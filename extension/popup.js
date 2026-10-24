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
let lastDiag = null;   // background 给的抓取诊断（{seen, drop:{原因:次数}, sample:{原因:[url]}}）
let focusInfo = null;  // 列表被「当前打开的那一条」收窄时，background 回传 {kind,id}；否则 null
let selecting = false; // 批量选择模式
const picked = new Set(); // 已选条目的 key（就是 it.u）
// 用户选的清晰度：key 是主清单的 it.u，value 是那一档子清单的**绝对地址**。
// 只活在这次打开 popup 期间 —— 写进 storage 会变成跨会话的隐藏状态，
// 下次打开少了几档会解释不清（同 moviePick 的取舍）。
const variantPick = new Map();
// B27：按条目记用户填的时间段（「1:30-2:45」），点下载时随 native:download 透传。
// 合法性在宿主 parse_time_range 再把一道——这里只做「填了就带」。
const timeRangePick = new Map();
// 同片折叠时用户点过「切换」的选择：groupKey → url。
// 只活在 popup 这次打开期间 —— 它是一次「我现在想看哪条」的即时偏好，
// 存进 storage 就变成跨会话的隐性状态，下次打开为什么少一条说不清。
const moviePick = new Map();
let blockedHosts = []; // 用户屏蔽的站点（hostname）

const $ = (sel) => document.querySelector(sel);

/** 只取 hostname（不带端口），屏蔽名单用它做 key */
function siteOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

async function readBlocked() {
  try {
    const s = await chrome.storage.local.get({ blockedHosts: [] });
    return Array.isArray(s.blockedHosts) ? s.blockedHosts.filter(Boolean) : [];
  } catch { return []; }
}

function siteBlocked() {
  const h = siteOf(tabUrl);
  return !!h && blockedHosts.includes(h);
}

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

/** 小红书详情页。只比 hostname —— 信息流页没有「当前帖子」，不该走详情页那套。 */
function isXhsDetailPage() {
  try {
    const h = new URL(tabUrl).hostname;
    return /(^|\.)xiaohongshu\.com$/i.test(h) && /^\/(explore|discovery\/item)\/[0-9a-f]{20,}/i.test(new URL(tabUrl).pathname);
  } catch { return false; }
}

/** 这一条是不是「只录到已播放片段」的 MSE/blob 条目
 *  blob: 是页面自己 createObjectURL 出来的，m\d+ 是扩展给 MSE 流编的假 URL。 */
function isRecorderItem(it) {
  const u = it.u || "";
  return /^blob:/i.test(u) || /^m\d+$/.test(u);
}

/** 要不要隐藏录制条目。
 *  B 站：播放器走 MSE，同时提供可完整下载的 DASH 流 → 隐掉录制条目。
 *  小红书（2026-10-18）：正文视频的 <video src> 同样是 blob:，而真实 mp4 地址
 *  已由页面侧从 __INITIAL_STATE__ 换成直链上报；录制条目留着只会和它并列成
 *  两条「页面视频（录制中）」，用户点了存下来是坏的。
 *  HLS 站（2026-10-21）：artplayer/hls.js 一边请求 m3u8 一边往 MSE 塞分片，
 *  于是同一条视频在列表里出现三份（m3u8 清单、blob: 录制、m1/m2 分片）。
 *  **必须先确认页面上真有 m3u8 才隐**——只认 blob/mN 的站（有 MSE 没有清单）
 *  一旦也隐掉，用户就什么都看不到了。 */
function hideRecorder() {
  return isBiliSite() || isXhsDetailPage() || allItems.some(isHlsItem);
}

/** 这一页有没有「能完整下载」的真实视频/音频：http(s) 地址 + 已知体积。
 *
 *  0 字节的不算 —— 红果短剧会留下一条 `…/360p.mp4` 的空壳（webRequest 抓到
 *  请求头但没等到 content-length），拿它当「替代品」会把真能下的那条也挤掉。 */
function hasCompleteMedia(list) {
  return (list || []).some((it) => (it.k === "video" || it.k === "audio")
    && /^https?:/i.test(String(it.u || "")) && (it.s || 0) > 0);
}

/** 有真实直链时，把 blob: 条目从列表里去掉。
 *
 *  blob: 是页面 createObjectURL 出来的内部地址，宿主读不到，最多只能录到
 *  「已播放的部分」。同一条视频既有 blob 又有直链时，两条并排显示，用户点
 *  blob 那条必然失败（红果 4 条视频里 3 条是这种）。
 *
 *  **只在真有替代时删**：Telegram 这类「本来就只有 blob」的站整站如此，
 *  删了列表会空（hideRecorder 的注释记的是同一件事）。
 *  **只删 blob:，不删 m\\d+**：m\\d+ 是扩展 appendBuffer 录到的真数据，宿主能
 *  落盘，是腾讯正片唯一可行的路径。 */
function dropBlobItems(list) {
  const src = list || [];
  if (!hasCompleteMedia(src)) return src.slice();
  return src.filter((it) => !/^blob:/i.test(String(it.u || "")));
}

/**
 * 过滤后的条目清单 —— 列表、chip 计数、「全部保存」三处都从这里取，保证口径一致。
 *
 * 非 B 站：原样返回（复制一份，避免调用方改到 allItems）。
 * B 站：剔掉 MSE/blob 录制条目，再补一条合成条目。合成条目的条件是有播放器
 * （存在录制条目）——首页那种没有播放器的页面不该冒出「完整 DASH 流」。
 */
