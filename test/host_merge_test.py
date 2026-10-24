#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""离线自测：B 站「下载完自动合并」的宿主侧链路。

覆盖三层：
  A. **不需要 ffmpeg 也能验的部分**（2026-10-24 重排：原来这些被 ffmpeg 的
     SKIP 一起带走了，等于本机 ffmpeg 一坏就什么都验不到）
       · 输入缺失 → `VERIFY_MISMATCH`，且建议被覆盖成「重新下载」
       · 缺 ffmpeg → `MISSING_DEP`（不是 INTERNAL：让用户去装东西）
       · `tool_runs()`：存在但启动即崩的 exe 必须判「没有」
  B. run_merge 真实合并（要有能跑的 ffmpeg）：视频-only + 音频-only → 双流 mp4，
     成功后删两条源流；搬流失败保留源流并给 CODEC_UNSUPPORTED。
  C. sniffer_host.py 的 msfile_merge 动作——路径校验（只允许文件存放处里的文件、
     输入必须存在且非空）、job/状态文件是否正确建立（worker 真的被拉起）。

用法： python test/host_merge_test.py
     退出码 0=全过  1=有失败  77=环境不满足（没 ffmpeg），A 段已跑过
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


def place(name, content=b"x"):
    p = os.path.join(TMP, name)
    with open(p, "wb") as f:
        f.write(content)
    return p


def make_streams(dirpath):
    """用项目自带的 ffmpeg 造两段 1 秒的测试流；ffmpeg 不可用时返回 (None, None, None)。"""
    ffmpeg = D.find_tool(["ffmpeg"])
    if not ffmpeg:
        return None, None, None
    video = os.path.join(dirpath, "t-video.mp4")
    audio = os.path.join(dirpath, "t-audio.m4a")
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
        print("（ffmpeg 没有可用视频编码器，B/C 段会跳过）")
        return None, None, None

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


# ================================================================ A. 不需要 ffmpeg

print("[A1] 输入缺失 → VERIFY_MISMATCH（建议覆盖成「重新下载」）")
keep = place("keep.m4a", b"placeholder")
D.run_merge({"id": "merge-missing", "mode": "merge",
             "video": os.path.join(TMP, "不存在-video.mp4"), "audio": keep, "outdir": TMP})
st2 = read_status("merge-missing")
check("状态转为 error", st2.get("status") == "error", st2)
check("错误信息可读", "不存在" in (st2.get("message") or ""), st2.get("message"))
check("没碰另一条源流", os.path.exists(keep))
os.remove(keep)
# 「少一条流」不是合并的问题，是上一步没下全 → VERIFY_MISMATCH，
# 但建议必须覆盖：表里那句「再点一次会重试」在这里是错的（合并任务没有 URL，
# 再点一次还是同一对缺一条的文件）。
check("缺流 → 码是 VERIFY_MISMATCH", st2.get("err") == "VERIFY_MISMATCH", st2.get("err"))
check("缺流 → 建议是「重新下载」不是「再点一次会重试」",
      "重新下" in (st2.get("message") or "") and "会重试" not in (st2.get("message") or ""),
      st2.get("message"))

print("[A2] 缺 ffmpeg → MISSING_DEP（不是 INTERNAL）")
_real_find = D.find_tool
D.find_tool = lambda names: None if "ffmpeg" in names else _real_find(names)
nf_v = place("nf-v.mp4")
nf_a = place("nf-a.m4a")
try:
    D.run_merge({"id": "merge-noffmpeg", "mode": "merge",
                 "video": nf_v, "audio": nf_a, "outdir": TMP})
    st_nf = read_status("merge-noffmpeg")
    check("缺 ffmpeg → 码是 MISSING_DEP", st_nf.get("err") == "MISSING_DEP", st_nf)
    check("缺 ffmpeg → 文案告诉用户去装，不出现英文异常",
          "ffmpeg" in (st_nf.get("message") or "") and "Error" not in (st_nf.get("message") or ""),
          st_nf.get("message"))
    check("缺 ffmpeg → detail 说清是「启动即崩」还是「缺文件」",
          ("启动即崩" in (st_nf.get("message") or "")) or ("没有 ffmpeg" in (st_nf.get("message") or "")),
          st_nf.get("message"))
    check("缺 ffmpeg → 两条源流都留着（没白删）",
          os.path.exists(nf_v) and os.path.exists(nf_a), None)
