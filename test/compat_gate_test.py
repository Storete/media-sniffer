#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""规则库 CI 门禁自身的反向验证（tools/check_compat_rules.py 的钉子）。

交接文档（docs/HANDOFF-T-C7-规则库.md）点名的判据：
  - 空库必须绿 —— 门禁不因「还没攒够案例」就红，那会卡死所有提交；
  - 伪造无引用 / 坏引用必须红 —— 假绿比真红更危险（d-052/d-058 的教训），
    只检查「文件里有『测试』两个字」的门禁等于没设。

所以这里的每个用例都是「构造一条违规案例，断言门禁真的会红」；
反过来「好案例必须绿」用一条引用真实测试文件的案例钉住——
如果 test/sanitize_test.py 哪天改名了，这条用例会跟着红，提醒同步改文档。

用法： python test/compat_gate_test.py
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GATE = os.path.join(ROOT, "tools", "check_compat_rules.py")

ok = True


def check(name, cond, extra=None):
    global ok
    if cond:
        print("PASS", name)
    else:
        ok = False
        print("FAIL", name, "" if extra is None else extra)


def run_gate(case_dir):
    """对 case_dir 跑门禁，返回 (exit_code, 合并后的输出)。"""
    p = subprocess.run(
        [sys.executable, GATE, "--dir", case_dir, "--test-root", HERE],
        capture_output=True, timeout=60,
        env=dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1"),
    )
    return p.returncode, ((p.stdout or b"") + (p.stderr or b"")).decode("utf-8", "replace")


GOOD_REFS = "test/sanitize_test.py"  # 真实存在的测试文件


def case_md(state="已启用", refs=GOOD_REFS, fid="001-x",
            sections=("现象", "复现", "根因", "修复"), body_extra="",
            sep=": ", with_bom=False, drop_field=None):
    fm = ["---", "id%s%s" % (sep, fid), "状态%s%s" % (sep, state),
          "测试引用%s%s" % (sep, refs), "适用版本%s1.3.42" % sep, "---"]
    if drop_field:
        fm = [ln for ln in fm if not ln.startswith(drop_field)]
    body = [""] + ["## %s" % s + "\n\n这里写点内容。\n" for s in sections]
    text = "\n".join(fm) + "\n" + "\n".join(body) + body_extra
    data = text.encode("utf-8-sig" if with_bom else "utf-8")
    return data


def new_dir():
    return tempfile.mkdtemp(prefix="compat_gate_")


def write(d, name, data):
    with open(os.path.join(d, name), "wb") as f:
        f.write(data)


# ------------------------------------------------------------ 1. 空库与豁免

print("[1] 空库放行：门禁不因「还没案例」卡提交")

d = new_dir()
code, out = run_gate(d)
check("完全空目录也绿（目录存在即可）", code == 0, out[:200])
shutil.rmtree(d)

d = new_dir()
write(d, "README.md", "# 规则库".encode("utf-8"))
write(d, "000-template.md", case_md(state="已启用", refs="不存在的引用"))
code, out = run_gate(d)
check("只有 README + 模板 → 绿（豁免按精确文件名）", code == 0, out[:200])
shutil.rmtree(d)

# ------------------------------------------------------------ 2. 好案例必须绿

print("[2] 合规案例必须绿")

d = new_dir()
write(d, "001-x.md", case_md())
code, out = run_gate(d)
check("已启用 + 真实引用 → 绿", code == 0, out[:300])
check("统计行报出启用数", "启用 1" in out, out[-200:])
shutil.rmtree(d)

d = new_dir()
write(d, "001-x.md", case_md(refs="test/sanitize_test.py test/naming.test.js"))
code, out = run_gate(d)
check("空格分隔的多引用（都真实存在）→ 绿", code == 0, out[:300])
shutil.rmtree(d)

d = new_dir()
write(d, "001-x.md", case_md(state="已停用", refs="",
                             sections=("现象", "复现", "根因", "修复", "停用"),
                             body_extra="\n## 停用\n\n被 002 取代。\n"))
code, out = run_gate(d)
check("已停用可以不写引用，但要有停用说明 → 绿", code == 0, out[:300])
shutil.rmtree(d)

d = new_dir()
write(d, "001-x.md", case_md(sep="："))
code, out = run_gate(d)
check("全角冒号 frontmatter 也能解析 → 绿", code == 0, out[:300])
shutil.rmtree(d)

