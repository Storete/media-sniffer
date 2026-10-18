/* 资源嗅探 - popup
 *
 * popup 是扩展的唯一 UI。它本身**不抓任何东西**，只做两件事：
 *   1. 向 background 要当前标签页的条目清单（sniff:get），渲染成列表
 *   2. 用户点按钮时，把请求转给 background（本地下载器）或页面（页面浮层保存）
 *
 * 三条数据通路，选哪条决定了条目长什么样：
 *   · webRequest 抓到的直链    → 有 u/s/m，k 是视频/图片/字体等，按大小排序
 *   · 页面主世界注入脚本上报的 → 带 page=1，有 mid（消息号）/title/ref，
 *                                Telegram 这类「只能页面自己取」的站走这条
 *   · B 站合成条目             → u 是哨兵 __bili_dash__，真实流在页面里现取
 *
 * 条目字段速查（background.js 的 recordPageMedia 产出的）：
 *   u      URL，也是唯一 key（B 站合成条目用哨兵）
 *   k      kind：video/audio/image/icon/doc/font/other/seg
 *   s      字节数        m   mime
 *   w h    像素尺寸      dur 时长（秒）
 *   t      首次抓到的时间戳（同 kind 内按此兜底排序）
 *   f      服务器给的文件名（Content-Disposition），可能是空的
 *   page   1 = 页面上下文捕获的（列表里显示「保存」而非「下载」）
 *   mid    页面里的消息 id（Telegram 一条消息可有多图）
 *   ref    页面给的上下文标记：album=相册 / viewer=媒体查看器
 *   ord    页面里的出现序号（决定 ①②③ 的先后）
 *   idx    编好号后的序号（background 按 mid + ref 分组重排的最终结果）
 *   mark   ①②③ 这种圈码前缀，只有分组内多于一条时才编
 *   title  页面里的标题（Telegram 消息正文 / 小红书帖子文字）
 *   live   1 = 还在录制（MSE 流）
 *   hits   同一 URL 被命中过几次
 */

const KIND_LABEL = {
  video: "视频", audio: "音频", image: "图片", icon: "图标",
  doc: "文档", font: "字体", other: "其他", seg: "分片",
};
const KIND_ICON = {
  video: "▶", audio: "♪", image: "▣", icon: "◆", doc: "▤", font: "A", other: "◇", seg: "#",
};

let tabId = null;      // 当前活动标签页 id，所有消息都带着它（background 的 state 按 tabId 分）
let tabUrl = "";       // 当前标签页地址，用来判断站点（B 站、小红书…）
let allItems = [];     // 从 background 拿到的全量条目（未经任何过滤）
let filter = "all";    // 当前选中的分类 chip
let counts = {};       // background 给的各 kind 计数（B 站上会被 shownItems 重算覆盖）
let hostOk = null;     // 本地下载器状态：null=还没结果 / true=可用 / false=不可用

const $ = (sel) => document.querySelector(sel);

/** 「1.5 MB」这种人读的尺寸。0/空返回空串，让调用方用 filter(Boolean) 拼「·」 */
function fmtSize(n) {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + " " + u[i];
}

/** 取 host。blob:/data: 这类地址 new URL 也能成功（host 为空），坏 URL 返回空串 */
function hostOf(url) {
  try { return new URL(url).host; } catch { return ""; }
}

/**
 * B 站（以及有完整 DASH 清单的同类站点）播放器走 MSE，扩展的「录制流」只含
 * 已播放过的那一小段，存下来必然残缺；而页面上同时存在可完整下载的直链条目。
 * 两边一起显示只会让人点错，所以 B 站上把 MSE/blob 录制条目整个隐掉。
 * 隐藏判断放这里，counts / 列表 / 全部保存 共用同一份，避免「计数 2 但列表只有 1」。
 */
function isBiliSite() {
  try {
    const h = new URL(tabUrl).hostname;
    return /(^|\.)bilibili\.com$/i.test(h);
  } catch { return false; }
}

/**
 * B 站首页 / 频道页 / 搜索页这类「推荐流」页面。
 *
 * 这些页面的视频卡片只有封面图 + 悬停时的几秒静音预览，没有完整视频流
 * （`__playinfo__` 只在视频页/番剧播放页才有）。用户在这里看不到视频条目是
 * 正常的，但不知道原因就容易以为扩展坏了——所以给出明确提示，而不是一句
 * 通用的「还没有资源」。
 */
