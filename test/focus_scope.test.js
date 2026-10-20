// 「焦点收窄」回归测试（一期一目标 · 用户 m13863）
//
// 用户原话（m13863）：「像这种一个消息包含多个图片或者视频，当我点开其中任意一个时，
// 列表只会出现该标题下的所有内容而不包含其他消息里的，这个功能实现了吗」
// 追问后确认（m13874 / m13885）：开查看器时自动收窄；统一用 focus() 钩子，
// 小红书/B 站已有等价行为，改成走同一个钩子。
//
// 本文件由 test/background.test.js 末尾 require 进来，共用同一个 check 计数器。

module.exports = function runFocusTests(check) {
  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

  const dir = __dirname;
  const bgCode = fs.readFileSync(path.join(dir, "..", "extension", "background.js"), "utf8");
  const mainCode = fs.readFileSync(path.join(dir, "..", "extension", "inject-main.js"), "utf8");

  function extractFn(src, name) {
    const start = src.indexOf("function " + name + "(");
    if (start < 0) return null;
    let i = src.indexOf("{", start), depth = 0, inStr = null, esc = false;
    for (; i < src.length; i++) {
      const c = src[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    return null;
  }

  // ---------------------------------------------------------------- [F1] background 侧

  console.log("\n[F1] background：焦点过滤只保留同一条消息的条目");

  const fn = extractFn(bgCode, "applyFocusFilter");
  if (!fn) {
    check("[F1] background.js 应提供 applyFocusFilter(items, focus)", false, "未找到 applyFocusFilter");
  } else {
    const ctx = vm.createContext({ console, Map, Set, String, Number, Object, Array });
    vm.runInContext(fn, ctx, { filename: "applyFocusFilter" });
    const apply = (items, focus) => ctx.applyFocusFilter(items, focus);

    const mk = (o) => Object.assign({ u: "u", k: "image", mid: "", title: "" }, o);

    // 用户真机形态：一条消息 9 个媒体，另有别的频道消息
    const items = [
      mk({ u: "a1", mid: "8928", title: "鱼哥又吃嫩货了" }),
      mk({ u: "a2", mid: "8928", title: "鱼哥又吃嫩货了" }),
      mk({ u: "a3", mid: "8928", title: "鱼哥又吃嫩货了" }),
      mk({ u: "b1", mid: "9001", title: "别的消息" }),
      mk({ u: "c1", mid: "", title: "无消息号" }),
    ];

    {
      const got = apply(items, { mid: "8928" }).map((x) => x.u).join(",");
      check("[F1] 焦点=8928 时只留这 3 条（期望 a1,a2,a3）", got === "a1,a2,a3", got);
    }
    {
      const got = apply(items, null).map((x) => x.u).join(",");
      check("[F1] 无焦点时原样返回（5 条）", got === "a1,a2,a3,b1,c1", got);
    }
    {
      const got = apply(items, {}).map((x) => x.u).join(",");
      check("[F1] 空焦点对象等价于无焦点", got === "a1,a2,a3,b1,c1", got);
    }
    {
      // 焦点 id 在本页没匹配到任何条目 —— 宁可显示全量，也别显示空列表
      const got = apply(items, { mid: "9999" }).map((x) => x.u).join(",");
      check("[F1] 焦点匹配不到任何条目时退回全量（不显示空列表）",
        got === "a1,a2,a3,b1,c1", got);
    }
    {
      // 焦点类型必须和条目对齐，不能只比 id
      const mixed = [
        mk({ u: "x1", mid: "8928", noteId: "" }),
        mk({ u: "x2", mid: "8928", noteId: "n1" }),
      ];
      const got = apply(mixed, { kind: "note", id: "8928" }).map((x) => x.u).join(",");
      check("[F1] 焦点带 kind=note 时不匹配 Telegram 的 mid", got === "x1,x2", got);
    }
  }

  // ---------------------------------------------------------------- [F2] 页面侧 focus() 钩子

  console.log("\n[F2] inject-main：站点对象提供 focus() 钩子");

  check("[F2] SITES 钩子清单里写明了 focus()",
    /focus\(\)\s+当前焦点/.test(mainCode) || /focus\(\)[^\n]*当前焦点/.test(mainCode),
    "钩子注释里没找到 focus()");
  check("[F2] 有 tgFocus 实现（Telegram 查看器反查消息 id）",
    /function tgFocus\s*\(/.test(mainCode), "未找到 tgFocus");
  check("[F2] 有 reportFocus（焦点变化时上报）",
    /function reportFocus\s*\(/.test(mainCode), "未找到 reportFocus");
  check("[F2] post() 会给 found/progress 补 focus 字段（或单独发 focus 指令）",
    /cmd:\s*"focus"/.test(mainCode), "未找到 cmd:\"focus\"");
  check("[F2] 小红书站点对象实现了 focus",
    /name:\s*"xiaohongshu"[\s\S]{0,600}?focus:/.test(mainCode),
    "小红书对象里没有 focus");
  check("[F2] B 站站点对象实现了 focus（若有 B 站对象）",
    !/name:\s*"bilibili"/.test(mainCode) || /name:\s*"bilibili"[\s\S]{0,600}?focus:/.test(mainCode),
    "B 站对象里没有 focus");

  // ---------------------------------------------------------------- [F3] popup 侧

  console.log("\n[F3] popup：列表按焦点收窄，且给用户一个明显提示");

  const popCode = fs.readFileSync(path.join(dir, "..", "extension", "popup.js"), "utf8");
  const popHtml = fs.readFileSync(path.join(dir, "..", "extension", "popup.html"), "utf8");

  check("[F3] popup 读取 res.focus", /res\.focus|\.focus\b/.test(popCode), "popup 没读 focus");
  check("[F3] popup 有「只看当前消息」的提示条元素",
    /id="focusBar"/.test(popHtml), "popup.html 没有 #focusBar");
  check("[F3] popup 有退出焦点的入口",
    /#focusExit/.test(popCode) && /id="focusExit"/.test(popHtml), "没有 focusExit 按钮");
};
