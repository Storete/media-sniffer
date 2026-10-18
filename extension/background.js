/**
 * 资源嗅探 - background service worker
 *
 * 职责：
 *  1. 用 webRequest 监听所有 http(s) 请求，按类型归类，按标签页归档
 *  2. 给扩展图标加角标
 *  3. 接收 popup 指令，把链接交给本地 Native Host（yt-dlp）下载并回传进度
 */

const HOST_NAME = "com.starmediasniffer.host";
const MAX_PER_TAB = 5000;
const MAX_SEGMENTS = 400;
const FLUSH_DELAY = 600;

// 最小体量门槛（借鉴 CocoCut 的可配置白名单阈值）：content-length 明确存在且小于
// 门槛的媒体请求直接丢弃。很多假资源（1×1 像素、空占位、几字节的 mime 声明）content-length
// 极小，webRequest 会把它们全抓进来堆在列表里。门槛取最宽松一档，绝不误杀真内容。
// 注意：只作用于「完整响应」（statusCode 非 206）。206 是 Range 分段响应，content-length
// 只是分段长度，用它判体量会把真视频误删——分段由 existed 分支的「取最大 size」修正。
const MIN_MEDIA_BYTES = {
  video: 2048,     // 2KB
  audio: 10240,    // 10KB（CocoCut 对 audio/* 也是 10KB）
  image: 512,      // 半 KB，仅挡掉 1×1 像素/空占位
  seg: 0, doc: 0, font: 0, other: 0, icon: 0,
};

// ---------------------------------------------------------------- 分类规则

const EXT_TO_KIND = {
  video: ["m3u8", "mpd", "mp4", "webm", "flv", "mov", "mkv", "avi", "m4v", "f4v", "ogv", "3gp", "m2ts", "mts"],
  audio: ["mp3", "m4a", "ogg", "oga", "opus", "wav", "flac", "weba", "mid", "midi"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif", "tif", "tiff"],
  doc: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "md", "epub", "zip", "rar", "7z", "tar", "gz"],
  font: ["woff", "woff2", "ttf", "otf", "eot"],
};

const SEGMENT_EXT = new Set(["ts", "m4s", "cmfv", "cmfa", "init", "key", "vtt", "srt", "aac"]);

const KIND_ORDER = ["video", "audio", "image", "icon", "doc", "font", "other", "seg"];

function extOf(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    const seg = p.split("/").pop() || "";
    const i = seg.lastIndexOf(".");
    return i > 0 ? seg.slice(i + 1) : "";
  } catch {
    return "";
  }
}

function kindFromMime(mime) {
  if (!mime) return null;
  const m = mime.toLowerCase().split(";")[0].trim();
  if (m === "application/vnd.apple.mpegurl" || m === "application/x-mpegurl") return "video";
  if (m === "application/dash+xml") return "video";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("font/") || m === "application/font-woff" || m === "application/vnd.ms-fontobject") return "font";
  if (m === "application/pdf" || m.startsWith("application/msword") ||
      m.startsWith("application/vnd.openxmlformats") || m.startsWith("application/vnd.ms-") ||
      m.startsWith("text/csv") || m === "application/epub+zip") return "doc";
  if (m.startsWith("text/html") || m.startsWith("text/css") || m.startsWith("text/javascript") ||
      m === "application/javascript" || m === "application/json" || m === "text/plain") return "other";
  return null;
}

function classify(url, mime) {
  const ext = extOf(url);
  if (SEGMENT_EXT.has(ext)) return "seg";
  const byMime = kindFromMime(mime);
  if (byMime) return byMime;
  // 无扩展名的媒体端点（Telegram /progressive/document<id>、/k/stream/... 等）
  if (/\/(progressive|stream|k\/stream|playback|video|media|documents?)\//i.test(url)) return "video";
  for (const [kind, list] of Object.entries(EXT_TO_KIND)) {
    if (list.includes(ext)) return kind;
  }
  return "other";
}

// ---------------------------------------------------------------- 内存状态

/**
 * tabId -> { url, items: Map<url, item>, dirty }
 * item = { u, k, m, s, h, t, i }
 */
const state = new Map();
let buffered = [];
let loaded = false;
const loadPromise = restore().then(() => {
  loaded = true;
  for (const detail of buffered) record(detail);
  buffered = [];
});

async function restore() {
  try {
    const all = await chrome.storage.session.get(null);
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith("tab:") || !value || !value.items) continue;
      const tabId = Number(key.slice(4));
      if (!Number.isFinite(tabId)) continue;
      state.set(tabId, { url: value.url || "", items: new Map(value.items), dirty: false });
    }
  } catch {
    /* session storage 不可用时从空状态开始 */
  }
}

function ensureTab(tabId) {
  let rec = state.get(tabId);
  if (!rec) {
    rec = { url: "", items: new Map(), dirty: false };
    state.set(tabId, rec);
  }
  return rec;
}

function flushSoon(tabId) {
  const rec = state.get(tabId);
  if (!rec || rec.dirty) return;
  rec.dirty = true;
  clearTimeout(flushSoon._t);
  flushSoon._t = setTimeout(() => flushAll(), FLUSH_DELAY);
}

async function flushAll() {
  const payload = {};
  for (const [tabId, rec] of state) {
    if (!rec.dirty) continue;
    rec.dirty = false;
    // 只存必要字段，控制 session storage 体积
    payload["tab:" + tabId] = {
      url: rec.url,
      items: [...rec.items.values()].map((it) => [it.u, it]),
    };
  }
  if (!Object.keys(payload).length) return;
  try {
    await chrome.storage.session.set(payload);
  } catch {
    /* 超出配额时忽略，内存里仍然可用 */
  }
}

// ---------------------------------------------------------------- 记录一条请求

function headerValue(headers, name) {
  if (!headers) return "";
  const hit = headers.find((h) => h.name.toLowerCase() === name);
  return hit ? hit.value || "" : "";
}

/**
 * 老版本把命中次数记在 `h` 里，而 `h` 现在表示高度。升级后仍在 storage.session
 * 里的旧条目要能继续用：只有当它没有 w/h 尺寸（说明 h 不是高度）时才把 h 当次数。
 */
function it_legacyHits(it) {
  if (!it || it.h === undefined) return 0;
  if (it.w || it.dur || it.page) return 0; // 有尺寸/时长的，h 一定是高度
  return Number(it.h) || 0;
}

function record(d) {  if (!d || !d.tabId || d.tabId < 0) return;
  if (!/^https?:/i.test(d.url)) return;
  if (d.type === "main_frame") {
    const rec = ensureTab(d.tabId);
    rec.url = d.url;
    flushSoon(d.tabId);
    return;
  }
  const rec = ensureTab(d.tabId);
  const mime = headerValue(d.responseHeaders, "content-type");
  const kind = classify(d.url, mime);
  const size = Number(headerValue(d.responseHeaders, "content-length")) || 0;

  // 最小体量门槛（见 MIN_MEDIA_BYTES 注释）：明确小于门槛的完整响应丢弃。
  // 206 分段响应跳过门槛（content-length 只是分段长度，真体量靠后续 existed 分支补）。
  if (d.statusCode !== 206 && size > 0 && size < (MIN_MEDIA_BYTES[kind] || 0)) return;

  const now = Date.now();
  const existed = rec.items.get(d.url);
  if (existed) {
    // 命中次数单独算：`h` 在页面条目里是图片/视频高度，不能混用
    existed.hits = (existed.hits || it_legacyHits(existed)) + 1;
    existed.t = now;
    if (size > (existed.s || 0)) existed.s = size; // Range 请求的 content-length 只是分段长度
    if (!existed.m && mime) existed.m = mime;
    confirmPageItem(existed);
    flushSoon(d.tabId);
    return;
  }

  if (rec.items.size >= MAX_PER_TAB) return;
  if (kind === "seg" && countKind(rec, "seg") >= MAX_SEGMENTS) return;

  rec.items.set(d.url, {
    u: d.url,
    k: kind,
    m: mime.split(";")[0],
    s: size,
    hits: 1,
    t: now,
    i: d.initiator || "",
  });
  rec.items.get(d.url).f = fileNameOf(d.url);
  flushSoon(d.tabId);
  bumpBadge(d.tabId, kind, rec);
}

