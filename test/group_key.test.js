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
  for (const fn of ["isXhsDetailUrl", "isXhsHostUrl", "markOf", "renumberImages", "numberDisplayed", "numberShown"]) {
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
  {
    const out = runRenum([
      tgItem({ title: "身材不错编号 2026253", mid: "3218", ref: "", k: "video" }),
      tgItem({ title: "身材不错编号 2026253", mid: "3219", ref: "album", k: "video" }),
      tgItem({ title: "身材不错编号 2026253", mid: "3219", ref: "album", k: "video" }),
    ]);
    const marks = out.map((x) => x.mark || "");
    check("[G1] 同标题跨消息应连续编号 ①②③（期望 ①②③）", marks.join("") === "①②③", marks.join("|"));
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

  // 同标题下「视频 + 图片」共用一个序号池（用户 m13827 确认过的语义）。
  // 这条是**故意**的，不是碰巧：拆分会让同一标题下出现两个 ①，
  // 用户分不清谁先谁后（第十轮小红书就是这么改回来的）。
  {
    const out = runRenum([
      tgItem({ title: "同一标题", mid: "100", k: "video", ord: 0 }),
      tgItem({ title: "同一标题", mid: "100", k: "image", ord: 1 }),
      tgItem({ title: "同一标题", mid: "101", k: "video", ord: 2 }),
      tgItem({ title: "同一标题", mid: "101", k: "image", ord: 3 }),
    ]);
    const marks = out.map((x) => x.mark || "");
    check("[G1] 同标题下视频+图片共用一个序号池（期望 ①②③④，不是两个①）",
      marks.join("") === "①②③④", marks.join("|"));
    const kinds = out.map((x) => x.k).join(",");
    check("[G1] 上面这组的 kind 确实是 video,image,video,image 交错的",
      kinds === "video,image,video,image", kinds);
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

  // 同标题里夹一个无标题的，不影响有标题那组的连贯
  {
    const out = runRenum([
      tgItem({ title: "同一标题", mid: "10", k: "video" }),
      tgItem({ title: "", mid: "11", k: "image" }),
      tgItem({ title: "同一标题", mid: "12", k: "video" }),
    ]);
    const titled = out.filter((x) => x.title === "同一标题").map((x) => x.mark || "");
    check("[G1] 无标题杂项不打断同标题编号（期望 ①②）", titled.join("") === "①②", titled.join("|"));
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

    // 用户 m13684 的真机形态：同标题跨消息，⑪ 在消息 3161、①②在 3171
    {
      const got = sctx.sortItems([
        mk({ title: "医美工作室流出", mid: "3161", idx: 11, mark: "⑪", s: 9000 }),
        mk({ title: "医美工作室流出", mid: "3171", idx: 1, mark: "①", s: 100 }),
        mk({ title: "医美工作室流出", mid: "3171", idx: 2, mark: "②", s: 200 }),
      ]).map((x) => x.mark).join("");
      check("[G4] 同标题跨 mid 时按序号排（期望 ①②⑪）", got === "①②⑪", got);
    }

    // 小红书详情页：没标题也没 mid，共用一个池子
    {
      const got = sctx.sortItems([
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
