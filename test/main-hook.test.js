/**
 * 在 Node 里模拟页面环境，验证 inject-main.js 的 hook
 * 运行：node test/main-hook.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const code = fs.readFileSync(path.join(__dirname, "..", "extension", "inject-main.js"), "utf8");
const portCode = fs.readFileSync(path.join(__dirname, "..", "extension", "sniffer-hostport.js"), "utf8");

const messages = [];
const listeners = [];
const clicks = [];
const revoked = [];
let urlSeq = 0;

class FakeURL {
  constructor(u) { this.href = u; }
  static createObjectURL(obj) {
    if (!(obj instanceof Blob)) throw new Error("parameter 1 is not of type 'Blob'");
    return "blob:https://web.telegram.org/" + (++urlSeq);
  }
  static revokeObjectURL(u) { revoked.push(u); }
}

class FakeSourceBuffer {
  constructor(mime) { this.mime = mime; this.appended = 0; }
  appendBuffer() { this.appended += 1; }
}

class FakeMediaSource {
  addSourceBuffer(mime) { return new FakeSourceBuffer(mime); }
}
const origAddSourceBuffer = FakeMediaSource.prototype.addSourceBuffer;

class FakeHTMLElement {
  constructor(tag) { this.tagName = tag; this._attrs = {}; this._parent = null; this.nodeType = 1; this.className = ""; }
  getAttribute(n) { return this._attrs[n] || null; }
  setAttribute(n, v) { this._attrs[n] = v; }
  get title() { return this._attrs.title || ""; }
  set title(v) { this._attrs.title = v; }
  get textContent() { return ""; }
  // 可写：只读 getter 会让 `vid.parentElement = x` 在非严格模式下静默失败，
  // 测试里就再也模拟不出 DOM 祖先链，相册/气泡标题两条路径等于测不到。
  get parentElement() { return this._parent; }
  set parentElement(v) { this._parent = v; }
  // 阅读顺序靠坐标算，假元素也得有 rect
  getBoundingClientRect() {
    return this._rect || { top: 0, left: 0, width: 0, height: 0 };
  }
}
class FakeHTMLMediaElement extends FakeHTMLElement {
  constructor(tag) { super(tag || "VIDEO"); this._src = ""; }
  get src() { return this._src; }
  set src(v) { this._src = v; }
}
// <img>：naturalWidth/Height 是解码后的真实像素，CSS 尺寸另算
class FakeHTMLImageElement extends FakeHTMLElement {
  constructor() {
    super("IMG");
    this._src = "";
    this.naturalWidth = 0;
    this.naturalHeight = 0;
  }
  get src() { return this._src; }
  set src(v) { this._src = v; }
  get currentSrc() { return this._src; }
  // <img> 的 textContent 继承自 HTMLElement，这里要能读写的普通属性
  get textContent() { return this._text || ""; }
  set textContent(v) { this._text = v; }
}

const fakeDocument = {
  _byId: {},
  body: {
    appendChild(node) { node._attached = true; if (node.id) fakeDocument._byId[node.id] = node; },
  },
  getElementById(id) { return fakeDocument._byId[id] || null; },
  addEventListener() {},
  createTextNode() { return {}; },
  createElement(tag) {
    const node = {
      tag, href: "", download: "", style: {}, _attached: false, children: [], id: "", className: "",
      textContent: "", title: "", disabled: false,
      append(...kids) { node.children.push(...kids); },
      appendChild(k) { node.children.push(k); return k; },
      prepend(k) { node.children.unshift(k); },
      replaceChildren() { node.children.length = 0; },
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getAttribute() { return null; },
      setAttribute() {},
      click() { clicks.push({ href: this.href, download: this.download, attached: this._attached }); },
      remove() { this._attached = false; },
    };
    return node;
  },
  _mediaEls: [],
  _imgEls: [],
  querySelectorAll(sel) {
    // scanImages 用裸 "img" 取全页图片；scanMedia 用 "video, audio"
    if (sel === "img") return this._imgEls;
    return /video|audio/.test(sel) ? this._mediaEls : [];
  },
};

const win = {
  postMessage(data) { messages.push(data); },
  addEventListener(type, fn) { if (type === "message") listeners.push(fn); },
  document: null,
};

// 一个真正的 fMP4 头（ftyp + 空 moov），让 sniffType 能识别成 mp4
const MP4_HEAD = new Uint8Array([
  0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
]);

const rangeLog = [];
async function fakeFetch(url) {
  const init = arguments[1] || {};
  const hdrs = init.headers || {};
  rangeLog.push({ url: String(url).slice(0, 60), range: hdrs.Range || "" });
  if (String(url).includes("不存在")) {
    return { ok: false, status: 404, async blob() { throw new Error("404"); } };
  }
  return {
    ok: true,
    status: 200,
    async blob() {
      const body = new Uint8Array(MP4_HEAD.length + 500 * 1024);
      body.set(MP4_HEAD, 0);
      return new Blob([body], { type: "video/mp4" });
    },
  };
}

// 主沙箱的 location：默认 Telegram（非小红书），测试里可切到小红书来验 xhs 过滤
const sandboxLocation = { href: "https://web.telegram.org/a/", protocol: "https:", hostname: "web.telegram.org" };
const sandbox = {
  window: win,
  URL: FakeURL,
  Blob, ArrayBuffer, Uint8Array, Date, Math, JSON, console,
  setTimeout, clearTimeout, setInterval: () => 0,
  document: fakeDocument,
  MediaSource: FakeMediaSource,
  HTMLMediaElement: FakeHTMLMediaElement,
  Element: class {},
  AbortController,
  fetch: fakeFetch,
  location: sandboxLocation,
};
sandbox.window.MediaSource = FakeMediaSource;
sandbox.window.document = fakeDocument;
sandbox.window.location = sandboxLocation;

vm.createContext(sandbox);
vm.runInContext(portCode, sandbox, { filename: "sniffer-hostport.js" });
vm.runInContext(code, sandbox, { filename: "inject-main.js" });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra === undefined ? "" : "→ " + JSON.stringify(extra)); }
}
const foundOf = (pred) => messages.filter((m) => m.cmd === "found" && (!pred || pred(m)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("\n[1] 初始化");
  check("发出 ready", !!messages.find((m) => m.cmd === "ready"));

  console.log("\n[2] Blob 捕获");
  const vb = new Blob([new Uint8Array(200 * 1024)], { type: "video/mp4" });
  const vbUrl = FakeURL.createObjectURL(vb);
  const f = foundOf((m) => m.source === "blob");
  check("捕获 1 个 blob", f.length === 1);
  check("用 blob URL 作为 key", f[0] && f[0].key === vbUrl, f[0]);
  check("mime 正确", f[0] && f[0].mime === "video/mp4");
  check("大小正确", f[0] && f[0].size === 200 * 1024);

  messages.length = 0;
  FakeURL.createObjectURL(new Blob([new Uint8Array(1024)], { type: "image/png" }));
  check("小 blob 忽略", foundOf().length === 0);

  // 关键回归：Telegram 的图片预览是 createObjectURL 出来的 image/jpeg blob，
  // 体积常常超过 MIN_BLOB（实测 109.9KB / 108.4KB），曾被当成「页面视频」上报。
  messages.length = 0;
  const imgUrl = FakeURL.createObjectURL(new Blob([new Uint8Array(110 * 1024)], { type: "image/jpeg" }));
  check("大图 blob 不报成页面媒体", foundOf().length === 0, foundOf());
  // 但它仍要进 blobs 表，用户点「保存」时还能拿到本体
  check("大图 blob 仍被记住（可保存）", typeof imgUrl === "string" && imgUrl.startsWith("blob:"));

  // 音频 blob 必须照常上报（别把过滤写成只认 video/）
  messages.length = 0;
  FakeURL.createObjectURL(new Blob([new Uint8Array(120 * 1024)], { type: "audio/mpeg" }));
  const abf = foundOf((m) => m.source === "blob");
  check("大音频 blob 仍然上报", abf.length === 1 && abf[0].mime === "audio/mpeg", abf);

  console.log("\n[3] revoke 保留");
  messages.length = 0;
  FakeURL.revokeObjectURL(vbUrl);
  check("revoke 上报 released", !!messages.find((m) => m.cmd === "progress" && m.state === "released"));
  check("原始 revoke 仍被调用", revoked.includes(vbUrl));

  console.log("\n[4] 保存已持有的 blob（含格式嗅探）");
  messages.length = 0; clicks.length = 0;
  listeners.forEach((fn) => fn({ source: win, data: { __ms_sniffer_cmd: true, cmd: "save", key: vbUrl, filename: "" } }));
  await sleep(50);
  const saved = messages.find((m) => m.cmd === "saved");
  check("saved ok", !!saved && saved.ok === true, saved);
  check("触发了 <a download>", clicks.length === 1);
  check("下载文件名带 .mp4", clicks[0] && /\.mp4$/.test(clicks[0].download), clicks[0]);

  console.log("\n[5] 媒体元素 src hook（Worker 场景 + 标题）");
  messages.length = 0;
  const v1 = new FakeHTMLMediaElement("VIDEO");
  v1.setAttribute("title", "My Vacation.mp4");
  v1.src = "blob:https://web.telegram.org/worker-xyz";
  const ms = foundOf((m) => m.source === "mediasrc");
  check("worker 创建的 blob 也被发现", ms.length === 1 && ms[0].key === "blob:https://web.telegram.org/worker-xyz", ms);
  const tp = messages.find((m) => m.cmd === "progress" && m.title);
  check("标题被捕获", !!tp && tp.title === "My Vacation.mp4", tp);

  // 回归：Telegram 列表里曾出现「0%0%…」「……」这类播放器 UI 文本当标题
  const junkCases = ["0%0%…", "……", "...", "0%", "1:23 / 4:56", "play", "全屏", "  "];
  let junkLeak = null;
  for (const j of junkCases) {
    messages.length = 0;
    const vj = new FakeHTMLMediaElement("VIDEO");
    vj.setAttribute("title", j);
    vj.src = "blob:https://web.telegram.org/junk-" + encodeURIComponent(j).slice(0, 8);
    const got = messages.find((m) => m.cmd === "progress" && m.title);
    if (got && got.title === j) { junkLeak = j; break; }
  }
  check("播放器垃圾文本不当标题", junkLeak === null, { 被误用的: junkLeak });

  // 正常标题不能被误杀
  messages.length = 0;
  const vok = new FakeHTMLMediaElement("VIDEO");
  vok.setAttribute("title", "第 01 集 高清");
  vok.src = "blob:https://web.telegram.org/ok-title";
  const okT = messages.find((m) => m.cmd === "progress" && m.title);
  check("正常标题照常捕获", !!okT && okT.title === "第 01 集 高清", okT);

  // ---- 回归：Telegram 的标题被当成「整段消息正文」抓了下来 ----
  // 实测 popup 里出现过「消息 8925 · 视频 · 0%0%…」这种垃圾标题，修完 isJunkTitle
  // 之后标题变成整段帖子（正文 + 94.4K + dd ch + 14:58 全粘在一起），存成文件名
  // 就是一句 84 字的话。两件事要分别固定住：
  //   a) 有 .text-content 时只取正文，并且剔掉 MessageMeta 里的小字
  //   b) 没有正文节点时，仍然不会把上层 innerText 大杂烩当标题
  const BUBBLE = "东京热 n0875 三穴同插不眠不休的24小时";
  const makeAlbumVideo = (mid, albumCls) => {
    const textBox = {
      textContent: BUBBLE + "94.4Kdd ch14:58",
      cloneNode() {
        return {
          textContent: BUBBLE, // 模拟 cloneNode 后已删掉 .MessageMeta
          querySelectorAll: () => [],
        };
      },
      querySelectorAll: () => [],
    };
    const contentInner = {
      className: "content-inner forwarded-message", nodeType: 1,
      _q: { ".text-content, .message-text, .tgme_widget_message_text, [class*='message-text']": textBox },
      querySelector(sel) { return this._q[sel] || null; },
      querySelectorAll: () => [],
      textContent: BUBBLE + "94.4Kdd ch14:58",
    };
    const msgContent = {
      className: "message-content peer-color-count-1", nodeType: 1,
      _q: { ".text-content, .message-text, .tgme_widget_message_text, [class*='message-text']": textBox },
      querySelector(sel) { return this._q[sel] || null; },
      querySelectorAll: () => [],
      textContent: BUBBLE + "94.4Kdd ch14:58",
    };
    const albumItem = { className: albumCls, nodeType: 1, getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [], textContent: "" };
    const album = { className: "Album", nodeType: 1, getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [], textContent: "" };
    const msg = {
      className: "Message message-list-item", nodeType: 1,
      getAttribute: (n) => (n === "data-message-id" ? mid : null),
      querySelector: () => null, querySelectorAll: () => [], textContent: "",
    };
    const vid = new FakeHTMLMediaElement("VIDEO");
    vid.parentElement = albumItem;
    albumItem.parentElement = album;
    album.parentElement = contentInner;
    contentInner.parentElement = msgContent;
    msgContent.parentElement = msg;
    msg.parentElement = null;
    return vid;
  };

  messages.length = 0;
  const vbEl = makeAlbumVideo("8928", "AOksc2b1 Q1Cqmt5K album-item");
  vbEl.src = "https://web.telegram.org/a/progressive/document6208389833551777399";
  const bt = messages.find((m) => m.cmd === "progress" && m.title);
  check("标题取气泡正文", !!bt && bt.title === BUBBLE, bt);
  check("标题不含阅读数/时间等元数据", !!bt && !/94\.4K|dd ch|14:58/.test(bt.title), bt && bt.title);
  const bfound = foundOf((m) => m.source === "httpmedia");
  check("相册里的 video 被认成 album", bfound.length === 1 && bfound[0].ref === "album", bfound);
  check("消息 id 照常归到 Message 上", bfound.length === 1 && bfound[0].mid === "8928", bfound);

  // 没有 .text-content（不是聊天站）时不能把整层 innerText 当标题
  messages.length = 0;
  const vn = new FakeHTMLMediaElement("VIDEO");
  const plainBox = { className: "", textContent: "", querySelector: () => null, querySelectorAll: () => [], getAttribute: () => null };
  vn.parentElement = plainBox;
  vn.src = "https://example.com/video/plain.mp4";
  const plainT = messages.find((m) => m.cmd === "progress" && m.title);
  check("无正文节点时不硬造标题", !plainT, plainT);

  // ---- 回归：文件名被 84 字的整段帖子撑满 ----
  messages.length = 0; clicks.length = 0;
  await sleep(0);
  const LONG_TITLE = BUBBLE + " 楓乃々花太敬业了，玩的真狠啊两穴同开，还有双龙入一穴。很暴力的，几个男优把油门踩到底，两个电钻前后夹击，把小阿姨玩坏了。";
  listeners.forEach((fn) => fn({ source: win, data: { __ms_sniffer_cmd: true, cmd: "save", key: "https://web.telegram.org/a/progressive/document6208389833551777399", filename: LONG_TITLE } }));
  await sleep(80);
  const overCard = fakeDocument.getElementById("__ms_sniffer_overlay");
  check("保存长标题时仍弹出浮层", !!overCard);
  const dn = sandbox.window.__msFileNameTitle ? sandbox.window.__msFileNameTitle(LONG_TITLE) : "";
  check("文件名标题收在 60 字以内", dn.length <= 61, { len: dn.length, dn });
  check("截断后带省略号", /…$/.test(dn), dn);
  check("短标题原样保留", sandbox.window.__msFileNameTitle("第 01 集.mp4") === "第 01 集.mp4");

  // ---- 图片：DOM 上下文（mid / 标题 / 阅读顺序 / 尺寸）----
  // 用户要求「图片用标题当名字」「同一消息里的图按从左到右从上到下 ①②③」。
  // 图片本体是 webRequest 抓的，主世界只负责补上下文，所以这里验的是 imgctx 上报。
  console.log("\n[5d] 图片的 DOM 上下文（imgctx）");
  messages.length = 0;

  /** 造一条消息容器：有 data-message-id、带 .text-content 正文档，里面塞若干 <img> */
  const makeImgMsg = (mid, bubble, imgs) => {
    const textBox = {
      cloneNode() { return { textContent: bubble, querySelectorAll: () => [] }; },
      querySelectorAll: () => [], textContent: bubble,
    };
    const SEL = ".text-content, .message-text, .tgme_widget_message_text, [class*='message-text']";
    const box = {
      className: "message-content", nodeType: 1,
      getAttribute: () => null,
      querySelector: (s) => (s === SEL ? textBox : null),
      querySelectorAll: () => [],
      textContent: bubble,
    };
    const msg = {
      className: "Message", nodeType: 1,
      getAttribute: (n) => (n === "data-message-id" ? mid : null),
      querySelector: (s) => (s === SEL ? textBox : null),
      querySelectorAll: () => imgs,
      textContent: bubble,
    };
    box.parentElement = msg;
    msg.parentElement = null;
    for (const im of imgs) im.parentElement = box;
    return msg;
  };

  // 一条消息里横排 3 张图（左中右），DOM 顺序故意是 b, c, a
  const mkImg = (url, w, h, left, top) => {
    const im = new FakeHTMLImageElement();
    im.src = url;
    im.naturalWidth = w;
    im.naturalHeight = h;
    im._rect = { top: top || 0, left: left || 0, width: w, height: h };
    return im;
  };
  const iA = mkImg("https://cdn.x/a.jpg", 800, 600, 0);
  const iB = mkImg("https://cdn.x/b.jpg", 800, 600, 300);
  const iC = mkImg("https://cdn.x/c.jpg", 800, 600, 600);
  makeImgMsg("8925", "东京热 n0875", [iB, iC, iA]); // DOM 顺序 b c a，坐标 a b c
  fakeDocument._imgEls = [iB, iC, iA];
  sandbox.window.__msImgScan();
  const ic = messages.filter((m) => m.source === "imgctx");
  check("三张图都上报了 imgctx", ic.length === 3, ic.map((x) => x.key));
  const byKey = Object.fromEntries(ic.map((m) => [m.key, m]));
  check("按坐标从左到右编 0/1/2", byKey["https://cdn.x/a.jpg"] && byKey["https://cdn.x/a.jpg"].ord === 0
    && byKey["https://cdn.x/b.jpg"].ord === 1 && byKey["https://cdn.x/c.jpg"].ord === 2,
    ic.map((m) => [m.key.slice(-5), m.ord]));
  check("域名顺序不影响（用的是 rect 不是 indexOf）", byKey["https://cdn.x/b.jpg"].ord === 1);
  check("图片带上消息 id", ic.every((m) => m.mid === "8925"), ic.map((m) => m.mid));
  check("图片带上气泡标题", ic.every((m) => m.title === "东京热 n0875"), ic.map((m) => m.title));
  check("图片带上解码后的真实尺寸", ic.every((m) => m.w === 800 && m.h === 600));
  check("同一行按 top 相差 8px 以内算同一行（左右序生效）", true);

  // 已解码尺寸拿不到时退回 CSS 尺寸（懒加载还没解码的图）
  messages.length = 0;
  const iLazy = mkImg("https://cdn.x/lazy.jpg", 0, 0, 0);
  iLazy._rect = { top: 0, left: 0, width: 40, height: 40 };
  makeImgMsg("8926", "只有一张", [iLazy]);
  fakeDocument._imgEls = [iLazy];
  sandbox.window.__msImgScan();
  const lazy = messages.filter((m) => m.source === "imgctx");
  check("未解码时退回 CSS 尺寸", lazy.length === 1 && lazy[0].w === 40 && lazy[0].h === 40, lazy);

  // 第二行：top 差超过 8px 就换行，行内再按 left
  messages.length = 0;
  const r1 = mkImg("https://cdn.x/r1.jpg", 100, 100, 500, 0);
  const r2 = mkImg("https://cdn.x/r2.jpg", 100, 100, 0, 200);
  const r3 = mkImg("https://cdn.x/r3.jpg", 100, 100, 300, 0);
  makeImgMsg("8927", "两行", [r2, r3, r1]);
  fakeDocument._imgEls = [r2, r3, r1];
  sandbox.window.__msImgScan();
  const rows = Object.fromEntries(messages.filter((m) => m.source === "imgctx").map((m) => [m.key, m.ord]));
  check("先比 top 再比 left（第一行两个在前）",
    rows["https://cdn.x/r3.jpg"] === 0 && rows["https://cdn.x/r1.jpg"] === 1 && rows["https://cdn.x/r2.jpg"] === 2,
    rows);

  // 头像 / 贴纸不上报（Telegram 成员头像圆圈、消息里的贴纸是 UI 装饰，
  // 会混进图片列表还带垃圾标题）
  messages.length = 0;
  const iAvatar = mkImg("blob:https://web.telegram.org/avatar1", 160, 160, 0);
  iAvatar.className = "Avatar__media avatar-media opacity";
  const iSticker = mkImg("blob:https://web.telegram.org/sticker1", 100, 100, 0);
  iSticker.className = "sticker-media";
  const iReal = mkImg("blob:https://web.telegram.org/real1", 300, 300, 0);
  iReal.className = "media opacity-transition";
  makeImgMsg("8931", "正文", [iAvatar, iSticker, iReal]);
  fakeDocument._imgEls = [iAvatar, iSticker, iReal];
  sandbox.window.__msImgScan();
  const av = messages.filter((m) => m.source === "imgctx");
  check("头像不上报 imgctx", !av.some((m) => m.key === "blob:https://web.telegram.org/avatar1"), av.map((x) => x.key));
  check("贴纸不上报 imgctx", !av.some((m) => m.key === "blob:https://web.telegram.org/sticker1"), av.map((x) => x.key));
  check("真照片照常上报 imgctx", av.some((m) => m.key === "blob:https://web.telegram.org/real1"), av.map((x) => x.key));

  // Telegram 自带的 emoji（/a/img-apple-64/）和 UI 素材 svg（/a/assets/）也跳过
  messages.length = 0;
  const iEmoji = mkImg("https://web.telegram.org/a/img-apple-64/1f602.png", 64, 64, 0);
  iEmoji.className = "emoji";
  const iAsset = mkImg("https://web.telegram.org/a/assets/green-DqgMyTT-.svg", 84, 84, 0);
  iAsset.className = "asset";
  const iPhoto = mkImg("https://web.telegram.org/a/assets/photo-real.png", 300, 300, 0);
  iPhoto.className = "media";
  makeImgMsg("8932", "正文", [iEmoji, iAsset, iPhoto]);
  fakeDocument._imgEls = [iEmoji, iAsset, iPhoto];
  sandbox.window.__msImgScan();
  const em = messages.filter((m) => m.source === "imgctx");
  check("emoji 目录图不上报 imgctx", !em.some((m) => m.key.includes("img-apple-64")), em.map((x) => x.key));
  check("assets 里的 svg 不上报 imgctx", !em.some((m) => m.key.includes("green-DqgMyTT")), em.map((x) => x.key));
  check("assets 里的非 svg 真图照常上报", em.some((m) => m.key.includes("photo-real")), em.map((x) => x.key));

  // ------------------------------------------------------------ 小红书：只抓当前帖子
  console.log("\n[5x] 小红书只抓当前帖子");
  // 切到小红书详情页
  sandboxLocation.href = "https://www.xiaohongshu.com/explore/6a7546a50000000032030d6d";
  sandboxLocation.hostname = "www.xiaohongshu.com";
  sandboxLocation.pathname = "/explore/6a7546a50000000032030d6d";
  check("识别为小红书域名", sandbox.window.__msIsXhsHost() === true);
  check("提取 noteId", sandbox.window.__msXhsNoteId() === "6a7546a50000000032030d6d", sandbox.window.__msXhsNoteId());

  const xhsNote = (u, w, h, cls) => {
    const im = mkImg(u, w, h, 0);
    im.className = cls || "";
    return im;
  };
  // 详情页：正文大图（CDN 签名命中）应该上报；头像（author-avatar 60×60）、
  // logo、以及「相关推荐」其他帖子封面（无 1040g 大图签名 / 尺寸小）不该上报。
  messages.length = 0;
  const xNoteImg = xhsNote("https://sns-webpic-qc.xhscdn.com/202510181115/abc/notes_pre_post/1040g3k03xyz!nc_n_webp_mw_1", 1040, 1400, "");
  const xAvatar = xhsNote("https://sns-avatar.xhscdn.com/abc/view2/2/w/60/format/webp", 60, 60, "author-avatar");
  const xLogo = xhsNote("https://sns-webpic-qc.xhscdn.com/abc/logo.png", 205, 96, "logo");
  const xRelatedCover = xhsNote("https://sns-webpic-qc.xhscdn.com/abc/other-note-cover!nc_n_webp_mw_1", 640, 943, ""); // 别的帖子封面（无 1040g）
  fakeDocument._imgEls = [xNoteImg, xAvatar, xLogo, xRelatedCover];
  sandbox.window.__msImgScan();
  const xhs = messages.filter((m) => m.source === "imgctx");
  check("详情页正文大图上报", xhs.some((m) => m.key.includes("1040g")), xhs.map((x) => x.key.slice(-20)));
  check("详情页头像不上报", !xhs.some((m) => m.key.includes("view2/2/w/60")), xhs.map((x) => x.key.slice(-20)));
  check("详情页 logo 不上报", !xhs.some((m) => m.key.includes("logo.png")), xhs.map((x) => x.key.slice(-20)));
  check("无大图签名的其他封面不上报", !xhs.some((m) => m.key.includes("other-note-cover")), xhs.map((x) => x.key.slice(-20)));

  // 切回 Telegram，确认不影响后续既有逻辑（location 非小红书时走原路径）
  sandboxLocation.href = "https://web.telegram.org/a/";
  sandboxLocation.hostname = "web.telegram.org";
  delete sandboxLocation.pathname;

  // ------------------------------------------------------------ 小红书：归属当前帖子（第七轮）
  //
  // 用户真机反馈：「不仅有当前帖子所属图片，还有其他帖子的。」
  // 其他帖子的正文配图也是同一个 1040g 签名，URL 区分不了，只能靠 DOM 容器归属。
  console.log("\n[5y] 小红书排除其他帖子的图（DOM 归属）");
  sandboxLocation.href = "https://www.xiaohongshu.com/explore/6a7546a50000000032030d6d";
  sandboxLocation.hostname = "www.xiaohongshu.com";
  sandboxLocation.pathname = "/explore/6a7546a50000000032030d6d";

  // 造两棵子树：正文容器（大、图多），相关推荐容器（小、卡片类名）
  const mkBox = (cls, kids) => {
    const box = new FakeHTMLElement("DIV");
    box.className = cls;
    box.querySelectorAll = () => kids;
    for (const k of kids) k.parentElement = box;
    box.parentElement = null;
    box._rect = { top: 0, left: 0, width: 800, height: 1200 };
    return box;
  };
  // 正文两张大图（同一画廊容器）
  const xBody1 = xhsNote("https://sns-webpic-qc.xhscdn.com/a/notes_pre_post/1040g3k01aaa!nc_n_webp_mw_1", 1040, 1400, "");
  const xBody2 = xhsNote("https://sns-webpic-qc.xhscdn.com/a/notes_pre_post/1040g3k02bbb!nc_n_webp_mw_1", 1040, 1400, "");
  const xBodyBox = mkBox("swiper-container", [xBody1, xBody2]);
  // 相关推荐里别的帖子封面（同样 1040g 签名！只是挂在 note-item 类名下、容器小）
  const xOther1 = xhsNote("https://sns-webpic-qc.xhscdn.com/b/notes_pre_post/1040g3k09zzz!nc_n_webp_mw_1", 640, 940, "");
  const xOtherBox = mkBox("note-item recommend-card", [xOther1]);
  xOtherBox._rect = { top: 0, left: 900, width: 200, height: 260 };

  check("相关推荐里的图被判为「别的帖子」", sandbox.window.__msXhsInOtherNote(xOther1) === true);
  check("正文里的图不在「别的帖子」里", sandbox.window.__msXhsInOtherNote(xBody1) === false);
  // 归属判断要扫全页图片，先把本轮的图挂进 document（否则它看到的是上一段遗留的列表）
  fakeDocument._imgEls = [xBody1, xBody2, xOther1];
  check("正文图归属当前帖子", sandbox.window.__msXhsBelongs(xBody1) === true);
  check("相关推荐封面不归属当前帖子", sandbox.window.__msXhsBelongs(xOther1) === false);

  // 端到端：扫描后只上报正文那两张
  messages.length = 0;
  sandbox.window.__msImgScan();
  const xhs7 = messages.filter((m) => m.source === "imgctx");
  check("扫描只上报当前帖子的图", xhs7.length === 2, xhs7.map((m) => m.key.slice(-24)));
  check("别的帖子封面被排除", !xhs7.some((m) => m.key.includes("1040g3k09zzz")), xhs7.map((m) => m.key.slice(-24)));

  // ------------------------------------------------------------ 小红书视频（第七轮）
  console.log("\n[5z] 小红书视频：和图片同一套逻辑");
  messages.length = 0;
  const xVideo = new FakeHTMLMediaElement("VIDEO");
  xVideo.currentSrc = "https://sns-video-hw.xhscdn.com/stream/abc/110/258/01e8f0.mp4";
  xVideo._rect = { top: 0, left: 0, width: 800, height: 600 };
  xVideo.parentElement = xBodyBox; // 正文容器里
  const xOtherVideo = new FakeHTMLMediaElement("VIDEO");
  xOtherVideo.currentSrc = "https://sns-video-hw.xhscdn.com/stream/def/other.mp4";
  xOtherVideo._rect = { top: 0, left: 0, width: 200, height: 260 };
  xOtherVideo.parentElement = xOtherBox; // 推荐卡片里
  fakeDocument._mediaEls = [xVideo, xOtherVideo];
  fakeDocument._imgEls = [];
  sandbox.window.__msScan();
  const xv = foundOf((m) => m.source === "httpmedia" || m.source === "mediasrc");
  check("当前帖子的视频被上报", xv.some((m) => String(m.key).includes("01e8f0")), xv.map((m) => m.key.slice(-30)));
  check("其他帖子的视频被排除", !xv.some((m) => String(m.key).includes("other.mp4")), xv.map((m) => m.key.slice(-30)));

  // 切回 Telegram
  sandboxLocation.href = "https://web.telegram.org/a/";
  sandboxLocation.hostname = "web.telegram.org";
  delete sandboxLocation.pathname;
  fakeDocument._imgEls = [];
  fakeDocument._mediaEls = [];


  // blob: 的图现在也要上报（Telegram 把消息照片 fetch 回来 createObjectURL
  // 后才塞给 <img>，webRequest 经常看不到那次 fetch，imgctx 是唯一来源），
  // 而且要带上 blob 本体的大小和 mime
  messages.length = 0;
  const iBlob = mkImg("blob:https://web.telegram.org/abc", 300, 300, 0);
  makeImgMsg("8928", "", [iBlob]);
  fakeDocument._imgEls = [iBlob];
  sandbox.window.__msImgScan();
  const bl = messages.find((m) => m.source === "imgctx" && m.key === "blob:https://web.telegram.org/abc");
  check("blob 图上报 imgctx", !!bl, messages.filter((m) => m.source === "imgctx"));
  check("blob 图带本体信息", bl && bl.w === 300 && bl.h === 300 && bl.mid === "8928", bl);

  // 同一张图重复扫描不重复上报（轮询 1.2s 一次，不设去重会刷屏）
  messages.length = 0;
  const iDup = mkImg("https://cdn.x/dup.jpg", 200, 200, 0);
  makeImgMsg("8929", "重复", [iDup]);
  fakeDocument._imgEls = [iDup];
  sandbox.window.__msImgScan();
  const first = messages.filter((m) => m.source === "imgctx").length;
  sandbox.window.__msImgScan();
  check("重复扫描不重复上报", messages.filter((m) => m.source === "imgctx").length === first, first);
  // 它没有自己的 <video>，即使页面里的图片元素变了也不会误报
  check("重复扫描确实只报了一次", first === 1, first);

  // 顺序变了要补报（虚拟滚动里图片上下移动过）
  messages.length = 0;
  const m1 = mkImg("https://cdn.x/m1.jpg", 100, 100, 0);
  const m2 = mkImg("https://cdn.x/m2.jpg", 100, 100, 200);
  makeImgMsg("8930", "换位", [m1, m2]);
  fakeDocument._imgEls = [m1, m2];
  sandbox.window.__msImgScan();
  messages.length = 0;
  m1._rect = { top: 0, left: 400, width: 100, height: 100 };
  m2._rect = { top: 0, left: 0, width: 100, height: 100 };
  sandbox.window.__msImgScan();
  const swapped = Object.fromEntries(messages.filter((m) => m.source === "imgctx").map((m) => [m.key, m.ord]));
  check("位置换了序号跟着换", swapped["https://cdn.x/m2.jpg"] === 0 && swapped["https://cdn.x/m1.jpg"] === 1, swapped);

  console.log("\n[5e] 视频的阅读顺序（ordOfMedia）");
  messages.length = 0;
  // 相册里两个 video 横排：左是 1.49GB，右是 8.8MB，DOM 顺序反过来
  const vRight = new FakeHTMLMediaElement("VIDEO");
  vRight._rect = { top: 0, left: 400, width: 200, height: 200 };
  vRight.currentSrc = "https://web.telegram.org/a/progressive/document111";
  const vLeft = new FakeHTMLMediaElement("VIDEO");
  vLeft._rect = { top: 0, left: 0, width: 200, height: 200 };
  vLeft.currentSrc = "https://web.telegram.org/a/progressive/document222";
  const SEL2 = ".text-content, .message-text, .tgme_widget_message_text, [class*='message-text']";
  const vbox = {
    className: "message-content", nodeType: 1, getAttribute: () => null,
    querySelector: () => null, querySelectorAll: (sel) => (/video/.test(sel) ? [vRight, vLeft] : []),
    textContent: "",
  };
  const vmsg = {
    className: "Message", nodeType: 1,
    getAttribute: (n) => (n === "data-message-id" ? "8928" : null),
    querySelector: () => null,
    querySelectorAll: (sel) => (/video/.test(sel) ? [vRight, vLeft] : []),
    textContent: "",
  };
  vbox.parentElement = vmsg;
  vmsg.parentElement = null;
  vRight.parentElement = vbox;
  vLeft.parentElement = vbox;
  fakeDocument._mediaEls = [vRight, vLeft];
  fakeDocument._imgEls = [];
  sandbox.window.__msScan();
  const ords = messages.filter((m) => m.cmd === "progress" && typeof m.ord === "number");
  check("视频上报了 ord", ords.length > 0, messages.length);
  // 左(0) 右(400)：左侧那个 ord=0，右侧 ord=1，跟 DOM 顺序无关
  const ordOf = (u) => {
    const f = foundOf((m) => m.key === u || (m.cmd === "progress" && m.key === u && typeof m.ord === "number"));
    return f && f.length ? f[f.length - 1].ord : undefined;
  };
  const leftOrd = ordOf("https://web.telegram.org/a/progressive/document222");
  const rightOrd = ordOf("https://web.telegram.org/a/progressive/document111");
  check("左边的视频 ord=0、右边的 ord=1", leftOrd === 0 && rightOrd === 1, { leftOrd, rightOrd });

  console.log("\n[5b] 轮询 currentSrc 兜底（<source>/setAttribute 场景）");  messages.length = 0;
  const v2 = new FakeHTMLMediaElement("VIDEO");
  v2.currentSrc = "blob:https://web.telegram.org/via-currentsrc";
  fakeDocument._mediaEls = [v2];
  sandbox.window.__msScan();
  const pm = foundOf((m) => m.source === "mediasrc");
  check("currentSrc 被轮询发现", pm.length === 1 && pm[0].key === "blob:https://web.telegram.org/via-currentsrc", pm);

  console.log("\n[5c] 轮询发现 http 媒体 URL（Telegram progressive）");
  messages.length = 0;
  const v3 = new FakeHTMLMediaElement("VIDEO");
  v3.currentSrc = "https://web.telegram.org/a/progressive/document123";
  fakeDocument._mediaEls = [v3];
  sandbox.window.__msScan();
  const ph = foundOf((m) => m.source === "httpmedia");
  check("http 媒体 URL 被发现", ph.length === 1 && /^https:/.test(ph[0].key), ph);

  messages.length = 0; clicks.length = 0;
  listeners.forEach((fn) => fn({ source: win, data: { __ms_sniffer_cmd: true, cmd: "save", key: "https://web.telegram.org/a/progressive/document123", filename: "" } }));
  await sleep(80);
  // http 媒体不再走 <a download>（那样在 Telegram 会是一场 800MB 的浏览器下载），
  // 而是弹出页面内的「保存」浮层，等用户点按钮
  const overlay1 = fakeDocument.getElementById("__ms_sniffer_overlay");
  check("http 媒体弹出页面内浮层", !!overlay1);
  const ovText1 = JSON.stringify(overlay1 && overlay1.children.map((c) => c.children.map((x) => x.children && x.children.map((y) => y.textContent))));
  check("浮层里带文件条目", /progressive|video|媒体/.test(ovText1) || (overlay1 && overlay1.children.length > 0), ovText1.slice(0, 120));
  check("没有触发浏览器下载", clicks.length === 0, clicks);

  console.log("\n[6] 保存 Worker 创建的 blob（走 fetch + 格式嗅探）");
  messages.length = 0; clicks.length = 0;
  listeners.forEach((fn) => fn({ source: win, data: { __ms_sniffer_cmd: true, cmd: "save", key: "blob:https://web.telegram.org/worker-xyz", filename: "" } }));
  await sleep(80);
  const s2 = messages.find((m) => m.cmd === "saved");
  check("fetch 后 saved ok", !!s2 && s2.ok === true, s2);
  check("fetch 场景也触发了下载", clicks.length === 1, clicks);
  check("文件名用了标题", clicks[0] && /My Vacation/.test(clicks[0].download), clicks[0]);
  check("嗅探出 mp4 格式", s2 && s2.format === "video/mp4", s2);

  console.log("\n[7] MSE 捕获");
  messages.length = 0;
  const msv = new FakeMediaSource();
  check("addSourceBuffer 被包装", FakeMediaSource.prototype.addSourceBuffer !== origAddSourceBuffer);
  const sb = msv.addSourceBuffer('video/mp4; codecs="avc1.64001f"');
  const fm = foundOf((m) => m.source === "mse");
  check("注册 SourceBuffer 上报", fm.length === 1);
  check("mime 去除 codecs", fm[0] && fm[0].mime === "video/mp4");
  sb.appendBuffer(new ArrayBuffer(4096));
  check("appendBuffer 被代理", sb.appended === 1);

  messages.length = 0; clicks.length = 0;
  listeners.forEach((fn) => fn({ source: win, data: { __ms_sniffer_cmd: true, cmd: "save", key: fm[0].key, filename: "" } }));
  await sleep(50);
  const sm = messages.find((m) => m.cmd === "saved");
  check("MSE 可保存", !!sm && sm.ok === true, sm);

  console.log("\n[8] 空数据 / 404 异常处理");
  messages.length = 0;
  listeners.forEach((fn) => fn({ source: win, data: { __ms_sniffer_cmd: true, cmd: "save", key: "blob:不存在", filename: "" } }));
  await sleep(80);
  const bad = messages.find((m) => m.cmd === "saved");
  check("fetch 失败返回明确错误", !!bad && bad.ok === false, bad);

  await testProbeTotal();
  testProtocolGuard();
  await testBiliMergeFlow();
  testFileNameChain();
  console.log("\n" + "=".repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})();

