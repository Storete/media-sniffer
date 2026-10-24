#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""解释库（L4 的自动通道）：把「同站点 + 同错误码反复出现」翻译成一句站点级的建议。

与 `errcode.describe` 的分工：
  · `describe(code)` 回答「这一次为什么失败」—— 单次、通用，不知道这是哪个站；
  · 这里的 `explain(failures, site, code)` 回答「这个站为什么老失败」—— 跨任务累积，
    只在「同站 + 同码 ≥ 3 次」时开口。学错只是解释不准，不会下错文件，所以敢自动长。

两条硬规则（PRODUCT-PLAN §4 定的，不是拍脑袋）：
  1. 只学「失败模式」，不学「站点规则」。失败模式十来个可穷举且十年后仍成立；
     站点规则无限且会变。所以表里只有 `code`（失败模式），没有「这个站该走哪条链」。
  2. 判定规则走「规则库」（人工进），**不在这里**。这里只产「解释」，不产「判定」。

本模块全部是纯函数：输入数据、输出数据，不碰文件、不碰网络。持久化（写失败日志）
由调用方做，这样表驱动测试零成本驱动「第 2 次 vs 第 3 次」的边界。
"""
import re

# 同站 + 同码累计多少次才「开口」。定 3 是 PRODUCT-PLAN 的原文「≥3 次」。
EXPLAIN_AFTER = 3

# 记录里最多留多少条（防无限膨胀）。失败日志本身也是数据，不设上限迟早吃满磁盘。
MAX_FAILURES = 2000


def site_key(url):
    """近似 eTLD+1：把一条地址归到「可注册域名」，用于判断两条地址是否同站。

    与扩展侧 `background.js` 的 `siteKeyOf` 同一套规则（二级域名单、三级回落），
    两边必须对齐，否则「宿主记的是 a.com、扩展读的是 www.a.com」就永远凑不上。
    """
    if not url:
        return ""
    try:
        from urllib.parse import urlparse
        host = urlparse(url).hostname or ""
    except Exception:
        host = ""
    host = (host or "").lower().lstrip(".")
    if not host:
        return ""
    parts = host.split(".")
    if len(parts) <= 2:
        return host
    two_level = re.compile(r"^(com|net|org|gov|edu|co|ac|or|ne|go|mil)\.(cn|uk|jp|hk|tw|kr|au|br|nz|za|mx|sg|in|tr)$")
    last2 = ".".join(parts[-2:])
    if two_level.match(last2) and len(parts) >= 3:
        return ".".join(parts[-3:])
    return last2


# 失败模式 → 站点级建议。这是「解释库」的种子表：每个码给一句比 `describe.act`
# 更进一步的、针对「这个站反复这样」的建议。宁可少，不硬凑 —— 拿不准的码不进表，
# `explain` 会退回「单次建议」，那也已经是 `describe` 的活儿了。
FAILURE_MODES = {
    "SEGMENT_GAP": {
        "title": "这个站的分片经常断",
        "advice": "不是你的网络问题，是这个站的分片不稳定。换一档清晰度或换一条地址，"
                  "别在同一地址上反复重试。",
    },
    "HTTP_403": {
        "title": "这个站有防盗链",
        "advice": "它要求特定的来源或登录态，直接下会被拦。刷新页面重新抓一次，"
                  "或先在浏览器里把视频打开再下。",
    },
    "HTTP_429": {
        "title": "这个站会限速",
        "advice": "短时间内下得越多越会被拦。等几分钟再试，别连续猛点。",
    },
    "TOKEN_EXPIRED": {
        "title": "这个站的地址会过期",
        "advice": "拿到的下载地址有有效期，过期就得回页面重新抓一条新的。",
    },
    "DRM_PROTECTED": {
        "title": "这个站的内容有 DRM",
        "advice": "这类流下下来也放不了，是站点故意加的锁。换别的来源，别在这条流上耗。",
    },
    "AUTH_REQUIRED": {
        "title": "这个站要登录",
        "advice": "先在浏览器里登录这个站，再回来下载。",
    },
    "INIT_MISSING": {
        "title": "这个站的清单缺初始化段",
        "advice": "它给的清单不完整（少了 fMP4 的初始化段）。换一档清晰度，"
                  "或换一条地址试试。",
    },
    "JOB_TIMEOUT": {
        "title": "这个站的分片太慢",
        "advice": "它分片多、单条慢，整段下会卡到超时。换一条更短的地址，"
                  "或换一档清晰度。",
    },
}


def fail_signature(site, code):
    """把一次失败规整成「站 | 码」的键。site 要先过 site_key，code 要归一化。"""
    return "%s|%s" % (site_key(site) or site or "", str(code or ""))


def record_failure(entries, site, code, now):
    """追加一条失败记录，返回新列表（不改原列表）。

    记录形状统一成 `(signature, now)`，`now` 是 epoch 秒 —— 有了时间戳，
    以后做「最近 N 天内的失败」或「失败是否在衰退」才有依据，现在先存着。
    """
    out = list(entries or [])
    out.append((fail_signature(site, code), now))
    if len(out) > MAX_FAILURES:
        out = out[-MAX_FAILURES:]
    return out


def count_failures(entries, site, code):
    """数「这个站 + 这个码」累计失败多少次。只认签名完全相等的。"""
    sig = fail_signature(site, code)
    return sum(1 for s, _t in (entries or []) if s == sig)


def explain(entries, site, code):
    """累计 ≥ EXPLAIN_AFTER 次时，返回 `{"title", "advice"}`；否则返回 None。

    这是纯函数：输入失败记录（可迭代的 `(signature, now)`）、站点、码，
    输出「要不要开口、开什么口」。持久化和「≥3 的判定阈值」都不在这里散落，
    阈值是模块级常量 `EXPLAIN_AFTER`，测试专门钉这个边界（第 2 次闭嘴、第 3 次开口）。

    `code` 不在 FAILURE_MODES 表里时，即便累计够了也返回 None —— 不是「不知道」，
    而是「这个失败模式我们还没有站点级的话可说」，退回 `describe` 的单次建议。
    硬编一句万能建议，等于把「解释库」降级成「每 3 次失败就弹一句废话」。
    """
    if not entries:
        return None
    if count_failures(entries, site, code) < EXPLAIN_AFTER:
        return None
    mode = FAILURE_MODES.get(code)
    if not mode:
        return None
    return dict(mode)
