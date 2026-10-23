#!/usr/bin/env node
/**
 * 站点覆盖度审计：批量打开站点，量出「扩展在这些站上到底发现了什么」。
 *
 * 和 test/ 的分工：单测验的是「代码在已知输入下对不对」，这里量的是「在真实站点的
 * 真实页面上，有多少内容被抓到、多少被当成媒体、多少是噪声」。后者只有真浏览器能给答案。
 *
 * 测法
 * ----
 * 扩展的注入层（inject-main.js）在页面主世界里把每条发现都 `window.postMessage`
 * 出去（`{__ms_sniffer:true, cmd:'found', key, size, mime, …}`）。我们在页面**加载前**
 * 装一个钩子，把这些上报抄一份到 `window.__auditFound`，跑完再读走。
 *
 * 测的是「注入层的发现能力」——抓不到就是抓不到，这是覆盖度的上限。background 的
 * 过滤/去重（图标剔除、blob 让位、去重）不在这份数据里，所以这里数字**大于**用户在
 * popup 里看到的条目数。
 *
 * 为什么不读扩展内部
 * ------------------
 * 试过三条路，都被 Chrome 156 堵死：
 *   1. `chrome.storage.session`：MV3 的 background 在 CDP 里被暴露成 background_page，
 *      但那个 world 里 storage/cookies/webRequest 全是 undefined
 *      （Object.keys(chrome) 只到 tabs/windows/runtime，且都是不可用的壳）。
 *   2. `chrome.runtime.sendMessage({type:'sniff:get'})`：同上，发给自身也收不到。
 *   3. `Target.createTarget({url:'chrome-extension://…/popup.html'})`：落到
 *      `chrome-error://chromewebdata/`（未打包扩展的页面不对外部导航开放）。
 *   而 `chrome.tabs.create()` 在那个受限 world 里返回的 promise 永远 pending。
 * 页面内 hook 是唯一稳定的一条，而且不需要扩展配合。
 *
 * 用法
 *   node tools/site_audit.mjs                        # 跑 tools/sites.txt
 *   node tools/site_audit.mjs --wait 15 --limit 5
 *   node tools/site_audit.mjs --out a.json --md a.md --log a.log
 *
 * 需要真 Chrome（扩展在 headless 下不工作）且能直连外网；沙箱里起不来，要放沙箱外跑。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BROWSERS = {
  chrome: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ],
  edge: [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ],
};

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
}
const WAIT = Number(arg("wait", 13)) * 1000;
const LIMIT = Number(arg("limit", 0)) || Infinity;
const PORT = Number(arg("port", 9347));
const PROFILE = arg("profile", "D:/tmp/ms-audit-profile");
const SITES_FILE = arg("sites", join(HERE, "sites.txt"));
const OUT_JSON = arg("out", "");
const OUT_MD = arg("md", "");
const LOG = arg("log", "");
const KEEP = argv.includes("--keep");
// 深链模式：首页没有媒体时，自动从首页找第一个「像详情页」的链接再测一次。
// 首页是海报墙（img 拼的），视频在详情页里 —— 只测首页会得出「这些站都没有视频」
// 的错误结论（2026-10-23 的 34 站实测、以及更早的 20 站审计都栽在这上面）。
const DEEP = argv.includes("--deep");

// 扩展目录默认用 ASCII 路径下的副本（--ext-dir 可覆盖）。
// 原因：--load-extension 对含中文的路径不生效 —— 扩展会「看似加载」（background target
// 在），但 content script 一个都不注入。用路径 hash 算出的 ID 可以验证这一点：
// 生效时 /json/list 里出现的 ID 必须等于 sha256(路径) 映射后的结果。
const EXT_DIR = arg("ext-dir", "D:/tmp/ms-ext");



/**
 * 进度同时写 stderr 和日志文件。
 *
 * 写文件不是为了好看：Node 在管道模式下 stdout 是**全缓冲**，脚本被判超时杀掉时
 * 缓冲区直接丢，于是「跑了半天什么都没有」。调试这类 CDP 脚本时文件日志是唯一
 * 能留下现场的东西。
 */
function log(msg) {
  process.stderr.write(msg + "\n");
  if (LOG) {
    try { appendFileSync(LOG, msg + "\n"); } catch { /* 写不了就算了 */ }
  }
}

