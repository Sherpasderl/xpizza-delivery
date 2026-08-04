// Static-shell service worker + Phase-2a staff web push. Precaches ONLY the app shell and NEVER
// intercepts live RTDB/Maps requests (staleness would violate "never present stale data as live").
// v3: skipWaiting()/clients.claim() so a deployed SW/push update takes control of existing installs
//     immediately (else it stays 'waiting' until every tab closes — a re-install for the owner).
const SHELL = 'dl-shell-v4';
const ASSETS = [
  './index.html', './xpizza-delivery.js', './board-model.js', './slot-format.js',
  './reassign-model.js', './dispatch-aging.js', './driver-glide.js', './push-support.js', './fonts/hankengrotesk-var.woff2', './manifest.json',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();   // don't wait for all tabs to close — activate the new SW as soon as it installs
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)));
});
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())   // take control of already-open clients now, so the update reaches them
));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Live data + maps: let them hit the network, always. Never cache, never serve stale.
  if (/firebaseio\.com|googleapis\.com|gstatic\.com/.test(url.host)) return;
  // Everything else (the static shell): network-first, fall back to the cached shell when offline.
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

// ── Phase 2a: staff web push ── payload {title, body, tag, data:{orderId?}} ──
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(d.title || 'Dispatch', {
    body: d.body || '', tag: d.tag || 'dispatch', data: d.data || {}, renotify: true,
    icon: './icon-192.png', badge: './icon-192.png',
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const orderId = e.notification.data && e.notification.data.orderId;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find((c) => c.url.includes(self.registration.scope)) || all[0];
    if (client) { await client.focus(); client.postMessage({ type: 'open-order', orderId }); }
    else { await self.clients.openWindow(orderId ? `./index.html#order=${orderId}` : './index.html'); }
  })());
});
