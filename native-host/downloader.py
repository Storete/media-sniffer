#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
独立下载进程（由 sniffer_host.py 以 detached 方式启动）

为什么单独一个进程：
  Chrome 的 service worker / 扩展弹窗随时可能被回收，如果下载跑在 native host
  里，一关弹窗就断了。这里让下载彻底独立，宿主死了也照下不误。

用法（内部）：
    python downloader.py <job.json>
状态写入 %LOCALAPPDATA%\\MediaSniffer\\jobs\\<id>.json
"""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

APP_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "MediaSniffer")
JOBS_DIR = os.path.join(APP_DIR, "jobs")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import library  # noqa: E402  统一的下载目录定位（默认 D:/软件应用/DSH/文件存放处）

DEFAULT_OUT = library.library_dir()
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)

ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
RESERVED = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])$", re.I)


def status_path(job_id):
    return os.path.join(JOBS_DIR, job_id + ".json")


def cancel_path(job_id):
    return os.path.join(JOBS_DIR, job_id + ".cancel")


def write_status(job_id, **fields):
    os.makedirs(JOBS_DIR, exist_ok=True)
    path = status_path(job_id)
    data = {}
    if os.path.exists(path):
        try:
            data = json.load(open(path, encoding="utf-8"))
        except Exception:
            data = {}
    data.update(fields)
    data["updated"] = time.time()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def sanitize(name, fallback="video"):
    name = (name or "").strip()
    name = ILLEGAL.sub("_", name).strip(" .")
    if not name or RESERVED.match(name):
        name = fallback
    if len(name) > 100:
        root, ext = os.path.splitext(name)
        name = root[:100 - len(ext)] + ext
    return name


PROJECT_BIN = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin"
)


def find_tool(names):
    # 优先用项目自带的 bin/（随插件一起分发，不依赖系统 PATH 和 C 盘）
    for n in names:
        for cand in (n, n + ".exe"):
            p = os.path.join(PROJECT_BIN, cand)
            if os.path.exists(p):
                return p
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    for base in [
        os.path.join(os.path.expanduser("~"), ".venvs", "agent-reach", "Scripts"),
        os.path.join(os.path.expanduser("~"), "scoop", "shims"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Links"),
    ]:
        for n in names:
            for cand in (n, n + ".exe"):
                p = os.path.join(base, cand)
                if os.path.exists(p):
                    return p
    return None


def is_cancelled(job_id):
    return os.path.exists(cancel_path(job_id))


# ---------------------------------------------------------------- yt-dlp 路径

PROGRESS_TPL = (
    "download:MSPROG|%(progress._percent_str)s|%(progress._speed_str)s|"
    "%(progress._eta_str)s|%(progress.downloaded_bytes)s|"
    "%(progress.total_bytes_estimate)s"
)


def run_ytdlp(job, ytdlp, ffmpeg):
    job_id = job["id"]
    outdir = job.get("outdir") or DEFAULT_OUT
    os.makedirs(outdir, exist_ok=True)

    base = sanitize(job.get("filename") or "", "video")
    base = os.path.splitext(base)[0] or "video"
    outtmpl = os.path.join(outdir, base + ".%(ext)s")

    cmd = [
        ytdlp, job["url"],
        "--no-playlist",
        "--newline",
        "--progress",
        "--progress-template", PROGRESS_TPL,
        "--print", "after_move:FILE:%(filepath)s",
        "--concurrent-fragments", str(int(job.get("concurrency") or 16)),
        "--retries", "10",
        "--fragment-retries", "10",
        "--hls-prefer-native",
        "--output", outtmpl,
    ]
    if job.get("referer"):
        cmd += ["--referer", job["referer"]]
    if job.get("cookie"):
        cmd += ["--add-header", "Cookie:" + job["cookie"]]
    if job.get("tabUrl"):
        cmd += ["--add-header", "Origin:" + _origin(job["tabUrl"])]
    if ffmpeg:
        cmd += ["--ffmpeg-location", os.path.dirname(ffmpeg)]
        if job.get("kind") in ("video", "audio"):
            cmd += ["--merge-output-format", "mp4"]

    write_status(job_id, status="downloading", percent=0, speed="", eta="", file="")

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        creationflags=0x08000000,  # CREATE_NO_WINDOW
    )

    final_file = ""
    tail = []
    try:
        for line in proc.stdout:
            line = line.rstrip()
            if not line:
                continue
            if line.startswith("MSPROG|"):
                parts = line[len("MSPROG|"):].split("|")
                if len(parts) >= 3:
                    pct_raw = parts[0].replace("%", "").strip()
                    try:
                        pct = float(pct_raw)
                    except ValueError:
                        pct = 0.0
                    write_status(
                        job_id,
                        status="downloading",
                        percent=pct,
                        speed=parts[1].strip(),
                        eta=parts[2].strip(),
                    )
            elif line.startswith("FILE:"):
                final_file = line[len("FILE:"):].strip()
            else:
                tail.append(line)
                if len(tail) > 40:
                    tail.pop(0)

            if is_cancelled(job_id):
                proc.terminate()
                write_status(job_id, status="cancelled", message="用户取消")
                return
    except Exception as e:
        write_status(job_id, status="error", message=("读取下载输出失败: " + str(e))[:300])
        return

    proc.wait()
    if proc.returncode == 0:
        write_status(job_id, status="done", percent=100, speed="", eta="", file=final_file)
    else:
        msg = " | ".join(tail[-6:]) or ("yt-dlp 退出码 %s" % proc.returncode)
        write_status(job_id, status="error", message=msg[:600])


def _origin(tab_url):
    try:
        from urllib.parse import urlparse
        p = urlparse(tab_url)
        return f"{p.scheme}://{p.netloc}"
    except Exception:
        return ""


# ---------------------------------------------------------------- 普通文件路径

def run_urllib(job):
    job_id = job["id"]
    outdir = job.get("outdir") or DEFAULT_OUT
    os.makedirs(outdir, exist_ok=True)

    name = sanitize(job.get("filename") or os.path.basename(job["url"].split("?")[0]), "file")
    path = os.path.join(outdir, name)
    root, ext = os.path.splitext(name)
    n = 1
    while os.path.exists(path) and os.path.getsize(path) > 0:
        path = os.path.join(outdir, f"{root} ({n}){ext}")
        n += 1

    headers = {"User-Agent": job.get("ua") or UA}
    if job.get("referer"):
        headers["Referer"] = job["referer"]
    if job.get("cookie"):
        headers["Cookie"] = job["cookie"]

    part = path + ".part"
    resumed = 0
    if os.path.exists(part):
        resumed = os.path.getsize(part)
        if resumed:
            headers["Range"] = f"bytes={resumed}-"

    write_status(job_id, status="downloading", percent=0, speed="", eta="", file="")
    req = urllib.request.Request(job["url"], headers=headers)

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            total = int(resp.headers.get("Content-Length") or 0)
            if resp.status == 206 and resumed:
                total += resumed
            elif total == 0:
                total = 0

            mode = "ab" if (resp.status == 206 and resumed) else "wb"
            if mode == "wb":
                resumed = 0

            done = resumed
            last_t = time.time()
            last_b = done
            with open(part, mode) as f:
                while True:
                    if is_cancelled(job_id):
                        write_status(job_id, status="cancelled", message="用户取消")
                        return
                    chunk = resp.read(262144)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)

                    now = time.time()
                    if now - last_t >= 0.6:
                        speed = (done - last_b) / (now - last_t)
                        pct = (done / total * 100) if total else 0
                        eta = ""
                        if total and speed > 0:
                            eta = str(int((total - done) / speed)) + "s"
                        write_status(
                            job_id,
                            percent=pct,
                            speed=fmt_speed(speed),
                            eta=eta,
                        )
                        last_t, last_b = now, done

        os.replace(part, path)
        write_status(job_id, status="done", percent=100, speed="", eta="", file=path)
    except urllib.error.HTTPError as e:
        write_status(job_id, status="error", message=f"HTTP {e.code} {e.reason}")
    except Exception as e:
        write_status(job_id, status="error", message=str(e)[:400])


def fmt_speed(bps):
    for unit in ("B/s", "KB/s", "MB/s", "GB/s"):
        if bps < 1024:
            return f"{bps:.2f} {unit}" if unit != "B/s" else f"{int(bps)} {unit}"
        bps /= 1024
    return f"{bps:.2f} GB/s"


# ---------------------------------------------------------------- 音视频合并（B 站等双流站点）

def probe_duration(ffprobe, path):
    """用 ffprobe 问时长（秒）。问不出来返回 0，进度条就退化为不定态。"""
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=30,
            creationflags=0x08000000,
        )
        return float(out.stdout.strip() or 0) or 0.0
    except Exception:
        return 0.0


def run_merge(job):
    """ffmpeg -c copy 把视频流 + 音频流合成一个 mp4（不重编码，纯搬字节）。

    成功后删掉两条源流（单文件是这次合并的全部意义）；失败则保留源流，
    错误信息里说明两个文件还在。进度从 ffmpeg 的 -progress 机器输出里解析。
    """
    job_id = job["id"]
    outdir = job.get("outdir") or DEFAULT_OUT
    os.makedirs(outdir, exist_ok=True)

    video, audio = job.get("video") or "", job.get("audio") or ""
    for p in (video, audio):
        if not (os.path.isfile(p) and os.path.getsize(p) > 0):
            write_status(job_id, status="error",
                         message=f"输入文件不存在或为空: {p}")
            return

    ffmpeg = find_tool(["ffmpeg"])
    if not ffmpeg:
        write_status(job_id, status="error",
                     message="找不到 ffmpeg（项目 bin/ 目录缺失？）")
        return
    ffprobe = find_tool(["ffprobe"])
    duration = probe_duration(ffprobe, video) if ffprobe else 0.0

    base = sanitize(job.get("out") or "", "bilibili")
    base = os.path.splitext(base)[0] or "bilibili"
    out = os.path.join(outdir, base + ".mp4")
    root, ext = os.path.splitext(out)
    n = 1
    while os.path.exists(out):
        out = os.path.join(outdir, f"{root} ({n}){ext}")
        n += 1

    write_status(job_id, status="merging", percent=0, message="合并音视频", file=out)

    cmd = [
        ffmpeg, "-y",
        "-i", video, "-i", audio,
        "-c", "copy",
        "-progress", "pipe:1", "-nostdin",
        "-hide_banner", "-loglevel", "error",
        out,
    ]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace",
        creationflags=0x08000000,  # CREATE_NO_WINDOW
    )

    # stderr 必须排空，否则错误输出攒多了会把管道写满、ffmpeg 卡死
    err_tail = []

    def drain_err():
        try:
            for line in proc.stderr:
                line = line.rstrip()
                if line:
                    err_tail.append(line)
                    if len(err_tail) > 30:
                        err_tail.pop(0)
        except Exception:
            pass

    threading.Thread(target=drain_err, daemon=True).start()

    last_pct = -1.0
    try:
        for line in proc.stdout:
            line = line.strip()
            if line.startswith("out_time_us="):
                try:
                    t = float(line.split("=", 1)[1]) / 1e6
                except ValueError:
                    t = 0.0
                if duration > 0:
                    pct = min(100.0, t / duration * 100)
                    if pct - last_pct >= 1.0:
                        last_pct = pct
                        write_status(job_id, status="merging", percent=round(pct, 1))
            elif line.startswith("out_time_ms="):
                # 老版本 ffmpeg 字段名不同（毫秒），同样认
                try:
                    t = float(line.split("=", 1)[1]) / 1e6
                except ValueError:
                    t = 0.0
                if duration > 0:
                    pct = min(100.0, t / duration * 100)
                    if pct - last_pct >= 1.0:
                        last_pct = pct
                        write_status(job_id, status="merging", percent=round(pct, 1))
            elif line.startswith("total_size="):
                try:
                    size = int(line.split("=", 1)[1] or 0)
                    if size > 0:
                        write_status(job_id, message=f"已写出 {fmt_speed(size)}")
                except ValueError:
                    pass
            if is_cancelled(job_id):
                proc.terminate()
                try:
                    os.remove(out)
                except OSError:
                    pass
                write_status(job_id, status="cancelled", message="用户取消合并")
                return
    except Exception as e:
        write_status(job_id, status="error", message=("读取合并输出失败: " + str(e))[:300])
        proc.terminate()
        return

    proc.wait()
    if proc.returncode == 0 and os.path.isfile(out) and os.path.getsize(out) > 0:
        # 合并成功才删源流；失败/取消一律保留，用户还能自己用 ffmpeg 合
        for p in (video, audio):
            try:
                os.remove(p)
            except OSError:
                pass
        write_status(job_id, status="done", percent=100, speed="", eta="",
                     file=out, message="已合并为单文件")
    else:
        msg = " | ".join(err_tail[-8:]) or ("ffmpeg 退出码 %s" % proc.returncode)
        write_status(job_id, status="error",
                     message=("合并失败，视频/音频两个源文件已保留: " + msg)[:600])


MEDIA_EXT = re.compile(
    r"\.(mp4|m4v|webm|mkv|mov|avi|flv|ts|m4a|mp3|aac|ogg|opus|flac|wav|jpg|jpeg|png|gif|webp|pdf)(\?|$)",
    re.I,
)


def _short(s, n=400):
    return (s or "")[:n]


def main():
    job = json.load(open(sys.argv[1], encoding="utf-8"))
    job_id = job["id"]
    os.makedirs(JOBS_DIR, exist_ok=True)
    try:
        # 合并任务没有 url，先于地址校验分发
        if job.get("mode") == "merge":
            run_merge(job)
            return

        # 相对地址（Telegram 的 /a/progressive/document…、blob:、data:）外部进程根本取不到：
        # yt-dlp 会把它当网页去爬，然后报 HTTP 302。这种一律交回页面保存。
        url = (job.get("url") or "").strip()
        if not re.match(r"^https?://", url, re.I):
            write_status(
                job_id, status="error",
                message="这不是外部进程能直接取的地址（可能是页内相对路径/blob），"
                        "请用扩展里的「保存」，由页面自己抓流",
            )
            return

        ytdlp = find_tool(["yt-dlp"])
        ffmpeg = find_tool(["ffmpeg"])
        kind = job.get("kind") or "other"
        low = url.lower()
        # 已经确认是媒体文件直链的（扩展名明确、带 Range 的 progressive 链接），
        # 不要无谓地先丢给 yt-dlp —— 它对非站点 URL 经常返回 302/403，
        # 白白浪费一轮还会给出看不懂的报错。
        looks_like_file = bool(MEDIA_EXT.search(low)) or "/progressive/" in low
        use_ytdlp = (
            ytdlp is not None
            and not looks_like_file
            and (kind in ("video", "audio") or ".m3u8" in low or ".mpd" in low
                 or "format=m3u8" in low)
        )
        if use_ytdlp:
            run_ytdlp(job, ytdlp, ffmpeg)
            # yt-dlp 失败时给一次普通 HTTP 下载的机会：很多「302/403」只是 yt-dlp
            # 的站点识别误判，真正带 cookie/referer 的直连反而能下。
            st = read_status(job_id)
            if st.get("status") == "error":
                ytdlp_msg = st.get("message") or ""
                run_urllib(job)
                st2 = read_status(job_id)
                if st2.get("status") == "error":
                    write_status(
                        job_id, status="error",
                        message=_short("yt-dlp: " + ytdlp_msg + " ／ 直连: " + (st2.get("message") or "")),
                    )
        else:
            run_urllib(job)
    except Exception as e:
        write_status(job_id, status="error", message=("下载进程异常: " + str(e))[:400])


def read_status(job_id):
    try:
        return json.load(open(status_path(job_id), encoding="utf-8"))
    except Exception:
        return {}


if __name__ == "__main__":
    main()
