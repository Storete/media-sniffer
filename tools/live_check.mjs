/**
 * 真机取证工具（验收 R3 的常规手段）
 *
 * 解决三个「只能靠猜」的问题：
 *   1. 列表里那几条 HLS 到底是什么 —— 打的是同一个地址，还是 master/media 两级？
 *   2. 关闭标签页会不会连带清掉「下载记录」—— storage.session 到底动没动？
 *   3. 列表条目与网页实际内容是否对得上 —— 条目数据直接从扩展的 storage 读，
 *      不是从页面 DOM 猜。
 *
 * 为什么不从 service worker 的 target 读：Chrome 156 把 MV3 的 SW 暴露成
 * background_page，`Object.keys(chrome)` 里根本没有 `storage`（2026-10-23 实测）。
 * 所以改成开一个**扩展页面**（popup.html，普通标签页打开），在扩展源下执行
 * evaluate —— 那里 chrome.storage 是完整的。
 *
 * 用法：
 *   node tools/live_check.mjs --url https://example.com/watch/1 --wait 12
 *   node tools/live_check.mjs --url ... --history-test      # 附带关标签页实验
 *   node tools/live_check.mjs --url ... --browser edge --out D:/tmp/live.json
 *
 * 硬约束（都是踩过的坑）：
 *   · `Extensions.loadUnpacked` 的 path 必须正斜杠，中文路径先同步到 ASCII 副本；
 *   · 不用 fs.cpSync（源路径含中文会静默硬杀 Node，退出码 127），改手工递归；
 *   · 页面加载前不注入任何东西，本工具只读扩展自己的 storage。
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 中文路径不能用 URL.pathname 直接取（会被百分号编码），必须走 fileURLToPath。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 9333;
const PROFILE = "D:/tmp/ms-live-profile";
const EXT_DIR = "D:/tmp/ms-live-ext";

// ---------------------------------------------------------------- 参数
function argOf(name, def) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const TARGET_URL = argOf("url", "");
const WAIT_MS = Number(argOf("wait", 12)) * 1000;
const BROWSER = String(argOf("browser", "edge"));
const HISTORY_TEST = argOf("history-test", false) === true;
const RENDER_CHECK = argOf("render-check", false) === true;
const DOWNLOAD_TEST = argOf("download-test", false) === true;
// 模拟用户真实路径：点完下载就关掉 popup，再回来查记录。
// 为什么必须单独测：上一轮修完 notifySaved 后，我是在**扩展页一直开着**的情况下验的，
// 那种测法下 SW 有活跃页面、port 不会断；用户关掉 popup 后 MV3 SW 可能被回收，
// 宿主回执就没人接。用户报「退出界面后没有下载记录」正是这条路径。
const CLOSE_POPUP = argOf("close-popup", false) === true;
const DOWNLOAD_WAIT = Number(argOf("dl-wait", 25)) * 1000;
const OUT = argOf("out", "");
const KEEP = argOf("keep", false) === true;
const LOAD_MS = Number(argOf("load", 40)) * 1000;

if (!TARGET_URL) {
  console.error("缺少 --url。用法：node tools/live_check.mjs --url https://… --wait 12");
  process.exit(2);
}

const LOG = [];
function log(...a) {
  const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  LOG.push(s);
  console.error(s);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 手工递归拷贝
// fs.cpSync 在源路径含中文时会把 Node 进程静默硬杀（exit 127、不抛异常、不进 catch）。
function copyTree(src, dst) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(src)) {
      if (name === "node_modules" || name === ".git") continue;
      copyTree(join(src, name), join(dst, name));
    }
  } else {
    copyFileSync(src, dst);
  }
}

// ---------------------------------------------------------------- 极简 CDP
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.waiting = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
      if (!msg.id || !this.waiting.has(msg.id)) return;
      const { res, rej, timer } = this.waiting.get(msg.id);
      this.waiting.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
      else res(msg.result || {});
    });
  }

  static connect(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => rej(new Error("CDP 连接超时")), 15000);
      ws.addEventListener("open", () => { clearTimeout(t); res(new Cdp(ws)); });
      ws.addEventListener("error", (e) => { clearTimeout(t); rej(new Error("CDP 连接失败 " + (e.message || ""))); });
    });
  }

  send(method, params = {}, timeout = 45000) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        rej(new Error("CDP 超时 " + method));
      }, timeout);
      this.waiting.set(id, { res, rej, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expr, timeout = 45000) {
    // 扩展页面的 evaluate 不需要额外的 executionContext 指定
    const r = await this.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, timeout);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error("页面侧异常：" + (d.exception?.description || d.text || "").slice(0, 300));
    }
    return r.result ? r.result.value : undefined;
  }
}

async function httpJson(path) {
  const r = await fetch("http://127.0.0.1:" + PORT + path);
  if (!r.ok) throw new Error("HTTP " + r.status + " " + path);
  return r.json();
}

// ---------------------------------------------------------------- 浏览器路径
function browserExe() {
  const c = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
  ];
  const e = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  const list = BROWSER === "edge" ? e.concat(c) : c.concat(e);
  for (const p of list) if (p && existsSync(p)) return p;
  throw new Error("找不到 " + BROWSER + " 可执行文件");
}

// ---------------------------------------------------------------- 主流程
let browser = null;
let extId = "";
let rootCdp = null;

async function launch() {
  rmSync(PROFILE, { recursive: true, force: true });
  const exe = browserExe();
  log("[1] 浏览器：" + basename(exe));

  // 扩展副本必须在启动前就位：Edge 靠 --load-extension 加载它，
  // Chrome 137+ 会忽略这个参数（不报错），那条路改用 Extensions.loadUnpacked。
  rmSync(EXT_DIR, { recursive: true, force: true });
  copyTree(join(ROOT, "extension"), EXT_DIR);
  log("[2] 扩展副本已同步 → " + EXT_DIR);

  const args = [
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + PROFILE,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter,DisableLoadExtensionCommandLineSwitch",
    "--enable-unsafe-extension-debugging",
    "--window-size=1280,900",
  ];
  browser = spawn(exe, args, { stdio: "ignore", detached: false });

  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = await httpJson("/json/version"); break; } catch { await sleep(500); }
  }
  if (!ver) throw new Error("浏览器未起来（remote-debugging 端口无响应）");
  log("     版本：" + ver.Browser + (ver["User-Agent"] ? "" : ""));
  return ver;
}

/** 拿扩展 id。
 *
 * 只用浏览器级 CDP 的 `Extensions.loadUnpacked`，**不能**靠扫 target 列表猜：
 * Edge 自带一堆内置扩展，扫到的第一个 `chrome-extension://` 往往是它自己的，
 * 打开那个 id 的 popup.html 会得到一个没有扩展 API 的 404 页 ——
 * 表现为「扩展页里 chrome.storage 不可用」，而 URL 检查却是通过的（2026-10-24 实测）。
 *
 * 注意 `--load-extension` 也不再用了：Chrome/Edge 155+ 已禁用，且不报错。 */
