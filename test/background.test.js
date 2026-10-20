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
  "({ looksLikeIcon, renumberImages, numberShown, markOf, ICON_MAX, CIRCLE })", pureCtx, { filename: "img-rules-export" });
const { looksLikeIcon, renumberImages, numberShown, markOf, ICON_MAX, CIRCLE } = rules;

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

// 编号已从 renumberImages 挪到 numberShown（只给「最终显示的条目」编号，见其注释）。
// 这些用例验的都是「用户看到的序号」，所以统一走 numberShown。
function numberRec(rec) {
  numberShown([...rec.items.values()], rec.url || "");
  return rec;
}

// 相册 3 张图，DOM 顺序被打乱（c=2, a=0, b=1），编号必须按 ord
const rec1 = mkRec([
  { u: "a", k: "image", mid: "8925", ord: 0, t: 1 },
  { u: "b", k: "image", mid: "8925", ord: 1, t: 2 },
  { u: "c", k: "image", mid: "8925", ord: 2, t: 3 },
]);
numberRec(rec1);
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
numberRec(rec2);
check("不同消息各自从 ① 开始",
  rec2.items.get("a").mark === "①" && rec2.items.get("x").mark === "①",
  [...rec2.items.values()].map((x) => [x.mid, x.u, x.mark]));

// 只有一张的组不加序号
const rec3 = mkRec([{ u: "solo", k: "image", mid: "1", ord: 0, t: 1 }]);
numberRec(rec3);
check("组里只有一张不加序号", rec3.items.get("solo").mark === "", rec3.items.get("solo").mark);

// 视频也编号，而且和图片分开排
const rec4 = mkRec([
  { u: "i1", k: "image", mid: "9", ord: 0, t: 1 },
  { u: "i2", k: "image", mid: "9", ord: 1, t: 2 },
  { u: "v1", k: "video", mid: "9", ord: 0, t: 3 },
  { u: "v2", k: "video", mid: "9", ord: 1, t: 4 },
]);
numberRec(rec4);
check("图片和视频各自从 ① 起",
  rec4.items.get("i1").mark === "①" && rec4.items.get("v1").mark === "①",
  [...rec4.items.values()].map((x) => [x.k, x.u, x.mark]));

// ord 缺失时退回按抓到时间排
const rec5 = mkRec([
  { u: "late", k: "image", mid: "7", ord: -1, t: 200 },
  { u: "early", k: "image", mid: "7", ord: -1, t: 100 },
]);
numberRec(rec5);
check("没有 DOM 顺序时按抓到先后排",
  rec5.items.get("early").mark === "①" && rec5.items.get("late").mark === "②",
  [...rec5.items.values()].map((x) => [x.u, x.mark]));

// 没有 mid 时按标题分组（普通网站）
const rec6 = mkRec([
  { u: "p1", k: "image", title: "同一篇", ord: 0, t: 1 },
  { u: "p2", k: "image", title: "同一篇", ord: 1, t: 2 },
  { u: "q1", k: "image", title: "别的", ord: 0, t: 3 },
]);
numberRec(rec6);
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
numberRec(rec7);
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
numberRec(rec8);
check("无 mid 无 title 的图不编号",
  !rec8.items.get("d1").mark && !rec8.items.get("d2").mark
    && !rec8.items.get("d3").mark && !rec8.items.get("d4").mark,
  [...rec8.items.values()].map((x) => [x.u, x.title, x.mark]));

console.log("\n[4] 小红书：详情页封面去重（用户真机反馈「封面那张图会有两张」）");
// 小红书这几个函数只依赖 URL / 条目对象，抽出来单独跑
const xhsStart = bgCode.indexOf("// ---------------------------------------------------------------- 小红书");
const xhsEnd = bgCode.indexOf("// ---------------------------------------------------------------- 监听", xhsStart);
// 小红书去重用的 XHS_ASSET_PATH 定义在图标判定区（looksLikeIcon 也要用），
// 不在「小红书」注释块里面。切片起点往前挪到那行，否则 xhsImgIdentity 里
// 引用的是个未定义变量，身份恒为空串、去重整个失效。
const assetDefPos = bgCode.indexOf("const XHS_ASSET_PATH", 0);
const xhsSliceStart = assetDefPos >= 0 && assetDefPos < xhsStart ? assetDefPos : xhsStart;
const xhsCtx = vm.createContext({ console, Map, Set, String, Number, RegExp, URL });
vm.runInContext(bgCode.slice(xhsSliceStart, xhsEnd), xhsCtx, { filename: "xhs-rules" });
const xhs = vm.runInContext(
  "({ isXhsHostUrl, isXhsDetailUrl, xhsImgIdentity, dedupeXhsNoteImages, preferXhsNoteList, identityOf, dedupeImagesByIdentity })", xhsCtx, { filename: "xhs-export" });
