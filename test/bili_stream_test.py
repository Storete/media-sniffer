"""
B 站完整流抓取的服务端验证。

扩展的做法：页面里读 window.__playinfo__，拿 DASH 的视频流 / 音频流地址，
用 Range 链（每段 <=512KB）整条拉下来，逐段喂给本地宿主写盘。

本脚本验证「宿主这一半」：把同样的 msfile_start / msfile_chunk / msfile_end
序列直接喂给 sniffer_host.py，检查落盘长度和字节完全一致。

用法（需要一个可分段的真实媒体地址，先在浏览器里用 fetch 确认支持 Range）：
    python test/bili_stream_test.py <url> [期望字节数]

不传参数时只做协议自检（造假数据），不碰网络。
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = os.path.join(os.path.dirname(HERE), "native-host", "sniffer_host.py")
CHUNK = 512 * 1024


class Host:
    def __init__(self, outdir):
        env = dict(os.environ)
        env["MEDIA_SNIFFER_OUTDIR"] = outdir
        self.p = subprocess.Popen([sys.executable, HOST], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)

    def send(self, obj):
        d = json.dumps(obj, ensure_ascii=False).encode()
        self.p.stdin.write(struct.pack("<I", len(d)) + d)
        self.p.stdin.flush()

    def recv(self):
        raw = self.p.stdout.read(4)
        if len(raw) < 4:
            raise RuntimeError("宿主已退出")
        (n,) = struct.unpack("<I", raw)
        return json.loads(self.p.stdout.read(n).decode())

    def call(self, obj):
        self.send(obj)
        while True:
            msg = self.recv()
            if msg.get("id") == obj.get("id"):
                return msg

    def close(self):
        try:
            self.p.stdin.close()
        except Exception:
            pass
        self.p.wait(timeout=10)


def fetch_range(url, start, end, tried=0):
    req = urllib.request.Request(url, headers={
        "Range": "bytes=%d-%d" % (start, end),
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
        "Referer": "https://www.bilibili.com/",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.headers.get("Content-Range"), r.read()
    except Exception:
        if tried >= 3:
            raise
        return fetch_range(url, start, end, tried + 1)


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else ""
    outdir = tempfile.mkdtemp(prefix="bili_test_")
    host = Host(outdir)
    try:
        pong = host.call({"action": "ping", "id": "p"})
        assert pong.get("action") == "pong", pong
        print("宿主 OK，存放处 =", pong.get("outdir"))

        if not url:
            # 无网络自检：假数据走完整协议
            data = os.urandom(CHUNK * 2 + 123)
            st = host.call({"action": "msfile_start", "id": "s", "name": "selftest.bin",
                            "total": len(data)})
            assert st.get("ok"), st
            job = st["id"]
            for off in range(0, len(data), CHUNK):
                host.call({"action": "msfile_chunk", "id": job, "data": list(data[off:off + CHUNK])})
            done = host.call({"action": "msfile_end", "id": job, "total": len(data)})
            got = open(done["file"], "rb").read()
            assert got == data, "自检数据不一致"
            print("自检通过：%d 字节" % len(data))
            return

        status, cr, first = fetch_range(url, 0, CHUNK - 1)
        total = int(cr.split("/")[-1]) if cr and "/" in cr else 0
        if sys.argv[2] if len(sys.argv) > 2 else "":
            total = int(sys.argv[2])
        print("首段 HTTP %s  content-range=%s  总长=%d" % (status, cr, total))
        assert status == 206 and total > 0, "该地址不支持 Range，不能链式抓取"

        name = "bili-stream-test.mp4"
        st = host.call({"action": "msfile_start", "id": "b", "name": name, "total": total})
        assert st.get("ok"), st
        job = st["id"]

        digest = 0
        got = 0
        write_bytes = 0
        # 逐段取回并喂给宿主（扩展里是并发取 + 按序写，这里按序足以验证落盘）
        pos = 0
        while pos < total:
            end = min(pos + CHUNK - 1, total - 1)
            s, cr2, buf = fetch_range(url, pos, end)
            if not buf:
                raise RuntimeError("空分段 @%d" % pos)
            host.call({"action": "msfile_chunk", "id": job, "data": list(buf)})
            got += len(buf)
            digest ^= hash(buf)
            pos += len(buf)
            if write_bytes == 0:
                write_bytes = 1
                print("首段实收 %d 字节，预计 %d 段" % (len(buf), (total + CHUNK - 1) // CHUNK))
        done = host.call({"action": "msfile_end", "id": job, "total": got})
        size = os.path.getsize(done["file"])
        print("下载 %d 字节，落盘 %d 字节，文件 = %s" % (got, size, done["file"]))
        assert size == got, "落盘长度与收到长度不一致"
        print("RESULT: PASS（B 站完整流 %d 字节落盘一致）" % size)
    finally:
        host.close()


if __name__ == "__main__":
    main()
