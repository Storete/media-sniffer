/**
 * MSHlsFamily —— 把同一页的多条 .m3u8 归成「主清单 + N 档变体」。
 *
 * 为什么有这一层（2026-10-24 用户截图 51cg1）：
 *   列表里并排三条「HLS 流（视频）」，5.1 / 4.0 / 4.2 KB，文案一模一样。
 *   用户问「这三条有什么区别」。真相不是三个视频，是**同一个视频的主清单和
 *   清晰度变体** —— 点错一条就下到另一档，而界面上没有任何线索。
 *
 * 真机证据（本地 hls.js + mux 三档测试流，修完体积门槛后抓到的原始数据）：
 *   master  752 B  …/x36xhzz/x36xhzz.m3u8
 *   HD     3606 B  …/x36xhzz/url_0/…_hd_7.m3u8
 *   FHD    3670 B  …/x36xhzz/url_8/…_fhd_7.m3u8
 *   HQ     3606 B  …/x36xhzz/url_6/…_hq_7.m3u8
 *
 * 判据只用到「目录 + 体积」两样，不读响应体。这是有意的：
 *   · 读 master 的内容才能拿到真正的分辨率/带宽，那是 S1（L1-a）的活；
 *   · 但在那之前，「这是主清单 / 这是第几档」已经足够让用户不再点错。
 * 两条判据都只做**标注**，不隐藏、不合并、不改变下载行为 —— 判断错时的代价
 * 只是标注不准，不会让用户少一个选项。
 */
var MSHlsFamily = (function () {
  "use strict";

  function isM3u8(u) {
    try {
      return /\.m3u8$/i.test(new URL(String(u || "")).pathname);
    } catch (e) {
      return false;
    }
  }

  /** 目录，**带尾斜杠**。尾斜杠是祖先判定的关键：没有它，/hls 会吞掉 /hls-a/。 */
  function dirOf(u) {
    try {
      const p = new URL(String(u || ""));
      return p.origin + p.pathname.replace(/[^/]*$/, "");
    } catch (e) {
      return "";
    }
  }

  function sizeOf(it) {
    return Number(it && it.s) || 0;
  }

  /**
   * 路径第一段，用来判断「是不是同一棵树」。
   *   https://a.com/hls/1080/index.m3u8 → "hls"
   *   https://a.com/m3m/x.m3u8          → "m3m"
   *   https://a.com/x.m3u8（根下）      → ""
   */
  function firstSegOf(dir) {
    const m = /^https?:\/\/[^/]+(\/[^/]*)/.exec(String(dir || ""));
    return m ? m[1].replace(/\//g, "") : "";
  }

  /** 体积降序（大→小），同体积用 URL 字典序定序 —— 保证输入顺序变化时结果不变。 */
  function bySizeDesc(list) {
    return list.slice().sort((a, b) => {
      const d = sizeOf(b) - sizeOf(a);
      if (d) return d;
      return String(a.u) < String(b.u) ? -1 : String(a.u) > String(b.u) ? 1 : 0;
    });
  }

  /**
   * @param {Array<{u:string,s?:number}>} items 当前标签页的条目（可含非 m3u8）
   * @returns {Map<string, {role:"master"|"variant", index:number, total:number,
   *                        size:number, hasMaster:boolean}>}
   *   key 是条目 URL。少于 2 条 m3u8 时返回空 Map —— 单条标「主清单」只会误导。
   *   **不在 Map 里的条目 = 独立清单**（同目录下没有伙伴），调用方按中性文案显示。
   */
  function build(items) {
    const out = new Map();

    const uniq = [];
    const seen = new Set();
    for (const it of (items || [])) {
      if (!it || !isM3u8(it.u) || seen.has(it.u)) continue;
      seen.add(it.u);
      uniq.push(it);
    }
    if (uniq.length < 2) return out;

    const dirs = uniq.map((it) => dirOf(it.u));

    // 候选主清单：目录是**其它条目**目录的严格前缀（按 / 边界，不是字符串前缀）。
    const masterIdx = [];
    for (let i = 0; i < uniq.length; i++) {
      for (let j = 0; j < uniq.length; j++) {
        if (i === j) continue;
        const a = dirs[i], b = dirs[j];
        if (a && b && b.length > a.length && b.startsWith(a)) {
          masterIdx.push(i);
          break;
        }
      }
    }

    if (masterIdx.length === 1) {
      const mi = masterIdx[0];
      const variants = bySizeDesc(uniq.filter((_, i) => i !== mi));
      out.set(uniq[mi].u, { role: "master", index: 0, total: variants.length, size: sizeOf(uniq[mi]), hasMaster: true });
      variants.forEach((it, k) => {
        out.set(it.u, { role: "variant", index: k + 1, total: variants.length, size: sizeOf(it), hasMaster: true });
      });
      return out;
    }

    // ---- 没有唯一主清单：按**路径第一段**分组，只有同一棵树下的才算一族。
    //
    // 2026-10-24 真机（51cg1）为什么必须收紧：页面上同时有
    //     /videos5/<md5>/<md5>.m3u8   5 KB
    //     /m3m/<长hex>.m3u8          29 KB → 179 段、1074s（17:54），播放器真正在用的
    // 两条同域名、同后缀、mime 都是 text/plain，唯一区别是目录。上一版把它们全塞进
    // 一族、标成「第 1/2 档」，等于**编造**了一个并不存在的清晰度关系。
    //
    // 为什么不用「同父目录」而用「路径第一段」：
    //   /hls/1080/index.m3u8 + /hls/720/index.m3u8 是同一视频的两档（共同祖先 /hls/），
    //   父目录不同但必须归族；而 /videos5/… 和 /m3m/… 连第一段都不同，绝不该归族。
    //   第一段是这两类的最小公共分母。
    //
    // 同树的多条确实可能是同一视频的多档（也可能是分段），保持归族，但记下
    // hasMaster=false —— 调用方据此**不能**再说「整段下载请点主清单」（根本没有主清单）。
    const groups = new Map();
    for (let i = 0; i < uniq.length; i++) {
      const seg = firstSegOf(dirs[i] || "");
      if (!groups.has(seg)) groups.set(seg, []);
      groups.get(seg).push(uniq[i]);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;   // 这个目录树下只有一条：不归族，不给序号
      // 体积只用来排序线索，不声称等价于清晰度 —— 实测 HQ 比 FHD 小。
      const sorted = bySizeDesc(list);
      sorted.forEach((it, k) => {
        out.set(it.u, { role: "variant", index: k + 1, total: sorted.length, size: sizeOf(it), hasMaster: false });
      });
    }
    return out;
  }

  return { build: build, dirOf: dirOf, isM3u8: isM3u8 };
})();

if (typeof globalThis !== "undefined") globalThis.MSHlsFamily = MSHlsFamily;
if (typeof module !== "undefined" && module.exports) module.exports = MSHlsFamily;