/**
 * imgctx 先到、webRequest 后到：条目已经存在但还没标 page。
 * 现在能确认它是页面里真发出去的请求了（有大小有 mime），把标志补上。
 */
function confirmPageItem(it) {
  if (!it || it.page) return;
  if (!it.mid && !it.title) return; // 不是页面上下文抓来的条目
  it.page = 1;
  it.bid = it.bid || it.u;
  it.f = it.f || fileNameOf(it.u);
}

function countKind(rec, kind) {
  let n = 0;
  for (const it of rec.items.values()) if (it.k === kind) n++;
  return n;
}

function fileNameOf(url) {
  try {
    const p = new URL(url).pathname;
    const last = decodeURIComponent(p.split("/").filter(Boolean).pop() || "");
    return last.length > 120 ? last.slice(0, 117) + "..." : last;
  } catch {
    return "";
  }
}

/**
 * 下载完成后弹系统通知（桌面右下角 / 通知中心）。
 *
 * 背景：下载跑在「页面主世界」（inject-main.js），完成时只有页面右下角一个浮层卡片。
 * 用户一切页面（切 tab / 切窗口 / 最小化浏览器），那张卡片就看不到了，感觉「卡住没反应」。
 * 系统通知是浏览器级别的，不随页面走，切走、最小化、甚至浏览器在后台都能弹出来。
 *
 * 这里只认「页面保存」这条链路（page 模式，blob/MSE/Range 链下载都汇到这里的 saved 事件）；
 * 「原生下载」（native:download，交给本地 downloader.py）走 popup 的进度条，关弹窗也能继续，
 * 那条链路由 popup 的 addJob/updateJob 负责展示，不在这里重复弹。
 */
function notifySaved(p) {
  try {
    if (!chrome.notifications || !chrome.notifications.create) return;
    const ok = p.ok !== false;
    const name = (p.filename || p.key || "").split(/[\\/]/).pop() || "媒体";
    const sizeText = p.size ? `（${(p.size / 1048576).toFixed(1)}MB）` : "";
    const title = ok ? "资源嗅探 · 保存完成" : "资源嗅探 · 保存失败";
    const message = ok
      ? `${name}${sizeText} 已保存到本地`
      : `${name}：${p.error || "未知错误"}`;
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
      priority: ok ? 0 : 2,
    });
  } catch (e) { /* 通知失败不影响下载本身 */ }
}

const badgeTimer = new Map();
function bumpBadge(tabId, kind, rec) {
  if (kind !== "video" && kind !== "audio") return;
  clearTimeout(badgeTimer.get(tabId));
  badgeTimer.set(tabId, setTimeout(() => {
    let n = 0;
    for (const it of rec.items.values()) if (it.k === "video" || it.k === "audio") n++;
    const text = n ? (n > 99 ? "99+" : String(n)) : "";
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
    chrome.action.setBadgeText({ tabId, text });
  }, 300));
}

// ---------------------------------------------------------------- 页面内捕获（blob / MSE）

/**
 * Telegram 这类站点没有可嗅探的媒体 URL：数据走自定义协议，浏览器端解密后
 * 拼成 Blob 交给 <video>。这部分条目由页面内 hook 上报，标记 page=1，
 * 保存时走「页面内 a[download]」而不是本地 yt-dlp。
 */
function recordPageMedia(tabId, pageUrl, p) {
  const key = p.key || p.id;
  if (!key) return;
  const isHttp = /^https?:/i.test(key);
  const rec = ensureTab(tabId);
  if (!rec.url && pageUrl) rec.url = pageUrl;

  // http 媒体 URL 直接用 URL 作 key，与 webRequest 抓到的那条合并；
  // blob / MSE 用 "page:" 前缀，避免和普通请求冲突。
  const mapKey = isHttp ? key : "page:" + key;
  const now = Date.now();
  const mime = p.mime || "";
  // imgctx 只是「这张图的 DOM 上下文」，本体由 webRequest 那条路抓。
  // 它不能把条目标成 page=1（否则 popup 会给它弹页面保存面板），
  // 也不能把 mime 变成通配的 image/*。
  const ctxOnly = p.source === "imgctx";
  // blob: 的图片本体永远等不到 webRequest（页面自己 createObjectURL 的），
  // imgctx 那条消息就是它的唯一来源 —— 不算「只带上下文」，直接按页面条目建
  const ctxBlobImg = ctxOnly && /^blob:/i.test(key);
  // kind 必须认 image：媒体查看器复用 <video> 元素时会把它正在显示的图片
  // （image/jpeg 的 progressive URL）也报成「页面视频」，列表里出现假视频条目
  const kind = mime.startsWith("audio/") ? "audio"
    : mime.startsWith("image/") ? "image" : "video";

  // m1 / m2 这类 MSE 录制条目、以及小红书 <video> 的 blob: 地址，都只是
  // 「页内播放器正在吃分片」的副产品。页面一旦报出同一条视频的真实 mp4 地址
  // （hint=xhs-note + k=video），它们就该让位 —— 否则列表里同时出现
  // 「① 真实视频」和「m1 页面视频（录制中）」，用户不知道该点哪个。
  //
  // ⚠️ 必须在 `const existed = ...` **之前**：录制/blob 条目往往比真实地址
  // 晚到（播放器挂载后 MSE hook 才建 m1），放进 existed 分支里就永远轮不到。
  if (kind === "video" && p.hint === "xhs-note") {
    rec.xhsVid = isHttp ? mapKey : "";
    let dropped = 0;
    for (const [itKey, it] of [...rec.items]) {
      if (it.k !== "video") continue;
      const u = it.u || "";
      if (/^m\d+$/.test(u) || /^blob:/i.test(u)) { rec.items.delete(itKey); dropped++; }
    }
    if (dropped) flushSoon(tabId);
  }

  // 小红书详情页里，播放器吃分片这件事本身没有保存价值：真实 mp4 地址由
  // inject-main 的 reportXhsVideo 从 __INITIAL_STATE__ 直接给出，与 <video>
  // 是否挂载、播放到哪都无关。所以同 tab 一旦有了真实地址，MSE 录制条目
  // （m1/m2）和它的 blob: 地址就**不再准入**，连建都不建。
  //
  // 只做「事后清理」不够：页面每 0.6s 扫一次 <video>，会把 m1/m2 一遍遍
  // 重新播报回来，列表里就永远挂着一个「页面视频（录制中）」。
  if (!p.hint && rec.xhsVid && kind !== "image" && (p.source === "mse" || /^blob:|^m\d+$/.test(String(key)))) {
    return;
  }

  const existed = rec.items.get(mapKey);
  if (existed) {
    if (p.size) existed.s = p.size;
    if (p.mime && !ctxOnly) existed.m = p.mime;
    if (ctxBlobImg && p.mime && p.mime !== "image/*") existed.m = p.mime;
    if (p.title) existed.title = p.title;
    if (p.w) existed.w = p.w;
    if (p.h) existed.h = p.h;
    if (p.dur) existed.dur = p.dur;
    if (p.state) existed.state = p.state;
    if (p.mid) existed.mid = p.mid;
    if (p.ref) existed.ref = p.ref;
    if (p.ct) existed.m = p.ct;
    if (typeof p.ord === "number") existed.ord = p.ord;
    if (p.hint) existed.hint = p.hint;
    if (typeof p.inChrome === "boolean") existed.ic = p.inChrome ? 1 : 0;
    // 已有条目也要跟着 mime 修正分类：同一 URL 先被当成 video 上报、
    // 后来才拿到 image/jpeg 的情况（Telegram 媒体查看器复用 <video> 元素）会
    // 一直挂在「视频」栏里。只在能确定新分类时才改，避免把唯一一次 mime 覆盖成空。
    if ((p.mime && !ctxOnly) || p.ct || ctxBlobImg) {
      const nk = (p.ct || (ctxBlobImg ? p.mime : "") || existed.m || "");
      const fixed = nk.startsWith("audio/") ? "audio"
        : nk.startsWith("image/") ? "image" : null;
      if (fixed && existed.k !== fixed) {
        existed.k = fixed;
        bumpBadge(tabId, fixed, rec);
      }
    }
    // 页面内 http 媒体（Telegram 等）：交给页面里抓；blob 图直接就是页面条目
    if ((isHttp && !ctxOnly) || ctxBlobImg) existed.page = 1;
    // imgctx 条目刚拿到 title/mid 时也要补一次 page：
    // webRequest 常常比页面的 found 消息先到，那时 confirmPageItem 因为
    // 条目上还没有 title 直接返回了，page 就永远停在 0。小红书这类
    // 「图片本体由 webRequest 抓、上下文由 imgctx 报」的站点全靠这一步。
    confirmPageItem(existed);
    existed.t = now;
    flushSoon(tabId);
    return;
  }

  rec.items.set(mapKey, {
    u: key,
    k: kind,
    m: (ctxOnly && !ctxBlobImg) ? "" : mime,
    s: p.size || 0,
    hits: 1,
    t: now,
    i: pageUrl || "",
    // ctxOnly 的图片本体还没被 webRequest 抓到，先不标 page：
    // 等真正的请求进来时由 record() 补上大小/mime，popup 也才知道该给什么按钮。
    // blob 图例外：它的 imgctx 消息就是唯一来源，直接当页面条目
    page: (ctxOnly && !ctxBlobImg) ? 0 : 1,
    bid: key,
    title: p.title || "",
    live: p.live ? 1 : 0,
    w: p.w || 0,
    h: p.h || 0,
    dur: p.dur || 0,
    state: p.state || "",
    mid: p.mid || "",
    ref: p.ref || "",
    ord: typeof p.ord === "number" ? p.ord : -1,
    hint: p.hint || "",
    ic: p.inChrome ? 1 : 0,
  });
  if (p.own) rec.items.get(mapKey).own = 1;
  if (isHttp || ctxBlobImg) rec.items.get(mapKey).f = fileNameOf(key);
  flushSoon(tabId);
  bumpBadge(tabId, kind, rec);
}