function isBiliFeedPage() {
  if (!isBiliSite()) return false;
  try {
    const p = new URL(tabUrl).pathname || "/";
    // 视频页 /video/BV...、番剧 /bangumi/play/...、直播 /live/... 都是可抓的
    if (/^\/(video|bangumi|live|list\/watch|medialist|cheese)\//i.test(p)) return false;
    // 首页 /、频道 /channel/...、搜索 /search/...、热门/排行 等
    return true;
  } catch { return false; }
}

/** 这一条是不是「只录到已播放片段」的 MSE/blob 条目
 *  blob: 是页面自己 createObjectURL 出来的，m\d+ 是扩展给 MSE 流编的假 URL。 */
function isRecorderItem(it) {
  const u = it.u || "";
  return /^blob:/i.test(u) || /^m\d+$/.test(u);
}

/** 要不要隐藏录制条目。目前只有 B 站需要（它同时提供可完整下载的 DASH 流） */
function hideRecorder() {
  return isBiliSite();
}

/**
 * 过滤后的条目清单 —— 列表、chip 计数、「全部保存」三处都从这里取，保证口径一致。
 *
 * 非 B 站：原样返回（复制一份，避免调用方改到 allItems）。
 * B 站：剔掉 MSE/blob 录制条目，再补一条合成条目。合成条目的条件是有播放器
 * （存在录制条目）——首页那种没有播放器的页面不该冒出「完整 DASH 流」。
 */
function shownItems() {
  const list = hideRecorder() ? allItems.filter((it) => !isRecorderItem(it)) : allItems.slice();
  if (hideRecorder()) {
    // B 站的完整视频不在 <video src> 里，而是 __playinfo__ 的 DASH 流；
    // 隐藏录制条目后必须补一个合成条目，否则列表全空没得点。
    // 点保存 → 页面浮层 → runBiliDownload（它自己读 __playinfo__，不看 key）。
    const hadPlayer = allItems.some((it) => (it.k === "video" || it.k === "audio") && isRecorderItem(it));
    if (hadPlayer && !list.some((it) => it.u === BILI_DASH_KEY)) {
      list.unshift({
        u: BILI_DASH_KEY, k: "video", page: 1,
        title: "B 站视频（完整 DASH 流）",
        s: 0,
      });
    }
  }
  return list;
}
const BILI_DASH_KEY = "__bili_dash__";

/** 造元素的小工具，省掉三行 createElement/setAttribute */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// ---------------------------------------------------------------- 数据

/**
 * 读当前标签页的条目并渲染。
 *
 * tabId 必须由 popup 自己查（chrome.tabs.query）再带给 background：
 * background 的 state 是 Map<tabId, record>，没有「当前标签页」的概念。
 *
 * 两处 tabUrl 可能不一致：popup 拿到的是 query 的 tab.url，background 记的是
 * 最后一次 main_frame 请求的地址。SPA（小红书从信息流点进帖子）不会触发
 * main_frame，所以 background 会把它的 tabUrl 一并发回来纠正 popup。
 */
async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  tabId = tab.id;
  tabUrl = tab.url || "";
  $("#site").textContent = tabUrl || "(当前标签页)";
  $("#site").title = tabUrl;

  const res = await chrome.runtime.sendMessage({ type: "sniff:get", tabId });
  if (!res || !res.ok) {
    $("#list").replaceChildren(el("div", "empty", "读取失败，请重新打开扩展"));
    return;
  }
  allItems = res.items || [];
  counts = res.counts || {};
  if (res.tabUrl && res.tabUrl !== tabUrl) {
    tabUrl = res.tabUrl;
    $("#site").textContent = tabUrl;
  }
  renderChips();
  renderList();
}

// ---------------------------------------------------------------- 渲染

/**
 * 顶部分类 chip。
 *
 * 两处刻意的处理：
 *   · 视频/音频两个 chip 数量为 0 也照显示 —— 它们是主功能，藏起来会让人以为
 *     扩展只会抓图片；其它分类（doc/font/other/seg）为 0 才跳过。
 *   · B 站上 counts 是 background 用全量算的，含被隐掉的录制条目，直接显示会
 *     「chip 写 2、点进去空」，所以这里按 shownItems 重算。
 */
