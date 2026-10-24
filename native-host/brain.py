#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""T-F5 失败 AI 分析：把结构化失败诊断交给 LLM，拿回「根因 + 下一步」。

为什么是宿主侧 Python：LLM API 调用走 urllib（纯标准库），且 brain.py 是
诊断逻辑的**唯一真源**——评测（corpus_eval --brain）、宿主 handler、将来的
尝试循环（F6）全部引用同一份。

输入 case 与 corpus_eval 的考卷同形（url / observed{chain,errcode,trail,message}）。
输出受控词表与 docs/corpus/eval-cases.jsonl 的 expected.strategy 同一张表——
「说得对但词不对」= 没对接上，解析层直接校验。

边界：endpoint/key 未配置时 analyze 返回明确错误（不触网）；HTTP/解析失败
一律返回 {ok: False, error}，绝不抛——分析挂了不能影响下载主流程。
"""
import json
import re
import urllib.request

# 与 docs/corpus/eval-cases.jsonl 的 expected.strategy 同一张表（受控词表）
STRATEGIES = {
    "direct-download":   "直接可下，无需干预",
    "specific-video-url": "首页/列表页无单视频，需要具体视频页地址",
    "page-parse":        "B28 整页解析：需要浏览器嗅探上下文（可能含登录态）",
    "page-save":         "页面保存（Range 链）：blob/MSE 由页面自己取回",
    "record-live":       "直播流：录制或放弃，无固定媒体文件",
    "login-required":    "需要站点登录态",
    "self-hls":          "自实现 HLS（含剥壳等站点特殊处理）",
    "anti-bot":          "反爬拦截：需要浏览器上下文/指纹",
    "not-applicable":    "页面本来就没有要下的媒体",
    "unsupported-drm":   "DRM 保护：明确不做",
}

SYSTEM_PROMPT = (
    "你是浏览器媒体下载扩展「资源嗅探」的失败分析器。用户给你一条下载失败的"
    "结构化记录（URL、走过的下载链、错误码、三路尝试轨迹）。你要：\n"
    "1. 判断失败根因（一句话人话）；\n"
    "2. 从给定的策略词表里选一个最合适的下一步（只准用词表里的词）；\n"
    "3. 给一句具体的行动建议。\n"
    "\n"
    "判别指引（按顺序问自己）：\n"
    "· URL 是视频站/直播站的首页或列表页（没有具体视频 id）？媒体在具体视频"
    "页里 → specific-video-url；若是直播站（斗鱼/虎牙/抖音直播），直播没有固定"
    "媒体文件 → record-live；\n"
    "· URL 域名是已知要登录/加密的（音乐站网易云/QQ音乐、付费正片）？→ "
    "login-required；\n"
    "· URL 或错误信息带 DRM/Widevine？→ unsupported-drm；\n"
    "· 错误是 403 且站点有反爬？→ anti-bot；\n"
    "· 页面确认无媒体（纯图文社区/文档站）？→ not-applicable；\n"
    "· 站点用 blob/MSE 播放（Telegram/抖音类）、或错误提示需要浏览器上下文？"
    "→ page-parse；\n"
    "· 错误是「伪装分片」「剥壳」类（分片内容异常）？→ self-hls；\n"
    "· 三路轨迹里其实有成功路径、只是某一环出错？→ direct-download。\n"
    "用 URL 的域名和路径形态判断站点类型——URL 本身是最强的证据。\n"
    "\n"
    "只输出 JSON：{\"diagnosis\": \"...\", \"strategy\": \"词表里的词\", "
    "\"confidence\": 0到1, \"advice\": \"...\"}。不要输出 JSON 以外的任何内容。")

USER_TMPL = (
    "策略词表：{vocab}\n\n"
    "失败记录：\n"
    "URL: {url}\n"
    "下载链: {chain}\n"
    "错误码: {errcode}\n"
    "三路尝试轨迹: {trail}\n"
    "失败消息: {message}\n"
    "页面媒体标记: {markers}")


# 经验库雏形（d-082 错题主因之二：站点知识不在 prompt 里）。
# 每条 = 域名片段 → 一句站点事实。来源：20 站审计 + DEVLOG 实锤。
SITE_KNOWLEDGE = [
    ("bilibili.com", "B 站：具体视频页的 DASH 双流下载与合并链已支持，应 direct-download"),
    ("4kvm", "该站分片是伪装壳（PNG 壳 + 真 TS），需自实现 HLS 剥壳 → self-hls"),
    ("51cg1", "该站 DPlayer 播放 HLS 正片，自实现 HLS 可下 → self-hls"),
    ("douyu.com", "斗鱼：直播流，无固定媒体文件 → record-live"),
    ("huya.com", "虎牙：直播流 → record-live"),
    ("live.douyin.com", "抖音直播：MSE + 登录态 → record-live"),
    ("douyin.com", "抖音视频页：MSE 分段解密，无裸地址，需浏览器嗅探 → page-parse"),
    ("music.163.com", "网易云：音频加密 + 需登录 → login-required"),
    ("y.qq.com", "QQ音乐：音频加密逐曲接口 → login-required"),
    ("v.qq.com", "腾讯视频：正片为私有 JSON 清单，需浏览器上下文 → page-parse；若记录里提到 DRM/Widevine 则该正片有 DRM → unsupported-drm"),
    ("1905.com", "1905 电影网：反爬严格，纯程序请求直接 403 → anti-bot"),
    ("web.telegram.org", "Telegram：blob/MSE，只能页面保存（Range 链）→ page-save"),
    ("sohu.com", "搜狐：具体视频页才有媒体，首页没有 → specific-video-url"),
    ("miguvideo.com", "咪咕：需登录态看正片，首页无媒体 → specific-video-url 或 login-required"),
]


def site_notes(url):
    """URL → 命中的站点知识条目（经验库的检索雏形）。"""
    u = (url or "").lower()
    return [note for dom, note in SITE_KNOWLEDGE if dom in u]


def build_prompt(case):
    """case（考卷同形）→ (system, user)。纯函数。"""
    obs = case.get("observed") or {}
    user = USER_TMPL.format(
        vocab="、".join(STRATEGIES),
        url=case.get("url") or "(未知)",
        chain=obs.get("chain") or "?",
        errcode=obs.get("errcode") or "(无)",
        trail=obs.get("trail") or "(无)",
        message=obs.get("message") or "(无)",
        markers="、".join(case.get("markers") or []) or "(无)")
    notes = site_notes(case.get("url"))
    if notes:
        user += "\n\n已知站点知识（优先采信）：\n" + "\n".join("- " + x for x in notes)
    return SYSTEM_PROMPT, user


def parse_analysis(text):
    """LLM 返回文本 → 结构化结果。词表外的 strategy 降级为 page-parse？不——
    降级成 ok=False（策略没对接上就该暴露，而不是悄悄给个可能错的建议）。"""
    out = {"ok": False, "error": ""}
    if not text or not text.strip():
        out["error"] = "LLM 返回为空"
        return out
    # 提取 JSON（容忍 ```json 包裹与前后废话）
    m = re.search(r"\{[^{}]*\}", text, re.S)
    if not m:
        out["error"] = "返回里没有 JSON"
        return out
    try:
        data = json.loads(m.group(0))
    except ValueError:
        out["error"] = "JSON 解析失败"
        return out
    strategy = str(data.get("strategy") or "")
    if strategy not in STRATEGIES:
        out["error"] = "策略不在词表里: %s" % strategy[:40]
        return out
    try:
        conf = max(0.0, min(1.0, float(data.get("confidence") or 0.5)))
    except (TypeError, ValueError):
        conf = 0.5
    return {
        "ok": True,
        "diagnosis": str(data.get("diagnosis") or "")[:200],
        "strategy": strategy,
        "strategy_label": STRATEGIES[strategy],
        "confidence": round(conf, 2),
        "advice": str(data.get("advice") or "")[:200],
    }


# T-F6 白名单动作：大脑的建议只能落在这几个可执行动作上。
# 每个动作的执行器在宿主/扩展里已存在（换头重扫 = _header_variants；
# 换链 = main() 的 fallback；page-parse = popup 整页解析入口）。
ACTIONS = {
    "retry-with-headers": "换请求头组合重试（原样→去Referer→只留UA/Cookie）",
    "switch-chain":       "切换下载链（yt-dlp↔自实现HLS↔直连）",
    "page-parse":         "提示用户用整页解析（浏览器嗅探上下文）",
    "page-save":          "提示用户用页面保存（blob/MSE）",
    "give-up":            "明确放弃并说明原因（DRM/站点无媒体）",
}
_STRATEGY_TO_ACTION = {
    "direct-download":    "retry-with-headers",
    "specific-video-url": "page-parse",
    "page-parse":         "page-parse",
    "page-save":          "page-save",
    "record-live":        "give-up",
    "login-required":     "page-parse",
    "self-hls":           "switch-chain",
    "anti-bot":           "retry-with-headers",
    "not-applicable":     "give-up",
    "unsupported-drm":    "give-up",
}


def propose_actions(analysis):
    """T-F6：分析结果 → 白名单动作序列（受控映射，LLM 不能发明动作）。

    返回 [{"action": ..., "why": ...}]；analysis 不 ok 时返回空——
    没有可信诊断就不该有动作。
    """
    if not analysis or not analysis.get("ok"):
        return []
    act = _STRATEGY_TO_ACTION.get(analysis.get("strategy"))
    if not act:
        return []
    return [{"action": act, "why": analysis.get("advice") or analysis.get("diagnosis") or ""}]


def analyze(case, endpoint, key, model, timeout=60):
    """case + 配置 → 结构化分析。任何失败返回 {ok: False, error}，不抛。"""
    if not endpoint or not key:
        return {"ok": False, "error": "未配置 AI 分析（需要 endpoint 与 API key）"}
    system, user = build_prompt(case)
    body = json.dumps({
        "model": model or "gpt-4o-mini",
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user}],
        "temperature": 0.2,
    }).encode("utf-8")
    req = urllib.request.Request(
        endpoint.rstrip("/") + "/chat/completions", data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
        text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        out = parse_analysis(text)
        out["model"] = data.get("model") or model
        return out
    except urllib.error.HTTPError as e:
        # 4xx/5xx 的响应体里是端点的真实原因（model 不存在 / key 无效 / 字段
        # 不合法）——HTTPError 的 str 只有状态码，body 不读就全丢了
        try:
            detail = e.read().decode("utf-8", "replace")[:200]
        except Exception:
            detail = ""
        return {"ok": False, "error": "HTTP %d: %s" % (e.code, detail or str(e)[:120])}
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, str(e)[:120])}
