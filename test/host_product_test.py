#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""离线自测：`done` 必须落在**真视频**上，不能落在播放列表上。

来自 2026-10-22 23:13 真机（51cg1 第三次下载，见 DEVLOG d-037）。现场状态：

    {"status": "done", "percent": 100,
     "file": ".../<base>",          <- 29,251 字节，内容是 #EXTM3U 清单
     "message": "ERROR:"}           <- 光秃秃一个字面量

而同一个目录里躺着 `<base>.mp4` **170,275,712 字节、首字节 ftyp iso6** —— 真视频。

复盘出的链路（三段互相掩护，任何一段单独看都像"没问题"）：

  1) run_ytdlp 其实**下成了**，但 yt-dlp 在 returncode=0 的情况下打了一行内容为空的
     `ERROR:`；`post_err` 取到它 → 整单被误判失败 → 写 status=error，message="ERROR:"。
  2) main() 看到 error → 兜底 `run_urllib`，把 **m3u8 地址当普通文件下**，
     落盘成 `<base>`（29KB 清单文本）。
  3) run_urllib 成功 → `write_status(status="done", file=<base>)` 没传 message，
     合并式写入把上一步的 "ERROR:" 原样留着。于是 done + "ERROR:" + 清单文件。

结论：`done` 的判据一直是「这一路说自己成功了」，没有任何一处检查
「目录里到底有没有一个真视频」。本测试把这条判据钉成**魔数**。
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

import downloader as D  # noqa: E402

TMP = tempfile.mkdtemp(prefix="ms-product-")
D.JOBS_DIR = TMP
D.status_path = lambda job_id: os.path.join(TMP, job_id + ".json")

results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  -> " + str(extra)))


def fresh(sub):
    d = os.path.join(TMP, sub)
    if os.path.isdir(d):
        shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d, exist_ok=True)
    return d


def w(path, data, size=None):
    """写文件。size 给定时用稀疏填充到该体积，避免测试真的写 170MB。"""
    with open(path, "wb") as f:
        f.write(data)
        if size and size > len(data):
            f.seek(size - 1)
            f.write(b"\0")


MP4_MAGIC = b"\x00\x00\x00\x18ftypiso6\x00\x00\x00\x01"
TS_HEAD = b"\x47" + b"\x00" * 187
PLAYLIST = b"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MAP:URI=\"https://x/y.mp4\"\n" * 400


# ---------------------------------------------------------------- [P1] 魔数判定
def p1():
    d = fresh("p1")
    good_mp4 = os.path.join(d, "a.mp4")
    good_ts = os.path.join(d, "b.ts")
    bad_pl = os.path.join(d, "c")
    tiny = os.path.join(d, "d.mp4")
    w(good_mp4, MP4_MAGIC, size=1024 * 1024)
    w(good_ts, TS_HEAD * 2000)
    w(bad_pl, PLAYLIST)
    w(tiny, MP4_MAGIC)

    f = getattr(D, "is_real_media", None)
    if not f:
        check("[P1] is_real_media 必须存在（done 的判据要按魔数）", False, "函数不存在")
        return
    check("[P1a] mp4（ftyp）判为真视频", f(good_mp4) is True, f(good_mp4))
    check("[P1b] TS（0x47 周期）判为真视频", f(good_ts) is True, f(good_ts))
    check("[P1c] #EXTM3U 清单判为假", f(bad_pl) is False, f(bad_pl))
    check("[P1d] 只有几个字节的 mp4 头判为假（不是完整视频）", f(tiny) is False, f(tiny))
    check("[P1e] 路径不存在判为假", f(os.path.join(d, "nope.mp4")) is False)


# ---------------------------------------------------------------- [P2] 从目录里挑产物
def p2():
    d = fresh("p2")
    base = "job"
    pl = os.path.join(d, base)
    mp4 = os.path.join(d, base + ".mp4")
    w(pl, PLAYLIST)
    w(mp4, MP4_MAGIC, size=8 * 1024 * 1024)
    w(os.path.join(d, "other.mp4"), MP4_MAGIC, size=16 * 1024 * 1024)  # 别的任务

    f = getattr(D, "find_done_product", None)
    if not f:
        check("[P2] find_done_product 必须存在", False, "函数不存在")
        return
    got = f(d, base)
    check("[P2a] 同时有 29KB 清单和真视频时，必须挑真视频", os.path.basename(got) == base + ".mp4", got)
    check("[P2b] 不能挑到别的任务的成片", "other" not in os.path.basename(got), got)

    d2 = fresh("p2b")
    w(os.path.join(d2, base), PLAYLIST)
    check("[P2c] 目录里只有清单时返回空串", f(d2, base) == "", repr(f(d2, base)))


