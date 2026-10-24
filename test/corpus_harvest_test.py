#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""T-F1 语料采集器的离线测试（本地 HTTP 服务器，不碰真网站）。

判据（TODO T-F1）：
  · 纯度闸门：带媒体标记的页面进下载、纯图文页记 skipped（不浪费预算）、
    直接媒体 URL 走直链、抓不到的记 fetch-error；
  · 去重：同 URL 两条清单只采一次；
  · 产出：JSONL 逐条 + report.md 带错误码分布（种子数据里造一条 INTERNAL
    形态——宿主对 404 媒体报 INTERNAL？不——404 是 HTTP_404，用「无 status
    文件的超时」来造「?」桶即可，报告有分布即可）。
不依赖真网站、不依赖 ffmpeg（下载结果只断言「有记录」，不断言成败）。
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
HARVEST = os.path.join(ROOT, "tools", "corpus_harvest.py")

ok = True


def check(name, cond, extra=None):
    global ok
    if cond:
        print("PASS", name)
    else:
        ok = False
        print("FAIL", name, "" if extra is None else extra)


# ---- 本地站：带标记页 / 纯图文页 / 直链 / 404 ----
MARKED = ("<!doctype html><html><head><title>m</title></head><body>"
          "<div id='dplayer'></div><video src='/clipbin'></video></body></html>")
CLEAN = "<!doctype html><html><head><title>c</title></head><body><p>纯图文</p></body></html>"


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/marked":
            body = MARKED.encode()
        elif self.path == "/clean":
            body = CLEAN.encode()
        elif self.path == "/media.bin":
            body = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 500
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        ctype = "video/mp4" if self.path == "/media.bin" else "text/html; charset=utf-8"
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
port = srv.server_port
threading.Thread(target=srv.serve_forever, daemon=True).start()

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"

# ---- 清单：含重复（去重）与一个非 http 行 ----
tmp = os.path.join(os.environ["TEMP"], "corpus-test")
os.makedirs(tmp, exist_ok=True)
list_a = os.path.join(tmp, "a.txt")
list_b = os.path.join(tmp, "b.txt")
open(list_a, "w", encoding="utf-8").write(
    "# 注释行\n"
    "http://127.0.0.1:%d/marked tag1\n"
    "http://127.0.0.1:%d/clean\n"
    "http://127.0.0.1:%d/media.bin\n"
    "not-a-url\n" % (port, port, port))
open(list_b, "w", encoding="utf-8").write(
    "http://127.0.0.1:%d/marked\n"    # 与 a 重复 → 去重
    "http://127.0.0.1:%d/gone\n" % (port, port))  # 404 → fetch-error

import subprocess
out = os.path.join(tmp, "corpus")
import shutil
shutil.rmtree(out, ignore_errors=True)   # JSONL 是 append 模式：每轮清，防跨轮累积
os.makedirs(out, exist_ok=True)
r = subprocess.run(
    [sys.executable, HARVEST, "--input", list_a, "--input", list_b,
     "--limit", "10", "--rate", "0.05", "--outdir", out],
    capture_output=True, text=True, timeout=300,
    env=dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1"))
outtext = (r.stdout or "") + (r.stderr or "")
if r.returncode != 0:
    print(outtext[-800:])

# ---- 断言 ----
jsonls = [f for f in os.listdir(out) if f.startswith("corpus-") and f.endswith(".jsonl")]
check("JSONL 语料文件产出", len(jsonls) == 1, jsonls)
recs = [json.loads(l) for l in open(os.path.join(out, jsonls[0]), encoding="utf-8")]
check("去重：marked 只采一次（清单 a+b 共两条 marked）",
      len([x for x in recs if x["url"].endswith("/marked")]) == 1,
      [x["url"] for x in recs])
check("非 http 行被跳过", not any(x["url"] == "not-a-url" for x in recs))
marked = next((x for x in recs if x["url"].endswith("/marked")), None)
clean = next((x for x in recs if x["url"].endswith("/clean")), None)
media = next((x for x in recs if x["url"].endswith("/media.bin")), None)
gone = next((x for x in recs if x["url"].endswith("/gone")), None)
check("带媒体标记的页进了下载（有 chain 字段）",
      marked is not None and marked.get("chain") in ("ytdlp", "urllib", "hls", "reject", "?"),
      marked)
check("纯图文页被闸门拦下（skipped-no-media-mark，无 chain）",
      clean is not None and clean.get("outcome") == "skipped-no-media-mark"
      and "chain" not in clean, clean)
check("直接媒体 URL 走直链（purity=direct）",
      media is not None and media.get("purity") == "direct", media)
check("404 记 fetch-error（不浪费下载预算）",
      gone is not None and gone.get("outcome") == "skipped-fetch-error", gone)

reps = [f for f in os.listdir(out) if f.startswith("report-") and f.endswith(".md")]
check("分布报告产出", len(reps) == 1)
if reps:
    rep = open(os.path.join(out, reps[0]), encoding="utf-8").read()
    check("报告有错误码分布节", "## 错误码分布" in rep)
    check("报告有链分布节", "## 链分布" in rep)
    check("报告声明「语料非测试」", "不是测试报告" in rep)

srv.shutdown()
print()
print("=" * 50)
if ok:
    print("全部通过")
    sys.exit(0)
print("有失败项")
sys.exit(1)
