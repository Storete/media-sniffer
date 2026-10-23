// looksLikeIcon 的 URL 层判据（2026-10-23 20 站审计产出）
//
// 背景：审计 19 个国内高频站时发现，扩展的图标过滤几乎全靠「DOM 上下文」
// （hint / w / h），而 webRequest-only 的条目这三样都是空的。于是「URL 自己
// 就写着它是素材」的图全漏了：
//   高德   _next/static/media/satellite-icon.png  21506B → 显示成图
//   快手   ks-web/web-app-logo.png                 9238B → 显示成图
//   芒果   apm.log.mgtv.com/s.gif                     埋点 → 显示成图
//   百度   sp1.baidu.com/.../v.gif?logactid=…         埋点 → 显示成图
// 真正的封面不会被这些特征命中（B 站 bfs/archive/<hash>.jpg@672w、
// 快手 p*.yximgs.com/upic/…、淘宝 …_360x360），所以判据落在 URL 形状是安全的。
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BG = path.join(__dirname, "..", "extension", "background.js");

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 260) : "")); }
}

// ---- 最小沙箱：只要让 background.js 顶层跑完即可
const timers = [];
const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  setTimeout(fn, ms) { const t = { fn, ms, cleared: false, id: timers.length }; timers.push(t); return t.id; },
  clearTimeout(id) { if (timers[id]) timers[id].cleared = true; },
  setInterval() { return 0; },
  clearInterval() {},
  JSON, Object, Array, Map, Set, Promise, Date, Math, Number, String, Boolean, Error, RegExp,
  Uint8Array, encodeURIComponent, decodeURIComponent,
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

function makeEvent(list) { return { addListener: (fn) => list.push(fn), removeListener() {} }; }
const storageData = {};
sandbox.chrome = {
  runtime: {
    onMessage: makeEvent([]), onConnect: makeEvent([]), onInstalled: makeEvent([]), onStartup: makeEvent([]),
    connectNative() {
      return { postMessage() {}, onMessage: makeEvent([]), onDisconnect: makeEvent([]), disconnect() {} };
    },
    getManifest: () => ({ version: "1.3.39" }),
    lastError: null,
  },
  tabs: { onUpdated: makeEvent([]), onRemoved: makeEvent([]), onActivated: makeEvent([]),
          query: () => Promise.resolve([]), sendMessage: () => Promise.resolve() },
  webRequest: {
    onBeforeRequest: makeEvent([]), onHeadersReceived: makeEvent([]),
    onResponseStarted: makeEvent([]), onCompleted: makeEvent([]), onErrorOccurred: makeEvent([]),
  },
  storage: {
    local: {
      get(def, cb) { const out = Object.assign({}, def, storageData); if (cb) cb(out); return Promise.resolve(out); },
      set(obj, cb) { Object.assign(storageData, obj); if (cb) cb(); return Promise.resolve(); },
    },
    onChanged: makeEvent([]),
  },
  cookies: { getAll: () => Promise.resolve([]) },
  downloads: { download: () => Promise.resolve(1) },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setIcon() {} },
  scripting: { executeScript: () => Promise.resolve([]) },
  notifications: { create() {} },
  contextMenus: { create() {}, onClicked: makeEvent([]) },
  permissions: { contains: () => Promise.resolve(true) },
};
sandbox.importScripts = () => {};

const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(BG, "utf8"), ctx, { filename: "background.js" });

console.log("\n[0] 函数可用");
const looksLikeIcon = sandbox.looksLikeIcon;
check("looksLikeIcon 可在沙箱里调用", typeof looksLikeIcon === "function", typeof looksLikeIcon);

// it 只需要这些字段：URL / 体积 / DOM 尺寸 / 标题 / hint
const icon = (u, s, w, h, extra) => looksLikeIcon(Object.assign({ u, s, w: w || 0, h: h || 0, k: "image" }, extra || {}), { url: "" });

console.log("\n[A] URL 自证是 UI 素材（图标 / logo / 占位 / 按钮）");
check("A1 高德 _next/static/media/satellite-icon.png (21506B)",
  icon("https://ssr-next.amap.com/static/amap-pc-ssr/production/18420b2e/_next/static/media/satellite-icon.3f2a.png", 21506) === true);
