// popup 的静态接线检查。
//
// popup 没有 DOM 测试环境（不引 jsdom，保持零依赖），但 UI 最常见的故障不是逻辑，
// 而是「JS 里取了一个 HTML 里不存在的 id」—— 一改模板就白屏/按钮没反应，
// 而且只有手动开扩展才发现。这里把这类错误挡在 CI。
"use strict";

const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..", "extension");
const HTML = fs.readFileSync(path.join(EXT, "popup.html"), "utf8");
const JS = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
const CONTENT = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
const MAIN = fs.readFileSync(path.join(EXT, "inject-main.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

console.log("[1] popup.js 引用的 id 必须在 popup.html 里");
const refs = new Set();
for (const m of JS.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)) refs.add(m[1]);
const missing = [...refs].filter((id) => !new RegExp('id="' + id + '"').test(HTML));
check("引用了 " + refs.size + " 个 id，全部存在", missing.length === 0, missing);

console.log("[2] 批量选择的关键节点与事件");
for (const id of ["selectToggle", "batchBar", "selAllBox", "selInv", "selSave", "selDone"]) {
  check(`#${id} 在 HTML 里`, new RegExp('id="' + id + '"').test(HTML));
}
check("#selectToggle 绑定了 setSelecting", /#selectToggle"\)\.addEventListener\("click",\s*\(\)\s*=>\s*setSelecting/.test(JS));
check("#selSave 绑定了 saveSelected", /#selSave"\)\.addEventListener\("click"/.test(JS));
check("批量条默认隐藏", /id="batchBar" class="batch-bar hidden"/.test(HTML));
check("勾选框只给 page 条目", /if \(selecting && isPage\)/.test(JS));
check("保存所选复用 page:save-batch", /type: "page:save-batch"/.test(JS));

console.log("[3] 屏蔽站点");
check("有 #blockSite 按钮", /id="blockSite"/.test(HTML));
check("屏蔽写入 storage.local", /chrome\.storage\.local\.set\(\{ blockedHosts \}\)/.test(JS));
check("读取带默认值", /chrome\.storage\.local\.get\(\{ blockedHosts: \[\] \}\)/.test(JS));
check("被屏蔽时走 renderBlocked", /if \(siteBlocked\(\)\) renderBlocked\(\);/.test(JS));

console.log("[4] 重新扫描链路完整");
check("popup 发 ms:rescan", /type: "ms:rescan"/.test(JS));
check("content.js 处理 ms:rescan", /msg\.type === "ms:rescan"/.test(CONTENT));
check("content.js 转成 cmd:rescan", /cmd: "rescan"/.test(CONTENT));
check("inject-main 处理 rescan", /d\.cmd === "hello" \|\| d\.cmd === "rescan"/.test(MAIN));
check("rescan 会真的重扫 DOM", /try \{ scanMedia\(\); \}/.test(MAIN) && /try \{ scanImages\(\); \}/.test(MAIN));

console.log("\n==============================================");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
