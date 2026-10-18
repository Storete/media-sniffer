// background.js 的单元测试：只测能脱离 Chrome 单独验证的纯逻辑。
//
// 目前重点是 watchFileReq —— 它曾经给每一条 msfile_chunk 都挂一个 120 秒定时器，
// 而闭包捕获的 msg 里带着 512KB 的分段数据。8 并发下 120 秒能堆 2000+ 条，
// 累计 1GB 以上常驻内存，service worker 直接 OOM：
// 真机表现就是 Telegram 8.8MB 文件下到 17% 彻底不动、连取消都等不到回执。
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BG = path.join(__dirname, "..", "extension", "background.js");

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  \u2713 " + name);
  } else {
    fail++;
    console.log("  \u2717 " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 300) : ""));
  }
}

// ---- 造一个足够让 background.js 顶层跑完的假环境
const timers = [];
const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  setTimeout(fn, ms) {
    const t = { fn, ms, cleared: false, id: timers.length };
    timers.push(t);
    return t.id;
  },
  clearTimeout(id) {
    if (timers[id]) timers[id].cleared = true;
  },
  setInterval() { return 0; },
  clearInterval() {},
  JSON,
  Object,
  Array,
  Map,
  Set,
  Promise,
  Date,
  Math,
  Number,
  String,
  Boolean,
  Error,
  RegExp,
  Uint8Array,
  encodeURIComponent,
  decodeURIComponent,
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

// chrome API 桩
const listeners = { onMessage: [], onConnect: [], tabs: [], onUpdated: [] };
function makeEvent(list) {
  return { addListener: (fn) => list.push(fn), removeListener() {} };
}
const storageData = {};
sandbox.chrome = {
  runtime: {
    onMessage: makeEvent(listeners.onMessage),
    onConnect: makeEvent(listeners.onConnect),
    onInstalled: makeEvent([]),
    onStartup: makeEvent([]),
    connectNative() {
      return {
        postMessage() {},
        onMessage: makeEvent([]),
        onDisconnect: makeEvent([]),
        disconnect() {},
      };
    },
    getManifest: () => ({ version: "1.2.3" }),
    lastError: null,
  },
  tabs: {
    onUpdated: makeEvent([]),
    onRemoved: makeEvent([]),
    onActivated: makeEvent([]),
    query: () => Promise.resolve([]),
    sendMessage: () => Promise.resolve(),
  },
  webRequest: {
    onBeforeRequest: makeEvent([]),
    onHeadersReceived: makeEvent([]),
    onResponseStarted: makeEvent([]),
    onCompleted: makeEvent([]),
    onErrorOccurred: makeEvent([]),
  },
  storage: {
    local: {
      get(def, cb) {
        const out = Object.assign({}, def, storageData);
        if (cb) cb(out);
        return Promise.resolve(out);
      },
      set(obj, cb) {
        Object.assign(storageData, obj);
        if (cb) cb();
        return Promise.resolve();
      },
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

// 顶层可能用到 importScripts，给它一个空实现
const importedScripts = [];
sandbox.importScripts = (...names) => {
  importedScripts.push(...names);
  for (const n of names) {
    const p = path.join(__dirname, "..", "extension", n);
    if (fs.existsSync(p)) {
      vm.runInContext(fs.readFileSync(p, "utf8"), ctx, { filename: n });
    }
  }
};

const ctx = vm.createContext(sandbox);
const bgCode = fs.readFileSync(BG, "utf8");

console.log("\n[1] 加载 background.js");
let loaded = false;
try {
  vm.runInContext(bgCode, ctx, { filename: "background.js" });
  loaded = true;
} catch (e) {
  console.log("  加载抛错（可能是缺少某个 API）：" + (e && e.message));
}
check("background.js 能在桩环境里加载", loaded);

console.log("\n[2] watchFileReq：chunk 不许挂定时器");
// 直接取测试用的内部函数
const watchSrc = bgCode.slice(bgCode.indexOf("const WATCHED_ACTIONS"));
check("存在 WATCHED_ACTIONS 白名单", watchSrc.length > 0 && bgCode.indexOf("WATCHED_ACTIONS") > 0);
check("白名单只含 start/end/abort",
  /"msfile_start"\s*,\s*"msfile_end"\s*,\s*"msfile_abort"/.test(bgCode),
  bgCode.match(/WATCHED_ACTIONS\s*=\s*new Set\(\[[^\]]*\]\)/));
check("msfile_chunk 不在白名单里", !/"msfile_chunk"/.test(
  (bgCode.match(/WATCHED_ACTIONS\s*=\s*new Set\(\[([^\]]*)\]\)/) || [])[1] || "__none__"));

// 真正验证行为：把 watchFileReq 抽出来跑
function extractFn(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) return null;
  let i = src.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  return null;
}

