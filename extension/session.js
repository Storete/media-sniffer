// 会话数据契约（产品化方案 L0）
// ============================
//
// 这个文件只做一件事：把 background 里那一袋扁平条目（`rec.items`）整理成
// **一次播放会话**。它是纯函数——不读 chrome、不读时钟、不读网络、不写存储。
//
// 为什么需要这一层
// ----------------
// 现在的数据模型是「一个标签页一个 Map，400 条条目一视同仁」，然后靠去重、
// 编号、过滤让用户在列表里认人。用户的心里模型从来不是这样：他要的是**这一个**
// 视频。而后面三件事全都无处可挂：
//   · 选清晰度 → 没有 variants 这个概念
//   · 音视频双轨配齐 → 没有 tracks 这个概念
//   · 输出验证 → 没有「这次会话该产出什么」的预期，ffprobe 出来的轨道没得比
// 所以先把模型立起来，行为一点不改，新旧两条路径并行对照（S0 的双跑）。
//
// 三条设计约束（不是风格问题，是不这样就白做）
// --------------------------------------------
// 1. **sid 必须幂等**：同一页面反复扫描要得到同一个 sid，否则去重、历史库、
//    断点续传全都对不上。所以 sid 只用「主机 + 路径」，不吃查询串、不吃 hash、
//    不吃条目内容——SPA 换一集视频 sid 不变是**故意的**，那是同一个页面的不同会话，
//    由 state 区分，不由 sid 区分。
// 2. **分片和图标永远不进 tracks**：`.m4s/.ts` 这类分片一个视频有几百条，
//    放进来会让「一个视频」变成「几百条轨道」，UI 直接不可用。
// 3. **confidence 只能是离散等级**：strong / weak / conflict。
//    没有标注集就别造 0.92——那个数字进代码之后没人敢动阈值，因为它看起来
//    像有依据，其实是拍脑袋。
//
// 不做什么
// --------
// 不判断「这个条目该不该显示」（那是 background 的 icon/cover/去重的事），
// 不排序给谁先展示（那是 popup 的事），不发起下载。这里只回答「这次会话里有什么」。
"use strict";

