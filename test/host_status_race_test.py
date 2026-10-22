#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""离线自测：状态写盘的并发健壮性 + yt-dlp 失败后清理碎片。

这两条都来自 2026-10-22 真机现场（4kvm 第二集下载失败）：

  1) 宿主每 0.4 秒用 open() 读状态文件，下载进程同时在 os.replace 原子替换。
     Windows 下目标文件被别人持有句柄时 replace 会直接
     `PermissionError: [WinError 5] 拒绝访问`。后果不是「少更新一次进度」，
     而是**最终的错误原因写不进去**：状态停在上一次的 done/100，
     用户看到「完成」、目录里却没有视频，真正的失败原因只留在内存里消失了。
  2) yt-dlp 失败会在输出目录留下 `<base>.mp4.part-FragN.part` 几十个。
     本机 safe-delete 一次删 >50 文件会被拦，所以「以后再说」等于永远清不掉。
"""
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

import downloader as D  # noqa: E402

TMP = tempfile.mkdtemp(prefix="ms-status-race-")
D.JOBS_DIR = TMP
D.status_path = lambda job_id: os.path.join(TMP, job_id + ".json")

results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  -> " + str(extra)))


_real_replace = os.replace


def patch_replace(fn):
    D.os.replace = fn


def restore_replace():
    D.os.replace = _real_replace


# ---------------------------------------------------------------- 1. 重试后成功
calls = {"n": 0}


def flaky(tmp, dst):
    calls["n"] += 1
    if calls["n"] == 1:
        raise PermissionError(13, "拒绝访问", dst)
    return _real_replace(tmp, dst)


patch_replace(flaky)
err = None
try:
    D.write_status("race1", status="error", message="真因：拉取播放列表失败 404")
except Exception as e:  # 现状会抛，这就是红点
    err = e
restore_replace()

check("首次 replace 被占用时不抛异常（重试即解决）", err is None, repr(err))
check("真的重试了（replace 调用 >= 2 次）", calls["n"] >= 2, calls["n"])
st = D.read_status("race1")
check("失败原因最终写进去了", st.get("message") == "真因：拉取播放列表失败 404", st.get("message"))
check("status 也是 error 而不是残留的 done", st.get("status") == "error", st.get("status"))
check("没有残留 .tmp 文件", not os.path.exists(os.path.join(TMP, "race1.json.tmp")),
      os.listdir(TMP))

# ---------------------------------------------------------------- 2. 一直占用也不炸
def always_busy(tmp, dst):
    raise PermissionError(13, "拒绝访问", dst)


patch_replace(always_busy)
err2 = None
try:
    D.write_status("race2", status="error", message="一直写不进去也不能崩")
except Exception as e:
    err2 = e
restore_replace()

check("replace 一直失败时也不抛异常（不能让状态写盘把下载进程打死）",
      err2 is None, repr(err2))
st2 = D.read_status("race2")
check("退化为直接覆写后仍能读到内容",
      st2.get("message") == "一直写不进去也不能崩", st2)

# ---------------------------------------------------------------- 3. 清理 yt-dlp 碎片
out = os.path.join(TMP, "out")
os.makedirs(out, exist_ok=True)
base = "77aa0dea31e85ff16ea6fb79cea2780e"

junk = [
    base + ".mp4.part",
    base + ".mp4.part-Frag1.part",
    base + ".mp4.part-Frag10.part",
    base + ".mp4.part-Frag9",
    base + ".mp4.ytdl",
]
for n in junk:
    open(os.path.join(out, n), "wb").write(b"x" * 16)

# 只下到播放列表的那种残骸（内容确实是 #EXTM3U）
with open(os.path.join(out, base + ".m3u8"), "w", encoding="utf-8") as f:
    f.write("#EXTM3U\n#EXT-X-VERSION:6\nhttp://a/1.ts\n")

# 必须保住的东西：真正的成片，以及别的任务的文件
open(os.path.join(out, base + ".mp4"), "wb").write(b"\x00\x00\x00\x18ftypisom")
open(os.path.join(out, "other-task.mp4"), "wb").write(b"\x00\x00\x00\x18ftypisom")
open(os.path.join(out, base + "-extra.mp4"), "wb").write(b"\x00\x00\x00\x18ftypisom")

has_fn = hasattr(D, "cleanup_ytdlp_junk")
check("downloader 提供 cleanup_ytdlp_junk", has_fn)
if has_fn:
    n = D.cleanup_ytdlp_junk(out, base)
    left = sorted(os.listdir(out))
    check("清理返回删除个数（5 个碎片 + 1 个清单残骸）", n == 6, n)
    check("Frag 碎片全清掉", not any("Frag" in x for x in left), left)
    check(".part / .ytdl 全清掉",
          not any(x.endswith(".part") or x.endswith(".ytdl") for x in left), left)
    check("只下到播放列表的 .m3u8 残骸也清掉", base + ".m3u8" not in left, left)
    check("真正的成片不碰（同名 .mp4 还在）", base + ".mp4" in left, left)
    check("别的任务的文件不碰", "other-task.mp4" in left, left)
    check("名字相近但不是本任务的不碰", base + "-extra.mp4" in left, left)

# 真实成片的 .m3u8 不能误删：内容不是 #EXTM3U 时不动它
out2 = os.path.join(TMP, "out2")
os.makedirs(out2, exist_ok=True)
with open(os.path.join(out2, base + ".m3u8"), "wb") as f:
    f.write(b"\x00\x00\x00\x18ftypisom" * 4)
if has_fn:
    D.cleanup_ytdlp_junk(out2, base)
    check("内容不是播放列表的同名 .m3u8 不删（宁少删不多删）",
          os.path.exists(os.path.join(out2, base + ".m3u8")), os.listdir(out2))

# ---------------------------------------------------------------- 4. 接线检查
src = open(D.__file__, encoding="utf-8").read()
check("write_status 不再直接裸调 os.replace",
      "os.replace(tmp, path)" not in src or "_replace_retry" in src)
check("yt-dlp 失败分支会清理碎片", "cleanup_ytdlp_junk(" in src.split("def cleanup_ytdlp_junk")[-1])

shutil.rmtree(TMP, ignore_errors=True)

print("RESULT: " + ("ALL PASS" if all(results) else "FAILED %d" % results.count(False)))
sys.exit(0 if all(results) else 1)
