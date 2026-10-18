/* 页面内 hook 与本地下载器之间的消息端口。
 *
 * 与 inject-main.js 同处 MAIN world：content script 按顺序先跑本文件、再跑 inject-main.js，
 * 两个经典脚本共享同一个全局作用域，所以这里的 const 能直接被 inject-main.js 用到。
 *
 * 为什么要拆出来：Chrome 的 executeScript({world:'MAIN'}) 每条脚本是独立的经典脚本，
 * 顶层 const 天生挂在共享的全局词法环境上，拆开后调试和注入单文件都更方便。
 *
 * 消息路径：本文件 → content.js → background → Native Host（二进制安全，不经 JSON 序列化）
 */
(function () {
  const post = (data) => {
    try { window.postMessage(Object.assign({ __ms_sniffer_cmd: true }, data), "*"); } catch (e) { /* 忽略 */ }
  };

  const hostPort = {
    listeners: [],
    // 端口断开后再 send 等于往黑洞里扔：没人会回，调用方只能等到超时。
    // 这里直接抛，让 hostRequest / msfile 立刻失败并把「扩展已更新，请刷新页面」
    // 这句提示送到浮层上（刷新页面就会用上新扩展，问题一次性解决）。
    disconnectedFlag: false,
    send(payload) {
      if (this.disconnectedFlag) {
        const e = new Error("与本地下载器的连接已断开（扩展可能刚更新过，请刷新本页）");
        e.disconnected = true;
        throw e;
      }
      post({ cmd: "host-send", payload });
    },
    // 收到宿主消息（由 content.js 转发）
    deliver(msg) {
      for (const fn of this.listeners.slice()) {
        try { fn(msg); } catch (e) { /* 忽略 */ }
      }
    },
    // 连接断开时必须同时把「正在等回执」的调用方打醒。
    //
    // 曾经的坑（真机：点保存后浮层永远停在「正在读取媒体信息…」）：
    // 端口一断就 this.listeners.length = 0，把等待者全清空，但**从不让它们 reject**。
    // hostRequest 的 45s 超时根本没机会生效（它的监听器已经被清掉了），
    // Promise 永久 pending。扩展被重载（loadUnpacked / 更新）后旧页面都会这样。
    disconnected(err) {
      this.disconnectedFlag = true;
      // 先置位，后续 send 直接抛错，不再静默丢进黑洞
      for (const fn of this.listeners.slice()) {
        try { fn({ __disconnected: true, error: err }); } catch (e) { /* 忽略 */ }
      }
      this.listeners.length = 0;
    },
    on(fn) { this.listeners.push(fn); },
    off(fn) {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    },
  };

  try {
    if (!window.__msHostPort) window.__msHostPort = hostPort;
  } catch (e) { /* 忽略 */ }
})();