// ---------------------------------------------------------------- 图片：图标判定 + 序号
//
// 用户要求把「图片」和「小图标」分开，并且同一条消息里的图片用 ①②③ 编号。
//
// 图标判定（尺寸为主，URL 加严）：只看尺寸会把 Telegram 的小缩略图误判成
// 图标，只看 URL 又认不出别的站。
//   1. 显示尺寸两边都 ≤ ICON_MAX（默认 96px），且
//   2. URL 不像媒体 CDN 的缩略图端点
// 注意：Telegram 的图片域就是 media-cdn.telesco.pe（用户截图里 46 个 100×100
// 的 UI 小图也来自它），不能拿「在不在 CDN 域」来区分图和图标 —— 真正能区分
// 的是 DOM 上下文（imgctx 报上来的有消息归属 = 用户内容；webRequest-only 的
// 小图没有 = 页面装饰），以及非 Telegram 站的 CDN 缩略图 URL 特征。
const ICON_MAX = 96;
const THUMB_HINT = /\/file\/|thumb|avatar|emoji|\/icons?\/|img-apple-64|\/assets\//i;
// B 站等站的图片 CDN 域名特征（只用于加严，不用于豁免 —— Telegram 的教训）
const CDN_HINT = /hdslb\.com|alicdn\.com|bdstatic\.com|gtimg\.cn|byteimg\.com|360buyimg\.com/i;
// 小红书头像/二维码的 URL 特征：头像走 sns-avatar.xhscdn.com 且路径含 view2/2/w/60 这种
// 小尺寸裁切，二维码/logo 是 xhscdn.com 上的固定素材。即使页面侧 imgIsXhsDecor 漏了，
// 这里也能把走 webRequest-only 路径抓到的头像/二维码判成 icon（popup 已过滤 icon）。
const XHS_AVATAR_HINT = /xhscdn\.com\/[^"'\s]*view2\/\d+\/w\/\d+\//i;
const XHS_QR_HINT = /xhscdn\.com\/[^"'\s]*(qrcode|qr-code|logo|icon)[^"'\s]*/i;
// 小红书正文图的路径特征。定义在这里而不是去重逻辑旁边，是因为 looksLikeIcon()
// 也要用它来区分「笔记配图」和「站点素材」；两份常量各写一次迟早会改歪。
const XHS_ASSET_PATH = /(?:^|\/)(spectrum|notes_pre_post|notes|oss-sg|comment)\/(1040g[0-9a-z]{20,})(?=$|[!?_])/i;
/** 评论区贴的图：路径里多一段 /comment/（页面侧和这里共用同一条判据） */
const XHS_COMMENT_IMG = /xhscdn\.com\/[^"'\s]+\/comment\/[^"'\s]*1040g/i;

// ---------------------------------------------------------------------------
// 「这张图是不是站点装饰（图标/logo/徽章/头像）」
//
// 借鉴了一份 Playwright 抓图脚本的判据（用户提供）：它不只看 URL，还看
//   · 图片的天然尺寸（naturalWidth/Height）——太小的一定不是内容图
//   · class / id / alt / 父级 class 里的关键词（avatar|logo|icon|profile|sprite|badge|emoji）
//   · 是否位于 header / nav / footer / aside（页面外壳里的图都是装饰）
// 这些信号比单看 URL 准得多，尤其对「URL 看着正常、其实是网站 UI 小图」的情况。
//
// 但有一个 Telegram 的教训必须保留（HANDOVER 9.10）：Telegram 的图片域就是
// media-cdn.telesco.pe，UI 小图和用户照片同一个域名，**不能靠域名或 URL 判断**。
// 所以顺序很重要：
//   1. 页面里确认过归属（有 mid / 有 title）→ 一定是内容，直接放行（最高优先级）
//   2. 有 DOM 上下文（hint/inChrome）→ 用 Playwright 那套规则判
//   3. 只有 webRequest 的裸条目 → 退回原来的 URL + 体积启发式
// 这样 Telegram 的真图靠第 1 条救回来，而 B 站首页/普通网站的装饰图靠第 2 条筛掉。
// ---------------------------------------------------------------------------

/** 上下文关键词：带这些词的基本都是站点装饰（来自 Playwright 脚本的 BAD 正则，稍作扩充） */
const DECOR_HINT = /avatar|logo|icon|profile|sprite|badge|emoji|favicon|placeholder|loading|spinner|qrcode|qr-code|share-pic|sharepic/i;
// 太小的图一定不是内容（Playwright 脚本用 400×200，这里放宽：图标判定只关心「小」）
const DECOR_MAX = 120;
// 方形小图 = 头像 / 徽章（Playwright 脚本：0.9 < ratio < 1.1 且宽 < 800）
const AVATAR_MAX = 200;
// 无 mid 时，标题至少要这么长才当「这张图自己的内容标题」。
// B 站的 UI 按钮文字（「充电 关注 95.4万」= 9 字）远短于此，而 Telegram 的消息
// 正文/文件名通常更长；这条线把两者分开，避免按钮文字冒充内容标题。
const TITLE_MIN = 12;

/**
 * 这个标题是不是「页面标题」本身（而不是这张图自己的内容标题）。
 *
 * 普通网站里 guessTitle(el) 会沿 DOM 往上找最近的、像标题的文本，B 站这种整页
 * 只有一个 h1 的站点几乎每张图都会拿到同一个视频标题 —— 那不是「这张图有归属」，
 * 只是「它所在的页面有标题」。用它当放行理由会让所有装饰图漏网（实测 B 站
 * 充电按钮图标 / 头像占位 / loading 图全部混进图片栏）。
 *
 * 判据：条目自己的标题等于（或包含于）页面标题 → 视为页面标题污染。
 */
function isPageTitle(title, rec) {
  const t = String(title || "").trim();
  if (!t) return false;
  const page = String((rec && rec.url) || "");
  // 页面标题从 URL 里拿不到，只能靠启发式：B 站等站的 title 很长且带站点名
  // 我们用两条路：
  //   1) 标题含站点后缀（_哔哩哔哩 / - bilibili 等）
  //   2) 标题长度 ≥ 12 且没有消息归属（mid）—— 常见 UI 图不会有这么长的自述标题
  if (/_哔哩哔哩|-\s*bilibili|_bilibili|\.\.\.\s*$/i.test(t)) return true;
  if (/^[^\u4e00-\u9fa5]{0,3}(正在|加载|缓冲)/.test(t)) return true;
  // 页面 URL 里的视频/文章 id 出现在标题里也算（B 站 h1 = 视频标题）
  if (page && t.length >= 12) return true;
  return false;
}

function looksLikeIcon(it, rec) {
  const w = it.w | 0;
  const h = it.h | 0;
  // 1. 消息归属最高优先：Telegram 的照片带 mid（消息 id），那是「这条消息的内容」，
  //    即使它所在的容器类名里恰好有 icon/avatar 之类字样也不能误杀。
  if (it.mid) return false;

  // 2. 没有 mid 时，title 只能「部分」证明这是内容：
  //    真实的消息/文件标题通常是一句话（够长），而 B 站这类站点的 guessTitle 常
  //    抓到邻近的按钮文字（「充电 关注 95.4万」「正在缓冲...」），很短且不是标题。
  //    所以短标题不足以豁免装饰判定，继续往下让 hint / 尺寸说话。
  const ttl = String(it.title || "").trim();
  const titleIsContent = ttl && !isPageTitle(ttl, rec) && ttl.length >= TITLE_MIN;
  if (titleIsContent) return false;

  // 3. DOM 上下文里明确写着这是装饰（class/id/alt 命中 avatar|logo|icon|...）。
  //    这比短 title 可信 —— B 站「充电按钮」的图片，guessTitle 抓到的是旁边按钮上的
  //    「充电 关注 95.4万」，看着像正经标题，其实是 UI 文字；类名 charge-btn-icon
  //    才是这张图真正的身份。参考的 Playwright 脚本也是这么做的：BAD 命中直接丢。
  const hint = String(it.hint || "");
  if (hint && DECOR_HINT.test(hint)) return true;
  // 在页头 / 页脚 / 侧栏里 → 站点外壳，装饰
  if (it.ic) return true;

  const u = String(it.u || "");
  const s = it.s | 0;

  // 2. 有 DOM 上下文就用尺寸判（比 URL 可信）
  const hasCtx = !!(hint || it.ic);
  if (hasCtx) {
    // 天然尺寸极小（两边都 ≤ DECOR_MAX）
    if (w && h && w <= DECOR_MAX && h <= DECOR_MAX) return true;
    // 方形小图：大概率是头像/徽章
    if (w && h && w < AVATAR_MAX && h < AVATAR_MAX) {
      const ratio = w / h;
      if (ratio > 0.88 && ratio < 1.14) return true;
    }
    // 有上下文且过了上面几关 → 当内容图，不再用 URL 的模糊规则误杀
    return false;
  }

  // 3. 裸条目（只有 webRequest，没有 DOM 上下文）：沿用原来的启发式
  //    有渲染尺寸的：两边都 ≤ ICON_MAX 才算图标
  if (w && h) {
    if (w > ICON_MAX || h > ICON_MAX) return false;
    return !THUMB_HINT.test(u);
  }
  // 站方自带的图标/素材目录（Telegram 的 /a/img-apple-64/ emoji、/a/assets/ UI 素材）
  // 是确定的图标来源，先于体积判断：wave-ripple 这类 UI 素材会超过 24KB，
  // 但仍然是图标不是用户图片。
  if (/img-apple-64|\/assets\//i.test(u)) return true;
  // 小红书头像/二维码（走 webRequest-only 无 DOM 上下文时靠 URL 特征兜底）
  if (XHS_AVATAR_HINT.test(u) || XHS_QR_HINT.test(u)) return true;
  // 小红书的站点素材（2026-10-18 第十轮真机）：这些图走 webRequest-only、没有 DOM
  // 上下文，体积又会骗过下面的 24KB 线 —— 实测 svg-sprite.6.57.6.svg 有 80.7KB、
  // fe-platform.xhscdn.com 的 104101l…png 只有 1KB，两条都混进了正文图片列表。
  // 它们的共同点是「不是笔记配图」：配图一定在 sns-webpic/sns-img 的
  // spectrum|notes_pre_post|notes|oss-sg 目录下且带 1040g fileId，
  // 其余 xhscdn.com / xiaohongshu.com 上的图片一律按站点装饰处理。
  if (/xiaohongshu\.com\/[^"'\s]*\.(svg|ico)(\?|$)/i.test(u)) return true;
  if (/fe-(static|platform)\.xhscdn\.com\//i.test(u)) return true;
  // 小红书评论区里的图（路径里多一段 /comment/）：页面侧 imgIsXhsComment 已拦了一道，
  // 但走 webRequest-only 的条目没有 DOM 上下文，只能在这里按路径兜底。
  // 用户明确要求「评论区里的图片也会抓取，这个要改」。
  // 注意顺序：这条必须在下面 XHS_ASSET_PATH 那行之前，因为 /comment/ 本身
  // 也匹配 XHS_ASSET_PATH 的类型段，先判类型段会把它当成正文图放行。
  if (XHS_COMMENT_IMG.test(u)) return true;
  if (/xhscdn\.com\//i.test(u) && !XHS_ASSET_PATH.test(u)) return true;
  if (s && s > 24 * 1024) return false;          // 大于 24KB 的先当真图
  if (THUMB_HINT.test(u)) return true;
  if (/\.(svg|ico)(\?|$)/i.test(u)) return true; // svg/ico 基本都是图标
  if (CDN_HINT.test(u)) return true;             // 已知图片 CDN 上的无尺寸小文件
  return false;
}

/**
 * 给同一 tab 内的图片/视频重编序号。
 *
 * 序号范围 = 「同一条消息」：先按 mid 分组，组内按页面里的 DOM 阅读顺序（ord，
 * 从左到右从上到下）排，再依次编 ①②③。没有 mid 的（普通网站）按标题分组，
 * 标题也没有就整组按抓到的先后排。
 *
 * 图片和视频分别排自己的序号（一段图文混排的消息里，视频和图片各自从 ① 起），
 * 因为用户是按「相册里的图」「消息里的视频」两件事分别看的。
 *
 * 只给「已经抓到的」编号 —— Telegram 的列表是虚拟滚动的，没渲染出来的媒体
 * 根本不会发请求，也就不可能有 DOM 顺序，所以序号只对当前已渲染的这批成立。
 */
const CIRCLE = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩",
  "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];

function markOf(n) {
  if (n >= 1 && n <= CIRCLE.length) return CIRCLE[n - 1];
  return "(" + n + ")";
}

const NUMBERED_KINDS = new Set(["image", "video"]);

function renumberImages(rec) {
  // 小红书详情页（2026-10-18 第七轮）：正文配图/视频常常既没有 mid（不是 Telegram
  // 消息）也没有 title（页面没给标题），会被下面「无 mid 无 title 跳过」的规则
  // 整批漏掉，序号就永远编不出来。用户要求「给图片加一个排序，逻辑和之前实现过的一样」。
  //
  // 这里不再要求它自己有 mid/title，改成按「帖子」分组：详情页整页只有一个帖子，
  // 所以所有正文媒体天然同组，编号 = 页面里的 DOM 阅读顺序（ord，由 inject-main 给）。
  const xhsDetail = isXhsDetailUrl((rec && rec.url) || "");
  const groups = new Map();
  for (const it of rec.items.values()) {
    if (!NUMBERED_KINDS.has(it.k)) continue;
    // 页面自己上传的图（popup 那边不显示），不参与编号
    // 既没有 mid 也没有 title 的图（B 站等普通网站的装饰图 / 头像 / 封面，
    // webRequest-only 抓来的）不属于「同一条消息里的多张图」，不给编号。
    // 否则会把整页互不相关的图归进同一个空标题组，编成 ①~㉔（m03690 的乱序号）。
    // 小红书详情页例外：上面的 DOM 归属过滤已经保证「剩下的都属于当前帖子」，
    // 且它们本来就该整组编号。
    if (!xhsDetail && !it.mid && !(it.title || "").trim()) continue;
    // 小红书详情页还要再筛一层：这个 tab 里同时混着三种「图/视频」——
    //   · 正文（hint=xhs-note 的图 + 有标题的真实视频）  ← 要编号的
    //   · svg-sprite / 站点素材 / 别的帖子的封面缩略图  ← 没 hint 也没标题
    //   · MSE 录制条目 m1/m2（k 是 video/audio，但 u 是 "m1"）  ← 绝不能编号
    // 以前只靠 popup 那边隐藏，background 照样把它们编号，于是真图被顶到 ④⑤、
    // MSE 条目拿到 (26)，用户看到的「①」根本对不上。
    if (xhsDetail) {
      if (/^m\d+$/.test(it.u || "")) continue;
      const real = it.hint === "xhs-note" || (it.title || "").trim();
      if (!real) continue;
    }
    // ref 也进分组键：Telegram 相册里「视频 + 图片」横排时，两个 <video> 的
    // ref 可能一个 album 一个 viewer，不拆开会把同一格的序号算重
    // 小红书详情页：整页一个帖子，不分 ref、**也不分 kind** —— 视频和图片
    // 共用一个 ①~Ⓝ 序号池，按 DOM 阅读顺序排（正文视频常排在第一张图之前）。
    // 曾按 kind 分组，结果视频和图片各自都有 ①，列表里出现两个 ①，
    // 用户没法判断谁先谁后。
    const gk = xhsDetail
      ? "xhs"
      : it.k + "|" + (it.mid ? "m:" + it.mid : "t:" + (it.title || "")) + "|" + (it.ref || "");
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(it);
  }

  for (const list of groups.values()) {
    list.sort((a, b) => {
      const oa = typeof a.ord === "number" && a.ord >= 0 ? a.ord : 1e6;
      const ob = typeof b.ord === "number" && b.ord >= 0 ? b.ord : 1e6;
      if (oa !== ob) return oa - ob;
      return (a.t || 0) - (b.t || 0);
    });
    // 组里只有一张不加序号，免得满屏都是 ①
    for (let i = 0; i < list.length; i++) {
      list[i].idx = list.length > 1 ? i + 1 : 0;
      list[i].mark = list.length > 1 ? markOf(i + 1) : "";
    }
  }
}

// ---------------------------------------------------------------- 小红书
//
// 用户真机反馈（2026-10-18）：「只有当前帖子的图」已经对了，但**封面那张图会有两张**。
//
// 原因：详情页会把同一张图用不同的尺寸/裁切后缀引用多次（主图位一张、缩略图/预载
// 再一张），URL 不同所以 webRequest 当成两个条目各记一条。它们在列表里并排出现，
// 看起来就是「同一张图重复」。
//
// 图片服务的尺寸参数放在 `!` 之后（实测 `...!nc_n_webp_mw_1`），也可能放在
// query 里，所以「内容身份」= pathname 去掉 `!...` 一段（query 天然不进 pathname）。
// 同一个身份只留体量最大的一条。

/** 是不是小红书（含子域） */
function isXhsHostUrl(u) {
  try { return /(^|\.)xiaohongshu\.com$/i.test(new URL(u).hostname); } catch { return false; }
}

/** 小红书帖子详情页：/explore/{noteId} 或 /discovery/item/{noteId} */
function isXhsDetailUrl(u) {
  try {
    const x = new URL(u);
    return /(^|\.)xiaohongshu\.com$/i.test(x.hostname)
      && /^\/(explore|discovery\/item)\/[0-9a-f]{20,}/i.test(x.pathname);
  } catch { return false; }
}

/**
 * 小红书 CDN 路径里「稳定的那一段」的正则：`<路径类型>/<fileId>`。
 *
 * 一条完整的图 URL 长这样（真实样本）：
 *   https://sns-webpic-qc.xhscdn.com / 202610181600 / 004ef081518e... / spectrum / 1040g34o325dkebtl4a204... / !nd_dft_wgth_webp_3
 *                                    ↑ 时间戳        ↑ 随机 hash       ↑ 路径类型  ↑ fileId（真正的身份证）      ↑ 档位后缀
 *
 * 前三段里**时间戳和 hash 每次请求都会变**（实测同一张图 16:00 抓到的 hash 是
 * `004ef08…`，16:05 变成 `b5b96ec…`），所以拿整条 pathname 当身份永远对不上，
 * 一张图会被记成 3~4 条。只有 `<类型>/<fileId>` 这一段是稳定的。
 */
// XHS_ASSET_PATH 定义在图标判定区（那里也要用），这里不再重复声明。
/** 路径里没有已知类型段时的兜底：直接找 fileId */
const XHS_ASSET_BARE = /(?:^|\/)(1040g[0-9a-z]{20,})(?=$|[!?_])/i;
/** 头像专用来路，fileId 格式和正文图一样但绝不能参与正文去重 */
const XHS_AVATAR_PATH = /\/avatar\//i;

/**
 * 小红书图片的「内容身份」：同一张图的不同档位/不同抓取时刻会得到同一个值。
 *
 * 两条实测出来的规则：
 *   · 档位后缀（`!nc_n_webp_mw_1` 缩略图 / `!nd_dft_wgth_webp_3` 正文大图）不算身份，
 *     否则同一张图的缩略图和大图会被当成两张；
 *   · 时间戳段和 hash 段也不算身份，否则同一张图刷新一次就多一条。
 *
 * 取不到稳定段时返回空串 —— 调用方据此放弃去重，**绝不误删**（最坏退回旧行为）。
 */
function xhsImgIdentity(u) {
  try {
    const p = new URL(u).pathname;
    const m = XHS_ASSET_PATH.exec(p);
    // 带类型段：identity 里也保留类型，免得 `spectrum/X` 和 `comment/X` 撞车
    if (m) return m[1].toLowerCase() + "/" + m[2].toLowerCase();
    // 头像：明确排除。头像 fileId 也是 1040g 开头，靠裸正则会被认成正文图
    if (XHS_AVATAR_PATH.test(p)) return "";
    const bare = XHS_ASSET_BARE.exec(p);
    return bare ? bare[1].toLowerCase() : "";
  } catch { return ""; }
}

/**
 * 同一帖子内按内容身份去重：每组只留「体量最大」的一条。
 *
 * 保守线（宁多留、不误删）：
 *   · 只动 k === "image" 的条目，视频/音频/文档一律不碰
 *   · 只认命中小红书正文大图签名（1040g）的 URL，其它图不参与
 *   · 身份取不到就原样保留
 * @param {Array} items 已经过滤掉 icon 的条目数组
 * @returns {Array} 去重后的新数组
 */
function dedupeXhsNoteImages(items) {
  const best = new Map();      // 身份 -> {score, idx}
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.k !== "image") continue;
    const u = String(it.u || "");
    if (!/1040g/i.test(u)) continue;
    const id = xhsImgIdentity(u);
    if (!id) continue;
    // 优先比字节数（同一张图的大档一定比小档大）；没有 s 就退回像素面积。
    // 两者都没有时给 1，比「纯 0」高一点点，保证同组里至少有一条能被选中，
    // 而不是因为全员 0 分导致 best 里存下第一条之后谁都不替换。
    const score = (it.s | 0) || (((it.w | 0) * (it.h | 0)) | 0) || 1;
    const cur = best.get(id);
    if (!cur || score > cur.score) best.set(id, { score, idx: i });
  }
  if (!best.size) return items;
  // 按「身份」保留，而不是按 URL：同一张图可能有多条完全相同的 URL
  // （webRequest 与 DOM 扫描各记一次），按 URL 比较会把它们都留下。
  const keepIdx = new Set();
  for (const v of best.values()) keepIdx.add(v.idx);
  return items.filter((it, i) => {
    if (it.k !== "image") return true;
    const u = String(it.u || "");
    if (!/1040g/i.test(u)) return true;
    if (!xhsImgIdentity(u)) return true;
    return keepIdx.has(i);
  });
}

/**
 * 小红书详情页：页面既然已经读到了 `__INITIAL_STATE__.note.imageList`（那条最权威的
 * 「这个帖子有哪些图」），就别再从 webRequest 的一堆请求里猜了。
 *
 * 真机证据（2026-10-18 第十一轮，帖子 6ab221bd…）：页面上报了 7 条 `hint === "xhs-note"`
 * 的直读条目（编号 ①~⑦，尺寸/标题/顺序全对），但同一时刻 webRequest 还记着 22 条噪声：
 *   · `svg-sprite.6.57.6.svg#me` —— 站点雪碧图，82KB，骗过了体积线；
 *   · 一堆 `!nc_n_webp_mw_1` 缩略图 —— 信息流里**别的帖子**的封面，fileId 各不相同，
 *     按身份去重根本去不掉；
 *   · 几条无后缀的随机 hex `.png` —— 小红书 UI 素材。
 * 这些在 popup 里被一起编了号，用户看到的就是「②③④…不止 7 张」。
 *
 * 所以：只要页面报过直读条目，就**只保留直读条目**（外加视频/音频，它们不走这条路）。
 * 没报过（老版本注入脚本、页面结构变了、`__INITIAL_STATE__` 没注入）就别动，
 * 原样返回 —— 宁可多几条噪声，也不能让列表整个空掉。
 */
function preferXhsNoteList(items) {
  const direct = items.filter((it) => String(it.hint || "") === "xhs-note");
  if (!direct.length) return items;
  return items.filter((it) => {
    // 直读条目本身
    if (String(it.hint || "") === "xhs-note") return true;
    // 视频/音频不受影响：它们本来就该由 webRequest + 页面 hook 抓
    if (it.k === "video" || it.k === "audio") return true;
    return false;
  });
}

/**
 * 通用图片「内容身份」：host + pathname（去 query、去 hash）。
 *
 * 借鉴 CocoCut 的做法（它用 `repeatReg` 默认 `\?[\S]+` 去掉整条 query string 再比对，
 * `pure(url)` 去掉 `#...`）。很多图片 CDN 用 query 里的签名/时间戳做缓存失效，同一张图
 * 每次请求 query 都不同、pathname 却不变，按完整 URL 记会得到 N 条重复。小红书就是典型，
 * 之前是单独写 xhsImgIdentity 补丁解决的；这里给一个**通用兜底**，别的站点也能受益。
 *
 * 取不到稳定段（坏 URL）返回空串，调用方据此放弃去重，绝不误删。
 */
function identityOf(url) {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase() + u.pathname;
  } catch {
    return "";
  }
}

/**
 * 通用图片去重：同一 host+pathname 的多条（query 签名不同）只留体量最大一条。
 *
 * 保守线（宁多留、不误删）：
 *   · 只动 k === "image"，视频/音频/文档一律不碰；
 *   · 只合并「裸条目」——没有 mid / title / page / hint 的（这些是 webRequest 抓来的
 *     同一 CDN 资源被反复请求，正是要去重的对象）。带 DOM 上下文（mid/title/ord）的图
 *     是页面明确报出的内容项，即使 pathname 相同也不能合并（可能是相册里两张同图）；
 *   · 身份取不到就原样保留；
 *   · 只有出现「同身份 ≥2 条」才真正合并，否则原样返回，避免无谓扰动。
 *
 * 注意：这个兜底只在「非小红书详情页」时用；小红书详情页有更权威的
 * dedupeXhsNoteImages + preferXhsNoteList，不会走到这里。
 */
function dedupeImagesByIdentity(items) {
  const best = new Map(); // 身份 -> {score, idx}
  const seen = new Map(); // 身份 -> 出现次数
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.k !== "image") continue;
    // 只合并裸条目（无页面上下文）
    if (it.mid || (it.title || "").trim() || it.page || it.hint) continue;
    const id = identityOf(it.u);
    if (!id) continue;
    seen.set(id, (seen.get(id) || 0) + 1);
    const score = (it.s | 0) || (((it.w | 0) * (it.h | 0)) | 0) || 1;
    const cur = best.get(id);
    if (!cur || score > cur.score) best.set(id, { score, idx: i });
  }
  // 没有任何「同身份出现多次」的裸图，说明没有 query 签名造成的重复，原样返回
  let hasDup = false;
  for (const n of seen.values()) if (n >= 2) { hasDup = true; break; }
  if (!hasDup) return items;
  const keepIdx = new Set();
  for (const v of best.values()) keepIdx.add(v.idx);
  return items.filter((it, i) => {
    if (it.k !== "image") return true;
    if (it.mid || (it.title || "").trim() || it.page || it.hint) return true;
    if (!identityOf(it.u)) return true;
    return keepIdx.has(i);
  });
}

// ---------------------------------------------------------------- 监听

// onHeadersReceived 已经记录过的 requestId：onResponseStarted 对同一条请求会再触发一次，
// 若也进 record() 会把 hits 翻倍（用户看到 ×2/×3）。用 requestId 去重，让两个监听器
// 各司其职：onHeadersReceived 抓「带完整响应头的」，onResponseStarted 兜底抓「响应头缺失
// 或响应开始时才拿得到」的（CDN 直连 mp4 端点、service worker 命中的缓存响应等）。
const recordedRequestIds = new Set();
function markRecorded(requestId) {
  if (!requestId) return;
  recordedRequestIds.add(requestId);
  // 防无限增长：满了整体清空。最坏后果是清空后极少数请求被重复记录一次（hits 多算 1），
  // 远好过 set 无限膨胀吃内存。
  if (recordedRequestIds.size > 20000) recordedRequestIds.clear();
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!loaded) {
      buffered.push(details);
      if (buffered.length > 2000) buffered.shift();
      return;
    }
    markRecorded(details.requestId);
    record(details);
  },
  { urls: ["http://*/*", "https://*/*"] },
  ["responseHeaders"]
);

// 兜底监听：onHeadersReceived 没覆盖到的（content-type 缺失、短头响应、SW 缓存响应等）
// 在这里补记。requestId 已在 onHeadersReceived 记过就不重复。
chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (!loaded) return;
    if (details.type === "main_frame") return; // 主文档由 onBeforeRequest 管
    if (recordedRequestIds.has(details.requestId)) return;
    markRecorded(details.requestId);
    record(details);
  },
  { urls: ["http://*/*", "https://*/*"] },
  ["responseHeaders"]
);

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // 主文档地址用于展示当前页
    if (details.type !== "main_frame") return;
    if (!loaded) return;
    const rec = ensureTab(details.tabId);
    rec.url = details.url;
    flushSoon(details.tabId);
  },
  { urls: ["http://*/*", "https://*/*"] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  state.delete(tabId);
  badgeTimer.delete(tabId);
  chrome.storage.session.remove("tab:" + tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) {
    // 页面开始导航：清掉上一个页面的记录
    state.set(tabId, { url: info.url, items: new Map(), dirty: false });
    chrome.action.setBadgeText({ tabId, text: "" });
    chrome.storage.session.remove("tab:" + tabId).catch(() => {});
  }
});

