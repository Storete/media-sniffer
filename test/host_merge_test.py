#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""离线自测：B 站「下载完自动合并」的宿主侧链路。

覆盖两层：
  1. sniffer_host.py 的 msfile_merge 动作——路径校验（只允许文件存放处里的文件、
     输入必须存在且非空）、job 文件 / 状态文件是否正确建立（worker 真的被拉起）。
  2. downloader.py 的 run_merge——用真实 ffmpeg 把「视频-only mp4 + 音频 m4a」
     合成一个双流 mp4，成功后删除两条源流；输入缺失时给出可读错误且不删源流。

用法： python test/host_merge_test.py
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NH = os.path.join(ROOT, "native-host")
PY = sys.executable
sys.path.insert(0, NH)


def _no_window():
    """POSIX 上传 creationflags 会 ValueError，只有 Windows 需要这个参数。"""
    return {"creationflags": 0x08000000} if os.name == "nt" else {}

TMP = tempfile.mkdtemp(prefix="ms-merge-test-")
JOBS = os.path.join(TMP, "jobs")
os.makedirs(JOBS, exist_ok=True)

import sniffer_host as H  # noqa: E402
import downloader as D    # noqa: E402

H._download_dir = lambda: TMP
H.JOBS_DIR = JOBS
H.status_file = lambda jid: os.path.join(JOBS, jid + ".json")
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
    if not os.path.exists(p):
        return {}
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return {}


def make_streams(dirpath):
    """用项目自带的 ffmpeg 造两段 1 秒的测试流，返回 (video, audio, ffmpeg) 路径。"""
    ffmpeg = D.find_tool(["ffmpeg"])
    if not ffmpeg:
        print("SKIP 没找到 ffmpeg，跑不了真实合并（bin/ 目录缺失？）")
        sys.exit(0)
    video = os.path.join(dirpath, "t-video.mp4")
    audio = os.path.join(dirpath, "t-audio.m4a")
    # POSIX 上传 creationflags 会 ValueError，只有 Windows 需要
    cf = _no_window()

    def make_video(codec):
        return subprocess.run(
            [ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=10",
             "-c:v", codec, "-pix_fmt", "yuv420p", video],
            capture_output=True, **cf)

    # 精简版 ffmpeg（很多 Linux 发行版/容器）没有 libx264，退回 mpeg4。
    # 这个测试验的是「合并流程」，编码器不是被测对象，有能用的就行。
    r = make_video("libx264")
    if r.returncode != 0:
        r = make_video("mpeg4")
    if r.returncode != 0:
        print("SKIP ffmpeg 没有可用的视频编码器（libx264/mpeg4 都失败）")
        print((r.stderr or b"")[-400:].decode("utf-8", "replace"))
        sys.exit(0)

    subprocess.run(
        [ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
         "-c:a", "aac", audio],
        check=True, capture_output=True, **cf)
    return video, audio, ffmpeg


def probe_streams(ffprobe, path):
    out = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", path],
        capture_output=True, text=True, **_no_window())
    try:
        data = json.loads(out.stdout)
    except Exception:
        return []
    return [s.get("codec_type") for s in data.get("streams", [])]


# ---------------------------------------------------------------- 1) run_merge 真实合并

print("[1] run_merge：真实 ffmpeg 合并")
video, audio, ffmpeg = make_streams(TMP)
ffprobe = D.find_tool(["ffprobe"])
check("测试前置：两条源流都在", os.path.getsize(video) > 0 and os.path.getsize(audio) > 0)

job = {"id": "merge-ok", "mode": "merge", "video": video, "audio": audio,
       "out": "合并成功案例", "outdir": TMP}
D.run_merge(job)
st = read_status("merge-ok")
merged = st.get("file") or ""
check("状态转为 done", st.get("status") == "done", st)
check("产物存在且非空", os.path.isfile(merged) and os.path.getsize(merged) > 0, merged)
check("产物文件名用了 out 参数", os.path.basename(merged) == "合并成功案例.mp4", os.path.basename(merged))
if ffprobe and merged:
    kinds = probe_streams(ffprobe, merged)
    check("产物含视频流", "video" in kinds, kinds)
    check("产物含音频流", "audio" in kinds, kinds)
check("成功后删除两条源流", not os.path.exists(video) and not os.path.exists(audio))

# ---------------------------------------------------------------- 2) run_merge 输入缺失