// ------------------------------------------------------------------ 扩展是否真的生效
/**
 * 校验方式不是看扩展 ID，而是**看页面里注入层有没有跑起来**（`__MS_SNIFFER_MAIN__`
 * 是个 boolean 才说明 inject-main.js 在 MAIN world 执行了）。
 *
 * 为什么不比 ID：未打包扩展的 ID 本该等于 sha256(路径) 映射，但实测 Edge 对路径的
 * 规范化（盘符大小写、分隔符）与手算不一致，对不上就没法判。而「注入层跑起来了吗」
 * 是端到端的事实，骗不了人。
 *
 * 为什么必须验：Chrome 137+ 已禁用 `--load-extension`，**但它不报错** —— 浏览器照常
 * 启动、也照常有 chrome-extension:// 的 target（那是自带的组件扩展），只是我们的
 * content script 一个都不注入。不验的话每站都是 0 条，看起来特别像「这些网站本来
 * 就没有媒体」。这一条曾经真的把我带偏过一次。
 */

// ------------------------------------------------------------------ CDP 客户端
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP 连接失败: " + url)), { once: true });
    });
    return new Cdp(ws);
  }

  call(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(method + " 超时"));
      }, timeoutMs);
      this.pending.set(id, {
        res: (v) => { clearTimeout(t); res(v); },
        rej: (e) => { clearTimeout(t); rej(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 在页面里求值并按值返回。表达式可以是 async 的。 */
  async eval(expression, timeoutMs = 30000) {
    const r = await this.call(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      timeoutMs,
    );
    if (r.exceptionDetails) {
      throw new Error("求值异常: " + (r.exceptionDetails.text || "") + " " +
        (r.exceptionDetails.exception?.description || ""));
    }
    return r.result?.value;
  }
}

async function httpJson(path) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
  if (!r.ok) throw new Error(path + " -> HTTP " + r.status);
  return r.json();
}

async function waitPort(ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { return await httpJson("/json/version"); } catch { await sleep(300); }
  }
  throw new Error("Chrome 调试端口没起来（" + PORT + "）");
}

// ------------------------------------------------------------------ 页面钩子
/**
 * 抄一份注入层的上报。只留 JSON 安全的字段（原消息里可能有 DOM 引用）。
 * 字段含义：key=地址、size=字节、mime、source=httpmedia|mediasrc|blob、dur=秒。
 */
const HOOK = `(() => {
  if (window.__auditFound) return;
  window.__auditFound = [];
  const orig = window.postMessage.bind(window);
  window.postMessage = function (msg, ...rest) {
    try {
      if (msg && msg.__ms_sniffer && msg.cmd === "found") {
        window.__auditFound.push({
          u: String(msg.key || ""),
          s: Number(msg.size) || 0,
          m: String(msg.mime || ""),
          src: String(msg.source || ""),
          t: String(msg.title || "").slice(0, 90),
          d: Number(msg.dur) || 0,
          w: Number(msg.w) || 0,
          h: Number(msg.h) || 0,
        });
      }
    } catch (e) { /* 钩子绝不干扰页面 */ }
    return orig(msg, ...rest);
  };
})();`;

// ------------------------------------------------------------------ 站点清单
function loadSites() {
  if (!existsSync(SITES_FILE)) throw new Error("站点清单不存在: " + SITES_FILE);
  return readFileSync(SITES_FILE, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [url, tag] = l.split(/\s+/);
      return { url, tag: tag || "" };
    });
}

// ------------------------------------------------------------------ 分析
/** 从 mime / 扩展名猜类型。注入层的 mime 偶尔缺失，所以两条都看。 */
function kindOf(it) {
  const m = (it.m || "").toLowerCase();
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("image/")) return "image";
  const u = (it.u || "").toLowerCase().split("?")[0];
  if (/\.(mp4|m4v|webm|ts|m4s|mkv|mov|flv)$/.test(u)) return "video";
  if (/\.(mp3|m4a|aac|ogg|opus|flac|wav)$/.test(u)) return "audio";
  if (/\.(jpg|jpeg|png|gif|webp|avif)$/.test(u)) return "image";
  return "other";
}

