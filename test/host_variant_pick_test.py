#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""S1「选清晰度」（T-C1）的离线验证。

判据是 PRODUCT-PLAN 的 S1-2：**选非默认档下载，实际下到的就是那一档**。
真机上这一步靠 `ffprobe` 量宽高；本机没有能跑的 ffmpeg，所以这里用**等价证据**：
起一个真 HTTP 服务器，给 master 里两档各挂不同的子清单与分片路径，
然后看下载器**到底请求了哪条子清单**。请求了哪档的分片，就是下了哪档。

顺带锁住三件容易写错的事：

  1. `child`（默认档）必须按**分辨率**选，不能按带宽 —— 实测有站给
     「高码率 480p + 低码率 1080p」，按带宽排会挑到 480p。
  2. 用户选的档如果已经不在清单里（地址轮换），必须**回落并说出来**，
     不能默默下成默认档：用户点了 1080 拿到 720 却不知道，比报错更糟。
  3. `variants` 要真的解析出来（带宽 / 分辨率 / 绝对地址）—— 解析不出来，
     popup 就没有档位可选，这一刀等于没做。

用法： python test/host_variant_pick_test.py
"""
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

TMP = tempfile.mkdtemp(prefix="ms-variant-test-")
JOBS = os.path.join(TMP, "jobs")
os.makedirs(JOBS, exist_ok=True)

import downloader as D  # noqa: E402

D.JOBS_DIR = JOBS
D.status_path = lambda jid: os.path.join(JOBS, jid + ".json")
D.cancel_path = lambda jid: os.path.join(JOBS, jid + ".cancel")
D.DEFAULT_OUT = TMP

ok = True


def check(name, cond, extra=None):
    global ok
    if cond:
        print("PASS", name)
    else:
        ok = False
        print("FAIL", name, "" if extra is None else extra)


def read_status(jid):
    p = os.path.join(JOBS, jid + ".json")
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return {}


# ---------------------------------------------------------------- 1. 纯函数

print("[1] pick_variant：选哪一档")

V = [
    {"url": "http://h/1080.m3u8", "bandwidth": 2_000_000, "w": 1920, "h": 1080},
    {"url": "http://h/720.m3u8", "bandwidth": 5_000_000, "w": 1280, "h": 720},
    {"url": "http://h/480.m3u8", "bandwidth": 900_000, "w": 854, "h": 480},
]

check("不给 want → 取分辨率最高（1080，不是带宽最高的 720）",
      D.pick_variant(V)["url"] == "http://h/1080.m3u8", D.pick_variant(V))
check("want=完整 URL → 精确命中", D.pick_variant(V, "http://h/720.m3u8")["url"] == "http://h/720.m3u8")
check("want=1080 → 命中 1080 档", D.pick_variant(V, "1080")["url"] == "http://h/1080.m3u8")
check("want=1080p → 也认", D.pick_variant(V, "1080p")["url"] == "http://h/1080.m3u8")
check("want=1280x720 → 按高度命中", D.pick_variant(V, "1280x720")["url"] == "http://h/720.m3u8")
check("want=999（清单里没有）→ 回落最佳", D.pick_variant(V, "999")["url"] == "http://h/1080.m3u8")
check("回落时 fell_back=True（调用方必须说出来）", D.pick_variant(V, "999")["fell_back"] is True)
check("正常命中时 fell_back=False", D.pick_variant(V, "720")["fell_back"] is False)
check("空列表不炸，返回空 url", D.pick_variant([])["url"] == "")

# 同分辨率两档（不同码率）→ 取码率高的那档
V2 = [
    {"url": "http://h/1080-lo.m3u8", "bandwidth": 1_000_000, "w": 1920, "h": 1080},
    {"url": "http://h/1080-hi.m3u8", "bandwidth": 4_000_000, "w": 1920, "h": 1080},
]
check("同分辨率取高码率", D.pick_variant(V2, "1080")["url"] == "http://h/1080-hi.m3u8")

# 没有 RESOLUTION 的档（只有带宽）→ 不硬猜分辨率，排到最后
V3 = [
    {"url": "http://h/nores.m3u8", "bandwidth": 9_000_000, "w": 0, "h": 0},
    {"url": "http://h/480.m3u8", "bandwidth": 500_000, "w": 854, "h": 480},
]
check("没有 RESOLUTION 的档不会因为带宽高而当默认",
      D.pick_variant(V3)["url"] == "http://h/480.m3u8", D.pick_variant(V3))

# ---------------------------------------------------------------- 2. 清单解析

print("[2] parse_hls_playlist：variants 要真的解析出来")

MASTER = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080
v/1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1280x720
v/720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480
/v/480.m3u8
"""
info = D.parse_hls_playlist(MASTER, "http://h/live/master.m3u8")
check("kind=master", info["kind"] == "master", info["kind"])
check("variants 解析出 3 档", len(info["variants"]) == 3, info["variants"])
check("相对地址被补成绝对地址",
      info["variants"][0]["url"] == "http://h/live/v/1080.m3u8", info["variants"][0]["url"])