print("[2] run_merge：输入缺失")
# 第 1 段成功时把两条源流都删了；这里造个占位文件当「不该被碰的输入」
keep = os.path.join(TMP, "keep.m4a")
open(keep, "wb").write(b"placeholder")
job2 = {"id": "merge-missing", "mode": "merge",
        "video": os.path.join(TMP, "不存在-video.mp4"), "audio": keep, "outdir": TMP}
D.run_merge(job2)
st2 = read_status("merge-missing")
check("状态转为 error", st2.get("status") == "error", st2)
check("错误信息可读", "不存在" in (st2.get("message") or ""), st2.get("message"))
check("没碰另一条源流", os.path.exists(keep))
os.remove(keep)  # 清场，别影响下一段

# ---------------------------------------------------------------- 3) msfile_merge 路径校验

print("[3] msfile_merge：路径校验（起一个真宿主进程喂协议帧）")
proc = subprocess.Popen(
    [PY, "-c",
     "import sys; sys.path.insert(0, r'%s'); import sniffer_host as h; "
     "h._download_dir = lambda: r'%s'; h.JOBS_DIR = r'%s'; h.main()" % (NH, TMP, JOBS)],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
)


def send(obj):
    data = json.dumps(obj).encode()
    proc.stdin.write(struct.pack("<I", len(data)) + data)
    proc.stdin.flush()
    return recv()


def recv():
    raw = proc.stdout.read(4)
    if len(raw) < 4:
        raise SystemExit("宿主没有回应")
    (n,) = struct.unpack("<I", raw)
    return json.loads(proc.stdout.read(n).decode())


v2, a2, _ = make_streams(TMP)

r = send({"id": "m1", "action": "msfile_merge",
          "video": r"C:\Windows\win.ini", "audio": a2})
check("拒绝文件存放处以外的路径", r.get("ok") is False and "文件存放处" in (r.get("error") or ""), r)

r = send({"id": "m2", "action": "msfile_merge",
          "video": os.path.join(TMP, "nope.mp4"), "audio": a2})
check("拒绝不存在的输入", r.get("ok") is False and ("不存在" in (r.get("error") or "") or "为空" in (r.get("error") or "")), r)

r = send({"id": "m3", "action": "msfile_merge", "video": v2, "audio": a2, "out": "桥接合并"})
check("合法输入被受理（inProgress）", r.get("ok") is True and r.get("inProgress") is True, r)
# 这里拉起的是**真实** detached worker：它的状态文件写在真实 %LOCALAPPDATA%（测不到），
# 但产物落在 job["outdir"] = 临时目录，源流成功后会被删——直接轮询这两个就够了
out_file = os.path.join(TMP, "桥接合并.mp4")
deadline = time.time() + 60
while time.time() < deadline:
    if os.path.isfile(out_file) and os.path.getsize(out_file) > 0:
        break
    time.sleep(0.5)
check("桥接发起的合并也真的合并完成", os.path.isfile(out_file) and os.path.getsize(out_file) > 0)
check("产物落在文件存放处（临时目录）", os.path.isfile(out_file), out_file)
# 源流删除发生在**产物落盘之后**：worker 的 done 状态要等 ffmpeg 退出、
# 写完成状态、再 unlink 两条源流。只看产物就断言「源流已删」会偶发失败
# （实测 8 次并发跑过一次 FAIL，单跑必过）——这里给 unlink 留 10 秒窗口。
_dl = time.time() + 10
while time.time() < _dl and (os.path.exists(v2) or os.path.exists(a2)):
    time.sleep(0.2)
check("worker 成功后同样删除源流", not os.path.exists(v2) and not os.path.exists(a2),
      {"video": os.path.exists(v2), "audio": os.path.exists(a2)})

proc.stdin.close()
try:
    proc.wait(timeout=5)
except Exception:
    proc.kill()

# 清理真实状态目录里这个测试任务留下的痕迹（worker 的状态/取消标记）
_real_jobs = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "MediaSniffer", "jobs")
for _f in ("m3.json", "m3.job.json", "m3.cancel"):
    _p = os.path.join(_real_jobs, _f)
    if os.path.exists(_p):
        try:
            os.remove(_p)
        except OSError:
            pass

print("RESULT:", "ALL PASS" if ok else "HAS FAILURES")
sys.exit(0 if ok else 1)
