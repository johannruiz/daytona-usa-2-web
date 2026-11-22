// Arcade FFB Helper client for the game pages (Daytona USA, Daytona USA 2, Scud Race).
//
// Include it once, after window.arcadeForceFeedback exists (or before: it reads it lazily).
// It does nothing until the player turns it on, because the first connection to the helper
// on 127.0.0.1 makes Chrome ask for "local network access":
//
//   arcadeFfbHelper.enable()      // from the game's settings ("Wheel force feedback: FFB Helper")
//   arcadeFfbHelper.disable()
//   arcadeFfbHelper.onChange((status, info) => ...)
//     status: 'off' | 'connecting' | 'connected' | 'waiting' (helper not running; retries)
//     info:   { version, wheel: true|false, device: 'Logitech G29 ...' } once connected
//
// Opening a game with ?ffb=helper in the URL turns it on as well.
// Protocol: see src/main.c in github.com/johannruiz/arcade-ffb-helper. The page only forwards its own forces; the helper shapes them
// with the player's settings and stops the wheel by itself if the page goes quiet.
(function () {
  'use strict';
  if (window.arcadeFfbHelper) return;
  const PORT = 47823;
  const KEY = 'arcadeFfbHelper';
  let ws = null, pumpTimer = 0, retryTimer = 0, retries = 0;
  let status = 'off', info = null, last = '', lastSent = 0;
  const listeners = new Set();

  const store = {
    get() { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } },
    set(on) { try { on ? localStorage.setItem(KEY, '1') : localStorage.removeItem(KEY); } catch {} },
  };
  try { if (new URLSearchParams(location.search).get('ffb') === 'helper') store.set(true); } catch {}

  function setStatus(s) {
    status = s;
    for (const fn of listeners) { try { fn(status, info); } catch {} }
  }
  const num = v => (Number.isFinite(v) ? v : 0).toFixed(3);

  function pump() {
    if (!ws || ws.readyState !== 1) return;
    let f = null;
    try { f = window.arcadeForceFeedback?.read?.(); } catch {}
    const line = f && f.live
      ? `f 1 ${num(f.constant)} ${num(f.spring)} ${num(f.damper)} ${num(f.friction)} ${num(f.rumble)}`
      : 'f 0 0 0 0 0 0';
    const now = performance.now();
    if (line === last && now - lastSent < 200) return; // keep-alive every 200 ms (the helper stops at 300)
    last = line; lastSent = now;
    ws.send(line);
  }

  function connect() {
    clearTimeout(retryTimer);
    if (ws || !store.get()) return;
    setStatus(retries ? 'waiting' : 'connecting');
    let sock;
    try { sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws/game`); } catch { return retry(); }
    ws = sock;
    sock.onopen = () => {
      retries = 0;
      const api = window.arcadeForceFeedback;
      sock.send(`hello ${api?.game || 'unknown'} ${api?.version || 0}`);
      last = '';
      pumpTimer = setInterval(pump, 8);
    };
    sock.onmessage = e => {
      if (typeof e.data !== 'string' || !e.data.startsWith('hi ')) return;
      const [, version, wheel, ...name] = e.data.split(' ');
      info = { version, wheel: wheel === '1', device: name.join(' ') };
      setStatus('connected');
    };
    sock.onerror = () => {};
    sock.onclose = () => {
      if (ws !== sock) return;
      clearInterval(pumpTimer);
      ws = null; info = null;
      if (!store.get()) return setStatus('off');
      retry();
    };
  }
  function retry() {
    ws = null;
    setStatus('waiting');
    retryTimer = setTimeout(connect, Math.min(5000, 1000 * 2 ** retries++));
  }

  window.arcadeFfbHelper = Object.freeze({
    get enabled() { return store.get(); },
    get status() { return status; },
    get info() { return info; },
    enable() { store.set(true); retries = 0; connect(); },
    disable() {
      store.set(false);
      clearTimeout(retryTimer); clearInterval(pumpTimer);
      const s = ws; ws = null; info = null;
      if (s) { try { if (s.readyState === 1) s.send('f 0 0 0 0 0 0'); s.close(); } catch {} }
      setStatus('off');
    },
    onChange(fn) { listeners.add(fn); try { fn(status, info); } catch {} return () => listeners.delete(fn); },
  });
  if (store.get()) connect();
})();
