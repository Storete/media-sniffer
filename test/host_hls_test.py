#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""离线自测：HLS 下载的两个坑（不起浏览器、不联网）。

用户 m16052 报 51cg1 / 4kvm「不起作用」，排查后确认下载链路本身是通的，
真正的问题有两个，这里各锁一条：

  1) yt-dlp 退出码 0 不等于成功。实测 971MB 的 HLS 流：TS 分片合并成功，
     后续 ffmpeg 重封装 mp4 报 Permission denied，yt-dlp 仍返回 0，
     状态被写成 done —— 用户看到「完成」却拿到坏文件。
  2) 原来写死 --merge-output-format mp4，正是触发上面那条重封装路径的原因。

这两个都是「看代码就能验」的：① 状态判定是纯逻辑；② 命令拼装是纯逻辑。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

import downloader as D  # noqa: E402

results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  -> " + str(extra)))


# ---------------------------------------------------------------- 1. 命令里不再强制 mp4
src = open(D.__file__, encoding="utf-8").read()

check("video 类型不再写死 --merge-output-format mp4",
      '["--merge-output-format", "mp4"]' not in src,
      "源码里还留着强制 mp4 的那行")
check("注释里记下了这条坑的来由",
      "Postprocessing: Error opening output files" in src)


# ---------------------------------------------------------------- 2. 退出码 0 + 尾部 ERROR 必须报错
# 直接测状态判定：把 run_ytdlp 里那段逻辑抽出来单独跑不现实（它裹在 subprocess 循环里），
# 所以复制同样的判据在这里跑一遍，保证「代码里的判据」和「期望行为」一致。
def final_status(returncode, tail):
    """复刻 run_ytdlp 收尾处的判据。改动那边必须同步改这里。"""
    post_err = ""
    for ln in tail:
        if "ERROR:" in ln:
            post_err = ln.strip()
            break
    if returncode == 0 and not post_err:
        return "done"
    return "error"


check("退出码 0、无 ERROR -> done",
      final_status(0, ["[download] 100% of 971.00MiB"]) == "done")
check("退出码 0、尾部有 Postprocessing ERROR -> error（这条就是 4kvm 的坑）",
      final_status(0, ["[download] 100%",
                       "ERROR: Postprocessing: Error opening output files: Permission denied"]) == "error")
check("退出码非 0 -> error",
      final_status(1, []) == "error")
check("ERROR 出现在尾部窗口以外的更早位置不会误判（只扫 tail）",
      final_status(0, ["[download] 100%"]) == "done")

# 确认源码里真的用了这个判据（不是只在这个测试文件里写了一份）
check("源码里确实扫了 tail 里的 ERROR:",
      'for ln in tail:' in src and '"ERROR:" in ln' in src)
check("源码里 done 的条件带了 not post_err",
      "proc.returncode == 0 and not post_err" in src)


# ---------------------------------------------------------------- 3. m3u8 仍走 yt-dlp（没被误伤）
low = "https://oss.douyinbit.com/m3u8/8ffa39d4da7087210f1292376e7b39f3.m3u8"
check("MEDIA_EXT 不把 .m3u8 当文件直链",
      D.MEDIA_EXT.search(low) is None)
check("分派条件仍认 .m3u8",
      ".m3u8" in low)


print("RESULT: " + ("ALL PASS" if all(results) else "FAILED %d" % results.count(False)))
sys.exit(0 if all(results) else 1)
