/**
 * 页面内「保存」进度卡（图二）的显示规则
 * 运行：node test/ui_card.test.js
 *
 * 真机反馈（图二）：卡片里同一句「正在下载视频流（完整流，与播放进度无关）…」
 * 出现两次，下面挂着一条 0% 不动的灰槽，再下面一个「取消」。三件事都是显示层
 * 没做对，而不是下载本身有问题：
 *   1. uiStage 既写阶段行又写进度行 → 同一句话被说了两遍
 *   2. 不知道总长时把 bar 设成 0% 就不管了 → 一停几十秒，看着像卡死
 *   3. 文案把实现细节（「与播放进度无关」）当成人话讲
 *
 * 这里只测「卡片怎么显示」，不碰下载逻辑（下载由 range_parallel /
 * host_* 那几套管）。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const code = fs.readFileSync(path.join(__dirname, "..", "extension", "inject-main.js"), "utf8");
const portCode = fs.readFileSync(path.join(__dirname, "..", "extension", "sniffer-hostport.js"), "utf8");

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra === undefined ? "" : "→ " + JSON.stringify(extra)); }
}

// ---------------------------------------------------------------- 假 DOM

/** 真实元素才有 cssText 解析：否则 card.bar.style.width 永远是 undefined */
function makeStyle() {
  const s = {};
  Object.defineProperty(s, "cssText", {
    enumerable: false,
    get() {
      return Object.keys(s).map((k) => k + ":" + s[k]).join(";");
    },
    set(v) {
      String(v).split(";").forEach((part) => {
        const i = part.indexOf(":");
        if (i <= 0) return;
        s[part.slice(0, i).trim()] = part.slice(i + 1).trim();
      });
    },
  });
  return s;
}

const animations = [];
const attached = [];

function makeEl(tag) {
  const el = {
    tag,
    id: "",
    className: "",
    textContent: "",
    title: "",
    disabled: false,
    onclick: null,
    children: [],
    style: makeStyle(),
    _attached: false,
    append(...kids) { kids.forEach((k) => this.appendChild(k)); },
    appendChild(k) { if (k) { k.parentElement = this; this.children.push(k); k._attached = true; } return k; },
    remove() { this._attached = false; },
    contains(n) {
      if (!n) return false;
      if (n === this) return true;
      const stack = [...this.children];
      while (stack.length) {
        const x = stack.pop();
        if (x === n) return true;
        if (x && x.children) stack.push(...x.children);
      }
      return false;
    },
    addEventListener() {},
    // Web Animations API：不确定进度靠它跑光带，测试要看「有没有动画 / 有没有被取消」
    animate(keyframes, options) {
      const a = {
        keyframes, options, cancelled: false,
        target: el,
        cancel() { this.cancelled = true; },
      };
      animations.push(a);
      return a;
    },
  };
  return el;
}

const fakeDocument = {
  documentElement: { appendChild(n) { n._attached = true; }, contains: (n) => !!(n && n._attached) },
  body: { appendChild(n) { n._attached = true; attached.push(n); } },
  createElement(tag) { return makeEl(tag); },
  createTextNode() { return {}; },
  getElementById() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
};

// ---------------------------------------------------------------- 假时钟 / 定时器

let NOW = 1700000000000;
class FakeDate extends Date {
  constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
  static now() { return NOW; }
}

const intervals = [];
function fireIntervals(ms) {
  intervals.filter((t) => !t.cleared && (ms === undefined || t.ms === ms)).forEach((t) => {
    try { t.fn(); } catch (e) { console.log("    (定时器抛错)", e.message); }
  });
}

// ---------------------------------------------------------------- 沙箱

const win = {
  postMessage() {},
  addEventListener() {},
  document: fakeDocument,
  location: { href: "https://www.bilibili.com/video/BV1xx411c7mD", protocol: "https:", hostname: "www.bilibili.com" },
};

