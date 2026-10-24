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
// B28「整页解析」按钮（1.3.60）：入口存在 + 发 native:download-page + 有降级文案
check("#pageDl 按钮在 HTML 里", /id="pageDl"/.test(HTML));
check("#pageDl 绑定了点击处理", /#pageDl"\)\.addEventListener\("click"/.test(JS));
check("整页解析发 native:download-page", /type: "native:download-page"/.test(JS));
check("background 处理 native:download-page", /case "native:download-page":/.test(fs.readFileSync(path.join(EXT, "background.js"), "utf8")));
check("chrome:// 页面有拦截提示", /交不了给本地解析器/.test(JS));

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
check("变体标注是「同目录第 N/M 个清单」", /同目录第 /.test(JS));
// 2026-10-24 51cg1 真机：四条全是变体、页面上没有主清单，界面上却写着
// 「整段下载请点主清单」，用户找不到那一行。这句必须挂在 hasMaster 后面。
check("没有主清单时不喊「请点主清单」", /if \(fam\.hasMaster\) bits\.push\("整段下载请点主清单"\)/.test(JS));
check("清单条目显示时长与段数", /bits\.push\(dur \+ \(segs \? " · " \+ segs \+ " 段" : ""\)\)/.test(JS));

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
  /filename: downloadName\(it\)/.test(JS));
// 这条以前写成 /filename: it\.f \|\| \(it\.title …/ —— 匹配的正是**有 bug 的写法**
// （it.f 是 URL 末段的哈希，永远赢），等于把错误行为锁死了。
// 2026-10-24 用户真机下到 449820be….mp4 才发现。现在反过来：不许再出现哈希优先。
check("下载链不许再出现「URL 名优先」",
  !/filename: it\.f \|\|/.test(JS));
check("downloadName 委托给 naming.js（规则只留一处）",
  /return MSNaming\.downloadName\(it\)/.test(JS));

console.log("[8] 列表行号：按出现顺序编号（用户 2026-10-23 51cg1 截图）");
// 51cg1 详情页有两条 m3u8：一条页面钩子上报（有站点标题）、一条 webRequest 抓的（无标题）。
// 两条都叫「HLS 流（视频）」，用户看不出哪个是哪个 —— 点错了下到的是另一路流。
// 行号必须是**当前列表的显示顺序**，不是 it.idx（那是 ①②③ 的池子，按消息分组编的）。
check("renderList 把显示顺序传给 renderItem",
  /box\.append\(renderItem\(items\[i\], i \+ 1(?:, [^)]+)?\)\)/.test(JS));
check("renderItem 接收行号", /function renderItem\(it, no(?:, [^)]+)?\)/.test(JS));
// 同一页多条 m3u8 时必须能说出「哪条是主清单、哪条是第几档」，
// 否则用户面对三条一模一样的「HLS 流（视频）」只能靠猜（2026-10-24 用户截图）。
// 只钉「传了 hlsFamily」这个事实，不钉参数个数：2026-10-24 加了同片折叠
// （第四个参数 groupOf），旧断言写死 `renderItem(items[i], i + 1, hlsFamily)`
// 直接变红 —— 那是断言把实现细节锁死了，不是实现错了。
check("renderList 把清单族传给 renderItem",
  /renderItem\(items\[i\], i \+ 1, hlsFamily[,)]/.test(JS));
check("renderList 把同片折叠的结论也传给 renderItem（第二参数位）",
  /renderItem\(items\[i\], i \+ 1, hlsFamily, movie\.groupOf\)/.test(JS));
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

// 下载记录里的失败原因：**必须可见**，不许只放在 title 里。
// 「下不下来时告诉你为什么」是这产品唯一的卖点；塞进 tooltip 等于没做。
check("失败记录把原因渲染成可见元素（.h-why），不是只挂 title",
  /className\s*=\s*"h-why"/.test(JS) && /why\.textContent\s*=\s*it\.error/.test(JS));
check("CSS 里失败行允许换行（否则原因会被挤成一团）",
  /\.h-item\.err\s*\{\s*flex-wrap:\s*wrap/.test(CSS));
check("原因行占满整行宽度（flex-basis:100%）",
  /\.h-why\s*\{[\s\S]{0,120}flex:\s*0 0 100%/.test(CSS));
check("错误码进 title（诊断时能念出来），不占用可见行",
  /why\.title\s*=\s*\(it\.code/.test(JS));

// 站点级建议（解释库 L4）：与「这一次为什么失败」分两行，带「已知问题」标题。
check("站点级建议渲染成独立行（.h-advice），不并进 .h-why",
  /className\s*=\s*"h-advice"/.test(JS) && /it\.advice/.test(JS));
check("建议行带「已知问题」标题（adviceTitle 兜底成「已知问题」）",
  /adviceTitle\s*\|\|\s*"已知问题"/.test(JS));
check("CSS 给建议行整行宽度 + 琥珀色（与红色失败原因区分）",
  /\.h-advice\s*\{[\s\S]{0,160}flex:\s*0 0 100%[\s\S]{0,80}color:\s*#92400e/.test(CSS));

console.log("[?] 选清晰度（S1）的接线");

// 这一刀最容易坏在「接了 UI 却没接到下载」：下拉框能选，点了下载还是 master，
// 用户以为换了档、其实没有。所以三处必须同时钉住。
check("有档位选择行（.vsel）",
  /function variantRow\(it\)/.test(JS) && /el\("div", "vsel"\)/.test(JS));
check("只对主清单出选择（变体/单清单不该有档位）",
  /it\.listKind !== "master"/.test(JS));
check("不足 2 档不出选择（一档的不给假选项）",
  /vs\.length < 2/.test(JS));
check("档位按高度降序排（与宿主 pick_variant 同序）",
  /heightOf\(b\) - heightOf\(a\)/.test(JS));
check("标签优先用分辨率（1080P），不是「第 N 档」",
  /if \(h\) return h \+ "P"/.test(JS));
check("选择存进 variantPick（本次会话有效）",
  /variantPick\.set\(it\.u, sel\.value\)/.test(JS));
// 这里必须带**行首锚**：第一版写的是 /variant: chosen/，而把这一行注释掉
// （`// variant: chosen,`）也能匹配上 —— 反向验证照绿，等于没钉住。
check("**下载时真的用了选中的档**（这是本刀的判据）",
  /const chosen = variantPick\.get\(it\.u\)/.test(JS)
  && /^\s*variant:\s*chosen,/m.test(JS));
check("CSS 给了档位行的样式（.vsel-sel）",
  /\.vsel-sel\s*\{/.test(CSS));

console.log("\n==============================================");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
