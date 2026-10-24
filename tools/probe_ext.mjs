/**
 * 一次性探针：验证扩展的各个脚本是否真的进了页面。
 * 起因：加 hls-meta.js 后真机「时长未知」，需要区分「脚本没注入」和「hook 没跑」。
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const EXT = "D:/tmp/ms-probe-ext";
const PROFILE = "D:/tmp/ms-probe-profile";
const PORT = 9457;
const URL_ = process.argv[2] || "http://127.0.0.1:8899/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function copyTree(src, dst) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const n of readdirSync(src)) if (n !== "node_modules") copyTree(join(src, n), join(dst, n));
  } else copyFileSync(src, dst);
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waits = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waits.has(m.id)) { this.waits.get(m.id)(m); this.waits.delete(m.id); }
    });
  }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    return new Cdp(ws);
  }
  send(method, params = {}, timeout = 30000, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waits.delete(id); rej(new Error(method + " 超时")); }, timeout);
      this.waits.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result || {}); });
      const body = { id, method, params };
      if (sessionId) body.sessionId = sessionId;
      this.ws.send(JSON.stringify(body));
    });
  }
}

async function main() {
  rmSync(PROFILE, { recursive: true, force: true });
  rmSync(EXT, { recursive: true, force: true });
  copyTree(join(ROOT, "extension"), EXT);
  console.log("扩展副本已重建 → " + EXT);
  console.log("  含 hls-meta.js: " + readdirSync(EXT).includes("hls-meta.js"));

  const proc = spawn(EDGE, [
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + PROFILE,
    "--no-first-run", "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter,DisableLoadExtensionCommandLineSwitch",
    "--enable-unsafe-extension-debugging",
  ], { stdio: "ignore" });

  let ver;
  for (let i = 0; i < 40; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(300); }
  }
  const cdp = await Cdp.connect(ver.webSocketDebuggerUrl);
  const r = await cdp.send("Extensions.loadUnpacked", { path: EXT }, 40000);
  console.log("扩展已加载 id=" + r.id);

  const t = await cdp.send("Target.createTarget", { url: URL_ });
  await sleep(12000);
  const s = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, 30000, s.sessionId);

  const probe = await cdp.send("Runtime.evaluate", {
    expression: `(() => ({
      title: document.title,
      bodyHead: (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, 260),
      loginish: /登录|登陆|log ?in/i.test(document.body ? document.body.innerText : ""),
      videoTags: document.querySelectorAll("video").length,
      hlsMeta: typeof MSHlsMeta,
      hlsFamily: typeof MSHlsFamily,
      naming: typeof MSNaming,
      mainFlag: typeof window.__MS_SNIFFER_MAIN__,
      fetchPatched: String(window.fetch).indexOf("readManifestBody") >= 0,
      fetchHead: String(window.fetch).slice(0, 120),
    }))()`,
    returnByValue: true,
    }, 30000, s.sessionId);
  console.log("页面探针：", JSON.stringify(probe.result.value, null, 2));

  // 直接问 hls-meta 能不能解析（确认脚本可用，不是只有个空对象）
  const parseTest = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      try {
        const r = MSHlsMeta.parse("#EXTM3U\\n#EXTINF:6,\\na.ts\\n#EXTINF:6,\\nb.ts");
        return { ok: true, kind: r.kind, segs: r.segs, dur: r.dur };
      } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
    })()`,
    returnByValue: true,
    }, 30000, s.sessionId);
  console.log("解析自测：", JSON.stringify(parseTest.result.value));

  // 页面里手动 fetch 一个清单，看 hook 有没有把消息发出去
  const manual = await cdp.send("Runtime.evaluate", {
    expression: `(async () => {
      const got = [];
      const orig = window.postMessage.bind(window);
      window.addEventListener("message", (e) => {
        if (e.data && e.data.__ms_sniffer && e.data.cmd === "hlsmeta") {
          got.push({ key: String(e.data.key || "").slice(-60), segs: e.data.segs, dur: e.data.dur });
        }
      });
      try {
        await fetch("https://test-streams.mux.dev/x36xhzz/url_6/193039199_mp4_h264_aac_hq_7.m3u8");
      } catch (e) { return { err: String(e && e.message || e) }; }
      await new Promise((r) => setTimeout(r, 1500));
      return { got };
    })()`,
    awaitPromise: true,
    returnByValue: true,
    }, 30000, s.sessionId);
  console.log("手动 fetch 清单后收到的 hlsmeta 消息：", JSON.stringify(manual.result.value, null, 2));

  // ---- 端到端：页面 hook 发的消息，有没有真的落到 background 的条目上
  await sleep(2500);
  const extT = await cdp.send("Target.createTarget", { url: "chrome-extension://" + r.id + "/popup.html" });
  await sleep(2000);
  const se = await cdp.send("Target.attachToTarget", { targetId: extT.targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, 30000, se.sessionId);
  const listed = await cdp.send("Runtime.evaluate", {
    expression: `(async () => {
      const all = await chrome.storage.session.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith("tab:"));
      const out = [];
      for (const k of keys) {
        const v = all[k] || {};
        const items = (v.items || []).map((p) => Array.isArray(p) ? p[1] : p).filter(Boolean);
        const m = items.filter((it) => /\.m3u8/i.test(it.u || ""));
        out.push({
          key: k, url: String(v.url || "").slice(0, 50), items: items.length,
          m3u8: m.map((it) => ({ f: String(it.u).split("/").slice(-1)[0], s: it.s, dur: it.dur || 0, segs: it.segs || 0 })),
        });
      }
      return { probe: all._hlsProbe || [], tabs: out };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }, 30000, se.sessionId);
  console.log("storage 侧：", JSON.stringify(listed.result.value, null, 2));

  try { proc.kill("SIGKILL"); } catch {}
  process.exit(0);
}

main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
