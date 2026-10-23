#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""离线自测：HLS「伪装分片」与自实现下载（不起浏览器、只连本机 mock 服务）。

2026-10-22 真机（4kvm.net，用户报「这个网站的功能实现了吗」）：

  · 抓取正常：抓到一个 `hint=hls` 的 m3u8（60144 字节、514 个分片）；
  · 下载失败：`yt-dlp: ERROR: unable to download video data: HTTP Error 404`
    —— 但把 m3u8 拉下来会发现另一种更隐蔽的东西：

        分片 URL 全部是 https://sns-open-qc.xhscdn.com/... 去掉 Referer 才 200，
        返回的头 8 字节是 PNG 签名，IHDR 声明 64×64，IEND 在 offset 112 结束，
        **紧接着 offset 112 就是 0x47**，再按 188 字节周期取样 50/50 命中。

  也就是说：分片是「112 字节 PNG 壳 + 真 MPEG-TS 数据」。浏览器里 hls.js 用
  自定义 loader 剥壳后喂 MSE（实测 videoWidth=1920、buffered 到 2495s），
  yt-dlp/ffmpeg 不剥壳，于是要么 404（地址另有时效问题）要么拼出坏文件。

本套件锁两件事：
  1) `strip_masquerade()` 能识别并剥掉这种壳，且**不误伤**真 PNG / 真 TS；
  2) `run_hls_self()` 自己下 m3u8（并发 + 剥壳 + 按序拼 TS），端到端跑通。
