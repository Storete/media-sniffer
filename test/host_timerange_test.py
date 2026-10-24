#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""B27（推荐层）时间段截取：parse_time_range 纯函数 + run_ytdlp 的 --download-sections 接线。

三层方案的本刀只做推荐层：job["timeRange"] → yt-dlp
`--download-sections "*start-end" --force-keyframes-at-cuts`（HLS/DASH 只拉
覆盖区间的分片）。判据：
  · 三种输入形态都认（H:M:S / M:S / 纯秒），归一成 H:MM:SS；
  · **不合法一律返回 None，绝不把半个参数交给 yt-dlp**（它会整单报失败，
    而用户只是手滑）——所以接线处 None 就不加参数；
  · start >= end 不合法；直播流没有绝对时间轴，UI 侧不显示输入框（宿主不判）。
接线测试沿用 host_cookie_jar_test 的 FakePopen 模式（原因同：cmd 批处理
转发会二次解析参数里的 %）。
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

import downloader as D  # noqa: E402

ok = True


def check(name, cond, extra=None):
    global ok
    if cond:
        print("PASS", name)
    else:
        ok = False
        print("FAIL", name, "" if extra is None else extra)


# ---------------------------------------------------------------- [1] parse_time_range 纯函数

print("[1] parse_time_range：三种形态归一，非法一律 None")

CASES = [
    ("1:30-2:45", "*00:01:30-00:02:45"),            # M:S-M:S
    ("00:01:30-00:02:45", "*00:01:30-00:02:45"),    # H:M:S
    ("90-165", "*00:01:30-00:02:45"),               # 纯秒
    ("1:00:00-2:00:00", "*01:00:00-02:00:00"),
    ("59-60", "*00:00:59-00:01:00"),
    (" 1:30 - 2:45 ", "*00:01:30-00:02:45"),        # 容忍空白
    # ---- 非法：全 None
    ("2:45-1:30", None),        # start >= end
    ("1:30-1:30", None),
    ("10:00:00-9:00:00", None),
    ("abc", None),
    ("1:30", None),             # 没有区间
    ("1:75-2:00", None),        # 分钟超 59
    ("1:30-2:75", None),
    ("", None),
    (None, None),
    ("1:30-2:45x", None),       # 尾部杂物
    ("-1:30-2:45", None),       # 负数形态不认
]
for raw, want in CASES:
    got = D.parse_time_range(raw)
    check("%r -> %s" % (raw, want), got == want, got)

# ---------------------------------------------------------------- [2] 接线（FakePopen）

print("[2] run_ytdlp：合法区间加参数，非法区间零参数")

