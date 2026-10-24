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
check("勾选框只给 page 条目（HLS 除外，见 [7]）", /if \(selecting && isPage && !isHlsItem\(it\)\)/.test(JS));
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

console.log("[5] HLS 条目的展示（用户 m16052：51cg1 / 4kvm）");
// m3u8 是文本清单，以前和 mp4 一样显示成「视频 29KB」，用户以为下到了坏文件。
check("popup 有 isHlsItem 判定", /function isHlsItem\(it\)/.test(JS));
check("isHlsItem 认 hint=hls", /it\.hint === "hls"/.test(JS));
check("isHlsItem 退回 URL 后缀判（老 state 没有 hint 也能认）", JS.indexOf("m3u8$/i") >= 0);
check("displayName 里 HLS 走专用名字", /HLS 流（视频）/.test(JS));
// 名字里已经有「HLS 流（视频）」，副行不要再重复一次；三条并列时靠副行区分。
check("副行提示这是分片清单", /bits\.push\("分片清单"\)/.test(JS));
check("副行提示点下载会自动拼", /点下载自动拼成完整视频/.test(JS));
check("主清单标注含几个清晰度清单", /主清单 · 含 /.test(JS));
check("变体标注是同一视频的第几个清单", /同一视频的第 /.test(JS));

// 真机 51cg1 的现象：有 m3u8 的页面同时存在 blob: 录制条目和 m1/m2 分片，
// 同一条视频在列表里显示三份。hideRecorder 必须把它们一并隐掉。
// 但反过来——只有 blob/mN 没有 m3u8 的站——绝不能隐，否则用户什么都看不到。
check("hideRecorder 会在有 m3u8 时隐掉录制条目",
  /function hideRecorder\(\)\s*\{[\s\S]{0,400}allItems\.some\(isHlsItem\)/.test(JS));
check("hideRecorder 仍然保留 B 站 / 小红书的原有判据",
  /isBiliSite\(\) \|\| isXhsDetailPage\(\) \|\| allItems\.some\(isHlsItem\)/.test(JS));
check("隐录制条目的前提是页面上真有 m3u8（不是无条件隐）",
  JS.indexOf("只认 blob/mN 的站") >= 0);

console.log("[6] 进度条要显示准备期的阶段文案（B21）");
// 宿主在「拉清单 / 探请求头 / yt-dlp 解析分片」这几段给的是 message、没有 percent。
// updateJob 以前只拼百分比，宿主写了 message 也看不见 —— 用户看到的就是一根停着的
// 0% 空槽（真机 2026-10-22：近 2 分钟一动不动）。
const CSS = fs.readFileSync(path.join(EXT, "popup.css"), "utf8");
check("updateJob 会渲染 msg.message", /if \(msg\.message\) bits\.push\(msg\.message\)/.test(JS));
check("没有百分比也没有文案时兜底「下载中」", /if \(!bits\.length\) bits\.push\("下载中"\)/.test(JS));
check("准备期给进度条挂 wait 类", /classList\.toggle\("wait", !pct && !!msg\.message\)/.test(JS));
check("结束态要摘掉 wait 类（否则光带一直走）",
  (JS.match(/classList\.remove\("wait"\)/g) || []).length >= 2);
check("CSS 有 wait 的动画", /\.job\.wait \.bar i\s*\{[\s\S]{0,120}animation:\s*jobwait/.test(CSS));
check("CSS 有 jobwait 关键帧", /@keyframes jobwait/.test(CSS));

console.log("[7] HLS 条目按类型分派，不按来源分派（B22）");
// 真机 2026-10-22：DPlayer 页面 data-config 里读出来的那条 m3u8 带站点标题、看着最像
// 「该点的那条」，但它 page=1 → 只给「预览/保存」；点保存 = 页面去 Range 拉 m3u8，
// 拿到 38.5KB 清单文本。用户原话：「上面那个用不了，下面那个能用」。
check("页面分支要排除 HLS（否则带标题的 HLS 只能「保存」）",
  /if \(isPage && !isHlsItem\(it\)\)/.test(JS));
check("非页面分支的下载按钮仍在（HLS 走这条）",
  /const dl = el\("button", "btn primary", "下载"\)/.test(JS));
check("HLS 不挂预览（Chrome 的 video 不会放 HLS，点了必然失败）",
  /canPreviewSrc\(it\) && !isHlsItem\(it\)/.test(JS));
check("HLS 不许进「保存所选」批量（否则批量下一堆清单文本）",
  /if \(selecting && isPage && !isHlsItem\(it\)\)/.test(JS));
check("页面条目下载时用标题当文件名（否则落盘是哈希名）",
  /filename: it\.f \|\| \(it\.title \? shortTitle\(it\.title\) : ""\)/.test(JS));

console.log("[8] 列表行号：按出现顺序编号（用户 2026-10-23 51cg1 截图）");
// 51cg1 详情页有两条 m3u8：一条页面钩子上报（有站点标题）、一条 webRequest 抓的（无标题）。
// 两条都叫「HLS 流（视频）」，用户看不出哪个是哪个 —— 点错了下到的是另一路流。
// 行号必须是**当前列表的显示顺序**，不是 it.idx（那是 ①②③ 的池子，按消息分组编的）。
check("renderList 把显示顺序传给 renderItem",
  /box\.append\(renderItem\(items\[i\], i \+ 1(?:, [^)]+)?\)\)/.test(JS));
check("renderItem 接收行号", /function renderItem\(it, no(?:, [^)]+)?\)/.test(JS));
// 同一页多条 m3u8 时必须能说出「哪条是主清单、哪条是第几档」，
// 否则用户面对三条一模一样的「HLS 流（视频）」只能靠猜（2026-10-24 用户截图）。
check("renderList 把清单族传给 renderItem",
  /renderItem\(items\[i\], i \+ 1, hlsFamily\)/.test(JS));
check("清单族按全量条目算，不按筛选后的可见列表",
  /MSHlsFamily\.build\(allItems\)/.test(JS));
check("行号建成独立的 .no 元素（不混进 displayName，否则会被标题截断吃掉）",
  /const noEl = el\("div", "no"/.test(JS));
check("行号排在类型徽标之前", JS.indexOf('row.append(noEl)') >= 0
  && JS.indexOf('row.append(noEl)') < JS.indexOf('row.append(badge)'));
check("批量模式下勾选框在最左（行号在它右边，两种模式同一列）",
  JS.indexOf("row.append(box)") >= 0 && JS.indexOf("row.append(box)") < JS.indexOf("row.append(noEl)"));
check("CSS 给 .no 固定宽度（否则名字列宽随序号位数跳动）",
  /\.no\s*\{[\s\S]{0,160}flex:\s*0 0 \d+px/.test(CSS));

console.log("\n==============================================");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
