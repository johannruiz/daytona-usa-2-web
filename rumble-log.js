// Controller vibration log for diagnosis (Claude 2026-11-11). Active only with
// ?rumblelog in the URL. Records, while the user plays on their own controller:
// every vibration command any code in the page sends (GamepadHapticActuator
// playEffect / reset), the engine's rumble outputs, the drive board commands
// the game wrote (dayto_web_drive_ring_*), the controller's axes and buttons,
// the input sent to the game and focus / menu state. Batches are posted to the
// local diagnostic server (scripts/web_followup_serve.mjs, POST /__rumble-log).
export function startRumbleLog({ getModule, getInput, menuOpen }) {
  const session = new Date().toISOString().replace(/[:.]/g, '-');
  let queue = [], ringRead = 0, lastPad = '';
  const push = row => { row.t = Math.round(performance.now()); queue.push(row); };
  const proto = globalThis.GamepadHapticActuator?.prototype;
  if (proto?.playEffect) {
    const play = proto.playEffect, reset = proto.reset;
    proto.playEffect = function (type, params = {}) {
      push({ k: 'fx', type, s: +(params.strongMagnitude ?? 0).toFixed(3), w: +(params.weakMagnitude ?? 0).toFixed(3),
             d: params.duration, ls: params.leftTrigger, rs: params.rightTrigger, stack: new Error().stack.split('\n').slice(2, 4).join(' | ') });
      return play.call(this, type, params);
    };
    if (reset) proto.reset = function () { push({ k: 'reset' }); return reset.call(this); };
  }
  // Same origin on the diagnostic server; from the user's own server (8160) the
  // rows go to the diagnostic server on 8162 (CORS), tried on both loopback names.
  const targets = ['/__rumble-log', 'http://127.0.0.1:8162/__rumble-log', 'http://localhost:8162/__rumble-log'];
  let target = 0, sent = 0, failed = 0;
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;padding:4px 8px;border-radius:4px;font:12px system-ui;background:#a40909;color:#fff;pointer-events:none';
  badge.textContent = 'Vibration log: starting';
  (document.body || document.documentElement).append(badge);
  const post = async body => {
    for (let i = 0; i < targets.length; i++) {
      const url = targets[(target + i) % targets.length];
      try { const r = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: body.length < 60000 });
        if (r.ok) { target = (target + i) % targets.length; return true; } } catch {}
    }
    return false;
  };
  const flush = async () => {
    if (!queue.length) return;
    const rows = queue; queue = [];
    if (await post(JSON.stringify({ session, rows }))) sent += rows.length; else failed += rows.length;
    badge.textContent = `Vibration log: ${sent} rows sent` + (failed ? `, ${failed} not delivered (is the diagnostic server on 8162 running?)` : '');
  };
  push({ k: 'start', href: location.href, ua: navigator.userAgent });
  setInterval(flush, 2000);
  addEventListener('pagehide', flush);
  let tick = 0;
  return function onField() {
    const M = getModule(); if (!M?._dayto_web_rumble_strong) return;
    if (M._dayto_web_drive_ring_count) {
      const n = M._dayto_web_drive_ring_count() >>> 0;
      if (n - ringRead > 1024) ringRead = n - 1024;
      for (; ringRead < n; ringRead++) { const e = M._dayto_web_drive_ring_at(ringRead) >>> 0; push({ k: 'cmd', f: e >>> 8, c: (e & 255).toString(16).padStart(2, '0') }); }
    }
    if (++tick % 3) return;
    const pads = [...(navigator.getGamepads?.() ?? [])].filter(Boolean);
    const pad = pads[0], key = pads.map(p => `${p.index}:${p.id}:${p.mapping}:${!!p.vibrationActuator}`).join(' / ');
    if (key !== lastPad) { lastPad = key; push({ k: 'pads', pads: key }); }
    const input = getInput();
    const sfx = M._dayto_web_sfx_low ? { lo: +M._dayto_web_sfx_low().toFixed(4), fu: +M._dayto_web_sfx_full().toFixed(4), im: +M._dayto_web_sfx_impact().toFixed(3) } : {};
    push({ k: 'field', ...sfx, s: +M._dayto_web_rumble_strong().toFixed(3), w: +M._dayto_web_rumble_weak().toFixed(3),
           focus: document.hasFocus(), hidden: document.hidden, menu: menuOpen(),
           axes: pad ? pad.axes.map(v => +v.toFixed(2)) : null,
           buttons: pad ? pad.buttons.map((b, i) => b.pressed || b.value > 0.05 ? `${i}:${b.value.toFixed(2)}` : null).filter(Boolean) : null,
           steer: input?.steer, accel: input?.accel, brake: input?.brake });
  };
}
