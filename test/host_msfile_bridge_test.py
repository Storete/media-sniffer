#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""宿主端 msfile_* 协议自测（直接起 sniffer_host.py 子进程讲 Native Messaging 帧）。

重点是「同一台宿主连开多个文件」：每个文件的回执都必须带 inProgress=True，
否则扩展的 requestId 记账会把这台宿主判定为一次性连接、提前解绑，
第二个文件就会报「本地下载器无响应」。
"""
import base64
import json
import os
import struct
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
HOST = os.path.join(ROOT, "native-host", "sniffer_host.py")
TMP = tempfile.mkdtemp(prefix="ms-host-test-")

results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  -> " + str(extra)))


proc = subprocess.Popen([sys.executable, HOST], stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


def send(obj):
    # 二进制按扩展的做法走 base64 包装（Native Messaging 的 JSON 帧不接受裸 bytes）
    obj = dict(obj)
    if isinstance(obj.get("data"), (bytes, bytearray)):
        obj["data"] = {"__b64": base64.b64encode(bytes(obj["data"])).decode("ascii")}
    data = json.dumps(obj).encode("utf-8")
    proc.stdin.write(struct.pack("<I", len(data)) + data)
    proc.stdin.flush()


def recv():
    head = proc.stdout.read(4)
    if len(head) < 4:
        raise RuntimeError("宿主提前退出")
    n = struct.unpack("<I", head)[0]
    return json.loads(proc.stdout.read(n).decode("utf-8"))


try:
    send({"id": "p1", "action": "ping"})
    ping = recv()
    check("ping 通", ping.get("action") == "pong", ping)

    payload = bytes(range(256)) * 4096  # 1MB
    files = []
    for round_no in (1, 2):
        jid = "msf-round%d" % round_no
        send({"id": jid, "action": "msfile_start", "name": "bridge-round%d.bin" % round_no,
              "total": len(payload)})
        st = recv()
        check("第%d个文件 start 成功" % round_no, st.get("ok") is True, st)
        check("第%d个文件 start 带 inProgress" % round_no, st.get("inProgress") is True, st)
        for i in range(0, len(payload), 512 * 1024):
            send({"id": jid, "action": "msfile_chunk", "text": "bytes=%d-" % i,
                  "data": payload[i:i + 512 * 1024]})
            ck = recv()
            if not ck.get("ok") or ck.get("inProgress") is not True:
                check("第%d个文件 chunk 回执正常" % round_no, False, ck)
                break
        else:
            check("第%d个文件 chunk 回执带 inProgress" % round_no, True)
        send({"id": jid, "action": "msfile_end", "total": len(payload)})
        end = recv()
        check("第%d个文件 end 成功" % round_no, end.get("ok") is True, end)
        if end.get("ok"):
            files.append(end["file"])
            check("第%d个文件大小一致" % round_no, end.get("size") == len(payload), end)
            check("第%d个文件内容一致" % round_no,
                  open(end["file"], "rb").read() == payload, "字节比对失败")

    check("两个文件落到不同路径", len(set(files)) == 2, files)

    send({"id": "bad", "action": "nope"})
    err = recv()
    check("未知指令返回 error", err.get("status") == "error", err)
finally:
    try:
        proc.stdin.close()
    except Exception:
        pass
    proc.wait(timeout=10)
    for f in os.listdir(os.path.dirname(files[0])) if files else []:
        if f.startswith("bridge-round"):
            try:
                os.remove(os.path.join(os.path.dirname(files[0]), f))
            except OSError:
                pass

print("RESULT: " + ("ALL PASS" if all(results) else "FAILED %d" % results.count(False)))
sys.exit(0 if all(results) else 1)
