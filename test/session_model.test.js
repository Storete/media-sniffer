// 会话数据契约（extension/session.js）的单元测试。
//
// 这一层是产品化方案的 L0：把「一个标签页一袋扁平条目」换成「一次播放会话」。
// 它必须是**纯函数**——不读 chrome、不读时钟、不读网络，只吃条目吐会话。
// 只有这样 S1（清晰度）、S2（验证）、S3（规划表）才有地方挂。
//
// 断言的是**契约**，不是当前实现：
//   · sid 幂等（同一页面反复扫描必须得到同一个 sid，否则去重全乱）
//   · 分片/图标永远不进 tracks（否则一个视频变成几百条轨道）
//   · confidence 是离散等级，**绝不能是小数**（没有标注集的小数置信度是装饰）
//   · 畸形输入不崩（页面世界里什么脏数据都有）
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FILE = path.join(__dirname, "..", "extension", "session.js");
const sandbox = { URL, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(FILE, "utf8"), sandbox, { filename: "session.js" });

const S = sandbox.MSSession;
let pass = 0, fail = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name + "  -> got " + g + ", want " + w); }
}
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name + (extra === undefined ? "" : "  -> " + JSON.stringify(extra))); }
}

// ---------------------------------------------------------------- 固定夹具
// 字段名照抄 background.js 里两个真实构造点：record()（webRequest 条目）与
// recordPageMedia()（页面条目）。测试里故意混用两边的字段，模拟真实数据。
const CASES = {
  mp4_1080: { u: "https://cdn.x.com/v/1080.mp4", k: "video", m: "video/mp4", s: 5242880, w: 1920, h: 1080, dur: 125 },
  mp4_720: { u: "https://cdn.x.com/v/720.mp4", k: "video", m: "video/mp4", s: 2097152, w: 1280, h: 720 },
  hls: { u: "https://cdn.x.com/hls/master.m3u8", k: "video", m: "application/vnd.apple.mpegurl", s: 0 },
  mpd: { u: "https://cdn.x.com/dash/manifest.mpd", k: "video", m: "application/dash+xml", s: 0 },
  mse: { u: "m1", k: "video", m: "video/mp4", s: 31457280 },
  blob_audio: { u: "blob:https://music.163.com/aaa-bbb", k: "audio", m: "audio/mpeg", s: 0, dur: 210 },
  seg: { u: "https://cdn.x.com/seg/1.m4s", k: "seg", m: "video/mp4", s: 1024 },
  icon: { u: "https://cdn.x.com/i/icon.png", k: "icon", m: "image/png", s: 900, w: 32, h: 32 },
  img: { u: "https://cdn.x.com/p/1.jpg", k: "image", m: "image/jpeg", s: 204800, w: 800, h: 600, hint: "xhs-note" },
  cover: { u: "https://cdn.x.com/cover.jpg", k: "image", m: "image/jpeg", s: 40960, hint: "bili-cover" },
};
const build = (items, tabUrl) => S.msBuildSession({ items, tabUrl: tabUrl || "https://www.x.com/watch/123" });

// ---------------------------------------------------------------- [1] 畸形输入
console.log("[1] 畸形输入不崩（页面世界什么脏数据都有）");
ok("无参数", (() => { const s = S.msBuildSession(); return !!s && Array.isArray(s.tracks); })());
ok("items 为空", (() => { const s = build([]); return Array.isArray(s.tracks) && s.tracks.length === 0; })());
ok("items 是 null", (() => { const s = build(null); return Array.isArray(s.tracks); })());
ok("items 是字符串", (() => { const s = build("nope"); return Array.isArray(s.tracks); })());
ok("条目里有 null", (() => { const s = build([null, CASES.mp4_1080, undefined]); return s.tracks.length === 1 && s.tracks[0].variants.length === 1; })());
ok("条目缺 u", (() => { const s = build([{ k: "video" }]); return s.tracks.length === 0; })());
ok("条目 u 不是字符串", (() => { const s = build([{ u: 123, k: "video" }]); return s.tracks.length === 0; })());
ok("条目 k 不认识", (() => { const s = build([{ u: "https://a.com/x", k: "weird" }]); return s.tracks.length === 0; })());
ok("传入 Map 也能吃", (() => {
  const m = new Map();
  m.set(CASES.mp4_1080.u, CASES.mp4_1080);
  return S.msBuildSession({ items: m, tabUrl: "https://www.x.com/watch/1" }).tracks.length === 1;
})());
ok("tabUrl 非法不崩", (() => { const s = build([CASES.mp4_1080], "not a url"); return typeof s.sid === "string"; })());