var MSSession = (function () {
  // 分片扩展名：判进了 tracks 就一定是错，所以这里宁可宽一点。
  const SEG_EXT = /\.(m4s|cmfv|cmfa|cmft|ts|m4f|m4i|m4v|cmf|seg)$/i;
  // MSE 录制条目的地址是 `m1` / `m2` 这种伪地址，不是 URL。
  const MSE_KEY = /^m\d+$/;
  const ROLES = ["video", "audio"];

  /** 取主机名（去 www、小写）；非法 URL 返回空串。 */
  function hostOf(u) {
    try {
      return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  }

  /**
   * 会话 ID：`主机 + 路径`。
   * 刻意不吃 query / hash / 条目内容 —— 见文件头「约束 1」。
   */
  function msSessionSid(tabUrl) {
    let host = "", path = "";
    try {
      const u = new URL(tabUrl);
      host = u.hostname.toLowerCase().replace(/^www\./, "");
      path = u.pathname.replace(/\/+$/, "") || "/";
    } catch (e) {
      return "";
    }
    if (!host) return "";
    return host + path;
  }

  /** 条目地址的采集来源。UI 上要能说清「这条是哪来的」。 */
  function sourceOf(url) {
    if (MSE_KEY.test(url)) return "mse";
    if (/^blob:/i.test(url)) return "blob";
    if (/^https?:/i.test(url)) return "http";
    return "other";
  }

  /** 从高度或 URL 里的 `1080p` 字样推一个人类可读的清晰度标签。 */
  function qualityOf(it, url) {
    const h = Number(it.h) || 0;
    if (h > 0) return h + "p";
    const m = /(?:^|[^0-9])(\d{3,4})p(?:[^0-9]|$)/i.exec(url);
    return m ? m[1] + "p" : "";
  }

  function num(v) {
    const n = Number(v);
    return isFinite(n) && n > 0 ? n : 0;
  }

  /** 扁平条目 → 归一化后的中间表示；不合法直接丢。 */
  function normalize(it) {
    if (!it || typeof it !== "object") return null;
    const url = typeof it.u === "string" ? it.u : "";
    if (!url) return null;
    const k = String(it.k || "");
    if (ROLES.indexOf(k) < 0) return null;
    if (k === "video" && SEG_EXT.test(url.split("?")[0])) return null; // 约束 2
    const src = sourceOf(url);
    if (src === "other") return null;
    return {
      url,
      role: k,
      source: src,
      mime: String(it.m || ""),
      size: num(it.s),
      width: num(it.w),
      height: num(it.h),
      dur: num(it.dur),
      quality: qualityOf(it, url),
      hint: String(it.hint || ""),
    };
  }

  /** 变体排序：有高度的在前、高的在前、大的在前、最后按地址定序保证稳定。 */
  function cmpVariant(a, b) {
    const ha = a.height > 0 ? a.height : -1;
    const hb = b.height > 0 ? b.height : -1;
    if (ha !== hb) return hb - ha;
    if (a.size !== b.size) return b.size - a.size;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  }

  /** 把一组条目整理成一条轨道；同地址合并（保留更大/更全的字段）。 */
  function buildTrack(role, rows) {
    const byUrl = new Map();
    for (const r of rows) {
      const prev = byUrl.get(r.url);
      if (!prev) { byUrl.set(r.url, r); continue; }
      prev.size = Math.max(prev.size, r.size);
      prev.height = Math.max(prev.height, r.height);
      prev.width = Math.max(prev.width, r.width);
      prev.dur = Math.max(prev.dur, r.dur);
      if (!prev.mime && r.mime) prev.mime = r.mime;
      if (!prev.quality && r.quality) prev.quality = r.quality;
    }
    const variants = Array.from(byUrl.values()).sort(cmpVariant).map((r, i) => ({
      id: role.charAt(0) + (i + 1),
      url: r.url,
      source: r.source,
      mime: r.mime,
      size: r.size,
      width: r.width,
      height: r.height,
      quality: r.quality,
    }));
    return { role, variants };
  }

  /** 清单类型：有 m3u8 就算 hls（清单优先），其次 mpd，最后按普通文件。 */
  function manifestOf(rows, allItems) {
    let type = "file";
    const urlList = rows.map((r) => r.url.toLowerCase());
    if (urlList.some((u) => u.indexOf(".m3u8") >= 0) || rows.some((r) => /mpegurl/i.test(r.mime))) {
      type = "hls";
    } else if (urlList.some((u) => u.indexOf(".mpd") >= 0) || rows.some((r) => /dash\+xml/i.test(r.mime))) {
      type = "dash";
    }
    let duration = 0;
    for (const r of rows) duration = Math.max(duration, r.dur);
    // 分片数先只数「已被当成条目上报的」；真正的清单内部分片数要等 L1 读到 m3u8 体
    // 才有，这里给 0 不假装知道。
    // 注意 `it &&`：条目袋里真的会有 null（页面侧 post 过来的半成品），
    // 少这个守卫就是整页 0 条 —— 第一版测试第一组就把它抓出来了。
    const segments = allItems.filter((it) => it && String(it.k || "") === "seg").length;
    return { type, duration, segments, initUrl: "" };
  }

  /**
   * 证据链。规则：**每条变体都要能追到一条证据**，否则 UI 上没法解释
   * 「我为什么认为这里有东西」。空会话也要留一条，表示「扫过了，确实没有」。
   */
  function evidenceOf(rows, images, manifest) {
    const out = [];
    for (const r of rows) {
      out.push({
        src: r.source === "mse" ? "mse" : "net",
        field: "variant.url",
        value: r.url,
      });
    }
    for (const img of images) {
      out.push({ src: "dom", field: "image.url", value: img.u });
    }
    if (rows.length) out.push({ src: "manifest", field: "manifest.type", value: manifest.type });
    if (!out.length) out.push({ src: "net", field: "items", value: "0" });
    return out;
  }

  /**
   * 置信度（离散）。
   * conflict 的判据是「同一角色同时有 MSE 录制和 http 直链」——这不是猜测，
   * 小红书视频帖真机上就出现过两条路径都给答案、而答案不同的情况。
   */
  function confidenceOf(tracks) {
    for (const t of tracks) {
      const hasMse = t.variants.some((v) => v.source === "mse");
      const hasHttp = t.variants.some((v) => v.source === "http");
      if (hasMse && hasHttp) return "conflict";
    }
    for (const t of tracks) {
      for (const v of t.variants) {
        if ((v.source === "http" || v.source === "mse") && v.size > 0) return "strong";
      }
    }
    return "weak";
  }

  /**
   * 条目袋 → 会话。
   *
   * @param {Object} opt
   * @param {Array|Map} opt.items 扁平条目（`rec.items` 的 values 或 Map 本身）
   * @param {string} opt.tabUrl   当前页地址
   */
  function msBuildSession(opt) {
    const o = opt || {};
    let raw = o.items;
    // 鸭子类型而不是 instanceof：这个函数会被塞进 vm 沙箱跑测试，
    // 跨 realm 的 Map 用 instanceof 判不出来（实测会漏成「空数组」）。
    if (raw && typeof raw !== "object") raw = null;
    let list = [];
    if (raw) {
      if (typeof raw.values === "function" && typeof raw.get === "function") {
        try { list = Array.from(raw.values()); } catch (e) { list = []; }
      } else if (Array.isArray(raw)) {
        list = raw;
      }
    }
    if (!Array.isArray(list)) list = [];

    const rows = [];
    const images = [];
    let cover = "";
    for (const it of list) {
      if (!it || typeof it !== "object") continue;
      const k = String(it.k || "");
      if (k === "image") {
        const u = typeof it.u === "string" ? it.u : "";
        if (!u) continue;
        const hint = String(it.hint || "");
        // 封面是「这张图的来源说明」，不是内容本身：单独挑出来，不进图片集。
        if (hint.indexOf("cover") >= 0) { if (!cover) cover = u; continue; }
        images.push(it);
        continue;
      }
      const r = normalize(it);
      if (r) rows.push(r);
    }

    const tracks = [];
    for (const role of ROLES) {
      const mine = rows.filter((r) => r.role === role);
      if (mine.length) tracks.push(buildTrack(role, mine));
    }

    const manifest = manifestOf(rows, list);
    let kind = "unknown";
    if (tracks.some((t) => t.role === "video")) kind = "video";
    else if (tracks.some((t) => t.role === "audio")) kind = "audio";
    else if (images.length) kind = "image-set";

    return {
      sid: msSessionSid(o.tabUrl),
      site: hostOf(o.tabUrl),
      page: { url: String(o.tabUrl || ""), title: "" },
      kind,
      tracks,
      manifest,
      subs: [],
      cover,
      evidence: evidenceOf(rows, images, manifest),
      confidence: confidenceOf(tracks),
      state: "discovered",
      error: null,
    };
  }

  return { msBuildSession, msSessionSid };
})();

// 测试与 SW 共用：测试在 vm 里读这个全局，background 用 importScripts 加载。
if (typeof globalThis !== "undefined") globalThis.MSSession = MSSession;