const fnSrc = extractFn(bgCode, "watchFileReq");
if (fnSrc) {
  const beforeCount = timers.length;
  const hostLogCalls = [];
  const testCtx = vm.createContext({
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false, id: timers.length }); return timers.length - 1; },
    clearTimeout() {},
    fileWatch: new Map(),
    WATCHED_ACTIONS: new Set(["msfile_start", "msfile_end", "msfile_abort"]),
    bridgePorts: new Map(),
    hostLog: (kind, text) => hostLogCalls.push([kind, text]),
    String, Map, Set, console,
  });
  vm.runInContext(fnSrc, testCtx, { filename: "watchFileReq" });
  const watch = testCtx.watchFileReq;

  const bigArray = new Array(524288).fill(7);
  for (let i = 0; i < 50; i++) {
    watch({ action: "msfile_chunk", id: "job1", text: "bytes=" + (i * 524288) + "-", data: bigArray }, {});
  }
  const chunkTimers = timers.length - beforeCount;
  check("50 条 chunk 一个定时器都不挂", chunkTimers === 0, chunkTimers);

  const before2 = timers.length;
  watch({ action: "msfile_end", id: "job1", total: 1 }, {});
  check("msfile_end 才挂定时器", timers.length - before2 === 1, timers.length - before2);

  const before3 = timers.length;
  watch({ action: "msfile_start", id: "job2", name: "x" }, {});
  check("msfile_start 不挂定时器", timers.length - before3 === 0, timers.length - before3);

  const before4 = timers.length;
  watch({ action: "msfile_abort", id: "job3" }, {});
  check("msfile_abort 挂定时器", timers.length - before4 === 1, timers.length - before4);
} else {
  check("能抽出 watchFileReq", false);
}

console.log("\n[3] 图片 / 图标 / 序号（纯逻辑抽出来单跑）");
// 这三块逻辑只依赖条目对象，不碰 chrome API，抽出来在干净的 ctx 里跑最稳
const pureCtx = vm.createContext({ console, Map, Set, String, Number, Math, JSON, URL, RegExp });
const rulesStart = bgCode.indexOf("const ICON_MAX");
const rulesEnd = bgCode.indexOf("// ---------------------------------------------------------------- 监听", rulesStart);
vm.runInContext(bgCode.slice(rulesStart, rulesEnd), pureCtx, { filename: "img-rules" });
// const 声明在 vm 里不进沙箱 global，用一个表达式把它们导出来
const rules = vm.runInContext(
  "({ looksLikeIcon, renumberImages, markOf, ICON_MAX, CIRCLE })", pureCtx, { filename: "img-rules-export" });
const { looksLikeIcon, renumberImages, markOf, ICON_MAX, CIRCLE } = rules;

check("ICON_MAX 是 96", ICON_MAX === 96, ICON_MAX);
check("序号表从 ① 开始", CIRCLE[0] === "①" && CIRCLE[1] === "②" && CIRCLE[2] === "③");
check("markOf(1) = ①", markOf(1) === "①");
check("markOf(21) 退回括号数字", markOf(21) === "(21)", markOf(21));

