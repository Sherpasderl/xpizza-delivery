// X Pizza Dispatch - minimal service worker (v1.1.0)
// install registration only, no fetch interception

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