function renderChips() {
  const nav = $("#chips");
  nav.replaceChildren();

  const src = shownItems();
  const totalAll = src.filter((it) => it.k !== "seg").length;
  const defs = [["all", "全部", totalAll]];
  for (const k of ["video", "audio", "image", "doc", "font", "other", "seg"]) {
    let n = counts[k] || 0;
    if (hideRecorder()) {
      // 计数里含被隐掉的录制条目，这里按剩余条目重算，避免「点进去是空的」
      n = src.filter((it) => it.k === k).length;
    }
    // 图标默认不占位置：数量都为 0 才跳过，有就显示（用户要求「分出来」，不是「藏起来」）
    if (!n && k !== "video" && k !== "audio") continue;
    defs.push([k, KIND_LABEL[k], n]);
  }

  for (const [key, label, n] of defs) {
    const c = el("button", "chip" + (filter === key ? " active" : ""));
    c.append(document.createTextNode(label));
    const b = el("b", null, String(n));
    c.append(b);
    c.addEventListener("click", () => { filter = key; renderChips(); renderList(); });
    nav.append(c);
  }
}

/**
 * 按当前 filter 过滤 + 排序。
 *
 * 排序三级：
 *   1. kind 优先级（视频→音频→文档→图片→字体→其他→分片），视频排最前
 *   2. 同一 mid 且都编了号的，按 idx 升序 —— 否则按大小排会把 ①②③ 打乱
 *   3. 大小降序，再按抓到时间降序兜底
 */
function visibleItems() {
  let list = shownItems();
  if (filter === "all") list = list.filter((it) => it.k !== "seg");
  else list = list.filter((it) => it.k === filter);

  const order = ["video", "audio", "doc", "image", "font", "other", "seg"];
  return list.slice().sort((a, b) => {
    const ka = order.indexOf(a.k), kb = order.indexOf(b.k);
    if (ka !== kb) return ka - kb;
    // 同一组里编了 ①②③ 的条目，按序号从上到下排（用户要求 m03360），
    // 否则默认按大小排，序号会乱掉看不出顺序。
    //
    // 判据不能只看 mid：小红书的正文图没有消息号（mid 为空），编号是
    // background 按「整帖一组」编的（见 renumberImages 的 xhsDetail 分支），
    // 只认 mid 会让这些图退回按大小排，列表里出现 ②⑦①⑥③④⑤ 这种乱序。
    // 两条都编过号、且同属一组（mid 相同，或两个都没 mid）就按 idx 排。
    const ma = a.mid || "", mb = b.mid || "";
    if (ma === mb && (a.idx || 0) && (b.idx || 0)) return a.idx - b.idx;
    if ((b.s || 0) !== (a.s || 0)) return (b.s || 0) - (a.s || 0);
    return (b.t || 0) - (a.t || 0);
  });
}

/**
 * 渲染列表。空列表时给三种不同的提示 —— 「什么都没有」这句废话解决不了问题，
 * 用户需要知道「为什么空」以及「下一步该做什么」。
 */
function renderList() {
  const box = $("#list");
  const items = visibleItems();
  box.replaceChildren();

  if (!items.length) {
    let tip;
    if (filter === "seg") {
      tip = "还没有捕获到分片。HLS 分片通常只有视频流才会大量出现。";
    } else if (isBiliFeedPage()) {
      // 首页/频道/搜索页没有完整视频流，明确告诉用户该去哪儿，别让人以为坏了
      tip = "这里是 B 站的推荐流页面（首页/频道/搜索），<b>没有完整视频流</b>。<br>"
        + "封面图和悬停预览只是缩略图，无法下载完整视频。<br>"
        + "<b>点进任意一个视频</b>后，再打开本扩展就能看到「B 站视频（完整 DASH 流）」。";
    } else {
      tip = "还没有资源。<br>刚打开扩展或刚安装时，<b>点右上角 ⟳ 重新载入页面</b>，才能捕获完整的请求列表。";
    }
    const d = el("div", "empty");
    d.innerHTML = tip;
    box.append(d);
    return;
  }

  for (const it of items) {
    box.append(renderItem(it));
  }
}

/**
 * 渲染一行。
 *
 * 两条完全不同的分支，取决于 it.page：
 *   · 页面捕获的（page=1）→ 只能「保存」，数据由页面自己取。这里**不要**加
 *     yt-dlp 入口：Telegram 的 /progressive/document… 是相对地址，yt-dlp 会
 *     把它当网页爬然后报 302。
 *   · webRequest 抓到的直链 → 复制 / 打开 / 预览 / 下载（走本地下载器）。
 */
