#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""量一次「多连接到底值不值」——T-B3 的前置，不是功能代码。

为什么先量（`docs/ENGINE-EVAL.md` §4-P0）：单流确实是事实，但「该提速」和
「值得为此写 400 行并发分片」是两件事。倍数不到 2× 就先不做——那说明瓶颈在
对端/链路，而不是我们少开了几个连接。

做法：同一个文件、同一个进程、同一时刻，先单连接整份下一个来回，再 4 连接分
4 段并发下（丢弃数据，只计时）。三次取中位数，避免一次抖动定生死。

用法：
    python tools/throughput_check.py            # 用内置候选 URL
    python tools/throughput_check.py <url>      # 指定 URL
    python tools/throughput_check.py --rounds 5
"""
import sys
import threading
import time
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36"

# 只量**固定窗口**，不量整份文件：单连接与多连接下的是同样 32MB，才可比；
# 而且省时间、省流量、不受「文件多大」影响。
WINDOW = 32 * 1024 * 1024

# 候选：都要求支持 Range、体积 ≥20MB。按「离得近 + 稳定」排。
CANDIDATES = [
    # GitHub release 资源（S3 后端，支持 Range，且不像测速站那样秒限速）。
    # 顺手用刚评估过的 gopeed：它的 android 包 74MB，够大。
    "https://github.com/GopeedLab/gopeed/releases/download/v1.9.3/Gopeed-v1.9.3-android.apk",
    "https://proof.ovh.net/files/100Mb.dat",
    "https://ash-speed.hetzner.com/100MB.bin",
]


def head_size(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Range": "bytes=0-0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            cr = r.headers.get("Content-Range") or ""
            if "/" in cr:
                try:
                    return int(cr.rsplit("/", 1)[1]), True
                except ValueError:
                    return 0, False
            return int(r.headers.get("Content-Length") or 0), False
    except Exception as e:
        return 0, "ERR:%s" % str(e)[:60]


def fetch(url, start=None, end=None, sink=None):
    """下载一段；sink 是列表时把字节数累加进去（不存盘，省 IO 干扰）。"""
    h = {"User-Agent": UA}
    if start is not None:
        h["Range"] = "bytes=%d-%s" % (start, "" if end is None else str(end))
    req = urllib.request.Request(url, headers=h)
    n = 0
    with urllib.request.urlopen(req, timeout=60) as r:
        while True:
            chunk = r.read(262144)
            if not chunk:
                break
            n += len(chunk)
    if sink is not None:
        sink[0] += n
    return n


def one_conn(url, total):
    win = min(total, WINDOW)
    t0 = time.time()
    n = fetch(url, 0, win - 1)
    dt = time.time() - t0
    return n, dt


def multi_conn(url, total, parts):
    win = min(total, WINDOW)
    step = win // parts
    ranges = []
    for i in range(parts):
        s = i * step
        e = (win - 1) if i == parts - 1 else (s + step - 1)
        ranges.append((s, e))
    got = [0]
    errs = []

    def work(s, e):
        try:
            fetch(url, s, e, got)
        except Exception as ex:      # 单段失败就让整轮失败，别报个虚高的速度
            errs.append(ex)

    t0 = time.time()
    ts = [threading.Thread(target=work, args=rg) for rg in ranges]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    dt = time.time() - t0
    if errs:
        raise errs[0]
    return got[0], dt


def median(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2]


def mbps(n, dt):
    return (n / (1024.0 * 1024.0)) / dt if dt > 0 else 0.0


class RateLimited(Exception):
    """对端 429/403：这一轮测不出结论，换下一个源。"""


def bench(url, total, rounds):
    """返回 (单连接中位数, 4 连接中位数)。对端限速时抛 RateLimited。"""
    s1, s4 = [], []
    try:
        fetch(url, 0, min(total - 1, 1024 * 1024))      # 热身：把 DNS/TLS 挪出计时段
    except Exception:
        pass
    for i in range(rounds):
        n, dt = one_conn(url, total)
        s1.append(mbps(n, dt))
        print("  单连接 #%d：%.1f MB/s（%.1f MB / %.2fs）" % (i + 1, s1[-1], n / 1048576.0, dt))
        time.sleep(0.6)
    for i in range(rounds):
        n, dt = multi_conn(url, total, 4)
        s4.append(mbps(n, dt))
        print("  4 连接 #%d：%.1f MB/s（%.1f MB / %.2fs）" % (i + 1, s4[-1], n / 1048576.0, dt))
        time.sleep(0.6)
    return median(s1), median(s4)


def main(argv):
    rounds = 3
    if "--rounds" in argv:
        rounds = int(argv[argv.index("--rounds") + 1])
    urls = [a for a in argv[1:] if a.startswith("http")] or CANDIDATES

    tried = []
    for u in urls:
        size, ranged = head_size(u)
        if not (isinstance(size, int) and size >= 20 * 1024 * 1024 and ranged is True):
            print("跳过 %s（size=%s range=%s）" % (u, size, ranged))
            tried.append((u, "不支持 Range 或体积不足"))
            continue
        print("源  ：%s" % u)
        print("大小：%.1f MB，取前 %.0f MB 计时" % (size / 1048576.0, min(size, WINDOW) / 1048576.0))
        try:
            m1, m4 = bench(u, size, rounds)
        except urllib.error.HTTPError as e:
            # 429 本身就是发现：不少 CDN 对「同一 IP 多连接」直接限速，
            # 多连接不但不提速，还会把整单搞失败。
            print("  → HTTP %d，换下一个源\n" % e.code)
            tried.append((u, "HTTP %d" % e.code))
            continue
        ratio = (m4 / m1) if m1 else 0
        print("")
        print("中位数：单连接 %.1f MB/s → 4 连接 %.1f MB/s，倍数 %.2f×" % (m1, m4, ratio))
        print("判据（ENGINE-EVAL §4-P0）：≥2.0 才值得写多连接；<2.0 说明瓶颈在对端。")
        print("结论：%s" % ("值得做（≥2×）" if ratio >= 2.0 else "暂不做（<2×）"))
        return 0

    print("")
    print("没有源测出结论。已试：")
    for u, why in tried:
        print("  - %s  (%s)" % (u, why))
    print("换一个「≥20MB 且支持 Range」的地址再来：")
    print("  python tools/throughput_check.py <url>")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