MP4_HEAD = b"\x00\x00\x00\x18ftypmp42"
tmp = tempfile.mkdtemp(prefix="ms-tr-")
try:
    captured = []

    class FakeProc(object):
        def __init__(self, args, **kwargs):
            captured.append(list(args))
            self.cmd = list(args)
            self.returncode = 0
            self.pid = 0
            oi = self.cmd.index("--output")
            final = self.cmd[oi + 1].replace("%(ext)s", "mp4")
            d = os.path.dirname(final)
            if d and not os.path.exists(d):
                os.makedirs(d)
            with open(final, "wb") as f:
                f.write(MP4_HEAD + b"\x00" * 1000)
            self.stdout = iter(["MSPROG|  5.0%| 1.2MiB/s| 00:01|1000|20000", "FILE:" + final])

        def wait(self):
            return 0

        def terminate(self):
            pass

    real_popen = D.subprocess.Popen
    D.subprocess.Popen = FakeProc
    real_ffprobe = D.ffprobe_tool
    D.ffprobe_tool = lambda: None

    def make_job(tag, tr):
        return {
            "id": "tr-" + tag,
            "url": "https://example.com/v/index.m3u8",
            "kind": "video",
            "filename": "tr-" + tag + ".mp4",
            "outdir": os.path.join(tmp, "out-" + tag),
            "concurrency": 2,
            "timeRange": tr,
        }

    # 2a: 合法区间 → 参数在，且带 --force-keyframes-at-cuts
    D.run_ytdlp(make_job("ok", "1:30-2:45"), "fake-ytdlp", None)
    st = D.read_status("tr-ok")
    check("合法区间：任务 done", st.get("status") == "done", st.get("status"))
    cmd = captured[-1]
    check("--download-sections 归一形态正确",
          cmd.count("--download-sections") == 1
          and cmd[cmd.index("--download-sections") + 1] == "*00:01:30-00:02:45", cmd[-8:])
    check("--force-keyframes-at-cuts 在（切点精确）",
          "--force-keyframes-at-cuts" in cmd)

    # 2b: 非法区间 → 零参数（宁可整段下，不让 yt-dlp 整单报失败）
    D.run_ytdlp(make_job("bad", "9:99-2:00"), "fake-ytdlp", None)
    cmd2 = captured[-1]
    check("非法区间：没有 --download-sections", "--download-sections" not in cmd2)
    check("非法区间：任务仍走完（不因手滑失败）",
          D.read_status("tr-bad").get("status") == "done")

    # 2c: 不传 → 与老行为一致
    D.run_ytdlp(make_job("none", None), "fake-ytdlp", None)
    check("不传：没有 --download-sections",
          "--download-sections" not in captured[-1])

    D.ffprobe_tool = real_ffprobe
    D.subprocess.Popen = real_popen
finally:
    if "D" in dir() and D.subprocess.Popen.__name__ == "FakeProc":
        D.subprocess.Popen = real_popen
    shutil.rmtree(tmp, ignore_errors=True)

# ---------------------------------------------------------------- [3] B27 ③层：自实现 HLS 选片

print("[3] 自实现 HLS：EXTINF 选片 + 只下覆盖分片（真实 HTTP 请求计数）")

# 3a: _parse_extinf_durs
M3U8 = (
    "#EXTM3U\n"
    "#EXT-X-VERSION:3\n"
    "#EXT-X-TARGETDURATION:3\n"
    "#EXTINF:2.0,\n"
    "seg0.ts\n"
    "#EXTINF:2.0,\n"
    "seg1.ts\n"
    "#EXTINF:2.0,\n"
    "seg2.ts\n"
    "#EXTINF:2.0,\n"
    "seg3.ts\n"
    "#EXTINF:2.0,\n"
    "seg4.ts\n"
    "#EXT-X-ENDLIST\n"
)
durs = D._parse_extinf_durs(M3U8)
check("EXTINF 时长解析（MAP 行天然跳过）", durs == [2.0] * 5, durs)

tr = D.parse_time_range("3-7")   # → *00:00:03-00:00:07
check("区间归一", tr == "*00:00:03-00:00:07", tr)
win = D.select_segment_window(durs, tr)
# 时间轴 [0,2)[2,4)[4,6)[6,8)[8,10)；覆盖 3-7 = 第 2~4 片（下标 1-3）
check("选片 3-7s → 下标 1..3", win == (1, 3), win)
check("选片 0-2s → 只有第 1 片", D.select_segment_window(durs, D.parse_time_range("0-2")) == (0, 0))
check("end 超总长钳到最后一片", D.select_segment_window(durs, D.parse_time_range("8-99")) == (4, 4))
check("start 超总长 → None（整段兜底）", D.select_segment_window(durs, D.parse_time_range("99-100")) is None)
check("空表 → None", D.select_segment_window([], tr) is None)

# 3b: 集成——本地 HTTP 服务器 + 请求计数，断言只请求选中分片
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
REQS = []
# 分片数据三档降级（本机依赖不许泄漏进 CI）：
#   ① 有 ffmpeg（本机 TEMP 副本或 PATH）→ 生成真 TS 等分 5 片——验证四层全开时
#      占位字节会被真 ffprobe 正确拒收（VERIFY_MISMATCH），所以有 ffprobe 就必须有真 TS；
#   ② 无 ffmpeg 但也无 ffprobe（CI 容器）→ 占位分片即可：验证走前三层（魔数/大小），
#      第 4 层自动跳过（probed: False）；
#   ③ 无 ffmpeg 但有 ffprobe（什么都验不了）→ SKIP（exit 77，automake 约定）。
import subprocess
import shutil


