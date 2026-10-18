#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""离线自测：把 msfile_* 协议跑一遍，确认二进制分块能正确落盘。

不依赖浏览器，直接给 sniffer_host.py 喂 Native Messaging 帧：
  msfile_start -> msfile_chunk × N（含二进制数组与 base64 兜底）-> msfile_end
用法： python test/host_msfile_test.py
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PY = sys.executable
sys.path.insert(0, os.path.join(ROOT, "native-host"))

import sniffer_host as H  # noqa: E402

TMP = tempfile.mkdtemp(prefix="ms-test-")
H._download_dir = lambda: TMP  # 写到临时目录，别污染真实的下载文件夹

proc = subprocess.Popen(
    [PY, "-c", "import sys; sys.path.insert(0, r'%s'); import sniffer_host as h; "
               "h._download_dir = lambda: r'%s'; h.main()" % (os.path.join(ROOT, "native-host"), TMP)],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
)


def send(obj):
    data = json.dumps(obj).encode()
    proc.stdin.write(struct.pack("<I", len(data)) + data)
    proc.stdin.flush()
    return recv()


def recv():
    raw = proc.stdout.read(4)
    if len(raw) < 4:
        raise SystemExit("宿主没有回应")
    (n,) = struct.unpack("<I", raw)
    return json.loads(proc.stdout.read(n).decode())


def main():
    ok = True

    # 1) 二进制数组分块
    payload = bytes(range(256)) * 4096  # 1MB
    r = send({"id": "t1", "action": "msfile_start", "name": "测试 视频.mp4", "total": len(payload)})
    assert r["ok"], r
    job = r["id"]
    for off in range(0, len(payload), 512 * 1024):
        piece = payload[off:off + 512 * 1024]
        rk = send({"id": job, "action": "msfile_chunk", "text": "bytes=%d-" % off, "data": list(piece)})
        if not rk.get("ok"):
            print("FAIL chunk", rk)
            ok = False
            break
    r = send({"id": job, "action": "msfile_end", "total": len(payload)})
    got = open(r["file"], "rb").read()
    if got == payload and r.get("size") == len(payload):
        print("PASS 二进制分块落盘", len(got), "字节", os.path.basename(r["file"]))
    else:
        print("FAIL 内容不一致", len(got), r)
        ok = False

    # 2) base64 兜底
    import base64
    r = send({"id": "t2", "action": "msfile_start", "name": "b64.bin", "total": 11})
    job = r["id"]
    send({"id": job, "action": "msfile_chunk", "data": {"__b64": base64.b64encode(b"hello world").decode()}})
    r2 = send({"id": job, "action": "msfile_end"})
    if open(r2["file"], "rb").read() == b"hello world":
        print("PASS base64 兜底")
    else:
        print("FAIL base64 兜底")
        ok = False

    # 3) 重名不覆盖
    r = send({"id": "t3", "action": "msfile_start", "name": "b64.bin", "total": 1})
    r3 = send({"id": r["id"], "action": "msfile_end"})
    if r3["file"] != r2["file"] and "(" in os.path.basename(r3["file"]):
        print("PASS 重名自动改名", os.path.basename(r3["file"]))
    else:
        print("FAIL 重名覆盖了", r3["file"])
        ok = False

    # 4) 取消删除残文件
    r = send({"id": "t4", "action": "msfile_start", "name": "abort.bin", "total": 5})
    job = r["id"]
    send({"id": job, "action": "msfile_chunk", "data": list(b"abc")})
    send({"id": job, "action": "msfile_abort"})
    if not os.path.exists(r["file"]):
        print("PASS 中止后删除残文件")
    else:
        print("FAIL 残文件还在", r["file"])
        ok = False

    # 5) ping 仍然正常
    r = send({"id": "p", "action": "ping"})
    if r.get("action") == "pong":
        print("PASS ping", r.get("ytdlp") or "无 yt-dlp")
    else:
        print("FAIL ping", r)
        ok = False

    proc.stdin.close()
    proc.wait(timeout=5)
    print("RESULT:", "ALL PASS" if ok else "HAS FAILURES")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
