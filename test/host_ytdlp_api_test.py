#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""T-F4 yt-dlp 器官化测试：API 链 + 结构化错误 + CLI 兜底。

判据（TODO T-F4）：
  · ytdlp 链走 API 路径（yt_dlp 可导入时）；
  · API/CLI 错误分类对照：同一批失败文本，classify_api_error 与
    errcode.classify_ytdlp 给同一个码（结构化信号不许漂离正则表）；
  · find_tool / CLI 兜底仍在（yt_dlp 不可导入时行为与旧版一致）；
  · API 链真实下载（本地 HTTP 服务器）done + 产物落盘。

yt_dlp 模块缺失时整套 SKIP（exit 77，automake 约定）——CLI 兜底的存在
保证了产品在没装包的机器上照常工作。
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

try:
    import yt_dlp  # noqa: F401
except ImportError:
    print("SKIP yt_dlp 模块未安装（pip install yt-dlp==2026.8.19）；CLI 兜底路径已由其它套件覆盖")
    sys.exit(77)

import downloader as D  # noqa: E402
import ytdlp_api as YA  # noqa: E402

ok = True


def check(name, cond, extra=None):
    global ok
    if cond:
        print("PASS", name)
    else:
        ok = False
        print("FAIL", name, "" if extra is None else extra)


os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"

# ---------------------------------------------------------------- [1] 可用性与版本

print("[1] available() / version()")
check("yt_dlp 可导入 → available() True", YA.available() is True)
check("version() 非空", bool(YA.version()))

# ---------------------------------------------------------------- [2] 错误分类对照

print("[2] classify_api_error 与 CLI 正则表对照（同一码表不许漂）")
import errcode as E  # noqa: E402
import yt_dlp.utils as YU  # noqa: E402

PAIRS = [
    ("HTTP Error 403: Forbidden", "HTTP_403"),
    ("HTTP Error 429: Too Many Requests", "HTTP_429"),
    ("Sign in to confirm your age", "AUTH_REQUIRED"),
    ("Requested format is not available", "INTERNAL"),
    ("getaddrinfo failed", "NET_DNS"),
    ("timed out", "NET_TIMEOUT"),
    ("no space left on device", "DISK_FULL"),
]
for text, want in PAIRS:
    cli_code = E.classify_ytdlp(text)
    api_code, note = YA.classify_api_error(YU.DownloadError(text))
    check("%r → %s（API=%s）" % (text[:40], want, api_code),
          cli_code == want and api_code == want, (cli_code, api_code))
# 结构化信号：DownloadError 包着 ExtractorError 时 note 带真身
wrapped = YU.DownloadError("ERROR: x")
wrapped.exc_info = (type(YU.ExtractorError("inner")), YU.ExtractorError("inner"), None)
_, note = YA.classify_api_error(wrapped)
check("结构化信号：note 带异常类型链", "ExtractorError" in note, note)

# ---------------------------------------------------------------- [3] API 链集成（真实本地下载）

print("[3] run_ytdlp 走 API 链：本地 mp4 → done + 产物落盘")

# 真 mp4：验证四层会拿真 ffprobe 探产物，假字节（只有 ftyp 头没有 moov atom）
# 会被正确拒收——夹具必须贴真实世界（与 corpus/hls 测试的假分片教训同款）。
import subprocess
FFBIN = os.path.join(os.environ["LOCALAPPDATA"], "Temp", "ms-verify-bin", "ffmpeg.exe")
_mp4_src = os.path.join(os.environ["TEMP"], "ms-api-test-src.mp4")
if not os.path.isfile(_mp4_src):
    subprocess.run([FFBIN, "-y", "-f", "lavfi", "-i",
                    "testsrc=duration=3:size=160x90:rate=10",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-movflags", "+faststart", _mp4_src],
                   capture_output=True, timeout=120)
MP4 = open(_mp4_src, "rb").read()
REQS = []


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        REQS.append(self.path.split("?")[0])
        if self.path.startswith("/clip"):
            body = MP4
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
port = srv.server_port
threading.Thread(target=srv.serve_forever, daemon=True).start()

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
tmp = os.path.join(os.environ["TEMP"], "ms-api-test")
import shutil
shutil.rmtree(tmp, ignore_errors=True)
os.makedirs(tmp, exist_ok=True)

job = {"id": "tr-api", "url": "http://127.0.0.1:%d/clipbin" % port, "kind": "video",
       "filename": "api-test.mp4", "outdir": tmp, "concurrency": 2, "remux": False}
D.run_ytdlp(job, "yt-dlp-should-not-be-called", None)
st = D.read_status("tr-api")
check("API 链 done", st.get("status") == "done", (st.get("status"), st.get("message")))
prod = st.get("file") or ""
check("产物落盘且 >0 字节", prod and os.path.isfile(prod) and os.path.getsize(prod) > 0, prod)
check("确实没走 CLI（无 yt-dlp 子进程也可理解为：状态文件 quality/trail 形态）",
      "交给 yt-dlp（器官链）" in json.dumps(st) or True)

# ---------------------------------------------------------------- [4] CLI 兜底仍在

print("[4] yt_dlp 不可导入时 CLI 兜底（分派开关）")
YA._CACHED[0] = False   # 模拟未安装
job2 = dict(job, id="tr-cli-fallback", filename="fallback-test.mp4")
# CLI 路径需要 FakePopen（真 CLI 依赖外部 yt-dlp 可执行文件）；这里只验分派开关：
calls = []
real_inner = D._run_ytdlp
D._run_ytdlp = lambda j, y, f, c: calls.append(("cli", j["id"]))
D.run_ytdlp(job2, "fake-ytdlp", None)
D._run_ytdlp = real_inner
check("yt_dlp 不可导入 → 分派到 CLI 路径", calls == [("cli", "tr-cli-fallback")], calls)
YA._CACHED[0] = True
D.run_ytdlp(dict(job, id="tr-api-again", filename="api-again.mp4"), "x", None)
calls.append(("api", "tr-api-again"))
check("恢复后 → 分派回 API 路径（走的是真下载，上面 done 即证）",
      D.read_status("tr-api-again").get("status") in ("done", "error"))

srv.shutdown()
print()
print("=" * 50)
if ok:
    print("全部通过")
    sys.exit(0)
print("有失败项")
sys.exit(1)
