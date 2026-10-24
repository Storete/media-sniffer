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
      out.push({ src: "dom", field: "image.url", value: img.url });
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

  /** 条目袋 → 数组。鸭子类型判 Map（跨 realm 的 Map 用 instanceof 判不出来）。 */
  function listOf(raw) {
    if (raw && typeof raw !== "object") raw = null;
    let list = [];
    if (raw) {
      if (typeof raw.values === "function" && typeof raw.get === "function") {
        try { list = Array.from(raw.values()); } catch (e) { list = []; }
      } else if (Array.isArray(raw)) {
        list = raw;
      }
    }
    return Array.isArray(list) ? list : [];
  }

  /** 条目袋 → 会话。
   *
   * @param {Object} opt
   * @param {Array|Map} opt.items 扁平条目（`rec.items` 的 values 或 Map 本身）
   * @param {string} opt.tabUrl   当前页地址
   */
  /**
   * 「这条地址是多码率主清单」的判定（T-C10）。
   *
   * 判据是条目上的 `listKind`（background 的 applyHlsMetaTo 从 hls-meta.js 的
   * 正文解析打上，随 storage 持久化）；**没有元数据就不判**——webRequest 只见
   * 地址、清单正文还没读到时，它可能只是我们还没证据的普通媒体，宁可留在
   * variants 里也不凭 URL 形状猜。
   *
   * 为什么要把主清单从 variants 排除：`x36xhzz.m3u8` 这类地址在旧模型里是一条
   * 合法的 video 条目（点它宿主会选默认档下载），但在会话模型里它是「清单的
   * 清单」——混进 variants 就是 S1 选档下拉里一条没有分辨率的假档位（T-C10）。
   * 注意排除只发生在**会话层**：旧模型的 popup 列表条目原样保留。
   * msBuildSession 与 msDiffSession **必须用同一个判据**——一边排除一边比较，
   * 差异就会变成假 missing / 假 extra。
   */
  function isMasterListEntry(it) {
    return !!it && typeof it === "object" && String(it.listKind || "") === "master";
  }

  function msBuildSession(opt) {
    const o = opt || {};
    const list = listOf(o.items);

    const rows = [];
    const images = [];
    let cover = "";
    for (const it of list) {
      if (!it || typeof it !== "object") continue;
      if (isMasterListEntry(it)) continue;   // 主清单不是媒体流：不进 variants（T-C10）
      const k = String(it.k || "");
      if (k === "image") {
        const u = typeof it.u === "string" ? it.u : "";
        if (!u) continue;
        const hint = String(it.hint || "");
        // 封面是「这张图的来源说明」，不是内容本身：单独挑出来，不进图片集。
        if (hint.indexOf("cover") >= 0) { if (!cover) cover = u; continue; }
        // 图片也得进会话。原来这里只留了个 cover、其余图片被扔掉 —— 于是
        // 「图集」这种页面在会话里等于空的，双跑比对也就无从比起（S0 Step2 现场发现）。
        images.push({
          url: u,
          source: sourceOf(u),
          mime: String(it.m || ""),
          size: num(it.s),
          width: num(it.w),
          height: num(it.h),
        });
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
      images,
      manifest,
      subs: [],
      cover,
      evidence: evidenceOf(rows, images, manifest),
      confidence: confidenceOf(tracks),
      state: "discovered",
      error: null,
    };
  }

  // ------------------------------------------------------------------ S0 双跑比对
  //
  // 为什么要有 msDiffSession
  // ---------------------
  // S0 的「双跑并行」不是「顺便也跑一下新模型」，而是**要能回答一个新模型是不是
  // 丢了旧模型有的东西**。没有这个函数，双跑就只是两袋数据摆着，谁也不会去比。
  //
  // 比对的口径（这个口径决定了它有没有用）
  // --------------------------------------
  // **只允许「新增」**。三页真机跑下来，diff 里出现 missing / changed 就说明新模型
  // 丢了东西或改了值 —— S1~S6 全建在它上面，不能带着这个隐患往前推。
  // 所以 ok 的定义是严格的：missing、changed、extra 三者都为空。
  //
  // 字段映射（旧条目字段 → 会话字段）：u→url、k→role、m→mime、s→size、
  // w→width、h→height、dur→dur。映射之外的都是新增（id/source/quality）。
  //
  // 两条刻意的不报错
  // ----------------
  // · 同一地址出现多次：旧模型是两条条目，新模型按地址合并成一条（buildTrack 取
  //   max）。这是**故意的**，不是丢数据，所以计入 merged 而不进 changed。
  // · 分片 / 图标 / 文档 / 字体 / 非 http 地址：两边都不该出现（约束 2），
  //   计入 dropped。
  // · 多码率主清单地址（listKind==="master"）：旧模型把它当一条可点的 video 条目
  //   （点它宿主会选默认档），新模型**有意**不把它当媒体流（T-C10：混进 variants
  //   就是选档下拉里的假档位）。两边口径一致地跳过，计入 masterSkipped ——
  //   既不是 missing（新模型没丢东西，popup 列表里的条目原样在），也不是 dropped
  //   （旧模型那条是合法存在的）。判据必须与 msBuildSession 完全同一个函数。
  function msDiffSession(session, items) {
    const st = session || {};
    const list = listOf(items);
    const tracks = Array.isArray(st.tracks) ? st.tracks : [];
    const imgs = Array.isArray(st.images) ? st.images : [];

    const byRole = new Map();
    for (const t of tracks) {
      const m = new Map();
      for (const v of (t && t.variants) || []) if (v && v.url) m.set(v.url, v);
      byRole.set(t && t.role, m);
    }
    const imgMap = new Map();
    for (const im of imgs) if (im && im.url) imgMap.set(im.url, im);

    const counts = { seen: 0, media: 0, image: 0, dropped: 0, merged: 0, masterSkipped: 0 };
    const urlCount = new Map();
    const flat = [];      // [{kind, url, row}]  row 里的键已经是映射后的
    for (const it of list) {
      counts.seen++;
      if (!it || typeof it !== "object") { counts.dropped++; continue; }
      const k = String(it.k || "");
      if (k === "image") {
        const u = typeof it.u === "string" ? it.u : "";
        if (!u || String(it.hint || "").indexOf("cover") >= 0) { counts.dropped++; continue; }
        counts.image++;
        urlCount.set(u, (urlCount.get(u) || 0) + 1);
        flat.push({
          kind: "image", url: u,
          row: { mime: String(it.m || ""), size: num(it.s), width: num(it.w), height: num(it.h) },
        });
        continue;
      }
      const r = normalize(it);
      if (!r) { counts.dropped++; continue; }
      // 与 msBuildSession 同判据：主清单不进 variants，也不进比较（见上方说明）
      if (isMasterListEntry(it)) { counts.masterSkipped++; continue; }
      counts.media++;
      urlCount.set(r.url, (urlCount.get(r.url) || 0) + 1);
      flat.push({ kind: "media", url: r.url, row: r });
    }

    const missing = [];
    const extra = [];
    const changed = [];
    const FIELDS = ["mime", "size", "width", "height"];
    const seenMedia = new Set();
    const seenImage = new Set();

    for (const f of flat) {
      const isImg = f.kind === "image";
      (isImg ? seenImage : seenMedia).add(f.url);
      const v = isImg ? imgMap.get(f.url) : (byRole.get(f.row.role) || new Map()).get(f.url);
      if (!v) { missing.push(f.url); continue; }
      // 同地址多条目 → 合并是故意的（buildTrack 取 max），不比字段值
      if ((urlCount.get(f.url) || 1) > 1) { counts.merged++; continue; }
      for (const k of FIELDS) {
        const before = f.row[k];
        const after = v[k];
        // mime 是字符串，其余是数字。统一用 Number() 比会把两条相同的 mime 判成不同
        // （Number("video/mp4") 是 NaN，而 NaN !== NaN）—— 那样每次双跑都是满屏假红，
        // 第一次跑完就没人再看这个 diff 了。这是 test/session_shadow.test.js 第一轮抓到的。
        const same = k === "mime"
          ? String(before || "") === String(after || "")
          : Number(before) === Number(after);
        if (!same) {
          changed.push({ url: f.url, field: k, old: before, new: after });
        }
      }
    }

    for (const m of byRole.values()) {
      for (const u of m.keys()) if (!seenMedia.has(u)) extra.push(u);
    }
    for (const u of imgMap.keys()) if (!seenImage.has(u)) extra.push(u);

    // 「新增字段」由数据算，不写死：拿第一条变体的键减去映射后的旧键。
    let sample = null;
    for (const t of tracks) { if (t && t.variants && t.variants.length) { sample = t.variants[0]; break; } }
    const oldKeys = new Set(["url", "role", "mime", "size", "width", "height"]);
    const added = sample ? Object.keys(sample).filter((k) => !oldKeys.has(k)).sort() : [];

    return {
      ok: missing.length === 0 && changed.length === 0 && extra.length === 0,
      counts,
      missing,
      extra,
      changed,
      added,
    };
  }

  return { msBuildSession, msSessionSid, msDiffSession };
})();

// 测试与 SW 共用：测试在 vm 里读这个全局，background 用 importScripts 加载。
if (typeof globalThis !== "undefined") globalThis.MSSession = MSSession;
