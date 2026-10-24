#!/usr/bin/env node
/* 用户报障复现 harness：51cg1.com 真实数据回放 popup 的 load() 全链。
 *
 * 背景：用户真机截图——筛选「视频 1」后列表区空白（连空态都没有）、
 * 「检测本地下载器…」卡住。headless 复现不了（popup 的 tabs.query 拿到的是
 * popup 自己），所以在这里用「SW 里抓出的真实条目 + chrome 桩」完整模拟
 * popup 页面场景：tabs.query 返回 51cg1 标签、sniff:get 返回真实 items。
 *
 * 用法： node test/replay_51cg1.js   （数据文件在 %TEMP%/ms-51-full.json）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "..", "extension");
const HTML = fs.readFileSync(path.join(EXT, "popup.html"), "utf8");
const DATA = path.join(process.env.TEMP || process.env.TMP, "ms-51-full.json");
const raw = JSON.parse(fs.readFileSync(DATA, "utf8"));

// ---- 最小 DOM 桩（够 popup.js 的 load/renderChips/renderItem 跑完） ----
class FakeEl {
  constructor(tag) {
    this.tagName = (tag || "div").toUpperCase();
    this.children = [];
    this.style = { cssText: "", maxWidth: "" };
    this.dataset = {};
    this._attrs = {};
    this._listeners = {};
    this.classList = {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    };
    this.value = "";
    this.textContent = "";
    this.innerHTML = "";
    this.title = "";
    this.placeholder = "";
    this.disabled = false;
    this.checked = false;
    this.type = "";
    this.className = "";
  }
  get id() { return this._attrs.id || ""; }
  set id(v) { this._attrs.id = v; }
  append(...xs) { this.children.push(...xs); }
  appendChild(x) { this.children.push(x); return x; }
  replaceChildren(...xs) { this.children = xs; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  getAttribute(a) { return this._attrs[a] !== undefined ? this._attrs[a] : null; }
  setAttribute(a, v) { this._attrs[a] = v; }
  remove() {}
  click() { (this._listeners.click || []).forEach((f) => f({ target: this })); }
}

const byId = new Map();
function regId(el) { if (el._attrs && el._attrs.id) byId.set(el._attrs.id, el); return el; }
function mk(tag) { return regId(new FakeEl(tag)); }

// popup.html 的静态结构（load/renderList 会碰的节点）
// 从 popup.html 提取全部 id，自动预建（加载时的绑定一个都不能少）
for (const m of HTML.match(/id="([^"]+)"/g) || []) {
  const id = m.slice(4, -1);
  if (!byId.has(id)) { const e = mk("div"); e._attrs.id = id; byId.set(id, e); }
}
console.log("[harness] HTML id 数:", (HTML.match(/id="([^"]+)"/g) || []).length,
            "| byId:", byId.size, "| reload:", !!byId.get("reload"));

const fakeDocument = {
  createElement: (t) => mk(t),
  createTextNode: (t) => ({ textContent: t }),
  getElementById: (id) => byId.get(id) || null,
  // popup.js 的 $() 走 querySelector("#id") —— 按 id 精确匹配
  querySelector: (sel) => (sel && sel[0] === "#") ? (byId.get(sel.slice(1)) || null) : null,
  querySelectorAll: () => [],
  addEventListener() {},
  body: mk("body"),
  documentElement: mk("html"),
};

const sandboxLog = [];
const store = { local: { concurrency: 16, outdir: "", useCookies: true, msRecentErrors: [] }, session: {} };
const counts = {};
for (const it of raw.items) counts[it.k] = (counts[it.k] || 0) + 1;

const listeners = { onMessage: [] };
function makeEvent(l) { return { addListener: (fn) => l.push(fn), removeListener() {} }; }

const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  setTimeout(fn, ms) { return 0; }, clearTimeout() {},
  setInterval() { return 0; }, clearInterval() {},
  JSON, Object, Array, Map, Set, Promise, Date, Math, Number, String, Boolean, Error, RegExp,
  Uint8Array, encodeURIComponent, decodeURIComponent, URL,
  document: fakeDocument,
  navigator: { clipboard: { writeText: async () => {} } },
  location: { href: "chrome-extension://x/popup.html" },
  window: null,
  chrome: {
    runtime: {
      onMessage: makeEvent(listeners.onMessage),
      onInstalled: makeEvent([]), onConnect: makeEvent([]), onStartup: makeEvent([]),
      getManifest: () => ({ version: "1.3.62" }),
      lastError: null,
      sendMessage(msg, cb) {
        if (msg.type === "sniff:get") {
          const out = { ok: true, items: raw.items, counts,
                        tabUrl: raw.tabUrl, diag: null, focus: null };
          if (cb) cb(out); return Promise.resolve(out);
        }
        const out = { ok: true };
        if (cb) cb(out); return Promise.resolve(out);
      },
    },
    tabs: {
      query(q) { return Promise.resolve([{ id: raw.tabId, url: raw.tabUrl, active: true }]); },
      sendMessage(tabId, msg, cb) { if (cb) cb({}); return Promise.resolve({}); },
      create() {}, update() {},
    },
    storage: {
      local: {
        get(def, cb) { const o = Object.assign({}, def, store.local); if (cb) cb(o); return Promise.resolve(o); },
        set(o, cb) { Object.assign(store.local, o); if (cb) cb(); return Promise.resolve(); },
      },
      session: {
        get(def, cb) { const o = Object.assign({}, def, store.session); if (cb) cb(o); return Promise.resolve(o); },
        set(o, cb) { Object.assign(store.session, o); if (cb) cb(); return Promise.resolve(); },
        remove(k, cb) { if (cb) cb(); return Promise.resolve(); },
      },
    },
  },
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
sandbox.importScripts = (...names) => {
  for (const n of names) {
    const p = path.join(EXT, n);
    if (fs.existsSync(p)) vm.runInContext(fs.readFileSync(p, "utf8"), ctx, { filename: n });
  }
};
sandbox.MSHlsFamily = undefined; // popup.html 用 <script>，等效于全局可见

const ctx = vm.createContext(sandbox);
// popup.html 的脚本顺序：hls-family → naming → popup
for (const n of ["hls-family.js", "naming.js", "popup.js"]) {
  vm.runInContext(fs.readFileSync(path.join(EXT, n), "utf8"), ctx, { filename: n });
}

(async () => {
  // 用户场景：点开「视频」筛选（filter 变量在 popup.js 顶层，可从上下文直接改）
  try {
    await vm.runInContext("load()", ctx);
  } catch (e) {
    console.log("load() 抛错:", e.message);
    console.log((e.stack || "").split("\n").slice(0, 6).join("\n"));
    process.exit(1);
  }
  // 模拟用户点「视频」chip：直接调内部逻辑（filter 是顶层 let）
  try {
    vm.runInContext('filter = "video"; renderChips(); renderList();', ctx);
  } catch (e) {
    console.log("视频筛选 renderList 抛错:", e.message);
    console.log((e.stack || "").split("\n").slice(0, 8).join("\n"));
    process.exit(1);
  }
  const list = byId.get("list");
  console.log("filter=video 后 #list 子节点:", list.children.length);
  console.log("innerHTML 头 120:", (list.innerHTML || "").slice(0, 120).replace(/\n/g, " "));
  const st = byId.get("hostState");
  console.log("hostState 文本:", st && st.textContent);
})().catch((e) => { console.error("harness 挂了:", e.message); process.exit(1); });