const { isXhsHostUrl, isXhsDetailUrl, xhsImgIdentity, dedupeXhsNoteImages, preferXhsNoteList, identityOf, dedupeImagesByIdentity } = xhs;

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
// 用真实长度的 fileId（37 位）。早期测试用的是 `1040g3k03xyz` 这种短串，
// 真实 CDN 上不存在，正则按 `{20,}` 要求后它们会退化到「裸匹配」分支，
// 测出来的行为和线上不一致。
const FID_A = "1040g3k0326952rj244005p5rujnl7eaonshedm8";
const FID_B = "1040g34o325dkdh8bk610415if87gclpjti1acp8";
const U1 = `https://sns-webpic-qc.xhscdn.com/202510181115/aaa/notes_pre_post/${FID_A}!nc_n_webp_mw_1`;
const U2 = `https://sns-webpic-qc.xhscdn.com/202510181115/aaa/notes_pre_post/${FID_A}!nc_n_webp_mw_2`;
check("同一张图的两个尺寸后缀 → 同一身份", xhsImgIdentity(U1) === xhsImgIdentity(U2), [xhsImgIdentity(U1), xhsImgIdentity(U2)]);
check("身份里不含 `!` 及其后的参数", !xhsImgIdentity(U1).includes("!"), xhsImgIdentity(U1));
check("query string 不进身份",
  xhsImgIdentity(U1 + "?imageView2/2/w/1080") === xhsImgIdentity(U1));
const U_DIFF = `https://sns-webpic-qc.xhscdn.com/202510181115/bbb/notes_pre_post/${FID_B}!nc_n_webp_mw_1`;
check("不同图识别为不同身份", xhsImgIdentity(U1) !== xhsImgIdentity(U_DIFF));
check("坏 URL 的身份为空串（调用方就放弃去重）", xhsImgIdentity("不是URL") === "");

// ---- 真机那条坑：同一张图，时间戳段和 hash 段都变了
// 实测样本：16:00 抓到 hash=004ef08…，16:05 变成 b5b96ec…，路径里只剩
// `spectrum/<fileId>` 是稳定的，靠它才能认出是同一张图。
const REAL_FID = "1040g34o325dkebtl4a20415if87gclpj20lh3rg";
const R1 = `https://sns-webpic-qc.xhscdn.com/202610181600/004ef081518ed93d28996909b3298510/spectrum/${REAL_FID}!nd_dft_wgth_webp_3`;
const R2 = `https://sns-webpic-qc.xhscdn.com/202610181605/b5b96ec2cd88010f4432ffed37d87241/spectrum/${REAL_FID}!nd_dft_wgth_webp_3`;
const R3 = `https://sns-webpic-qc.xhscdn.com/202610181559/b3718a91a4d4150cdb9d4e13ec6b61b0/spectrum/${REAL_FID}!nc_n_webp_mw_1`;
check("时间戳+hash 变了、fileId 没变 → 仍是同一身份",
  xhsImgIdentity(R1) === xhsImgIdentity(R2) && xhsImgIdentity(R1) === xhsImgIdentity(R3),
  [xhsImgIdentity(R1), xhsImgIdentity(R2)]);
check("身份里不含时间戳段和 hash 段",
  xhsImgIdentity(R1) === "spectrum/" + REAL_FID, xhsImgIdentity(R1));

// 头像必须排除：fileId 同样 1040g 开头，混进正文去重会误删
const AV1 = "https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo31pcvrtgu24004a1ke1jil4hm9p0h1k0?imageView2/2/w/60/format/webp";
const AV2 = "https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo31pcvrtgu24004a1ke1jil4hm9p0h1k0?imageView2/2/w/120/format/jpg";
check("头像的身份是空串（不参与正文去重）", xhsImgIdentity(AV1) === "" && xhsImgIdentity(AV2) === "",
  [xhsImgIdentity(AV1), xhsImgIdentity(AV2)]);