async function loadExtension(ver) {
  rootCdp = await Cdp.connect(ver.webSocketDebuggerUrl);
  try {
    const r = await rootCdp.send("Extensions.loadUnpacked", { path: EXT_DIR }, 40000);
    if (r && r.id) {
      log("     扩展已加载（Extensions.loadUnpacked），id = " + r.id);
      return r.id;
    }
    log("     loadUnpacked 返回空 id");
  } catch (e) {
    log("     loadUnpacked 失败：" + e.message.slice(0, 120));
  }
  return "";
}

// ---------------------------------------------------------------- 步骤 3：开目标页
async function openTarget(browserCdp) {
  // 直接开目标站点，不走 about:blank → Page.navigate：那条路上 content script
  // 不注入（2026-10-23 实测），列表会永远是空的。
  const t = await browserCdp.send("Target.createTarget", { url: TARGET_URL });
  const info = await browserCdp.send("Target.getTargetInfo", { targetId: t.targetId });
  const s = await browserCdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  const page = new SessionCdp(browserCdp, s.sessionId);

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  log("[3] 目标页已打开，等待 " + Math.round(WAIT_MS / 1000) + " 秒…");
  await sleep(WAIT_MS);
  return { targetId: t.targetId, sessionId: s.sessionId, page, info: info.targetInfo };
}

