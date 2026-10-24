/**
 * 用 CDP Network 域抓页面自己请求过的 m3u8 正文。
 * 不受 CORS 限制（拿的是浏览器实际收到的响应），是 S1「读响应体」的技术验证。
 *
 * 用法：node tools/net_dump.mjs --url <页面> --wait 20 [--grep m3u8] [--out x.json]
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const EXT = "D:/tmp/ms-live-ext";
const PROFILE = "D:/tmp/ms-netdump-profile";
const PORT = 9456;

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf("--" + k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const PAGE = argOf("url", "");
const WAIT = Number(argOf("wait", 20)) * 1000;
const GREP = argOf("grep", "m3u8");
const OUT = argOf("out", "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function copyTree(src, dst) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const n of readdirSync(src)) copyTree(join(src, n), join(dst, n));
  } else copyFileSync(src, dst);
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waits = new Map(); this.handlers = [];
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waits.has(m.id)) { this.waits.get(m.id)(m); this.waits.delete(m.id); }
      else if (m.method) for (const h of this.handlers) h(m);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
    return new Cdp(ws);
  }
  on(fn) { this.handlers.push(fn); }
  send(method, params = {}, sessionId, timeout = 30000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waits.delete(id); rej(new Error(method + " 超时")); }, timeout);
      this.waits.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result || {}); });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

/** 从清单正文里抽结构：主/媒体、分片数、总时长 */
function analyze(text) {
  const lines = String(text || "").split(/\r?\n/);
  const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));
  const durations = [];
  let cur = 0;
  for (const l of lines) {
    const m = /^#EXTINF:\s*([0-9.]+)/.exec(l);
    if (m) cur = Number(m[1]) || 0;
    else if (l && !l.startsWith("#")) { if (cur) durations.push(cur); cur = 0; }
  }
  const total = durations.reduce((a, b) => a + b, 0);
  const variants = isMaster
    ? lines.filter((l) => l.startsWith("#EXT-X-STREAM-INF")).map((l) => {
        const bw = /BANDWIDTH=(\d+)/.exec(l);
        const rs = /RESOLUTION=([0-9x]+)/.exec(l);
        return { bandwidth: bw ? Number(bw[1]) : 0, res: rs ? rs[1] : "" };
      })
    : [];
  const segExt = (text.match(/\.(ts|m4s|mp4)\b/g) || []).slice(0, 3);
  return {
    isMaster, isMedia: /#EXTINF/.test(text),
    segCount: durations.length,
    duration: Math.round(total),
    variants, segExt,
    encrypted: /#EXT-X-KEY:METHOD=(?!NONE)/.test(text),
    head: lines.slice(0, 14).join("\n"),
  };
}

async function main() {
  rmSync(PROFILE, { recursive: true, force: true });
  rmSync(EXT, { recursive: true, force: true });
  copyTree(join(ROOT, "extension"), EXT);

  const proc = spawn(EDGE, [
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + PROFILE,
    "--no-first-run", "--no-default-browser-check", "--window-size=1200,900",
    "--disable-features=Translate,MediaRouter,DisableLoadExtensionCommandLineSwitch",
    "--enable-unsafe-extension-debugging",
  ], { stdio: "ignore" });

  let ver;
  for (let i = 0; i < 40; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(300); }
  }
  const cdp = await Cdp.connect(ver.webSocketDebuggerUrl);

  // 先建空白 target，enable Network，再导航 —— 否则会漏掉最早的响应
  const t = await cdp.send("Target.createTarget", { url: "about:blank" });
  const s = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  const sid = s.sessionId;
  await cdp.send("Network.enable", { maxTotalBufferSize: 64e6, maxResourceBufferSize: 8e6 }, sid);

  const reqs = new Map(); // requestId -> {url, mime, status}
  cdp.on((m) => {
    if (m.sessionId !== sid) return;
    if (m.method === "Network.responseReceived") {
      const r = m.params.response;
      reqs.set(m.params.requestId, { url: r.url, mime: r.mimeType || "", status: r.status, type: m.params.type });
    }
    if (m.method === "Network.loadingFailed") reqs.delete(m.params.requestId);
  });

  await cdp.send("Page.enable", {}, sid);
  await cdp.send("Page.navigate", { url: PAGE }, sid);
  console.log("页面已打开，等 " + Math.round(WAIT / 1000) + " 秒抓包…");
  await sleep(WAIT);

  const hits = [...reqs.entries()].filter(([, v]) => v.url && v.url.indexOf(GREP) >= 0);
  console.log("匹配「" + GREP + "」的响应 " + hits.length + " 条\n");

  const out = [];
  for (const [rid, v] of hits) {
    let body = "";
    try { const r = await cdp.send("Network.getResponseBody", { requestId: rid }, sid, 15000); body = r.body || ""; if (r.base64Encoded) body = Buffer.from(body, "base64").toString("utf8"); }
    catch (e) { body = ""; }
    const a = body ? analyze(body) : { err: "取不到正文" };
    const rec = { url: v.url, mime: v.mime, status: v.status, bytes: body.length, ...a };
    out.push(rec);
    console.log("── " + v.url.replace(/^https?:\/\//, ""));
    console.log("   mime=" + v.mime + " status=" + v.status + " 正文=" + body.length + "B");
    if (a.err) { console.log("   " + a.err); continue; }
    console.log("   主清单=" + a.isMaster + " 媒体清单=" + a.isMedia + " 分片=" + a.segCount + " 时长=" + a.duration + "s 加密=" + a.encrypted);
    if (a.variants.length) console.log("   变体: " + JSON.stringify(a.variants));
    if (a.segExt.length) console.log("   分片后缀: " + a.segExt.join(" "));
    console.log("   ---- 头部 ----");
    for (const line of a.head.split("\n")) console.log("   " + line.slice(0, 108));
    console.log("");
  }

  if (OUT) { writeFileSync(OUT, JSON.stringify(out, null, 2)); console.log("已写入 " + OUT); }

  try { proc.kill("SIGKILL"); } catch {}
  process.exit(0);
}

main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
