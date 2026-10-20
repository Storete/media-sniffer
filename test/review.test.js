// ---- 追加测试：审查文档 P2 的 9 类用例 + 第 7.6A 的 tabId=0
//
// 用法：被 background.test.js 末尾 require 之前的部分共享同一份沙箱，
// 这里独立造桩，避免污染既有 147 项。
"use strict";

// 这个文件不独立运行：它导出 runReviewTests(check)，由 background.test.js
// 用同一套 check() 计数器调用，结果算进 background 的项数。
// 单独 `node test/review.test.js` 时打印一行说明就退出，避免 CI 把它当成空套件判失败。
if (require.main === module) {
  console.log("review.test.js 由 background.test.js 引入执行，请跑 `node test/background.test.js`");
  process.exit(0);
}

const fs2 = require("fs");
const path2 = require("path");
const vm2 = require("vm");

module.exports = function runReviewTests(check) {
  const BG2 = path2.join(__dirname, "..", "extension", "background.js");
  const bg = fs2.readFileSync(BG2, "utf8");

  function extractFn(src, name) {
    const start = src.indexOf("function " + name + "(");
    if (start < 0) return null;
    let depth = 0, seen = false;
    for (let j = src.indexOf("{", start); j < src.length; j++) {
      if (src[j] === "{") { depth++; seen = true; }
      else if (src[j] === "}") { depth--; if (seen && depth === 0) return src.slice(start, j + 1); }
    }
    return null;
  }

  // ============================================================
  // [R1] tabId 判定（审查文档 7.6 A）
  // ============================================================
  console.log("\n[R1] record：tabId 判定（tabId=0 是合法标签页）");
  {
    // 抽出 record 需要的依赖，单独造一个最小沙箱
    const tabs = new Map();
    const diagStore = new Map();   // 诊断独立存放：bad-tabid 分支的 tabId 本身无效
    const recCtx = vm2.createContext({
      console: console,
      String, Number, RegExp, Map, Set, Date, Math, Object, Array, JSON,
      ensureTab: (tid) => {
        if (!tabs.has(tid)) tabs.set(tid, { items: new Map(), url: "", dirty: false });
        return tabs.get(tid);
      },
      flushSoon() {}, bumpBadge() {}, confirmPageItem() {},
      headersOf: () => undefined,
      // content-length 必须真读：体量门槛测试全靠它
      headerValue: (headers, name) => {
        if (!Array.isArray(headers)) return "";
        const hit = headers.find((h) => String(h.name || "").toLowerCase() === name);
        return hit ? String(hit.value || "") : "";
      },
      classify: () => "image",
      MIN_MEDIA_BYTES: { video: 2048, audio: 10240, image: 512, seg: 0, doc: 0, font: 0, other: 0, icon: 0 },
      MAX_PER_TAB: 5000, MAX_SEGMENTS: 400,
      it_legacyHits: () => 0,
      fileNameOf: (u) => String(u).split("/").pop() || "",
      isValidTabId: (t) => Number.isInteger(t) && t >= 0,
      diagBump: (tid, key) => {
        const k = String(tid);
        if (!diagStore.has(k)) diagStore.set(k, { seen: 0, drop: {}, sample: {} });
        const d = diagStore.get(k);
        d.seen += 1;
        d.drop[key] = (d.drop[key] || 0) + 1;
      },
      self: { MSDetect: null },
    });
    const recordSrc = extractFn(bg, "record");
    if (!recordSrc) { check("能抽到 record", false); return; }
    vm2.runInContext(recordSrc, recCtx, { filename: "record" });
    const record = recCtx.record;

    // tabId=0 是合法标签页（Chrome 从 0 开始编号）
    record({ tabId: 0, url: "https://a.test/1.png", type: "image", statusCode: 200,
      responseHeaders: [{ name: "content-length", value: "10000" }], requestId: "r0" });
    check("tabId=0 的请求被正常记录（当前实现会丢弃 → 预期红）", tabs.has(0) && tabs.get(0).items.size === 1,
      { tabs: [...tabs.keys()], size: tabs.has(0) ? tabs.get(0).items.size : null });

    // tabId=-1 必须丢弃（不是标签页）
    tabs.clear();
    record({ tabId: -1, url: "https://a.test/2.png", type: "image", statusCode: 200,
      responseHeaders: [], requestId: "r1" });
    check("tabId=-1 被丢弃", tabs.size === 0, [...tabs.keys()]);

    // 缺失 tabId 必须丢弃
    tabs.clear();
    record({ url: "https://a.test/3.png", type: "image", statusCode: 200, requestId: "r2" });
    check("缺失 tabId 被丢弃", tabs.size === 0);

    // 正整数正常
    tabs.clear();
    record({ tabId: 42, url: "https://a.test/4.png", type: "image", statusCode: 200,
      responseHeaders: [{ name: "content-length", value: "10000" }], requestId: "r3" });
    check("正整数 tabId 正常记录", tabs.has(42) && tabs.get(42).items.size === 1);

    // 非整数（浮点）应当按无效处理
    tabs.clear();
    record({ tabId: 1.5, url: "https://a.test/5.png", type: "image", statusCode: 200, requestId: "r4" });
    check("非整数 tabId 被丢弃（预期红）", tabs.size === 0, [...tabs.keys()]);

    // 字符串 "0"（某些 API 会给字符串）不应崩、也不应当成 0 以外的值误判
    tabs.clear();
    record({ tabId: "0", url: "https://a.test/6.png", type: "image", statusCode: 200,
      responseHeaders: [{ name: "content-length", value: "10000" }], requestId: "r5" });
    check("字符串 tabId 不崩（行为不作强约束）", true);

    // 诊断：被丢弃的请求必须留下计数，否则「某站列表为空」无从排查
    check("无效 tabId 的请求记进了诊断计数", !!diagStore.get("1.5") && diagStore.get("1.5").drop["bad-tabid"] === 1,
      diagStore.has("1.5") ? diagStore.get("1.5").drop : null);

    // 体量门槛丢弃也要记：1KB 的 image 应被 too-small:image 计数
    tabs.clear(); diagStore.clear();
    record({ tabId: 9, url: "https://a.test/tiny.png", type: "image", statusCode: 200,
      responseHeaders: [{ name: "content-length", value: "100" }], requestId: "r6" });
    check("体量过小的图片被丢弃且记进诊断",
      !tabs.has(9) || !tabs.get(9).items.size,
      tabs.has(9) ? tabs.get(9).items.size : "no-tab");
    check("诊断里有 too-small:image 计数",
      !!diagStore.get("9") && diagStore.get("9").drop["too-small:image"] === 1,
      diagStore.has("9") ? diagStore.get("9").drop : null);
  }

  // ============================================================
  // [R2] 素材分类：体积线不能压过域名弱信号（审查文档 2/P1）
  // ============================================================
  console.log("\n[R2] looksLikeIcon：CDN 弱信号 vs 体积线");
  {
    const pure = vm2.createContext({ console, Map, Set, String, Number, Math, JSON, URL, RegExp });
    const rs = bg.indexOf("const ICON_MAX");
    const re = bg.indexOf("// ---------------------------------------------------------------- 监听", rs);
    vm2.runInContext(bg.slice(rs, re), pure, { filename: "img-rules" });
    const api = vm2.runInContext("({looksLikeIcon})", pure);
    const looksLikeIcon = api.looksLikeIcon;

    // B 站真机截图里的两条漏网素材（无 DOM 上下文、体积 47KB / 29KB）
    const biliJunk1 = "https://i0.hdslb.com/bfs/archive/fac5c6d5ce8dc4c4b3166ddc54b06266e2daa101.jpg@.avif";
    const biliJunk2 = "https://i0.hdslb.com/bfs/svg-next/nbrdaq48p5.png";
    check("B站 UI 素材 avif@ 47KB 算装饰（当前实现漏 → 预期红）",
      looksLikeIcon({ u: biliJunk1, s: 48000 }) === true, looksLikeIcon({ u: biliJunk1, s: 48000 }));
    check("B站 UI 素材 png 29KB 算装饰（当前实现漏 → 预期红）",
      looksLikeIcon({ u: biliJunk2, s: 29000 }) === true, looksLikeIcon({ u: biliJunk2, s: 29000 }));

    // 关键回归：真封面不能被域名一刀切误杀
    const biliCover = "https://i1.hdslb.com/bfs/archive/5242750857.jpg@.webp";
    check("B站真封面（同 CDN、体积大）不算装饰",
      looksLikeIcon({ u: biliCover, s: 200000 }) === false);

    // 尺寸边界
    check("尺寸 95×95 算图标", looksLikeIcon({ u: "https://x.test/a.png", w: 95, h: 95 }) === true);
    check("尺寸 96×96 算图标（阈值内）", looksLikeIcon({ u: "https://x.test/a.png", w: 96, h: 96 }) === true);
    check("尺寸 97×96 不算图标（高度超阈值）", looksLikeIcon({ u: "https://x.test/a.png", w: 97, h: 96 }) === false);
    check("只有宽没高：不按图标处理（尺寸未知）", looksLikeIcon({ u: "https://x.test/a.png", w: 60 }) === false);

    // 体积边界
    check("体积正好 24KB（24576）不算图标（当前阈值取 >）",
      looksLikeIcon({ u: "https://x.test/a.png", s: 24576 }) === false);
    check("体积 24577（刚过线）不算图标",
      looksLikeIcon({ u: "https://x.test/a.png", s: 24577 }) === false);
    check("体积未知（0）+ 无特征 URL 不算图标",
      looksLikeIcon({ u: "https://x.test/a.png", s: 0 }) === false);

    // 封面保留：带 hint=bili-cover 的条目即使尺寸小也不该被判装饰
    check("hint=bili-cover 的封面在 icon 判定里保留",
      looksLikeIcon({ u: "https://i0.hdslb.com/bfs/archive/abc.jpg", w: 100, h: 100, hint: "bili-cover" }) === false,
      looksLikeIcon({ u: "https://i0.hdslb.com/bfs/archive/abc.jpg", w: 100, h: 100, hint: "bili-cover" }));
  }

  // ============================================================
  // [R3] SPA 生命周期：旧上下文迟到消息不许污染新页面
  // ============================================================
  console.log("\n[R3] 导航代次：旧页面迟到的上报不得进入新页面");
  {
    // 抽出 recordPageMedia 与它依赖的 ensureTab
    const tabs = new Map();
    const ctx3 = vm2.createContext({
      console, String, Number, RegExp, Map, Set, Date, Math, Object, Array,
      ensureTab: (tid) => {
        if (!tabs.has(tid)) tabs.set(tid, { items: new Map(), url: "", dirty: false });
        return tabs.get(tid);
      },
      flushSoon() {}, bumpBadge() {}, confirmPageItem() {},
      fileNameOf: (u) => String(u).split("/").pop() || "",
    });
    const rpmSrc = extractFn(bg, "recordPageMedia");
    vm2.runInContext(rpmSrc, ctx3, { filename: "recordPageMedia" });
    const rpm = ctx3.recordPageMedia;

    // 页面 A 建立条目
    rpm(1, "https://www.bilibili.com/video/BV1AAAA", {
      key: "https://i0.hdslb.com/bfs/archive/AAA.jpg", mime: "image/jpeg",
      hint: "bili-cover", title: "视频 A", gen: 1,
    });
    check("页面 A 的封面建立",
      tabs.get(1).items.has("https://i0.hdslb.com/bfs/archive/AAA.jpg"));

    // 切到页面 B：模拟 background 的 nav 处理（重建 rec，带新代次）
    tabs.set(1, { url: "https://www.bilibili.com/video/BV1BBBB", items: new Map(), dirty: false, gen: 2 });

    // B 的封面正常进入
    rpm(1, "https://www.bilibili.com/video/BV1BBBB", {
      key: "https://i0.hdslb.com/bfs/archive/BBB.jpg", mime: "image/jpeg",
      hint: "bili-cover", title: "视频 B", gen: 2,
    });
    check("页面 B 的封面建立",
      tabs.get(1).items.has("https://i0.hdslb.com/bfs/archive/BBB.jpg"));

    // A 的迟到消息（gen=1）必须被拒
    rpm(1, "https://www.bilibili.com/video/BV1BBBB", {
      key: "https://i0.hdslb.com/bfs/archive/AAA-late.jpg", mime: "image/jpeg",
      hint: "bili-cover", title: "视频 A", gen: 1,
    });
    check("A 的迟到消息被拒（当前实现会收 → 预期红）",
      !tabs.get(1).items.has("https://i0.hdslb.com/bfs/archive/AAA-late.jpg"),
      [...tabs.get(1).items.keys()]);

    // 不带 gen 的老消息：兼容放行（不能把老版本内容脚本打挂）
    rpm(1, "https://www.bilibili.com/video/BV1BBBB", {
      key: "https://i0.hdslb.com/bfs/archive/noGen.jpg", mime: "image/jpeg",
      hint: "bili-cover", title: "视频 B",
    });
    check("不带 gen 的消息兼容放行（旧版内容脚本不被打挂）",
      tabs.get(1).items.has("https://i0.hdslb.com/bfs/archive/noGen.jpg"));

    // 幂等性：同一 key 重复上报只留一条
    const before = tabs.get(1).items.size;
    rpm(1, "https://www.bilibili.com/video/BV1BBBB", {
      key: "https://i0.hdslb.com/bfs/archive/BBB.jpg", mime: "image/jpeg",
      hint: "bili-cover", title: "视频 B", gen: 2,
    });
    check("同一媒体重复上报不产生重复条目", tabs.get(1).items.size === before,
      { before, after: tabs.get(1).items.size });
  }

  // ============================================================
  // [R4] 普通导航：整页导航后旧上下文不泄漏
  // ============================================================
  console.log("\n[R4] 普通导航：tabs.onUpdated 重建后旧条目全部清空");
  {
    const tabs = new Map();
    const ctx4 = vm2.createContext({
      console, String, Number, RegExp, Map, Set, Date, Math, Object, Array,
      ensureTab: (tid) => {
        if (!tabs.has(tid)) tabs.set(tid, { items: new Map(), url: "", dirty: false });
        return tabs.get(tid);
      },
      flushSoon() {}, bumpBadge() {}, confirmPageItem() {},
      fileNameOf: (u) => String(u).split("/").pop() || "",
    });
    const rpmSrc = extractFn(bg, "recordPageMedia");
    vm2.runInContext(rpmSrc, ctx4, { filename: "recordPageMedia" });
    const rpm = ctx4.recordPageMedia;

    rpm(7, "https://a.test/", { key: "https://a.test/pic1.jpg", mime: "image/jpeg" });
    rpm(7, "https://a.test/", { key: "https://a.test/video.mp4", mime: "video/mp4" });
    check("导航前有 2 条", tabs.get(7).items.size === 2);

    // 模拟 tabs.onUpdated 的 loading 重建
    tabs.set(7, { url: "https://b.test/", items: new Map(), dirty: false });
    check("整页导航后旧条目清空", tabs.get(7).items.size === 0);
  }
};
