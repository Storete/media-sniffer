#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""离线自测：限速 / 超时 / 5xx 真的会重试（只连本机 mock 服务，不联网）。

对应 `docs/TODO.md` 的 T-B4（P2 自适应降级）的第二半。第一半是码表本身
（`host_errcode_test.py`，纯函数），这一半验证 `run_urllib` 真的按表执行。

为什么这件事重要：`docs/ENGINE-EVAL.md` §4-P0 实测里，`proof.ovh.net` 单连接正常、
**4 连接那轮直接吃 HTTP 429**。也就是说 429 不是理论风险，是已经在自家机器上
撞见过的失败。而原来的代码 `except HTTPError → write_status(error) → return`，
一次就放弃 —— 用户看到的是一句英文，且必须自己重新点。

本套件锁六件事：
  · 429 一次后成功 → 最终 `done`，产物完整，且中途**写了重试提示**（用户看得见）；
  · 429 两次（预算用完）→ `error`，码是 `HTTP_429`，请求数正好 2（不多不少）；
  · 403 一次就放弃 → 请求数 1（重试一百次还是 403，不烧流量）；
  · 503 两次 → `error`，码是 `HTTP_503`，文案里保留了 503 这个数字；
  · 500 一次后成功 → 表外 5xx 属瞬时抖动，值得再试一次；
  · 重试**不吃掉断点**：`.part` 已有 30000 字节时，重试仍然带 `Range: bytes=30000-`；
  · 退避等待期间点取消 → 不再发请求，状态是 `cancelled`（不让用户等我们）。
