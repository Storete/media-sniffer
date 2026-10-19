#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""宿主侧输入校验：文件名、任务 id、下载目录。

这几条都是「页面能控制、但会变成磁盘路径」的输入。任何一条漏了，
都等于把本地文件系统的写入位置交给网页。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "native-host"))

import sniffer_host as host       # noqa: E402
import downloader as dl           # noqa: E402

passed = 0
failed = 0


def check(name, cond, extra=None):
    global passed, failed
    if cond:
        passed += 1
        print("  \u2713 " + name)
    else:
        failed += 1
        print("  \u2717 " + name + (("  -> " + repr(extra)) if extra is not None else ""))


print("[1] _safe_name：Windows 上真正会失败的名字")
check("普通名字不变", host._safe_name("视频 1.mp4") == "视频 1.mp4")
check("路径被剥掉", host._safe_name("../../etc/passwd") == "passwd", host._safe_name("../../etc/passwd"))
check("反斜杠按路径处理", host._safe_name(r"C:\Windows\a.mp4") == "a.mp4", host._safe_name(r"C:\Windows\a.mp4"))
check("非法字符替换", "/" not in host._safe_name('a<b>c.mp4') and "<" not in host._safe_name("a<b>.mp4"))
check("空名兜底", host._safe_name("").startswith("media-"))
check("结尾点被去掉", not host._safe_name("abc...").endswith("."), host._safe_name("abc..."))
for reserved in ("CON", "con.txt", "NUL.mp4", "COM1", "lpt9.mkv", "aux"):
    got = host._safe_name(reserved)
    check("保留名 %-9s 被改写" % reserved, got.upper() != reserved.upper() and got.upper().startswith("_"),
          got)
check("长度截断到 150", len(host._safe_name("中" * 400)) == 150)

print("[2] _safe_job_id：id 会被拼进文件名")
check("正常 id 通过", host._safe_job_id("dl-1_abc-2") == "dl-1_abc-2")
check("路径穿越被拒", host._safe_job_id("../../evil") == "")
check("斜杠被拒", host._safe_job_id("a/b") == "")
check("空值被拒", host._safe_job_id("") == "")
check("超长被拒", host._safe_job_id("a" * 81) == "")

print("[3] _safe_outdir：下载目录不许越界")
check("空值回落到默认目录", host._safe_outdir("") == "")
outside = os.path.abspath(os.path.join(os.path.dirname(HERE), "..", ".."))
check("目录外路径被拒", host._safe_outdir(outside) == "", outside)

print("[4] downloader 的状态文件路径")
check("正常 id 拼出路径", dl.status_path("dl-1").endswith("dl-1.json"))
bad = False
try:
    dl.status_path("../../evil")
except ValueError:
    bad = True
check("路径穿越抛 ValueError", bad)
bad_cancel = False
try:
    dl.cancel_path("a/b")
except ValueError:
    bad_cancel = True
check("取消标记同样校验", bad_cancel)

print("[5] _safe_headers：下载时重放的请求头")
h = host._safe_headers({
    "Referer": "https://a.com/p",
    "origin": "https://a.com",
    "accept": "*/*",
    "accept-language": "zh-CN",
    "user-agent": "UA/1",
    "cookie": "SID=secret",
    "Authorization": "Bearer x",
    "x-custom": "1",
})
check("只保留 5 个白名单头", len(h) == 5, h)
check("键名小写", h.get("referer") == "https://a.com/p")
check("Cookie 被丢弃", "cookie" not in h)
check("Authorization 被丢弃", "authorization" not in h)
check("自定义头被丢弃", "x-custom" not in h)
check("CRLF 注入被拒", "referer" not in host._safe_headers({"referer": "a\r\nX: 1"}))
check("超长值被拒", "accept" not in host._safe_headers({"accept": "a" * 400}))
check("非字典返回空", host._safe_headers("not-a-dict") == {})
check("None 返回空", host._safe_headers(None) == {})

print("[6] do_download：请求头真的落进 job 文件（端到端）")
import json      # noqa: E402
import tempfile  # noqa: E402

tmp = tempfile.mkdtemp(prefix="ms-job-test-")
host.JOBS_DIR = tmp
sent = []
host.send = lambda obj: sent.append(obj)          # 不往 stdout 写协议帧
host._spawn_worker = lambda job_file: None        # 不真的起下载进程
host.poll_job = lambda job_id: None               # 不轮询

host.do_download({
    "id": "dl-test-1",
    "url": "https://cdn.example.com/v.mp4",
    "kind": "video",
    "filename": "v.mp4",
    "headers": {"referer": "https://a.com/p", "cookie": "SID=x", "origin": "https://a.com"},
    "outdir": "",
})
job_file = os.path.join(tmp, "dl-test-1.job.json")
check("job 文件已写出", os.path.exists(job_file))
saved = json.load(open(job_file, encoding="utf-8")) if os.path.exists(job_file) else {}
check("请求头白名单生效（cookie 不进 job）",
      saved.get("headers") == {"referer": "https://a.com/p", "origin": "https://a.com"}, saved.get("headers"))
check("http 地址被受理", not any(s.get("status") == "error" for s in sent), sent)

sent.clear()
host.do_download({"id": "dl-test-2", "url": "file:///etc/passwd", "headers": {}})
check("非 http 地址被拒", any(s.get("status") == "error" for s in sent), sent)

sent.clear()
host.do_download({"id": "../../evil", "url": "https://a.com/v.mp4"})
check("非法 id 被拒", any(s.get("status") == "error" for s in sent), sent)

print("[7] ytdlp_header_args：同名头不重复、大小写正确")
import downloader as _dl  # noqa: E402,F811

args = _dl.ytdlp_header_args({
    "referer": "https://a.com/p",
    "cookie": "SID=x",
    "tabUrl": "https://a.com/watch",
    "headers": {
        "origin": "https://a.com",
        "accept": "*/*",
        "user-agent": "UA/1",
        "referer": "https://should-be-ignored",
    },
})
check("带 --referer", "--referer" in args)
check("Referer 头没有被重复加", not any(str(x).lower().startswith("referer:") for x in args), args)
check("Origin 只出现一次", sum(1 for x in args if str(x).startswith("Origin:")) == 1, args)
check("Origin 取真实值", "Origin:https://a.com" in args, args)
check("Accept 头大小写正确", "Accept:*/*" in args, args)
check("User-Agent 大小写正确", "User-Agent:UA/1" in args, args)

fallback = _dl.ytdlp_header_args({"tabUrl": "https://b.com/x", "headers": {}})
check("没有真实 Origin 时从 tabUrl 推导", "Origin:https://b.com" in fallback, fallback)

print("\n==============================================")
print("通过 %d 项，失败 %d 项" % (passed, failed))
sys.exit(1 if failed else 0)