/** 扁平化会话：同一个 WebSocket 上带 sessionId 的 Cdp 视图。 */
class SessionCdp {
  constructor(parent, sessionId) { this.parent = parent; this.sessionId = sessionId; }
  async send(method, params = {}, timeout = 45000) {
    const id = ++this.parent.seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.parent.waiting.delete(id); rej(new Error("CDP 超时 " + method)); }, timeout);
      this.parent.waiting.set(id, { res, rej, timer });
      this.parent.ws.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
    });
  }
  async evaluate(expr, timeout = 45000) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
    }, timeout);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error("页面侧异常：" + (d.exception?.description || d.text || "").slice(0, 300));
    }
    return r.result ? r.result.value : undefined;
  }
}

// ---------------------------------------------------------------- 步骤 4：扩展页面取证
async function openExtensionPage(browserCdp, id) {
  const url = "chrome-extension://" + id + "/popup.html";
  const t = await browserCdp.send("Target.createTarget", { url });
  await sleep(1500);
  const info = await browserCdp.send("Target.getTargetInfo", { targetId: t.targetId });
  const actual = info.targetInfo.url || "";
  if (!actual.startsWith("chrome-extension://")) {
    throw new Error("扩展页打不开，落到了 " + actual + "（多半是扩展 id 不对）");
  }
  const s = await browserCdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  const page = new SessionCdp(browserCdp, s.sessionId);
  await page.send("Runtime.enable");
  // 探针不能只查 storage 存不存在：Edge 内置扩展也满足这一点。必须核对 manifest 名字，
  // 否则会对着别人的 id 取一份空数据，然后报告「这页没抓到」。
  const probe = await page.evaluate(`(async () => {
    try {
      const m = chrome.runtime.getManifest();
      const ses = await chrome.storage.session.get(null);
      return { ok: true, name: m.name || "", version: m.version || "", keys: Object.keys(ses).length };
    } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
  })()`);
  if (!probe || !probe.ok) throw new Error("扩展页无扩展 API：" + ((probe && probe.err) || "未知"));
  if (!/资源嗅探/.test(probe.name)) {
    throw new Error("打开的不是本扩展（manifest.name=" + probe.name + "，id=" + id + "）");
  }
  log("[4] 扩展页就绪：" + probe.name + " v" + probe.version + "，session 已有 " + probe.keys + " 个键");
  return { targetId: t.targetId, page };
}

/**
 * 条目 → 可 JSON 化的纯对象。**只此一处**。
 * 这份白名单漏字段的代价是「取证说没有、其实有」，已经踩过两次
 * （dumpItems 和 renderCheck 各一份，改了一处忘了另一处）。
 */
const PLAIN_SRC = `function plainItem(it) {
  return {
    u: it.u, k: it.k, m: it.m || "", s: it.s || 0, hint: it.hint || "",
    page: it.page || 0, title: (it.title || "").slice(0, 80),
    mid: it.mid || "", mark: it.mark || "", f: it.f || "", t: it.t || 0,
    dur: it.dur || 0, segs: it.segs || 0, listKind: it.listKind || "", enc: it.enc || 0,
  };
}`;
// Node 侧用（renderCheck 在 Node 里 map）
const plainItem = new Function("return " + PLAIN_SRC.replace(/^function plainItem/, "function"))();
// 页面侧用：evaluate 是字符串，必须把源码拼进去，否则报 plainItem is not defined
function plainInPage(listExpr) {
  return PLAIN_SRC + "\n return (" + listExpr + ");";
}

/** 把 tab:<id> 的条目读出来，并整理成人类能看的形状。 */
async function dumpItems(extPage, tabId) {
  const raw = await extPage.evaluate(`
    (async () => {
      ${PLAIN_SRC}
      const all = await chrome.storage.session.get(null);
      const keys = Object.keys(all);
      const out = { keys: keys, tabs: {} };
      for (const k of keys) {
        if (!k.startsWith("tab:")) continue;
        const v = all[k] || {};
        out.tabs[k] = {
          url: v.url || "",
          items: (v.items || []).map((pair) => {
            const it = Array.isArray(pair) ? pair[1] : pair;
            return it ? plainItem(it) : null;
          }).filter(Boolean),
        };
      }
      return out;
    })()
  `);
  return raw;
}

