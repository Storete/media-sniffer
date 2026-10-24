// B29 页面侧解析器：右键元素 → 真实媒体地址（inject-main.js 的 msPickFromElement）。
//
// 为什么单独测它：background 链（context_menu.test.js）测的是「拿到地址之后」，
// 这里测「地址从哪来」。Chrome 的 info.srcUrl 只认识 <img src>/<video src>，
// 这五类真实站点形态它全都拿不到，是整个右键菜单存在的理由：
//   · 懒加载图（data-src / data-original / data-lazy-src）
//   · srcset 多候选（要取宽度最大的）
//   · <picture> 的 <source>（优先级高于 img 自身）
//   · <video> 的 currentSrc / <source> 子元素
//   · 背景图（div + background-image）
//
// 手写最小 DOM 桩（不引 jsdom）：只实现解析器摸得到的那几个方法。
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FILE = path.join(__dirname, "..", "extension", "inject-main.js");
const src = fs.readFileSync(FILE, "utf8");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name + (extra === undefined ? "" : "  -> " + JSON.stringify(extra).slice(0, 200))); }
}
function section(t) { console.log("\n" + t); }

function extractFn(name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) return null;
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

// ---- 最小 DOM 桩 ----
function el(spec) {
  // spec: { tag, attrs:{}, src, currentSrc, srcset, style, parent:{sources:[],cls}, childSources:[], nearTitle }
  const attrs = spec.attrs || {};
  const node = {
    nodeType: 1,
    tagName: (spec.tag || "DIV").toUpperCase(),
    getAttribute(a) { return attrs[a] !== undefined ? attrs[a] : null; },
    get src() { return spec.src || ""; },
    get currentSrc() { return spec.currentSrc || ""; },
    get srcset() { return spec.srcset || ""; },
    querySelectorAll() { return spec.sources || []; },
    querySelector() { return spec.childSource ? { src: spec.childSource } : null; },
    closest(sel) {
      if (sel === "picture" && spec.inPicture) return { querySelectorAll: () => spec.pictureSources || [] };
      if (/card|item|figure/.test(sel) && spec.nearTitle !== undefined) {
        return { querySelector: (s2) => (/title|figcaption/.test(s2) && spec.nearTitle ? { textContent: spec.nearTitle } : null) };
      }
      return null;
    },
  };
  node.style = spec.bg ? { backgroundImage: 'url("' + spec.bg + '")' } : { backgroundImage: "none" };
  // msPickFromElement 里 srcset 走 getAttribute（HTML 属性），不走 .srcset 属性
  if (spec.srcset && attrs.srcset === undefined) attrs.srcset = spec.srcset;
  return node;
}
// getComputedStyle 桩走全局
const styleMap = new Map();

const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  URL, Date, String, Number, Array, Object, RegExp, Error, Math,
  location: { href: "https://shop.example.com/item/1" },
  document: { title: "页面标题", addEventListener() {} },
  getComputedStyle: (el) => el.style,
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

const picked = [
  extractFn("msAbs"), extractFn("msNameFrom"), extractFn("msPickSrcset"), extractFn("msPickFromElement"),
];
if (picked.some((f) => !f)) { console.error("抽不到解析函数（要跟着源码结构调整）"); process.exit(1); }
vm.runInContext(picked.join("\n"), ctx, { filename: "pick" });
const pick = vm.runInContext("msPickFromElement", ctx);

section("[1] IMG：currentSrc > src > srcset > data-src");
ok("currentSrc 优先", pick(el({ tag: "img", currentSrc: "https://c/cur.jpg", src: "https://c/src.jpg" })).url === "https://c/cur.jpg");
ok("无 currentSrc 落 src", pick(el({ tag: "img", src: "https://c/src.jpg" })).url === "https://c/src.jpg");
ok("srcset 取宽度最大候选", pick(el({ tag: "img", srcset: "https://c/s.jpg 320w, https://c/l.jpg 1280w, https://c/m.jpg 640w" })).url === "https://c/l.jpg");
ok("懒加载 data-src 兜底", pick(el({ tag: "img", attrs: { "data-src": "https://c/lazy.jpg" } })).url === "https://c/lazy.jpg");
ok("懒加载 data-original 兜底", pick(el({ tag: "img", attrs: { "data-original": "https://c/orig.jpg" } })).url === "https://c/orig.jpg");
const r1 = pick(el({ tag: "img", src: "img/a.png" }));
ok("相对地址转绝对（URL 标准语义：替换最后一段）", r1.url === "https://shop.example.com/item/img/a.png", r1.url);

section("[2] <picture>：<source> 优先于 img 自身");
ok("picture 的 source 被选中",
   pick(el({ tag: "img", src: "https://c/fallback.jpg", inPicture: true, pictureSources: [{ getAttribute: (a) => (a === "srcset" ? "https://c/webp 800w" : null) }] })).url === "https://c/webp");

section("[3] VIDEO/AUDIO：currentSrc > src > <source>");
ok("video currentSrc 优先", pick(el({ tag: "video", currentSrc: "https://c/cur.mp4", src: "https://c/src.mp4" })).url === "https://c/cur.mp4");
ok("video 落 <source> 子元素", pick(el({ tag: "video", childSource: "https://c/from-source.mp4" })).url === "https://c/from-source.mp4");
const a3 = pick(el({ tag: "audio", src: "https://c/a.mp3" }));
ok("audio 的 kind=audio", a3.url === "https://c/a.mp3" && a3.kind === "audio", a3);

section("[4] 背景图（图墙的常见形态）");
const bg = pick(el({ tag: "div", bg: "https://c/wall.jpg" }));
ok("背景图 url 被解析", bg.url === "https://c/wall.jpg" && bg.kind === "image", bg);

section("[5] 解析不出（纯文本/空白处）返回 null——旧记录由调用方清掉");
ok("无地址 DIV → null", pick(el({ tag: "div" })) === null);
ok("非元素节点 → null", pick(null) === null);

section("[6] 命名：alt → 邻近标题 → 文档标题（别落成 video.mp4）");
ok("alt 优先", pick(el({ tag: "img", src: "https://c/x.jpg", attrs: { alt: "红色连衣裙" } })).name === "红色连衣裙");
ok("无 alt 落邻近卡片标题",
   pick(el({ tag: "img", src: "https://c/x.jpg", nearTitle: "春季新品" })).name === "春季新品");
ok("都没有落文档标题", pick(el({ tag: "img", src: "https://c/x.jpg" })).name === "页面标题");

console.log("\n" + (fail ? "有失败：" : "全部通过：") + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