// ---- 图标判定：尺寸为主 + 页面归属 / URL 加严
// Telegram 的图片域就是 media-cdn.telesco.pe，UI 小图也来自它，不能拿
// 「在不在 CDN 域」区分。真正区分的是：有没有页面归属（mid / title）。
const tgThumb = "https://cdn4.telegram-cdn.org/file/abc/thumb.jpg";
check("32×32 的小图（URL 无特征）算图标", looksLikeIcon({ u: "https://x.com/a/32.webp", w: 32, h: 32 }) === true);
check("40×40 头像（URL 无特征）算图标", looksLikeIcon({ u: "https://x.com/a/40x40.jpg", w: 40, h: 40 }) === true);
check("96×96 刚好在阈值上，算图标", looksLikeIcon({ u: "https://x.com/a.png", w: 96, h: 96 }) === true);
check("97×97 超过阈值，不算图标", looksLikeIcon({ u: "https://x.com/a.png", w: 97, h: 97 }) === false);
check("1000×800 真图不算图标", looksLikeIcon({ u: "https://x.com/p.jpg", w: 1000, h: 800 }) === false);
// 尺寸小但带页面归属（imgctx 报上来的）→ 消息内容，不当图标
check("小尺寸但有 mid 不算图标（消息内容）",
  looksLikeIcon({ u: "https://x.com/a.png", w: 60, h: 60, mid: "8925" }) === false);
check("小尺寸但有标题不算图标（消息内容）",
  looksLikeIcon({ u: "https://x.com/a.png", w: 60, h: 60, title: "满足你的一切愿望的高清原图" }) === false);
// --- 页面标题污染（2026-10-18 真机数据，Edge+B站实测）---
// B 站视频页里 guessTitle() 会把整页的 h1 视频标题塞给每张装饰图，于是
// looksLikeIcon 原来「有 title 就放行」的第一条让它们全部漏进图片栏。
const BILI_REC = { url: "https://www.bilibili.com/video/BV1GJ411x7h7/" };
check("B站：充电按钮图标（hint=charge-btn-icon, 72×72）算图标",
  looksLikeIcon({ u: "https://i0.hdslb.com/bfs/garb/item/33e2e72d.png", w: 72, h: 72,
    hint: "charge-btn-icon", title: "【官方 MV】Never Gonna Give You Up - Rick Astley" }, BILI_REC) === true);
check("B站：头像占位 business.svg 算图标",
  looksLikeIcon({ u: "https://i0.hdslb.com/bfs/seed/jinkela/short/user-avatar/business.svg",
    title: "【官方 MV】Never Gonna Give You Up - Rick Astley" }, BILI_REC) === true);
check("B站：播放器 loading 图算图标",
  looksLikeIcon({ u: "https://s1.hdslb.com/bfs/static/player/img/ploading.png",
    title: "【官方 MV】Never Gonna Give You Up - Rick Astley" }, BILI_REC) === true);
check("B站：`正在缓冲...` 这类假标题不能当内容依据",
  looksLikeIcon({ u: "https://www.bilibili.com/x.jpg", w: 60, h: 60, title: "正在缓冲..." }, BILI_REC) === true);
check("B站：带站点后缀的页面标题（_哔哩哔哩）也算污染",
  looksLikeIcon({ u: "https://x.com/a.png", w: 60, h: 60, title: "某视频_哔哩哔哩_bilibili" }, BILI_REC) === true);
check("B站：真的大图即使带着页面标题也不算图标（别误杀封面）",
  looksLikeIcon({ u: "https://i1.hdslb.com/bfs/archive/5242750857.jpg@.webp", w: 1920, h: 1080,
    hint: "b-img__inner b-img", title: "【官方 MV】Never Gonna Give You Up - Rick Astley" }, BILI_REC) === false);
check("B站：微信分享卡片图（wxwork-share-pic，512×512）算装饰",
  looksLikeIcon({ u: "https://i0.hdslb.com/bfs/static/jinkela/long/images/512.png", w: 512, h: 512,
    hint: "wxwork-share-pic win" }, BILI_REC) === true);
check("Telegram 带 mid 的消息照片不受页面标题规则影响",
  looksLikeIcon({ u: "https://x.com/a.png", w: 60, h: 60, mid: "8925",
    title: "很长很长的一条消息正文内容" }, { url: "https://web.telegram.org/a/" }) === false);
