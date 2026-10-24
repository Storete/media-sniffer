#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""规则库门禁：`docs/compatibility/` 里每一条「已启用」的案例，必须有真实存在的测试引用。

判据是 PRODUCT-PLAN §4 L4 的原话：**「每条启用规则必须有测试引用」**。
规则库错一条，用户会下错文件且不自知（把封面当正文、把广告当内容），
所以这里卡的比普通文档检查严：不是「文件里出现过『测试』两个字」就算数，
要解析出具体的 `test/xxx_test.py` / `test/xxx.test.js` 路径，并确认它在仓库里真的存在。

三条铁的失败形态（每条都对应 test/compat_gate_test.py 里的一组反向用例）：
  1. 「已启用」但测试引用为空 / 写的是人话（「见 sanitize 测试」）→ 红；
  2. 引用的路径在 test/ 下不存在 → 红（案例挪走测试文件后忘了改文档，就是这种）；
  3. frontmatter 缺字段、状态写了别的值、正文缺小节 → 红（模板没填完不许入库）。

刻意**不**红的两种情况：
  - 目录里一条案例都没有 → 绿。空库不卡提交——「还没攒够真实失败」不是错，
    卡死所有提交的门禁第一天就会被人绕掉。
  - README.md 与 000-template.md 豁免（按文件名精确匹配，通配不了）。

用法：
    python tools/check_compat_rules.py                     # 默认仓库目录
    python tools/check_compat_rules.py --dir X --test-root Y
