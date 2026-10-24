#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""S3「规划表外置」（T-C5）的表驱动测试。

判据是 PRODUCT-PLAN 的 L2-a：**「这条为什么走了 yt-dlp」能答**。
以前分派散在 `main()` 的一段内嵌 if 里，连作者自己都难说清某条地址为什么
走了某条链。现在 `plan_download(job, tools)` 是纯函数：输入数据、输出数据，
每条规划带一个 `reason`（一句人话）—— 判据就看这个字段能不能答。

表驱动：一张 (job, tools, 期望 chain, 期望 reason 关键词) 的表，逐条喂。
这样「智能」是可测的：不是测「代码这么写」，是测「这条地址就该走这条链」。

用法： python test/host_plan_test.py
"""
import os
import sys

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


def plan(job, ytdlp=True, ffmpeg=True):
    tools = {}
    if ytdlp:
        tools["ytdlp"] = "/fake/yt-dlp"
    if ffmpeg:
        tools["ffmpeg"] = "/fake/ffmpeg"
    return D.plan_download(job, tools)


# ---------------------------------------------------------------- 1. merge / reject

print("[1] merge 与 reject：最先的两道闸")

check("mode=merge → chain=merge（合并没有 url）",
      plan({"mode": "merge", "url": ""})["chain"] == "merge")
check("merge 的 reason 提到「没有 URL」",
      "URL" in plan({"mode": "merge", "url": ""})["reason"])

for bad in ("", "blob:https://x/abc", "data:video/mp4;base64,AAAA",
            "/a/progressive/document/123", "javascript:void(0)"):
    check("非 http(s) 地址 %r → reject" % bad[:20],
          plan({"mode": "download", "url": bad})["chain"] == "reject")
check("reject 的 reason 提到「外部进程取不到」",
      "外部进程取不到" in plan({"mode": "download", "url": "blob:http://x/1"})["reason"])

# ---------------------------------------------------------------- 2. urllib（直链）

print("[2] urllib：明确的媒体直链")

for ext in (".mp4", ".webm", ".mkv", ".flv", ".mp3", ".jpg", ".png", ".pdf"):
    url = "https://cdn.example.com/video" + ext + "?token=1"
    check("扩展名 %s 的直链 → urllib" % ext,
          plan({"mode": "download", "url": url})["chain"] == "urllib", url)

check("/progressive/ 链接 → urllib",
      plan({"mode": "download", "url": "https://t.me/a/progressive/document/123"})["chain"] == "urllib")
check("urllib 的 reason 提到「直链」",
      "直链" in plan({"mode": "download", "url": "https://x.com/a.mp4"})["reason"])

# 没有 yt-dlp 时，即便看起来像站点页也只能直连
check("无 yt-dlp 时站点页 → urllib（没别的工具可用）",
      plan({"mode": "download", "url": "https://video.example.com/watch/123",
            "kind": "video"}, ytdlp=False)["chain"] == "urllib")
check("无 yt-dlp 的 reason 提到「没有可用的 yt-dlp」",
      "没有可用的 yt-dlp" in plan({"mode": "download", "url": "https://video.example.com/watch/123",
                                    "kind": "video"}, ytdlp=False)["reason"])

# ---------------------------------------------------------------- 3. ytdlp

print("[3] ytdlp：站点页 / 非 m3u8 的流地址")

check("kind=video 的站点页（无扩展名）→ ytdlp",
      plan({"mode": "download", "url": "https://video.example.com/watch/123",
            "kind": "video"})["chain"] == "ytdlp")
check("kind=audio → ytdlp",
      plan({"mode": "download", "url": "https://music.example.com/song/456",
            "kind": "audio"})["chain"] == "ytdlp")
check(".mpd 地址 → ytdlp",
      plan({"mode": "download", "url": "https://cdn.example.com/live/manifest.mpd"})["chain"] == "ytdlp")
check("format=m3u8 但 path 不是 .m3u8 → ytdlp",
      plan({"mode": "download", "url": "https://cdn.example.com/get?format=m3u8"})["chain"] == "ytdlp")
check("ytdlp 的 reason 提到「交给 yt-dlp」",
      "yt-dlp" in plan({"mode": "download", "url": "https://video.example.com/watch/123",
                        "kind": "video"})["reason"])

# kind=other 且地址不像媒体的 → urllib（不无谓走 yt-dlp）
check("kind=other 且无媒体特征 → urllib（不无谓丢给 yt-dlp）",
      plan({"mode": "download", "url": "https://x.com/whatever"})["chain"] == "urllib")

# ---------------------------------------------------------------- 4. hls（自实现剥壳）

print("[4] hls：.m3u8 优先自实现")

check(".m3u8 直链 → hls",
      plan({"mode": "download", "url": "https://cdn.example.com/live/index.m3u8",
            "kind": "video"})["chain"] == "hls")
check("hls 的 reason 提到「自实现」和「yt-dlp 接手」",
      "自实现" in plan({"mode": "download", "url": "https://cdn.example.com/live/index.m3u8",
                        "kind": "video"})["reason"]
      and "yt-dlp" in plan({"mode": "download", "url": "https://cdn.example.com/live/index.m3u8",
                            "kind": "video"})["reason"])

# 关键反例：.m3u8 在 query 里但 path 不是 .m3u8 → 不是 hls（looks_like_hls_url 只看 path）
check(".m3u8 只在 query、path 不是 → 不是 hls（避免把跳转链接误判成 HLS）",
      plan({"mode": "download", "url": "https://cdn.example.com/redirect?url=x.m3u8",
            "kind": "video"})["chain"] != "hls")

# .m3u8 但 kind=other 且无 ytdlp？—— m3u8 触发 use_ytdlp 需要 ytdlp 存在
check(".m3u8 但无 yt-dlp → urllib（hls 依赖 yt-dlp 兜底，没有就不走）",
      plan({"mode": "download", "url": "https://cdn.example.com/live/index.m3u8",
            "kind": "video"}, ytdlp=False)["chain"] == "urllib")

# ---------------------------------------------------------------- 5. 优先级顺序

print("[5] 分派优先级：merge > reject > hls/ytdlp > urllib")

check("merge 优先级最高（即便给了 url 也走 merge）",
      plan({"mode": "merge", "url": "https://x.com/a.mp4"})["chain"] == "merge")
check("reject 优先于 urllib（即便扩展名像媒体，地址非法仍 reject）",
      plan({"mode": "download", "url": "/local/a.mp4"})["chain"] == "reject")

# ---------------------------------------------------------------- 6. expect 字段（喂给 verify_product）

print("[6] expect：规划要带产物验证预期")

check("merge 的 expect 要 video 轨（合并产物至少含视频）",
      plan({"mode": "merge", "url": ""})["expect"].get("tracks") == ["video"])
check("非 merge 的 expect 为空（没有清单元数据）",
      plan({"mode": "download", "url": "https://x.com/a.mp4"})["expect"] == {})

# ---------------------------------------------------------------- 汇总

print()
if ok:
    print("结果：全部通过")
    sys.exit(0)
else:
    print("结果：有失败")
    sys.exit(1)
