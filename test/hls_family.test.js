// HLS 清单族：把同一页的多条 .m3u8 归成「主清单 + N 档变体」。
//
// 为什么需要（2026-10-24 用户截图 51cg1）：
//   列表里并列三条「HLS 流（视频）」，体积 5.1 / 4.0 / 4.2 KB，文案完全一样。
//   用户的原话是「这三条有什么区别」。真相是它们不是三个视频，是**同一个视频的
//   主清单和清晰度变体** —— 点错一条就下到另一档，而且用户没有任何线索。
//
// 真机证据（本地 hls.js + mux 3 档测试流，修复体积门槛后抓到的原始数据）：
//   master  752 B  https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
//   HD     3606 B  https://test-streams.mux.dev/x36xhzz/url_0/…_hd_7.m3u8
//   FHD    3670 B  https://test-streams.mux.dev/x36xhzz/url_8/…_fhd_7.m3u8
//   HQ     3606 B  https://test-streams.mux.dev/x36xhzz/url_6/…_hq_7.m3u8
//
// 判据（不读响应体就能成立的那部分）：
//   1. 主清单的**目录**是其它条目的目录祖先（/x36xhzz/ 是 /x36xhzz/url_6/ 的祖先）；
//   2. 主清单体积明显更小（master 只列变体，media playlist 要列全部分片）；
//   3. 没有唯一祖先时（各档放在平级目录，如 /hls/1080/index.m3u8），
//      按体积降序当作「第 N 档」——大体量通常对应高清晰度，只作为排序线索，不声称等价。
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "extension", "hls-family.js");

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else {
    fail++;
    console.log("  ✗ " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 240) : ""));
  }
}
function section(t) { console.log("\n" + t); }

if (!fs.existsSync(SRC)) {
  console.error("缺 extension/hls-family.js，先用空壳跑红也可以，但这个文件本身必须存在");
  process.exit(1);
}
const MSHlsFamily = require(SRC);
const build = MSHlsFamily.build || MSHlsFamily;

const M = "https://test-streams.mux.dev/x36xhzz";

// ---------------------------------------------------------------- [1] 真实结构
section("[1] master + 3 变体（mux 真机实测结构）");

const real = [
  { u: M + "/x36xhzz.m3u8", s: 752, k: "video", hint: "hls" },
  { u: M + "/url_0/193039199_mp4_h264_aac_hd_7.m3u8", s: 3606, k: "video" },
  { u: M + "/url_8/193039199_mp4_h264_aac_fhd_7.m3u8", s: 3670, k: "video" },
  { u: M + "/url_6/193039199_mp4_h264_aac_hq_7.m3u8", s: 3606, k: "video" },
];
const m1 = build(real);
ok("认出了主清单", m1.get(M + "/x36xhzz.m3u8")?.role === "master", m1.get(M + "/x36xhzz.m3u8"));
ok("主清单标出变体数 3", m1.get(M + "/x36xhzz.m3u8")?.total === 3, m1.get(M + "/x36xhzz.m3u8"));
ok("三个变体都标成 variant", ["url_0", "url_8", "url_6"].every((d) =>
  m1.get(M + "/" + d + "/" + real.find((x) => x.u.includes(d)).u.split("/").pop())?.role === "variant"));
ok("变体的 total 也是 3（UI 要显示 2/3）",
  real.slice(1).every((it) => m1.get(it.u)?.total === 3));
ok("变体序号从 1 连续到 3，不重复",
  new Set(real.slice(1).map((it) => m1.get(it.u)?.index)).size === 3 &&
  real.slice(1).every((it) => m1.get(it.u)?.index >= 1 && m1.get(it.u)?.index <= 3));

// ---------------------------------------------------------------- [2] 平级目录
section("[2] 没有主清单、各档平级（/hls/1080/、/hls/720/）");

const flat = [
  { u: "https://cdn.a.com/hls/1080/index.m3u8", s: 9200 },
  { u: "https://cdn.a.com/hls/720/index.m3u8", s: 6100 },
  { u: "https://cdn.a.com/hls/480/index.m3u8", s: 3300 },
];
const m2 = build(flat);
ok("平级时没有 master（不瞎猜）", [...m2.values()].every((v) => v.role !== "master"), [...m2.values()]);
ok("按体积降序排成 1/2/3",
  m2.get("https://cdn.a.com/hls/1080/index.m3u8")?.index === 1 &&
  m2.get("https://cdn.a.com/hls/720/index.m3u8")?.index === 2 &&
  m2.get("https://cdn.a.com/hls/480/index.m3u8")?.index === 3,
  [...m2.entries()]);

