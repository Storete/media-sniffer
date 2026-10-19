// 跨世界常量同步检查。
//
// inject-main.js（MAIN world）和 background.js（service worker）不能 import 同一个
// 模块，所以站点特征正则被抄成了两份。抄写本身没问题，问题是改一处忘另一处：
// 两边判定不一致时，表现是「列表里该过滤的没过滤」或「正文图被当成装饰」，
// 而且极难查——因为每个文件单独看都是对的。
//
// 这里只做一件事：把两份定义抠出来比对。加新常量时照着扩展 PATTERNS 表即可。
"use strict";

const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..", "extension");
const MAIN = fs.readFileSync(path.join(EXT, "inject-main.js"), "utf8");
const BG = fs.readFileSync(path.join(EXT, "background.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

/** 抓 `const NAME = /regex/flags;` 或 `const NAME = /regex/flags`（缩进可有可无） */
function grabRegex(src, name) {
  const re = new RegExp("(?:^|\\n)\\s*(?:const|let|var)\\s+" + name + "\\s*=\\s*(/[^\\n]+/[a-z]*)", "m");
  const m = re.exec(src);
  return m ? m[1].trim() : null;
}

// 目前两边都有定义、且语义必须一致的常量
const PATTERNS = ["XHS_COMMENT_IMG"];

console.log("[1] 跨世界正则一致性");
for (const name of PATTERNS) {
  const a = grabRegex(MAIN, name);
  const b = grabRegex(BG, name);
  check(name + " 两边都有定义", !!a && !!b, { inject: a, background: b });
  if (a && b) check(name + " 定义完全一致", a === b, { inject: a, background: b });
}

// 结构检查：这两处都应该只在「同一份判定」里用，避免有人绕过常量直接写死一份
console.log("[2] 没有绕过常量写死的副本");
const hardcodedComment = /xhscdn\\\.com[^\n]*comment[^\n]*1040g/g;
const inMain = (MAIN.match(hardcodedComment) || []).length;
const inBg = (BG.match(hardcodedComment) || []).length;
check("inject-main 只有一处注释图特征", inMain <= 1, inMain);
check("background 只有一处注释图特征", inBg <= 1, inBg);

console.log("\n==============================================");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