function renderItem(it) {
  const row = el("div", "item");
  const isPage = !!it.page;

  const badge = el("div", "badge " + it.k, KIND_ICON[it.k] || "?");
  badge.title = (isPage ? "页面内捕获 · " : "") + (KIND_LABEL[it.k] || it.k);
  row.append(badge);

  const meta = el("div", "meta");
  const name = el("div", "name", displayName(it, isPage));
  // 悬停给完整信息：m 只是 mime（image/jpeg），看不出是哪个文件，附上 URL 才有用
  name.title = isPage
    ? [it.m || "页面内捕获", it.u || ""].filter(Boolean).join("\n")
    : it.u;
  if (isPage && it.title) name.classList.add("page-title");
  if (it.mark) name.classList.add("has-mark");
  meta.append(name);

  const bits = [];
  if (isPage) {
    if (it.mid) bits.push("消息 " + it.mid);
    else bits.push("页面捕获");
    if (!it.mid && hostOf(it.i)) bits.push(hostOf(it.i));
    // Telegram 相册里一条消息常常是「图片 + 视频」横排，两个视频都挂在同一个
    // message-content 下，光看「消息 8928 · video/mp4」完全分不清是哪个。
    // 页面那边已经能认出 album 了，这里把它显示出来。
    if (it.ref === "album") bits.push("相册");
    else if (it.ref === "viewer") bits.push("查看器");
    if (it.live) bits.push("录制中");
    if (it.state === "fetching") bits.push("抓取中…");
    if (it.w && it.h) bits.push(it.w + "×" + it.h);
    const d = fmtDur(it.dur);
    if (d) bits.push(d);
  } else {
    bits.push(hostOf(it.u));
  }
  if (it.m) bits.push(it.m);
  if (it.s) bits.push(fmtSize(it.s));
  if (it.hits > 1) bits.push("×" + it.hits);
  // Telegram 的尺寸只存在 Content-Range 里，页面不加载媒体就永远读不到，
  // 条目标一个「大小未知」比不显示诚实
  if (isPage && !it.s) bits.push("大小未知");
  const sub = el("div", "sub", bits.filter(Boolean).join(" · "));
  meta.append(sub);
  row.append(meta);

  const ops = el("div", "ops");

  if (isPage) {
    const save = el("button", "btn primary", "保存");
    save.title = "在页面里弹出保存面板（数据由页面自己取，能避开 Telegram 的 512KB 限制）";
    save.addEventListener("click", () => savePageItem(it, save));
    ops.append(save);

    // 预览：只对「有直接 http(s) 地址的图片/视频」给。
    // 页面捕获条目里，图片和视频绝大多数是实打实的 CDN 直链（小红书的
    // sns-webpic / Telegram 的 /progressive/…），popup 直接 <img src>/<video src>
    // 就能显示，不需要页面配合——用户反馈「带标题的每行只有一个按钮」正是缺这个。
    //
    // 为什么不给 blob:/MSE：那两类地址只在本页主世界有效，扩展页加载不了；
    // 点了必然报错，比没有按钮更让人困惑。
    if (["image", "video", "audio"].includes(it.k) && /^https?:/i.test(it.u || "")) {
      const pv = el("button", "btn", "预览");
      pv.addEventListener("click", () => showPreview(it));
      ops.append(pv);
    }

    // 注意：不要在这里给页面媒体加「本地下载器（yt-dlp）」入口。
    // Telegram 的 /progressive/document… 是相对地址，yt-dlp 会把
    // "document6208…" 当成网页去爬，直接报 HTTP 302；而且这类媒体只认
    // 页面上下文的带 Range 请求，交给外部进程本来就下不动。
    row.append(ops);
    return row;
  }

  const copy = el("button", "btn", "复制");
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(it.u); copy.textContent = "已复制"; }
    catch { copy.textContent = "失败"; }
    setTimeout(() => (copy.textContent = "复制"), 1200);
  });
  ops.append(copy);

  const open = el("button", "btn", "打开");
  open.addEventListener("click", () => chrome.tabs.create({ url: it.u }));
  ops.append(open);

  if (["image", "video", "audio"].includes(it.k)) {
    const pv = el("button", "btn", "预览");
    pv.addEventListener("click", () => showPreview(it));
    ops.append(pv);
  }

  const dl = el("button", "btn primary", "下载");
  dl.addEventListener("click", () => startDownload(it, dl));
  ops.append(dl);

  row.append(ops);
  return row;
}

