// HLS/DASH 清单的分类与体积门槛。
//
// 2026-10-24 本地真机复现（hls.js + mux 3 档测试流）暴露：网页明明在放 HLS，
// 列表里**一条 m3u8 都没有**，只有 19 条分片和 MSE 录制条目。根因是两层叠加：
//
//   1. classify 先看 MIME 再看扩展名。清单的 MIME 五花八门 ——
//      `audio/mpegurl`（mux 就是这个）、`application/xml`、`text/plain`、
//      `application/vnd.apple.mpegurl` 全都合法。看 MIME 就必然把清单判成
//      audio / other，而不是 video。
//   2. record 的 MIN_MEDIA_BYTES 门槛按 kind 取值：video 是 2048 字节。
//      而真实 master playlist 只有 752 字节、media playlist 只有 231 字节
//      （都是 curl 实测），**整条被当成「1×1 像素级的假资源」丢掉**。
//
// 后果不是「少一条」：用户看不到「这是个 HLS 视频」，只能看到几百条分片，
// 于是既不知道怎么整段下，也不知道有哪些清晰度。
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BG = path.join(__dirname, "..", "extension", "background.js");

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  ✓ " + name);
  } else {
    fail++;
    console.log("  ✗ " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 200) : ""));
  }
}
function section(t) { console.log("\n" + t); }

// 行尾先归一化。本仓库 core.autocrlf=true，检出后 background.js 是 CRLF，
// 而下面用 "\n}\n" 找函数结尾——不归一化就匹配不到，indexOf 返回 -1，
// 再 +3 变成 2，slice(1255, 2) 得到**空字符串**。空字符串在沙箱里当然不报错，
// 于是错在下一行（classify is not defined），离真因隔了一层。
const bgsrc = fs.readFileSync(BG, "utf8").replace(/\r\n/g, "\n");

// 切出「分类规则」这一整块（EXT_TO_KIND / SEGMENT_EXT / extOf / kindFromMime / classify / isManifestUrl）。
// 起点必须在 EXT_TO_KIND 之前：classify 末尾要遍历它，切漏了会在沙箱里 ReferenceError。
const start = bgsrc.indexOf("const EXT_TO_KIND");
const cStart = bgsrc.indexOf("function classify(");
if (start < 0 || cStart < 0) {
  console.error("切不出分类代码块，测试文件需要跟着源码结构调整");
  process.exit(1);
}

