#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
独立下载进程（由 sniffer_host.py 以 detached 方式启动）

为什么单独一个进程：
  Chrome 的 service worker / 扩展弹窗随时可能被回收，如果下载跑在 native host
  里，一关弹窗就断了。这里让下载彻底独立，宿主死了也照下不误。

四条下载路径（main() 里按 URL 特征分发）：
  · run_merge     音视频分离的两条流 → ffmpeg -c copy 合单文件（B 站）
  · run_ytdlp     m3u8 / mpd / 站点页 → yt-dlp（HLS 分片支持最好）
  · run_hls_self  伪装分片的 m3u8（分片是「图片壳 + TS」）→ 自己并发拉、剥壳、拼 TS
  · run_urllib    已知直链 → 自己发 Range 请求（最简单可控，支持续传）

状态写 %LOCALAPPDATA%\\MediaSniffer\\jobs\\<id>.json，宿主轮询它回传进度。
取消靠同目录下的 <id>.cancel 文件，worker 每轮 stat 一次。

用法（内部）：
    python downloader.py <job.json>
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urljoin

APP_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "MediaSniffer")

# CREATE_NO_WINDOW 只在 Windows 上成立。POSIX 只要传了 creationflags 就抛
# ValueError("creationflags is only supported on Windows platforms")，
# 所以这里预先把参数做成空字典，调用点统一用 **展开。
_NO_WINDOW = {"creationflags": 0x08000000} if os.name == "nt" else {}
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
JOB_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")


def _job_id_or_raise(job_id):
    """job id 会被拼进文件名。宿主侧已经校验过一次，这里再挡一次：
    手工改过的 job 文件、旧版本残留的坏 id 都不该把文件写到 jobs/ 之外。"""
    jid = str(job_id or "")
    if not JOB_ID_RE.match(jid):
        raise ValueError("invalid job id: %r" % (jid[:80],))
    return jid


def status_path(job_id):
    """状态文件路径。<id>.json；对照的取消标记是同目录的 <id>.cancel"""
    return os.path.join(JOBS_DIR, _job_id_or_raise(job_id) + ".json")


def cancel_path(job_id):
    """取消标记路径。宿主写、worker 只读，存在即取消。"""
    return os.path.join(JOBS_DIR, _job_id_or_raise(job_id) + ".cancel")


def _replace_retry(tmp, path, attempts=10, first_delay=0.01):
    """把 tmp 换成 path，撞上「对方正持有句柄」时重试，最后退化为直接覆写。

    为什么不能裸调 os.replace（2026-10-22 真机踩到）：
    宿主 poll_job 每 0.4 秒用 `open()` 读同一个状态文件，Windows 上目标文件
    被别人持有句柄时 MoveFileEx 直接返回 ERROR_ACCESS_DENIED → PermissionError
    [WinError 5]。窗口很短，但一次 40 分钟、上千分片的任务要写几十上百次状态，
    撞上几乎是必然。

    真正致命的地方不是「少一次进度」，而是**这个异常会从 write_status 抛出去**：
    调用方多数在 except 块里写错误原因，于是「为什么会失败」这条最重要的话
    恰好写不进去，进程带着 traceback 退出，状态里留着上一次的 done/100——
    用户看到「完成」，目录里却没有视频。
    """
    last = None
    for i in range(attempts):
        try:
            os.replace(tmp, path)
            return True
        except PermissionError as e:
            last = e
            time.sleep(min(0.08, first_delay * (2 ** i)))
        except OSError as e:  # 跨卷/权限之外的系统错误，重试没意义
            last = e
            break
    # 兜底：放弃原子性，直接覆写。宁可宿主可能读到半个 JSON（它有容错，
    # 坏 JSON 当空 dict），也不能让状态彻底写不进去。
    try:
        with open(tmp, "r", encoding="utf-8") as f:
            buf = f.read()
        with open(path, "w", encoding="utf-8") as f:
            f.write(buf)
        try:
            os.remove(tmp)
        except OSError:
            pass
        return True
    except OSError:
        sys.stderr.write("write_status: 状态写盘失败 %s (%s)\n" % (path, last))
        return False


def write_status(job_id, **fields):
    """**合并式**写状态：读出旧内容、update 新字段、原子替换。

    三个刻意的设计：
      · 合并而不是覆盖 —— 调用方每次只传几个字段（percent/speed/eta），
        覆盖会把 status/file 这些冲掉
      · 写 .tmp 再 os.replace —— 宿主是另一个进程，正在轮询读这个文件，
        直接 open("w") 有窗口期读到空/半个 JSON，宿主会当成「没状态」
      · "updated" 每次刷新 —— 宿主据此判断任务是否还活着
    """
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
    _replace_retry(tmp, path)