// ---------------------------------------------------------------- [3] 不该标注的情况
section("[3] 单条 / 混合类型 / 空输入：一律不标注");

ok("单条 → 空表（标「主清单」反而误导）", build([{ u: "https://a.com/only.m3u8", s: 500 }]).size === 0);
ok("空数组 → 空表", build([]).size === 0);
ok("null → 空表，不崩", (() => { try { return build(null).size === 0; } catch { return false; } })());
ok("非 m3u8 条目被忽略",
  build([{ u: "https://a.com/a.mp4", s: 99999 }, { u: "https://a.com/b.m3u8", s: 500 }]).size === 0);
ok("分片不进族",
  build([{ u: "https://a.com/s/1.ts", s: 900000 }, { u: "https://a.com/s/2.ts", s: 900000 }]).size === 0);

// ---------------------------------------------------------------- [4] 前缀边界
section("[4] 目录祖先判定必须按 / 边界，不能按字符串前缀");

// /hls/ 和 /hls-a/ 去掉尾斜杠后 "…/hls" 确实是 "…/hls-a/" 的字符串前缀 ——
// 用裸 startsWith 就会把 /hls/index.m3u8 误判成主清单，连带把另外两条说成它的变体。
const tricky = [
  { u: "https://a.com/hls/index.m3u8", s: 600 },
  { u: "https://a.com/hls-a/x.m3u8", s: 5000 },
  { u: "https://a.com/hls-b/y.m3u8", s: 5000 },
];
const m4 = build(tricky);
ok("/hls/ 不能吞下 /hls-a/（三条都是平级）",
  [...m4.values()].every((v) => v.role !== "master"), [...m4.entries()]);

// ---------------------------------------------------------------- [5] 无序输入
section("[5] 输入顺序不影响判定（列表顺序会随抓取时机变）");

const m5a = build(real);
const m5b = build(real.slice().reverse());
ok("反转输入后主清单判定不变",
  m5a.get(M + "/x36xhzz.m3u8")?.role === m5b.get(M + "/x36xhzz.m3u8")?.role);
ok("反转输入后变体序号不变",
  real.slice(1).every((it) => m5a.get(it.u)?.index === m5b.get(it.u)?.index));

// ---------------------------------------------------------------- [6] 不同树绝不归族
section("[6] 不同目录树不归族（51cg1 真机结构）");

// 真机数据（2026-10-24，tools/net_dump.mjs + tools/live_check.mjs）：
//   /videos5/<md5>/<md5>.m3u8   5153 B  ← 页面预载的小清单，用户点了这条
//   /m3m/<长hex>.m3u8          29155 B  ← 179 段 × 6s = 1074s，播放器真正在用的正片
// 上一版把它们标成「同一视频的第 1/2 档」，是编造关系。
const cg = [
  { u: "https://hls.example.cn/videos5/449820be/449820be.m3u8", s: 5153 },
  { u: "https://hls.example.cn/m3m/31ab4879.m3u8", s: 29155 },
];
const m6 = build(cg);
ok("不同目录树 → 不归族（Map 为空）", m6.size === 0, [...m6.keys()]);
ok("绝不出现「第 N 档」序号", [...m6.values()].every((v) => !v.index), [...m6.values()]);

// 同一棵树里两条 → 归族，但必须标明没有主清单
const sameTree = [
  { u: "https://hls.example.cn/videos5/abc/a.m3u8", s: 5153 },
  { u: "https://hls.example.cn/videos5/abc/b.m3u8", s: 4200 },
  { u: "https://hls.example.cn/m3m/zzz.m3u8", s: 29155 },
];
const m6b = build(sameTree);
ok("同树两条归族、另一棵树不参与", m6b.size === 2, [...m6b.keys()]);
ok("同树两条的 total=2（不含另一棵树的条目）",
  m6b.get("https://hls.example.cn/videos5/abc/a.m3u8")?.total === 2,
  m6b.get("https://hls.example.cn/videos5/abc/a.m3u8"));
ok("没有主清单时 hasMaster=false（UI 不能再喊「请点主清单」）",
  m6b.get("https://hls.example.cn/videos5/abc/a.m3u8")?.hasMaster === false);
ok("不同树的条目不在结果里",
  !m6b.has("https://hls.example.cn/m3m/zzz.m3u8"));

// 有主清单时 hasMaster=true
const withMaster = build(real);
ok("有主清单时 hasMaster=true",
  withMaster.get(M + "/url_0/193039199_mp4_h264_aac_hd_7.m3u8")?.hasMaster === true,
  [...withMaster.values()].slice(0, 2));

console.log("\n" + (fail ? "有失败：" : "全部通过：") + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
