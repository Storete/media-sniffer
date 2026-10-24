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

print()
print("=" * 50)
if ok:
    print("全部通过")
    sys.exit(0)
print("有失败项")
sys.exit(1)