def write_progress(job_id, percent, speed="", eta=""):
    """进度刷新统一入口。**必须清空 message。**

    write_status 是合并式的（只更新传入的字段），所以上一步写下的提示会一直留着。
    真机（2026-10-22 51cg1）：自实现 HLS 开头写了「解析播放列表」，随后清单加密
    交回 yt-dlp，yt-dlp 的进度更新只写 percent/speed/eta —— 于是界面上从 0% 到
    87.7% 全程显示「解析播放列表」，用户看到的是「卡在解析」，其实一直在下载。
    """
    write_status(job_id, status="downloading", percent=percent,
                 speed=speed, eta=eta, message="")


def read_status(job_id):
    """读状态文件，读不到/坏 JSON 一律返回空 dict（调用方用 .get 就不会炸）"""
    try:
        return json.load(open(status_path(job_id), encoding="utf-8"))
    except Exception:
        return {}


def sanitize(name, fallback="video"):
    """洗成合法的 Windows 文件名。

    处理四件事：非法字符换 _、去掉首尾的点和空格（Windows 上以点/空格结尾
    的文件名建不出来）、保留设备名（con/prn/aux/nul/com1-9/lpt1-9 会失败）
    换掉、超长按「主干 100 减扩展名长度」截断以保住扩展名。
    """
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
    """三级查找：项目 bin/ → 系统 PATH → 常见包管理器目录。

    与 sniffer_host.find_tool 逻辑一致（宿主和 worker 是不同进程，
    不能共用模块级函数，只能各留一份）。
    """
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
    """取消靠「标记文件存在」传递：跨进程、不用 socket、worker 还没起来时
    写的标记也会在它起来后立刻被看到。"""
    return os.path.exists(cancel_path(job_id))


# ---------------------------------------------------------------- yt-dlp 路径

PROGRESS_TPL = (
    # --progress-template 的机器可读格式：用 | 分隔，行首 MSPROG| 做识别。
    # 不要改成人类可读的那个模板，解析会随 yt-dlp 版本漂。
    "download:MSPROG|%(progress._percent_str)s|%(progress._speed_str)s|"
    "%(progress._eta_str)s|%(progress.downloaded_bytes)s|"
    "%(progress.total_bytes_estimate)s"
)


PLAYLIST_MAX = 256 * 1024


def looks_like_playlist(path):
    """产物是不是 HLS/DASH 播放列表文本。

    yt-dlp 对 m3u8 地址有两种处理：认得出是 HLS 就下载分片并合并成视频；
    认不出（站点改过扩展名、参数怪、或者清单本身加密）就走 generic 分支，
    把**清单本身**当普通文件存下来 —— 退出码 0、尾部没有 ERROR，只看这两样
    必然报成「完成」。2026-10-22 真机 51cg1 就是这样：界面显示完成，落盘是
    38KB 的 .m3u8 文本。

    判据用文件头而不是扩展名：扩展名是 yt-dlp 按响应 content-type 猜的，
    同一份清单可能被存成 .m3u8 / .m3u / .txt。体积先兜一刀 —— 清单只有几 KB，
    超过 256KB 的一律当视频，不去读文件头。
    """
    try:
        if not path or not os.path.isfile(path):
            return False
        if os.path.getsize(path) > PLAYLIST_MAX:
            return False
        with open(path, "rb") as f:
            head = f.read(16)
        # 去 BOM 和空白的写法：有些站返回 UTF-8 BOM 开头的清单
        return head.lstrip(b"\xef\xbb\xbf \t\r\n").startswith(b"#EXTM3U")
    except Exception:
        return False


def cleanup_ytdlp_junk(outdir, base):
    """清掉 yt-dlp 一次失败留下的碎片，返回删除个数。

    为什么会留：yt-dlp 下 HLS 先写 `<base>.mp4.part`，再按分片落
    `<base>.mp4.part-FragN.part` 和 `.ytdl` 断点文件；失败或被中断时这些
    全堆在输出目录里（真机实测一次失败 31 个文件）。用户不知道能不能删，
    而本机 safe-delete 一次删 >50 文件会被拦 → 越积越多，「以后再说」等于
    永远清不掉。

    只认三类，宁少删不多删：
      · `<base>.*.part*` —— 未完成的下载与分片
      · `<base>.*.ytdl`  —— yt-dlp 断点记录
      · 内容确实是播放列表的 `<base>.m3u8` —— 「只下到清单」的残骸，不是视频
    最终成片（.mp4/.ts/.mkv）和名字相近的别的任务一律不碰。
    """
    if not outdir or not os.path.isdir(outdir):
        return 0
    prefix = base + "."
    removed = 0
    try:
        names = os.listdir(outdir)
    except OSError:
        return 0
    for n in names:
        if not n.startswith(prefix):
            continue
        low = n.lower()
        p = os.path.join(outdir, n)
        if ".part" in low or low.endswith(".ytdl"):
            drop = True
        elif low == (base + ".m3u8").lower() and looks_like_playlist(p):
            drop = True
        else:
            drop = False
        if not drop:
            continue
        try:
            os.remove(p)
            removed += 1
        except OSError:
            pass
    return removed


