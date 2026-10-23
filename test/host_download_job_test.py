#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""离线自测：downloader.py 的入口判断（不起浏览器、不联网）。

覆盖两个线上踩过的坑：
  1) Telegram 的 document… 被丢给 yt-dlp → yt-dlp 当网页爬 → HTTP 302
  2) 相对地址压根不该交给外部进程
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

import downloader as D  # noqa: E402

TMP = tempfile.mkdtemp(prefix="ms-dl-test-")
D.JOBS_DIR = TMP
D.status_path = lambda job_id: os.path.join(TMP, job_id + ".json")


# 注意：必须让 downloader 自己的 status_path 指向临时目录。
# 只改 D.JOBS_DIR 不够——函数在下面重绑，status_path 还会走默认的
# %LOCALAPPDATA%\MediaSniffer\jobs，测试就会读到上一次跑残留的状态。

results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  -> " + str(extra)))


def job(**kw):
    j = {"id": kw.pop("id", "t"), "url": "https://example.invalid/a.mp4", "kind": "video",
         "filename": "x", "outdir": TMP}
    j.update(kw)
    return j


# 1) 相对地址 → 直接失败，且提示去页面保存，绝不进 yt-dlp
path = os.path.join(TMP, "rel.job.json")
json.dump(job(id="rel", url="document6208389833551777399"), open(path, "w", encoding="utf-8"))
called = {"ytdlp": 0, "urllib": 0, "hls": 0}
D.run_ytdlp = lambda *a, **k: called.__setitem__("ytdlp", called["ytdlp"] + 1)
D.run_urllib = lambda *a, **k: called.__setitem__("urllib", called["urllib"] + 1)
D.run_urllib = D.run_urllib
sys.argv = ["downloader.py", path]

# 重新包一层 main，避免 monkeypatch 被 main 里的局部引用绕过
orig_urllib = D.run_urllib
D.run_urllib = lambda j: called.__setitem__("urllib", called["urllib"] + 1)
D.main()
st = json.load(open(os.path.join(TMP, "rel.json"), encoding="utf-8"))
check("相对地址不进任何下载器", called == {"ytdlp": 0, "urllib": 0, "hls": 0}, called)
check("相对地址给出可读错误", st.get("status") == "error" and "页面" in (st.get("message") or ""), st)

# 2) 直链媒体 → 不经过 yt-dlp，直接 urllib
called.update(ytdlp=0, urllib=0, hls=0)
path2 = os.path.join(TMP, "direct.job.json")
json.dump(job(id="direct", url="https://web.telegram.org/a/progressive/document123"), open(path2, "w", encoding="utf-8"))
sys.argv = ["downloader.py", path2]
D.main()
check("progressive 直链不走 yt-dlp", called["ytdlp"] == 0 and called["urllib"] == 1, called)

# 3) m3u8 → 走 yt-dlp；yt-dlp 失败后自动兜底 urllib
D.find_tool = lambda names: ("C:/fake/yt-dlp.exe" if "yt-dlp" in names else None)


def fake_ytdlp_fail(j, ytdlp, ffmpeg):
    called["ytdlp"] += 1          # 必须计入计数，只写状态文件的话断言永远看不到
    D.write_status(j["id"], status="error", message="ERROR: HTTP Error 302: Moved Temporarily")


D.run_ytdlp = fake_ytdlp_fail
D.run_urllib = lambda j: called.__setitem__("urllib", called["urllib"] + 1)


# 2026-10-22 新增第三条路：伪装分片的 m3u8（分片是「图片壳 + TS」）自己下。
# 这里必须一起打桩，否则测试会真的去连 example.invalid（走系统代理要好几秒）。
def fake_hls_fail(j, quiet=False):
    called["hls"] += 1
    D.write_status(j["id"], status="error", message="拉取播放列表失败：HTTP 404 Not Found")
    return True


D.run_hls_self = fake_hls_fail
path3 = os.path.join(TMP, "hls.job.json")
json.dump(job(id="hls3", url="https://example.invalid/live/index.m3u8"), open(path3, "w", encoding="utf-8"))
sys.argv = ["downloader.py", path3]
# 先清掉：上面「直链」那次也计进了 urllib，不清就分不清这一轮的归属
called.update(ytdlp=0, urllib=0, hls=0)
D.main()
# 2026-10-22 起顺序是「自实现 HLS → yt-dlp → 直连」：分片是不是「图片壳 + TS」
# 只有下第一片才知道，而 yt-dlp 遇到壳会一路重试到超时（4kvm 实测几分钟还停在 0%）。
check("m3u8 先走自实现 HLS（不等 yt-dlp 重试到超时）", called["hls"] == 1, called)
check("自实现 HLS 搞不定时交给 yt-dlp", called["ytdlp"] == 1, called)
check("yt-dlp 302 后自动兜底直连", called["urllib"] == 1, called)

# 4) 两者都失败 → 错误里同时保留两条信息
def fake_urllib_fail(j):
    D.write_status(j["id"], status="error", message="HTTP 403 Forbidden")


D.run_urllib = fake_urllib_fail
path4 = os.path.join(TMP, "both.job.json")
json.dump(job(id="both4", url="https://example.invalid/live/index.m3u8"), open(path4, "w", encoding="utf-8"))
sys.argv = ["downloader.py", path4]
D.main()
st4 = json.load(open(os.path.join(TMP, "both4.json"), encoding="utf-8"))
check("双失败时两条原因都保留",
      st4.get("status") == "error" and "yt-dlp" in st4.get("message", "") and "直连" in st4.get("message", ""), st4)
check("三路全失败时自实现 HLS 的原因也保留（不然用户只看到 yt-dlp 的 404）",
      "自实现 HLS" in st4.get("message", ""), st4)

print("RESULT: " + ("ALL PASS" if all(results) else "FAILED %d" % results.count(False)))
sys.exit(0 if all(results) else 1)