function shownItems() {
  // 小红书也会 hideRecorder（正文视频是 blob，靠真实 mp4 条目代替），但那边
  // **没有** __playinfo__，绝不能补 B 站那条合成条目。条件必须分开判：
  // 曾写成 `if (hideRecorder())` 直接补，结果小红书页列表顶部多出一条
  // 「B 站视频（完整 DASH 流）」，点了当然什么也下不下来。
  const hide = hideRecorder();
  let list = hide ? allItems.filter((it) => !isRecorderItem(it)) : allItems.slice();
  // 有真实直链时 blob 条目是纯噪声（红果/腾讯实测，见 dropBlobItems 注释）。
  // 放在站点特判之前：B 站的合成条目要等下面才 unshift，不能被这里看见。
  list = dropBlobItems(list);
  if (isXhsDetailPage()) {
    // 小红书详情页还有一类噪声：页面播放器拉的 m4a 音轨 / m3u8 分片被 webRequest
    // 单独记下来，既没有标题也不是 page 条目，混在「音频」栏里就是一条
    // 叫 `01ead…_m4a` 的裸链接（用户截图里第 ② 条）。
    // 正文的图/视频都有 title（页面侧从 __INITIAL_STATE__ 读出的帖子文案），
    // 所以这里只留「有标题的」和 page 条目，其余都是播放器内部请求。
    list = list.filter((it) => it.page || (it.title || "").trim());
  }
  if (isBiliSite()) {
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
  lastDiag = res.diag || null;
  focusInfo = res.focus || null;
  if (res.tabUrl && res.tabUrl !== tabUrl) {
    tabUrl = res.tabUrl;
    $("#site").textContent = tabUrl;
  }
  // 屏蔽名单可能在别的标签页改过，每次打开都读一遍
  blockedHosts = await readBlocked();
  syncBlockBtn();
  // 选择状态跟着列表走：已消失的条目不该继续占着「已选」
  const alive = new Set(shownItems().map((it) => it.u));
  for (const k of [...picked]) if (!alive.has(k)) picked.delete(k);

  renderChips();
  renderFocusBar();
  if (siteBlocked()) renderBlocked();
  else renderList();
  updateBatchBar();

  // 「扩展重载后页面没刷新」的提示：content.js 发现 context invalidated 时会往
  // 页面 post 一条 __ms_sniffer_stale，这里顺手问一句页面脚本还在不在。
  // 不弹窗、不拦路，只把话说清楚，省得用户以为功能坏了。
  pingPageScript();
}

/**
 * 检查当前页的内容脚本是否还活着。
 *
 * 为什么需要这个：inject-main.js 是**页面注入脚本**，重载扩展不会重新注入
 * 已打开的页面。用户重载后不刷新，页面里跑的还是旧脚本（甚至已失效），
 * 列表看起来"什么都没抓到"，但代码本身没问题。后台没法替用户刷新，
 * 只能在这里明确提示一句。
 */
async function pingPageScript() {
  if (tabId == null) return;
  // 内容脚本只注入 http/https 页；chrome://、商店页、PDF 查看器从来没有过
  // 脚本，ping 失败不能说「已失效」（那是误诊），这类页面干脆不问（d-018）。
  if (!/^https?:/i.test(tabUrl || "")) return;
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "ms:ping" }, { frameId: 0 });
    if (pong && pong.ok) return;  // 活着，什么都不说
  } catch (e) {
    // 连接失败 = 内容脚本没了（扩展刚装页面没刷新 / 扩展刚重载脚本被孤儿化）
  }
  // 文案要同时盖住两种成因：刚装（老页面没注入）和刚更新（脚本连不上扩展）
  const staleText = "本页没有嗅探脚本（扩展刚装/刚更新过），点右上角 ⟳ 重新载入页面";
  $("#hint").textContent = staleText;
  // 只清自己写的那句话：8 秒里用户可能点了别的按钮换了提示，不能一起抹掉
  setTimeout(() => { if ($("#hint").textContent === staleText) $("#hint").textContent = ""; }, 8000);
}

// ---------------------------------------------------------------- 屏蔽 / 重扫 / 批量选择
//
// 这三件事都是「让用户自己把长尾问题变简单」，而不是继续加判定规则：
//   · 屏蔽：垃圾站直接静音，不用和误判搏斗（借鉴 CocoCut 的按域名屏蔽）
//   · 重扫：很多站要先点播放才挂载媒体，给一个不用重载页面的按钮
//   · 批量：候选列表本身有价值，让人一次勾选比逐条点可靠

function syncBlockBtn() {
  const b = $("#blockSite");
  if (!b) return;
  const on = siteBlocked();
  b.classList.toggle("on", on);
  b.title = on ? "已屏蔽此站，点击恢复显示" : "屏蔽此站（不再显示本页资源）";
}

function renderBlocked() {
  const box = $("#list");
  box.replaceChildren();
  const d = el("div", "empty blocked");
  d.innerHTML = `已屏蔽 <b>${siteOf(tabUrl) || "此站"}</b> 的资源列表。<br>`
    + "抓取和收藏不受影响，只是不再在这里显示。";
  const wrap = el("div", "empty-actions");
  const btn = el("button", "btn-txt tint-blue", "恢复显示");
  btn.addEventListener("click", () => setBlocked(false));
  wrap.append(btn);
  d.append(wrap);
  box.append(d);
}

/** 显式设置「当前站点是否屏蔽」，避免用布尔参数兼作开关时把恢复写成屏蔽 */
async function setBlocked(want) {
  const h = siteOf(tabUrl);
  if (!h) return;
  const on = !!want;
  if (on) {
    if (!blockedHosts.includes(h)) blockedHosts.push(h);
    $("#hint").textContent = `已屏蔽 ${h}，点右上角 🚫 可恢复`;
  } else {
    blockedHosts = blockedHosts.filter((x) => x !== h);
    $("#hint").textContent = `已恢复 ${h}`;
  }
  try { await chrome.storage.local.set({ blockedHosts }); } catch (e) { /* 忽略 */ }
  syncBlockBtn();
  if (on) renderBlocked(); else renderList();
  updateBatchBar();
  setTimeout(() => ($("#hint").textContent = ""), 4000);
}

/** 顶栏 🚫：在「屏蔽」和「恢复」之间切换 */
function toggleBlock() {
  const h = siteOf(tabUrl);
  if (!h) return;
  setBlocked(!blockedHosts.includes(h));
}

/** 让页面重新扫一遍 DOM。不重载页面，避免丢掉已经播放/缓冲好的媒体。 */
async function rescanPage(btn) {
  if (btn) { btn.disabled = true; btn.textContent = "扫描中…"; }
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ms:rescan" }, { frameId: 0 });
  } catch (e) { /* 页面没注入（内部页/刚安装）时忽略 */ }
  // 扫描是同步遍历 + postMessage，给 background 700ms 落库
  await new Promise((r) => setTimeout(r, 700));
  await load();
  if (btn) { btn.disabled = false; btn.textContent = "重新扫描"; }
}

function setSelecting(on) {
  selecting = on;
  if (!on) picked.clear();
  $("#selectToggle").classList.toggle("on", on);
  renderList();
  updateBatchBar();
}

/** 可勾选的条目：只限 page=1（数据必须由页面自己取，和「保存」按钮同一条链路） */
function selectableItems() {
  return visibleItems().filter((it) => it.page);
}

function updateBatchBar() {
  const bar = $("#batchBar");
  if (!bar) return;
  bar.classList.toggle("hidden", !selecting);
  const n = picked.size;
  $("#selCount").textContent = `已选 ${n} 项`;
  $("#selSave").disabled = n === 0;
  const all = selectableItems();
  const box = $("#selAllBox");
  box.checked = all.length > 0 && all.every((it) => picked.has(it.u));
  box.indeterminate = n > 0 && !box.checked;
}

async function saveSelected(btn) {
  const items = selectableItems().filter((it) => picked.has(it.u));
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
  btn.textContent = "保存所选";
  if (!res || !res.ok) {
    $("#hint").textContent = "下发失败：" + ((res && res.error) || "页面无响应");
    return;
  }
  $("#hint").textContent = `已在页面弹出 ${items.length} 项，请逐项确认`;
  setTimeout(() => ($("#hint").textContent = ""), 5000);
}

// ---------------------------------------------------------------- 渲染

/**
 * 焦点提示条：列表被「当前打开的那一条」收窄时显示，并给一个「显示全部」的出口。
 *
 * 为什么要显式提示：Telegram 里点开某个相册/图片查看器后，列表只剩那条消息的
 * 媒体（这是用户要的行为）；但如果不告诉他，他会以为「别的图片没抓到」。
 */
