#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""错误码字典（L2-c 初版）：把「失败原因」从英文异常串变成一张可测的表。

为什么需要
----------
`downloader.py` 原来在 `except Exception` 里写 `str(e)[:400]`，用户看到的是
`<urlopen error timed out>`、`HTTP Error 429: Too Many Requests`。
这既看不懂，也分不清「等 30 秒再点就行」和「这条地址已经废了」。

本模块的约定（与 `docs/PRODUCT-PLAN.md` 的 L2-c 一致）：

  · **13 个码**，每个带「阶段 / 能不能重试 / 重试几次 / 隔多久 / 一句原因 / 一句建议」；
  · **重试预算写在码表里**，不散落在 if 里 —— 这样「第几次开始降级」不是黑箱，
    而是这张表上的一个数字；
  · 重试对用户**可见**：每次重试前写一条 message（`retry_note`），不静默重试。
    静默降级等于把「下不下来时告诉你为什么」这句产品承诺又还回去了。

> 为什么是 13 而不是文档里写的 12
> ------------------------------
> `docs/PRODUCT-PLAN.md` 原来的 12 码里**没有 429**，而 429 恰恰是最常见的失败：
> 2026-10-24 量多连接吞吐时，`proof.ovh.net` 单连接正常、4 连接那轮直接吃 429
> （见 `docs/ENGINE-EVAL.md` §4-P0）。多连接不做之后，429 更是唯一会撞上的限速形态。
> 缺了它，「站点在限速」只能落进 `NET_TIMEOUT` → 用户看到「连接超时」，
> 于是不停重试，越重试越被封。**码表是按真实失败场景列的，不是凑数**，
> 所以补 `HTTP_429`，总数 13。数字改了，承诺没改。

几个刻意的取舍
--------------
1. `DISK_FULL` 的语义放宽成「**本地写盘失败**」：磁盘满、目录只读、配额不足都归它。
   对用户来说建议完全一样（换目录 / 清空间），拆成三个码只会多三个没人记得住的名字。
2. `NET_DNS` 的语义同样放宽成「**网络层连不上**」：DNS 解析失败、连接被拒、
   需要代理都归它。URLError 的本质都是「包没送出去」，对用户的动作也一样。
3. 表外的状态码**原样保留**成 `HTTP_<code>`，不塞进一个 `HTTP_OTHER`：
   诊断包里那个数字是唯一能查到原因的东西，合并掉就再也查不到了。
4. `INTERNAL` 是**兜底桶，不属于对用户承诺的 13 个原因**。它出现就代表分类器
   漏了一种异常 —— 所以测试里专门断言「已知异常不许落进 INTERNAL」。
   单独成一类而不是混进 NET_TIMEOUT，就是为了让这个信号不被掩盖。