// ---------------------------------------------------------------- 步骤 5：下载记录实验
async function historyTest(browserCdp, extPage, victimTargetId) {
  const before = await extPage.evaluate(`(async () => {
    const v = await chrome.storage.session.get({ history: [] });
    return Array.isArray(v.history) ? v.history.length : -1;
  })()`);

  const probeName = "live-check-probe-" + Date.now();
  await extPage.evaluate(`(async () => {
    const v = await chrome.storage.session.get({ history: [] });
    const list = Array.isArray(v.history) ? v.history : [];
    list.push({ ok: true, name: ${JSON.stringify(probeName)}, size: 12345, time: Date.now(), error: "", file: "" });
    await chrome.storage.session.set({ history: list });
    return list.length;
  })()`);

  log("[5] 已写入一条探测记录：" + probeName + "（写入前 " + before + " 条）");

  if (victimTargetId) {
    await browserCdp.send("Target.closeTarget", { targetId: victimTargetId });
    log("     已关闭目标标签页，等待 2 秒…");
    await sleep(2000);
  }

  const after = await extPage.evaluate(`(async () => {
    const v = await chrome.storage.session.get({ history: [] });
    const list = Array.isArray(v.history) ? v.history : [];
    const hit = list.find((x) => x && x.name === ${JSON.stringify(probeName)});
    const all = await chrome.storage.session.get(null);
    return { count: list.length, kept: !!hit, keys: Object.keys(all) };
  })()`);

  const survived = after.kept;
  log("     关闭标签页后：" + after.count + " 条，探测记录" + (survived ? "仍在 ✅" : "已消失 ❌"));
  log("     当前 session keys：" + after.keys.join(", "));
  return { before, after, survived, probeName };
}

// ---------------------------------------------------------------- 步骤 6：渲染探针
/**
 * 用**真实条目**调 popup 的 renderItem，把生成的文案读出来。
 *
 * 为什么不看 popup 的真实 DOM：popup.html 作为普通标签页打开时，
 * `chrome.tabs.query({active:true})` 拿到的是它自己，列表必然是空的。
 * 直接调渲染函数既能验真实数据，又不受这个限制。
 */
async function renderCheck(extPage, items) {
  // 统一走 plainItem()：以前这里是另一份独立字段白名单，加了 dur/segs 之后
  // 只改了 dumpItems 那份，渲染探针还是旧的 —— 于是「条目里有 634 秒，
  // 界面显示时长未知」，白排查了一轮。
  const payload = JSON.stringify(items.slice(0, 40).map(plainItem));
  const res = await extPage.evaluate(`(async () => {
    const items = ${payload};
    if (typeof renderItem !== "function") return { err: "renderItem 不在全局（popup.js 没加载完）" };
    if (typeof MSHlsFamily === "undefined") return { err: "MSHlsFamily 未加载（hls-family.js 没引）" };
    const fam = MSHlsFamily.build(items);
    const rows = [];
    for (const it of items) {
      if (!fam.has(it.u)) continue;
      try {
        const row = renderItem(it, 1, fam);
        const meta = row.querySelector(".meta");
        rows.push({
          u: it.u,
          text: (meta ? meta.textContent : "").replace(/\\s+/g, " ").trim(),
          role: fam.get(it.u).role, index: fam.get(it.u).index, total: fam.get(it.u).total,
        });
      } catch (e) {
        rows.push({ u: it.u, err: String((e && e.message) || e).slice(0, 160) });
      }
    }
    return { rows };
  })()`);
  if (res.err) log("     ⚠ 渲染探针：" + res.err);
  else log("[6] 渲染探针：标出 " + res.rows.length + " 条清单关系");
  return res;
}

// ---------------------------------------------------------------- 步骤 7：下载 + 关标签页
/**
 * 复现用户的场景：**下载还在跑的时候关掉标签页**，看「下载记录」会不会丢。
 *
 * 为什么要真下载，不能只看存储：history 是在下载完成回调里写的（background.js
 * 的 notifySaved）。如果任务因为标签页消失 / SW 被回收而收不到回执，
 * 文件可能已经在磁盘上了，但记录永远不会出现 —— 用户看到的就是「记录消失」。
 */
