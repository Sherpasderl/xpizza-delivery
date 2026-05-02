// X Pizza Driver — service worker
// v2: install registration + Web Push handlers
// Still NO fetch interception (intercepting breaks Firebase Auth + RTDB WebSockets).

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// No fetch handler — let the browser handle all network requests directly.

// ============================================================
// Web Push: receive push from server, show notification
// ============================================================
self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try { payload = event.data.json(); }
    catch { payload = { title: 'X Pizza', body: event.data.text() }; }
  }

  const title = payload.title || '¡Nuevo pedido!';
  const options = {
    body: payload.body || '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: payload.tag || 'xpizza-order',
    requireInteraction: true,    // sticks until user dismisses or taps
    vibrate: [200, 100, 200, 100, 200],
    data: payload.data || {}
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ============================================================
// User taps notification → focus existing window or open new one
// ============================================================
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    // If app is already open in a tab/window, focus it
    for (const client of allClients) {
      if (client.url.includes(self.location.host) && 'focus' in client) {
        return client.focus();
      }
    }

    // Otherwise open the app fresh
    if (self.clients.openWindow) {
      return self.clients.openWindow('/');
    }
  })());
});
