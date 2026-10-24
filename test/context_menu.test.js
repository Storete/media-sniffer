// B29 右键菜单：注册 / 点击处理 / blob 降级问页面 / 命名。
//
// 沙箱与桩的骨架抄自 background.test.js（同一份 background.js 全量加载）。
// 这里只验菜单这条链，不重复那里的嗅探回归。
//
// 三个判据（DEVELOPMENT B29 的设计）：
//   ① 三类菜单按 contexts 分流注册；不做「解析此页」（B28 未排期，不注册空转菜单项）；
//   ② srcUrl 可用直接下（复用 startNativeDownload），blob/空才回页面问真实地址；
//   ③ 问不到（页面也是 blob / 超时）**不静默**——失败原因写进下载记录。
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BG = path.join(__dirname, "..", "extension", "background.js");
const bgCode = fs.readFileSync(BG, "utf8");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name + (extra === undefined ? "" : "  -> " + JSON.stringify(extra).slice(0, 240))); }
}
function section(t) { console.log("\n" + t); }

const timers = [];
const listeners = { onMessage: [], onInstalled: [] };
const menusCreated = [];
const tabsSent = [];
const hostMsgs = [];
const storageData = {};
const sessionStore = {};

function makeEvent(list) { return { addListener: (fn) => list.push(fn), removeListener() {} }; }

const sandbox = {
  console: { log() {}, warn() {}, error() {}, info() {} },
  setTimeout(fn, ms) { const t = { fn, ms, cleared: false, id: timers.length }; timers.push(t); return t.id; },
  clearTimeout(id) { if (timers[id]) timers[id].cleared = true; },
  setInterval() { return 0; }, clearInterval() {},
  JSON, Object, Array, Map, Set, Promise, Date, Math, Number, String, Boolean, Error, RegExp,
  Uint8Array, encodeURIComponent, decodeURIComponent,
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  URL,
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;

const nativePortListeners = [];
sandbox.chrome = {
  runtime: {
    onMessage: makeEvent(listeners.onMessage),
    onConnect: makeEvent([]),
    onInstalled: makeEvent(listeners.onInstalled),
    onStartup: makeEvent([]),
    connectNative() {
      return {
        postMessage(m) { hostMsgs.push(m); },
        onMessage: makeEvent(nativePortListeners),
        onDisconnect: makeEvent([]),
        disconnect() {},
      };
    },
    getManifest: () => ({ version: "1.3.58" }),
    lastError: null,
    sendMessage() { return Promise.resolve(); },
  },
  contextMenus: {
    removeAll(cb) { menusCreated.length = 0; if (cb) cb(); },
    create(o) { menusCreated.push(o); },
    onClicked: makeEvent([]),
  },
  tabs: {
    onUpdated: makeEvent([]), onRemoved: makeEvent([]), onActivated: makeEvent([]),
    query: () => Promise.resolve([]),
    // 捕获 background 发给页面的消息；应答由测试手动走 ms:page 模拟 content 转发
    sendMessage(tabId, msg, cb) { tabsSent.push({ tabId, msg }); if (cb) cb(); },
    reload() {},
    create() {},
  },
  webRequest: { onBeforeRequest: makeEvent([]), onHeadersReceived: makeEvent([]), onResponseStarted: makeEvent([]), onCompleted: makeEvent([]), onErrorOccurred: makeEvent([]) },
  storage: {
    local: {
      get(def, cb) { const out = Object.assign({}, def, storageData); if (cb) cb(out); return Promise.resolve(out); },
      set(obj, cb) { Object.assign(storageData, obj); if (cb) cb(); return Promise.resolve(); },
    },
    session: {
      get(def, cb) { const out = Object.assign({}, def, sessionStore); if (cb) cb(out); return Promise.resolve(out); },
      set(obj, cb) { Object.assign(sessionStore, obj); if (cb) cb(); return Promise.resolve(); },
      remove(keys, cb) { for (const k of [].concat(keys)) delete sessionStore[k]; if (cb) cb(); return Promise.resolve(); },
    },
    onChanged: makeEvent([]),
  },
  cookies: { getAll: () => Promise.resolve([]) },
  downloads: { download: () => Promise.resolve(1) },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setIcon() {} },
  scripting: { executeScript: () => Promise.resolve([]) },
  notifications: { create() {} },
};
sandbox.importScripts = (...names) => {
  for (const n of names) {
    const p = path.join(__dirname, "..", "extension", n);
    if (fs.existsSync(p)) vm.runInContext(fs.readFileSync(p, "utf8"), ctx, { filename: n });
  }
};

const ctx = vm.createContext(sandbox);
vm.runInContext(bgCode, ctx, { filename: "background.js" });

const onMessageHandler = listeners.onMessage[listeners.onMessage.length - 1];
const onClickedHandler = sandbox.chrome.contextMenus.onClicked.addListener
  ? null : null; // 占位：onClicked 回调从 listeners 取

