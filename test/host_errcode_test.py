#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""离线自测：错误码表（纯函数，不联网、不起服务，跑得飞快）。

对应 `docs/TODO.md` 的 T-B4（P2 自适应降级）的第一半：**先把「失败原因」变成数据**。
第二半（重试真的会重试）在 `host_urllib_retry_test.py`。

本套件锁七件事：
  · `docs/PRODUCT-PLAN.md` 里承诺的码**一个不少**（原案 12 个 + 补上的 `HTTP_429`），
    且每个都有「原因 / 建议 / 阶段」；
  · 用户能看懂的那句话必须**不超过 80 字** —— popup 的下载记录只显示一行，超了就被截；
  · 403/404 不重试（重试一百次还是 403），429/超时/5xx 重试；
  · 重试预算来自码表，**不是 if 里临时想出来的**：429 总共 2 次请求，第 2 次失败就不再试；
  · `Retry-After` 尊重但夹在 1~30 秒，被夹掉时把「对方要等多久」写进 detail；
  · 已知异常**不许**落进兜底桶 `INTERNAL`（落进去 = 分类器漏了一种异常）；
  · 表外状态码保留原数字（`HTTP_503`），不合并成一个查不到原因的 `HTTP_OTHER`。
"""
import os
import socket
import sys
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

import errcode as E  # noqa: E402

results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  -> " + str(extra)))


# ---------------------------------------------------------------- 1. 码表完整性
print("[1] 码表：承诺的码一个都不能少")

# PRODUCT-PLAN 原来的 12 码，后来补了三个，各有各的现场：
#   · HTTP_429    原案没有限速码，而 429 是唯一在自家机器上撞见过的失败
#                 （ENGINE-EVAL §4-P0）。缺它 →「站点在限速」落进 NET_TIMEOUT
#                 → 用户看到「连接超时」→ 立刻再点 → 被限得更狠。
#   · MISSING_DEP 缺 ffmpeg / yt-dlp。落 INTERNAL 等于把「你没装东西」说成
#                 「我们写错了」，用户会来报 bug 而不是去装。
#   · JOB_TIMEOUT 宿主 6 小时没等到终点。落 NET_TIMEOUT 等于把「任务卡死」
#                 说成「网络慢」，用户会一直重试同一条地址。
# 三个都是**可预见、会真实发生、且动作唯一**的失败，不是分类洁癖。
PROMISED = [
    "NET_DNS", "NET_TIMEOUT", "HTTP_403", "HTTP_404",
    "TOKEN_EXPIRED", "SEGMENT_GAP", "INIT_MISSING", "CODEC_UNSUPPORTED",
    "DRM_PROTECTED", "AUTH_REQUIRED", "DISK_FULL", "VERIFY_MISMATCH",
    "HTTP_429", "MISSING_DEP", "JOB_TIMEOUT",
]

missing = [c for c in PROMISED if c not in E.CODES]
check("承诺的 15 个码全在表里", not missing, missing)
check("表里的码数 = 15 + 1（多出来的只许是兜底桶）",
      len(E.CODES) == 16 and E.INTERNAL in E.CODES,
      [c for c in E.CODES if c not in PROMISED])

bad_spec = []
for code in PROMISED:
    spec = E.CODES[code]
    for key in ("phase", "retryable", "attempts", "backoff", "say", "act"):
        if key not in spec:
            bad_spec.append((code, key))
    if not spec.get("say") or not spec.get("act"):
        bad_spec.append((code, "empty-text"))
check("每个码都带 phase/retryable/attempts/backoff/say/act", not bad_spec, bad_spec)

phases = sorted({E.CODES[c]["phase"] for c in PROMISED})
# setup 是 1.3.50 加的：缺依赖不是「连不上/传不动/写不进/验不过」里的任何一件事，
# 它发生在下载开始之前。硬塞进四个老阶段会让「阶段」这个词失去意义。
check("阶段值都在约定的集合里",
      set(phases) <= {"setup", "connect", "transfer", "write", "verify"}, phases)


# ---------------------------------------------------------------- 2. describe 文案
print("")
print("[2] describe：一句话说清「为什么 + 该怎么办」")

too_long = []
for code in PROMISED + [E.INTERNAL]:
    text = E.describe(code)
    if len(text) > 80:
        too_long.append((code, len(text)))
    if not text.endswith("。"):
        too_long.append((code, "no-period"))
check("每个码的文案都 ≤ 80 字且以句号结尾（popup 只显示一行）", not too_long, too_long)

check("403 的文案指向防盗链（不是干巴巴的状态码）",
      "防盗链" in E.describe("HTTP_403"), E.describe("HTTP_403"))
check("429 的文案说「等一会儿」（用户能自己解决）",
      "等一会儿" in E.describe("HTTP_429"), E.describe("HTTP_429"))
check("DISK_FULL 的文案给的是用户能做的动作（换目录 / 清空间）",
      "目录" in E.describe("DISK_FULL") and "空间" in E.describe("DISK_FULL"),
      E.describe("DISK_FULL"))
check("VERIFY_MISMATCH 的文案会说「再点一次会重试」",
      "再点一次" in E.describe("VERIFY_MISMATCH"), E.describe("VERIFY_MISMATCH"))

t = E.describe("VERIFY_MISMATCH", "只收到 62.4 KB / 100.0 KB")
check("detail 被塞进括号里", "（只收到 62.4 KB / 100.0 KB）" in t, t)

t2 = E.describe("HTTP_503")
check("表外 5xx 有专门文案（不是「内部出错」）", "服务器出错" in t2, t2)
check("表外 5xx 保留原数字（诊断时唯一能查的东西）", "503" in t2, t2)
check("表外 5xx 建议「过一会儿再试」", "过一会儿" in t2, t2)

t3 = E.describe("HTTP_418")
check("表外 4xx 走兜底，但把原码带上", "418" in t3, t3)

# 同一个码，建议可以按场景换 —— 因为「原因」是客观的，「该怎么办」要看具体情况。
# 反例：下到的是 HLS 清单时说「再点一次会重试」是错的建议，重试一百次还是清单。
t4 = E.describe("VERIFY_MISMATCH", "拿到的是清单", act="用扩展里的下载按钮。")
check("act 可覆盖：原因还是那个原因", "拿到的是清单" in t4 and "文件不完整" in t4, t4)
check("act 可覆盖：建议换成传进来的那句", "下载按钮" in t4 and "再点一次" not in t4, t4)
check("不给 act 时用表里的默认建议",
      "再点一次" in E.describe("VERIFY_MISMATCH"), E.describe("VERIFY_MISMATCH"))


# ---------------------------------------------------------------- 3. 分类
print("")
print("[3] classify_http：状态码 → 码")


def cls(code, want):
    got = E.classify_http(code)
    check("%s → %s" % (code, want), got == want, got)


cls(401, "AUTH_REQUIRED")
cls(403, "HTTP_403")
cls(404, "HTTP_404")
cls(410, "HTTP_404")
cls(429, "HTTP_429")
cls(503, "HTTP_503")
cls(500, "HTTP_500")
cls(302, "HTTP_302")
check("字符串形式的状态码也认", E.classify_http("403") == "HTTP_403", E.classify_http("403"))
check("垃圾输入 → 兜底（不抛异常）", E.classify_http(None) == E.INTERNAL, E.classify_http(None))

print("")
print("[4] classify_exc：异常 → 码")


def exc_of(e, want):
    got = E.classify_exc(e)
    check("%s → %s" % (type(e).__name__, want), got == want, got)


exc_of(urllib.error.HTTPError("u", 403, "Forbidden", {}, None), "HTTP_403")
exc_of(urllib.error.HTTPError("u", 429, "Too Many Requests", {}, None), "HTTP_429")
exc_of(urllib.error.URLError(socket.gaierror(11001, "getaddrinfo failed")), "NET_DNS")
exc_of(urllib.error.URLError(socket.timeout("timed out")), "NET_TIMEOUT")
exc_of(urllib.error.URLError(ConnectionRefusedError(111, "refused")), "NET_DNS")
exc_of(socket.gaierror(11001, "getaddrinfo failed"), "NET_DNS")
exc_of(TimeoutError("timed out"), "NET_TIMEOUT")
exc_of(ConnectionResetError(10054, "reset"), "NET_TIMEOUT")
exc_of(OSError(28, "No space left on device"), "DISK_FULL")
exc_of(OSError(13, "Permission denied"), "DISK_FULL")
exc_of(RuntimeError("boom"), E.INTERNAL)

# 这条比单点断言重要：INTERNAL 是「我们漏了一种异常」的信号，
# 上面每一个已知异常都必须有归属，一个都不许滑进去。
KNOWN = [
    urllib.error.HTTPError("u", 500, "ISE", {}, None),
    urllib.error.URLError(socket.gaierror()),
    urllib.error.URLError(socket.timeout()),
    urllib.error.URLError(ConnectionRefusedError()),
    ConnectionResetError(),
    TimeoutError(),
    OSError(28, "nospace"),
    OSError(13, "denied"),
]
leaked = [type(e).__name__ for e in KNOWN if E.classify_exc(e) == E.INTERNAL]
check("已知异常一个都不许落进 INTERNAL 兜底桶", not leaked, leaked)


# ---------------------------------------------------------------- 5. 重试预算
print("")
print("[5] 重试预算：写在表里，测试照着表验")

check("403 不重试（重试一百次还是 403）", E.retryable("HTTP_403") is False)
check("404 不重试", E.retryable("HTTP_404") is False)
check("429 重试", E.retryable("HTTP_429") is True)
check("超时重试", E.retryable("NET_TIMEOUT") is True)
check("表外 503 重试（瞬时抖动）", E.retryable("HTTP_503") is True)
check("表外 400 不重试", E.retryable("HTTP_400") is False)
check("未知字符串不重试", E.retryable("WHAT") is False)

check("429 总共 2 次请求", E.budget("HTTP_429") == 2, E.budget("HTTP_429"))
check("403 总共 1 次请求", E.budget("HTTP_403") == 1, E.budget("HTTP_403"))
check("表外 503 总共 2 次请求", E.budget("HTTP_503") == 2, E.budget("HTTP_503"))

r1, d1, _ = E.plan("HTTP_429", None, 1)
check("429 第 1 次失败 → 还要再试", r1 is True, (r1, d1))
check("429 第 1 次退避 = 表里的 3.0s", d1 == 3.0, d1)
r2, d2, _ = E.plan("HTTP_429", None, 2)
check("429 第 2 次失败 → 不试了（预算用完）", r2 is False, (r2, d2))

r3, d3, _ = E.plan("HTTP_403", None, 1)
check("403 第一次就不试", r3 is False, (r3, d3))

r4, d4, _ = E.plan("HTTP_503", None, 2)
check("表外 503 第 2 次失败 → 不试了", r4 is False, (r4, d4))

r5, d5, _ = E.plan("NET_TIMEOUT", None, 1)
check("超时第 1 次退避 1.5s", r5 is True and d5 == 1.5, (r5, d5))


# ---------------------------------------------------------------- 6. Retry-After
print("")
print("[6] Retry-After：尊重，但不无限等")

check("数字形式：120 → 30（被夹到上限）", E.parse_retry_after("120") == 30.0,
      E.parse_retry_after("120"))
check("数字形式：0 → 1（被夹到下限）", E.parse_retry_after("0") == 1.0,
      E.parse_retry_after("0"))
check("数字形式：7 → 7", E.parse_retry_after("7") == 7.0, E.parse_retry_after("7"))
check("HTTP-date 形式也认（未来 10 秒）",
      abs(E.parse_retry_after("Wed, 21 Oct 2015 07:28:10 GMT", now=1445412480) - 10.0) < 1.5,
      E.parse_retry_after("Wed, 21 Oct 2015 07:28:10 GMT", now=1445412480))
check("HTTP-date 已过去 → 夹到下限 1", E.parse_retry_after(
    "Wed, 21 Oct 2015 07:00:00 GMT", now=1445412480) == 1.0)
check("垃圾值 → None（退回表里的 backoff，不猜）", E.parse_retry_after("soon") is None,
      E.parse_retry_after("soon"))
check("空值 → None", E.parse_retry_after("  ") is None)
check("None → None", E.parse_retry_after(None) is None)

r6, d6, w6 = E.plan("HTTP_429", {"Retry-After": "5"}, 1)
check("服务端要 5 秒 → 按它说的等 5 秒（不是表里的 3）", r6 and d6 == 5.0, (r6, d6))
check("没被夹掉时不多话", w6 == "", w6)

r7, d7, w7 = E.plan("HTTP_429", {"Retry-After": "3600"}, 1)
check("服务端要 3600 秒 → 只等 30 秒（不装死也不干等一小时）", r7 and d7 == 30.0, (r7, d7))
check("被夹掉时把「对方要多久」告诉用户", "3600" in w7, w7)


# ---------------------------------------------------------------- 7. retry_note
print("")
print("[7] retry_note：重试必须对用户可见")

n = E.retry_note("HTTP_429", 1, 4.0)
check("429 的重试提示说「限速」", "限速" in n, n)
check("重试提示带倒计时秒数", "4 秒" in n, n)
check("重试提示带「第几次 / 共几次」", "1/2" in n, n)
n2 = E.retry_note("NET_TIMEOUT", 1, 2.0)
check("超时的重试提示说「连接不稳」", "不稳" in n2, n2)


# ---------------------------------------------------------------- 汇总
print("")
ok = sum(1 for r in results if r)
print("RESULT: %d 通过 / %d 失败" % (ok, len(results) - ok))
sys.exit(0 if ok == len(results) else 1)
