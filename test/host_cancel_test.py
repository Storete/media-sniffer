#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""离线自测：点「取消」必须真的停下来，不能换个下载器接着下。

2026-10-22 真机冒烟（4kvm，1.3.33）撞到：取消自实现 HLS 后，状态先是
`cancelled / 用户取消`，紧接着被覆盖成 `downloading / percent 0`，输出目录里
又开始出现文件 —— 说明 `main()` 只是「done 才 return」，`cancelled` 也照样
掉进 yt-dlp 兜底，用户点了取消等于没点。

根因在 `main()` 的这一段：

    if run_hls_self(job, quiet=True):
        st_h = read_status(job_id)
        if st_h.get("status") == "done":     # ← cancelled 不在这里
            return
        hls_msg = ...
    run_ytdlp(job, ytdlp, ffmpeg)            # ← 取消后照样执行

本套件锁三件事：
  1) `main()` 在自实现 HLS 已判定 cancelled 时**不得**再调 yt-dlp；
  2) `run_ytdlp()` 自己有守卫：已有取消标记就直接收尾，不 spawn 外部进程；
  3) `run_urllib()` 同理（它是 yt-dlp 失败后的兜底，更容易漏）。
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

import downloader as D  # noqa: E402

results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  -> " + str(extra)))


TMP = tempfile.mkdtemp(prefix="ms-cancel-")
D.JOBS_DIR = TMP
D.status_path = lambda job_id: os.path.join(TMP, job_id + ".json")
D.DEFAULT_OUT = os.path.join(TMP, "out")
os.makedirs(D.DEFAULT_OUT, exist_ok=True)


def write_cancel(job_id):
    with open(D.cancel_path(job_id), "w") as f:
        f.write("1")


def make_job(job_id, url="https://example.invalid/list.m3u8", name="c.mp4"):
    j = {"id": job_id, "url": url, "kind": "video", "filename": name,
         "outdir": D.DEFAULT_OUT, "concurrency": 4, "remux": False}
    p = os.path.join(TMP, job_id + ".job.json")
    json.dump(j, open(p, "w", encoding="utf-8"))
    return p


# ---------------------------------------------------------------- 1. main() 不越权兜底
calls = []
real_hls, real_ytdlp, real_urllib, real_find = (
    D.run_hls_self, D.run_ytdlp, D.run_urllib, D.find_tool)


def fake_hls(job, quiet=False):
    # 模拟「用户中途取消」：写 cancelled 并返回 True（= 我处理了，别往下走）
    D.write_status(job["id"], status="cancelled", percent=0, message="用户取消")
    return True


def rec_ytdlp(job, ytdlp, ffmpeg):
    calls.append("ytdlp")


def rec_urllib(job):
    calls.append("urllib")


D.run_hls_self = fake_hls
D.run_ytdlp = rec_ytdlp
D.run_urllib = rec_urllib
D.find_tool = lambda names: "/fake/" + (names[0] if names else "tool")

jobfile = make_job("cancel-main")
write_cancel("cancel-main")
old_argv = sys.argv
sys.argv = ["downloader.py", jobfile]
try:
    D.main()
finally:
    sys.argv = old_argv
    D.run_hls_self, D.run_ytdlp, D.run_urllib, D.find_tool = (
        real_hls, real_ytdlp, real_urllib, real_find)

check("取消后 main() 不再调 yt-dlp", "ytdlp" not in calls, calls)
check("取消后 main() 也不再调直连兜底", "urllib" not in calls, calls)
st = D.read_status("cancel-main")
check("状态停在 cancelled（没被后续阶段覆盖成 downloading）",
      st.get("status") == "cancelled", st.get("status"))

# ---------------------------------------------------------------- 2. run_ytdlp 自己的守卫
write_cancel("cancel-ytdlp")
j2 = {"id": "cancel-ytdlp", "url": "https://example.invalid/x.m3u8", "kind": "video",
      "filename": "c2.mp4", "outdir": D.DEFAULT_OUT}
err = None
try:
    # 第二个参数故意给一个不存在的可执行文件：真有守卫就不会去 spawn 它
    D.run_ytdlp(j2, os.path.join(TMP, "no-such-ytdlp.exe"), None)
except Exception as e:
    err = e
check("run_ytdlp 在已取消时不抛异常", err is None, repr(err))
st2 = D.read_status("cancel-ytdlp")
check("run_ytdlp 在已取消时直接写 cancelled",
      st2.get("status") == "cancelled", st2)
check("run_ytdlp 的取消提示是「用户取消」", st2.get("message") == "用户取消", st2.get("message"))

# ---------------------------------------------------------------- 3. run_urllib 同理
write_cancel("cancel-urllib")
j3 = {"id": "cancel-urllib", "url": "https://example.invalid/x.mp4", "kind": "video",
      "filename": "c3.mp4", "outdir": D.DEFAULT_OUT}
err3 = None
try:
    D.run_urllib(j3)
except Exception as e:
    err3 = e
check("run_urllib 在已取消时不抛异常", err3 is None, repr(err3))
st3 = D.read_status("cancel-urllib")
check("run_urllib 在已取消时直接写 cancelled", st3.get("status") == "cancelled", st3)
check("run_urllib 没有留下半截图",
      not any(x.endswith(".part") for x in os.listdir(D.DEFAULT_OUT)),
      os.listdir(D.DEFAULT_OUT))

# ---------------------------------------------------------------- 4. 取消要能打断分片重试
# 真机量到：点完取消还要 70 秒进程才退 —— 因为在途分片正在把 3 轮退避跑完。
# 补了 should_stop 之后，第一轮之后就该立刻放弃，不能再花剩余预算。
real_get = D._hls_get
cnt = {"n": 0}


def bad_get(url, headers, timeout=45, retries=2):
    cnt["n"] += 1
    raise OSError("boom")


D._hls_get = bad_get
seen = {"n": 0}


def should_stop():
    seen["n"] += 1
    return seen["n"] > 1        # 第一轮放行（真的发了请求），之后喊停


raised = None
try:
    D._fetch_segment("http://127.0.0.1:1/1.ts", {}, attempts=3, backoff=0.01,
                     should_stop=should_stop)
except D._Cancelled:
    raised = True
except Exception as e:
    raised = "wrong:" + type(e).__name__
finally:
    D._hls_get = real_get

check("取消能立刻打断分片重试（抛 _Cancelled，不是返回普通错误）",
      raised is True, raised)
check("只跑了一轮就停（没把 3 轮退避全跑完）", cnt["n"] == 1, cnt["n"])

print("RESULT: " + ("ALL PASS" if all(results) else "FAILED %d" % results.count(False)))
sys.exit(0 if all(results) else 1)