/** 秒 → 「1:23」或「1:02:03」。0/空返回空串 */
function fmtDur(sec) {
  sec = Math.round(Number(sec) || 0);
  if (!sec) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * 页面捕获条目没有标题时的兜底名。
 * 有 w/h 就用尺寸 + 时长当名字（`video_1920x1080_30s`），比空着强。
 */
function pageTitle(it) {
  if (it.title) return it.title;
  const m = (it.m || "").toLowerCase();
  const label = m.startsWith("audio/") ? "页面音频"
    : m.startsWith("image/") ? "页面图片" : "页面视频";
  const dim = it.w && it.h ? ` ${it.w}×${it.h}` : "";
  return label + dim + (it.live ? "（录制中）" : "");
}

/**
 * 列表里显示的名字。
 *
 * 规则（用户要求 m02988 / m03012）：
 * - 图片/视频优先用页面里的标题（Telegram 消息正文），拿不到标题才退回默认名
 * - 同一条消息里有多张图/多个视频时，前面加 ①②③（序号由 background 编）
 * - 图标（emoji、头像、UI 小图）大多没有标题，就用默认名，不硬凑
 */
function displayName(it, isPage) {
  let base;
  if (isPage) base = pageTitle(it);
  else if (it.title) base = it.title;
  else base = it.f || it.u || "";
  base = shortTitle(base);
  if (it.mark) return it.mark + " " + base;
  return base;
}

/**
 * popup 里能直接用来当文件名的那一截标题。
 *
 * 页面传来的 title 可能是一整段帖子正文（Telegram 的消息文字，实测 84 个字符），
 * 直接交给页面浮层会把整句话当文件名存下来。这里按 60 个字符收一下。
 * 主世界那边的 finishName 还会再收一次——两边都要，因为「全部保存」「页面浮层
 * 里改名」这几条路径都不一定经过 finishName。
 */
function shortTitle(t) {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  if (s.length <= 60) return s;
  // 截断前先把扩展名摘出来：否则「…（完整版）.mp4」这种标题截到 60 字后
  // 扩展名被砍掉，列表里名字看着对，存下来却成了无扩展名文件。
  const m = /\.([a-z0-9]{2,5})$/i.exec(s);
  const ext = m ? "." + m[1] : "";
  const body = (ext ? s.slice(0, s.length - ext.length) : s).slice(0, 60)
    .replace(/[\s_\-·,，、]+$/, "") + "…";
  return body + ext;
}

/**
 * 交给页面浮层的文件名（不是列表显示名）。
 *
 * blob:/MSE 条目——页面没有服务器给的文件名，只能用尺寸+时长拼；
 * 其余——用 title 收一下。B 站合成条目在 pageSaveItem 里单独处理，
 * 它必须传**未截断**的原始标题。
 *
 * 返回空串时由页面侧 fileNameTitle/safeFileName 兜底。
 */
function pageSaveName(it) {
  if (it.title) return shortTitle(it.title);
  if (it.w && it.h) return `video_${it.w}x${it.h}` + (it.dur ? `_${Math.round(it.dur)}s` : "");
  return "";
}

/**
 * 「保存」按钮：把这一条丢给页面，让页面弹浮层。
 *
 * 为什么不让 popup 自己下：Telegram 的媒体只认页面上下文的带 Range 请求，
 * 外部进程（yt-dlp / 本地宿主）拿不到 Cookie，也拼不出相对路径。
 *
 * 按钮文案走「…」→「去页面点」→ 2.5 秒后复位，因为真正的下载在页面里，
 * popup 这边结束得很快，不复位会让人以为按钮坏了。
 */
async function savePageItem(it, btn) {
  btn.disabled = true;
  btn.textContent = "…";
  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: "page:save-batch",
      tabId,
      items: [pageSaveItem(it)],
    });
  } catch (e) {
    // 页面没有注入 content script（内部页、扩展页、或刚安装还没刷新）时
    // sendMessage 会直接抛 "Could not establish connection"，这里兜住，
    // 否则按钮会一直停在「…」。
    res = { ok: false, error: "页面未连接（请刷新页面再试）" };
  }
  if (res && res.ok) {
    btn.textContent = "去页面点";
    $("#hint").textContent = "已在页面右下角弹出保存面板，请点「保存到本地」";
    setTimeout(() => ($("#hint").textContent = ""), 5000);
  } else {
    btn.textContent = "失败";
    btn.title = (res && res.error) || "页面未响应，请刷新页面后再试";
  }
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = "保存";
  }, 2500);
}