// ---------------------------------------------------------------- Native Host

let nativePort = null;
const downloads = new Map(); // id -> {url, status}

function connectNative() {
  if (nativePort) return nativePort;
  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    nativePort = null;
    return null;
  }
  nativePort.onMessage.addListener((msg) => {
    // 页面的二进制请求：按 id 直接回给发起它的那个页面。
    // 注意匹配键必须是 msg.id —— 注册侧（ms-host-bridge 的 onMessage）登记的就是
    // 页面请求里的 id，宿主回执也原样带回同一个 id。早期这里写成 msg.requestId，
    // 而全链路没有任何人会填 requestId，导致真机上 msfile_* 回执永远走不回页面，
    // 表现为「文件建好了，页面却报本地下载器无响应」（HTTP shim 端到端测试
    // 绕过了 background，所以当时没暴露）。
    if (msg && msg.id && bridgeOwner.has(String(msg.id))) {
      const port = bridgeOwner.get(String(msg.id));
      try { port.postMessage(msg); } catch (e) { bridgeOwner.delete(String(msg.id)); }
      if (!msg.inProgress) bridgeOwner.delete(String(msg.id));
      return;
    }
    if (msg && msg.id) {
      clearFileReq(msg.id);
      const job = downloads.get(msg.id) || {};
      Object.assign(job, msg);
      downloads.set(msg.id, job);
    }
    chrome.runtime.sendMessage({ type: "native:progress", msg }).catch(() => {});
  });
  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    nativePort = null;
    chrome.runtime.sendMessage({
      type: "native:disconnected",
      error: err ? err.message : "本地下载器已断开",
    }).catch(() => {});
  });
  return nativePort;
}

