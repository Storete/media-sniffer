// 分组键与预览按钮的回归测试（一期一目标 · Telegram 分组/编号/预览）
//
// 用户 m13684 三条：
//   1. 把相同标题的视频或图片放在一起（并问「其他网站有没有同样问题」）
//   2. 图三第一个条目没有正确编号（显示 ⑪ 却又像新的一组）
//   3. 图四 Telegram 图片不能预览
//
// 本文件由 test/background.test.js 末尾 require 进来，共用同一个 check 计数器。

module.exports = function runGroupTests(check) {
  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

  const dir = __dirname;
  const bgCode = fs.readFileSync(path.join(dir, "..", "extension", "background.js"), "utf8");
  const popCode = fs.readFileSync(path.join(dir, "..", "extension", "popup.js"), "utf8");

  // ---------------------------------------------------------------- 抽函数

  function extractFn(src, name) {
    const start = src.indexOf("function " + name + "(");
    if (start < 0) return null;
    let i = src.indexOf("{", start), depth = 0, inStr = null, esc = false;
    for (; i < src.length; i++) {
      const c = src[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    return null;
  }

  const parts = [];
  for (const fn of ["isXhsDetailUrl", "isXhsHostUrl", "markOf", "compareWithinGroup", "renumberImages", "numberDisplayed", "numberShown"]) {
    const body = extractFn(bgCode, fn);
    if (!body) { console.log("  ! 抽不到函数 " + fn); return; }
    parts.push(body);
  }
  // CIRCLE 是跨行数组（792-793），必须整段取，不能按行 split
  const circleStart = bgCode.indexOf("const CIRCLE");
  const circleEnd = bgCode.indexOf("];", circleStart) + 2;
  const circleLine = circleStart >= 0 ? bgCode.slice(circleStart, circleEnd) : "";
  const numberedLine = bgCode.split("\n").find((l) => l.startsWith("const NUMBERED_KINDS") && l.includes("new Set"));
  if (!circleLine || !numberedLine) { console.log("  ! 抽不到 CIRCLE / NUMBERED_KINDS"); return; }

  const ctx = vm.createContext({ console, Map, Set, String, Number, Math, JSON, URL, RegExp });
  vm.runInContext(circleLine + "\n" + numberedLine + "\n" + parts.join("\n"), ctx, { filename: "renumber" });

  // ---------------------------------------------------------------- [G1] 分组键按标题

  console.log("\n[G1] 相同标题的条目归入同一组（不再按消息 id 拆散）");

  /** 造一条 Telegram 风格的条目 */
  function tgItem(o) {
    return Object.assign({
      u: "blob:https://web.telegram.org/" + Math.random().toString(36).slice(2),
      k: "image", s: 0, mid: "", title: "", ref: "", t: 0,
    }, o);
  }

  function runRenum(items, url) {
    // 编号已挪到 numberShown（在 icon 过滤 + 去重之后编），renumberImages 只负责
    // 记忆分组。测试要验「用户看到的序号」，所以这里调 numberShown。
    ctx.numberShown(items, url || "https://web.telegram.org/a/");
    return items;
  }

  // 同一标题、不同消息 id、不同 ref —— 用户抱怨的正是这种
  //
  // 2026-10-22 改（Web K 的 data-mid 修复一并调整）：**mid 优先于标题**。
  // 一条消息就是一个内容单元，标题只是「抓不到 mid 时的兜底」。所以
  //   3218 只有 1 条 → 组内单条不编号；
  //   3219 有 2 条     → ①②。
  // 旧行为是「同标题跨消息合并连号」→ ①②③，那会让用户以为第 3 张还在同一条消息里，
  // 而真机上他点开的是其中某一条（1.3.29 的焦点收窄按消息过滤，两者必须同一粒度）。
  {
    const out = runRenum([
      tgItem({ title: "身材不错编号 2026253", mid: "3218", ref: "", k: "video" }),
      tgItem({ title: "身材不错编号 2026253", mid: "3219", ref: "album", k: "video" }),
      tgItem({ title: "身材不错编号 2026253", mid: "3219", ref: "album", k: "video" }),
    ]);
    const marks = out.map((x) => x.mark || "");
    check("[G1] 有 mid 时按消息分组：单条不编号、两条消息各自 ①②",
      marks.length === 3 && marks[0] === "" && marks[1] === "①" && marks[2] === "②",
      marks.join("|"));
  }

  // 不同标题必须各自成组，仍各自 ① 或空
  {
    const out = runRenum([
      tgItem({ title: "标题甲", mid: "1", k: "video" }),
      tgItem({ title: "标题乙", mid: "2", k: "video" }),
    ]);
    const marks = out.map((x) => x.mark || "");
    check("[G1] 不同标题不合并（组内只有一张 → 不编号）", marks.join("") === "", marks.join("|"));
  }

  // 同一条消息下「视频 + 图片」共用一个序号池（用户 m13827 确认过的语义）。
  // 这条是**故意**的，不是碰巧：拆分会让同一消息里出现两个 ①，
  // 用户分不清谁先谁后（第十轮小红书就是这么改回来的）。
  //
  // 2026-10-22 改：共用池的**单位是「消息」**，不是「标题」。所以 mid 100 的
  // 两条是 ①②、mid 101 的两条也是 ①②，而不是四条连成 ①②③④。
  {
    const out = runRenum([
      tgItem({ title: "同一标题", mid: "100", k: "video", ord: 0 }),
      tgItem({ title: "同一标题", mid: "100", k: "image", ord: 1 }),
      tgItem({ title: "同一标题", mid: "101", k: "video", ord: 2 }),
      tgItem({ title: "同一标题", mid: "101", k: "image", ord: 3 }),
    ]);
    const marks = out.map((x) => x.mark || "");
    check("[G1] 每条消息内部图视频共用一个序号池（期望 ①②+①②，不是四条连号）",
      marks.join("") === "①②①②", marks.join("|"));
    const kinds = out.map((x) => x.k).join(",");
    check("[G1] 上面这组的 kind 确实是 video,image,video,image 交错的",
      kinds === "video,image,video,image", kinds);
  }

  // ---------------------------------------------------------------- [G1b] 跨消息的 ord 不能互相干扰
  //
  // 真机数据（2026-10-20 Telegram「ONE PIECE / General」频道，用户 m14493 报「编号对不上内容」）：
  // 同一个标题「编号：#CC0385」下有 **三条消息**（mid 7497 / 7498 / 7508），
  // 每条消息内部的 ord 都**从 0 重新开始**：
  //   7497: 1 张图  ord=0
  //   7498: 5 张图 + 7 条视频，ord=0..9，其中还有一条 ref=viewer 的 ord=0
  //   7508: 1 张图  ord=0
  // 旧排序只比 ord，于是三个 ord=0 并列，再退到 t（抓取时间）——
  // 抓取时间是异步到达的，等于随机，用户看到的就是「序号和内容对不上」。
  //
  // 正确语义：**先按消息分组（mid 升序），消息内部再按 ord**。
  {
    const T = "编号： #CC0385";
    const out = runRenum([
      // 故意把乱序塞进来，模拟真实抓到的顺序
      tgItem({ title: T, mid: "7508", k: "image", ord: 0, u: "img-7508-0" }),
      tgItem({ title: T, mid: "7498", k: "video", ord: 4, u: "vid-7498-4" }),
      tgItem({ title: T, mid: "7497", k: "image", ord: 0, u: "img-7497-0" }),
      tgItem({ title: T, mid: "7498", k: "image", ord: 0, u: "img-7498-0" }),
      tgItem({ title: T, mid: "7498", k: "video", ord: 0, ref: "viewer", u: "vid-7498-viewer" }),
      tgItem({ title: T, mid: "7498", k: "image", ord: 2, u: "img-7498-2" }),
    ]);
    // numberShown 只原地写 idx/mark，不重排数组（重排是 popup 的事）。
    // 所以要验证「用户看到的顺序」，得按 idx 排一遍再断言。
    //
    // 2026-10-22 改（mid 优先）：三条消息各自成组，7497 和 7508 各只有 1 条
    // → 组内单条不编号；只有 7498 的 4 条编号。期望顺序（同 mid 内 ord 升序、
    // 同 ord 内 t 升序）：
    //   7498/img-7498-0 (ord0, t 更早) → 7498/vid-7498-viewer (ord0, t 更晚)
    //   → 7498/img-7498-2 (ord2) → 7498/vid-7498-4 (ord4)
    // 注意 viewer 那条的 ord 也是 0，和 img-7498-0 并列，靠 t 决出先后 —— 这是
    // 目前唯一可用的平局规则（viewer 与 album 的 ord 各自从 0 数，无法互相对齐）。
    const sorted = out.filter((x) => x.mark).slice().sort((a, b) => a.idx - b.idx);
    const order = sorted.map((x) => x.u).join(",");
    check("[G1b] 消息内按 ord 升序、跨消息不再连号（只 7498 编 ①②③④）",
      order === "img-7498-0,vid-7498-viewer,img-7498-2,vid-7498-4", order);
    const marks = sorted.map((x) => x.mark).join("");
    check("[G1b] 7498 内四条连续 ①②③④（真机曾出现跳号/重复）",
      marks === "①②③④", marks);
    check("[G1b] 7497 / 7508 各只有一条，不占序号",
      !out.find((x) => x.u === "img-7497-0").mark && !out.find((x) => x.u === "img-7508-0").mark,
      out.map((x) => [x.u, x.mark]));
  }

  // viewer 那条的 ord 也是 0，绝不能因为「ord 更小」就抢到 7498 的第一位
  {
    const T = "X";
    const out = runRenum([
      tgItem({ title: T, mid: "100", k: "image", ord: 3, u: "a3" }),
      tgItem({ title: T, mid: "100", k: "image", ord: 4, ref: "viewer", u: "v4" }),
      tgItem({ title: T, mid: "100", k: "image", ord: 5, u: "a5" }),
    ]);
    const order = out.filter((x) => x.mark).map((x) => x.u).join(",");
    check("[G1b] 同一 mid 内 viewer 与 album 的 ord 互不干扰（按 ord 排：a3,v4,a5）",
      order === "a3,v4,a5", order);
  }

  // 无 mid 的条目（普通网站）不能被这条规则误伤：仍然只按 ord
  {
    const out = runRenum([
      tgItem({ title: "无 mid 标题", mid: "", k: "image", ord: 1, u: "b1" }),
      tgItem({ title: "无 mid 标题", mid: "", k: "image", ord: 0, u: "b0" }),
    ]);
    const sorted = out.slice().sort((a, b) => (a.idx || 0) - (b.idx || 0));
    const order = sorted.map((x) => x.u).join(",");
    check("[G1b] 无 mid 时仍按 ord 排（b0,b1）", order === "b0,b1", order);
  }

  // 无标题条目仍不参与编号（防止空标题把全页图并成一组）
  {
    const out = runRenum([
      tgItem({ title: "", mid: "1" }),
      tgItem({ title: "", mid: "2" }),
      tgItem({ title: "", mid: "3" }),
    ]);
    const marks = out.map((x) => x.mark || "");
    check("[G1] 无标题条目不编号", marks.join("") === "", marks.join("|"));
  }

  // 同标题里夹一个无标题的：三条各自是一条消息、各只有 1 条 → 都不编号。
  // 2026-10-22 改：旧语义是「跨消息按标题合组，无标题那条不打断 ①②」；
  // mid 优先后不再跨消息合组，所以这条改为验证「不会因为都叫『同一标题』
  // 就把两条独立消息并成一个池」。
  {
    const out = runRenum([
      tgItem({ title: "同一标题", mid: "10", k: "video" }),
      tgItem({ title: "", mid: "11", k: "image" }),
      tgItem({ title: "同一标题", mid: "12", k: "video" }),
    ]);
    const titled = out.filter((x) => x.title === "同一标题").map((x) => x.mark || "");
    check("[G1] 同标题的两条独立消息不合并（各只有一条 → 都不编号）",
      titled.join("|") === "|", titled.join("|"));
  }

  // ---------------------------------------------------------------- [G2] 小红书不能被误伤

  console.log("\n[G2] 小红书详情页 / 首页 feed 的既有规则不被破坏");

  {
    // 详情页：整页一个池子，跨 kind
    const out = runRenum([
      tgItem({ title: "帖子标题", mid: "", ref: "", k: "video", ord: 0, hint: "xhs-note" }),
      tgItem({ title: "帖子标题", mid: "", ref: "", k: "image", ord: 1, hint: "xhs-note" }),
    ], "https://www.xiaohongshu.com/explore/6ab221bd000000003602a63e");
    const marks = out.map((x) => x.mark || "");
    check("[G2] 小红书详情页视频+图片共用一个序号池（期望 ①②）", marks.join("") === "①②", marks.join("|"));
  }

  {
    // 首页 feed：有标题的不同帖子不能被并成一组
    const out = runRenum([
      tgItem({ title: "帖子甲", mid: "", k: "image" }),
      tgItem({ title: "帖子乙", mid: "", k: "image" }),
    ], "https://www.xiaohongshu.com/explore");
    const marks = out.map((x) => x.mark || "");
    check("[G2] 小红书首页 feed 不加序号", marks.join("") === "", marks.join("|"));
  }

  // ---------------------------------------------------------------- [G3] 预览按钮

  console.log("\n[G3] Telegram 的 blob: 图片也应能预览");

  // 把预览判据抽成独立函数后，直接测这个函数的逻辑
  const canPreviewSrc = extractFn(popCode, "canPreviewSrc");
  if (!canPreviewSrc) {
    check("[G3] popup.js 应抽出 canPreviewSrc(it) 供测试（否则无法验证）", false, "未找到 canPreviewSrc");
  } else {
    const pctx = vm.createContext({ console, String, RegExp });
    vm.runInContext(canPreviewSrc, pctx, { filename: "canPreviewSrc" });
    const can = (it) => pctx.canPreviewSrc(it);

    check("[G3] https 图片可预览", can({ k: "image", u: "https://a.com/x.jpg" }) === true);
    check("[G3] https 视频可预览", can({ k: "video", u: "https://a.com/x.mp4" }) === true);
    check("[G3] blob 图片可预览（Telegram 场景）", can({ k: "image", u: "blob:https://web.telegram.org/abc" }) === true);
    check("[G3] blob 视频可预览", can({ k: "video", u: "blob:https://web.telegram.org/abc" }) === true);
    check("[G3] MSE 分片 m1 不可预览", can({ k: "video", u: "m1" }) === false);
    check("[G3] 普通文本不可预览", can({ k: "doc", u: "https://a.com/x.pdf" }) === false);
  }

  // ---------------------------------------------------------------- [G4] 列表排序

  console.log("\n[G4] 同标题的条目在列表里必须挨着按序号排");

  // visibleItems 里那段排序 comparator 单独抽出来测（它不依赖 DOM）
  const sortBlock = (() => {
    const start = popCode.indexOf("const order = [\"video\"");
    if (start < 0) return null;
    const end = popCode.indexOf("});", start);
    return end > start ? popCode.slice(start, end + 3) : null;
  })();

  if (!sortBlock) {
    check("[G4] popup.js 应保留 visibleItems 的排序块（否则无法验证）", false, "未找到排序块");
  } else {
    // 造一个只有排序所需的极简环境
    const sctx = vm.createContext({ console, String, Number });
    vm.runInContext("function sortItems(list){" + sortBlock + "\nreturn list;}", sctx, { filename: "sortItems" });

    const mk = (o) => Object.assign({ k: "image", s: 0, t: 0, mid: "", title: "", idx: 0 }, o);

    // 用户 m13684 的真机形态：同一条消息里 ①②③ 必须按序号挨着。
    //
    // 2026-10-22 改（mid 优先）：旧用例是「同标题跨 mid，⑪ 在 3161、①②在 3171」。
    // mid 优先后跨消息不再同组，而且每条消息各自从 ① 编号，⑪ 和 ①② 不可能
    // 出现在同一池子里。改为验证「同消息内序号压过体积」。
    {
      const got = sctx.sortItems([
        mk({ title: "医美工作室流出", mid: "3171", idx: 3, mark: "③", s: 3000 }),
        mk({ title: "医美工作室流出", mid: "3171", idx: 1, mark: "①", s: 100 }),
        mk({ title: "医美工作室流出", mid: "3171", idx: 2, mark: "②", s: 2000 }),
      ]).map((x) => x.mark).join("");
      check("[G4] 同一条消息内按序号排（期望 ①②③，体积再大也不抢位）", got === "①②③", got);
    }

    // 跨消息：标题相同、mid 不同、都编了 ① —— 不同组，不能按 idx 穿插，
    // 退回 kind（都是 image）后按体积降序，与 background 的 mid 分组保持一致。
    {
      const got = sctx.sortItems([
        mk({ k: "image", title: "同一标题", mid: "3161", idx: 1, mark: "①", s: 9000 }),
        mk({ k: "video", title: "同一标题", mid: "3171", idx: 1, mark: "①", s: 100 }),
      ]).map((x) => x.k).join(",");
      check("[G4] 跨消息即使同标题也不当成一组（按 kind 分块，video 在前）", got === "video,image", got);
    }

    // 用户 m14306 真机（问题①的最后一环）：同标题下视频和图片共用一个序号池，
    // 但排序的第一行原来是 `if (ka !== kb) return ka - kb;`，把所有 video 提到
    // 所有 image 前面，于是列表变成「②④⑥…（video）在前，①③⑤…（image）在后」，
    // 用户看到的就是「序号和内容对不上」。同组已编号时 idx 必须压过 kind。
    {
      const got = sctx.sortItems([
        mk({ k: "video", title: "编号： #CC0385", mid: "7498", idx: 2, mark: "②", s: 5000 }),
        mk({ k: "image", title: "编号： #CC0385", mid: "7498", idx: 1, mark: "①", s: 900 }),
        mk({ k: "video", title: "编号： #CC0385", mid: "7498", idx: 4, mark: "④", s: 4000 }),
        mk({ k: "image", title: "编号： #CC0385", mid: "7498", idx: 3, mark: "③", s: 800 }),
      ]).map((x) => x.mark).join("");
      check("[G4] 同组编号压过 kind（期望 ①②③④，而不是 video 全在前）", got === "①②③④", got);
    }

    // 不同组（标题不同）仍然按 kind 分块 —— 这条规则不能丢
    {
      const got = sctx.sortItems([
        mk({ k: "image", title: "甲", mid: "1", idx: 1, mark: "①", s: 100 }),
        mk({ k: "video", title: "乙", mid: "2", idx: 1, mark: "①", s: 100 }),
      ]).map((x) => x.k).join(",");
      check("[G4] 不同组之间仍按 kind 排（video 在前）", got === "video,image", got);
    }

    // 小红书详情页：没标题也没 mid，共用一个池子
    {      const got = sctx.sortItems([
        mk({ title: "", mid: "", idx: 3, mark: "③" }),
        mk({ title: "", mid: "", idx: 1, mark: "①" }),
        mk({ title: "", mid: "", idx: 2, mark: "②" }),
      ]).map((x) => x.mark).join("");
      check("[G4] 都无标题无 mid 时按序号排（期望 ①②③）", got === "①②③", got);
    }

    // 不同标题不能互相穿插排序
    {
      const got = sctx.sortItems([
        mk({ title: "甲", mid: "1", idx: 2, mark: "②", s: 500 }),
        mk({ title: "乙", mid: "2", idx: 1, mark: "①", s: 100 }),
      ]).map((x) => x.title + (x.mark || "")).join(",");
      check("[G4] 不同标题不按序号混排（先按体积降序：甲②,乙①）", got === "甲②,乙①", got);
    }
  }
};