function analyze(found) {
  const items = found.map((it) => ({ ...it, k: kindOf(it) }));
  const media = items.filter((it) => it.k === "video" || it.k === "audio");
  const direct = media.filter((it) => /^https?:/i.test(it.u) && it.s > 0);
  const blob = media.filter((it) => /^blob:/i.test(it.u));
  const noSize = media.filter((it) => /^https?:/i.test(it.u) && !it.s);
  const imgs = items.filter((it) => it.k === "image");
  const others = items.filter((it) => it.k === "other");

  // 归类只看「有没有一条能直接下的地址」，不看站名（B22 的教训）。
  let cls;
  if (direct.length) cls = "A";        // 有 http 直链且知道大小
  else if (noSize.length) cls = "A?";  // 有 http 地址但没拿到大小（可能只是没发 content-length）
  else if (blob.length) cls = "B";     // 只有流式地址
  else if (media.length) cls = "?";
  else cls = "-";                      // 这一页没有媒体
  return {
    total: items.length,
    media: media.length,
    direct: direct.length,
    noSize: noSize.length,
    blob: blob.length,
    image: imgs.length,
    other: others.length,
    dur: media.filter((it) => it.d > 0).length,
    cls,
    sample: direct.slice(0, 2).map((it) => ({
      k: it.k, s: it.s, d: it.d, u: it.u.slice(0, 110),
    })),
  };
}

// ------------------------------------------------------------------ 单站
async function auditSite(browser, site, waitMs) {
  const t0 = Date.now();
  // 直接开目标站点（不经过 about:blank）：实测「about:blank → Page.navigate」这条路上
  // 扩展的 MAIN world content script 根本不会注入（__MS_SNIFFER_MAIN__ 是 undefined），
  // 那样测出来全是 0 条。正常导航才注入，装完钩子用 reload 让它在文档起点生效。
  const { targetId } = await browser.call("Target.createTarget", { url: site.url });
  const list = await httpJson("/json/list");
  const target = list.find((x) => x.id === targetId);
  if (!target) throw new Error("新建的 tab 找不到");

  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    await cdp.call("Page.enable");
    await cdp.call("Runtime.enable");
    await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
    await cdp.call("Page.reload", { ignoreCache: false });
    await sleep(waitMs);

    const state = await cdp.eval(`({
      href: location.href,
      title: (document.title || "").slice(0, 80),
      ready: document.readyState,
      hidden: document.hidden,
      found: window.__auditFound || null,
      hook: typeof window.__auditFound,
      injected: typeof window.__msScan,
      msMain: typeof window.__MS_SNIFFER_MAIN__,
      links: (() => {
        try {
          // 「像详情页」的路径：播放页、视频页、图文详情、音乐/声音页。宁可错杀，
          // 别抓一堆导航链接。判据用「关键字 + 路径深度」。
          //
          // 用 new RegExp 而不是字面量，是被坑过两次：这段代码住在模板字符串里，
          // 正则字面量里的斜杠转义会被吃掉，紧跟的那个斜杠就把字面量截断了，
          // 结果是页面侧抛 Unterminated group，**每一站都失败**。
          // 换成字符串构造后，斜杠和 [0-9] 都不会再被模板字符串改写。
          // 同理：这段注解里也不能出现反引号，否则模板字符串当场被闭合
          // （第二次踩的时候就是这么挂的：missing ) after argument list）。
          const RE = new RegExp(
            "(video|play|watch|vod|detail|note|album|bangumi|sound|mixsong|song|id_|av[0-9]|ac[0-9]|b/[0-9])",
            "i",
          );
          const host = location.hostname.replace(/^www\./, "");
          const seen = new Set();
          const out = [];
          for (const a of document.querySelectorAll("a[href]")) {
            let u;
            try { u = new URL(a.href); } catch (e) { continue; }
            if (!/^https?:$/.test(u.protocol)) continue;
            if (u.hostname.replace(/^www\./, "") !== host) continue;
            if (u.href === location.href) continue;
            if (!RE.test(u.pathname)) continue;
            if (u.pathname.split("/").filter(Boolean).length < 2) continue;
            if (seen.has(u.href)) continue;
            seen.add(u.href);
            out.push(u.href);
            if (out.length >= 6) break;
          }
          return out;
        } catch (e) { return []; }
      })(),
      videos: document.querySelectorAll("video,audio").length,
      imgs: document.querySelectorAll("img").length,
      foundLen: (window.__auditFound || []).length,
    })`, 45000); // 视频站的 DOM 特别大（v.qq 实测 30s 默认值不够）
    if (!state.found) throw new Error("钩子没生效（" + state.hook + "）");
    const a = analyze(state.found);
    return {
      url: site.url, tag: site.tag,
      finalUrl: state.href, title: state.title,
      hidden: state.hidden, injected: state.injected,
      msMain: state.msMain, links: state.links || [],
      videos: state.videos, imgs: state.imgs,
      ...a, ms: Date.now() - t0,
    };
  } finally {
    cdp.ws.close();
    try { await browser.call("Target.closeTarget", { targetId }); } catch { /* 已关 */ }
  }
}

