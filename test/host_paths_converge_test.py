#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""离线自测：同一个原因，三条路径必须给**同一个码、同一句话**（T-B5 / P3'）。

为什么要有这一套
----------------
d-054 把「为什么失败」变成了码表，但只接了 HTTP 那一条路径。另外两条还在各说各话：

    HLS  ："拉取播放列表失败：HTTP 403 Forbidden（该站地址有时效，请刷新页面后重试）"
    yt-dlp："ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden"
    直连  ："站点拒绝了这个请求（403）。多半是防盗链：刷新页面重新抓一次。"

三条路都在描述**同一件事**，用户看到的却是三种语言 —— 其中两种还是英文。
更糟的是 main() 的兜底链：三条都失败时它把三句话拼成一条

    "自实现 HLS: … ／ yt-dlp: … ／ 直连: …"

这是写给作者看的。用户拿到一条 200 字的串，反而更不知道该干什么。

本套件钉五件事
--------------
  · `classify_ytdlp` 认得真机见过的那几种英文说法，且**不许**把它们落进兜底桶；
  · 403 / 500 在三条路径上 `err` 相同、`message` 逐字相同；
  · 「清单当文件下」在直连与 yt-dlp 两条路上同码同文案（这个坑撞过两次真机）；
  · 三条都失败时，对外只留一个码一句话，三条原话进 `trail`（机器看三条，人看一句）；
  · 宿主 `poll_job` 必须把 `err` 转发给扩展 —— 这一跳漏过一次，
    downloader 写了、background 也读了，中间的宿主不转发，于是 UI 上永远没有码。

