/**
 * 通用媒体判定（纯函数，不碰 DOM、不碰 chrome API，可在 Node 里直接测）。
 *
 * 为什么单独一个文件：background.js 里的 classify() 是「扩展名 + mime」两张表，
 * 遇到 `application/octet-stream` 且 URL 没有扩展名的 CDN 就判成「其他」，
 * 这类站点恰恰是抓不全的主要来源。这里补一层「正向证据」判定，顺序参考
 * flowpick（MIT）的 detect.ts，但只保留我们需要的部分：
 *
 *   1. 先排除分片（.m4s / .cmfv / .cmfa / .ts …）——分片不是可下载的成品
 *   2. Content-Type 优先（最可靠的信号）
 *   3. octet-stream 这类通用二进制：必须有「体积 ≥ 1MB」+「已知扩展名或已知 CDN」
 *   4. 最后才退回 URL 扩展名
 *
 * 返回 kind（video / audio / image）或 null，不返回具体格式：调用方只需要分类。
 */
(function (root) {
  "use strict";

  var FORMAT_KIND = {
    mp4: "video", m4v: "video", webm: "video", mkv: "video", mov: "video",
    flv: "video", avi: "video", "3gp": "video", "3g2": "video", mpg: "video",
    mpeg: "video", m3u8: "video", mpd: "video",
    mp3: "audio", m4a: "audio", aac: "audio", oga: "audio", weba: "audio",
    wav: "audio", flac: "audio", opus: "audio", ogg: "audio",
    jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image",
    avif: "image", bmp: "image", svg: "image", ico: "image",
  };

  // 分片/初始化段：它们的扩展名和成品相同（.ts 就是 MPEG-TS），必须优先排除，
  // 否则一个视频会被拆成几百条「视频」条目。.ts 也算——真正要下的 .ts 成片
  // 极少，误伤成本远小于列表被分片淹没。
  var SEGMENT_EXT = new Set([
    "m4s", "m4f", "m4i", "cmfv", "cmfa", "cmft", "ts", "init",
  ]);

  var CT_KIND = [
    [/^video\//i, "video"],
    [/^audio\//i, "audio"],
    [/^image\//i, "image"],
    [/^application\/(vnd\.apple\.mpegurl|x-mpegurl)$/i, "video"],
    [/^application\/dash\+xml$/i, "video"],
  ];

  // 视频 URL 常常没有扩展名、content-type 又是 octet-stream 的几家 CDN。
  // 只作为「octet-stream 兜底」的辅助证据，不单独用来判类型。
  var MEDIA_CDN = /(?:douyinvod|douyinpic|byteimg|bytecdn|ixigua|pstatp|kwaicdn|ks-cdn|hdslb|bilivideo)\./i;

  var MIN_OCTET_BYTES = 1024 * 1024;

  function pathExt(url) {
    try {
      var p = new URL(url).pathname || "";
      var name = p.split("/").filter(Boolean).pop() || "";
      var dot = name.lastIndexOf(".");
      return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    } catch (e) {
      var bare = String(url || "").split(/[?#]/)[0];
      var d2 = bare.lastIndexOf(".");
      return d2 > 0 ? bare.slice(d2 + 1).toLowerCase() : "";
    }
  }

  function kindFromFormat(ext) {
    return FORMAT_KIND[ext] || null;
  }

  function kindFromContentType(ct) {
    var m = String(ct || "").split(";")[0].trim();
    if (!m) return null;
    for (var i = 0; i < CT_KIND.length; i++) {
      if (CT_KIND[i][0].test(m)) return CT_KIND[i][1];
    }
    return null;
  }

  /**
   * 判定一个 URL 是不是可下载的媒体。
   * @param {string} url
   * @param {string} [contentType]  响应头里的 content-type
   * @param {number} [contentLength] 响应头里的 content-length（分段响应时是分段长度）
   * @returns {"video"|"audio"|"image"|null}
   */
  function kindOf(url, contentType, contentLength) {
    var ext = pathExt(url);
    if (SEGMENT_EXT.has(ext)) return null;

    var ct = String(contentType || "").split(";")[0].trim().toLowerCase();

    // 1. 通用二进制：只有「够大 + 有旁证」才认，避免把任意下载文件当视频
    if (ct === "application/octet-stream") {
      var big = !(typeof contentLength === "number" && contentLength > 0) || contentLength >= MIN_OCTET_BYTES;
      if (!big) return null;
      var byExt = kindFromFormat(ext);
      if (byExt) return byExt;
      if (MEDIA_CDN.test(String(url || ""))) return "video";
      return null;
    }

    // 2. Content-Type 优先
    var byCt = kindFromContentType(ct);
    if (byCt) return byCt;

    // 3. content-type 不认识（常见：m3u8 被当成 text/plain，图片被当成 binary）
    //    或压根没有，就退回扩展名。扩展名表里只有媒体类型，非媒体文件不会误判。
    return kindFromFormat(ext);
  }

  root.MSDetect = { kindOf: kindOf };
})(typeof globalThis !== "undefined" ? globalThis : this);
