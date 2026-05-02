# X Pizza Dispatch — Deploy Guide

The browser app the dispatcher uses to monitor drivers, see incoming orders, and assign deliveries. Designed for laptop or tablet.

## Files

- `index.html` — main app
- `xpizza-delivery.js` — shared SDK
- `manifest.json`, `sw.js`, `icon.svg` — PWA setup
- `README.md` — this file

## Deploy to Netlify

1. Go to https://app.netlify.com → **Add new site → Deploy manually**
2. Drag this entire folder (`xpizza-dispatch`) onto the drop zone
3. Site Settings → Change site name → `xpizzadispatch`
4. URL is now `https://xpizzadispatch.netlify.app`

## First-run setup

1. Open `https://xpizzadispatch.netlify.app` (or `http://localhost:8000` for local testing)
2. App shows the **Configuración inicial** screen
3. Paste two things:
   - **Firebase config JSON** (same one as the test harness and driver app)
   - **Google Maps API key** (the one you locked to `xpizzadispatch.netlify.app/*` in Cloud Console)
4. Click **Guardar y entrar**
5. Login screen → sign in as your dispatcher account (`sherpasderl@gmail.com`)

Both are stored in localStorage so you only do this once per browser/device. If you later change the Maps key or add a new dispatcher to a new laptop, just paste again.

## Daily use

- **Top bar** shows live counts: drivers in turno / pendientes / activos / delivered today
- **Left sidebar** has three sections:
  - **Drivers** — every active driver with status, ping freshness, distance to base. Click any card to pan the map to that driver.
  - **Nuevos pedidos** — orders waiting for assignment. Each card shows customer + address + total + payment method. Click the card to fit the map between restaurant and customer. Click **Asignar** to open the driver picker.
  - **En proceso** — orders being delivered, with assigned driver and current phase. Click to fit map between restaurant + customer + driver.
- **Map**: live-updating markers
  - **Red XP pin**: the restaurant, with a 50m geofence circle
  - **Colored circles with initials**: drivers (green = available/at restaurant, blue = en route delivery, amber = returning/assigned, grey = stale GPS)
  - **Drop pins**: customer locations for active orders (amber = awaiting pickup, blue = en route)

## Order assignment workflow

1. New order arrives → audible chime + visual flash on the order card + toast notification
2. Click **Asignar** on the order card
3. Driver picker overlay appears with all active drivers, sorted by **readiness for pickup**:
   - At restaurant (instant pickup) shows first
   - Available drivers next, sorted by distance to restaurant
   - Returning drivers next (incoming, sort by distance to base)
   - Busy drivers last (en route delivery / already assigned) — shown but click requires confirmation
4. Each driver row shows distance to base AND distance to customer. Pick whichever fits best — usually the top one is correct, but you can override based on the customer being on someone's existing route.
5. Click a driver → both pickup + delivery tasks atomically assigned. Order moves from Pendientes to Activos. Driver gets the chime + active card on their phone.

## Map controls

- **Mouse/touch** — pan and zoom normally
- **Centrar mapa** (top right) — auto-fit to show restaurant + all active drivers + all active customers
- **Ocultar panel** (top left) — collapse the sidebar for full-screen map

## Important: Google Maps API key restrictions

When you set up the API key in Cloud Console, make sure:
- **Application restrictions** = Websites
  - `https://xpizzadispatch.netlify.app/*` for production
  - `http://localhost:8000/*` for local testing
- **API restrictions** = Maps JavaScript API only

If the map shows "RefererNotAllowedMapError" or just stays grey, your referrer restrictions don't include the URL you're loading from. Add it and wait 2 minutes for propagation.

## What's intentionally not here yet

- **Drag-and-drop assignment.** Click + picker is faster for two-driver operation; can add later.
- **Route lines.** Lines drawn from driver to current target. Adds visual noise; punted unless you ask.
- **Historial / completed orders view.** Need to see past day's completions? That data is in Firebase but no UI yet.
- **Multi-day analytics dashboard.** Not in scope; if you want this, it's a separate dashboard app.

These are all natural follow-ups once the core dispatcher is being used in real ops.

## Troubleshooting

- **"Esta cuenta no tiene permisos de dispatcher"** — your Firebase Auth account isn't in `/dispatchers/{uid}` in the Realtime DB. Add it via Firebase Console.
- **Map is grey, no errors** — Maps API key is wrong or not loaded. Check browser devtools console (F12). Likely a referrer mismatch.
- **Drivers don't show on map** — they need to have `active: true` AND a `lat/lng` set. Driver might not have started shift, or GPS hasn't fired yet.
- **Chime doesn't play** — click anywhere in the page first to satisfy browser autoplay policy. Then it'll play on subsequent new orders.