// ---------------------------------------------------------------- [2] sid 幂等
console.log("[2] sid 幂等（去重全靠它）");
const sid = (u) => build([CASES.mp4_1080], u).sid;
ok("同页两次相同", sid("https://www.x.com/watch/123") === sid("https://www.x.com/watch/123"));
ok("查询串不影响", sid("https://www.x.com/watch/123?t=9") === sid("https://www.x.com/watch/123"));
ok("hash 不影响", sid("https://www.x.com/watch/123#part2") === sid("https://www.x.com/watch/123"));
ok("末尾斜杠不影响", sid("https://www.x.com/watch/123/") === sid("https://www.x.com/watch/123"));
ok("主机大小写不影响", sid("https://WWW.X.com/watch/123") === sid("https://www.x.com/watch/123"));
ok("不同页面必须不同", sid("https://www.x.com/watch/123") !== sid("https://www.x.com/watch/124"));
ok("不同站点必须不同", sid("https://www.x.com/watch/123") !== sid("https://y.com/watch/123"));
ok("条目变化不改变 sid（同一页面同一会话）",
  build([CASES.mp4_1080], "https://www.x.com/watch/123").sid ===
  build([CASES.mp4_1080, CASES.mp4_720], "https://www.x.com/watch/123").sid);
ok("sid 非空字符串", typeof sid("https://www.x.com/watch/123") === "string" && sid("https://www.x.com/watch/123").length > 0);

// ---------------------------------------------------------------- [3] kind
console.log("[3] 会话类型");
check("只有视频", build([CASES.mp4_1080]).kind, "video");
check("只有音频", build([CASES.blob_audio]).kind, "audio");
check("只有图片", build([CASES.img]).kind, "image-set");
check("只有分片 → unknown", build([CASES.seg]).kind, "unknown");
check("只有图标 → unknown", build([CASES.icon]).kind, "unknown");
check("图片 + 视频 → video", build([CASES.img, CASES.mp4_1080]).kind, "video");
check("空 → unknown", build([]).kind, "unknown");

// ---------------------------------------------------------------- [4] tracks / variants
console.log("[4] 轨道与变体");
const t2 = build([CASES.mp4_720, CASES.mp4_1080]);
check("视频轨只有一条", t2.tracks.length, 1);
check("role", t2.tracks[0].role, "video");
check("两个变体", t2.tracks[0].variants.length, 2);
check("按高度降序（1080 在前）", t2.tracks[0].variants.map(v => v.height), [1080, 720]);
check("高质量先出现（用户默认要最好的）", t2.tracks[0].variants[0].quality, "1080p");
ok("无高度的排在有高度的后面", (() => {
  const s = build([CASES.hls, CASES.mp4_720]); // hls 没 h
  return s.tracks[0].variants[1].url.indexOf(".m3u8") > 0;
})());
check("同 URL 去重", build([CASES.mp4_1080, CASES.mp4_1080]).tracks[0].variants.length, 1);
check("MSE 条目的 source", build([CASES.mse]).tracks[0].variants[0].source, "mse");
check("MSE 条目地址原样保留", build([CASES.mse]).tracks[0].variants[0].url, "m1");
check("blob 的 source", build([CASES.blob_audio]).tracks[0].variants[0].source, "blob");
check("http 的 source", build([CASES.mp4_1080]).tracks[0].variants[0].source, "http");
ok("分片不进任何轨道", build([CASES.seg, CASES.mp4_1080]).tracks[0].variants.length === 1);
ok("图标不进任何轨道", (() => {
  const s = build([CASES.icon]);
  return s.tracks.every(t => t.variants.every(v => v.url.indexOf("icon") < 0));
})());
check("音视频分离成两条轨", (() => {
  const s = build([CASES.mp4_1080, CASES.blob_audio]);
  return s.tracks.map(t => t.role).sort().join(",");
})(), "audio,video");
ok("变体带字节数", build([CASES.mp4_1080]).tracks[0].variants[0].size === 5242880);

