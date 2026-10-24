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

# 需要真实 ffmpeg **才能验任何东西**的套件 → 没有就整条跳过。
# 注意：能自己优雅降级的套件**不要**放进来（例如 host_merge_test：
# 它的 A 段测的是「缺 ffmpeg 时报什么码」，没有 ffmpeg 反而正好能验；
# 在这里提前跳过，等于把那半也一起丢了）。
NEEDS_FFMPEG = {"bili_stream_test.py"}

# 故意不纳入 CI 的：慢速大文件，本机手动跑即可
SLOW = {"big_file_test.py"}


def have_ffmpeg():
    """**能启动才算有。**

    老写法只做 `os.path.exists`，本机 2026-10-24 现场就骗了它一次：项目目录
    被打了 Low Mandatory Level 标签后 `bin/ffmpeg.exe` 启动就 0xC0000409 崩掉，
    而 exists 照样返回 True。于是 `have_ffmpeg()` 说「有」，套件被放进去跑，
    内部再自己 SKIP 并 `exit(0)` —— **汇总行记成 PASS**。
    一条断言都没跑的套件躺在「20/20 通过」里，比直接 FAIL 危险得多。
    """
    import shutil

    root = os.path.dirname(HERE)
    cands = [os.path.join(root, "bin", c) for c in ("ffmpeg", "ffmpeg.exe")]
    p = shutil.which("ffmpeg")
    if p:
        cands.append(p)
    for path in cands:
        if not os.path.exists(path):
            continue
        try:
            r = subprocess.run([path, "-version"], capture_output=True, timeout=10,
                               stdin=subprocess.DEVNULL,
                               **({"creationflags": 0x08000000} if os.name == "nt" else {}))
            if r.returncode == 0 and ((r.stdout or b"") + (r.stderr or b"")).strip():
                return True
        except Exception:
            continue
    return False


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
            results.append((name, "SKIP", "没有能跑的 ffmpeg"))
            print("  SKIP  %-32s 没有能跑的 ffmpeg" % name)
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
            # 77 = SKIP（automake 约定）。套件自己判「环境不满足」时用它，
            # 而不是 exit(0) —— 后者会被这里记成 PASS，等于把「没测」说成「过了」。
            if p.returncode == 77:
                why = [l for l in out.splitlines() if l.startswith("SKIP")]
                # 部分跳过：套件里**不需要**那个依赖的断言已经跑过并通过了。
                # 把这些也算成「什么都没验」是另一种失真 —— 所以在这里点名条数，
                # 但套件整体仍然记 SKIP（不能进「全绿」）。
                npass = out.count("PASS ")
                note = (why[-1][:120] if why else "套件自报跳过")
                if npass:
                    note += "（另有 %d 条已通过）" % npass
                results.append((name, "SKIP", note))
                print("  SKIP  %-32s %s" % (name, note[:90]))
            elif p.returncode == 0:
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
    if skipped:
        # 跳过的**不是通过**。这句话必须打出来：否则「20/20」会被顺手读成
        # 「20 套都验过了」，而实际有套件一条断言都没跑（2026-10-24 教训）。
        print("  注意：跳过的 %d 套**没有验证任何东西**，别把上面那行读成全绿。" % len(skipped))
        for name, status, info in skipped:
            print("    SKIP %s: %s" % (name, info[:160]))
    if failed:
        for name, status, info in failed:
            print(" %s %s: %s" % (status, name, info))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