关于「怎么假装 yt-dlp 失败」
--------------------------
不用真的造一个可执行文件：Windows 下 `Popen` 启动 `.cmd` 时，整条命令行会被
cmd.exe 再解析一遍，而我们传的 `--progress-template` 里带 `|` 和 `%`
（`download:MSPROG|%(progress._percent_str)s|…`），会被当成管道拆开执行，
报出 `'%' 不是内部或外部命令` —— 假程序还没跑起来就已经不是被测对象了。
所以在 `subprocess` 这一层打个假：只换掉 `Popen`，其余（读 stdout、判退出码、
扫 ERROR 行、找产物）全是真代码。真实进程启动不是这一刀改的东西。
"""
import contextlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

import downloader as D  # noqa: E402
import errcode as E  # noqa: E402

TMP = tempfile.mkdtemp(prefix="ms-converge-")
D.JOBS_DIR = os.path.join(TMP, "jobs")
os.makedirs(D.JOBS_DIR, exist_ok=True)

results = []
CMDS = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  -> " + str(extra)))


def fresh(sub):
    d = os.path.join(TMP, sub)
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d, exist_ok=True)
    return d


# ---------------------------------------------------------------- 假站点
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/403"):
            self.send_error(403)
            return
        if self.path.startswith("/500"):
            self.send_error(500)
            return
        if self.path.startswith("/pl.m3u8"):
            body = b"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\na.ts\n"
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.apple.mpegurl")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True


SRV = Server(("127.0.0.1", 0), Handler)
PORT = SRV.server_address[1]
threading.Thread(target=SRV.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:%d" % PORT


# ---------------------------------------------------------------- 假 yt-dlp
class _Proc:
    def __init__(self, lines, rc):
        self.stdout = iter(lines)
        self.returncode = rc

    def wait(self):
        return self.returncode

    def terminate(self):
        pass


class _Sub:
    PIPE = subprocess.PIPE
    STDOUT = subprocess.STDOUT
    DEVNULL = subprocess.DEVNULL

    def __init__(self, lines, rc):
        self.lines, self.rc = lines, rc

    def Popen(self, cmd, **kw):   # noqa: N802  （模仿 stdlib 的名字）
        CMDS.append(cmd)
        return _Proc(self.lines, self.rc)


@contextlib.contextmanager
def fake_ytdlp(lines, rc=1):
    real = D.subprocess
    D.subprocess = _Sub(list(lines), rc)
    try:
        yield
    finally:
        D.subprocess = real


def job(job_id, url, outdir, filename, **kw):
    j = {"id": job_id, "url": url, "kind": "video", "filename": filename,
         "outdir": outdir, "concurrency": 2, "remux": False}
    j.update(kw)
    return j


def status(job_id):
    return D.read_status(job_id) or {}


# ---------------------------------------------------------------- [1] 翻译表
print("[1] classify_ytdlp：把 yt-dlp 的英文说法翻成码")

CASES = [
    ("ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden", "HTTP_403"),
    ("ERROR: unable to download video data: HTTP Error 404: Not Found", "HTTP_404"),
    ("ERROR: Unable to download JSON metadata: HTTP Error 429: Too Many Requests", "HTTP_429"),
    ("ERROR: unable to download video data: HTTP Error 503: Service Unavailable", "HTTP_503"),
    ("ERROR: [generic] None: HTTP Error 401: Unauthorized", "AUTH_REQUIRED"),
    ("ERROR: unable to download video data: <urlopen error timed out>", "NET_TIMEOUT"),
    ("ERROR: unable to download video data: [Errno 10054] connection reset by peer", "NET_TIMEOUT"),
    ("ERROR: <urlopen error [Errno 11001] getaddrinfo failed>", "NET_DNS"),
    ("ERROR: This video is DRM protected", "DRM_PROTECTED"),
    ("ERROR: [generic] Sign in to confirm your age. This video may be inappropriate", "AUTH_REQUIRED"),
    ("ERROR: [Errno 28] No space left on device", "DISK_FULL"),
    ("ERROR: [hlsnative] Unsupported codec", "CODEC_UNSUPPORTED"),
]
for text, want in CASES:
    got = E.classify_ytdlp(text)
    check("「%s…」→ %s" % (text[:44], want), got == want, got)

check("没见过的话落进兜底桶（不许硬猜）",
      E.classify_ytdlp("ERROR: something we have never seen") == E.INTERNAL)
check("空输出落进兜底桶（不许报成功）", E.classify_ytdlp("") == E.INTERNAL)
check("已知说法一个都不许落进 INTERNAL",
      all(E.classify_ytdlp(t) != E.INTERNAL for t, _ in CASES))


# ---------------------------------------------------------------- [2] 共识
print("[2] consensus：三条路径三个码时，对外只留一个")

check("三条一致 → 就用它", E.consensus(["HTTP_403", "HTTP_403", "HTTP_403"]) == "HTTP_403")
check("空列表 → 兜底桶", E.consensus(["", None]) == E.INTERNAL)
check("DRM 压过 403（403 能重来，DRM 永远放不了）",
      E.consensus(["HTTP_403", "DRM_PROTECTED", "HTTP_403"]) == "DRM_PROTECTED")
check("INTERNAL 不盖住别人给出的真原因",
      E.consensus(["INTERNAL", "HTTP_403", ""]) == "HTTP_403")
check("表外 5xx 不被当成「更具体」",
      E.consensus(["HTTP_503", "NET_TIMEOUT"]) == "NET_TIMEOUT")


# ---------------------------------------------------------------- [3] 403 三路径
print("[3] 403：直连 / 自实现 HLS / yt-dlp 必须同码同文案")

d = fresh("403")
D.run_urllib(job("c-http-403", BASE + "/403.bin", d, "a.bin", headers={}))
st_http = status("c-http-403")

d2 = fresh("403h")
D.run_hls_self(job("c-hls-403", BASE + "/403.m3u8", d2, "b.mp4"), quiet=True)
st_hls = status("c-hls-403")

d3 = fresh("403y")
with fake_ytdlp(["ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden"], 1):
    D.run_ytdlp(job("c-yt-403", BASE + "/403.m3u8", d3, "c.mp4"), "yt-dlp", None)
st_yt = status("c-yt-403")

check("直连 403 → 码是 HTTP_403", st_http.get("err") == "HTTP_403", st_http)
check("自实现 HLS 拉清单 403 → 码是 HTTP_403", st_hls.get("err") == "HTTP_403", st_hls)
check("yt-dlp 403 → 码是 HTTP_403（英文被翻掉了）", st_yt.get("err") == "HTTP_403", st_yt)

msgs = {st_http.get("message"), st_hls.get("message"), st_yt.get("message")}
check("三条路的话**逐字相同**（%s）" % E.describe("HTTP_403"),
      len(msgs) == 1 and msgs.copy().pop() == E.describe("HTTP_403"), msgs)
check("三条路的提示里都不含英文原串",
      all("Forbidden" not in (s.get("message") or "") for s in (st_http, st_hls, st_yt)))


# ---------------------------------------------------------------- [4] 500 三路径
print("[4] 500（表外码）：三条路仍然同码同文案，且留住原数字")

d = fresh("500")
D.run_urllib(job("c-http-500", BASE + "/500.bin", d, "a.bin", headers={}))
st_http = status("c-http-500")

d2 = fresh("500h")
D.run_hls_self(job("c-hls-500", BASE + "/500.m3u8", d2, "b.mp4"), quiet=True)
st_hls = status("c-hls-500")

d3 = fresh("500y")
with fake_ytdlp(["ERROR: unable to download video data: HTTP Error 500: Server Error"], 1):
    D.run_ytdlp(job("c-yt-500", BASE + "/500.m3u8", d3, "c.mp4"), "yt-dlp", None)
st_yt = status("c-yt-500")

check("直连 500 → HTTP_500（不合并成 HTTP_OTHER）", st_http.get("err") == "HTTP_500", st_http)
check("HLS 500 → HTTP_500", st_hls.get("err") == "HTTP_500", st_hls)
check("yt-dlp 500 → HTTP_500", st_yt.get("err") == "HTTP_500", st_yt)
msgs = {st_http.get("message"), st_hls.get("message"), st_yt.get("message")}
check("三条路的话逐字相同，且带着状态码",
      len(msgs) == 1 and "500" in msgs.copy().pop(), msgs)


# ---------------------------------------------------------------- [5] 清单当文件
print("[5] 「清单当文件下」：直连与 yt-dlp 同码同文案（真机撞过两次）")

d = fresh("pl-http")
D.run_urllib(job("c-http-pl", BASE + "/pl.m3u8", d, "d.mp4", headers={}))
st_http = status("c-http-pl")

d2 = fresh("pl-yt")
pl_path = os.path.join(d2, "e.m3u8")
# 假 yt-dlp 的行为：把清单文本当普通文件写下、打印 FILE:、退出码 0 —— 与真机
# 2026-10-22 51cg1 那次一模一样（界面报完成，落盘是 29KB 的 #EXTM3U）。
with open(pl_path, "w", encoding="ascii", newline="\n") as f:
    f.write("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\na.ts\n")
with fake_ytdlp(["FILE:%s" % pl_path], 0):
    D.run_ytdlp(job("c-yt-pl", BASE + "/pl.m3u8", d2, "e.mp4"), "yt-dlp", None)
st_yt = status("c-yt-pl")

check("直连下到清单 → VERIFY_MISMATCH", st_http.get("err") == "VERIFY_MISMATCH", st_http)
check("yt-dlp 下到清单 → VERIFY_MISMATCH（不再是自由发挥的一句话）",
      st_yt.get("err") == "VERIFY_MISMATCH", st_yt)
check("两条路的话逐字相同",
      st_http.get("message") == st_yt.get("message") == E.describe(
          "VERIFY_MISMATCH", E.DETAIL_PLAYLIST, E.ACT_PLAYLIST),
      (st_http.get("message"), st_yt.get("message")))
check("建议指向「用扩展的下载按钮」（重试一百次还是清单）",
      "扩展列表里的「下载」" in (st_http.get("message") or ""), st_http.get("message"))


# ---------------------------------------------------------------- [6] 假成功
print("[6] yt-dlp 退出码 0 但什么都没下 → 不许报 done")

d = fresh("nothing")
with fake_ytdlp(["No FILE line at all"], 0):
    D.run_ytdlp(job("c-yt-none", BASE + "/403.m3u8", d, "f.mp4"), "yt-dlp", None)
st = status("c-yt-none")
check("退出码 0 但无产物 → error 而不是 done", st.get("status") == "error", st)
check("码是 VERIFY_MISMATCH（产物不对，不是网络问题）", st.get("err") == "VERIFY_MISMATCH", st)


# ---------------------------------------------------------------- [7] main 收敛
print("[7] main()：三条路都失败时只留一个码一句话，三句原话进 trail")

d = fresh("main")
job_path = os.path.join(TMP, "job-main.json")
with open(job_path, "w", encoding="utf-8") as f:
    json.dump(job("c-main", BASE + "/403.m3u8", d, "g.mp4"), f, ensure_ascii=False)

_real_find_tool = D.find_tool
D.find_tool = lambda names: ("yt-dlp" if names and names[0] == "yt-dlp" else None)
_argv = sys.argv
sys.argv = ["downloader.py", job_path]
try:
    with fake_ytdlp(["ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden"], 1):
        D.main()
finally:
    D.find_tool = _real_find_tool
    sys.argv = _argv

st = status("c-main")
check("三条都失败时状态是 error", st.get("status") == "error", st)
check("码是 HTTP_403（三条一致 → 直接用）", st.get("err") == "HTTP_403", st)
check("对外只有一句人话，不再是「自实现 HLS: … ／ yt-dlp: … ／ 直连: …」",
      st.get("message") == E.describe("HTTP_403"), st.get("message"))
check("trail 里留住了三条路径各自的码（诊断用）",
      len([x for x in (st.get("trail") or "").split(" ／ ") if "=" in x]) == 3, st.get("trail"))
check("trail 里三条路径都点了名",
      all(k in (st.get("trail") or "") for k in ("自实现HLS", "yt-dlp", "直连")), st.get("trail"))

# 三条不一致时：对外取**最具体**的那个，而不是「最后一条路的说法」。
# 现场：HLS 与直连都被 403 挡住（解不出内容），但 yt-dlp 认出了 DRM ——
# 这时候告诉用户「防盗链，刷新页面」是把他往一条永远走不通的路上推。
d = fresh("main-drm")
job_path = os.path.join(TMP, "job-drm.json")
with open(job_path, "w", encoding="utf-8") as f:
    json.dump(job("c-main-drm", BASE + "/403.m3u8", d, "h.mp4"), f, ensure_ascii=False)
sys.argv = ["downloader.py", job_path]
D.find_tool = lambda names: ("yt-dlp" if names and names[0] == "yt-dlp" else None)
try:
    with fake_ytdlp(["ERROR: This video is DRM protected"], 1):
        D.main()
finally:
    D.find_tool = _real_find_tool
    sys.argv = _argv
st = status("c-main-drm")
check("三条不一致 → 取 DRM_PROTECTED（不是最后一条的 403）",
      st.get("err") == "DRM_PROTECTED", st)
check("对外那句话也是 DRM 的那句",
      st.get("message") == E.describe("DRM_PROTECTED"), st.get("message"))


# ---------------------------------------------------------------- [8] 宿主转发
print("[8] poll_job：err 必须从状态文件转发到扩展（这一跳漏过一次）")

import sniffer_host as H  # noqa: E402

sent = []
_real_send, _real_read = H.send, H.read_status
H.send = sent.append
H.read_status = lambda job_id: {"status": "error", "err": "HTTP_403",
                                "message": E.describe("HTTP_403"), "file": "",
                                "percent": 0, "trail": "直连=HTTP_403"}
try:
    H.poll_job("x")
finally:
    H.send, H.read_status = _real_send, _real_read

final = [m for m in sent if m.get("action") == "error"]
check("收尾消息带上了 err", bool(final) and final[-1].get("err") == "HTTP_403", final)
check("收尾消息仍带 message / file / size（原有字段没被挤掉）",
      bool(final) and all(k in final[-1] for k in ("message", "file", "size")), final)


# ---------------------------------------------------------------- 汇总
print("")
ok = sum(1 for r in results if r)
print("结果：%d/%d 通过，%d 失败" % (ok, len(results), len(results) - ok))
sys.exit(0 if ok == len(results) else 1)
