/**
 * HLS 清单正文解析单测（先红后绿）。
 *
 * 为什么需要这个模块：
 *   用户截图里四条「HLS 流（视频）」全是 5KB 级，文案一模一样，
 *   他问「有什么区别、该点哪个」。真机取证（51cg1）给出答案：
 *     /m3m/<hex>.m3u8      29 KB  → 179 段 × 6s = 1074s（17:54，播放器在用的正片）
 *     /videos5/<md5>/…m3u8  5 KB  → 页面预载的小清单，不是播放器实际在播的那条
 *   而用户点的是后者，下到的文件名就是那个 md5。
 *
 *   判据只能来自**清单正文**：段数、总时长、是否加密、有几个变体。
 *   以前扩展只监听地址、从不读内容，所以这四条在界面上无从区分。
 *
 * 这个模块只做「文本 → 结构」，不碰网络、不碰 chrome、不碰 DOM。
 * 读体那一侧（inject-main 的 fetch/XHR hook）只负责把文本喂进来。
 */
"use strict";
const path = require("path");
const MSHlsMeta = require(path.join(__dirname, "..", "extension", "hls-meta.js"));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log("  ✗ " + name);
  if (detail !== undefined) console.log("      " + JSON.stringify(detail).slice(0, 240));
}
function section(t) { console.log("\n" + t); }

// ---------------------------------------------------------------- [1] 媒体清单
section("[1] 媒体清单（#EXTINF 一条一段）");

const MEDIA = [
  "#EXTM3U",
  "#EXT-X-WJ-T:-0",
  "#EXT-X-VERSION:6",
  '#EXT-X-MAP:URI="https://mts.example.com/a/init_0.m4s"',
  "#EXT-X-MEDIA-SEQUENCE:0",
  "#EXT-X-TARGETDURATION:9",
  "#EXTINF:6.000,",
  "https://mts.example.com/a/seg_1.m4s",
  "#EXTINF:6.000,",
  "https://mts.example.com/a/seg_2.m4s",
  "#EXTINF:4.500,",
  "https://mts.example.com/a/seg_3.m4s",
  "#EXT-X-ENDLIST",
].join("\n");

const m = MSHlsMeta.parse(MEDIA);
ok("kind = media", m.kind === "media", m.kind);
ok("段数 = 3", m.segs === 3, m.segs);
ok("总时长 = 16.5s", Math.abs(m.dur - 16.5) < 1e-6, m.dur);
ok("未加密", m.encrypted === false, m.encrypted);
ok("变体数为 0", m.variants.length === 0, m.variants.length);

// ---------------------------------------------------------------- [2] 主清单
section("[2] 主清单（#EXT-X-STREAM-INF）");

const MASTER = [
  "#EXTM3U",
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
  "url_8/1080p.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720",
  "url_0/720p.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=800000",
  "url_6/360p.m3u8",
].join("\n");

const M = MSHlsMeta.parse(MASTER);
ok("kind = master", M.kind === "master", M.kind);
ok("变体 3 个", M.variants.length === 3, M.variants.length);
ok("第一档 1920x1080", M.variants[0].res === "1920x1080", M.variants[0]);
ok("第一档带宽 5000000", M.variants[0].bandwidth === 5000000, M.variants[0]);
ok("第三档没有 RESOLUTION → res 为空串", M.variants[2].res === "", M.variants[2]);
ok("主清单本身没有段", M.segs === 0, M.segs);
ok("主清单时长 0（时长要靠子清单）", M.dur === 0, M.dur);
ok("变体地址是相对路径，原样保留", M.variants[1].url === "url_0/720p.m3u8", M.variants[1].url);

// ---------------------------------------------------------------- [3] 加密与 init
section("[3] 加密 / init 段");

const ENC = [
  "#EXTM3U",
  '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
  "#EXTINF:10,",
  "s1.ts",
].join("\n");
ok("AES-128 判为加密", MSHlsMeta.parse(ENC).encrypted === true);
ok("METHOD=NONE 不算加密",
  MSHlsMeta.parse('#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:10,\ns1.ts').encrypted === false);

// ---------------------------------------------------------------- [4] 脏输入
section("[4] 脏输入不能崩，也不能谎报");

for (const [name, text] of [
  ["空串", ""],
  ["null", null],
  ["undefined", undefined],
  ["纯 HTML 错误页", "<!DOCTYPE html><html><body>403</body></html>"],
  ["只有 #EXTM3U", "#EXTM3U"],
  ["随机二进制样文本", "\u0000\u0001\u0002abc"],
]) {
  let r;
  try { r = MSHlsMeta.parse(text); } catch (e) { ok(name + " 不能抛异常", false, e.message); continue; }
  ok(name + " → kind=unknown", r.kind === "unknown", r.kind);
  ok(name + " → segs=0", r.segs === 0, r.segs);
  ok(name + " → dur=0", r.dur === 0, r.dur);
}

section("[5] BOM / CRLF / 前后空白");

