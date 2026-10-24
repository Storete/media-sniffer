// 同片清单折叠：时长精确相同的多条 m3u8 只留一条（用户 2026-10-24「不能只出现一条可下载吗」）。
//
// 真机数据（51cg1 那个页面，用户截图 + net_dump 取证）：
//   /videos5/<md5>/<md5>.m3u8   9.1 KB  403 段  33:33  ×2 次请求  带页面标题
//   /m3m/<hex>.m3u8             7.6 KB  337 段  33:33  ×1 次请求  无标题
// 两条时长精确相同（2013s），说明覆盖同一段内容 —— 它们是同一个视频的两个片源，
// 不是两个视频。用户看到两行、两个「下载」按钮，才问「不能只出现一条吗」。
//
// 判据只有「时长相同」这一条。为什么不拿体积/段数/路径当判据：
//   · 体积：实测 HQ 比 FHD 小，体积跟质量没有稳定关系（hls-family.js 已记过）；
//   · 段数：403 vs 337 是切片长度不同（5s vs 6s），同样不表达内容差异；
//   · 路径：上一版拿「路径第一段」猜关系，把预载清单和正片标成了「第 1/2 档」，
//     用户点的正是错的那条 —— 弱证据只能标注，不能折叠。
"use strict";

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "extension", "hls-family.js");
const POPUP = path.join(__dirname, "..", "extension", "popup.js");

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
  console.error("缺 extension/hls-family.js");
  process.exit(1);
}
const MS = require(SRC);
const build = MS.build;
const sameMovie = MS.sameMovie;

// ---------------------------------------------------------------- 真机那两条
section("[1] 真机两条同长清单 → 折叠成一条");

const V5 = "https://hls.example.cn/videos5/9f8a/9f8a.m3u8";
const M3M = "https://hls.example.cn/m3m/2f1c9b.m3u8";
const real = [
  { u: V5, s: 9300, k: "video", dur: 2013, segs: 403, hits: 2, title: "酒吧系列 001" },
  { u: M3M, s: 7800, k: "video", dur: 2013, segs: 337, hits: 1 },
];

const fam1 = build(real);
const r1 = sameMovie(real, fam1, null);

ok("两条都在同一个组里",
  r1.groupOf.get(V5) && r1.groupOf.get(V5) === r1.groupOf.get(M3M), [...r1.groupOf.keys()]);
ok("只折叠掉 1 条（列表从 2 行变 1 行）", r1.hidden.size === 1, [...r1.hidden]);
ok("被折叠的不是被选中的", !r1.hidden.has(r1.groupOf.get(V5).chosen));
ok("组里记着共有 2 个片源（alts=1）", r1.groupOf.get(V5).alts === 1, r1.groupOf.get(V5));
ok("组里带着时长，UI 不用再算", r1.groupOf.get(V5).dur === 2013);

// 默认取哪条：两条都有 title/hits 时优先有 title 的（页面自己声明的源）
ok("默认取有 title 的那条（页面声明的视频源）",
  r1.groupOf.get(V5).chosen === V5, r1.groupOf.get(V5).chosen);

// ---------------------------------------------------------------- 排序三级
section("[2] 没有 title 时按 hits → segs 挑默认");

const noTitle = [
  { u: "https://a.cn/m3m/a.m3u8", dur: 600, segs: 120, hits: 1 },
  { u: "https://a.cn/m3m/b.m3u8", dur: 600, segs: 100, hits: 3 },
];
ok("hits 多的优先（播放器反复拉的那条）",
  sameMovie(noTitle, new Map(), null).groupOf.get("https://a.cn/m3m/b.m3u8").chosen === "https://a.cn/m3m/b.m3u8");

const noHits = [
  { u: "https://a.cn/m3m/a.m3u8", dur: 600, segs: 120 },
  { u: "https://a.cn/m3m/b.m3u8", dur: 600, segs: 100 },
];
ok("hits 相同时段数多的优先",
  sameMovie(noHits, new Map(), null).groupOf.get("https://a.cn/m3m/a.m3u8").chosen === "https://a.cn/m3m/a.m3u8");

// ---------------------------------------------------------------- 不折叠
section("[3] 证据不足就不折叠（宁可多一条，不可少一条）");

const diffDur = [
  { u: "https://a.cn/m3m/a.m3u8", dur: 2013 },
  { u: "https://a.cn/m3m/b.m3u8", dur: 1074 },
];
ok("时长差 15 分钟 → 不折叠",
  sameMovie(diffDur, new Map(), null).hidden.size === 0 &&
  sameMovie(diffDur, new Map(), null).groupOf.size === 0);

const tol = [
  { u: "https://a.cn/m3m/a.m3u8", dur: 2013 },
  { u: "https://a.cn/m3m/b.m3u8", dur: 2014 },
];
ok("差 1 秒（#EXTINF 取整误差）→ 折叠",
  sameMovie(tol, new Map(), null).hidden.size === 1);

const nearMiss = [
  { u: "https://a.cn/m3m/a.m3u8", dur: 2013 },
  { u: "https://a.cn/m3m/b.m3u8", dur: 2016 },
];
ok("差 3 秒 → 不折叠（容差只吸收取整，不做近似匹配）",
  sameMovie(nearMiss, new Map(), null).hidden.size === 0);

const short = [
  { u: "https://a.cn/m3m/a.m3u8", dur: 30 },
  { u: "https://a.cn/m3m/b.m3u8", dur: 30 },
];
ok("30 秒短片时长相撞太正常 → 不折叠",
  sameMovie(short, new Map(), null).hidden.size === 0);

const noDur = [
  { u: "https://a.cn/m3m/a.m3u8", dur: 0 },
  { u: "https://a.cn/m3m/b.m3u8", dur: 0 },
];
ok("时长未知（0）→ 不折叠",
  sameMovie(noDur, new Map(), null).hidden.size === 0);

