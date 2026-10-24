/**
 * MSHlsMeta —— HLS/MPD 清单**正文**的结构解析（纯函数）。
 *
 * 为什么有这一层（2026-10-24，用户截图 51cg1）：
 *   列表里四条「HLS 流（视频）」全是 5 KB 级，文案一模一样，用户问
 *   「有什么区别、该点哪个」。真机取证（tools/net_dump.mjs）给出答案：
 *     /m3m/<hex>.m3u8       29 KB  → 179 段 × 6s = 1074s = 17:54 ← 播放器在用的正片
 *     /videos5/<md5>/…m3u8   5 KB  → 页面预载的小清单，播放器根本没用它
 *   用户点了后者，下到的文件名就是那个 md5。
 *
 *   在只有地址的情况下，这两条**无法区分**：同域名、同后缀、同 mime（都是
 *   text/plain），体积差 5 倍但界面上没显示体积的意义。唯一能区分的是内容：
 *   段数和总时长。所以必须从「监听地址」跨到「读内容」。
 *
 * 边界（照 fuzz_host.py 挖出来的那几条教训）：
 *   · BOM / CRLF / 前后空行都得吃；第一行不是 #EXTM3U 就判 unknown，不硬猜；
 *   · #EXTINF 后面那一行如果是注释，那不是分片地址，不能计段；
 *   · 负数和垃圾时长不累加，否则总时长会出现负数或 NaN；
 *   · 解析失败一律返回 unknown + 零值，绝不抛异常 —— 这条链在页面主线程上跑，
 *     抛一次就可能让站点的播放器跟着坏。
 */
var MSHlsMeta = (function () {
  "use strict";

  const EMPTY = () => ({ kind: "unknown", segs: 0, dur: 0, encrypted: false, variants: [] });

  function isMpd(text) {
    // MPD 是 XML。只做最小判断：能被当成清单读出来就够了，不引 XML 解析器。
    return /<MPD[\s>]/i.test(text) && /<Period[\s>]/i.test(text);
  }

  /**
   * @param {string} text 清单正文
   * @returns {{kind:"master"|"media"|"mpd"|"unknown", segs:number, dur:number,
   *            encrypted:boolean, variants:Array<{bandwidth:number,res:string,url:string}>}}
   */
  function parse(text) {
    const out = EMPTY();
    if (typeof text !== "string" || !text) return out;

    // BOM 和零宽字符：真机见过 m3u8 带 U+FEFF 开头，不剥掉第一行就匹配不上
    const clean = text.replace(/^\ufeff/, "").replace(/[\u200b\u200e\u200f]/g, "");

    if (isMpd(clean)) {
      out.kind = "mpd";
      return out;
    }

    const rawLines = clean.split(/\r?\n/);

    // 第一个非空行必须是 #EXTM3U，否则这不是清单（可能是 403 的 HTML 错误页）
    let first = -1;
    for (let i = 0; i < rawLines.length; i++) {
      if (rawLines[i].trim()) { first = i; break; }
    }
    if (first < 0 || rawLines[first].trim() !== "#EXTM3U") return out;

    let hasStreamInf = false;
    let pendingInf = -1;        // #EXTINF 后面跟着的那个分片地址
    let pendingBandwidth = 0;
    let pendingRes = "";
    let pendingVariant = false; // 上一条是 #EXT-X-STREAM-INF，下一非注释行是变体地址

    for (let i = first + 1; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (!line) continue;

      if (line.charAt(0) === "#") {
        // ---- #EXTINF：记下时长，等下一行的分片地址
        if (line.indexOf("#EXTINF:") === 0) {
          const v = parseFloat(line.slice(8));
          // 负数和 NaN 一律当「没有时长」：宁可总时长偏短，也不要出现 -5 或 NaN
          pendingInf = (isFinite(v) && v > 0) ? v : 0;
          continue;
        }
        // ---- #EXT-X-STREAM-INF：主清单的一档
        if (line.indexOf("#EXT-X-STREAM-INF:") === 0) {
          hasStreamInf = true;
          const bw = /BANDWIDTH=(\d+)/i.exec(line);
          const rs = /RESOLUTION=([0-9]+x[0-9]+)/i.exec(line);
          pendingBandwidth = bw ? Number(bw[1]) : 0;
          pendingRes = rs ? rs[1] : "";
          pendingVariant = true;
          continue;
        }
        // ---- 加密：METHOD=NONE 不算
        if (line.indexOf("#EXT-X-KEY:") === 0) {
          if (!/METHOD\s*=\s*NONE/i.test(line)) out.encrypted = true;
          continue;
        }
        // 其它注释（含 #EXT-X-MAP / #EXT-X-ENDLIST / #EXT-X-WINDOW）不影响计数。
        // 尤其 #EXT-X-MAP 是 init 段，它**不是**一个分片，不能计进 segs。
        continue;
      }

      // ---- 非注释行：要么是分片地址，要么是变体地址
      if (pendingVariant) {
        out.variants.push({ bandwidth: pendingBandwidth, res: pendingRes, url: line });
        pendingVariant = false;
        pendingBandwidth = 0;
        pendingRes = "";
        continue;
      }
      if (pendingInf >= 0) {
        out.segs++;
        out.dur += pendingInf;
        pendingInf = -1;
      }
    }

    if (hasStreamInf) {
      out.kind = "master";
      // 主清单本身没有分片，时长要等子清单 —— 这里清零，避免把变体数当段数
      out.segs = 0;
      out.dur = 0;
    } else if (out.segs > 0) {
      out.kind = "media";
      out.dur = Math.round(out.dur * 1000) / 1000;
    }
    return out;
  }

  /** 这个地址看起来是清单吗（只看路径，不看正文） */
  function looksLikeManifest(u) {
    if (typeof u !== "string" || !u) return false;
    try {
      return /\.(m3u8|mpd)$/i.test(new URL(u).pathname);
    } catch (e) {
      return /\.(m3u8|mpd)(\?|#|$)/i.test(u);
    }
  }

  /** 秒 → "17:54" / "1:02:03"；0 或非法值返回空串（调用方据此决定不显示） */
  function durText(sec) {
    let s = Math.round(Number(sec) || 0);
    if (!s || s < 0) return "";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h) return h + ":" + String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
    return m + ":" + String(r).padStart(2, "0");
  }

  return { parse: parse, looksLikeManifest: looksLikeManifest, durText: durText };
})();

if (typeof globalThis !== "undefined") globalThis.MSHlsMeta = MSHlsMeta;
if (typeof module !== "undefined" && module.exports) module.exports = MSHlsMeta;