"""
import json
import os
import re
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

import downloader as D  # noqa: E402
import errcode as E    # noqa: E402

# 退避时间整体压小，否则本套件要跑十几秒。`Retry-After: 0` 会被夹到 MIN。
E.RETRY_AFTER_MIN = 0.01
E.RETRY_AFTER_MAX = 0.05

results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  -> " + str(extra)))


DATA = bytes(range(256)) * 352      # 90112 B
DATA = DATA[:90000]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_GET(self):
        STATE["reqs"].append(self.headers.get("Range") or "")
        queue = STATE["statuses"]
        st = queue.pop(0) if queue else 200

        if st != 200:
            body = b"not today"
            self.send_response(st)
            for k, v in STATE["headers"].items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            self.close_connection = True
            return

        rng = self.headers.get("Range") or ""
        start = 0
        m = re.match(r"bytes=(\d+)-", rng)
        if m:
            start = int(m.group(1))
        body = DATA[start:]
        if rng:
            self.send_response(206)
            self.send_header("Content-Range",
                             "bytes %d-%d/%d" % (start, len(DATA) - 1, len(DATA)))
        else:
            self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True


STATE = {"reqs": [], "statuses": [], "headers": {}}

srv = Server(("127.0.0.1", 0), Handler)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:%d/v.mp4" % PORT

TMP = tempfile.mkdtemp(prefix="ms-retry-test-")
D.DEFAULT_OUT = TMP
D.JOBS_DIR = TMP
D.status_path = lambda job_id: os.path.join(TMP, job_id + ".json")


def size_of(path):
    """产物大小；文件不在就返 -1。

    反向验证时第一条断言就会红（比如「重试被关掉了，产物根本没生成」），
    如果这里直接 os.path.getsize 抛异常，**后面的断言一条都看不到** ——
    一红就崩的测试等于只测了第一件事。所有取值都要能容错。
    """
    try:
        return os.path.getsize(path)
    except OSError:
        return -1


def status_of(job_id):
    p = os.path.join(TMP, job_id + ".json")
    if not os.path.exists(p):
        return {}
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return {}


def msgs_of(job_id):
    """状态文件只留最后一次 message，所以用「边下边记」的钩子收集全过程。

    `write_status` 每次都会把 message 覆盖掉，只看终态会漏掉重试提示 ——
    而「重试是否对用户可见」正是本套件的核心判据，不能自己把自己测瞎。
    """
    return SEEN.get(job_id, [])


SEEN = {}
_orig_write = D.write_status


def spy_write(job_id, **fields):
    if fields.get("message"):
        SEEN.setdefault(job_id, []).append(fields["message"])
    return _orig_write(job_id, **fields)


D.write_status = spy_write


def setup(statuses=(), headers=None, part_bytes=0):
    STATE["reqs"] = []
    STATE["statuses"] = list(statuses)
    STATE["headers"] = dict(headers or {})
    SEEN.clear()
    out = tempfile.mkdtemp(prefix="run-", dir=TMP)
    if part_bytes:
        with open(os.path.join(out, "v.mp4.part"), "wb") as f:
            f.write(DATA[:part_bytes])
    return out


def job(job_id, outdir):
    return {"id": job_id, "url": URL, "kind": "video", "filename": "v.mp4", "outdir": outdir}


# ---------------------------------------------------------------- [A] 429 一次后成功
print("[A] 429 一次 → 自动重试 → 成功")
out = setup([429], {"Retry-After": "0"})
D.run_urllib(job("a1", out))
st = status_of("a1")
msgs = msgs_of("a1")
check("最终 done（没有因为一次限速就整单失败）", st.get("status") == "done", st.get("status"))
check("产物字节数完整", size_of(os.path.join(out, "v.mp4")) == len(DATA),
      size_of(os.path.join(out, "v.mp4")))
check("请求了 2 次", len(STATE["reqs"]) == 2, STATE["reqs"])
check("中途写过重试提示（用户看得见，不是默默重试）",
      any("限速" in m for m in msgs), msgs)
check("重试提示带「第几次 / 共几次」", any("1/2" in m for m in msgs), msgs)
check("成功时把错误码清掉（不留一个吓人的 HTTP_429）",
      st.get("err") == "", st.get("err"))


# ---------------------------------------------------------------- [B] 429 到底
print("")
print("[B] 429 两次 → 预算用完就停，说清原因")
out = setup([429, 429], {"Retry-After": "0"})
D.run_urllib(job("b1", out))
st = status_of("b1")
check("最终 error", st.get("status") == "error", st.get("status"))
check("码是 HTTP_429", st.get("err") == "HTTP_429", st.get("err"))
check("文案说「限速」而不是「连接超时」（用户才知道该等）",
      "限速" in (st.get("message") or ""), st.get("message"))
check("请求数正好 2（表里写的预算，不多烧）", len(STATE["reqs"]) == 2, STATE["reqs"])
check("文案带 HTTP 429 这个数字（诊断用）", "429" in (st.get("message") or ""),
      st.get("message"))


# ---------------------------------------------------------------- [C] 403 不重试
print("")
print("[C] 403 → 一次就放弃（重试一百次还是 403）")
out = setup([403])
D.run_urllib(job("c1", out))
st = status_of("c1")
check("最终 error", st.get("status") == "error", st.get("status"))
check("码是 HTTP_403", st.get("err") == "HTTP_403", st.get("err"))
check("请求数 1（没浪费预算）", len(STATE["reqs"]) == 1, STATE["reqs"])
check("文案指向防盗链", "防盗链" in (st.get("message") or ""), st.get("message"))


# ---------------------------------------------------------------- [D] 503 到底
print("")
print("[D] 503 两次 → error，且保留 503 这个数字")
out = setup([503, 503])
D.run_urllib(job("d1", out))
st = status_of("d1")
check("最终 error", st.get("status") == "error", st.get("status"))
check("码是 HTTP_503（不合并成笼统的「网络错误」）", st.get("err") == "HTTP_503", st.get("err"))
check("请求 2 次（5xx 是瞬时抖动，值得再试一次）", len(STATE["reqs"]) == 2, STATE["reqs"])
check("文案说「服务器出错」", "服务器出错" in (st.get("message") or ""), st.get("message"))


# ---------------------------------------------------------------- [E] 500 后成功
print("")
print("[E] 500 一次 → 重试 → 成功")
out = setup([500])
D.run_urllib(job("e1", out))
st = status_of("e1")
check("最终 done", st.get("status") == "done", st.get("status"))
check("请求 2 次", len(STATE["reqs"]) == 2, STATE["reqs"])
check("产物完整", size_of(os.path.join(out, "v.mp4")) == len(DATA),
      size_of(os.path.join(out, "v.mp4")))


# ---------------------------------------------------------------- [F] 重试不丢断点
print("")
print("[F] 重试不吃掉断点：.part 有 30000 字节时，重试仍带 Range")
out = setup([429], {"Retry-After": "0"}, part_bytes=30000)
D.run_urllib(job("f1", out))
st = status_of("f1")
check("最终 done", st.get("status") == "done", st.get("status"))
check("两次请求都带 Range: bytes=30000-",
      STATE["reqs"] == ["bytes=30000-", "bytes=30000-"], STATE["reqs"])
check("产物是 90000（30000 旧 + 60000 新，没重头下）",
      size_of(os.path.join(out, "v.mp4")) == len(DATA),
      size_of(os.path.join(out, "v.mp4")))


# ---------------------------------------------------------------- [G] 退避里取消
print("")
print("[G] 退避等待期间点取消 → 立刻停，不再发请求")
out = setup([429])          # 不发 Retry-After → 用表里的 backoff 3.0s
tid = "g1"


def cancel_soon():
    time.sleep(0.12)
    open(os.path.join(TMP, tid + ".cancel"), "w").close()


threading.Thread(target=cancel_soon, daemon=True).start()
t0 = time.time()
D.run_urllib(job(tid, out))
elapsed = time.time() - t0
st = status_of(tid)
check("状态是 cancelled", st.get("status") == "cancelled", st.get("status"))
check("没有第二次请求（取消了就不该再打扰站方）", len(STATE["reqs"]) == 1, STATE["reqs"])
check("取消后错误码清空（取消不是错误）", st.get("err") == "", st.get("err"))
check("没等满 3 秒退避（我们的等待不该让用户干等）", elapsed < 2.0, round(elapsed, 2))


# ---------------------------------------------------------------- 汇总
print("")
ok = sum(1 for r in results if r)
print("RESULT: %d 通过 / %d 失败" % (ok, len(results) - ok))
sys.exit(0 if ok == len(results) else 1)
