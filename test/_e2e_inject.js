const out = await page.evaluate(`(() => {
  try {
    window.__msOut = [];
    if (!window.__msOutHook) {
      window.__msOutHook = true;
      window.addEventListener('message', (e) => {
        const d = e.data;
        if (d && d.__ms_sniffer_cmd) window.__msOut.push(d);
      });
    }
    const mk = (src) => { const s = document.createElement('script'); s.textContent = src; (document.head || document.documentElement).appendChild(s); s.remove(); };
    mk(hp);
    mk(main);
    return { ok: true, scan: typeof window.__msScan, port: !!(window.__msHostPort) };
  } catch (e) { return { ok: false, err: String(e && e.stack || e) }; }
})()`);
console.log(JSON.stringify(out));

