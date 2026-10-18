#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""统一的「文件存放处」定位。

为什么单独一份：
  sniffer_host.py（写盘）和 downloader.py（yt-dlp / urllib）都各自需要知道
  下载目录，以前两边各写一份 `~/Downloads/MediaSniffer`，改一处漏一处。

规则（按优先级）：
  1. 环境变量 MEDIA_SNIFFER_OUTDIR（方便临时指定/迁移）
  2. 按候选顺序取第一个「已存在或父目录可写（能建出来）」的目录
  3. 兜底 %LOCALAPPDATA%/MediaSniffer/downloads

注意第 2 条是「存在或可建」合一轮判定，不是「先扫一遍已存在、再扫一遍可建」：
  分两轮的话，C 盘上被旧版本建出来的目录（~/Downloads/MediaSniffer）永远压过
  「父目录可写、可以新建」的 D 盘首选目录，违背「文件尽量别放 C 盘」的要求。

默认首选 D:/软件应用/DSH/文件存放处，与用户「文件尽量别放 C 盘」的要求一致。
"""
import os

ENV_KEY = "MEDIA_SNIFFER_OUTDIR"

CANDIDATES = [
    r"D:\软件应用\DSH\文件存放处",
    r"D:\软件应用\DSH\文件存放处\MediaSniffer",
    os.path.join(os.path.expanduser("~"), "Downloads", "MediaSniffer"),
]

APP_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "MediaSniffer")
FALLBACK = os.path.join(APP_DIR, "downloads")


def _writable_dir(path):
    """父目录存在且能写 = 这个目录可以被创建出来"""
    parent = os.path.dirname(path.rstrip("/"))
    while parent and not os.path.isdir(parent):
        nxt = os.path.dirname(parent)
        if nxt == parent:
            return False
        parent = nxt
    return bool(parent) and os.access(parent, os.W_OK)


def library_dir(create=True):
    env = (os.environ.get(ENV_KEY) or "").strip()
    if env:
        d = env
    else:
        d = None
        for c in CANDIDATES:
            if os.path.isdir(c) or _writable_dir(c):
                d = c
                break
        if not d:
            d = FALLBACK
    if create:
        try:
            os.makedirs(d, exist_ok=True)
        except OSError:
            d = FALLBACK
            os.makedirs(d, exist_ok=True)
    return d


def default_library_dirs():
    return list(CANDIDATES)
