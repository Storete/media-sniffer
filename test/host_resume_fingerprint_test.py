#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""离线自测：续传的指纹校验 + 完整性校验（只连本机 mock 服务，不联网）。

2026-10-24 的 P1（见 `docs/ENGINE-EVAL.md` §4）。两个真实缺口：

1. **续传只认长度**。`.part` 有多长就从那儿接着写，不管这期间服务器换没换内容
   （重新转码 / CDN 换切片 / 签名直链换批次）。拼出来是「前半段 A + 后半段 B」，
   而 **ffprobe 往往还能打开** → 验证层放它过去。这是「错并且不自知」。
2. **提前 EOF 会被报成完成**。`read()` 返空就 `break`，接着就 `os.replace` ——
   半截文件盖上正式名字，状态写 `done`。这是 V2 一票否决项（产物打不开），
   而现在的代码只会静默产出它。

本套件锁五件事：
  · 指纹三项（长度 / ETag / Last-Modified）任一变化 → 作废 `.part` 重下，产物里
    不能混进旧内容；
  · 指纹没变 → 真的续传（第二次只请求剩下的字节，不是整个重下）；
  · 服务器不给校验头 → **仍然续传**（不允许「一刀切重下」，那比冒险更糟）；
  · `W/"abc"` 与 `"abc"` 不算变化（强弱标记差别，不是内容变了）；
  · 中途断流 → 状态 `error`、`.part` **保留**、正式文件不出现。
