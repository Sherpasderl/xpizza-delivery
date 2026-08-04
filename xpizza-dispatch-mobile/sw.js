// Static-shell-only service worker — Phase 1 PWA installability (spec §8).
// It precaches ONLY the app shell and NEVER intercepts the live RTDB/Maps requests: staleness there
// would violate spec §7 ("never present stale data as live"). Offline/badges/push are Phases 2–3.
const SHELL = 'dl-shell-v1';
const ASSETS = [
  './index.html', './xpizza-delivery.js', './board-model.js', './slot-format.js',
  './reassign-model.js', './dispatch-aging.js', './fonts/hankengrotesk-var.woff2', './manifest.json',
];

self.addEventListener('install', (e) => e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS))));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Live data + maps: let them hit the network, always. Never cache, never serve stale.
  if (/firebaseio\.com|googleapis\.com|gstatic\.com/.test(url.host)) return;
  // Everything else (the static shell): network-first, fall back to the cached shell when offline.
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