check("小尺寸 URL 含 /file/ 不算图标",
  looksLikeIcon({ u: "https://x.com/file/1", w: 60, h: 60 }) === false);
check("小尺寸 URL 含 avatar 不算图标",
  looksLikeIcon({ u: "https://x.com/avatar/9.webp", w: 60, h: 60 }) === false);
// 尺寸未知（webRequest-only，B 站这类没有 DOM 归属的）：体积 + URL 兜底
check("无尺寸 + 5KB 小 webp（CDN 域）算图标（B 站场景）",
  looksLikeIcon({ u: "https://i0.hdslb.com/bfs/70eac.png@1c.webp", s: 5324 }) === true);
check("无尺寸 + 40KB（超过 24KB）不算图标",
  looksLikeIcon({ u: "https://i0.hdslb.com/bfs/cover.avif", s: 40528 }) === false);
check("无尺寸 + .ico 算图标", looksLikeIcon({ u: "https://x.com/favicon.ico", s: 4300 }) === true);
check("无尺寸 + .svg 算图标", looksLikeIcon({ u: "https://x.com/i/s8Z5o.svg", s: 733 }) === true);
check("无尺寸 + 非知名 CDN + 非 svg/ico 不猜（保真图）",
  looksLikeIcon({ u: "https://unknown.site/img/abc.jpg", s: 8000 }) === false);
check("无尺寸 + 无体积不算图标", looksLikeIcon({ u: "https://x.com/a.png" }) === false);
// Telegram 自带图标目录：emoji 在 /a/img-apple-64/，UI 素材在 /a/assets/
check("无尺寸 + Telegram emoji 目录算图标",
  looksLikeIcon({ u: "https://web.telegram.org/a/img-apple-64/1f602.png", s: 7158 }) === true);
check("无尺寸 + Telegram assets 目录算图标",
  looksLikeIcon({ u: "https://web.telegram.org/a/assets/wave-ripple-Cix9ChoB.webp", s: 27244 }) === true);

// ---- DOM 上下文判据（借鉴 Playwright 抓图脚本：尺寸 + 关键词 + 页头页脚）
// 有上下文时优先用上下文，比单看 URL 准；但 mid/title（消息归属）仍然最高优先。
check("有上下文：在 header 里 → 图标（即使尺寸很大）",
  looksLikeIcon({ u: "https://x.com/big.jpg", w: 1200, h: 400, ic: 1, hint: "hdr" }) === true);
check("有上下文：在 footer 里 → 图标",
  looksLikeIcon({ u: "https://x.com/f.jpg", w: 800, h: 300, ic: 1 }) === true);
check("有上下文：class 带 logo → 图标（即使尺寸很大）",
  looksLikeIcon({ u: "https://x.com/normal.jpg", w: 1200, h: 500, hint: "site-logo" }) === true);
check("有上下文：class 带 avatar → 图标",
  looksLikeIcon({ u: "https://x.com/pic.jpg", w: 500, h: 500, hint: "user-avatar" }) === true);
check("有上下文：alt 带 icon → 图标",
  looksLikeIcon({ u: "https://x.com/pic.jpg", w: 300, h: 300, hint: "设置 icon" }) === true);
check("有上下文：class 带 sprite → 图标",
  looksLikeIcon({ u: "https://x.com/pic.png", w: 600, h: 200, hint: "icon-sprite" }) === true);
check("有上下文：天然尺寸极小（60×60）→ 图标",
  looksLikeIcon({ u: "https://x.com/pic.jpg", w: 60, h: 60, hint: "some-class" }) === true);
check("有上下文：方形小图（300×300，像头像/徽章）→ 图标",
  looksLikeIcon({ u: "https://x.com/pic.jpg", w: 150, h: 150, hint: "thumb-wrap" }) === true);
check("有上下文：大图且无装饰特征 → 不算图标（不能误杀真图）",
  looksLikeIcon({ u: "https://x.com/photo.jpg", w: 1200, h: 800, hint: "content" }) === false);