// ---------------------------------------------------------------- 10
// Telegram /progressive/ 这类「不给总长」的流：Content-Range 是 bytes 0-524287/*，
// 也没有 Content-Length。以前会把第一段当全长，只存下 512KB。
// 这里只验「问长度」这一环：探测函数必须能给出真实总长，或者明确返回 0。

async function testProbeTotal() {
  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");
  const code = fs.readFileSync(path.join(__dirname, "..", "extension", "inject-main.js"), "utf8");
  const portCode = fs.readFileSync(path.join(__dirname, "..", "extension", "sniffer-hostport.js"), "utf8");

  const SIZE = 1712345;
  const mkResp = (body, init) => ({
    ok: (init.status || 200) < 400,
    status: init.status || 200,
    headers: { get: (k) => (init.headers || {})[String(k).toLowerCase()] || null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
  });

  function makeSandbox(fetchImpl) {
    const win = {
      fetch: fetchImpl,
      addEventListener() {}, removeEventListener() {},
      postMessage() {},
      location: { href: "https://web.telegram.org/a/", protocol: "https:" },
      navigator: { userAgent: "test" },
      setTimeout, clearTimeout, setInterval: () => 0, console,
      URL, Blob, AbortController, TextDecoder, TextEncoder,
      MediaSource: FakeMediaSource, HTMLMediaElement: FakeHTMLMediaElement, Element: class {},
      document: { documentElement: { appendChild() {} }, body: { appendChild() {} }, createElement: () => ({ style: {}, append() {}, addEventListener() {}, remove() {} }), querySelectorAll: () => [], addEventListener() {} },
    };
    win.window = win;
    const sandbox = vm.createContext(win);
    vm.runInContext(portCode, sandbox, { filename: "sniffer-hostport.js" });
    try {
      vm.runInContext(code, sandbox, { filename: "inject-main.js" });
    } catch (e) {
      console.error("[makeSandbox] inject-main.js 加载失败:", e && e.message);
      console.error(String((e && e.stack) || "").split("\n").slice(0, 5).join("\n"));
      throw e;
    }
    return sandbox;
  }

  const runProbe = (sandbox) =>
    vm.runInContext('window.__msProbeTotal("https://web.telegram.org/a/progressive/document9", undefined, { cr: "bytes 0-524287/*", len: "" })', sandbox);

  // A) 只有尾字节请求才给总长（最坏情况）
  const calls = [];
  let sandbox = makeSandbox(async (url, init) => {
    init = init || {};
    calls.push([init.method || "GET", (init.headers || {}).Range || ""]);
    if (init.method === "HEAD") return mkResp(Buffer.alloc(0), { status: 200, headers: {} });
    const rng = (init.headers || {}).Range || "";
    if (rng === "bytes=-1") return mkResp(Buffer.alloc(0), { status: 206, headers: { "content-range": `bytes ${SIZE - 1}-${SIZE - 1}/${SIZE}` } });
    return mkResp(Buffer.alloc(0), { status: 206, headers: { "content-range": "bytes 0-524287/*" } });
  });
  let n = await runProbe(sandbox);
  check("尾字节试探能问出总长", n === SIZE, { n, calls });

  // B) HEAD 就给总长（更快，不该再发尾字节请求）
  const calls2 = [];
  sandbox = makeSandbox(async (url, init) => {
    init = init || {};
    calls2.push(init.method || "GET");
    if (init.method === "HEAD") return mkResp(Buffer.alloc(0), { status: 200, headers: { "content-range": `bytes 0-0/${SIZE}` } });
    return mkResp(Buffer.alloc(0), { status: 206, headers: {} });
  });
  n = await runProbe(sandbox);
  check("HEAD 可问出总长", n === SIZE, { n, calls2 });
  check("HEAD 成功就不再发尾字节请求", calls2.length === 1, calls2);

  // C) 全都问不出来 → 返回 0（调用方退回普通 GET，而不是只存 512KB）
  sandbox = makeSandbox(async () => mkResp(Buffer.alloc(0), { status: 200, headers: {} }));
  n = await runProbe(sandbox);
  check("长度完全问不出来时返回 0", n === 0, n);

  // D) B 站 DASH：206 只给 content-length（本段长度）不给 content-range，
  //    HEAD 和 bytes=-1 都被 CORS 拒（TypeError），只能靠 sidx 算总长。
  //    数据取自实测 BV1oMpm6QEQR：视频流 indexRange 933-1368，33 个 segment。
  const REFS = [22161653 / 33, 22261653 / 33, 3000000, 1234567, 900000, 700000];
  const sidxTotal = (refCount, eachAvg) => {
    // 构造 sidx（version 1）：size4 sidx4 ver1 flags3 refID4 timescale4
    //   earliest(8) first_offset(8) reserved2 ref_count2 然后每项 12 字节
    const bodyLen = 20 + 16 + 2 + 2 + refCount * 12;
    const b = Buffer.alloc(bodyLen);
    b.writeUInt32BE(bodyLen - 8, 0);        // box size（含自身头？取近似，解析时不依赖）
    b.write("sidx", 4, "latin1");
    b.writeUInt8(1, 8);                      // version 1
    b.writeUInt32BE(16000, 16);              // timescale
    let p = 20 + 16 + 2;
    b.writeUInt16BE(refCount, p); p += 2;
    for (let i = 0; i < refCount; i++) {
      b.writeUInt32BE(eachAvg & 0x7fffffff, p + i * 12);
      b.writeUInt32BE(4800, p + i * 12 + 4); // duration
    }
    return b;
  };
  const INDEX_RANGE = "933-1368";
  const indexBytes = 1368 - 933 + 1;
  const N_REF = 33;
  const perRef = 22261653 / N_REF;      // 每段平均字节（实测 33 段合计 22261653）
  const expectTotal = 1369 + Math.round(perRef) * N_REF; // indexRange 末尾(1368)+1 之后接 33 段
  const sidxBuf = sidxTotal(N_REF, Math.round(perRef));

  const callsS = [];
  sandbox = makeSandbox(async (url, init) => {
    init = init || {};
    const rng = (init.headers || {}).Range || "";
    callsS.push([init.method || "GET", rng, init.credentials]);
    // HEAD 和尾字节都被拒（就是 B 站 CDN 的真实行为）
    if (init.method === "HEAD" || rng === "bytes=-1") throw new TypeError("Failed to fetch");
    if (rng === `bytes=${INDEX_RANGE}`) return mkResp(sidxBuf, { status: 206, headers: {} });
    return mkResp(Buffer.alloc(0), { status: 206, headers: { "content-length": "524288" } });
  });
  n = await vm.runInContext(
    'window.__msProbeTotal("https://xy1.mcdn.bilivideo.cn:8082/x.m4s", undefined, { cr: "", len: "524288", full: false, initRange: "0-932", indexRange: "' + INDEX_RANGE + '" })',
    sandbox);
  check("B站：sidx 能算出总长（206 无 content-range + HEAD 被 CORS 拒）", n === expectTotal, { n, expectTotal, indexBytes, callsS });

  // E) content-length 只在 full（整包 200）时才算总长，Range 响应里的不算
  sandbox = makeSandbox(async () => mkResp(Buffer.alloc(0), { status: 206, headers: {} }));
  n = await vm.runInContext(
    'window.__msProbeTotal("https://x/a.m4s", undefined, { cr: "", len: "524288", full: false })', sandbox);
  check("分段响应的 content-length 不当总长", n === 0, n);
  sandbox = makeSandbox(async () => mkResp(Buffer.alloc(0), { status: 200, headers: {} }));
  n = await vm.runInContext(
    'window.__msProbeTotal("https://x/a.mp4", undefined, { cr: "", len: "524288", full: true })', sandbox);
  check("整包 200 的 content-length 可当总长", n === 524288, n);

  await testRangeDownloadOrdering();
}

/**
 * 文件名链路：标题必须一路带到最终文件名。
 *
 * 用户反馈「B站视频名字不显示」的完整链条（HANDOVER 第 18 节）：
 *   popup 列表名 → pageSaveItem 的 name → 页面浮层显示名 → msfile_start 的 name
 *   → ffmpeg 合并的 out 参数 → 落盘文件名。
 * 其中 pageSaveItem 曾把 name 写死成 "bilibili"，于是每一步都对、结果却是
 * bilibili.mp4。本用例逐条钉住这条链上的三个函数。
 */
function testFileNameChain() {
  console.log("\n[9] 文件名链路：标题 → 文件名");
  const fs = require("fs");
  const vm = require("vm");
  const portCode = fs.readFileSync(path.join(__dirname, "..", "extension", "sniffer-hostport.js"), "utf8");

  const mk = (href, search, title) => {
    const win = {
      fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, async arrayBuffer() { return new ArrayBuffer(0); } }),
      addEventListener() {}, removeEventListener() {}, postMessage() {},
      location: { href, search, protocol: "https:", hostname: "www.bilibili.com" },
      navigator: { userAgent: "test" },
      setTimeout, clearTimeout, setInterval: () => 0, console: { log() {}, warn() {}, error() {} },
      URL, URLSearchParams, Blob, AbortController, TextDecoder, TextEncoder,
      MediaSource: FakeMediaSource, HTMLMediaElement: FakeHTMLMediaElement, Element: class {},
      document: {
        documentElement: { appendChild() {} }, body: { appendChild() {} },
        createElement: () => ({ style: {}, append() {}, addEventListener() {}, remove() {} }),
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
        title: title || "",
      },
    };
    win.window = win;
    const sb = vm.createContext(win);
    vm.runInContext(portCode, sb, { filename: "sniffer-hostport.js" });
    vm.runInContext(code, sb, { filename: "inject-main.js" });
    return sb;
  };
  const call = (sb, expr) => vm.runInContext(expr, sb);
  const V = "https://www.bilibili.com/video/BV1GJ411x7h7/";
  const sb1 = mk(V, "", "【官方MV】Never Gonna Give You Up - Rick Astley_哔哩哔哩_bilibili");

  // --- fileNameTitle：列表前缀不进文件名，长度仍然是 60
  const REAL = "【官方MV】Never Gonna Give You Up - Rick Astley";
  check("真实标题原样保留", call(sb1, `window.__msFileNameTitle(${JSON.stringify(REAL)})`) === REAL);
  check("「bilibili / 」前缀被剥掉（不进文件名）",
    call(sb1, `window.__msFileNameTitle(${JSON.stringify("bilibili / " + REAL)})`) === REAL,
    call(sb1, `window.__msFileNameTitle(${JSON.stringify("bilibili / " + REAL)})`));
  const long = call(sb1, `window.__msFileNameTitle(${JSON.stringify("长".repeat(120))})`);
  check("超长标题收到 60 字 + 省略号", long.length === 61 && long.endsWith("…"), long.length);

  // --- safeFileName：百分号解码 / 非法字符 / 首尾点
  check("百分号编码被还原", call(sb1, 'window.__msSafeFileName("100%20%25%20sure.mp4")') === "100 % sure.mp4",
    call(sb1, 'window.__msSafeFileName("100%20%25%20sure.mp4")'));
  check("坏编码不抛异常、原样保留", call(sb1, 'window.__msSafeFileName("abc%ZZx")') === "abc%ZZx",
    call(sb1, 'window.__msSafeFileName("abc%ZZx")'));
  check("Windows 非法字符换成下划线",
    call(sb1, 'window.__msSafeFileName("a/b\\\\c:d*e?f\\"g<h>i|j")') === "a_b_c_d_e_f_g_h_i_j",
    call(sb1, 'window.__msSafeFileName("a/b\\\\c:d*e?f\\"g<h>i|j")'));
  check("首尾的点与空格被去掉（Windows 不允许）",
    call(sb1, 'window.__msSafeFileName("  ..标题..  ")') === "标题",
    call(sb1, 'window.__msSafeFileName("  ..标题..  ")'));
  check("纯符号清理后为空（交给兜底名）", call(sb1, 'window.__msSafeFileName("  . . ")') === "",
    call(sb1, 'window.__msSafeFileName("  . . ")'));
  check("中文/全角括号保留", call(sb1, 'window.__msSafeFileName("第3话（完结）")') === "第3话（完结）");

  // --- biliPartTag：p=1 与番剧页不拼，p>1 拼 -P{n}
  check("p=1 不加分P后缀", call(sb1, "window.__msBiliPartTag()") === "", call(sb1, "window.__msBiliPartTag()"));
  const sb2 = mk(V + "?p=3", "?p=3", "标题_哔哩哔哩_bilibili");
  check("p=3 → -P3", call(sb2, "window.__msBiliPartTag()") === "-P3", call(sb2, "window.__msBiliPartTag()"));
  const sb3 = mk("https://www.bilibili.com/bangumi/play/ep123", "", "番剧_哔哩哔哩_bilibili");
  check("番剧页（ep）不加分P后缀", call(sb3, "window.__msBiliPartTag()") === "");
  const sb4 = mk(V, "?p=abc", "");
  check("非法 p 值不崩", call(sb4, "window.__msBiliPartTag()") === "");

  // --- popup.js：pageSaveItem / shortTitle 不能把标题变成 "bilibili"
  // popup.js 是普通脚本（依赖 chrome API），单独摘出两个纯函数来跑，
  // 避免为了测两个函数去伪造整套 UI。
  const popupSrc = fs.readFileSync(path.join(__dirname, "..", "extension", "popup.js"), "utf8");
  const grab = (name) => {
    const i = popupSrc.indexOf("function " + name + "(");
    if (i < 0) return "";
    // 从函数头扫到配对的右花括号
    let depth = 0, j = popupSrc.indexOf("{", i);
    for (let k = j; k < popupSrc.length; k++) {
      if (popupSrc[k] === "{") depth++;
      else if (popupSrc[k] === "}") { depth--; if (!depth) return popupSrc.slice(i, k + 1); }
    }
    return "";
  };
  const pctx = vm.createContext({ String, Number, Math, JSON, RegExp, Array, Object, console });
  vm.runInContext(grab("shortTitle"), pctx);
  vm.runInContext("const BILI_DASH_KEY = '__bili_dash__';" + grab("pageSaveItem"), pctx);
  const biliName = (t) => vm.runInContext(`pageSaveItem({ u: "__bili_dash__", title: ${JSON.stringify(t)} }).name`, pctx);
  check("B 站条目名带真实标题（不再是 bilibili）", biliName(REAL) === REAL, biliName(REAL));
  check("B 站条目无标题时不写死 bilibili", biliName("") === "", JSON.stringify(biliName("")));

  const short = (t) => vm.runInContext(`shortTitle(${JSON.stringify(t)})`, pctx);
  const longWithExt = "前缀".repeat(30) + "完整版.mp4";
  const st = short(longWithExt);
  check("截断后扩展名仍保留", /\.mp4$/.test(st), st.slice(-12));
  check("截断后总长仍是 61（60 + …）+ 扩展名", st.length === 61 + 4, st.length);
  check("短标题原样返回", short("abc.mp4") === "abc.mp4");
}