// ---------------------------------------------------------------- [5] manifest
console.log("[5] 清单推断");
check("m3u8 → hls", build([CASES.hls]).manifest.type, "hls");
check("mpd → dash", build([CASES.mpd]).manifest.type, "dash");
check("只有 mp4 → file", build([CASES.mp4_1080]).manifest.type, "file");
check("清单优先于直链（有 m3u8 就是 hls）", build([CASES.mp4_1080, CASES.hls]).manifest.type, "hls");
check("MSE 也算清单态（无 URL 可下）", build([CASES.mse]).manifest.type, "file");
check("没有媒体 → file", build([]).manifest.type, "file");
check("时长取最大值", build([CASES.mp4_1080, CASES.blob_audio]).manifest.duration, 210);
check("无时长记 0", build([CASES.hls]).manifest.duration, 0);

// ---------------------------------------------------------------- [6] confidence 离散
console.log("[6] confidence 必须是离散等级，不是小数");
check("http + 有字节数 → strong", build([CASES.mp4_1080]).confidence, "strong");
check("http 无字节数 → weak", build([CASES.hls]).confidence, "weak");
check("只有 blob → weak", build([CASES.blob_audio]).confidence, "weak");
check("MSE 有字节数 → strong", build([CASES.mse]).confidence, "strong");
check("同角色既有 MSE 又有直链 → conflict", build([CASES.mse, CASES.mp4_1080]).confidence, "conflict");
ok("绝不出现小数", (() => {
  const all = [
    build([]), build([CASES.mp4_1080]), build([CASES.hls]), build([CASES.blob_audio]),
    build([CASES.mse]), build([CASES.mse, CASES.mp4_1080]), build([CASES.img]),
  ];
  return all.every(s => typeof s.confidence === "string" && s.confidence.indexOf(".") < 0
    && ["strong", "weak", "conflict"].indexOf(s.confidence) >= 0);
})());

// ---------------------------------------------------------------- [7] evidence
console.log("[7] 证据链");
ok("非空", build([CASES.mp4_1080]).evidence.length > 0);
ok("每项有 src 且取值合法", (() => {
  const okSrc = ["dom", "net", "mse", "manifest"];
  return build([CASES.mp4_1080, CASES.mse, CASES.img]).evidence
    .every(e => okSrc.indexOf(e.src) >= 0 && typeof e.field === "string" && e.field.length > 0);
})());
ok("空会话也有证据（至少一条说明「什么都没有」）", build([]).evidence.length > 0);
ok("每条变体都能追到一条证据", (() => {
  const s = build([CASES.mp4_1080, CASES.mp4_720]);
  return s.tracks[0].variants.every(v => s.evidence.some(e => e.value && String(e.value).indexOf(v.url) >= 0));
})());

// ---------------------------------------------------------------- [8] 结构不变量
console.log("[8] 结构不变量");
const st = build([CASES.mp4_1080, CASES.mse, CASES.img, CASES.cover, CASES.seg], "https://www.x.com/watch/9");
ok("可 JSON 序列化且往返不失真", (() => {
  try {
    const back = JSON.parse(JSON.stringify(st));
    return back.sid === st.sid && back.tracks.length === st.tracks.length;
  } catch (e) { return false; }
})());
ok("不含函数值", Object.keys(st).every(k => typeof st[k] !== "function"));
ok("变体地址全为非空字符串", st.tracks.every(t => t.variants.every(v => typeof v.url === "string" && v.url.length > 0)));
ok("state 合法", ["discovered", "planned", "running", "verifying", "done", "failed"].indexOf(st.state) >= 0);
ok("error 初始为 null", st.error === null);
ok("subs 是数组", Array.isArray(st.subs));
ok("sid 在会话对象上", typeof st.sid === "string" && st.sid.length > 0);
ok("site 取主机名（去 www）", st.site === "x.com");
check("封面单独挑出来，不算图片集", st.cover, CASES.cover.u);
ok("封面不进 tracks", st.tracks.every(t => t.variants.every(v => v.url !== CASES.cover.u)));

console.log("\n" + (fail === 0 ? "全部通过" : "有失败") + "：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail === 0 ? 0 : 1);