check("有上下文：细长横幅（800×200）不算图标",
  looksLikeIcon({ u: "https://x.com/banner.jpg", w: 800, h: 200, hint: "post" }) === false);
check("有上下文也压不过 mid（消息内容最高优先）",
  looksLikeIcon({ u: "https://x.com/s.jpg", w: 60, h: 60, ic: 1, hint: "logo", mid: "8925" }) === false);
check("有上下文也压不过 title（消息内容最高优先，标题够长才算内容）",
  looksLikeIcon({ u: "https://x.com/s.jpg", w: 60, h: 60, ic: 1, hint: "logo", title: "满足你的一切愿望的高清原图" }) === false);
check("短标题（B站按钮文字「充电 关注 95.4万」）不足以豁免装饰判定",
  looksLikeIcon({ u: "https://x.com/s.jpg", w: 72, h: 72, hint: "charge-btn-icon", title: "充电 关注 95.4万" }) === true);
check("无上下文的老路径不受影响：97×97 仍不算图标",
  looksLikeIcon({ u: "https://x.com/a.png", w: 97, h: 97 }) === false);
check("无上下文的老路径不受影响：32×32 仍算图标",
  looksLikeIcon({ u: "https://x.com/a/32.webp", w: 32, h: 32 }) === true);

// ---- 序号：同一条消息内，按 DOM 阅读顺序
function mkRec(items, url) {
  return { items: new Map(items.map((it) => [it.u, it])), url: url || "" };
}

// 相册 3 张图，DOM 顺序被打乱（c=2, a=0, b=1），编号必须按 ord
const rec1 = mkRec([
  { u: "a", k: "image", mid: "8925", ord: 0, t: 1 },
  { u: "b", k: "image", mid: "8925", ord: 1, t: 2 },
  { u: "c", k: "image", mid: "8925", ord: 2, t: 3 },
]);
renumberImages(rec1);
check("三张图按 ord 编 ①②③",
  rec1.items.get("a").mark === "①" && rec1.items.get("b").mark === "②" && rec1.items.get("c").mark === "③",
  [...rec1.items.values()].map((x) => [x.u, x.mark]));

// 另一条消息从 ① 重新开始
const rec2 = mkRec([
  { u: "a", k: "image", mid: "8925", ord: 0, t: 1 },
  { u: "b", k: "image", mid: "8925", ord: 1, t: 2 },
  { u: "x", k: "image", mid: "8928", ord: 0, t: 3 },
  { u: "y", k: "image", mid: "8928", ord: 1, t: 4 },
]);
renumberImages(rec2);
check("不同消息各自从 ① 开始",
  rec2.items.get("a").mark === "①" && rec2.items.get("x").mark === "①",
  [...rec2.items.values()].map((x) => [x.mid, x.u, x.mark]));

// 只有一张的组不加序号
const rec3 = mkRec([{ u: "solo", k: "image", mid: "1", ord: 0, t: 1 }]);
renumberImages(rec3);
check("组里只有一张不加序号", rec3.items.get("solo").mark === "", rec3.items.get("solo").mark);

// 视频也编号，而且和图片分开排
const rec4 = mkRec([
  { u: "i1", k: "image", mid: "9", ord: 0, t: 1 },
  { u: "i2", k: "image", mid: "9", ord: 1, t: 2 },
  { u: "v1", k: "video", mid: "9", ord: 0, t: 3 },
  { u: "v2", k: "video", mid: "9", ord: 1, t: 4 },
]);
renumberImages(rec4);
check("图片和视频各自从 ① 起",
  rec4.items.get("i1").mark === "①" && rec4.items.get("v1").mark === "①",
  [...rec4.items.values()].map((x) => [x.k, x.u, x.mark]));

// ord 缺失时退回按抓到时间排
const rec5 = mkRec([
  { u: "late", k: "image", mid: "7", ord: -1, t: 200 },
  { u: "early", k: "image", mid: "7", ord: -1, t: 100 },
]);
renumberImages(rec5);
check("没有 DOM 顺序时按抓到先后排",
  rec5.items.get("early").mark === "①" && rec5.items.get("late").mark === "②",
  [...rec5.items.values()].map((x) => [x.u, x.mark]));