"""
import argparse
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

EXEMPT = {"README.md", "000-template.md"}
# 「测试引用」不在这里：它只在「已启用」时必填 —— 停用的规则允许引用留空
# （规则过期时它钉的测试可能已经删了），但一旦写了引用，存在性照样要查。
REQUIRED_FIELDS = ("id", "状态", "适用版本")
VALID_STATES = ("已启用", "已停用")
REQUIRED_SECTIONS = ("现象", "复现", "根因", "修复")
# 测试引用 token：test/ 开头、.py/.js 结尾，中间不许有空白和 ..
REF_TOKEN_RE = re.compile(r"^test[\\/][A-Za-z0-9_.\-]+\.(py|js)$")


def split_frontmatter(text):
    """返回 (frontmatter 文本, 正文) ；没有合法 frontmatter 返回 (None, None)。"""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "\n".join(lines[1:i]), "\n".join(lines[i + 1:])
    return None, None


def parse_fields(fm_text):
    """frontmatter 逐行 `key: value`（半角/全角冒号都认）→ dict；解析不了的行记进 errors。"""
    fields, bad = {}, []
    for ln in fm_text.splitlines():
        s = ln.strip()
        if not s:
            continue
        m = re.match(r"^([^:：]+)[：:](.*)$", s)
        if not m:
            bad.append(s)
            continue
        fields[m.group(1).strip()] = m.group(2).strip()
    return fields, bad


def section_text(body, name):
    """正文里 `## <name>` 小节的内容（到下一个 `## ` 为止），strip 后返回；没有返回空串。"""
    pat = re.compile(r"^##\s+%s\s*$" % re.escape(name), re.M)
    m = pat.search(body)
    if not m:
        return ""
    rest = body[m.end():]
    nxt = re.search(r"^##\s+", rest, re.M)
    if nxt:
        rest = rest[: nxt.start()]
    return rest.strip()


def ref_paths(value):
    """「测试引用」的值 → token 列表（空白 / 逗号 / 分号 / 顿号都当分隔符）。"""
    return [t for t in re.split(r"[\s,，;；、]+", value or "") if t]


def check_file(path, test_root):
    """单条案例 → 错误列表（空列表 = 过）。"""
    errs = []
    with open(path, "r", encoding="utf-8-sig") as f:
        # utf-8-sig 是 d-047 的教训：带 BOM 的文件首行会多出一个 \ufeff，
        # 让 frontmatter 的第一个 `---` 匹配不上，整条案例「静默不被解析」。
        text = f.read()

    name = os.path.basename(path)
    fm, body = split_frontmatter(text)
    if fm is None:
        return ["第一行必须是 `---` 开头的 frontmatter（模板见 000-template.md）"]
    fields, bad = parse_fields(fm)
    if bad:
        errs.append("frontmatter 里这几行不是 `key: value` 形态：%s" % "；".join(bad[:3]))

    for k in REQUIRED_FIELDS:
        if not fields.get(k):
            errs.append("frontmatter 缺字段「%s」" % k)

    state = fields.get("状态", "")
    if state and state not in VALID_STATES:
        errs.append("状态「%s」不在 %s 里" % (state, "/".join(VALID_STATES)))

    for sec in REQUIRED_SECTIONS:
        if not section_text(body, sec):
            errs.append("正文缺「## %s」小节或小节为空" % sec)

    refs = ref_paths(fields.get("测试引用", ""))
    if state == "已启用" and not refs:
        errs.append("已启用的案例必须有测试引用（指向 test/ 下真实存在的文件）")
    if state == "已停用" and not section_text(body, "停用"):
        errs.append("已停用的案例必须写「## 停用」说明原因")

    for ref in refs:
        if not REF_TOKEN_RE.match(ref):
            errs.append("测试引用「%s」不像 test/ 下的 .py/.js 路径" % ref)
            continue
        if ".." in ref:
            errs.append("测试引用「%s」含 .." % ref)
            continue
        if not os.path.exists(os.path.join(test_root, *ref.split("/")[1:])):
            errs.append("测试引用「%s」指向的文件不存在" % ref)

    fid = fields.get("id", "")
    if fid and fid != name[: -len(".md")]:
        errs.append("id「%s」与文件名不一致（应为 %s）" % (fid, name[: -len(".md")]))

    return errs


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dir", default=os.path.join(ROOT, "docs", "compatibility"),
                    help="规则库目录（默认 docs/compatibility）")
    ap.add_argument("--test-root", default=os.path.join(ROOT, "test"),
                    help="测试引用的根目录（默认 test/）")
    args = ap.parse_args(argv)

    if not os.path.isdir(args.dir):
        print("FAIL 规则库目录不存在：%s" % args.dir)
        print("     门禁跑在错的目录上等于没跑 —— 先确认仓库结构没变。")
        return 1

    names = sorted(n for n in os.listdir(args.dir) if n.endswith(".md"))
    cases = [n for n in names if n not in EXEMPT]
    if not cases:
        print("规则库门禁：%s" % args.dir)
        print("  目录里还没有任何案例（只有 README/模板）。空库放行，")
        print("  但新案例必须带真实存在的测试引用 —— 见 README 的准入三件套。")
        return 0

    failed = 0
    enabled = 0
    print("规则库门禁：%s（%d 条案例）" % (args.dir, len(cases)))
    for n in cases:
        errs = check_file(os.path.join(args.dir, n), args.test_root)
        if errs:
            failed += 1
            for e in errs:
                print("  FAIL %s: %s" % (n, e))
        else:
            # 状态在字段齐全时必然解析得到；这里再兜一层只为统计不炸
            fm, _ = split_frontmatter(open(os.path.join(args.dir, n), "r", encoding="utf-8-sig").read())
            fields, _ = parse_fields(fm)
            if fields.get("状态") == "已启用":
                enabled += 1
            print("  PASS %s" % n)

    print()
    if failed:
        print(" %d 条案例不过门禁（启用 %d / 共 %d）。" % (failed, enabled, len(cases)))
        print(" 每条启用规则必须有测试引用 —— 这是 PRODUCT-PLAN L4 的硬判据。")
        return 1
    print(" 全部通过：启用 %d / 停用 %d。" % (enabled, len(cases) - enabled))
    return 0


if __name__ == "__main__":
    sys.exit(main())