/**
 * 把一条页面捕获项转成页面浮层需要的载荷。
 * Telegram 的媒体只能由页面自己（带 Range、过一次 512KB 上限）取，
 * 所以真正的下载在页面主世界里跑，popup 只负责把清单递过去。
 */
function pageSaveItem(it) {
  // B 站合成条目：key 是哨兵，真正的流由页面里 runBiliDownload 从 __playinfo__ 取。
  // name 传**原始标题**，不在这里截断：截断/清洗统一由页面侧 beginSaveBatch
  // （fileNameTitle + safeFileName）做一次，两处各截一遍容易出现
  // 「列表 60 字、文件名 55 字 + …」这种对不上的情况。
  // 曾写死成 "bilibili"：列表看得到标题，一到保存浮层和最终文件名就变成 bilibili.mp4。
  if (it.u === BILI_DASH_KEY) {
    return { key: BILI_DASH_KEY, name: it.title || "", sub: "完整 DASH 流（音视频分开）", mid: "", ref: "" };
  }
  const isBlob = /^blob:/i.test(it.u || "");
  const isMse = /^m\d+$/.test(it.u || "");
  const name = isBlob || isMse ? pageSaveName(it) : shortTitle(it.title || it.f || "");
  const sub = [];
  if (it.w && it.h) sub.push(it.w + "×" + it.h);
  const d = fmtDur(it.dur);
  if (d) sub.push(d);
  if (it.s) sub.push(fmtSize(it.s));
  if (it.mid) sub.push("消息 " + it.mid);
  if (isBlob) sub.push("Blob");
  if (isMse) sub.push("MSE 录制流");
  if (!isBlob && !isMse) sub.push("分段抓取");
  return {
    key: it.u,
    name,
    sub: sub.join(" · "),
    mid: it.mid || "",
    ref: it.ref || "",
  };
}

/** 「全部保存」：把所有页面捕获的视频/音频一次性丢给页面浮层 */
async function saveAllPageItems(btn) {
  const items = shownItems().filter((it) => it.page && (it.k === "video" || it.k === "audio"));
  if (!items.length) return;
  btn.disabled = true;
  btn.textContent = "…";
  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: "page:save-batch",
      tabId,
      items: items.map(pageSaveItem),
    });
  } catch (e) {
    res = { ok: false, error: "页面未连接（请刷新页面再试）" };
  }
  btn.disabled = false;
  btn.textContent = "全部保存";
  if (!res || !res.ok) {
    $("#hint").textContent = "下发失败：" + ((res && res.error) || "页面无响应");
    return;
  }
  $("#hint").textContent = `已在页面弹出 ${items.length} 项，请逐项确认`;
  setTimeout(() => ($("#hint").textContent = ""), 5000);
}

// ---------------------------------------------------------------- 下载

/**
 * 「下载」按钮：交给本地下载器（native host → downloader.py）。
 *
 * referer 用 it.i（抓取时的发起页）而不是当前 tabUrl：图片/CDN 常校验来源，
 * 用当前页地址会 403。it.i 空时退回 tabUrl。
 */
async function startDownload(it, btn) {
  btn.disabled = true;
  btn.textContent = "…";
  const res = await chrome.runtime.sendMessage({
    type: "native:download",
    url: it.u,
    kind: it.k,
    filename: it.f,
    referer: it.i || tabUrl,
    tabUrl,
  });
  if (!res || !res.ok) {
    btn.disabled = false;
    btn.textContent = "下载";
    setHost(false, res ? res.error : "本地下载器不可用");
    return;
  }
  addJob(res.id, it.f || it.u);
  btn.textContent = "已提交";
  setTimeout(() => { btn.disabled = false; btn.textContent = "下载"; }, 2500);
}

// 进度条容器：jobId → DOM 引用。native host 那边是独立进程，进度靠
// 它写状态文件 + background 轮询 + native:progress 消息送回来。
const jobEls = new Map();