// 同一 fileId 出现在不同路径类型下，不能算同一张图
check("spectrum 和 comment 下的同 fileId 不混为一谈",
  xhsImgIdentity(`https://sns-webpic-qc.xhscdn.com/ts/h/spectrum/${REAL_FID}!x`)
  !== xhsImgIdentity(`https://sns-webpic-qc.xhscdn.com/ts/h/comment/${REAL_FID}!x`));


// ---- 去重行为
const mkImgItem = (u, extra) => Object.assign({ u, k: "image" }, extra || {});
// 封面同一张图两份（不同后缀、大小不同），正文另两张
const dupItems = [
  mkImgItem(U1, { s: 480000 }),
  mkImgItem(U2, { s: 120000 }),
  mkImgItem(U_DIFF, { s: 300000 }),
  mkImgItem(`https://sns-webpic-qc.xhscdn.com/202510181115/ccc/notes_pre_post/1040g3k0326952rj244005p5rujnl7eaonshedm9!nc_n_webp_mw_1`, { s: 250000 }),
];
const deduped = dedupeXhsNoteImages(dupItems);
check("封面重复被合掉：4 条 → 3 条", deduped.length === 3, deduped.map((x) => x.u.slice(-40)));
check("封面保留体量最大的那条（s 大的赢）",
  deduped.some((x) => x.u === U1) && !deduped.some((x) => x.u === U2),
  deduped.map((x) => [x.u.slice(-30), x.s]));
check("其它两张正文图原样保留",
  deduped.some((x) => x.u === U_DIFF) && deduped.some((x) => x.u.includes("1040g3k0326952rj244005p5rujnl7eaonshedm9")));

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

// 真机形态：一张图 4 条记录（3 个不同 URL + 1 个重复 URL），必须只留 1 条
const realDup = [
  mkImgItem(`https://sns-webpic-qc.xhscdn.com/202610181600/004ef08aaa/spectrum/${REAL_FID}!nd_dft_wgth_webp_3`, { s: 201614, w: 1672, h: 941 }),
  mkImgItem(`https://sns-webpic-qc.xhscdn.com/202610181605/b5b96ecbbb/spectrum/${REAL_FID}!nd_dft_wgth_webp_3`, { s: 201614, w: 1672, h: 941 }),
  mkImgItem(`https://sns-webpic-qc.xhscdn.com/202610181559/b3718a91cc/spectrum/${REAL_FID}!nc_n_webp_mw_1`, { s: 48850, w: 640, h: 360 }),
  mkImgItem(`https://sns-webpic-qc.xhscdn.com/202610181605/b5b96ecbbb/spectrum/${REAL_FID}!nd_dft_wgth_webp_3`, { s: 0, w: 0, h: 0 }),
];
const realOut = dedupeXhsNoteImages(realDup);
check("真机形态：一张图 4 条记录 → 只剩 1 条", realOut.length === 1, realOut.map((x) => [x.u.slice(-28), x.s]));
check("保留的那条是大档（201614 字节），不是缩略图也不是 s=0 的",
  realOut.length === 1 && realOut[0].s === 201614, realOut.map((x) => x.s));


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
  // 第十一轮起，小红书详情页只有「直读条目（hint=xhs-note）」或「有标题的」
  // 才参与编号 —— 站点雪碧图/别的帖子封面缩略图/ MSE 的 m1 都不算。
  // 所以这里必须带上 hint，否则它们会被当成噪声跳过（这正是线上的行为）。
  { u: "https://sns-webpic-qc.xhscdn.com/a/notes_pre_post/1040g3k01aaa!x", k: "image", ord: 2, t: 3, hint: "xhs-note" },
  { u: "https://sns-webpic-qc.xhscdn.com/a/notes_pre_post/1040g3k02bbb!x", k: "image", ord: 0, t: 1, hint: "xhs-note" },
  { u: "https://sns-webpic-qc.xhscdn.com/a/notes_pre_post/1040g3k03ccc!x", k: "image", ord: 1, t: 2, hint: "xhs-note" },
], XHS_DETAIL);
numberRec(recX);
const xMarks = [...recX.items.values()].map((x) => [x.u.slice(-12), x.ord, x.mark]);
check("小红书详情页的图会编号（不再因为没 mid/title 被跳过）",
  xMarks.every((x) => x[2] !== ""), xMarks);
