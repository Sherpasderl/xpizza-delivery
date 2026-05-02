# X Pizza Delivery — Changelog

Versioning: `MAJOR.MINOR.PATCH`
- **MAJOR**: schema/rules changes requiring data migration or manual setup
- **MINOR**: new features, new files, new screens
- **PATCH**: bug fixes, no behavior changes

Each file changed in a release carries a `// version: X.Y.Z` comment at the top.

---

## v1.5.0 — 2026-05-01

### Major — Make.com migration: Onfleet replaced by Cloud Function → Firebase

The dispatcher has been functional for weeks but disconnected from real customer orders — every test order had to be created manually. This release wires up the actual production pipeline: orders submitted through `xpizzaorders.netlify.app` now flow through Make.com → a new Cloud Function → Firebase RTDB → the dispatcher, in seconds, end to end.

#### What changed in the order pipeline

**Before (broken since Onfleet trial expired):**
```
Order form → Make.com → [Google Sheets] + [UltraMsg WhatsApp] + [Onfleet Create Task ×2 → DEAD]
```

**After:**
```
Order form → Make.com → [Google Sheets] + [UltraMsg WhatsApp] + [Cloud Function → Firebase]
                                                                       ↓
                                                                  [Dispatcher]
```

The Google Sheets log and UltraMsg confirmation WhatsApp are unchanged. Only the Onfleet portion is replaced.

#### New: Cloud Function (`xpizza-functions/`)

A single endpoint (`createOrder`) with a few important properties:

- **Shared-secret auth**: Make.com holds only a 64-char secret in its bearer token; never gets Firebase admin credentials. If the secret leaks, blast radius is "an attacker can create fake orders" — they cannot read the database, cannot touch drivers, cannot impersonate dispatchers. Compare to giving Make a Firebase service account, where leak = total database compromise.
- **Idempotent**: Make.com retries on network failure are safe; a duplicate `order_id` returns 200 with `idempotent: true` rather than overwriting.
- **Server-side validation**: malformed orders are rejected at the function with a clear error rather than polluting the dispatcher.
- **Atomic writes**: order + pickup task + delivery task all created in one multi-path RTDB update. Either all three exist or none do.
- **Cheap**: ~50 invocations/day vs. 2M/month free tier = effectively free.

#### Why a Cloud Function instead of direct Firebase REST writes from Make

Three options were on the table for "how does Make write to Firebase":

1. **Database secret** (legacy, deprecated, single-token-grants-everything)
2. **Service account JWT** (proper, but holding Firebase admin credentials inside Make is a bigger blast radius than necessary, plus JWT signing in Make is fiddly)
3. **Cloud Function with shared secret** (chosen) — Make's credential only authorizes one specific operation, server-side validation lives in code rather than Make's UI, easier to extend later (e.g. when we eventually want to send delivery-completion WhatsApp, that logic has a clean home)

#### What's NOT included in this release

- **Delivery confirmation WhatsApp**: Verified with Xavier that this never existed (he assumed Onfleet was sending it; Onfleet was not). Zero regression. Can be added in a future release if customer feedback requests it.
- **Kitchen alerts**: The KDS reads from the Google Sheets log, which is unchanged. No work needed.
- **App version bumps**: Driver and dispatcher app versions remain at v1.3.1 and v1.4.1 respectively. The migration is purely backend infrastructure — no client code changed.

#### Deployment artifact

New folder `xpizza-functions/` contains:
- `index.js` — the function source
- `package.json` — Node 20, firebase-admin v12, firebase-functions v6
- `.env.example` — template for the shared secret
- `.gitignore` — keeps `.env` and `node_modules/` out of source control
- `README.md` — full setup + deployment guide + Make.com wiring instructions

#### Action required

Follow the deployment guide at `xpizza-functions/README.md`. Roughly:

1. `npm install -g firebase-tools && firebase login`
2. `cd xpizza-functions && firebase use xpizza-delivery && npm install`
3. Generate secret: `openssl rand -hex 32`
4. `cp .env.example .env`, paste secret
5. `npm run deploy` → copy the Function URL printed at the end
6. In Make.com, disable the two Onfleet HTTP modules in the Delivery route
7. Add a new HTTP module pointing to the Function URL with the bearer token + JSON body (exact config in README)
8. Test with one real order, watch it appear in the dispatcher

Once verified, the entire system is production-ready: real customers can place delivery orders and you'll see them in the dispatcher within seconds.

---



### Patch — Resizable sidebar + decluttered map controls

Two small UX improvements requested after using v1.4.0:

**1. Sidebar is now resizable.** Drag handle on the inner (left) edge of the sidebar — hover and the handle highlights blue, drag to resize. Min 280px, max 700px. Width persists across sessions via localStorage (`xpd_sidebar_width`). Double-click the handle to reset to the default 380px.

Map automatically re-centers/recalculates its viewport after each resize.

**2. Map controls slimmed down (Onfleet-style).**
- "Centrar mapa" pill replaced with a small circular icon button (target/crosshair SVG) at top-left. Cleaner, less visual noise, same function.
- Hid Google Maps default controls that were rarely used: street view (we don't dispatch via street view) and the horizontal road/satellite/hybrid bar at the bottom-left.
- Kept the genuinely useful defaults: zoom (now positioned at right-bottom), fullscreen (top-right).

The result: more map visible, less chrome competing with the data on it.

**Files changed:**
- `xpizza-dispatch/index.html` (1.4.1) — only file changed; SDK stays at 1.4.0

**Action required:** Replace `index.html` in `xpizza-dispatch/`, redeploy. Suggested deploy message: `v1.4.1 — resizable sidebar + cleaner map controls`. No SDK update, so the other folders don't need touching.

---



### Minor — Slate-blue palette + full polish queue

After looking at Onfleet's actual screenshot more carefully, two things were obvious: the bg isn't pure black (it's a warm slate-blue grey), and there are several small operational features missing that would matter the moment real orders start flowing.

#### New color palette (dispatcher only)

Onfleet's interface is comfortable to look at for hours because the background isn't pure black — it's a slate-blue grey. We were running pure greys (`#0a0a0a` bg) which felt cold and made every accent color slightly too punchy. New palette uses Tailwind-style slate undertones:

- `--bg`: `#1a212c` (was `#0a0a0a`) — the primary dispatcher background
- `--surface`: `#232b39` (was `#141416`) — sidebar
- `--surface-2`: `#2d3645` (was `#1c1c1f`) — cards
- `--surface-3`: `#3d475a` (was `#26262a`) — interactive hover states
- `--border`: `#3a4458`, `--border-soft`: `#2a3142`
- Map bg: `#131826` (was `#0e0e10`) — also slate-tinted
- Map roads: `#3a4459` / `#4a5670` / `#5a6685` — keeps road grid visible against the new bg
- Driver marker stroke: `#131826` (was `#0a0a0a`) — matches new map bg

**Why slate-blue is better than pure black:**
- Less eye strain over long sessions
- Accent colors (red alerts, green driver pins, amber warnings) feel intentional rather than aggressive
- Status pills and pill backgrounds (`-soft` variants bumped from 0.15 to 0.18 alpha) read more clearly

Also bumped `--accent-soft` and other `-soft` color alphas from 0.15 → 0.18 so pills are more visible against the new lighter bg.

#### Polish queue items — all four shipped

**1. Per-task action menu (⋯)**

Every order card (unassigned + per-driver) now has a `⋯` button that opens a popover with contextual actions:
- **Llamar a [customer]** — opens the dialer if customer phone is on file (uses `tel:` link)
- **Reasignar a otro driver** (active tasks only) — opens the picker in reassign mode
- **Cancelar pedido** (red, danger styling) — confirmation dialog → cancels via new SDK function

Menu closes on outside click. Position pins to the trigger button.

**2. Inline order detail expansion**

Clicking anywhere on a card body (not on a button) now does TWO things:
- Pans/fits the map to that order's location
- Toggles inline expansion showing customer phone (clickable), payment method, items list, and address notes

Expand state persists across re-renders. Click again to collapse.

**3. Assign-to-self shortcut**

If the dispatcher is also a driver and is currently active, every unassigned card shows a green `A mí` button next to `Asignar`. One tap → atomic assignment to the dispatcher's own driver record. Skips the picker entirely. (You're both a dispatcher and a driver, so this saves a tap-cycle every order you take yourself.)

**4. Today's deliveries section**

New tree group `ENTREGADOS HOY` at the bottom of the sidebar, collapsed by default. Click the header to expand/collapse. Shows:
- Customer name, total
- Driver who delivered
- Time of delivery (12-hour format)
- Click → fits map between restaurant and customer (useful for reviewing routes)

Filters to orders where `status === 'delivered'` AND `delivered_at >= today midnight`. Resets at local midnight.

#### SDK additions (v1.4.0)

Two new exports, used only by the dispatcher (driver app doesn't need to load these):

- `cancelOrder(orderId, reason?)` — atomic update marks order + both tasks as cancelled, AND clears the assigned driver's `current_task_id` if they were working it (so they don't get stuck pointing at a cancelled task). Optionally records a cancel reason.
- `reassignOrder(orderId, newDriverId)` — reassigns both tasks to a new driver, resets accept timestamps so the new driver has to accept fresh, AND cleans up the old driver's `current_task_id` if it pointed at this order. Atomic single write.

#### What's NOT changed
- Driver app — no changes to driver UX
- Auth flow, order creation flow, geofence transitions
- Map markers, sounds, version display

#### Files changed

- `xpizza-dispatch/index.html` (1.4.0) — palette + all four polish features
- `xpizza-dispatch/xpizza-delivery.js` (1.4.0) — new SDK functions
- `xpizza-driver/xpizza-delivery.js` (1.4.0) — synced for SDK consistency (no behavior change)
- `xpizza-delivery/xpizza-delivery.js` (1.4.0) — synced for test harness

#### Action required

**Required:**
- `xpizza-dispatch/` → replace BOTH `index.html` and `xpizza-delivery.js`, redeploy

**Optional (sync only — keeps SDK versions aligned across folders, no behavior change):**
- `xpizza-driver/xpizza-delivery.js` → drop in (no driver redeploy needed since the index.html stays at v1.3.1 and the new SDK functions aren't used)
- `xpizza-delivery/xpizza-delivery.js` → drop in (test harness consistency)

Suggested deploy message: `v1.4.0 — slate palette + polish queue`.

After deploy, hard-refresh the dispatcher to bypass cache.

---



### Patch — driver pin no longer teleports to restaurant on manual arrival

**Bug:** When a driver tapped "Estoy en el restaurante," the dispatcher map briefly showed them at the restaurant (regardless of their actual GPS position). Driver pin would also "disappear" because it landed on the exact same coordinates as the restaurant marker, hidden behind it (restaurant zIndex 999 vs driver 500). Then ~10 seconds later the next real GPS ping fired, the pin would jump back to the driver's actual location.

**Root cause:** v1.0.3 had `arriveAtRestaurant()` write the restaurant's lat/lng + a fresh last_ping to the driver's record, intending to hide a momentary "GPS inactivo" UX glitch. The side effect was creating false dispatcher views for ~10 seconds.

**Fix:**
1. `arriveAtRestaurant()` now only updates state fields (`status`, `arrived_at_restaurant_at`). It no longer touches `lat`, `lng`, or `last_ping`. The driver's actual GPS keeps streaming and the dispatcher always sees their real position.
2. Driver marker `zIndex` bumped from 500 to 1000 (above restaurant's 999) — so even if a driver IS legitimately at the restaurant coords, they'll render on top and remain visible.

**Why this is the right call:** If a driver claims to be at the restaurant but GPS shows them elsewhere, that's *useful information* for the dispatcher (signals GPS issue or driver inaccuracy). Hiding that information was worse than the rare "GPS inactivo" momentary blip we were trying to prevent. The visibilitychange handler from v1.0.3 already restarts watchPosition reliably — fresh GPS pings resume in seconds when needed.

**Files changed:**
- `xpizza-delivery/xpizza-delivery.js` (1.3.1) → also synced to driver and dispatch folders
- `xpizza-driver/index.html` (1.3.1) — version + cache buster
- `xpizza-dispatch/index.html` (1.3.1) — version + cache buster + driver marker zIndex

**Action required:** Replace `index.html` in both apps + `xpizza-delivery.js` in all three folders, redeploy. Hard-refresh browser tabs and PWA. Suggested deploy message: `v1.3.1 — driver pin no longer teleports`.

---



### Minor — Onfleet-style sidebar restructure + typography overhaul

**Two themes in this release:** dispatcher sidebar rebuilt to Onfleet's tree pattern, and the type system across both apps replaced with a friendlier humanist sans (matches Onfleet's warmer feel).

#### Typography (both apps)

**Why:** The previous combo (IBM Plex Sans Condensed for body + Anton for display) felt technical and slightly cold. Onfleet's tools feel friendlier because they use a single humanist sans throughout in different weights — no display/body split, no condensed letterforms. Easier to read at a glance, less "engineering tool," more "purpose-built operator interface."

**Switched to:**
- **Plus Jakarta Sans** for everything (body, headers, labels, big buttons) — modern humanist sans with clear letterforms and warm character
- Different weights provide hierarchy: 400 (body), 500 (medium emphasis), 600 (subheaders), 700 (most labels), 800 (big buttons + headers)
- **IBM Plex Mono** retained for codes, IDs, distances, version tags — provides clear visual differentiation for technical content

**Removed:** Anton (was used as condensed display font), IBM Plex Sans Condensed (was body)

**Effect:**
- Driver app feels less utilitarian, more approachable for daily use
- Dispatcher feels less technical, easier on the eyes during long sessions
- Both apps look more cohesive — one type system instead of three
- Big action buttons read as confident rather than aggressive (Plus Jakarta 800 vs Anton's narrow caps)

#### Dispatcher sidebar — full Onfleet-style restructure

**Why:** The previous three-section layout (Drivers / Pending / Active) required mental cross-referencing between sections. Onfleet's pattern groups everything by assignee, which matches dispatcher cognition: "what does Hermez have on his plate? what's still unassigned?" gets answered in one glance.

**Sidebar — completely restructured:**
- **Position:** moved from left to right side of screen (Onfleet convention)
- **New tree structure:**
  - **SIN ASIGNAR** group at top — pending orders waiting for a driver, each with the Asignar button
  - **REPARTIDORES** group below — every driver listed, with their assigned orders nested below their name
- **Driver row:** status dot · name · status text + ping freshness · expandable chevron
- **Each order under driver:** customer name, address, total, phase pill (Pickup/Delivery/Esperando)
- **Width:** bumped from 360px to 380px (more breathing room for nested content)

**Map style:** road contrast bumped significantly for the grid feel:
- Local roads: `#3a3a42` (was `#2a2a2e`)
- Arterial roads: `#46464f` (new tier)
- Highways: `#5a5a64` (was `#3a3a40`)
- Background: `#0e0e10` (was `#1a1a1c`) — slightly darker, makes roads pop more
- Result: SPS street grid is now clearly visible at typical zoom levels

**Sidebar toggle:** redesigned. Sticky "▶ OCULTAR PANEL" header at top of sidebar collapses it. When collapsed, a small "◀ Panel" tab on the right edge of screen brings it back.

**Map controls repositioned:** "Centrar mapa" moved from top-right to top-left.

**What's NOT changed:**
- Topbar stats, map markers (drivers/customers/restaurant + geofence), order assignment picker, sound chime + visual flash, auth flow

**What's coming next (queued for 1.3.1+):**
- Per-task action menu (cancel, reassign, call customer)
- Order details on click (expand inline)
- Assign-to-self shortcut
- Today's deliveries list

**Files changed:**
- `xpizza-driver/index.html` (1.3.0) — typography
- `xpizza-dispatch/index.html` (1.3.0) — typography + sidebar restructure + map style

**Action required:** Replace `index.html` in both `xpizza-driver/` and `xpizza-dispatch/`, redeploy both. Suggested deploy messages: `v1.3.0 — Plus Jakarta Sans typography` (driver), `v1.3.0 — Onfleet sidebar + typography` (dispatcher).

---



### Patch — driver active card: chronological step hierarchy + smart navigation

**Why:** The active order card showed Waze, Maps, and the action button as parallel choices, but they're really sequential ("first navigate, then confirm"). Drivers had to derive the chronology themselves. This makes it explicit and foolproof.

**What changed (driver active card):**

1. **PASO 1 / PASO 2 step numbers.** Navigation block is "PASO 1 · Ir [destination]" and the action button is preceded by a hint "Cuando tengas el pedido" / "Cuando entregues" with a step 2 marker.

2. **Dynamic destination labels.** The nav block now reads "Ir al restaurante" during pickup phase, and "Ir donde María Reyes" during delivery phase (uses customer name). Removes ambiguity about where the buttons take you.

3. **Geofence-aware navigation hide.** When the driver is within 50m of the current target (restaurant during pickup, customer during delivery), the Waze/Maps buttons disappear and a green checkmark "Has llegado al restaurante / donde el cliente" replaces them. The action button becomes the only thing on screen — driver can't miss what to do next.

**Confirmed (no change needed, already enforced):** Pickup-first sequencing is baked into the schema (linked tasks with `depends_on_task_id`), the SDK (`getDriverOrders` computes phase strictly in order), the `pickupComplete` workflow (atomically completes pickup + accepts delivery), and the UI (one phase visible at a time, always pickup before delivery). The driver can never skip ahead.

**Files changed:**
- `xpizza-driver/index.html` (1.2.1)

**Action required:** Redeploy `xpizza-driver/`. Suggested deploy message: `v1.2.1 — driver step hierarchy`.

---



### Minor — Driver app switched to light mode

**Why:** The driver app is used outdoors in tropical Honduras sunlight. Dark mode was a poor default — black mirror in direct sun = unreadable. Industry convention (DoorDash, Uber Eats, Rappi, Onfleet) is light mode for driver apps for this exact reason. Dispatcher stays in dark mode (indoor, fixed-distance, long sessions).

**Changes:**
- All color tokens flipped: white background, dark text, clean Zinc grey scale (DoorDash style)
- Phase pills upgraded to higher-contrast pastel backgrounds (Tailwind amber-100/blue-100/red-100 with dark colored text — meets AA contrast on light bg)
- Payment method pills similarly upgraded (mint green for cash, sky blue for card)
- Big buttons now have tinted shadows (red-tinted on red, etc.) for tactile feel on white
- Active order card and queue cards have subtle drop shadows so they lift off the white background
- Toast notifications now white with colored borders + dark text (was inverted on dark)
- iOS status bar style switched from `black-translucent` to `default` (dark text on light bg)
- Android `mobile-web-app-capable` meta tag added alongside the deprecated `apple-mobile-web-app-capable`

**No functional changes.** Same flows, same buttons, same state machine. Only colors.

**Files changed:**
- `xpizza-driver/index.html` (1.2.0)
- All other files synced to 1.2.0 stamp (no behavior change in those, just version sync)
- SDK cache-buster bumped to `?v=7` in both apps

**Action required:** Redeploy `xpizza-driver/`. Force-refresh on phones to pick up the new CSS. Suggested deploy message: `v1.2.0 — driver light mode`.

---



### Patch — visible version tags + unified versioning

**Why:** When debugging or verifying a deploy, there's now no ambiguity about which version of the system is actually running. Previously the version was only in HTML comments (invisible) and `VERSION.md` (out-of-band).

**Added:**
- Visible `v1.1.3 · driver` / `v1.1.3 · dispatch` label on every screen of both apps:
  - Driver: login, off-shift, on-shift (after Terminar turno button)
  - Dispatcher: config, login, topbar (between user email and Salir button)
- Style: small mono font, muted color, intentionally subtle so it doesn't distract
- Single `SYSTEM_VERSION` constant per app — change in one place per release

**Versioning convention going forward:**
All files in the system now share the same version on each release. Even files that didn't change get the version comment bumped, so "what version is everything at?" is trivially answerable.

**Files changed:**
- `xpizza-driver/index.html` (1.1.3) — version tags + SDK cache-buster v=6
- `xpizza-dispatch/index.html` (1.1.3) — version tags + SDK cache-buster v=6
- `xpizza-delivery/xpizza-delivery.js` (1.1.3) — synced version stamp
- `xpizza-driver/xpizza-delivery.js` (1.1.3) — synced
- `xpizza-dispatch/xpizza-delivery.js` (1.1.3) — synced

### Bonus — Netlify deploy message conventions

Three ways to track deploys:
1. **Manual:** drag folder onto Netlify, then edit the deploy message via the Deploys tab pencil icon. Format: `v1.1.3 — visible version tags`.
2. **CLI (recommended once tedious):** `netlify deploy --prod --dir=. --message="v1.1.3 — visible version tags"` after one-time `netlify link`.
3. **Visible in app:** the version tag in each app makes it possible to verify what's actually live by visiting the URL.

---



### Patch — dispatcher map controls (street/satellite/hybrid view + street view + fullscreen)

**Added:**
- **Map type control** (Mapa / Satélite / Híbrido) bottom-left of the map
- **Street View pegman** bottom-right
- **Fullscreen toggle** top-right
- **Zoom control** moved to right-center for cleaner left-side layout

Moved the **Centrar mapa** button down 50px to clear room for the fullscreen control.

**Files changed:**
- `xpizza-dispatch/index.html` (1.1.2)

---



### Patch — dispatcher map fails to render

**Bug:** `google.maps.Map is not a constructor` thrown at boot. The previous `loadGoogleMaps()` used a plain `<script>` tag with `loading=async`, which resolves the promise as soon as the bootstrap script downloads — but the actual `Map` constructor isn't available until the inner `maps` library finishes loading.

**Fix:** Replaced the script-tag loader with Google's official async bootstrap pattern, which exposes `google.maps.importLibrary()`. We `await importLibrary("maps")` before resolving the promise, guaranteeing `Map` exists when `initMap()` runs.

**Files changed:**
- `xpizza-dispatch/index.html` (bumped to 1.1.1)

**Action required:** Replace `index.html` in the dispatch folder, redeploy.

---



### Minor — Dispatcher View

New full app: `xpizza-dispatch/`. The browser app the dispatcher uses on a laptop or tablet to monitor drivers, see incoming orders, and assign deliveries. Replaces the role of the test harness in real operations.

**Layout:** dark mode, map dominant, sidebar on left (Onfleet style). Three sidebar sections: live drivers, pending orders, active orders.

**Map (Google Maps):**
- Restaurant pin + 50m geofence circle
- Live driver pins (colored circles with initials, color-coded by status, grey when GPS stale)
- Customer pins for active orders (amber = awaiting pickup, blue = en route)
- Custom dark map theme matching app aesthetic
- Click any pin → InfoWindow with details
- Click any sidebar card → pan/fit map to relevant location
- Top-right "Centrar mapa" button auto-fits view to all drivers + active orders + restaurant

**Order assignment:**
- "Asignar" button on each pending order opens a driver picker overlay
- Drivers sorted by **readiness for pickup**:
  1. At restaurant (instant)
  2. Available (sort by distance to base)
  3. Returning (incoming, sort by distance to base)
  4. Busy (en route / already assigned) — shown but require confirmation to override
- Each driver row shows distance to base + distance to customer + status pill
- One click assigns both pickup + delivery tasks atomically (mirrors Onfleet linked-task model)

**New-order alerts:** chime + visual flash on the order card + toast notification when a new order's pickup task arrives unassigned.

**Top bar stats:** drivers in turno / pendientes / activos / delivered today.

**Sidebar collapse:** toggle button hides sidebar for full-screen map.

**Auth & permissions:** Login screen rejects non-dispatchers immediately. Only accounts with `/dispatchers/{uid}: true` can sign in here.

**Setup config:** First-run screen accepts both Firebase config and Google Maps API key; both stored in localStorage per-device.

**Files added:**
- `xpizza-dispatch/index.html` (1.1.0)
- `xpizza-dispatch/xpizza-delivery.js` (1.0.3, synced)
- `xpizza-dispatch/manifest.json`
- `xpizza-dispatch/sw.js`
- `xpizza-dispatch/icon.svg` (teal radar/scope motif, distinct from driver's red X)
- `xpizza-dispatch/README.md`

**Action required to deploy:**
1. Create a new Google Maps API key in Cloud Console:
   - Application restrictions: Websites → `https://xpizzadispatch.netlify.app/*` and `http://localhost:8000/*`
   - API restrictions: Maps JavaScript API only
2. Drag the `xpizza-dispatch/` folder onto Netlify, name the site `xpizzadispatch`
3. First-run: paste Firebase config + Maps API key
4. Sign in as dispatcher

**Action required for full Onfleet replacement (still pending):** Make.com pipeline migration to write to Firebase instead of Onfleet. That's the next session.

---



### Patch — GPS goes "inactivo" after manual arrival + iOS background pause fix

**Problems addressed:**

1. **"GPS inactivo" after tapping "Estoy en el restaurante"**: the `arriveAtRestaurant` SDK helper updated driver status but didn't refresh `last_ping`. If iOS had paused `watchPosition` (e.g. during a brief app switch), the staleness check would show GPS inactive immediately after the manual button tap.

2. **iOS Safari pauses `watchPosition` during background, sometimes doesn't resume cleanly**: the `visibilitychange` handler reacquired the wake lock but didn't restart the GPS watch. Drivers coming back from a screenshot, a phone call, or a brief app switch could end up with stale GPS for 30+ seconds.

**Fixes:**

1. `arriveAtRestaurant` now writes the restaurant coordinates as the driver's position and refreshes `last_ping` to `serverTimestamp()`. We trust the driver's claim that they're at the restaurant — no reason to wait for iOS to catch up.

2. `visibilitychange` handler now tears down the existing `watchPosition` and restarts it whenever the page becomes visible. Reset `lastUpdateAt` so the first new update fires immediately (skip the throttle).

**Files changed:**
- `xpizza-delivery/xpizza-delivery.js` (arriveAtRestaurant patched)
- `xpizza-driver/xpizza-delivery.js` (synced)
- `xpizza-driver/index.html` (visibilitychange handler updated, cache-buster v=5)

**Action required:** Redeploy `xpizza-driver/` to Netlify. No rules or schema changes.

---



### Patch — better UX when driver is `returning`

**Problem:** After completing a delivery, driver sees "Esperando pedidos / Te notificaremos cuando llegue uno" while status pill says `REGRESANDO`. The message is misleading — it implies they're available for a new order when they're actually still on their way back. Also, drivers had no way to manually advance to `at_restaurant` if GPS jitter or being slightly outside the 50m geofence prevented automatic detection.

**Fix:**
1. Idle screen now shows status-aware messaging:
   - `returning` → "Regresando al restaurante / Pulsa abajo cuando hayas llegado" + manual button
   - `at_restaurant` → "En el restaurante / Listo para el siguiente pedido"
   - `available` → original "Esperando pedidos" message
2. Added **"Estoy en el restaurante"** button visible only during `returning` status. Tapping forces the geofence transition manually. Real-world fallback for GPS issues; also makes dev/test cycles workable when not physically at the restaurant.
3. New SDK helper `arriveAtRestaurant(driverId)` — manually flips `returning → at_restaurant` (or `→ available` if no current task).

**Files changed:**
- `xpizza-delivery/xpizza-delivery.js` (added `arriveAtRestaurant`)
- `xpizza-driver/xpizza-delivery.js` (synced)
- `xpizza-driver/index.html` (idle state rendering + manual button)

**Action required:** Redeploy `xpizza-driver/` to Netlify. No rules or schema changes.

---

## v1.0.1 — 2026-05-01

### Patch — driver permission denied on "Recogí el pedido"

**Bug:** Drivers received "permission denied" when tapping pickup-complete because the atomic update tried to write `orders/{id}/status = out_for_delivery`, but the rules only allowed dispatchers to write to `/orders/`.

**Fix:** Updated `database.rules.json` to allow drivers assigned to an order to update three specific fields on that order:
- `status` (to mark out_for_delivery / delivered)
- `picked_up_at` (timestamp when bag is picked up)
- `delivered_at` (timestamp when delivery completes)

All other order fields remain dispatcher-only.

**Action required:** Republish `database.rules.json` in the Firebase Console → Realtime Database → Rules tab. No data migration needed.

**Files changed:**
- `xpizza-delivery/database.rules.json`

---

## v1.0.0 — 2026-05-01

### Initial release

First end-to-end working system. Replaces Onfleet for X Pizza's last-mile delivery operation.

**Backend (Firebase Realtime Database):**
- Schema: dispatchers, drivers, tasks, orders, config nodes
- Security rules for role-based access (dispatcher / driver / authenticated)
- Atomic order + linked-task creation (mirrors Onfleet's pickup→delivery model)

**Shared SDK (`xpizza-delivery.js`):**
- Auth helpers (sign in, role detection)
- Driver operations (start/end shift, location streaming, geofence transitions)
- Dispatcher operations (live subscriptions, order assignment)
- Order-centric helpers (`assignOrderToDriver`, `pickupComplete`, `getDriverOrders`)
- Geofence state machine: `returning ↔ at_restaurant ↔ available`, `assigned → at_restaurant` on arrival, `at_restaurant → en_route_delivery` on geofence exit with task

**Test harness:**
- Manual driver/dispatcher controls for backend validation
- Order + driver dropdowns for full-order assignment

**Driver PWA (`xpizzadriver.netlify.app`):**
- Spanish UI, dark mode, big-button design for handlebar-mount use
- Login, shift toggle, GPS streaming with wake lock
- Active order card with phase-aware action button (Aceptar → Recogí → Entregado)
- Full task queue visible
- Waze + Google Maps handoff buttons
- iOS audio unlock on shift start (works around iOS Safari autoplay restrictions)
- Tap-to-call customer phone number

**Files at v1.0.0:**
- `xpizza-delivery/SCHEMA.md`
- `xpizza-delivery/database.rules.json`
- `xpizza-delivery/xpizza-delivery.js`
- `xpizza-delivery/test-harness.html`
- `xpizza-delivery/README.md`
- `xpizza-driver/index.html`
- `xpizza-driver/xpizza-delivery.js`
- `xpizza-driver/manifest.json`
- `xpizza-driver/sw.js`
- `xpizza-driver/icon.svg`
- `xpizza-driver/README.md`