function renderFocusBar() {
  const bar = $("#focusBar");
  if (!bar) return;
  if (!focusInfo) { bar.classList.add("hidden"); return; }
  const n = shownItems().length;
  $("#focusText").textContent = n
    ? "只看当前打开的那一条（" + n + " 项）"
    : "只看当前打开的那一条";
  bar.classList.remove("hidden");
}

/** 「显示全部」：清掉 background 里的焦点，重取列表 */
async function exitFocus() {
  if (tabId == null) return;
  await chrome.runtime.sendMessage({ type: "ms:page-forget-focus", tabId });
  await load();
}

/**
 * 分类 chip。
 * 两处刻意的处理：
 *   · 视频/音频两个 chip 数量为 0 也照显示 —— 它们是主功能，藏起来会让人以为
 *     扩展只会抓图片；其它分类（doc/font/other/seg）为 0 才跳过。
 *   · B 站上 counts 是 background 用全量算的，含被隐掉的录制条目，直接显示会
 *     「chip 写 2、点进去空」，所以这里按 shownItems 重算。
 */
function renderChips() {
  const nav = $("#chips");
  nav.replaceChildren();

  // 折叠掉同片清单之后才算数：列表只显示一条，chip 就不能还写 2
  // （「视频 2、点进去 1 条」是用户反复报过的那类对不上）。
  const hidden = movieDedupe().hidden;
  const src = shownItems().filter((it) => !hidden.has(it.u));
  const totalAll = src.filter((it) => it.k !== "seg").length;
  const defs = [["all", "全部", totalAll]];
  for (const k of ["video", "audio", "image", "doc", "font", "other", "seg"]) {
    // ⚠️ 计数一律按 shownItems 重算，不要用 background 给的 counts。
    // counts 是 background 用**全量**算的，含 popup 这边会隐掉的录制条目
    // （B 站 / 小红书详情页），直接显示会出现「chip 写 3、点进去 1 条」。
    // 这一条同时修了小红书「视频 1 音频 2 全部 4」对不上的问题。
    const n = src.filter((it) => it.k === k).length;
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

  // 先判断「两条是不是同一编号组」。判据必须与 background 的分组键一致
  // （见 renumberImages）：**mid 优先，其次标题**。
  //   ① 两个都有 mid            → 比 mid（一条消息一个池）
  //   ② 都没有 mid              → 比标题（普通网站 / 抓不到消息号）
  //   ③ 一个有 mid 一个没有     → 不是同一组
  // 同组且都编了号时，**序号必须压过 kind**。
  //
  // 为什么（2026-10-20 真机，问题①的最后一环）：
  // 同一条消息里视频和图片共用一个序号池（①~⑳），background 按
  // 「组内 ord」编好。但这里原来第一行就是 `if (ka !== kb) return ka - kb;`，
  // 把所有 video 提到所有 image 前面，于是拿到的顺序是
  //   ②④⑥⑧…（video）在前，①③⑤⑦…（image）在后
  // —— 用户看到「序号和内容对不上、跳号」。序号本来就是「阅读顺序」，
  // kind 只是「同序号时的兜底排序」，不能反过来压过它。
  //
  // 2026-10-22 改：这里原来只认标题（v3），与 background 的「mid 优先」不一致
  // 会让同一条消息的条目被判成不同组、退回按体积排 —— 编号对了但顺序乱。
  const sameGroup = (a, b) => {
    const ma = a.mid || "", mb = b.mid || "";
    if (ma && mb) return ma === mb;
    if (!ma && !mb) return (a.title || "").trim() === (b.title || "").trim();
    return false;
  };

  return list.slice().sort((a, b) => {
    // 同一组里编了 ①②③ 的条目，**序号就是阅读顺序**，必须压过 kind 排序。
    // 顺序很关键：后台按 mid → ord 编好号后，若先按 kind 分块（所有 video
    // 提到所有 image 前面），用户看到的就是 ②④⑥… 在前、①③⑤… 在后
    // —— 真机 m14306「序号和内容对不上」的另一半原因就在这里。
    if (sameGroup(a, b) && (a.idx || 0) && (b.idx || 0)) return a.idx - b.idx;
    const ka = order.indexOf(a.k), kb = order.indexOf(b.k);
    if (ka !== kb) return ka - kb;
    // 不同组之间才按 kind 分块；同组但没编号（如未登录的 Telegram 会话）再退回
    // 按大小、时间排。
    //
    // 「是不是同一组」这个判断改过两次，两版都是错的，记下来：
    //   v1 只看 mid —— 小红书的正文图没有消息号（mid 为空），编号是 background
    //      按「整帖一组」编的，只认 mid 会让它们退回按大小排，列表出现 ②⑦①⑥③④⑤。
    //   v2 改成 mid 相同（或两个都没 mid）—— 修好了小红书，但 Telegram 又炸：
    //      background 早已改成**按标题分组**（见 renumberImages 的 titleKey），
    //      而同标题的媒体常横跨好几条消息（同一个标题发了好几组图），mid 各不相同，
    //      于是同组成员被拆散开，用户在列表里看到「⑪ 在最上面、下面才是 ①②③」
    //      —— 用户 m13684 就是拿这张图来问的。
    const ta = (a.title || "").trim(), tb = (b.title || "").trim();
    if (ta && tb && ta === tb && (a.idx || 0) && (b.idx || 0)) return a.idx - b.idx;
    const ma = a.mid || "", mb = b.mid || "";
    if (!ta && !tb && ma === mb && (a.idx || 0) && (b.idx || 0)) return a.idx - b.idx;
    if ((b.s || 0) !== (a.s || 0)) return (b.s || 0) - (a.s || 0);
    return (b.t || 0) - (a.t || 0);
  });
}

/**
 * 渲染列表。空列表时给三种不同的提示 —— 「什么都没有」这句废话解决不了问题，
 * 用户需要知道「为什么空」以及「下一步该做什么」。
 */
function renderList() {
  // 1.3.62 的教训：渲染路径上任何一个 ReferenceError 都会让用户看到「纯空白」
  // （replaceChildren 已清空、行还没建），既没有空态也没有错误，无从报告。
  // 这里把异常兜在列表区：用户能截图一句话，我们不用盲猜。
  try {
    renderListInner();
  } catch (e) {
    try {
      console.warn("[资源嗅探] 列表渲染出错：", e);
      $("#list").replaceChildren(
        el("div", "empty", "列表渲染出错：" + String((e && e.message) || e)
          + "<br>请截图这行字反馈。"));
    } catch (_) { /* 兜底都失败就保持原样 */ }
  }
}

function renderListInner() {
  const box = $("#list");

  // 清单族要按**全量**条目算，不能用 visibleItems：用户切到「视频」筛选时，
  // 分片被筛掉了，但主清单/变体的判定跟分片无关；反过来在「分片」筛选下
  // 用可见列表算，会一条 m3u8 都看不到，标注全丢。
  const hlsFamily = hlsFamilyMap();
  // 同片折叠（2026-10-24 用户要求「只出现一条可下载吗」）：
  // 时长精确相同的多条 m3u8 只留一条，其余折叠起来、那一条上给「切换」。
  const movie = movieDedupe();

  const items = visibleItems().filter((it) => !movie.hidden.has(it.u));
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
      // 「什么都没有」这句废话解决不了问题。多数站的媒体是播放器挂载后才出现的，
      // 所以这里给的是可执行动作：先播一下，再就地重扫（不用整页重载）。
      tip = "还没有资源。<br>如果页面里有视频/音频，<b>先点一下播放</b>，再点下面的「重新扫描」；<br>"
        + "还不行就点右上角 ⟳ 重载页面。";
    }
    const d = el("div", "empty");
    d.innerHTML = tip;
    if (/^https?:/i.test(tabUrl)) {
      const actions = el("div", "empty-actions");
      const scan = el("button", "btn-txt tint-blue", "重新扫描");
      scan.addEventListener("click", () => rescanPage(scan));
      actions.append(scan);
      d.append(actions);
      // 「粘贴链接」（§6 首次空态三动作之一）：B28 落地后这个动作有了实体——
      // 把任意 http(s) URL（视频页/媒体直链都行）连本站 cookie 一起交给本地解析器
      const linkRow = el("div", "empty-actions");
      const linkInput = document.createElement("input");
      linkInput.type = "text";
      linkInput.placeholder = "或粘贴视频页/媒体链接…";
      linkInput.style.cssText = "flex:1;min-width:0;padding:5px 8px;border:1px solid #d4d4d8;border-radius:8px;font:12px system-ui";
      const linkGo = el("button", "btn-txt tint-blue", "解析下载");
      linkGo.addEventListener("click", async () => {
        const u = linkInput.value.trim();
        if (!/^https?:\/\//i.test(u)) {
          $("#hint").textContent = "请粘贴 http(s) 开头的链接";
          setTimeout(() => ($("#hint").textContent = ""), 3000);
          return;
        }
        linkGo.disabled = true;
        const res = await chrome.runtime.sendMessage({ type: "native:download-page", url: u, tabId: null });
        linkGo.disabled = false;
        $("#hint").textContent = res && res.ok ? "已交给本地解析器，进度在下方任务区" : (res ? res.error : "本地下载器不可用");
        setTimeout(() => ($("#hint").textContent = ""), 4000);
      });
      linkRow.append(linkInput, linkGo);
      d.append(linkRow);
    }
    // 诊断：用户报「某站视频列表为空」时，这一行能直接告诉我们是哪一步丢的。
    // 只在「确实收到过请求、但全被丢掉」时显示，避免给正常空页加噪声。
    const dg = diagText(lastDiag);
    if (dg) {
      const box2 = el("div", "diag");
      box2.textContent = dg;
      d.append(box2);
    }
    box.append(d);
    return;
  }

  for (let i = 0; i < items.length; i++) {
    box.append(renderItem(items[i], i + 1, hlsFamily, movie.groupOf));
  }
}