// ------------------------------------------------------------------ 主流程
const BROWSER = arg("browser", "chrome");
const CHROME = (BROWSERS[BROWSER] || []).find((p) => existsSync(p));
if (!CHROME) {
  console.error("找不到 " + BROWSER + "，可用: " + Object.keys(BROWSERS).join(" / "));
  process.exit(2);
}

const args = [
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + PROFILE,
  "--load-extension=" + EXT_DIR,
  "--disable-extensions-except=" + EXT_DIR,
  "--no-first-run",
  "--no-default-browser-check",
  // Chrome 137+ 默认禁用了 --load-extension（安全策略）。不加这一条，扩展会「看似加载」
  // （能看到 background target），但 content script 一个都不注入 —— 实测页面里
  // __MS_SNIFFER_MAIN__ 是 undefined，扫出来全是 0 条，很容易误判成「这些站没有媒体」。
  "--disable-features=Translate,MediaRouter,DisableLoadExtensionCommandLineSwitch",
  "--enable-unsafe-extension-debugging",
  "--window-size=1280,900",
  "--window-position=-2400,-2400", // 挪出屏幕，不挡事
  "about:blank",
];

// 把扩展同步到 ASCII 路径的副本再加载：一是避免中文路径可能的坑，二是副本会被
// 覆盖刷新，不会出现「改了源码但测的是旧副本」。
//
// 这里**不能用 `cpSync(src, dst, {recursive:true})`**：源路径含中文时它会让整个
// Node 进程被静默硬杀（退出码 127，不抛异常、不打日志、连 catch 都进不去）。
// 实测 3/3 复现，ASCII->ASCII 拷同一份文件则正常。表现为「脚本什么都不输出就退出」，
// 而且 `$?` 是 127 很容易被误读成「命令没找到」，我第一次就栽在这上面排查了半天。
// 手工递归 walk 是等价的，且稳。
function copyTree(src, dst) {
  if (statSync(src).isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(src)) copyTree(join(src, name), join(dst, name));
  } else {
    copyFileSync(src, dst);
  }
}

const SRC_EXT = join(ROOT, "extension");
if (resolve(SRC_EXT) !== resolve(EXT_DIR)) {
  rmSync(EXT_DIR, { recursive: true, force: true });
  copyTree(SRC_EXT, EXT_DIR);
  log("扩展已同步到 " + EXT_DIR);
}

log("启动 " + BROWSER + "…");
mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, args, { stdio: "ignore", detached: false });

let browser = null;
const rows = [];

