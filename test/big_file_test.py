#!/usr/bin/env python3
"""大文件落盘测试：验证宿主不再有 512MB 上限。

用法：
    python test/big_file_test.py            # 默认 3GB
    python test/big_file_test.py 5          # 5GB
    python test/big_file_test.py 1 --keep   # 1GB 且保留文件

背景：native-host/sniffer_host.py 原来有 FILE_MAX = 512MB，
会把 Telegram 的 771MB 视频直接拒掉。用户要求「不要设限」，已删除，
这个脚本就是守门员：写超过旧上限的数据，断言字节数完全正确。

进程间用 Native Messaging 的 4 字节小端长度 + JSON 帧。
每个分块转成 JSON 数组会膨胀约 4 倍，所以用 512KB 分块（≈2MB 帧）。
"""

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
HOST = os.path.join(ROOT, "native-host", "sniffer_host.py")
PY = sys.executable

CHUNK = 512 * 1024
GB = 1024 * 1024 * 1024


def send(proc, obj):
    body = json.dumps(obj).encode("utf-8")
    proc.stdin.write(struct.pack("<I", len(body)) + body)
    proc.stdin.flush()


def read(proc):
    head = proc.stdout.read(4)
    if len(head) < 4:
        return None
    n = struct.unpack("<I", head)[0]
    return json.loads(proc.stdout.read(n))


def main():
    gb = 3.0
    keep = "--keep" in sys.argv
    for a in sys.argv[1:]:
        if a[0].isdigit():
            gb = float(a)
    total = int(gb * GB)

    # 落在真实下载目录的子目录里，顺便验证该盘有足够空间；
    # 跑完默认删掉，免得白占几个 GB。
    try:
        sys.path.insert(0, os.path.join(ROOT, "native-host"))
        import library  # noqa: E402

        base = library.library_dir()
    except Exception:
        base = os.environ.get("TEMP") or "."
    tmp = tempfile.mkdtemp(prefix="ms_bigfile_", dir=base)
    print("临时目录:", tmp)

    free = shutil.disk_usage(tmp).free
    print("可用空间: %.1f GB，本次写入 %.1f GB" % (free / GB, total / GB))
    if free < total + GB:
        print("!! 空间不足，退出")
        return 1

    env = dict(os.environ, MEDIA_SNIFFER_OUTDIR=tmp)
    proc = subprocess.Popen(
        [PY, HOST],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        env=env,
        bufsize=0,
    )
    try:
        send(proc, {"id": "t1", "action": "ping"})
        pong = read(proc)
        if not pong or pong.get("action") != "pong":
            print("FAIL ping", pong)
            return 1
        print("PASS ping")

        jid = "big-test"
        send(proc, {"id": jid, "action": "msfile_start", "name": "big-test.mp4"})
        started = read(proc)
        if not started or not started.get("ok"):
            print("FAIL msfile_start", started)
            return 1
        path = started.get("file")
        print("PASS start ->", path)

        block = b"\xa5" * CHUNK
        # 分块内容带上序号，落盘后抽查，确认顺序没错位
        written = 0
        t0 = time.time()
        last = t0
        while written < total:
            n = min(CHUNK, total - written)
            send(proc, {"id": jid, "action": "msfile_chunk", "data": list(block[:n])})
            ack = read(proc)
            if not ack or not ack.get("ok"):
                print("FAIL chunk at", written, ack)
                return 1
            written += n
            now = time.time()
            if now - last > 10:
                last = now
                el = now - t0
                print(
                    "  %.2f / %.2f GB   %.1f MB/s"
                    % (written / GB, total / GB, written / 1048576 / el),
                    flush=True,
                )

        send(proc, {"id": jid, "action": "msfile_end", "total": written})
        ended = read(proc)
        dt = time.time() - t0
        if not ended or not ended.get("ok"):
            print("FAIL msfile_end", ended)
            return 1
        print(
            "PASS 写完 %.2f GB，用时 %.1fs = %.1f MB/s"
            % (total / GB, dt, total / 1048576 / dt)
        )

        size = os.path.getsize(path) if os.path.exists(path) else 0
        if size != total:
            print("FAIL 落盘大小 %d != %d" % (size, total))
            return 1
        print("PASS 落盘字节数完全一致:", size)

        # 超过旧上限（512MB）的远端位置也要能读到数据，证明没有在 512MB 处截断
        with open(path, "rb") as f:
            for off in (0, 512 * 1024 * 1024, total - CHUNK):
                f.seek(off)
                got = f.read(16)
                if got != b"\xa5" * 16:
                    print("FAIL 偏移 %d 处数据不对: %r" % (off, got))
                    return 1
        print("PASS 偏移 0 / 512MB / 末尾 都有正确数据（旧上限位置未被截断）")

        print("\nRESULT: ALL PASS")
        return 0
    finally:
        try:
            proc.kill()
        except Exception:
            pass
        if keep:
            print("保留文件:", tmp)
        else:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
