#!/usr/bin/env python3
"""跑完全部 JS 套件并给出**可复现**的总数。

为什么需要这个文件：JS 套件的汇总行有三种写法（历史原因，见 AGENTS.md）：

    「全部通过：28 通过 / 0 失败」      ← 老套件
    「通过 64 项，失败 0 项」           ← 新套件
    「PASS 12」                          ← 少数

之前每次收尾都用 `grep -c "✓"` 手工数，第二种写法一个 ✓ 都不打，
于是总数在 993 / 995 / 1021 之间来回飘，谁也不知道哪个是真的。
「数不清」本身就会掩盖红灯——所以把它固化成脚本。

另外两个坑，这里显式处理：

  1. `focus_scope / group_key / review` 三个文件是 **fragment**，只导出函数、
     由 background.test.js require 进来执行。它们单独跑输出为空、退出码 0，
     不能被算成「跑了一套」。
  2. 退出码非 0 一律记 FAIL，不管它打了多少 ✓。
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# 由别的套件 require 执行，单独跑没有意义
FRAGMENTS = {"focus_scope.test.js", "group_key.test.js", "review.test.js"}

PATTERNS = [
    re.compile(r"通过\s*(\d+)\s*项"),          # 通过 64 项，失败 0 项
    re.compile(r"(\d+)\s*通过\s*/\s*\d+\s*失败"),  # 全部通过：28 通过 / 0 失败
    re.compile(r"PASS\s+(\d+)"),
]


def node_exe():
    p = r"C:\Users\l\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
    if os.path.exists(p):
        return p
    return "node"


def pick_count(out):
    """从输出里取通过数；取不到就数 ✓。"""
    for pat in PATTERNS:
        found = pat.findall(out)
        if found:
            return int(found[-1])
    return out.count("✓")


def main():
    node = node_exe()
    files = sorted(f for f in os.listdir(HERE) if f.endswith(".test.js"))
    total = 0
    fails = []
    skipped = []
    for f in files:
        if f in FRAGMENTS:
            skipped.append(f)
            continue
        path = os.path.join(HERE, f)
        try:
            r = subprocess.run([node, path], capture_output=True, text=True, timeout=300)
        except subprocess.TimeoutExpired:
            fails.append((f, "timeout"))
            print("  FAIL  %-30s 超时" % f)
            continue
        out = (r.stdout or "") + (r.stderr or "")
        n = pick_count(out)
        total += n
        if r.returncode != 0:
            fails.append((f, "rc=%d" % r.returncode))
            print("  FAIL  %-30s %5d 项  rc=%d" % (f, n, r.returncode))
            tail = out.strip().splitlines()[-6:]
            for line in tail:
                print("        | " + line)
        else:
            print("  ok    %-30s %5d 项" % (f, n))

    print("")
    if skipped:
        print("  （fragment 不单独算：%s）" % "、".join(skipped))
    if fails:
        print("JS 总数 %d，**%d 套失败**：%s" % (total, len(fails), "、".join(f for f, _ in fails)))
        return 1
    print("JS 全部通过：%d 项（%d 个文件）" % (total, len(files) - len(skipped)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