"""
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

import downloader as D  # noqa: E402

results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  -> " + str(extra)))


# ---------------------------------------------------------------- 构造素材
TS_PACKET = 188


def ts_packet(pid=0x100, payload=b"x"):
    """一个 188 字节的 TS 包：首字节 0x47，其余填 payload，长度严格对齐。"""
    head = bytes([0x47, 0x40 | ((pid >> 8) & 0x1F), pid & 0xFF, 0x10])
    body = (payload * 200)[: TS_PACKET - len(head)]
    return head + body


def ts_stream(n=6, tag=b"a"):
    return b"".join(ts_packet(payload=tag + bytes([i])) for i in range(n))


def png_shell(payload=ts_stream(), pad=112):
    """和真机同构的壳：PNG 签名 + 一段填充使 IEND 恰好结束在 offset 112。"""
    head = b"\x89PNG\r\n\x1a\n" + b"\x00" * (pad - 8)
    return head + payload


REAL_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 200 + b"IEND" + b"\xaeB`\x82" * 20

# ---------------------------------------------------------------- 1. 剥壳
has_strip = hasattr(D, "strip_masquerade")
check("downloader 提供 strip_masquerade(bytes) -> bytes", has_strip)

if has_strip:
    body = ts_stream(6)
    masked = png_shell(body)
    out = D.strip_masquerade(masked)
    check("伪装 PNG 壳被整段剥掉（返回长度 = 原长度 - 112）",
          len(out) == len(body) and out[:1] == b"\x47", "got len=%d head=%r" % (len(out), out[:1]))
    check("剥壳后内容与原始 TS 完全一致", out == body)

    check("已经是 TS 的输入原样返回（不误伤）",
          D.strip_masquerade(body) == body)
    check("真 PNG（没有 TS 周期同步）原样返回（不误伤）",
          D.strip_masquerade(REAL_PNG) == REAL_PNG)
    check("空输入不炸", D.strip_masquerade(b"") == b"")

    # 壳里随机出现 0x47 但构不成 188 周期 -> 不能剥
    noisy = b"\x89PNG\r\n\x1a\n" + b"\x47" * 3 + b"\x00" * 300
    check("只有零星 0x47、构不成 188 周期时不剥（防误判）",
          D.strip_masquerade(noisy) == noisy)

    # 剥壳点必须落在「第一个能构成周期的位置」，而不是写死 112
    other_pad = png_shell(body, pad=200)
    check("壳长度不是 112 时同样能定位（不写死偏移）",
          D.strip_masquerade(other_pad) == body)

# ---------------------------------------------------------------- 2. 解析播放列表
has_parse = hasattr(D, "parse_hls_playlist")
check("downloader 提供 parse_hls_playlist(text, base_url)", has_parse)

if has_parse:
    BASE = "https://cdn.example.com/a/b/list.m3u8"
    media = (
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:7\n"
        "#EXTINF:6.125,\nseg-1.ts\n#EXTINF:6.125,\n/abs/seg-2.ts\n"
        "#EXTINF:6.125,\nhttps://other.example.com/seg-3.ts\n#EXT-X-ENDLIST\n"
    )
    p = D.parse_hls_playlist(media, BASE)
    check("media playlist 被识别为 media", p.get("kind") == "media", p)
    check("相对地址按 base 解析成绝对地址",
          p["segments"][0] == "https://cdn.example.com/a/b/seg-1.ts", p["segments"][:1])
    check("站内绝对路径按 host 补全",
          p["segments"][1] == "https://cdn.example.com/abs/seg-2.ts", p["segments"][1:2])
    check("跨域绝对地址原样保留",
          p["segments"][2] == "https://other.example.com/seg-3.ts")
    check("分片数量正确", len(p["segments"]) == 3)

    master = (
        "#EXTM3U\n"
        "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow/index.m3u8\n"
        "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\nhigh/index.m3u8\n"
    )
    pm = D.parse_hls_playlist(master, BASE)
    check("master playlist 被识别", pm.get("kind") == "master", pm)
    check("master 里挑最高码率的子清单",
          pm["child"] == "https://cdn.example.com/a/b/high/index.m3u8", pm.get("child"))

    enc = ("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://k.example.com/k1\"\n"
           "#EXTINF:6.0,\nseg-1.ts\n")
    pe = D.parse_hls_playlist(enc, BASE)
    check("检测到 AES-128 加密（加密流不交给自实现）",
          pe.get("encrypted") is True and "k1" in (pe.get("key_url") or ""), pe)

    fmp4 = ("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6.0,\nseg-1.m4s\n")
    pf = D.parse_hls_playlist(fmp4, BASE)
    check("检测到 EXT-X-MAP 初始化段",
          pf.get("init") == "https://cdn.example.com/a/b/init.mp4", pf.get("init"))

# ---------------------------------------------------------------- 3. 端到端：本地 mock HLS 服务
check("downloader 提供 run_hls_self(job)", hasattr(D, "run_hls_self"))


class Handler(BaseHTTPRequestHandler):
    """只回三种东西：伪装分片的 m3u8、伪装分片本身、404。

    `/seg-*` 额外模拟真机的防盗链方向：**带 Referer 一律 403，不带才 200**。
    这和大多数站相反（一般缺 Referer 才拒），正是 4kvm/xhscdn 的实测行为
    —— 浏览器侧 hls.js 用 referrerPolicy:no-referrer 发请求才拿得到数据。
    """

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/list.m3u8":
            body = ("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:7\n"
                    + "".join("#EXTINF:6.125,\nseg-%d.ts\n" % i for i in range(6))
                    + "#EXT-X-ENDLIST\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.apple.mpegurl")
        elif self.path.startswith("/seg-"):
            if self.headers.get("Referer"):
                self.send_error(403)
                return
            body = png_shell(ts_stream(4, tag=self.path.encode()[-1:]))
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
        else:
            self.send_error(404)
            return
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ThreadingServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


if hasattr(D, "run_hls_self"):
    srv = ThreadingServer(("127.0.0.1", 0), Handler)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()

    tmpdir = tempfile.mkdtemp(prefix="ms_hls_self_")
    job = {
        "id": "hls-self-test",
        "url": "http://127.0.0.1:%d/list.m3u8" % port,
        "kind": "video",
        "filename": "mock.mp4",
        "outdir": tmpdir,
        "concurrency": 4,
        # 本套件验的是「剥壳 + 按序拼 TS」，转封装另算：假 TS 包喂 ffmpeg 也没意义
        "remux": False,
    }
    # 状态目录指到临时目录，别污染真实 jobs/
    D.JOBS_DIR = os.path.join(tmpdir, "jobs")
    os.makedirs(D.JOBS_DIR, exist_ok=True)

    D.run_hls_self(job)
    st = D.read_status("hls-self-test")
    check("自实现 HLS 下载状态为 done", st.get("status") == "done", st)
    out_file = st.get("file") or ""
    check("产物存在且非空", bool(out_file) and os.path.isfile(out_file) and os.path.getsize(out_file) > 0, out_file)

    if out_file and os.path.isfile(out_file):
        data = open(out_file, "rb").read()
        check("产物首字节是 TS 同步字节（壳已被剥掉）", data[:1] == b"\x47", data[:8])
        check("产物里不含 PNG 签名（没有把壳拼进去）", b"\x89PNG" not in data)
        expect = 6 * len(ts_stream(4))
        check("产物大小 = 6 个分片的净长度之和（%d）" % expect, len(data) == expect, len(data))
        check("产物末尾仍是 TS 包边界", len(data) % TS_PACKET == 0, len(data) % TS_PACKET)

    # 404 的清单要给出人话，而不是抛异常
    job404 = dict(job, id="hls-self-404",
                  url="http://127.0.0.1:%d/missing.m3u8" % port)
    D.run_hls_self(job404)
    st4 = D.read_status("hls-self-404")
    check("清单 404 -> 状态 error 且提示里带地址过期线索",
          st4.get("status") == "error" and ("404" in (st4.get("message") or "")), st4)

    # 防盗链方向相反的站（4kvm/xhscdn）：带 Referer 403、不带才 200。
    # 头组合不能写死，必须自己探。
    job_ref = dict(job, id="hls-self-ref",
                   referer="https://www.4kvm.net/play/ch0y0e044",
                   filename="mock2.mp4")
    D.run_hls_self(job_ref)
    st_ref = D.read_status("hls-self-ref")
    check("分片带 Referer 被 403 时自动去掉 Referer 重试",
          st_ref.get("status") == "done", st_ref)
    if st_ref.get("status") == "done":
        f2 = st_ref.get("file") or ""
        check("降级后产物同样是干净的 TS",
              bool(f2) and open(f2, "rb").read()[:1] == b"\x47", f2)

    # 头组合的排列顺序：先原样、再去 Referer、再去 Origin、最后只剩 UA/Cookie
    has_var = hasattr(D, "_header_variants")
    check("downloader 提供 _header_variants(headers)", has_var)
    if has_var:
        vs = D._header_variants({
            "User-Agent": "UA", "Referer": "R", "Origin": "O", "Accept": "*/*",
        })
        check("第一个候选是原样（不主动降级）", vs[0].get("Referer") == "R" and vs[0].get("Origin") == "O", vs[0])
        check("第二个候选去掉了 Referer", "Referer" not in vs[1] and vs[1].get("Origin") == "O", vs[1])
        check("第三个候选连 Origin 也去掉", "Origin" not in vs[2] and vs[2].get("Accept") == "*/*", vs[2])
        check("最后一个候选只剩 UA", vs[-1].get("User-Agent") == "UA" and "Accept" not in vs[-1], vs[-1])
        check("候选数量有上限（不会把组合爆炸成十几种）", len(vs) <= 4, len(vs))

    srv.shutdown()

# ---------------------------------------------------------------- 4. 接进主分派
src = open(D.__file__, encoding="utf-8").read()
check("main() 对 m3u8 先试自实现 HLS（不等 yt-dlp 重试到超时）", "run_hls_self(job" in src)
check("自实现 HLS 只对 m3u8 生效（不抢别的地址）", "looks_like_hls_url" in src or ".m3u8" in src)

print("RESULT: " + ("ALL PASS" if all(results) else "FAILED %d" % results.count(False)))
sys.exit(0 if all(results) else 1)
