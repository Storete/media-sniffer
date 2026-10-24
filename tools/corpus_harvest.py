#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""T-F1 语料采集器：链接清单 → 纯度闸门 → 纯宿主档直灌 → JSONL 语料 + 分布报告。

为什么存在（d-075 之后的下一步）
--------------------------------
「大脑」开工前的必备件：失败语料库 + 评测集。本工具把「海量链接」灌过产品的
真实下载链路，每条产出一条结构化语料（URL 特征、选择的链、错误码、trail、
消息），附带分布报告——其中 INTERNAL 桶就是大脑的第一份教学大纲。

纪律（从 d-047 原样继承）：
  · 这是**数据采集**，不是测试跑分——产出严禁当 bug 报告用；
  · **采集当天的链接**：token 过期让隔夜数据失真；
  · **纯度比数量重要**：确认「页面确实带媒体标记」才值得一条下载尝试，
    纯图文页只会产出「本来就没视频」的噪声。

纯度闸门（纯宿主档的廉价近似）：
  直接抓 URL 首块内容——媒体类型/扩展名 → 直链档；text/html → 数媒体标记
  （<video / <audio / .m3u8 / .mp4 / 播放器特征串），有标记才进下载，
  无标记记 skipped（不浪费限速预算，也不制造「本来就没视频」的假失败）。

用法：
    python tools/corpus_harvest.py --input tools/sites.txt --limit 40
    python tools/corpus_harvest.py --input bookmarks.txt --input tools/sites.txt

输出：<outdir>/corpus-<日期>.jsonl（逐条增量写，中断不丢）+ report.md。
限速默认 1.5s/条；每条下载子进程带 MS_JOB_TIMEOUT=120（不让 6 小时任务级
超时拖死采集）。
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from collections import Counter
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# 页面里的媒体特征：标签、扩展名引用、常见播放器特征串
PAGE_MARKERS = (
    "<video", "<audio", ".m3u8", ".mp4", ".webm", ".mkv", "m3u8",
    "dplayer", "aplayer", "videojs", "plyr", "xgplayer", "artplayer",
    "playinfo", "player", "vid=", "vsource",
)
MEDIA_EXT_RE = re.compile(
    r"\.(mp4|m4v|webm|mkv|mov|avi|flv|ts|m4a|mp3|aac|ogg|opus|flac|wav)(\?|$)", re.I)


def load_links(paths):
    """清单文件 → 去重后的有序 URL 列表。`#` 注释行跳过；行尾 tag 忽略。"""
    seen, out = set(), []
    for p in paths:
        if not os.path.isfile(p):
            print("  （清单不存在，跳过：%s）" % p)
            continue
        for line in open(p, "r", encoding="utf-8", errors="replace"):
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            url = s.split()[0]
            if not re.match(r"^https?://", url, re.I):
                continue
            if url in seen:
                continue
            seen.add(url)
            out.append(url)
    return out


def probe(url):
    """抓 URL 首块 → (purity, kind, markers)。纯度闸门的全部依据。"""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            ctype = (r.headers.get("Content-Type") or "").lower()
            chunk = r.read(200 * 1024)
    except Exception as e:
        return ("fetch-error", "%s: %s" % (type(e).__name__, str(e)[:80]), [])
    if re.search(r"video|audio|mpegurl|octet-stream", ctype) or MEDIA_EXT_RE.search(url):
        return ("direct", ctype, [])
    if "html" in ctype or not ctype:
        text = chunk.decode("utf-8", "replace").lower()
        markers = [m for m in PAGE_MARKERS if m in text]
        return ("marked" if markers else "clean", ctype, markers[:8])
    return ("unknown", ctype, [])