def run_ytdlp(job, ytdlp, ffmpeg):
    """跑 yt-dlp。适合 m3u8 / mpd / 「一个网页里藏着视频」这几类，
    HLS 分片它比我们自己拼强得多（并发、重试、音视频合并都能处理）。

    输出模板 `<base>.%(ext)s` 而不是写死 .mp4：yt-dlp 自己决定最终容器，
    写死会出现「已经 .mp4 又拼一个 .mp4」。真正的落盘名靠 --print
    after_move:FILE: 那一行回读，比猜扩展名可靠。

    cookie 走 --add-header 而不是 --cookies 文件：我们没有 Netscape 格式的
    cookie 文件，只能把整条 Cookie 头递过去。
    """
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
    cmd += ytdlp_header_args(job)
    if ffmpeg:
        cmd += ["--ffmpeg-location", os.path.dirname(ffmpeg)]
        # 不要加 --merge-output-format mp4（2026-10-21 用户 m16052 排查 4kvm 时发现）。
        #
        # 原来这里写死 mp4，本意是「下完统一成 mp4 好播放」。实测一个 971MB 的
        # HLS 流：yt-dlp 把 TS 分片合并成完整的 TS 之后，ffmpeg 重封装 mp4 这一步
        # 报 `Postprocessing: Error opening output files: Permission denied`，
        # **但 yt-dlp 退出码仍是 0**，于是状态被写成 done，用户看到「完成」却
        # 拿到一个不完整的 .mp4。
        #
        # 不强制 mp4 的代价很小：HLS 的 TS 流本身就是完整可播的视频，mpv/PotPlayer/
        # VLC 都能直接放；真需要 mp4 时用户拿 bin/ 里的 ffmpeg 一条命令就能转。
        # 换来的是「要么下成、要么明确报错」，比「报完成但文件坏」好得多。
        #
        # 注：--merge-output-format 的合法值只有 avi/flv/mkv/mov/mp4/webm，
        # 音频不能写 m4a，所以音频也保持原样（不传这个参数）。

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
        **_NO_WINDOW,  # Windows 上不弹窗
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
                    write_progress(job_id, pct, parts[1].strip(), parts[2].strip())
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
    # 退出码 0 不等于成功（2026-10-21 4kvm 实测）：yt-dlp 的分片合并成功、
    # 后续 ffmpeg 重封装失败时，它照样返回 0，只在输出里留一行 ERROR。
    # 只看 returncode 会把坏文件报成「完成」，所以再扫一遍尾部输出。
    post_err = ""
    for ln in tail:
        if "ERROR:" in ln:
            post_err = ln.strip()
            break
    if proc.returncode == 0 and not post_err:
        # 还有第三种「假的成功」：yt-dlp 没认出是 HLS，把 m3u8 清单本身当普通
        # 文件存了下来（退出码 0、无 ERROR）。见 looks_like_playlist 的说明。
        if looks_like_playlist(final_file):
            cleanup_ytdlp_junk(outdir, base)
            write_status(
                job_id,
                status="error",
                message="只下到播放列表（#EXTM3U），不是视频。"
                        "yt-dlp 没把这条地址当成 HLS 流，多半是该站需要 Referer/Cookie，"
                        "或清单本身加密。",
            )
        else:
            write_status(job_id, status="done", percent=100, speed="", eta="", file=final_file)
    else:
        msg = post_err or (" | ".join(tail[-6:]) or ("yt-dlp 退出码 %s" % proc.returncode))
        cleanup_ytdlp_junk(outdir, base)
        write_status(job_id, status="error", message=msg[:600])


def _origin(tab_url):
    """从标签页地址取 scheme://host，给 Origin 头用。
    部分 CDN（B 站、各视频站）会校验它，缺了直接 403。"""
    try:
        from urllib.parse import urlparse
        p = urlparse(tab_url)
        return f"{p.scheme}://{p.netloc}"
    except Exception:
        return ""


def ytdlp_header_args(job):
    """把 Referer / Cookie / Origin / 抓到的请求头 转成 yt-dlp 参数。

    单独拎出来是为了能测：这里的顺序和去重直接决定 CDN 会不会 403。
    同名头只加一次 —— 重复的 Origin 会让一部分 CDN 直接拒绝。
    """
    args = []
    seen = set()

    def add(key, value):
        args.extend(["--add-header", "%s:%s" % (key, value)])
        seen.add(key.lower())

    if job.get("referer"):
        args += ["--referer", job["referer"]]
        seen.add("referer")
    if job.get("cookie"):
        add("Cookie", job["cookie"])

    # 抓取时实际发出的头（宿主侧已按白名单过滤）。先于下面「从 tabUrl 推导
    # Origin」加入，这样真实 Origin 优先于推导值。
    for hk, hv in (job.get("headers") or {}).items():
        key = str(hk).lower()
        if key in seen:
            continue
        add(key.title(), hv)

    if "origin" not in seen and job.get("tabUrl"):
        origin = _origin(job["tabUrl"])
        if origin:
            add("Origin", origin)
    return args