const BOM = "\ufeff#EXTM3U\r\n#EXTINF:6,\r\nseg1.ts\r\n#EXTINF:6,\r\nseg2.ts\r\n";
const b = MSHlsMeta.parse(BOM);
ok("带 BOM + CRLF 仍判为 media", b.kind === "media", b.kind);
ok("带 BOM + CRLF 段数 = 2", b.segs === 2, b.segs);
ok("带 BOM + CRLF 时长 = 12", b.dur === 12, b.dur);

section("[6] #EXTM3U 必须在首行（否则是别的东西）");

ok("首行不是 #EXTM3U → unknown",
  MSHlsMeta.parse("hello\n#EXTINF:6,\nx.ts").kind === "unknown");
ok("首行前有空行 → 仍然认（宽松）",
  MSHlsMeta.parse("\n\n#EXTM3U\n#EXTINF:6,\nx.ts").kind === "media");

// ---------------------------------------------------------------- [7] 数值极端
section("[7] 数值极端");

const BIG = ["#EXTM3U", ...Array.from({ length: 5000 }, () => "#EXTINF:6.000,\nseg.ts")].join("\n");
const big = MSHlsMeta.parse(BIG);
ok("5000 段不崩且计数正确", big.segs === 5000, big.segs);
ok("5000 段总时长 = 30000", big.dur === 30000, big.dur);

ok("负数时长不进总时长",
  MSHlsMeta.parse("#EXTM3U\n#EXTINF:-5,\ns.ts\n#EXTINF:10,\ns2.ts").dur === 10);
ok("垃圾时长（EXTINF:abc）不进总时长",
  MSHlsMeta.parse("#EXTM3U\n#EXTINF:abc,\ns.ts").dur === 0);
ok("有 EXTINF 但下一行是注释 → 不算段",
  MSHlsMeta.parse("#EXTM3U\n#EXTINF:6,\n#COMMENT\n#EXTINF:6,\ns.ts").segs === 1);

section("[8] 判据函数 looksLikeManifest");

ok("m3u8 路径 → true", MSHlsMeta.looksLikeManifest("https://a.com/x/y.m3u8") === true);
ok("m3u8 带查询串 → true", MSHlsMeta.looksLikeManifest("https://a.com/y.m3u8?auth=1") === true);
ok("mpd → true", MSHlsMeta.looksLikeManifest("https://a.com/y.mpd") === true);
ok("大写 .M3U8 → true", MSHlsMeta.looksLikeManifest("https://a.com/Y.M3U8") === true);
ok("mp4 → false", MSHlsMeta.looksLikeManifest("https://a.com/y.mp4") === false);
ok("空串 → false", MSHlsMeta.looksLikeManifest("") === false);
ok("非字符串 → false", MSHlsMeta.looksLikeManifest(null) === false);

section("[9] 变体地址补全（S1 选清晰度要用它去下载）");

// 传了 base 就把变体地址补成绝对。不补的话 popup 拿到的是 `v/1080.m3u8`，
// 交给宿主根本打不开 —— 而 popup 自己并不知道清单在网络上的位置，
// 只能靠这里补。三种写法都要认：相对、站内绝对、完整地址。
const MASTER2 = [
  "#EXTM3U",
  "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080",
  "v/1080.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1280x720",
  "/hls/720/index.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480",
  "https://cdn.other.com/480.m3u8",
].join("\n");

const m2 = MSHlsMeta.parse(MASTER2, "https://a.com/live/master.m3u8");
ok("三档都解析出来", m2.variants.length === 3, m2.variants);
ok("相对路径 → 按清单地址补全",
  m2.variants[0].url === "https://a.com/live/v/1080.m3u8", m2.variants[0].url);
ok("站内绝对路径 → 只换 origin",
  m2.variants[1].url === "https://a.com/hls/720/index.m3u8", m2.variants[1].url);
ok("完整地址原样保留",
  m2.variants[2].url === "https://cdn.other.com/480.m3u8", m2.variants[2].url);
ok("带宽解析出来", m2.variants[1].bandwidth === 5000000, m2.variants[1]);
ok("分辨率解析出来", m2.variants[0].res === "1920x1080", m2.variants[0].res);

const m3 = MSHlsMeta.parse(MASTER2);
ok("不传 base 时原样返回（纯解析保持向后兼容）",
  m3.variants[0].url === "v/1080.m3u8", m3.variants[0].url);
const m4 = MSHlsMeta.parse(MASTER2, "not a url");
ok("base 是垃圾也不抛异常", m4.variants.length === 3);
ok("resolveUrl 对外可用",
  MSHlsMeta.resolveUrl("https://a.com/x/y.m3u8", "z.m3u8") === "https://a.com/x/z.m3u8");

section("[10] 时长取整口径（给 UI 用的短文案）");

ok("1074s → 17:54", MSHlsMeta.durText(1074) === "17:54", MSHlsMeta.durText(1074));
ok("59s → 0:59", MSHlsMeta.durText(59) === "0:59", MSHlsMeta.durText(59));
ok("3600s → 1:00:00", MSHlsMeta.durText(3600) === "1:00:00", MSHlsMeta.durText(3600));
ok("0 → 空串", MSHlsMeta.durText(0) === "");
ok("undefined → 空串", MSHlsMeta.durText(undefined) === "");

console.log("\n通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