"""
import os
import re
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

import downloader as D  # noqa: E402

results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  -> " + str(extra)))


# ---------------------------------------------------------------- 单元：纯函数
print("[1] 指纹比较（纯函数，不起服务）")


class FakeResp:
    def __init__(self, status, headers):
        self.status = status
        self.headers = headers


def fake(status=206, **h):
    return FakeResp(status, h)


ok = D._norm_etag
check("W/ 前缀不算变化", ok('W/"abc"') == ok('"abc"') == '"abc"', [ok('W/"abc"'), ok('"abc"')])
check("大小写 w/ 也认", ok('w/"abc"') == '"abc"')

crt = D._parse_content_range_total
check("Content-Range 取总数", crt("bytes 100-999/1000") == 1000, crt("bytes 100-999/1000"))
check("总数未知（*）返回 0", crt("bytes 0-99/*") == 0)
check("格式不对返回 0", crt("garbage") == 0 and crt(None) == 0)

rt = D._resp_total
check("206 用 Content-Range 的总数（不是剩余字节）",
      rt(fake(206, **{"Content-Length": "900", "Content-Range": "bytes 100-999/1000"}), 100) == 1000,
      rt(fake(206, **{"Content-Length": "900", "Content-Range": "bytes 100-999/1000"}), 100))
check("206 没有 Content-Range 时退回 剩余+已下",
      rt(fake(206, **{"Content-Length": "900"}), 100) == 1000)
check("200 用 Content-Length", rt(fake(200, **{"Content-Length": "500"}), 0) == 500)

fp = D.fingerprint_of(fake(206, ETag='"v1"', **{"Last-Modified": "Mon, 01 Jan 2024 00:00:00 GMT"}), 1000, "u")
check("指纹取到三样", fp == {"etag": '"v1"', "lm": "Mon, 01 Jan 2024 00:00:00 GMT", "len": 1000, "url": "u"}, fp)

mm = D.fingerprint_mismatch
base = {"etag": '"v1"', "lm": "LM1", "len": 1000}
check("完全一致 → 可以续", mm(base, dict(base)) == "")
check("长度变了 → 不能续", "长度" in mm(base, {"etag": '"v1"', "lm": "LM1", "len": 1001}))
check("ETag 变了 → 不能续", "ETag" in mm(base, {"etag": '"v2"', "lm": "LM1", "len": 1000}))
check("只 Last-Modified 变了 → 不能续", "Last-Modified" in mm(base, {"etag": '"v1"', "lm": "LM2", "len": 1000}))
check("ETag 强弱标记变化 → 仍可续", mm({"etag": 'W/"v1"', "lm": "LM1", "len": 1000}, base) == "")
check("旧记录不存在（老版本留的 .part）→ 允许续，不因噎废食", mm(None, base) == "")
check("两边都没有校验头、长度相同 → 允许续（绝大多数 CDN 分片如此）",
      mm({"etag": "", "lm": "", "len": 1000}, {"etag": "", "lm": "", "len": 1000}) == "")
check("一边有 ETag 一边没有 → 不判冲突（没法比，不是不同）",
      mm({"etag": "", "lm": "LM1", "len": 1000}, base) == "")

# ---------------------------------------------------------------- mock 服务
print("\n[2] 端到端（本机 mock 服务，支持 Range）")

STATE = {
    "data": b"",          # 当前「服务器上」的内容
    "etag": '"v1"',
    "lm": "Mon, 01 Jan 2024 00:00:00 GMT",
    "no_validators": False,
    "truncate": 0,        # 发够 Content-Length 但少写这么多字节，然后断开
    "reqs": [],           # 每次请求带的 Range 头
    "range_ok": True,
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_GET(self):
        rng = self.headers.get("Range") or ""
        STATE["reqs"].append(rng)
        data = STATE["data"]
        start = 0
        if rng:
            m = re.match(r"bytes=(\d+)-", rng)
            if m:
                start = int(m.group(1))
        body = data[start:]
        if rng and STATE["range_ok"]:
            self.send_response(206)
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, len(data) - 1, len(data)))
        else:
            start = 0
            body = data
            self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        if not STATE["no_validators"]:
            self.send_header("ETag", STATE["etag"])
            self.send_header("Last-Modified", STATE["lm"])
        self.end_headers()
        cut = STATE["truncate"]
        self.wfile.write(body[: len(body) - cut] if cut else body)
        self.close_connection = True


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True


srv = Server(("127.0.0.1", 0), Handler)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:%d/v.mp4" % PORT

TMP = tempfile.mkdtemp(prefix="ms-resume-test-")
D.DEFAULT_OUT = TMP
D.JOBS_DIR = TMP
D.status_path = lambda job_id: os.path.join(TMP, job_id + ".json")


def status_of(job_id):
    import json
    p = os.path.join(TMP, job_id + ".json")
    if not os.path.exists(p):
        return {}
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return {}


def job(job_id, outdir):
    return {"id": job_id, "url": URL, "kind": "video", "filename": "v.mp4", "outdir": outdir}


# ---- [A] 中途断流：必须 error + 保留 .part + 不出正式文件
outA = os.path.join(TMP, "A")
os.makedirs(outA)
STATE["data"] = bytes(range(256)) * 400                      # 102400 B
STATE["truncate"] = 40000
STATE["reqs"].clear()
D.run_urllib(job("a1", outA))
stA = status_of("a1")
partA = os.path.join(outA, "v.mp4.part")
check("断流 → 状态是 error（不是 done）", stA.get("status") == "error", stA)
check("断流 → 提示里说清楚要再点一次",
      "断点" in (stA.get("message") or ""), stA.get("message"))
check("断流 → .part 保留（续传的本钱）",
      os.path.exists(partA) and os.path.getsize(partA) == 62400,
      os.path.exists(partA) and os.path.getsize(partA))
check("断流 → 正式文件不出现（半截图不许盖上正式名）",
      not os.path.exists(os.path.join(outA, "v.mp4")))
check("断流 → 指纹已落盘", D.read_part_meta(partA) is not None, D.read_part_meta(partA))

# ---- [B] 内容没变：真续传（只请求剩下的字节），最后完整
STATE["truncate"] = 0
STATE["reqs"].clear()
D.run_urllib(job("b1", outA))
stB = status_of("b1")
check("续传成功", stB.get("status") == "done", stB)
check("续传只请求了剩余字节（Range 起点 62400）",
      any(r == "bytes=62400-" for r in STATE["reqs"]), STATE["reqs"])
check("续传后产物长度 == 102400",
      os.path.getsize(os.path.join(outA, "v.mp4")) == 102400,
      os.path.getsize(os.path.join(outA, "v.mp4")) if os.path.exists(os.path.join(outA, "v.mp4")) else -1)
check("续传后内容逐字节正确（没拼错位）",
      open(os.path.join(outA, "v.mp4"), "rb").read() == STATE["data"][:0] + (bytes(range(256)) * 400))
check(".part 已清理", not os.path.exists(partA))
check("指纹文件也清理（不留孤儿 .part.meta）",
      not os.path.exists(partA + ".part.meta"))

# ---- [C] 内容变了：必须作废重下，产物里不许混旧内容
outC = os.path.join(TMP, "C")
os.makedirs(outC)
OLD = b"\x11" * 60000
NEW = b"\x22" * 90000                     # 长度和内容都变了
STATE["data"] = OLD
STATE["truncate"] = 30000
D.run_urllib(job("c1", outC))
partC = os.path.join(outC, "v.mp4.part")
check("场景 C 的前置：断点里是旧内容的开头",
      os.path.getsize(partC) == 30000 and open(partC, "rb").read() == b"\x11" * 30000)

STATE["data"] = NEW
STATE["etag"] = '"v2"'
STATE["lm"] = "Tue, 02 Jan 2024 00:00:00 GMT"
STATE["truncate"] = 0
STATE["reqs"].clear()
D.run_urllib(job("c2", outC))
stC = status_of("c2")
prodC = os.path.join(outC, "v.mp4")
check("换内容后仍能下成", stC.get("status") == "done", stC)
# 请求序列必须是「先用 Range 探一次 → 发现变了 → 再不带 Range 整份重下」。
# 探的那次不会写盘（指纹比对在读 body 之前），所以不会浪费流量下完才发现。
check("换内容后：先带 Range 探、发现变了再整份重下",
      STATE["reqs"] == ["bytes=30000-", ""], STATE["reqs"])
check("产物 == 新内容（半个字节的旧内容都不许混进来）",
      os.path.exists(prodC) and open(prodC, "rb").read() == NEW,
      os.path.getsize(prodC) if os.path.exists(prodC) else -1)

# ---- [D] 只换 ETag、长度相同：也要重下（长度相等不代表内容相等）
outD = os.path.join(TMP, "D")
os.makedirs(outD)
STATE["data"] = b"\x33" * 50000
STATE["etag"] = '"d1"'
STATE["lm"] = "Wed, 03 Jan 2024 00:00:00 GMT"
STATE["truncate"] = 20000
D.run_urllib(job("d1", outD))
STATE["truncate"] = 0
STATE["etag"] = '"d2"'                   # 长度不变，只有 ETag 变
STATE["reqs"].clear()
D.run_urllib(job("d2", outD))
okD = status_of("d2")
check("长度相同但 ETag 变了 → 也重下（序列同上：探 → 整份）",
      okD.get("status") == "done" and STATE["reqs"] == ["bytes=30000-", ""], STATE["reqs"])

# ---- [E] 服务器不给校验头：仍然续传（不做一刀切重下）
outE = os.path.join(TMP, "E")
os.makedirs(outE)
STATE["data"] = b"\x44" * 80000
STATE["no_validators"] = True
STATE["truncate"] = 30000
D.run_urllib(job("e1", outE))
STATE["truncate"] = 0
STATE["reqs"].clear()
D.run_urllib(job("e2", outE))
stE = status_of("e2")
check("没有校验头 → 仍然续传（Range 起点 50000）",
      stE.get("status") == "done" and any(r == "bytes=50000-" for r in STATE["reqs"]), STATE["reqs"])
check("没有校验头 → 产物长度正确",
      os.path.getsize(os.path.join(outE, "v.mp4")) == 80000)

# ---- [F] 服务器不支持 Range（回 200）：整份重写，不能追加
outF = os.path.join(TMP, "F")
os.makedirs(outF)
STATE["no_validators"] = False
STATE["data"] = b"\x55" * 40000
STATE["truncate"] = 15000
D.run_urllib(job("f1", outF))
STATE["truncate"] = 0
STATE["range_ok"] = False                # 忽略 Range，直接 200 整份
D.run_urllib(job("f2", outF))
stF = status_of("f2")
prodF = os.path.join(outF, "v.mp4")
check("服务器回 200 → 整份重写（不追加，否则文件会变长）",
      stF.get("status") == "done" and os.path.getsize(prodF) == 40000,
      (stF.get("status"), os.path.getsize(prodF) if os.path.exists(prodF) else -1))
check("服务器回 200 → 内容正确", open(prodF, "rb").read() == b"\x55" * 40000)

srv.shutdown()
print("\nRESULT: " + ("ALL PASS" if all(results) else "FAILED %d" % results.count(False)))
sys.exit(0 if all(results) else 1)