# ---------------------------------------------------------------- 普通文件路径

def run_urllib(job):
    """自己发 HTTP 下直链。相比 yt-dlp 的好处：完全可控、支持断点续传、
    没有「把 URL 当网页爬」的误判。

    续传协议：数据先写 <名字>.part，写完了才 os.replace 到正式名。
      · 重跑时看到 .part 就带 `Range: bytes=<已有长度>-` 继续
      · 服务器回 206 才追加；回 200 说明对方不支持 Range（可能整个重发），
        必须 wb 重写，否则拼接出来是坏的
      · 正式文件永远只有「完整」这一种状态，用户不会看到半截图
    """
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
    # 抓取时看到的头：补上 Origin / Accept / Accept-Language / UA。
    # 已有同名头时不覆盖（referer/cookie/ua 上面的取值更可信）。
    for hk, hv in (job.get("headers") or {}).items():
        name_k = str(hk).title()
        if name_k in headers:
            continue
        headers[name_k] = hv

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


# ---------------------------------------------------------------- HLS 自下载（伪装分片）

TS_PACKET = 188      # MPEG-TS 固定包长
MASQ_SCAN = 4096     # 壳最多在这段前缀里找 TS 同步
MASQ_SYNC = 5        # 连续几个包对得上才算认出
SEG_ATTEMPTS = 3     # 单个分片在 _hls_get 之外还允许几轮重试（见 _fetch_segment）
SEG_BACKOFF = 1.0    # 秒；指数退避 1s → 2s，合计横跨约 3 秒的抖动窗口


def looks_like_hls_url(url):
    """只看 pathname 是不是 .m3u8（不看 query）。

    和扩展侧 isHlsUrl 同一个判据，理由也同一个：`?url=xxx.m3u8` 那种跳转
    链接抓到的是跳转前地址，判成 HLS 会误导。
    """
    try:
        from urllib.parse import urlparse
        return urlparse(url or "").path.lower().endswith(".m3u8")
    except Exception:
        return False