// 结尾不能靠 "\n}\n" 这种文本锚点：
//   · 行尾一变（CRLF）就匹配不到 → indexOf 返回 -1，+3 变 2，切成空串；
//   · 大括号被格式化（`} ` 多个空格）就一路滑到**后面某个函数**的 `}`，
//     切片悄悄变长、把无关代码也吞进来，测试照样绿。
// 两种都是「切错了却看不出来」。数括号才是唯一稳的判据。
function bodyEnd(src, from) {
  const open = src.indexOf("{", from);
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

const cEnd = bodyEnd(bgsrc, cStart);
const slice = cEnd > cStart ? bgsrc.slice(start, cEnd) : "";

// 切空了比切错更危险：空切片能跑通，却让后面每条断言都无从谈起。
// 这类「什么都没测」必须当场炸，不能往下走。
if (cEnd <= cStart || slice.length < 200) {
  console.error("切片为空或明显不全（cStart=" + cStart + " cEnd=" + cEnd + " 长度=" + slice.length + "）");
  console.error("大概率是行尾格式或源码结构变了；别让空切片冒充「跑通了」");
  process.exit(1);
}
// 切多了同样要炸：一旦吞进后面的函数，这个文件测的就不再只是分类规则。
// 用紧邻下一段的真实代码当哨兵 —— 它出现在切片里就说明终点算错了。
if (slice.indexOf("function classify(") < 0) {
  console.error("切片里没有 classify —— 起点或终点算错了");
  process.exit(1);
}
if (slice.includes("new Map()") || slice.includes("function record(")) {
  console.error("切片越界：把后面的代码也切进来了，长度 " + slice.length);
  process.exit(1);
}
if (bgsrc[cEnd - 1] !== "}") {
  console.error("切片没停在 classify 的收尾大括号上（cEnd-1 = " + JSON.stringify(bgsrc[cEnd - 1]) + "）");
  process.exit(1);
}

const ctx = vm.createContext({
  URL,
  console,
  Set,
  Object,
  String,
  RegExp,
  Error,
});
try {
  vm.runInContext(slice, ctx, { filename: "classify-slice" });
} catch (e) {
  console.error("分类代码块在沙箱里跑不起来：" + e.message);
  console.error("切片范围 " + start + "~" + cEnd + "，可能是切到了半截函数");
  process.exit(1);
}

const classify = vm.runInContext("classify", ctx);
const extOf = vm.runInContext("extOf", ctx);
const hasManifestHelper = bgsrc.includes("function isManifestUrl(");
const isManifestUrl = hasManifestHelper ? vm.runInContext("isManifestUrl", ctx) : null;

// ---------------------------------------------------------------- [1] 清单优先于 MIME
section("[1] 清单扩展名必须压过 MIME（清单的 MIME 本来就不可靠）");

const M3U8 = "https://cdn.example.com/hls/index.m3u8";
ok("m3u8 + audio/mpegurl → video（mux 的真实 MIME）", classify(M3U8, "audio/mpegurl") === "video", classify(M3U8, "audio/mpegurl"));
ok("m3u8 + application/xml → video（curl 实测）", classify(M3U8, "application/xml; charset=UTF-8") === "video", classify(M3U8, "application/xml; charset=UTF-8"));
ok("m3u8 + text/plain → video（51cg1 就是这种）", classify(M3U8, "text/plain") === "video", classify(M3U8, "text/plain"));
ok("m3u8 + application/vnd.apple.mpegurl → video", classify(M3U8, "application/vnd.apple.mpegurl") === "video");
ok("m3u8 + 空 MIME → video", classify(M3U8, "") === "video");
ok("m3u8 + application/octet-stream → video（CDN 常见）", classify(M3U8, "application/octet-stream") === "video", classify(M3U8, "application/octet-stream"));

const MPD = "https://cdn.example.com/dash/manifest.mpd";
ok("mpd + text/plain → video", classify(MPD, "text/plain") === "video", classify(MPD, "text/plain"));
ok("mpd + application/xml → video", classify(MPD, "application/xml") === "video", classify(MPD, "application/xml"));

// ---------------------------------------------------------------- [2] 分片与常规类型不受影响
section("[2] 回归：分片与常规类型不能被这次改动带偏");

ok(".ts 即便 MIME 写 video/mp4 也是 seg", classify("https://a.com/x/seg-1.ts", "video/mp4") === "seg");
ok(".m4s 是 seg", classify("https://a.com/x/seg-1.m4s", "video/mp4") === "seg");
ok(".mp4 + video/mp4 → video", classify("https://a.com/a.mp4", "video/mp4") === "video");
ok(".jpg + image/jpeg → image", classify("https://a.com/a.jpg", "image/jpeg") === "image");
ok(".mp3 + audio/mpeg → audio", classify("https://a.com/a.mp3", "audio/mpeg") === "audio");
ok("无扩展名 /progressive/ 端点 → video", classify("https://t.me/progressive/document123", "") === "video");
ok(".m3u（老式音频列表）不误判成 video 以外的类别", classify("https://a.com/radio.m3u", "audio/x-mpegurl") === "audio", classify("https://a.com/radio.m3u", "audio/x-mpegurl"));
ok("query 里的 .m3u8 不该被当扩展名", extOf("https://a.com/play?url=x.m3u8") === "", extOf("https://a.com/play?url=x.m3u8"));

// ---------------------------------------------------------------- [3] 体积门槛豁免
section("[3] 清单必须豁免最小体积门槛");

if (!hasManifestHelper) {
  ok("存在 isManifestUrl() 供体量门槛调用", false, "源码里没有 function isManifestUrl(");
} else {
  ok("m3u8 → 是清单", isManifestUrl("https://a.com/x/index.m3u8") === true);
  ok("m3u8 带 query → 是清单", isManifestUrl("https://a.com/x/index.m3u8?token=abc") === true);
  ok("大写扩展名 → 是清单", isManifestUrl("https://a.com/x/INDEX.M3U8") === true);
  ok("mpd → 是清单", isManifestUrl("https://a.com/dash/manifest.mpd") === true);
  ok("mp4 → 不是清单", isManifestUrl("https://a.com/a.mp4") === false);
  ok("ts 分片 → 不是清单", isManifestUrl("https://a.com/x/seg.ts") === false);
  ok("query 里的 .m3u8 → 不是清单（与 isHlsUrl 同一判据）", isManifestUrl("https://a.com/play?url=x.m3u8") === false);
  ok("空值不崩", isManifestUrl("") === false);
  ok("非法 URL 不崩", isManifestUrl("not a url") === false);
}

// ---------------------------------------------------------------- [4] 真实尺寸回归
section("[4] 用实测尺寸确认门槛会误杀（这条是本次 bug 的量化证据）");

const REAL_MASTER = 752;   // curl test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
const REAL_MEDIA = 231;    // curl .../url_862/..._hq.m3u8
const MIN_VIDEO = 2048;    // background.js MIN_MEDIA_BYTES.video
ok("master 752 字节 < video 门槛 2048（所以旧逻辑必丢）", REAL_MASTER < MIN_VIDEO);
ok("media 231 字节 < video 门槛 2048（所以旧逻辑必丢）", REAL_MEDIA < MIN_VIDEO);
ok("豁免后判定：master 属于清单", !hasManifestHelper || isManifestUrl("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8") === true);

console.log("\n" + (fail ? "有失败：" : "全部通过：") + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