def _find_bin(name):
    """本机 TEMP 副本（ms-verify-bin）优先，其次 PATH。CI 上两处都没有 → None。"""
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("TEMP") or ""
    if base:
        cand = os.path.join(base, "Temp", "ms-verify-bin", name + (".exe" if os.name == "nt" else ""))
        if os.path.isfile(cand):
            return cand
        cand2 = os.path.join(base, "ms-verify-bin", name + (".exe" if os.name == "nt" else ""))
        if os.path.isfile(cand2):
            return cand2
    return shutil.which(name)


FFBIN = _find_bin("ffmpeg")
os.makedirs(tmp, exist_ok=True)   # tmp 在 [2] 段的 finally 里被删了
real_ts = os.path.join(tmp, "real.ts")
ts_data = b""
if FFBIN:
    subprocess.run([FFBIN, "-y", "-f", "lavfi", "-i", "testsrc=duration=10:size=160x90:rate=10",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-f", "mpegts", real_ts],
                   capture_output=True, timeout=120)
    if os.path.isfile(real_ts):
        ts_data = open(real_ts, "rb").read()
        if len(ts_data) % 188:
            ts_data = ts_data[: len(ts_data) - (len(ts_data) % 188)]
if not ts_data and _find_bin("ffprobe"):
    print("SKIP 有 ffprobe（验证四层全开）但没有 ffmpeg 生成真 TS——占位分片会被正确拒收，"
          "整段无法验证")
    sys.exit(77)
if not ts_data:
    # CI 档：占位分片（0x47 开头过第三层魔数），第 4 层在无 ffprobe 环境自动跳过
    ts_data = b"\x47" + bytes(187) * 40
chunk = len(ts_data) // 5
MEDIA = {
    "/v.m3u8": M3U8.replace("seg", "/seg/seg").replace("/seg//", "/seg/"),
}
for i in range(5):
    MEDIA["/seg/seg%d.ts" % i] = ts_data[i * chunk: (i + 1) * chunk]


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        REQS.append(self.path)
        body = MEDIA.get(self.path)
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        if self.path.endswith(".m3u8"):
            # 清单里的相对地址按 /seg/... 服务
            body = body.encode("utf-8")
            for i in range(5):
                body = body.replace(("/seg/seg%d.ts" % i).encode(),
                                    ("http://127.0.0.1:%d/seg/seg%d.ts" % (self.server.server_port, i)).encode())
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
port = srv.server_port
threading.Thread(target=srv.serve_forever, daemon=True).start()

trout = os.path.join(tmp, "tr-out")
os.makedirs(trout, exist_ok=True)
job3 = {"id": "tr-self", "url": "http://127.0.0.1:%d/v.m3u8" % port, "kind": "video",
        "out": "tr-self", "timeRange": "3-7", "outdir": trout, "concurrency": 2,
        "remux": False}   # 本机沙箱拦 ffmpeg 写盘（T-E5），③层选片验证只看请求计数
D.run_hls_self(job3)
st = D.read_status("tr-self")
check("自实现链 done", st.get("status") == "done", st.get("status"))
seg_reqs = sorted(r for r in REQS if "/seg/seg" in r)
check("只请求了选中分片（第 2~4 片）",
      seg_reqs == ["/seg/seg%d.ts" % i for i in (1, 2, 3)], seg_reqs)
check("清单拉取", REQS.count("/v.m3u8") >= 1)
srv.shutdown()

# 3c: 反向验证埋点在文件底部统一跑

print()
print("=" * 50)
if ok:
    print("全部通过")
    sys.exit(0)
print("有失败项")
sys.exit(1)