const mixed = [
  { u: "https://a.cn/m3m/a.m3u8", dur: 2013 },
  { u: "https://a.cn/videos5/1.mp4", dur: 2013, k: "video" },
];
ok("不是 m3u8 的条目不参与（mp4 跟 m3u8 时长相同不是重复）",
  sameMovie(mixed, new Map(), null).hidden.size === 0);

// 有主清单的族：变体之间是不同清晰度，不能折叠
const masterFam = [
  { u: "https://a.cn/x.m3u8", s: 752 },
  { u: "https://a.cn/url_8/x_fhd.m3u8", s: 3670, dur: 2013 },
  { u: "https://a.cn/url_6/x_hq.m3u8", s: 3606, dur: 2013 },
];
ok("有主清单的族不折叠（那是清晰度选项，不是重复）",
  sameMovie(masterFam, build(masterFam), null).hidden.size === 0);

// ---------------------------------------------------------------- 切换
section("[4] 切换：override 生效，且可逆");

const ov = new Map();
const key1 = r1.groupOf.get(V5).key;
ov.set(key1, M3M);
const r2 = sameMovie(real, fam1, ov);
ok("override 之后选中换成了另一条", r2.groupOf.get(V5).chosen === M3M, r2.groupOf.get(V5).chosen);
ok("折叠的也换成了原来那条",
  r2.hidden.has(V5) && !r2.hidden.has(M3M), [...r2.hidden]);
ok("组键与选中无关（切换后 key 不变）", r2.groupOf.get(V5).key === key1);

const ovBad = new Map([[key1, "https://a.cn/nothere.m3u8"]]);
ok("override 里是无效 URL → 退回默认，不崩",
  sameMovie(real, fam1, ovBad).groupOf.get(V5).chosen === V5);

// 输入顺序打乱，组键不变（用户切换后重渲染仍稳定）
const shuffled = [real[1], real[0]];
ok("组键与输入顺序无关",
  sameMovie(shuffled, build(shuffled), null).groupOf.get(V5).key === key1,
  sameMovie(shuffled, build(shuffled), null).groupOf.get(V5).key);

// ---------------------------------------------------------------- 多条
section("[5] 三条以上");

const three = [
  { u: "https://a.cn/m3m/a.m3u8", dur: 1800, segs: 300 },
  { u: "https://a.cn/m3m/b.m3u8", dur: 1800, segs: 360 },
  { u: "https://a.cn/m3m/c.m3u8", dur: 1800, segs: 200 },
];
const r3 = sameMovie(three, new Map(), null);
ok("三条同长 → 折叠 2 条、alts=2",
  r3.hidden.size === 2 && r3.groupOf.get("https://a.cn/m3m/a.m3u8").alts === 2, [...r3.hidden]);
ok("三个 URL 都在 urls 里（切换能转圈）",
  r3.groupOf.get("https://a.cn/m3m/a.m3u8").urls.length === 3);

// 两个簇（1800 与 3600 各两条）
const twoClusters = [
  { u: "https://a.cn/m3m/a1.m3u8", dur: 1800, segs: 300 },
  { u: "https://a.cn/m3m/a2.m3u8", dur: 1800, segs: 301 },
  { u: "https://a.cn/m3m/b1.m3u8", dur: 3600, segs: 600 },
  { u: "https://a.cn/m3m/b2.m3u8", dur: 3600, segs: 601 },
];
const r4 = sameMovie(twoClusters, new Map(), null);
ok("两个时长各成一组、各折叠 1 条",
  r4.hidden.size === 2 && new Set([...r4.groupOf.values()]).size === 2);
ok("不同簇互不干扰（1800 的 chosen 不是 3600 那条）",
  r4.groupOf.get("https://a.cn/m3m/a1.m3u8").chosen.startsWith("https://a.cn/m3m/a"));

// ---------------------------------------------------------------- 幂等/健壮
section("[6] 健壮性");

ok("空输入不抛异常", (() => {
  try { sameMovie([], new Map(), null); sameMovie(null, null, null); return true; }
  catch (e) { return false; }
})());
ok("重复调用结果一致（幂等）",
  JSON.stringify(sameMovie(real, fam1, null).groupOf.get(V5)) ===
  JSON.stringify(sameMovie(real, fam1, null).groupOf.get(V5)));
ok("dur 是字符串也认（storage 回来可能是 string）",
  sameMovie([{ u: "https://a.cn/m3m/a.m3u8", dur: "2013" }, { u: "https://a.cn/m3m/b.m3u8", dur: "2013" }],
    new Map(), null).hidden.size === 1);

// ---------------------------------------------------------------- 接线
section("[7] popup 接线（防止「模块写了但没接上」）");

const popupSrc = fs.readFileSync(POPUP, "utf8");
ok("renderList 里调用了 movieDedupe", /const movie = movieDedupe\(\);/.test(popupSrc));
ok("列表渲染前过滤掉折叠项",
  /visibleItems\(\)\.filter\(\(it\) => !movie\.hidden\.has\(it\.u\)\)/.test(popupSrc));
ok("chip 计数也过滤折叠项（否则「视频 2、点进去 1 条」）",
  /const hidden = movieDedupe\(\)\.hidden;/.test(popupSrc));
ok("有「切换」入口", /function appendSwap\(/.test(popupSrc) && /className = "swap"/.test(popupSrc));
ok("切换会重新渲染", /moviePick\.set\(grp\.key/.test(popupSrc) && /renderList\(\);\n?\s*\}\)/.test(popupSrc) || /moviePick\.set\(grp\.key[^]*?renderList\(\);/.test(popupSrc));

console.log("\n" + (fail ? "有失败：" : "全部通过：") + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
