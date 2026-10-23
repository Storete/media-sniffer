#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""文件名清洗 与 m3u8 解析的边界用例。

这套用例的来源不是「想出来的」：它们全部由 `tools/fuzz_host.py` 的变异测试
跑出来后钉在这里，防止再退回去。

当时（2026-10-23）fuzz 第一轮就出了两条：
  · sanitize("a." + "b"*300) 返回 301 字符 —— 超 Windows 255 上限，真建不出文件
  · sanitize 对 "　.PRN.webm" 不幂等 —— 洗一次留 U+3000，洗两次才干净

两条的根因都是同一类：**常量/序列没考虑边界**。所以这套测试的重点不是
「正常名字洗得对不对」（那谁都会写），而是长度、字符集、幂等这三件事在
极端输入下还成不成立。
"""
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "native-host"))

import downloader as D          # noqa: E402
import sniffer_host as H        # noqa: E402

passed = 0
failed = 0


def check(name, cond, extra=None):
    global passed, failed
    if cond:
        passed += 1
        print("  \u2713 " + name)
    else:
        failed += 1
        print("  \u2717 " + name + (("  -> " + repr(extra)) if extra is not None else ""))


def utf16_len(s):
    """Windows 的文件名上限按 UTF-16 码元算，emoji 占 2 个。"""
    return len(s.encode("utf-16-le")) // 2


# ---------------------------------------------------------------- sanitize
print("[1] sanitize：超长与截断（fuzz 挖出来的两条）")
r = D.sanitize("a." + "b" * 300)
check("超长「扩展名」不会突破 MAX_BASE", len(r) <= D.MAX_BASE, len(r))
check("超长扩展名整段被当正文，尾部无点", not r.endswith("."), r[-4:])

r = D.sanitize("x" * 99 + " " + "y" * 10)
check("第 100 个字符是空格时不留下尾随空格", r == r.rstrip(" ."), repr(r[-3:]))

r = D.sanitize("x" * 99 + "." + "y" * 10)
check("截断后不留尾随点", r == r.rstrip(" ."), repr(r[-3:]))

r = D.sanitize("标题" * 80 + ".mp4")
check("正常长标题保留扩展名", r.endswith(".mp4"), r[-6:])
check("正常长标题总长受控", len(r) <= D.MAX_BASE, len(r))

print("[2] sanitize：全角空格与 Unicode 空白（不幂等的那条）")
for raw, label in [
    ("\u3000.PRN.webm", "全角空格开头"),
    ("\u3000第1集.mp4", "全角空格在中文标题前"),
    ("\u00a0 视频.mp4", "不换行空格"),
    ("\u200b视频.mp4", "零宽空格"),
]:
    once = D.sanitize(raw)
    twice = D.sanitize(once)
    check("%s：一次就洗到稳态（幂等）" % label, once == twice, (once, twice))
    check("%s：首尾无空白/点" % label,
          once == once.strip() and once == once.strip(" ."), once)

print("[3] sanitize：Windows 建不出文件的名字")
for raw in ["con", "CON", "prn", "aux", "nul", "com1", "lpt9", "con.txt",
            "...", "   ", "", ".", " . . "]:
    r = D.sanitize(raw)
    check("%-9r 变成可用的名字" % raw,
          bool(r) and not D.RESERVED.match(r) and r == r.strip(" ."), r)

for raw in ['a<b>c.mp4', 'a:b.mp4', 'a|b.mp4', 'a?b.mp4', 'a*b.mp4',
            'a"b.mp4', 'a/b.mp4', 'a\\b.mp4', 'a\x00b.mp4', 'a\x1fb.mp4']:
    r = D.sanitize(raw)
    check("%-12r 非法字符被替换" % raw, not D.ILLEGAL.search(r), r)

print("[4] sanitize：随机输入的不变量（固定 seed，可复现）")
PIECES = ["【4K】", "第 12 集", "（上）", " ", ".", "..", "|", ":", "?", "*",
          "\x00", "\n", "\t", "con", "PRN", "com1", "🎬", "中文", "a", "x" * 60,
          "y" * 200, "\u3000", "\u200b", "_", "-"]
rnd = random.Random(20261023)
bad = []
for _ in range(500):
    raw = "".join(rnd.choice(PIECES) for _ in range(rnd.randint(0, 8)))
    raw += rnd.choice(["", ".mp4", ".m4a", "." + "z" * 40, "." + "q" * 300])
    try:
        out = D.sanitize(raw)
    except Exception as e:  # noqa: BLE001
        bad.append((raw, "抛异常 %r" % (e,)))
        continue
    if not out:
        bad.append((raw, "空串"))
    elif len(out) > D.MAX_BASE:
        bad.append((raw, "超长 %d" % len(out)))
    elif out != out.strip(" .") or out != out.strip():
        bad.append((raw, "首尾脏 %r" % out[:10]))
    elif D.ILLEGAL.search(out):
        bad.append((raw, "非法字符"))
    elif D.RESERVED.match(out):
        bad.append((raw, "保留名"))
    elif D.sanitize(out) != out:
        bad.append((raw, "不幂等 -> %r" % D.sanitize(out)[:20]))
    elif utf16_len(out) > 220:
        bad.append((raw, "UTF-16 码元 %d" % utf16_len(out)))
check("500 条随机输入全部满足不变量", not bad, bad[:2])

# ---------------------------------------------------------------- _safe_name
print("[5] sniffer_host._safe_name：同一类截断缺陷")
r = H._safe_name("x" * 149 + " .mp4")
check("第 150 个字符是空格时不留尾随空格", r == r.rstrip(" ."), repr(r[-3:]))
r = H._safe_name("x" * 149 + ".mp4")
check("第 150 个字符是点时不留下尾随点", r == r.rstrip(" ."), repr(r[-3:]))
check("超长输入长度受控", len(H._safe_name("x" * 400)) <= 150)
check("路径被剥掉", H._safe_name("../../etc/passwd") == "passwd")
check("反斜杠按路径处理", H._safe_name(r"C:\Windows\a.mp4") == "a.mp4")
check("空名兜底成 media- 前缀", H._safe_name("").startswith("media-"))
for reserved in ["CON", "con.txt", "NUL.mp4", "COM1", "lpt9.mkv", "aux"]:
    got = H._safe_name(reserved)
    check("保留名 %-9s 被改写" % reserved,
          os.path.splitext(got)[0].upper() not in H._WIN_RESERVED, got)

# ---------------------------------------------------------------- m3u8
print("[6] parse_hls_playlist：URI 属性的三种写法")
BASE = "https://cdn.example.com/a/index.m3u8"
for tag, label in [
    ('#EXT-X-MAP:URI="init.mp4"', "双引号"),
    ("#EXT-X-MAP:URI='init.mp4'", "单引号"),
    ("#EXT-X-MAP:URI=init.mp4", "不带引号"),
]:
    text = "#EXTM3U\n%s\n#EXTINF:4,\nseg1.m4s\n#EXT-X-ENDLIST\n" % tag
    info = D.parse_hls_playlist(text, BASE)
    check("EXT-X-MAP %s：init 段被解析出来" % label,
          info["init"] == "https://cdn.example.com/a/init.mp4", info["init"])

for tag, label in [
    ('#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', "双引号"),
    ("#EXT-X-KEY:METHOD=AES-128,URI='key.bin'", "单引号"),
    ("#EXT-X-KEY:METHOD=AES-128,URI=key.bin", "不带引号"),
]:
    text = "#EXTM3U\n%s\n#EXTINF:4,\nseg1.ts\n#EXT-X-ENDLIST\n" % tag
    info = D.parse_hls_playlist(text, BASE)
    check("EXT-X-KEY %s：置加密位并取到密钥地址" % label,
          info["encrypted"] and info["key_url"].endswith("/a/key.bin"),
          (info["encrypted"], info["key_url"]))

info = D.parse_hls_playlist(
    '#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\nseg1.ts\n', BASE)
check("METHOD=NONE 不算加密", not info["encrypted"])

print("[7] parse_hls_playlist：几种常见畸形清单")
cases = [
    ("BOM 开头", "\ufeff#EXTM3U\n#EXTINF:4,\nseg1.ts\n", "media", 1),
    ("CRLF 换行", "#EXTM3U\r\n#EXTINF:4,\r\nseg1.ts\r\n", "media", 1),
    ("空行夹杂", "#EXTM3U\n\n#EXTINF:4,\n\nseg1.ts\n", "media", 1),
    ("只有 ENDLIST", "#EXTM3U\n#EXT-X-ENDLIST\n", "media", 0),
    ("空串", "", "media", 0),
]
for label, text, want_kind, want_segs in cases:
    info = D.parse_hls_playlist(text, BASE)
    check("%s：kind=%s 分片 %d 个" % (label, want_kind, want_segs),
          info["kind"] == want_kind and len(info["segments"]) == want_segs,
          (info["kind"], info["segments"]))

info = D.parse_hls_playlist(
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8\n"
    "#EXT-X-STREAM-INF:BANDWIDTH=2400000\nhigh.m3u8\n", BASE)
check("master 取 BANDWIDTH 最大的子清单",
      info["kind"] == "master" and info["child"].endswith("/a/high.m3u8"),
      info["child"])
check("master 不产生分片", info["segments"] == [], info["segments"])

info = D.parse_hls_playlist("#EXTM3U\n#EXTINF:6,\n/abs/seg-1.ts\n", BASE)
check("站内绝对路径补全到同源",
      info["segments"] == ["https://cdn.example.com/abs/seg-1.ts"], info["segments"])

info = D.parse_hls_playlist("#EXTM3U\n#EXTINF:6,\n../../up/seg.ts\n", BASE)
check("相对路径按 RFC 3986 上溯",
      info["segments"] == ["https://cdn.example.com/up/seg.ts"], info["segments"])

print("\n==============================================")
print("通过 %d 项，失败 %d 项" % (passed, failed))
sys.exit(1 if failed else 0)