(async () => {
  // ---------------------------------------------------------------- [1] 注册
  section("[1] onInstalled 注册三类菜单（不做 B28 的「解析此页」）");
  await listeners.onInstalled[0]();
  ok("注册了 3 个菜单项", menusCreated.length === 3, menusCreated.map((m) => m.id));
  const byId = {};
  for (const m of menusCreated) byId[m.id] = m;
  ok("视频/音频项 contexts=video+audio", JSON.stringify(byId["ms-dl-media"].contexts) === JSON.stringify(["video", "audio"]), byId["ms-dl-media"]);
  ok("图片项 contexts=image", JSON.stringify(byId["ms-dl-image"].contexts) === JSON.stringify(["image"]), byId["ms-dl-image"]);
  ok("链接项存在且不含「解析此页」", !!byId["ms-dl-link"] && !byId["ms-dl-page"], Object.keys(byId));

  // onMessage handler（ctx-res 分发走它）
  const pageMsg = (payload) => onMessageHandler(
    { type: "ms:page", payload }, { tab: { id: 7 } }, () => {});

  // ---------------------------------------------------------------- [2] 直下
  section("[2] srcUrl 可用：直接走 startNativeDownload（host 桩收到 download）");
  hostMsgs.length = 0;
  await sandbox.handleContextMenu(
    { menuItemId: "ms-dl-media", srcUrl: "https://cdn.example.com/v/clip_01.mp4?q=1", pageUrl: "https://x/page" },
    { id: 7 });
  const d2 = hostMsgs.find((m) => m.action === "download");
  ok("发起了下载", !!d2, hostMsgs.map((m) => m.action));
  ok("地址就是 srcUrl", d2 && d2.url === "https://cdn.example.com/v/clip_01.mp4?q=1", d2 && d2.url);
  ok("kind=video", d2 && d2.kind === "video", d2 && d2.kind);
  ok("文件名取 URL 尾段", d2 && d2.filename === "clip_01.mp4", d2 && d2.filename);
  ok("referer 带页面地址", d2 && d2.referer === "https://x/page", d2 && d2.referer);

  // ---------------------------------------------------------------- [3] blob 问页面
  section("[3] srcUrl 是 blob：回页面取真实地址（懒加载/录制场景）");
  hostMsgs.length = 0;
  const p3 = sandbox.handleContextMenu(
    { menuItemId: "ms-dl-media", srcUrl: "blob:https://x/abc", pageUrl: "https://x/page" }, { id: 7 });
  await new Promise((r) => setTimeout(r, 0));
  const ask = tabsSent[tabsSent.length - 1];
  ok("向页面发了 ms:ctx-get", ask && ask.msg && ask.msg.type === "ms:ctx-get" && ask.msg.requestId, ask && ask.msg);
  // 模拟 content 转发页面的应答
  pageMsg({ cmd: "ctx-res", requestId: ask.msg.requestId,
    ctx: { url: "https://cdn.example.com/img/real-big.jpg", kind: "image", name: "商品实拍图" } });
  await p3;
  const d3 = hostMsgs.find((m) => m.action === "download");
  ok("改用页面解析出的真实地址", d3 && d3.url === "https://cdn.example.com/img/real-big.jpg", d3 && d3.url);
  ok("kind 跟随页面判定=image", d3 && d3.kind === "image", d3 && d3.kind);
  ok("文件名用元素上下文（alt）", d3 && d3.filename === "商品实拍图", d3 && d3.filename);

  // ---------------------------------------------------------------- [4] 双 blob 不静默
  section("[4] 页面也拿不到直链：不下载，失败原因写进下载记录");
  hostMsgs.length = 0;
  const p4 = sandbox.handleContextMenu(
    { menuItemId: "ms-dl-media", srcUrl: "blob:https://x/def", pageUrl: "https://x/page" }, { id: 7 });
  await new Promise((r) => setTimeout(r, 0));
  const ask4 = tabsSent[tabsSent.length - 1];
  pageMsg({ cmd: "ctx-res", requestId: ask4.msg.requestId,
    ctx: { url: "blob:https://x/still-blob", kind: "video", name: "x" } });
  await p4;
  await new Promise((r) => setTimeout(r, 5));   // notifySaved 是异步写，等它落盘
  ok("没有发起下载", !hostMsgs.some((m) => m.action === "download"), hostMsgs.map((m) => m.action));
  const h4 = sessionStore.history || [];
  const last4 = h4[h4.length - 1];
  ok("下载记录里写了失败与原因", last4 && last4.ok === false && /流式播放|blob/.test(last4.why || last4.error || ""), last4);

  // ---------------------------------------------------------------- [5] 超时降级
  section("[5] 页面不应答（超时）：srcUrl 原路，blob 则记失败，不挂死");
  hostMsgs.length = 0;
  // 直接清掉 pendingCtx 的应答路径：不模拟 ctx-res，驱动全部计时器
  const p5 = sandbox.handleContextMenu(
    { menuItemId: "ms-dl-media", srcUrl: "blob:https://x/ghi", pageUrl: "https://x/page" }, { id: 7 });
  await new Promise((r) => setTimeout(r, 0));
  for (const t of timers) { if (!t.cleared) { t.cleared = true; t.fn(); } }
  await p5;
  await new Promise((r) => setTimeout(r, 5));
  ok("超时后不挂死也不下载", !hostMsgs.some((m) => m.action === "download"));
  ok("超时也留下失败记录", (sessionStore.history || []).length >= 2);

  // ---------------------------------------------------------------- [6] link 菜单
  section("[6] 链接菜单：linkUrl 直接下，kind=other");
  hostMsgs.length = 0;
  await sandbox.handleContextMenu(
    { menuItemId: "ms-dl-link", linkUrl: "https://cdn.example.com/a/track.m4a", pageUrl: "https://x/page" },
    { id: 7 });
  const d6 = hostMsgs.find((m) => m.action === "download");
  ok("linkUrl 直接下载", d6 && d6.url === "https://cdn.example.com/a/track.m4a", d6);
  ok("kind=other", d6 && d6.kind === "other", d6 && d6.kind);

  console.log("\n" + (fail ? "有失败：" : "全部通过：") + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("测试跑挂了：", e && e.message); process.exit(1); });