/** 提交成功后立刻插一条「准备中…」的进度条，等 background 推真实进度来更新 */
function addJob(id, name) {
  const wrap = el("div", "job");
  const label = el("div", null, "准备中… " + (name || ""));
  const bar = el("div", "bar");
  const fill = el("i");
  bar.append(fill);
  wrap.append(label, bar);
  wrap.dataset.id = id;
  $("#jobs").append(wrap);
  jobEls.set(id, { wrap, label, fill, name });
}

/**
 * 按 background 推来的 native:progress 更新进度条。
 *
 * 消息有两种形状（历史原因）：带 action 的（pong/done/error）和带 status 的
 * （downloading/done/error），两种都认，避免漏更新。
 */
function updateJob(msg) {
  const job = jobEls.get(msg.id);
  if (!job) return;
  if (msg.action === "progress" || msg.status === "downloading") {
    const pct = Number(msg.percent || 0);
    job.fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
    const bits = [msg.percent ? pct.toFixed(1) + "%" : "下载中"];
    if (msg.speed) bits.push(msg.speed);
    if (msg.eta) bits.push("剩余 " + msg.eta);
    job.label.textContent = job.name + " · " + bits.join(" · ");
  } else if (msg.status === "done" || msg.action === "done") {
    job.fill.style.width = "100%";
    job.wrap.classList.add("done");
    job.label.textContent = "完成 · " + (msg.file || job.name);
  } else if (msg.status === "error" || msg.action === "error") {
    job.wrap.classList.add("err");
    job.label.textContent = "失败 · " + (msg.message || "未知错误");
  }
}

// ---------------------------------------------------------------- 预览

/**
 * 预览模态框。用 <img>/<video>/<audio> 直接指向 it.u —— 浏览器会带上当前
 * 会话的 Cookie，所以对多数站点能直接播；个别站点校验 Referer 会加载失败，
 * error 事件里给一句说明，而不是干瞪眼。
 */
function showPreview(it) {
  // 复用 <video> 元素展示图片时它会报成视频（见 background 的 ctxBlobImg 注释），
  // 这里按 k 严格建对应标签，不要偷懒
  const body = $("#previewBody");
  body.replaceChildren();
  let node;
  if (it.k === "image") {
    node = document.createElement("img");
  } else if (it.k === "video") {
    node = document.createElement("video");
    node.controls = true;
    node.autoplay = true;
  } else {
    node = document.createElement("audio");
    node.controls = true;
    node.autoplay = true;
  }
  node.src = it.u;
  node.addEventListener("error", () => {
    const tip = el("div", "pv-meta", "预览加载失败（可能需要 Referer/Cookie，或该资源已失效）");
    body.replaceChildren(tip);
  });
  body.append(node);
  body.append(el("div", "pv-meta", it.f || it.u));
  $("#preview").classList.remove("hidden");
}

/**
 * 关预览。必须先 pause + removeAttribute("src") + load()：
 * 直接 replaceChildren 会把视频从 DOM 摘掉但**继续在后台解码播放**，
 * 关掉弹窗后声音还在响（踩过）。
 */
function closePreview() {
  const body = $("#previewBody");
  const v = body.querySelector("video, audio");
  if (v) {
    v.pause();
    v.removeAttribute("src");
    v.load();
  }
  body.replaceChildren();
  $("#preview").classList.add("hidden");
}

// ---------------------------------------------------------------- 本地下载器状态

/**
 * 本地下载器状态灯。
 *
 * ok 传 null 表示「检测中」——此时 setHost 不会把它置成 false，等 2 秒
 * 还没有 pong 才由 pingHost 判为无响应（见下面的 setTimeout）。
 */
function setHost(ok, text) {
  hostOk = ok;
  const pill = $("#hostState");
  pill.className = "pill " + (ok ? "ok" : "err");
  pill.textContent = ok ? (text || "本地下载器已连接") : (text || "本地下载器未连接");
  pill.title = ok ? "" : "请先运行 media-sniffer/native-host/install.bat 安装本地组件";
}

/**
 * 检测本地宿主是否在线。发 native:ping，宿主回 pong（带 yt-dlp/ffmpeg 路径）。
 *
 * 这里不 await 等结果：宿主首次拉起要几百毫秒，等了会让弹窗白屏一下。
 * 改成「先显示检测中，2 秒内收到 pong 就由 onMessage 更新，否则判无响应」。
 */