def run_download(url, n, tmp, app_jobs):
    """纯宿主档：写 job → 子进程跑 downloader main → 读状态。返回语料记录。"""
    jid = "corpus-%s-%d" % (hashlib.md5(url.encode()).hexdigest()[:8], n)
    job = {"id": jid, "url": url, "kind": "video", "out": "corpus-%d" % n,
           "outdir": tmp, "concurrency": 4}
    jp = os.path.join(tmp, "job-%s.json" % jid)
    json.dump(job, open(jp, "w", encoding="utf-8"), ensure_ascii=False)
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1", MS_JOB_TIMEOUT="120",
               NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
    t0 = time.time()
    try:
        subprocess.run([sys.executable, os.path.join(ROOT, "native-host", "downloader.py"), jp],
                       capture_output=True, timeout=180, env=env)
    except subprocess.TimeoutExpired:
        pass
    dur_ms = int((time.time() - t0) * 1000)
    stf = os.path.join(app_jobs, jid + ".json")
    st = {}
    if os.path.isfile(stf):
        try:
            st = json.load(open(stf, encoding="utf-8"))
        except Exception:
            pass
    # plan（链与理由）从 downloader 模块直接问，与实际执行同源
    try:
        ytdlp = __import__("downloader").find_tool(["yt-dlp"])
        plan = __import__("downloader").plan_download(job, {"ytdlp": ytdlp, "ffmpeg": None})
        chain = plan.get("chain")
    except Exception:
        chain = "?"
    rec = {
        "url": url, "ts": time.strftime("%Y-%m-%d %H:%M:%S"), "chain": chain,
        "status": st.get("status"), "errcode": st.get("err") or "",
        "message": (st.get("message") or "")[:200],
        # trail 是语料里诊断价值最高的字段：三路尝试的完整轨迹
        #（规划=… ／ yt-dlp=… ／ 直连=…），大脑分析的原料就是它（第一跑发现）
        "trail": (st.get("trail") or "")[:300],
        "file_bytes": (os.path.getsize(st["file"]) if st.get("file") and os.path.isfile(st.get("file")) else 0),
        "duration_ms": dur_ms, "job": jid,
    }
    try:  # 清理本条产物（语料要的是记录不是文件）
        if st.get("file") and os.path.isfile(st["file"]):
            os.remove(st["file"])
        part = (st.get("file") or "") + ".part"
        if part and os.path.isfile(part):
            os.remove(part)
    except OSError:
        pass
    return rec


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--input", action="append", required=True, help="链接清单（可多次）")
    ap.add_argument("--limit", type=int, default=50, help="最多采集条数（默认 50）")
    ap.add_argument("--rate", type=float, default=1.5, help="每条间隔秒（默认 1.5，防反爬）")
    ap.add_argument("--outdir", default=os.path.join(
        os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "MediaSniffer", "corpus"))
    ap.add_argument("--keep-media", action="store_true", help="保留下载产物（默认只留记录）")
    args = ap.parse_args(argv)

    links = load_links(args.input)[: args.limit]
    if not links:
        print("清单里没有可用链接")
        return 1
    os.makedirs(args.outdir, exist_ok=True)
    app_jobs = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")),
                            "MediaSniffer", "jobs")
    jsonl = os.path.join(args.outdir, "corpus-%s.jsonl" % date.today().isoformat())
    print("语料采集：%d 条链接 → %s（限速 %.1fs/条，当天链接当天采）"
          % (len(links), jsonl, args.rate))

    stats = Counter()
    internal = []
    jf = open(jsonl, "a", encoding="utf-8")
    for n, url in enumerate(links, 1):
        purity, info, markers = probe(url)
        rec = {"url": url, "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
               "purity": purity, "info": info, "markers": markers}
        if purity == "clean":
            stats["skipped-clean"] += 1
            rec["outcome"] = "skipped-no-media-mark"
            jf.write(json.dumps(rec, ensure_ascii=False) + "\n"); jf.flush()
            print("  [%d/%d] SKIP 纯度闸门（无媒体标记）%s" % (n, len(links), url[:60]))
            time.sleep(args.rate)
            continue
        if purity == "fetch-error":
            stats["skipped-fetch"] += 1
            rec["outcome"] = "skipped-fetch-error"
            jf.write(json.dumps(rec, ensure_ascii=False) + "\n"); jf.flush()
            print("  [%d/%d] SKIP 抓不到（%s）" % (n, len(links), info))
            time.sleep(args.rate)
            continue
        dl = run_download(url, n, args.outdir, app_jobs)
        dl.update({k: rec[k] for k in ("purity", "info", "markers", "ts")})
        dl["outcome"] = dl.get("status") or "no-status"
        jf.write(json.dumps(dl, ensure_ascii=False) + "\n"); jf.flush()
        code = dl.get("errcode") or ("done" if dl.get("status") == "done" else "?")
        stats["done" if dl.get("status") == "done" else "error"] += 1
        stats["code:" + (code or "?")] += 1
        stats["chain:" + (dl.get("chain") or "?")] += 1
        if code == "INTERNAL":
            internal.append(dl)
        print("  [%d/%d] %-4s %-14s %s" % (n, len(links), dl.get("status"), code, url[:55]))
        if not args.keep_media and dl.get("file_bytes") == 0:
            pass
        time.sleep(args.rate)
    jf.close()

    # 分布报告——INTERNAL 桶是大脑的第一份教学大纲
    rep = os.path.join(args.outdir, "report-%s.md" % date.today().isoformat())
    with open(rep, "w", encoding="utf-8") as f:
        f.write("# 语料采集报告（%s）\n\n" % date.today().isoformat())
        f.write("> 这是**语料采集**报告，不是测试报告——失败记录是训练数据，不是 bug 清单。\n"
                "> 语料按当天链接采集，隔夜需重采。\n\n")
        f.write("## 总览\n\n- 链接 %d 条：done %d / error %d / 纯度跳过 %d / 抓不到 %d\n\n"
                % (len(links), stats["done"], stats["error"],
                   stats["skipped-clean"], stats["skipped-fetch"]))
        f.write("## 错误码分布\n\n| 码 | 条数 |\n|---|---|\n")
        for k, v in sorted(stats.items()):
            if k.startswith("code:"):
                f.write("| %s | %d |\n" % (k[5:], v))
        f.write("\n## 链分布\n\n| 链 | 条数 |\n|---|---|\n")
        for k, v in sorted(stats.items()):
            if k.startswith("chain:"):
                f.write("| %s | %d |\n" % (k[6:], v))
        f.write("\n## INTERNAL 桶（教学大纲——大脑最该先学的失败）\n\n")
        if internal:
            for r in internal:
                f.write("- %s\n  - %s\n" % (r["url"], r["message"] or "(无消息)"))
        else:
            f.write("（本轮没有 INTERNAL——错误码表把已知失败全接住了）\n")
    print("\n报告：%s" % rep)
    print("语料：%s（%d 条）" % (jsonl, len(links)))
    print("done %d / error %d / 纯度跳过 %d" % (stats["done"], stats["error"], stats["skipped-clean"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
