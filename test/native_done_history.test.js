// 下载完成 → 写入「下载记录」。
//
// 2026-10-24 用户报「下载时退出标签页，下载记录消失」。真机复现（live_check
// --download-test）得到的事实是：**跟关不关标签页无关** —— 用 popup 的「下载」
// 按钮拉下来的文件，记录从来就没写过：
//
//   修复前：文件已落盘 240000 字节，history 0 → 0，lastResult null
//   修复后：history 0 → 1，lastResult「成功 · live-check-probe (2) · 240000 字节」
//           （而且那一次仍然是在关掉标签页之后才完成的）
//
// 根因：notifySaved 只挂在页面浮层保存那条链（cmd:"saved"）上；native:download
// 这条链的完成回执（宿主 action:done/error/cancelled）只被转发给 popup，没有落地。
// 而用户点的是截图里那个「下载」按钮，走的就是后者。
//
// 这个文件测两件事：行为（notifySaved 真的写进 session.history）和防回退
// （nativePort.onMessage 里必须留住那条调用）。
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BG = path.join(__dirname, "..", "extension", "background.js");
const bg = fs.readFileSync(BG, "utf8");

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else {
    fail++;
    console.log("  ✗ " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 240) : ""));
  }
}
function section(t) { console.log("\n" + t); }

function extractFn(src, name) {
  let start = src.indexOf("function " + name + "(");
  if (start < 0) return null;
  // async 函数要从 async 开始切，否则函数体里的 await 变成语法错误
  // （报 "await is only valid in async functions"，很容易误判成切片范围错了）
  if (src.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

// ---------------------------------------------------------------- [1] 行为
section("[1] notifySaved 把成功/失败都写进 session.history");

const store = { local: {}, session: {} };
const log = [];
const sandbox = {
  console: { log() {}, warn() {}, error() {}, info() {} },
  Date, Number, String, Boolean, JSON, Object, Array, Math, Promise, Set, Map, RegExp, Error,
  chrome: {
    storage: {
      local: { set: (o) => { Object.assign(store.local, o); return Promise.resolve(); } },
      session: {
        get: (def) => Promise.resolve(Object.assign({}, def || {}, store.session)),
        set: (o) => { Object.assign(store.session, o); return Promise.resolve(); },
      },
    },
    action: {
      setBadgeText() { log.push("badge"); },
      setBadgeBackgroundColor() { log.push("badge-color"); },
    },
  },
};
sandbox.self = sandbox;
const ctx = vm.createContext(sandbox);

const badgeSrc = extractFn(bg, "markDoneBadge");
const notifySrc = extractFn(bg, "notifySaved");
if (!badgeSrc || !notifySrc) {
  console.error("抽不到 markDoneBadge / notifySaved，测试要跟着源码结构调整");
  process.exit(1);
}
try {
  vm.runInContext(badgeSrc + "\n" + notifySrc, ctx, { filename: "notifySaved" });
} catch (e) {
  console.error("函数在沙箱里跑不起来：" + e.message);
  process.exit(1);
}
const notifySaved = vm.runInContext("notifySaved", ctx);

(async () => {
  await notifySaved({ ok: true, filename: "D:\\down\\测 试 文件.mp4", size: 240000 });
  const h1 = store.session.history || [];
  ok("成功时写入一条记录", h1.length === 1, h1);
  ok("记录名取文件名（不含目录）", h1[0] && h1[0].name === "测 试 文件.mp4", h1[0] && h1[0].name);
  ok("记录带上字节数（宿主 done 消息里量的）", h1[0] && h1[0].size === 240000, h1[0] && h1[0].size);
  ok("成功记录 ok=true 且 error 为空", h1[0] && h1[0].ok === true && !h1[0].error);
  ok("lastResult 同时更新（「打开所在文件夹」靠它）", store.local.lastResult && store.local.lastResult.ok === true, store.local.lastResult);
  ok("打了角标", log.includes("badge"));

  await notifySaved({ ok: false, filename: "D:\\down\\bad.mp4", error: "分片 403" });
  const h2 = store.session.history || [];
  ok("失败也写记录（不能只记成功，失败才是排障素材）", h2.length === 2, h2.length);
  ok("失败记录带错误原文", h2[1] && /403/.test(String(h2[1].error)), h2[1] && h2[1].error);

  // 站点级建议（解释库 L4）：advice/adviceTitle 要独立透传，不能并进 error 字符串
  await notifySaved({ ok: false, filename: "D:\\down\\bad2.mp4", error: "分片 403", advice: "不是你的网络问题", adviceTitle: "这个站的分片经常断" });
  const hAdv = store.session.history || [];
  const advRec = hAdv[hAdv.length - 1];
  ok("建议独立字段透传（advice 不并进 error）", advRec && advRec.advice === "不是你的网络问题" && /403/.test(String(advRec.error)), advRec);
  ok("adviceTitle 透传", advRec && advRec.adviceTitle === "这个站的分片经常断", advRec && advRec.adviceTitle);
  ok("lastResult 也带建议", store.local.lastResult && store.local.lastResult.advice === "不是你的网络问题", store.local.lastResult);

  // 宿主取消：action=cancelled → ok=false，错误文案要给一句人话
  await notifySaved({ ok: false, filename: "x", error: "已取消" });
  const h3 = store.session.history || [];
  ok("取消也留痕", h3[h3.length - 1] && h3[h3.length - 1].ok === false, h3.length);

  // 边界：filename 为空不能崩，也不能写出 undefined 名字
  await notifySaved({ ok: true, filename: "", size: 0 });
  const h4 = store.session.history || [];
  ok("空 filename 不崩且名字有兜底", h4[h4.length - 1] && typeof h4[h4.length - 1].name === "string" && h4[h4.length - 1].name.length > 0,
    h4[h4.length - 1] && h4[h4.length - 1].name);

  ok("记录上限 100 条（超过丢最旧的）", /list\.length\s*>\s*100/.test(notifySrc) && /list\.shift\(\)/.test(notifySrc));

  // ---------------------------------------------------------------- [2] 防回退
  section("[2] nativePort.onMessage 必须自己收尾（防回退）");

  const npStart = bg.indexOf("nativePort.onMessage.addListener");
  const npEnd = bg.indexOf("nativePort.onDisconnect.addListener");
  const npSrc = npStart >= 0 && npEnd > npStart ? bg.slice(npStart, npEnd) : "";
  ok("找得到 nativePort.onMessage 分支", npSrc.length > 0);
  ok("完成回执分支存在（done / error / cancelled）",
    /action\s*===\s*"done"/.test(npSrc) && /"error"/.test(npSrc) && /"cancelled"/.test(npSrc), npSrc.slice(0, 200));
  ok("完成回执里调用了 notifySaved",
    npSrc.indexOf("notifySaved(") >= 0,
    "没有 notifySaved 就退回到「只有页面保存才记历史」的老 bug");
  ok("收尾后把任务从 downloads 里删掉（防 Map 长期增长）",
    /downloads\.delete\(msg\.id\)/.test(npSrc));
  ok("size 从宿主回执里取（宿主 done 消息现在会带上）",
    /Number\(msg\.size\)/.test(npSrc));

  console.log("\n" + (fail ? "有失败：" : "全部通过：") + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
