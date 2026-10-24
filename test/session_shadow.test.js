// S0 双跑：`msBuildSession` 出来的会话 vs 旧扁平条目袋，「只允许新增」。
//
// 为什么单独一个文件
// ------------------
// `session_model.test.js` 验的是**会话自己长什么样**（sid 幂等、分片不进 tracks、
// confidence 是离散等级）。这个文件验的是另一件事：**新模型有没有把旧模型的东西弄丢**。
// 两件事的失败方式完全不同 —— 前者是「模型设计错了」，后者是「切过去会掉东西」。
//
// 口径（这决定了它有没有用）
// --------------------------
// 严格 ok = missing / extra / changed 三者皆空。允许的差异只有 `added`
// （id / source / quality 这些旧模型没有的概念）。
//
// 两条刻意不报错（否则真机上会是满屏假红，然后就没人看了）：
//   · 同地址多条目 → 新模型按地址合并（buildTrack 取 max），计入 merged；
//   · 分片 / 图标 / 封面 / 文档 / 字体 → 两边都不该出现（约束 2），计入 dropped。
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
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name + (extra === undefined ? "" : "  -> " + JSON.stringify(extra).slice(0, 300))); }
}
function section(t) { console.log("\n" + t); }

// ---------------------------------------------------------------- 夹具
// 字段名照抄 background.js 的两个真实构造点：record()（webRequest 条目，
// 有 u/k/m/s/hits/t/i，可能带 hdr）与 recordPageMedia()（页面条目，多 page/mid/ord/hint）。
// 三个页面类型对应 PRODUCT-PLAN 里要真机复验的三页。
const PAGES = {
  // ① 小红书图集：一张封面 + 四张图。封面必须单独拎出去，不能算进图集。
  xhs: {
    url: "https://www.xiaohongshu.com/explore/abc123",
    items: [
      { u: "https://sns-img.xhscdn.com/cover.jpg", k: "image", m: "image/jpeg", s: 88000, w: 720, h: 960, hint: "xhs-cover" },
      { u: "https://sns-img.xhscdn.com/a.jpg", k: "image", m: "image/jpeg", s: 220000, w: 1080, h: 1440, ord: 0, page: 1 },
      { u: "https://sns-img.xhscdn.com/b.jpg", k: "image", m: "image/jpeg", s: 210000, w: 1080, h: 1440, ord: 1, page: 1 },
      { u: "https://sns-img.xhscdn.com/c.jpg", k: "image", m: "image/jpeg", s: 205000, w: 1080, h: 1440, ord: 2, page: 1 },
      { u: "https://sns-img.xhscdn.com/d.jpg", k: "image", m: "image/jpeg", s: 199000, w: 1080, h: 1440, ord: 3, page: 1 },
      { u: "https://sns-webpic.xhscdn.com/avatar.png", k: "icon", m: "image/png", s: 3000, w: 48, h: 48 },
    ],
  },
  // ② Telegram：一条 blob（MSE 录制的伪地址 m1）+ 一条 http 直链 + 一个 UI 贴纸小视频。
  tg: {
    url: "https://web.telegram.org/k/#@channel/123",
    items: [
      { u: "m1", k: "video", m: "video/mp4", s: 4200000, page: 1, mid: 11, ord: 0 },
      { u: "https://cdn.telesco.pe/file/abc.mp4", k: "video", m: "video/mp4", s: 4200000, w: 854, h: 480, page: 1, mid: 11, ord: 0 },
      { u: "https://cdn.telesco.pe/sticker/1.webm", k: "video", m: "video/webm", s: 9000, w: 100, h: 100 },
      { u: "https://cdn.telesco.pe/file/abc.mp3", k: "audio", m: "audio/mpeg", s: 300000 },
    ],
  },
  // ③ HLS 多档：主清单 + 分片（分片一条都不许进 tracks）+ 一档音轨。
  hls: {
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    items: [
      { u: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", k: "video", m: "application/vnd.apple.mpegurl", s: 752 },
      { u: "https://test-streams.mux.dev/x36xhzz/url_862/193039199_mp4_h264_aac_hd_7.m3u8", k: "video", m: "text/plain", s: 231, h: 1080, dur: 634 },
      { u: "https://test-streams.mux.dev/x36xhzz/url_560/193039199_mp4_h264_aac_ld_7.m3u8", k: "video", m: "text/plain", s: 231, h: 480 },
      { u: "https://test-streams.mux.dev/x36xhzz/url_862/seg-1-v1-a1.ts", k: "seg", m: "video/mp2t", s: 900000, h: 1080 },
      { u: "https://test-streams.mux.dev/x36xhzz/url_862/seg-2-v1-a1.ts", k: "seg", m: "video/mp2t", s: 890000, h: 1080 },
    ],
  },
};

function bag(p) { return p.items.slice(); }

// ---------------------------------------------------------------- [1] 三页都「只多不少」
section("[1] 三页夹具：新模型一条都不许丢（ok 必须为 true）");

for (const name of Object.keys(PAGES)) {
  const p = PAGES[name];
  const st = S.msBuildSession({ items: bag(p), tabUrl: p.url });
  const d = S.msDiffSession(st, bag(p));
  ok(name + "：ok=true", d.ok === true, {
    missing: d.missing, extra: d.extra, changed: d.changed, counts: d.counts,
  });
  ok(name + "：missing 为空", d.missing.length === 0, d.missing);
  ok(name + "：extra 为空", d.extra.length === 0, d.extra);
  ok(name + "：changed 为空", d.changed.length === 0, d.changed);
  // 纯图集页面没有轨道，就没有「变体上新增的字段」可说 —— added 空是对的，
  // 不要为了整齐去报一个不存在的 id/source/quality。
  const want = st.tracks.length ? ["id", "quality", "source"] : [];
  ok(name + "：added = " + JSON.stringify(want), JSON.stringify(d.added) === JSON.stringify(want), d.added);
}

// ---------------------------------------------------------------- [2] 图片必须进会话
section("[2] 图集页面：图片得进会话，封面不算图片");

const xhsSt = S.msBuildSession({ items: bag(PAGES.xhs), tabUrl: PAGES.xhs.url });
ok("会话里有 images 字段", Array.isArray(xhsSt.images), typeof xhsSt.images);
ok("四张图都在（不是只剩封面）", xhsSt.images.length === 4, xhsSt.images.length);
ok("封面单独在 cover 上", xhsSt.cover === "https://sns-img.xhscdn.com/cover.jpg", xhsSt.cover);
ok("封面不在 images 里", xhsSt.images.every((i) => i.url.indexOf("cover") < 0), xhsSt.images.map((i) => i.url));
ok("kind=image-set", xhsSt.kind === "image-set", xhsSt.kind);
ok("图片条目带 source=http", xhsSt.images[0].source === "http", xhsSt.images[0].source);
ok("图标不进 images（k=icon）", xhsSt.images.every((i) => i.url.indexOf("avatar") < 0));
ok("evidence 里有 image.url 证据", xhsSt.evidence.some((e) => e.field === "image.url"), xhsSt.evidence.slice(0, 2));

// ---------------------------------------------------------------- [3] 分片永不进 tracks
section("[3] 分片 / 图标 / 封面：两边都不该出现，计入 dropped 而不是 missing");

const hlsSt = S.msBuildSession({ items: bag(PAGES.hls), tabUrl: PAGES.hls.url });
const hlsD = S.msDiffSession(hlsSt, bag(PAGES.hls));
ok("分片没进 tracks", hlsSt.tracks.every((t) => t.variants.every((v) => !/\.ts$/i.test(v.url))),
  hlsSt.tracks.map((t) => t.variants.map((v) => v.url)));
ok("dropped 数 = 2 条分片", hlsD.counts.dropped === 2, hlsD.counts);
ok("分片没被记成 missing", hlsD.missing.length === 0, hlsD.missing);
ok("清单类型是 hls", hlsSt.manifest.type === "hls", hlsSt.manifest.type);
ok("时长从清单条目上取（634）", hlsSt.manifest.duration === 634, hlsSt.manifest.duration);

const tgSt = S.msBuildSession({ items: bag(PAGES.tg), tabUrl: PAGES.tg.url });
ok("blob 伪地址 m1 进了 video 轨（source=mse）",
  tgSt.tracks.some((t) => t.role === "video" && t.variants.some((v) => v.url === "m1" && v.source === "mse")));
ok("同一视频同时有 mse 与 http → confidence=conflict", tgSt.confidence === "conflict", tgSt.confidence);

// ---------------------------------------------------------------- [4] 反向：三条真丢法
section("[4] 反向验证：diff 必须真的能抓到丢数据（否则它只是个摆设）");

const base = S.msBuildSession({ items: bag(PAGES.hls), tabUrl: PAGES.hls.url });
// 变体排序是「有高度的在前、高的在前」，所以主清单（没有高度）排最后一条。
const lastUrl = base.tracks[0].variants[base.tracks[0].variants.length - 1].url;

// 4a 丢一条变体
const lostVariant = JSON.parse(JSON.stringify(base));
lostVariant.tracks[0].variants.pop();
const dA = S.msDiffSession(lostVariant, bag(PAGES.hls));
ok("少一条变体 → ok=false", dA.ok === false, dA.ok);
ok("少的那条进了 missing", dA.missing.length === 1, dA.missing);
ok("missing 里正是被删的那条", dA.missing[0] === lastUrl, { missing: dA.missing[0], want: lastUrl });

// 4b 值被改
const wrongSize = JSON.parse(JSON.stringify(base));
wrongSize.tracks[0].variants[0].size = 1;
const dB = S.msDiffSession(wrongSize, bag(PAGES.hls));
ok("变体大小被改 → ok=false", dB.ok === false, dB.ok);
ok("changed 指出字段是 size", dB.changed.some((c) => c.field === "size"), dB.changed);
ok("changed 带上了旧值与新值", dB.changed.every((c) => "old" in c && "new" in c), dB.changed);

// 4c 凭空多一条
const invented = JSON.parse(JSON.stringify(base));
invented.tracks[0].variants.push({ url: "https://x/none.mp4", source: "http", size: 1 });
const dC = S.msDiffSession(invented, bag(PAGES.hls));
ok("凭空多一条 → ok=false", dC.ok === false, dC.ok);
ok("多的那条进了 extra", dC.extra.length === 1 && dC.extra[0] === "https://x/none.mp4", dC.extra);

// 4d 整条轨道丢了（最容易发生：角色判定不一致）
const lostTrack = JSON.parse(JSON.stringify(base));
lostTrack.tracks = [];
const dD = S.msDiffSession(lostTrack, bag(PAGES.hls));
ok("整条轨道丢了 → missing 覆盖全部变体（含主清单那条）", dD.missing.length === 3, dD.missing);

// ---------------------------------------------------------------- [5] 合并是故意的
section("[5] 同地址多条：合并本身不算丢数据");

const dup = bag(PAGES.tg).concat([
  { u: "https://cdn.telesco.pe/file/abc.mp4", k: "video", m: "video/mp4", s: 9000000, w: 1280, h: 720 },
]);
const dupSt = S.msBuildSession({ items: dup, tabUrl: PAGES.tg.url });
const dupD = S.msDiffSession(dupSt, dup);
ok("同地址合并后 ok=true（不因为 size 变化报 changed）", dupD.ok === true, {
  changed: dupD.changed, missing: dupD.missing, counts: dupD.counts,
});
ok("计了 merged（2 条同地址合并成 1 条）", dupD.counts.merged === 2, dupD.counts);
ok("合并后保留更大的宽高", (() => {
  const v = dupSt.tracks.find((t) => t.role === "video").variants.find((x) => x.url.indexOf("abc.mp4") >= 0);
  return v && v.height === 720 && v.size === 9000000;
})(), dupSt.tracks.map((t) => t.variants));

// ---------------------------------------------------------------- [6] 脏输入不崩
section("[6] 脏输入：页面世界里什么都有，diff 不许抛");

const dirty = [
  null, undefined, 0, "", "x", [], {},
  { u: "", k: "video" },
  { u: "https://a/x.mp4", k: "video", s: "12MB" },
  { u: "https://a/y.jpg", k: "image" },
  { u: "javascript:alert(1)", k: "video" },
];
let threw = null;
try { S.msDiffSession(S.msBuildSession({ items: dirty, tabUrl: "not a url" }), dirty); }
catch (e) { threw = e && e.message; }
ok("脏条目数组不抛", threw === null, threw);

threw = null;
try { S.msDiffSession(null, null); } catch (e) { threw = e && e.message; }
ok("空会话 + 空条目不抛", threw === null, threw);

threw = null;
try { S.msDiffSession({}, [{ u: "https://a/x.mp4", k: "video" }]); } catch (e) { threw = e && e.message; }
ok("会话缺 tracks 也不抛", threw === null, threw);

// 没东西的页面：ok=true 且 missing 空（「扫过了确实没有」是合法结果）
const emptyD = S.msDiffSession(S.msBuildSession({ items: [], tabUrl: "https://a.com/v/1" }), []);
ok("空页面 ok=true", emptyD.ok === true, emptyD);
ok("空页面 added 是空数组（没东西可加）", Array.isArray(emptyD.added) && emptyD.added.length === 0, emptyD.added);

// ---------------------------------------------------------------- [7] added 由数据算
section("[7] added 不许写死：变体没有哪个字段就不该报哪个");

const thin = JSON.parse(JSON.stringify(base));
for (const t of thin.tracks) for (const v of t.variants) { delete v.source; delete v.quality; }
const thinD = S.msDiffSession(thin, bag(PAGES.hls));
ok("删掉 source/quality 后 added 只剩 id", JSON.stringify(thinD.added) === JSON.stringify(["id"]), thinD.added);

// ---------------------------------------------------------------- [8] Map 与数组等价
section("[8] 输入可以是 Map（background 里就是 Map）");

const mapBag = new Map();
for (const it of PAGES.hls.items) mapBag.set(it.u, it);
const mapSt = S.msBuildSession({ items: mapBag, tabUrl: PAGES.hls.url });
const mapD = S.msDiffSession(mapSt, mapBag);
ok("Map 输入与数组结果一致", JSON.stringify(mapD) === JSON.stringify(hlsD), { map: mapD, arr: hlsD });

console.log("\n" + (fail ? "有失败：" : "全部通过：") + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