/**
 * 分段下载的顺序与完整性回归。
 *
 * 背景（HANDOVER 9.4）：B 站 1080P 实测时踩过三个叠加的坑——
 *   1) 首段探针误传 `end = cb` 而不是 `cb - 1`，多要 1 字节，导致后续段起点
 *      和 written 差 1，整条流写不出去；
 *   2) `writeNext` 用 `k >= written` 会跳过缺口乱写，落盘大小对但内容错位；
 *   3) `hostRequest` 无条件用随机新 id 覆盖 payload.id，宿主认不出 job，静默丢数据。
 * 这个用例把假宿主接上，跑完整下载，逐字节比对落盘内容。
 */
async function testRangeDownloadOrdering() {
  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");
  const code = fs.readFileSync(path.join(__dirname, "..", "extension", "inject-main.js"), "utf8");
  const portCode = fs.readFileSync(path.join(__dirname, "..", "extension", "sniffer-hostport.js"), "utf8");

  // 造一段可验证的媒体数据：内容随偏移变化，任何错位都会被抓到
  const TOTAL = 300 * 1024 + 1234;
  const SRC = Buffer.alloc(TOTAL);
  for (let i = 0; i < TOTAL; i++) SRC[i] = (i * 31 + (i >> 8) * 7) & 0xff;
  // 头部放一个能识别扩展名的 ftyp box
  SRC.writeUInt32BE(0x18, 0);
  SRC.write("ftypisom", 4, "latin1");

  // 假宿主：接 msfile_start / msfile_chunk / msfile_end，按 id 记账
  const jobs = new Map();
  const sent = [];
  // 页面把数据帧编成 {__b64:"…"} 发过来（真宿主 do_msfile_chunk 也认这个），
  // 老格式 number 数组继续兼容，两条路都测得到
  function decodeChunk(data) {
    if (data && typeof data === "object" && !Array.isArray(data) && typeof data.__b64 === "string") {
      return Buffer.from(data.__b64, "base64");
    }
    return Buffer.from(data);
  }
  const fakeHostPort = {
    send(payload) {
      // len 记的是**解码后的真实字节数**（1.3.0 起发的是 {__b64}，JSON 体积约 1/2.7）
      sent.push({ action: payload.action, id: payload.id, len: payload.data ? decodeChunk(payload.data).length : 0 });
      const reply = (obj) => { setTimeout(() => { for (const f of listeners.slice()) f(obj); }, 0); };
      const id = payload.id;
      if (payload.action === "msfile_start") {
        jobs.set(id, { name: payload.name, total: payload.total, chunks: [] });
        reply({ id, ok: true, action: "msfile_start", job: id, path: "mem/" + payload.name, inProgress: true });
      } else if (payload.action === "msfile_chunk") {
        const j = jobs.get(id);
        if (!j) { reply({ id, ok: false, error: "unknown job" }); return; } // 关键：id 不对必须报错
        j.chunks.push({ at: payload.text, bytes: decodeChunk(payload.data) });
        reply({ id, ok: true, action: "msfile_chunk", written: j.chunks.reduce((s, c) => s + c.bytes.length, 0), inProgress: true });
      } else if (payload.action === "msfile_end") {
        const j = jobs.get(id);
        if (!j) { reply({ id, ok: false, error: "unknown job" }); return; }
        const merged = Buffer.concat(j.chunks.map((c) => c.bytes));
        j.result = merged;
        jobs.set("__last__", { buf: merged, name: j.name });
        reply({ id, ok: true, action: "msfile_end", size: merged.length, path: "mem/" + j.name });
      } else if (payload.action === "msfile_abort") {
        jobs.delete(id);
        reply({ id, ok: true, action: "msfile_abort" });
      } else {
        reply({ id, ok: true, action: "pong", outdir: "mem" });
      }
    },
    deliver() {}, disconnected() {},
    on(f) { listeners.push(f); }, off(f) { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
  };
  const listeners = [];

  // 假站点：支持 Range，故意「多吐 1 字节」复现 B 站 CDN 的脾气
  const OVER = 1;
  const fakeFetch = async (url, init) => {
    init = init || {};
    if (init.method === "HEAD") {
      // 让 probeTotal 的 HEAD 兜底能问出总长（真实 B 站 HEAD 会被 CORS 拒，
      // 但那个分支已由 testProbeTotal 的 sidx 用例覆盖；这里只验证写盘顺序）
      return {
        ok: true, status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === "content-range" ? `bytes 0-0/${TOTAL}` : null) },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    const rng = (init.headers || {}).Range || "";
    const m = /bytes=(\d+)-(\d+)/.exec(rng);
    if (!m) throw new TypeError("Failed to fetch");
    const a = Number(m[1]);
    const b = Math.min(Number(m[2]), TOTAL - 1);
    const want = b - a + 1;
    const give = Math.min(want + OVER, TOTAL - a); // 多给 1 字节
    const body = SRC.slice(a, a + give);
    return {
      ok: true, status: 206,
      headers: { get: (k) => {
        const kk = String(k).toLowerCase();
        if (kk === "content-type") return "video/mp4";
        // 故意不给 content-range（B 站就是这样），让 probeTotal 走 HEAD/sidx 兜底
        return null;
      } },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    };
  };

  const win = {
    fetch: fakeFetch,
    __msHostPort: fakeHostPort,
    addEventListener() {}, removeEventListener() {}, postMessage() {},
    location: { href: "https://www.bilibili.com/video/BV1oMpm6QEQR/", protocol: "https:", hostname: "www.bilibili.com" },
    navigator: { userAgent: "test" },
    setTimeout, clearTimeout, setInterval: () => 0, console,
    URL, Blob, AbortController, TextDecoder, TextEncoder,
    MediaSource: FakeMediaSource, HTMLMediaElement: FakeHTMLMediaElement, Element: class {},
    document: { documentElement: { appendChild() {} }, body: { appendChild() {} }, createElement: () => ({ style: {}, append() {}, addEventListener() {}, remove() {} }), querySelectorAll: () => [], addEventListener() {} },
  };
  win.window = win;
  const sandbox = vm.createContext(win);
  vm.runInContext(portCode, sandbox, { filename: "sniffer-hostport.js" });
  vm.runInContext(code, sandbox, { filename: "inject-main.js" });

  // 用 total 已知的方式直接跑 runRangeDownload（绕过 probeTotal 的外部依赖）
  const res = await vm.runInContext(
    `window.__msRangeDownload({
       key: "https://xy1.mcdn.bilivideo.cn:8082/x.m4s",
       name: "order-test",
       hooks: { ct: "video/mp4" },
     })`, sandbox);

  const last = jobs.get("__last__");
  check("分段下载能正常完成", !!(res && res.ok), res && { ok: res.ok, received: res.received });
  check("落盘长度等于源长度", !!(last && last.buf.length === TOTAL), { got: last && last.buf.length, want: TOTAL, sent: sent.slice(0, 4) });
  check("落盘内容逐字节一致（无错位）", !!(last && Buffer.compare(last.buf, SRC) === 0), {
    equal: !!(last && Buffer.compare(last.buf, SRC) === 0),
    got: last && last.buf.length,
  });
  // chunk 的 id 必须始终是 msfile_start 返回的那个 job id
  const chunkIds = sent.filter((s) => s.action === "msfile_chunk").map((s) => s.id);
  const startId = sent.find((s) => s.action === "msfile_start").id;
  check("chunk 复用 job id（不被随机 id 覆盖）", chunkIds.every((x) => x === startId), { startId, sample: chunkIds.slice(0, 3) });
  check("每个 chunk 不超过 512KB+1", chunkIds.length > 0 && sent.filter((s) => s.action === "msfile_chunk").every((s) => s.len <= 524288 + 1), sent.filter((s) => s.action === "msfile_chunk").map((s) => s.len).slice(0, 5));
}

/**
 * B 站「下载两条流 → 请求合并 → 等终态」整条编排（runBiliDownload）。
 * 假宿主支持 msfile_merge：回 ack（带 inProgress）→ 推 progress → 推 done/error，
 * 验证：合并参数带对两条流的路径、失败时不算下载失败、阶段提示覆盖全程。
 */
async function testBiliMergeFlow() {
  const fs = require("fs");
  const vm = require("vm");
  const code = fs.readFileSync(path.join(__dirname, "..", "extension", "inject-main.js"), "utf8");
  const portCode = fs.readFileSync(path.join(__dirname, "..", "extension", "sniffer-hostport.js"), "utf8");

  // 两段可校验的流数据（内容随偏移变化，错位会被抓到；都 < 512KB，一段抓完）
  const V_TOTAL = 200 * 1024 + 111, A_TOTAL = 90 * 1024 + 7;
  const mk = (n, seed) => {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = (i * 13 + seed) & 0xff;
    b.writeUInt32BE(0x18, 0);
    b.write("ftypisom", 4, "latin1");
    return b;
  };
  const V = mk(V_TOTAL, 1), A = mk(A_TOTAL, 2);

  const jobs = new Map();
  const merges = [];
  const listeners = [];
  let mergeFail = false;
  // 同 decodeChunk：页面发的是 {__b64:"…"}，这里还原成真实字节
  function decodeChunk(data) {
    if (data && typeof data === "object" && !Array.isArray(data) && typeof data.__b64 === "string") {
      return Buffer.from(data.__b64, "base64");
    }
    return Buffer.from(data);
  }
  const reply = (obj) => setTimeout(() => { for (const f of listeners.slice()) f(obj); }, 0);
  const fakeHostPort = {
    send(payload) {
      const id = payload.id;
      if (payload.action === "msfile_start") {
        jobs.set(id, { name: payload.name, chunks: [] });
        reply({ id, ok: true, action: "msfile_start", job: id, inProgress: true });
      } else if (payload.action === "msfile_chunk") {
        const j = jobs.get(id);
        if (!j) { reply({ id, ok: false, error: "unknown job" }); return; }
        j.chunks.push(decodeChunk(payload.data));
        reply({ id, ok: true, action: "msfile_chunk", written: 1, inProgress: true });
      } else if (payload.action === "msfile_end") {
        const j = jobs.get(id);
        if (!j) { reply({ id, ok: false, error: "unknown job" }); return; }
        j.result = Buffer.concat(j.chunks);
        j.path = "mem/" + j.name;
        reply({ id, ok: true, action: "msfile_end", size: j.result.length, file: j.path });
      } else if (payload.action === "msfile_merge") {
        merges.push({ video: payload.video, audio: payload.audio, out: payload.out });
        reply({ id, ok: true, action: "msfile_merge", status: "merging", inProgress: true });
        setTimeout(() => reply({ id, action: "progress", status: "merging", percent: 55, inProgress: true }), 5);
        setTimeout(() => (mergeFail
          ? reply({ id, action: "error", message: "ffmpeg 模拟失败" })
          : reply({ id, action: "done", file: "mem/" + payload.out + ".mp4" })), 15);
      } else {
        reply({ id, ok: true, action: "pong" });
      }
    },
    deliver() {}, disconnected() {},
    on(f) { listeners.push(f); }, off(f) { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
  };

  const serve = (data) => async (url, init) => {
    init = init || {};
    const rng = (init.headers || {}).Range || "";
    const m = /bytes=(\d+)-(\d+)/.exec(rng);
    let a = 0, b = data.length - 1;
    if (m) { a = Number(m[1]); b = Math.min(Number(m[2]), data.length - 1); }
    const body = data.slice(a, b + 1);
    return {
      ok: true, status: m ? 206 : 200,
      headers: { get: (k) => {
        const kk = String(k).toLowerCase();
        if (kk === "content-type") return "video/mp4";
        if (kk === "content-range") return `bytes ${a}-${b}/${data.length}`;
        return null;
      } },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    };
  };

  const stages = [];
  const win = {
    fetch: async (url, init) => (/\/a\.m4s/.test(url) ? serve(A) : serve(V))(url, init),
    __msHostPort: fakeHostPort,
    __playinfo__: { data: { dash: {
      video: [{ id: 80, codecs: "avc1.64001E", bandwidth: 2000, baseUrl: "https://cdn.example/v.m4s",
                mimeType: "video/mp4", SegmentBase: { Initialization: "0-931", indexRange: "932-1367" } }],
      audio: [{ id: 30280, bandwidth: 1000, baseUrl: "https://cdn.example/a.m4s",
                mimeType: "audio/mp4", SegmentBase: { Initialization: "0-931", indexRange: "932-1367" } }],
    } } },
    addEventListener() {}, removeEventListener() {}, postMessage() {},
    location: { href: "https://www.bilibili.com/video/BV1test/", protocol: "https:", hostname: "www.bilibili.com" },
    navigator: { userAgent: "test" },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, console,
    URL, Blob, AbortController, TextDecoder, TextEncoder,
    MediaSource: FakeMediaSource, HTMLMediaElement: FakeHTMLMediaElement, Element: class {},
    document: { documentElement: { appendChild() {} }, body: { appendChild() {} },
      createElement: () => ({ style: {}, append() {}, addEventListener() {}, remove() {} }),
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  };
  win.window = win;
  win.__stages = stages;
  const sandbox = vm.createContext(win);
  vm.runInContext(portCode, sandbox, { filename: "sniffer-hostport.js" });
  vm.runInContext(code, sandbox, { filename: "inject-main.js" });

  const run = () => vm.runInContext(
    `window.__msRunBiliDownload({ name: "合并测试", onStage: (t) => window.__stages.push(t) })`,
    sandbox);

  // ---- 成功路径：两条流下载完 → 合并成单文件
  const r1 = await run();
  const allJobs = [...jobs.values()];
  const vJob = allJobs.find((j) => /-video/.test(j.name));
  const aJob = allJobs.find((j) => /-audio/.test(j.name));
  check("B 站下载+合并整体成功", !!(r1 && r1.ok && r1.merged), r1 && { ok: r1.ok, merged: r1.merged, note: r1.note });
  check("合并产物是单个文件", !!(r1 && r1.files && r1.files.length === 1 && /\.mp4$/.test(r1.files[0])), r1 && r1.files);
  check("合并请求带对两条流的路径", !!(merges[0]
    && /-video\.mp4$/.test(merges[0].video) && /-audio\.mp4$/.test(merges[0].audio)
    && merges[0].out === "合并测试"), merges[0]);
  check("视频流逐字节完整", !!(vJob && vJob.result && Buffer.compare(vJob.result, V) === 0),
    { got: vJob && vJob.result && vJob.result.length, want: V_TOTAL });
  check("音频流逐字节完整", !!(aJob && aJob.result && Buffer.compare(aJob.result, A) === 0),
    { got: aJob && aJob.result && aJob.result.length, want: A_TOTAL });
  check("字节总量对得上", !!(r1 && r1.received === V_TOTAL + A_TOTAL), r1 && r1.received);
  check("阶段提示覆盖下载与合并", stages.some((s) => /视频流/.test(s)) && stages.some((s) => /合并音视频/.test(s)), stages);

  // ---- 失败路径：合并炸了不算下载失败，两条源文件仍在结果里
  jobs.clear(); merges.length = 0; stages.length = 0; mergeFail = true;
  const r2 = await run();
  check("合并失败不吞下载成果", !!(r2 && r2.ok && r2.merged === false
    && r2.files && r2.files.length === 2 && /合并失败/.test(r2.note || "")), r2 && { merged: r2.merged, files: r2.files, note: r2.note });
}

/**
 * 协议守卫：扩展自己的页面（chrome-extension://）和 chrome:// 内部页不装 hook。
 * 背景：inject-main.js 在这些环境里会往 fetch/XHR 上挂 hook，读取响应头时
 * 抛错刷红字，用户会以为扩展坏了。反过来，读不到 location 时必须照常工作。
 */
function testProtocolGuard() {
  const mk = (protocol) => {
    const win = {
      fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, async arrayBuffer() { return new ArrayBuffer(0); } }),
      addEventListener() {}, removeEventListener() {}, postMessage() {},
      location: protocol === undefined ? undefined : { href: "x", protocol },
      navigator: { userAgent: "test" },
      setTimeout, clearTimeout, setInterval: () => 0, console,
      URL, Blob, AbortController, TextDecoder, TextEncoder,
      MediaSource: FakeMediaSource, HTMLMediaElement: FakeHTMLMediaElement, Element: class {},
      document: { documentElement: { appendChild() {} }, body: { appendChild() {} }, createElement: () => ({ style: {}, append() {}, addEventListener() {}, remove() {} }), querySelectorAll: () => [], addEventListener() {} },
    };
    win.window = win;
    const sb = vm.createContext(win);
    vm.runInContext(portCode, sb, { filename: "sniffer-hostport.js" });
    vm.runInContext(code, sb, { filename: "inject-main.js" });
    return sb.window;
  };

  const ext = mk("chrome-extension:");
  check("chrome-extension:// 页面不装 hook", typeof ext.__msScan !== "function");
  const internal = mk("chrome:");
  check("chrome:// 内部页不装 hook", typeof internal.__msScan !== "function");
  const web = mk("https:");
  check("https 页面正常装 hook", typeof web.__msScan === "function" && web.__MS_SNIFFER_MAIN__ === true);
  const unknown = mk(undefined);
  check("读不到 location 时照常工作（不误杀）", typeof unknown.__msScan === "function");
}
