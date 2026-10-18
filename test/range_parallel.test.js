/**
 * Range 下载并发上限测试。
 *
 * 背景（真机实测，telegram.org 的 Service Worker，同一文件不同分片）：
 *   4 并发  → 891ms
 *   8 并发  → 4620ms   ← 5 倍慢
 *   16 并发 → 8404ms   ← 纯排队
 * SW 是串行回源的，并发越多每个请求等越久。这里验证 PARALLEL 常量确实生效，
 * 防止以后有人「优化」成高并发又把 Telegram 的下大文件拖回卡死状态。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name, extra !== undefined ? JSON.stringify(extra) : ""); }
}

const code = fs.readFileSync(path.join(__dirname, "..", "extension", "inject-main.js"), "utf8");
const portCode = fs.readFileSync(path.join(__dirname, "..", "extension", "sniffer-hostport.js"), "utf8");

const EXPECTED_PARALLEL = 4;
const SEG = 512 * 1024;
const TOTAL = SEG * 4; // 正好 4 段

const SRC = (function () {
  const b = Buffer.alloc(TOTAL);
  for (let i = 0; i < TOTAL; i++) b[i] = (i * 7 + 11) & 0xff;
  return b;
})();

// inject-main.js 顶层会读 HTMLMediaElement.prototype.src 的 setter，必须有桩
class FakeHTMLMediaElement {}
Object.defineProperty(FakeHTMLMediaElement.prototype, "src", {
  configurable: true,
  get() { return this._src || ""; },
  set(v) { this._src = v; },
});
Object.defineProperty(FakeHTMLMediaElement.prototype, "currentSrc", {
  configurable: true, get() { return this._src || ""; },
});
class FakeMediaSource {}
FakeMediaSource.prototype.addSourceBuffer = function () {
  return { appendBuffer() {}, addEventListener() {}, removeEventListener() {}, updating: false };
};

function buildFakeFetch(state) {
  return async (url, init) => {
    init = init || {};
    if (init.method === "HEAD") {
      return {
        ok: true, status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === "content-range" ? `bytes 0-0/${TOTAL}` : null) },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    const m = /bytes=(\d+)-(\d+)/.exec((init.headers || {}).Range || "");
    if (!m) throw new TypeError("Failed to fetch");
    const a = Number(m[1]);
    const b = Math.min(Number(m[2]), TOTAL - 1);
    const body = SRC.slice(a, b + 1);

    state.inflight++;
    state.maxInflight = Math.max(state.maxInflight, state.inflight);
    state.ranges.push([a, b]);
    // 给个延迟，让并发窗口有机会重叠（同步完成看不出并发数）
    await new Promise((r) => setTimeout(r, 5));
    state.inflight--;

    return {
      ok: true, status: 206,
      headers: { get: (k) => {
        const kk = String(k).toLowerCase();
        if (kk === "content-type") return "video/mp4";
        if (kk === "content-range") return `bytes ${a}-${b}/${TOTAL}`;
        return null;
      } },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    };
  };
}

async function run() {
  const state = { inflight: 0, maxInflight: 0, ranges: [] };
  const jobs = new Map();
  let jobSeq = 0;
  let portRef = null;
  let msgHandler = null;

  // 宿主回包：模拟 content.js 把回包 postMessage 给页面。inject-main.js 第 1508 行
  // 监听 message 事件，要求 e.source === window，且数据带 __ms_sniffer_host 标记、
  // cmd === "host-message"，才会调 HOSTPORT.deliver(d.payload)。
  const reply = (m) => {
    if (!msgHandler) return;
    try {
      // 关键：事件对象必须在沙箱内构造。跨 realm 的普通对象虽然字段可读，
      // 但监听器里 `msg.id !== id` 这类判等会因内建对象来自不同 realm 而失配，
      // 表现是「宿主回包到了但请求永远不 resolve」。
      const ev = vm.runInContext(
        `(function(payload){ return { source: window, data: { __ms_sniffer_host: true, cmd: "host-message", payload: payload } }; })`,
        sandbox);
      msgHandler(ev(m));
    } catch (e) { /* 忽略 */ }
  };

  const win = {
    fetch: buildFakeFetch(state),
    addEventListener(type, fn) { if (type === "message") msgHandler = fn; },
    removeEventListener(type, fn) { if (type === "message" && msgHandler === fn) msgHandler = null; },
    location: { href: "https://web.telegram.org/a/", protocol: "https:", hostname: "web.telegram.org" },
    navigator: { userAgent: "test" },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    URL, Blob, AbortController, TextDecoder, TextEncoder,
    console,
    MediaSource: FakeMediaSource,
    HTMLMediaElement: FakeHTMLMediaElement,
    Element: class {},
    document: {
      documentElement: { appendChild() {} }, body: { appendChild() {} },
      createElement: () => ({ style: {}, append() {}, addEventListener() {}, remove() {} }),
      querySelectorAll: () => [], addEventListener() {},
    },
  };

  // sniffer-hostport.js 把 send 转成 window.postMessage({cmd:"host-send",payload})，
  // 这里接管 postMessage 模拟 content.js + 宿主的往返。
  // 宿主回包走反方向：inject-main.js:1512 监听 message 事件，读到 cmd==="host-message"
  // 时调 HOSTPORT.deliver(payload)，所以回包要派发成 message 事件。
  win.postMessage = (env) => {
    
    if (!env || env.__ms_sniffer_cmd !== true) return;
    if (env.cmd !== "host-send") return; // "saved" 等只是通知
    const payload = env.payload || {};
    const id = payload.id;
    setImmediate(() => {
      const send = (m) => reply(m);
      switch (payload.action) {
        case "msfile_start": {
          // 真宿主 sniffer_host.py:135 用 job_id = msg.get("id")，即沿用请求 id；
          // 假宿主必须一致，否则页面等的是请求 id、收到的是新 id，永远对不上。
          const jid = id;
          jobs.set(jid, { name: payload.name, wrote: 0 });
          return send({ id, ok: true, action: "msfile_start", id: jid, path: "mem/" + payload.name });
        }
        case "msfile_chunk": {
          const j = jobs.get(id);
          if (!j) return send({ id, ok: true, action: "msfile_chunk" });
          const mm = /bytes=(\d+)/.exec(payload.text || "");
          const st = mm ? Number(mm[1]) : j.wrote;
          // 数据帧是 {__b64:"…"}（1.3.0 起），按**解码后的字节数**记账，
          // 不能拿 payload.data.length —— 那是 base64 字符串长度，会算错 4/3 倍。
          const d = payload.data;
          let n = 0;
          if (d && typeof d === "object" && typeof d.__b64 === "string") n = Buffer.from(d.__b64, "base64").length;
          else if (d && typeof d.length === "number") n = d.length;
          j.wrote = Math.max(j.wrote, st + n);
          jobs.set("__last__", j);
          return send({ id, ok: true, action: "msfile_chunk", written: j.wrote });
        }
        case "msfile_end": {
          const j = jobs.get(id);
          jobs.delete(id);
          return send({ id, ok: true, action: "msfile_end", size: j ? j.wrote : 0, path: "mem/" + (j ? j.name : "?") });
        }
        case "msfile_abort":
          jobs.delete(id);
          return send({ id, ok: true, action: "msfile_abort" });
        default:
          return send({ id, ok: true, action: "pong", outdir: "mem" });
      }
    });
  };
  win.self = win;
  win.window = win;

  const sandbox = vm.createContext(win);
  vm.runInContext(portCode, sandbox, { filename: "sniffer-hostport.js" });
  portRef = win.__msHostPort;
  vm.runInContext(code, sandbox, { filename: "inject-main.js" });

  const m = /\bconst PARALLEL = (\d+)/.exec(code);
  check("源码里能读到 PARALLEL 常量", !!m, m ? m[1] : null);
  const PARALLEL = m ? Number(m[1]) : -1;
  check(`PARALLEL 是 ${EXPECTED_PARALLEL}（Telegram 实测最优并发）`, PARALLEL === EXPECTED_PARALLEL, { got: PARALLEL });

  // ---- 放大档：只在直连 CDN 上生效，Telegram 的 SW 流绝不能被放大 ----
  const bm = /\bconst BIG_CHUNK = ([0-9\s*]+)/.exec(code);
  const bp = /\bconst BIG_PARALLEL = (\d+)/.exec(code);
  check("源码里能读到 BIG_CHUNK", !!bm, bm ? bm[1] : null);
  check("源码里能读到 BIG_PARALLEL", !!bp, bp ? bp[1] : null);
  const BIG_CHUNK = bm ? eval(bm[1]) : 0;
  const BIG_PARALLEL = bp ? Number(bp[1]) : -1;
  check("BIG_CHUNK 是 4MB（真机基准 4M×6 → 3.12MB/s）", BIG_CHUNK === 4 * 1024 * 1024, { got: BIG_CHUNK });
  check("BIG_PARALLEL 是 6", BIG_PARALLEL === 6, { got: BIG_PARALLEL });

  const res = await vm.runInContext(
    `window.__msRangeDownload({ key: "https://web.telegram.org/a/progressive/document1", name: "cc-test", hooks: { ct: "video/mp4" } })`,
    sandbox);

  check("下载完成", !!(res && res.ok), res && { ok: res.ok, received: res.received });
  check("收到全部字节", !!(res && res.received === TOTAL), { got: res && res.received, want: TOTAL });
  check(`在途请求数从不超过 ${PARALLEL}`, state.maxInflight <= PARALLEL, { maxInflight: state.maxInflight });
  check("确实用到了并发（>1）", state.maxInflight > 1, { maxInflight: state.maxInflight });
  // probeTotal 会先用一次 Range 探总长（可能整段拿回 512KB），所以去重后再算
  const uniq = [];
  for (const r of state.ranges) {
    if (!uniq.some((u) => u[0] === r[0] && u[1] === r[1])) uniq.push(r);
  }
  check("去重后分段数与文件匹配", uniq.length === 4, { count: uniq.length, uniq });
  check("Telegram 的段长仍是 512KB（没有被放大档误伤）",
    uniq.every(([a, b]) => b - a + 1 <= 512 * 1024 + 1),
    uniq.map(([a, b]) => b - a + 1));
  check("分段覆盖整个区间无空洞", (() => {
    const sorted = uniq.slice().sort((x, y) => x[0] - y[0]);
    let at = 0;
    for (const [a, b] of sorted) { if (a !== at) return false; at = b + 1; }
    return at === TOTAL;
  })(), uniq);

  const job = jobs.get("__last__");
  check("落盘字节数正确", !!(job && job.wrote === TOTAL), { got: job && job.wrote, want: TOTAL });

  console.log("\n" + "=".repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) process.exit(1);
}

run().catch((e) => { console.error("测试崩溃：", e); process.exit(1); });