check("编号按 DOM 顺序（ord=0 得 ①、ord=1 得 ②、ord=2 得 ③）",
  recX.items.get("https://sns-webpic-qc.xhscdn.com/a/notes_pre_post/1040g3k02bbb!x").mark === "①"
  && recX.items.get("https://sns-webpic-qc.xhscdn.com/a/notes_pre_post/1040g3k03ccc!x").mark === "②"
  && recX.items.get("https://sns-webpic-qc.xhscdn.com/a/notes_pre_post/1040g3k01aaa!x").mark === "③",
  xMarks);

console.log("\n[4c] 小红书详情页：页面直读了 imageList 就只认直读条目");
// 真机证据（帖子 6ab221bd…）：页面上报了 7 条 hint=xhs-note 的直读条目，
// webRequest 同时还记着 22 条噪声（站点雪碧图 / 信息流里别的帖子的封面缩略图 /
// UI 素材 png）。它们在 popup 里被一起编了号，用户看到「不止 7 张」。
const D1 = `https://sns-webpic-qc.xhscdn.com/202610181653/aaa/spectrum/${REAL_FID}!nd_dft_wgth_webp_3`;
const D2 = `https://sns-webpic-qc.xhscdn.com/202610181653/bbb/spectrum/${FID_B}!nd_dft_wgth_webp_3`;
const NOISE_THUMB = `https://sns-webpic-qc.xhscdn.com/202610181653/ccc/spectrum/1040g2t0326dl1a0p00005n33mumk2o11tqs8apg!nc_n_webp_mw_1`;
const NOISE_SVG = "https://sns-webpic-qc.xhscdn.com/202610181653/ddd/notes_pre_post/svg-sprite.6.57.6.svg#me";
const NOISE_PNG = "https://sns-webpic-qc.xhscdn.com/202610181653/eee/notes_pre_post/36c01bac91a3eb7284b6e107e4714d7c06da.png";
const withDirect = [
  { u: D1, k: "image", hint: "xhs-note", ord: 0, w: 1672, h: 941, title: "标题" },
  { u: D2, k: "image", hint: "xhs-note", ord: 1, w: 1600, h: 900, title: "标题" },
  { u: NOISE_THUMB, k: "image", s: 9224 },
  { u: NOISE_SVG, k: "image", s: 82659 },
  { u: NOISE_PNG, k: "image", s: 638 },
  { u: "https://sns-video-v6.xhscdn.com/stream/1/110/332/abc_332.mp4", k: "video", title: "标题" },
];
const kept = preferXhsNoteList(withDirect);
check("只留下 2 条直读图片", kept.filter((x) => x.k === "image").length === 2,
  kept.filter((x) => x.k === "image").map((x) => String(x.u).slice(-24)));
check("噪声缩略图被丢掉", !kept.some((x) => String(x.u).includes("!nc_n_webp_mw_1")));
check("站点雪碧图被丢掉", !kept.some((x) => String(x.u).includes("svg-sprite")));
check("无后缀 UI 素材 png 被丢掉", !kept.some((x) => String(x.u).includes("36c01bac")));
check("视频不受影响（它不走直读这条路）", kept.some((x) => x.k === "video"), kept.map((x) => x.k));
check("有没有直读条目时原样返回（不能把列表整个清空）",
  preferXhsNoteList(withDirect.filter((x) => x.hint !== "xhs-note")).length === 4,
  preferXhsNoteList(withDirect.filter((x) => x.hint !== "xhs-note")).length);
check("空数组原样返回", preferXhsNoteList([]).length === 0);

// 视频帖：视频和封面共用一个序号池（不再各编各的 ①）
// 真机帖子 6ad46958…：imageList 只有 1 条（视频封面），正文是那个 mp4。
// 页面侧给视频 ord=0、封面 ord=1，所以视频拿 ①、封面拿 ②。
const recXV = mkRec([
  { u: "https://sns-webpic-qc.xhscdn.com/a/1040gimg1!x", k: "image", ord: 1, t: 1, hint: "xhs-note" },
  { u: "https://sns-video-hw.xhscdn.com/stream/abc.mp4", k: "video", ord: 0, t: 3, title: "帖标题" },
], XHS_DETAIL);
numberRec(recXV);
check("视频帖里视频拿 ①、封面拿 ②（共用一个序号池）",
  recXV.items.get("https://sns-video-hw.xhscdn.com/stream/abc.mp4").mark === "①"
  && recXV.items.get("https://sns-webpic-qc.xhscdn.com/a/1040gimg1!x").mark === "②",
  [...recXV.items.values()].map((x) => [x.k, x.ord, x.mark]));