/**
 * build() 的薄封装。写成函数是因为它有两个调用点（列表 + chip 计数），
 * 两处必须拿到同一份结论 —— 否则会出现「视频 2、列表 1 条」，
 * 那正是用户最反感的那类对不上。
 */
function hlsFamilyMap() {
  return (typeof MSHlsFamily !== "undefined" && MSHlsFamily)
    ? MSHlsFamily.build(allItems)
    : new Map();
}

/** 同片折叠的结论（见 hls-family.js 的 sameMovie）。 */
function movieDedupe() {
  if (typeof MSHlsFamily === "undefined" || !MSHlsFamily || !MSHlsFamily.sameMovie) {
    return { groupOf: new Map(), hidden: new Set() };
  }
  return MSHlsFamily.sameMovie(allItems, hlsFamilyMap(), moviePick);
}

/**
 * 把 background 的抓取诊断翻成一句人话。
 * 返回空串 = 没什么可说的（没收到请求，或全部正常入库）。
 */
function diagText(diag) {
  if (!diag || !diag.seen) return "";
  const drop = diag.drop || {};
  const parts = [];
  const NAME = {
    "bad-tabid": "标签页 id 无效",
    "bad-scheme": "非 http(s) 链接",
  };
  for (const [k, n] of Object.entries(drop)) {
    if (k.startsWith("too-small:")) {
      parts.push(k.slice(10) + " 体积过小 " + n + " 条");
    } else {
      parts.push((NAME[k] || k) + " " + n + " 条");
    }
  }
  if (!parts.length) return "";
  return "本次共收到 " + diag.seen + " 个请求，已丢弃：" + parts.join("、") + "。";
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
/**
 * 这条媒体能不能用 popup 里的 <img>/<video> 直接预览。
 *
 * 历史：最初只放行 `http(s):`，理由是「blob:/MSE 只在本页主世界有效，扩展页
 * 加载不了」。这个判断对 **MSE 分片条目（u 是 "m1"/"m2"）** 成立，但对
 * **blob: 地址** 并不成立——Telegram 的 `<img>` 和 `<video>` 的 src 就是
 * `blob:https://web.telegram.org/…`，用户 m13684 的真机截图里那些图片
 * 全都点不了「预览」，正是被这条一刀切挡掉的。
 *
 * 现在的判据只排除「确定预览不了」的两类：
 *   · MSE 录制的合成条目（u 形如 m1/m2，不是真 URL）
 *   · 非 image/video/audio 的类型（文档、字体等）
 * 其余（http/https/blob/data）都放行，让浏览器自己决定能不能画出来；
 * 画不出来时预览框会显示「预览加载失败」，比没有按钮更容易理解。
 */
function canPreviewSrc(it) {
  if (!it) return false;
  if (!["image", "video", "audio"].includes(it.k)) return false;
  const u = String(it.u || "");
  if (/^m\d+$/.test(u)) return false;          // MSE 合成条目
  return /^(https?|blob|data):/i.test(u);
}

/**
 * 渲染一条。
 *
 * @param {object} it 条目
 * @param {number} [no] 行号 = 它在**当前列表**里的位置（1 起）。
 *
 * 为什么要有行号（2026-10-23 用户 51cg1 截图）：同一个视频在列表里出现两条，
 * 一条是页面钩子上报的（带站点标题）、一条是 webRequest 抓的（无标题），
 * 两条都叫「HLS 流（视频）」，用户的原话是「无法区分哪个是哪个」——
 * 点错了下到的是另一路流。行号让人能说「第 2 条」，也让截图能对上号。
 *
 * 与 ①②③（it.mark）**不是一套东西**，别混：
 *   · ①②③ 由 background 按「消息/标题」分组编，表达「这是这条消息里的第几张」，
 *     写在名字里，跟着标题一起被截断；
 *   · 行号是「列表里的第几行」，随筛选/排序变，表达位置而不表达归属。
 * 所以行号单独占一列，在类型徽标左边。
 */
function renderItem(it, no, hlsFamily, groupOf) {
  const row = el("div", "item");
  const isPage = !!it.page;

  // 批量选择只对 page=1 的条目开放：这类数据必须由页面自己取（和「保存」同一条
  // 链路），直链条目的批量下载另有语义，混在一起容易下出一堆意外文件。
  // HLS 也要排除：它必须走本地下载器，混进「保存所选」等于批量下一堆清单文本。
  if (selecting && isPage && !isHlsItem(it)) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "sel-box";
    box.checked = picked.has(it.u);
    const sync = () => {
      if (box.checked) picked.add(it.u); else picked.delete(it.u);
      row.classList.toggle("picked", box.checked);
      updateBatchBar();
    };
    box.addEventListener("change", sync);
    row.addEventListener("click", (e) => {
      if (e.target.closest("button") || e.target === box) return;
      box.checked = !box.checked;
      sync();
    });
    row.classList.add("selectable");
    if (box.checked) row.classList.add("picked");
    row.append(box);
  }

  // 行号放在勾选框**右边**：批量模式下勾选框占最左，是全局一致的约定；
  // 行号紧贴类型徽标，两种模式下都落在同一列，不会左右跳。
  const noEl = el("div", "no", no ? String(no) : "");
  row.append(noEl);

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
  let grp = null;
  if (isHlsItem(it)) {
    // m3u8 的大小是**播放列表文本**的大小（几 KB），不是视频大小。
    // 不写清楚的话用户看到「视频 29 KB」会以为下到了个坏文件。
    //
    // 2026-10-24 真机（51cg1）：四条 5 KB 级的清单文案一模一样，用户问
    // 「有什么区别、该点哪个」。真相是页面同时有
    //     /videos5/<md5>/…  5 KB  ← 预载的小清单，用户点了这个
    //     /m3m/<hex>.m3u8  29 KB  ← 179 段 × 6s = 17:54，播放器真正在用的正片
    // 所以文案第一项必须是**时长和段数**：这是唯一能让人一眼看出哪条是正片的
    // 硬信息（体积不能——5 KB 的清单也可能很长，取决于分片地址写多短）。
    const fam = hlsFamily && hlsFamily.get(it.u);
    grp = (groupOf && groupOf.get(it.u)) || null;
    const dur = fmtDur(it.dur);
    const segs = Number(it.segs) || 0;
    if (grp) {
      // 同片折叠（用户 2026-10-24：「不能只出现一条可下载吗」）。
      // 这一条是**代表**，其余时长相同的清单折叠在它后面，用 sub 行末尾的
      // 「切换」换。不写「第 N 档」：时长相同说明覆盖的是同一段内容，
      // 谁也不是「更高档」，编出档位只会让用户再选一次。
      bits.push(dur ? dur + (segs ? " · " + segs + " 段" : "") : "时长未知");
      bits.push("另有 " + grp.alts + " 个等长片源");
      bits.push("点下载自动拼成完整视频");
    } else if (fam && fam.role === "master") {
      // 名字里已经有「HLS 流（视频）」了，这里不要再重复一次。
      bits.push("主清单 · 含 " + fam.total + " 个清晰度清单");
      bits.push("点下载自动拼成完整视频");
    } else if (fam && fam.role === "variant") {
      // 不写「第 N 档」：这一版只按体积排序，而实测 HQ 比 FHD 小，
      // 档位 ≠ 清晰度。写「第几个清单」是准确的，等 S1 读清单内容再换成真档位。
      if (dur) bits.push(dur + (segs ? " · " + segs + " 段" : ""));
      else bits.push("时长未知");
      bits.push("同目录第 " + fam.index + " / " + fam.total + " 个清单");
      // 「请点主清单」只在**真的有主清单**时才说。51cg1 那四条全是变体、
      // 页面上根本没有主清单，上一版照喊「整段下载请点主清单」，用户找不到那一行。
      if (fam.hasMaster) bits.push("整段下载请点主清单");
    } else {
      // 独立清单（同目录下没有伙伴）—— 中性描述，不编造任何关系
      if (dur) bits.push(dur + (segs ? " · " + segs + " 段" : ""));
      else bits.push("分片清单");
      bits.push("点下载自动拼成完整视频");
    }
  } else if (isPage) {
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
  if (grp) appendSwap(sub, grp);
  meta.append(sub);
  const vrow = variantRow(it);
  if (vrow) meta.append(vrow);
  // B27 时间段截取：video/audio 且非直播（直播没有绝对时间轴）才显示
  if ((it.k === "video" || it.k === "audio") && !it.live) {
    const trwrap = el("div", "vsel");
    const tr = document.createElement("input");
    tr.type = "text";
    tr.className = "vsel-sel";
    tr.placeholder = "可选：00:01:30-00:02:45";
    tr.title = "只下这一段时间（B27）。格式 1:30-2:45 / 00:01:30-00:02:45 / 秒-秒；留空 = 整段";
    tr.style.maxWidth = "180px";
    tr.value = timeRangePick.get(it.u) || "";
    tr.addEventListener("change", () => {
      const v = tr.value.trim();
      if (v) timeRangePick.set(it.u, v);
      else timeRangePick.delete(it.u);
    });
    const trtip = el("span", "vsel-tip", "时间段");
    trwrap.append(trtip, tr);
    meta.append(trwrap);
  }
  row.append(meta);

  const ops = el("div", "ops");

  // HLS 条目**一律走本地下载器**，不管它是页面钩子上报的还是 webRequest 抓的。
  //
  // 真机（2026-10-22 51cg1，用户截图）：DPlayer 页面的 `data-config` 里读出来的那条
  // m3u8 带站点标题，看着最像「该点的那一条」，可它 page=1 → 走下面的页面分支 →
  // 只有「预览 / 保存」。而「保存」这条链路是给 Telegram（blob 地址、要在页面里
  // 带 Range、512KB 限制）和 B 站（`__playinfo__`）设计的：点下去页面会去 Range 拉
  // 那个 m3u8，拿到的是 **38.5KB 的清单文本**，不是视频 —— 用户的原话就是
  // 「上面那个用不了，下面那个能用」。
  // m3u8 只有「几百个分片拼一个文件」这一种下法，宿主才会拼，所以按类型分派，
  // 不按来源分派。
  if (isPage && !isHlsItem(it)) {
    // 预览：判据见 canPreviewSrc() 的注释（blob: 也放行，Telegram 靠它）。
    //
    // 为什么不给 MSE（u 就是 "m1"/"m2"）：那是录制的合成条目，扩展页拼不出
    // 完整文件，点了必然报错，比没有按钮更让人困惑。
    //
    // 按钮次序：预览在左、保存在右。用户 2026-10-18 要求对调——「保存」是
    // 主操作，放在最右贴近滚动条一侧更顺手，也和下面非页面分支的
    // 「复制 / 打开 / 预览 / 下载」保持「重操作在右」的一致节奏。
    if (canPreviewSrc(it)) {
      const pv = el("button", "btn", "预览");
      pv.addEventListener("click", () => showPreview(it));
      ops.append(pv);
    }

    const save = el("button", "btn primary", "保存");
    save.title = "在页面里弹出保存面板（数据由页面自己取，能避开 Telegram 的 512KB 限制）";
    save.addEventListener("click", () => savePageItem(it, save));
    ops.append(save);

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

  if (canPreviewSrc(it) && !isHlsItem(it)) {
    // m3u8 不挂预览：Chrome 的 <video> 不会放 HLS（扩展页更没有 hls.js），
    // 点开必然「预览加载失败」，比没有按钮更让人困惑。
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

/**
 * 同片折叠的「切换」入口。
 *
 * 只换 URL，不换行、不弹选择器 —— 用户要的就是「一条」；再给他一个下拉框
 * 等于把问题原样退回去。切换是**可逆**的：点几次就转几圈，不会丢片源。
 */
function appendSwap(sub, grp) {
  const sp = document.createElement("span");
  sp.className = "swap";
  sp.textContent = "切换";
  const total = grp.urls.length;
  sp.title = "共 " + total + " 个片源、时长都是 " + (fmtDur(grp.dur) || "未知")
    + "，点一下换成下一个";
  sp.addEventListener("click", (e) => {
    e.stopPropagation();   // 别触发整行点击（批量勾选模式下会误勾）
    const i = grp.urls.indexOf(grp.chosen);
    moviePick.set(grp.key, grp.urls[(i + 1) % total]);
    renderList();
  });
  sub.title = "这 " + total + " 个清单时长相同，视为同一个视频的不同片源；"
    + "默认取页面当前在用的那个，点「切换」可以换。";
  sub.append(document.createTextNode(" · "));
  sub.append(sp);
}

// ---------------------------------------------------------------- 选清晰度（S1）

/**
 * 主清单有多少档可选。
 *
 * 只认**主清单**（listKind === "master"）：变体条目自己就是一个档，
 * 单条 media 清单没有档可选。`vlist` 为空说明页面没读到清单正文
 * （CORS / 太大 / 不是页面自己请求的），这时宁可不给选择，也不要编档位。
 */
function pickableVariants(it) {
  if (!it || !isHlsItem(it)) return [];
  if (it.listKind !== "master") return [];
  const vs = Array.isArray(it.vlist) ? it.vlist : [];
  if (vs.length < 2) return [];
  // 与宿主 pick_variant 同一套排序（高度降序 → 带宽降序）：
  // 两处顺序必须一致，否则「默认那档」在 popup 上排第一、在宿主里却不是，
  // 用户看到「默认 1080」却下到 720。
  return vs.slice().sort((a, b) => (heightOf(b) - heightOf(a)) || ((b.bandwidth || 0) - (a.bandwidth || 0)));
}

/** "1920x1080" → 1080；读不出返回 0（不猜）。 */
function heightOf(v) {
  if (!v) return 0;
  const m = /(\d+)\s*[x×]\s*(\d+)/i.exec(String(v.res || ""));
  if (m) return Number(m[2]);
  const one = /^(\d{3,4})p?$/i.exec(String(v.res || ""));
  return one ? Number(one[1]) : 0;
}

/** 一档在界面上的名字：优先「1080P」，其次带宽，最后「第 N 档」。 */
function variantLabel(v, i) {
  const h = heightOf(v);
  if (h) return h + "P";
  const bw = Number(v.bandwidth) || 0;
  if (bw > 0) return (bw / 1e6).toFixed(1) + " Mbps";
  return "第 " + (i + 1) + " 档";
}

/**
 * 档位选择行。没有可选档时返回 null（列表里就完全不出现这一行）。
 *
 * 用 `<select>` 而不是一排按钮：popup 宽度只有 380px 左右，四档以上按钮会换行，
 * 把「下载」按钮挤下去；而 select 的原生下拉在小窗口里更好点。
 */
function variantRow(it) {
  const vs = pickableVariants(it);
  if (!vs.length) return null;
  const wrap = el("div", "vsel");
  const sel = document.createElement("select");
  sel.className = "vsel-sel";
  sel.title = "选清晰度：选定后点「下载」，下到的就是这一档";
  for (let i = 0; i < vs.length; i++) {
    const o = document.createElement("option");
    o.value = vs[i].url;
    o.textContent = variantLabel(vs[i], i);
    sel.append(o);
  }
  sel.value = variantPick.get(it.u) || vs[0].url;
  sel.addEventListener("change", () => {
    // 选回第一档（也就是默认）时清掉记录，让宿主走它自己的默认逻辑 ——
    // 这样「没选」和「选了第一档」在下游是同一条路径，少一种状态。
    if (sel.value === vs[0].url) variantPick.delete(it.u);
    else variantPick.set(it.u, sel.value);
  });
  const tip = el("span", "vsel-tip", "清晰度");
  wrap.append(tip, sel);
  return wrap;
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
  if (isHlsItem(it)) {
    // HLS 列表的文件名多半是「8ffa39d4da7087210f1292376e7b39f3.m3u8」这种哈希，
    // 对用户毫无意义。统一叫「HLS 流（视频）」，真名在下载时按站点标题取。
    base = (it.title ? shortTitle(it.title) + " · " : "") + "HLS 流（视频）";
    if (it.mark) return it.mark + " " + base;
    return base;
  }
  if (isPage) base = pageTitle(it);
  else if (it.title) base = it.title;
  else base = it.f || it.u || "";
  base = shortTitle(base);
  if (it.mark) return it.mark + " " + base;
  return base;
}

/**
 * 是不是 HLS 播放列表条目（background 在 sniff:get 里打的 hint="hls"）。
 *
 * 退回 URL 后缀再判一次：hint 是后加的，用户没重载扩展时老 state 里没有这个
 * 字段，只靠 hint 会漏。
 */
function isHlsItem(it) {
  if (!it) return false;
  if (it.hint === "hls") return true;
  return /\.m3u8$/i.test(String(it.u || "").split("?")[0]);
}

/**
 * popup 里能直接用来当文件名的那一截标题。
 *
 * 页面传来的 title 可能是一整段帖子正文（Telegram 的消息文字，实测 84 个字符），
 * 直接交给页面浮层会把整句话当文件名存下来。这里按 60 个字符收一下。
 * 主世界那边的 finishName 还会再收一次——两边都要，因为「全部保存」「页面浮层
 * 里改名」这几条路径都不一定经过 finishName。
 */
/** 显示名/文件名共用的截断规则，实现在 naming.js（与文件名优先级放一起，可单测）。 */
function shortTitle(t) {
  return MSNaming.shortTitle(t);
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
  // 用户选了清晰度就下那一档（直接下子清单；宿主会把它当 media 清单处理），
  // 没选就交 master，由宿主挑画质最好的那档。
  const chosen = variantPick.get(it.u) || "";
  // B27：填了时间段就透传（合法性宿主 parse_time_range 把关，非法 = 整段下）
  const timeRange = (timeRangePick.get(it.u) || "").trim() || undefined;
  const res = await chrome.runtime.sendMessage({
    type: "native:download",
    url: it.u,
    variant: chosen,
    timeRange,
    kind: it.k,
    // 文件名：**标题优先**，没有标题才退回 URL 推出的名字。
    //
    // 2026-10-24 用户真机：「下载下来的应该是标题，而不是 449820be…（32 位哈希）」。
    // 现场原因：it.f 是 fileNameOf(it.u) —— 纯从 URL 末段推的，对
    // /videos5/449820be.../449820be....m3u8 这种站就只能是哈希。原来写成
    // `it.f || title`，哈希永远赢。
    //
    // 页面浮层那条链（pageSaveName）一直是标题优先，两条链行为还不一致 ——
    // 现在统一成标题优先，用户从哪条路下都是认得出的名字。
    filename: downloadName(it),
    referer: it.i || tabUrl,
    tabUrl,
    // background 需要它才能在「地址过期」时刷新对应标签页重取 m3u8
    tabId,
    // 抓取时实际发出的请求头（referer/origin/accept/accept-language/user-agent）。
    // 只带 referer 时，不少 CDN 会因为没有 Origin 或 Accept 直接 403。
    headers: it.hdr || null,
  });
  if (!res || !res.ok) {
    btn.disabled = false;
    btn.textContent = "下载";
    setHost(false, res ? res.error : "本地下载器不可用");
    return;
  }
  addJob(res.id, downloadName(it) || it.u);
  btn.textContent = "已提交";
  setTimeout(() => { btn.disabled = false; btn.textContent = "下载"; }, 2500);
}

/**
 * 落盘文件名：标题优先，其次 URL 推出的名字。
 *
 * 实现搬到了 extension/naming.js（纯函数、可单测）—— 这里只留转发，
 * 因为「标题 vs URL 名」这个优先级被写反过一次（用户下到 449820be….mp4）。
 * 规则集中一处、有测试盯着，比散在 popup 和 page 两条链里靠谱。
 */
function downloadName(it) {
  return MSNaming.downloadName(it);
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
    // 准备期（percent 还是 0、但宿主给了阶段文案）挂一条来回走的光带：
    // 拉清单 / 探请求头 / yt-dlp 解析分片这几段确实估不出百分比，一根停着的
    // 0% 空槽看起来就是卡死。真机 2026-10-22：这三段合计能让界面静止近 2 分钟。
    job.wrap.classList.toggle("wait", !pct && !!msg.message);
    const bits = [];
    // 阶段文案优先显示 —— updateJob 以前只拼百分比，宿主写了 message 也看不见
    if (msg.message) bits.push(msg.message);
    if (pct) bits.push(pct.toFixed(1) + "%");
    if (!bits.length) bits.push("下载中");
    if (msg.speed) bits.push(msg.speed);
    if (msg.eta) bits.push("剩余 " + msg.eta);
    job.label.textContent = job.name + " · " + bits.join(" · ");
  } else if (msg.status === "done" || msg.action === "done") {
    job.wrap.classList.remove("wait");
    job.fill.style.width = "100%";
    job.wrap.classList.add("done");
    job.label.textContent = "完成 · " + (msg.file || job.name);
  } else if (msg.status === "error" || msg.action === "error") {
    job.wrap.classList.remove("wait");
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

// 批量选择
$("#selectToggle").addEventListener("click", () => setSelecting(!selecting));
$("#selAllBox").addEventListener("change", (e) => {
  const all = selectableItems();
  if (e.target.checked) for (const it of all) picked.add(it.u);
  else for (const it of all) picked.delete(it.u);
  renderList();
  updateBatchBar();
});
$("#selInv").addEventListener("click", () => {
  for (const it of selectableItems()) {
    if (picked.has(it.u)) picked.delete(it.u); else picked.add(it.u);
  }
  renderList();
  updateBatchBar();
});
$("#selSave").addEventListener("click", (e) => saveSelected(e.currentTarget));
$("#selDone").addEventListener("click", () => setSelecting(false));

// 站点屏蔽
$("#blockSite").addEventListener("click", () => toggleBlock());

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

// （日志按钮已按用户要求移除；host.log 仍照常写盘，排查时直接开文件即可）

// （「所在文件夹」独立按钮已并入每条历史记录的操作里，footer 不再有重复入口）

// ---- 本次下载记录（storage.session，浏览器关闭自动清空）----

/** 「打开某条记录所在文件夹」：把文件路径交给 native host 的 reveal。
 *  有 file 就定位到文件，没有就只打开下载目录。 */
async function revealHistoryFile(it, btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "native:reveal-file",
      file: it.file || "",          // background 端：有 file 用 file，没有退回下载目录
    });
    $("#hint").textContent = res && res.ok
      ? (it.file ? "已定位到文件" : "已打开文件存放处")
      : "打不开：" + ((res && res.error) || "本地宿主无响应");
  } catch (e) {
    $("#hint").textContent = "打不开：" + (e && e.message || e);
  }
  if (btn) setTimeout(() => (btn.disabled = false), 1200);
  setTimeout(() => ($("#hint").textContent = ""), 4000);
}

/** 删除某条历史记录（只删记录本身，不动磁盘上的文件） */
async function deleteHistoryItem(time, box) {
  const { history } = await chrome.storage.session.get({ history: [] });
  const list = (history || []).filter((x) => x.time !== time);
  await chrome.storage.session.set({ history: list });
  renderHistory(list, false);
  if (!list.length) { historyShown = false; renderHistory(null, true); }
}

/** 渲染「下载记录」面板；hideNow=true 时只收起不重取 */
function renderHistory(items, hideNow) {
  const box = $("#history");
  if (hideNow || !items || !items.length) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.innerHTML = "";
  const h = document.createElement("h4");
  h.append("下载记录");
  const clr = document.createElement("button");
  clr.textContent = "清空";
  clr.addEventListener("click", async () => {
    await chrome.storage.session.set({ history: [] });
    historyShown = false;
    renderHistory([], false);
  });
  h.append(clr);
  box.append(h);
  for (const it of items.slice().reverse()) {  // 新的在上
    const row = document.createElement("div");
    row.className = "h-item " + (it.ok ? "ok" : "err");
    const t = document.createElement("span");
    t.className = "t";
    const d = new Date(it.time || Date.now());
    t.textContent = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = (it.ok ? "" : "✗ ") + (it.name || "");
    n.title = it.ok ? (it.name || "") : (it.error || it.name || "下载失败");
    row.append(t, n);
    if (it.size) {
      const s = document.createElement("span");
      s.className = "s";
      s.textContent = fmtSize(it.size);
      row.append(s);
    }
    row.append(Object.assign(document.createElement("span"), { className: "sp" }));
    // 打开所在文件夹（琥珀色）——只对成功条目有意义，失败条目禁用
    const rv = document.createElement("button");
    rv.className = "h-act amber";
    rv.textContent = "所在文件夹";
    if (!it.ok) rv.disabled = true;
    rv.addEventListener("click", () => revealHistoryFile(it, rv));
    // 删除（红色）——只删这条记录，不动已下载的文件
    const del = document.createElement("button");
    del.className = "h-act red";
    del.textContent = "删除";
    del.addEventListener("click", () => deleteHistoryItem(it.time, box));
    row.append(rv, del);
    // 失败原因**直接显示**，不藏在 title 里。
    // 原来只有 ✗ + 文件名，用户得把鼠标悬上去才知道为什么失败 ——
    // 而「下不下来时告诉你为什么」是这产品唯一的卖点，不能放在 tooltip 里。
    if (!it.ok && it.error) {
      const why = document.createElement("span");
      why.className = "h-why";
      why.textContent = it.error;
      why.title = (it.code ? it.code + " · " : "") + it.error;
      row.append(why);
    }
    // 站点级建议（解释库 L4）单独一行，与「这一次为什么失败」分开：
    // 前者是单次、通用（describe 的话），后者是「这个站老失败」的已知问题（解释库的话）。
    // 带个标题（「已知问题」）让用户分清这不是本次下载的报错，而是累计出来的规律。
    if (!it.ok && it.advice) {
      const adv = document.createElement("span");
      adv.className = "h-advice";
      const ttl = document.createElement("b");
      ttl.textContent = (it.adviceTitle || "已知问题") + " · ";
      const body = document.createElement("span");
      body.textContent = it.advice;
      adv.append(ttl, body);
      row.append(adv);
    }
    box.append(row);
  }
  box.classList.remove("hidden");
}

/** 「下载记录」按钮：切显隐；每次展开都现取 session storage（保证是最新） */
let historyShown = false;
$("#historyBtn").addEventListener("click", async () => {
  historyShown = !historyShown;
  if (!historyShown) { renderHistory(null, true); return; }
  const { history } = await chrome.storage.session.get({ history: [] });
  if (!(history || []).length) {
    $("#hint").textContent = "本次会话还没有下载记录";
    setTimeout(() => ($("#hint").textContent = ""), 3000);
    historyShown = false;   // 没内容就当没展开，下次再点还能重新取
    return;
  }
  renderHistory(history, false);
});

/**
 * 「整页解析」按钮（B28）：当前页面 URL + 本站 cookie（jar 形态）交给本地
 * yt-dlp。给「插件列表抓不全的站」用的兜底入口 —— yt-dlp 的站点解析器自己
 * 会解协议，扩展只递 URL 和凭据，不注入任何东西。
 */
$("#pageDl").addEventListener("click", async function () {
  const btn = this;
  if (!tabUrl || !/^https?:/i.test(tabUrl)) {
    $("#hint").textContent = "当前页面类型（chrome:// 等）交不了给本地解析器";
    setTimeout(() => ($("#hint").textContent = ""), 4000);
    return;
  }
  btn.disabled = true;
  btn.textContent = "…";
  const res = await chrome.runtime.sendMessage({
    type: "native:download-page",
    url: tabUrl,
    tabId,
  });
  btn.disabled = false;
  btn.textContent = "整页解析";
  if (res && res.ok) {
    $("#hint").textContent = "已交给本地解析器，进度在下方任务区";
    setTimeout(() => ($("#hint").textContent = ""), 4000);
  } else {
    setHost(false, res ? res.error : "本地下载器不可用");
  }
});

/**
 * 「诊断」按钮（§6 诊断包）：一键打包版本/条目统计/脱敏错误日志进剪贴板。
 * 报问题的唯一杠杆——用户不用截图、我们不用猜版本。
 * 脱敏口径：URL 只留 origin + 首段路径（去查询串——里面常有 token），每条截 120 字。
 */
$("#diagBtn").addEventListener("click", async function () {
  const btn = this;
  btn.disabled = true;
  const sanitizeUrl = (u) => {
    try {
      const x = new URL(String(u || ""));
      return x.origin + x.pathname.split("/").slice(0, 2).join("/") + "/…";
    } catch (e) { return String(u || "").slice(0, 60); }
  };
  const lines = [];
  lines.push("资源嗅探诊断包 " + new Date().toISOString());
  lines.push("扩展版本: " + (chrome.runtime.getManifest().version));
  lines.push("页面: " + sanitizeUrl(tabUrl) + (siteBlocked() ? "（已屏蔽站点）" : ""));
  lines.push("条目: " + JSON.stringify(counts) + "（全部 " + allItems.length + "）");
  const dg = diagText(lastDiag);
  if (dg) lines.push("抓取诊断: " + dg);
  const { history } = await chrome.storage.session.get({ history: [] });
  if ((history || []).length) {
    lines.push("最近下载记录:");
    for (const h of history.slice(-5)) {
      lines.push("  " + (h.ok ? "✓" : "✗") + " " + String(h.name || "").slice(0, 40)
        + (h.code ? " [" + h.code + "]" : "") + (h.error ? " " + String(h.error).slice(0, 60) : ""));
    }
  }
  try {
    const r = await chrome.runtime.sendMessage({ type: "ms:diag" });
    if (r && r.ok) {
      lines.push("扩展内部错误（最近 " + (r.errors || []).length + " 条，脱敏）:");
      for (const e of (r.errors || []).slice(-8)) {
        lines.push("  [" + e.where + "] " + String(e.detail || "").replace(/https?:\/\/[^\s"']+/g, (m) => sanitizeUrl(m)).slice(0, 120));
      }
    }
    lines.push("本地引擎: " + ($("#hostState").textContent || "?"));
    await navigator.clipboard.writeText(lines.join("\n"));
    btn.textContent = "已复制";
    setTimeout(() => { btn.textContent = "诊断"; btn.disabled = false; }, 2500);
  } catch (e) {
    btn.textContent = "失败";
    setTimeout(() => { btn.textContent = "诊断"; btn.disabled = false; }, 2500);
  }
});

/**
 * 「AI」按钮（T-F5）：对最近一条失败的下载记录做 AI 分析。
 * 失败时给出的不是又一句固定文案，而是根因假设 + 受控词表里的下一步。
 */
$("#aiBtn").addEventListener("click", async function () {
  const btn = this;
  const { history } = await chrome.storage.session.get({ history: [] });
  const lastFail = (history || []).filter((h) => h && h.ok === false).slice(-1)[0];
  if (!lastFail) {
    $("#hint").textContent = "本次会话还没有失败的下载记录可分析";
    setTimeout(() => ($("#hint").textContent = ""), 3000);
    return;
  }
  btn.disabled = true;
  btn.textContent = "…";
  const res = await chrome.runtime.sendMessage({
    type: "ai:analyze",
    jobId: lastFail.jobId || "",
    url: lastFail.url || "",
  });
  btn.disabled = false;
  btn.textContent = "AI";
  if (res && res.ok) {
    $("#hint").textContent =
      "AI: " + (res.diagnosis || "?") + " → " + (res.strategy_label || res.strategy || "?")
      + (res.advice ? "｜" + res.advice : "");
  } else {
    $("#hint").textContent = (res && res.error) || "AI 分析不可用";
  }
  setTimeout(() => ($("#hint").textContent = ""), 8000);
});

$("#clear").addEventListener("click", async () => {  if (tabId == null) return;
  await chrome.runtime.sendMessage({ type: "sniff:clear", tabId });
  allItems = [];
  counts = {};
  renderChips();
  renderList();
});

$("#focusExit").addEventListener("click", exitFocus);

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
  // 打开 popup = 用户看到了结果：清掉常驻的完成 ✓/✗ 角标
  chrome.runtime.sendMessage({ type: "badge:clear" }).catch(() => {});
})();
