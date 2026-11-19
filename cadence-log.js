// Cadence log for diagnosis (Claude 2026-11-19). Active only with ?cadencelog in
// the URL (kept for the tab's session). Records, while the user plays on their
// own display, what reaches the screen and why:
//   d  every image drawn: refreshes the previous image stayed (held), fields it
//      moved on (adv), GPU time from submit to done (gpu, filled in later);
//   f  every field: gap since the previous one, the engine's own times from the
//      control block (engine, its wait for the page, sound board, scene wait,
//      board wait), the page's present time, the lock's state, late starts;
//   r  a browser frame later than 1.5 refreshes (a refresh the browser missed);
//   lt a long task on the page's thread (PerformanceObserver);
//   m  F8: the user saw a stutter here;
//   s  every second: the page's Hz counter, drawn images, lock, skipping, hidden.
// Batches go to the local server's POST /__cadence-log (web/tools/serve.js),
// one JSON row per line in build/evidence/cadence_capture_20261119/.
export function startCadenceLog(host) {
  const session = new Date().toISOString().replace(/[:.]/g, '-');
  const t0 = performance.now(), T = t => Math.round((t - t0) * 10) / 10;
  let queue = [], sent = 0, failed = 0, marks = 0;
  const push = row => { queue.push(row); return row; };
  const c = () => host.ctl;
  // The game's own frame (web_bridge.cpp WebFrame word 24, scene_changed): 0 when the
  // game rendered no new scene in this field (it repeated a frame); its phase byte
  // (RAM 0x737b76, 0x10 in a race).
  const guest = () => {
    try {
      const heap = host.heap(), pk = Atomics.load(host.ctl, 2) >>> 0, ram = Atomics.load(host.ctl, 29) >>> 0;
      return { sc: pk ? new Uint32Array(heap.buffer, pk + 24 * 4, 1)[0] : null, ph: ram ? heap[ram + 0x737b76] : null };
    } catch { return {}; }
  };
  // Fields: wrap present (the packet arrives from the engine's worker).
  let lastField = 0, lastLate = 0;
  const present = host.present.bind(host);
  host.present = p => {
    const a = performance.now(), r = present(p), b = performance.now(), ctl = c(), L = host.lock;
    const late = (host.lateStarts || 0) - lastLate; lastLate = host.lateStarts || 0;
    push({ k: 'f', t: T(a), gap: lastField ? +(a - lastField).toFixed(2) : 0, pres: +(b - a).toFixed(2),
      eng: ctl ? ctl[7] / 1000 : null, wait: ctl ? ctl[9] / 1000 : null, snd: ctl ? ctl[11] / 1000 : null,
      scene: ctl ? ctl[19] / 1000 : null, board: ctl ? ctl[21] / 1000 : null,
      due: L ? L.due : null, acc: L ? L.acc : null, late: late || undefined, skip: host.skipping ? 1 : undefined, ...guest() });
    lastField = a; return r;
  };
  // Images: wrap the renderer's draw.
  let lastDraw = 0, lastDrawField = 0;
  const hookRenderer = R => {
    if (!R || R.__cadenceHooked) return; R.__cadenceHooked = true;
    const render = R.render.bind(R);
    R.render = (...args) => {
      const t = performance.now(), out = render(...args), hz = host.lock ? host.lock.hz : 75;
      const row = push({ k: 'd', t: T(t), held: lastDraw ? Math.round((t - lastDraw) * hz / 1000) : 0, adv: host.fields - lastDrawField });
      lastDraw = t; lastDrawField = host.fields;
      R.device?.queue.onSubmittedWorkDone().then(() => { row.gpu = +(performance.now() - t).toFixed(2); });
      return out;
    };
  };
  hookRenderer(host.renderer);
  // Browser frames: one rAF loop of its own.
  let lastRaf = 0;
  const raf = t => { const per = 1000 / (host.lock ? host.lock.hz : 75); if (lastRaf && t - lastRaf > 1.5 * per) push({ k: 'r', t: T(t), gap: +(t - lastRaf).toFixed(2) }); lastRaf = t; requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) push({ k: 'lt', t: T(e.startTime), d: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: false }); } catch {}
  addEventListener('keydown', e => { if (e.code === 'F8') { e.preventDefault(); marks++; push({ k: 'm', t: T(performance.now()) }); badge.style.background = '#d08000'; setTimeout(() => { badge.style.background = '#a40909'; }, 300); } }, true);
  let prevDraws = 0;
  setInterval(() => {
    hookRenderer(host.renderer);
    const d = (host.vsyncDraws || 0) + (host.directDraws || 0);
    push({ k: 's', t: T(performance.now()), hz: +(host.fps?.() || 0).toFixed(2), draws: d - prevDraws, skipped: host.skippedDraws || 0,
      lock: host.lock ? `${host.lock.p}/${host.lock.q}@${host.lock.hz.toFixed(2)}` : null, skipping: host.skipping ? 1 : 0, hidden: document.hidden ? 1 : 0,
      lateStarts: host.lateStarts || 0, w: innerWidth, h: innerHeight, fs: document.fullscreenElement ? 1 : 0 });
    prevDraws = d;
  }, 1000);
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;padding:3px 7px;border-radius:4px;font:11px system-ui;background:#a40909;color:#fff;pointer-events:none;opacity:.8';
  badge.textContent = 'Cadence log';
  (document.body || document.documentElement).append(badge);
  const flush = async () => {
    // Rows from the last second may still wait for their GPU time.
    const cut = T(performance.now()) - 1000, i = queue.findIndex(r => r.t > cut);
    const rows = i < 0 ? queue : queue.slice(0, i); queue = i < 0 ? [] : queue.slice(i);
    if (!rows.length) return;
    try { const r = await fetch('/__cadence-log', { method: 'POST', body: JSON.stringify({ session, rows }), headers: { 'Content-Type': 'text/plain' } }); if (r.ok) sent += rows.length; else failed += rows.length; }
    catch { failed += rows.length; }
    badge.textContent = `Cadence log · ${Math.round(sent / 1000)}k rows · F8 marks: ${marks}` + (failed ? ` · ${failed} not saved` : '');
  };
  push({ k: 'start', t: 0, href: location.href, ua: navigator.userAgent, dpr: devicePixelRatio, screen: `${screen.width}x${screen.height}` });
  setInterval(flush, 3000);
  addEventListener('pagehide', () => { const rows = queue; queue = []; if (rows.length) navigator.sendBeacon?.('/__cadence-log', JSON.stringify({ session, rows })); });
}