// 没有 mid 时按标题分组（普通网站）
const rec6 = mkRec([
  { u: "p1", k: "image", title: "同一篇", ord: 0, t: 1 },
  { u: "p2", k: "image", title: "同一篇", ord: 1, t: 2 },
  { u: "q1", k: "image", title: "别的", ord: 0, t: 3 },
]);
renumberImages(rec6);
check("无 mid 时按标题分组编号",
  rec6.items.get("p1").mark === "①" && rec6.items.get("p2").mark === "②" && rec6.items.get("q1").mark === "",
  [...rec6.items.values()].map((x) => [x.title, x.mark]));

// icon / audio 不参与编号
const rec7 = mkRec([
  { u: "ic", k: "icon", mid: "1", ord: 0, t: 1 },
  { u: "au", k: "audio", mid: "1", ord: 1, t: 2 },
  { u: "g1", k: "image", mid: "1", ord: 2, t: 3 },
  { u: "g2", k: "image", mid: "1", ord: 3, t: 4 },
]);
renumberImages(rec7);
check("图标和音频不占图片的序号",
  rec7.items.get("g1").mark === "①" && !rec7.items.get("ic").mark && !rec7.items.get("au").mark,
  [...rec7.items.values()].map((x) => [x.k, x.mark]));

// 既没有 mid 也没有 title 的图（B 站装饰图 / 头像，webRequest-only）不给编号
const rec8 = mkRec([
  { u: "d1", k: "image", title: "", ord: 0, t: 1 },
  { u: "d2", k: "image", title: "", ord: 1, t: 2 },
  { u: "d3", k: "image", title: "", ord: 2, t: 3 },
  { u: "d4", k: "image", title: "   ", ord: 3, t: 4 },
]);
renumberImages(rec8);
check("无 mid 无 title 的图不编号",
  !rec8.items.get("d1").mark && !rec8.items.get("d2").mark
    && !rec8.items.get("d3").mark && !rec8.items.get("d4").mark,
  [...rec8.items.values()].map((x) => [x.u, x.title, x.mark]));

console.log("\n[4] 小红书：详情页封面去重（用户真机反馈「封面那张图会有两张」）");
// 小红书这几个函数只依赖 URL / 条目对象，抽出来单独跑
const xhsStart = bgCode.indexOf("// ---------------------------------------------------------------- 小红书");
const xhsEnd = bgCode.indexOf("// ---------------------------------------------------------------- 监听", xhsStart);
const xhsCtx = vm.createContext({ console, Map, Set, String, Number, RegExp, URL });
vm.runInContext(bgCode.slice(xhsStart, xhsEnd), xhsCtx, { filename: "xhs-rules" });
const xhs = vm.runInContext(
  "({ isXhsHostUrl, isXhsDetailUrl, xhsImgIdentity, dedupeXhsNoteImages })", xhsCtx, { filename: "xhs-export" });
const { isXhsHostUrl, isXhsDetailUrl, xhsImgIdentity, dedupeXhsNoteImages } = xhs;

// ---- 域名 / 详情页判定
check("识别小红书域名", isXhsHostUrl("https://www.xiaohongshu.com/explore") === true);
check("识别小红书子域（web.xiaohongshu.com）", isXhsHostUrl("https://web.xiaohongshu.com/x") === true);
check("非小红书域名不认", isXhsHostUrl("https://www.bilibili.com/video/BV1") === false);
check("xiaohongshu.com.evil.com 不算（后缀必须真匹配）",
  isXhsHostUrl("https://xiaohongshu.com.evil.com/x") === false);
check("坏 URL 不抛错，返回 false", isXhsHostUrl("不是URL") === false);

check("识别帖子详情页 /explore/{24位hex}",
  isXhsDetailUrl("https://www.xiaohongshu.com/explore/6a7546a50000000032030d6d") === true);
