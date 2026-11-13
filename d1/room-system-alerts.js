// System notifications for the room (Claude 2026-11-12), after Daytona USA
// Web's room-system-alerts.js (53.8.57). Every cabinet in a room hears about
// drivers joining, leaving or stopping; the host also about join requests.
// Shown only while this page is in the background (hidden or unfocused): in
// front, the lobby sound and notices already say it. The permission is asked
// from the Create room / Join gestures, never on a visit; a refusal or a
// browser without notifications never blocks the room. Delivery goes through
// room-alerts-sw.js (notifications only), with the page constructor as a
// fallback. Nothing is sent anywhere; the page must stay open.
import { arrivalRoomKey } from './room-arrivals.js';
const KINDS = ['joined', 'request', 'waiting', 'left', 'stalled'];
const active = s => s && [...(s.members || []), ...(s.waiters || [])].some(p => p.id === s.id) && ['lobby', 'playing', 'waiting'].includes(s.phase);

export function createRoomSystemAlerts({ NotificationAPI = globalThis.Notification, serviceWorkers = globalThis.navigator?.serviceWorker, secure = globalThis.isSecureContext,
  onClick = () => {}, background = () => document.hidden || !document.hasFocus(), focusWindow = () => globalThis.focus(),
  token = () => globalThis.crypto?.randomUUID?.() || Date.now() + '-' + Math.random().toString(36).slice(2),
  workerURL = new URL('../room-alerts-sw.js', import.meta.url), icon = new URL('../img/daytona-usa-2-logo.png', import.meta.url).href } = {}) {
  let state = null, key = '', stamp = '', live = false, asked = false, registration = null, workerPromise = null;
  const notices = new Set();
  const allowed = () => secure && NotificationAPI?.permission === 'granted';
  const current = (event, savedStamp = stamp) => active(state) && arrivalRoomKey(state) === event.roomKey && savedStamp === stamp;
  function ensureWorker() {
    if (!serviceWorkers || !allowed()) return Promise.resolve(null);
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
      try {
        registration = await serviceWorkers.register(workerURL.href, { updateViaCache: 'none' });
        const worker = registration.active || registration.installing || registration.waiting;
        if (!worker) return null;
        if (worker.state === 'activated') return worker;
        return await new Promise(resolve => {
          let timer; const finish = value => { clearTimeout(timer); worker.removeEventListener('statechange', changed); resolve(value); };
          const changed = () => { if (worker.state === 'activated') finish(worker); else if (worker.state === 'redundant') finish(null); };
          timer = setTimeout(() => finish(null), 5000); worker.addEventListener('statechange', changed); changed();
        });
      } catch { return null; }
    })().then(worker => { if (!worker) workerPromise = null; return worker; });
    return workerPromise;
  }
  serviceWorkers?.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== registration?.active || data?.type !== 'daytona2-room-alert-click' || data.stamp !== stamp || !KINDS.includes(data.kind) || !active(state)) return;
    onClick({ kind: data.kind });
  });
  function clear(oldStamp) {
    for (const n of notices) n.close(); notices.clear();
    if (oldStamp) try { registration?.active?.postMessage({ type: 'daytona2-room-alert-close', stamp: oldStamp }); } catch {}
  }
  return {
    sync(next) {
      const nextKey = arrivalRoomKey(next), nextLive = active(next);
      if (key !== nextKey) { clear(stamp); key = nextKey; stamp = key ? token() : ''; } else if (live && !nextLive) clear(stamp);
      state = next; live = nextLive;
    },
    // Called synchronously from the Create room / Join click.
    enable() {
      if (!secure || !NotificationAPI) return Promise.resolve(false);
      if (allowed()) return ensureWorker().then(() => true);
      if (NotificationAPI.permission !== 'default' || asked) return Promise.resolve(false);
      asked = true; let result;
      try { result = NotificationAPI.requestPermission(); } catch { return Promise.resolve(false); }
      return Promise.resolve(result).then(p => p === 'granted' ? ensureWorker().then(() => true) : false).catch(() => false);
    },
    async show(event) {
      if (!KINDS.includes(event.kind) || event.kind === 'request' && !state?.isHost || !allowed() || !current(event) || !background()) return false;
      const savedStamp = stamp, worker = await ensureWorker();
      if (!allowed() || !current(event, savedStamp)) return false;
      const room = event.roomName || 'the room';
      const title = 'Daytona USA 2 · ' + { request: 'Join request', joined: 'Driver joined', waiting: 'Driver waiting', left: 'Driver left', stalled: 'Driver stopped responding' }[event.kind];
      const body = { request: `${event.name} asked to join ${room}.`, joined: `${event.name} joined ${room}${event.cabinet ? ` · car ${event.cabinet}` : ''}.`,
        waiting: `${event.name} is waiting in ${room} for the next race.`, left: `${event.name} left ${room}.`,
        stalled: `${event.name} stopped responding and is out of this race.` }[event.kind];
      const tag = `daytona2-${savedStamp}-${event.kind}-${event.id}`.slice(0, 180);
      if (worker) { try { worker.postMessage({ type: 'daytona2-room-alert', title, body, tag, stamp: savedStamp, kind: event.kind }); return true; } catch {} }
      try {
        const n = new NotificationAPI(title, { body, tag, silent: true, icon }); notices.add(n);
        n.onclose = () => notices.delete(n);
        n.onclick = () => { n.close(); if (current(event, savedStamp)) { focusWindow(); onClick(event); } };
        return true;
      } catch { return false; }
    },
    dispose() { clear(stamp); state = null; key = ''; stamp = ''; live = false; },
  };
}
