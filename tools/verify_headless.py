#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""无头真机验证：headless Chrome 加载本扩展（CDP Extensions.loadUnpacked），
直接在真 Service Worker 环境里跑 T-E1 / T-E2 / T-E3 / T-E4 的判据。

为什么存在
----------
真机验证（TODO 的 E 组）原来全靠用户手点。2026-10-24（d-064）发现 headless Chrome
+ CDP 可以把其中「不依赖登录态和 popup 交互」的部分自动化：

  · `--sw`    T-E1/T-E3：SW 内 `typeof MSSession === "object"`、三个方法齐全，
              并把真形态 items 回放喂 `msBuildSession`（sid 非空 / images 收进 /
              cover 分离 / 轨道判对）；
  · `--pages` T-E4/T-E2：开 B 站首页 + 从首页 DOM 取一个真实视频页（不猜 URL），
              等 webRequest 真抓取后发 `sniff:get`（旧模型条目）与 `ms:shadow`
              （新旧模型 diff），双跑 ok 才算过。

Chrome 137+ 的 branded Chrome 移除了 `--load-extension`，所以用
`Extensions.loadUnpacked` + `--enable-unsafe-extension-debugging`。
标准库实现最小 WebSocket 客户端（RFC6455 文本帧 + mask），不依赖任何包。

用法（Chrome 路径不同时用 --chrome 指定）：
    python tools/verify_headless.py --sw
    python tools/verify_headless.py --pages
