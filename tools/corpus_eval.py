#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""T-F2 考场：给「大脑」出考卷（docs/corpus/eval-cases.jsonl）并打分。

大脑接口
--------
一个 Python 模块（--brain path.py），暴露：

    def diagnose(case: dict) -> dict:
        # case 含 url / observed(chain, errcode, trail, message, markers) / 纯度信息
        # 返回 {"diagnosis": str, "strategy": str}
        # strategy 必须取自受控词表（见 STRATEGIES）

基线大脑（--brain 缺省时）只用**产品现有信号**（errcode / chain / trail /
markers）按规则猜——它就是「玩偶的智商」。规则基线的分数是地板，
LLM 大脑的分数跟它比：高多少，就是大脑值多少。

评分
----
strategy 对照 expected.strategy（受控词表精确匹配）。
分母只算 status 字段为「已确认」的案例？——不，**全部案例都算**：
「待复核」是用户还没批，不是没答案；批改后把 status 改成「已确认」即可。

用法：
    python tools/corpus_eval.py                          # 基线大脑跑分
    python tools/corpus_eval.py --brain my_brain.py      # 换大脑
    python tools/corpus_eval.py --verbose                # 逐题看对错
"""
import argparse
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CASES = os.path.join(ROOT, "docs", "corpus", "eval-cases.jsonl")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 受控词表：strategy 的全部合法值（考卷与大脑共用这套词，避免「说得对但词不对」）
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


# ---------------------------------------------------------------- 基线大脑

def baseline_diagnose(case):
    """规则基线：只用产品现有信号（errcode/chain/trail/markers），不背答案。

    它不知道每个网站是什么——那是大脑要补的空白。规则按「已有信息的
    最可能解释」给策略：这正是确定性管线在遇到新站时能做到的上限。
    """
    obs = case.get("observed") or {}
    err = obs.get("errcode") or ""
    chain = obs.get("chain") or ""
    outcome = obs.get("outcome") or ""
    trail = obs.get("trail") or ""
    markers = case.get("markers") or []

    if "drm" in (case.get("url") or "").lower() or "DRM" in json.dumps(obs, ensure_ascii=False):
        return {"diagnosis": "DRM", "strategy": "unsupported-drm"}
    if outcome == "done":
        return {"diagnosis": "下载成功，无失败可诊断", "strategy": "direct-download"}
    if outcome == "skipped-no-media-mark":
        return {"diagnosis": "页面无媒体标记，纯度闸门拦下", "strategy": "not-applicable"}
    if err in ("HTTP_403",) or "403" in outcome:
        return {"diagnosis": "站点拒绝请求", "strategy": "anti-bot"}
    if err in ("AUTH_REQUIRED",):
        return {"diagnosis": "需要登录", "strategy": "login-required"}
    if err in ("TOKEN_EXPIRED",):
        return {"diagnosis": "地址过期，重新抓取", "strategy": "page-parse"}
    if err == "VERIFY_MISMATCH" and chain == "ytdlp":
        # generic 提取器拿到了东西但不是媒体：产品信息能给出的最好解释是
        # 「这不是一个媒体直链页面」——但首页/直播/登录/纯图文它分不开。
        # 直连也 VERIFY_MISMATCH 说明连内容 sniff 都对不上 → 倾向「无裸媒体」。
        if "直连=VERIFY_MISMATCH" in trail:
            return {"diagnosis": "页面无裸媒体，需要浏览器上下文或换地址",
                    "strategy": "page-parse"}
        return {"diagnosis": "yt-dlp 解析结果不是可验证的媒体", "strategy": "specific-video-url"}
    if markers:
        return {"diagnosis": "页面有媒体标记但直灌失败，需要浏览器嗅探", "strategy": "page-parse"}
    return {"diagnosis": "信息不足", "strategy": "page-parse"}


# ---------------------------------------------------------------- 考场

def load_brain(path):
    spec = importlib.util.spec_from_file_location("ms_brain", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not hasattr(mod, "diagnose"):
        raise SystemExit("FAIL 大脑模块必须暴露 diagnose(case)")
    return mod.diagnose


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cases", default=CASES)
    ap.add_argument("--brain", help="大脑模块路径（缺省 = 规则基线）")
    ap.add_argument("--verbose", action="store_true", help="逐题打印")
    a = ap.parse_args(argv)

    diagnose = load_brain(a.brain) if a.brain else baseline_diagnose
    cases = [json.loads(l) for l in open(a.cases, encoding="utf-8") if l.strip()]
    if not cases:
        print("考卷为空")
        return 1

    by_status = {}
    results = []
    for c in cases:
        exp = c.get("expected") or {}
        got = diagnose(c)
        got_strategy = got.get("strategy")
        want_strategy = exp.get("strategy")
        ok = got_strategy == want_strategy
        if got_strategy not in STRATEGIES:
            ok = False   # 词表外的 strategy 直接判错（「说得对但词不对」= 没对接上）
        results.append((c, got, ok))
        by_status.setdefault(c.get("status", "?"), []).append(ok)

    print("考卷：%s | 大脑：%s" % (
        a.cases, a.brain or "规则基线（只用产品现有信号）"))
    print("词表：%d 个 strategy" % len(STRATEGIES))
    print("-" * 56)
    for c, got, ok in results:
        mark = "✓" if ok else "✗"
        line = " %s %-5s 期望=%-18s 实得=%-18s %s" % (
            mark, c.get("id"), c.get("expected", {}).get("strategy"),
            got.get("strategy"), (c.get("url") or "")[:42])
        print(line)
        if a.verbose and not ok:
            print("      诊断实得:", got.get("diagnosis", "")[:90])
            print("      诊断期望:", (c.get("expected", {}) or {}).get("diagnosis", "")[:90])
    print("-" * 56)
    total_ok = total = 0
    for st in sorted(by_status):
        xs = by_status[st]
        total_ok += sum(xs)
        total += len(xs)
        print("  %s：%d/%d（%.0f%%）" % (st, sum(xs), len(xs), 100.0 * sum(xs) / len(xs)))
    print("总分：%d/%d（%.0f%%）" % (total_ok, total, 100.0 * total_ok / total))
    if not a.brain:
        print("\n这是规则基线的分数 = 「玩偶的智商」。LLM 大脑跟这张卷子比，高出多少值多少。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