// cdpTargetId 和 chromeTabId 是两个东西，别混：
//   · Target.closeTarget 要的是 CDP 的 targetId（一串大写哈希）；
//   · 发给扩展的 native:download 要的是 chrome.tabs 的 tabId（纯数字）。
// 混用会得到 "Invalid parameters"（2026-10-24 实测踩过一次）。
async function downloadTest(browserCdp, extPage, items, chromeTabId, cdpTargetId, tabUrl, extId) {
  const page = extPage.page || extPage;
  const cand = items.find((it) => /^https?:/i.test(it.u) && it.k !== "seg" && !/\.m3u8$/i.test(it.u))
    || items.find((it) => /^https?:/i.test(it.u));
  if (!cand) {
    log("[7] 没有可用 http 直链，跳过下载测试");
    return { skipped: "没有 http 直链" };
  }
  log("[7] 下载测试目标：" + shortUrl(cand.u, 80) + "（" + cand.k + "）");

  // 用 popup 自己的命名函数算一次名字，确认「标题优先」在真机上成立。
  // 直接调 downloadName 而不是在这里重写一份规则 —— 否则测的是我这份副本，
  // 不是用户实际走的那条路。
  let wantedName = "";
  try {
    const nr = await page.evaluate(`(() => {
      try {
        if (typeof downloadName !== "function") return { err: "downloadName 不在全局" };
        return { name: downloadName(${JSON.stringify({ ...cand, tabUrl })}), title: String(${JSON.stringify(cand.title || "")}).slice(0, 40) };
      } catch (e) { return { err: String((e && e.message) || e) }; }
    })()`);
    wantedName = (nr && nr.name) || "";
    log("     命名探针：标题「" + ((nr && nr.title) || "") + "」→ 文件名「" + wantedName + "」" + (nr && nr.err ? " (" + nr.err + ")" : ""));
  } catch (e) { log("     命名探针失败：" + e.message); }

  const before = await page.evaluate(`(async () => {
    const v = await chrome.storage.session.get({ history: [] });
    return Array.isArray(v.history) ? v.history.length : -1;
  })()`);

  const started = await page.evaluate(`(async () => {
    try {
      const r = await chrome.runtime.sendMessage({
        type: "native:download",
        url: ${JSON.stringify(cand.u)},
        kind: ${JSON.stringify(cand.k || "video")},
        filename: ${JSON.stringify(wantedName || "live-check-probe")},
        referer: ${JSON.stringify(tabUrl)},
        tabUrl: ${JSON.stringify(tabUrl)},
        tabId: ${Number(chromeTabId) || 0},
        headers: null,
      });
      return { ok: !!(r && r.ok), id: (r && r.id) || "", error: (r && r.error) || "" };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  })()`);
  if (!started.ok) {
    log("     下载没起来：" + started.error);
    return { before, started, error: started.error };
  }
  log("     任务已下单 id=" + started.id + "，立刻关闭标签页并等 " + Math.round(DOWNLOAD_WAIT / 1000) + " 秒…");

  await browserCdp.send("Target.closeTarget", { targetId: cdpTargetId });

  // 关键分支：先关掉扩展页面（= 用户关掉 popup），让 SW 进入空闲，
  // 等下载完成后再开一个新扩展页查记录。这样才复现得出「关界面后记录还在吗」。
  let probePage = extPage;
  if (CLOSE_POPUP) {
    log("     已关闭扩展页面（模拟用户关 popup），等 " + Math.round(DOWNLOAD_WAIT / 1000) + " 秒…");
    await browserCdp.send("Target.closeTarget", { targetId: extPage.targetId }).catch(() => {});
    await sleep(DOWNLOAD_WAIT);
    probePage = (await openExtensionPage(browserCdp, extId)).page;
    log("     重新打开扩展页面查记录");
  } else {
    await sleep(DOWNLOAD_WAIT);
  }

  const after = await (probePage.page || probePage).evaluate(`(async () => {
    const v = await chrome.storage.session.get({ history: [] });
    const list = Array.isArray(v.history) ? v.history : [];
    const last = await chrome.storage.local.get({ lastResult: null });
    return {
      count: list.length,
      // 只比对主干名：宿主遇到重名会加「(1)」，拿全名比会误判成「没写入」
      mine: list.filter((x) => x && String(x.name || "").indexOf(${JSON.stringify((wantedName || "live-check-probe").replace(/\.[a-z0-9]{2,5}$/i, "").slice(0, 10))}) >= 0),
      lastResult: last.lastResult || null,
    };
  })()`);

  const got = after.mine.length > 0;
  log("     下载记录：" + before + " → " + after.count + " 条，" + (got ? "本次任务**已写入** ✅" : "本次任务**没写入** ❌"));
  if (after.lastResult) {
    log("     lastResult：" + (after.lastResult.ok ? "成功" : "失败") + " · " + (after.lastResult.name || "") + " · " + (after.lastResult.size || 0) + " 字节");
  }
  return { before, started, after, wrote: got };
}