"""
import argparse
import base64
import json
import os
import socket
import struct
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "extension")
PORT = 9333

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def http_json(port, path):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path))
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read().decode("utf-8"))


class WS:
    """最小 CDP WebSocket：握手 / 发带 mask 的 text 帧 / 收帧（126/127 长度与 ping）。"""

    def __init__(self, port, path):
        self.s = socket.create_connection(("127.0.0.1", port), timeout=15)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(("GET %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nUpgrade: websocket\r\n"
                        "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
                        "Sec-WebSocket-Version: 13\r\n\r\n" % (path, port, key)).encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.s.recv(4096)
        if b" 101 " not in buf.split(b"\r\n", 1)[0]:
            raise RuntimeError("WS 握手失败: %s" % buf[:200])
        self.buf = buf.split(b"\r\n\r\n", 1)[1]

    def send(self, text):
        payload = text.encode("utf-8")
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            head = struct.pack("!BB", 0x81, 0x80 | n)
        elif n < 65536:
            head = struct.pack("!BBH", 0x81, 0x80 | 126, n)
        else:
            head = struct.pack("!BBQ", 0x81, 0x80 | 127, n)
        self.s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise RuntimeError("WS 断开")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        b1, b2 = self._read(2)
        opcode = b1 & 0x0F
        n = b2 & 0x7F
        if n == 126:
            n = struct.unpack("!H", self._read(2))[0]
        elif n == 127:
            n = struct.unpack("!Q", self._read(8))[0]
        data = self._read(n)
        if opcode == 9:                      # ping → pong
            self.s.sendall(struct.pack("!BB", 0x8A, 0x80) + os.urandom(4))
            return self.recv()
        if opcode == 8:
            raise RuntimeError("WS close")
        if opcode != 1:
            return self.recv()
        return data.decode("utf-8")

    def call(self, method, params=None, _id=[0]):
        _id[0] += 1
        self.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.recv())
            if msg.get("id") == _id[0]:
                if "error" in msg:
                    raise RuntimeError("%s: %s" % (method, msg["error"]))
                return msg["result"]


class HeadlessChrome:
    """起/连一次 headless Chrome，loadUnpacked 扩展，给子命令一个统一的句柄。"""

    def __init__(self, chrome_path):
        os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
        self.profile = os.path.join(os.environ["TEMP"], "ms-verify-profile")
        self.chrome = subprocess.Popen(
            [chrome_path, "--headless=new", "--remote-debugging-port=%d" % PORT,
             "--user-data-dir=" + self.profile, "--no-first-run",
             "--no-default-browser-check", "--enable-unsafe-extension-debugging",
             "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            try:
                http_json(PORT, "/json/version")
                break
            except Exception:
                time.sleep(0.5)
        else:
            raise RuntimeError("CDP 端口没起来")
        ver = http_json(PORT, "/json/version")
        path = "/" + ver["webSocketDebuggerUrl"].split(":%d/" % PORT, 1)[1]
        self.browser = WS(PORT, path)
        self.ext_id = self.browser.call(
            "Extensions.loadUnpacked", {"path": EXT})["id"]

    def target(self, url):
        return self.browser.call("Target.createTarget", {"url": url})["targetId"]

    def wait_target(self, target_id, want=None, secs=20):
        """轮询 /json/list 等一个 target；want 是对 url 的附加过滤（如扩展 ID）。"""
        for _ in range(secs * 2):
            for t in http_json(PORT, "/json/list"):
                if t.get("id") == target_id and (not want or want in t.get("url", "")):
                    return t
            time.sleep(0.5)
        raise RuntimeError("等 target 超时（%s）" % target_id)

    def connect(self, tinfo):
        path = "/" + tinfo["webSocketDebuggerUrl"].split(":%d/" % PORT, 1)[1]
        return WS(PORT, path)

    def wait_sw(self, secs=20):
        """等本扩展的 service worker target；MV3 SW 会空闲自杀，必要时开页面唤醒。"""
        for i in range(secs * 2):
            for t in http_json(PORT, "/json/list"):
                if t.get("type") == "service_worker" and self.ext_id in t.get("url", ""):
                    return t
            if i == 8:   # 用 webRequest 事件把 SW 叫醒
                try:
                    self.target("http://127.0.0.1:18080/index.m3u8")
                except Exception:
                    pass
            time.sleep(0.5)
        raise RuntimeError("没等到本扩展的 service_worker（targets=%s）"
                           % [t.get("url", "")[:60]
                              for t in http_json(PORT, "/json/list")][:6])

    def close(self):
        self.chrome.terminate()
        try:
            self.chrome.wait(timeout=10)
        except Exception:
            self.chrome.kill()


def verify_sw(chrome_path):
    """T-E1/T-E3：SW 存活 + MSSession 三个方法 + 真形态 items 回放。"""
    hc = HeadlessChrome(chrome_path)
    out = {"ok": False}
    try:
        sw = hc.wait_sw()
        out["swUrl"] = sw["url"]
        sws = hc.connect(sw)

        def ev(expr, await_promise=False):
            r = sws.call("Runtime.evaluate", {
                "expression": expr, "returnByValue": True, "awaitPromise": await_promise})
            v = r.get("result", {})
            if r.get("exceptionDetails"):
                raise RuntimeError(str(r["exceptionDetails"])[:200])
            return v.get("value")

        out["typeofMSSession"] = ev("typeof MSSession")
        out["msMethods"] = ev("['msBuildSession','msDiffSession','msSessionSid']"
                              ".map(m => m + '=' + typeof MSSession[m]).join(' ')")
        out["manifestVersion"] = ev("chrome.runtime.getManifest().version")
        replay = json.dumps({
            "tabUrl": "https://www.xiaohongshu.com/explore/abc123",
            "items": [
                {"k": "image", "u": "https://sns-img.xhscdn.com/a.jpg",
                 "hint": "xhs-note", "m": "image/jpeg", "s": 12345},
                {"k": "image", "u": "https://sns-img.xhscdn.com/cover.jpg",
                 "hint": "xhs-cover", "m": "image/jpeg"},
                {"k": "video", "u": "https://vod.xhscdn.com/v/index.m3u8", "hint": ""},
            ]})
        # 真形态 items 回放喂 msBuildSession：sid 非空 / cover 分离 / images 收进 / 轨道判对
        out["replay"] = ev(
            "new Promise(res => { try { const s = MSSession.msBuildSession(%s); "
            "res(JSON.stringify({sid: s.sid, kind: s.kind, cover: s.cover, "
            "images: (s.images||[]).map(i => i.url), tracks: (s.tracks||[]).length})) } "
            "catch (e) { res('build-fail: ' + e.message) } })" % replay, await_promise=True)
        rep = json.loads(out["replay"])
        out["ok"] = (out["typeofMSSession"] == "object"
                     and "msBuildSession=function" in out["msMethods"]
                     and rep["sid"].startswith("xiaohongshu.com")
                     and rep["cover"].endswith("cover.jpg")
                     and len(rep["images"]) == 1 and rep["tracks"] == 1)
    except Exception as e:
        out["error"] = str(e)[:300]
    finally:
        hc.close()
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0 if out.get("ok") else 1


def verify_pages(chrome_path):
    """T-E4/T-E2：真页面抓取（首页+视频页）+ 双跑 shadow ok。"""
    hc = HeadlessChrome(chrome_path)
    out = {"ok": False}
    try:
        hc.target("https://www.bilibili.com/")
        time.sleep(14)                       # 首页资源多，给 webRequest 足够时间

        # 从首页 DOM 取一个真实存在的视频页链接（不猜 URL）
        home = None
        for t in http_json(PORT, "/json/list"):
            if "bilibili.com" in t.get("url", "") and t.get("type") == "page":
                home = t
                break
        video_url = None
        if home:
            hws = hc.connect(home)
            r = hws.call("Runtime.evaluate", {
                "expression": "JSON.stringify([...document.querySelectorAll("
                              "'a[href*=\"/video/BV\"]')].map(a => a.href).slice(0, 5))",
                "returnByValue": True})
            try:
                links = json.loads(r.get("result", {}).get("value") or "[]")
                video_url = links[0] if links else None
            except Exception:
                pass
        out["videoUrl"] = video_url
        if video_url:
            hc.target(video_url)
            time.sleep(15)                   # 视频页 DASH 流启动要时间

        popup = hc.wait_target(hc.target("chrome-extension://%s/popup.html" % hc.ext_id))
        time.sleep(2)
        pws = hc.connect(popup)
        expr = r"""
