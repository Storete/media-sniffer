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
import errcode  # noqa: E402  失败原因码表（L2-c）；重试预算写在码表里，不散在 if 里

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


# 同一进程里至少三个线程会写状态文件（主流程 / stdout 读取线程 / 阶段 ticker），
# 而 write_status 是「读-合并-写」。不加锁时「读到的旧值」与「写下去的新值」之间
# 有条缝，两处都会出错：
#   · 两个进度线程同时合并 → 后写的那个用的是旧快照，把对方刚写的字段冲掉；
#   · ticker 拿旧 message 做判断 → 结束后还能盖掉 done 的文案（见 write_message_if）。
# 用 RLock 而不是 Lock：write_message_if 持锁时还要调 write_status，
# 走的是同一个临界区（可重入）。
_STATUS_LOCK = threading.RLock()


def write_status(job_id, **fields):
    """**合并式**写状态：读出旧内容、update 新字段、原子替换。

    三个刻意的设计：
      · 合并而不是覆盖 —— 调用方每次只传几个字段（percent/speed/eta），
        覆盖会把 status/file 这些冲掉
      · 写 .tmp 再 os.replace —— 宿主是另一个进程，正在轮询读这个文件，
        直接 open("w") 有窗口期读到空/半个 JSON，宿主会当成「没状态」
      · "updated" 每次刷新 —— 宿主据此判断任务是否还活着

    外面套一把进程内锁，见 `_STATUS_LOCK` 的说明。
    """
    with _STATUS_LOCK:
        _write_status_locked(job_id, **fields)


def _write_status_locked(job_id, **fields):
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


def write_message_if(job_id, expect, message):
    """只有当 message 仍等于 `expect` 时才写它。返回是否真的写了。

    这是「比较并写」的原子版本，专供阶段 ticker 自限用。原来的写法是
    ticker 自己 `read_status` 比对、再调 `write_status` —— 两步之间有条缝：

        ticker: 读到 message 还是「探测请求头 1/4」（是我写的，继续）
        主流程: write_status(done, message="")      ← 缝在这里
        ticker: write_status(message="探测请求头 1/4（已等 0 秒）")

    结果是 status=done、message 却挂着一句阶段提示 —— 也就是 d-034 那个
    「全程挂着解析播放列表」的界面症状，从另一个入口进来。真机上 tick 是 2 秒、
    这条缝不到 1 毫秒，所以只在测试把 PHASE_TICK 踩到 0.05 时才**七分之一**地露头
    （2026-10-25 复现：25 次里红 4 次，红的是 T3 或 T4 各一次）。
    概率低不等于不存在：用户看到的是「下载完成了，但下面还写着正在探测请求头」。
    """
    with _STATUS_LOCK:
        cur = read_status(job_id).get("message") or ""
        if cur != expect:
            return False
        _write_status_locked(job_id, message=message)
        return True


def write_progress(job_id, percent, speed="", eta=""):
    """进度刷新统一入口。**必须清空 message。**

    write_status 是合并式的（只更新传入的字段），所以上一步写下的提示会一直留着。
    真机（2026-10-22 51cg1）：自实现 HLS 开头写了「解析播放列表」，随后清单加密
    交回 yt-dlp，yt-dlp 的进度更新只写 percent/speed/eta —— 于是界面上从 0% 到
    87.7% 全程显示「解析播放列表」，用户看到的是「卡在解析」，其实一直在下载。
    """
    write_status(job_id, status="downloading", percent=percent,
                 speed=speed, eta=eta, message="")


PHASE_TICK = 2.0     # 阶段提示的刷新节拍（秒）；测试里会调小


class Phase:
    """「正在干什么」的可见提示，附带自动累加的「已等 N 秒」。

    为什么需要：从点下载到第一片落地，中间有两段**纯等待**，都不产生进度事件 ——
    ① `run_hls_self` 自己试一遍（拉主清单、有子清单再拉一次、查加密、第一片当探针
    最多试 4 档请求头，每档一次真实 HTTP）；② 交回 `run_ytdlp` 后它还要拉清单、
    解析几百个分片。真机（2026-10-22 51cg1）：22:10:33 写 `percent=0`，
    **22:12:21** 才第一次跳到 93.9% —— 近 2 分钟界面一动不动，用户以为卡死。
    这两段确实估不出百分比，但「还在动」是能给的，所以给一句会走的文案。

    **自限**：每次写之前先读状态，发现 message 已经被别人改掉（`write_progress`
    清空 / 写了 done/error）就自己退出。这样调用方不需要在每条 `return` 前记得
    停它 —— 忘了停就是 d-034 那个 bug 的翻版：整场下载全程挂着「解析播放列表」。
    也正因为自限，它可以放心地挂在 `run_ytdlp` 那条长流程上。
    """

    def __init__(self, job_id, text):
        self.job_id = job_id
        self.text = text
        self._mine = text
        self._stop = threading.Event()
        self._t0 = time.time()
        write_status(job_id, status="downloading", message=text)
        self._th = threading.Thread(target=self._run, daemon=True)
        self._th.start()

    def _run(self):
        while not self._stop.wait(PHASE_TICK):
            try:
                nxt = "%s（已等 %d 秒）" % (self.text, int(time.time() - self._t0))
                # 「比较并写」必须是一步：先自己 read_status 比对、再 write_status
                # 的话中间有缝，结束态会在缝里被盖掉（见 write_message_if 的注释）。
                if not write_message_if(self.job_id, self._mine, nxt):
                    return           # 别人接管了 message（进度/结束态），闭嘴
                self._mine = nxt
            except Exception:
                return

    def done(self):
        self._stop.set()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.done()
        return False


def read_status(job_id):
    """读状态文件，读不到/坏 JSON 一律返回空 dict（调用方用 .get 就不会炸）"""
    try:
        return json.load(open(status_path(job_id), encoding="utf-8"))
    except Exception:
        return {}


MAX_BASE = 100
# 超过这个长度的"扩展名"不是扩展名。见下面的注释，这是个真的坑。
EXT_KEEP = 16


def _strip_edges(s):
    """去掉首尾所有空白和点。

    不能只写 s.strip(" .")：它只认 ascii 空格和点，而 str.strip() 认**全部
    Unicode 空白**。两者混用会留下以 U+3000（全角空格）开头的名字 —— 中文
    标题里"　第1集"这种写法很常见 —— 而且不幂等：洗一次剩 \\u3000，洗两次
    才干净。变异测试（tools/fuzz_host.py 的 S6）就是这么揪出来的。
    """
    i, j = 0, len(s)
    while i < j and (s[i] == "." or s[i].isspace()):
        i += 1
    while j > i and (s[j - 1] == "." or s[j - 1].isspace()):
        j -= 1
    return s[i:j]