// ---------------------------------------------------------------- 输出
function shortUrl(u, n = 96) {
  u = String(u || "");
  return u.length > n ? u.slice(0, n - 12) + "…" + u.slice(-11) : u;
}

function report(items, hist, extId, ui, dl) {
  const lines = [];
  lines.push("# 真机取证 · " + TARGET_URL);
  lines.push("");
  lines.push("- 浏览器：" + (LOG[0] || ""));
  lines.push("- 扩展 ID：" + (extId || "(未知)"));
  lines.push("- 条目总数：" + items.length);
  lines.push("");

  const hls = items.filter((it) => it.hint === "hls" || /\.m3u8?(\?|$)/i.test(it.u));
  lines.push("## HLS 条目（" + hls.length + " 条）");
  if (!hls.length) lines.push("（本页没有 HLS 条目）");
  hls.forEach((it, i) => {
    const dur = it.t ? new Date(it.t).toISOString().slice(11, 19) : "";
    lines.push("### " + (i + 1) + " · " + (it.title || "(无标题)"));
    lines.push("- url: `" + shortUrl(it.u) + "`");
    lines.push("- kind=" + it.k + " mime=" + (it.m || "-") + " size=" + it.s + " page=" + it.page + " mid=" + (it.mid || "-") + " mark=" + (it.mark || "-"));
    lines.push("- 时间戳 " + dur + (it.f ? " · 文件名 " + it.f : ""));
    lines.push("");
  });

  // 核心判定：有没有两条指向同一个 URL（去重失败），或父子清单关系
  const byUrl = new Map();
  for (const it of hls) {
    const key = it.u;
    byUrl.set(key, (byUrl.get(key) || 0) + 1);
  }
  const dup = [...byUrl.entries()].filter(([, n]) => n > 1);
  lines.push("## 判定");
  if (dup.length) {
    lines.push("- ❌ **有 " + dup.length + " 个 URL 重复出现在多条里**（去重键失效）：");
    dup.forEach(([u, n]) => lines.push("  - ×" + n + " `" + shortUrl(u, 80) + "`"));
  } else if (hls.length > 1) {
    lines.push("- ✅ " + hls.length + " 条地址各不相同（不存在重复上报）");
  } else {
    lines.push("- 单条，无需判定");
  }
  lines.push("");
  lines.push("## 全部条目（按类型）");
  const byKind = {};
  for (const it of items) byKind[it.k] = (byKind[it.k] || 0) + 1;
  lines.push(Object.entries(byKind).map(([k, n]) => k + "=" + n).join(" · "));
  lines.push("");

  if (ui) {
    lines.push("## 渲染文案（真实条目喂给 renderItem）");
    if (ui.err) lines.push("- ⚠ " + ui.err);
    else if (!ui.rows.length) lines.push("（没有需要标注的清单条目）");
    else {
      for (const r of ui.rows) {
        const tag = r.role === "master" ? "主清单" : "变体 " + r.index + "/" + r.total;
        lines.push("- **" + tag + "** — " + (r.text || r.err || ""));
        lines.push("  - `" + shortUrl(r.u, 100) + "`");
      }
    }
    lines.push("");
  }

  if (dl) {
    lines.push("## 下载中关标签页 · 记录是否还在");
    if (dl.skipped) lines.push("- 跳过：" + dl.skipped);
    else if (dl.error) lines.push("- ❌ 下载没起来：" + dl.error);
    else {
      lines.push("- 目标：" + (dl.started.url || ""));
      lines.push("- 下单：" + (dl.started.ok ? "成功 id=" + dl.started.id : "失败 " + dl.started.error));
      lines.push("- 记录数：" + dl.before + " → " + dl.after.count);
      lines.push("- 本次任务写入记录：" + (dl.wrote ? "**是**" : "**否**"));
      if (dl.after.lastResult) {
        const r = dl.after.lastResult;
        lines.push("- lastResult：" + (r.ok ? "成功" : "失败") + " · " + (r.name || "") + " · " + (r.size || 0) + " 字节"
          + (r.error ? " · " + r.error : ""));
      }
      lines.push("");
      lines.push(dl.wrote
        ? "结论：**关了标签页也不影响下载记录写入**。用户看到记录消失，得往「关的是浏览器」或「扩展被重载」方向查。"
        : "结论：**复现了 —— 下载中关标签页，记录确实没写进去**。根因在下载完成回调没落到 notifySaved。");
    }
    lines.push("");
  }

  if (hist) {
    lines.push("## 下载记录实验");
    lines.push("- 写入前：" + hist.before + " 条");
    lines.push("- 关闭标签页后：" + hist.after.count + " 条，" + (hist.survived ? "探测记录**仍在**" : "探测记录**已消失**"));
    lines.push("- session keys：" + hist.after.keys.join(", "));
    lines.push("");
    lines.push(hist.survived
      ? "结论：关标签页**不会**清下载记录。若用户仍看到记录消失，问题在写入时机（下载完成前不写）或显示逻辑。"
      : "结论：关标签页**会**清掉下载记录 —— 已复现，需定位是谁删的。");
  }

  const dir = OUT ? resolve(OUT).replace(/[\\/][^\\/]+$/, "") : "D:/tmp";
  const mdOut = (OUT ? resolve(OUT).replace(/\.json$/i, "") : join(dir, "live-check")) + ".md";
  writeFileSync(mdOut, lines.join("\n") + "\n", "utf8");
  log("\n报告已写入 " + mdOut);
  return mdOut;
}

