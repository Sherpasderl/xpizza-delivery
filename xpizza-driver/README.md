# X Pizza Driver — Deploy Guide

The PWA Hermez and Xavier install on their phones.

## Files in this folder

- `index.html` — the driver app
- `xpizza-delivery.js` — shared SDK (same as in xpizza-delivery folder, kept here for self-contained deploy)
- `manifest.json` — PWA manifest
- `sw.js` — service worker (registers as installable, no offline caching)
- `icon.svg` — app icon

## Deploy to Netlify

1. Go to https://app.netlify.com → **Add new site → Deploy manually**
2. Drag this folder (`xpizza-driver`) into the drop zone
3. Rename the site → **Site settings → Change site name** → `xpizzadriver`
4. URL is now `https://xpizzadriver.netlify.app`

## First-run setup

Open the URL on your laptop first to validate, then on each driver's phone.

1. App shows "Configuración inicial"
2. Paste the Firebase config JSON (same one used in the test harness):
   ```json
   {
     "apiKey": "...",
     "authDomain": "xpizza-delivery.firebaseapp.com",
     "databaseURL": "https://xpizza-delivery-default-rtdb.firebaseio.com",
     "projectId": "xpizza-delivery",
     "storageBucket": "...",
     "messagingSenderId": "...",
     "appId": "..."
   }
   ```
3. Tap **Guardar**
4. Login screen appears → sign in with the driver account (e.g. `hermez@xpizza.local` / password)

The config is stored in localStorage per device, so each driver only does this once.

## Install as PWA

**iOS (Hermez/Xavier on iPhone):**
1. Open `xpizzadriver.netlify.app` in **Safari** (must be Safari, not Chrome on iOS)
2. Tap the share button → **Add to Home Screen**
3. Confirm — icon appears on home screen
4. Open from home screen — runs full-screen, no browser chrome

**Android:**
1. Open in Chrome → menu → **Install app**
2. Confirm

## Daily flow for the driver

1. Tap home screen icon → app opens
2. Sign in if not already (auth persists across sessions)
3. Tap **Iniciar turno** (Start shift) — phone:
   - Acquires wake lock (screen stays on)
   - Requests GPS permission (allow)
   - Starts streaming location every ~10s to Firebase
4. App shows **DISPONIBLE** at top — driver is on the clock
5. When dispatcher assigns an order → chime + toast notification + vibration
6. Active order card appears with:
   - Customer name (tap phone number to call)
   - Address + delivery notes
   - Items + total + payment method
   - **Waze** + **Google Maps** buttons (target = restaurant for pickup phase, customer for delivery phase)
   - Big colored action button
7. Action button progression:
   - **Aceptar pedido** (red) → driver acknowledges
   - Driver heads to restaurant; status auto-flips to `EN RESTAURANTE` on arrival
   - **Recogí el pedido** (amber) → confirms bag in hand
   - Driver navigates to customer; status auto-flips to `EN CAMINO` when leaving geofence
   - **Entregado** (green) → confirms delivery
8. Driver returns to base; geofence detects arrival; status flips to `DISPONIBLE`
9. Repeat. End of night: scroll down, **Terminar turno**.

## What the driver sees vs what dispatcher sees

| State | Driver app | Dispatcher view |
|---|---|---|
| `DISPONIBLE` | Idle screen | Green pill "Available" |
| `ASIGNADO` | Active card with **Aceptar** | Amber pill, pin updating |
| `EN RESTAURANTE` | Active card with **Recogí pedido** | Green pill at restaurant |
| `EN CAMINO` | Active card with **Entregado**, navigation buttons | Blue pill, live trail to customer |
| `REGRESANDO` | Idle screen (no current task) | Amber pill, trail back to base |

## Wake lock caveat (read this)

The driver app uses `navigator.wakeLock.request('screen')` to keep the screen on while the shift is active. This works:

✅ When the app is in the foreground
✅ Even if the phone is on a charger or in a handlebar mount
❌ When the phone is locked or another app is in the foreground

If the driver locks the phone, GPS streaming **stops**. The dispatcher will see the pin go stale ("hace Xm") within 90 seconds.

**Mitigation:** drivers should keep the phone in their handlebar mount with the app open. If they need to put the phone away (bathroom break, sit-down meal break), they should tap **Terminar turno** so the dispatcher knows they're offline.

If you find this is too constraining in practice, the next step is wrapping the PWA in a Capacitor shell with native background geolocation. But try this v1 first — for short SPS deliveries with handlebar mounts, it should be fine.

## Testing locally before phone deploy

```bash
cd xpizza-driver
python3 -m http.server 8000
```

Open `http://localhost:8000` in Chrome. PWA install + service worker won't work fully on `http://localhost`, but the app logic does — useful for sanity checks.

For real GPS + install testing, deploy to Netlify (HTTPS required for both wake lock and service workers) and open the live URL on your phone.

## Validation flow before going live

1. Deploy this folder to `xpizzadriver.netlify.app`
2. Open on your phone, sign in as `hermez@xpizza.local`
3. **Start shift** — confirm `DISPONIBLE` shows + GPS dot pulses green
4. Switch to laptop — open the test harness as dispatcher
5. **Create test order** → use new "Assign order to driver" dropdowns at the bottom — pick the order + Hermez → **Assign full order**
6. Phone should chime + vibrate + toast "¡Nuevo pedido asignado!"
7. Active card appears with **Aceptar pedido**
8. Walk through: Aceptar → Recogí → Entregado
9. Confirm dispatcher view shows live state changes throughout

If all that works, give Hermez and Xavier the URL + their login creds, walk them through the install + first shift, and you're ready to cut over from Onfleet.