def sanitize(name, fallback="video"):
    """洗成合法的 Windows 文件名。

    处理五件事：非法字符换 _、去掉首尾的点和空白（Windows 上以点/空格结尾
    的文件名建不出来）、保留设备名（con/prn/aux/nul/com1-9/lpt1-9 会失败）
    换掉、超长按「主干 100 减扩展名长度」截断以保住扩展名、**截断之后再洗一遍
    尾部**（否则第 100 个字符正好是空格时，会留下以空格结尾的名字）。

    扩展名的边界：os.path.splitext("a." + "b"*300) 会认出一个 301 字符的"扩展名"，
    这时 100 - len(ext) 变成负数，切片直接失效、长度完全不受控（实测返回 301 字符，
    超过 Windows 255 上限就真的建不出文件）。所以 ext 太长的，一律当它不是扩展名，
    整个名字按正文截断。
    """
    name = _strip_edges(name or "")
    name = _strip_edges(ILLEGAL.sub("_", name))
    if not name or RESERVED.match(name):
        name = fallback
    if len(name) > MAX_BASE:
        root, ext = os.path.splitext(name)
        if not ext or len(ext) > EXT_KEEP:
            root, ext = name, ""
        root = _strip_edges(root[: MAX_BASE - len(ext)])
        name = root + ext
        # 截断后可能只剩点/空格（原名 100 个 "."），也可能刚好落回保留名
        if not _strip_edges(name) or RESERVED.match(name):
            name = fallback
    return name


PROJECT_BIN = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin"
)

# path -> 能不能启动。一次任务内只探一次：ffmpeg -version 约 60ms，
# 但 run_hls_self 里要调好几次，不该每次都付。
_TOOL_RUNS = {}


def _probe_args(path):
    """yt-dlp 只认 `--version`，ffmpeg/ffprobe 只认 `-version`。"""
    n = os.path.basename(path).lower()
    if n.startswith("yt-dlp") or n.startswith("youtube-dl"):
        return ["--version"]
    return ["-version"]


def tool_runs(path):
    """**能启动才算「有」。**

    这一条是拿真机现场换来的（2026-10-24）：本机项目目录被打了
    `Mandatory Label\\Low Mandatory Level` 标签，里面的 `ffmpeg.exe`
    一启动就 `0xC0000409`（STATUS_STACK_BUFFER_OVERRUN）直接崩掉 ——
    而 `os.path.exists()` 高高兴兴返回 True。

    结果是合并任务报出「ffmpeg 退出码 3221226505，输出为空」：用户完全看不懂，
    我们也查不到（错误输出一个字都没有）。**存在性检查会骗人，可执行性不会。**
    """
    if path in _TOOL_RUNS:
        return _TOOL_RUNS[path]
    ok = False
    try:
        r = subprocess.run([path] + _probe_args(path), capture_output=True,
                           timeout=8, stdin=subprocess.DEVNULL, **_NO_WINDOW)
        # 只看「有没有正常打印版本」：有的构建 -version 写 stderr（老 ffmpeg），
        # 有的工具退出码非 0 但确实可用，所以两个流一起看。
        out = (r.stdout or b"") + (r.stderr or b"")
        ok = r.returncode == 0 and bool(out.strip())
    except Exception:
        ok = False
    _TOOL_RUNS[path] = ok
    return ok