// 噪声不占号位：站点雪碧图 / 无标题缩略图 / MSE 的 m1 都不能拿到编号，
// 否则真图会被顶到 ④⑤（真机帖子 6ad46958… 就是这样，MSE 条目拿到了 (26)）
const recNoise = mkRec([
  { u: "https://sns-webpic-qc.xhscdn.com/a/svg-sprite.6.57.6.svg#me", k: "image" },
  { u: "https://sns-webpic-qc.xhscdn.com/a/1040gnoi!nc_n_webp_mw_1", k: "image" },
  { u: "m1", k: "video", title: "" },
  { u: "https://sns-webpic-qc.xhscdn.com/a/1040greal!x", k: "image", ord: 0, hint: "xhs-note" },
], XHS_DETAIL);
numberRec(recNoise);
check("小红书噪声条目（雪碧图/无标题缩略图/MSE）不参与编号",
  !recNoise.items.get("https://sns-webpic-qc.xhscdn.com/a/svg-sprite.6.57.6.svg#me").mark
  && !recNoise.items.get("https://sns-webpic-qc.xhscdn.com/a/1040gnoi!nc_n_webp_mw_1").mark
  && !recNoise.items.get("m1").mark,
  [...recNoise.items.values()].map((x) => [String(x.u).slice(-20), x.mark]));
check("只有一张真图时不加序号（免得满屏 ①）",
  !recNoise.items.get("https://sns-webpic-qc.xhscdn.com/a/1040greal!x").mark,
  recNoise.items.get("https://sns-webpic-qc.xhscdn.com/a/1040greal!x").mark);

// 非详情页（首页/信息流）保持老规则：没 mid 没 title 的仍然不编号
const recHome = mkRec([
  { u: "https://sns-webpic-qc.xhscdn.com/a/1040gfeed1!x", k: "image", ord: 0, t: 1 },
  { u: "https://sns-webpic-qc.xhscdn.com/a/1040gfeed2!x", k: "image", ord: 1, t: 2 },
], "https://www.xiaohongshu.com/explore");
numberRec(recHome);
check("首页（非详情页）不误编号",
  [...recHome.items.values()].every((x) => !x.mark),
  [...recHome.items.values()].map((x) => x.mark));

// A1（用户 m06550）：「既然标题不一样就不要加序号了」。
// 真机现场：首页信息流封面各自带不同标题（xhsFeedTitle 补的），
// 结果每张都进了「有标题」分支、被编成各自的 ①，列表里一片「①、①、①」。
const recHomeTitled = mkRec([
  { u: "https://sns-webpic-qc.xhscdn.com/a/1040gfeedA!x", k: "image", ord: 0, t: 1, title: "千万不要点这个肯德基的虾仁肉堡" },
  { u: "https://sns-webpic-qc.xhscdn.com/a/1040gfeedB!x", k: "image", ord: 1, t: 2, title: "好像 Maybe Tomorrow" },
  { u: "https://sns-webpic-qc.xhscdn.com/a/1040gfeedC!x", k: "image", ord: 2, t: 3, title: "存一个血糖爆炸的食物秋秋没烦恼" },
], "https://www.xiaohongshu.com/explore");
numberRec(recHomeTitled);
check("A1 首页信息流封面有标题也不编号（标题不同就不该有序号）",
  [...recHomeTitled.items.values()].every((x) => !x.mark && !x.idx),
  [...recHomeTitled.items.values()].map((x) => [x.title.slice(0, 6), x.mark]));

// 但详情页仍然必须编号：同一帖子的多张图属于一组
const recDetailStill = mkRec([
  { u: "https://sns-webpic-qc.xhscdn.com/a/1040gdetA!x", k: "image", ord: 0, t: 1, title: "帖子标题", hint: "xhs-note" },
  { u: "https://sns-webpic-qc.xhscdn.com/a/1040gdetB!x", k: "image", ord: 1, t: 2, title: "帖子标题", hint: "xhs-note" },
], XHS_DETAIL);
numberRec(recDetailStill);
check("A1 详情页不受影响，仍然按 ord 编号 ①②",
  recDetailStill.items.get("https://sns-webpic-qc.xhscdn.com/a/1040gdetA!x").mark === "①"
  && recDetailStill.items.get("https://sns-webpic-qc.xhscdn.com/a/1040gdetB!x").mark === "②",
  [...recDetailStill.items.values()].map((x) => x.mark));