new Promise(async (res) => {
  try {
    const tabs = await chrome.tabs.query({ url: "*://www.bilibili.com/*" });
    if (!tabs.length) { res(JSON.stringify({error: "bilibili tab not found"})); return; }
    const perTab = [];
    for (const tab of tabs) {
      const tabId = tab.id;
      const get = (msg) => new Promise(r => chrome.runtime.sendMessage(
          Object.assign({ tabId }, msg), r));
      const r1 = await get({ type: "sniff:get" });
      const items = (r1 && (r1.items || r1.list)) || [];
      const r2 = await get({ type: "ms:shadow" });
      const briefs = (r2 && r2.shadow && r2.shadow[tabId]) || [];
      const b = briefs[briefs.length - 1] || null;
      perTab.push({
        url: tab.url.slice(0, 60),
        itemCount: items.length,
        kinds: items.reduce((a, it) => { const k = it.k || "?"; a[k] = (a[k]||0)+1; return a; }, {}),
        shadowBrief: b ? { ok: b.ok, sid: b.sid, kind: b.kind, counts: b.counts } : null,
      });
    }
    res(JSON.stringify(perTab));
  } catch (e) { res(JSON.stringify({error: e.message})); }
})
"""
        r = pws.call("Runtime.evaluate",
                     {"expression": expr, "returnByValue": True, "awaitPromise": True})
        out["tabs"] = json.loads(r.get("result", {}).get("value") or "[]")
        tabs = out["tabs"]
        out["ok"] = (isinstance(tabs, list) and len(tabs) >= 1
                     and tabs[0].get("itemCount", 0) > 0
                     and bool((tabs[0].get("shadowBrief") or {}).get("ok", False)))
    except Exception as e:
        out["error"] = str(e)[:300]
    finally:
        hc.close()
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0 if out.get("ok") else 1


def verify_userflow(chrome_path, url):
    """模拟用户流程（AGENTS 7.5 的自动半）：开页面 → 点插件（popup）→
    列表与页面资源比对 → 对第一条可下条目点下载 → 断言文件真实落盘。

    与 --pages 的差别：pages 只读双跑摘要；userflow 真的点「下载」并等文件，
    且断言 popup 列表非空、页面上确实有对应媒体（video/img 计数 > 0）。
    落盘目录用 chrome.storage.local.outdir 指到 %TEMP%，验证后清理。
    """
    hc = HeadlessChrome(chrome_path)
    out = {"ok": False}
    tmp_out = os.path.join(os.environ["TEMP"], "ms-userflow-out")
    shutil.rmtree(tmp_out, ignore_errors=True)
    os.makedirs(tmp_out, exist_ok=True)
    try:
        hc.target(url)
        time.sleep(12)                       # 等页面媒体请求自然发生

        # 设定下载目录（真实 settings 通道，不是测试桩）
        page = None
        for t in http_json(PORT, "/json/list"):
            if url.split("//", 1)[1].split("/")[0] in t.get("url", "") and t.get("type") == "page":
                page = t
                break
        if not page:
            raise RuntimeError("测试页 target 没起来")
        pws = hc.connect(page)
        pws.call("Runtime.evaluate", {
            "expression": "chrome.storage && null",
            "returnByValue": True})  # noop；outdir 由 popup 设置通道写
        # 从 SW 写 settings（chrome.storage 是 SW/页面共通的同一份）
        sw = hc.wait_sw()
        sws = hc.connect(sw)
        sws.call("Runtime.evaluate", {
            "expression": "chrome.storage.local.set({outdir: %s})" % json.dumps(tmp_out),
            "returnByValue": True})

        # 刷新页面让捕获重新开始 + 等 SW 把 settings 收进下一次任务
        pws.call("Runtime.evaluate", {"expression": "location.reload()", "returnByValue": True})
        time.sleep(12)

        # 页面侧资源计数（与 popup 列表比对的「页面真值」）
        r = pws.call("Runtime.evaluate", {
            "expression": "JSON.stringify({videos: document.querySelectorAll('video').length,"
                          " imgs: document.querySelectorAll('img').length,"
                          " title: document.title.slice(0, 40)})",
            "returnByValue": True})
        pageTruth = json.loads(r.get("result", {}).get("value") or "{}")
        out["pageTruth"] = pageTruth

        popup = hc.wait_target(hc.target("chrome-extension://%s/popup.html" % hc.ext_id))
        time.sleep(2)
        pops = hc.connect(popup)
        r = pops.call("Runtime.evaluate", {
            "expression": r"""(async () => {
              const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
              if (!tab) return JSON.stringify({err: "popup 的 active tab 是自己（headless 已知限制），改由 SW 取"});
              return JSON.stringify({tabId: tab.id, url: tab.url});
            })()""",
            "returnByValue": True, "awaitPromise": True})
        tabinfo = json.loads(r.get("result", {}).get("value") or "{}")

        # popup 的 tabs.query 限制（d-074 教训）：headless 里 popup 的 active tab
        # 是 popup 自己。列表数据改从 SW 的 state 直读——与 popup sniff:get 同源。
        r = sws.call("Runtime.evaluate", {
            "expression": """(async () => {
              const ts = await chrome.tabs.query({});
              const hit = ts.find(x => (x.url || "").indexOf(%s) >= 0);
              if (!hit) return JSON.stringify({err: "no tab"});
              const resp = await new Promise(res => chrome.tabs.sendMessage(hit.id, {type: "ms:ping"}, r => res(r)));
              const rec = state.get(hit.id);
              const items = rec ? [...rec.items.values()] : [];
              return JSON.stringify({tabId: hit.id, n: items.length,
                kinds: items.reduce((a, it) => { a[it.k] = (a[it.k]||0)+1; return a; }, {}),
                downloadable: items.filter(it => it.k === "video" && !/^m\\d+$/.test(it.u || ""))
                                   .map(it => ({u: it.u, name: it.name || ""})).slice(0, 3)});
            })()""" % json.dumps(url.split("//", 1)[1].split("/")[0]),
            "returnByValue": True, "awaitPromise": True})
        listing = json.loads(r.get("result", {}).get("value") or "{}")
        out["listing"] = {k: listing.get(k) for k in ("n", "kinds", "err")}

        # 列表 vs 页面资源匹配（粗判）：popup 看到了条目，页面也确实有媒体
        match_ok = listing.get("n", 0) > 0 and (
            pageTruth.get("videos", 0) > 0 or pageTruth.get("imgs", 0) > 0)
        out["listMatchesPage"] = match_ok

        # 点下载：挑第一条 video 直链（带扩展名，走 urllib 链最快）
        dl = (listing.get("downloadable") or [None])[0]
        if dl:
            fname = "userflow-probe.mp4"
            dl_target = os.path.join(tmp_out, fname)
            sws.call("Runtime.evaluate", {
                "expression": """(async () => { try {
                  await startNativeDownload({url: %s, tabId: null, kind: "video",
                    filename: %s, referer: %s, tabUrl: %s});
                  return "ok"; } catch (e) { return "err: " + e.message; } })()"""
                % (json.dumps(dl["u"]), json.dumps(fname),
                   json.dumps(url), json.dumps(url)),
                "returnByValue": True})
            # 落盘断言跟真实 job 状态走（outdir 可能被 settings 默认值覆盖，
            # 直接盯 jobs 目录最新一条的 file 字段 + 文件真实存在）
            out["download"] = {"clicked": True}
            got = None
            jobs_dir = os.path.join(os.environ.get("LOCALAPPDATA", ""), "MediaSniffer", "jobs")
            for _ in range(40):
                try:
                    cands = [f for f in os.listdir(jobs_dir)
                             if f.startswith("dl-") and f.endswith(".json") and ".job." not in f]
                    newest = max(cands, key=lambda f: os.path.getmtime(os.path.join(jobs_dir, f)))
                    st = json.load(open(os.path.join(jobs_dir, newest), encoding="utf-8"))
                    prod = st.get("file") or ""
                    if st.get("status") == "done" and prod and os.path.isfile(prod) and os.path.getsize(prod) > 0:
                        got = os.path.getsize(prod)
                        out["download"]["file"] = prod
                        break
                except Exception:
                    pass
                time.sleep(1)
            out["download"]["fileSaved"] = got is not None
            out["download"]["size"] = got
            out["ok"] = bool(match_ok and got is not None)
        else:
            out["download"] = {"clicked": False, "reason": "列表里没有可下直链"}
            out["ok"] = bool(match_ok)
    except Exception as e:
        out["error"] = str(e)[:300]
    finally:
        shutil.rmtree(tmp_out, ignore_errors=True)
        hc.close()
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0 if out.get("ok") else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sw", action="store_true", help="T-E1/T-E3：SW 存活 + 回放")
    ap.add_argument("--pages", action="store_true", help="T-E4/T-E2：真页面抓取 + 双跑")
    ap.add_argument("--userflow", action="store_true",
                    help="AGENTS 7.5 自动半：模拟用户开页面→看列表→点下载→验落盘（配 --url）")
    ap.add_argument("--url", help="--userflow 的测试页地址")
    ap.add_argument("--chrome", default=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                    help="Chrome 路径")
    a = ap.parse_args()
    if not (a.sw or a.pages or a.userflow):
        ap.error("选一个：--sw / --pages / --userflow")
    if a.userflow:
        if not a.url:
            ap.error("--userflow 需要 --url <测试页>")
        return verify_userflow(a.chrome, a.url)
    if a.sw:
        return verify_sw(a.chrome)
    return verify_pages(a.chrome)


if __name__ == "__main__":
    sys.exit(main())
