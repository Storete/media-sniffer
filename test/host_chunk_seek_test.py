# -*- coding: utf-8 -*-
"""msfile_chunk 按偏移写入 + 重试幂等。

背景（真机 bug）：Telegram 8.8MB 文件下到 17% 卡死，日志里是
「宿主 120s 未响应 msfile_abort」。根因之一是页面侧 hostWrite 超时重试，
而宿主原来只做顺序追加 —— 如果宿主其实已经写进去了（只是回执晚了），
重试会把同一段写第二遍，文件大小对、内容整体错位。

修复后：chunk 带 text="bytes=<start>-"，宿主 seek 到该偏移覆写，
重复写入同一段完全无害。

这里不拉起真宿主进程，直接调 do_* 函数，把 send() 打桩收集回执。
"""
import io
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOST_DIR = os.path.join(os.path.dirname(HERE), "native-host")
sys.path.insert(0, HOST_DIR)

import sniffer_host as H  # noqa: E402

_failures = []
SENT = []


def check(name, cond, extra=None):
    if cond:
        print("PASS " + name)
    else:
        msg = "FAIL " + name
        if extra is not None:
            msg += " :: " + repr(extra)[:400]
        print(msg)
        _failures.append(name)


def _send(obj):
    SENT.append(obj)


def run():
    tmpdir = tempfile.mkdtemp(prefix="mschunk-")
    H.send = _send
    H._download_dir = lambda: tmpdir

    # ---- 1) 基本写入：三段拼起来
    SENT.clear()
    job = "test-seek-1"
    H.do_msfile_start({"id": job, "name": "seek.bin", "total": 30})
    start = SENT[-1]
    check("start 回执 ok", start.get("ok") is True, start)
    path = start.get("file")
    check("文件创建在临时目录", path and path.startswith(tmpdir), path)

    payload = bytes(range(30))
    H.do_msfile_chunk({"id": job, "text": "bytes=0-", "data": list(payload[0:10])})
    H.do_msfile_chunk({"id": job, "text": "bytes=10-", "data": list(payload[10:20])})
    H.do_msfile_chunk({"id": job, "text": "bytes=20-", "data": list(payload[20:30])})
    H.do_msfile_end({"id": job, "total": 30})
    got = io.open(path, "rb").read()
    check("三段顺序写入内容正确", got == payload, got)

    # ---- 2) 重试幂等：同一段写两次，内容不变
    SENT.clear()
    job = "test-seek-2"
    H.do_msfile_start({"id": job, "name": "idem.bin", "total": 30})
    path2 = SENT[-1].get("file")
    H.do_msfile_chunk({"id": job, "text": "bytes=0-", "data": list(payload[0:10])})
    # 模拟超时重试：同一段再写一次
    H.do_msfile_chunk({"id": job, "text": "bytes=0-", "data": list(payload[0:10])})
    H.do_msfile_chunk({"id": job, "text": "bytes=10-", "data": list(payload[10:30])})
    H.do_msfile_end({"id": job, "total": 30})
    got2 = io.open(path2, "rb").read()
    check("重复写同一段不产生重复数据", got2 == payload, got2)
    check("重复写后长度仍正确", len(got2) == 30, len(got2))

    # ---- 3) 乱序写入：先写后面的段，再补前面的缺口
    SENT.clear()
    job = "test-seek-3"
    H.do_msfile_start({"id": job, "name": "ooo.bin", "total": 30})
    path3 = SENT[-1].get("file")
    H.do_msfile_chunk({"id": job, "text": "bytes=20-", "data": list(payload[20:30])})
    H.do_msfile_chunk({"id": job, "text": "bytes=0-", "data": list(payload[0:10])})
    H.do_msfile_chunk({"id": job, "text": "bytes=10-", "data": list(payload[10:20])})
    H.do_msfile_end({"id": job, "total": 30})
    got3 = io.open(path3, "rb").read()
    check("乱序写入最终内容正确", got3 == payload, got3)

    # ---- 4) 没有 text 偏移时退回顺序追加（兼容老调用）
    SENT.clear()
    job = "test-seek-4"
    H.do_msfile_start({"id": job, "name": "seq.bin", "total": 20})
    path4 = SENT[-1].get("file")
    H.do_msfile_chunk({"id": job, "data": list(payload[0:10])})
    H.do_msfile_end({"id": job, "total": 10})
    got4 = io.open(path4, "rb").read()
    check("无偏移时顺序追加仍然工作", got4 == payload[0:10], got4)

    # ---- 5) written 是最高水位，不是最后写的位置（乱序时不能退回去）
    SENT.clear()
    job = "test-seek-5"
    H.do_msfile_start({"id": job, "name": "wm.bin", "total": 30})
    H.do_msfile_chunk({"id": job, "text": "bytes=20-", "data": list(payload[20:30])})
    wm_after_far = [m for m in SENT if m.get("action") == "msfile_chunk"][-1].get("written")
    H.do_msfile_chunk({"id": job, "text": "bytes=0-", "data": list(payload[0:10])})
    wm_after_near = [m for m in SENT if m.get("action") == "msfile_chunk"][-1].get("written")
    check("written 记录最高水位（远段先写=30）", wm_after_far == 30, wm_after_far)
    check("回写近段后 written 不倒退", wm_after_near == 30, wm_after_near)
    H.do_msfile_abort({"id": job})

    # ---- 6) abort 能清理
    SENT.clear()
    job = "test-seek-6"
    H.do_msfile_start({"id": job, "name": "abort.bin", "total": 10})
    path6 = SENT[-1].get("file")
    H.do_msfile_chunk({"id": job, "text": "bytes=0-", "data": list(payload[0:5])})
    H.do_msfile_abort({"id": job})
    check("abort 后文件被删除", not os.path.exists(path6), path6)
    check("abort 后任务已摘除", job not in H.FILE_JOBS)

    # 清理
    for f in os.listdir(tmpdir):
        try:
            os.remove(os.path.join(tmpdir, f))
        except OSError:
            pass
    try:
        os.rmdir(tmpdir)
    except OSError:
        pass


try:
    run()
finally:
    print()
    if _failures:
        print("RESULT: %d FAILED -> %s" % (len(_failures), ", ".join(_failures)))
        sys.exit(1)
    else:
        print("RESULT: ALL PASS")