try {
  const ver = await waitPort();
  log("Chrome " + String(ver.Browser || "").replace(/^Chrome\//, "") + " 已就绪");
  browser = await Cdp.connect(ver.webSocketDebuggerUrl);

  const sites = loadSites().slice(0, LIMIT);
  log(`站点 ${sites.length} 个，每站等 ${WAIT / 1000}s`);

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    log(`[${i + 1}/${sites.length}] ${site.url.replace(/^https?:\/\//, "")} …`);
    try {
      const r = await auditSite(browser, site, WAIT);
      if (i === 0 && r.msMain !== "boolean") {
        throw new Error(
          "扩展注入层没有运行（__MS_SNIFFER_MAIN__ = " + r.msMain + "）。" +
          "这个浏览器的 --load-extension 已被禁用（Chrome 137+ 移除了它），" +
          "换 --browser edge 重跑。注意它不会报错，只会让每站都变成 0 条。");
      }
      log(`    首页 ${r.total} 条 / 媒体 ${r.media} / 直链 ${r.direct} / 图 ${r.image} / ${r.cls}（${r.links.length} 个候选详情页）`);
      // 首页没有媒体并不等于这个站下不了 —— 视频在海报墙后面。追一两个详情页。
      if (DEEP && r.cls === "-" && r.links.length) {
        for (const link of r.links.slice(0, 2)) {
          log(`    深链 ${link.slice(0, 90)}`);
          try {
            const d = await auditSite(browser, { url: link, tag: site.tag }, WAIT);
            log(`      → ${d.total} 条 / 媒体 ${d.media} / 直链 ${d.direct} / 无大小 ${d.noSize} / blob ${d.blob} / ${d.cls}`);
            if (d.media > 0) { r.deep = { url: link, ...d, links: undefined }; break; }
          } catch (e) {
            log("      → " + String(e.message || e));
          }
        }
      }
      rows.push(r);
    } catch (e) {
      rows.push({ url: site.url, tag: site.tag, error: String(e.message || e) });
      log("    失败: " + String(e.message || e));
    }
  }
} finally {
  try { await browser?.call("Browser.close", {}, 5000); } catch { /* 已经关了 */ }
  await sleep(600);
  try { chrome.kill(); } catch { /* 已经退了 */ }
  if (!KEEP) {
    // profile 里有会话与缓存，跑完就清。
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 锁住就算了 */ }
  }
}

// ------------------------------------------------------------------ 输出
const ok = rows.filter((r) => !r.error);
const withDirect = ok.filter((r) => r.cls === "A" || r.cls === "A?");
const withBlob = ok.filter((r) => r.cls === "B");
const noMedia = ok.filter((r) => r.cls === "-");
const failed = rows.filter((r) => r.error);

console.log("\n" + "=".repeat(88));
console.log(`站点 ${rows.length} 个：有直链 ${withDirect.length} / 只有流式 ${withBlob.length} / 本页无媒体 ${noMedia.length} / 打开失败 ${failed.length}`);
console.log("=".repeat(88));
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(pad("站点", 30) + pad("条目", 6) + pad("媒体", 6) + pad("直链", 6) + pad("无大小", 8) + pad("blob", 6) + pad("图", 6) + "类");
for (const r of rows) {
  if (r.error) {
    console.log(pad(r.url.replace(/^https?:\/\//, ""), 30) + "  失败: " + r.error.slice(0, 44));
    continue;
  }
  console.log(
    pad(r.url.replace(/^https?:\/\//, ""), 30) +
    pad(r.total, 6) + pad(r.media, 6) + pad(r.direct, 6) + pad(r.noSize, 8) +
    pad(r.blob, 6) + pad(r.image, 6) + r.cls,
  );
}

if (OUT_JSON) {
  writeFileSync(OUT_JSON, JSON.stringify({ when: new Date().toISOString(), rows }, null, 2), "utf8");
  console.log("\nJSON -> " + OUT_JSON);
}
if (OUT_MD) {
  const lines = [
    "# 站点覆盖度实测",
    "",
    `> ${new Date().toLocaleString("zh-CN")} · 未登录 · 每站等 ${WAIT / 1000}s · Chrome 真机`,
    "> 数字是**注入层上报的原始发现**，未经 background 的图标过滤/去重，所以大于用户在 popup 里看到的条目数。",
    "",
    "| 站点 | 条目 | 媒体 | 直链 | 无大小 | blob | 图 | 类 | 说明 |",
    "|---|---:|---:|---:|---:|---:|---:|---|---|",
    ...rows.map((r) => r.error
      ? `| ${r.url} | - | - | - | - | - | - | 失败 | ${String(r.error).slice(0, 40)} |`
      : `| ${r.url} | ${r.total} | ${r.media} | ${r.direct} | ${r.noSize} | ${r.blob} | ${r.image} | ${r.cls} | ${
        (r.sample?.[0]?.u || "").replace(/[|]/g, "\\|").slice(0, 68)} |`),
    "",
    "`类` 的判据只看「有没有一条能直接下的地址」，不看站名：",
    "A=有 http 直链且拿到字节数，A?=有 http 地址但没拿到字节数，B=只有 blob，-=本页没有媒体。",
  ];
  writeFileSync(OUT_MD, lines.join("\n") + "\n", "utf8");
  console.log("Markdown -> " + OUT_MD);
}

// WebSocket 还开着，Node 不会自己退；显式退出。
process.exit(0);
