/**
 * blob: 条目的取舍
 * 运行：node test/blob_item.test.js
 *
 * 真机（2026-10-23 三站审计）：
 *   红果短剧 4 条「视频」里 3 条是假的 —— 2 条 `blob:https://hongguoduanju.com/…`
 *   加 1 条 0 字节的占位地址；真正能下的只有那条 10MB 直链。
 *   腾讯视频 6 条视频里 3 条 blob，正片全程走 MSE。
 *
 * blob: 是页面 createObjectURL 出来的内部地址，宿主读不到，只能靠 MSE 录制
 * 拿到「已播放的部分」。所以：
 *   · 同一页**已经有**真实 http(s) 视频时 → blob 条目是纯噪声，删掉
 *   · 同一页**只有** blob 时 → 绝对不能删（Telegram 全站如此），删了列表就空
 *   · m\d+ 永不删 —— 那是扩展 appendBuffer 录到的真数据，是腾讯正片唯一路径
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "extension", "popup.js"), "utf8");

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra === undefined ? "" : "→ " + JSON.stringify(extra)); }
}

/** 从 popup.js 里抽出纯函数体，在沙箱里跑真代码（不复制实现） */
function grabFn(name) {
  const re = new RegExp("function " + name + "\\([\\s\\S]*?\\n\\}");
  const m = SRC.match(re);
  if (!m) throw new Error("popup.js 里找不到 function " + name);
  return m[0];
}

function call(name, list) {
  const ctx = { __list: list, __r: null };
  // dropBlobItems 依赖 hasCompleteMedia，一起注入（两个都是 popup.js 里的真代码）
  const prelude = name === "hasCompleteMedia" ? "" : grabFn("hasCompleteMedia") + "\n";
  vm.runInNewContext(prelude + grabFn(name) + "\n__r = " + name + "(__list);", ctx);
  return ctx.__r;
}

const V = (u, s, w, h) => ({ u, k: "video", s, w, h });
const A = (u, s) => ({ u, k: "audio", s });
const M = (n, s) => ({ u: "m" + n, k: "video", s });

console.log("\n[A] 函数存在性");
check("A1 popup.js 定义了 hasCompleteMedia", /function hasCompleteMedia\(/.test(SRC));
check("A2 popup.js 定义了 dropBlobItems", /function dropBlobItems\(/.test(SRC));
check("A3 shownItems 里真的调用了 dropBlobItems", /dropBlobItems\(/.test(
  (SRC.match(/function shownItems\(\)[\s\S]*?\n\}/) || [""])[0]));

console.log("\n[B] 红果短剧实测场景（1 条 10MB 直链 + 2 blob + 1 条 0 字节）");
const hg = [
  V("https://hongguoduanju.com/video/public/769/360p.mp4", 0),
  V("blob:https://hongguoduanju.com/2a78c65d", 0),
  V("blob:https://hongguoduanju.com/a2995e75", 0),
  V("https://v3-hgweb.qznovelvod.com/b4bd/okPVCgZ", 10004275, 360, 640),
];
const hgOut = call("dropBlobItems", hg);
check("B1 4 条 → 2 条（blob 两条清掉）", hgOut.length === 2, hgOut.map((x) => x.u));
check("B2 真实直链还在", hgOut.some((x) => x.u.includes("qznovelvod")));
check("B3 0 字节的 http 占位条目保留（可能只是没拿到 content-length）",
  hgOut.some((x) => x.u.includes("/video/public/")));
check("B4 一条 blob 都不剩", !hgOut.some((x) => /^blob:/i.test(x.u)));

console.log("\n[C] Telegram 场景（全站只有 blob）");
const tg = [
  V("blob:https://web.telegram.org/aaa", 0, 1280, 720),
  A("blob:https://web.telegram.org/bbb", 0),
];
const tgOut = call("dropBlobItems", tg);
check("C1 没有真实直链时一条都不能删", tgOut.length === 2, tgOut.length);
check("C2 视频 blob 还在", tgOut.some((x) => x.k === "video"));
check("C3 音频 blob 还在", tgOut.some((x) => x.k === "audio"));

console.log("\n[D] 腾讯视频场景（2 条 CDN 直链 + 3 blob + m2/m3 录制）");
const tx = [
  V("blob:https://v.qq.com/f9cf65d8", 0),
  V("https://c8ffddd9.v.smtcdns.com/a.mp4", 2469981),
  V("blob:https://v.qq.com/88289738", 0),
  A("m2", 192209),
  M(3, 1703966),
  V("https://c8ffddd9.v.smtcdns.com/b.mp4", 2218365),
  V("blob:https://v.qq.com/cecdccba", 0),
];
const txOut = call("dropBlobItems", tx);
check("D1 blob 三条全清", !txOut.some((x) => /^blob:/i.test(x.u)));
check("D2 m2/m3 录制条目必须留下（正片唯一可行路径）",
  txOut.some((x) => x.u === "m3") && txOut.some((x) => x.u === "m2"),
  txOut.map((x) => x.u.slice(0, 30)));
check("D3 CDN 直链保留", txOut.filter((x) => /^https:/.test(x.u)).length === 2);

console.log("\n[E] 边界");
check("E1 只有 m\\d+ 没有 http 时不算「有可完整下载的视频」",
  call("hasCompleteMedia", [M(3, 1703966), A("m2", 192209)]) === false);
check("E2 0 字节的 http 条目不构成替代（避免删了 blob 只剩空壳）",
  call("hasCompleteMedia", [V("https://x.com/a.mp4", 0), V("blob:https://x.com/1", 0)]) === false);
check("E3 空列表不炸", call("dropBlobItems", []).length === 0);
check("E4 图片/其他类型不参与判断",
  call("hasCompleteMedia", [{ u: "https://x.com/a.jpg", k: "image", s: 9000 },
    { u: "https://x.com/b.js", k: "other", s: 9000 }]) === false);
check("E5 音频直链也能构成替代", call("hasCompleteMedia",
  [A("https://x.com/a.m4a", 300000)]) === true);

console.log("\n==============================================");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
