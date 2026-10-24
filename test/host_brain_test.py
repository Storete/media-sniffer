#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""T-F5 失败 AI 分析测试（brain.py）——fake endpoint，零外网。

判据：
  · build_prompt 纯函数：case 全字段进 prompt，词表全量在 prompt 里；
  · parse_analysis：合法 JSON / ```json 包裹 / 前后废话 / 词表外 strategy /
    非法 JSON / 空返回——只有「词表内 + 合法 JSON」才 ok；
  · analyze：未配置 → 明确错误不触网；fake OpenAI 兼容 endpoint → 全链通；
    endpoint 挂 → {ok: False, error} 不抛。
"""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "native-host"))

import brain  # noqa: E402

ok = True


def check(name, cond, extra=None):
    global ok
    if cond:
        print("PASS", name)
    else:
        ok = False
        print("FAIL", name, "" if extra is None else extra)


CASE = {
    "url": "https://tv.sohu.com/",
    "observed": {"chain": "ytdlp", "errcode": "VERIFY_MISMATCH",
                 "trail": "规划=站点页 ／ yt-dlp=INTERNAL ／ 直连=VERIFY_MISMATCH",
                 "message": "文件不完整或内容不对"},
    "markers": ["dplayer"],
}

# ---------------------------------------------------------------- [1] build_prompt

print("[1] build_prompt：case 全字段进 prompt，词表全量在场")
system, user = brain.build_prompt(CASE)
check("system 提到只输出 JSON", "JSON" in system)
check("user 带 URL", "tv.sohu.com" in user)
check("user 带错误码", "VERIFY_MISMATCH" in user)
check("user 带 trail", "直连=VERIFY_MISMATCH" in user)
check("user 带媒体标记", "dplayer" in user)
check("user 带全量词表", all(s in user for s in brain.STRATEGIES))
check("词表 10 个（与考卷一致）", len(brain.STRATEGIES) == 10)

# ---------------------------------------------------------------- [2] parse_analysis

print("[2] parse_analysis：只有「词表内 + 合法 JSON」才 ok")
good = json.dumps({"diagnosis": "视频站首页无单视频", "strategy": "specific-video-url",
                   "confidence": 0.8, "advice": "给具体视频页地址"})
r = brain.parse_analysis(good)
check("合法 JSON → ok", r["ok"] is True and r["strategy"] == "specific-video-url", r)
r = brain.parse_analysis("```json\n" + good + "\n```")
check("```json 包裹也能解析", r["ok"] is True)
r = brain.parse_analysis("分析如下：" + good + " 以上。")
check("前后废话容忍", r["ok"] is True)
r = brain.parse_analysis(json.dumps({"diagnosis": "x", "strategy": "guess-hard",
                                     "confidence": 0.9}))
check("词表外 strategy → ok=False（策略没对接上要暴露）", r["ok"] is False and "词表" in r["error"])
r = brain.parse_analysis("完全不是 JSON 的一段话")
check("无 JSON → 红", r["ok"] is False)
r = brain.parse_analysis("")
check("空返回 → 红", r["ok"] is False)
r = brain.parse_analysis(json.dumps({"diagnosis": "x", "strategy": "direct-download",
                                     "confidence": "高"}))
check("confidence 非数字 → 降 0.5 不炸", r["ok"] is True and r["confidence"] == 0.5)

# ---------------------------------------------------------------- [3] analyze（fake endpoint）

print("[3] analyze：未配置不触网；fake OpenAI 兼容端点全链通；挂了不抛")

r = brain.analyze(CASE, "", "", "m")
check("未配置 endpoint/key → 明确错误", r["ok"] is False and "未配置" in r["error"])

FAKE_RESP = {"choices": [{"message": {"content": good}}, ],
             "model": "fake-model"}
hits = {"auth": None, "body": None}


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        hits["auth"] = self.headers.get("Authorization")
        hits["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(FAKE_RESP).encode())

    def log_message(self, *a):
        pass


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
port = srv.server_port
threading.Thread(target=srv.serve_forever, daemon=True).start()

r = brain.analyze(CASE, "http://127.0.0.1:%d/v1" % port, "sk-test", "fake-model")
check("fake endpoint 全链通", r.get("ok") is True and r["strategy"] == "specific-video-url", r)
check("Authorization Bearer 头", hits["auth"] == "Bearer sk-test")
check("model 进请求体", hits["body"]["model"] == "fake-model")

srv2 = ThreadingHTTPServer(("127.0.0.1", 0), H)


class Dead(BaseHTTPRequestHandler):
    def do_POST(self):
        self.send_response(500)
        self.end_headers()
        self.wfile.write(b"oops")

    def log_message(self, *a):
        pass


dead = ThreadingHTTPServer(("127.0.0.1", 0), Dead)
dead_port = dead.server_port
threading.Thread(target=dead.serve_forever, daemon=True).start()
r = brain.analyze(CASE, "http://127.0.0.1:%d/v1" % dead_port, "sk", "m")
check("endpoint 500 → {ok:False, error} 不抛", r["ok"] is False and "error" in r)

# ---------------------------------------------------------------- [4] F6 白名单动作

print("[4] propose_actions：分析 → 受控动作（LLM 不能发明动作）")
acts = brain.propose_actions({"ok": True, "strategy": "specific-video-url",
                              "diagnosis": "首页", "advice": "给具体视频页"})
check("specific-video-url → page-parse 动作",
      acts == [{"action": "page-parse", "why": "给具体视频页"}], acts)
check("分析不 ok → 空动作（没有可信诊断就不该有动作）",
      brain.propose_actions({"ok": False, "error": "x"}) == [])
check("未知 strategy → 空动作",
      brain.propose_actions({"ok": True, "strategy": "invented"}) == [])
check("动作全部落在白名单",
      all(a["action"] in brain.ACTIONS for a in brain.propose_actions(
          {"ok": True, "strategy": "record-live"})))

print()
print("=" * 50)
if ok:
    print("全部通过")
    sys.exit(0)
print("有失败项")
sys.exit(1)
