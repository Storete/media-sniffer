#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""变异 / 性质测试：给宿主侧的纯函数喂大量畸形输入，找「没想过的情况」。

和 test/ 的分工
---------------
  test/*            正常路径 + 我们真踩过的坑，确定、快、进 CI
  tools/fuzz_host   随机 + 结构化变异，慢、不确定、**只给你看报告**

为什么要分开：现有单测全是「已知坑」，而 bug 长在「没想过的情况」上。比如
sanitize("a." + "b"*300) 会返回 301 字符（超 Windows 255 上限），736 项单测
一条都没覆盖 —— 那是靠想不出来的，得靠喂。

设计原则：**不断言「正确答案」，只断言「不变量」**。派生出来的结果不是重点，
重点是这些结果永远不能违反的硬约束（长度、字符集、绝对地址、不崩）。没有
oracle 才这么写；等以后有了真实语料，再另外做端到端比对。

用法
----
    python tools/fuzz_host.py                  # 默认 3000 轮
    python tools/fuzz_host.py --rounds 20000
    python tools/fuzz_host.py --only sanitize  # sanitize | hls | masq | url
    python tools/fuzz_host.py --seed 42
    python tools/fuzz_host.py --verbose        # 打印每个反例

退出码：发现不变量失败 → 1（可以直接挂 CI 当 fuzz 门禁）。
"""
from __future__ import annotations

import argparse
import os
import random
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

import downloader as D  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


# ---------------------------------------------------------------- 报告器
class Report:
    def __init__(self, verbose=False):
        self.fail = Counter()
        self.case = Counter()
        self.samples = {}
        self.warn = Counter()
        self.verbose = verbose

    def hit(self, rule, payload, detail=""):
        self.fail[rule] += 1
        if rule not in self.samples:
            self.samples[rule] = (payload, detail)
        if self.verbose:
            print("  FAIL %-6s %r  %s" % (rule, payload, detail))

    def soft(self, rule, payload, detail=""):
        self.warn[rule] += 1
        if rule not in self.samples:
            self.samples[rule] = (payload, detail)

    def ran(self, area, n):
        self.case[area] += n

    def dump(self):
        print("\n" + "=" * 72)
        print("轮次统计")
        print("=" * 72)
        for area, n in self.case.items():
            print("  %-10s %6d 轮" % (area, n))

        if not self.fail and not self.warn:
            print("\n没有任何不变量被违反。")
            return 0

        if self.fail:
            print("\n" + "=" * 72)
            print("硬失败（违反不变量，视为 bug）")
            print("=" * 72)
            for rule, n in self.fail.most_common():
                payload, detail = self.samples.get(rule, ("", ""))
                print("  %-7s %5d 次   首个反例: %r" % (rule, n, payload))
                if detail:
                    print("           %s" % detail)
        if self.warn:
            print("\n" + "=" * 72)
            print("软警告（可能不是 bug，但值得看一眼）")
            print("=" * 72)
            for rule, n in self.warn.most_common():
                payload, detail = self.samples.get(rule, ("", ""))
                print("  %-7s %5d 次   首例: %r  %s" % (rule, n, payload, detail))
        return 1 if self.fail else 0


# ---------------------------------------------------------------- 输入池
# 真实标题里会出现的东西：中文、括号、emoji、竖线、冒号、反问号、路径分隔符、
# 保留名片段、超长串。别只喂 ascii。
PIECES = [
    "【4K】", "第 12 集", "（上）", "  ", ".", "..", "...", "|", ":", "?", "*",
    '"', "<", ">", "/", "\\", "\x00", "\x01", "\n", "\t", "\r", "con", "PRN",
    "aux", "nul", "com1", "lpt9", "con.txt", "🎬", "🔥", "中文标题", "a", "x" * 60,
    "y" * 200, "_", "-", "  .  ", "\u3000", "\u200b",
]
EXTS = ["", ".mp4", ".m4a", ".webm", ".ts", ".mkv", ".flac", ".pdf",
        ".jpg", ".m3u8", "." + "z" * 40, "." + "q" * 300, ".MP4", ".tar.gz"]


def rand_name(rnd):
    n = rnd.randint(0, 8)
    body = "".join(rnd.choice(PIECES) for _ in range(n))
    return body + rnd.choice(EXTS)


def utf16_len(s):
    """Windows 文件名的上限按 UTF-16 码元算，emoji 占 2 个。"""
    return len(s.encode("utf-16-le")) // 2


# ---------------------------------------------------------------- sanitize
def fuzz_sanitize(rnd, rounds, rep):
    print("[1/4] sanitize —— 文件名合法性")
    for _ in range(rounds):
        raw = rand_name(rnd)
        try:
            out = D.sanitize(raw)
        except Exception as e:  # noqa: BLE001
            rep.hit("S0", raw, "抛异常: %r" % (e,))
            continue

        # S1 非空
        if not out:
            rep.hit("S1", raw, "返回空串")
            continue
        # S2 长度受控（sanitize 只管主干，调用方再拼扩展名）
        if len(out) > D.MAX_BASE:
            rep.hit("S2", raw, "长度 %d > %d" % (len(out), D.MAX_BASE))
        # S3 首尾不能是点或空格
        if out != out.strip(" .") or out != out.rstrip(" ."):
            rep.hit("S3", raw, "首尾残留点/空格: %r" % (out[:12],))
        # S4 非法字符
        if D.ILLEGAL.search(out):
            rep.hit("S4", raw, "含非法字符: %r" % (D.ILLEGAL.search(out).group(),))
        # S5 保留设备名
        if D.RESERVED.match(out):
            rep.hit("S5", raw, "是 Windows 保留名: %r" % (out,))
        # S6 幂等：洗过的名字再洗一次必须不变
        try:
            again = D.sanitize(out)
        except Exception as e:  # noqa: BLE001
            rep.hit("S6", raw, "二次洗抛异常: %r" % (e,))
            again = out
        if again != out:
            rep.hit("S6", raw, "不幂等: %r -> %r" % (out[:20], again[:20]))
        # S7 UTF-16 码元（Windows 真实上限 255，含扩展名与目录，留余量）
        if utf16_len(out) > 200:
            rep.soft("S7", raw, "UTF-16 码元 %d（emoji 会翻倍）" % utf16_len(out))
    rep.ran("sanitize", rounds)


# ---------------------------------------------------------------- HLS 清单
HLS_TEMPLATES = [
    # 0 标准 media
    "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n"
    "#EXTINF:10.0,\nseg-1.ts\n#EXTINF:10.0,\nseg-2.ts\n#EXT-X-ENDLIST\n",
    # 1 master
    "#EXTM3U\n"
    "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow/index.m3u8\n"
    "#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720\nhigh/index.m3u8\n",
    # 2 加密 + fMP4
    "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x1\n"
    "#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4,\nseg1.m4s\n#EXT-X-ENDLIST\n",
    # 3 站内绝对路径 + query
    "#EXTM3U\n#EXTINF:6,\n/abs/seg-1.ts?token=abc\n#EXT-X-ENDLIST\n",
    # 4 byterange + discontinuity
    "#EXTM3U\n#EXT-X-BYTERANGE:1000@0\n#EXTINF:5,\nall.ts\n"
    "#EXT-X-DISCONTINUITY\n#EXTINF:5,\nseg2.ts\n",
    # 5 空清单
    "#EXTM3U\n",
    # 6 只有 EXTINF 没有分片
    "#EXTM3U\n#EXTINF:10,\n#EXTINF:10,\n",
]

MUTATIONS = [
    "drop_endlist", "dup_key", "crlf", "bom", "bw_missing", "bw_huge",
    "uri_unquoted", "uri_empty", "relative_up", "absolute_other_host",
    "drop_all_extinf", "empty_lines", "comment_noise", "lowercase_tags",
    "huge_url", "repeat_master", "master_no_uri", "utf8_bom_body",
]


def mutate_playlist(rnd, text, op):
    if op == "drop_endlist":
        return text.replace("#EXT-X-ENDLIST\n", "")
    if op == "dup_key":
        return text.replace(
            "#EXTM3U\n",
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k1.bin\"\n"
            "#EXT-X-KEY:METHOD=NONE\n", 1)
    if op == "crlf":
        return text.replace("\n", "\r\n")
    if op == "bom":
        return "\ufeff" + text
    if op == "utf8_bom_body":
        return text + "\ufeff"
    if op == "bw_missing":
        return text.replace("BANDWIDTH=800000,", "")
    if op == "bw_huge":
        return text.replace("BANDWIDTH=800000", "BANDWIDTH=" + "9" * 40)
    if op == "uri_unquoted":
        return text.replace('URI="key.bin"', "URI=key.bin")
    if op == "uri_empty":
        return text.replace('URI="key.bin"', 'URI=""').replace(
            'URI="init.mp4"', 'URI=""')
    if op == "relative_up":
        return text.replace("seg-1.ts", "../../up/seg-1.ts")
    if op == "absolute_other_host":
        return text.replace("seg-1.ts", "https://other.example/x/seg-1.ts")
    if op == "drop_all_extinf":
        return "\n".join(l for l in text.splitlines() if not l.startswith("#EXTINF"))
    if op == "empty_lines":
        return "\n\n".join(text.splitlines())
    if op == "comment_noise":
        return text.replace("#EXTM3U", "#EXTM3U\n# a comment\n#\n#EXT-X-UNKNOWN:1")
    if op == "lowercase_tags":
        return "\n".join(
            l.lower() if l.startswith("#EXT-X") else l for l in text.splitlines())
    if op == "huge_url":
        return text.replace("seg-2.ts", "s" * 5000 + ".ts")
    if op == "repeat_master":
        return "#EXTM3U\n" + "".join(
            "#EXT-X-STREAM-INF:BANDWIDTH=%d\nv%d.m3u8\n" % (i * 1000, i)
            for i in range(rnd.randint(1, 30)))
    if op == "master_no_uri":
        return "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n"
    raise AssertionError(op)


def fuzz_hls(rnd, rounds, rep):
    print("[2/4] parse_hls_playlist —— m3u8 解析")
    base = "https://cdn.example.com/a/b/index.m3u8"
    for i in range(rounds):
        text = rnd.choice(HLS_TEMPLATES)
        op = rnd.choice(MUTATIONS)
        try:
            text = mutate_playlist(rnd, text, op)
        except AssertionError:
            continue
        try:
            info = D.parse_hls_playlist(text, base)
        except Exception as e:  # noqa: BLE001
            rep.hit("H0", (op, text[:60]), "抛异常: %r" % (e,))
            continue

        # H1 返回值契约
        if not isinstance(info, dict):
            rep.hit("H1", op, "返回类型 %r" % type(info))
            continue
        for key in ("kind", "child", "segments", "init", "encrypted",
                    "key_url", "byterange"):
            if key not in info:
                rep.hit("H1", op, "缺字段 %s" % key)
        # H2 kind 只能是两个值
        if info.get("kind") not in ("master", "media"):
            rep.hit("H2", op, "kind=%r" % (info.get("kind"),))
        # H3 所有地址必须是绝对地址（urljoin 之后）
        urls = list(info.get("segments") or [])
        for key in ("child", "init", "key_url"):
            if info.get(key):
                urls.append(info[key])
        for u in urls:
            if not isinstance(u, str):
                rep.hit("H3", op, "非字符串地址 %r" % (u,))
            elif not u.startswith(("http://", "https://")):
                rep.hit("H3", (op, u[:60]), "不是绝对地址")
        # H4 没有 STREAM-INF 就不该判成 master
        if "#EXT-X-STREAM-INF" not in text and info.get("kind") == "master":
            rep.hit("H4", op, "无 STREAM-INF 却判成 master")
        # H5 master 必须有子清单地址。空的情况 run_hls_self 已经兜住了
        #    （"多码率清单里没找到子清单"），所以只算软警告。
        if info.get("kind") == "master" and not info.get("child"):
            rep.soft("H5", (op, text[:80]), "master 但 child 为空（调用方有兜底）")
        # H6 media 不该同时带 child
        if info.get("kind") == "media" and info.get("child"):
            rep.hit("H6", op, "media 却带 child=%r" % (info["child"][:40],))
        # H7 加密标记与 key_url 是否自洽。KEY 拿不到 URI 不算致命：
        #    encrypted 一置位就整体交回 yt-dlp，我们不去取密钥。
        if info.get("encrypted") and not info.get("key_url"):
            rep.soft("H7", (op, text[:80]), "encrypted 但无 key_url（交回 yt-dlp，不取密钥）")
        # H8 分片地址里不该有 BOM / 零宽 / 控制字符。
        #    这条是补出来的：带 BOM 的清单会让首行 "\ufeff#EXTM3U" 不以 "#"
        #    开头，从而被当成一个分片地址。只检查「是不是绝对地址」是漏得掉的，
        #    必须检查「里面有没有根本不该出现在 URL 里的字符」。
        INVISIBLE = "\ufeff\u200b\u200e\u200f"
        for u in urls:
            if not isinstance(u, str):
                continue
            if any(c in INVISIBLE for c in u) or any(ord(c) < 32 for c in u):
                rep.hit("H8", (op, u[:60]), "地址里含 BOM/零宽/控制字符")
    rep.ran("hls", rounds)


# ---------------------------------------------------------------- 伪装分片
TS_PACKET = 188


def ts_stream(rnd, packets=20):
    out = bytearray()
    for _ in range(packets):
        pkt = bytearray(rnd.getrandbits(8) for _ in range(TS_PACKET))
        pkt[0] = 0x47
        out += pkt
    return bytes(out)


def fuzz_masq(rnd, rounds, rep):
    print("[3/4] strip_masquerade —— 图片壳 + TS 剥离")
    for _ in range(rounds):
        mode = rnd.choice(["pure_ts", "png_ts", "jpeg_ts", "noise",
                           "truncated", "empty", "ts_then_noise", "short"])
        if mode == "pure_ts":
            data = ts_stream(rnd)
        elif mode == "png_ts":
            shell = b"\x89PNG\r\n\x1a\n" + bytes(rnd.getrandbits(8)
                                                for _ in range(rnd.randint(8, 300)))
            data = shell + ts_stream(rnd)
        elif mode == "jpeg_ts":
            shell = b"\xff\xd8\xff\xe0" + bytes(rnd.getrandbits(8)
                                               for _ in range(rnd.randint(4, 200)))
            data = shell + ts_stream(rnd)
        elif mode == "noise":
            data = bytes(rnd.getrandbits(8) for _ in range(rnd.randint(1, 500)))
        elif mode == "truncated":
            data = ts_stream(rnd, rnd.randint(1, 3))[: rnd.randint(1, 300)]
        elif mode == "empty":
            data = b""
        elif mode == "ts_then_noise":
            data = ts_stream(rnd, 3) + bytes(rnd.getrandbits(8) for _ in range(400))
        else:
            data = bytes([0x47]) * rnd.randint(1, 5)

        try:
            out = D.strip_masquerade(data)
        except Exception as e:  # noqa: BLE001
            rep.hit("M0", (mode, len(data)), "抛异常: %r" % (e,))
            continue

        # M1 不能变长（它只剥壳，不造数据）
        if len(out) > len(data):
            rep.hit("M1", (mode, len(data), len(out)), "输出变长")
        # M2 空进空出
        if not data and out:
            rep.hit("M2", mode, "空输入返回非空")
        # M3 本来以 0x47 开头的，必须原样返回（没有壳可剥）
        if data[:1] == b"\x47" and out != data:
            rep.hit("M3", (mode, len(data)), "纯 TS 被改动")
        # M4 剥壳后必须以 0x47 开头，否则等于交出一个坏文件。
        # 只对「壳 + TS」这两种输入硬查：noise 之类本来就不是 TS，原样返回才对。
        if data and out and out[:1] != b"\x47" and mode in ("png_ts", "jpeg_ts"):
            rep.hit("M4", (mode, len(data)), "剥壳后首字节 %r" % out[:1])
        # M5 幂等
        try:
            again = D.strip_masquerade(out)
        except Exception as e:  # noqa: BLE001
            rep.hit("M5", mode, "二次剥抛异常: %r" % (e,))
            again = out
        if again != out:
            rep.hit("M5", (mode, len(data)), "不幂等")
        # M6 能剥出 TS 的，输出必须真是 TS 周期
        if mode in ("png_ts", "jpeg_ts") and out[:1] == b"\x47":
            ok = all(out[i] == 0x47 for i in range(0, len(out) - TS_PACKET,
                                                 TS_PACKET)) if len(out) > TS_PACKET else True
            if not ok:
                rep.hit("M6", (mode, len(data)), "剥完不是 188 周期")
    rep.ran("masq", rounds)


# ---------------------------------------------------------------- URL 判据
URL_CASES = [
    ("https://a.com/x/index.m3u8", True),
    ("https://a.com/x/index.M3U8", True),
    ("https://a.com/x/index.m3u8?token=1", True),
    ("https://a.com/play?url=https://b.com/x.m3u8", False),
    ("https://a.com/x/index.m3u8/extra", False),
    ("https://a.com/x/index.m3u8.txt", False),
    ("", False),
    ("blob:https://a.com/1234", False),
    ("m3u8", False),
    ("https://a.com/m3u8?a=1", False),
    # 协议相对地址：path 确实是 .m3u8，按本函数的定义（只看 pathname）就是 True。
    # 它不需要在这里拦 —— downloader.main() 第一道校验就要求 ^https?://。
    ("//a.com/x.m3u8", True),
]


def fuzz_url(rnd, rounds, rep):
    print("[4/4] looks_like_hls_url —— 只看 pathname")
    for url, want in URL_CASES:
        try:
            got = D.looks_like_hls_url(url)
        except Exception as e:  # noqa: BLE001
            rep.hit("U0", url, "抛异常: %r" % (e,))
            continue
        if bool(got) != want:
            rep.hit("U1", url, "期望 %r 实得 %r" % (want, got))
    # 随机变形：大小写、多余斜杠、端口、userinfo、percent-encoding
    for _ in range(rounds):
        stem = rnd.choice(["index", "a b", "中文", "m3u8", "x.m3u8", "a.m3u8/", ""])
        q = rnd.choice(["", "?a=1", "?url=x.m3u8", "?t=.m3u8"])
        host = rnd.choice(["a.com", "A.COM", "a.com:8080", "u:p@a.com", "[::1]"])
        path = rnd.choice(["/", "/x/", "/x//", "/x/"])
        url = "https://%s%s%s%s" % (host, path, stem, q)
        try:
            D.looks_like_hls_url(url)
        except Exception as e:  # noqa: BLE001
            rep.hit("U0", url, "抛异常: %r" % (e,))
    rep.ran("url", rounds + len(URL_CASES))


# ---------------------------------------------------------------- 入口
def main():
    ap = argparse.ArgumentParser(description="宿主侧纯函数的变异/性质测试")
    ap.add_argument("--rounds", type=int, default=3000)
    ap.add_argument("--seed", type=int, default=0, help="0 = 每次不同")
    ap.add_argument("--only", default="", help="sanitize | hls | masq | url")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    seed = args.seed or random.randrange(1 << 30)
    rnd = random.Random(seed)
    rep = Report(args.verbose)
    print("seed = %d，每区 %d 轮" % (seed, args.rounds))
    print("=" * 72)

    only = (args.only or "").strip().lower()
    if not only or only == "sanitize":
        fuzz_sanitize(rnd, args.rounds, rep)
    if not only or only == "hls":
        fuzz_hls(rnd, args.rounds, rep)
    if not only or only == "masq":
        fuzz_masq(rnd, args.rounds, rep)
    if not only or only == "url":
        fuzz_url(rnd, args.rounds, rep)

    code = rep.dump()
    if code:
        print("\n复现：python tools/fuzz_host.py --seed %d --only <区>" % seed)
    return code


if __name__ == "__main__":
    sys.exit(main())