// 非小红书站点（比如 Telegram 相册）有标题有 mid，照常编号
const recTgAlbum = mkRec([
  { u: "https://cdn.telegram.org/a.jpg", k: "image", mid: "42", ref: "album", t: 1 },
  { u: "https://cdn.telegram.org/b.jpg", k: "image", mid: "42", ref: "album", t: 2 },
], "https://web.telegram.org/a/");
numberRec(recTgAlbum);
check("A1 非小红书站点照常编号（没被误伤）",
  recTgAlbum.items.get("https://cdn.telegram.org/a.jpg").mark === "①"
  && recTgAlbum.items.get("https://cdn.telegram.org/b.jpg").mark === "②",
  [...recTgAlbum.items.values()].map((x) => x.mark));

console.log("\n[4d] 通用图片去重（借鉴 CocoCut 去 query 签名）+ 身份");
// identityOf：host + pathname，去掉 query 和 hash
check("身份 = host + pathname（去 query）",
  identityOf("https://cdn.example.com/a/b.jpg?sign=abc") === identityOf("https://cdn.example.com/a/b.jpg?sign=xyz"));
check("身份忽略 hash 片段",
  identityOf("https://cdn.example.com/a/b.jpg#me") === identityOf("https://cdn.example.com/a/b.jpg"));
check("不同 pathname 是不同身份",
  identityOf("https://cdn.example.com/a/1.jpg") !== identityOf("https://cdn.example.com/a/2.jpg"));
check("不同 host 是不同身份",
  identityOf("https://cdn.a.com/x.jpg") !== identityOf("https://cdn.b.com/x.jpg"));
check("host 大小写归一",
  identityOf("https://CDN.Example.com/x.jpg") === identityOf("https://cdn.example.com/x.jpg"));
check("坏 URL 身份为空串", identityOf("不是URL") === "");

// dedupeImagesByIdentity：同一 host+pathname 的裸图只留体量最大的
const GEN_DUP = [
  { u: "https://cdn.example.com/pic/1.jpg?sign=111", k: "image", s: 480000 },
  { u: "https://cdn.example.com/pic/1.jpg?sign=222", k: "image", s: 120000 },
  { u: "https://cdn.example.com/pic/2.jpg?sign=333", k: "image", s: 300000 },
];
const genOut = dedupeImagesByIdentity(GEN_DUP);
check("同一张图（query 不同）合掉：3 条 → 2 条", genOut.length === 2, genOut.map((x) => x.u));
check("保留体量最大的那条", genOut.some((x) => x.u.includes("sign=111")) && !genOut.some((x) => x.u.includes("sign=222")),
  genOut.map((x) => [x.u, x.s]));

// 没有 s 时退回像素面积
const genArea = dedupeImagesByIdentity([
  { u: "https://cdn.example.com/p/1.jpg?q=1", k: "image", w: 1000, h: 800 },
  { u: "https://cdn.example.com/p/1.jpg?q=2", k: "image", w: 320, h: 240 },
]);
check("通用去重：无字节数时按像素面积留大图", genArea.length === 1 && genArea[0].u.includes("q=1"), genArea.map((x) => [x.u, x.w]));

// 保守线：带 mid/title/page/hint 的（页面上下文条目）不合并
const genCtx = dedupeImagesByIdentity([
  { u: "https://cdn.example.com/p/1.jpg?q=1", k: "image", s: 100, mid: "8925" },
  { u: "https://cdn.example.com/p/1.jpg?q=2", k: "image", s: 200, title: "标题" },
]);
check("带页面上下文（mid/title）的同图不合并", genCtx.length === 2, genCtx.map((x) => x.u));

// 没有重复时不扰动
check("通用去重：无重复时一条不少",
  dedupeImagesByIdentity([{ u: "https://cdn.example.com/1.jpg", k: "image", s: 1 }, { u: "https://cdn.example.com/2.jpg", k: "image", s: 2 }]).length === 2);
// 不碰非 image
check("通用去重：视频条目不受影响",
  dedupeImagesByIdentity([{ u: "https://cdn.example.com/a.mp4?x=1", k: "video" }, { u: "https://cdn.example.com/a.mp4?x=2", k: "video" }]).length === 2);
// 空输入安全
check("通用去重：空列表安全返回", Array.isArray(dedupeImagesByIdentity([])) && dedupeImagesByIdentity([]).length === 0);

