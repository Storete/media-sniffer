#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""离线自测：下载前的「准备期」必须有可见反馈。

2026-10-22 真机（51cg1）：22:10:33 写 `percent=0`，**22:12:21** 才第一次跳到 93.9%
—— 近 2 分钟界面一动不动，用户以为卡死，实际在跑两段纯等待：

  1) `run_hls_self` 自己试一遍：拉主清单 → 有子清单再拉一次 → 查加密 →
     第一片当探针，最多试 **4 档请求头组合**，每档一次真实 HTTP
  2) 交回 `run_ytdlp` 后它还要拉清单、解析几百个分片，进度行要到
     **真正开下第一片**才出现

这两段确实估不出百分比，但「还在动」是能给的。所以加一个阶段提示：
写一句「在干什么」，每 2 秒补上「已等 N 秒」。

**关键约束（B16/d-034 的血泪）**：进度一开跑，阶段文案必须立刻消失。
所以 ticker 是**自限的**——每次写之前先读状态，发现 message 已经被别人
改掉（进度刷新清空 / 写了结束态）就自己退出，不需要调用方记得 stop。
忘了 stop 就会复现 d-034：整个下载过程界面上一直挂着「解析播放列表」。
"""
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

import downloader as D  # noqa: E402

TMP = tempfile.mkdtemp(prefix="ms-phase-")
D.JOBS_DIR = TMP
D.status_path = lambda job_id: os.path.join(TMP, job_id + ".json")
D.PHASE_TICK = 0.05          # 测试里把节拍踩快，别真等 2 秒

results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  -> " + str(extra)))


def msg(jid):
    return D.read_status(jid).get("message") or ""


# ---------------------------------------------------------------- [T1] 阶段提示本身
def t1():
    cls = getattr(D, "Phase", None)
    if not cls:
        check("[T1] Phase 必须存在（准备期要有可见反馈）", False, "类不存在")
        return
    jid = "t1"
    ph = cls(jid, "解析播放列表")
    check("[T1a] 建立时立刻把阶段文案写进状态", msg(jid) == "解析播放列表", msg(jid))
    check("[T1b] 状态是 downloading", D.read_status(jid).get("status") == "downloading",
          D.read_status(jid).get("status"))
    time.sleep(D.PHASE_TICK * 4)
    m = msg(jid)
    check("[T1c] 计时器要补上「已等 N 秒」，让用户看见还在动", "已等" in m, m)
    ph.done()


# ---------------------------------------------------------------- [T2] 别人改了 message 就闭嘴
def t2():
    cls = getattr(D, "Phase", None)
    if not cls:
        check("[T2] Phase 不存在", False)
        return
    jid = "t2"
    ph = cls(jid, "yt-dlp 解析清单")
    time.sleep(D.PHASE_TICK * 2)
    D.write_progress(jid, 12.5, "3MiB/s", "00:30")   # 进度开跑：message 被清空
    time.sleep(D.PHASE_TICK * 6)
    m = msg(jid)
    check("[T2] 进度开始后阶段文案必须停（否则复现「全程挂着解析播放列表」）",
          m == "", repr(m))
    check("[T2b] 而且不许把进度写回 0", D.read_status(jid).get("percent") == 12.5,
          D.read_status(jid).get("percent"))
    ph.done()


# ---------------------------------------------------------------- [T3] 结束态也让它闭嘴
def t3():
    cls = getattr(D, "Phase", None)
    if not cls:
        check("[T3] Phase 不存在", False)
        return
    jid = "t3"
    ph = cls(jid, "探测请求头 1/4")
    time.sleep(D.PHASE_TICK * 2)
    D.write_status(jid, status="done", percent=100, file="x.mp4", message="")
    time.sleep(D.PHASE_TICK * 6)
    check("[T3] 写完 done 之后不许再被阶段文案覆盖", msg(jid) == "", repr(msg(jid)))
    check("[T3b] status 保持 done", D.read_status(jid).get("status") == "done",
          D.read_status(jid).get("status"))
    ph.done()


# ---------------------------------------------------------------- [T4] run_ytdlp 的解析期
class SlowProc:
    """按 (延迟, 行) 逐行吐输出，模拟「解析很久才出第一行进度」"""

    def __init__(self, steps, rc=0):
        self._steps = steps
        self.returncode = rc
        self.stdout = self._gen()

    def _gen(self):
        for delay, line in self._steps:
            time.sleep(delay)
            yield line + "\n"

    def wait(self):
        return self.returncode

    def terminate(self):
        pass


def t4():
    d = os.path.join(TMP, "t4out")
    os.makedirs(d, exist_ok=True)
    real = os.path.join(d, "job.mp4")
    with open(real, "wb") as f:
        f.write(b"\x00\x00\x00\x18ftypiso6\x00\x00\x00\x01")
        f.seek(1024 * 1024 - 1)
        f.write(b"\0")

    jid = "t4"
    seen = []
    _orig_ws = D.write_status

    def spy(job_id, **fields):
        if job_id == jid and fields.get("message"):
            seen.append(fields["message"])
        return _orig_ws(job_id, **fields)

    D.write_status = spy
    _orig_popen = D.subprocess.Popen
    D.subprocess.Popen = lambda *a, **k: SlowProc([
        (0.0, "FILE:" + real),
        (D.PHASE_TICK * 6, "MSPROG| 12.0%|3MiB/s|00:30"),
        (D.PHASE_TICK * 6, "MSPROG|100.0%|0|00:00"),
    ])
    job = {"id": jid, "url": "https://x/y.m3u8", "kind": "video", "filename": "job", "outdir": d}
    try:
        D.run_ytdlp(job, "yt-dlp", None)
    finally:
        D.write_status = _orig_ws
        D.subprocess.Popen = _orig_popen

    check("[T4a] yt-dlp 解析期必须写出阶段文案（不能一片死寂）",
          any("yt-dlp" in s for s in seen), seen[:3])
    st = D.read_status(jid)
    check("[T4b] 跑完 message 为空（阶段文案不许残留）", (st.get("message") or "") == "",
          repr(st.get("message")))
    check("[T4c] 且状态是 done", st.get("status") == "done", st.get("status"))


for fn in (t1, t2, t3, t4):
    try:
        fn()
    except Exception as e:
        check(fn.__name__ + " 执行抛异常", False, repr(e))

fails = results.count(False)
print("\n结果：%d/%d 通过，%d 失败" % (results.count(True), len(results), fails))
sys.exit(1 if fails else 0)
