#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""会话成本报告 —— 看钱花在哪一步上。

用法：
    python tools/token_report.py                    # 最近一个会话
    python tools/token_report.py <session.jsonl>    # 指定会话
    python tools/token_report.py --all              # 所有会话汇总

会话记录在 ~/.workbuddy/projects/<slug>/<uuid>.jsonl。
每次模型调用 = 一条带 usage 的 function_call / message，按 providerData.messageId 去重。
"""
import glob
import json
import os
import sys

HOME = os.path.expanduser("~")
PROJ = os.path.join(HOME, ".workbuddy", "projects")

# DeepSeek-V4.1-Flash（元 / 百万 token）
PRICE = {
    "idle": {"hit": 0.02, "miss": 1.0, "out": 4.0},
    "peak": {"hit": 0.04, "miss": 2.0, "out": 8.0},
}
BUCKETS = [(0, 50e3), (50e3, 100e3), (100e3, 150e3), (150e3, 200e3), (200e3, 1e12)]


def find_sessions(pattern=None):
    if pattern:
        return [pattern]
    files = glob.glob(os.path.join(PROJ, "**", "*.jsonl"), recursive=True)
    files = [f for f in files if "agent-" not in os.path.basename(f)]
    return sorted(files, key=os.path.getmtime, reverse=True)


def load(path):
    calls = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            u = (rec.get("message") or {}).get("usage") or {}
            mid = (rec.get("providerData") or {}).get("messageId")
            if not u.get("input_tokens") or not mid:
                continue
            row = (u["input_tokens"], u.get("cache_read_input_tokens", 0),
                   u.get("output_tokens", 0), rec.get("timestamp") or 0)
            # 同一次调用会在多个条目里重复出现 usage，取 input 最大的那条
            if mid not in calls or row[0] > calls[mid][0]:
                calls[mid] = row
    return sorted(calls.values(), key=lambda r: r[3])


def cost(rows, p):
    hit = sum(r[1] for r in rows)
    total_in = sum(r[0] for r in rows)
    miss = total_in - hit
    out = sum(r[2] for r in rows)
    yuan = (hit * p["hit"] + miss * p["miss"] + out * p["out"]) / 1e6
    return yuan, hit, miss, out


def report(path, rows):
    if not rows:
        print("没有 usage 数据：%s" % path)
        return
    total_in = sum(r[0] for r in rows)
    hit = sum(r[1] for r in rows)
    print("会话：%s" % os.path.basename(path))
    print("  模型调用：%d 次" % len(rows))
    print("  input   ：%s（缓存命中 %s = %.1f%%）"
          % (f"{total_in:,}", f"{hit:,}", hit * 100.0 / total_in))
    print("  output  ：%s" % f"{sum(r[2] for r in rows):,}")

    print("\n  上下文规模分布（钱主要花在大上下文那几次）")
    for lo, hi in BUCKETS:
        g = [r[0] for r in rows if lo <= r[0] < hi]
        if not g:
            continue
        s = sum(g)
        tag = "%dk+" % (lo // 1000) if hi > 1e11 else "%dk-%dk" % (lo // 1000, hi // 1000)
        bar = "#" * max(0, int(s * 100.0 / total_in / 2))
        print("    %-10s %5d 次  %6.1f%%  %s" % (tag, len(g), s * 100.0 / total_in, bar))

    print("\n  费用")
    for name, label in (("idle", "空闲时段"), ("peak", "高峰时段")):
        yuan, h, m, o = cost(rows, PRICE[name])
        print("    %s  ¥%5.2f   （缓存读 %.2f + 未命中 %.2f + 输出 %.2f）"
              % (label, yuan, h * PRICE[name]["hit"] / 1e6,
                 m * PRICE[name]["miss"] / 1e6, o * PRICE[name]["out"] / 1e6))

    # 上下文增长曲线（每 10 分位采样）
    n = len(rows)
    print("\n  上下文随时间（每 1/10 处采样）")
    print("    " + "  ".join("%4d" % (rows[min(i * n // 10, n - 1)][0] // 1000) for i in range(10)))
    print("    （单位 k token）")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    if "--all" in sys.argv:
        files = find_sessions()
        tot = {"rows": []}
        for p in files:
            rows = load(p)
            if rows:
                tot["rows"].extend(rows)
        report("全部会话汇总", tot["rows"])
        return
    files = find_sessions(args[0] if args else None)
    if not files:
        print("找不到会话记录，路径：%s" % PROJ)
        return
    report(files[0], load(files[0]))


if __name__ == "__main__":
    main()