// ---- 页面 → 宿主 的准入校验
//
// 背景：content.js 会把页面 postMessage 发来的 host-send 原样转给宿主，
// 而页面主世界和注入脚本是同一个执行环境 —— 任何页面脚本都能伪造。
// 这里锁定几条必须成立的边界。
console.log("\n[9] validateHostPayload：页面不能指挥宿主");
const vhp = ctx.validateHostPayload;
check("存在准入校验函数", typeof vhp === "function");

const PAGE = "https://www.example.com/archives/1/";
check("拒绝页面发起 download（下载只能由 background 发起）",
  vhp({ action: "download", id: "x1", url: "https://evil.test/a.mp4" }, PAGE) === null);
check("拒绝 file:// 本地读取",
  vhp({ action: "msfile_start", id: "x1", name: "a.mp4", total: 1, url: "file:///C:/Windows/win.ini" }, PAGE) === null);
check("拒绝 javascript: 伪协议",
  vhp({ action: "reveal", file: "javascript:alert(1)" }, PAGE) === null);
check("拒绝路径穿越的 id",
  vhp({ action: "msfile_start", id: "../../evil", name: "a", total: 1 }, PAGE) === null);

const cleanOut = vhp({ action: "msfile_start", id: "dl-1", name: "a.mp4", total: 10, outdir: "C:\\Windows\\Temp" }, PAGE);
check("丢弃页面指定的 outdir", cleanOut && cleanOut.outdir === undefined, cleanOut);

const sameSite = vhp({
  action: "log", id: "l1", url: "https://www.example.com/v.mp4",
  cookie: "SID=abc", tabUrl: PAGE,
}, PAGE);
check("同站保留 Cookie", sameSite && sameSite.cookie === "SID=abc", sameSite);

const crossSite = vhp({
  action: "log", id: "l2", url: "https://evil.test/v.mp4",
  cookie: "SID=abc", tabUrl: PAGE,
}, PAGE);
check("跨站丢弃 Cookie", crossSite && crossSite.cookie === undefined, crossSite);

check("正常分片请求放行", !!vhp({ action: "msfile_chunk", id: "dl-1", text: "bytes=0-", data: { __b64: "AA==" } }, PAGE));

// ---- 请求头白名单
//
// 这些头会被原样重放到 CDN 请求上，所以必须严格：只保留 5 个安全头，
// 且拒绝 CR/LF（头注入）。Cookie / Authorization 永远不进这条通路。
console.log("\n[10] pickHeaders：只留白名单，拒绝头注入");
const ph = ctx.pickHeaders;
check("存在 pickHeaders", typeof ph === "function");
const picked = ph([
  { name: "Referer", value: "https://a.com/p" },
  { name: "Origin", value: "https://a.com" },
  { name: "Accept", value: "*/*" },
  { name: "Accept-Language", value: "zh-CN" },
  { name: "User-Agent", value: "UA/1" },
  { name: "Cookie", value: "SID=secret" },
  { name: "Authorization", value: "Bearer x" },
  { name: "X-Custom", value: "1" },
]);
check("保留 5 个白名单头", Object.keys(picked).length === 5, picked);
check("键名统一小写", picked.referer === "https://a.com/p" && picked["user-agent"] === "UA/1", picked);
check("Cookie 被丢弃", !("cookie" in picked));
check("Authorization 被丢弃", !("authorization" in picked));
check("自定义头被丢弃", !("x-custom" in picked));

check("CRLF 注入被拒", !("referer" in ph([{ name: "Referer", value: "a\r\nX-Evil: 1" }])));
check("超长值被拒", !("accept" in ph([{ name: "Accept", value: "a".repeat(400) }])));
check("空值被拒", !("accept" in ph([{ name: "Accept", value: "" }])));
check("全是非法头时返回空对象", Object.keys(ph([{ name: "Cookie", value: "x" }])).length === 0);

