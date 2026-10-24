/**
 * [A0] 站点注册表的结构约束
 *
 * 这一套不测「功能对不对」（那是 main-hook.test.js 的事），只测**架构约束**：
 * 通用层不许再出现站点专属判断。用户诉求原话：
 *   「给功能分组，方便快速定位问题」「图片和视频下载是否有通用的代码，
 *     是否需要针对特定应用添加逻辑」
 *
 * 为什么需要这套：模块化一旦没有约束，下一个人加站点时最省事的做法
 * 仍然是在 scanImages 里再抄一个 `if (isXhsHost())`，几个月后又会退化成
 * 一坨 if。把它变成测试，退化会立刻变红。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "extension", "inject-main.js"), "utf8");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail !== undefined ? " → " + JSON.stringify(detail) : "")); }
}

console.log("\n[A0-1] 站点注册表存在且结构正确");

check("定义了 SITES 注册表", /const SITES = \[\];/.test(SRC));
check("有 activeSite() 解析当前站点", /function activeSite\(\)/.test(SRC));
check("SITES 至少注册了一个站点", /SITES\.push\(\{/.test(SRC));

// 每个注册项都必须有 name 和 match —— 没有 match 的对象永远不会被选中（静默失效）
const pushes = SRC.match(/SITES\.push\(\{[\s\S]*?\n  \}\);/g) || [];
check("SITES.push 能解析到注册项", pushes.length >= 1, pushes.length);
for (const p of pushes) {
  const nameM = /name:\s*"([^"]+)"/.exec(p);
  const nm = nameM ? nameM[1] : "?";
  check(`站点 ${nm} 有 match 钩子`, /match:/.test(p));
}

console.log("\n[A0-2] 通用层不出现站点专属判断（防回退成 if 汤）");

// 找通用函数体的边界：从函数定义到下一个顶层 `function ` 或段落注释
function bodyOf(fnName) {
  const start = SRC.indexOf("function " + fnName + "(");
  if (start < 0) return null;
  const after = SRC.indexOf("\n  function ", start + 10);
  const afterAsync = SRC.indexOf("\n  async function ", start + 10);
  let end = SRC.length;
  if (after > 0) end = Math.min(end, after);
  if (afterAsync > 0) end = Math.min(end, afterAsync);
  return SRC.slice(start, end);
}

const GENERIC = ["guessTitle", "scanImages", "scanMedia", "handleMediaSrc", "reportXhsVideo"];
const SITE_HINTS = [
  /isXhsHost\(\)/,
  /isBiliHost\(\)/,
  /\bxiaohongshu\b/i,
  /\bbilibili\b/i,
];

for (const fn of GENERIC) {
  const body = bodyOf(fn);
  if (body === null) { check(`能定位到 ${fn}()`, false); continue; }
  // 去掉注释再判断：注释里解释「以前这里是 if (isXhsHost())」是允许的
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const hit = SITE_HINTS.find((re) => re.test(code));
  check(`${fn}() 里没有站点专属判断`, !hit, hit ? String(hit) : undefined);
}

console.log("\n[A0-3] 站点钩子都通过注册表转发，而不是硬编码");

check("guessTitle 走 site.title", /site\.title/.test(bodyOf("guessTitle") || ""));
check("scanImages 走 site.isDecorImg / owns",
  /site\.isDecorImg/.test(bodyOf("scanImages") || "") && /site\.owns/.test(bodyOf("scanImages") || ""));
check("scanImages 走 site.onScanImages（清单通路）", /site\.onScanImages/.test(bodyOf("scanImages") || ""));
check("scanMedia 走 site.videoSrc / owns",
  /site\.videoSrc/.test(bodyOf("scanMedia") || "") || /site\.owns/.test(bodyOf("scanMedia") || ""));

console.log("\n[A0-4] 下载层也不许出现站点专属判断（2026-10-19 第二轮模块化）");
//
// 背景：扫描层模块化之后，下载调度层还留着 4 处硬编码 ——
//   startMediaDownload 的 `const useBili = isBiliHost() && biliPlayinfo()`
//   overlayShow/runSave 的 `if (isBiliHost() && biliPlayinfo())`
//   overlayShow 底部文案的 `isBiliHost() ? "B 站走完整流…" : "…"`
//   beginSaveBatch 的 `biliSig = ""`
// 它们让「加一个新站点」必须回去改通用函数。现在统一走站点对象：
//   canFeedDownload / feedDownload / saveHint / onSaveStart

check("有 siteCanFeed() 统一入口", /function siteCanFeed\(/.test(SRC));
check("有 siteSaveHint() 统一入口", /function siteSaveHint\(/.test(SRC));
check("有 siteResetReport() 统一入口", /function siteResetReport\(/.test(SRC));

const DL_GENERIC = ["startMediaDownload", "dispatchSaveItem", "beginSaveBatch"];
for (const fn of DL_GENERIC) {
  const body = bodyOf(fn);
  if (body === null) { check(`能定位到 ${fn}()`, false); continue; }
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  // overlayShow 里的 runSave 是闭包，bodyOf 拿不到它，单独测（见下）
  const hit = SITE_HINTS.find((re) => re.test(code));
  check(`${fn}() 里没有站点专属判断`, !hit, hit ? String(hit) : undefined);
}

// 1.3.61 浮层移除后，单条分派是模块级的 dispatchSaveItem
const dsiBody = bodyOf("dispatchSaveItem");
check("能定位到 dispatchSaveItem", dsiBody !== null);
check("分派里没有站点专属判断",
  !SITE_HINTS.find((re) => re.test((dsiBody || "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""))));
check("分派走 siteCanFeed", /siteCanFeed\(/.test(dsiBody || ""));

console.log("\n[A0-5] 下载层钩子确实被通用函数用上了");

check("startMediaDownload 走 siteCanFeed", /siteCanFeed\(/.test(bodyOf("startMediaDownload") || ""));
check("startMediaDownload 走 site.feedDownload",
  /\.feedDownload\b/.test(bodyOf("startMediaDownload") || ""));
// 浮层移除后 siteSaveHint 暂无 UI 消费点（API 保留）
check("siteSaveHint 定义仍在", /function siteSaveHint\(/.test(SRC));
check("hello/rescan 重报走 siteResetReport", /siteResetReport\(\)/.test(SRC));

// d-018：内容归属与回放也走注册表。rescan 块 1.3.11 里还直调 reportBiliDash()，
// 与 siteResetReport 并排 —— 那是重构停差一行的地方。
check("回放重报走 siteReplayReport（不许直调 reportBiliDash）",
  /siteReplayReport\(\)/.test(SRC)
  && !/siteResetReport\(\);\s*\n\s*reportBiliDash\(\)/.test(SRC));
check("post() 注入 siteContentId（blob/MSE 条目的 noteId）",
  /siteContentId\(\)/.test(SRC)
  && /d\.cmd === "found" \|\| d\.cmd === "progress"/.test(SRC));

// B 站站点对象必须把 4 个下载层钩子都实现，否则泄漏只是换了个位置
const biliPush = (SRC.match(/SITES\.push\(\{\s*\n\s*name:\s*"bilibili"[\s\S]*?\n  \}\);/) || [""])[0];
check("注册了 bilibili 站点对象", biliPush.length > 0);
for (const hook of ["canFeedDownload", "feedDownload", "saveHint", "onSaveStart", "replayReport"]) {
  check(`bilibili 实现了 ${hook}`, new RegExp(hook + "\\s*:").test(biliPush));
}
// 小红书必须提供内容 id（background 的按 noteId 隔离全靠它供数）
const xhsPush = (SRC.match(/SITES\.push\(\{\s*\n\s*name:\s*"xiaohongshu"[\s\S]*?\n  \}\);/) || [""])[0];
check("注册了 xiaohongshu 站点对象", xhsPush.length > 0);
check("xiaohongshu 实现了 contentId", /contentId\s*:/.test(xhsPush));

console.log("\n[TGC] Telegram 视频封面不当图片（默认策略 m15108）");

// 用户 m15279：「telegram 没有按照默认策略吗，为什么还把封面当作图片」。
// 真机证据（2026-10-20，频道 ONE PIECE）：
//   · 消息内封面：<div class="media-inner"> 里同时挂 <video class="full-media">
//     和 <img class="thumbnail …"> —— img 是视频封面（加载占位，起播后不移除）。
//   · 左栏列表预览：.media-preview 里 <img class="media-preview--image"> + <i class="icon icon-play">。
//   · 真实照片：<img class="media">，无 video 兄弟。
// telegram 不在 VIDEO_COVER_SITES，所以必须在站点对象里拦（isDecorImg 钩子）。
const TG_AT = SRC.indexOf('name: "telegram"');
const TG_END = TG_AT >= 0 ? SRC.indexOf("\n  });", TG_AT) : -1;
const tgPush = TG_AT >= 0 && TG_END > TG_AT ? SRC.slice(TG_AT, TG_END) : "";

check("telegram 站点注册项能解析到", tgPush.length > 0, TG_AT);
check("telegram 有 isDecorImg 钩子", /isDecorImg\s*:/.test(tgPush), tgPush.slice(0, 120));
check("封面判据看的是 video 兄弟节点", /querySelector\(["']video["']\)/.test(tgPush));
check("列表预览看的是 icon-play", /icon-play/.test(tgPush));

// ---------------------------------------------------------------- [TGS] 陈旧条目清理
// 真机 2026-10-21：telegram 站点对象加了 isDecorImg 之后，**新扫描**确实挡住了封面，
// 但 state 里仍留着 15 条 media-preview 封面。原因：Telegram 封面是 blob: URL，
// 每轮刷新都换一个地址，新扫描挡掉的是新地址，旧地址的条目永远没人删 ——
// 只能靠一次「按当前判定重算」清掉。
console.log("\n[TGS] 陈旧封面条目要能被清掉（不是只挡新扫描）");

const bgSrc = fs.readFileSync(path.join(ROOT, "extension", "background.js"), "utf8");
check("background 有清理陈旧图片条目的函数", /function pruneStaleImages\s*\(/.test(bgSrc), "run after fix");
check("sniff:get 会调用它", /pruneStaleImages\s*\(\s*rec/.test(bgSrc), "run after fix");

const prStart = bgSrc.indexOf("function pruneStaleImages(");
if (prStart >= 0) {
  const prEnd = bgSrc.indexOf("\n}", prStart) + 2;
  const vm = require("vm");
  const prCtx = vm.createContext({ console, Map, Set, String, Number, Math, JSON, URL, RegExp });
  const depsStart = bgSrc.indexOf("const ICON_MAX");
  vm.runInContext(bgSrc.slice(depsStart, prStart) + "\n" + bgSrc.slice(prStart, prEnd), prCtx, { filename: "prune" });
  const prune = vm.runInContext("pruneStaleImages", prCtx);

  const mkRec = (items, url) => ({ items: new Map(items.map((x) => [x.u, x])), url });

  let rec = mkRec([
    { u: "blob:https://web.telegram.org/preview-old", k: "image", hint: "media-preview--image media-preview", w: 320, h: 180, t: 1 },
    { u: "blob:https://web.telegram.org/photo-keep", k: "image", hint: "media opacity-transition shown", w: 1280, h: 720, t: 2 },
  ], "https://web.telegram.org/a/#x");
  const dropped = prune(rec);
  check("[TGS] telegram 列表预览封面被清掉",
    !rec.items.has("blob:https://web.telegram.org/preview-old"), [...rec.items.keys()]);
  check("[TGS] telegram 真照片保留",
    rec.items.has("blob:https://web.telegram.org/photo-keep"), [...rec.items.keys()]);
  check("[TGS] 返回清掉的数量", dropped === 1, dropped);

  rec = mkRec([
    { u: "https://example.com/c.jpg", k: "image", hint: "bili-cover", w: 800, h: 600, t: 3 },
    { u: "https://example.com/d.jpg", k: "image", hint: "", w: 800, h: 600, t: 4 },
  ], "https://example.com/page");
  prune(rec);
  check("[TGS] 非白名单站点的 cover 被清掉", !rec.items.has("https://example.com/c.jpg"), [...rec.items.keys()]);
  check("[TGS] 普通图保留", rec.items.has("https://example.com/d.jpg"), [...rec.items.keys()]);

  rec = mkRec([
    { u: "https://i0.hdslb.com/bfs/archive/cover.jpg", k: "image", hint: "bili-cover", w: 1920, h: 1080, t: 5 },
  ], "https://www.bilibili.com/video/BV1xx411c7mD");
  prune(rec);
  check("[TGS] B 站封面在白名单站点保留",
    rec.items.has("https://i0.hdslb.com/bfs/archive/cover.jpg"), [...rec.items.keys()]);

  check("[TGS] 空 rec 不炸", prune(null) === 0 && prune({ items: new Map(), url: "" }) === 0);
}

// ---------------------------------------------------------------- [B10] B 站 banner 泄漏
// 用户真机 2026-10-21：B 站视频页列表里混进了 banner/活动图。
// 根因：站点对象的 onScanImages / isImageOnly 都以 biliPlayinfo()（有没有
// __playinfo__ 的 DASH 清单）当作「这是不是视频页」，但：
//   ① 首屏 JS 还没写入 __playinfo__ 时返回 null → 判定成「非视频页」→ 全放行；
//   ② 番剧/课程页的清单不在 __playinfo__（在 __INITIAL_STATE__.epInfo）→ 永远判非视频页。
// 正确判据是「URL 是视频页」+「能不能从 state 拿到这一集的封面」两件事分开问。
console.log("\n[B10] B 站视频页只留封面，URL 判定不能依赖 __playinfo__");

const injSrc = fs.readFileSync(path.join(ROOT, "extension", "inject-main.js"), "utf8");

check("[B10] 有 biliIsVideoPage（按 URL 判，不看 __playinfo__）",
  /function biliIsVideoPage\s*\(/.test(injSrc), "run after fix");
check("[B10] onScanImages 用 biliIsVideoPage 而不是 biliPlayinfo 判视频页",
  /onScanImages:\s*\(\)\s*=>\s*\{[\s\S]{0,200}?biliIsVideoPage\s*\(/.test(injSrc)
  && !/onScanImages:\s*\(\)\s*=>\s*\{[\s\S]{0,80}?if\s*\(!biliPlayinfo\(\)\)\s*return false/.test(injSrc),
  "run after fix");
check("[B10] isImageOnly 用 biliIsVideoPage 而不是 biliPlayinfo 判视频页",
  /isImageOnly:\s*\(el,\s*src\)\s*=>\s*\{[\s\S]{0,220}?biliIsVideoPage\s*\(/.test(injSrc)
  && !/isImageOnly:\s*\(el,\s*src\)\s*=>\s*\{[\s\S]{0,120}?if\s*\(!biliPlayinfo\(\)\)\s*return true/.test(injSrc),
  "run after fix");

// 行为验证：把 biliIsVideoPage 切出来单独跑
const vpStart = injSrc.indexOf("function biliIsVideoPage(");
if (vpStart >= 0) {
  // 按大括号配对截取：函数体里还有 try/catch 两层，不能用第一个 "\n  }" 收尾
  let depth = 0, vpEnd = vpStart;
  for (let i = injSrc.indexOf("{", vpStart); i < injSrc.length; i++) {
    const c = injSrc[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { vpEnd = i + 1; break; } }
  }
  const vm = require("vm");
  const vpCtx = vm.createContext({ console, String, RegExp, URL });
  vm.runInContext(injSrc.slice(vpStart, vpEnd), vpCtx, { filename: "vp" });
  const isVideoPage = (href) => {
    vpCtx.__href = href;
    vm.runInContext("location = { href: __href, hostname: new URL(__href).hostname, pathname: new URL(__href).pathname }", vpCtx);
    return vm.runInContext("biliIsVideoPage()", vpCtx);
  };
  check("[B10] /video/BV… 是视频页", isVideoPage("https://www.bilibili.com/video/BV1GJ411x7h7") === true,
    "false");
  check("[B10] /video/BV…?p=2 是视频页", isVideoPage("https://www.bilibili.com/video/BV1GJ411x7h7?p=2") === true,
    "false");
  check("[B10] /bangumi/play/ep… 是番剧页", isVideoPage("https://www.bilibili.com/bangumi/play/ep123456") === true,
    "false");
  check("[B10] /cheese/play/ep… 是课程页", isVideoPage("https://www.bilibili.com/cheese/play/ep123456") === true,
    "false");
  check("[B10] 首页不是视频页", isVideoPage("https://www.bilibili.com/") === false, "true");
  check("[B10] 动态页不是视频页", isVideoPage("https://t.bilibili.com/12345") === false, "true");
  check("[B10] 搜索页不是视频页", isVideoPage("https://search.bilibili.com/all?keyword=x") === false, "true");
}

// ---------------------------------------------------------------- [B10b] webRequest 路径的 B 站噪声
// 1.3.23 修好了 DOM 扫描（isImageOnly），但真机 state 里仍有 33 条图片，
// 全部是 webRequest 路径进来的：banner、活动图、头像、推荐位封面、loading 图。
// 页面侧钩子管不到 webRequest，只能在 background 出列表时按「站点 + 视频页」再筛一次。
console.log("\n[B10b] B 站视频页的 webRequest 图片只留封面");

const bg2 = fs.readFileSync(path.join(ROOT, "extension", "background.js"), "utf8");
check("[B10b] 有 preferBiliCover 函数", /function preferBiliCover\s*\(/.test(bg2), "run after fix");

const pbStart = bg2.indexOf("function preferBiliCover(");
if (pbStart >= 0) {
  let depth = 0, pbEnd = pbStart;
  for (let i = bg2.indexOf("{", pbStart); i < bg2.length; i++) {
    const c = bg2[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { pbEnd = i + 1; break; } }
  }
  const vm = require("vm");
  const pbCtx = vm.createContext({ console, Array, String, RegExp, URL, Set });
  vm.runInContext(bg2.slice(pbStart, pbEnd), pbCtx, { filename: "pb" });
  const prefer = vm.runInContext("preferBiliCover", pbCtx);
  const mk = (hint, u) => ({ k: "image", hint, u, w: 800, h: 600 });
  const imgsOf = (out) => out.filter((i) => i.k === "image").length;

  let list = [mk("bili-cover", "https://i1.hdslb.com/bfs/archive/cover.jpg"),
              mk("", "https://i2.hdslb.com/bfs/banner/abc.jpg"),
              mk("", "https://i2.hdslb.com/bfs/archive/rec1.jpg"),
              { k: "video", u: "https://x/1.m4s" }];
  let out = prefer(list, "https://www.bilibili.com/video/BV1GJ411x7h7");
  check("[B10b] 视频页只留封面", imgsOf(out) === 1, imgsOf(out));
  check("[B10b] 封面本身保留", out.some((i) => i.hint === "bili-cover"), out.map((i) => i.hint));
  check("[B10b] banner 被挡掉", !out.some((i) => /banner/.test(i.u || "")), out.map((i) => i.u));
  check("[B10b] 视频条目不受影响", out.some((i) => i.k === "video"), out.map((i) => i.k));

  list = [mk("", "https://i2.hdslb.com/bfs/banner/abc.jpg"), mk("", "https://i2.hdslb.com/bfs/archive/rec1.jpg")];
  out = prefer(list, "https://www.bilibili.com/");
  check("[B10b] 首页不筛", imgsOf(out) === 2, imgsOf(out));

  list = [mk("bili-cover", "https://i1.hdslb.com/a.jpg"), mk("", "https://i2.hdslb.com/bfs/banner/x.jpg")];
  out = prefer(list, "https://www.bilibili.com/bangumi/play/ep123456");
  check("[B10b] 番剧页也筛", imgsOf(out) === 1, imgsOf(out));

  list = [mk("", "https://x.com/a.jpg"), mk("", "https://x.com/b.jpg")];
  out = prefer(list, "https://example.com/video/BV1x");
  check("[B10b] 非 B 站不筛", imgsOf(out) === 2, imgsOf(out));

  list = [mk("", "https://i2.hdslb.com/bfs/banner/abc.jpg")];
  out = prefer(list, "https://www.bilibili.com/video/BV1GJ411x7h7");
  check("[B10b] 视频页没有封面时一张图都不留", imgsOf(out) === 0, imgsOf(out));

  check("[B10b] 空列表安全", prefer([], "https://www.bilibili.com/video/BV1x").length === 0);
}

// ---------------------------------------------------------------- [BLOB] blob 走 Native Host 落盘
// 用户 m11900「Telegram 视频和图片下载全部失效」。
// 真机 2026-10-21 的证据：
//   · __msRangeDownload（走 Native Host）→ D:/…/文件存放处/tg-probe.mp4  72796 字节 ✅
//   · <a download>（doSaveBlob 当前路径）→ C:/Users/l/Downloads/test-tg.jfif 72796 字节 ⚠️
// 数据其实下下来了，但落在 Chrome 默认下载目录、扩展名被 MIME 改成 .jfif，
// 用户在「文件存放处」找不到，看起来就是「下载失败」。
console.log("\n[BLOB] blob: 用 Range + Native Host 落盘，不用 <a download>");

const inj = fs.readFileSync(path.join(ROOT, "extension", "inject-main.js"), "utf8");

// dispatchSaveItem 里 blob 分支必须调 startMediaDownload，不能再调 doSaveBlob
const rsStart = inj.indexOf("function dispatchSaveItem(it) {");
// 不能用 indexOf("    };") —— runSave 里有多层 if/return，第一个缩进 4 的 };
// 出现得很早，截出来的片段漏掉 blob 分支，红测就变成了假红。
let rsEnd = rsStart, depth = 0;
for (let i = inj.indexOf("{", rsStart); i < inj.length; i++) {
  if (inj[i] === "{") depth++;
  else if (inj[i] === "}") { depth--; if (depth === 0) { rsEnd = i + 1; break; } }
}
const runSave = inj.slice(rsStart, rsEnd);  // 变量名沿用：就是分派函数体
// 只取 blob 分支自己的花括号体：注释里会出现 doSaveBlob 字样（讲为什么不用它），
// 用正则窗口扫整段会把注释当代码，红测就成了假红。
let blobBody = "";
{
  const at = runSave.indexOf("/^blob:/i.test(it.key)");
  if (at >= 0) {
    const open = runSave.indexOf("{", runSave.indexOf(")", at));
    let d = 0;
    for (let i = open; i < runSave.length; i++) {
      if (runSave[i] === "{") d++;
      else if (runSave[i] === "}") { d--; if (d === 0) { blobBody = runSave.slice(open + 1, i); break; } }
    }
  }
}
const blobCode = blobBody.replace(/\/\/.*$/gm, "");   // 去掉行注释只留代码
check("[BLOB] runSave 的 blob 分支走 startMediaDownload",
  /startMediaDownload\s*\(/.test(blobCode), blobCode.slice(0, 240));
check("[BLOB] runSave 的 blob 分支不再调 doSaveBlob",
  !/doSaveBlob\s*\(/.test(blobCode), blobCode.slice(0, 240));

// probeTotal / fetchRange 必须支持 blob:（它们本来就走 fetch，天然支持，但要防止以后加守卫）
check("[BLOB] probeTotal 没有把 blob: 挡掉",
  !/function probeTotal[\s\S]{0,400}?\/\^https\?:\/[:]?[\s\S]{0,80}?return 0/.test(inj),
  "blob: would be rejected");
check("[BLOB] range 下载入口接受 blob:",
  /\/\^\(https\?\|blob\):\/i|blob:/.test(inj), "blob: not handled");

// downloadBlob 保留（MSE / 兜底还要用），但不能再是 blob 主通路
check("[BLOB] downloadBlob 仍存在（MSE 兜底用）", /async function downloadBlob\s*\(/.test(inj), "removed");
check("[BLOB] doSaveBlob 仍存在（旧链路/兜底）", /async function doSaveBlob\s*\(/.test(inj), "removed");

// 真机证据留档：文件必须落在 Native Host 的 outdir，而不是 Chrome 下载目录
check("[BLOB] 注释里写清了「不能走 <a download>」的原因",
  /Chrome 默认下载目录|落不到|outdir/.test(inj), "no rationale");

// ---------------------------------------------------------------- [EXT] 扩展名按内容判定
// 真机 2026-10-21：Telegram 图片存成「真机测试图.mp4」，十六进制却是 ffd8ffe0（JPEG）。
// 根因：sniffExt 只认音视频魔数，guessExtFromType 只认 audio/* video/*，
// 两者都没命中就兜到写死的 ".mp4"。
console.log("\n[EXT] 扩展名按字节/Content-Type 判定，认不出来也不硬写 .mp4");

{
  // 把 sniffExt / extOf / guessExtFromType / ascii 切出来真跑
  const extStart = inj.indexOf("  function extOf(mime)");
  const extEnd = inj.indexOf("  function sanitize(name)");
  const asciiAt = inj.indexOf("  function ascii(b, off, len)");
  const asciiEnd = inj.indexOf("\n  }", asciiAt) + 4;
  const sniffAt = inj.indexOf("  function sniffExt(b)");
  let d = 0, sniffEnd = sniffAt;
  for (let i = inj.indexOf("{", sniffAt); i < inj.length; i++) {
    if (inj[i] === "{") d++;
    else if (inj[i] === "}") { d--; if (d === 0) { sniffEnd = i + 1; break; } }
  }
  const gAt = inj.indexOf("  function guessExtFromType(ct)");
  let g2 = 0, gEnd = gAt;
  for (let i = inj.indexOf("{", gAt); i < inj.length; i++) {
    if (inj[i] === "{") g2++;
    else if (inj[i] === "}") { g2--; if (g2 === 0) { gEnd = i + 1; break; } }
  }
  const imgAt = inj.indexOf("  const IMG_MIME_EXT = {");
  const imgEnd = inj.indexOf("};", imgAt) + 2;

  const src = [
    inj.slice(extStart, extEnd),
    inj.slice(asciiAt, asciiEnd),
    inj.slice(imgAt, imgEnd),
    inj.slice(sniffAt, sniffEnd),
    inj.slice(gAt, gEnd),
    "this.__sniffExt = sniffExt; this.__guessExt = guessExtFromType;",
  ].join("\n");
  const ctx = { __sniffExt: null, __guessExt: null };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: "ext" });

  const b = (...n) => new Uint8Array(n.concat(new Array(16).fill(0)).slice(0, 16));

  check("[EXT] JPEG 魔数 → .jpg",
    ctx.__sniffExt(b(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01)) === ".jpg",
    String(ctx.__sniffExt(b(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01))));
  check("[EXT] PNG 魔数 → .png",
    ctx.__sniffExt(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0)) === ".png",
    String(ctx.__sniffExt(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0))));
  check("[EXT] GIF 魔数 → .gif",
    ctx.__sniffExt(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])) === ".gif", "bad");
  check("[EXT] WEBP 魔数 → .webp",
    ctx.__sniffExt(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])) === ".webp", "bad");
  check("[EXT] mp4 魔数不受影响",
    ctx.__sniffExt(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])) === ".mp4", "bad");

  check("[EXT] image/jpeg → .jpg（原先返回 null）", ctx.__guessExt("image/jpeg") === ".jpg", String(ctx.__guessExt("image/jpeg")));
  check("[EXT] image/png → .png", ctx.__guessExt("image/png") === ".png", String(ctx.__guessExt("image/png")));
  check("[EXT] 带 charset 也能认", ctx.__guessExt("image/jpeg; charset=binary") === ".jpg", String(ctx.__guessExt("image/jpeg; charset=binary")));
  check("[EXT] video/mp4 仍走原路", ctx.__guessExt("video/mp4") === ".mp4", String(ctx.__guessExt("video/mp4")));

  // 认不出来的兜底不能再写死 .mp4
  check("[EXT] 两处兜底都不再硬写 .mp4",
    !/sniffExt\([^)]*\)\s*\|\|\s*guessExtFromType\([^)]*\)\s*\|\|\s*"\.mp4"/.test(inj),
    "still falls back to .mp4");
}

/**
 * [DPL] DPlayer 站（51cg1 这类）：播放器没起来时从 data-config 取地址
 *
 * 用户 m16052 报「51cg1 不起作用」。查下来：站方用 DPlayer + hls.js，
 * hls.js 一挂，播放器永远停在「播放器加载中...」，浏览器一次都没请求过
 * .m3u8，webRequest 什么都看不见。但地址就摆在 data-config 里。
 *
 * 这里测的是纯解析逻辑（不碰 DOM）：给一段真实形态的 data-config，
 * 能不能取出 video.url、以及退回 video_h265.url。
 */
