#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""解释库（T-C7）宿主接线的测试：失败记账 + 站点级建议的持久化闭环。

纯函数层（`knowledge.py` 的阈值/归一化/失败模式表）在 `host_knowledge_test.py` 里测，
这里测**接线**：失败真的记进 `failures.jsonl`、跨任务累计、以及 `poll_job` 在
失败收尾时把「同站+同码 ≥3 次」的建议附到发给扩展的消息里。

判据（PRODUCT-PLAN L4）：同站失败 3 次自动出建议 —— 这里的「自动」就落在
`poll_job` 这一跳：worker 写 error 状态 → 宿主轮询看到 → 记账 + 查建议 → 拼进消息。

用法： python test/host_knowledge_host_test.py
"""
import json
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

TMP = tempfile.mkdtemp(prefix="ms-khost-test-")
JOBS = os.path.join(TMP, "jobs")
os.makedirs(JOBS, exist_ok=True)

import sniffer_host as H  # noqa: E402

H.JOBS_DIR = JOBS
H.status_file = lambda jid: os.path.join(JOBS, jid + ".json")
H.FAILURES_FILE = os.path.join(TMP, "failures.jsonl")

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


def write_jobdef(jid, **fields):
    p = os.path.join(JOBS, jid + ".job.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(fields, f, ensure_ascii=False)


# ---------------------------------------------------------------- 1. append_failure / load_failures

print("[1] 失败记账：跨任务持久化")

check("初始无失败日志 → 空", H.load_failures() == [])
H.append_failure("https://a.com/x", "HTTP_403")
check("记 1 条 → load 出 1 条", len(H.load_failures()) == 1, H.load_failures())
H.append_failure("https://www.a.com/y", "HTTP_403")
check("同站（不同子域）同码 → 累计 2 条", len(H.load_failures()) == 2, H.load_failures())
check("签名归一化（www 剥掉）",
      H.load_failures()[0][0] == H.load_failures()[1][0] == "a.com|HTTP_403",
      H.load_failures())

# 坏行不影响读（学习不能崩掉下载流程）
with open(H.FAILURES_FILE, "a", encoding="utf-8") as f:
    f.write("这不是合法的 json\n")
    f.write('["a.com|HTTP_403"]\n')  # 缺时间戳
check("日志里有坏行 → load 跳过坏行、保留好行",
      len(H.load_failures()) == 2, H.load_failures())

# ---------------------------------------------------------------- 2. failure_advice：≥3 才开口

print("[2] failure_advice：跨任务累计到 3 次才给建议")

check("累计 2 次 → 没建议", H.failure_advice("https://a.com/x", "HTTP_403") is None)
H.append_failure("https://a.com/z", "HTTP_403")
adv = H.failure_advice("https://a.com/x", "HTTP_403")
check("累计 3 次 → 有建议", adv is not None and adv.get("advice"), adv)

# ---------------------------------------------------------------- 3. poll_job 失败收尾：记账 + 拼建议

print("[3] poll_job 失败收尾：第 3 次失败时 message 里多一句站点级建议")

# 先喂两次失败（同站同码），第三次 poll 时应该出建议
H.append_failure("https://b.com/x", "SEGMENT_GAP")
H.append_failure("https://b.com/y", "SEGMENT_GAP")

write_jobdef("k-poll", tabUrl="https://b.com/watch/1")
write_job("k-poll", status="error", err="SEGMENT_GAP", message="有分片一直取不到。换一条地址，或稍后再试。",
          percent=0, speed="", eta="", file="", quality="")

sent = []
_real_send = H.send
H.send = lambda obj: sent.append(obj) or True
try:
    # 设 5 秒上限：万一未来有人把 RLock 改回 Lock 导致死锁，这里会超时退出
    # 而不是挂满 6 小时（死锁是「挂」不是「红」，要让它变成可见的失败）。
    os.environ["MS_JOB_TIMEOUT"] = "5"
    H.poll_job("k-poll")
finally:
    H.send = _real_send
    os.environ.pop("MS_JOB_TIMEOUT", None)

last = [m for m in sent if m.get("action") in ("error", "done", "cancelled")][-1]
check("收尾消息是 error", last.get("status") == "error", last)
check("err 原样转发", last.get("err") == "SEGMENT_GAP", last)
check("第 3 次失败 → message 附了站点级建议（比单次建议更长）",
      len(last.get("message") or "") > len("有分片一直取不到。换一条地址，或稍后再试。"),
      last.get("message"))
check("建议是 SEGMENT_GAP 那条（分片经常断）", "分片" in (last.get("message") or ""), last.get("message"))

# 记完这次后，日志里应有 3 条 b.com|SEGMENT_GAP
check("这次失败也被记进日志（第 3 条）",
      sum(1 for s, _t in H.load_failures() if s == "b.com|SEGMENT_GAP") == 3,
      H.load_failures())

# ---------------------------------------------------------------- 4. 记账失败不影响收尾

print("[4] 记账失败不能崩掉下载收尾")

# 把失败日志指向一个不可写的路径，poll 失败收尾仍要正常发消息
write_jobdef("k-robust", tabUrl="https://c.com/watch/1")
write_job("k-robust", status="error", err="HTTP_403", message="站点拒绝。",
          percent=0, speed="", eta="", file="", quality="")
_bad_file = os.path.join(TMP, "no-such-dir", "failures.jsonl")
_real_fail = H.FAILURES_FILE
H.FAILURES_FILE = _bad_file
sent2 = []
_real_send2 = H.send
H.send = lambda obj: sent2.append(obj) or True
try:
    os.environ["MS_JOB_TIMEOUT"] = "5"
    H.poll_job("k-robust")
finally:
    H.send = _real_send2
    H.FAILURES_FILE = _real_fail
    os.environ.pop("MS_JOB_TIMEOUT", None)
last2 = [m for m in sent2 if m.get("action") in ("error", "done", "cancelled")][-1]
check("日志不可写时收尾照常（message 是原样）",
      last2.get("status") == "error" and last2.get("message") == "站点拒绝。", last2)

# ---------------------------------------------------------------- 汇总

print()
if ok:
    print("结果：全部通过")
    sys.exit(0)
else:
    print("结果：有失败")
    sys.exit(1)
