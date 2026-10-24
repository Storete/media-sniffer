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
 * build() 的两条判据都只做**标注**，不隐藏、不合并、不改变下载行为 —— 判断错时
 * 的代价只是标注不准，不会让用户少一个选项。
 *
 * 唯一会**折叠**列表的是同文件的 sameMovie()：它只认「时长精确相同」这一条硬证据
 * （见文件末尾的说明），且折叠可逆（有「切换」）。「可能是同一批」这种弱证据一律
 * 只标注不折叠 —— 2026-10-24 上一版就是因为拿路径猜关系，把预载清单和正片标成了
 * 「第 1/2 档」，用户点的正是错的那条。
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

  // ==================== 同片清单去重（2026-10-24 用户要求「只出现一条」）====================
  //
  // 用户原话：「1.不能只出现一条可下载吗」。
  // 那一页列表里并排两条，**时长一模一样 33:33**，一条 403 段、一条 337 段：
  //     /videos5/<md5>/<md5>.m3u8   9.1 KB  403 段
  //     /m3m/<hex>.m3u8             7.6 KB  337 段
  // 上一版按「路径第一段」只归族不合并，于是它们成了两条。可它们时长精确相同，
  // 意味着覆盖的是同一段内容 —— 两条都能下出完整视频，只是片源/切片长度不同。
  // 对用户来说这就不是「两个选择」，是「同一个视频被我拆成了两行」。
  //
  // 判据只有一条：**时长相同**（容差 2 秒）。这是 hls-meta 从 #EXTINF 累加出来的
  // 硬数字，不是猜的。为什么不用体积/段数：那两项跟清晰度没有稳定对应关系
  // （实测 HQ 比 FHD 小），拿它们判「同一个视频」等于编造。
  //
  // 为什么容差只有 2 秒：同一条流的两个清单，时长要么完全相同，要么差几分钟
  // （不同集/不同版本）。2 秒只吸收 #EXTINF 四舍五入，不做近似匹配。
  //
  // 为什么要求 ≥60 秒：短片（贴片广告、预览）时长撞车太正常，凭 30 秒相同
  // 就合并会把两个不同的东西吃掉一个。
  //
  // 合并后**只留一条**（其余 hidden），并在那一条上给「切换」——
  // 隐藏是可逆的，不是删除：用户想换片源随时能换回来。
  const DUR_TOL = 2;     // 秒
  const MIN_DUR = 60;    // 秒

  /**
   * 从一组同长清单里挑默认那一条。优先级每条都有理由，且都能从条目字段直接读到：
   *   1. **有 title**：title 只有页面自己声明的视频源才会有（DPlayer 的 data-config
   *      等），比网络里随便抓到的一条更可信；
   *   2. **hits 多**：被请求次数多，通常是播放器正在反复拉的（预载清单一般只拉一次）；
   *   3. **段数多**：同长度下切片更细，单段失败要重下的量更小；
   *   4. 体积大、URL 字典序兜底 —— 只为让结果稳定，不代表任何质量判断。
   */
  function pickDefault(list) {
    return list.slice().sort((a, b) => {
      const ta = (a.title || "").trim() ? 1 : 0, tb = (b.title || "").trim() ? 1 : 0;
      if (ta !== tb) return tb - ta;
      const ha = Number(a.hits) || 0, hb = Number(b.hits) || 0;
      if (ha !== hb) return hb - ha;
      const sa = Number(a.segs) || 0, sb = Number(b.segs) || 0;
      if (sa !== sb) return sb - sa;
      const za = sizeOf(a), zb = sizeOf(b);
      if (za !== zb) return zb - za;
      return String(a.u) < String(b.u) ? -1 : String(a.u) > String(b.u) ? 1 : 0;
    })[0];
  }

  /**
   * @param {Array} items 当前标签页全量条目
   * @param {Map}   family build() 的结果，用来排除「已有主清单」的族
   * @param {Map}   override 用户点过「切换」后的选择：groupKey → url
   * @returns {{groupOf: Map<string,object>, hidden: Set<string>}}
   *   groupOf 的 key 是 URL，value = {key, dur, urls, chosen, alts}
   *   hidden 里是**被折叠掉**的 URL，调用方渲染时跳过。
   */
  function sameMovie(items, family, override) {
    const groupOf = new Map();
    const hidden = new Set();

    const cand = [];
    for (const it of (items || [])) {
      if (!it || !isM3u8(it.u)) continue;
      const d = Number(it.dur) || 0;
      if (d < MIN_DUR) continue;
      // 已经有主清单的族里，「变体」之间本来就不是重复关系（是不同清晰度），
      // 那边已由 build() 标注，再叠一层「同片折叠」会把清晰度选项吃掉。
      const fam = family && family.get(it.u);
      if (fam && fam.hasMaster) continue;
      cand.push({ it: it, d: d });
    }
    if (cand.length < 2) return { groupOf: groupOf, hidden: hidden };

    cand.sort((a, b) => (a.d - b.d) || (String(a.it.u) < String(b.it.u) ? -1 : 1));

    // 单链聚类：只跟**上一个成员**比，不跟簇首比。
    // 跟簇首比会在 100/101/102 这种密集但确实不同的三条上把跨度撑成 2 秒外还归一族。
    const clusters = [];
    for (const c of cand) {
      const last = clusters.length ? clusters[clusters.length - 1] : null;
      if (last && c.d - last[last.length - 1].d <= DUR_TOL) last.push(c);
      else clusters.push([c]);
    }

    for (const cl of clusters) {
      if (cl.length < 2) continue;
      const list = cl.map((x) => x.it);
      // 组键用**排序后的 URL 拼**：与渲染顺序无关，用户点过切换后重新渲染仍稳定。
      const key = list.map((it) => it.u).sort().join("|");
      const want = override && override.get(key);
      const chosen = (want && list.find((it) => it.u === want)) || pickDefault(list);
      const grp = {
        key: key,
        dur: Number(chosen.dur) || 0,
        urls: list.map((it) => it.u),
        chosen: chosen.u,
        alts: list.length - 1,
      };
      for (const it of list) {
        groupOf.set(it.u, grp);
        if (it.u !== chosen.u) hidden.add(it.u);
      }
    }
    return { groupOf: groupOf, hidden: hidden };
  }

  return { build: build, sameMovie: sameMovie, pickDefault: pickDefault, dirOf: dirOf, isM3u8: isM3u8 };
})();

if (typeof globalThis !== "undefined") globalThis.MSHlsFamily = MSHlsFamily;
if (typeof module !== "undefined" && module.exports) module.exports = MSHlsFamily;