def strip_masquerade(data, scan=MASQ_SCAN, sync=MASQ_SYNC):
    """剥掉「图片壳 + MPEG-TS」这种伪装分片的前导壳。

    真机证据（2026-10-22，4kvm.net）：分片 URL 返回 `image/png`，前 112 字节
    是一个 64×64 的 PNG（IHDR/pHYs/IDAT/IEND 齐全，IEND 正好结束在 112），
    从 offset 112 起就是标准 TS —— 0x47 起始、188 周期取样 50/50 命中。
    浏览器里 hls.js 用自定义 loader 剥壳后喂 MSE，所以「能播」；而 yt-dlp /
    ffmpeg 不剥壳，拼出来就是坏文件或直接失败。

    判据只认「TS 包周期」这一件事，不认壳的长度和格式：在头 scan 字节里找
    第一个位置，使 offset + k*188 连续 sync 个都是 0x47。这样换成 JPEG/WEBP
    壳、壳长变了都照样能剥；真图片里零星的 0x47 也不会被误判（要求连续命中）。
    """
    if not data or data[0:1] == b"\x47":
        return data
    limit = min(len(data), scan)
    # 分片特别短时按实际长度放宽要求，但至少 2 个包；连 2 个包都放不下就不动
    need = max(2, min(sync, len(data) // TS_PACKET))
    for off in range(limit):
        if data[off] != 0x47:
            continue
        ok = True
        for k in range(1, need):
            j = off + k * TS_PACKET
            if j >= len(data) or data[j] != 0x47:
                ok = False
                break
        if ok:
            return data[off:]
    return data


def parse_hls_playlist(text, base_url):
    """解析 m3u8，返回：

        kind       "master"（多码率）还是 "media"（分片清单）
        child      master 里 BANDWIDTH 最大的子清单地址
        segments   media 的分片地址（已按 base_url 补成绝对地址）
        init       EXT-X-MAP 的初始化段（fMP4 才需要）
        encrypted  是否有 EXT-X-KEY（METHOD 不是 NONE）
        key_url    密钥地址
        byterange  是否用了 EXT-X-BYTERANGE（自实现不支持，交回 yt-dlp）

    地址补全必须用 urljoin：站方给相对路径（`seg-1.ts`）和站内绝对路径
    （`/abs/seg-2.ts`）都很常见，直接拼字符串会拼出 `.../a/b//abs/...` 这种。
    """
    info = {
        "kind": "media", "child": "", "segments": [], "init": "",
        "encrypted": False, "key_url": "", "byterange": False,
    }
    best_bw = -1
    pending_bw = None
    for raw in (text or "").splitlines():
        ln = raw.strip()
        if not ln:
            continue
        if ln.startswith("#"):
            if ln.startswith("#EXT-X-STREAM-INF"):
                info["kind"] = "master"
                m = re.search(r"BANDWIDTH=(\d+)", ln)
                pending_bw = int(m.group(1)) if m else 0
            elif ln.startswith("#EXT-X-KEY"):
                m = re.search(r"METHOD=([^,\s]+)", ln)
                method = (m.group(1) if m else "").upper()
                if method and method != "NONE":
                    info["encrypted"] = True
                    km = re.search(r'URI="([^"]+)"', ln)
                    if km:
                        info["key_url"] = urljoin(base_url, km.group(1))
            elif ln.startswith("#EXT-X-MAP"):
                km = re.search(r'URI="([^"]+)"', ln)
                if km:
                    info["init"] = urljoin(base_url, km.group(1))
            elif ln.startswith("#EXT-X-BYTERANGE"):
                info["byterange"] = True
            continue
        url = urljoin(base_url, ln)
        if pending_bw is not None:
            if pending_bw > best_bw:
                best_bw = pending_bw
                info["child"] = url
            pending_bw = None
        else:
            info["segments"].append(url)
    return info


def _hls_get(url, headers, timeout=45, retries=2):
    """取一段字节。分片几百上千个，偶发 5xx/超时很常见，小重试比整单失败划算。"""
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            # 4xx 重试没用（地址过期/防盗链就是这个），直接抛
            if 400 <= e.code < 500:
                raise
            last = e
        except Exception as e:
            last = e
        if attempt < retries:
            time.sleep(0.6 * (attempt + 1))
    raise last


def _fetch_segment(url, headers, attempts=None, backoff=None):
    """取一个分片并剥壳，带「外层」退避重试。全失败返回 `(None, 最后一次错误)`。

    为什么 `_hls_get` 之外还要一层（2026-10-22 真机，用户自己的下载）：
    `_hls_get` 的 2 次重试是**紧接着**的（间隔 0.6s / 1.2s），对「服务端连续几秒
    抽风」不够。实测 4kvm 178 片下到第 31 片被掐连接：

        IncompleteRead(528064 bytes read, 1614008 expected)

    3 次尝试全撞在抽风窗口里 → 异常一路抛到主循环 → 整单判失败、`.part` 删掉，
    **前 30 片全白下**；用户手动重试一次（同地址同网络）立刻成功。瞬时抖动
    不该等于整单失败，所以这里再加 3 轮、退避 1s→2s，横跨约 3 秒的抖动窗口。

    4xx（地址过期 / 防盗链）不重试：`_hls_get` 已经直接抛，这里也不浪费预算，
    立刻把错误交回上层——那种错重试一百次还是同样的结果。
    """
    attempts = SEG_ATTEMPTS if attempts is None else max(1, int(attempts))
    backoff = SEG_BACKOFF if backoff is None else float(backoff)
    last = None
    for i in range(attempts):
        try:
            return strip_masquerade(_hls_get(url, headers)), None
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500:
                return None, e
            last = e
        except Exception as e:
            last = e
        if i < attempts - 1:
            time.sleep(backoff * (2 ** i))
    return None, last


def _header_variants(headers):
    """分片请求的候选头组合，按「先原样、再逐项降级」排序，最多 4 档。

    真机（2026-10-22，4kvm / xhscdn）：同一片带 Referer 请求是 **403**，把
    Referer 去掉才 200 —— 和大多数站相反（一般缺 Referer 才拒），因为浏览器侧
    是 hls.js 用 `referrerPolicy: no-referrer` 发的包。所以不能写死带或不带，
    只能按顺序探一档：

        原样 → 去 Referer → 去 Referer+Origin → 只留 UA/Cookie

    顺序即优先级：越靠前越接近抓取时的真实请求，越不容易被当成爬虫。
    """
    def drop(keys):
        keys = {k.lower() for k in keys}
        return {k: v for k, v in headers.items() if k.lower() not in keys}

    out = [dict(headers)]
    no_ref = drop(["referer"])
    if no_ref != out[-1]:
        out.append(no_ref)
    bare = drop(["referer", "origin"])
    if bare != out[-1]:
        out.append(bare)
    ua_only = {k: v for k, v in headers.items() if k.lower() in ("user-agent", "cookie")}
    if ua_only != out[-1]:
        out.append(ua_only)
    return out


def run_hls_self(job, quiet=False):
    """自己下 HLS：并发拉分片 → 剥伪装壳 → 按序拼成 TS → 尽力转封装。

    为什么不用 yt-dlp：它按 HLS 规范把分片当字节流拼接，不认「图片壳」；
    这个站点的 514 个分片全部是「112 字节 PNG + TS」，yt-dlp 必然失败
    （实测 `unable to download video data: HTTP Error 404`）。

    返回 True 表示已经接管并写了最终状态；False 表示这单不适合自实现
    （AES 加密 / BYTERANGE / 没有分片），调用方可以继续 fallback。
    quiet=True 时「不适合接管」不写状态，免得把 yt-dlp 的原始报错冲掉。
    """
    job_id = job["id"]
    outdir = job.get("outdir") or DEFAULT_OUT
    os.makedirs(outdir, exist_ok=True)

    headers = {"User-Agent": job.get("ua") or UA}
    if job.get("referer"):
        headers["Referer"] = job["referer"]
    if job.get("cookie"):
        headers["Cookie"] = job["cookie"]
    for hk, hv in (job.get("headers") or {}).items():
        name_k = str(hk).title()
        if name_k not in headers:
            headers[name_k] = hv

    def bail(msg, take_over=True):
        if take_over or not quiet:
            write_status(job_id, status="error", message=_short(msg, 300))
        return take_over

    write_status(job_id, status="downloading", percent=0, speed="", eta="",
                 file="", message="解析播放列表")

    try:
        text = _hls_get(job["url"], headers).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return bail("拉取播放列表失败：HTTP %d %s（该站地址有时效，请刷新页面后重试）"
                    % (e.code, e.reason))
    except Exception as e:
        return bail("拉取播放列表失败：%s" % e)

    base = job["url"]
    info = parse_hls_playlist(text, base)
    if info["kind"] == "master":
        if not info["child"]:
            return bail("多码率清单里没找到子清单")
        base = info["child"]
        try:
            text = _hls_get(base, headers).decode("utf-8", "replace")
        except Exception as e:
            return bail("拉取子清单失败：%s" % e)
        info = parse_hls_playlist(text, base)

    if info["encrypted"] or info["byterange"]:
        # 这两种 yt-dlp 处理得比我们好（它能拉密钥、能按 BYTERANGE 取片），
        # 不该抢过来 —— 抢过来只会把「能下」变成「不能下」。
        return bail("AES 加密 / BYTERANGE 清单，交回 yt-dlp 处理", take_over=False)
    if not info["segments"]:
        return bail("清单里没有分片（可能是空清单或地址已失效）")

    name = sanitize(job.get("filename") or "", "video")
    root, _ext = os.path.splitext(name)
    root = root or "video"
    ts_path = os.path.join(outdir, root + ".ts")
    n = 1
    while os.path.exists(ts_path):
        ts_path = os.path.join(outdir, "%s (%d).ts" % (root, n))
        n += 1
    part = ts_path + ".part"

    segs = info["segments"]
    total = len(segs)
    workers = max(1, min(16, int(job.get("concurrency") or 8)))
    done_bytes = 0
    done_segs = 0
    t0 = time.time()

    # 第一片当探针：既确认分片真能取（地址没过期），也把头组合定下来。
    #
    # 为什么必须探：真机（4kvm / xhscdn）**带 Referer 403、不带才 200**，和大多数
    # 站的防盗链方向相反（一般缺 Referer 才拒）；浏览器侧是 hls.js 用
    # referrerPolicy:no-referrer 发的包。写死任何一个方向都会让另一半站点失效，
    # 所以按 _header_variants 的顺序一档档试，试通哪档整单沿用。
    first_data = None
    first_err = None
    for hv in _header_variants(headers):
        try:
            first_data = strip_masquerade(_hls_get(segs[0], hv))
            headers = hv
            first_err = None
            break
        except Exception as e:
            first_err = e
    if first_data is None:
        return bail("下载分片失败（0/%d 已下）：%s。该站地址有时效，刷新页面后重试"
                    % (total, first_err))

    # 滑动窗口：线程池负责下载，主线程严格按 index 顺序取结果写盘。
    # 不把整片下载到内存再拼（514×2.7MB ≈ 1.4GB），也不落成几百个临时文件
    # （本机 safe-delete 一次删 >50 个文件会被拦，下载会卡在清理阶段）。
    from concurrent.futures import ThreadPoolExecutor

    sem = threading.Semaphore(workers * 2)

    def fetch(i):
        """返回 `(data, err)`，**不抛异常**——异常在 worker 里抛会丢掉「第几片」
        这层上下文，主线程只能看到一个光秃秃的 IncompleteRead。
        """
        try:
            if i == 0:
                return first_data, None   # 探针已经下过了，别重复请求
            return _fetch_segment(segs[i], headers)
        finally:
            sem.release()

    cancelled = False
    try:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            pending = {}
            nxt = 0
            submitted = 0
            with open(part, "wb") as f:
                if info["init"]:
                    f.write(strip_masquerade(_hls_get(info["init"], headers)))
                while nxt < total:
                    while submitted < total and submitted - nxt < workers * 2:
                        sem.acquire()
                        pending[submitted] = ex.submit(fetch, submitted)
                        submitted += 1
                    data, seg_err = pending.pop(nxt).result()
                    if data is None:
                        # 这片重试到底也没取到，交给外层统一写提示。
                        # 不再在这里把异常往上抛原始类型：外层要能说出「第几片、
                        # 重试了几次」，光一个 IncompleteRead 用户没法判断严重程度。
                        raise _SegmentFailed(nxt, seg_err)
                    f.write(data)
                    done_bytes += len(data)
                    done_segs += 1
                    nxt += 1

                    if done_segs % 5 == 0 or nxt == total:
                        elapsed = max(0.001, time.time() - t0)
                        speed = done_bytes / elapsed
                        pct = done_segs / total * 100
                        eta = ""
                        if done_segs:
                            per = elapsed / done_segs
                            eta = "%ds" % int(per * (total - done_segs))
                        # message 要清空：上面写的是「解析播放列表」，不清会一直
                        # 挂在进度条上，看起来像卡在第一步（真机 v1.3.30 首测）。
                        write_status(job_id, percent=round(pct, 1),
                                     speed=fmt_speed(speed), eta=eta, message="")
                    if is_cancelled(job_id):
                        cancelled = True
                        raise _Cancelled()
        os.replace(part, ts_path)
    except _Cancelled:
        try:
            os.remove(part)
        except OSError:
            pass
        write_status(job_id, status="cancelled", percent=0, message="用户取消")
        return True
    except _SegmentFailed as e:
        try:
            os.remove(part)
        except OSError:
            pass
        return bail("下载分片失败（%d/%d 已下）：第 %d 片重试 %d 轮仍失败：%s"
                    "。网络抖一下不会这样，多半是这一片在服务端有问题，"
                    "刷新页面换个地址重试" % (done_segs, total, e.idx + 1, SEG_ATTEMPTS, e.err))
    except Exception as e:
        try:
            os.remove(part)
        except OSError:
            pass
        return bail("下载分片失败（%d/%d 已下）：%s" % (done_segs, total, e))

    if os.path.getsize(ts_path) <= 0:
        return bail("拼出来的文件是空的")

    # 转封装成 mp4：-c copy 不重编码，几秒到几十秒。失败不算失败 ——
    # TS 本身就是完整可播的视频（mpv/VLC/PotPlayer 都能放），删掉才是真的白干。
    # 失败原因要写进 message：只说「没转成 mp4」用户没法判断是文件坏了还是
    # 只是格式没转（真机 v1.3.30 首测就是这种情况，得再捞一次 ffmpeg 的报错）。
    remux_err = ""
    if job.get("remux", True):
        ffmpeg = find_tool(["ffmpeg"])
        if ffmpeg:
            out_mp4 = ts_path[:-3] + ".mp4"
            # 输出先写系统临时目录再搬回来。
            #
            # 本机实测（2026-10-22，三次）：ffmpeg 直接往下载目录写 mp4 一律报
            # `Error opening output files: Permission denied`，同一目录下 python
            # 自己写 1.3GB 的 .ts 完全正常；换成 .part 后缀也一样被拒 —— 说明不是
            # 扩展名黑白名单，而是 ffmpeg 这个进程本身写不了那个目录（安全软件限制
            # 未签名 exe 的写入比较常见）。临时目录通常不在限制范围内，试过再谈。
            tmp_mp4 = os.path.join(tempfile.gettempdir(), "ms-remux-%s.mp4" % job_id)
            write_status(job_id, status="merging", percent=100, message="转封装 mp4")
            try:
                r = subprocess.run(
                    [ffmpeg, "-y", "-i", ts_path, "-c", "copy", "-f", "mp4",
                     "-nostdin", "-hide_banner",
                     "-loglevel", "error", tmp_mp4],
                    capture_output=True, text=True, encoding="utf-8",
                    errors="replace", timeout=1800, **_NO_WINDOW,
                )
                ok = r.returncode == 0 and os.path.isfile(tmp_mp4) and os.path.getsize(tmp_mp4) > 0
                if not ok:
                    tail = [ln for ln in (r.stderr or "").splitlines() if ln.strip()]
                    remux_err = (tail[-1] if tail else "ffmpeg 退出码 %s" % r.returncode)[:180]
            except Exception as e:
                ok = False
                remux_err = str(e)[:180]
            if ok:
                try:
                    shutil.move(tmp_mp4, out_mp4)
                except Exception as e:
                    remux_err = "搬到下载目录失败：%s" % e
                    ok = False
            if not ok:
                try:
                    os.remove(tmp_mp4)
                except OSError:
                    pass
            if ok:
                try:
                    os.remove(ts_path)
                except OSError:
                    pass
                write_status(job_id, status="done", percent=100, speed="", eta="",
                             file=out_mp4, message="已拼成完整视频")
                return True

    msg = "已拼成完整视频（TS 容器，播放器能直接放）"
    if remux_err:
        msg += "；转 mp4 失败：" + remux_err
    write_status(job_id, status="done", percent=100, speed="", eta="",
                 file=ts_path, message=msg)
    return True


class _Cancelled(Exception):
    """内部用的取消信号：跳出滑动窗口循环，由外层统一收尾。"""


class _SegmentFailed(Exception):
    """某个分片重试到底仍失败。带上是第几片（0 起算）和最后那个错误。

    单独一个类型是为了让外层能把「已知的坏片」和「别的意外」分开写提示：
    前者要告诉用户是第几片、重试了几次；后者直接把异常字符串贴出来。
    """

    def __init__(self, idx, err):
        self.idx = idx
        self.err = err
        super().__init__("第 %d 片: %s" % (idx + 1, err))


def fmt_speed(bps):
    """字节/秒 → 「1.5 MB/s」。B/s 不显示小数（「1 B/s」比「1.00 B/s」自然）"""
    for unit in ("B/s", "KB/s", "MB/s", "GB/s"):
        if bps < 1024:
            return f"{bps:.2f} {unit}" if unit != "B/s" else f"{int(bps)} {unit}"
        bps /= 1024
    return f"{bps:.2f} GB/s"


# ---------------------------------------------------------------- 音视频合并（B 站等双流站点）

def probe_duration(ffprobe, path):
    """用 ffprobe 问时长（秒）。问不出来返回 0，进度条就退化为不定态。

    必须在合并**之前**问：合并过程中源流文件还完整，合并完就被删了，
    那时候再想问也问不到。时长只用来把 out_time 换算成百分比。
    """
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=30,
            **_NO_WINDOW,
        )
        return float(out.stdout.strip() or 0) or 0.0
    except Exception:
        return 0.0


def run_merge(job):
    """ffmpeg -c copy 把视频流 + 音频流合成一个 mp4（不重编码，纯搬字节）。

    成功后删掉两条源流（单文件是这次合并的全部意义）；失败则保留源流，
    错误信息里说明两个文件还在。进度从 ffmpeg 的 -progress 机器输出里解析。

    两个容易踩的地方：
      · stderr 必须开线程排空（见下面 drain_err 的注释），否则死锁
      · out_time_us 在旧版 ffmpeg 里叫 out_time_ms，且**值同样是微秒**
        （这是 ffmpeg 的历史 bug，字段名写 ms 实际是 us），所以两处都 /1e6
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
        **_NO_WINDOW,  # Windows 上不弹窗
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
    """错误信息截断。ffmpeg/yt-dlp 的报错经常几百行，全塞进状态文件
    会让 popup 的高度撑爆。"""
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
            # m3u8 先走自实现，而不是先 yt-dlp。
            #
            # 理由是「壳只有下第一片才知道」：伪装分片站（4kvm，2026-10-22）的
            # 清单长得完全正常，yt-dlp 会一路重试到超时（514 个分片 × --retries 10
            # × --fragment-retries 10，实测几分钟还停在 percent 0），用户只能干等。
            # 自实现剥壳对普通 HLS 是原样透传（strip_masquerade 认不出壳就返回原
            # 字节），所以先自己试没有副作用；搞不定（AES 加密 / BYTERANGE / 拉不
            # 到清单）再由 yt-dlp 接手。
            hls_msg = ""
            if looks_like_hls_url(url):
                if run_hls_self(job, quiet=True):
                    st_h = read_status(job_id)
                    if st_h.get("status") == "done":
                        return
                    hls_msg = st_h.get("message") or ""

            run_ytdlp(job, ytdlp, ffmpeg)
            # yt-dlp 失败时给一次普通 HTTP 下载的机会：很多「302/403」只是 yt-dlp
            # 的站点识别误判，真正带 cookie/referer 的直连反而能下。
            st = read_status(job_id)
            if st.get("status") == "error":
                ytdlp_msg = st.get("message") or ""
                run_urllib(job)
                st2 = read_status(job_id)
                if st2.get("status") == "error":
                    parts = []
                    if hls_msg:
                        parts.append("自实现 HLS: " + hls_msg)
                    parts.append("yt-dlp: " + ytdlp_msg)
                    parts.append("直连: " + (st2.get("message") or ""))
                    write_status(job_id, status="error", message=_short(" ／ ".join(parts)))
        else:
            run_urllib(job)
    except Exception as e:
        write_status(job_id, status="error", message=("下载进程异常: " + str(e))[:400])

if __name__ == "__main__":
    main()
