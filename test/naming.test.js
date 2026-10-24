/**
 * 落盘文件名规则单测（先红后绿）。
 *
 * 现场（2026-10-24）：用户下到 `449820be57199908ccb430879b3ada75.mp4`，
 * 反馈「应该是标题（如果有的话），而不是这种名称」。
 * 根因是 popup 下载链写成 `it.f || title`，而 it.f 是 URL 末段的哈希。
 */
"use strict";
const path = require("path");
const N = require(path.join(__dirname, "..", "extension", "naming.js"));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log("  ✗ " + name);
  if (detail !== undefined) console.log("      " + JSON.stringify(detail).slice(0, 200));
}
function section(t) { console.log("\n" + t); }

// ---------------------------------------------------------------- [1] 标题优先
section("[1] 有标题就必须用标题（用户的核心诉求）");

ok("标题赢过 URL 哈希",
  N.downloadName({
    title: "第 12 集 大结局",
    f: "449820be57199908ccb430879b3ada75.m3u8",
    i: "https://51cg1.com/archives/274378/",
  }) === "第 12 集 大结局");

ok("标题赢过普通文件名也没有副作用",
  N.downloadName({ title: "我的视频", f: "movie.mp4", i: "https://a.com/" }) === "我的视频");

ok("没有标题 → 用 URL 推的名字",
  N.downloadName({ f: "movie.mp4", i: "https://a.com/" }) === "movie.mp4");

ok("标题是空白 → 用 URL 推的名字",
  N.downloadName({ title: "   ", f: "movie.mp4", i: "https://a.com/" }) === "movie.mp4");

ok("全都没有 → 空串（宿主侧兜底）",
  N.downloadName({}) === "");

ok("null 不崩", N.downloadName(null) === "");

// ---------------------------------------------------------------- [2] 站点名保护
section("[2] 标题只是站点名时退回 URL 名（否则一页四条会互相覆盖）");

ok("短标题含域名主体 → 退回 f",
  N.downloadName({ title: "51cg1", f: "clip.mp4", i: "https://51cg1.com/x/" }) === "clip.mp4");

ok("短标题含域名主体（大小写混） → 退回 f",
  N.downloadName({ title: "BiliBili", f: "clip.mp4", i: "https://bilibili.com/x/" }) === "clip.mp4");

ok("长标题即使含域名也照用（内容名更可能长）",
  N.downloadName({ title: "51cg1 独家首发 完整版 4K 修复版", f: "h.mp4", i: "https://51cg1.com/x/" })
    === "51cg1 独家首发 完整版 4K 修复版");

ok("www. 前缀不影响判定",
  N.downloadName({ title: "example", f: "clip.mp4", i: "https://www.example.com/x/" }) === "clip.mp4");

ok("没有 f 时，站点名标题仍要保留（总比空名强）",
  N.downloadName({ title: "51cg1", i: "https://51cg1.com/x/" }) === "51cg1");

// ---------------------------------------------------------------- [3] 截断
section("[3] 截断：保扩展名、不留脏尾");

const long = "很长的标题".repeat(30);
const cut = N.shortTitle(long);
ok("超长标题截到 60 字 + 省略号", cut.length <= 61, cut.length);

ok("扩展名在截断后保住",
  /\.mp4$/.test(N.shortTitle("a".repeat(80) + ".mp4")) === true,
  N.shortTitle("a".repeat(80) + ".mp4").slice(-8));

ok("截断后不留「空格/下划线/顿号」脏尾",
  !/[\s_\-·,，、]…$/.test(N.shortTitle("ab ".repeat(40))),
  JSON.stringify(N.shortTitle("ab ".repeat(40)).slice(-6)));

ok("短标题原样返回", N.shortTitle("第 3 集") === "第 3 集");

ok("空白压成一个空格", N.shortTitle("第   3\n集") === "第 3 集");

ok("空 → 空串", N.shortTitle("") === "");
ok("null → 空串", N.shortTitle(null) === "");

// ---------------------------------------------------------------- [4] 幂等
section("[4] 幂等：同一个名字处理两次结果不变");

for (const t of ["第 3 集", "很长的标题".repeat(30), "a".repeat(80) + ".mp4"]) {
  const once = N.shortTitle(t);
  const twice = N.shortTitle(once);
  ok("shortTitle 幂等：" + t.slice(0, 12), once === twice, { once, twice });
}

for (const it of [
  { title: "第 3 集", f: "x.mp4", i: "https://a.com/" },
  { title: "51cg1", f: "x.mp4", i: "https://51cg1.com/" },
  { f: "x.mp4" },
]) {
  ok("downloadName 幂等：" + JSON.stringify(it).slice(0, 30),
    N.downloadName(it) === N.downloadName({ ...it, title: N.downloadName(it) }) ||
    // 站点名退回 f 的情况下，第二轮 title 变成 f，结果仍是 f
    N.downloadName(it) === N.downloadName({ ...it, title: N.downloadName(it), f: N.downloadName(it) }));
}

console.log("\n通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