// ---------------------------------------------------------------- main
async function main() {
  const ver = await launch();

  // 命令行方式加载扩展（老路），失败则全靠 loadUnpacked
  try {
    const id = await loadExtension(ver);
    if (id) extId = id;
  } catch (e) {
    log("     扩展加载失败：" + e.message);
  }

  const browserCdp = await Cdp.connect(ver.webSocketDebuggerUrl);

  // 目标页
  const target = await openTarget(browserCdp);

  // 扩展页
  if (!extId) throw new Error("扩展没加载成功，无法取证（Extensions.loadUnpacked 未返回 id）");

  const extPage = await openExtensionPage(browserCdp, extId);

  // 找目标页对应的 tab:<id>
  const dump = await dumpItems(extPage.page);
  const keys = Object.keys(dump.tabs);
  log("[6] session 里的 tab 记录：" + keys.length + " 个");
  let picked = null;
  let pickedKey = "";
  for (const k of keys) {
    const t = dump.tabs[k];
    if (t.url && TARGET_URL.startsWith(t.url.split("?")[0].slice(0, 40))) { picked = t; pickedKey = k; }
  }
  if (!picked && keys.length) { picked = dump.tabs[keys[keys.length - 1]]; pickedKey = keys[keys.length - 1]; }
  const items = picked ? picked.items : [];
  const chromeTabId = pickedKey ? Number(pickedKey.slice(4)) : 0;
  log("     取到条目 " + items.length + " 条（tab " + chromeTabId + "，页面 " + (picked ? shortUrl(picked.url, 60) : "-") + "）");

  let hist = null;
  if (HISTORY_TEST) hist = await historyTest(browserCdp, extPage.page, target.targetId);

  let ui = null;
  if (RENDER_CHECK) {
    try { ui = await renderCheck(extPage.page, items); }
    catch (e) { log("     渲染探针失败：" + e.message); ui = { err: e.message }; }
  }

  // 下载测试会关掉目标标签页，必须放在所有读 items 的步骤之后。
  let dl = null;
  if (DOWNLOAD_TEST) {
    try { dl = await downloadTest(browserCdp, extPage, items, chromeTabId, target.targetId, TARGET_URL, extId); }
    catch (e) { log("     下载测试失败：" + e.message); dl = { error: e.message }; }
  }

  const md = report(items, hist, extId, ui, dl);
  if (OUT) {
    writeFileSync(OUT, JSON.stringify({
      when: new Date().toISOString(), url: TARGET_URL, extId,
      items, history: hist, log: LOG,
    }, null, 2), "utf8");
    log("JSON 已写入 " + OUT);
  }

  if (!KEEP) {
    try { await browserCdp.send("Browser.close"); } catch {}
    await sleep(800);
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  } else {
    log("（保留浏览器窗口，--keep）");
  }
  console.log(md);
  process.exit(0);
}

main().catch(async (e) => {
  console.error("失败：" + (e && e.stack || e));
  try { if (browser) browser.kill(); } catch {}
  process.exit(1);
});