function postNative(msg) {
  const port = connectNative();
  if (!port) throw new Error("无法连接本地下载器");
  port.postMessage(msg);
}

// ---------------------------------------------------------------- 页面直连通道（二进制走这里）

/**
 * Telegram 这类站的媒体只能由页面自己（带 Range）抓，数据必须从页面搬到本地下载器。
 * content.js 用 chrome.runtime.connect({name:'ms-host-bridge'}) 连上来，
 * 这里把消息原样转给 Native Host，回复原样转回页面。
 *
 * 为什么不用 chrome.runtime.sendMessage：Native Messaging 的消息是二进制安全
 * （扩展侧可以直接传 Uint8Array），sendMessage 的 JSON 序列化会把二进制变成
 * 普通对象，白白多一层 base64 中转。
 */
const bridgePorts = new Map(); // port -> 是否已转发到宿主

function ensureNativeForBridge(port) {
  const np = connectNative();
  if (!np) return null;
  if (!bridgePorts.has(port)) bridgePorts.set(port, np);
  return np;
}

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== "ms-host-bridge") return;

  port.onMessage.addListener((msg) => {
    const np = ensureNativeForBridge(port);
    if (!np) {
      try { port.postMessage({ id: msg && msg.id, action: "error", ok: false, error: "无法连接本地下载器（是否已运行 install.bat？）" }); } catch (e) { /* 忽略 */ }
      return;
    }
    try {
      np.postMessage(msg);
      // 把这条请求的 id 登记为「属于这个页面」，宿主回来后只发给它
      if (msg && msg.id) bridgeOwner.set(String(msg.id), port);
      watchFileReq(msg, port);
    } catch (e) {
      try { port.postMessage({ id: msg && msg.id, action: "error", ok: false, error: String(e.message || e) }); } catch (err) { /* 忽略 */ }
    }
  });

  port.onDisconnect.addListener(() => {
    bridgePorts.delete(port);
    for (const [id, p] of bridgeOwner) if (p === port) bridgeOwner.delete(id);
  });
});

