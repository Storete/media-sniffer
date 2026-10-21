/**
 * 页面内 hook（MAIN world，document_start）
 *
 * 捕获层（发现资源）：
 *   1. URL.createObjectURL       → 主线程创建 Blob 时直接持有本体
 *   2. <video>/<audio>.src 赋值  → 即时发现 + 抓标题（property setter）
 *   3. Element.setAttribute      → 覆盖 setAttribute('src', ...) 的写法
 *   4. 轮询 currentSrc           → 兜底：无论 src 怎么设（含 <source> 子元素），
 *                                  currentSrc 都是最终解析结果
 *   5. MediaSource/SourceBuffer  → 流式播放（MSE）时累积分片
 *   6. fetch/XHR hook            → 记录页面自己发出的流媒体请求（Telegram 的
 *                                  /progressive/、/k/stream/ 就是这样发的）
 *
 * 保存层（为什么必须在页面里做）：
 *   Telegram Web 的媒体由它自己的 Service Worker 提供：
 *     - 不带 Range 的 GET          → TypeError: Failed to fetch（SW 直接拒绝）
 *     - 带 Range 的 GET            → 206，但**每次响应最多 512 KB**，而且
 *       即使请求 1 MB，SW 也会截断到 512 KB（见 HANDOVER 里的实测记录）
 *   → 只能分段（Range 链）拉满整条流，再一段段喂给本地下载器写盘。
 *   本地下载器接不到 Service Worker，所以数据必须由页面搬运。
 *
 * 通信：与 content.js 用 window.postMessage
 *   上报  → {__ms_sniffer:true, cmd:'found'|'progress'|'saved', ...}
 *   桥接  ← {__ms_sniffer_cmd:true, cmd:'host-message'|'host-disconnected'}
 *   指令 ↑ {__ms_sniffer_cmd:true, cmd:'host-send', payload}
 *
 * PageEgo / DSH debug hooks（自动测试用，生产环境不存在时自动忽略）：
 *   window.__msDiag(items) / __msLog(level, text)
 */