check("识别帖子详情页 /discovery/item/{id}",
  isXhsDetailUrl("https://www.xiaohongshu.com/discovery/item/6a7546a50000000032030d6d") === true);
check("信息流首页不算详情页", isXhsDetailUrl("https://www.xiaohongshu.com/explore") === false);
check("搜索页不算详情页", isXhsDetailUrl("https://www.xiaohongshu.com/search_result?keyword=x") === false);
check("noteId 太短不算详情页", isXhsDetailUrl("https://www.xiaohongshu.com/explore/abc123") === false);
check("别的站点同名路径不算详情页",
  isXhsDetailUrl("https://evil.com/explore/6a7546a50000000032030d6d") === false);

// ---- 内容身份
const U1 = "https://sns-webpic-qc.xhscdn.com/202510181115/aaa/notes_pre_post/1040g3k03xyz!nc_n_webp_mw_1";
const U2 = "https://sns-webpic-qc.xhscdn.com/202510181115/aaa/notes_pre_post/1040g3k03xyz!nc_n_webp_mw_2";
check("同一张图的两个尺寸后缀 → 同一身份", xhsImgIdentity(U1) === xhsImgIdentity(U2), [xhsImgIdentity(U1), xhsImgIdentity(U2)]);
check("身份里不含 `!` 及其后的参数", !xhsImgIdentity(U1).includes("!"), xhsImgIdentity(U1));
check("query string 不进身份",
  xhsImgIdentity(U1 + "?imageView2/2/w/1080") === xhsImgIdentity(U1));
const U_DIFF = "https://sns-webpic-qc.xhscdn.com/202510181115/bbb/notes_pre_post/1040g3k03abc!nc_n_webp_mw_1";
check("不同图识别为不同身份", xhsImgIdentity(U1) !== xhsImgIdentity(U_DIFF));
check("坏 URL 的身份为空串（调用方就放弃去重）", xhsImgIdentity("不是URL") === "");

// ---- 去重行为
const mkImgItem = (u, extra) => Object.assign({ u, k: "image" }, extra || {});
// 封面同一张图两份（不同后缀、大小不同），正文另两张
const dupItems = [
  mkImgItem(U1, { s: 480000 }),
  mkImgItem(U2, { s: 120000 }),
  mkImgItem(U_DIFF, { s: 300000 }),
  mkImgItem("https://sns-webpic-qc.xhscdn.com/202510181115/ccc/notes_pre_post/1040g3k03def!nc_n_webp_mw_1", { s: 250000 }),
];
const deduped = dedupeXhsNoteImages(dupItems);
check("封面重复被合掉：4 条 → 3 条", deduped.length === 3, deduped.map((x) => x.u.slice(-40)));
check("封面保留体量最大的那条（s 大的赢）",
  deduped.some((x) => x.u === U1) && !deduped.some((x) => x.u === U2),
  deduped.map((x) => [x.u.slice(-30), x.s]));
check("其它两张正文图原样保留",
  deduped.some((x) => x.u === U_DIFF) && deduped.some((x) => x.u.includes("1040g3k03def")));

// 没有 s 时退回像素面积
const byArea = dedupeXhsNoteImages([
  mkImgItem(U1, { w: 1040, h: 1400 }),
  mkImgItem(U2, { w: 320, h: 430 }),
]);
check("没有字节数时按像素面积留大的", byArea.length === 1 && byArea[0].u === U1, byArea.map((x) => [x.u.slice(-20), x.w]));

// 保守线：不碰非 image、不碰非 1040g、身份坏的原样留
const mixed = [
  mkImgItem(U1, { s: 480000 }),
  mkImgItem(U2, { s: 120000 }),
  { u: "https://sns-webpic-qc.xhscdn.com/a/small!x", k: "image", s: 1000 },   // 无 1040g，不参与去重
  { u: "https://sns-webpic-qc.xhscdn.com/a/small!y", k: "image", s: 2000 },   // 同上
  { u: "https://sns-webpic-qc.xhscdn.com/b/1040gvideo!z", k: "video", s: 9000 }, // 视频不碰
];
const mixedOut = dedupeXhsNoteImages(mixed);
check("只合 1040g 的重复图，非 1040g 的小图都留着",
  mixedOut.filter((x) => x.k === "image").length === 3,
  mixedOut.map((x) => [x.k, x.u.slice(-16)]));
