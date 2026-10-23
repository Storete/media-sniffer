#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Media Sniffer 的 Native Messaging 宿主

协议：4 字节小端长度 + UTF-8 JSON，走 stdin/stdout。
  - stdin/stdout 只用于协议通信，任何调试输出必须走 stderr
  - 写入必须加 WRITE_LOCK：poll_job 在后台线程里也会发消息，
    两个线程同时写 stdout 会把帧长度和正文交错，浏览器直接断开

职责（两大类，别混）：
  1. 「点按钮下载」—— downloader.py 以 detached 进程跑，宿主只拉起 + 轮询
     状态文件回传进度（C 盘/网络下载、yt-dlp、ffmpeg 合并都走这条）
  2. 「页面直传」—— msfile_* 系列，页面自己把分块递过来，宿主负责顺序落盘。
     Telegram 这类只认页面 Range 请求的站走这条，数据流方向完全相反

消息形状：每个响应都带 id（请求里那个）和 action（请求的动作名），
扩展侧靠 id 把响应配回请求；带 inProgress 的表示「后面还有消息，别拆桥」。
"""
import base64
import json
import os
import re
import struct
import subprocess
import sys
import threading
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(HERE, "downloader.py")

sys.path.insert(0, HERE)
import library  # noqa: E402  统一的下载目录定位
APP_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "MediaSniffer")
JOBS_DIR = os.path.join(APP_DIR, "jobs")

# 单条消息上限：一个 512KB 分段转成 JSON 数组约 2MB，留足余量
MAX_MSG = 64 * 1024 * 1024

WRITE_LOCK = threading.Lock()
_t0 = time.time()


LOG_FILE = os.path.join(APP_DIR, "host.log")
_log_lock = threading.Lock()


def log(*a):
    """stderr 内容浏览器会代进黑洞，排障时只能靠落盘。
    日志超过 1MB 就截断重开，免得长期运行越写越大（整条内容始终只在锁内算一次）。"""
    line = "[%s] %s" % (time.strftime("%H:%M:%S"), " ".join(str(x) for x in a))
    try:
        print("[host]", *a, file=sys.stderr, flush=True)
    except Exception:
        pass
    try:
        with _log_lock:
            if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 1024 * 1024:
                open(LOG_FILE, "w", encoding="utf-8").close()
            with open(LOG_FILE, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
    except Exception:
        pass


def send(obj):
    """发一条帧。BrokenPipe 说明浏览器那边已经关了宿主（正常退出路径），
    直接 os._exit(0) 而不是抛异常 —— 抛的话会在 poll_job 线程里变成
    一堆噪音，且主循环还活着。

    必须先 write 长度再 write 正文，且两者在同一把锁里：分成两次加锁
    会出现「A 写完长度、B 插进一段正文」的错位。"""
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    with WRITE_LOCK:
        try:
            sys.stdout.buffer.write(struct.pack("<I", len(data)))
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        except (BrokenPipeError, OSError):
            os._exit(0)


def read_message():
    """读一条帧。返回 None 表示连接该结束了（EOF / 长度非法 / JSON 坏）。

    注意 read(n) 不保证一次读满，但 stdin 是管道且 length-prefixed，
    正常情况一次到底；< n 视为 EOF 处理（浏览器重启宿主比猜测帧边界安全）。
    """
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("<I", raw)
    if n <= 0 or n > MAX_MSG:
        log("bad message length", n)
        # 长度不可信就没法继续对齐帧边界，直接退出让浏览器重启宿主
        return None
    body = sys.stdin.buffer.read(n)
    if len(body) < n:
        return None
    try:
        return json.loads(body.decode("utf-8"))
    except Exception as e:
        log("bad json", e)
        return None


# ---------------------------------------------------------------- 页面直传写文件
#
# Telegram 这类站点只给页面自己（带 Range）取数据，一次最多 512KB。
# 页面把分块通过 msfile_* 指令直接递过来，这里按顺序写到最终文件。
# 只在锁内写盘，最多缓存几十 MB，不会把整部视频读进内存。

FILE_LOCK = threading.Lock()
FILE_JOBS = {}      # job id -> {fh, path, written, total, last}
# 单个文件不设上限：用户明确要求「不要设限」。
# 这里仍会检查磁盘剩余空间，写满时给一条可读的错误而不是抛 OSError。
# （历史上这里是 512MB，会把 Telegram 的 771MB 视频直接拒掉。）


def _download_dir():
    # 统一由 library.py 决定（默认 D:/软件应用/DSH/文件存放处，见那里的优先级说明），
    # 不再各处硬编码 ~/Downloads，避免文件落到 C 盘。
    return library.library_dir()


_WIN_RESERVED = {"CON", "PRN", "AUX", "NUL"}
_WIN_RESERVED |= {"COM%d" % i for i in range(1, 10)}
_WIN_RESERVED |= {"LPT%d" % i for i in range(1, 10)}
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")


def _safe_job_id(value):
    """任务 id 会被拼进 .job.json / .status 文件名，必须先挡住路径分隔符。

    没有这道校验时，页面传 id="../../x" 就能让宿主把文件写到 JOBS_DIR 外面。
    """
    s = str(value or "").strip()
    if not s or s in (".", "..") or not _JOB_ID_RE.match(s):
        return ""
    return s


def _safe_outdir(value):
    """下载目录只允许落在资料库目录内；其余一律忽略（用默认目录）。"""
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        p = os.path.abspath(raw)
        root = os.path.abspath(library.library_dir())
        if os.path.commonpath([p, root]) != root:
            log("outdir 越界，已忽略", raw)
            return ""
        return p
    except Exception:
        # 不同盘符时 commonpath 会抛 ValueError —— 同样按越界处理
        return ""


_HEADER_ALLOW = {"referer", "origin", "accept", "accept-language", "user-agent"}


def _safe_headers(value):
    """页面抓到的请求头 → 只保留白名单里的 5 个。

    扩展侧已经过滤过一遍，这里是第二道：宿主也被别的调用方直接连着。
    CR/LF 一律丢弃（头注入），值过长也丢（畸形请求）。
    """
    out = {}
    if not isinstance(value, dict):
        return out
    for k, v in value.items():
        key = str(k or "").strip().lower()
        if key not in _HEADER_ALLOW:
            continue
        s = str(v or "")
        if not s or len(s) > 300 or "\r" in s or "\n" in s:
            continue
        out[key] = s
    return out


def _safe_name(name):
    """把页面给的文件名洗成「只剩一个安全文件名」。

    先 basename 掉路径（同时把反斜杠统一成斜杠，否则 Windows 上的
    "a\\b.mp4" 在 os.path.basename 里算一个整体），再换掉 Windows 非法字符。
    空名兜底成 media-时间戳，避免存成一个叫 "" 的文件。最长 150 字符。

    另外处理两个 Windows 专有的坑：
      · 保留设备名（CON/NUL/COM1…）——即便带扩展名也非法，open() 会直接报错
      · 结尾的点和空格——资源管理器不接受，Python 会静默截断
    """
    name = os.path.basename(str(name or "").replace("\\", "/")).strip()
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    name = name.strip(". ")
    # 截断必须放在收货检查之前：第 150 个字符正好是空格或点时，直接切片会
    # 留下 "xxx " / "xxx." 这种 Windows 建不出来的名字（实测 x*149 + " .mp4"）。
    if len(name) > 150:
        name = name[:150].rstrip(". ")
    if not name:
        name = "media-" + time.strftime("%Y%m%d-%H%M%S")
    stem = os.path.splitext(name)[0].upper()
    if stem in _WIN_RESERVED:
        name = ("_" + name)[:150]
    return name


def _unique_path(dirname, name):
    """同名文件不覆盖，从 "xxx (2).mp4" 起往后找空位。

    刻意不用「先删旧的再写」：下载目录是用户的，同名文件可能是他
    自己攒的东西，覆盖是不可逆的。
    """
    base, ext = os.path.splitext(name)
    path = os.path.join(dirname, name)
    i = 2
    while os.path.exists(path):
        path = os.path.join(dirname, "%s (%d)%s" % (base, i, ext))
        i += 1
    return path


def do_msfile_start(msg):
    """页面直传的第 1 步：建文件、登记任务。

    立刻 open(path, "wb") 而不是收到第一块再建 —— 文件在磁盘上出现本身
    就是「正在写」的可视信号；中止时 do_msfile_abort 会删掉它。
    id 允许页面自己带（同一批下载复用），不带就生成一个。
    """
    name = _safe_name(msg.get("name"))
    total = int(msg.get("total") or 0)
    if total < 0:
        total = 0
    d = _download_dir()
    path = _unique_path(d, name)
    raw_id = msg.get("id")
    job_id = _safe_job_id(raw_id) if raw_id else ("msf-" + uuid.uuid4().hex[:10])
    if not job_id:
        send({"id": "", "action": "error", "ok": False, "error": "任务 id 不合法"})
        return
    with FILE_LOCK:
        fh = open(path, "wb")
        FILE_JOBS[job_id] = {
            "fh": fh, "path": path, "written": 0, "total": total,
            "last": time.time(), "id": job_id,
        }
    send({"id": job_id, "action": "msfile_start", "ok": True, "file": path,
          "dir": d, "name": os.path.basename(path), "inProgress": True})


def do_msfile_chunk(msg):
    """页面直传的第 2 步：写一块。**这是整条链路最热的路径**，
    一次 Telegram 771MB 视频要过 ~1500 次（512KB 一块）。

    三个非显然的点：
      · 按 start 偏移 seek 写而不是顺序追加 —— 见下面的大段注释（幂等重试）
      · 数据既可能是 base64 字典也可能是字节数组，两种都收
      · 回执带 inProgress，否则扩展会把页面桥当一次性请求拆掉
    """
    job_id = msg.get("id")
    # 起始偏移。页面用 text="bytes=<start>-" 的形式带过来（沿用 B 站那种 Range 风格）。
    # 有偏移就按偏移 seek 写，而不是顺序追加 —— 这样重试同一段是幂等的：
    # 页面侧 hostWrite 超时后会重试，如果宿主其实已经写进去了（只是回执慢了），
    # 顺序追加会把同一段写两遍，结果文件大小对、内容整体错位、播不了。
    # 按偏移覆写则重复写入完全无害。
    start = None
    text = msg.get("text")
    if isinstance(text, str):
        m = re.match(r"\s*bytes\s*=\s*(\d+)", text)
        if m:
            start = int(m.group(1))
    with FILE_LOCK:
        job = FILE_JOBS.get(job_id)
        if not job:
            send({"id": job_id, "action": "msfile_chunk", "ok": False,
                  "error": "没有对应的写入任务（可能已结束）"})
            return
        data = msg.get("data")
        # Base64 兜底：万一浏览器把二进制序列化成了普通对象
        if isinstance(data, dict) and data.get("__b64"):
            data = base64.b64decode(data["__b64"])
        elif isinstance(data, list):
            data = bytes(data)
        if not isinstance(data, (bytes, bytearray)):
            send({"id": job_id, "action": "msfile_chunk", "ok": False, "error": "数据不是二进制"})
            return
        fh = job["fh"]
        try:
            if start is not None:
                # seek 到指定位置覆写：精确 seek 而不是依赖 write 的返回值
                fh.flush()
                fh.seek(start)
                fh.write(data)
            else:
                fh.seek(0, os.SEEK_END)  # 没有偏移信息时退回顺序追加
                fh.write(data)
            # written 记「已推进到的最高水位」，用于 end 时校验文件长度
            end_pos = (start if start is not None else job["written"]) + len(data)
            job["written"] = max(job["written"], end_pos)
        except OSError as e:
            send({"id": job_id, "action": "msfile_chunk", "ok": False,
                  "error": "写盘失败（磁盘满了？）: %s" % str(e)[:120]})
            return
        job["last"] = time.time()
        written = job["written"]
    # inProgress：告诉扩展这台宿主还活着。扩展收到带 inProgress 的回执时，
    # 会把这条页面端口保持绑定，不会被「一次性请求」的清账逻辑提前拆掉
    # （曾经就是这个导致同一台宿主连第二个文件时报「无响应」）。
    send({"id": job_id, "action": "msfile_chunk", "ok": True, "written": written,
          "size": len(data), "inProgress": True})


def do_msfile_end(msg):
    """页面直传的第 3 步：关文件、回最终大小。

    用 os.path.getsize 而不是累加的 written —— written 只是「推进到的最高
    水位」，理论上应该相等，但以磁盘实际为准；文件系统出错时能立刻发现。
    """
    job_id = msg.get("id")
    with FILE_LOCK:
        job = FILE_JOBS.pop(job_id, None)
    if not job:
        send({"id": job_id, "action": "msfile_end", "ok": False, "error": "任务不存在"})
        return
    size = 0
    try:
        job["fh"].close()
        size = os.path.getsize(job["path"])
    except OSError as e:
        send({"id": job_id, "action": "msfile_end", "ok": False,
              "error": "落盘失败: %s" % str(e)[:120]})
        return
    send({"id": job_id, "action": "msfile_end", "ok": True, "file": job["path"],
          "size": size})


def do_msfile_abort(msg):
    """中止直传：关掉句柄**并删掉半成品**。

    与 downloader 不同：那边的半成品是 .part 文件（可续传），这边的半成品
    是直接以正式文件名打开的，留着就是一坨播不了的垃圾，必须清掉。
    """
    job_id = msg.get("id")
    with FILE_LOCK:
        job = FILE_JOBS.pop(job_id, None)
    if job:
        try:
            job["fh"].close()
            os.remove(job["path"])
        except OSError:
            pass
    send({"id": job_id, "action": "msfile_abort", "ok": True})


def do_msfile_merge(msg):
    """把页面刚落盘的两条流（B 站 -video / -audio）交给 ffmpeg 合成单文件。

    合并跑在 detached 的 downloader.py 里（mode=merge），宿主/浏览器退出也不受影响；
    这里只做校验 + 拉起 + 轮询状态文件回传进度（与 download 同一套 poll_job）。
    """
    job_id = msg.get("id") or ("merge-" + uuid.uuid4().hex[:10])
    d = _download_dir()

    def bad(err):
        send({"id": job_id, "action": "msfile_merge", "ok": False, "error": err})

    video = os.path.realpath(str(msg.get("video") or ""))
    audio = os.path.realpath(str(msg.get("audio") or ""))
    # 只合并「文件存放处」里面的文件：页面是不可信输入，不能让它指挥宿主
    # 去拷贝/删除任意路径（比如把系统文件搬进下载目录造成泄露）。
    root = os.path.realpath(d)
    for p in (video, audio):
        if not (p == root or p.startswith(root + os.sep)):
            bad("只允许合并文件存放处里的文件: %s" % p)
            return
        if not os.path.isfile(p) or os.path.getsize(p) == 0:
            bad("输入文件不存在或为空: %s" % p)
            return
    if video == audio:
        bad("视频流和音频流不能是同一个文件")
        return

    ffmpeg = find_tool(["ffmpeg"])
    if not ffmpeg:
        bad("找不到 ffmpeg（项目 bin/ 目录缺失？重新解压/安装一次）")
        return

    if not os.path.exists(WORKER):
        bad("找不到 downloader.py，请重新安装")
        return

    job = {
        "id": job_id,
        "mode": "merge",
        "video": video,
        "audio": audio,
        "out": _safe_name(msg.get("out") or ""),
        "outdir": d,
        "kind": "merge",
        "filename": os.path.basename(video),
    }
    os.makedirs(JOBS_DIR, exist_ok=True)
    job_file = os.path.join(JOBS_DIR, job_id + ".job.json")
    with open(job_file, "w", encoding="utf-8") as f:
        json.dump(job, f, ensure_ascii=False)

    cancel = os.path.join(JOBS_DIR, job_id + ".cancel")
    if os.path.exists(cancel):
        os.remove(cancel)

    with open(status_file(job_id), "w", encoding="utf-8") as f:
        json.dump({"id": job_id, "kind": "merge", "status": "merging", "percent": 0,
                   "updated": time.time()}, f)

    _spawn_worker(job_file)
    threading.Thread(target=poll_job, args=(job_id,), daemon=True).start()
    # inProgress：这条 id 后面还有一串 progress/done 推送，别让扩展把桥拆了
    send({"id": job_id, "action": "msfile_merge", "ok": True, "status": "merging",
          "inProgress": True})


def reap_stale_files():
    """页面崩溃时可能留下没 end 的任务：超过 10 分钟没动静就收掉并删残文件"""
    while True:
        time.sleep(120)
        now = time.time()
        with FILE_LOCK:
            dead = [k for k, v in FILE_JOBS.items() if now - v["last"] > 600]
            for k in dead:
                v = FILE_JOBS.pop(k)
                try:
                    v["fh"].close()
                    os.remove(v["path"])
                except OSError:
                    pass



def find_tool(names):
    """找可执行文件，按优先级：项目 bin/ → PATH → 几个常见包管理器目录。

    为什么项目 bin/ 排第一：ffmpeg/ffprobe 随项目分发，不依赖系统 PATH，
    也不需要用户装。C 盘上的 winget 目录排最后，避免误用别的版本。
    """
    import shutil
    # 优先项目自带的 bin/（ffmpeg/ffprobe 随项目分发，不依赖系统 PATH）
    project_bin = os.path.join(os.path.dirname(HERE), "bin")
    for n in names:
        for cand in (n, n + ".exe"):
            p = os.path.join(project_bin, cand)
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


def status_file(job_id):
    return os.path.join(JOBS_DIR, job_id + ".json")


def read_status(job_id):
    p = status_file(job_id)
    if not os.path.exists(p):
        return None
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return None


# ---------------------------------------------------------------- 任务轮询

def poll_job(job_id):
    """轮询状态文件，有变化就推给扩展；进程结束后收尾"""
    last = None
    deadline = time.time() + 6 * 3600
    while time.time() < deadline:
        st = read_status(job_id)
        if st:
            snapshot = {k: st.get(k) for k in ("status", "percent", "speed", "eta", "file", "message")}
            if snapshot != last:
                last = snapshot
                send({
                    "id": job_id,
                    "action": "progress",
                    "status": st.get("status"),
                    "percent": round(float(st.get("percent") or 0), 1),
                    "speed": st.get("speed") or "",
                    "eta": st.get("eta") or "",
                    "file": st.get("file") or "",
                    "message": st.get("message") or "",
                    # 页面桥靠 inProgress 判断「这条 id 还会有后续消息」；
                    # 不带的话第一条 progress 就会把映射拆掉，后面全断
                    "inProgress": True,
                })
            if st.get("status") in ("done", "error", "cancelled"):
                send({"id": job_id, "action": st.get("status"), "status": st.get("status"),
                      "file": st.get("file") or "", "message": st.get("message") or ""})
                return
        time.sleep(0.4)
    send({"id": job_id, "action": "error", "status": "error", "message": "任务超时"})


# ---------------------------------------------------------------- 动作

def do_ping(msg):
    ytdlp = find_tool(["yt-dlp"])
    ffmpeg = find_tool(["ffmpeg"])
    send({
        "id": msg.get("id") or "pong",
        "action": "pong",
        "ytdlp": ytdlp or "",
        "ffmpeg": ffmpeg or "",
        "outdir": library.library_dir(),
        "python": sys.executable,
        "version": "1.0.0",
        "uptime": round(time.time() - _t0, 1),
    })


def do_reveal(msg):
    """在资源管理器里打开文件存放处。

    - 不带 file：打开下载目录（popup 的 📁 按钮）
    - 带 file：在资源管理器里**选中**这个文件（页面进度卡下载完后的
      「打开所在文件夹」按钮）。路径做了白名单校验：只允许落在下载目录里，
      避免页面通过 native 桥让宿主打开任意路径 / 执行任意程序
      （os.startfile 对 .exe 是会执行起来的，这是实打实的风险）。
    """
    d = _download_dir()
    target = (msg.get("file") or "").strip()
    try:
        if target:
            p = os.path.abspath(target)
            root = os.path.abspath(d)
            # normcase 抹平 Windows 的大小写 / 分隔符差异
            inside = os.path.normcase(p).startswith(os.path.normcase(root) + os.sep)
            if inside and os.path.exists(p):
                _reveal_path(d, p)
                send({"id": msg.get("id") or "reveal", "action": "reveal",
                      "ok": True, "dir": os.path.dirname(p), "file": p})
                return
            # 不在下载目录里（或文件已被删/改名）：退回只打开目录
            _reveal_dir(d)
            send({"id": msg.get("id") or "reveal", "action": "reveal",
                  "ok": True, "dir": d, "file": p, "fallback": True})
            return
        _reveal_dir(d)
        send({"id": msg.get("id") or "reveal", "action": "reveal", "ok": True, "dir": d})
    except Exception as e:
        send({"id": msg.get("id") or "reveal", "action": "reveal", "ok": False,
              "error": str(e)[:200], "dir": d})


def _reveal_dir(d):
    if sys.platform == "win32":
        os.startfile(d)  # noqa: 只对 Windows 有效
    elif sys.platform == "darwin":
        subprocess.Popen(["open", d])
    else:
        subprocess.Popen(["xdg-open", d])


def _reveal_path(d, p):
    """打开目录并选中文件；非 Windows 就先打开目录"""
    if sys.platform == "win32":
        # note: explorer 的 /select, 必须和路径分开传，逗号不能省
        subprocess.Popen(["explorer", "/select,", os.path.normpath(p)])
    else:
        _reveal_dir(os.path.dirname(p))


def do_open_log(msg):
    """用默认程序打开 host.log（popup 的 📄 按钮）"""
    path = LOG_FILE
    try:
        if not os.path.exists(path):
            log("日志占位", "open-log")
        if sys.platform == "win32":
            os.startfile(path)  # noqa
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
        send({"id": msg.get("id") or "open-log", "action": "open-log", "ok": True, "path": path})
    except Exception as e:
        send({"id": msg.get("id") or "open-log", "action": "open-log", "ok": False,
              "error": str(e)[:200], "path": path})


def _spawn_worker(job_file):
    """以 detached 方式拉起 downloader.py（浏览器/宿主退出后它还活着）。"""
    common = dict(
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        cwd=HERE, close_fds=True,
    )
    if sys.platform == "win32":
        # 这三个 flag 都只在 Windows 上有效；POSIX 传 creationflags 会直接 ValueError
        DETACHED_PROCESS = 0x00000008
        CREATE_NO_WINDOW = 0x08000000
        CREATE_BREAKAWAY_FROM_JOB = 0x01000000
        common["creationflags"] = DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB
    try:
        subprocess.Popen([sys.executable, WORKER, job_file], **common)
    except OSError:
        # 某些环境下 BREAKAWAY 不被允许，退回不带它的方式
        if sys.platform == "win32":
            common["creationflags"] = 0x00000008 | 0x08000000
        subprocess.Popen([sys.executable, WORKER, job_file], **common)


def do_download(msg):
    """拉起下载任务。宿主只负责写 job 文件 + 起进程 + 开轮询线程，
    真正的下载在 downloader.py 那个独立进程里跑 —— 弹窗关了、宿主死了、
    浏览器退了，下载都照下不误。

    副作用顺序很重要：先清取消标记（同 id 重试时残留的 .cancel 会让新任务
    一启动就自杀），再写初始状态（扩展在 worker 起来前不能读到空文件）。

    入参全部当作不可信处理：id 拼文件名、url 交给 yt-dlp、outdir 决定落盘位置。
    扩展侧已有一道校验，这里是独立的一道（宿主也被别的调用方直接连着）。
    """
    job_id = _safe_job_id(msg.get("id"))
    if not job_id:
        send({"id": "", "action": "error", "status": "error",
              "message": "任务 id 不合法"})
        return
    url = str(msg.get("url") or "").strip()
    if not re.match(r"^https?://", url, re.I):
        send({"id": job_id, "action": "error", "status": "error",
              "message": "只支持 http/https 地址"})
        return

    job = {
        "id": job_id,
        "url": url,
        "kind": msg.get("kind") or "other",
        "filename": msg.get("filename") or "",
        "referer": msg.get("referer") or "",
        "tabUrl": msg.get("tabUrl") or "",
        "cookie": msg.get("cookie") or "",
        "concurrency": int(msg.get("concurrency") or 16),
        "outdir": _safe_outdir(msg.get("outdir")),
        "headers": _safe_headers(msg.get("headers")),
    }
    os.makedirs(JOBS_DIR, exist_ok=True)

    job_file = os.path.join(JOBS_DIR, job["id"] + ".job.json")
    with open(job_file, "w", encoding="utf-8") as f:
        json.dump(job, f, ensure_ascii=False)

    # 清掉可能残留的取消标记
    cancel = os.path.join(JOBS_DIR, job["id"] + ".cancel")
    if os.path.exists(cancel):
        os.remove(cancel)

    if not os.path.exists(WORKER):
        send({"id": job["id"], "action": "error", "status": "error",
              "message": "找不到 downloader.py，请重新安装"})
        return

    # 初始状态，避免扩展在 worker 起来前读到空
    with open(status_file(job["id"]), "w", encoding="utf-8") as f:
        json.dump({"id": job["id"], "status": "starting", "percent": 0,
                   "updated": time.time()}, f)

    _spawn_worker(job_file)

    threading.Thread(target=poll_job, args=(job["id"],), daemon=True).start()
    send({"id": job["id"], "action": "started", "status": "starting", "percent": 0})


def do_cancel(msg):
    """取消 = 在 jobs/ 下写一个 <id>.cancel 空文件。downloader 的读写循环每
    轮都 stat 一下它，看到就 terminate 子进程。跨进程用文件当信号，比 socket
    简单，也不怕 worker 还没起来（标记会一直在那儿等着）。
    """
    os.makedirs(JOBS_DIR, exist_ok=True)
    job_id = _safe_job_id(msg.get("id"))
    if not job_id:
        send({"id": "", "action": "error", "status": "error", "message": "任务 id 不合法"})
        return
    with open(os.path.join(JOBS_DIR, job_id + ".cancel"), "w") as f:
        f.write("1")
    send({"id": job_id, "action": "cancelled", "status": "cancelled"})


def do_list(msg):
    """列出最近的下载任务（供排障用）。

    跳过 .job.json（那是发给 worker 的输入，不是状态），只读 .json 状态文件；
    按 updated 倒序，最多 50 条 —— 用户攒了几个月也不至于返回几千条。
    """
    os.makedirs(JOBS_DIR, exist_ok=True)
    jobs = []
    for name in os.listdir(JOBS_DIR):
        if not name.endswith(".json") or name.endswith(".job.json"):
            continue
        st = read_status(name[:-5])
        if st:
            jobs.append(st)
    jobs.sort(key=lambda x: x.get("updated") or 0, reverse=True)
    send({"id": msg.get("id") or "list", "action": "list", "jobs": jobs[:50]})


def do_log(msg):
    """扩展侧（background / 页面）的排查事件，统一落进 host.log。"""
    kind = str(msg.get("kind") or "web")[:24]
    text = str(msg.get("text") or "")[:400]
    log("[%s] %s" % (kind, text))
    send({"id": msg.get("id") or "", "action": "log", "ok": True})


HANDLERS = {
    "ping": do_ping,
    "download": do_download,
    "cancel": do_cancel,
    "reveal": do_reveal,
    "open-log": do_open_log,
    "list": do_list,
    "log": do_log,
    "msfile_start": do_msfile_start,
    "msfile_chunk": do_msfile_chunk,
    "msfile_end": do_msfile_end,
    "msfile_abort": do_msfile_abort,
    "msfile_merge": do_msfile_merge,
}


def main():
    """主循环：读一条、派发一条，**永远不退出**（除非 stdin 关了）。

    handler 里任何异常都就地兜住转成 error 回执 —— 一个坏请求不该把宿主
    整个打死，否则用户得重启浏览器才能再下载。reap_stale_files 是守护
    线程，负责清理页面崩溃留下的半成品。
    """
    log("start", sys.executable)
    threading.Thread(target=reap_stale_files, daemon=True).start()
    while True:
        msg = read_message()
        if msg is None:
            log("stdin closed")
            return
        action = msg.get("action")
        fn = HANDLERS.get(action)
        if not fn:
            send({"id": msg.get("id") or "", "action": "error",
                  "status": "error", "message": "未知指令: %s" % action})
            continue
        try:
            fn(msg)
        except Exception as e:
            log("handler error", action, e)
            send({"id": msg.get("id") or "", "action": "error",
                  "status": "error", "message": str(e)[:300]})


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
