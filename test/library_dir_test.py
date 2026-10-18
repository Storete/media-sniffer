# -*- coding: utf-8 -*-
"""library.py 目录选择规则测试（2026-10-18 新增）。

背景：旧实现分两轮扫候选（先「已存在」、后「可创建」），导致 C 盘上被旧版本
建出来的 ~/Downloads/MediaSniffer 永远压过「父目录可写、可以新建」的 D 盘首选
目录，违背「文件尽量别放 C 盘」。现在合并为一轮「存在或可建」判定。
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "native-host"))
import library

PASS = 0
FAIL = 0


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("PASS " + name)
    else:
        FAIL += 1
        print("FAIL " + name)


def dead_drive():
    """找一个本机不存在的盘符，用来构造「父链断掉、建不出来」的候选。"""
    for i in range(65, 91):
        drv = chr(i) + ":\\"
        if not os.path.exists(drv):
            return drv
    return None


def with_candidates(cands, fallback, env=None, create=True):
    """在受控候选列表下调用 library_dir，返回选中的目录。"""
    old_c, old_f = library.CANDIDATES, library.FALLBACK
    old_env = os.environ.get(library.ENV_KEY)
    library.CANDIDATES, library.FALLBACK = cands, fallback
    if env is not None:
        os.environ[library.ENV_KEY] = env
    elif old_env is not None:
        del os.environ[library.ENV_KEY]
    try:
        return library.library_dir(create=create)
    finally:
        library.CANDIDATES, library.FALLBACK = old_c, old_f
        if old_env is None:
            os.environ.pop(library.ENV_KEY, None)
        else:
            os.environ[library.ENV_KEY] = old_env


def main():
    tmp = tempfile.mkdtemp(prefix="libdir_test_")
    c_exist = os.path.join(tmp, "c_drive_like", "MediaSniffer")   # 模拟 C 盘已存在目录
    d_new = os.path.join(tmp, "d_drive_like", "文件存放处")         # 模拟 D 盘「可新建」目录
    os.makedirs(c_exist)
    fb = os.path.join(tmp, "fallback")
    os.makedirs(fb)

    # 1. 环境变量最高优先
    got = with_candidates([c_exist], fb, env=os.path.join(tmp, "from_env"))
    check("环境变量优先于一切", got == os.path.join(tmp, "from_env"))

    # 2. 回归核心：列表靠前的「可新建」目录压过靠后的「已存在」目录
    got = with_candidates([d_new, c_exist], fb)
    check("可新建的 D 盘候选胜过已存在的 C 盘候选（旧实现在此返回 C 盘）", got == d_new)
    check("选中的目录被真正创建出来", os.path.isdir(d_new))

    # 3. 已存在的候选照常胜出（列表顺序）
    other = os.path.join(tmp, "other")
    os.makedirs(other)
    got = with_candidates([d_new, other], fb)
    check("列表顺序保持：前面的候选存在时直接选中", got == d_new)

    # 4. 所有候选都建不出来 → 兜底
    drv = dead_drive()
    if drv:
        dead = os.path.join(drv, "no", "such", "dir")
        got = with_candidates([dead], fb)
        check("全部候选不可用时落兜底", got == fb)
    else:
        print("SKIP 全部候选不可用时落兜底（找不到空闲盘符）")

    # 5. create=False 不建目录
    probe = os.path.join(tmp, "probe_no_create")
    got = with_candidates([probe], fb, create=False)
    check("create=False 时不创建目录", got == probe and not os.path.exists(probe))

    print()
    print("RESULT: " + ("ALL PASS" if FAIL == 0 else f"{FAIL} FAILED"))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