# ---------------------------------------------------------------- [P3] m3u8 不许当文件下
class FakeResp:
    def __init__(self, body, status=200, ctype="application/vnd.apple.mpegurl"):
        self._body = body
        self._off = 0
        self.status = status
        self.headers = {"Content-Length": str(len(body)), "Content-Type": ctype}

    def read(self, n):
        chunk = self._body[self._off:self._off + n]
        self._off += len(chunk)
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def run_urllib_with(body, outdir, job_id="j1", fname="job"):
    D.DEFAULT_OUT = outdir
    job = {"id": job_id, "url": "https://hls.example.com/x.m3u8?auth_key=1",
           "kind": "video", "filename": fname, "outdir": outdir}
    _orig = D.urllib.request.urlopen
    D.urllib.request.urlopen = lambda req, timeout=60: FakeResp(body)
    try:
        D.run_urllib(job)
    finally:
        D.urllib.request.urlopen = _orig
    return D.read_status(job_id)


def p3():
    d = fresh("p3")
    st = run_urllib_with(PLAYLIST, d)
    check("[P3] 把 m3u8 当普通文件下完 → 不能报 done",
          st.get("status") != "done", "status=" + str(st.get("status")))
    check("[P3b] 报错里要说清是「播放列表」不是视频",
          "播放列表" in (st.get("message") or ""), st.get("message"))


# ---------------------------------------------------------------- [P4] 已有真视频就别再下清单
def p4():
    d = fresh("p4")
    w(os.path.join(d, "job.mp4"), MP4_MAGIC, size=8 * 1024 * 1024)
    st = run_urllib_with(PLAYLIST, d, job_id="j4", fname="job")
    check("[P4] 目录里已有真视频时，兜底下清单也必须收成 done", st.get("status") == "done",
          "status=" + str(st.get("status")))
    check("[P4b] 且 file 指向那个真视频",
          os.path.basename(st.get("file") or "") == "job.mp4", st.get("file"))


# ---------------------------------------------------------------- [P5] yt-dlp 的假失败
class FakeProc:
    def __init__(self, lines, rc=0):
        self._lines = list(lines)
        self.returncode = rc
        self.stdout = iter([l + "\n" for l in self._lines])

    def wait(self):
        return self.returncode

    def terminate(self):
        pass


def run_ytdlp_with(lines, rc, outdir, base="job", job_id="j5"):
    D.DEFAULT_OUT = outdir
    job = {"id": job_id, "url": "https://hls.example.com/x.m3u8",
           "kind": "video", "filename": base, "outdir": outdir}
    _orig = D.subprocess.Popen
    D.subprocess.Popen = lambda *a, **k: FakeProc(lines, rc)
    try:
        D.run_ytdlp(job, "yt-dlp", None)
    finally:
        D.subprocess.Popen = _orig
    return D.read_status(job_id)


def p5():
    d = fresh("p5")
    real = os.path.join(d, "job.mp4")
    w(real, MP4_MAGIC, size=8 * 1024 * 1024)
    lines = ["MSPROG| 93.9%|5.58MiB/s|00:05", "FILE:" + real, "ERROR:"]
    st = run_ytdlp_with(lines, 0, d, job_id="j5")
    check("[P5] 退出码 0 + 空内容的 ERROR 行 + 真产物 → 必须 done",
          st.get("status") == "done", "status=" + str(st.get("status")))
    check("[P5b] file 指向真视频", os.path.basename(st.get("file") or "") == "job.mp4", st.get("file"))
    check("[P5c] message 不许留光秃秃的 ERROR", "ERROR" not in (st.get("message") or ""),
          st.get("message"))


# ---------------------------------------------------------------- [P6] 合并写入不许留旧 message
def p6():
    d = fresh("p6")
    jid = "j6"
    D.write_status(jid, status="error", message="ERROR:")
    w(os.path.join(d, "job.mp4"), MP4_MAGIC, size=8 * 1024 * 1024)
    st = run_urllib_with(PLAYLIST, d, job_id=jid, fname="job")
    check("[P6] done 之后不许残留上一段的 error message",
          (st.get("message") or "") == "", repr(st.get("message")))


# ---------------------------------------------------------------- [P7] 无后缀清单要被清掉
def p7():
    d = fresh("p7")
    base = "job"
    bare = os.path.join(d, base)                       # 内容是清单、没有后缀
    real = os.path.join(d, base + ".mp4")              # 真视频
    keep = os.path.join(d, "job2.mp4")                 # 相近名字，不能碰
    w(bare, PLAYLIST)
    w(real, MP4_MAGIC, size=1024 * 1024)
    w(keep, MP4_MAGIC, size=1024 * 1024)
    D.cleanup_ytdlp_junk(d, base)
    check("[P7a] 无扩展名但内容是清单的 <base> 必须被清掉", not os.path.exists(bare), "仍存在")
    check("[P7b] 真视频不许删", os.path.exists(real), "被误删")
    check("[P7c] 名字相近的别的成片不许删", os.path.exists(keep), "被误删")


for fn in (p1, p2, p3, p4, p5, p6, p7):
    try:
        fn()
    except Exception as e:
        check(fn.__name__ + " 执行抛异常", False, repr(e))

fails = results.count(False)
print("\n结果：%d/%d 通过，%d 失败" % (results.count(True), len(results), fails))
print("临时目录:", TMP)
sys.exit(1 if fails else 0)
