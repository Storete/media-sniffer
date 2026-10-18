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
    send(payload) {
      post({ cmd: "host-send", payload });
    },
    // 收到宿主消息（由 content.js 转发）
    deliver(msg) {
      for (const fn of this.listeners.slice()) {
        try { fn(msg); } catch (e) { /* 忽略 */ }
      }
    },
    disconnected(err) {
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
