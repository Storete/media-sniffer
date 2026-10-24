/**
 * MSNaming —— 落盘文件名的选择规则（纯函数）。
 *
 * 2026-10-24 用户真机反馈：下载下来的文件叫 `449820be57199908ccb430879b3ada75.mp4`，
 * 原话是「应该是标题（如果有的话），而不是这种名称」。
 *
 * 为什么会这样：popup 的下载按钮写的是 `it.f || title`，而 it.f 是
 * fileNameOf(it.u) —— 纯从 URL 末段推出来的。对 51cg1 这种
 * `/videos5/449820be…/449820be….m3u8` 的站，URL 末段就是 32 位哈希，
 * 于是哈希永远赢过标题。而页面浮层那条保存链（pageSaveName）一直是标题优先 ——
 * 同一个产品里两条链的名字规则相反，用户从不同入口下到的东西名字不一样。
 *
 * 规则定死在这里，两条链都调它：
 *   1. 有标题 → 用标题（截到 60 字，保留扩展名）；
 *   2. 标题明显是**站点名**（很短且含域名主体）→ 退回 URL 推的名字，
 *      否则一页四个视频会撞成同一个文件名，互相覆盖；
 *   3. 都没 → 空串，由宿主侧兜底。
 */
var MSNaming = (function () {
  "use strict";

  const MAX = 60;

  /**
   * 列表显示名 / 文件名共用：压空白、截断、截断时保住扩展名。
   * 截断前先摘扩展名，否则「…（完整版）.mp4」截到 60 字后扩展名被砍掉，
   * 列表里看着对，存下来成了无扩展名文件。
   */
  function shortTitle(t) {
    const s = String(t || "").replace(/\s+/g, " ").trim();
    if (s.length <= MAX) return s;
    const m = /\.([a-z0-9]{2,5})$/i.exec(s);
    const ext = m ? "." + m[1] : "";
    const body = (ext ? s.slice(0, s.length - ext.length) : s).slice(0, MAX)
      .replace(/[\s_\-·,，、]+$/, "") + "…";
    return body + ext;
  }

  function hostOf(u) {
    try { return new URL(String(u || "")).hostname || ""; } catch (e) { return ""; }
  }

  /**
   * @param {{title?:string, f?:string, i?:string, tabUrl?:string}} it
   * @returns {string} 期望的文件名（不含扩展名也行，宿主侧会补）
   */
  function downloadName(it) {
    it = it || {};
    const title = shortTitle(it.title || "");
    if (!title) return String(it.f || "");

    // 站点名判定：标题短，且包含域名主体（如 "51cg1"、"bilibili"）。
    // 刻意保守 —— 宁可留一个长标题，也不要再把哈希名放出来。
    const host = hostOf(it.i || it.tabUrl || "").replace(/^www\./, "").split(".")[0] || "";
    if (title.length <= 8 && host && title.toLowerCase().indexOf(host.toLowerCase()) >= 0) {
      return String(it.f || title);
    }
    return title;
  }

  return { downloadName: downloadName, shortTitle: shortTitle, hostOf: hostOf };
})();

if (typeof globalThis !== "undefined") globalThis.MSNaming = MSNaming;
if (typeof module !== "undefined" && module.exports) module.exports = MSNaming;
