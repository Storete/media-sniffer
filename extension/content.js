/**
 * content script（isolated world）
 * 搬运层：
 *   页面主世界 hook 的发现结果 → background
 *   popup 的保存指令 → 页面主世界（在主世界里弹浮层，让用户手势落在页面按钮上）
 *   页面主世界 ↔ Native Host 的二进制传输桥
 */
(() => {
  // 只在 http/https 页面上工作。chrome-extension:// 自己的页面（扩展详情里
  // 「检查视图」打开的 popup 等）、chrome:// 内部页不需要嗅探，
  // 也不该往那里转发消息（会刷控制台错误）。
  // 读不到 location 时照常工作，避免非标准环境下被误杀。
  try {
    const proto = location && location.protocol;
    if (typeof proto === "string" && proto && proto !== "http:" && proto !== "https:") return;
  } catch (e) {
    /* location 读不到就继续 */
  }

  const toPage = (msg) => {
    try { window.postMessage({ __ms_sniffer_cmd: true, ...msg }, "*"); } catch (e) { /* 忽略 */ }
  };

  // 页面 → background
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d) return;

    // 页面要跟本地下载器通信（Range 链下载的大块数据走这里）
    if (d.__ms_sniffer_cmd && d.cmd === "host-send") {
      forwardHost(d.payload);
      return;
    }

    if (!d.__ms_sniffer) return;
    // 宿主消息是 background 回的，不往 background 转
    if (d.__ms_sniffer_host) return;
    try {
      chrome.runtime.sendMessage({ type: "ms:page", payload: d });
    } catch (err) {
      // 扩展被重载/失效时 context invalidated。
      //
      // ⚠️ 这里以前是**完全静默**的 —— 结果是「扩展重载后没刷新页面」时，页面里
      // 所有 found 消息全部无声丢失，用户看到的就是「什么都没抓到」，却没有任何
      // 线索指向真正的原因。现在只提示一次（避免每 600ms 刷一条），并在页面上
      // 给一条看得见的话：让人立刻知道该刷新页面，而不是去怀疑功能坏了。
      warnInvalidatedOnce(err);
    }
  });

  /** 扩展上下文失效时，只警告一次（刷屏比沉默更难查）。 */
  let warnedInvalidated = false;
  function warnInvalidatedOnce(err) {
    if (warnedInvalidated) return;
    warnedInvalidated = true;
    const msg = String((err && err.message) || err || "");
    // 只有「真的失效」才提示；其它异常（比如消息太大）不该被当成失效
    if (!/context invalidated|extension context|receiving end/i.test(msg)) return;
    console.warn("[资源嗅探] 扩展已更新过，本页的嗅探脚本已失效 —— 请刷新页面后重试。", msg);
    try {
      window.postMessage({
        __ms_sniffer_stale: true,
        text: "资源嗅探扩展刚更新过，本页需要刷新一次才能继续工作。",
      }, "*");
    } catch (e) { /* 忽略 */ }
  }

  let hostPort = null;

  function fromHost(msg) {
    try { window.postMessage({ __ms_sniffer_host: true, cmd: "host-message", payload: msg }, "*"); } catch (e) { /* 忽略 */ }
  }

  function hostDown(error) {
    try { window.postMessage({ __ms_sniffer_host: true, cmd: "host-disconnected", error: error || "" }, "*"); } catch (e) { /* 忽略 */ }
  }

  /** 把页面发来的请求送进 Native Host 通道 */
  function forwardHost(payload) {
    if (!payload || typeof payload !== "object") return;
    try {
      if (!hostPort) {
        hostPort = chrome.runtime.connect({ name: "ms-host-bridge" });
        hostPort.onMessage.addListener(fromHost);
        hostPort.onDisconnect.addListener(() => {
          const err = chrome.runtime.lastError;
          hostPort = null;
          hostDown(err ? err.message : "本地下载器已断开");
        });
      }
      hostPort.postMessage(payload);
    } catch (err) {
      hostDown(String((err && err.message) || err));
    }
  }

  // popup / background → 页面
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "ms:save") {
      toPage({ cmd: "save", key: msg.key, filename: msg.filename });
      sendResponse({ ok: true });
    } else if (msg.type === "ms:save-batch") {
      toPage({ cmd: "save-batch", items: msg.items || [] });
      sendResponse({ ok: true });
    } else if (msg.type === "ms:rescan") {
      // 让页面主世界重新扫一遍 DOM。很多站的 <video> 是点了播放才挂上的，
      // 重载页面反而会丢掉已缓冲的媒体，所以给一个「就地重扫」的入口。
      toPage({ cmd: "rescan" });
      sendResponse({ ok: true });
    } else if (msg.type === "ms:ping") {
      // popup 打开时用来判断「本页脚本还活着吗」。
      // 能走到这里就说明 content.js 还在；页面主世界的 inject-main 是否还活着
      // 由它自己的 hello 决定，这里只回一个基本存活信号。
      sendResponse({ ok: true, alive: true });
    }
    return true;
  });

  toPage({ cmd: "hello" });
})();
