// 通用媒体判定（extension/detect.js）的单元测试。
//
// 这个文件是纯函数，不依赖 Chrome；测试直接把它读进 vm 跑。
// 重点是那几条「以前会判错」的情况：octet-stream、无扩展名 CDN、分片。
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FILE = path.join(__dirname, "..", "extension", "detect.js");
const sandbox = { URL, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(FILE, "utf8"), sandbox, { filename: "detect.js" });

const D = sandbox.MSDetect;
let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name + "  -> got " + JSON.stringify(got) + ", want " + JSON.stringify(want)); }
}

console.log("[1] Content-Type 优先");
check("video/mp4", D.kindOf("https://x.com/a", "video/mp4", 0), "video");
check("audio/mpeg", D.kindOf("https://x.com/a", "audio/mpeg", 0), "audio");
check("image/jpeg", D.kindOf("https://x.com/a", "image/jpeg", 0), "image");
check("m3u8 playlist 头", D.kindOf("https://x.com/list", "application/vnd.apple.mpegurl", 0), "video");
check("dash 头", D.kindOf("https://x.com/m.mpd", "application/dash+xml", 0), "video");
check("带 charset 也能认", D.kindOf("https://x.com/a", "video/mp4; charset=utf-8", 0), "video");

console.log("[2] 分片必须排除（否则一个视频变几百条）");
for (const ext of ["m4s", "cmfv", "cmfa", "cmft", "ts", "m4f", "m4i"]) {
  check("." + ext + " 分片", D.kindOf("https://x.com/seg/1." + ext, "video/mp4", 0), null);
}
check("分片优先于 content-type", D.kindOf("https://x.com/a.ts", "video/mp2t", 999999), null);

console.log("[3] octet-stream：必须有大体积 + 旁证");
check("无扩展名 + 2MB + 未知站 → 不认",
  D.kindOf("https://x.com/abc123", "application/octet-stream", 2 * 1024 * 1024), null);
check("无扩展名 + 2MB + 已知 CDN → video",
  D.kindOf("https://v3-web.douyinvod.com/abc123", "application/octet-stream", 2 * 1024 * 1024), "video");
check("有扩展名 + 2MB → video",
  D.kindOf("https://x.com/v.mp4", "application/octet-stream", 2 * 1024 * 1024), "video");
check("有扩展名但只有 10KB → 不认（可能是占位/雪碧图）",
  D.kindOf("https://x.com/v.mp4", "application/octet-stream", 10 * 1024), null);

console.log("[4] 没有 content-type 时退回扩展名");
check("无 CT + .mp4", D.kindOf("https://x.com/v.mp4", "", 0), "video");
check("无 CT + .m3u8", D.kindOf("https://x.com/v.m3u8", null, 0), "video");
check("无 CT + .jpg", D.kindOf("https://x.com/a.jpg", "", 0), "image");
check("无 CT + .pdf → null", D.kindOf("https://x.com/a.pdf", "", 0), null);
check("无 CT + 无扩展名 → null", D.kindOf("https://x.com/abc", "", 0), null);

console.log("[5] 非媒体 content-type 不该被扩展名带偏成可下载媒体");
check("application/pdf", D.kindOf("https://x.com/a.pdf", "application/pdf", 1024), null);
check("text/html", D.kindOf("https://x.com/a.html", "text/html", 1024), null);
check("application/json", D.kindOf("https://x.com/a.json", "application/json", 1024), null);
check("m3u8 但 CT 是 text/plain（很常见）→ 仍认",
  D.kindOf("https://x.com/v.m3u8", "text/plain", 500), "video");

console.log("[6] 边界");
check("空 URL", D.kindOf("", "video/mp4", 0), "video");
check("查询串不影响扩展名", D.kindOf("https://x.com/v.mp4?token=abc&x=1", "", 0), "video");
check("大写扩展名", D.kindOf("https://x.com/V.MP4", "", 0), "video");

console.log("\n==============================================");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