const sandbox = {
  window: win,
  URL,
  Blob, ArrayBuffer, Uint8Array, Date: FakeDate, Math, JSON, console,
  setTimeout: (fn) => { try { fn(); } catch (e) { /* 忽略 */ } return 0; },
  clearTimeout() {},
  setInterval: (fn, ms) => { const id = intervals.length + 1; intervals.push({ id, fn, ms, cleared: false }); return id; },
  clearInterval: (id) => { const t = intervals.find((x) => x.id === id); if (t) t.cleared = true; },
  document: fakeDocument,
  Element: class {},
  AbortController,
  fetch: async () => ({ ok: false, status: 404 }),
  location: win.location,
  history: { pushState() {}, replaceState() {} },
  navigator: { userAgent: "Mozilla/5.0 Chrome/156" },
};
sandbox.window.MediaSource = class { addSourceBuffer() { return {}; } };
sandbox.window.URL = URL;
sandbox.window.document = fakeDocument;
sandbox.window.location = win.location;
sandbox.MediaSource = sandbox.window.MediaSource;
sandbox.HTMLMediaElement = class {};
sandbox.MutationObserver = class { observe() {} disconnect() {} };

vm.createContext(sandbox);
try {
  vm.runInContext(portCode, sandbox, { filename: "sniffer-hostport.js" });
  vm.runInContext(code, sandbox, { filename: "inject-main.js" });
} catch (e) {
  console.log("  ✗ inject-main.js 加载失败：" + e.message);
  process.exit(1);
}

const UIAPI = win.__msUiApi || null;
const card = () => (win.__msUiCard ? win.__msUiCard() : null);

console.log("\n[A] 卡片结构（一次只该有一个卡片）");
check("A1 暴露了 __msUiApi", !!UIAPI);

if (!UIAPI) {
  console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
  process.exit(1);
}

UIAPI.show("测试视频标题");
const C = card();
check("A2 卡片挂在 body 上", !!C && !!C.root && C.root._attached === true);
check("A3 有独立的阶段行和进度行", !!C.stage && !!C.text && C.stage !== C.text);
check("A4 有进度条", !!C.bar);
check("A5 标题说明这是「资源嗅探 · 保存」", /资源嗅探/.test(C.root.children[0].textContent), C.root.children[0].textContent);

console.log("\n[B] 阶段行与进度行不能同时写同一句话（图二的第一处毛病）");
UIAPI.stage("正在下载完整视频流", 0);
check("B1 阶段行显示了阶段名", C.stage.textContent === "正在下载完整视频流", C.stage.textContent);
check("B2 阶段行可见", C.stage.style.display === "block", C.stage.style.display);
check("B3 进度行不得重复阶段名", C.text.textContent !== C.stage.textContent, C.text.textContent);
check("B4 进度行此刻为空（还没有字节可报）", C.text.textContent === "", C.text.textContent);

console.log("\n[C] 不知道总长时，进度条要会走，不能挂在 0%");
check("C1 进度条不再停在 0%", C.bar.style.width !== "0%", C.bar.style.width);
check("C2 起了一个无限循环的动画", animations.length >= 1 && animations[animations.length - 1].options
  && animations[animations.length - 1].options.iterations === Infinity,
  animations.length ? animations[animations.length - 1].options : null);
// 真机翻过这个：animations 有、width 也对，但 fill 被清成了透明，
// 光带扫过去屏幕上什么都没有——自动化全绿、肉眼一条灰槽。
check("C3 进度条有填充色（透明度会让光带白跑）", /gradient|rgb|#/.test(String(C.bar.style.background || "")),
  C.bar.style.background);

console.log("\n[D] 拿到真实百分比后要切回确定进度，动画得停");
UIAPI.progress(512 * 1024, 1024 * 1024, 200 * 1024, "测试视频标题");
const pctNow = parseFloat(C.bar.style.width);
check("D1 进度条显示 50%", Math.abs(pctNow - 50) < 0.5, C.bar.style.width);
check("D2 进度行显示百分比与体积", /50\.0%/.test(C.text.textContent) && /\/ 1\.0 MB/.test(C.text.textContent), C.text.textContent);
check("D3 光带动画已取消", animations[animations.length - 1].cancelled === true,
  animations.map((a) => a.cancelled));
check("D4 取消后没有残留的 marginLeft", !C.bar.style.marginLeft, C.bar.style.marginLeft);

console.log("\n[E] 没有字节可报时，要告诉用户已经等了多久");
intervals.length = 0;
attached.length = 0;
animations.length = 0;
UIAPI.show("大文件");
NOW += 0;
check("E1 uiShow 之后进度行是空的", C.text.textContent === "", C.text.textContent);
NOW += 4200;
fireIntervals(500);
check("E2 4 秒后进度行出现「已等」", /已等\s*4\s*秒/.test(C.text.textContent), C.text.textContent);
NOW += 6000;
fireIntervals(500);
check("E3 超过 8 秒补一句「仍在连接」", /仍在连接/.test(C.text.textContent), C.text.textContent);
check("E4 提示里要告诉用户能点取消", /可点取消|点取消/.test(C.text.textContent), C.text.textContent);

