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

console.log("\n==============================================");
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