check("站内绝对路径也补对了",
      info["variants"][2]["url"] == "http://h/v/480.m3u8", info["variants"][2]["url"])
check("分辨率被解析出来", (info["variants"][0]["w"], info["variants"][0]["h"]) == (1920, 1080),
      info["variants"][0])
check("child 默认是 1080（按分辨率，不按带宽）",
      info["child"] == "http://h/live/v/1080.m3u8", info["child"])

# ---------------------------------------------------------------- 3. 端到端

print("[3] 端到端：选哪档就请求哪档的分片")

HITS = []


def seg(n):
    return b"G" * 188 * n


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        HITS.append(self.path)
        p = self.path.split("?")[0]
        body = None
        ctype = "application/vnd.apple.mpegurl"
        if p == "/master.m3u8":
            body = (
                "#EXTM3U\n"
                "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080\n"
                "/hi/index.m3u8\n"
                "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1280x720\n"
                "/lo/index.m3u8\n"
            ).encode()
        elif p == "/hi/index.m3u8":
            body = (b"#EXTM3U\n#EXTINF:6.0,\n/hi/s1.ts\n#EXTINF:6.0,\n/hi/s2.ts\n"
                    b"#EXT-X-ENDLIST\n")
        elif p == "/lo/index.m3u8":
            body = (b"#EXTM3U\n#EXTINF:6.0,\n/lo/s1.ts\n#EXTINF:6.0,\n/lo/s2.ts\n"
                    b"#EXT-X-ENDLIST\n")
        elif p.endswith(".ts"):
            body = seg(3)
            ctype = "video/mp2t"
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:%d" % port


def run_job(jid, variant=""):
    HITS.clear()
    outdir = os.path.join(TMP, jid)
    os.makedirs(outdir, exist_ok=True)
    job = {"id": jid, "url": BASE + "/master.m3u8", "kind": "video",
           "filename": jid + ".mp4", "outdir": outdir, "concurrency": 2}
    if variant:
        job["variant"] = variant
    D.run_hls_self(job)
    return read_status(jid), outdir


st, out1 = run_job("v-auto")
check("不选档 → 请求的是 1080 那条子清单", "/hi/index.m3u8" in HITS, HITS)
check("不选档 → 只下 1080 的分片，不碰 720", all("/lo/" not in h for h in HITS), HITS)
check("状态里记下了实际清晰度 1920x1080", st.get("quality") == "1920x1080", st.get("quality"))
check("下载成功（ts 拼出来了）", st.get("status") == "done", st)

st2, out2 = run_job("v-720", BASE + "/lo/index.m3u8")
check("选 720 → 请求的是 720 那条子清单", "/lo/index.m3u8" in HITS, HITS)
check("选 720 → 完全不碰 1080 的分片", all("/hi/" not in h for h in HITS), HITS)
check("选 720 → 状态里 quality=1280x720", st2.get("quality") == "1280x720", st2.get("quality"))

st3, out3 = run_job("v-gone", BASE + "/nope/index.m3u8")
check("选了一档已不在清单里 → 回落 1080 仍然下成", "/hi/index.m3u8" in HITS, HITS)
check("回落要**说出来**（message 里有「已经不在这条清单里」）",
      "已经不在这条清单里" in (st3.get("message") or ""), st3.get("message"))
check("回落时 quality 记的是**实际**下的那档（1920x1080），不是用户点的那档",
      st3.get("quality") == "1920x1080", st3.get("quality"))

st4, out4 = run_job("v-num", "720")
check("用分辨率标记「720」也能选中（popup 只传高度时的路径）",
      "/lo/index.m3u8" in HITS, HITS)

srv.shutdown()

print("RESULT:", "ALL PASS" if ok else "HAS FAILURES")
sys.exit(0 if ok else 1)