finally:
    D.find_tool = _real_find

print("[A3] tool_runs：存在但启动即崩 == 没有")
# 造一个「看起来像 exe、其实是垃圾字节」的文件。os.path.exists 会对它说 True，
# 这就是本机 2026-10-24 的现场：项目目录被打了 Low Mandatory Level 标签后，
# bin/ffmpeg.exe 启动即 0xC0000409，而存在性检查高高兴兴放行，
# 最后报给用户的是「ffmpeg 退出码 3221226505，输出为空」。
junk = place("junk.exe", b"MZ" + b"\x00" * 200)
D._TOOL_RUNS.pop(junk, None)
check("垃圾 exe：exists 说在", os.path.exists(junk))
check("垃圾 exe：tool_runs 说跑不起来", D.tool_runs(junk) is False)
check("探测结果被缓存（第二次不再起进程）", junk in D._TOOL_RUNS)

real_ffmpeg = D.find_tool(["ffmpeg"])
check("本机 ffmpeg：find_tool 的结论与 tool_runs 一致",
      (real_ffmpeg is not None) == (bool(D.tool_runs(real_ffmpeg)) if real_ffmpeg else False),
      real_ffmpeg)

# ================================================================ B. 需要真实 ffmpeg

video, audio, ffmpeg = make_streams(TMP)
if not ffmpeg:
    # 退出码 77 = SKIP（automake 约定）。**不能用 0**：run_all 把 0 记成 PASS，
    # 「一条断言都没跑」的套件就会出现在「N/N 通过」里（2026-10-24 教训）。
    print("SKIP B/C 段需要能跑的 ffmpeg；A 段已跑完（上面的 PASS 是真的）")
    print("RESULT:", "A 段通过，B/C 段未验" if ok else "HAS FAILURES")
    sys.exit(77 if ok else 1)

print("[B1] run_merge：真实 ffmpeg 合并")
ffprobe = D.find_tool(["ffprobe"])
check("测试前置：两条源流都在", os.path.getsize(video) > 0 and os.path.getsize(audio) > 0)

D.run_merge({"id": "merge-ok", "mode": "merge", "video": video, "audio": audio,
             "out": "合并成功案例", "outdir": TMP})
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
check("成功时 err 被清空（不残留上一步的码）", st.get("err") in ("", None), st.get("err"))

print("[B2] 搬流失败（输入不是媒体）→ CODEC_UNSUPPORTED，源流都留着")
bad_v = place("bad-v.mp4", b"this is not a video at all\n" * 50)
v_ok, a_ok, _ = make_streams(TMP)
if v_ok and a_ok:
    D.run_merge({"id": "merge-badcodec", "mode": "merge", "video": bad_v,
                 "audio": a_ok, "out": "坏输入", "outdir": TMP})
    st_bad = read_status("merge-badcodec")
    check("搬流失败 → 码是 CODEC_UNSUPPORTED", st_bad.get("err") == "CODEC_UNSUPPORTED", st_bad)
    check("搬流失败 → 保留了 ffmpeg 的原话（诊断用）",
          "ffmpeg" in (st_bad.get("message") or ""), st_bad.get("message"))
    check("搬流失败 → 两条源流都留着（没白下）",
          os.path.exists(bad_v) and os.path.exists(v_ok), None)
    for p in (bad_v, v_ok, a_ok):
        try:
            os.remove(p)
        except OSError:
            pass

# ================================================================ C. msfile_merge

print("[C] msfile_merge：路径校验（起一个真宿主进程喂协议帧）")
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