console.log("\n[F] 换阶段不能把上一阶段的文案留在进度行");
UIAPI.stage("正在下载音频流", 0);
check("F1 阶段行换成音频", C.stage.textContent === "正在下载音频流", C.stage.textContent);
check("F2 进度行没有被写成阶段名", C.text.textContent !== "正在下载音频流", C.text.textContent);

console.log("\n[G] 合并阶段有真实百分比，也要走确定进度");
UIAPI.stage("合并音视频 47%", 47);
check("G1 进度条到 47%", Math.abs(parseFloat(C.bar.style.width) - 47) < 0.5, C.bar.style.width);
check("G2 动画停了", !animations.filter((a) => !a.cancelled).length, animations.map((a) => a.cancelled));

console.log("\n[H] 结束态");
UIAPI.done(true, "测试视频.mp4（12.3 MB，8s，1.5 MB/s）", "D:\\out\\测试视频.mp4");
check("H1 进度行写明完成", /^完成/.test(C.text.textContent), C.text.textContent);
check("H2 进度条满格", C.bar.style.width === "100%", C.bar.style.width);
check("H3 阶段行收起", C.stage.style.display === "none", C.stage.style.display);
check("H4 出现「打开所在文件夹」按钮", C.revealBtn && C.revealBtn.style.display === "inline-block", C.revealBtn && C.revealBtn.style.display);
check("H5 计时器已停", !intervals.filter((t) => !t.cleared && t.ms === 500).length, intervals.map((t) => [t.ms, t.cleared]));

console.log("\n[I] 失败态也要收干净");
attached.length = 0;
animations.length = 0;
intervals.length = 0;
UIAPI.show("失败测试");
UIAPI.stage("正在读取媒体信息", 0);
UIAPI.done(false, "服务器没有响应");
check("I1 进度行写明失败", /^失败/.test(C.text.textContent), C.text.textContent);
check("I2 光带动画已取消", !animations.filter((a) => !a.cancelled).length, animations.map((a) => a.cancelled));
check("I3 阶段行收起", C.stage.style.display === "none", C.stage.style.display);

console.log("\n[J] 卡片被强行关掉后重开，光带要重新起来");
UIAPI.show("第一次");
UIAPI.stage("正在下载完整视频流", 0);
const oldRoot = card().root;
// 模拟用户点「关闭」把卡片摘掉（DOM 里已经没有了）
oldRoot.remove();
animations.length = 0;
UIAPI.show("第二次");
const root2 = card().root;
check("J1 卡片重新建了一个", root2 !== oldRoot && root2._attached === true, root2 === oldRoot);
check("J2 进度条不是 0%", root2 && card().bar.style.width !== "0%", card().bar.style.width);
check("J3 光带重新起来了", animations.filter((a) => !a.cancelled).length >= 1,
  animations.map((a) => a.cancelled));

console.log("\n[J2] 失败的红条不能带到下一次任务里");
UIAPI.done(false, "服务器没有响应");
check("J4 失败时进度条转红", /ef4444|red/i.test(String(card().bar.style.background || "")), card().bar.style.background);
UIAPI.show("第三次");
check("J5 重新开始时颜色复原成正常渐变", /gradient/i.test(String(card().bar.style.background || "")) && !/ef4444/i.test(String(card().bar.style.background || "")),
  card().bar.style.background);

console.log("\n[K] 文案不许对用户讲实现细节");
// 只看会真的显示到屏幕上的字符串字面量：整行注释里提到这个词是正常的（那是
// 给后来改代码的人看的背景说明，用户在卡片上永远看不到）。
const displaySrc = code
  .replace(/\r\n/g, "\n")
  .replace(/^\s*\/\/.*$/gm, "");
check("K1 界面上不再出现「与播放进度无关」", !/与播放进度无关/.test(displaySrc),
  (displaySrc.match(/^.*与播放进度无关.*$/gm) || []).map((s) => s.trim()));
check("K2 阶段文案里不出现括号解释", !/视频流（完整流/.test(displaySrc),
  (displaySrc.match(/^.*视频流（完整流.*$/gm) || []).map((s) => s.trim()));

console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
process.exit(fail ? 1 : 0);
