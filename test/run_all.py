#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""跑全部 Python 测试套件，汇总结果。

用法：
    python test/run_all.py            # 全部
    python test/run_all.py --list     # 只列出有哪些套件
    python test/run_all.py -k merge   # 只跑名字含 merge 的

设计说明：
- **不依赖 pytest**：每个套件都是可以直接 `python xxx_test.py` 跑的独立脚本，
  以退出码 0 / 非 0 表示成败。这里只是把它们串起来、统一汇总。
- **环境不满足就 SKIP 而不是 FAIL**：有些套件需要本机装了 ffmpeg 才能跑，
  CI 容器里没有时应报「跳过」，不该让整条流水线变红。
- 超时保护：单个套件默认 180 秒（`big_file_test.py` 本来就是慢速大文件测试，
  它自己会超时退出，属预期行为）。
"""
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TIMEOUT = int(os.environ.get("TEST_TIMEOUT", "180"))

# 需要真实 ffmpeg 可执行文件的套件 → 没有就跳过
NEEDS_FFMPEG = {"host_merge_test.py", "bili_stream_test.py"}

# 故意不纳入 CI 的：慢速大文件，本机手动跑即可
SLOW = {"big_file_test.py"}


def have_ffmpeg():
    import shutil

    root = os.path.dirname(HERE)
    for cand in ("ffmpeg", "ffmpeg.exe"):
        if os.path.exists(os.path.join(root, "bin", cand)):
            return True
    return shutil.which("ffmpeg") is not None


def suites():
    names = sorted(
        n for n in os.listdir(HERE) if n.endswith("_test.py") and n not in SLOW
    )
    return names


def main(argv):
    # 本进程自己的输出也强制 UTF-8：CI 的 Windows runner 默认 cp1252，
    # 否则汇总行里的中文会直接把脚本搞崩。
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    if "--list" in argv:
        for n in suites():
            print(n)
        return 0

    picked = suites()
    if "-k" in argv:
        kw = argv[argv.index("-k") + 1]
        picked = [n for n in picked if kw in n]

    ffmpeg_ok = have_ffmpeg()
    results = []
    t0 = time.time()

    for name in picked:
        if name in NEEDS_FFMPEG and not ffmpeg_ok:
            results.append((name, "SKIP", "没有 ffmpeg"))
            print("  SKIP  %-32s 没有 ffmpeg" % name)
            continue

        start = time.time()
        # Windows 上子进程的 stdout 默认走 ANSI 代码页（CI runner 是 cp1252），
        # 一 print 中文就 UnicodeEncodeError。强制 UTF-8，两个变量都要设：
        # PYTHONIOENCODING 管 sys.stdout 的编码，PYTHONUTF8 管文件系统/默认编码。
        child_env = dict(os.environ)
        child_env["PYTHONIOENCODING"] = "utf-8"
        child_env["PYTHONUTF8"] = "1"
        try:
            p = subprocess.run(
                [sys.executable, os.path.join(HERE, name)],
                capture_output=True,
                timeout=TIMEOUT,
                cwd=HERE,
                env=child_env,
            )
            out = (p.stdout or b"").decode("utf-8", "replace")
            err = (p.stderr or b"").decode("utf-8", "replace")
            dt = time.time() - start
            if p.returncode == 0:
                results.append((name, "PASS", "%.1fs" % dt))
                print("  PASS  %-32s %.1fs" % (name, dt))
            else:
                tail = (err.strip() or out.strip()).splitlines()[-3:]
                results.append((name, "FAIL", " | ".join(tail)[:300]))
                print("  FAIL  %-32s %.1fs" % (name, dt))
                for line in tail:
                    print("        " + line[:200])
        except subprocess.TimeoutExpired:
            results.append((name, "TIMEOUT", "%ss" % TIMEOUT))
            print("  TIMEOUT %-30s %ss（可用 TEST_TIMEOUT 调大）" % (name, TIMEOUT))

    total = time.time() - t0
    failed = [r for r in results if r[1] in ("FAIL", "TIMEOUT")]
    skipped = [r for r in results if r[1] == "SKIP"]
    passed = [r for r in results if r[1] == "PASS"]

    print()
    print("=" * 56)
    print(
        " 通过 %d / 跳过 %d / 失败 %d    （%.1fs）"
        % (len(passed), len(skipped), len(failed), total)
    )
    print("=" * 56)
    if failed:
        for name, status, info in failed:
            print(" %s %s: %s" % (status, name, info))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