// ---- recordPageMedia：同帖分片让位闸（d-018）
//
// 1.3.11 里这条闸从未生效：带 noteId 的上报都带 hint=xhs-note、被 !p.hint
// 排除，两条路互斥。页面侧 post() 补 noteId 之后闸才可达。把 recordPageMedia
// 抽出来直接验证：同帖拦、换帖留、缺 noteId 留、图片和 http 媒体永不拦。
console.log("\n[11] recordPageMedia：同帖分片让位闸按 noteId 生效");
const rpmSrc = extractFn(bgCode, "recordPageMedia");
if (!rpmSrc) {
  check("能抽到 recordPageMedia", false);
} else {
  const tabs = new Map();
  const rpmCtx = vm.createContext({
    ensureTab: (tid) => {
      if (!tabs.has(tid)) tabs.set(tid, { items: new Map(), url: "" });
      return tabs.get(tid);
    },
    flushSoon() {}, bumpBadge() {}, confirmPageItem() {},
    fileNameOf: (u) => String(u).split("/").pop() || "",
    String, RegExp, Date, Map, Set, console,
  });
  vm.runInContext(rpmSrc, rpmCtx, { filename: "recordPageMedia" });
  const rpm = rpmCtx.recordPageMedia;
  const N1 = "6a7546a50000000032030d99", N2 = "6ab221bd000000003602a63e";

  // 真实地址先到：hint=xhs-note + noteId=N1，闸的状态由它点亮
  rpm(1, "https://www.xiaohongshu.com/explore/" + N1,
    { cmd: "found", source: "httpmedia", key: "https://sns-video.xhscdn.com/v/real.mp4",
      mime: "video/mp4", hint: "xhs-note", noteId: N1 });
  const rec = tabs.get(1);
  check("真实地址条目建立", rec.items.has("https://sns-video.xhscdn.com/v/real.mp4"));
  check("xhsVidNote 记下当前帖子", rec.xhsVidNote === N1, rec.xhsVidNote);

  // ① 同帖 blob：必须被拦（1.3.11 死门复活的回归断言）
  rpm(1, "", { cmd: "found", source: "mediasrc", key: "blob:https://www.xiaohongshu.com/m-1",
    mime: "video/mp4", noteId: N1 });
  check("① 同帖 blob 条目被拦", !rec.items.has("page:blob:https://www.xiaohongshu.com/m-1"),
    [...rec.items.keys()]);

  // ② 同帖 MSE（m1）：必须被拦
  rpm(1, "", { cmd: "found", source: "mse", key: "m1", mime: "video/mp4", noteId: N1 });
  check("② 同帖 MSE 条目被拦", !rec.items.has("page:m1"), [...rec.items.keys()]);

  // ③ 换帖（noteId 不同）：照常建条 —— 1.3.11 修的「换个视频抓不到」
  rpm(1, "", { cmd: "found", source: "mse", key: "m2", mime: "video/mp4", noteId: N2 });
  check("③ 换帖的 MSE 条目照常建", rec.items.has("page:m2"));

  // ④ 不带 noteId：宁可多留
  rpm(1, "", { cmd: "found", source: "mse", key: "m3", mime: "video/mp4" });
  check("④ 不带 noteId 的条目照常建", rec.items.has("page:m3"));

  // ⑤ 图片永不拦（kind !== "image" 排除）
  rpm(1, "", { cmd: "found", source: "blob", key: "blob:https://www.xiaohongshu.com/img1",
    mime: "image/jpeg", noteId: N1 });
  check("⑤ 同帖 blob 图片照常建", rec.items.has("page:blob:https://www.xiaohongshu.com/img1"));

  // ⑥ 同帖的 http 媒体不拦（闸只管 blob:/m\d+/mse 分片副产品）
  rpm(1, "", { cmd: "found", source: "httpmedia", key: "https://sns-video.xhscdn.com/v/other.mp4",
    mime: "video/mp4", noteId: N1 });
  check("⑥ 同帖 http 媒体条目照常建", rec.items.has("https://sns-video.xhscdn.com/v/other.mp4"));

  // ⑦ 下一个真实地址缺 noteId 时：xhsVidNote 必须清空，不能留旧值挡新帖
  rpm(1, "", { cmd: "found", source: "httpmedia", key: "https://sns-video.xhscdn.com/v/real2.mp4",
    mime: "video/mp4", hint: "xhs-note" });
  check("⑦ 真实地址缺 noteId 时 xhsVidNote 清空", rec.xhsVidNote === "", rec.xhsVidNote);
}

// ---- 审查文档（readonly-review-and-fix-plan）追加的回归组
// [R1] tabId=0、[R2] 素材分类体积线、[R3] 导航代次、[R4] 普通导航清空
require("./review.test.js")(check);

// ---- 用户 m13684 追加：[G1] 按标题分组、[G2] 小红书不被误伤、[G3] blob 预览
require("./group_key.test.js")(check);

// ---- 用户 m13863 追加：[F1] 焦点过滤、[F2] focus() 钩子、[F3] popup 提示条
require("./focus_scope.test.js")(check);

console.log("\n==============================================");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
