// Room notifications for Daytona USA 2 (Claude 2026-11-12), after Daytona USA
// Web's room-alerts-sw.js: notification delivery only. No fetch handler,
// cache, push subscription or ROM access.
const appURL = new URL('./', self.location.href);
const KINDS = ['joined', 'request', 'waiting', 'left', 'stalled'];
const sameApp = client => { try { const url = new URL(client.url); return url.origin === appURL.origin && (url.pathname === appURL.pathname || url.pathname === appURL.pathname + 'index.html'); } catch { return false; } };
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  const client = event.source, data = event.data;
  if (!client?.id || !sameApp(client) || typeof data?.stamp !== 'string' || data.stamp.length > 80) return;
  if (data.type === 'daytona2-room-alert-close') {
    event.waitUntil(self.registration.getNotifications().then(list => { for (const n of list) if (n.data?.clientId === client.id && n.data?.stamp === data.stamp) n.close(); }));
    return;
  }
  if (data.type !== 'daytona2-room-alert' || !KINDS.includes(data.kind) || typeof data.title !== 'string' || data.title.length > 80 || typeof data.body !== 'string' || data.body.length > 160 || typeof data.tag !== 'string' || data.tag.length > 180) return;
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, tag: data.tag, silent: true, icon: new URL('img/daytona-usa-2-logo.png', appURL).href,
    data: { clientId: client.id, stamp: data.stamp, kind: data.kind } }).catch(() => {}));
});
self.addEventListener('notificationclick', event => {
  event.notification.close(); const data = event.notification.data;
  if (!data?.clientId) return;
  event.waitUntil((async () => {
    const client = await self.clients.get(data.clientId);
    if (client && sameApp(client)) { await client.focus(); client.postMessage({ type: 'daytona2-room-alert-click', stamp: data.stamp, kind: data.kind }); }
  })());
});