"""

import email.utils
import errno
import http.client
import re
import socket
import time
import urllib.error

# 「服务端说等 N 秒」的夹取区间。夹的理由不是偷懒：
# 真按 Retry-After: 3600 等一小时，用户只会以为程序卡死；
# 装没看见又会在限速站上白撞。折成 30 秒后仍然失败，就把对方要求写进文案。
RETRY_AFTER_MIN = 1.0
RETRY_AFTER_MAX = 30.0

INTERNAL = "INTERNAL"

# 「地址其实是 HLS 清单，却按普通文件下下来了」这个场景两条路径都会遇到
# （直连 / yt-dlp）。文案只留一份：同一原因在三条路径上必须说同一句话，
# 各写一份就是等着以后漂成两种说法（T-B5 的判据就靠它）。
DETAIL_PLAYLIST = "拿到的是 #EXTM3U 播放列表，不是视频"
ACT_PLAYLIST = "用扩展列表里的「下载」按钮，它会按分片拼。"

# 码表。`say` 是一句原因，`act` 是一句该干什么 —— 两者都不许超过一行，
# 因为 popup 的下载记录只显示一行（background.js 里截 80 字）。
CODES = {
    "NET_DNS": dict(
        phase="connect", retryable=True, attempts=2, backoff=1.0,
        say="连不上这个站（域名解析失败或被拒绝）",
        act="检查网络或代理后重试。",
    ),
    "NET_TIMEOUT": dict(
        phase="transfer", retryable=True, attempts=2, backoff=1.5,
        say="连接超时或中途断了",
        act="重试一次通常能好。",
    ),
    "HTTP_403": dict(
        phase="connect", retryable=False, attempts=1, backoff=0.0,
        say="站点拒绝了这个请求（403）",
        act="多半是防盗链：刷新页面重新抓一次。",
    ),
    "HTTP_404": dict(
        phase="connect", retryable=False, attempts=1, backoff=0.0,
        say="地址不存在（404）",
        act="这条链接已失效，回页面重新抓。",
    ),
    "HTTP_429": dict(
        phase="connect", retryable=True, attempts=2, backoff=3.0,
        say="站点在限速（429）",
        act="等一会儿再点，或换一条地址。",
    ),
    "TOKEN_EXPIRED": dict(
        phase="connect", retryable=False, attempts=1, backoff=0.0,
        say="下载地址过期了",
        act="刷新页面重新抓一次。",
    ),
    "SEGMENT_GAP": dict(
        phase="transfer", retryable=False, attempts=1, backoff=0.0,
        say="有分片一直取不到",
        act="换一条地址，或稍后再试。",
    ),
    "INIT_MISSING": dict(
        phase="transfer", retryable=False, attempts=1, backoff=0.0,
        say="这个格式需要额外的初始化文件，但它没出现在清单里",
        act="换一条地址试试。",
    ),
    "CODEC_UNSUPPORTED": dict(
        phase="verify", retryable=False, attempts=1, backoff=0.0,
        say="这个编码这台机器解不了",
        act="换一档清晰度再试。",
    ),
    "DRM_PROTECTED": dict(
        phase="verify", retryable=False, attempts=1, backoff=0.0,
        say="这条流有 DRM 保护，下下来也放不了",
        act="换别的来源。",
    ),
    "AUTH_REQUIRED": dict(
        phase="connect", retryable=False, attempts=1, backoff=0.0,
        say="需要登录（401）",
        act="先在浏览器里登录这个站，再回来下。",
    ),
    "DISK_FULL": dict(
        phase="write", retryable=False, attempts=1, backoff=0.0,
        say="本地写不进文件（磁盘满或目录不可写）",
        act="换个下载目录，或清点空间。",
    ),
    "VERIFY_MISMATCH": dict(
        phase="verify", retryable=False, attempts=1, backoff=0.0,
        say="文件不完整或内容不对",
        act="再点一次会重试；反复这样换一条地址。",
    ),
    # ---- 兜底（不属于 12 码）
    INTERNAL: dict(
        phase="unknown", retryable=False, attempts=1, backoff=0.0,
        say="下载器内部出错",
        act="记下这个错误码反馈给我们。",
    ),
}


def known(code):
    return code in CODES


def classify_http(status, headers=None):
    """HTTP 状态码 → 码。

    `headers` 这里不用（留给以后读 `Retry-After` 之外的提示头），
    保留参数是为了三条路径调用形状一致。
    """
    try:
        status = int(status)
    except (TypeError, ValueError):
        return INTERNAL
    if status == 401:
        return "AUTH_REQUIRED"
    if status == 403:
        return "HTTP_403"
    if status in (404, 410):
        return "HTTP_404"
    if status == 429:
        return "HTTP_429"
    # 5xx 不折进来：它是瞬时抖动，可重试，但原因与服务端有关，
    # 原样留住那个数字（HTTP_503）才知道是谁的锅。
    return "HTTP_%d" % status


def classify_exc(exc):
    """异常对象 → 码。**已知异常不允许落进 INTERNAL**（测试里钉着）。"""
    if isinstance(exc, urllib.error.HTTPError):
        return classify_http(exc.code, getattr(exc, "headers", None))

    if isinstance(exc, urllib.error.URLError):
        reason = getattr(exc, "reason", None)
        if isinstance(reason, socket.gaierror):
            return "NET_DNS"
        if isinstance(reason, (socket.timeout, TimeoutError)):
            return "NET_TIMEOUT"
        if "timed out" in str(reason).lower():
            return "NET_TIMEOUT"
        # ConnectionRefused / SSL 证书 / 代理不通 —— 包都没送出去，一律「连不上」
        return "NET_DNS"

    if isinstance(exc, socket.gaierror):
        return "NET_DNS"
    if isinstance(exc, http.client.IncompleteRead):
        # 读到的字节比声明的少。这是「产物不完整」，该走验证码而不是网络码。
        return "VERIFY_MISMATCH"
    if isinstance(exc, (socket.timeout, TimeoutError, ConnectionError)):
        return "NET_TIMEOUT"
    if isinstance(exc, OSError):
        # EDQUOT 在部分平台没有这个常量，用 getattr 兜一下
        no_space = {errno.ENOSPC, getattr(errno, "EDQUOT", errno.ENOSPC)}
        if exc.errno in no_space or exc.errno in (errno.EACCES, errno.EPERM, errno.EROFS):
            return "DISK_FULL"
        return INTERNAL
    return INTERNAL


# yt-dlp 的失败只有英文输出，没有状态码（它自己已经重试过 10 次）。
# 这张表是「把它的输出翻译回码表」的**唯一**入口：顺序即优先级，
# 越靠前越具体 —— 抓错顺序会让「登录失败」被后面的 "not found" 抢走。
_YT_RULES = [
    (re.compile(r"digital rights management|\bwidevine\b|\bplayready\b|\bdrm\b", re.I),
     "DRM_PROTECTED"),
    (re.compile(r"http error 429|too many requests", re.I), "HTTP_429"),
    (re.compile(r"http error 401", re.I), "AUTH_REQUIRED"),
    (re.compile(r"http error 403|forbidden", re.I), "HTTP_403"),
    (re.compile(r"http error 404|http error 410|: not found", re.I), "HTTP_404"),
    # 5xx 不折成一个码：原样留住数字，才知道是谁的锅（与 classify_http 一致）
    (re.compile(r"http error (5\d\d)", re.I), "_5XX"),
    # 比 HTTP 码靠后：403 是站点给的**事实**，登录是它的解释；
    # 事实优先，解释只在没有事实时使用。
    (re.compile(r"sign in to confirm|log ?in required|please log ?in|members[- ]only|"
                r"private video|this video is private|"
                r"only available for (registered|premium)|需要登录|请先登录", re.I),
     "AUTH_REQUIRED"),
    (re.compile(r"token (has )?expired|signature (has )?expired|"
                r"url (has )?expired|expired url", re.I), "TOKEN_EXPIRED"),
    (re.compile(r"unsupported codec|no decoder|codec not supported|unknown encoder", re.I),
     "CODEC_UNSUPPORTED"),
    # 本机实测过的那一条：ffmpeg 重封装时 Permission denied（下载目录被安全软件挡）
    (re.compile(r"no space left|disk quota|permission denied|errno 28", re.I), "DISK_FULL"),
    (re.compile(r"timed out|timeout|connection reset|connection aborted|incompleteread", re.I),
     "NET_TIMEOUT"),
    (re.compile(r"getaddrinfo failed|name or service not known|nodename nor servname|"
                r"temporary failure in name resolution|connection refused|"
                r"tunnel connection failed", re.I), "NET_DNS"),
]


def classify_ytdlp(text):
    """yt-dlp 的 stdout/stderr 尾巴 → 码。

    为什么必须翻译：yt-dlp 的报错是英文、还带着自己的重试记录，直接贴给用户
    等于把 d-054 之前的状态还回去（用户看到 `HTTP Error 403: Forbidden`）。

    只认**已知**的几种说法；都不认就返回 `INTERNAL` —— 它在这里的语义和异常
    分类器一致：「我们漏了一种说法」。调用方拿到 INTERNAL 时必须把原文带上，
    否则诊断信息就断了。
    """
    s = str(text or "")
    if not s.strip():
        return INTERNAL
    for rx, code in _YT_RULES:
        m = rx.search(s)
        if not m:
            continue
        if code == "_5XX":
            return "HTTP_%s" % m.group(1)
        return code
    return INTERNAL


# 三条路径各报一个码时，对外只留一个。顺序 = 「越能说明用户下一步做什么」越靠前。
# 例：DRM 保护比 403 更具体（403 可以刷新页面重来，DRM 永远放不了）；
# INTERNAL 永远垫底 —— 它是「我们没认出」，不该盖住别人给出的真原因。
_PRIORITY = [
    "DRM_PROTECTED", "AUTH_REQUIRED", "CODEC_UNSUPPORTED", "TOKEN_EXPIRED",
    "HTTP_403", "HTTP_404", "SEGMENT_GAP", "DISK_FULL", "VERIFY_MISMATCH",
    "HTTP_429", "NET_TIMEOUT", "NET_DNS", INTERNAL,
]


def _rank(code):
    try:
        return _PRIORITY.index(code)
    except ValueError:
        # 表外 HTTP_5xx：瞬时抖动，说明不了用户该做什么，排在中段偏后
        if isinstance(code, str) and code.startswith("HTTP_5"):
            return len(_PRIORITY) - 2
        return len(_PRIORITY) - 1


def consensus(codes):
    """三条路径各自的失败码 → 对外的一个码。

    **一致就直接用**：同一条原因在三条路径上撞了三次，这是最强证据，
    不需要再挑。不一致时才按 `_PRIORITY` 挑最具体的那一个 ——
    分散的码说明每条路被挡在不同地方，而用户只该看到一个下一步。
    """
    got = [c for c in codes if c]
    if not got:
        return INTERNAL
    if all(c == got[0] for c in got):
        return got[0]
    best = got[0]
    for c in got[1:]:
        if _rank(c) < _rank(best):
            best = c
    return best


def parse_retry_after(value, now=None):
    """`Retry-After` → 夹取后的秒数；拿不到返回 None。

    支持两种写法（RFC 7231）：秒数（`120`）和 HTTP-date（`Wed, 21 Oct 2015 07:28:00 GMT`）。
    """
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    secs = None
    try:
        secs = float(raw)
    except ValueError:
        try:
            when = email.utils.parsedate_to_datetime(raw)
        except (TypeError, ValueError):
            return None
        if when is None:
            return None
        if when.tzinfo is None:
            secs = when.timestamp() - (now if now is not None else time.time())
        else:
            secs = when.timestamp() - (now if now is not None else time.time())
    return max(RETRY_AFTER_MIN, min(RETRY_AFTER_MAX, secs))


def retryable(code):
    """这个码值不值得再试一次。

    表内看 `retryable`；表外的 `HTTP_5xx` 是瞬时抖动，可重试；
    `HTTP_4xx` 重试一百次也是同样结果，不浪费预算。
    """
    spec = CODES.get(code)
    if spec is not None:
        return bool(spec["retryable"])
    if isinstance(code, str) and code.startswith("HTTP_"):
        try:
            return int(code[5:]) >= 500
        except ValueError:
            return False
    return False


def budget(code):
    """这个码总共允许多少次请求（含第一次）。"""
    spec = CODES.get(code)
    if spec is not None:
        return int(spec["attempts"])
    return 2 if retryable(code) else 1


def plan(code, headers=None, attempt=1):
    """第 `attempt` 次请求失败之后：还试不试、隔多久、为什么。

    返回 `(retry, delay_seconds, why)`；`why` 是给 `describe(detail=...)` 用的
    补充事实（可能为空串）。attempt 从 1 开始数。
    """
    if not retryable(code):
        return False, 0.0, ""
    total = budget(code)
    if attempt >= total:
        return False, 0.0, ""

    spec = CODES.get(code) or {"backoff": 1.5}
    base = float(spec.get("backoff") or 1.5)
    delay = base * (2 ** (attempt - 1))
    why = ""

    ra_raw = None
    if headers:
        try:
            ra_raw = headers.get("Retry-After")
        except AttributeError:
            ra_raw = None
    if ra_raw:
        got = parse_retry_after(ra_raw)
        if got is not None:
            delay = got
            try:
                asked = float(str(ra_raw).strip())
            except ValueError:
                asked = None
            # 只在对端要的时间被我们夹掉时才写这句 —— 没夹就别多话
            if asked is not None and asked > RETRY_AFTER_MAX:
                why = "对方要求等 %d 秒" % int(asked)
    return True, round(delay, 1), why


def retry_note(code, attempt, delay):
    """重试前写给用户看的**可见**提示（不是日志）。"""
    total = budget(code)
    secs = int(round(delay))
    if code == "HTTP_429":
        what = "站点在限速"
    else:
        what = "连接不稳"
    return "%s，%d 秒后重试（%d/%d）" % (what, secs, attempt, total)


def describe(code, detail="", act=""):
    """码 → 给用户看的一行话：`原因（补充事实）。建议`。

    `act` 可覆盖表里的建议：**原因码只有一个（统计口径统一），但建议可以按场景更贴切**。
    例：同样是 `VERIFY_MISMATCH`，「下到的是 HLS 清单」要的是「用扩展里的下载按钮」，
    而「只收到一半」要的是「再点一次会续传」—— 建议反了就是把用户往错的方向推。

    未知码（含表外的 HTTP_5xx）走兜底文案，但**把原码留在括号里**，
    否则诊断包里就只剩一句「下载失败」。
    """
    spec = CODES.get(code)
    if spec is None:
        if isinstance(code, str) and code.startswith("HTTP_"):
            try:
                n = int(code[5:])
            except ValueError:
                n = 0
            if 500 <= n <= 599:
                head = "服务器出错（%d）" % n
                tail = act or "过一会儿再试。"
                body = head + ("（%s）" % detail if detail else "") + "。" + tail
                return body
        spec = CODES[INTERNAL]
        detail = detail or str(code)

    say = spec["say"]
    act = act or spec["act"]
    if detail:
        return "%s（%s）。%s" % (say, detail, act)
    return "%s。%s" % (say, act)
