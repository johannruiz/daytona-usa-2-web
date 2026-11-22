// Cross-origin isolation for static hosting (Claude 2026-11-18).
//
// The engine shares its memory with this page and its threads
// (SharedArrayBuffer), which browsers allow only on a cross-origin isolated
// page: the document must be served with
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: credentialless (or require-corp)
// GitHub Pages cannot set response headers, so this service worker adds them
// to every response of the site itself (the same technique as the MIT
// coi-serviceworker project; written here from scratch). The first visit
// registers it and reloads once (coi-register.js); later visits are isolated
// from the start. Servers that already send the headers (web/tools/serve.js)
// are left as they are.
//
// COEP credentialless (Chrome, Edge, Firefox) lets cross-origin resources that
// need no credentials load as before (the Firebase SDK, PeerJS signalling and
// the TURN worker use CORS anyway); Safari, which lacks it, gets require-corp.
// The same worker also delivers the room notices (room-alerts-sw.js): one
// service worker per scope.
importScripts('./room-alerts-sw.js');

const coep = /Safari\//.test(navigator.userAgent) && !/Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent) ? 'require-corp' : 'credentialless';
self.addEventListener('fetch', event => {
  const r = event.request;
  if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
  const url = new URL(r.url);
  if (url.origin !== self.location.origin) return;   // only the site's own responses get the headers
  // Every file of the site is revalidated with the server (an unchanged one costs a 304). GitHub Pages
  // lets the browser keep each file 10 minutes, so right after a publication a page could mix new and
  // old modules: v0.10.3's main.js ran with v0.10.2's version.js and joined rooms as 0.10.2 (2026-11-21).
  let req = r;
  if (r.method === 'GET' && (r.cache === 'default' || r.cache === 'force-cache')) {
    req = r.mode === 'navigate' ? new Request(r.url, { cache: 'no-cache', credentials: 'same-origin' }) : new Request(r, { cache: 'no-cache' });
  }
  event.respondWith((async () => {
    let response;
    try { response = await fetch(req); } catch (e) { return Response.error(); }
    if (response.status === 0 || response.type === 'opaque') return response;
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', coep);
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  })());
});
