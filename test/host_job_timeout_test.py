#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""宿主「任务超时」这条收尾路径（T-B6 的后半）。

为什么单独测它：`poll_job` 最多等 6 小时，超时后原来只 `send({"message": "任务超时"})` ——

  · 没有错误码，popup 的「为什么失败」那一行永远是空的；
  · **状态文件还停在 `downloading 37%`**。宿主已经放弃轮询、下载进程还挂着，
    用户下次打开 popup 看到的是「还在下」。两边对同一件事的认知不一致，
    比两边都错更难查（d-055 那条 err 断链就是同一个病）。

本套件锁四件事：
  1. 超时后状态文件被改成 error + JOB_TIMEOUT（不是什么都不写）；
  2. 发出去的消息带 err，且文案是人话（不是「任务超时」四个字）；
  3. 已经 done / cancelled 的任务不被超时逻辑反向覆盖；
  4. 6 小时这个数字**可配**（MS_JOB_TIMEOUT）—— 不可配的超时等于不可测的超时。

用法： python test/host_job_timeout_test.py
"""
import json
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

TMP = tempfile.mkdtemp(prefix="ms-timeout-test-")
JOBS = os.path.join(TMP, "jobs")
os.makedirs(JOBS, exist_ok=True)

import sniffer_host as H  # noqa: E402
import errcode as E       # noqa: E402

H.JOBS_DIR = JOBS
H.status_file = lambda jid: os.path.join(JOBS, jid + ".json")

ok = True


def check(name, cond, extra=None):
    global ok
    if cond:
        print("PASS", name)
    else:
        ok = False
        print("FAIL", name, "" if extra is None else extra)


def write_job(jid, **fields):
    p = os.path.join(JOBS, jid + ".json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(fields, f, ensure_ascii=False)


def read_job(jid):
    p = os.path.join(JOBS, jid + ".json")
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return {}


# ---------------------------------------------------------------- 1. 码本身
print("[1] JOB_TIMEOUT 这个码")

check("JOB_TIMEOUT 在码表里", E.known("JOB_TIMEOUT"))
check("JOB_TIMEOUT 允许重试（换条地址就可能好）", E.retryable("JOB_TIMEOUT") is True)
line = E.describe("JOB_TIMEOUT", "等了 6 小时仍未结束")
check("文案是一句人话，不是「任务超时」四个字", len(line) >= 12, line)
check("文案点明「跑太久」而不是甩锅网络", "太久" in line or "时间" in line, line)
check("文案不出现英文异常名", "Error" not in line and "Timeout" not in line, line)

# ---------------------------------------------------------------- 2. mark_timeout
print("[2] mark_timeout：把「宿主放弃了」写进状态文件")

write_job("t-downloading", status="downloading", percent=37.5, speed="1.2 MB/s",
          eta="120s", file="", message="", err="")
code, msg = H.mark_timeout("t-downloading", 6 * 3600)
st = read_job("t-downloading")
check("返回码是 JOB_TIMEOUT", code == "JOB_TIMEOUT", code)
check("返回的文案与状态文件一致", msg == st.get("message"), (msg, st.get("message")))
check("状态被改成 error", st.get("status") == "error", st)
check("err 字段被写上（popup 靠它分类）", st.get("err") == "JOB_TIMEOUT", st.get("err"))
check("文案说清等了多久", "6 小时" in (st.get("message") or ""), st.get("message"))
check("进度留在原地（不假装 0% 也不假装 100%）", st.get("percent") == 37.5, st.get("percent"))
check("速度/ETA 被清空（已经不跑了，留着是撒谎）",
      (st.get("speed") or "") == "" and (st.get("eta") or "") == "", st)

# 分钟级也要能说清
write_job("t-minutes", status="downloading", percent=1, speed="", eta="", message="", err="")
H.mark_timeout("t-minutes", 90)
check("不足 1 小时时用分钟表述", "分钟" in (read_job("t-minutes").get("message") or ""),
      read_job("t-minutes").get("message"))

# ---------------------------------------------------------------- 3. 不覆盖终态
print("[3] 已经结束的任务不许被反向覆盖")

for jid, stt in (("t-done", "done"), ("t-cancelled", "cancelled"), ("t-err", "error")):
    write_job(jid, status=stt, percent=100, message="原消息", err="HTTP_403")
    H.mark_timeout(jid, 6 * 3600)
    got = read_job(jid)
    check("%s 的状态没被改" % stt, got.get("status") == stt, got)
    check("%s 的原错误码没被改" % stt, got.get("err") == "HTTP_403", got.get("err"))
    check("%s 的原消息没被改" % stt, got.get("message") == "原消息", got.get("message"))

# ---------------------------------------------------------------- 4. poll_job 端到端
print("[4] poll_job：超时后扩展真的收到 err")

sent = []
_real_send = H.send
H.send = lambda obj: sent.append(obj) or True
try:
    write_job("t-poll", status="downloading", percent=12, speed="", eta="", file="", message="", err="")
    t0 = time.time()
    # 1 秒就能等到，说明 MS_JOB_TIMEOUT 那条路真的被读到了
    os.environ["MS_JOB_TIMEOUT"] = "1"
    H.poll_job("t-poll")
    dt = time.time() - t0
finally:
    H.send = _real_send
    os.environ.pop("MS_JOB_TIMEOUT", None)

last = sent[-1] if sent else {}
check("poll_job 在 1 秒左右返回（环境变量生效）", dt < 6, "%.1fs" % dt)
check("最后一条消息是 error", last.get("action") == "error" and last.get("status") == "error", last)
check("最后一条消息带 err=JOB_TIMEOUT", last.get("err") == "JOB_TIMEOUT", last.get("err"))
check("最后一条消息带人话文案", len(last.get("message") or "") >= 12, last.get("message"))
check("状态文件也同步改了（两端认知一致）",
      read_job("t-poll").get("status") == "error" and read_job("t-poll").get("err") == "JOB_TIMEOUT",
      read_job("t-poll"))
check("中途至少推过一次 progress（不是一声不响等 6 小时）",
      any(m.get("action") == "progress" for m in sent), [m.get("action") for m in sent])

print("RESULT:", "ALL PASS" if ok else "HAS FAILURES")
sys.exit(0 if ok else 1)