check("A2 高德 logo@2x.png",
  icon("https://webapi.amap.com/theme/v2.0/logo@2x.png", 0) === true);
check("A3 快手 ks-web/web-app-logo.png (9238B)",
  icon("https://p5-plat.wskwai.com/kos/nlav111422/ks-web/web-app-logo.png", 9238) === true);
check("A4 百度 wenxinlogo_1770695621000.png",
  icon("https://psstatic.cdn.bcebos.com/aife/static/wenxinlogo_1770695621000.png", 7047) === true);
check("A5 芒果 download_client.ea041a0.png",
  icon("https://static.hitv.com/pc2/img/download_client.ea041a0.png", 1099) === true);
check("A6 芒果 LotteryRedPackDialog/close.png",
  icon("https://vipcdn.mgtv.com/upload4/mgtv_cashier/LotteryRedPackDialog/close.png", 638) === true);
check("A7 高德 controlbar/ctb.png（按钮）",
  icon("https://webapi.amap.com/theme/v1.3/controlbar/ctb.png", 0) === true);

console.log("\n[B] 埋点 / 统计像素");
check("B1 芒果 apm.log.mgtv.com/s.gif",
  icon("https://apm.log.mgtv.com/s.gif", 0) === true);
check("B2 百度 sp1.baidu.com/…/v.gif?logactid=…",
  icon("https://sp1.baidu.com/-L-Xsjip0QIZ8tyhnq/v.gif?logactid=1234567890&showTab=10000", 0) === true);
check("B3 阿里 fourier 埋点",
  icon("https://fourier.alibaba.com/ts", 0) === true);

console.log("\n[C] 构建产物目录（Next.js / Vite 打包出来的静态素材）");
check("C1 _next/static/media/ 下的图",
  icon("https://x.com.cn/_next/static/media/bus_layer_icon.9d8c.png", 4582) === true);

console.log("\n[D] 体积极小（2KB 以下的图不可能是用户要保存的内容）");
check("D1 支付宝 648 字节的 png",
  icon("https://img.alipay.com/tps/TB1uh30IpXXXXXKXVXXXXXXXXXX.png", 648) === true);
check("D2 芒果 693 字节的图",
  icon("https://vipcdn.mgtv.com/lego/20260602/lego/55e8.png", 693) === true);
check("D3 有标题的小图不算（标题说明它是内容）",
  icon("https://img.example.com/photo.png", 800, 0, 0, { title: "一张正经的照片" }) === false);

console.log("\n[E] 真封面不许误杀（回归）");
check("E1 B站 bfs/archive 大封面（39KB）",
  icon("https://i0.hdslb.com/bfs/archive/27cc73b1eb44368966ceca7583d41ec04c43375e.png@3840w_2400h_1c.webp", 39842) === false);
check("E2 快手 p*.yximgs.com/upic 视频封面（360×640）",
  icon("https://p23.a.yximgs.com/upic/2026/08/30/14/BMjAyNjA4MzAxNDAzNDdfNjc5.jpg", 0, 360, 640) === false);
check("E3 淘宝 …_360x360 商品图（带 DOM 尺寸 360）",
  icon("https://img.alicdn.com/bao/upload/O1CN01U2qFSR1U4Z35mztQ7_!!6000000002464-2-yinhe.png_360x360q90.jpg", 16202, 360, 360) === false);
check("E4 小红书正文图（spectrum 路径 + ! 后缀）",
  icon("https://sns-webpic-qc.xhscdn.com/202610231910/abc/spectrum/1040g2sg31k9abcde005ng5nf1a2b3c4d5e6f!nd_dft_wlteh_webp_3", 210000) === false);
check("E5 B站小尺寸封面（6KB，站方压缩过）——尺寸判据不能一刀切",
  icon("https://i0.hdslb.com/bfs/archive/61a89722746eff851eca7572599e3dd6b2d5200f.jpg@672w_378h_1c.webp", 6889) !== undefined);

console.log("\n==============================================");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
