// Cross-origin isolation on static hosting (Claude 2026-11-18): see coi-sw.js.
// A classic script, first in <head>, so the reload happens before anything
// else loads. Without isolation and with a service worker available, it
// registers coi-sw.js and reloads once; a second failure is reported by the
// engine (engine-host.js) instead of looping.
(() => {
  const KEY = 'd2-coi-reload';
  if (window.crossOriginIsolated) { try { sessionStorage.removeItem(KEY); } catch {} return; }   // isolated: a later loss may reload once again
  if (!window.isSecureContext || !navigator.serviceWorker) return;
  let tried = false; try { tried = sessionStorage.getItem(KEY) === '1'; } catch {}
  navigator.serviceWorker.register('./coi-sw.js', { updateViaCache: 'none' }).then(reg => {
    if (tried) { try { sessionStorage.removeItem(KEY); } catch {} return; }
    const reload = () => { try { sessionStorage.setItem(KEY, '1'); } catch {} location.reload(); };
    if (reg.active && navigator.serviceWorker.controller) { reload(); return; }   // active but this load was not controlled
    const w = reg.installing || reg.waiting || reg.active;
    if (w?.state === 'activated') { reload(); return; }
    w?.addEventListener('statechange', () => { if (w.state === 'activated') reload(); });
  }).catch(e => console.warn('[coi] service worker', e));
})();
