#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""S2「输出验证四层」（T-C4）的离线验证。

判据是 PRODUCT-PLAN 的 L2-b：**任一层不过 → 明确错误码，绝不把坏文件当成功**。
这是「下完了打不开」这一整类翻车点的总闸门。

四层（PRODUCT-PLAN 原话）：
  1. 文件存在
  2. 非空（size > 0）
  3. 字节数符合预期 / 内容对（不是清单）
  4. ffprobe 能解析出 expect 轨道、时长偏差 < 2s

本机没有能跑的 ffmpeg/ffprobe（T-E5），所以第 4 层用**假的 subprocess.run**
验证「拿到什么 ffprobe 输出就该怎么判」—— 这不是放宽判据，而是把判据本身
（解析失败的输出 → 红；缺轨道 → 红；时长太短 → 红）抽出来单独钉死，
真 ffprobe 只负责「真跑」，它的输出格式是 ffprobe 的契约，不是我们要测的。

用法： python test/host_verify_test.py
"""
import io
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

import downloader as D  # noqa: E402

TMP = tempfile.mkdtemp(prefix="ms-verify-test-")
JOBS = os.path.join(TMP, "jobs")
os.makedirs(JOBS, exist_ok=True)
D.JOBS_DIR = JOBS
D.status_path = lambda jid: os.path.join(JOBS, jid + ".json")
D.cancel_path = lambda jid: os.path.join(JOBS, jid + ".cancel")
D.DEFAULT_OUT = TMP

ok = True


def check(name, cond, extra=None):
    global ok
    if cond:
        print("PASS", name)
    else:
        ok = False
        print("FAIL", name, "" if extra is None else extra)


def read_status(jid):
    p = os.path.join(JOBS, jid + ".json")
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return {}


def write_bytes(name, data):
    p = os.path.join(TMP, name)
    with open(p, "wb") as f:
        f.write(data)
    return p


def rm(p):
    try:
        os.remove(p)
    except OSError:
        pass


# ---------------------------------------------------------------- 1. 第 1/2 层：存在 + 非空

print("[1] 第 1/2 层：文件存在 / 非空")

check("不存在的文件 → 红 + VERIFY_MISMATCH",
      D.verify_product(os.path.join(TMP, "nope.mp4"))[0] is False)
check("不存在的文件 → code=VERIFY_MISMATCH",
      D.verify_product(os.path.join(TMP, "nope.mp4"))[1] == "VERIFY_MISMATCH")

empty = write_bytes("empty.mp4", b"")
check("0 字节文件 → 红（第 2 层）",
      D.verify_product(empty)[0] is False)
check("0 字节文件 → detail 说 0 字节",
      "0 字节" in D.verify_product(empty)[2])

# 一个合法的假 mp4 头（ftyp）—— 前三层应全过、无 ffprobe 时 ok=True 且 probed=False
good = write_bytes("good.mp4", b"\x00\x00\x00\x20ftypisom" + b"\x00" * 4096)
r = D.verify_product(good)
check("非空真视频（无 ffprobe）→ ok=True", r[0] is True, r)
check("无 ffprobe → extra.probed=False（只做了前三层）", r[3].get("probed") is False, r[3])

# ---------------------------------------------------------------- 2. 第 3 层：内容对（不是清单 / min_bytes）

print("[2] 第 3 层：内容对 / 字节数够")

m3u8 = write_bytes("fake.m3u8", b"#EXTM3U\n#EXTINF:5,\nseg.ts\n")
r = D.verify_product(m3u8)
check("下到的是 m3u8 清单 → 红", r[0] is False)
check("清单 → detail 是 DETAIL_PLAYLIST（供调用方覆盖 act）",
      r[2] == D.errcode.DETAIL_PLAYLIST, r[2])

# 带 BOM 的清单也要认（looks_like_playlist 已处理 BOM，这里锁住「走 verify_product 也拦」）
bom_m3u8 = write_bytes("bom.m3u8", b"\xef\xbb\xbf#EXTM3U\n#EXTINF:5,\nseg.ts\n")
check("带 BOM 的清单 → 也红", D.verify_product(bom_m3u8)[0] is False)

# min_bytes：字节数不够
small = write_bytes("small.mp4", b"\x00\x00\x00\x20ftypisom" + b"\x00" * 100)
r = D.verify_product(small, {"min_bytes": 10 * 1024 * 1024})
check("min_bytes=10MB 而文件只有几百字节 → 红", r[0] is False, r)
check("字节数不够 → detail 带「比预期短」", "比预期短" in r[2], r[2])
check("字节数够 → 过", D.verify_product(good, {"min_bytes": 1024})[0] is True)

# content_sniff 回调：读到的不是这个类型
def sniff_ts(path, size):
    with open(path, "rb") as f:
        if not f.read(4).startswith(b"\x47"):
            return "不是 TS 同步字节"
    return ""

# 不是 TS 的文件（mp4 头）触发回调报错；真 TS 不报
mp4 = write_bytes("x.mp4", b"\x00\x00\x00\x20ftypisom" + b"\x00" * 4096)
check("content_sniff 判「不是这个类型」→ 红",
      D.verify_product(mp4, {"content_sniff": sniff_ts})[0] is False)
check("content_sniff 的返回值进 detail",
      "不是 TS" in D.verify_product(mp4, {"content_sniff": sniff_ts})[2])
ts = write_bytes("x.ts", b"\x47" + b"\x00" * 4096)
check("content_sniff 通过（真 TS）→ 过",
      D.verify_product(ts, {"content_sniff": sniff_ts})[0] is True)

# ---------------------------------------------------------------- 3. 第 4 层：ffprobe（假 subprocess）

print("[3] 第 4 层：ffprobe 解析（假 subprocess.run）")

_real_run = D.subprocess.run
_captured = []


def fake_run(cmd, **kw):
    _captured.append(cmd)
    # cmd = [ffprobe, "-v", "error", "-show_entries", ..., path]
    # 返回一个假的 CompletedProcess，stdout 是 ffprobe 格式
    out = _FFPROBE_OUTPUT
    rc = _FFPROBE_RC
    return _SimpleProc(rc, out, "")


class _SimpleProc:
    def __init__(self, returncode, stdout, stderr):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


# 正常输出：duration=60，有 video + audio 两条流
_FFPROBE_OUTPUT = (
    "duration=60.000000\n"
    "codec_type=video\n"
    "codec_name=h264\n"
    "codec_type=audio\n"
    "codec_name=aac\n"
)
_FFPROBE_RC = 0
D.subprocess.run = fake_run

r = D.verify_product(good, {}, ffprobe="ffprobe-fake")
check("ffprobe 正常解析 → ok=True", r[0] is True, r)
check("extra.probed=True + duration=60", r[3].get("probed") is True and r[3].get("duration") == 60.0, r[3])
check("extra.codecs 有 video+audio", set(r[3].get("codecs", [])) == {"video", "audio"}, r[3])
check("真的把路径传给了 ffprobe", _captured and _captured[-1][-1] == good, _captured[-1] if _captured else None)

# ffprobe 打不开（returncode != 0）
_FFPROBE_RC = 1
check("ffprobe 打不开 → 红", D.verify_product(good, {}, ffprobe="ffprobe-fake")[0] is False)
check("打不开 → detail 说打不开", "打不开" in D.verify_product(good, {}, ffprobe="ffprobe-fake")[2])

# 缺轨道：expect 要 audio，但 ffprobe 只报 video
_FFPROBE_RC = 0
_FFPROBE_OUTPUT = "duration=60.000000\ncodec_type=video\ncodec_name=h264\n"
r = D.verify_product(good, {"tracks": ["video", "audio"]}, ffprobe="ffprobe-fake")
check("expect 要 audio 但只有 video → 红", r[0] is False, r)
check("缺轨道 → detail 说「少了 audio 轨道」", "少了 audio" in r[2], r[2])

# 时长太短：expect.min_duration=100，实际 60
_FFPROBE_OUTPUT = "duration=60.000000\ncodec_type=video\ncodec_name=h264\n"
r = D.verify_product(good, {"min_duration": 100}, ffprobe="ffprobe-fake")
check("min_duration=100 但实际 60s → 红", r[0] is False, r)
check("时长太短 → detail 带「比预期短」", "比预期短" in r[2], r[2])

# 时长够：expect.min_duration=50，实际 60 → 过
r = D.verify_product(good, {"min_duration": 50}, ffprobe="ffprobe-fake")
check("min_duration=50 实际 60s → 过", r[0] is True, r)

# ffprobe 起不来（subprocess 抛异常）→ 不判失败，退回「前三层已过」
def raising_run(cmd, **kw):
    raise OSError("ffprobe 起不来")

D.subprocess.run = raising_run
r = D.verify_product(good, {}, ffprobe="ffprobe-fake")
check("ffprobe 抛异常 → 不判产物坏，前三层已过（ok=True）", r[0] is True, r)
check("起不来 → extra.probed=skipped", r[3].get("probed") == "skipped", r[3])

D.subprocess.run = _real_run

# ---------------------------------------------------------------- 4. finish_verified：统一收尾

print("[4] finish_verified：验证过才写 done，验不过走 _give_up")

D.subprocess.run = fake_run
_FFPROBE_RC = 0
_FFPROBE_OUTPUT = "duration=60.000000\ncodec_type=video\ncodec_name=h264\n"

# 成功的产物 → done + file 指向产物
jid = "v-ok"
finished = D.finish_verified(jid, good, "已下载", notes=["你选的档已换"])
st = read_status(jid)
check("finish_verified 返回 True", finished is True)
check("状态是 done", st.get("status") == "done", st)
check("file 指向产物", st.get("file") == good, st)
check("message 拼了 notes", "你选的档已换" in (st.get("message") or ""), st)

# 坏产物（清单）→ _give_up，状态是 error + 码
jid = "v-bad"
bad = write_bytes("bad.m3u8", b"#EXTM3U\n#EXTINF:5,\nseg.ts\n")
finished = D.finish_verified(jid, bad, "已下载")
st = read_status(jid)
check("坏产物 → finish_verified 返回 False", finished is False)
check("坏产物 → 状态是 error", st.get("status") == "error", st)
check("坏产物 → err=VERIFY_MISMATCH", st.get("err") == "VERIFY_MISMATCH", st)

# act 覆盖：下到清单要换分片路径的建议
jid = "v-act"
finished = D.finish_verified(jid, bad, "已下载", act=D.errcode.ACT_PLAYLIST)
st = read_status(jid)
check("act 覆盖进 message", D.errcode.ACT_PLAYLIST in (st.get("message") or ""), st)

D.subprocess.run = _real_run

# ---------------------------------------------------------------- 汇总

print()
if ok:
    print("结果：全部通过")
    sys.exit(0)
else:
    print("结果：有失败")
    sys.exit(1)