const bridgeOwner = new Map(); // 页面请求 id -> port（宿主回执按同一个 id 送回）

// 写盘请求（msfile_*）静默失联的排查线索：宿主从来没回过这条 id。
// 只记日志、不改行为——页面侧有 90s 超时 + 3 次重试兜底。
//
// 注意：**绝不能给 msfile_chunk 挂定时器**。
// 每条 chunk 携带 512KB 数据（JSON 后约 1.5MB），而 120s 的 setTimeout 闭包会把
// 整个 msg 一起捕获住。8 个 pump 并发时每秒能进来 20+ 条 chunk，120 秒就是
// 2000+ 条存活消息 —— 累计 1GB 以上常驻内存，service worker 直接 OOM。
// 真机表现：Telegram 8.8MB 文件下到 17%（约 3 段）后彻底不动，
// 连取消都等不到回执（host.log 里是「宿主 120s 未响应 msfile_abort」）。
// 这里只监控低频的 start / end / abort 三条，它们不带数据，挂多久都无所谓。
const fileWatch = new Map(); // 页面请求 id -> timer
const WATCHED_ACTIONS = new Set(["msfile_start", "msfile_end", "msfile_abort"]);
function watchFileReq(msg, port) {
  if (!msg || !msg.id) return;
  const action = String(msg.action || "");
  if (!WATCHED_ACTIONS.has(action)) return;
  const prev = fileWatch.get(String(msg.id));
  if (prev) clearTimeout(prev);
  if (action === "msfile_start") return; // 建立任务本身很快，按 id 监测后续收尾
  fileWatch.set(String(msg.id), setTimeout(() => {
    fileWatch.delete(String(msg.id));
    const alive = port && bridgePorts.has(port);
    hostLog("warn", `宿主 120s 未响应 ${action} ${msg.id}${alive ? "" : "（端口已断）"}`);
  }, 120000));
}
function clearFileReq(id) {
  const t = fileWatch.get(String(id));
  if (t) { clearTimeout(t); fileWatch.delete(String(id)); }
}

