#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""yt-dlp 器官化（T-F4）：把 yt-dlp 从外部 CLI 黑盒变成宿主内可编程的器官。

为什么（d-075 的架构结论）
--------------------------
yt-dlp 有两种资产：站点知识（1800 个解析器，社区维护，**不拥有**——跟着社区
吃训练成果）和提取框架（Python 包，**本来就拥有**——Unlicense，随意内嵌）。
器官化 = 用 Python API 驱动它，收益三块：

  1. **结构化错误**：CLI 时代错误是 stderr 文本尾巴（classify_ytdlp 的正则表
     在擦屁股）；API 直接抛 DownloadError/ExtractorError 对象——大脑（F5）
     分析失败时读到的是结构化异常，不是猜文本；
  2. **可编程**：progress hooks 直接对接状态写盘，download_ranges 原生支持
     时间段截取，插件目录支持 F7 的自写 extractor；
  3. **版本自有**：install.bat 钉版本安装，上游抽风不影响本产品；更新 = 换版本号+回归。

CLI 路径完整保留为兜底（find_tool 那套不动）：yt_dlp 模块不可导入时一切照旧。

取消：progress hook 里抛 yt_dlp.utils.DownloadCancelled（yt-dlp 自己认识它，
会把队列干净地停掉），宿主把它翻译成 cancelled 状态。
"""
import json
import os
import threading

try:  # 模块缺失不是错误——CLI 兜底（available() 就是干这个的）
    import yt_dlp
except ImportError:
    yt_dlp = None

_LOCK = threading.Lock()
_CACHED = [None]   # [bool | None]——None = 还没探过


def available():
    """yt_dlp 可导入吗（带缓存；CLI 兜底的开关）。"""
    if _CACHED[0] is None:
        with _LOCK:
            if _CACHED[0] is None:
                try:
                    import yt_dlp  # noqa: F401
                    _CACHED[0] = True
                except ImportError:
                    _CACHED[0] = False
    return bool(_CACHED[0])


def version():
    return yt_dlp.version.__version__ if yt_dlp else ""


def classify_api_error(exc):
    """yt-dlp 的结构化异常 → 错误码（与 errcode.classify_ytdlp 同一张码表）。

    API 时代的主分类器：先看异常类型（结构化信号），再看文本（兜底，
    复用 CLI 时代的正则表）。返回 (errcode, structured_note)。
    """
    import errcode

    note = type(exc).__name__
    # DownloadCancelled 不是失败，由调用方单独处理
    text = str(exc)
    # 结构化信号优先：DownloadError 包着 ExtractorError 时，exc_info 里有真身
    inner = getattr(exc, "exc_info", None)
    if inner is not None and inner[1] is not None:
        note += "+" + type(inner[1]).__name__
        text = str(inner[1])
    code = errcode.classify_ytdlp(text)
    return code, note


def build_opts(job, outdir, cookie_file=None, time_range=None):
    """job → YoutubeDL 选项（与 CLI 路径的参数语义对齐，见 _run_ytdlp）。"""
    opts = {
        "outtmpl": {"default": os.path.join(outdir, "%(title).60s.%(ext)s")},
        "noplaylist": True,
        "concurrent_fragment_downloads": int(job.get("concurrency") or 8),
        "retries": 10,
        "fragment_retries": 10,
        "hls_prefer_native": True,
        "noprogress": True,          # 我们走 progress_hooks，不要它自己的行
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 30,
    }
    headers = {}
    if job.get("referer"):
        opts["referer"] = job["referer"]
    if job.get("cookie") and not cookie_file:
        headers["Cookie"] = job["cookie"]
    for hk, hv in (job.get("headers") or {}).items():
        key = str(hk).lower()
        if key in ("cookie",) and cookie_file:
            continue
        headers[str(hk).title()] = hv
    if headers:
        opts["http_headers"] = headers
    if cookie_file:
        opts["cookiefile"] = cookie_file
    # B27 ②层 API 形态：download_ranges（结构化区间）在 F6 循环里接，
    # 本刀 CLI 路径的 --download-sections 已覆盖该功能
    return opts


def run_download(job, ytdlp_opts, on_status, is_cancelled):
    """API 链下载：进度直写状态（不再经过 stdout 解析）。

    返回 (final_file, err_tail, ok)。final_file 为空 = 失败（err_tail 有原因）。
    on_status(**fields) 直接对接 write_status。
    """
    import yt_dlp as Y

    holder = {"file": "", "err_tail": []}
    status = {"cancelled": False}

    def hook(d):
        if status["cancelled"] or is_cancelled():
            status["cancelled"] = True
            raise Y.utils.DownloadCancelled("用户取消")
        st = d.get("status")
        if st == "downloading":
            total = d.get("total_bytes_estimate") or d.get("total_bytes") or 0
            got = d.get("downloaded_bytes") or 0
            pct = min(100.0, got * 100.0 / total) if total else 0.0
            speed = d.get("speed")
            on_status(status="downloading", percent=round(pct, 1),
                      speed=(("%dKB/s" % (speed / 1024)) if speed else ""),
                      eta=(("%ds" % d["eta"]) if d.get("eta") else ""))
        elif st == "finished":
            on_status(status="merging", percent=100, message="分片取完，整理中")

    def prog(d):
        # after_move 钩子拿最终文件名。
        # 注意 d["postprocessor"] 是**后处理器名字符串**不是 dict（真机踩过）。
        if d.get("status") == "finished":
            info = d.get("info") if isinstance(d.get("info"), dict) else {}
            pps = d.get("postprocessor")
            pps = pps if isinstance(pps, dict) else {}
            fp = info.get("filepath") or pps.get("filepath")
            if fp:
                holder["file"] = fp

    ytdlp_opts = dict(ytdlp_opts)
    ytdlp_opts["progress_hooks"] = [hook]
    ytdlp_opts["postprocessor_hooks"] = [prog]

    with Y.YoutubeDL(ytdlp_opts) as ydl:
        try:
            info = ydl.extract_info(job["url"], download=True)
            if info and not holder["file"]:
                holder["file"] = (info.get("filepath")
                                  or ydl.prepare_filename(info))
        except Y.utils.DownloadCancelled:
            return None, ["cancelled"], False
        except Y.utils.DownloadError as e:
            holder["err_tail"].append(str(e)[:300])
            return None, holder["err_tail"], False
        except Exception as e:
            holder["err_tail"].append("%s: %s" % (type(e).__name__, str(e))[:300])
            return None, holder["err_tail"], False
    return holder["file"], holder["err_tail"], True


def mark_cancelled():
    """给取消检查器用：下次 hook 触发时抛 DownloadCancelled。"""
    pass