(() => {
  if (window.__MS_SNIFFER_MAIN__) return;

  // 只处理真正的网页。扩展自己的页面（chrome-extension://，比如 chrome://extensions
  // 里点「检查视图」时的 popup）、chrome:// 内部页、空白页都不该被 hook：
  // 那些页面里 fetch/XHR 的行为不同，硬装 hook 会在控制台刷红字
  // （典型：getResponseHeader 读到 null 后抛错），用户会以为扩展坏了。
  // 注意：只有「明确不是 http(s)」时才退出；读不到 location 时照常工作，
  // 免得非标准环境（worker 包装、测试沙箱）被误杀。
  try {
    const proto = location && location.protocol;
    if (typeof proto === "string" && proto && proto !== "http:" && proto !== "https:") return;
  } catch (e) {
    /* location 读不到就继续 */
  }

  // 放在守卫之后：这个标记表示「本页确实装了 hook」，
  // 别在非网页环境里也留下它，否则排查时会误以为扩展生效了。
  window.__MS_SNIFFER_MAIN__ = true;

  const KEEP_MS = 5 * 60 * 1000;
  const MIN_BLOB = 64 * 1024;
  // 内存预算。以前只有「条数上限」和「单条 MSE 上限」，页面开几个播放器就是
  // N × 单条上限，blob 更是只数条数不数字节 —— 几十个大 blob 就能把标签页拖崩。
  // 现在改成两层：单条上限挡住畸形大对象，全局预算保证总和可控。
  // 注意：这不是下载文件的大小上限——B 站/Telegram 走 Range 直传宿主，
  // 文件多大都行，宿主那边已经不设上限了。
  const MAX_MSE_ENTRY = 128 * 1024 * 1024;   // 单条 MSE 最多留 128MB
  const MAX_MSE_TOTAL = 512 * 1024 * 1024;   // 所有 MSE 加起来最多 512MB
  const MAX_BLOB_ITEM = 256 * 1024 * 1024;   // 单条 blob 超过就不留内存，只上报元信息
  const MAX_BLOB_TOTAL = 512 * 1024 * 1024;  // 所有 blob 加起来最多 512MB
  const MSE_TTL = 30 * 60 * 1000;            // 30 分钟没再 append 就回收（够覆盖暂停后保存）
  const MAX_ITEMS = 60;
  const MAX_MEDIA = 300; // 记录多少条原生媒体请求

  const blobs = new Map();   // blobUrl -> {url, blob, type, size, ts, expires}
  const titles = new Map();  // blobUrl -> title
  const mse = new Map();     // id(m\d+) -> {id, mime, chunks, size, ts}
  const msUrls = new Set();  // MediaSource 的 blob URL（不可 fetch）
  const seenSrc = new Set(); // 已上报过的 mediasrc
  const meta = new Map();    // blobUrl -> {w, h, dur} 分辨率/时长
  const mediaSeen = new Map(); // url -> {kind, ct, size, sample, ts, ref}
  const imgCtx = new Map();  // 图片 url -> {mid, title, ord, w, h}（DOM 上下文）
  let seq = 0;
  let blobBytes = 0;         // blobs 里实际占用的字节数
  let mseBytes = 0;          // mse 里实际占用的字节数

  const post = (data) => {
    try {
      const d = { __ms_sniffer: true, ...data };
      // blob/MSE 条目本身不带内容身份（一个 blob: URL 看不出属于哪个帖子），
      // background 的「同帖分片让位」（xhsVidNote === curNote）全靠这里补上
      // 当前内容的站点内 id；补不上（非清单站点 / 旧版页面脚本）就不过滤，宁可多留。
      if ((d.cmd === "found" || d.cmd === "progress") && !d.noteId) {
        const nid = siteContentId();
        if (nid) d.noteId = nid;
      }
      // 导航代次：SPA 切页后旧页面可能还有一次延迟上报在路上，带上代次让 background
      // 能认出「这是上一页的残留」并丢掉（见 watchSpaNav 里 gen 的说明）。
      // nav 消息自己已经带了自增后的新代次，这里不覆盖。
      if (d.cmd !== "nav" && d.gen == null) {
        const g = (typeof window.__msNavGen === "function") ? window.__msNavGen() : 0;
        if (g) d.gen = g;
      }
      window.postMessage(d, "*");
    } catch (e) { /* 忽略 */ }
  };
  const diag = (text) => {
    try { if (typeof window.__msDiag === "function") window.__msDiag(text); } catch (e) { /* 忽略 */ }
  };
  const log = (text) => {
    try { if (typeof window.__msLog === "function") window.__msLog("info", text); } catch (e) { /* 忽略 */ }
  };

  const origCreate = URL.createObjectURL.bind(URL);
  const origRevoke = URL.revokeObjectURL.bind(URL);

  function extOf(mime) {
    const m = (mime || "").toLowerCase();
    if (m.includes("mp4")) return ".mp4";
    if (m.includes("webm")) return ".webm";
    if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
    if (m.includes("m4a") || m.includes("audio/mp4")) return ".m4a";
    if (m.includes("aac")) return ".aac";
    if (m.includes("ogg") || m.includes("opus")) return ".ogg";
    if (m.includes("quicktime")) return ".mov";
    return ".bin";
  }

  function sanitize(name) {
    return (name || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 90);
  }

  /**
   * 文件名用的标题 → 安全文件名。比 sanitize 多三步：
   *   1. URL 里的 %20 / %E4%B8%AD 之类百分号编码先还原成字符，否则文件名里留一堆 %XX；
   *   2. 没有扩展名的标题去掉垂尾的点/空格（Windows 不允许文件名以 . 或空格结尾）；
   *   3. 清理后只剩符号或空 → 返回 ""，交给调用方走兜底名。
   * B 站用户反馈「B站视频名字不显示」时，最终落盘名是 bilibili.mp4；
   * 现在标题会一路带到文件名，所以这一层必须可靠。
   */
  function safeFileName(t) {
    let s = String(t == null ? "" : t);
    try {
      if (/%[0-9a-f]{2}/i.test(s)) s = decodeURIComponent(s);
    } catch (e) { /* 坏的百分号编码：保持原样 */ }
    // 全角括号/斜杠保留原样（Windows 允许），只处理真正非法的
    s = sanitize(s.replace(/\s+/g, " "));
    s = s.replace(/^[\s.]+|[\s.]+$/g, "");
    return s;
  }

  /**
   * 文件名用的标题上限。
   *
   * Telegram 的媒体都在一条聊天消息里，之前抓到的「标题」其实是整段正文
   * （实测 84 个字符的帖子全文），存下来就是
   * 「东京热 n0875 三穴同插不眠不休的24小时 楓乃々花太敬业了，玩的真狠啊两穴…mp4」。
   * 列表里显示全文没问题，但文件名必须收成一截，所以这里单独再加一层截断。
   * 90 是 Windows 全路径 260 上限下还留得住的长度，这里取 60 更稳。
   */
  function fileNameTitle(t) {
    const s = String(t || "").replace(/\s+/g, " ").trim();
    // 「bilibili / 完整 DASH 流」这种前缀是列表里给条目分类用的，不该进文件名，
    // 否则存出来就是 bilibili_【官方MV】xxx.mp4
    const pre = s.replace(/^[a-z0-9.-]*bilibili(\.com)?\s*[/|·]\s*/i, "");
    const base = pre || s;
    if (base.length <= 60) return base;
    return base.slice(0, 60).replace(/[\s_\-·,，、]+$/, "") + "…";
  }

  function trim() {
    // 条数和字节数任一超限都要裁：只数条数时，60 个大视频照样能吃掉几个 GB。
    if (blobs.size <= MAX_ITEMS && blobBytes <= MAX_BLOB_TOTAL) return;
    const sorted = [...blobs.values()].sort((a, b) => a.ts - b.ts);
    while (sorted.length && (blobs.size > MAX_ITEMS || blobBytes > MAX_BLOB_TOTAL)) {
      const old = sorted.shift();
      if (blobs.delete(old.url)) blobBytes = Math.max(0, blobBytes - (old.size || 0));
    }
  }

  function ascii(b, off, len) {
    return String.fromCharCode(...b.slice(off, off + len));
  }

  /** 字节头 → 扩展名（Telegram 的 CDN 是加密的，靠头判断更靠谱） */
  function sniffExt(b) {
    if (!b || b.length < 12) return null;
    if (ascii(b, 4, 4) === "ftyp") {
      const brand = ascii(b, 8, 4).toLowerCase();
      if (brand === "m4a " || brand.startsWith("m4a") || brand === "mp4a") return ".m4a";
      return ".mp4";
    }
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return ".webm";
    if (ascii(b, 0, 3) === "ID3") return ".mp3";
    if (ascii(b, 0, 4) === "OggS") return ".ogg";
    if (ascii(b, 0, 4) === "fLaC") return ".flac";
    if (b[0] === 0x47 && b[188] === 0x47) return ".ts";
    // 图片魔数：Telegram 的图片是 blob:（类型只挂 image/jpeg 这类 MIME），
    // 而旧逻辑只认音视频，一路兜到 ".mp4" —— 真机存出来是「真机测试图.mp4」，
    // 十六进制却是 ffd8ffe0（JPEG）。按内容定扩展名，别信调用方给的键名。
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ".png";
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return ".gif";
    if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return ".webp";
    if (b[0] === 0x42 && b[1] === 0x4d) return ".bmp";
    return null;
  }

  // ------------------------------------------------------------ 1. Blob / MediaSource 捕获

  URL.createObjectURL = function (obj) {
    const url = origCreate(obj);
    try {
      if (obj && typeof obj.size === "number" && obj.size >= MIN_BLOB && typeof obj.type === "string") {
        // 超大单条不留在内存：照样上报（用户能在列表里看到并直接 fetch 保存），
        // 但不进 blobs，避免一个 1GB 的录制对象把标签页顶爆。
        if (obj.size <= MAX_BLOB_ITEM) {
          blobs.set(url, { url, blob: obj, type: obj.type, size: obj.size, ts: Date.now(), expires: 0 });
          blobBytes += obj.size;
          trim();
        }
        // 只上报音视频 blob。Telegram 的图片预览（头像缩略图、查看器里的照片）
        // 也是 createObjectURL 出来的 image/jpeg blob，且常超过 MIN_BLOB；
        // 报给页面媒体列表会变成「页面视频 · image/jpeg」这类假视频条目。
        // 图片本来就有 webRequest 那条路可抓，这里不必重复上报。
        if (/^(video|audio)\//i.test(obj.type) || !obj.type) {
          post({ cmd: "found", source: "blob", key: url, size: obj.size, mime: obj.type, ext: extOf(obj.type) });
        }
      } else if (obj && typeof obj.addSourceBuffer === "function") {
        msUrls.add(url); // 这是 MediaSource 的 URL，不可 fetch，数据走 appendBuffer
      }
    } catch (e) { /* 忽略 */ }
    return url;
  };

  URL.revokeObjectURL = function (url) {
    const rec = blobs.get(url);
    if (rec && !rec.expires) {
      rec.expires = Date.now() + KEEP_MS;
      setTimeout(() => {
        const cur = blobs.get(url);
        if (cur && cur.expires) {
          blobBytes = Math.max(0, blobBytes - (cur.size || 0));
          blobs.delete(url);
        }
      }, KEEP_MS + 100);
      post({ cmd: "progress", key: url, state: "released" });
    }
    msUrls.delete(url);
    return origRevoke(url);
  };

  // ------------------------------------------------------------ 2. 媒体元素发现（三种触发 + 轮询兜底）

  /** 媒体所在消息的 id / 引用（Telegram 的 data-message-id 在 .Message 上） */
  function mediaContext(el) {
    const out = { mid: "", ref: "" };
    try {
      let n = el, depth = 0;
      while (n && n.nodeType === 1 && depth < 22) {
        const cn = String(n.className || "");
        if (!out.mid && n.getAttribute) out.mid = n.getAttribute("data-message-id") || "";
        if (!out.ref) {
          if (/MediaViewerSlide/.test(cn) || /is-for-video/.test(cn)) out.ref = "viewer";
          // `^Album\b` 只认得 Telegram 旧版的 `Album` 类名；WebZ 现在发的是
          // 哈希类名 + `album-item`，所以补上 album-item（实测 8928 的
          // 两个 video 都挂在 div.AOksc2b1.Q1Cqmt5K.album-item 里）。
          else if (/^Album\b|album-item/.test(cn)) out.ref = "album";
        }
        if (out.mid && out.ref) break;
        n = n.parentElement;
        depth++;
      }
    } catch (e) { /* 忽略 */ }
    return out;
  }

  /**
   * 这个 <video>/<audio> 在「同一条消息」里的阅读顺序（0 起，从左到右、从上到下）。
   *
   * 序号本身由 background 编（图片和视频要在同一个池子里排序），这里只提供
   * 位置信息。用同一消息容器里的 video/audio 逐个比坐标，而不是拿 indexOf
   * 出来的序号 —— DOM 里可能混着 <img>、占位 div，index 会把顺序算错。
   */
  function ordOfMedia(el) {
    try {
      if (!el || !el.parentElement) return -1;
      // 找消息容器：有 data-message-id 的祖先；没有就退回父节点
      let box = el.parentElement;
      let n = el, depth = 0;
      while (n && n.nodeType === 1 && depth < 22) {
        if (n.getAttribute && n.getAttribute("data-message-id")) { box = n; break; }
        n = n.parentElement;
        depth++;
      }
      if (!box || !box.querySelectorAll) return -1;
      // 只跟同一种媒体比：消息里一条视频 + 一条音频时各自从 ① 起
      const tag = el.tagName === "AUDIO" ? "audio" : "video";
      const list = [...box.querySelectorAll(tag)];
      if (list.length <= 1) return 0;
      let r = null;
      try { r = el.getBoundingClientRect(); } catch (e) { /* 忽略 */ }
      if (!r) return -1;
      let before = 0;
      for (const other of list) {
        if (other === el) continue;
        let ro = null;
        try { ro = other.getBoundingClientRect(); } catch (e) { /* 忽略 */ }
        if (!ro) continue;
        if (Math.abs(ro.top - r.top) > 8 ? ro.top < r.top : ro.left < r.left) before++;
      }
      return before;
    } catch (e) {
      return -1;
    }
  }

  /**
   * 判断一段文本是不是播放器 UI 里随手就能抓到的垃圾（不能当标题）：
   * - 全是标点/省略号：「……」「...」「···」
   * - 纯百分比/数字进度：「0%」「0%0%…」「1:23 / 4:56」
   * - 常见播放器控件词：play/pause/下载/全屏/静音/0.5x
   * Telegram 的加载占位符和进度条会把这类文本塞进容器，guessTitle 向上找容器时
   * 会把它当成标题（实测抓出「0%0%…」和「……」两条）。
   */
  function isJunkTitle(t) {
    const s = String(t || "").replace(/\s+/g, " ").trim();
    if (!s) return true;
    // 去掉标点、数字、空白后如果没有至少 2 个「文字」字符，就不是标题
    const words = s.replace(/[%…\.\-–—:：\/\(\)\[\]「」『』【】<>·、,，。!！?？'"“”‘’\s\d]/g, "");
    if (words.length < 2) return true;
    // 纯进度样式：数字 + 百分号 / 时间戳 反复出现
    if (/^[\d\s%:：\.\-\/]+$/.test(s)) return true;
    if (/^(play|pause|停止|静音|全屏|下载|分享|复制|loading|buffering)$/i.test(s)) return true;
    return false;
  }

  /**
   * 聊天气泡的正文（Telegram 的 .text-content，别的站按通用类名兜）。
   *
   * 为什么必须先认它：向上找容器的旧逻辑到了 `message-content` 这一层，
   * textContent 已经是大杂烩 —— Telegram 实测抓到的是
   * 「#jav #深喉 ISRD-008 如何让一个高傲的女人彻底丧失尊严94.4Kdd ch14:58」
   * （正文 + 阅读数 + 签名 + 时间全粘在一起），被当成文件名存了下来。
   * 这里只取正文节点，干净得多；再去掉末尾的时间/状态小字。
   */
  function bubbleText(el) {
    try {
      let n = el, depth = 0;
      while (n && n !== document.body && depth < 8) {
        const box = n.querySelector && n.querySelector(
          ".text-content, .message-text, .tgme_widget_message_text, [class*='message-text']"
        );
        if (box) {
          // cloneNode 后删掉 meta，避免把「94.4K / 14:58 / dd ch」混进标题。
          // 走 clone：直接改原节点会把页面自己的消息内容删掉。
          let txt = "";
          try {
            const c = box.cloneNode(true);
            for (const m of c.querySelectorAll(".MessageMeta, .message-time, .message-views, .message-signature, [class*='Meta']")) {
              try { m.remove(); } catch (e) { /* 忽略 */ }
            }
            txt = (c.textContent || "").replace(/\s+/g, " ").trim();
          } catch (e) {
            txt = (box.textContent || "").replace(/\s+/g, " ").trim();
          }
          if (txt && txt.length > 3 && !isJunkTitle(txt)) return txt.slice(0, 90);
        }
        n = n.parentElement;
        depth++;
      }
    } catch (e) { /* 忽略 */ }
    return "";
  }

  /** 当前帖子的标题（小红书详情页）
   *
   * 用户诉求第 2 条的后半句：「名字对不上」。
   *
   * 真机实测：小红书视频帖的 `note.title` **经常是空串**，真正的文字内容在
   * `note.desc`（例如本测试帖 title="" / desc="哇塞！"）。
   * 而 `guessTitle` 靠向上找 DOM 容器，视频元素 `class=""`、祖先全是
   * `player-el xgplayer` 这类播放器控件，抓到的净是进度/按钮文字，
   * 于是条目要么没名字，要么名字是垃圾。
   *
   * 这里直接从 `__INITIAL_STATE__` 取，优先级：title → desc → 首行文字。
   * 和 `xhsVideoSource()` 用同一份数据源，不额外发请求。 */
  function xhsNoteTitle() {
    try {
      const id = xhsCurrentNoteId();
      if (!id) return "";
      const st = window.__INITIAL_STATE__;
      const map = st && st.note && st.note.noteDetailMap;
      if (!map) return "";
      const entry = map[id];
      const note = entry && entry.note;
      if (!note) return "";
      const cand = note.title || note.desc || "";
      const s = String(cand).replace(/\s+/g, " ").trim();
      if (!s) return "";
      return sanitize(s.slice(0, 90));
    } catch (e) { return ""; }
  }

  function guessTitle(el) {
    try {
      // 站点特化（A0 模块化）：先问站点「你知道这段媒体的标题吗」。
      // 小红书详情页标题在 __INITIAL_STATE__、首页标题在 note-item 卡片的文字区，
      // 两者 DOM 通用逻辑都抓不到。站点返回 "" 就继续走下面的通用实现。
      const site = activeSite();
      if (site && site.title) {
        const t = site.title(el);
        if (t) return t;
      }
      const t = el.getAttribute("title") || el.getAttribute("aria-label") || el.title;
      if (t && t.trim() && !isJunkTitle(t)) return sanitize(t);
      // 优先用气泡正文：它是这段媒体真正的「标题」，比往上抓整层 innerText 干净
      const bubble = bubbleText(el);
      if (bubble) return sanitize(bubble);
      // 向上找几层容器，优先认「文件名样式」的文本（xxx.mp4 / 报告.pdf），
      // 找不到再退回普通短文本（时长、大小等至少能区分资源）
      let n = el, depth = 0;
      while (n && n !== document.body && depth < 5) {
        n = n.parentElement;
        depth++;
        if (!n) break;
        if (n.querySelectorAll) {
          const nodes = n.querySelectorAll("span, div, p, a, strong, em");
          for (const nd of nodes) {
            const txt = (nd.textContent || "").replace(/\s+/g, " ").trim();
            if (
              txt && txt.length >= 4 && txt.length <= 100 &&
              /\.(mp4|mkv|webm|mov|avi|flv|ts|m4v|mp3|m4a|aac|flac|ogg|opus|wav|pdf|zip|rar|7z|doc|docx|xls|xlsx|ppt|pptx|txt|epub)$/i.test(txt) &&
              !/^https?:/i.test(txt)
            ) {
              return sanitize(txt);
            }
          }
        }
        const txt = (n.textContent || "").replace(/\s+/g, " ").trim();
        if (txt && txt.length > 3 && txt.length < 80 && !isJunkTitle(txt)) return sanitize(txt);
      }
    } catch (e) { /* 忽略 */ }
    return "";
  }

  function handleMediaSrc(el, url) {
    try {
      if (!url || typeof url !== "string") return;
      const isBlob = url.startsWith("blob:");
      const isHttp = /^https?:/i.test(url);
      if (!isBlob && !isHttp) return;
      if (isBlob && msUrls.has(url)) return; // MediaSource 流，交给 MSE hook
      const isAudio = el && el.tagName === "AUDIO";
      const ctx = el ? mediaContext(el) : { mid: "", ref: "" };
      // Telegram 自己会往 <video> 里塞 UI 小视频（贴纸、转圈占位等，100×100
      // 这种），不是用户要保存的内容。页面里量出来比 ICON_MAX 还小、又挂在
      // 相册/消息结构外的，直接不上报 —— background 里看不到渲染尺寸。
      let rw = 0, rh = 0;
      try {
        const r = el.getBoundingClientRect();
        rw = Math.round(r.width); rh = Math.round(r.height);
      } catch (e) { /* 忽略 */ }
      if (rw && rh && rw <= 96 && rh <= 96) return;

      // 标题：拿到一次就不再扫（guessTitle 要遍历 DOM，轮询时反复调太贵）
      //
      // ⚠️ 2026-10-18 第十轮：原来这里只在 `!titles.get(url)` 时发一条 progress，
      // 而下面的 found 消息**不带 title**。背景里的 recordPageMedia 靠
      // `if (p.title) existed.title = p.title` 维护标题，但 `p.title` 为 undefined
      // 时这条分支根本不执行 —— 小红书「名字对不上」的直接原因。
      // 现在把 title 直接塞进 found，同时保留 progress 那条路。
      let title = titles.get(url) || "";
      // lateTitle：本轮拿到的标题**赶不上首条 found**，需要补发一条带 title 的。
      //
      // 判断链条（踩过两次才发现）：
      //   · 首轮就有标题（Telegram 等）→ 标题直接进首条 found，不补发
      //   · 首轮没标题、found 已发 → 次轮才拿到标题 → 必须补发
      // 所以判据是「这一轮是不是首轮」（!seenSrc.has(url)）：
      //   seenSrc 在首轮 found 后立刻加入，次轮进来时它已存在。
      // 不能用 titles 判断（首次 titles 必空，两次都成立）。
      const isFirstRound = !seenSrc.has(url);
      let lateTitle = false;
      if (!title) {
        title = guessTitle(el);
        if (title) {
          lateTitle = !isFirstRound; // 不是首轮才需要补发
          titles.set(url, title);
          post({ cmd: "progress", key: url, title });
        }
      }

      // 分辨率/时长元数据（loadedmetadata 之后才有，需要持续更新）
      let w = 0, h = 0, dur = 0;
      try {
        w = el.videoWidth | 0;
        h = el.videoHeight | 0;
        dur = el.duration && isFinite(el.duration) ? Math.round(el.duration) : 0;
      } catch (e) { /* 忽略 */ }
      // 页面侧预先量好的值优先（小红书从 __INITIAL_STATE__ 直接读到，
      // 因为它的 <video> 常是 blob/MSE，videoWidth 要么是 0 要么不是原始尺寸）。
      // 见 scanMedia 里 el.__msW 的赋值处。
      if (el && el.__msW && el.__msH) { w = el.__msW | 0; h = el.__msH | 0; }
      if (el && el.__msDur) dur = el.__msDur | 0;
      const last = meta.get(url);
      if (w || dur) {
        if (!last || last.w !== w || last.h !== h || last.dur !== dur) {
          meta.set(url, { w, h, dur });
          post({ cmd: "progress", key: url, w, h, dur });
        }
      }
      if (ctx.mid) post({ cmd: "progress", key: url, mid: ctx.mid });
      if (ctx.ref) post({ cmd: "progress", key: url, ref: ctx.ref });
      // el.__msOrd：页面侧预先算好的序号（小红书视频帖里视频=0，见 scanMedia）。
      // 优先它，否则退回 DOM 顺序 ordOfMedia。
      const ord = (el && typeof el.__msOrd === "number") ? el.__msOrd : ordOfMedia(el);
      if (ord >= 0) post({ cmd: "progress", key: url, ord });

      // 小红书特有：__INITIAL_STATE__ 是异步挂到 window 上的，第一轮轮询时
      // guessTitle 大概率还取不到标题；而 found 只发一次（seenSrc 挡着），
      // 于是「第一条 found 不带 title」会一直留到用户点开 popup。
      // 这里在标题「从无到有」的瞬间补发一条 found，让 background 补上 title。
      //
      // 只在**首轮没取到标题**（lateTitle）时才补发。标题一开始就有的情况
      // （Telegram 等）补发会造成重复 found 消息，测试 `[2b]` 正是按
      // 「一条 found」断言的。
      if (title && lateTitle) {
        if (!seenSrc.titlePatched) seenSrc.titlePatched = new Set();
        if (!seenSrc.titlePatched.has(url)) {
          seenSrc.titlePatched.add(url);
          post({
            cmd: "found", source: isBlob ? "mediasrc" : "httpmedia", key: url,
            size: 0, mime: isAudio ? "audio/mpeg" : "video/mp4", ext: isAudio ? ".mp3" : ".mp4",
            w, h, dur, title, mid: ctx.mid, ord, ref: ctx.ref,
          });
        }
      }

      if (!seenSrc.has(url)) {
        seenSrc.add(url);
        const ct = mediaSeen.get(url);
        const mime = (ct && ct.ct) || (isAudio ? "audio/mpeg" : "video/mp4");
        post({
          cmd: "found",
          source: isBlob ? "mediasrc" : "httpmedia",
          key: url,
          size: (ct && ct.size) || 0,
          mime,
          ext: isAudio ? ".mp3" : ".mp4",
          w, h, dur,
          title,
          mid: ctx.mid,
          ord,
          ref: ctx.ref,
        });
      }
    } catch (e) { /* 忽略 */ }
  }

  // 2a. src property setter
  const mdesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
  if (mdesc && mdesc.set) {
    Object.defineProperty(HTMLMediaElement.prototype, "src", {
      configurable: true,
      enumerable: true,
      get() { return mdesc.get.call(this); },
      set(v) {
        handleMediaSrc(this, v);
        return mdesc.set.call(this, v);
      },
    });
  }

  // 2b. setAttribute('src', ...)
  if (Element && Element.prototype && Element.prototype.setAttribute) {
    const origSetAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      try {
        const tag = this && this.tagName;
        if ((tag === "VIDEO" || tag === "AUDIO") && String(name).toLowerCase() === "src") {
          handleMediaSrc(this, value);
        }
      } catch (e) { /* 忽略 */ }
      return origSetAttr.call(this, name, value);
    };
  }

  // ------------------------------------------------------------ 2c. 站点注册表（SITES）
  //
  // 用户诉求（2026-10-19 A0）：功能模块化 —— 「图片和视频下载是否有通用的代码，
  // 是否需要针对特定应用添加逻辑」。
  //
  // 答案：**通用层是真的通用**（扫描 / 上下文 / 归属 / Range 下载全都不认站点），
  // 需要特化的只有 5 个点。以前这 5 个点是散在通用函数里的 `if (isXhsHost())`，
  // 每加一个站点就要去改 4~5 个通用函数。现在改成：
  //
  //   通用层只问「当前站点是谁」→ 把请求转给对应站点对象 → 站点没实现就用默认实现。
  //
  // 加新站点 = 往 SITES 里加一个对象，**不需要再动通用函数**。
  //
  // 钩子一览（全部可选，不实现就走通用默认）：
  //   match()              是否当前站点（必须实现，否则这个对象永远不会被选中）
  //   isDecorImg(el, src)  装饰图（头像/logo/二维码/站内素材）→ true 就跳过
  //   isImageOnly(el, src) 只对 <img> 生效的额外筛选（如「只认某个 CDN 签名」）
  //   isDecorVideo(el)     装饰视频（播放器 UI 的小视频）→ true 就跳过
  //   owns(el)             归属：这个元素属于「当前正在看的内容」吗（如小红书当前帖子）
  //   title(el)            标题（返回 "" 表示本钩子没结论，交给下面的通用实现）
  //   videoSrc(el, src)    把 blob:/占位地址换成真实可下地址（返回 "" / null 表示拿不到）
  //   feedImages()         当前内容的「完整清单」（如小红书 imageList），没有就返回 null
  //   onScanImages()       每轮图片扫描前的站点钩子（清单类站点在这里一次性上报）
  //
  // ── 下载层钩子（2026-10-19 第二轮模块化加，之前这些判断硬编码在通用函数里）──
  //   canFeedDownload(ctx) 这个站点能否接管下载（B 站有 __playinfo__ 时走 DASH）→ true
  //   feedDownload(name, ctrl, onProgress, onStage)  站点自己的下载实现（返回下载结果）
  //   saveHint()           浮层底部说明文案（站点专属话术），返回 "" 用通用文案
  //   onSaveStart()        重置站点自己的上报状态（B 站清去重签名）
  //
  // ── 内容归属 / 回放钩子（d-018）──
  //   contentId()          当前内容的站点内 id（小红书 = noteId）。post() 会把它
  //                        补到不带 noteId 的 found/progress 上，background 靠它
  //                        把「blob/MSE 分片让位」限定在同一个内容里
  //   replayReport()       hello/rescan 回放时重报站点自己的合成条目（B 站 DASH）
  //
  // 注意定义顺序：这些函数都是 `function` 声明（函数提升），SITES 里的引用
  // 在**调用时**才解析，所以小红书的实现写在本段之后也没问题。
  const SITES = [];

  function activeSite() {
    try {
      for (const s of SITES) {
        try { if (s.match && s.match()) return s; } catch (e) { /* 单个站点匹配失败不影响其他 */ }
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  /** 当前站点能否接管下载（有自己更完整的流，比如 B 站的 DASH 清单）。 */
  function siteCanFeed(ctx) {
    const s = activeSite();
    if (!s || !s.canFeedDownload) return false;
    try { return !!s.canFeedDownload(ctx); } catch (e) { return false; }
  }

  /** 浮层底部说明文案：站点给了专属话术就用，否则用通用文案。 */
  function siteSaveHint() {
    const s = activeSite();
    if (!s || !s.saveHint) return "";
    try { return s.saveHint() || ""; } catch (e) { return ""; }
  }

  /** 让当前站点重置自己的上报状态（签名等），以便重新播报条目。 */
  function siteResetReport() {
    const s = activeSite();
    if (!s || !s.onSaveStart) return;
    try { s.onSaveStart(); } catch (e) { /* 忽略 */ }
  }

  /** 当前内容的站点内 id（小红书 = noteId）：post() 给 blob/MSE 条目补内容归属用。 */
  function siteContentId() {
    const s = activeSite();
    if (!s || !s.contentId) return "";
    try { return String(s.contentId() || ""); } catch (e) { return ""; }
  }

  /** 重扫/回放时让站点把自己的合成条目重报一遍（B 站的 DASH 条目）。 */
  function siteReplayReport() {
    const s = activeSite();
    if (!s || !s.replayReport) return;
    try { s.replayReport(); } catch (e) { /* 忽略 */ }
  }

  // ------------------------------------------------------------ 小红书：只抓当前帖子
  //
  // 用户诉求：打开小红书单个帖子详情页时，只显示「这个帖子自己的图片」，
  // 不要信息流里其他帖子的封面、也不要头像/logo/二维码等装饰图。
  //
  // 难点：干净 profile 打开详情页会被反爬拦（error_code=300031），拿不到详情页的
  // 精确容器 class。所以判据建立在三路信号上（都不依赖详情页专用选择器）：
  //   1. URL 路由：/explore/{noteId} 或 /discovery/item/{noteId} 才是详情页
  //   2. 图片 CDN URL 特征：小红书正文配图有独一无二的大图签名（见 XHS_NOTE_IMG）
  //   3. DOM 上下文：头像/logo/二维码的 class 和尺寸特征
  // 判据集中成下面的常量/函数，小红书改版时只改这一处。

  /** 是不是小红书网页版（含子域） */
  function isXhsHost() {
    try {
      return /(^|\.)xiaohongshu\.com$/i.test(location.hostname || "");
    } catch (e) { return false; }
  }

  /** 从地址栏提取当前帖子 noteId（只在详情页有；首页 /explore 无 noteId 返回空） */
  function xhsCurrentNoteId() {
    try {
      const m = /^\/(explore|discovery\/item)\/([0-9a-f]{20,})/i.exec(location.pathname || "");
      return m ? m[2] : "";
    } catch (e) { return ""; }
  }

  /**
   * 小红书正文配图（大图）的 CDN URL 签名。实测（信息流封面 + 详情配图同源）：
   *   https://sns-webpic-qc.xhscdn.com/<ts>/<hash>/notes_pre_post/1040g3k03...!nc_n_webp_mw_1
   *   https://sns-webpic-qc.xhscdn.com/<ts>/<hash>/spectrum/1040g0k03...!...
   *   https://sns-webpic-qc.xhscdn.com/<ts>/<hash>/oss-sg/notes/1040g3l03...!...
   * 共同点：sns-(webpic|img)-qc.xhscdn.com 域名 + 路径里 `1040g`（1040px 大图档）+
   * `!` 后缀（图片服务裁切参数）。头像/logo/二维码都不满足这三条。
   */
  const XHS_NOTE_IMG = /sns-(webpic|img)(-qc)?\.xhscdn\.com\/[^"'\s]*1040g/i;

  /** 小红书**评论图**的 URL 特征（2026-10-18 第十轮真机实测）
   *
   * 实测同一张 CDN 上的图片，正文图和评论图**只差路径里一段 `/comment/`**：
   *   正文图 `https://sns-webpic-qc.xhscdn.com/202610181505/{hash}/1040g2sg326dsc2...!n`
   *   评论图 `https://sns-webpic-qc.xhscdn.com/202610181505/{hash}/comment/1040g4b8326f...`
   * 两者都带 1040g 签名，光看签名分不开——这正是「评论区图片也会抓取」的原因之一。
   * URL 判据比 class 判据稳（class 会随前端改版变，路径约定很少变），所以优先用。 */
  const XHS_COMMENT_IMG = /xhscdn\.com\/[^"'\s]+\/comment\/[^"'\s]*1040g/i;

  /** 小红书装饰图（头像/logo/二维码）的 class 特征 */
  const XHS_DECOR_CLASS = /author-avatar|logo|qrcode|qr-code|\bicon\b|profile|avatar/i;

  /** 这张图是不是小红书正文配图（只认 CDN URL 签名，不认 class） */
  function imgIsXhsNote(src) {
    try {
      return XHS_NOTE_IMG.test(src || "") && !XHS_COMMENT_IMG.test(src || "");
    } catch (e) { return false; }
  }

  /** 这张图是不是论坛/评论区的图（URL 带 /comment/ 段） */
  function imgIsXhsComment(src) {
    try { return XHS_COMMENT_IMG.test(src || ""); } catch (e) { return false; }
  }

  /** 这张图是不是小红书的装饰图（头像/logo/二维码）——详情页和首页都该跳过
   *
   * 2026-10-18 第十轮真机补强：侧栏用户头像的 DOM 是
   *   `<span class="reds-image-container gray responsive reds-avatar size-s">`
   *     → `<picture class="reds-img-box">` → `<img class="reds-img">`
   * `reds-img` / `reds-img-box` 本身都不含 "avatar"，原来只拼「自己 + 父亲」两级，
   * 于是这个头像（360×360，尺寸判据也拦不住）成了漏网的「图片」。
   * 修法：沿祖先链往上走 6 层，任意一级命中装饰特征就算装饰 ——
   * 这是小红书自家组件库的命名（reds-*），稳定性比业务 class 好。 */
  function imgIsXhsDecor(el) {
    try {
      let n = el, d = 0;
      while (n && n.nodeType === 1 && d < 6) {
        const hint = String(n.className || "") + " " + String(n.id || "") + " " +
          String(n.getAttribute && n.getAttribute("alt") || "");
        if (XHS_DECOR_CLASS.test(hint)) return true;
        n = n.parentElement; d++;
      }
      const w = el.naturalWidth || 0, h = el.naturalHeight || 0;
      if (w && h && w <= 120 && h <= 120) return true; // 极小图 = 头像/徽章
      return false;
    } catch (e) { return false; }
  }

  // ---- 当前帖子的 DOM 容器（2026-10-18 第七轮新增，解决「混进其他帖子的图」）
  //
  // 用户的真机反馈：「不仅有当前帖子所属图片，还有其他帖子的。」
  // 说明只靠 CDN URL 签名不够 —— **其他帖子的正文配图也是同一个 1040g 大图签名**，
  // URL 层面根本区分不了。唯一可靠的判据是「这个 <img>/<video> 挂在哪棵 DOM 子树下」。
  //
  // ⚠️ 约束：干净 profile 打不开详情页（error_code=300031），拿不到小红书的真实容器
  // class 名。所以这里**不写死选择器**，改成「由内容反推容器」：
  //   1. 拿出页面上所有命中 XHS_NOTE_IMG 的 <img>（这些是「某处』的正文配图」）
  //   2. 沿祖先链往上走，找到那个「只包含本组图、不再往上套」的最近公共祖先
  //   3. 该祖先子树里**所有**的 1040g 图都属于同一个帖子
  // 详情页 = 「当前帖子」容器是页面上**面积最大 / 图最多**的那一组（帖子正文是主内容），
  // 侧边栏相关推荐是若干小卡片，各自成组、面积小得多。
  //
  // 这条规则只在**详情页**生效；首页/搜索页没有「当前帖子」，照旧全部放行。

  /** 这些 class/id 命中的祖先，说明**不是正文媒体**，直接排除。
   *
   * 2026-10-18 第十轮先用真机 DOM 校准过一轮（详情页 dump），实际看到的容器：
   *   - 信息流/推荐卡片：`note-item`（`<section>`，带 `data-note-id`）
   *   - 评论区：`comment-item` / `comment-inner-container` / `parent-comment` /
   *     `comment-picture`（**评论里贴的图同样带 1040g 签名，光看 URL 分不出来**）
   *   - 侧栏：`side-bar` / `bottom-channel`
   * 所以 `comment` 这一项不是猜的，是实测命中；其余几项是保守补充。 */
  const XHS_OTHER_NOTE_CLASS = /note-item|feed-item|recommend|related|sidebar|comment|suggest|search-result/i;

  /** 元素是否落在「别的帖子 / 评论区 / 侧栏」子树里 */
  function xhsInOtherNote(el) {
    try {
      let n = el, d = 0;
      while (n && n.nodeType === 1 && d < 30) {
        const hint = String(n.className || "") + " " + String(n.id || "");
        if (XHS_OTHER_NOTE_CLASS.test(hint)) return true;
        n = n.parentElement; d++;
      }
      return false;
    } catch (e) { return false; }
  }

  /** 元素是否在**评论区**里（第 1 条诉求：评论区图片不该抓）
   *
   * 单独拎出来是因为：评论区常常在正文容器**内部**（小红书详情页的右栏），
   * 所以「祖先链核对 noteId」这一关它过得去（同一个 note-id），
   * 必须在归属判断里**先**用这一条把它拦掉，否则会被当成正文图。
   * 判据用真机实测过的类名，不看 noteId。 */
  const XHS_COMMENT_CLASS = /comment-item|comment-inner-container|parent-comment|comment-picture|comment-list|list-container|reply-container|comments-container|comment-container/i;

  function xhsInComment(el) {
    try {
      let n = el, d = 0;
      while (n && n.nodeType === 1 && d < 30) {
        const hint = String(n.className || "") + " " + String(n.id || "");
        if (XHS_COMMENT_CLASS.test(hint)) return true;
        n = n.parentElement; d++;
      }
      return false;
    } catch (e) { return false; }
  }

  /** 首页信息流封面的标题（图二诉求：给捕获到的封面加标题）。
   *  首页/发现页的每个卡片是 `<section class="note-item" data-note-id=…>`，
   *  封面图在卡片上半部分，标题文字在卡片下方的 <a>/span 里。
   *  从图向上找最近的 note-item / section[data-note-id] 容器，
   *  再在容器里取一段最像标题的纯文本（跳过作者行/互动数字）。
   *  只在**非详情页**用（详情页走 xhsNoteTitle()，读 __INITIAL_STATE__）。 */
  function xhsFeedTitle(el) {
    try {
      if (xhsCurrentNoteId()) return "";   // 详情页不用这条
      let card = null;
      let n = el, d = 0;
      while (n && n.nodeType === 1 && d < 30) {
        const cls = String(n.className || "");
        if (/\bnote-item\b|\bfeed-item\b|note-card|section-item/i.test(cls)
          || (n.tagName === "SECTION" && n.getAttribute("data-note-id"))) { card = n; break; }
        n = n.parentElement; d++;
      }
      if (!card) return "";
      // 容器里最长的可见文本段通常就是标题；作者名/点赞数都更短
      let best = "";
      for (const t of card.querySelectorAll("a, span, p, div")) {
        const s = String(t.textContent || "").replace(/\s+/g, " ").trim();
        if (!s || s.length < 4) continue;             // 太短的不是标题
        if (s.length > 80) continue;                  // 整卡 textContent 兜底项，跳过
        if (/^[\d.,万w\s·|赞收藏]*$/i.test(s)) continue; // 纯互动数字
        if (s === best) continue;
        if (s.length > best.length) best = s;         // 取最长段
      }
      return best ? sanitize(best.slice(0, 90)) : "";
    } catch (e) { return ""; }
  }

  /** 这张图是不是「信息流卡片里的封面/内容图」（区别于导航、遮罩里的杂图） */
  function xhsFeedCardImg(el) {
    try {
      let n = el, d = 0;
      while (n && n.nodeType === 1 && d < 30) {
        const cls = String(n.className || "");
        if (/\bnote-item\b|\bfeed-item\b|note-card|section-item/i.test(cls)
          || (n.tagName === "SECTION" && n.getAttribute("data-note-id"))) return true;
        n = n.parentElement; d++;
      }
      return false;
    } catch (e) { return false; }
  }


  /**
   * 判断这张图是否属于「当前帖子」。
   * 返回 true = 是当前帖子的；false = 别的帖子/装饰。
   *
   * ⚠️ 2026-10-18 第十轮重写（用户真机反馈：「还有其它帖子的图片」）。
   *
   * 旧做法是「按 parentElement 分组 → 图最多的组赢」，在真机上**不成立**：
   * 小红书详情页的轮播图是 `swiper-slide` 结构，每张正文图有**各自的 slide 容器**，
   * 于是每组都只有 1 张图，「图最多」退化成「面积最大」，最后只有面积最大的那张
   * 算当前帖子，其余全被误杀；推荐位容器要是更大，推荐图又会漏进来。
   *
   * 新做法（三路信号，任一命中即可判定，不依赖猜出来的 class 名）：
   *   ① URL 里的 noteId（最强证据）。小红书配图 URL 常带
   *      `.../{noteId}/...` 或 `..._{noteId}_...`，含**别的** 24 位 hex 段
   *      ⇒ 是别的帖子；含当前 noteId ⇒ 是当前帖子。
   *   ② 祖先链上出现 `data-note-id` / `data-noteid` 且值 ≠ 当前 ⇒ 别的帖子
   *      （小红书的 React 组件普遍带这个属性，比 class 名稳）。
   *   ③ 兜底：沿祖先链找「包含当前帖子正文图最多」的最近公共祖先，
   *      该子树里的图都算当前帖子；同时把「正文容器之外」的图排除。
   */
  /** 从图片 URL 里抠出所有 24 位 hex 段（noteId 就是 24 位 hex）
   *
   * ⚠️ 必须锚定到「路径/查询分隔符边界」：早年写法是裸匹配 24 位 hex，
   * 结果视频 URL `.../stream/abc/110/258/01e8f0.mp4` 里的 `110/258/01e8f0`
   * 也能凑出 24 位 hex，被误判成「别的帖子」把正文视频过滤掉。
   * 现在只认 `/<24hex>`（路径段）或 `=<24hex>` / `_<24hex>_`（查询/文件名段）。 */
  const XHS_NOTE_ID_RE = /(?:^|[\/=&_-])([0-9a-f]{24})(?=$|[\/=&_.!-])/gi;

  function xhsIdInUrl(u) {
    try {
      const s = String(u || "");
      const out = [];
      const re = new RegExp(XHS_NOTE_ID_RE.source, "gi");
      let m;
      while ((m = re.exec(s)) !== null) out.push(m[1].toLowerCase());
      return out;
    } catch (e) { return []; }
  }

  /** 元素祖先链上的 noteId 标记（当前帖子容器 or 别的帖子卡片）
   *
   * ⚠️ 真机上小红书的两种属性名**同时存在**（2026-10-18 第十轮真机实测）：
   *   - 信息流卡片 `<section class="note-item" data-note-id="...">`  → 带 data- 前缀
   *   - 正文容器 `<div class="note-detail-mask" note-id="...">`     → **不带** data- 前缀
   *
   * 早期只查了 `data-note-id` / `data-noteid` / `data-note` 三个带前缀的，
   * 结果正文容器完全命不中，视频/图片的归属判断退化成兜底分支——
   * 这正是「评论区图片仍被抓」和「本帖子视频不认」的直接原因之一。
   * 所以 `note-id` 必须一起查。 */
  function xhsAncestorNoteId(el) {
    try {
      let n = el, d = 0;
      while (n && n.nodeType === 1 && d < 40) {
        const id = n.getAttribute && (n.getAttribute("note-id") || n.getAttribute("data-note-id")
          || n.getAttribute("data-noteid") || n.getAttribute("data-note"));
        if (id && /^[0-9a-f]{24}$/i.test(String(id).trim())) return String(id).trim().toLowerCase();
        n = n.parentElement; d++;
      }
      return "";
    } catch (e) { return ""; }
  }

  function imgBelongsToCurrentNote(el) {
    try {
      const cur = xhsCurrentNoteId();
      if (!cur) return true; // 非详情页不做归属判断
      const curId = cur.toLowerCase();

      // ⓪ 评论区一律排除（第 1 条：评论区里贴的图不该抓）
      //
      // 必须放在最前面：评论区在小红书详情页里通常位于正文容器**内部**
      // （同一个 note-id 属性下），如果先走 ② 的 noteId 核对，它会一路通过；
      // 评论图的 URL 也可能带当前 noteId，① 同样拦不住。
      // 所以用「DOM 位置」这条独立判据先行拦截。
      if (xhsInComment(el)) return false;

      // ① URL 里的 noteId
      //
      // ⚠️ 视频不能用 el.src：真机实测正文视频的 src 是 `blob:https://www.xiaohongshu.com/uuid`，
      // 里面没有任何 noteId 信息（播放器把 mp4 读进 MSE 后把 src 换成了 blob）。
      // 真实地址在 `__INITIAL_STATE__` 里，见 xhsVideoSource() 的说明。
      let src = "";
      try { src = el.currentSrc || el.src || ""; } catch (e) { src = ""; }
      const ids = xhsIdInUrl(src);
      if (ids.includes(curId)) return true;           // 明确是自己的
      if (ids.length && !ids.includes(curId)) return false; // 明确是别人的

      // ② 祖先链上的 note-id / data-note-id
      // 真机上正文容器是 `note-id`（无 data- 前缀），信息流卡片是 `data-note-id`，
      // 两种都要认，否则正文容器命不中（见 xhsAncestorNoteId 的注释）。
      const anc = xhsAncestorNoteId(el);
      if (anc) return anc === curId;

      // 快速排除（猜的 class 名，命中就是别的帖子）
      if (xhsInOtherNote(el)) return false;

      // ③ 兜底：沿祖先链找「正文图最多」的容器
      // 收集范围内所有正文图（只认 CDN 签名，含被 ①② 判为当前的）
      const inScope = (im) => {
        let s = "";
        try { s = im.currentSrc || im.src || ""; } catch (e) { s = ""; }
        if (!imgIsXhsNote(s) || imgIsXhsDecor(im)) return false;
        const iid = xhsIdInUrl(s);
        if (iid.length) return iid.includes(curId); // URL 有 id 就按 id 算
        return !xhsInOtherNote(im);
      };
      const noteImgs = [...document.querySelectorAll("img")].filter(inScope);
      if (noteImgs.length <= 1) return true; // 判不出来，放行

      // 从「挂载这些图的最近公共祖先」往下，逐层找能覆盖本图的最大图集
      // 判据：某个祖先 A 子树里包含的正文图数量 ≥ 阈值，且本图在 A 子树里。
      let best = null, bestCount = 0;
      let n = el.parentElement, d = 0;
      while (n && d < 40) {
        let cnt = 0;
        try {
          cnt = noteImgs.filter((im) => n.contains(im)).length;
        } catch (e) { cnt = 0; }
        if (cnt > bestCount) { bestCount = cnt; best = n; }
        n = n.parentElement; d++;
      }
      if (!best) return true;
      // 该容器要装下「大部分」正文图才算当前帖子容器，否则说明判不出，放行
      if (bestCount < Math.ceil(noteImgs.length / 2)) return true;
      return best.contains(el);
    } catch (e) { return true; } // 判不出来时放行，宁可多抓不可漏抓
  }

  // ---- 小红书视频（2026-10-18 第七轮新增）
  //
  // 用户诉求：「实现小红书视频下载的功能，逻辑和图片一样」。
  // 小红书的视频是 <video> 且 **src 直接是 mp4 的 CDN 地址**（不是 MSE），
  // 所以只要在 scanMedia 里像处理图片那样做「装饰图/其他帖子」过滤就行。
  //
  // 视频 CDN 特征（实测）：sns-video-hw.xhscdn.com / sns-video-qc.xhscdn.com 等，
  // 路径里通常带 `spectrum` 或直接 .mp4。注意：正文图也可能出现 sns-video 域名的封面帧，
  // 所以**不靠域名判视频**，靠元素本身是 <video> 就够。
  const XHS_VIDEO_HINT = /\.(mp4|m4v|mov)(\?|$)|sns-video/i;

  /** 这个 <video> 是不是小红书的装饰/他帖视频 */
  function videoIsXhsDecor(el) {
    try {
      const hint = String(el.className || "") + " " + String(el.id || "") + " " +
        String(el.parentElement && el.parentElement.className || "");
      if (XHS_DECOR_CLASS.test(hint)) return true;
      return xhsInOtherNote(el);
    } catch (e) { return false; }
  }

  // ---- 小红书视频的真实地址（2026-10-18 第十轮真机实测后新增）
  //
  // 用户诉求第 2 条：「小红书的视频无法读取、名字对不上」。
  //
  // 【现象】真机详情页里 `<video>` 的 src 是
  //   `blob:https://www.xiaohongshu.com/364d1c52-6dbe-4b87-8c6a-77bed12edb94`
  // 里面**没有任何 CDN 地址**——播放器把 mp4 读进内存后把 src 换成了 blob。
  // 所以 `handleMediaSrc(el, src)` 上报的是这个 blob，浏览器端根本 fetch 不到，
  // 下载自然全失败；而 webRequest 抓到的是 MP4 分段 Range 请求，
  // 主文件那条往往因为 Service Worker / media 缓存看不到。
  //
  // 【真实地址在哪】`window.__INITIAL_STATE__.note.noteDetailMap[noteId].note.video.media.stream`
  // 是个 Map（key 是清晰度编号 EF4/EF5/EF6/EF7），每个 key 对应一个数组：
  //   [{ masterUrl: "http://sns-video-v6.xhscdn.com/stream/1/110/332/xxx.mp4?sign=...",
  //      backupUrls: [...], width: 1080, height: 2416, duration: 95134, format: "mp4" }]
  // 同一个视频常有多套清晰度（EF4=572x1280 / EF5=1080x2416），
  // 这里**取像素面积最大**的那条主地址（和图片「取体量最大」的策略一致）。
  //
  // 【为什么不 hook MSE / 不走 sidx】见 DEVELOPMENT.md 第 7 章：小红书是
  // 普通 Range 请求整段 mp4（不是分片 MSE），拿到 URL 直接 Range 下载即可。

  /** 从 __INITIAL_STATE__ 里取当前帖子的视频真实地址（取分辨率最高的那条）
   * @returns {{url:string, w:number, h:number, duration:number}|null}
   */
  function xhsVideoSource() {
    try {
      const id = xhsCurrentNoteId();
      if (!id) return null;
      const st = window.__INITIAL_STATE__;
      const map = st && st.note && st.note.noteDetailMap;
      if (!map) return null;
      const entry = map[id] || map[Object.keys(map).find((k) => k === id)];
      const note = entry && entry.note;
      if (!note || note.type !== "video") return null;
      const media = note.video && note.video.media;
      const streams = media && media.stream;
      if (!streams) return null;

      let best = null, bestArea = -1, bestRank = -1;
      // streams 在真机上是对象（Map 序列化成对象），但旧的 mock/别的版本可能是数组，
      // 两种都兜住。每个 value 才是「同一清晰度下的候选列表」。
      //
      // ⚠️ 2026-10-18 真机教训（帖子 6ad46958…，type=video、有 2K 版）：
      // 同一份 stream 里**混着两种东西** ——
      //   · `.mp4`   —— 完整单文件，Range 请求能直接下完整段；
      //   · `.m4s`   —— DASH 分片，只是整段的一部分，单独下下来放不出画面。
      // 老逻辑只比 `width*height`，而真机上 `.m4s` 那组的尺寸恰好更大
      // （2560×1440 的 m4s vs 1920×1080 的 mp4），于是总挑到分片：
      // 列表里能看到条目，一保存就是坏的 / 页面 <video> 是 blob: 时干脆认不出来。
      // 所以先按「是不是完整文件」排，再按面积排 —— **宁可分辨率低一点，也要能播**。
      const isSeg = (u) => /\.m4s(\?|$)/i.test(u);
      const rankOf = (u) => (isSeg(u) ? 0 : 1);
      const groups = Array.isArray(streams) ? [streams] : Object.keys(streams).map((k) => streams[k]);
      for (const group of groups) {
        const list = Array.isArray(group) ? group : [group];
        for (const s of list) {
          if (!s) continue;
          const u = s.masterUrl || s.url || "";
          if (!/^https?:\/\//i.test(u)) continue;
          const area = (s.width | 0) * (s.height | 0);
          const rank = rankOf(u);
          if (rank > bestRank || (rank === bestRank && area > bestArea)) {
            bestRank = rank; bestArea = area; best = s;
          }
        }
      }
      if (!best) return null;
      // ⚠️ 统一成 https：真机上 masterUrl 给的是 `http://sns-video-v6...`，
      // 而 webRequest 和播放器自己发的是 `https://...`，两条协议会被当成
      // 两个不同的 key，列表里就出现「同一个视频两条，一条有名字一条没名字」。
      // CDN 本来就支持 https（HEAD 200），按 https 报上去让它们合并成一条。
      const raw = String(best.masterUrl || best.url || "");
      const url = raw.replace(/^http:\/\//i, "https://");
      return {
        url,
        w: best.width | 0,
        h: best.height | 0,
        duration: best.duration | 0,
        backup: String((best.backupUrls || []).find((b) => /^https?:\/\//i.test(b)) || "").replace(/^http:\/\//i, "https://"),
      };
    } catch (e) { return null; }
  }

  /** 当前帖子的视频条目准备就绪时返回 true（供 scanMedia 判断要不要上报封面） */
  function xhsVideoReady() {
    return !!xhsVideoSource();
  }

  // ---- 小红书笔记的全部配图（2026-10-18 第十一轮新增）
  //
  // 【为什么加】用户发来一个「小红书去水印」iOS 快捷指令，它的做法是
  // 「把分享页 HTML 抓下来，正则扫 imageList / masterUrl」，不碰 DOM。
  // 顺着这条线实测了本机详情页的 `__INITIAL_STATE__`，结论是**它明显更全**：
  //
  //   · imageList 一次给全 7 张，尺寸齐全（1672×941 / 823×770 …），
  //     数组顺序就是作者发布顺序；
  //   · DOM 扫描拿到的同样 7 条里有 3 条 naturalWidth=0（swiper 只渲染首张，
  //     其余懒加载没解码），尺寸拿不到，排序只能靠 ord 猜；
  //   · 整页带 1040g 签名的 <img> 有 77 个（信息流他帖 + 评论图），
  //     DOM 这条路得靠「祖先链 + note-id + 评论区类名」一堆启发式去猜哪 7 张是正文——
  //     而 imageList 本身就是「这个帖子的图」这条定义的标准答案。
  //
  // 【做法】优先读 imageList；读不到（页面结构变了 / 不是详情页）就返回 null，
  // 调用方退回原来的 DOM 扫描。**不是二选一**，是「直读为主、DOM 兜底」。
  //
  // 【URL 取哪个】每条 imageList 项带 infoList（2 个档位），实测都是
  //   `http://sns-webpic-qc.xhscdn.com/<ts>/<hash>/spectrum/1040g…!<后缀>`
  // 取**最后一个**（infoList 末尾是大图档，和用户在页面上看到的一致）。
  // 和视频一样必须把 `http://` 换成 `https://`：webRequest 抓的是 https，
  // 两条协议会产生两个不同的 key，列表里就出现「同一张图两条」。

  /** 从 __INITIAL_STATE__ 取当前帖子的全部配图（按发布顺序）
   * @returns {Array<{url:string,w:number,h:number,fileId:string}>|null} 读不到时 null
   */
  function xhsNoteImages() {
    try {
      const id = xhsCurrentNoteId();
      if (!id) return null;
      const st = window.__INITIAL_STATE__;
      const map = st && st.note && st.note.noteDetailMap;
      if (!map) return null;
      const entry = map[id] || map[Object.keys(map).find((k) => k === id)];
      const note = entry && entry.note;
      if (!note) return null;
      const list = note.imageList;
      if (!Array.isArray(list) || !list.length) return null;

      const out = [];
      for (const im of list) {
        if (!im) continue;
        // 优先 infoList 末尾（大图档）；没有再退回 urlDefault / urlPre
        const infos = Array.isArray(im.infoList) ? im.infoList.filter((x) => x && x.url) : [];
        const picked = infos.length ? infos[infos.length - 1].url : (im.urlDefault || im.urlPre || "");
        const raw = String(picked || "");
        if (!/^https?:\/\//i.test(raw)) continue;
        const url = raw.replace(/^http:\/\//i, "https://");
        out.push({
          url,
          w: im.width | 0,
          h: im.height | 0,
          fileId: String(im.fileId || ""),
        });
      }
      return out.length ? out : null;
    } catch (e) { return null; }
  }

  /** 当前帖子是不是「图文笔记但不带视频」（纯图片帖）。视频帖的封面由 imageList[0] 给，
   * 下面 scanImages 用它决定要不要连封面一起上报。 */
  function xhsNoteType() {
    try {
      const id = xhsCurrentNoteId();
      if (!id) return "";
      const st = window.__INITIAL_STATE__;
      const map = st && st.note && st.note.noteDetailMap;
      const entry = map && (map[id] || map[Object.keys(map).find((k) => k === id)]);
      return String((entry && entry.note && entry.note.type) || "");
    } catch (e) { return ""; }
  }


  // ---- 小红书站点对象（A0 模块化：把散在通用函数里的 if 收进这里）----
  //
  // 只做「转发」，实现仍调用下面那一堆 xhs* 函数，一行没搬、行为不变。
  SITES.push({
    name: "xiaohongshu",
    match: () => isXhsHost(),

    // focus() 当前焦点：小红书返回 "" —— 详情页 URL 已经锁死在这一帖上
    // （owns 只报本帖），不需要额外的查看器焦点。
    focus: () => "",

    // 当前帖子 id：post() 靠它给 blob/MSE 条目补内容归属，background 的
    // 「分片让位」只对同一个 noteId 生效（d-018）。首页/发现页返回 ""。
    contentId: () => xhsCurrentNoteId(),

    isDecorImg: (el, src) => imgIsXhsDecor(el) || imgIsXhsComment(src) || xhsInComment(el),

    isDecorVideo: (el) => videoIsXhsDecor(el),

    // 详情页：不属于当前帖子的一律不要（含信息流他帖 + 评论区视频）。
    // 首页/发现页：只要信息流卡片里的图（导航/弹窗杂图不要）。
    owns: (el) => (xhsCurrentNoteId() ? imgBelongsToCurrentNote(el) : xhsFeedCardImg(el)),

    // 详情页图片还多一道：只认 CDN 大图签名（别的帖子的封面、站内素材没有这个签名，
    // 但它们有尺寸、有 class，装饰图判据拦不住）。只对 <img> 生效，视频不适用。
    isImageOnly: (el, src) => !xhsCurrentNoteId() || imgIsXhsNote(src),

    // 详情页标题在 __INITIAL_STATE__，首页标题在 note-item 卡片的文字区
    title: (el) => (xhsCurrentNoteId() ? xhsNoteTitle() : "") || xhsFeedTitle(el),

    // blob: → __INITIAL_STATE__ 里的真实 mp4；拿不到返回 ""（本轮回退为跳过）
    videoSrc: (el) => {
      const real = xhsVideoSource();
      if (!real || !real.url) return "";
      try {
        if (real.w && real.h) { el.__msW = real.w; el.__msH = real.h; }
        if (real.duration) el.__msDur = Math.round(real.duration / 1000);
      } catch (e) { /* 忽略 */ }
      el.__msOrd = 0;   // 视频帖里视频是正文第一件东西
      return real.url;
    },

    // 详情页有完整配图清单（比 DOM 扫描全，且天然只含当前帖子）
    feedImages: () => (xhsCurrentNoteId() ? xhsNoteImages() : null),

    // 清单通路：一次性报完配图 + 视频本体，然后告诉通用层「这轮不用扫 DOM 了」
    onScanImages: () => {
      if (!xhsCurrentNoteId()) return false;
      const noteImgs = xhsNoteImages();
      if (!noteImgs || !noteImgs.length) return false;
      scanXhsNoteImages(noteImgs);
      reportXhsVideo(xhsNoteVideoInfo());
      return true;
    },
  });

  /**
   * Telegram 的「焦点」：用户点开某条消息的相册/图片查看器时，返回那条消息的 id。
   *
   * 为什么 Telegram 需要这个，而小红书不需要：小红书的详情页 URL 里就带着 noteId，
   * 页面扫描天然只报本帖；Telegram 的地址是频道地址（`/a/#-100…`），点开任意一条
   * 消息都不会变，所以只能在 DOM 里反查「现在打开的是哪条」。
   *
   * 判据（按可靠度排序）：
   *   1. 查看器容器里的 `data-message-id` —— WebK/WebA 的 MediaViewer 都会给
   *      slide 标上来源消息；
   *   2. 从当前可见的查看器 `<img>`/`<video>` 往上找 `data-message-id`
   *      （查看器把消息容器整个搬进浮层时，id 还在祖先上）。
   * 两条都拿不到就返回 ""，也就是「不设焦点、显示全量」——
   * 宁可多显示，也不能因为猜错把列表清空。
   */
  /**
   * 取一个媒体元素的「可比对标识」：优先 currentSrc（blob 或 progressive 都算），
   * 其次 src 属性。两者都空时返回 ""。
   */
  function tgMediaKey(el) {
    if (!el) return "";
    const s = el.currentSrc || el.src || el.getAttribute("src") || "";
    return String(s).trim();
  }

  /**
   * 从「查看器里正在看的那张/那条」反查它属于哪条消息（问题②，方案 B）。
   *
   * 为什么需要反查（2026-10-20 真机实测）：Telegram 的 `#MediaViewer` 打开后，
   * DOM 里**没有任何消息标识**——`.MediaViewerSlide` 只有 class/style，
   * 上溯链 `MediaViewerSlide--active → MediaViewerSlides → DIALOG#MediaViewer
   * → .opacity-transition → .Transition → BODY` 全无 `data-message-id`，
   * `.message.highlighted/.selected` 也是空的（TG 的点击跳转用滚动定位，不加类）。
   * 唯一还能对上的是**媒体地址本身**：查看器里的 `<video src=".../document4999…">`
   * 与聊天里那条消息里的同一个地址。
   *
   * 所以做法是：拿查看器里激活那张的 src，去聊天里找 src 相同的媒体元素，
   * 再往上找它所属的 `[data-message-id]`。blob: 地址在同一页面里是同一个字符串
   * （TG 用的是同一个 objectURL），所以比对能命中。
   *
   * 找不到返回 ""，绝不猜一个——猜错会让列表显示错误的内容，
   * 比「不收窄」更糟（用户会以为抓漏了）。
   */
  function tgFocusByMedia() {
    try {
      // 只认「当前可见的那一页」。MediaViewer 里所有 slide 都渲染了，
      // 必须用 --active 挑出真正展示的那张，否则会拿到邻张。
      const slides = document.querySelectorAll(".MediaViewerSlide--active, .MediaViewer .MediaViewerSlide--active");
      const viewer = slides.length ? slides[slides.length - 1] : document.querySelector(".MediaViewerSlide");
      const vMedia = viewer ? viewer.querySelector("img, video") : null;
      const vKey = tgMediaKey(vMedia);
      if (!vKey) return "";
      // 在聊天消息里找同地址的媒体元素
      const all = document.querySelectorAll("[data-message-id] img, [data-message-id] video");
      for (const m of all) {
        if (tgMediaKey(m) !== vKey) continue;
        let n = m, depth = 0;
        while (n && n.nodeType === 1 && depth < 22) {
          const id = n.getAttribute && n.getAttribute("data-message-id");
          if (id) return String(id).trim();
          n = n.parentElement;
          depth++;
        }
      }
    } catch (e) { /* 忽略 */ }
    return "";
  }

  function tgFocus() {
    try {
      // 只在 Telegram 主界面里找，避免第三方嵌入页面误判
      if (!/(^|\.)telegram\.(org|me|dog)$/i.test(location.hostname || "")) return "";
      const viewerSel = ".MediaViewer, .MediaViewerSlide, [class*='MediaViewer'], [class*='is-for-video']";
      const viewers = document.querySelectorAll(viewerSel);
      for (const v of viewers) {
        // ① 容器自己带消息号（目前实测没有，留着以防 TG 改版加回来）
        const own = v.getAttribute && v.getAttribute("data-message-id");
        if (own) return String(own).trim();
        // ② 容器里的媒体元素往上找
        const media = v.querySelector ? v.querySelector("img, video") : null;
        if (media) {
          let n = media, depth = 0;
          while (n && n.nodeType === 1 && depth < 22) {
            const id = n.getAttribute && n.getAttribute("data-message-id");
            if (id) return String(id).trim();
            n = n.parentElement;
            depth++;
          }
        }
      }
      // ③ 兜底（方案 B）：拿查看器里激活那张的媒体地址，回聊天里反查
      return tgFocusByMedia();
    } catch (e) { /* 忽略 */ }
    return "";
  }

  /**
   * 焦点变化时向后台上报（没变化就不发，避免每 600ms 刷一条消息）。
   *
   * 难点是「通用层要认识站点」——但按 A0 模块化，通用层不认识任何站点，
   * 所以这一层只做「问一遍 activeSite().focus()」：
   *   · 小红书返回 ""（URL 已收窄，不需要）
   *   · Telegram 由下面 push 进去的对象返回 tgFocus()
   * 拿不到 focus 钩子的站点一律视为「没有焦点」。
   *
   * 为什么还要「隔一段时间强制重发」（2026-10-20 真机踩到）：
   * 只按变化发有个致命副作用——**一次上报丢掉就永久失效**。
   * 实测现象：查看器刚打开那一瞬间，`post` 发出去了，但 content script 转发时
   * service worker 正在启动（或 tab 记录还没建），后台没收到；可 `lastFocus`
   * 已经被设成 "7498"，之后每一轮都判定「没变化」直接 return，
   * 于是用户看到「明明打开了查看器，列表还是全量」。
   * 现在改成：值有变化立即发；没变化也每 FOCUS_RESEND_MS 补发一次，
   * 让后台最终一致。补发只是一条几十字节的消息，代价可以忽略。
   */
  const FOCUS_RESEND_MS = 5000;
  let lastFocus = "";
  let lastFocusAt = 0;
  function reportFocus(force) {
    try {
      const site = activeSite();
      let id = "";
      if (site && site.focus) {
        try { id = String(site.focus() || ""); } catch (e) { id = ""; }
      }
      const now = Date.now();
      const changed = id !== lastFocus;
      if (!changed && !force && now - lastFocusAt < FOCUS_RESEND_MS) return;
      lastFocus = id;
      lastFocusAt = now;
      post({ cmd: "focus", kind: id ? "mid" : "", id });
    } catch (e) { /* 忽略 */ }
  }

  function scanMedia() {
    try {
      // 后台标签页不扫：600ms 一轮的全文档查询在隐藏页上纯属浪费电量，
      // 用户切回来时下一轮（≤600ms）就会补齐。
      if (document.hidden) return;
      reportFocus();   // 焦点是「看哪条」，跟扫描同频检查（内部已按变化去重）
      const els = document.querySelectorAll("video, audio");
      for (const el of els) {
        let src = "";
        try { src = el.currentSrc || ""; } catch (e) { /* 忽略 */ }
        if (!src && typeof el.src === "string") src = el.src;
        if (!src) continue;
        // 站点特化（A0 模块化）：装饰视频 / 归属 / 真实地址 / 尺寸，全交给站点对象。
        // 以前这里是 `if (isXhsHost() && el.tagName === "VIDEO") { ... }` 一大块，
        // 每加一个站点就要再抄一遍；现在通用层不认识任何站点。
        const site = activeSite();
        if (site && el.tagName === "VIDEO") {
          if (site.isDecorVideo && site.isDecorVideo(el)) continue;
          if (site.owns && !site.owns(el)) continue;
          // blob: 地址在页面侧根本下不了，换成站点给的真实地址。
          // 拿不到就这一轮跳过（下一轮 600ms 再来），**永远不往上报 blob** ——
          // 否则它会成为该视频唯一的 found（seenSrc 挡着后续），
          // 用户看到「页面视频（录制中）」、存下来还是坏的。
          if (/^blob:/i.test(src) && site.videoSrc) {
            const real = site.videoSrc(el);
            if (!real) continue;
            src = real;
          }
        }
        handleMediaSrc(el, src);
      }
    } catch (e) { /* 忽略 */ }
  }
  setInterval(scanMedia, 600);
  window.__msScan = scanMedia; // 供调试/测试手动触发
  // 小红书同上：供排查
  window.__msXhsInOtherNote = xhsInOtherNote;
  window.__msXhsBelongs = imgBelongsToCurrentNote;
  window.__msXhsIdInUrl = xhsIdInUrl;
  window.__msXhsAncestorNoteId = xhsAncestorNoteId;
  window.__msXhsVideoSource = xhsVideoSource;
  window.__msXhsVideoReady = xhsVideoReady;
  window.__msXhsNoteTitle = xhsNoteTitle;
  window.__msXhsFeedTitle = xhsFeedTitle;
  window.__msXhsFeedCardImg = xhsFeedCardImg;


  // B 站 __playinfo__ 是 playurl XHR 返回后才挂上 window 的，没有可监听事件，
  // 所以周期轮询；reportBiliDash 内部按 baseUrl 签名去重，几乎零开销。
  setInterval(reportBiliDash, 2500);
  window.__msBiliTitle = biliTitle;          // 供排查「B 站标题取不到」
  window.__msReportBiliDash = reportBiliDash; // 供排查「条目没上报」
  window.__msActiveSite = activeSite;        // 供测试直接调站点钩子（isImageOnly 等）

  // ------------------------------------------------------------ 2d. 图片的 DOM 上下文
  //
  // 图片本身是 webRequest 抓到的（background 里已经有 URL / 大小 / mime），
  // 但它不知道这张图属于哪条消息、叫什么名字、是这条消息里的第几张。
  // 这里在页面里把 DOM 侧的上下文补上，按 URL 发一条 found，
  // background 的 recordPageMedia 会用同一个 URL 当 key 合并进去。
  //
  // 序号（①②③）放在 background 里编，因为那里才是所有 URL 汇合的地方，
  // 这里只负责给每张图一个「同一条消息内的 DOM 顺序」（ord，0 起）。

  const MAX_IMG_CTX = 400;

  /** 从左到右、从上到下：先比 top（容差 8px 容忍同一行的基线差），再比 left */
  function cmpReadingOrder(a, b) {
    const ta = a.rect ? a.rect.top : 0;
    const tb = b.rect ? b.rect.top : 0;
    if (Math.abs(ta - tb) > 8) return ta - tb;
    return (a.rect ? a.rect.left : 0) - (b.rect ? b.rect.left : 0);
  }

  /**
   * 图片的「上下文提示」：给它自己一个准确定位，供 background 判图标。
   *
   * 参考了一段 Playwright 抓图脚本的做法——只看 URL 不够，页头/页脚/侧栏里的
   * 图基本都是站点装饰（logo、徽章、语言切换旗），class/alt 里带 avatar/logo/
   * icon/sprite 的也几乎都是。这里只采信「明确」的信号，拿不准的一律不返回，
   * 避免把真图误杀（宁可漏收图标，不可错杀照片）。
   */
  function imgHint(el) {
    const parts = [];
    try {
      const push = (v) => {
        const s = String(v == null ? "" : v).trim();
        if (s && s.length < 120) parts.push(s);
      };
      push(el.className);
      push(el.id);
      push(el.getAttribute && el.getAttribute("alt"));
      const p = el.parentElement;
      if (p) push(p.className);
    } catch (e) { /* 忽略 */ }
    return parts.join(" ");
  }

  /** 这张图是不是在页头/页脚/侧栏这类「页面外壳」里（Playwright 脚本的 inChrome） */
  function imgInChrome(el) {
    try {
      return !!el.closest("header,nav,footer,aside");
    } catch (e) { return false; }
  }


  /**
   * 把 __INITIAL_STATE__ 里的 imageList 直接上报成 found。
   *
   * 和 DOM 扫描那条路的差别：
   *   · ord 直接取数组下标 —— imageList 的顺序就是作者的发布顺序，
   *     不需要再靠 getBoundingClientRect 猜阅读顺序（轮播里只有首张可见，
   *     其余图的 rect 全是 0，猜不出来）；
   *   · w/h 用 imageList 给的原始像素尺寸（DOM 里懒加载图 naturalWidth=0，
   *     退回 CSS 尺寸也不准）；
   *   · 不再走 imgBelongsToCurrentNote —— imageList 本身就是「这个帖子的图」；
   *   · 仍然带上 title，background 靠 title 判「这条是不是内容」；
   *   · 这里**不做图标判定**，交给 background 的 looksLikeIcon（头像/二维码
   *     的 URL 特征那边也有兜底）。
   */
  // 小红书正文视频的「统一上报」。
  //
  // ⚠️ 2026-10-18 真机教训（用户：「捕捉不到视频了」）：
  // 小红书的 <video> 只有在**点开笔记、播放器挂载之后**才在 DOM 里出现。
  // 从信息流直接点开（新标签页打开 / 首屏还没渲染播放器）时，scanMedia()
  // 那次 600ms 轮询根本没找到元素；等播放器出现时，handleMediaSrc() 还有
  // 两道闸 —— `if (!src) continue;`（currentSrc 还是空的）和 seenSrc 去重 ——
  // 于是这个视频**整场静默**，列表里只剩一个 MSE 的 m1。
  // 现在视频地址与标题都来自 `__INITIAL_STATE__`，和 DOM 无关，所以按
  // noteId 直接报，与 <video> 是否出现无关。scanMedia 那条路保留（补充
  // 宽高/时长），两条路用同一个 URL 当 key，在 background 里自然合并。
  const xhsVidReported = new Map(); // noteId|url -> title 已报过的标题

  function reportXhsVideo(real) {
    const noteId = xhsCurrentNoteId() || "";
    if (!noteId || !real || !real.url) return;
    const url = real.url;
    const title = xhsNoteTitle() || "";
    const prev = xhsVidReported.get(noteId + "|" + url);
    if (prev === title) return; // 同一标题不重复发
    xhsVidReported.set(noteId + "|" + url, title);
    if (xhsVidReported.size > 20) xhsVidReported.delete(xhsVidReported.keys().next().value);
    const payload = {
      cmd: "found", source: "httpmedia", key: url, size: 0,
      mime: "video/mp4", ext: ".mp4",
      w: real.w | 0, h: real.h | 0, dur: real.duration ? Math.round(real.duration / 1000) : 0,
      title, mid: "", ord: 0, ref: "", hint: "xhs-note",
      // noteId 必须带上去：background 靠它把「真实地址 → 帖子」绑定起来，
      // 这样「拦掉 blob/MSE 分片」只对这一个帖子生效，换帖子后新视频照常能抓。
      noteId,
    };
    post(payload);
    // 宽高/时长/序号也走 progress，popup 打开时即使 found 发生在很久以前
    //（background 里已有该条目），这些字段也能补上。
    post({ cmd: "progress", key: url, w: payload.w, h: payload.h, dur: payload.dur, ord: 0, title, hint: "xhs-note", noteId });
    // 同时把「视频没有 <video> 元素」这件事也当作已见，避免之后 handleMediaSrc
    // 再发一条不带 hint 的重复 found。
    try {
      seenSrc.add(url);
      meta.set(url, { w: payload.w, h: payload.h, dur: payload.dur });
      titles.set(url, title);
    } catch (e) { /* 忽略 */ }
  }

  function xhsNoteVideoInfo() {
    // 只有视频帖才有；xhsVideoSource 内部已按 note.type === "video" 判定
    return xhsVideoSource();
  }

  function scanXhsNoteImages(noteImgs) {
    const title = xhsNoteTitle() || "";
    // 视频帖（note.type === "video"）的 imageList 只有一条 —— 就是视频封面，
    // 不是正文配图。正文是那个 mp4。序号要让视频占 ①、封面排后面，
    // 所以这里给封面统一 +1 的偏移（视频侧扫到后用 ord 0 占位）。
    // 不用 type 判断也行，但纯图文帖里 imageList[0] 就是第一张正文图，
    // 加了偏移会出现「①」空号，所以必须按 type 区分。
    const isVideoNote = xhsNoteType() === "video";
    const coverOffset = isVideoNote ? 1 : 0;
    for (let i = 0; i < noteImgs.length; i++) {
      const im = noteImgs[i];
      const src = im.url;
      const ord = i + coverOffset;
      // 视频帖这一条是「视频封面」，不是用户要保存的图片。打上 xhs-cover 让
      // background 能识别出来：默认站点不收，只有白名单（本行）才留
      // —— 用户 m15108「默认不获取视频封面作为一张图片，有需要再特殊处理」。
      // 图文帖仍是正文图，保持 xhs-note，不能误伤。
      const hint = isVideoNote ? "xhs-cover" : "xhs-note";
      const prev = imgCtx.get(src);
      const w = im.w || 0, h = im.h || 0;
      // 只在内容真的变了才上报，避免每 1.2s 重复 post 一条相同载荷
      if (prev && prev.ord === ord && prev.title === title && prev.w === w && prev.h === h
        && prev.hint === hint) continue;
      imgCtx.set(src, { mid: "", title, ord, w, h, hint, inChrome: false });
      if (imgCtx.size > MAX_IMG_CTX) imgCtx.delete(imgCtx.keys().next().value);
      post({
        cmd: "found", source: "imgctx", key: src, mime: "image/*", size: 0,
        mid: "", title, ord, w, h, hint, inChrome: false,
      });
    }
  }

  function scanImages() {
    try {
      if (document.hidden) return;
      // 站点「完整清单」通路（A0 模块化）：小红书详情页的 __INITIAL_STATE__.imageList
      // 比 DOM 扫描全（懒加载图在 DOM 里根本没解码、尺寸是 0），也天然只含当前帖子。
      // 站点报完了就 return，DOM 扫描整个跳过；报不出来（页面结构变了）自动退回老逻辑。
      const site = activeSite();
      if (site && site.onScanImages && site.onScanImages()) return;
      const els = [...document.querySelectorAll("img")];
      // 一次扫描内先算好位置，避免每张图各调一次 getBoundingClientRect
      const rows = els.map((el) => {
        let r = null;
        try { r = el.getBoundingClientRect(); } catch (e) { /* 忽略 */ }
        return { el, rect: r };
      });
      // 按消息分组 → 组内按阅读顺序排 → 写回 ord
      const byMsg = new Map();
      for (const row of rows) {
        const el = row.el;
        let src = "";
        try { src = el.currentSrc || el.src || ""; } catch (e) { /* 忽略 */ }
        // blob: 的图也要：Telegram 把消息里的照片 fetch 回来 createObjectURL
        // 后才塞给 <img>，webRequest 只看得到那次 fetch（有时连 fetch 都不走
        // SW 缓存），DOM 上下文只有这里能补。真图（消息内容）跟图标（UI 装饰）
        // 靠 background 里的归属判定区分。
        if (!src || !/^(https?:|blob:)/i.test(src)) continue;
        // 站点特化（A0 模块化）：
        //   · isDecorImg —— 装饰图（小红书头像/logo/二维码；评论区贴图）直接跳过。
        //     两条独立判据都实现在站点对象里（URL 带 /comment/ + DOM 在评论容器里），
        //     前者防前端改版后 class 变了，后者防 URL 格式变了。
        //   · 详情页还要再按 CDN 大图签名筛一层——别的帖子的正文配图也是同一个
        //     1040g 签名，只靠 URL 区分不开，所以签名筛选和归属判定一起做。
        if (site) {
          if (site.isDecorImg && site.isDecorImg(el, src)) continue;
          if (site.isImageOnly && !site.isImageOnly(el, src)) continue;
          if (site.owns && !site.owns(el)) continue;
        }
        // 头像 / 贴纸是 Telegram 的 UI 装饰或非「照片内容」，不当作可保存的图片上报。
        // Avatar 类名（成员头像圆圈）、sticker 类名（消息里的贴纸）都跳过，
        // 否则会混进图片列表，且 guessTitle 会抓到频道标题之类垃圾（m03690 混在一起）。
        const cls = String(el.className || "");
        if (/\bAvatar\b|avatar-media|sticker-/i.test(cls)) continue;
        // Telegram 自带的 emoji（/a/img-apple-64/）和 UI 素材（/a/assets/ 的 svg/色块/占位图）
        // 是站点图标/占位，永远不是用户可保存的照片 —— 直接跳过，别交给 background 猜。
        if (/\/a\/img-apple-64\//i.test(src)
          || (/\/a\/assets\//i.test(src) && /\.svg$|blank-/i.test(src))) continue;
        const ctx = mediaContext(el);
        const key = ctx.mid || "__nomid__";
        if (!byMsg.has(key)) byMsg.set(key, []);
        byMsg.get(key).push({ row, src, ctx });
      }
      for (const list of byMsg.values()) {
        list.sort((a, b) => cmpReadingOrder(a.row, b.row));
        for (let i = 0; i < list.length; i++) {
          const { row, src, ctx } = list[i];
          const el = row.el;
          let w = 0, h = 0;
          try {
            w = el.naturalWidth || 0;
            h = el.naturalHeight || 0;
          } catch (e) { /* 忽略 */ }
          if (!w || !h) {
            // 懒加载还没解码出来时退回 CSS 尺寸，至少能把 40×40 的图标认出来
            w = Math.round(row.rect ? row.rect.width : 0);
            h = Math.round(row.rect ? row.rect.height : 0);
          }
          const title = guessTitle(el) || "";
          const hint = imgHint(el);
          const inChrome = imgInChrome(el);
          // blob: 图标 mime：createObjectURL 时的 obj.type 大多带 image/jpeg
          const rec = /^blob:/i.test(src) ? blobs.get(src) : null;
          const mime = (rec && rec.type) || "image/*";
          const size = (rec && rec.size) || 0;
          const prev = imgCtx.get(src);
          if (!prev || prev.ord !== i || prev.title !== title || prev.w !== w || prev.h !== h
            || prev.hint !== hint || prev.inChrome !== inChrome) {
            imgCtx.set(src, { mid: ctx.mid, title, ord: i, w, h, hint, inChrome });
            if (imgCtx.size > MAX_IMG_CTX) imgCtx.delete(imgCtx.keys().next().value);
            post({ cmd: "found", source: "imgctx", key: src, mime, size, mid: ctx.mid, title, ord: i, w, h, hint, inChrome });
          }
        }
      }
    } catch (e) { /* 忽略 */ }
  }
  setInterval(scanImages, 1200);
  window.__msImgScan = scanImages; // 供调试/测试手动触发

  // ------------------------------------------------------------ 3. 原生媒体请求（fetch / XHR）

  /** 判断一个请求是不是「流媒体」：看 URL 特征，再用 Range 嗅探响应头 */
  const MEDIA_HINT = /(progressive|stream|video|audio|playback|media|document)/i;
  const NOT_MEDIA = /(\.js|\.css|\.woff2?|\.ttf|\.png|\.jpg|\.jpeg|\.webp|\.gif|\.svg|\.json|\.html)(\?|$)/i;

  function noteMediaResp(url, ct, size, status) {
    if (!ct) return;
    const m = ct.toLowerCase();
    if (!m.startsWith("video/") && !m.startsWith("audio/")) return;
    const rec = mediaSeen.get(url) || { kind: m.startsWith("audio/") ? "audio" : "video", ct: m, size: 0, ts: 0, ref: "" };
    rec.ct = m;
    if (size) rec.size = size;
    rec.status = status;
    rec.ts = Date.now();
    rec.kind = m.startsWith("audio/") ? "audio" : "video";
    mediaSeen.set(url, rec);
    if (mediaSeen.size > MAX_MEDIA) mediaSeen.delete(mediaSeen.keys().next().value);
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (url && MEDIA_HINT.test(url) && !NOT_MEDIA.test(url)) {
          p.then((resp) => {
            try {
              const ct = (resp.headers.get("content-type") || "").toLowerCase();
              // Range 嗅探时浏览器会隐藏 Range/Content-Range 头，只能记 content-length
              const len = Number(resp.headers.get("content-length") || 0);
              noteMediaResp(resp.url || url, ct, len, resp.status);
            } catch (e) { /* 忽略 */ }
          }).catch(() => {});
        }
      } catch (e) { /* 忽略 */ }
      return p;
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && typeof XHR.prototype.open === "function") {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      try { this.__msUrl = String(url); } catch (e) { /* 忽略 */ }
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      try {
        const url = this.__msUrl || "";
        if (url && MEDIA_HINT.test(url) && !NOT_MEDIA.test(url)) {
          this.addEventListener("loadend", () => {
            try {
              // getResponseHeader 在两种情况下会返回 null：响应头不存在，
              // 或跨域响应里服务器没在 Access-Control-Expose-Headers 里列出它。
              // 后者是 XHR 的正常行为，不能当成异常，所以统一 || "" 兜住。
              const ct = String(this.getResponseHeader("content-type") || "").toLowerCase();
              const cr = String(this.getResponseHeader("content-range") || "");
              const tot = /\/(\d+)\s*$/.exec(cr);
              noteMediaResp(url, ct, tot ? Number(tot[1]) : 0, this.status);
            } catch (e) { /* 忽略 */ }
          });
        }
      } catch (e) { /* 忽略 */ }
      return origSend.apply(this, arguments);
    };
  }

  // ------------------------------------------------------------ 4. MSE 捕获

  function cleanMime(mime) {
    return (mime || "video/mp4").split(";")[0].trim();
  }

  const MS = window.MediaSource;
  if (MS && MS.prototype && typeof MS.prototype.addSourceBuffer === "function") {
    const origAdd = MS.prototype.addSourceBuffer;
    MS.prototype.addSourceBuffer = function (mime) {
      const sb = origAdd.call(this, mime);
      try { hookSourceBuffer(sb, mime); } catch (e) { /* 忽略 */ }
      return sb;
    };
  }

  function hookSourceBuffer(sb, mime) {
    const id = "m" + (++seq);
    const entry = { id, mime: cleanMime(mime), chunks: [], size: 0, ts: Date.now(), last: Date.now() };
    mse.set(id, entry);
    post({ cmd: "found", source: "mse", key: id, size: 0, mime: entry.mime, ext: extOf(entry.mime), live: true });

    const origAppend = sb.appendBuffer;
    let lastReport = 0;
    sb.appendBuffer = function (data) {
      try {
        // 两层限制：单条不超过 MAX_MSE_ENTRY，且所有 MSE 总和不超过 MAX_MSE_TOTAL。
        // 只限单条时，页面开 5 个播放器就是 5 份，照样能把标签页撑爆。
        if (data && entry.size < MAX_MSE_ENTRY && mseBytes < MAX_MSE_TOTAL) {
          let buf;
          if (data instanceof ArrayBuffer) buf = data.slice(0);
          else if (ArrayBuffer.isView(data)) buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          if (buf) {
            entry.chunks.push(buf);
            entry.size += buf.byteLength;
            mseBytes += buf.byteLength;
            const now = Date.now();
            entry.last = now;
            if (now - lastReport > 900) {
              lastReport = now;
              post({ cmd: "progress", key: id, size: entry.size, state: "growing" });
            }
          }
        }
      } catch (e) { /* 忽略 */ }
      entry.ctx = null;
      return origAppend.call(this, data);
    };
  }

  // MSE 分片没有 TTL 时会一直躺着：页面切走、用户不保存，那 512MB 就白占。
  // 30 分钟没新数据就回收（暂停很久再点保存才会受影响，概率远低于 OOM）。
  setInterval(() => {
    const now = Date.now();
    for (const [id, e] of mse) {
      if (now - (e.last || e.ts || 0) > MSE_TTL) {
        mseBytes = Math.max(0, mseBytes - (e.size || 0));
        mse.delete(id);
      }
    }
  }, 60 * 1000);

  // ------------------------------------------------------------ 本地下载器桥（经 content.js → background → Native Host）


  // ------------------------------------------------------------ 4b. 与本地下载器的端口（见 sniffer-hostport.js）

  const HOSTPORT = (() => {
    if (window.__msHostPort) return window.__msHostPort;
    // 兜底：单文件注入（调试 / 老版本）时自己建一个
    const post = (data) => {
      try { window.postMessage(Object.assign({ __ms_sniffer_cmd: true }, data), "*"); } catch (e) { /* 忽略 */ }
    };
    const p = {
      listeners: [],
      send(payload) { post({ cmd: "host-send", payload }); },
      deliver(msg) { for (const fn of this.listeners.slice()) { try { fn(msg); } catch (e) { /* 忽略 */ } } },
      disconnected(err) {
        for (const fn of this.listeners.slice()) { try { fn({ __disconnected: true, error: err }); } catch (e) { /* 忽略 */ } }
        this.listeners.length = 0;
      },
      on(fn) { this.listeners.push(fn); },
      off(fn) { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); },
    };
    window.__msHostPort = p;
    return p;
  })();

  // ------------------------------------------------------------ 5. Range 链下载（核心）

  const CHUNK = 512 * 1024; // 一个 Range 请求最多能拿到多少（多要也会被 SW 截断）
  // 同时在途的分段数。实测 Telegram 的 SW 对这个很敏感（同一文件 4 段并发）：
  //   4 并发  → 891ms      ← 只有它敢叫「快」
  //   8 并发  → 4620ms     ← 5 倍慢，曾经就是这里的默认值
  //   16 并发 → 8404ms     ← 再翻一倍，纯排队
  // 原因是 SW 把它们串行回源，并发越多每个请求等越久。放宽到 8 反而让
  // 8.8MB（18 段）看着像卡死在 17%。降到 4 之后单段快 5 倍，总时长反而更短。
  const PARALLEL = 4;       // 同时在途的分段数（Telegram 这种 SW 流的最优值，见上）
  const MAX_CHUNK = 16 * 1024 * 1024;

  // ---- 直连 CDN 的「放大档」：分块 4MB × 6 并发 ----------------------------
  // 512KB×4 是照着 Telegram 那个串行回源的 SW 调出来的，对 B 站这种直连 CDN
  // 完全是浪费：每个 Range 请求有 ~700-1400ms 的固定开销，512KB 的段摊不开。
  // 真机基准（BV1GJ411x7h7，固定 16MB 工作量，单位 MB/s）：
  //   512K×4 → 1.07（现行）  1M×8 → 2.90   4M×6 → 3.12   8M×8 → 3.41
  // 取 4M×6 而不是最快的 8M×8：8MB×8 路在途是 64MB 堆，页面上还有播放器在跑，
  // 容易触发 GC 掉帧；4M×6 = 24MB，3.12MB/s 已经比原来快约 3 倍。
  // 只在「确认不是 SW 流」时才放大（见 runRangeDownload 里 bigChunk 的判断）。
  const BIG_CHUNK = 4 * 1024 * 1024;
  const BIG_PARALLEL = 6;

  // ---- 单次 fetch 的超时上限 ------------------------------------------------
  // fetch() 本身**没有超时**：CDN 把 TCP 连接挂住不回响应时，Promise 永远 pending，
  // 页面上就停在「正在读取媒体信息… · 等待数据…」，等一天也不会动（真机截图即此）。
  // 所以每一次请求都必须自己掐表。
  //   首段（探针）给 20s —— 它同时承担「问总长度」，有些 CDN 首字节就是慢；
  //   后续分段给 40s —— 4MB 段在 100KB/s 的弱网下要 40s，再短会误杀大分段。
  // 超时按可重试的网络错误处理（换凭据模式再试），不当作致命错误。
  const FETCH_TIMEOUT_PROBE = 20 * 1000;
  const FETCH_TIMEOUT_CHUNK = 40 * 1000;
  // 「读取媒体信息」阶段超过这么久还没拿到任何字节，就在阶段行补一句提示，
  // 让用户知道可以点取消，而不是以为扩展死了。
  const PROBE_HINT_AFTER = 8 * 1000;

  /**
   * 这个地址是不是「直连 CDN」（不是 Telegram 那种 Service Worker 代理流）。
   * 只有直连 CDN 才敢用大分段 + 高并发；SW 流放大反而慢 5 倍以上。
   * B 站的 m4s 分散在 *.bilivideo.com / *.bilivideo.cn / *.mountaintoys.cn /
   * *.szbdyd.com 等多个 CDN 域名上，所以按后缀匹配，不写死某一个。
   */
  const DIRECT_CDN = /(^|\.)(bilivideo\.com|bilivideo\.cn|mountaintoys\.cn|szbdyd\.com|bilibili\.com|hdslb\.com)$/i;
  function isDirectCdnKey(url) {
    try {
      const h = new URL(url, location.href).hostname;
      return DIRECT_CDN.test(h);
    } catch (e) {
      return false;
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Uint8Array → base64 字符串（写盘通路用，见 writeNext 的说明）。
   * 不能直接 btoa(String.fromCharCode(...bytes))：4MB 一段时展开参数会爆栈
   * （V8 的参数个数上限约 6.5 万），必须分块喂。
   * 分块长度取 3 的倍数，每块单独 btoa 再拼，不会出现跨块 padding。
   * btoa 在页面主世界里一定有；Node 沙箱（测试）里没有，用 Buffer 兜一层。
   */
  const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function b64EncodeChunk(bytes) {
    if (typeof btoa === "function") {
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
      }
      return btoa(s);
    }
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
    // 最后的兜底：手写编码（很慢，只在既没 btoa 又没 Buffer 的怪环境里用）
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63]
        + (b === undefined ? "=" : B64_CHARS[(n >> 6) & 63])
        + (c === undefined ? "=" : B64_CHARS[n & 63]);
    }
    return out;
  }

  function bytesToBase64(bytes) {
    const CH = 0x8000 * 3; // 98304 字节，能被 3 整除 → 每块编码后无 "=" 补位
    if (bytes.length <= CH) return b64EncodeChunk(bytes);
    let out = "";
    for (let i = 0; i < bytes.length; i += CH) {
      out += b64EncodeChunk(bytes.subarray(i, Math.min(i + CH, bytes.length)));
    }
    return out;
  }

  function fmtBytes(n) {
    if (!n) return "0 B";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + " " + u[i];
  }

  /**
   * 发一个 Range 请求，读完整条响应，返回 ArrayBuffer。
   *
   * credentials 要按站点区分，不能一律 include：
   *   - Telegram 的 /a/progressive/ 走 Service Worker，必须带 cookie（include），
   *     不带就是 TypeError: Failed to fetch。
   *   - B 站的 CDN（*.bilivideo.cn / *.mountaintoys.cn 等）反过来，它的
   *     Access-Control-Allow-Origin 不认带凭据的跨域请求，include 直接
   *     Failed to fetch，必须 omit。（BV1oMpm6QEQR 就是这么挂的）
   * 所以先按 include 试，被 CORS/网络层拒掉就降级成 omit 再试一次。
   * 注意：不是 HTTP 状态码，是 TypeError，拿不到 res.status。
   *
   * cache 同理要按站点区分（实测 B 站 CDN 上差异巨大）：
   *   force-cache → 7409ms／段      ← 慢到 43 段要下好几分钟，看着像卡死
   *   no-cache    → 1127ms／段
   *   默认        → 465ms／段
   *   reload      → 32ms／段        ← 正确选择
   * Telegram 那种小流用 force-cache 有好处（复用 SW 缓存），但 B 站这种
   * 直连 CDN 的分段流必须 reload，否则每个 chunk 都白等 7 秒。
   * 判断依据：不需要凭据的跨域 CDN（即降级到 omit）就说明不是 SW 流，用 reload。
   */
  /**
   * 带超时的 fetch。fetch() 自己不会超时——CDN 挂住连接时 Promise 永远 pending。
   *
   * 外层 signal 中止时抛 AbortError（真取消）；自己掐表打断时抛带 `timeout` 标记的
   * 普通 Error，调用方可以当成「可重试的网络错误」。
   */
  async function fetchWithTimeout(url, opts, ms) {
    const outer = opts && opts.signal;
    const ctrl = new AbortController();
    let fired = false;
    const onOuterAbort = () => { try { ctrl.abort(); } catch (e) { /* 忽略 */ } };
    if (outer) outer.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => { fired = true; try { ctrl.abort(); } catch (e) { /* 忽略 */ } }, ms);
    try {
      return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    } catch (e) {
      if (outer && outer.aborted) throw new DOMException("aborted", "AbortError");
      if (fired) throw Object.assign(new Error(`请求超时（${Math.round(ms / 1000)}s 无响应）`), { timeout: true });
      throw e;
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener("abort", onOuterAbort);
    }
  }

  async function fetchRange(url, start, end, signal) {
    let lastErr = null;
    // 顺序：omit 优先（B 站 CDN 这种直连 CDN 一次就成，且能用 reload 走缓存旁路），
    // 失败再升级到 include（Telegram 的 SW 流必须带凭据）。
    // 反过来先试 include 的话，B 站每次都要等 CORS 预检超时（实测 3+ 秒），
    // 43 段下来就是几十分钟，看起来就是「卡住不动」。
    let mode = "omit";
    for (let attempt = 0; attempt < 4; attempt++) {
      if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
      // 每次请求自带上限。fetch 本身**没有任何超时**：CDN 把连接挂住不回响应时，
      // 这个 Promise 永远 pending，页面浮层就停在「正在读取媒体信息… / 等待数据…」
      // 一整天（用户真机截图就是这个状态）。首段给得宽松一点，后续分段更短。
      const timeout = attempt === 0 ? FETCH_TIMEOUT_PROBE : FETCH_TIMEOUT_CHUNK;
      const timer = { id: 0, fired: false };
      const ctrl = new AbortController();
      const onOuterAbort = () => { try { ctrl.abort(); } catch (e) { /* 忽略 */ } };
      if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
      timer.id = setTimeout(() => { timer.fired = true; try { ctrl.abort(); } catch (e) { /* 忽略 */ } }, timeout);
      try {
        // omit 模式下（B 站这类直连 CDN）用 reload 绕开缓存查询，实测快 200 倍以上。
        // include 模式（Telegram 的 SW 流）实测 no-store 比 force-cache 快一倍：
        //   未缓存段 force-cache → 6291ms    no-store → 3673ms
        // force-cache 会让 SW 先查一遍缓存再回源，未命中时段段都要多绕一圈。
        //
        // ⚠️ 2026-10-18 真机（小红书 CDN）：
        //   · default 缓存模式 → 5ms（浏览器直接给内存缓存，最快，也不报错）
        //   · no-store / reload → 250~380ms（真的回源）
        //   · credentials:"include" → `TypeError: Failed to fetch`（小红书 CDN 的
        //     ACAO 不回 credentials，带凭据的请求被 CORS 直接拒掉）
        // 所以：omit + default 是小红书这类 CDN 的最优组合；Telegram 的 SW 流
        // 必须 include，那边仍然用 no-store（实测比 force-cache 快一倍）。
        // 回源需求靠 Range 头本身满足（每段 Range 不同，缓存不会命中错段）。
        const cacheMode = mode === "omit" ? "default" : "no-store";
        const res = await fetch(url, {
          cache: cacheMode,
          credentials: mode,
          headers: { Range: `bytes=${start}-${end}` },
          signal: ctrl.signal,
        });
        if (res.status !== 206 && res.status !== 200) {
          // 4xx 不要了；5xx/429 重试
          if (res.status >= 400 && res.status < 500 && res.status !== 429) {
            throw Object.assign(new Error("HTTP " + res.status), { fatal: true });
          }
          throw new Error("HTTP " + res.status);
        }
        // 必须整包读完：让连接归还连接池，否则 8 路分段会把同源连接占满
        const buf = await res.arrayBuffer();
        return {
          buf,
          cr: res.headers.get("content-range") || "",
          full: res.status === 200,
          len: res.headers.get("content-length") || "",
        };
      } catch (e) {
        // 外层 signal 中止 → 真的取消，直接往外抛
        if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
        if (e.name === "AbortError" && !timer.fired) throw e;
        // 自己超时打断的，当成一次可重试的网络错误（fetch 会抛 AbortError）
        if (timer.fired) {
          lastErr = new Error(`请求超时（${Math.round(timeout / 1000)}s 无响应）`);
        } else {
          if (e.fatal) throw e;
          lastErr = e;
        }
        // 网络层直接拒掉（跨域凭据不匹配时就是 TypeError: Failed to fetch）：
        // omit 被拒就升级 include（Telegram 的 SW 流需要凭据），反之亦然。
        const wasOmit = mode === "omit";
        mode = wasOmit ? "include" : "omit";
        // 换个凭据模式重试一次，别把时间全耗在同一条路上
        if (timer.fired && !wasOmit) await sleep(150);
        else await sleep(250 * (attempt + 1));
      } finally {
        clearTimeout(timer.id);
        if (signal) signal.removeEventListener("abort", onOuterAbort);
      }
    }
    throw lastErr || new Error("Range 请求失败");
  }

  /**
   * 从 fMP4 的 sidx box 算总字节数（B 站 / DASH 流的最后手段）。
   *
   * 为什么需要：B 站 CDN 的 206 响应**只有 content-length，没有 content-range**，
   * 而 content-length 是「这次请求要了多少」，不是文件总长；HEAD 和 `bytes=-1`
   * 又被 CORS 拒（带不带凭据都是 TypeError）。所以三条常规路全废，
   * 只能读 init+indexRange 那一段，解析出每条 segment 的 size 累加。
   *   version 0: earliest_presentation_time(4) + first_offset(4)
   *   version 1: earliest_presentation_time(8) + first_offset(8)
   * 布局：[size4][sidx4][ver1][flags3][refID4][timescale4][...时间...][reserved2]
   *       [ref_count2][每项 12 字节: ref_type+size4, duration4, SAP4]
   * 返回 total（含 init + index 段自身），解析不出来返回 0。
   */
  function parseSidxTotal(sidxBuf, initRange, indexRange) {
    const buf = new Uint8Array(sidxBuf);
    if (buf.length < 32) return 0;
    let off = -1;
    for (let i = 0; i + 8 <= buf.length; i++) {
      if (buf[i + 4] === 0x73 && buf[i + 5] === 0x69 &&
          buf[i + 6] === 0x64 && buf[i + 7] === 0x78) { off = i; break; }
    }
    if (off < 0) return 0;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    try {
      const ver = dv.getUint8(off + 8);
      let p = off + 20;
      p += ver === 0 ? 8 : 16;
      p += 2; // reserved
      const refCount = dv.getUint16(p); p += 2;
      if (!refCount || p + refCount * 12 > buf.length) return 0;
      let payload = 0;
      for (let i = 0; i < refCount; i++) payload += dv.getUint32(p + i * 12) & 0x7fffffff;
      // 总长 = 首段媒体字节的偏移 + 所有媒体段之和。
      // indexRange 给的是闭区间下标（"933-1368"），所以首个媒体段从 1369 开始；
      // 没有 indexRange（sidx 就在 0 号位）时用 sidx box 自身的结束位置。
      const lead = indexRange ? indexRange[1] + 1 : off;
      return lead + payload;
    } catch (e) { return 0; }
  }

  /**
   * 问出媒体总长度。Telegram 的 /progressive/ 流不给 Content-Length，
   * Content-Range 也是 `bytes 0-524287/*` 这种不带总长的形式，只能从上往下试：
   *   1) 响应头里的 Content-Range 尾部的总长，或 Content-Length
   *   2) HEAD 请求（部分站点只在 HEAD 上给）
   *   3) Range: bytes=-1 —— 有的服务端只在尾字节请求里补总长
   *   4) B 站这类 DASH 流：读 SegmentBase 的 indexRange 解析 sidx
   * 全失败就返回 0，交给调用方走普通 GET。
   * `probe.sidx` / `probe.initRange` / `probe.indexRange` 由调用方（B 站分支）传入。
   */
  async function probeTotal(key, signal, probe) {
    const fromCR = (s) => {
      const m = /\/(\d+)\s*$/.exec(s || "");
      return m ? Number(m[1]) : 0;
    };
    const fromRange = (r) => {
      const m = /^(\d+)\s*-\s*(\d+)$/.exec(r || "");
      return m ? [Number(m[1]), Number(m[2])] : null;
    };
    let n = fromCR(probe && probe.cr);
    if (n) return n;
    // 注意：content-length 在 Range 响应里只是本段长度，只有 200 全量响应才可信。
    // 调用方传 probe.full 表示这是整包响应。
    if (probe && probe.full) {
      const cl = Number((probe && probe.len) || 0);
      if (cl > 0) return cl;
    }

    // HEAD 和尾字节探测同样要兼容「带凭据被拒」的 CDN（见 fetchRange 的注释）。
    // 顺序很重要：先 omit 后 include。
    //   实测 B 站 CDN：HEAD omit 28ms 就明确失败，HEAD include 要等 3350ms 才失败。
    //   Telegram 的 SW 流反过来——omit 也失败，但它那路第一次 include 就能成。
    //   所以先用最便宜的 omit 探一下，失败立刻换 include，不会浪费时间。
    const tries = ["omit", "include"];
    for (const cred of tries) {
      try {
        // HEAD 也要掐表：CORS 预检挂住时同样会永远 pending
        const res = await fetchWithTimeout(key, { method: "HEAD", credentials: cred, signal }, FETCH_TIMEOUT_PROBE / 2);
        n = fromCR(res.headers.get("content-range")) || Number(res.headers.get("content-length") || 0);
        if (n > 0) return n;
        break;
      } catch (e) {
        if (e && e.name === "AbortError") throw e;
      }
    }

    for (const cred of tries) {
      try {
        const res = await fetchWithTimeout(key, {
          // 同 fetchRange 的理由：omit 直连 CDN 用 reload，否则单次要等 7 秒；
          // include 走 SW 流时用 no-store（force-cache 未命中会慢一倍，实测）
          cache: cred === "omit" ? "reload" : "no-store",
          credentials: cred, signal,
          headers: { Range: "bytes=-1" },
        }, FETCH_TIMEOUT_PROBE / 2);
        if (res.status === 206) {
          n = fromCR(res.headers.get("content-range"));
          // 尾字节请求只读走 1 个字节，但响应体要消费掉，否则连接不归还连接池
          try { await res.arrayBuffer(); } catch (e) { /* 忽略 */ }
          if (n > 0) return n;
        }
        break;
      } catch (e) {
        if (e && e.name === "AbortError") throw e;
      }
    }

    // 4) DASH：解析 sidx。B 站分支会直接给现成的 sidx 字节；
    //    没给就按 indexRange 自己读一段。
    let sidx = probe && probe.sidx;
    const indexRange = fromRange(probe && probe.indexRange);
    if (!sidx && indexRange) {
      try {
        const r = await fetchWithTimeout(key, {
          headers: { Range: `bytes=${indexRange[0]}-${indexRange[1]}` },
          credentials: "omit", signal,
        }, FETCH_TIMEOUT_PROBE / 2);
        if (r.status === 206 || r.status === 200) sidx = await r.arrayBuffer();
      } catch (e) { if (e && e.name === "AbortError") throw e; }
    }
    if (sidx) {
      n = parseSidxTotal(sidx, fromRange(probe && probe.initRange), indexRange);
      if (n > 0) return n;
    }
    return 0;
  }

  /**
   * 下载整条流：Range 链 + 并行 + 断点续传次数有上限。
   * 返回 {ok, total, received, bytes}
   */
  async function runRangeDownload(opts) {
    const { key, name, onProgress, signal, hooks } = opts;
    const onStage = opts.onStage;
    const stage = (t, p) => { try { onStage && onStage(t, p); } catch (e) { /* 忽略 */ } };
    const ctx = hooks || {};
    // 放大档只在两种情况下启用：
    //   - hooks.big === true（调用方明确知道是直连 CDN，比如 B 站的 m4s）
    //   - 或者 URL 是 B 站的 CDN 域名（*.bilivideo.cn / *.mountaintoys.cn / *.bilibili.com）
    // Telegram 那条 SW 流必须留在 512KB×4，否则会从 891ms/段 退化成 4620ms/段。
    const big = opts.big === true || (ctx.big !== false && isDirectCdnKey(key));
    let chunkSize = big ? BIG_CHUNK : CHUNK;
    const parallel = big ? BIG_PARALLEL : PARALLEL;
    let cb = chunkSize;
    let total = 0;
    let first = null;

    // ---- 1) 第一个分段同时充当探针：拿到 /total 和文件头
    log(`读取媒体信息 ${key}`);
    const probeLabel = ctx.kind === "audio" ? "正在读取音频信息…" : "正在读取媒体信息…";
    stage(probeLabel);
    // 首段可能要等 CORS 预检 + 首字节；超过 PROBE_HINT_AFTER 还没回来就补一句
    // 「仍在连接…」，配合下面的超时，用户至少知道它没死、也能点取消。
    const probeHintAt = Date.now();
    const probeHintTimer = setInterval(() => {
      const s = Math.round((Date.now() - probeHintAt) / 1000);
      if (s >= PROBE_HINT_AFTER / 1000) stage(`${probeLabel}（已等 ${s}s，仍在连接，可点取消）`);
    }, 1000);
    let probe = null;
    try {
      // 注意 fetchRange 的 end 是**包含式**的：要 cb 个字节就得到 cb-1。
      // 这里原来传的是 cb，多要了 1 个字节，导致首段长度和后续段长对不上。
      probe = await fetchRange(key, 0, cb - 1, signal);
    } catch (e) {
      if (e.name === "AbortError") throw e;
      // 放大档首段就失败：很可能这个 CDN 不接受大 Range，退回保守档重试一次
      if (big) {
        log(`大分段请求失败（${String(e.message || e).slice(0, 60)}），退回 512KB 分段`);
        chunkSize = CHUNK;
        cb = CHUNK;
        try {
          probe = await fetchRange(key, 0, cb - 1, signal);
        } catch (e2) {
          if (e2.name === "AbortError") throw e2;
          probe = null;
        }
      }
      if (!probe) {
        // 退回不带 Range 的 fetch（有些站点反而只认普通 GET）。
        // 这条同样要掐表，否则「服务器忽略了 Range」和「服务器根本没回」长得一样。
        log("Range 请求失败，退回普通 fetch：" + (e.message || e));
        const res = await fetchWithTimeout(key, { credentials: "include", signal }, FETCH_TIMEOUT_CHUNK);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const buf = await res.arrayBuffer();
        return { ok: true, total: buf.byteLength, received: buf.byteLength, bytes: buf, filename: name };
      }
    } finally {
      clearInterval(probeHintTimer);
      stage(probeLabel);
    }
    if (!first) first = probe;
    if (probe.full) {
      // 服务器忽略 Range，一次给了完整文件
      const buf = probe.buf;
      log(`服务器不支持 Range，已取得完整数据 ${fmtBytes(buf.byteLength)}`);
      const ext = sniffExt(new Uint8Array(buf.slice(0, 16)));
      const filename = finishName(name, key, ext);
      fireProgress(onProgress, buf.byteLength, buf.byteLength, 0);
      return { ok: true, total: buf.byteLength, received: buf.byteLength, bytes: buf, filename };
    }
    const m = /\/(\d+)\s*$/.exec(probe.cr || "");
    let got = probe.buf.byteLength;
    if (m) total = Number(m[1]);
    // 服务器可能给的比要求的多（B 站 CDN 会多吐 1 个字节，实测 524289），
    // 也可能更小气。两种情况段长都必须按**实收字节数**对齐，否则后续分段的
    // 起始偏移和 written 对不上，pending 里永远「最早那一段不连续」，直接卡死。
    if (got > 0 && got !== cb) cb = got;

    // 总长已知的话，按「段长 × 并发」封顶：太小的文件不值得开大分段
    // （20MB 的 B 站流用 4MB 段正好 5 段，用完 5 路并发；512KB 段要 41 段）
    if (total && big && total < cb) cb = Math.max(64 * 1024, total);

    // 总长未知时（Telegram 的 progressive 流就是这样，既没有 Content-Range 也没有
    // Content-Length）不能拿第一段当全长，否则只能存下前 512KB。用 Content-Range
    // 的 */N 或者 HEAD 问一次，问不出来才按普通 GET 直接读全量。
    if (!total) {
      // hooks 里的 initRange/indexRange（B 站 SegmentBase）要一起交给探测，
      // 否则这种「206 不给 content-range、HEAD 又 CORS 拒」的 CDN 问不出总长。
      total = await probeTotal(key, signal, Object.assign({}, ctx, probe));
      if (total && total < got) total = got;
    }

    if (!total) {
      // 长度实在问不出来：退回普通 GET 一次性读完（只有小文件会走到这里）
      log(`总长度未知，改用普通 GET 读全量 ${key}`);
      const res = await fetchWithTimeout(key, { credentials: "include", signal }, FETCH_TIMEOUT_CHUNK);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const buf = await res.arrayBuffer();
      const ext = sniffExt(new Uint8Array(buf.slice(0, 16))) || guessExtFromType(ctx.ct) || "";
      const filename = finishName(name, key, ext);
      fireProgress(onProgress, buf.byteLength, buf.byteLength, 0);
      return { ok: true, total: buf.byteLength, received: buf.byteLength, bytes: buf, filename };
    }

    // ---- 2) 文件名：从字节头判断扩展名；Telegram 的引用（album/viewer）防重名
    let head = new Uint8Array(probe.buf.slice(0, Math.min(got, 64)));
    // 兜底不再写 ".mp4"：认不出来时宁可没扩展名，也别把一个 JPEG 存成 .mp4
    const ext = sniffExt(head) || guessExtFromType(ctx.ct) || "";
    const filename = finishName(name, key, ext);
    log(`开始下载 ${filename}（${fmtBytes(total)}，分段 ${fmtBytes(cb)}，${parallel} 并发）`);

    // ---- 3) 建本地文件
    const startRes = await hostRequest({ action: "msfile_start", name: filename, total }, signal, 60000);
    if (!startRes || startRes.ok === false) throw new Error("本地下载器无法创建文件: " + ((startRes && startRes.error) || "无响应"));
    const jobId = startRes.id;

    // ---- 4) 并行分段拉流，按序写盘（窗口式，内存里最多 parallel 段）
    const queue = [0];
    for (let s = got; s < total; s += cb) queue.push(s);
    let received = 0;
    let written = 0;
    let abortReason = null;
    const pending = new Map(); // start -> {buf, seq}
    let seqNo = 0;
    let writeChain = Promise.resolve();
    let pokeDone = null; // 由下面的 Promise 内部赋值，供 writeNext 链尾回调用
    let lastTick = Date.now();
    let lastWritten = 0;
    let lastSpeed = 0;

    // 先把探测到的那一段塞进队列
    pending.set(0, { buf: probe.buf, seq: seqNo++ });
    if (got === total) received = got;

    // 分段数据已在内存里，写盘迟到/丢回也要重试而不是整条失败。
    // signal 必须一路透传：用户点「取消」时，若写盘链还挂在 hostRequest 上
    // （本地宿主无响应 = 「卡住」的典型场景），abort 能让它立刻抛 AbortError 退出，
    // 否则 writeChain 会一直等到 90s 超时×3 次重试，「取消」点了跟没点一样。
    const hostWrite = async (payload) => {
      let lastErr = null;
      for (let i = 0; i < 3; i++) {
        if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
        try {
          const r = await hostRequest(payload, signal, 90000);
          if (r && r.ok === false) throw new Error(r.error || "宿主拒绝写入");
          return r;
        } catch (e) {
          if (e && e.name === "AbortError") throw e;
          lastErr = e;
          await new Promise((res) => setTimeout(res, 400 * (i + 1)));
        }
      }
      throw lastErr || new Error("写入失败");
    };

    const writeNext = () => {
      writeChain = writeChain.then(async () => {
        // 一直写到「接不上下一个」为止就退出；等新的段进 pending 后再被调用。
        // 条件是 while 里 k === written 找不到就 break，而不是 pending 空才 break，
        // 因为中间可能有缺口（后面的段先到），此时不能跳过缺口继续写。
        for (;;) {
          // 找「正好接在已写末尾」的那一段。
          // 必须是 k === written，不能是 k >= written：
          // 用 >= 会在中间有缺口时跳过它往下写，结果是文件大小对、内容错位。
          // 用 === 则缺口永远等不到写，靠 pump 的补队列兜底。
          let bestKey = null, bestSeq = Infinity;
          for (const [k, v] of pending) {
            if (k === written && v.seq < bestSeq) { bestSeq = v.seq; bestKey = k; }
          }
          if (bestKey === null) break;
          const item = pending.get(bestKey);
          pending.delete(bestKey);
          if (!item.buf || !item.buf.byteLength) continue;
          // 传输编码：base64 而不是 number 数组。
          // 512KB 一帧，真机实测（probe_chunk.js，BV1GJ411x7h7）：
          //   普通 number 数组 → JSON 1.87MB → 宿主 331ms
          //   {__b64:"…"}   → JSON 699KB → 宿主  43ms   ← 快 7.7 倍
          // 宿主侧 sniffer_host.py 的 do_msfile_chunk 本来就认 __b64，
          // 发 number 数组在 4~6 路并发下会直接把写盘链堵成瓶颈。
          const bytes = item.buf instanceof Uint8Array ? item.buf : new Uint8Array(item.buf);
          const b64 = bytesToBase64(bytes);
          // 关键：written 必须在 await 之前「占位」推进，不能等写盘回来再改。
          // 否则 await 期间另一个 writeNext 回调进来时会看到旧 written，
          // 把同一段（甚至更早的段）再写一遍，落盘顺序就乱了——
          // 表现正是「文件大小对、但内容错位、播不了」。
          const upto = bestKey + bytes.byteLength;
          written = upto;
          try {
            await hostWrite({ action: "msfile_chunk", id: jobId, text: `bytes=${bestKey}-`, data: { __b64: b64 } });
          } catch (e) {
            // 这一段没写进去：回滚占位并放回队列，交给上层判失败
            if (written === upto) written = bestKey;
            pending.set(bestKey, item);
            throw e;
          }
          received = Math.max(received, written);
          const now = Date.now();
          if (now - lastTick > 400) {
            lastSpeed = ((received - lastWritten) * 1000) / (now - lastTick);
            lastTick = now;
            lastWritten = received;
            fireProgress(onProgress, received, total, lastSpeed);
          }
        }
      });
      // 写盘链落定后可能刚好满足完成条件（最后一段往往就是这样收尾的），
      // 所以链尾再催一次。不催的话，若最后几个 pump 在写盘完成前就退出了，
      // 就没有任何地方会再调用 maybeDone，await 永远挂着。
      writeChain.then(() => { if (typeof pokeDone === "function") pokeDone(); });
      return writeChain;
    };

    await new Promise((resolve) => {
      let finished = false;
      let active = 0;
      const finish = (err) => {
        if (finished) return;
        finished = true;
        if (err) abortReason = err;
        resolve();
      };
      // 完成判定的核心：必须满足「队列空 + 没有待写段 + 没有在途请求 + 已写字节等于总长」。
      // 最后一个条件很关键：pending 为空、active 为 0 时，最后一段可能才刚被 hostWrite
      // 提交（written 已占位推进但 Promise 未落定），只靠 queue/pending/active 会漏判，
      // 于是 await 永远不返回 —— 文件其实已经写好了，UI 却停在 99%。
      const maybeDone = () => {
        if (finished) return;
        if (queue.length || pending.size || active > 0) return;
        if (written < total) return; // 还有缺口没补上，等 pump 补队列
        writeChain.then(() => finish(null), (e) => finish(e));
      };
      pokeDone = maybeDone; // 让 writeNext 的链尾也能催一次
      const pump = async () => {
        while (!finished) {
          const s = queue.shift();
          if (s === undefined) break; // 队列空，交给外层 maybeDone 判定
          const e = Math.min(total - 1, s + cb - 1);
          active++;
          try {
            const r = await fetchRange(key, s, e, signal);
            if (!r.buf.byteLength) throw new Error("空分段 @" + s);
            // 服务器实际给的字节数可能和要求的不一样（B 站 CDN 实测多吐 1 字节）。
            // 以「实收字节数」为准：不足的部分补回队列，段长跟着改，
            // 保证后续每个分段的起始偏移都和 written 严丝合缝。
            const real = r.buf.byteLength;
            const want = e - s + 1;
            if (real < want) {
              if (real < cb) cb = Math.max(64 * 1024, real);
              for (let p = s + real; p < total; p += cb) queue.push(p);
            } else if (real > want) {
              // 多给了：只认 want 字节，多的丢弃（否则 written 会跳过后面的段）
              pending.set(s, { buf: r.buf.slice(0, want), seq: seqNo++ });
              writeNext();
              active--;
              maybeDone();
              continue;
            }
            pending.set(s, { buf: r.buf, seq: seqNo++ });
            writeNext();
          } catch (err) {
            finish(err); // AbortError 也走这里
            return;
          }
          active--;
          maybeDone();
        }
        // 队列被别的 pump 抢空了，也要检查一次
        maybeDone();
      };
      if (total <= 0) { finish(new Error("内容长度未知")); return; }
      for (let i = 0; i < parallel; i++) pump();
    });

    await writeChain;
    if (abortReason) {
      await hostRequest({ action: "msfile_abort", id: jobId }, null, 10000);
      if (abortReason.name === "AbortError") throw abortReason;
      throw abortReason;
    }

    fireProgress(onProgress, received, total, lastSpeed);
    const end = await hostRequest({ action: "msfile_end", id: jobId, total: received }, signal, 60000);
    // 落盘长度对不上 = 文件是残的（以前会静默改名成「完整文件」）
    const finalSize = Number(end && end.size) || 0;
    if (finalSize && finalSize !== received) {
      throw new Error(`写入不完整：应 ${fmtBytes(received)}，实际 ${fmtBytes(finalSize)}`);
    }
    return { ok: true, total, received, filename: (end && end.file) || filename, size: received };
  }

  function fireProgress(onProgress, got, total, speed) {
    try { onProgress && onProgress(got, total, speed); } catch (e) { /* 忽略 */ }
  }

  // ------------------------------------------------------------ 5b. B 站：绕开 MSE，直接抓完整流

  /**
   * B 站播放器走 MSE（blob: 地址 + appendBuffer 分期喂数据），扩展能拿到的
   * 只有「已经播放过的那几秒」。用户看到的现象就是：看了 5 秒，存下来的文件
   * 只有 5 秒——但 MP4 的 moov（含全片时长）在文件开头，所以播放器显示的
   * 总时长仍是全片。
   *
   * 正确做法：B 站页面里本来就挂着 `window.__playinfo__`，里面是 DASH 清单
   * （独立的视频流 / 音频流，带备用 CDN）。这些 m4s 地址支持 Range，
   * 用和 Telegram 一样的链式分段抓法整条拉下来即可，与看到了多少无关。
   */
  function biliPlayinfo() {
    try {
      if (window.__playinfo__ && window.__playinfo__.data && window.__playinfo__.data.dash) {
        return window.__playinfo__.data;
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  /** 从播放清单里提当前流的 cid（DASH baseUrl 路径里埋着 cid，如 /upgcxcode/99/91/137649199/…） */
  function biliCidOfData(d) {
    try {
      const vs = (d && d.dash && d.dash.video) || [];
      const top = vs.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
      const m = /upgcxcode\/\d+\/\d+\/(\d+)\//.exec((top && (top.baseUrl || top.base_url)) || "");
      return m ? m[1] : null;
    } catch (e) { return null; }
  }

  /**
   * 当前页面「实际在播」的那一集（分P）的 cid。
   * B 站 SPA 切集时**不会重写 window.__playinfo__，也不会更新 __INITIAL_STATE__.videoData**，
   * 但会实时更新：① window.player.getManifest().cid ② __INITIAL_STATE__ 顶层 cid 字段。
   * 这就是第 ④ 点「切到下一集下载到的还是上一集」的根因与解药。
   * 优先级：manifest（最准）> 顶层 state.cid > videoData.cid（兜底）。
   */
  function biliCurrentCid() {
    try {
      const m = window.player && typeof window.player.getManifest === "function" && window.player.getManifest();
      if (m && m.cid != null) return String(m.cid);
    } catch (e) { /* 忽略 */ }
    try {
      const s = window.__INITIAL_STATE__ || {};
      if (s.cid != null) return String(s.cid);
    } catch (e) { /* 忽略 */ }
    try {
      const vd = (window.__INITIAL_STATE__ || {}).videoData;
      if (vd && vd.cid != null) return String(vd.cid);
    } catch (e) { /* 忽略 */ }
    return null;
  }

  /** 当前分P对应的 aid / bvid（拼 playurl 接口用，从 manifest 或顶层 state 拿） */
  function biliCurrentAidBvid() {
    let aid = null, bvid = null;
    try {
      const m = window.player && typeof window.player.getManifest === "function" && window.player.getManifest();
      if (m) { aid = m.aid; bvid = m.bvid; }
    } catch (e) { /* 忽略 */ }
    try {
      const s = window.__INITIAL_STATE__ || {};
      if (aid == null) aid = s.aid;
      if (bvid == null) bvid = s.bvid;
    } catch (e) { /* 忽略 */ }
    return { aid, bvid };
  }

  /**
   * 用 aid+cid 请求 B 站 playurl 接口，拿到该分P的完整 DASH 清单。
   * 返回 { data: { dash: { video[], audio[] } } } 或 null。
   * fnval=16 要 DASH（音视频分流），fourk=1 允许 4K，qn=64 要最高清晰度。
   */
  async function biliFetchPlayurl(aid, cid, bvid, signal) {
    const q = new URLSearchParams();
    if (aid) q.set("avid", aid);
    if (bvid) q.set("bvid", bvid);
    q.set("cid", cid);
    q.set("qn", "64");
    q.set("fnval", "16");
    q.set("fnver", "0");
    q.set("fourk", "1");
    const url = "https://api.bilibili.com/x/player/playurl?" + q.toString();
    try {
      const resp = await fetch(url, { credentials: "include", signal });
      if (!resp.ok) return null;
      const j = await resp.json();
      if (j && j.code === 0 && j.data && j.data.dash) return j;
      return null;
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      return null;
    }
  }

  /**
   * 下载前保证 window.__playinfo__ 指向「当前在播分P」的清单。
   * 检测 playinfo 里的 cid 是否等于实时 cid，不等就重新请求 playurl 并写回。
   * 写回后 biliPlayinfo() 读到的就是新分P的流，runBiliDownload 自然下对集。
   */
  async function biliEnsureFresh(signal) {
    if (!isBiliHost()) return;
    const curCid = biliCurrentCid();
    if (!curCid) return;
    const d = biliPlayinfo();
    const pinfoCid = biliCidOfData(d);
    if (pinfoCid && String(pinfoCid) === String(curCid)) return; // 已是最新
    const { aid, bvid } = biliCurrentAidBvid();
    const j = await biliFetchPlayurl(aid, curCid, bvid, signal);
    if (j && j.data && j.data.dash) {
      try {
        if (!window.__playinfo__) window.__playinfo__ = {};
        // 只替换 data（playurl 返回的 data 与 __playinfo__.data 同形，含 dash），
        // 不动 __playinfo__ 上的其他字段
        window.__playinfo__.data = j.data;
        log(`已刷新到当前分P（cid=${curCid}）`);
      } catch (e) { /* 忽略 */ }
    }
  }

  /**
   * B 站视频页的完整视频不靠 <video src> 直链，而是 __playinfo__ 的 DASH 清单。
   * 页面的 <video> 走 MSE，只有「播放过」才会 appendBuffer → 才有录制条目；
   * 视频暂停（或刚载入还没播）时 background 里一条 video 都没有，popup 列表
   * 自然全空（HANDOVER 9.11 的「唯一未解决」就是这个）。
   *
   * 所以这里在拿到 __playinfo__ 时就主动上报一条合成条目（哨兵 key），
   * 与 MSE 是否播过无关。background 会把它建成 page=1 的 video 条目，
   * popup 点「保存」走 pageSaveItem → runBiliDownload（它自己读 __playinfo__，
   * 不看 key）。key 用与 popup.js 相同的 BILI_DASH_KEY，避免两边各造一条。
   */
  const BILI_DASH_KEY = "__bili_dash__";
  let biliSig = "";
  function reportBiliDash() {
    if (!isBiliHost()) return;
    const d = biliPlayinfo();
    if (!d || !d.dash || !d.dash.video || !d.dash.video.length) return;
    // 用「当前分P cid + 标题」当签名。SPA 切集时 __playinfo__ 里的 baseUrl 不换，
    // 但 __INITIAL_STATE__.cid / manifest.cid 会实时更新，用它才能发现换集。
    // （第 ④ 点根因：只签 baseUrl 的话，切集后签名不变，popup 标题停在旧集。）
    const cid = biliCurrentCid() || biliCidOfData(d) || "";
    const title = biliTitle();
    // 分P 号必须进签名：同一 bvid 切集时标题常常一字不改（合集里很常见），
    // 只签 cid+title 会出现「换了集但 popup 不刷新」。cid 变了一般够用，
    // 但有些页面切集后 __INITIAL_STATE__ 滞后，这时 p 号是唯一的信号。
    const part = biliPartTag();
    // ⚠️ 标题为空时**不进签名**：否则「先空后有」的两次上报签名相同，
    // 第二次带着好标题的那条会被去重挡掉，popup 就永远显示占位文案。
    const fullSig = cid + "|" + title + "|" + part + "|" + (title ? "t" : "n");
    if (fullSig === biliSig) return;
    biliSig = fullSig;
    // 名字直接拼成「标题-P2」，和 runBiliDownload 里算文件名用的是同一套规则，
    // 这样列表里看到的和存下来的永远一致。
    // 取不到标题就**不发 title 字段**（而不是发 "bilibili"）：popup 拿到空标题时
    // 会保留自己的占位文案，比显示一个假站点名更容易让人看懂「还没取到」。
    const shown = title ? (part ? title + part : title) : "";
    post({
      cmd: "found", source: "bili", key: BILI_DASH_KEY, size: 0,
      mime: "video/mp4", title: shown,
    });
  }

  /**
   * B 站视频标题 —— 三级来源，从稳到脆：
   *
   *   ① `__INITIAL_STATE__.videoData.title` / `__INITIAL_STATE__.h1Title`
   *      B 站把页面数据整体塞进这个全局对象，标题是里面的一等字段，
   *      **不随 DOM 改版失效**。这是主来源（和小红书读 imageList 同一个思路）。
   *   ② DOM 选择器：只作兜底。站内改版极频繁（2025 年把 h1.video-title 换成了
   *      #arc_toolbar_report 下的一套），所以新旧两代都列上，按「新的在前」排。
   *   ③ `<title>` 剥后缀。还在加载/SPA 刚切换时前两级都可能是空的。
   *
   * 三个都不中才 return ""（**不再返回 "bilibili"**：那个字符串会让
   * popup 里出现一条名叫 bilibili 的条目，用户没法判断是标题没取到还是站点名）。
   */
  function biliTitle() {
    // ① __INITIAL_STATE__（最稳）
    try {
      const s = window.__INITIAL_STATE__ || {};
      const vd = s.videoData || {};
      const cands = [
        vd.title,
        s.h1Title,
        vd.pages && vd.pages[0] && vd.pages[0].part,   // 合集页的「第 N 话 标题」
        s.epInfo && s.epInfo.title,                     // 番剧单集
        s.mediaInfo && s.mediaInfo.title,               // 番剧总标题
      ];
      for (const c of cands) {
        const t = cleanBiliTitle(typeof c === "string" ? c : "");
        // _INITIAL_STATE__ 里的标题不带站点后缀，但可能是纯空白；过短的也不要
        if (t && t.length > 1) return t;
      }
    } catch (e) { /* 忽略 */ }

    // ② DOM 兜底（新版在前）
    const pick = (sel) => {
      try {
        const n = document.querySelector(sel);
        const t = n ? (n.textContent || "").trim() : "";
        return t.length > 1 ? t : "";
      } catch (e) { return ""; }
    };
    const sels = [
      // 新版（2025 起）：标题在 #arc_toolbar_report 或 .video-info-title 里
      "#arc_toolbar_report h1",
      ".video-info-title h1",
      "h1[class*=video-title]",
      "h1[class*=videoTitle]",
      // 旧版（可能仍存在于部分页面/缓存渲染）
      "h1.video-title",
      "h1.video-title[title]",
      "#viewbox_report h1",
      // 番剧页
      ".mediainfo_mediaTitle h1",
      ".video-title",
    ];
    for (const s of sels) {
      const t = pick(s);
      if (t) return cleanBiliTitle(t);
    }

    // ③ <title> 兜底：形如 "标题_哔哩哔哩_bilibili" / "标题 - 哔哩哔哩"
    const dt = (document.title || "").trim();
    if (dt) {
      const t = cleanBiliTitle(dt);
      // 只有 site 名的 <title> 等于没取到（例如首页/加载中）
      if (t && !/^bilibili$/i.test(t) && !/^哔哩哔哩$/.test(t)) return t;
    }
    return "";
  }

  /** 去掉 B 站标题尾巴与多余空白 */
  function cleanBiliTitle(t) {
    return String(t || "")
      .replace(/[_\-|]\s*哔哩哔哩.*$/i, "")
      .replace(/\s*[-_|]\s*bilibili.*$/i, "")
      .replace(/\s*[-_|]\s*番剧\s*$/i, "")
      // 首页/加载中的 <title> 是「哔哩哔哩 (゜-゜)つロ 干杯~」这类纯站点名，
      // 整条都是噪声 —— 不剥掉的话 biliTitle 会把站名当成视频标题报上去。
      .replace(/^哔哩哔哩\s*\(.*$/i, "")
      .replace(/^bilibili\s*\(.*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * 题目里带 ?p=N 的分P号（同 bvid 下的第 N 集）。番剧页是 /bangumi/play/ep123，
   * 一个 ep 就是一个文件，不需要区分，返回 ""。
   * 为什么要它：同一合集里每一集的标题常常一模一样（「第 3 话」这种除外，
   * 但「正片」类合集很常见同名），不带 p 号的话第二次保存会互相覆盖。
   */
  function biliPartTag() {
    try {
      const q = new URLSearchParams(location.search || "");
      const p = Number(q.get("p") || 0);
      return p > 1 ? "-P" + p : "";
    } catch (e) { return ""; }
  }

  function biliPickStreams(d) {
    const dash = d.dash || {};
    const vids = (dash.video || []).slice();
    const auds = (dash.audio || []).slice();
    if (!vids.length) return null;
    // 同分辨率下优先 avc（兼容性最好）；没有再退回带宽最高的
    const bestH = Math.max.apply(null, vids.map((v) => v.id || 0));
    const sameQ = vids.filter((v) => (v.id || 0) === bestH);
    const avc = sameQ.filter((v) => /^avc/i.test(v.codecs || ""));
    const video = (avc.length ? avc : sameQ).sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    const audio = auds.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0] || null;
    return { video, audio };
  }

  function biliUrls(stream) {
    const out = [];
    const push = (u) => { if (u && out.indexOf(u) < 0) out.push(u); };
    push(stream.baseUrl || stream.base_url);
    const bk = stream.backupUrl || stream.backup_url || [];
    for (const u of bk) push(u);
    return out;
  }

  /** 一条流整条抓下来（Range 链），落成单独文件 */
  async function biliFetchStream(stream, name, onProgress, signal) {
    const urls = biliUrls(stream);
    if (!urls.length) throw new Error("播放清单里没有可用的地址");
    // B 站 CDN 不返回 content-range，HEAD/尾字节又被 CORS 拒，
    // 总长只能靠 sidx 算 —— 把 SegmentBase 的两个 range 交给 probeTotal。
    const sb = stream.SegmentBase || {};
    const seg = {
      ct: stream.mimeType || "",
      initRange: sb.Initialization || "",
      indexRange: sb.indexRange || "",
      // 放大档：B 站 m4s 是直连 CDN，不走 Telegram 那种串行 SW
      big: true,
      kind: /^audio\//i.test(stream.mimeType || "") ? "audio" : "video",
    };
    let lastErr = null;
    for (const u of urls) {
      try {
        return await runRangeDownload({ key: u, name, onProgress, signal, hooks: seg });
      } catch (e) {
        if (e.name === "AbortError") throw e;
        lastErr = e;
        log(`备用地址失败，换下一个：${String(e.message || e).slice(0, 80)}`);
      }
    }
    throw lastErr || new Error("所有地址都失败");
  }

  /**
   * B 站整体保存：视频流 + 音频流先各自落盘（Range 链），
   * 然后让本地宿主用 bin/ffmpeg.exe 无损封装（-c copy）合成单个 mp4。
   * 合并跑在 detached 进程里：浏览器/页面中途关掉，合并也会完成；
   * 合并失败不算下载失败——两条源流文件保留，note 里说明原因。
   */
  async function runBiliDownload(opts) {
    const { name, onProgress, onStage, signal } = opts || {};
    // 第 ④ 点修复：切分P后 __playinfo__ 不刷新，先校正到当前分P再下载
    await biliEnsureFresh(signal);
    const d = biliPlayinfo();
    if (!d) throw new Error("没拿到播放清单（__playinfo__），请刷新页面后重试");
    const picked = biliPickStreams(d);
    if (!picked) throw new Error("播放清单里没有视频流");
    // 文件名基名：优先用 popup 递过来的条目名（就是列表里看到的标题），
    // 没有就现读页面标题；都拿不到才用 bilibili。
    // 之前用户看到的是 bilibili.mp4 —— 名字在 popup 里被写死过一次，
    // 这条链路上任何一处丢标题都会退化成通用名，所以这里再兜一层。
    const wanted = safeFileName(stripExt(fileNameTitle(name || "")));
    const partTag = biliPartTag();
    // 条目名已经带了 -P2 就不重复拼（列表名和文件名用同一套规则）
    const withPart = (s) => (s && partTag && !new RegExp(partTag + "$").test(s) ? s + partTag : s);
    const base = withPart(wanted || safeFileName(stripExt(fileNameTitle(biliTitle() || ""))) || "bilibili");
    const res = [];

    onStage && onStage("正在下载视频流（完整流，与播放进度无关）…", 0);
    const v = await biliFetchStream(picked.video, `${base}-video`, onProgress, signal);
    res.push(v);
    let a = null;
    if (picked.audio && !(signal && signal.aborted)) {
      onStage && onStage("正在下载音频流…", 0);
      a = await biliFetchStream(picked.audio, `${base}-audio`, onProgress, signal);
      res.push(a);
    }
    const received = res.reduce((s, r) => s + (r.received || 0), 0);

    if (a && v.filename && a.filename && !(signal && signal.aborted)) {
      try {
        onStage && onStage("合并音视频…", 0);
        const ack = await hostRequest(
          { action: "msfile_merge", video: v.filename, audio: a.filename, out: base },
          signal, 45000);
        if (!ack || ack.ok === false) throw new Error((ack && ack.error) || "本地下载器无法开始合并");
        const fin = await hostWaitJob(ack.id, {
          onProgress: (pct) => onStage && onStage(`合并音视频… ${Math.round(pct)}%`, pct),
          signal,
        });
        return {
          ok: true, merged: true,
          files: [(fin && fin.file) || (base + ".mp4")],
          received,
          filename: base + ".mp4",
          note: "已自动合并为单文件（ffmpeg 无损封装，两条源流已清理）",
        };
      } catch (e) {
        if (e && e.name === "AbortError") throw e;
        return {
          ok: true, merged: false,
          files: res.map((r) => r.filename), received,
          filename: `${base}（视频+音频，未合并）`,
          note: "自动合并失败（" + String(e.message || e).slice(0, 100)
            + "），两个源文件已保留，可用 bin\\ffmpeg.exe 手动合并",
        };
      }
    }
    return {
      ok: true, merged: false,
      files: res.map((r) => r.filename), received,
      filename: a ? `${base}（视频+音频，未合并）` : (v.filename || `${base}-video.mp4`).split(/[\\/]/).pop(),
      note: a ? null : "清单里没有音频流，仅保存了视频流",
    };
  }

  /** 等一个宿主后台任务（合并/下载）到终态：吃 progress 推送，done/error 落定 */
  function hostWaitJob(id, opts) {
    const { onProgress, signal, timeoutMs } = opts || {};
    return new Promise((resolve, reject) => {
      const finish = (fn, arg) => { cleanup(); fn(arg); };
      const timer = setTimeout(
        () => finish(reject, new Error("合并超时（30 分钟）")),
        timeoutMs || 30 * 60 * 1000);
      const onMsg = (msg) => {
        if (!msg || msg.id !== id) return;
        if (msg.action === "progress" && msg.status) {
          const pct = Number(msg.percent) || 0;
          try { onProgress && onProgress(pct); } catch (e) { /* 忽略 */ }
        } else if (msg.action === "done") {
          finish(resolve, msg);
        } else if (msg.action === "error" || msg.action === "cancelled") {
          finish(reject, new Error(msg.message || (msg.action === "cancelled" ? "已取消" : "合并失败")));
        }
      };
      const onDisc = (msg) => {
        if (!msg || !msg.__disconnected) return;
        finish(reject, new Error("本地下载器已断开: " + (msg.error || "")));
      };
      function cleanup() {
        clearTimeout(timer);
        HOSTPORT.off(onMsg);
        HOSTPORT.off(onDisc);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
      function onAbort() {
        // 合并在 detached 进程里，取消只能请宿主写取消标记（merger 会终止 ffmpeg）
        try { HOSTPORT.send({ action: "cancel", id }); } catch (e) { /* 尽力而为 */ }
        finish(reject, new DOMException("aborted", "AbortError"));
      }
      HOSTPORT.on(onMsg);
      HOSTPORT.on(onDisc);
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  /**
   * B 站当前视频的封面图地址（A2：只取所点开视频的封面）。
   *
   * 为什么不用 DOM 扫：视频页上 `<img>` 有一大堆——UP 主头像、推荐位封面、
   * 广告位、番剧卡片——它们的天然尺寸和 class 都没法可靠区分。而「当前视频
   * 的封面」在 `__INITIAL_STATE__` 里是明确的一个字段，与 DOM 是否渲染、
   * 推荐位加载了多少张全都无关。
   *
   * 取值顺序（新版 → 旧版）：
   *   1. videoData.pic         投稿视频（/video/BV…）：//i0.hdslb.com/bfs/archive/xxx.jpg
   *   2. epInfo.cover          番剧单集
   *   3. mediaInfo.cover       番剧总封面
   *   4. videoData.pages[0].first_frame   分P 首帧（前面都没有时的兜底）
   *
   * 返回 `{url, title}`；拿不到返回 null（调用方退回 DOM 扫描，宁可多抓不可漏抓）。
   */
  function biliCoverImage() {
    const norm = (u) => {
      const s = String(u || "").trim();
      if (!s) return "";
      // 协议相对地址（//i0.hdslb.com/...）在页面里就是 https，补全后才能和
      // webRequest 记下来的 https 条目对上（否则同一张图两条记录）。
      if (s.startsWith("//")) return "https:" + s;
      if (s.startsWith("http://")) return s.replace(/^http:\/\//i, "https://");
      return s;
    };
    try {
      const s = window.__INITIAL_STATE__ || {};
      const vd = s.videoData || {};
      const cands = [
        vd.pic,
        vd.cover,
        s.epInfo && s.epInfo.cover,
        s.mediaInfo && s.mediaInfo.cover,
        vd.pages && vd.pages[0] && vd.pages[0].first_frame,
      ];
      for (const c of cands) {
        const u = norm(c);
        if (/^https?:\/\//i.test(u)) return { url: u, title: biliTitle() };
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  /**
   * B 站页面上的某一类图要不要收（A2）。
   *
   * 用户在 B 站视频页只想要「所点开视频的封面」，不要推荐位/头像/广告。
   * 判据用「是不是 __INITIAL_STATE__ 里那个封面 URL」，比猜 class 稳得多；
   * 同一张封面在 CDN 上常有带 `@` 尺寸参数 / 不带参数的两种写法，
   * 所以比较时只比路径部分（去 query、去 `@…` 后缀）。
   */
  function biliIsCoverSrc(src, coverUrl) {
    if (!src || !coverUrl) return false;
    const cut = (u) => {
      try {
        const x = new URL(u, location.href);
        return (x.hostname.toLowerCase() + x.pathname).replace(/@[^/]*$/, "");
      } catch (e) { return ""; }
    };
    const a = cut(src), b = cut(coverUrl);
    return !!a && a === b;
  }

  function isBiliHost() {
    try { return /(^|\.)bilibili\.com$/i.test(location.hostname); } catch (e) { return false; }
  }

  /**
   * 当前是不是 B 站的「单个视频」页面（投稿 / 番剧 / 课程）。
   *
   * 为什么不能拿 biliPlayinfo() 当这个判据（用户真机 2026-10-21 报 banner 泄漏）：
   *   ① `__playinfo__` 是首页 JS 异步写入的，首屏那几百毫秒里是 undefined。
   *      DOM 扫描不会等它，于是这段窗口里页面被判成「非视频页」→ 全放行 →
   *      banner/活动图/推荐位封面全进列表，而且进了 state 就再也不走。
   *   ② 番剧/课程页的播放清单根本不在 `__playinfo__`（在 `__INITIAL_STATE__.epInfo`），
   *      这类页面**永远**被判成非视频页，等于完全没有过滤。
   * URL 是同步可读的、不会闪，所以「是不是视频页」只看 URL；
   * 「这一集的封面是哪张」才去问 state（见 biliCoverImage）。
   */
  function biliIsVideoPage() {
    try {
      const p = location.pathname || "";
      // /video/BVxxx | av123 | /bangumi/play/ep123456 | /cheese/play/ep123456
      return /^\/video\/(BV[0-9A-Za-z]+|av\d+)/i.test(p)
        || /^\/(bangumi|cheese)\/play\/(ep|ss)\d+/i.test(p);
    } catch (e) {
      return false;
    }
  }

  // ---- B 站站点对象（下载层钩子）----
  //
  // 以前 `startMediaDownload` 里写死 `const useBili = isBiliHost() && biliPlayinfo()`、
  // `overlayShow` 里写死 `if (isBiliHost() && biliPlayinfo())`、
  // `beginSaveBatch` 里写死 `biliSig = ""` —— 通用层认识 B 站，加第二个站点就得再改一遍。
  // 现在这些判断都收进这个对象，通用层只问 siteCanFeed()/siteSaveHint()/siteOnSaveStart()。
  SITES.push({
    name: "bilibili",
    match: () => isBiliHost(),

    // focus() 当前焦点：B 站有视频页 URL（/video/BV…），页面扫描本来就只报
    // 当前视频，不需要额外的查看器焦点。显式返回 "" 表示「本站在 URL 层已收窄」。
    focus: () => "",

    // 有 __playinfo__ 的 DASH 清单才接管；没有（比如首页/动态页）就老实走通用 Range 下载
    canFeedDownload: (ctx) => !!(biliPlayinfo() && (ctx && ctx.bili !== "off")),

    // 站点自己的下载实现：完整 DASH 流（与播放进度无关）
    feedDownload: (name, ctrl, onProgress, onStage) => runBiliDownload({
      name,
      onProgress,
      onStage,
      signal: ctrl && ctrl.signal,
    }),

    // 浮层底部说明：B 站是音视频分开落盘、需要 ffmpeg 合并
    saveHint: () => (biliPlayinfo()
      ? "B 站走完整流抓取（视频流 + 音频流分开落盘），与播放进度无关。"
        + "下载完成后会用 bin/ 目录自带的 ffmpeg 自动合并成单文件。"
      : ""),

    // 每次开始保存前清空上报签名：否则 SPA 换集后签名不变，popup 标题停在旧集
    onSaveStart: () => { biliSig = ""; },

    // hello/rescan 回放时重报 DASH 合成条目（上面 siteResetReport 已清签名，
    // 这里才会真的再发一条 found 而不是被签名去重挡掉）
    replayReport: () => reportBiliDash(),

    // A2 用户诉求：「B 站的图片获取我想改为仅获取所点开视频的封面」。
    //
    // 视频页上 DOM 里的 <img> 全是噪声：UP 主头像、推荐位封面、广告位、番剧卡片，
    // 还有 banner/活动图。它们的 class 会随改版变，唯一稳的判据是
    // 「这张图是不是 __INITIAL_STATE__ 里那个 cover」。
    //
    // 返回 true 表示「这轮 B 站自己报完了，通用 DOM 扫描不用跑了」；
    // 返回 false 走通用逻辑。**判视频页必须用 biliIsVideoPage() 而不是
    // biliPlayinfo()** —— 后者首屏异步、番剧页永远为空，见该函数注释。
    onScanImages: () => {
      if (!biliIsVideoPage()) return false;   // 不是视频页，不接管
      const cover = biliCoverImage();
      if (!cover.url) return false;        // state 还没就绪，退回 DOM 扫描
      // 只报封面这一张。source 用 httpmedia（与 webRequest 记下的条目同源合并），
      // hint 不带 xhs-note，避免被小红书那套「分片让位」规则误伤。
      post({
        cmd: "found",
        source: "httpmedia",
        key: cover.url,
        size: 0,
        mime: "image/*",
        ext: "",
        w: 0, h: 0,
        title: cover.title || "",
        mid: "", ord: 0, ref: "",
        hint: "bili-cover",
      });
      return true;
    },

    // 视频页的图片只认封面（onScanImages 已接管；这里是兜底，防 state 未就绪时
    // onScanImages 返回 false 之后，DOM 扫描又把 banner/推荐图放进来）。
    //
    // 视频页拿不到封面时**不能放行**：宁可这一轮一张图都不报，也不能让 banner
    // 混进去——混进去就进了 state，之后规则再改也清不掉（见 background 的
    // pruneStaleImages 与 1.3.21 的教训）。非视频页（首页/动态/搜索）不受限制。
    isImageOnly: (el, src) => {
      if (!biliIsVideoPage()) return true; // 非视频页不限制
      const cover = biliCoverImage();
      if (!cover.url) return false;        // 视频页但拿不到封面：本轮一张图都不报
      return biliIsCoverSrc(src, cover.url);
    },
  });

  // ---- Telegram 站点对象（用户 m13863：点开某条消息的查看器时收窄列表）----
  //
  // Telegram 和其他站点的根本区别：它没有「详情页 URL」。你打开一个频道
  // （`web.telegram.org/a/#-1002024022449`）后点开任意一条消息的相册，
  // 地址栏纹丝不动，所以「当前在看哪一条」只能从 DOM 里读（见 tgFocus）。
  //
  // 只实现 focus，不接管图片/视频扫描：Telegram 的媒体靠 webRequest + DOM 扫描
  // 已经抓得很准，多余的钩子反而会把「贴纸/头像」这类既有判定搅乱。
  //
  // 钩子清单（通用层只认这几个名字，不认识具体站点）：
  //   match()            是否属于本站
  //   focus()            当前焦点（查看器打开时返回内容 id，否则 ""）
  //   isDecorImg()       是否装饰图（头像/图标）
  //   isImageOnly()      只允许 <img> 上的某张图
  //   isDecorVideo()     是否装饰视频（贴纸/占位）
  //   owns()             这条内容是否属于「当前正在看的东西」
  //   title()            标题
  //   videoSrc()         把 blob: 换成真实地址
  //   feedImages()       直读清单
  //   onScanImages()     接管整轮图片扫描
  SITES.push({
    name: "telegram",
    match: () => /(^|\.)telegram\.(org|me|dog)$/i.test(location.hostname || ""),
    focus: () => tgFocus(),

    // 视频封面不是照片（用户 m15279「telegram 没有按照默认策略吗，为什么还把封面
    // 当作图片」）。TG 把封面塞在两个地方，都只能从 DOM 结构认，URL 和尺寸完全
    // 和真照片一样（实测 320×180 / 179×320），没有别的信号：
    //   ① 消息内：<div class="media-inner"> 里同时挂 <video class="full-media">
    //      和 <img class="thumbnail …">——img 是加载期占位，视频起播后也不移除。
    //   ② 左栏列表预览：.media-preview 里 <img class="media-preview--image">
    //      配 <i class="icon icon-play">，代表「这条是视频」。
    // 反过来，真照片的容器是 <img class="media">，**没有** video 兄弟节点，
    // 所以判据收得很窄：只看「同一个父容器里有没有 <video>」。
    // 注意不能上溯太深——相册的 .Album 容器里视频和照片是混在一起的，
    // 上溯到 Album 会把整组照片一起误杀。
    isDecorImg: (el) => {
      try {
        const p = el && el.parentElement;
        if (!p || !p.querySelector) return false;
        if (p.querySelector("video")) return true;          // ① 消息内封面
        const wrap = el.closest && el.closest(".media-preview");
        if (wrap && wrap.querySelector(".icon-play")) return true;  // ② 列表预览
      } catch (e) { /* 忽略 */ }
      return false;
    },
  });

  const IMG_MIME_EXT = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/pjpeg": ".jpg",
    "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
    "image/bmp": ".bmp", "image/avif": ".avif", "image/svg+xml": ".svg",
    "image/heic": ".heic",
  };

  /** 从 Content-Type 推扩展名。音视频 + 图片都要覆盖：
   *  旧版只认音视频，`image/jpeg` 落成 null，最终兜到 ".mp4"（真机踩过）。 */
  function guessExtFromType(ct) {
    const m = (ct || "").toLowerCase().split(";")[0].trim();
    if (IMG_MIME_EXT[m]) return IMG_MIME_EXT[m];
    if (m.startsWith("audio/")) return extOf(m) === ".bin" ? ".m4a" : extOf(m);
    if (m.startsWith("video/")) return extOf(m) === ".bin" ? ".mp4" : extOf(m);
    return null;
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  function stripExt(name) {
    return (name || "").replace(/\.[a-z0-9]{2,5}$/i, "");
  }

  /**
   * 组装最终文件名：标题/默认名 + 媒体标识 + 扩展名。
   * Telegram 一条消息里可能有多个视频（相簿 / 同一消息多条），必须带上 media key
   * 的尾部数字，否则同名文件会互相覆盖。
   */
  function finishName(name, key, ext) {
    // 收成文件名长度再 sanitize：标题可能是整段聊天正文（见 fileNameTitle）
    let base = safeFileName(stripExt(fileNameTitle(name || "")));
    if (!base) {
      const doc = /document(\d{6,})/.exec(key || "");
      base = doc ? "tg-document" + doc[1].slice(-6) : "media-" + stamp();
    }
    const tail = /(\d{4,})\D*$/.exec(String(key || ""));
    if (tail) base += "_" + tail[1].slice(-6);
    return base + ext;
  }

  /** 给本地宿主发一条请求并等回复（同一个 id） */
  function hostRequest(payload, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      // 注意：payload 里带 id 时必须用它（msfile_chunk / msfile_end 要靠它定位
      // 已打开的那个文件句柄）。早期这里无条件用新 id 覆盖，宿主收到 chunk 后
      // 在 JOBS 里找不到对应 job，只能静默丢弃 —— 表现正是「文件建好了、大小对、
      // 但内容全是 0」。
      const id = payload.id || ("msf-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7));
      const wait = timeoutMs || 45000;
      const timer = setTimeout(() => { cleanup(); reject(new Error("本地下载器无响应")); }, wait);
      const onMsg = (msg) => {
        if (!msg || msg.id !== id) return;
        cleanup();
        resolve(msg);
      };
      const onDisc = (msg) => {
        if (!msg || !msg.__disconnected) return;
        cleanup();
        const why = String((msg && msg.error) || "");
        // 扩展被重载（loadUnpacked / 商店更新）后，旧页面里的内容脚本整体失效，
        // 宿主端口随之断开。这时唯一正确的动作是刷新页面，直接把话说明白。
        reject(new Error(/context invalidated|已断开/i.test(why) || !why
          ? "与本地下载器的连接已断开（扩展可能刚更新过，请刷新本页后重试）"
          : "本地下载器已断开: " + why));
      };
      function cleanup() {
        clearTimeout(timer);
        HOSTPORT.off(onMsg);
        HOSTPORT.off(onDisc);
      }
      HOSTPORT.on(onMsg);
      HOSTPORT.on(onDisc);
      if (signal) {
        signal.addEventListener("abort", () => { cleanup(); reject(new DOMException("aborted", "AbortError")); }, { once: true });
      }
      // send 在「扩展刚被更新 / 端口已断」时会抛错（见 sniffer-hostport.js）。
      // 不接住的话异常会从 Promise 构造器里抛出，外层只能看到「无响应」字样，
      // 用户也就不知道正确的动作是刷新页面。
      try {
        HOSTPORT.send({ ...payload, id });
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  }

  // ------------------------------------------------------------ 下载进度卡（页面内悬浮 UI）

  const UI = { root: null, bar: null, text: null, btn: null, job: null, stage: "", lastFile: "" };

  function uiEnsure() {
    if (UI.root && document.documentElement.contains(UI.root)) return UI.root;
    try {
      const host = document.body || document.documentElement;
      const root = document.createElement("div");
      root.id = "__ms_sniffer_ui";
      root.style.cssText = [
        "position:fixed", "right:18px", "bottom:18px", "z-index:2147483647",
        "width:320px", "padding:12px 14px", "border-radius:12px",
        "background:rgba(22,22,26,.94)", "color:#f5f5f7", "font:13px/1.5 system-ui,'Segoe UI',sans-serif",
        "box-shadow:0 8px 28px rgba(0,0,0,.38)", "backdrop-filter:blur(6px)",
      ].join(";");
      const title = document.createElement("div");
      title.textContent = "资源嗅探 · 保存";
      title.style.cssText = "font-weight:600;margin-bottom:6px";
      // 阶段标签（第 3 点）：单独一行，告诉用户「在下载视频」还是「在下载音频」。
      // 不能揉进进度文字里——那行每 400ms 就被 uiProgress 整行重写一次。
      const stage = document.createElement("div");
      stage.style.cssText = [
        "display:none", "font-size:11.5px", "font-weight:600", "color:#93c5fd",
        "margin-bottom:4px", "letter-spacing:.3px",
      ].join(";");
      const text = document.createElement("div");
      text.style.cssText = "font-size:12px;opacity:.86;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
      text.textContent = "准备中…";
      const barWrap = document.createElement("div");
      barWrap.style.cssText = "height:6px;border-radius:3px;background:rgba(255,255,255,.16);margin:8px 0;overflow:hidden";
      const bar = document.createElement("i");
      bar.style.cssText = "display:block;height:100%;width:0;background:linear-gradient(90deg,#3b82f6,#22c55e);transition:width .25s";
      barWrap.append(bar);
      // 按钮行：取消/关闭在左，「打开所在文件夹」在右（下载完才出现）
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:2px";
      const btn = document.createElement("button");
      btn.textContent = "取消";
      btn.style.cssText = [
        "appearance:none", "border:0", "border-radius:8px", "padding:5px 12px",
        "background:rgba(255,255,255,.14)", "color:#fff", "font:12px system-ui", "cursor:pointer",
      ].join(";");
      const revealBtn = document.createElement("button");
      revealBtn.textContent = "打开所在文件夹";
      revealBtn.style.cssText = [
        "appearance:none", "border:0", "border-radius:8px", "padding:5px 12px", "display:none",
        "background:#2563eb", "color:#fff", "font:12px system-ui", "cursor:pointer",
      ].join(";");
      actions.append(btn, revealBtn);
      root.append(title, stage, text, barWrap, actions);
      host.appendChild(root);
      Object.assign(UI, { root, bar, text, btn, stage, revealBtn });
      return root;
    } catch (e) {
      return null;
    }
  }

  function uiShow(name) {
    const root = uiEnsure();
    if (!root) return;
    UI.text.textContent = "准备中… " + (name || "");
    UI.text.title = "";
    UI.bar.style.width = "0%";
    UI.btn.textContent = "取消";
    UI.btn.disabled = false;
    UI.stage.textContent = "";
    UI.stage.style.display = "none";
    UI.revealBtn.style.display = "none";
  }

  function uiProgress(got, total, speed, name) {
    const root = uiEnsure();
    if (!root) return;
    lastUiAt = Date.now();
    const pct = total ? (got / total) * 100 : 0;
    UI.bar.style.width = Math.max(0, Math.min(100, pct)) + "%";
    const parts = total > 0
      ? [`${pct.toFixed(1)}%  ${fmtBytes(got)} / ${fmtBytes(total)}`]
      : [fmtBytes(got)];
    if (speed) parts.push(fmtBytes(speed) + "/s");
    // 有阶段名时保留阶段标签行，数字行只放进度，避免两种信息互相覆盖
    if (UI.stage && UI.stage.style.display !== "none" && UI.stage.textContent) {
      UI.text.textContent = parts.join("  ·  ");
    } else {
      UI.text.textContent = parts.join("  ·  ") + (name ? "  ·  " + name : "");
    }
    UI.text.title = name || "";
  }

  // 心跳：上一次真正拿到新字节的时间。Telegram 的单段要 1-6 秒才回来，
  // 那期间进度条完全不动，用户会以为卡死（真机反馈「卡到 17%」就是这么来的）。
  // 超过 1.2 秒没新字节就补一行「等待数据…」，让人知道还在跑。
  let lastUiAt = 0;
  let uiHeartbeat = null;
  function startUiHeartbeat() {
    stopUiHeartbeat();
    lastUiAt = Date.now();
    uiHeartbeat = setInterval(() => {
      if (!UI.root) return;
      const idle = Date.now() - lastUiAt;
      if (idle < 1200) return;
      const base = UI.text.textContent.replace(/\s*·\s*等待数据…$/, "");
      UI.text.textContent = base + "  ·  等待数据…";
    }, 600);
  }
  function stopUiHeartbeat() {
    if (uiHeartbeat) { clearInterval(uiHeartbeat); uiHeartbeat = null; }
  }

  /**
   * 阶段提示（下载视频流 / 音频流 / 合并中）。
   *
   * 第 3 点要求：下载视频时提示「正在下载视频」，下载音频时提示「正在下载音频」。
   * 做法是把阶段名放进独立的 stage 标签行（蓝色小字），并让它**优先于**
   * uiProgress 的纯数字行——否则每 400ms 一次进度回调就会把阶段名冲掉。
   * 当前阶段同时记在 UI.stage，供 uiProgress 拼前缀。
   */
  function uiStage(text, pct) {
    const root = uiEnsure();
    if (!root) return;
    if (typeof pct === "number") UI.bar.style.width = Math.max(0, Math.min(100, pct)) + "%";
    if (!text) return;
    const t = String(text).trim();
    // 合并阶段不属于「下载视频/音频」，也让标签行如实反映
    UI.stage.textContent = t;
    UI.stage.style.display = t ? "block" : "none";
    UI.text.textContent = t;
  }

  function uiDone(ok, msg, file) {
    const root = uiEnsure();
    if (!root) return;
    stopUiHeartbeat();
    UI.stage.style.display = "none";
    UI.text.textContent = ok ? "完成 · " + msg : "失败 · " + msg;
    UI.text.title = msg || "";
    UI.btn.textContent = "关闭";
    UI.btn.disabled = false;
    UI.btn.onclick = () => { try { UI.root.remove(); UI.root = null; } catch (e) { /* 忽略 */ } };
    if (ok) {
      UI.bar.style.width = "100%";
      // 第 5 点：下载完给一个「打开所在文件夹」按钮，直接定位到刚落盘的文件
      if (UI.revealBtn) {
        UI.revealBtn.style.display = "inline-block";
        UI.revealBtn.disabled = false;
        UI.revealBtn.textContent = "打开所在文件夹";
        UI.revealBtn.onclick = async () => {
          UI.revealBtn.disabled = true;
          const old = UI.revealBtn.textContent;
          UI.revealBtn.textContent = "正在打开…";
          try {
            const r = await hostRequest({ action: "reveal", file: file || "" }, null, 15000);
            if (r && r.ok === false) throw new Error(r.error || "打开失败");
            // 不自动关卡片：用户可能还要点第二次
            UI.revealBtn.textContent = "已打开";
          } catch (e) {
            UI.revealBtn.textContent = "打开失败";
            UI.revealBtn.title = String((e && e.message) || e).slice(0, 120);
          }
          setTimeout(() => {
            if (!UI.revealBtn) return;
            UI.revealBtn.textContent = old;
            UI.revealBtn.disabled = false;
          }, 1800);
        };
      }
      // 成功自动消失：原来固定 6s，现在有「打开文件夹」按钮，给足 12s
      setTimeout(() => { try { if (UI.root) { UI.root.remove(); UI.root = null; } } catch (e) { /* 忽略 */ } }, 12000);
    }
  }

  let currentAbort = null;

  /** 开始一次 Range 链下载 */
  async function startMediaDownload(key, name, ctx, onDone) {
    if (currentAbort) {
      onDone && onDone({ ok: false, error: "已有任务在进行中" });
      return;
    }
    const ctrl = new AbortController();
    currentAbort = ctrl;
    uiShow(name);
    UI.btn.onclick = () => { try { ctrl.abort(); } catch (e) { /* 忽略 */ } };
    UI.btn.textContent = "取消";
    const t0 = Date.now();
    startUiHeartbeat();
    try {
      // 站点能否接管下载（B 站有 __playinfo__ 时走完整 DASH 流）。
      // 通用层不再写 `isBiliHost()`：加新站点只要在 SITES 里实现 canFeedDownload。
      const useSite = siteCanFeed(ctx);
      const site = useSite ? activeSite() : null;
      const r = (site && site.feedDownload)
        ? await site.feedDownload(
            name, ctrl,
            (got, total, speed) => uiProgress(got, total, speed, name),
            (text, pct) => uiStage(text, pct))
        : await runRangeDownload({
            key,
            name,
            onProgress: (got, total, speed) => uiProgress(got, total, speed, name),
            // 普通站点没有音视频分流，阶段统一叫「正在下载」
            onStage: (text, pct) => uiStage(text, pct),
            signal: ctrl.signal,
            hooks: ctx || {},
          });
      const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
      const msg = `${r.filename || name}（${fmtBytes(r.received)}，${secs}s，${fmtBytes(r.received / secs)}/s）`;
      // 「打开所在文件夹」要定位到具体文件：r.filename 是宿主返回的绝对路径
      // （msfile_end / merge done 都带 file 字段）
      const lastFile = (r.files && r.files[0]) || r.filename || "";
      uiDone(true, msg + (r.note ? " · " + r.note : ""), /[\\/]/.test(lastFile) ? lastFile : "");
      post({
        cmd: "saved", key, ok: true, filename: r.filename, files: r.files || null,
        size: r.received,
        format: useSite
          ? (r.merged ? "完整流（已合并单文件）" : "完整流（视频+音频分开）")
          : "Range 链式下载",
        mode: "page",
      });
      onDone && onDone({ ok: true, filename: r.filename, files: r.files || null, size: r.received });
    } catch (e) {
      const err = e.name === "AbortError" ? "已取消" : String((e && e.message) || e).slice(0, 120);
      uiDone(false, err);
      post({ cmd: "saved", key, ok: false, error: err });
      onDone && onDone({ ok: false, error: err });
    } finally {
      stopUiHeartbeat();
      currentAbort = null;
    }
  }

  // ------------------------------------------------------------ 6. 页面内「保存」浮层（用户手势保留在这里）

  const OV = { root: null, wrap: null, name: null };

  function overlayClose() {
    try { if (OV.root) OV.root.remove(); } catch (e) { /* 忽略 */ }
    OV.root = null;
  }

  function overlayShow(items) {
    overlayClose();
    const host = document.body || document.documentElement;
    const root = document.createElement("div");
    root.id = "__ms_sniffer_overlay";
    root.style.cssText = [
      "position:fixed", "inset:0", "z-index:2147483647", "background:rgba(0,0,0,.42)",
      "display:flex", "align-items:center", "justify-content:center",
      "font:14px/1.5 system-ui,'Segoe UI',sans-serif",
    ].join(";");
    const card = document.createElement("div");
    card.style.cssText = [
      "position:relative", "width:440px", "max-width:92vw", "max-height:76vh",
      "display:flex", "flex-direction:column",
      "padding:18px 20px", "box-sizing:border-box",
      "border-radius:14px", "background:#17171c", "color:#f2f2f5", "box-shadow:0 18px 48px rgba(0,0,0,.5)",
    ].join(";");

    // ---- 关闭按钮：卡片右上角（用户第 2 点要求）----
    // 用绝对定位而不是 flex 排进标题行：标题长度不定，绝对定位才能保证
    // 「永远在右上角」这个位置在任何标题长度下都不动。
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.title = "关闭";
    closeBtn.style.cssText = [
      "position:absolute", "top:10px", "right:10px",
      "appearance:none", "border:0", "width:26px", "height:26px", "line-height:1",
      "border-radius:7px", "cursor:pointer",
      "background:rgba(255,255,255,.10)", "color:#d0d0d8", "font:14px system-ui",
    ].join(";");
    closeBtn.addEventListener("mouseenter", () => { closeBtn.style.background = "rgba(255,255,255,.2)"; });
    closeBtn.addEventListener("mouseleave", () => { closeBtn.style.background = "rgba(255,255,255,.10)"; });
    closeBtn.addEventListener("click", overlayClose);
    card.append(closeBtn);

    const h = document.createElement("div");
    h.textContent = items.length > 1 ? `资源嗅探 · ${items.length} 个媒体` : "资源嗅探 · 保存媒体";
    // 右边留出关闭按钮的位置，标题再长也不会被压到按钮底下
    h.style.cssText = "font-size:15px;font-weight:600;margin-bottom:10px;padding-right:34px";
    card.append(h);

    // 串行队列：Range 链下载一次只跑一条，避免把带宽和 SW 打满
    const queue = [];
    let busy = false;
    const runQueue = async () => {
      if (busy) return;
      busy = true;
      while (queue.length) {
        const job = queue.shift();
        await new Promise((resolve) => startMediaDownload(job.key, job.name, job.ctx, () => resolve()));
      }
      busy = false;
      overlayClose();
    };

    // 真正的「保存」动作抽出来：底部右下的保存按钮和每行的点击都走这里
    const runSave = (it, btn) => {
      // 关键：点击事件在手势栈里，直接发起保存
      // 站点能接管下载时（B 站有 __playinfo__）：它那儿的 blob/MSE 只是「看到哪儿
      // 就录到哪儿」，一律让站点走自己的完整流。通用层不再写 isBiliHost()。
      if (siteCanFeed({ bili: "on" })) {
        overlayClose();
        startMediaDownload(it.key, it.name, { bili: "on" }, () => {});
        return;
      }
      if (/^blob:/i.test(it.key)) {
        overlayClose();
        // blob: 不再走 doSaveBlob 的 <a download>。真机（Telegram，2026-10-21）证据：
        //   __msRangeDownload → D:/…/文件存放处/tg-probe.mp4  72796 字节 ✅
        //   <a download>      → C:/Users/l/Downloads/test-tg.jfif 72796 字节 ⚠️
        // 数据其实都下下来了，但 <a download> 落在 **Chrome 默认下载目录**、
        // 扩展名被 MIME 改写成 .jfif，用户在「文件存放处」找不到 → 看起来就是「下载失败」。
        // 页面侧 fetch 读 blob: 完全可用（probeTotal 实测 72796 与 DOM 一致），
        // 所以统一走 Range + Native Host，落到插件配置的目录、扩展名由内容嗅探决定。
        startMediaDownload(it.key, it.name, {}, () => {});
        return;
      }
      if (/^m\d+$/.test(it.key)) {
        overlayClose();
        doSaveMse(it.key, it.name);
        return;
      }
      queue.push({ key: it.key, name: it.name, ctx: it.ctx || {} });
      if (btn) {
        btn.disabled = true;
        btn.style.opacity = ".45";
        btn.textContent = "排队中…";
      }
      runQueue();
    };

    // 条目区单独滚动，标题和底栏固定（不然 max-height 一撑，按钮会被滚出视野）
    const listBox = document.createElement("div");
    listBox.style.cssText = "overflow:auto;flex:1;min-height:0";

    for (const it of items) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid rgba(255,255,255,.08)";
      const label = document.createElement("div");
      label.style.cssText = "flex:1;min-width:0;cursor:pointer";
      const nm = document.createElement("div");
      nm.textContent = it.name || "（未命名媒体）";
      nm.style.cssText = "font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
      nm.title = it.key;
      const sub = document.createElement("div");
      sub.textContent = it.sub || "";
      sub.style.cssText = "font-size:11.5px;opacity:.6";
      label.append(nm, sub);
      // 只有一条时，点整行就等于点保存；多条时靠底部「全部保存」
      label.addEventListener("click", () => {
        if (items.length === 1) runSave(it, null);
      });
      row.append(label);
      listBox.append(row);
    }
    card.append(listBox);

    // ---- 底栏：说明文字在左，「保存到本地」在右下角（用户第 2 点要求）----
    const foot = document.createElement("div");
    foot.style.cssText = [
      "display:flex", "align-items:flex-end", "justify-content:space-between",
      "gap:14px", "margin-top:12px",
    ].join(";");
    const footText = document.createElement("div");
    footText.style.cssText = "flex:1;min-width:0;font-size:11.5px;opacity:.55;line-height:1.45";
    // 站点专属话术由站点对象给（siteSaveHint），通用层不认识任何站点
    footText.textContent = siteSaveHint()
      || "媒体由页面自己分段取回，直接写入本地下载器目录。多个文件会依次保存。";

    const saveBtn = document.createElement("button");
    saveBtn.textContent = items.length > 1 ? `全部保存（${items.length}）` : "保存到本地";
    saveBtn.style.cssText = [
      "appearance:none", "border:0", "border-radius:9px", "padding:9px 18px", "cursor:pointer",
      "background:#2563eb", "color:#fff", "font:13px system-ui", "font-weight:600", "white-space:nowrap",
      "flex:0 0 auto", "box-shadow:0 2px 10px rgba(37,99,235,.4)",
    ].join(";");
    saveBtn.addEventListener("click", () => {
      if (items.length === 1) {
        runSave(items[0], saveBtn);
        return;
      }
      // 多条：全部排进队列（按钮交给 runQueue 统一推进度）
      saveBtn.disabled = true;
      saveBtn.style.opacity = ".55";
      saveBtn.textContent = "保存中…";
      for (const it of items) queue.push({ key: it.key, name: it.name, ctx: it.ctx || {} });
      runQueue();
    });
    foot.append(footText, saveBtn);
    card.append(foot);
    root.append(card);
    root.addEventListener("click", (e) => { if (e.target === root) overlayClose(); });
    host.appendChild(root);
    OV.root = root;
  }

  function onEsc(e) {
    if (e.key === "Escape") overlayClose();
  }
  document.addEventListener("keydown", onEsc, true);

  function overlayOpen(items) {
    if (!items || !items.length) return;
    overlayShow(items);
  }

  /** popup 传来的媒体清单 → 打开页面浮层（popup 的通知只是兜底） */
  function beginSaveBatch(list) {
    const items = (list || [])
      .filter((x) => x && x.key)
      .map((x) => ({
        key: x.key,
        // 统一在入口收一次：popup、旧版直连保存、全部保存三条路都过这里
        name: fileNameTitle(x.name || ""),
        sub: x.sub || "",
        ctx: { ct: x.ct || "", mid: x.mid || "", ref: x.ref || "" },
      }));
    if (!items.length) return;
    if (items.length === 1) {
      // 只有一个：仍然用浮层，让用户的手势落在按钮上
      overlayShow(items);
    } else {
      overlayShow(items);
    }
  }

  // ------------------------------------------------------------ 7. 指令

  /** 扩展上下文失效的页内提示条（content.js 发 __ms_sniffer_stale 过来）。
   *  主世界脚本本身还活着——只是和扩展的消息通道断了，所以这里能替它把话
   *  亮出来；点一下就关。重复消息只保留一条。 */
  function showStaleBanner(text) {
    try {
      if (document.getElementById("__ms_sniffer_stale_bar")) return;
      const bar = document.createElement("div");
      bar.id = "__ms_sniffer_stale_bar";
      bar.textContent = text || "资源嗅探扩展刚更新过，本页需要刷新一次才能继续工作。";
      bar.title = "点击关闭";
      bar.style.cssText = [
        "position:fixed", "top:14px", "right:14px", "z-index:2147483647",
        "max-width:320px", "padding:10px 14px", "border-radius:10px",
        "background:rgba(20,20,24,.92)", "color:#fff", "font-size:13px",
        "line-height:1.5", "box-shadow:0 4px 16px rgba(0,0,0,.35)",
        "cursor:pointer", "font-family:system-ui,sans-serif",
      ].join(";");
      bar.addEventListener("click", () => bar.remove());
      (document.body || document.documentElement).appendChild(bar);
    } catch (e) { /* 忽略 */ }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d) return;

    // content.js（isolated world）发现「扩展上下文失效」时 post 过来的提醒：
    // 所有 found/progress 都送不出去了，用户看到的会是「什么都没抓到」。
    if (d.__ms_sniffer_stale) {
      showStaleBanner(d.text);
      return;
    }

    if (d.__ms_sniffer_host) {
      // content.js 转来的 Native Host 消息
      if (d.cmd === "host-message") HOSTPORT.deliver(d.payload);
      else if (d.cmd === "host-disconnected") HOSTPORT.disconnected(d.error);
      return;
    }

    if (!d.__ms_sniffer_cmd) return;

    if (d.cmd === "hello" || d.cmd === "rescan") {
      if (d.cmd === "rescan") {
        // 很多站的播放器是用户点播放之后才挂上 <video>/<img> 的。就地重扫一遍，
        // 比让用户整页重载更轻（重载会丢掉已经缓冲好的媒体，反而更难抓）。
        try { scanMedia(); } catch (e) { /* 忽略 */ }
        try { scanImages(); } catch (e) { /* 忽略 */ }
      }
      for (const rec of blobs.values()) {
        post({ cmd: "found", source: "blob", key: rec.url, size: rec.size, mime: rec.type, ext: extOf(rec.type) });
        if (titles.get(rec.url)) post({ cmd: "progress", key: rec.url, title: titles.get(rec.url) });
      }
      for (const url of seenSrc) {
        if (!blobs.has(url)) {
          const ct = mediaSeen.get(url) || {};
          post({ cmd: "found", source: "mediasrc", key: url, size: ct.size || 0, mime: ct.ct || "video/mp4", ext: extOf(ct.ct) });
        }
      }
      for (const entry of mse.values()) {
        post({ cmd: "found", source: "mse", key: entry.id, size: entry.size, mime: entry.mime, ext: extOf(entry.mime), live: true });
      }
      // 扩展重载后 background 状态被清，让站点重置自己的上报签名并重报条目
      siteResetReport();
      siteReplayReport();
      return;
    }

    if (d.cmd === "save") {
      // 兼容旧链路：popup 直接点名保存
      const k = String(d.key || d.id || "");
      if (/^https?:/i.test(k)) {
        // 必须在页面里下：本地下载器过不了 Service Worker
        const list = [{ key: k, name: d.filename || "", sub: "Range 链式下载", ctx: {} }];
        beginSaveBatch(list);
        post({ cmd: "progress", key: k, state: "overlay" });
      } else if (k.startsWith("blob:")) {
        doSaveBlob(k, d.filename);
      } else {
        doSaveMse(k, d.filename);
      }
      return;
    }

    if (d.cmd === "save-batch") {
      beginSaveBatch(d.items || []);
      return;
    }
  });

  // ------------------------------------------------------------ 8. Blob / MSE 老路径（保留）

  async function sniffType(blob) {
    try {
      const buf = await blob.slice(0, 16).arrayBuffer();
      const ext = sniffExt(new Uint8Array(buf));
      if (!ext) return null;
      return { ext, mime: extOf(ext) === ".mp4" ? "video/mp4" : blob.type || "application/octet-stream" };
    } catch (e) {
      return null;
    }
  }

  async function downloadBlob(blob, name, meta) {
    if (!blob || !blob.size) {
      return { ok: false, error: "数据为空（可能流已结束或该 blob 无法直接读取）" };
    }
    const sniff = await sniffType(blob);
    let base = stripExt(sanitize(fileNameTitle(name)));
    if (!base) base = "media-" + stamp();
    const ext = sniff ? sniff.ext : (extOf(blob.type) !== ".bin" ? extOf(blob.type) : "");
    const finalName = base + ext;

    const url = origCreate(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = finalName;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { origRevoke(url); } catch (e) { /* 忽略 */ } }, 60000);

    return {
      ok: true,
      filename: finalName,
      size: blob.size,
      format: sniff ? sniff.mime : (blob.type || "未知"),
      ext: ext || null,
      ...meta,
    };
  }

  async function doSaveBlob(key, filename) {
    let rec = blobs.get(key);
    if (!rec) {
      // Telegram 这种「Worker 里 createObjectURL」的站点：URL 是页面拿到的，
      // 但 blob 由 <video> 的私有存储持有。直接重试 fetch 一次成本很低，值得做，
      // 成功了就顺手记下来，后面再保存就不用再取。
      try {
        const res = await fetchWithTimeout(key, { cache: "force-cache", credentials: "include" }, FETCH_TIMEOUT_CHUNK);
        if (res.ok) {
          const blob = await res.blob();
          if (blob && blob.size) {
            rec = { url: key, blob, size: blob.size, type: blob.type || "video/mp4" };
            blobs.set(key, rec);
          }
        }
      } catch (e) { /* 取不到就走下面的错误分支 */ }
    }
    if (!rec) {
      post({ cmd: "saved", key, ok: false, error: "页面已释放该 Blob，重新播放一次再试" });
      return;
    }
    downloadBlob(rec.blob, fileNameTitle(filename || titles.get(key) || "")).then((r) => post({ cmd: "saved", key, ...r }));
  }

  function doSaveMse(id, filename) {
    const entry = mse.get(id);
    if (!entry || !entry.chunks.length) {
      post({ cmd: "saved", key: id, ok: false, error: "还没捕获到数据，或流已结束" });
      return;
    }
    const blob = new Blob(entry.chunks, { type: entry.mime });
    downloadBlob(blob, fileNameTitle(filename || ""), { experimental: true }).then((r) => post({ cmd: "saved", key: id, ...r }));
  }

  post({ cmd: "ready" });

  // 调试入口（只有测试脚本 / 控制台排障会调用）
  window.__msRangeFetch = fetchRange;
  window.__msFetchWithTimeout = fetchWithTimeout; // 超时保护（测试要直接断言）
  window.__msFetchTimeouts = () => ({ probe: FETCH_TIMEOUT_PROBE, chunk: FETCH_TIMEOUT_CHUNK, hint: PROBE_HINT_AFTER });
  window.__msProbeTotal = probeTotal;
  window.__msRangeDownload = runRangeDownload;
  window.__msRunBiliDownload = runBiliDownload; // 供真机排查
  window.__msBiliEnsureFresh = biliEnsureFresh; // 供真机排查（第④点切集修复）
  window.__msBiliCurrentCid = biliCurrentCid; // 供真机排查
  window.__msParseSidxTotal = parseSidxTotal;
  window.__msStartMediaDownload = startMediaDownload;
  window.__msNativeMedia = () => [...mediaSeen.entries()].map(([u, v]) => ({ url: u, ...v }));
  window.__msFileNameTitle = fileNameTitle; // 文件名截断规则（测试要直接断言）
  window.__msSafeFileName = safeFileName;   // 文件名清洗（百分号解码 / 首尾点 / 非法字符）
  window.__msBiliPartTag = biliPartTag;     // 分P号后缀
  // ------------------------------------------------------------ 9. SPA 导航上报
  //
  // pushState/replaceState 不会触发 chrome.tabs.onUpdated，background 以为还在原页面：
  // 上一个页面的条目、rec.xhsVid 都留在 tab 记录里。真实表现是「换了个视频抓不到」
  // （xhsVid 那道闸把新页面的 MSE/blob 条目全拦掉）和「列表混着上一页的图」。
  (function watchSpaNav() {
    // 导航代次：每发生一次 SPA 导航就 +1，随每条上报带给 background。
    // background 那边的 tab 记录也随之记下当前代次；收到「代次落后」的 found/progress
    // 一律丢弃 —— 这就是「切了视频，上一页的封面/图还混在列表里」的根因：
    // 页面 A 的扫描循环可能还挂着一次 setTimeout，导航到 B 之后它把 A 的图发上来，
    // background 刚清空的新记录就被 A 的残留污染了。
    let gen = 0;
    let lastPath = "";
    try { lastPath = location.pathname + location.search; } catch (e) { /* 忽略 */ }
    const fire = () => {
      let cur = "";
      try { cur = location.pathname + location.search; } catch (e) { return; }
      if (cur === lastPath) return;
      lastPath = cur;
      gen += 1;   // 必须在 post 之前自增：导航消息本身要带上新代次
      try { post({ cmd: "nav", url: String(location.href || ""), gen }); } catch (e) { /* 忽略 */ }
    };
    for (const name of ["pushState", "replaceState"]) {
      try {
        const orig = history[name];
        if (typeof orig !== "function") continue;
        history[name] = function () {
          const ret = orig.apply(this, arguments);
          setTimeout(fire, 0);
          return ret;
        };
      } catch (e) { /* 忽略 */ }
    }
    try { window.addEventListener("popstate", () => setTimeout(fire, 0)); } catch (e) { /* 忽略 */ }
    try { window.addEventListener("hashchange", () => setTimeout(fire, 0)); } catch (e) { /* 忽略 */ }
    // 供其它上报点读取当前代次（post 统一在下面这个包装里补 gen）
    window.__msNavGen = () => gen;
  })();

  window.__msIsXhsHost = isXhsHost;         // 小红书排查入口
  window.__msXhsNoteId = xhsCurrentNoteId;  // 当前帖子 noteId（详情页才有）
  window.__msXhsNoteImages = xhsNoteImages; // __INITIAL_STATE__ 直读的配图清单（测试要断言）
  window.__msXhsNoteType = xhsNoteType;
})();