function testDplayerConfig() {
  console.log("\n[DPL] DPlayer data-config 解析");

  const inj = fs.readFileSync(path.join(__dirname, "..", "extension", "inject-main.js"), "utf8");

  check("[DPL] 有 dplayerConfigUrl 函数", /function dplayerConfigUrl\(\)/.test(inj));
  check("[DPL] 注册了 dplayer 站点", /name: "dplayer"/.test(inj));
  check("[DPL] 站点用 .dplayer[data-config] 当 match",
    /match: \(\) => !!document\.querySelector\("\.dplayer\[data-config\], #dplayer\[data-config\]"\)/.test(inj));
  check("[DPL] 有 onScanMedia 钩子（播放器没起来时接管扫描）",
    /onScanMedia: \(\) => \{/.test(inj));
  check("[DPL] scanMedia 会先问站点 onScanMedia",
    /if \(scanSite && scanSite\.onScanMedia\)/.test(inj));

  // 抽 dplayerConfigUrl 的函数体在 vm 里跑，喂真实形态的 data-config。
  // 用大括号配对切（函数内有 try/catch，indexOf("}") 会截断）。
  const start = inj.indexOf("function dplayerConfigUrl()");
  check("[DPL] 能定位到函数体", start > 0);
  if (start > 0) {
    let i = inj.indexOf("{", start);
    let depth = 0, end = -1;
    for (let k = i; k < inj.length; k++) {
      const ch = inj[k];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = k + 1; break; } }
    }
    check("[DPL] 函数体大括号配对成功", end > i);
    const body = inj.slice(start, end);

    // 造一个最小 DOM 桩：只要 querySelectorAll 返回我们给的节点
    function makeCtx(configText) {
      const node = {
        getAttribute(n) { return n === "data-config" ? configText : null; },
      };
      const ctx = vm.createContext({
        document: { querySelectorAll: () => [node] },
        JSON, String, RegExp, console,
      });
      vm.runInContext(body + "\nthis.__get = dplayerConfigUrl;", ctx, { filename: "dplayer-config" });
      return ctx;
    }

    // 真实形态：站方把 https:// 转义成 https:\/\/ 再塞进属性里
    const realCfg = JSON.stringify({
      live: false,
      video: {
        url: "https://hls.weagdnz.cn/videos5/932dd69d68fa7fbd0aa85493623b492b/932dd69d68fa7fbd0aa85493623b492b.m3u8?auth_key=1792585246-6ad8ae1e3c113-0-a75597717e3632a5bef480549ceabbc5&v=3&time=0",
        type: "hls",
      },
      video_h265: {
        url: "https://hls.weagdnz.cn/m3m/d41c6e6e104f0fef482b5591c74bd169.m3u8?auth_key=1792585246-6ad8ae1e3c12a-0-8aa340b8548fd16c13782b9d38fb2450&v=3&time=0",
        type: "hls",
      },
    });
    const c1 = makeCtx(realCfg);
    const u1 = vm.runInContext("this.__get()", c1);
    check("[DPL] 取到主视频地址", /^https:\/\/hls\.weagdnz\.cn\/videos5\//.test(u1), u1);
    check("[DPL] 主地址优先于 h265 备用", u1.indexOf("/videos5/") > 0, u1);

    // 只有 h265 时退回它
    const only265 = JSON.stringify({ video_h265: { url: "https://a.com/x.m3u8", type: "hls" } });
    const c2 = makeCtx(only265);
    const u2 = vm.runInContext("this.__get()", c2);
    check("[DPL] 没有主地址时退回 video_h265", u2 === "https://a.com/x.m3u8", u2);

    // 配置是坏 JSON 时不抛错、返回空串（页面上可能出现半渲染的属性）
    const c3 = makeCtx("{not json");
    const u3 = vm.runInContext("this.__get()", c3);
    check("[DPL] 坏 JSON 返回空串而不是抛错", u3 === "", u3);

    // 地址不是 http(s) 的一律不要（javascript: / data: 之类）
    const bad = JSON.stringify({ video: { url: "javascript:alert(1)" } });
    const c4 = makeCtx(bad);
    const u4 = vm.runInContext("this.__get()", c4);
    check("[DPL] 非 http(s) 地址被拒绝", u4 === "", u4);
  }
}

testDplayerConfig();

console.log("\n==============================================");
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
