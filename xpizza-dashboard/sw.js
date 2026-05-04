// Minimal service worker — required for PWA install criteria.
// Doesn't cache anything (dashboard always wants fresh data).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});  // pass-through