check("视频条目完全不受影响", mixedOut.some((x) => x.k === "video"));

// 完全没重复时不能少东西
const noDup = [
  mkImgItem(U1, { s: 1 }), mkImgItem(U_DIFF, { s: 2 }),
];
check("没有重复时一条不少", dedupeXhsNoteImages(noDup).length === 2);

// 空输入不能炸
check("空列表安全返回", Array.isArray(dedupeXhsNoteImages([])) && dedupeXhsNoteImages([]).length === 0);

console.log("\n[4b] 小红书详情页：整帖一组，按 DOM 顺序编号（用户要求「图片加排序」）");
// 小红书详情页的正文图/视频既没有 mid（不是 Telegram 消息）也没有 title，
// 老规则会整批跳过、永远不编号。详情页要按「整帖一组」按 ord 排。
const XHS_DETAIL = "https://www.xiaohongshu.com/explore/6a7546a50000000032030d6d";
const recX = mkRec([
  // DOM 顺序故意打乱：c(ord2) a(ord0) b(ord1)
  { u: "https://sns-webpic-qc.xhscdn.com/a/notes_pre_post/1040g3k01aaa!x", k: "image", ord: 2, t: 3 },
  { u: "https://sns-webpic-qc.xhscdn.com/a/notes_pre_post/1040g3k02bbb!x", k: "image", ord: 0, t: 1 },
  { u: "https://sns-webpic-qc.xhscdn.com/a/notes_pre_post/1040g3k03ccc!x", k: "image", ord: 1, t: 2 },
], XHS_DETAIL);
renumberImages(recX);
const xMarks = [...recX.items.values()].map((x) => [x.u.slice(-12), x.ord, x.mark]);
check("小红书详情页的图会编号（不再因为没 mid/title 被跳过）",
  xMarks.every((x) => x[2] !== ""), xMarks);
check("编号按 DOM 顺序（ord=0 得 ①、ord=1 得 ②、ord=2 得 ③）",
  recX.items.get("https://sns-webpic-qc.xhscdn.com/a/notes_pre_post/1040g3k02bbb!x").mark === "①"
  && recX.items.get("https://sns-webpic-qc.xhscdn.com/a/notes_pre_post/1040g3k03ccc!x").mark === "②"
  && recX.items.get("https://sns-webpic-qc.xhscdn.com/a/notes_pre_post/1040g3k01aaa!x").mark === "③",
  xMarks);

// 同一页里的视频单独一组、也编号
const recXV = mkRec([
  { u: "https://sns-webpic-qc.xhscdn.com/a/1040gimg1!x", k: "image", ord: 0, t: 1 },
  { u: "https://sns-webpic-qc.xhscdn.com/a/1040gimg2!x", k: "image", ord: 1, t: 2 },
  { u: "https://sns-video-hw.xhscdn.com/stream/abc.mp4", k: "video", ord: 0, t: 3 },
], XHS_DETAIL);
renumberImages(recXV);
check("小红书视频也参与编号",
  recXV.items.get("https://sns-video-hw.xhscdn.com/stream/abc.mp4").mark === "",
  [...recXV.items.values()].map((x) => [x.k, x.mark]));

// 非详情页（首页/信息流）保持老规则：没 mid 没 title 的仍然不编号
const recHome = mkRec([
  { u: "https://sns-webpic-qc.xhscdn.com/a/1040gfeed1!x", k: "image", ord: 0, t: 1 },
  { u: "https://sns-webpic-qc.xhscdn.com/a/1040gfeed2!x", k: "image", ord: 1, t: 2 },
], "https://www.xiaohongshu.com/explore");
renumberImages(recHome);
check("首页（非详情页）不误编号",
  [...recHome.items.values()].every((x) => !x.mark),
  [...recHome.items.values()].map((x) => x.mark));

console.log("\n==============================================");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