async function pingHost() {
  setHost(null, "检测本地下载器…");
  const res = await chrome.runtime.sendMessage({ type: "native:ping" });
  if (!res || !res.ok) {
    setHost(false, "未安装本地下载器");
    return;
  }
  setTimeout(() => {
    if (hostOk === null) setHost(false, "本地下载器无响应");
  }, 2000);
}

// ---------------------------------------------------------------- 事件

// ⟳ 重新载入：改完代码、或首次打开扩展时需要重载页面，注入脚本才会重新跑。
// 延迟 900ms 再 load()，给页面留出开始发请求的时间。
$("#reload").addEventListener("click", async () => {
  if (tabId != null) {
    await chrome.tabs.reload(tabId);
    setTimeout(() => { load(); }, 900);
  }
});

$("#saveAll").addEventListener("click", (e) => saveAllPageItems(e.currentTarget));

// 打开文件存放处：目录由本地宿主决定（默认 D:/软件应用/DSH/文件存放处），
// popup 里不硬编码路径，免得两边不一致。
$("#openOut").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "native:reveal-outdir" });
  if (res && res.ok) {
    $("#hint").textContent = "已打开 " + (res.dir || "文件存放处");
  } else {
    $("#hint").textContent = "打不开目录：" + ((res && res.error) || "本地宿主无响应");
  }
  setTimeout(() => ($("#hint").textContent = ""), 4000);
});

$("#openLog").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "native:open-log" });
  if (res && res.ok) {
    $("#hint").textContent = "已打开日志";
  } else {
    $("#hint").textContent = "打不开日志：" + ((res && res.error) || "本地宿主无响应");
  }
  setTimeout(() => ($("#hint").textContent = ""), 4000);
});

$("#clear").addEventListener("click", async () => {  if (tabId == null) return;
  await chrome.runtime.sendMessage({ type: "sniff:clear", tabId });
  allItems = [];
  counts = {};
  renderChips();
  renderList();
});

$("#concurrency").addEventListener("change", (e) => {
  let v = Number(e.target.value) || 16;
  v = Math.max(1, Math.min(64, v));
  e.target.value = v;
  chrome.runtime.sendMessage({ type: "settings:set", patch: { concurrency: v } });
  $("#hint").textContent = "并发已设为 " + v;
  setTimeout(() => ($("#hint").textContent = ""), 1500);
});

$("#previewClose").addEventListener("click", closePreview);
$("#preview").addEventListener("click", (e) => {
  if (e.target.id === "preview") closePreview();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePreview();
});

/**
 * background 推来的消息总入口。四种：
 *   native:progress      下载进度 / pong（宿主在线宣告）
 *   native:disconnected  宿主断了（Chrome 关掉宿主进程时会发）
 *   ms:saved             页面保存完成（页面主世界 → background → 这里）
 */
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "native:progress") {
    const m = msg.msg || {};
    if (m.action === "pong") {
      const parts = [];
      parts.push(m.ytdlp ? "下载器就绪" : "缺 yt-dlp");
      if (!m.ffmpeg) parts.push("无 ffmpeg");
      setHost(!!m.ytdlp, parts.join(" · "));
      $("#hostState").title = `yt-dlp: ${m.ytdlp || "未找到"}\nffmpeg: ${m.ffmpeg || "未找到"}\n存放处: ${m.outdir || "默认"}`;
      return;
    }
    updateJob(m);
  } else if (msg.type === "native:disconnected") {
    setHost(false, "本地下载器已断开");
  } else if (msg.type === "ms:saved") {
    const p = msg.payload || {};
    if (p.ok) {
      const parts = ["已保存：" + (p.filename || "")];
      if (p.size) parts.push(fmtSize(p.size));
      if (p.format && p.format !== "未知") parts.push(p.format);
      if (p.experimental) parts.push("流式拼接，可能不完整");
      $("#hint").textContent = parts.join(" · ");
      setTimeout(() => ($("#hint").textContent = ""), 6000);
    } else {
      $("#hint").textContent = "保存失败：" + (p.error || "Blob 已释放");
    }
  }
});

// ---------------------------------------------------------------- 启动

(async function init() {
  chrome.runtime.sendMessage({ type: "settings:get" }).then((s) => {
    if (s && s.concurrency) $("#concurrency").value = s.concurrency;
  }).catch(() => {});
  await load();
  pingHost();
})();
