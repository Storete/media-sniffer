#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""解释库（T-C7 的自动通道）的表驱动测试。

判据是 PRODUCT-PLAN 的 L4：**同站点 + 同错误码累计 ≥ 3 次 → 自动出「已知问题 + 建议」**。
这是「学习」唯一可测的形态：不是测「代码这么写」，是测「第 2 次闭嘴、第 3 次开口」这个边界。

顺带锁住三件容易写错的事：
  1. 阈值边界：第 2 次必须闭嘴、第 3 次才开口 —— 提前开口会拿「两次偶发」吓用户，
     延后开口等于白学。
  2. site 归一化：`www.a.com` 和 `a.com` 必须算同站，否则「同一个站、两个 host」永远凑不够 3 次。
  3. 只学失败模式不学站点规则：`FAILURE_MODES` 表里只有码、没有站点，表外的码累计够也不开口
     （退回 describe 的单次建议，而不是硬编一句废话）。

用法： python test/host_knowledge_test.py
"""
import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

import knowledge as K  # noqa: E402

ok = True


def check(name, cond, extra=None):
    global ok
    if cond:
        print("PASS", name)
    else:
        ok = False
        print("FAIL", name, "" if extra is None else extra)


# ---------------------------------------------------------------- 1. site_key：同站归一化

print("[1] site_key：把地址归到可注册域名")

check("裸域名 → 原样", K.site_key("https://a.com/x") == "a.com", K.site_key("https://a.com/x"))
check("www 前缀 → 剥掉", K.site_key("https://www.a.com/x") == "a.com")
check("多级子域 → 归到二级", K.site_key("https://cdn.video.a.com/x") == "a.com")
check("端口不影响", K.site_key("https://a.com:8080/x") == "a.com")
check("co.uk 二级域 → 保留三级", K.site_key("https://www.bbc.co.uk/x") == "bbc.co.uk")
check("com.cn 二级域 → 保留三级", K.site_key("https://video.example.com.cn/x") == "example.com.cn")
check("空地址 → 空串", K.site_key("") == "")
check("没有 host 的地址 → 空串", K.site_key("https:///path") == "")
check("大小写归一", K.site_key("https://A.Com/x") == "a.com")

# ---------------------------------------------------------------- 2. fail_signature：站|码

print("[2] fail_signature：规整成「站|码」键")

check("签名是 site|code", K.fail_signature("https://www.a.com/x", "HTTP_403") == "a.com|HTTP_403")
check("不同子域同站 → 同签名",
      K.fail_signature("https://www.a.com/x", "HTTP_403") == K.fail_signature("https://a.com/y", "HTTP_403"))
check("不同码 → 不同签名",
      K.fail_signature("https://a.com/x", "HTTP_403") != K.fail_signature("https://a.com/x", "HTTP_404"))

# ---------------------------------------------------------------- 3. 阈值边界：第 2 次闭嘴、第 3 次开口

print("[3] 阈值边界：≥3 才开口")

entries = []
entries = K.record_failure(entries, "https://a.com/x", "SEGMENT_GAP", 1000)
check("第 1 次失败 → 闭嘴", K.explain(entries, "https://a.com/x", "SEGMENT_GAP") is None)
entries = K.record_failure(entries, "https://a.com/x", "SEGMENT_GAP", 1001)
check("第 2 次失败 → 仍闭嘴", K.explain(entries, "https://a.com/x", "SEGMENT_GAP") is None)
entries = K.record_failure(entries, "https://a.com/x", "SEGMENT_GAP", 1002)
r = K.explain(entries, "https://a.com/x", "SEGMENT_GAP")
check("第 3 次失败 → 开口", r is not None, r)
check("开口有 title", isinstance(r.get("title"), str) and r["title"], r)
check("开口有 advice", isinstance(r.get("advice"), str) and r["advice"], r)

# 同站不同码不算同一失败模式：两次 SEGMENT_GAP + 一次 HTTP_403 不触发 SEGMENT_GAP 的建议
entries2 = []
entries2 = K.record_failure(entries2, "https://a.com/x", "SEGMENT_GAP", 1000)
entries2 = K.record_failure(entries2, "https://a.com/x", "SEGMENT_GAP", 1001)
entries2 = K.record_failure(entries2, "https://a.com/x", "HTTP_403", 1002)
check("同站但不同码 → 不触发（各算各的）",
      K.explain(entries2, "https://a.com/x", "SEGMENT_GAP") is None)

# 同码不同站也不该串：a.com 两次 + b.com 一次，a.com 不触发
entries3 = []
entries3 = K.record_failure(entries3, "https://a.com/x", "SEGMENT_GAP", 1000)
entries3 = K.record_failure(entries3, "https://a.com/x", "SEGMENT_GAP", 1001)
entries3 = K.record_failure(entries3, "https://b.com/x", "SEGMENT_GAP", 1002)
check("不同站同码 → 不串站（a.com 只有 2 次）",
      K.explain(entries3, "https://a.com/x", "SEGMENT_GAP") is None)
check("b.com 只有 1 次 → 也不触发",
      K.explain(entries3, "https://b.com/x", "SEGMENT_GAP") is None)

# 空记录 → 闭嘴
check("空记录 → 闭嘴", K.explain([], "https://a.com/x", "SEGMENT_GAP") is None)

# ---------------------------------------------------------------- 4. 表外的码：累计够也不开口

print("[4] 只学失败模式：表外的码不硬编")

# 用 DISK_FULL（本地写盘失败，跟站点无关，不该有站点级建议）做反例
entries4 = []
for i in range(5):
    entries4 = K.record_failure(entries4, "https://a.com/x", "DISK_FULL", 1000 + i)
check("DISK_FULL 累计 5 次 → 不开口（这是本机问题，不是站点问题）",
      K.explain(entries4, "https://a.com/x", "DISK_FULL") is None)

# 表里没有的码，即便累计够也退回（不硬编万能建议）
check("表外码累计够 → 也不开口（退回 describe）",
      K.explain(entries4, "https://a.com/x", "VERIFY_MISMATCH") is None)

# ---------------------------------------------------------------- 5. 失败模式表：每条都有 title + advice

print("[5] FAILURE_MODES：每条都是「已知问题 + 建议」")

check("表非空（至少 5 个失败模式）", len(K.FAILURE_MODES) >= 5, len(K.FAILURE_MODES))
for code, mode in K.FAILURE_MODES.items():
    check("%s 有非空 title" % code, isinstance(mode.get("title"), str) and mode["title"])
    check("%s 有非空 advice" % code, isinstance(mode.get("advice"), str) and mode["advice"])
    # 站点级属性由 title 承载（「这个站的分片经常断」），advice 是「怎么办」，
    # 不要求 advice 里也硬塞「这个站」三个字 —— 那会逼出「这个站的这个站」这种废话。
    check("%s 的 title 是站点级（「这个站…」的已知问题）" % code,
          "这个站" in mode["title"], mode["title"])
# 表里只许出现「失败模式」（码），不许出现「站点规则」（没有站点字段）
check("表里没有站点字段（只学失败模式不学站点规则）",
      all("site" not in m and "url" not in m for m in K.FAILURE_MODES.values()))

# ---------------------------------------------------------------- 6. record_failure：不涨爆

print("[6] record_failure：追加 + 上限")

e = []
e = K.record_failure(e, "https://a.com/x", "HTTP_403", 1)
check("追加后长度 +1", len(e) == 1)
check("原列表不被修改", K.count_failures([], "https://a.com/x", "HTTP_403") == 0)
# 上限：塞满 MAX_FAILURES 后不再涨
e = []
for i in range(K.MAX_FAILURES + 50):
    e = K.record_failure(e, "https://a.com/x", "HTTP_403", i)
check("超过 MAX_FAILURES 后被截断", len(e) == K.MAX_FAILURES, len(e))

# ---------------------------------------------------------------- 汇总

print()
if ok:
    print("结果：全部通过")
    sys.exit(0)
else:
    print("结果：有失败")
    sys.exit(1)