def find_tool(names):
    """三级查找：项目 bin/ → 系统 PATH → 常见包管理器目录。

    每个候选都要过 `tool_runs`：**找不到和跑不起来是同一件事**
    （对调用方都是「没有可用的 ffmpeg」），但对用户要说成 MISSING_DEP，
    而不是把一个看不懂的退出码丢给他。
    """
    # 优先用项目自带的 bin/（随插件一起分发，不依赖系统 PATH 和 C 盘）
    for n in names:
        for cand in (n, n + ".exe"):
            p = os.path.join(PROJECT_BIN, cand)
            if os.path.exists(p) and tool_runs(p):
                return p
    for n in names:
        p = shutil.which(n)
        if p and tool_runs(p):
            return p
    for base in [
        os.path.join(os.path.expanduser("~"), ".venvs", "agent-reach", "Scripts"),
        os.path.join(os.path.expanduser("~"), "scoop", "shims"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Links"),
    ]:
        for n in names:
            for cand in (n, n + ".exe"):
                p = os.path.join(base, cand)
                if os.path.exists(p) and tool_runs(p):
                    return p
    return None


_FFPROBE_CACHE = [None, False]      # [path, 已探测过]


def ffprobe_tool():
    """拿一个「能跑」的 ffprobe，结果缓存。

    与 find_tool(["ffprobe"]) 唯一的区别是**缓存 + 只查一次**：验证四层在每条
    下载链收尾都要问一次，而 find_tool 每次都要真跑一遍 `-version`
    （tool_runs 会起子进程），几十次下来是纯浪费。缓存的第二个值是
    `False`（哨兵）用来区分「没查过」和「查过了但没有」。
    """
    if not _FFPROBE_CACHE[1]:
        _FFPROBE_CACHE[0] = find_tool(["ffprobe"])
        _FFPROBE_CACHE[1] = True
    return _FFPROBE_CACHE[0]


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

# 真视频的下限。只用来挡「只有前几个字节正确」的残片，所以定得很低：
# 播放列表只有几十 KB，但**判是不是视频靠的是魔数，不是体积**——真短视频
# （十几秒的片段）几百 KB 也得认，把线画在 1MB 会把正常成片误判成失败，
# 而失败会让人以为白下了一遍。64KB 足够采样 TS 的 188×5 个同步点。
MEDIA_MIN = 64 * 1024


def is_real_media(path, min_size=MEDIA_MIN):
    """按**魔数**判断这是不是一个真视频文件。

    为什么不能只看扩展名：「扩展名是 yt-dlp 按 content-type 猜的」——m3u8 的
    content-type 是 `application/vnd.apple.mpegurl`，猜不出来时会被存成没有
    扩展名的 `<base>`；反过来 `.mp4` 里装的也可能是 TS 字节（d-032 真机）。
    所以 done 的判据必须落到文件头。

    认得的容器：mp4/mov(ftyp)、mkv/webm(EBML)、avi(RIFF)、flv、ogg、mp3/aac(帧同步)、
    以及 MPEG-TS（0x47 起始 + 188 周期连续命中）。
    """
    try:
        if not path or not os.path.isfile(path):
            return False
        if os.path.getsize(path) < min_size:
            return False
        with open(path, "rb") as f:
            head = f.read(16)
            if len(head) < 12:
                return False
            if head[4:8] == b"ftyp":
                return True
            if head.startswith(b"\x1a\x45\xdf\xa3"):        # EBML：mkv / webm
                return True
            if head.startswith(b"RIFF") and head[8:12] == b"AVI ":
                return True
            if head.startswith(b"FLV\x01"):
                return True
            if head.startswith(b"OggS"):
                return True
            if head.startswith(b"ID3") or (head[0] == 0xFF and (head[1] & 0xE0) == 0xE0):
                return True
            if head[0:1] == b"\x47":                        # MPEG-TS
                for k in range(1, 5):
                    f.seek(k * TS_PACKET)
                    if f.read(1) != b"\x47":
                        return False
                return True
        return False
    except Exception:
        return False


def find_done_product(outdir, base):
    """在这次任务的产物里挑出最大的一个**真视频**，挑不到返回空串。

    只认 `<base>.*`，所以：
      · 不会挑到裸的 `<base>`（那正是「只下到播放列表」时被存下来的清单）
      · 不会挑到 `job2.mp4` 这种名字相近的别的任务
    取最大而不是第一个：同一个 base 下可能同时躺着半截残片和完整成片。
    """
    if not outdir or not base or not os.path.isdir(outdir):
        return ""
    best, best_size = "", 0
    try:
        names = os.listdir(outdir)
    except OSError:
        return ""
    prefix = base + "."
    for n in names:
        if not n.startswith(prefix):
            continue
        p = os.path.join(outdir, n)
        if not is_real_media(p):
            continue
        try:
            sz = os.path.getsize(p)
        except OSError:
            continue
        if sz > best_size:
            best, best_size = p, sz
    return best



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


def verify_product(path, expect=None, ffprobe=None):
    """输出验证四层（L2-b 的落地）。返回 `(ok, code, detail, extra)`。

    `ok=False` 时 `code` 一定是码表里的一个码（默认 VERIFY_MISMATCH），
    调用方拿它走 `_give_up` —— **绝不把坏文件当成功**。这是唯一入口，
    各下载链（直链 / HLS 自下 / yt-dlp / 合并 / MSE 落盘）收尾都要经过它。

    四层（任一层不过就停，后面的不再看）：
      1. 文件存在          → 不存在是「说完成但啥都没有」
      2. 非空（size > 0）  → 0 字节是「跑完了但空手」
      3. 内容符合预期      → 三件事：a) `looks_like_playlist`（把清单当文件下）
                              b) `expect.min_bytes` 有值时 size 不够
                              c) `expect.content_sniff`（可选回调）判「读到的不是这个类型」
      4. ffprobe 能解析    → 只有 `ffprobe` 非空才做；解析失败 / 缺 expect 的
                              轨道 / 时长偏差超 `expect.dur_tol` 秒 → 不过

    设计要点：
      · 纯函数 —— 不碰网络、不改文件，只读；`ffprobe` 是入参不是自己去找，
        这样测试能塞一个假 ffprobe 验证逻辑，本机没有真 ffmpeg 也能全绿。
      · 第 4 层「可跳过」：`ffprobe` 传 None 就只做前三层。本机（T-E5 之前）
        没有能跑的 ffprobe，但不该因此整个验证退化 —— 前三层已经能拦住
        「下到清单」「下到 0 字节」「下到半截」这三种最脏的假成功。
      · 时长偏差只判「太短」不判「太长」：多下几秒能忍，少下几十秒是
        真缺内容。`dur_tol` 默认 2 秒，与 PRODUCT-PLAN 的「偏差 < 2s」对齐。

    `expect` 可空：空就只做「存在 + 非空 + 不是清单」这三条最底线，
    对应「没有清单元数据、只有一条直链」的下载。
    """
    e = expect or {}
    if not path or not os.path.isfile(path):
        return (False, "VERIFY_MISMATCH", "下完的文件不存在", {})
    try:
        size = os.path.getsize(path)
    except OSError:
        return (False, "VERIFY_MISMATCH", "读不到文件大小", {})
    if size <= 0:
        return (False, "VERIFY_MISMATCH", "下完的文件是 0 字节", {})
    if looks_like_playlist(path):
        # 单独一个 detail 而不是拼 code：直链 / yt-dlp 两路要同一句话（T-B5），
        # 这里给「事实」，建议（act）由调用方按场景覆盖。
        return (False, "VERIFY_MISMATCH", errcode.DETAIL_PLAYLIST, {})
    if e.get("min_bytes") and size < int(e["min_bytes"]):
        return (False, "VERIFY_MISMATCH",
                "只有 %s，比预期短太多" % _fmt_bytes(size), {"size": size})
    sniff = e.get("content_sniff")
    if callable(sniff):
        try:
            bad = sniff(path, size)
        except Exception:
            bad = ""
        if bad:
            return (False, "VERIFY_MISMATCH", str(bad), {"size": size})

    # 第 4 层：ffprobe。没有 ffprobe 就到此为止 —— 前三层已经拦住最脏的假成功。
    if not ffprobe:
        return (True, "", "", {"size": size, "probed": False})
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries",
             "format=duration:stream=codec_type,codec_name",
             "-of", "default=noprint_wrappers=1", path],
            capture_output=True, text=True, timeout=30, **_NO_WINDOW,
        )
    except Exception as exc:
        # ffprobe 起不来是「本机缺依赖」，不是「文件坏」—— 别把工具问题算到产物头上。
        # 这里放宽成「前三层已过」，让 done 能落；工具问题由 find_tool 那一层拦。
        return (True, "", "", {"size": size, "probed": "skipped", "why": str(exc)[:40]})
    if out.returncode != 0:
        return (False, "VERIFY_MISMATCH", "ffprobe 打不开这个文件", {"size": size})

    dur = None
    codecs = set()
    for line in (out.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("duration="):
            try:
                dur = float(line.split("=", 1)[1])
            except ValueError:
                dur = None
        elif line.startswith("codec_type="):
            codecs.add(line.split("=", 1)[1].strip())
    extra = {"size": size, "probed": True, "duration": dur, "codecs": sorted(codecs)}

    # 缺轨道：expect.tracks 说要有 audio，但 ffprobe 没看到 audio 流
    for tr in (e.get("tracks") or []):
        if tr not in codecs:
            return (False, "VERIFY_MISMATCH",
                    "少了 %s 轨道" % tr, extra)
    # 时长偏差：只有 expect.min_duration 给了才判「太短」
    if e.get("min_duration") and dur is not None and dur < float(e["min_duration"]):
        return (False, "VERIFY_MISMATCH",
                "时长 %.1fs，比预期短" % dur, extra)
    return (True, "", "", extra)


def finish_verified(job_id, path, message="", expect=None, notes=(), act=""):
    """收尾统一出口：跑 `verify_product`，过了写 done，没过走 `_give_up`。

    各下载链（直链 / yt-dlp / HLS 自下 / 合并）原来各自写 `write_status(done)`，
    「验证产物」这一步要么没有、要么散落各处（有的查清单、有的查字节数、
    有的连 ffprobe 都不碰）。这里收成一个口：**done 一定是验证过的 done**。

    `act` 只在验证失败时用（不同链对同一码的建议不一样，比如「下到清单」在
    直链要换分片路径、在 yt-dlp 要换 URL）；`notes` 是要拼进成功 message 的
    额外提醒（如清晰度回落）。
    """
    ok, code, detail, _extra = verify_product(path, expect, ffprobe_tool())
    if not ok:
        _give_up(job_id, code, detail, act)
        return False
    msg = message
    if notes:
        msg = (msg + "；" if msg else "") + "；".join(notes)
    write_status(job_id, status="done", percent=100, speed="", eta="",
                 err="", file=path, message=msg)
    return True


def cleanup_ytdlp_junk(outdir, base):
    """清掉 yt-dlp 一次失败留下的碎片，返回删除个数。

    为什么会留：yt-dlp 下 HLS 先写 `<base>.mp4.part`，再按分片落
    `<base>.mp4.part-FragN.part` 和 `.ytdl` 断点文件；失败或被中断时这些
    全堆在输出目录里（真机实测一次失败 31 个文件）。用户不知道能不能删，
    而本机 safe-delete 一次删 >50 文件会被拦 → 越积越多，「以后再说」等于
    永远清不掉。

    只认四类，宁少删不多删：
      · `<base>.*.part*` —— 未完成的下载与分片
      · `<base>.*.ytdl`  —— yt-dlp 断点记录
      · 内容确实是播放列表的 `<base>.m3u8` —— 「只下到清单」的残骸，不是视频
      · 内容确实是播放列表的 `<base>` 本身 —— 同上，只是 yt-dlp 猜不出扩展名时
        会连后缀都不给（真机 2026-10-22：29,251 字节的清单就叫 `<base>`）
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
        p = os.path.join(outdir, n)
        low = n.lower()
        if n == base:
            # 无后缀的 <base>：只有「内容真是清单」才算垃圾。成片不可能没有后缀，
            # 但仍然用 looks_like_playlist 再确认一次，避免误删用户手放的文件。
            drop = looks_like_playlist(p)
        elif n.startswith(prefix):
            if ".part" in low or low.endswith(".ytdl"):
                drop = True
            elif low == (base + ".m3u8").lower() and looks_like_playlist(p):
                drop = True
            else:
                drop = False
        else:
            continue
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
    if is_cancelled(job_id):
        # 守卫放在最前面：取消标记可能是「上一路还在跑时」写下的，轮到这一路
        # 时任务其实已经取消了。没有这道守卫，取消会被兜底路径覆盖成
        # downloading 并继续下（真机 1.3.33 冒烟撞到）。
        write_status(job_id, status="cancelled", percent=0, message="用户取消")
        return

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
    # 解析期提示：yt-dlp 要把清单拉下来、分片表建好才吐第一行进度，这段可能几十秒
    # 到几分钟（视分片数）。没有它，界面就是一根停着的 0% 空槽。
    phase = Phase(job_id, "交给 yt-dlp 解析清单（分片多时要等一会儿）")

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
                # 第一行进度到了 = 解析结束，阶段提示让位（它的自限也能兜住，
                # 但显式停一下更干净，省掉一次多余的读盘）
                phase.done()
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
                write_status(job_id, status="cancelled", err="", message="用户取消")
                return
    except Exception as e:
        _give_up(job_id, errcode.INTERNAL, ("读取 yt-dlp 输出失败: " + str(e))[:60])
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
            # 与直连路径**同一个码、同一句话**：用户不该因为在哪条路上撞到
            # 「把清单当文件下」而看到两种解释（T-B5）。
            _give_up(job_id, "VERIFY_MISMATCH",
                     errcode.DETAIL_PLAYLIST, act=errcode.ACT_PLAYLIST)
        elif not final_file or not os.path.exists(final_file):
            # 第四种假成功：退出码 0、没有 FILE: 行、目录里也没有真视频。
            # 原代码在这里直接写 done + file=""，用户看到「完成」但什么都没有。
            product = find_done_product(outdir, base)
            if product:
                finish_verified(job_id, product)
            else:
                _give_up(job_id, "VERIFY_MISMATCH", "yt-dlp 说完成了，但目录里找不到视频文件")
        else:
            # yt-dlp 路径拿不到清单的时长/轨道，expect 只留空；ffprobe 在的时候
            # 走第 4 层（解析失败 = 打不开的假成功），没有 ffprobe 就前三层。
            finish_verified(job_id, final_file)
    else:
        # 尾部有 ERROR 行**不等于**失败（真机 2026-10-22 51cg1 第三次下载）：
        # yt-dlp 退出码 0、170MB 的真 mp4 已经下好，却打了一行内容为空的
        # `ERROR:`；旧代码把它当失败，接着兜底拿 m3u8 又下一遍，最后落成
        # 「done + message 残留 ERROR: + file 指向 29KB 清单」。
        # 判据改成「目录里有没有真视频」：有就是成了，那行 ERROR 只是噪声。
        product = find_done_product(outdir, base)
        if proc.returncode == 0 and product:
            finish_verified(job_id, product)
            return
        # 失败：把 yt-dlp 的英文输出翻成码表里的一个码。
        # 看的是整段尾巴而不是那一行 ERROR —— 真机上「原因」常常在上一行，
        # ERROR 行本身可能只有一句空的 `ERROR:`。
        code = errcode.classify_ytdlp("\n".join(tail[-12:]))
        cleanup_ytdlp_junk(outdir, base)
        # 认不出来的说法才贴原文（诊断要靠它）；认得出的已经有中文本事了。
        detail = str(post_err or " ".join(tail[-4:]))[:70] if code == errcode.INTERNAL else ""
        _give_up(job_id, code, detail)


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

# ---- 断点指纹（P1，2026-10-24）--------------------------------------------
#
# 为什么要它：续传原来只认 `.part` 的**长度**。长度对得上就接着写 —— 可这期间
# 服务端完全可能换了内容（视频重新转码、CDN 换切片、签名直链换批次）。拼出来的
# 是「前半段 A + 后半段 B」，而 **ffprobe 往往还能打开**，于是验证层会放它过去。
# 这是「错并且不自知」，比慢一百倍都严重，所以修它排在提速前面
# （`docs/ENGINE-EVAL.md` §4-P1）。
#
# 存三样：`ETag` / `Last-Modified` / 总长度。任一变化就**作废 `.part` 整单重下**，
# 不试图续 —— 续错的代价远大于重下的时间。
PART_META_SUFFIX = ".part.meta"


def _parse_content_range_total(value):
    """'bytes 100-999/1000' → 1000。总长是 '*' 或格式不对 → 0。"""
    m = re.search(r"/\s*(\d+)\s*$", str(value or ""))
    return int(m.group(1)) if m else 0


def _resp_total(resp, resumed):
    """这条响应对应的**整份文件**长度（不是本次要传的字节数）。

    206 的 `Content-Length` 只算「剩下的那截」，直接用会让进度条从 90% 跳回 10%；
    优先用 `Content-Range` 里的总数，没有才退回 `Content-Length + 已下长度`。
    """
    cl = int(resp.headers.get("Content-Length") or 0)
    if resp.status == 206:
        tot = _parse_content_range_total(resp.headers.get("Content-Range"))
        if tot:
            return tot
        return (cl + resumed) if cl else 0
    return cl


def _norm_etag(v):
    """`W/"abc"` 与 `"abc"` 是同一内容的强弱标记差别，不是内容变了。
    不剥掉 `W/` 会让「服务器今天改成弱校验」被误判成换文件，白下一次。"""
    v = (v or "").strip()
    return v[2:].strip() if v[:2].upper() == "W/" else v


def fingerprint_of(resp, total, url=""):
    return {
        "etag": (resp.headers.get("ETag") or "").strip(),
        "lm": (resp.headers.get("Last-Modified") or "").strip(),
        "len": int(total or 0),
        "url": url or "",
    }


def fingerprint_mismatch(old, new):
    """返回「不能续传」的人话原因；空串 = 可以续。

    判据强弱：长度 > ETag > Last-Modified。
    三项都拿不到时**允许续传**：绝大多数 CDN 分片和签名直链不给校验头，
    一律拒绝续传等于把它们变成「每次断了都从 0 开始」——那比冒险更糟。
    """
    if not isinstance(old, dict):
        return ""
    olen, nlen = int(old.get("len") or 0), int(new.get("len") or 0)
    if olen and nlen and olen != nlen:
        return "文件长度从 %d 变成 %d" % (olen, nlen)
    oet, net = _norm_etag(old.get("etag")), _norm_etag(new.get("etag"))
    if oet and net and oet != net:
        return "ETag 变了（%s → %s）" % (oet[:40], net[:40])
    olm, nlm = (old.get("lm") or "").strip(), (new.get("lm") or "").strip()
    if olm and nlm and olm != nlm:
        return "Last-Modified 变了（%s → %s）" % (olm[:40], nlm[:40])
    return ""


def read_part_meta(part):
    try:
        with open(part + PART_META_SUFFIX, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else None
    except Exception:
        return None


def write_part_meta(part, meta):
    """指纹写失败**不能**让下载失败：它只决定「下次能不能安全续传」。"""
    p = part + PART_META_SUFFIX
    try:
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False)
        os.replace(tmp, p)
    except Exception:
        pass


def drop_part_meta(part):
    for p in (part + PART_META_SUFFIX, part + PART_META_SUFFIX + ".tmp"):
        try:
            os.remove(p)
        except OSError:
            pass


def _fmt_bytes(n):
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return ("%d %s" % (n, unit)) if unit == "B" else ("%.1f %s" % (n, unit))
        n /= 1024.0
    return "%.1f GB" % n


def _sleep_watch(job_id, seconds, step=0.5):
    """睡 `seconds` 秒，但每 `step` 秒问一次取消。返回 False = 被取消。

    为什么分段：`time.sleep(30)` 期间用户点取消要等满 30 秒才生效 ——
    和 d-050 里「取消要等在途分片把 3 轮退避跑完（实测 70 秒）」是同一个病。
    退避等待是**我们**的决定，不该让用户等我们。
    """
    deadline = time.time() + float(seconds)
    while True:
        if is_cancelled(job_id):
            return False
        left = deadline - time.time()
        if left <= 0:
            return True
        time.sleep(min(step, left))


def _give_up(job_id, code, detail="", act=""):
    """统一收尾：写码 + 一句人话。三条路径以后都走这里（P3' 的收敛点）。"""
    write_status(job_id, status="error", err=code,
                 message=errcode.describe(code, detail, act))


def run_urllib(job):
    """自己发 HTTP 下直链。相比 yt-dlp 的好处：完全可控、支持断点续传、
    没有「把 URL 当网页爬」的误判。

    续传协议：数据先写 <名字>.part，写完了才 os.replace 到正式名。
      · 重跑时看到 .part 就带 `Range: bytes=<已有长度>-` 继续
      · 服务器回 206 才追加；回 200 说明对方不支持 Range（可能整个重发），
        必须 wb 重写，否则拼接出来是坏的
      · **续传前先比指纹**（见文件上方 PART_META_SUFFIX 的说明）：ETag /
        Last-Modified / 总长任一变化 → 作废 `.part` 从头下，绝不拼两份内容
      · 只有「收到的字节数 == 总长」才算完成，提前 EOF 判失败并**保留** `.part`
        （原来会 `break` 出去然后 os.replace，把半截文件报成 done）
      · 正式文件永远只有「完整」这一种状态，用户不会看到半截图
    """
    job_id = job["id"]
    outdir = job.get("outdir") or DEFAULT_OUT
    os.makedirs(outdir, exist_ok=True)
    if is_cancelled(job_id):
        # 同 run_ytdlp：这是 yt-dlp 失败后的兜底，取消的任务不该再被它捡起来。
        write_status(job_id, status="cancelled", percent=0, message="用户取消")
        return

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
    resumed = os.path.getsize(part) if os.path.exists(part) else 0

    # 兜底前先认现有产物。这一路是「yt-dlp 失败后换个办法再试」，而 yt-dlp 的
    # 「失败」经常是假的（退出码 0、真视频已下好、尾部一行空 ERROR）。真机
    # 2026-10-22：这里又拿 m3u8 下了一遍，把 29KB 清单存成 `<base>` 并报 done,
    # 覆盖掉旁边 170MB 的真 mp4。目录里已经有真视频就直接收工。
    existing = find_done_product(outdir, os.path.splitext(name)[0] or name)
    if existing:
        write_status(job_id, status="done", percent=100, speed="", eta="",
                     file=existing, message="")
        return

    write_status(job_id, status="downloading", percent=0, speed="", eta="", file="")

    dropped = False      # 本轮任务里已经作废过一次断点？
    attempt = 0          # 第几次**请求**（重试也算），交给 errcode.plan 判预算
    while True:
        attempt += 1
        resp_headers = dict(headers)
        if resumed:
            resp_headers["Range"] = f"bytes={resumed}-"
        req = urllib.request.Request(job["url"], headers=resp_headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                total = _resp_total(resp, resumed)
                mode = "ab" if (resp.status == 206 and resumed) else "wb"
                if mode == "wb":
                    resumed = 0

                fp = fingerprint_of(resp, total, job["url"])
                if mode == "ab":
                    why = fingerprint_mismatch(read_part_meta(part), fp)
                    if why:
                        if dropped:
                            # 已经重下一次还是对不上：说明服务端在抖动（或者每条
                            # 请求给不同的 CDN 节点）。停下来把原因说清楚，
                            # 不要无限重试烧流量。
                            write_status(
                                job_id, status="error",
                                message="源文件一直在变（%s），无法可靠地拼接。"
                                        "请稍后重试，或换一条地址。" % why,
                            )
                            return
                        dropped = True
                        try:
                            os.remove(part)
                        except OSError:
                            pass
                        drop_part_meta(part)
                        resumed = 0
                        # 这句要留着让用户看到：进度会从 0 重来，不给说法等于
                        # 「下载器抽风了」。message 是合并写的，会在 done 时被清掉。
                        write_status(
                            job_id, status="downloading", percent=0, speed="", eta="",
                            file="",
                            message="服务器上的文件变了（%s），之前的断点作废，正在从头重下。"
                                    % why,
                        )
                        continue      # 回到循环顶部，这次不带 Range 重新请求
                    write_part_meta(part, fp)   # 首次补写，或刷新 mtime 无关，图个确定
                else:
                    write_part_meta(part, fp)

                done = resumed
                last_t = time.time()
                last_b = done
                with open(part, mode) as f:
                    while True:
                        if is_cancelled(job_id):
                            write_status(job_id, status="cancelled", err="", message="用户取消")
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

            # ---- 完整性：读到的字节必须等于总长
            #
            # 原来的写法在这里直接 os.replace → 服务器提前关连接时，半截文件会
            # 被报成「完成」，用户点开是坏的（V2 一票否决项）。这里改成判失败
            # 并**保留 .part**，下次点击从断点续，不用从头下。
            if total and done < total:
                # 归 VERIFY_MISMATCH 而不是 NET_TIMEOUT：这是「产物不完整」这个**事实**，
                # 与「网络抖了一下」分开记 —— 统计时才知道是链路问题还是站方提前掐断。
                _give_up(job_id, "VERIFY_MISMATCH",
                         "只收到 %s / %s，断点已保留"
                         % (_fmt_bytes(done), _fmt_bytes(total)))
                return

            os.replace(part, path)
            drop_part_meta(part)
            # 下完统一走验证四层（L2-b）。直链只知道总长，没有清单元数据，
            # 所以 expect 只给 min_bytes；ffprobe 在本机往往没有，没有就只验前三层。
            ok, code, detail, _extra = verify_product(
                path, {"min_bytes": total} if total else {}, ffprobe_tool())
            if not ok:
                try:
                    os.remove(path)
                except OSError:
                    pass
                # 「下到的东西是清单」和「下到半截」是两种建议：
                # 前者重试一百次还是清单，得换一条走分片下载的路径；
                # 后者断点已保留（上面 done<total 的分支已经拦掉大半），再点会续。
                act = errcode.ACT_PLAYLIST if detail == errcode.DETAIL_PLAYLIST else ""
                _give_up(job_id, code, detail, act)
                return
            write_status(job_id, status="done", percent=100, speed="", eta="", file=path,
                         err="", message="")
            return
        except urllib.error.HTTPError as e:
            # HTTP 状态码 → 码表。**重试预算来自码表**（errcode.CODES[码]["attempts"]），
            # 不是这里临时决定的 if 分支 —— 「第几次开始降级」必须是表上的一个数字。
            hdrs = getattr(e, "headers", None)
            code = errcode.classify_http(e.code, hdrs)
            again, delay, why = errcode.plan(code, hdrs, attempt)
            if again:
                # 重试对用户**可见**：不写这一句就变成「默默重试」，用户只看到进度条不动。
                write_status(job_id, status="downloading", err=code,
                             message=errcode.retry_note(code, attempt, delay))
                if not _sleep_watch(job_id, delay):
                    write_status(job_id, status="cancelled", err="", message="用户取消")
                    return
                continue          # 回到顶部：`resumed` 还在，所以续传语义不受影响
            # detail 只在**有额外事实**时才写：码自己的话里已经带了状态码，
            # 再拼一句「HTTP 403」就是「站点拒绝了这个请求（403）（HTTP 403）」。
            # 这不是美观问题：三条路径要给同一句话（T-B5），谁多写一句就不一致了。
            _give_up(job_id, code, why)
            return
        except Exception as e:
            code = errcode.classify_exc(e)
            again, delay, why = errcode.plan(code, None, attempt)
            if again:
                write_status(job_id, status="downloading", err=code,
                             message=errcode.retry_note(code, attempt, delay))
                if not _sleep_watch(job_id, delay):
                    write_status(job_id, status="cancelled", err="", message="用户取消")
                    return
                continue
            # 兜底桶才贴原始异常：已知异常已经有一句人话了，再贴英文只是噪音。
            detail = str(e)[:60] if code == errcode.INTERNAL else ""
            _give_up(job_id, code, detail)
            return


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


def _hls_uri(line):
    """从 #EXT-X-KEY / #EXT-X-MAP 这类标签行里取 URI 属性。

    规范要求带双引号，但站方不总是守规矩：变异测试里试过
    `URI=key.bin`、`URI='key.bin'` 两种写法都能被真实的打包器吐出来。
    只认双引号的话，KEY 拿不到密钥还好（encrypted 一置位就交回 yt-dlp），
    但 **EXT-X-MAP 拿不到 init 段就是坏文件** —— fMP4 分片没有初始化段
    根本没法播，而这条路径是我们自己下载的。
    """
    m = re.search(r'URI\s*=\s*"([^"]*)"', line)
    if m:
        return m.group(1)
    m = re.search(r"URI\s*=\s*'([^']*)'", line)
    if m:
        return m.group(1)
    m = re.search(r"URI\s*=\s*([^,\s]+)", line)
    return m.group(1) if m else ""


def parse_hls_playlist(text, base_url):
    """解析 m3u8，返回：

        kind       "master"（多码率）还是 "media"（分片清单）
        child      master 里**画质最好**的子清单地址（分辨率高优先，其次带宽）
        variants   master 的每一档 [{url, bandwidth, w, h}]
        segments   media 的分片地址（已按 base_url 补成绝对地址）
        init       EXT-X-MAP 的初始化段（fMP4 才需要）
        encrypted  是否有 EXT-X-KEY（METHOD 不是 NONE）
        key_url    密钥地址
        byterange  是否用了 EXT-X-BYTERANGE（自实现不支持，交回 yt-dlp）

    地址补全必须用 urljoin：站方给相对路径（`seg-1.ts`）和站内绝对路径
    （`/abs/seg-2.ts`）都很常见，直接拼字符串会拼出 `.../a/b//abs/...` 这种。

    开头若有 UTF-8 BOM 必须先剥掉：否则首行变成 "\\ufeff#EXTM3U"，不以 "#"
    开头，会被当成**分片地址**去下载（变异测试跑出来的，真机上就是拉回一个
    404 或者一段垃圾塞进文件头）。改过解码为 utf-8-sig 之后这里仍然兜一层，
    因为这个函数是纯函数，谁调都得安全。
    """
    text = (text or "").lstrip("\ufeff")
    info = {
        "kind": "media", "child": "", "segments": [], "init": "",
        "encrypted": False, "key_url": "", "byterange": False,
        "variants": [],
    }
    pending_bw = None
    pending_res = (0, 0)
    for raw in (text or "").splitlines():
        # 行首可能粘着 BOM / 零宽空格：这类字符不是 str.isspace()，strip() 去不掉，
        # 留着会让 "#EXTM3U" 变成 "\ufeff#EXTM3U"，于是被当成一个分片地址。
        ln = raw.strip().lstrip("\ufeff\u200b\u200e\u200f")
        if not ln:
            continue
        if ln.startswith("#"):
            if ln.startswith("#EXT-X-STREAM-INF"):
                info["kind"] = "master"
                m = re.search(r"BANDWIDTH=(\d+)", ln)
                pending_bw = int(m.group(1)) if m else 0
                # RESOLUTION 可能缺（纯音频档、或抠门的站）。缺就当 (0,0)，
                # 排序时自然沉到最后 —— 不硬猜一个假分辨率。
                r = re.search(r"RESOLUTION=(\d+)x(\d+)", ln)
                pending_res = (int(r.group(1)), int(r.group(2))) if r else (0, 0)
            elif ln.startswith("#EXT-X-KEY"):
                m = re.search(r"METHOD=([^,\s]+)", ln)
                method = (m.group(1) if m else "").upper()
                if method and method != "NONE":
                    info["encrypted"] = True
                    uri = _hls_uri(ln)
                    if uri:
                        info["key_url"] = urljoin(base_url, uri)
            elif ln.startswith("#EXT-X-MAP"):
                uri = _hls_uri(ln)
                if uri:
                    info["init"] = urljoin(base_url, uri)
            elif ln.startswith("#EXT-X-BYTERANGE"):
                info["byterange"] = True
            continue
        url = urljoin(base_url, ln)
        if pending_bw is not None:
            info["variants"].append({
                "url": url, "bandwidth": pending_bw,
                "w": pending_res[0], "h": pending_res[1],
            })
            pending_bw = None
            pending_res = (0, 0)
        else:
            info["segments"].append(url)

    if info["variants"]:
        # 默认取**画质最好**那一档：先比分辨率高度，再比带宽。
        #
        # 原来这里是「BANDWIDTH 最大」，两个坑：
        #   · 有的站给高码率的 480p 和低码率的 1080p，纯按带宽排会挑到 480p；
        #   · 同一条清单里可能出现重复档，谁先谁后取决于站方写法。
        # 分辨率才是用户说的「清晰度」，带宽只在同分辨率时做 tie-break。
        info["child"] = pick_variant(info["variants"])["url"]
    return info


def pick_variant(variants, want=None):
    """从 master 的多档里选一档。

    `want` 三种形态，按可靠性排序：
      · 完整 URL（popup 从清单里直接拿到的那条）→ 精确匹配；
      · "1080" / "1080p" / "1920x1080" → 按高度匹配（同一高度取带宽最高）；
      · 空 / None → 画质最好那一档。

    **匹配不到时回落最佳，并把回落写进返回值**（`fell_back`），调用方要把这件事
    告诉用户：用户点了 1080 却拿到 720，却不被告知，比直接报错更糟 ——
    他会以为下对了。

    这个函数是纯的（不碰网络、不碰文件），因为「选哪档」这件事必须能单测。
    """
    if not variants:
        return {"url": "", "bandwidth": 0, "w": 0, "h": 0, "fell_back": False}
    best = max(variants, key=lambda v: (v.get("h") or 0, v.get("bandwidth") or 0))
    want = (want or "").strip() if isinstance(want, str) else ""
    if not want:
        out = dict(best)
        out["fell_back"] = False
        return out

    # 1) 完整 URL
    for v in variants:
        if v.get("url") == want:
            out = dict(v)
            out["fell_back"] = False
            return out

    # 2) 分辨率标记。只认数字，别的一律当没给 —— 站点写的 "HD"/"4K" 没有统一定义，
    #    按它匹配等于碰运气。
    heights = [int(x) for x in re.findall(r"\d+", want)]
    target_h = 0
    if "x" in want.lower() and len(heights) >= 2:
        target_h = heights[1]          # 1920x1080 → 取高度
    elif heights:
        target_h = heights[0]
    if target_h:
        same = [v for v in variants if (v.get("h") or 0) == target_h]
        if same:
            out = dict(max(same, key=lambda v: (v.get("bandwidth") or 0)))
            out["fell_back"] = False
            return out

    out = dict(best)
    out["fell_back"] = True
    return out


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


def _fetch_segment(url, headers, attempts=None, backoff=None, should_stop=None):
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

    `should_stop` 每轮之前问一次：用户点了取消就别再花剩下的重试预算。没有它
    的时候，取消要等在途分片把 3 轮退避跑完，实测量到 **70 秒**才真正停下来。
    命中时抛 `_Cancelled`，由主线程的既有分支统一收尾（删 .part + 写 cancelled）。
    """
    attempts = SEG_ATTEMPTS if attempts is None else max(1, int(attempts))
    backoff = SEG_BACKOFF if backoff is None else float(backoff)
    last = None
    for i in range(attempts):
        if should_stop is not None and should_stop():
            raise _Cancelled()
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

    def bail(code, detail="", act="", take_over=True):
        """写失败码 + 一句人话。

        `take_over=False` 表示「这单不该由我下」（AES / BYTERANGE），
        它**不是失败**，只是换一条路 —— 所以不写错误码。quiet 时连状态都不写，
        免得把下一条路（yt-dlp）的报错冲掉。
        """
        if take_over:
            _give_up(job_id, code, detail, act)
        elif not quiet:
            write_status(job_id, status="error", err="", message=_short(detail, 300))
        return take_over

    # 阶段提示：拉清单 + 解析分片期间界面本来什么都没有（真机 51cg1 现场
    # 这一段之后还要探 4 档请求头，合计能到十几秒）。
    phase = Phase(job_id, "解析播放列表")

    try:
        text = _hls_get(job["url"], headers).decode("utf-8-sig", "replace")
    except urllib.error.HTTPError as e:
        return bail(errcode.classify_http(e.code, getattr(e, "headers", None)))
    except Exception as e:
        code = errcode.classify_exc(e)
        return bail(code, str(e)[:60] if code == errcode.INTERNAL else "")

    base = job["url"]
    notes = []          # 「值得告诉用户、但不该被进度覆盖」的话（如清晰度回落）
    info = parse_hls_playlist(text, base)
    if info["kind"] == "master":
        if not info["variants"]:
            return bail("VERIFY_MISMATCH", "多码率清单里没有子清单")
        # 选哪一档：popup 传的是用户点的那条子清单 URL（"variant"），
        # 没传就取画质最好的。**选中哪档必须写进状态**，否则「选 1080 下到 720」
        # 这种事只能在 ffprobe 里发现。
        pick = pick_variant(info["variants"], job.get("variant"))
        if not pick.get("url"):
            return bail("VERIFY_MISMATCH", "多码率清单里没有可用的子清单")
        base = pick["url"]
        q = ("%dx%d" % (pick["w"], pick["h"])) if pick.get("h") else ""
        if pick.get("fell_back") and job.get("variant"):
            # 用户点的那档已经不在了（地址轮换 / CDN 换了清单）：**说出来**。
            #
            # 写进 notes 而不只是写一次 message：message 随后会被「已拼成视频」
            # 覆盖，而「你选的档没了」是承诺问题，不能一闪而过。所以这里记一份，
            # 收尾时拼进最终文案（测试钉的就是这条）。
            want = str(job.get("variant"))
            short = want.rsplit("/", 1)[-1][:40]
            note = "你选的那一档已经不在这条清单里，改用最好的%s" % ((" " + q) if q else "")
            notes.append(note)
            write_status(job_id, err="", quality=q, message=note)
        else:
            write_status(job_id, err="", quality=q)
        try:
            text = _hls_get(base, headers).decode("utf-8-sig", "replace")
        except urllib.error.HTTPError as e:
            return bail(errcode.classify_http(e.code, getattr(e, "headers", None)))
        except Exception as e:
            code = errcode.classify_exc(e)
            return bail(code, str(e)[:60] if code == errcode.INTERNAL else "")
        info = parse_hls_playlist(text, base)

    if info["encrypted"] or info["byterange"]:
        # 这两种 yt-dlp 处理得比我们好（它能拉密钥、能按 BYTERANGE 取片），
        # 不该抢过来 —— 抢过来只会把「能下」变成「不能下」。
        return bail("", "AES 加密 / BYTERANGE 清单，交回 yt-dlp 处理", take_over=False)
    if not info["segments"]:
        # 空清单的两种可能（地址过期 / 这条流本身没有分片）用户要做的事完全一样：
        # 先刷新页面重抓一次；还这样就是后者。所以建议写全，别让他反复试。
        return bail("VERIFY_MISMATCH", "清单里一个分片都没有",
                    act="刷新页面重新抓一条地址；还这样就是这条流本身没有分片。")

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
    # 探针是最容易被误认为「卡死」的一段：每一档都是一次真实 HTTP，四档串起来
    # 加上服务器慢的时候能到十几秒。换个文案让用户知道现在在试请求头。
    phase.done()
    phase = Phase(job_id, "探测分片请求头（最多 4 档）")
    for hv in _header_variants(headers):
        try:
            first_data = strip_masquerade(_hls_get(segs[0], hv))
            headers = hv
            first_err = None
            break
        except Exception as e:
            first_err = e
    if first_data is None:
        # 四档请求头都试过还取不到第一片 —— 原因就是那个异常本身
        # （403：地址/防盗链；超时：网络）。不再自己编一句「地址有时效」。
        code = errcode.classify_exc(first_err)
        return bail(code, str(first_err)[:60] if code == errcode.INTERNAL else "")
    phase.done()   # 探测结束，后面就由逐片进度接管

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
            return _fetch_segment(segs[i], headers,
                                  should_stop=lambda: is_cancelled(job_id))
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
        write_status(job_id, status="cancelled", err="", percent=0, message="用户取消")
        return True
    except _SegmentFailed as e:
        try:
            os.remove(part)
        except OSError:
            pass
        # 归 SEGMENT_GAP 而不是 VERIFY_MISMATCH：产物一个字节都不完整，
        # 不是「文件内容不对」而是「有一段一直取不到」。事实（第几片、重试几轮、
        # 已下多少）全部进 detail，不再写成一段需要读三遍的长句。
        return bail("SEGMENT_GAP",
                    "第 %d 片重试 %d 轮仍失败，已下 %d/%d"
                    % (e.idx + 1, SEG_ATTEMPTS, done_segs, total))
    except Exception as e:
        try:
            os.remove(part)
        except OSError:
            pass
        code = errcode.classify_exc(e)
        return bail(code, "已下 %d/%d，%s" % (done_segs, total, str(e)[:50])
                    if code == errcode.INTERNAL else "已下 %d/%d" % (done_segs, total))

    if os.path.getsize(ts_path) <= 0:
        return bail("VERIFY_MISMATCH", "拼出来的文件是 0 字节")

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
                # 验证 mp4 产物（四层：存在/非空/非清单/ffprobe 可解析）。
                # 验证要在删 ts **之前**：验证不过时 TS 还能留作退路，删了才查
                # 就等于把唯一的完整文件赌在一个还没验过的 mp4 上。
                finished = finish_verified(
                    job_id, out_mp4, "已拼成完整视频", notes=notes)
                if not finished:
                    return True   # 验证失败，状态已由 finish_verified 写好
                try:
                    os.remove(ts_path)
                except OSError:
                    pass
                return True

    msg = "已拼成完整视频（TS 容器，播放器能直接放）"
    if notes:
        msg += "；" + "；".join(notes)
    if remux_err:
        msg += "；转 mp4 失败：" + remux_err
    finish_verified(job_id, ts_path, msg)
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
            # 双流合并只有一种成立条件：两条流都在。少一条时用户看到的
            # 「合并失败」其实不是合并的问题，是上一步没下全 —— 码用
            # VERIFY_MISMATCH（产物不完整），建议覆盖成「重新下载」。
            # 表里那句「再点一次会重试」在这里是错的：合并任务没有 URL，
            # 再点一次还是同一对（缺一条的）文件。
            _give_up(job_id, "VERIFY_MISMATCH",
                     "音视频流文件缺一个或为空：%s" % os.path.basename(p),
                     act="回页面重新下这条视频，两条流都下完才能合并。")
            return

    ffmpeg = find_tool(["ffmpeg"])
    if not ffmpeg:
        # 「没有」和「有但跑不起来」对用户是同一件事（都合不了），
        # 但对我们完全不同：前者是用户杀软删了 bin/，后者是这个 exe 本身
        # 起不来。detail 里点明是哪种，别再让人猜。
        hit = os.path.join(PROJECT_BIN, "ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        _give_up(job_id, "MISSING_DEP",
                 "bin/ 里那个 ffmpeg 启动即崩，不是缺文件" if os.path.exists(hit)
                 else "项目 bin/ 里没有 ffmpeg")
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

    write_status(job_id, status="merging", percent=0, err="", message="合并音视频", file=out)

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
                write_status(job_id, status="cancelled", err="", message="用户取消合并")
                return
    except Exception as e:
        # 读 ffmpeg 的 stdout 失败，通常是管道被异常关闭 —— 分类交给码表，
        # 但保留原文：这条路径的异常种类不明，detail 是唯一线索。
        _give_up(job_id, errcode.classify_exc(e), ("读取合并输出失败: " + str(e))[:200])
        proc.terminate()
        return

    proc.wait()
    if proc.returncode == 0 and os.path.isfile(out) and os.path.getsize(out) > 0:
        # 合并产物也走验证四层；合并是「音+视频」两条流，期望产物至少带视频轨。
        # 验证要在删源流**之前**：验不过时两条源流还能留着当退路。
        finished = finish_verified(
            job_id, out, "已合并为单文件",
            expect={"tracks": ["video"]} if ffprobe_tool() else {})
        if not finished:
            return
        # 合并成功才删源流；失败/取消一律保留，用户还能自己用 ffmpeg 合
        for p in (video, audio):
            try:
                os.remove(p)
            except OSError:
                pass
    else:
        tail = " ".join(err_tail[-4:])
        # 先看 ffmpeg 那句尾巴能不能对上已知原因（磁盘满 / 编码不支持）；
        # 对不上就是容器层面的搬流失败，归 CODEC_UNSUPPORTED —— 这一路
        # 只做 `-c copy`，不做重编码，失败原因几乎总是「这两条流的封装合不到一起」。
        code = errcode.classify_ytdlp(tail) if tail else errcode.INTERNAL
        if code in (errcode.INTERNAL, "NET_TIMEOUT", "NET_DNS"):
            code = "CODEC_UNSUPPORTED"
        _give_up(job_id, code,
                 ("ffmpeg 退出码 %s：%s" % (proc.returncode, _short(tail, 160))).strip("："),
                 act="视频/音频两个源文件已保留在下载目录，可以换播放器或用别的工具合。")


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
        #
        # **这条刻意不进码表**（T-B6 时特意确认过）：它不是「失败原因」，
        # 而是「这条地址不该被派给外部下载器」—— 属于路由判断。等 T-C5 的规划表
        # 建好，这类地址在 popup 里就不该出现「下载到本地」按钮，连踩都踩不到。
        # 在路由修好之前留一句话，比给它编一个码更诚实。
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
            hls_code = ""
            if looks_like_hls_url(url):
                if run_hls_self(job, quiet=True):
                    st_h = read_status(job_id)
                    # cancelled 也必须停：「用户点了取消」不是「这一路没搞成」，
                    # 继续掉进 yt-dlp 等于取消按钮没作用（真机 1.3.33 冒烟撞到：
                    # 状态被从 cancelled 覆盖成 downloading，目录又开始出现文件）。
                    if st_h.get("status") in ("done", "cancelled"):
                        return
                    hls_msg = st_h.get("message") or ""
                    hls_code = st_h.get("err") or ""

            run_ytdlp(job, ytdlp, ffmpeg)
            # yt-dlp 失败时给一次普通 HTTP 下载的机会：很多「302/403」只是 yt-dlp
            # 的站点识别误判，真正带 cookie/referer 的直连反而能下。
            st = read_status(job_id)
            if st.get("status") == "error":
                ytdlp_msg = st.get("message") or ""
                ytdlp_code = st.get("err") or ""
                run_urllib(job)
                st2 = read_status(job_id)
                if st2.get("status") == "error":
                    # 三条路都失败：对外只留**一个**码、一句话。
                    #
                    # 原来是把三句报错拼成「自实现 HLS: … ／ yt-dlp: … ／ 直连: …」，
                    # 那是写给作者看的，用户拿到一条 200 字的串，还是不知道该干什么。
                    # 现在 code 用 consensus 挑（三条一致就用它，否则挑最具体的一个），
                    # 各自的原话留在 trail 里给诊断包用 —— 人看一句，机器看三条。
                    codes = [hls_code, ytdlp_code, st2.get("err") or ""]
                    code = errcode.consensus(codes)
                    trail = []
                    for label, c, m in (("自实现HLS", hls_code, hls_msg),
                                        ("yt-dlp", ytdlp_code, ytdlp_msg),
                                        ("直连", st2.get("err") or "", st2.get("message") or "")):
                        if c or m:
                            # 有码记码；没码（老调用点 / 测试里的假实现）就记那句话。
                            # 只记「无码」等于把三条路的诊断信息一起丢掉 ——
                            # trail 存在的唯一理由就是「以后能查出是谁的锅」。
                            trail.append("%s=%s" % (label, c or _short(m, 40)))
                    write_status(job_id, status="error", err=code,
                                 message=errcode.describe(code),
                                 trail=" ／ ".join(trail))
        else:
            run_urllib(job)
    except Exception as e:
        _give_up(job_id, errcode.INTERNAL, ("下载进程异常: " + str(e))[:60])

if __name__ == "__main__":
    main()
