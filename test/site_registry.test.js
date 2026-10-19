/**
 * [A0] 站点注册表的结构约束
 *
 * 这一套不测「功能对不对」（那是 main-hook.test.js 的事），只测**架构约束**：
 * 通用层不许再出现站点专属判断。用户诉求原话：
 *   「给功能分组，方便快速定位问题」「图片和视频下载是否有通用的代码，
 *     是否需要针对特定应用添加逻辑」
 *
 * 为什么需要这套：模块化一旦没有约束，下一个人加站点时最省事的做法
 * 仍然是在 scanImages 里再抄一个 `if (isXhsHost())`，几个月后又会退化成
 * 一坨 if。把它变成测试，退化会立刻变红。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "extension", "inject-main.js"), "utf8");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail !== undefined ? " → " + JSON.stringify(detail) : "")); }
}

console.log("\n[A0-1] 站点注册表存在且结构正确");

check("定义了 SITES 注册表", /const SITES = \[\];/.test(SRC));
check("有 activeSite() 解析当前站点", /function activeSite\(\)/.test(SRC));
check("SITES 至少注册了一个站点", /SITES\.push\(\{/.test(SRC));

// 每个注册项都必须有 name 和 match —— 没有 match 的对象永远不会被选中（静默失效）
const pushes = SRC.match(/SITES\.push\(\{[\s\S]*?\n  \}\);/g) || [];
check("SITES.push 能解析到注册项", pushes.length >= 1, pushes.length);
for (const p of pushes) {
  const nameM = /name:\s*"([^"]+)"/.exec(p);
  const nm = nameM ? nameM[1] : "?";
  check(`站点 ${nm} 有 match 钩子`, /match:/.test(p));
}

console.log("\n[A0-2] 通用层不出现站点专属判断（防回退成 if 汤）");

// 找通用函数体的边界：从函数定义到下一个顶层 `function ` 或段落注释
function bodyOf(fnName) {
  const start = SRC.indexOf("function " + fnName + "(");
  if (start < 0) return null;
  const after = SRC.indexOf("\n  function ", start + 10);
  const afterAsync = SRC.indexOf("\n  async function ", start + 10);
  let end = SRC.length;
  if (after > 0) end = Math.min(end, after);
  if (afterAsync > 0) end = Math.min(end, afterAsync);
  return SRC.slice(start, end);
}

const GENERIC = ["guessTitle", "scanImages", "scanMedia", "handleMediaSrc", "reportXhsVideo"];
const SITE_HINTS = [
  /isXhsHost\(\)/,
  /isBiliHost\(\)/,
  /\bxiaohongshu\b/i,
  /\bbilibili\b/i,
];

for (const fn of GENERIC) {
  const body = bodyOf(fn);
  if (body === null) { check(`能定位到 ${fn}()`, false); continue; }
  // 去掉注释再判断：注释里解释「以前这里是 if (isXhsHost())」是允许的
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const hit = SITE_HINTS.find((re) => re.test(code));
  check(`${fn}() 里没有站点专属判断`, !hit, hit ? String(hit) : undefined);
}

console.log("\n[A0-3] 站点钩子都通过注册表转发，而不是硬编码");

check("guessTitle 走 site.title", /site\.title/.test(bodyOf("guessTitle") || ""));
check("scanImages 走 site.isDecorImg / owns",
  /site\.isDecorImg/.test(bodyOf("scanImages") || "") && /site\.owns/.test(bodyOf("scanImages") || ""));
check("scanImages 走 site.onScanImages（清单通路）", /site\.onScanImages/.test(bodyOf("scanImages") || ""));
check("scanMedia 走 site.videoSrc / owns",
  /site\.videoSrc/.test(bodyOf("scanMedia") || "") || /site\.owns/.test(bodyOf("scanMedia") || ""));

console.log("\n[A0-4] 下载层也不许出现站点专属判断（2026-10-19 第二轮模块化）");
//
// 背景：扫描层模块化之后，下载调度层还留着 4 处硬编码 ——
//   startMediaDownload 的 `const useBili = isBiliHost() && biliPlayinfo()`
//   overlayShow/runSave 的 `if (isBiliHost() && biliPlayinfo())`
//   overlayShow 底部文案的 `isBiliHost() ? "B 站走完整流…" : "…"`
//   beginSaveBatch 的 `biliSig = ""`
// 它们让「加一个新站点」必须回去改通用函数。现在统一走站点对象：
//   canFeedDownload / feedDownload / saveHint / onSaveStart

check("有 siteCanFeed() 统一入口", /function siteCanFeed\(/.test(SRC));
check("有 siteSaveHint() 统一入口", /function siteSaveHint\(/.test(SRC));
check("有 siteResetReport() 统一入口", /function siteResetReport\(/.test(SRC));

const DL_GENERIC = ["startMediaDownload", "overlayShow", "beginSaveBatch"];
for (const fn of DL_GENERIC) {
  const body = bodyOf(fn);
  if (body === null) { check(`能定位到 ${fn}()`, false); continue; }
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  // overlayShow 里的 runSave 是闭包，bodyOf 拿不到它，单独测（见下）
  const hit = SITE_HINTS.find((re) => re.test(code));
  check(`${fn}() 里没有站点专属判断`, !hit, hit ? String(hit) : undefined);
}

// runSave 是 overlayShow 内部的闭包 —— 单独抠出来测
const runSaveStart = SRC.indexOf("const runSave = (it, btn) =>");
const runSaveEnd = runSaveStart < 0 ? -1 : SRC.indexOf("\n    };", runSaveStart);
const runSaveBody = runSaveStart < 0 ? "" : SRC.slice(runSaveStart, runSaveEnd);
check("能定位到 overlayShow 里的 runSave", runSaveStart >= 0 && runSaveEnd > runSaveStart);
check("runSave 里没有站点专属判断",
  !SITE_HINTS.find((re) => re.test(runSaveBody.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""))));
check("runSave 走 siteCanFeed", /siteCanFeed\(/.test(runSaveBody));

console.log("\n[A0-5] 下载层钩子确实被通用函数用上了");

check("startMediaDownload 走 siteCanFeed", /siteCanFeed\(/.test(bodyOf("startMediaDownload") || ""));
check("startMediaDownload 走 site.feedDownload",
  /\.feedDownload\b/.test(bodyOf("startMediaDownload") || ""));
check("overlayShow 底部文案走 siteSaveHint", /siteSaveHint\(\)/.test(bodyOf("overlayShow") || ""));
check("hello/rescan 重报走 siteResetReport", /siteResetReport\(\)/.test(SRC));

// d-018：内容归属与回放也走注册表。rescan 块 1.3.11 里还直调 reportBiliDash()，
// 与 siteResetReport 并排 —— 那是重构停差一行的地方。
check("回放重报走 siteReplayReport（不许直调 reportBiliDash）",
  /siteReplayReport\(\)/.test(SRC)
  && !/siteResetReport\(\);\s*\n\s*reportBiliDash\(\)/.test(SRC));
check("post() 注入 siteContentId（blob/MSE 条目的 noteId）",
  /siteContentId\(\)/.test(SRC)
  && /d\.cmd === "found" \|\| d\.cmd === "progress"/.test(SRC));

// B 站站点对象必须把 4 个下载层钩子都实现，否则泄漏只是换了个位置
const biliPush = (SRC.match(/SITES\.push\(\{\s*\n\s*name:\s*"bilibili"[\s\S]*?\n  \}\);/) || [""])[0];
check("注册了 bilibili 站点对象", biliPush.length > 0);
for (const hook of ["canFeedDownload", "feedDownload", "saveHint", "onSaveStart", "replayReport"]) {
  check(`bilibili 实现了 ${hook}`, new RegExp(hook + "\\s*:").test(biliPush));
}
// 小红书必须提供内容 id（background 的按 noteId 隔离全靠它供数）
const xhsPush = (SRC.match(/SITES\.push\(\{\s*\n\s*name:\s*"xiaohongshu"[\s\S]*?\n  \}\);/) || [""])[0];
check("注册了 xiaohongshu 站点对象", xhsPush.length > 0);
check("xiaohongshu 实现了 contentId", /contentId\s*:/.test(xhsPush));

console.log("\n==============================================");
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