d = new_dir()
write(d, "001-x.md", case_md(with_bom=True))
code, out = run_gate(d)
check("带 BOM 的案例文件仍能解析（d-047 的教训不能在门禁身上复发）→ 绿", code == 0, out[:300])
shutil.rmtree(d)

# ------------------------------------------------------------ 3. 引用缺失 / 坏引用必须红

print("[3] 无引用与坏引用必须红（本门禁存在的意义）")

d = new_dir()
write(d, "001-x.md", case_md(refs=""))
code, out = run_gate(d)
check("已启用但引用为空 → 红", code != 0 and "测试引用" in out, out[:300])
shutil.rmtree(d)

d = new_dir()
write(d, "001-x.md", case_md(refs="见 test 目录里的 sanitize 测试"))
code, out = run_gate(d)
check("引用写成一句人话（没有具体路径）→ 红", code != 0, out[:300])
shutil.rmtree(d)

d = new_dir()
write(d, "001-x.md", case_md(refs="test/does_not_exist_test.py"))
code, out = run_gate(d)
check("引用的文件不存在 → 红", code != 0 and "不存在" in out, out[:300])
shutil.rmtree(d)

d = new_dir()
write(d, "001-x.md", case_md(refs="test/sanitize_test.py test/nope_test.py"))
code, out = run_gate(d)
check("多引用中一个不存在 → 红", code != 0 and "nope_test.py" in out, out[:300])
shutil.rmtree(d)

d = new_dir()
write(d, "001-x.md", case_md(refs="../../etc/passwd.py"))
code, out = run_gate(d)
check("引用跑出 test/ 之外（../ 穿越）→ 红", code != 0, out[:300])
shutil.rmtree(d)

d = new_dir()
write(d, "001-x.md", case_md(refs="docs/TODO.md"))
code, out = run_gate(d)
check("引用指向 test/ 以外的真实文件 → 红", code != 0, out[:300])
shutil.rmtree(d)

d = new_dir()
write(d, "001-x.md", case_md(state="已停用", refs="test/does_not_exist_test.py",
                             sections=("现象", "复现", "根因", "修复", "停用"),
                             body_extra="\n## 停用\n\n过期。\n"))
code, out = run_gate(d)
check("已停用但写了坏引用 → 也红（写了引用就要存在）", code != 0 and "不存在" in out, out[:300])
shutil.rmtree(d)

# ------------------------------------------------------------ 4. 字段与结构必须红

print("[4] 模板没填完不许入库")

d = new_dir()
write(d, "001-x.md", case_md(state="生效中"))
code, out = run_gate(d)
check("状态写了表外值 → 红", code != 0 and "生效中" in out, out[:300])
shutil.rmtree(d)

d = new_dir()
write(d, "001-x.md", case_md(state="已启用", refs=GOOD_REFS, drop_field="适用版本"))
code, out = run_gate(d)
check("缺「适用版本」字段 → 红", code != 0 and "适用版本" in out, out[:300])
shutil.rmtree(d)

d = new_dir()
write(d, "001-x.md", case_md(sections=("现象", "复现", "根因")))
code, out = run_gate(d)
check("缺「修复」小节 → 红", code != 0 and "修复" in out, out[:300])
shutil.rmtree(d)

d = new_dir()
write(d, "001-x.md", case_md(fid="999-other"))
code, out = run_gate(d)
check("id 与文件名不一致 → 红", code != 0 and "不一致" in out, out[:300])
shutil.rmtree(d)

d = new_dir()
write(d, "001-x.md", "就一段话，没有 frontmatter。".encode("utf-8"))
code, out = run_gate(d)
check("没有 frontmatter → 红（不是静默跳过）", code != 0 and "frontmatter" in out, out[:300])
shutil.rmtree(d)

d = new_dir()
blank_fix = case_md().decode("utf-8").replace("## 修复\n\n这里写点内容。", "## 修复\n")
write(d, "001-x.md", blank_fix.encode("utf-8"))
code, out = run_gate(d)
check("小节只有标题没有内容 → 红（空小节不算回答了问题）", code != 0, out[:300])
shutil.rmtree(d)

# ------------------------------------------------------------ 5. 门禁自身的基础设施

print("[5] 门禁跑不起来也算红")

code, out = run_gate(os.path.join(ROOT, "docs", "no_such_dir_xyz"))
check("目录不存在 → 红（跑错目录等于没跑）", code != 0 and "不存在" in out, out[:300])

print()
print("=" * 56)
if ok:
    print("全部通过")
    sys.exit(0)
print("有失败项")
sys.exit(1)