/** 排查事件写进宿主 host.log（service worker 的 console 用户看不到） */
function hostLog(kind, text) {
  try {
    postNative({ action: "log", kind, text: String(text).slice(0, 400), id: "log-" + Date.now().toString(36) });
  } catch (e) { /* 宿主没装就算了 */ }
}

async function buildCookieHeader(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (!cookies || !cookies.length) return "";
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

async function getSettings() {
  const s = await chrome.storage.local.get({ concurrency: 16, outdir: "", useCookies: true });
  return s;
}

// ---------------------------------------------------------------- 消息

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 自己发出的广播（进度/断开通知）不处理，直接放行给 popup
  if (msg && (msg.type === "native:progress" || msg.type === "native:disconnected" || msg.type === "ms:saved")) return false;
  (async () => {
    switch (msg && msg.type) {
      case "sniff:get": {
        await loadPromise;
        const rec = state.get(msg.tabId);
        const items = rec ? [...rec.items.values()] : [];
        let tabUrl = rec ? rec.url : "";
        // 小红书是单页应用：从信息流点开帖子常常不触发 main_frame，rec.url 还停在
        // 上一个页面。下面的「封面去重」依赖「当前地址栏」，所以凡小红书标签页都
        // 额外问一次 tabs.get 拿真实 URL（对其它站点不加这个开销）。
        if (!tabUrl || isXhsHostUrl(tabUrl)) {
          try {
            const tab = await chrome.tabs.get(msg.tabId);
            if (tab && tab.url) tabUrl = tab.url;
          } catch { /* 忽略 */ }
        }
        // 把校正后的地址写回 rec：下面的 renumberImages 靠 rec.url 判断「是不是
        // 小红书详情页」（决定要不要按帖子整组编号），用旧地址会判错。
        if (rec && tabUrl && rec.url !== tabUrl) rec.url = tabUrl;
        // 每次取列表前重算一遍：图标判定只依赖 w/h/u，序号只依赖 mid/ord，
        // 都是幂等的，所以条目陆续到达时编号会跟着 DOM 顺序自己修正。
        if (rec) {
          for (const it of items) {
            if (it.k === "image" && looksLikeIcon(it, rec)) it.k = "icon";
            // Telegram 会往页面里塞 UI 小视频（贴纸/占位，100×100 这种），
            // 也不是用户要保存的内容，同样归进图标收起来
            else if (it.k === "video" && it.page && looksLikeIcon(it, rec)) it.k = "icon";
          }
          renumberImages(rec);
        }
        // 用户要求「图标彻底不要」：图标（emoji/头像/UI 素材/贴纸占位等站方自带小图）
        // 不进 popup，直接从返回列表里过滤掉。判定仍在 state 里做（保证图片栏干净），
        // 只是不再发给 popup 显示。
        const visible = items.filter((it) => it.k !== "icon");
        // 小红书详情页：同一张图被页面用不同尺寸/裁切后缀引用多次（封面最容易中招），
        // 按「内容身份」只留体量最大的一条，避免列表里一张图出现两次。
        // 再叠一层「页面直读优先」：imageList 已经给出完整清单时，webRequest 抓到的
        // 缩略图/雪碧图/别的帖子封面全是噪声（详见 preferXhsNoteList 的注释）。
        const shown = isXhsDetailUrl(tabUrl)
          ? preferXhsNoteList(dedupeXhsNoteImages(visible))
          : dedupeImagesByIdentity(visible);
        const counts = {};
        for (const it of shown) counts[it.k] = (counts[it.k] || 0) + 1;
        sendResponse({ ok: true, items: shown, counts, tabUrl, order: KIND_ORDER });
        break;
      }
      case "sniff:clear": {
        const rec = state.get(msg.tabId);
        if (rec) {
          rec.items.clear();
          rec.dirty = true;
          flushSoon(msg.tabId);
        }
        chrome.action.setBadgeText({ tabId: msg.tabId, text: "" });
        sendResponse({ ok: true });
        break;
      }
      case "ms:page": {
        // 来自 content script 的页面内捕获上报
        const p = msg.payload || {};
        const tid = sender.tab && sender.tab.id;
        if (tid == null) { sendResponse({ ok: false }); break; }
        if (p.cmd === "found" || p.cmd === "progress") {
          recordPageMedia(tid, (sender.tab && sender.tab.url) || "", p);
        } else if (p.cmd === "saved") {
          // 页面保存的成败都落进 host.log：失败以前只显示在页面右下角的进度卡里，
          // 用户一关页面就什么证据都不剩，排障无从下手（Telegram 首次真机排查就栽在这）
          if (p.ok === false) {
            hostLog("page-err", `保存失败 key=${String(p.key || "").slice(0, 90)} 错误=${p.error || "未知"}`);
          } else {
            hostLog("page", `保存完成 ${p.filename || ""} ${p.size ? (p.size / 1048576).toFixed(1) + "MB" : ""}`);
          }
          notifySaved(p);
          chrome.runtime.sendMessage({ type: "ms:saved", payload: p }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }
      case "blob:save": {
        try {
          // 只发给主 frame：广播到所有 iframe 会让别的 frame 也去 fetch，
          // 跨域失败后反而把错误结果顶掉（表现为「点了没反应」）
          const payload = { type: "ms:save", key: msg.bid, filename: msg.filename };
          try {
            await chrome.tabs.sendMessage(msg.tabId, payload, { frameId: 0 });
          } catch (e) {
            await chrome.tabs.sendMessage(msg.tabId, payload);
          }
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      }
      case "page:save-batch": {
        // 在主 frame 里弹浮层，让用户手势落在页面按钮上。
        // 关键：保存在页面主世界发起（Range 链抓流 + 直接喂本地下载器），
        // popup 里的点击手势传不到页面，所以按钮必须画在页面上。
        try {
          const list = msg.items || [];
          await chrome.tabs.sendMessage(msg.tabId, { type: "ms:save-batch", items: list }, { frameId: 0 });
          hostLog("page", `save-batch ${list.length} 项 → tab ${msg.tabId}`);
          sendResponse({ ok: true });
        } catch (e) {
          hostLog("error", `save-batch 失败: ${(e && e.message) || e}`);
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      }
      case "native:ping": {
        try {
          postNative({ action: "ping", id: "ping-" + Date.now() });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      }
      case "native:reveal-outdir": {
        try {
          postNative({ action: "reveal", id: "reveal-" + Date.now() });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      }
      case "native:open-log": {
        try {
          postNative({ action: "open-log", id: "openlog-" + Date.now() });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      }
      case "native:download": {
        try {
          const settings = await getSettings();
          const cookie = settings.useCookies ? await buildCookieHeader(msg.url) : "";
          const id = "dl-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
          downloads.set(id, { url: msg.url, status: "starting" });
          postNative({
            action: "download",
            id,
            url: msg.url,
            kind: msg.kind || "other",
            filename: msg.filename || "",
            referer: msg.referer || "",
            tabUrl: msg.tabUrl || "",
            cookie,
            concurrency: settings.concurrency || 16,
            outdir: settings.outdir || "",
          });
          sendResponse({ ok: true, id });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) + "（是否已运行安装脚本？）" });
        }
        break;
      }
      case "native:cancel": {
        try {
          postNative({ action: "cancel", id: msg.id });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      }
      case "settings:get": {
        sendResponse(await getSettings());
        break;
      }
      case "settings:set": {
        await chrome.storage.local.set(msg.patch || {});
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true;
});

// 安装/更新时初始化默认设置
chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(["concurrency"]);
  if (cur.concurrency == null) {
    await chrome.storage.local.set({ concurrency: 16, outdir: "", useCookies: true });
  }
});
