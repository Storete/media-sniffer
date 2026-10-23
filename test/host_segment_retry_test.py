#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""离线自测：单个分片「断流」不能打死整单（不起浏览器、只连本机 mock 服务）。

2026-10-22 真机现场（用户自己在 4kvm 上点的下载）：

    下载分片失败（30/178 已下）：IncompleteRead(528064 bytes read, 1614008 ...

178 片下到第 31 片时服务端把连接掐了，`http.client.IncompleteRead` 一路抛到主循环，
整个任务判失败、`.part` 被删掉——**前面 30 片全白下**。用户重试一次（同样的地址、
同样的网络）就成功了，说明这是**瞬时抖动**，不该等于整单失败。

`_hls_get` 本来就有 2 次重试，但两次间隔只有 0.6s/1.2s，且是「紧接着重试」，
对「服务端连续几秒抽风」这种情况不够。本套件锁两件事：

  1) `_fetch_segment()` 在 `_hls_get` 之外再加一层退避重试，抖动过去就能取到；
  2) 端到端跑 `run_hls_self()`：某一分片连续断流多次但最终恢复 → 任务仍 done，
     且产物大小等于 6 片净长之和（**没有缺片**，不是「跳过坏片凑个文件」）。
"""
import os
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


# ---------------------------------------------------------------- 素材构造
TS_PACKET = 188


def ts_packet(pid=0x100, payload=b"x"):
    head = bytes([0x47, 0x40 | ((pid >> 8) & 0x1F), pid & 0xFF, 0x10])
    body = (payload * 200)[: TS_PACKET - len(head)]
    return head + body


def ts_stream(n=6, tag=b"a"):
    return b"".join(ts_packet(payload=tag + bytes([i])) for i in range(n))


def png_shell(payload=None, pad=112):
    """和真机同构的壳：PNG 签名 + 填充，让 TS 从 offset 112 开始。"""
    payload = ts_stream(4) if payload is None else payload
    head = b"\x89PNG\r\n\x1a\n" + b"\x00" * (pad - 8)
    return head + payload


N_SEG = 6
# 每个分片被请求过几次（用来证明「真的重试了」，而不是碰巧第一次就成功）
HITS = {}
# 指定分片「前 TRUNCATE 次请求只发一半就断」，None = 一直断
BROKEN = {"idx": None, "truncate": 0}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/list.m3u8":
            body = ("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:7\n"
                    + "".join("#EXTINF:6.125,\nseg-%d.ts\n" % i for i in range(N_SEG))
                    + "#EXT-X-ENDLIST\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.apple.mpegurl")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if not self.path.startswith("/seg-"):
            self.send_error(404)
            return

        idx = int(self.path[len("/seg-"):].split(".")[0])
        HITS[idx] = HITS.get(idx, 0) + 1
        body = png_shell(ts_stream(4, tag=bytes([65 + idx])))

        # 模拟服务端半途掐连接：Content-Length 报满、实际只发一半
        if BROKEN["idx"] == idx and HITS[idx] <= BROKEN["truncate"]:
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body[: len(body) // 2])
            try:
                self.wfile.flush()
            except Exception:
                pass
            self.close_connection = True
            return

        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ThreadingServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


# ---------------------------------------------------------------- 1. 函数存在
has_fn = hasattr(D, "_fetch_segment")
check("downloader 提供 _fetch_segment(url, headers)", has_fn)

srv = ThreadingServer(("127.0.0.1", 0), Handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:%d" % port

tmpdir = tempfile.mkdtemp(prefix="ms_seg_retry_")
D.JOBS_DIR = os.path.join(tmpdir, "jobs")
os.makedirs(D.JOBS_DIR, exist_ok=True)

# ---------------------------------------------------------------- 2. 单片：抖动能自愈
if has_fn:
    # 前 4 次截断：只靠 _hls_get 自己的 3 次尝试是过不去的（3 次全断），
    # 必须靠外层退避重试在第 5/6 次请求里取到。
    HITS.clear()
    BROKEN.update({"idx": 2, "truncate": 4})
    data, err = D._fetch_segment(BASE + "/seg-2.ts", {}, attempts=3, backoff=0.05)
    check("连续断流 4 次后仍能取到分片（外层退避重试生效）", data is not None, repr(err))
    check("取到的是剥过壳的干净 TS", bool(data) and data[:1] == b"\x47", (data or b"")[:8])
    check("确实发生了多次请求（不是碰巧一次成功）", HITS.get(2, 0) >= 5, HITS.get(2, 0))

    # 一直断：不能无限重试，要老老实实返回错误
    HITS.clear()
    BROKEN.update({"idx": 3, "truncate": 10 ** 6})
    data2, err2 = D._fetch_segment(BASE + "/seg-3.ts", {}, attempts=2, backoff=0.02)
    check("一直断流时返回 (None, 错误) 而不是抛异常", data2 is None and err2 is not None, (data2, err2))
    check("重试次数受 attempts 约束（attempts=2 → 2 轮请求）",
          2 <= HITS.get(3, 0) <= 8, HITS.get(3, 0))

    # 4xx（地址过期/防盗链）不该白重试 —— 交给上层判断
    HITS.clear()
    data3, err3 = D._fetch_segment(BASE + "/missing-seg", {}, attempts=3, backoff=0.02)
    check("404 时快速失败（4xx 不浪费重试预算）", data3 is None and err3 is not None, err3)

# ---------------------------------------------------------------- 3. 端到端：断流不影响成片
BROKEN.update({"idx": 2, "truncate": 4})
HITS.clear()
job = {
    "id": "seg-retry-e2e",
    "url": BASE + "/list.m3u8",
    "kind": "video",
    "filename": "mock.mp4",
    "outdir": tmpdir,
    "concurrency": 4,
    "remux": False,
}
D.run_hls_self(job)
st = D.read_status("seg-retry-e2e")
check("有分片连续断流 4 次，任务仍然 done", st.get("status") == "done", st)
out = st.get("file") or ""
check("产物存在", bool(out) and os.path.isfile(out), out)
if out and os.path.isfile(out):
    blob = open(out, "rb").read()
    expect = N_SEG * len(ts_stream(4))
    check("产物大小 = 6 片净长之和（没有跳过坏片）", len(blob) == expect, (len(blob), expect))
    check("产物首字节是 TS 同步字节", blob[:1] == b"\x47", blob[:8])
    check("坏过的那片也被补齐了（重试计数 > 1）", HITS.get(2, 0) >= 5, HITS.get(2, 0))

# ---------------------------------------------------------------- 4. 彻底下不来要说清是哪片
BROKEN.update({"idx": 4, "truncate": 10 ** 6})
HITS.clear()
job2 = dict(job, id="seg-retry-fail", filename="mock2.mp4")
D.run_hls_self(job2)
st2 = D.read_status("seg-retry-fail")
msg2 = st2.get("message") or ""
check("一直下不来的分片最终报 error", st2.get("status") == "error", st2)
check("错误里指明是第几片（第 5 片，1 起算）", "第 5 片" in msg2, msg2)
check("错误里带上重试次数", "重试" in msg2, msg2)
check("错误里带上整体进度（已下 N/M）", "已下" in msg2, msg2)
check("失败后不留 .part 残骸",
      not any(x.endswith(".part") for x in os.listdir(tmpdir)), os.listdir(tmpdir))

srv.shutdown()

print("RESULT: " + ("ALL PASS" if all(results) else "FAILED %d" % results.count(False)))
sys.exit(0 if all(results) else 1)
