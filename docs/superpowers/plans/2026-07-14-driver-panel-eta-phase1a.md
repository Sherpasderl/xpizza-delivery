# Driver Panel + Single-Delivery ETA (Phase 1a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the dispatch driver-click a real, live **single-delivery ETA** ("≈ 12 min · 7:42 p. m.") plus four per-driver actions — client-only, data-certain, no predictor.

**Architecture:** A pure, dependency-free ETA module (`driver-eta.js`, ESM) holds the eligibility gate, arrival math, formatting, and refresh-throttle — unit-tested in Node. Into `xpizza-dispatch/index.html` we wire a `google.maps.DirectionsService` call (throttled) that fills an `etaCache` keyed by order, re-rendered into the existing `renderTaskRow`; plus a driver `⋯` action menu (reusing `showActionMenu`) and a last-known-location temp pin. The legacy `google.maps.Marker`/dark map are untouched (no `mapId`).

**Tech Stack:** Vanilla ESM JS, Google Maps JS `DirectionsService`, Node built-in `node:assert` tests (`node file.test.js`, matching `driver-glide.test.js`).

**Gate rulings baked in (advisor 2026-07-14):** route on `tasks/{id}_delivery.destination_lat/lng` (not `orders.lat/lng`); ETA only once the order's pickup is completed (driver has the food); `S_customer` flat config ≈ 3 min; **verify the Maps key's API restrictions include Directions API before ship** (enablement alone is insufficient). No predictor in 1a. Stacked/graduation are 1b/1c — out of scope here.

---

## File Structure

- **Create** `xpizza-dispatch/driver-eta.js` — pure ESM. Exports `distanceMeters`, `etaEligible`, `projectArrival`, `relativeEta`, `clockTime`, `dueForRefresh`. No `google.maps`, no DOM.
- **Create** `xpizza-dispatch/driver-eta.test.js` — Node tests for all of the above.
- **Modify** `xpizza-dispatch/index.html` (inside `<script type="module">`): import the module; add `S_CUSTOMER_SEC` config + an `etaCache` + `driverLocForEta` maps; a throttled `refreshDeliveryEtas()` driven off the driver subscription; render the ETA chip in `renderTaskRow`; add a driver `⋯` action menu (Llamar / Ver última ubicación / Reasignar / Sacar de turno) + a `lastLocMarker` temp pin. Anchor by SYMBOL (`renderTaskRow`, `renderDriverNode`, `subscribeToDrivers` callback) — line numbers drift.

### Pure module contract (used by every task)

```js
// distanceMeters(a,b) -> meters (equirectangular)
// etaEligible({pickupStatus, destLat, destLng, driverLat, driverLng}) -> bool
//   true only when the driver holds THIS order's food (pickupStatus==='completed')
//   and all four coords are finite.
// projectArrival(nowMs, travelSec, dwellSec) -> arrivalMs
// relativeEta(arrivalMs, nowMs) -> "llegando" | "≈ N min"
// clockTime(arrivalMs, tz='America/Tegucigalpa') -> "7:42 p. m." (deterministic from ms+tz)
// dueForRefresh(lastComputedAt|null, nowMs, intervalMs, movedMeters, moveThresholdM) -> bool
```

---

### Task 1: Pure ETA module (eligibility, math, format, throttle)

**Files:** Create `xpizza-dispatch/driver-eta.js`, `xpizza-dispatch/driver-eta.test.js`

- [ ] **Step 1: Write the failing test**

```js
// xpizza-dispatch/driver-eta.test.js
import assert from 'node:assert';
import {
  distanceMeters, etaEligible, projectArrival, relativeEta, clockTime, dueForRefresh,
} from './driver-eta.js';

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// distance sanity (~111m for 0.001° lat)
{
  const d = distanceMeters({ lat: 15.5, lng: -88 }, { lat: 15.501, lng: -88 });
  assert.ok(d > 100 && d < 125, `got ${d}`); ok('distanceMeters');
}
// eligibility: only when pickup completed + all coords finite
{
  const base = { pickupStatus: 'completed', destLat: 15.5, destLng: -88, driverLat: 15.51, driverLng: -88.01 };
  assert.strictEqual(etaEligible(base), true);
  assert.strictEqual(etaEligible({ ...base, pickupStatus: 'in_progress' }), false, 'not picked up yet');
  assert.strictEqual(etaEligible({ ...base, destLat: null }), false, 'no destination');
  assert.strictEqual(etaEligible({ ...base, driverLat: undefined }), false, 'no driver pos');
  ok('etaEligible gates on pickup-completed + finite coords');
}
// arrival = now + (travel + dwell)
{
  assert.strictEqual(projectArrival(1_000_000, 300, 180), 1_000_000 + 480_000);
  assert.strictEqual(projectArrival(0, -5, -5), 0, 'clamps negatives to 0');
  ok('projectArrival');
}
// relative label
{
  assert.strictEqual(relativeEta(60_000, 0), 'llegando', '<=1 min');
  assert.strictEqual(relativeEta(12 * 60_000, 0), '≈ 12 min');
  assert.strictEqual(relativeEta(0, 60_000), 'llegando', 'past -> llegando');
  ok('relativeEta');
}
// clock time is deterministic from ms + tz
{
  // 2026-07-14T19:42:00-06:00 (Tegucigalpa) === 2026-07-15T01:42:00Z
  const ms = Date.UTC(2026, 6, 15, 1, 42, 0);
  const s = clockTime(ms, 'America/Tegucigalpa');
  assert.ok(/7:42/.test(s), `expected 7:42, got ${s}`);
  ok('clockTime deterministic');
}
// refresh throttle
{
  assert.strictEqual(dueForRefresh(null, 100, 30_000, 0, 50), true, 'first ever');
  assert.strictEqual(dueForRefresh(0, 10_000, 30_000, 0, 50), false, 'too soon, no move');
  assert.strictEqual(dueForRefresh(0, 10_000, 30_000, 80, 50), true, 'moved far');
  assert.strictEqual(dueForRefresh(0, 40_000, 30_000, 0, 50), true, 'interval elapsed');
  ok('dueForRefresh');
}

console.log(`\n${pass} passed`);
```

- [ ] **Step 2: Run — expect FAIL** (`Cannot find module './driver-eta.js'`)

Run: `node xpizza-dispatch/driver-eta.test.js`

- [ ] **Step 3: Implement `driver-eta.js`**

```js
// xpizza-dispatch/driver-eta.js
// Pure, dependency-free delivery-ETA helpers for the dispatch driver panel (Phase 1a).
// No google.maps, no DOM — unit-testable. `now` is always passed in.

export function distanceMeters(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * R;
}

// Phase 1a: an ETA is honest only once the driver physically holds THIS order's food
// (its pickup task is completed). Before that we show a stage, not a number.
export function etaEligible(f) {
  return f.pickupStatus === 'completed'
    && Number.isFinite(f.destLat) && Number.isFinite(f.destLng)
    && Number.isFinite(f.driverLat) && Number.isFinite(f.driverLng);
}

export function projectArrival(nowMs, travelSec, dwellSec) {
  return nowMs + (Math.max(0, travelSec) + Math.max(0, dwellSec)) * 1000;
}

export function relativeEta(arrivalMs, nowMs) {
  const mins = Math.round((arrivalMs - nowMs) / 60000);
  return mins <= 1 ? 'llegando' : `≈ ${mins} min`;
}

export function clockTime(arrivalMs, tz = 'America/Tegucigalpa') {
  return new Date(arrivalMs).toLocaleTimeString('es-HN', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  });
}

export function dueForRefresh(lastComputedAt, nowMs, intervalMs, movedMeters, moveThresholdM) {
  if (lastComputedAt == null) return true;
  if (nowMs - lastComputedAt >= intervalMs) return true;
  return movedMeters >= moveThresholdM;
}
```

- [ ] **Step 4: Run — expect `6 passed`**

Run: `node xpizza-dispatch/driver-eta.test.js`

- [ ] **Step 5: Commit**

```bash
git add xpizza-dispatch/driver-eta.js xpizza-dispatch/driver-eta.test.js
git commit -m "feat(dispatch): pure delivery-ETA helpers + tests (Phase 1a)"
```

---

### Task 2: Wire DirectionsService + ETA cache, render the chip

**Files:** Modify `xpizza-dispatch/index.html`

- [ ] **Step 1: Import + config + state** — next to the `driver-glide.js` import, add:

```js
import { etaEligible, projectArrival, relativeEta, clockTime, dueForRefresh, distanceMeters } from './driver-eta.js?v=1';
```

Near the other module-globals (by `let allDrivers = {};`), add:

```js
// Phase 1a delivery ETA. Client-only: DirectionsService (driver -> delivery destination) +
// a flat customer-dwell buffer. Cache is keyed by order_id; recompute is throttled.
const S_CUSTOMER_SEC = 180;            // find-door/handoff buffer; tune post-deploy (§calibration)
const ETA_REFRESH_MS = 30000;          // at most once/30s per order
const ETA_MOVE_M = 50;                 // ...unless the driver moved >50m
let dirService = null;                  // lazily created after Maps loads
const etaCache = {};                    // order_id -> { arrivalMs, computedAt, driverLat, driverLng }
```

- [ ] **Step 2: Lazily create the DirectionsService** — inside the maps-ready path (after `map = new google.maps.Map(...)`), add:

```js
  dirService = new google.maps.DirectionsService();
```

- [ ] **Step 3: The throttled refresh routine** — add this function (near `updateDriverMarkers`):

```js
// Recompute live delivery ETAs for orders whose driver holds the food. Throttled per order.
// Fills etaCache and re-renders the sidebar when anything changed. Errors are swallowed so a
// Directions/key failure degrades to "no ETA", never breaks the board.
function refreshDeliveryEtas() {
  if (!dirService) return;
  const now = performance.timeOrigin + performance.now(); // wall-clock ms
  for (const [uid, d] of Object.entries(allDrivers)) {
    if (!d.active || !Number.isFinite(d.lat) || !Number.isFinite(d.lng)) continue;
    for (const o of getOrdersForDriver(uid)) {
      const dt = allTasks[`${o.order_id}_delivery`];
      const pt = allTasks[`${o.order_id}_pickup`];
      const facts = {
        pickupStatus: pt?.status,
        destLat: dt?.destination_lat, destLng: dt?.destination_lng,
        driverLat: d.lat, driverLng: d.lng,
      };
      if (!etaEligible(facts)) { delete etaCache[o.order_id]; continue; }
      const cached = etaCache[o.order_id];
      const moved = cached ? distanceMeters({ lat: cached.driverLat, lng: cached.driverLng }, { lat: d.lat, lng: d.lng }) : Infinity;
      if (!dueForRefresh(cached?.computedAt ?? null, now, ETA_REFRESH_MS, moved, ETA_MOVE_M)) continue;
      dirService.route({
        origin: { lat: d.lat, lng: d.lng },
        destination: { lat: dt.destination_lat, lng: dt.destination_lng },
        travelMode: google.maps.TravelMode.DRIVING,
        drivingOptions: { departureTime: new Date() },
      }, (res, status) => {
        if (status !== 'OK' || !res?.routes?.[0]?.legs?.[0]) return;
        const leg = res.routes[0].legs[0];
        const travelSec = (leg.duration_in_traffic || leg.duration).value;
        const nowMs = performance.timeOrigin + performance.now();
        etaCache[o.order_id] = {
          arrivalMs: projectArrival(nowMs, travelSec, S_CUSTOMER_SEC),
          computedAt: nowMs, driverLat: d.lat, driverLng: d.lng,
        };
        renderDriversSection();
      });
    }
  }
}
```

- [ ] **Step 4: Drive it off the driver subscription** — in the `subscribeToDrivers` callback (where `updateDriverMarkers()` is called), add `refreshDeliveryEtas();` after the render calls.

- [ ] **Step 5: Render the chip in `renderTaskRow`** — the row currently ends its meta block with the phase pill. Change:

```js
      <div class="task-meta">
        <span class="phase-pill ${phase}">${phaseLabel}</span>
      </div>
```

to:

```js
      <div class="task-meta">
        <span class="phase-pill ${phase}">${phaseLabel}</span>
        ${(() => { const e = etaCache[order.order_id]; if (!e) return ''; const now = performance.timeOrigin + performance.now(); return `<span class="eta-chip">${relativeEta(e.arrivalMs, now)} · ${clockTime(e.arrivalMs)}</span>`; })()}
      </div>
```

- [ ] **Step 6: Chip CSS** — add near `.phase-pill`:

```css
  .eta-chip { font-size: 11px; font-weight: 600; color: var(--info); margin-left: 6px; font-variant-numeric: tabular-nums; }
```

- [ ] **Step 7: Sanity — module loads + inline script parses**

Run:
```bash
node --check xpizza-dispatch/driver-eta.js
node -e "import('./xpizza-dispatch/driver-eta.js').then(m=>{if(typeof m.etaEligible!=='function')process.exit(1);console.log('module OK')})"
node -e "const fs=require('fs');const h=fs.readFileSync('xpizza-dispatch/index.html','utf8');fs.writeFileSync('/tmp/dm.mjs',h.match(/<script type=\"module\">([\\s\\S]*?)<\\/script>/)[1]);" && node --check /tmp/dm.mjs && echo "inline OK"
```
Expected: `module OK` and `inline OK`.

- [ ] **Step 8: Commit**

```bash
git add xpizza-dispatch/index.html
git commit -m "feat(dispatch): live single-delivery ETA chip via DirectionsService (Phase 1a)"
```

---

### Task 3: Driver `⋯` action menu + last-known-location pin

**Files:** Modify `xpizza-dispatch/index.html`

- [ ] **Step 1: Temp last-location marker state** — near `etaCache`, add:

```js
let lastLocMarker = null;   // dim "última ubicación" pin, shown on demand, cleared on next use
```

- [ ] **Step 2: Add a driver `⋯` button** — in `renderDriverNode`'s returned `.driver-row`, insert a more-button before the chevron:

```js
      <button class="more-btn" data-more-driver="${uid}" title="Acciones del repartidor">⋯</button>
      <span class="chevron">${ICONS.chevronRight}</span>
```

- [ ] **Step 3: Wire the menu** — in `renderDriversSection`, where `.driver-row` click handlers are attached, add a handler for `[data-more-driver]` that opens `showActionMenu` (stopPropagation so it doesn't toggle expand):

```js
  tree.querySelectorAll('[data-more-driver]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = btn.dataset.moreDriver;
      const d = allDrivers[uid];
      if (!d) return;
      const order = getOrdersForDriver(uid)[0];   // reassignable active order, if any
      const items = [
        d.phone ? { label: `Llamar a ${d.name || 'repartidor'}`, icon: ICONS.phone, action: () => { window.location.href = `tel:${d.phone}`; } } : null,
        (Number.isFinite(d.lat) && Number.isFinite(d.lng)) ? { label: 'Ver última ubicación', icon: ICONS.pin, action: () => showLastLocation(uid) } : null,
        order ? { label: `Reasignar #${order.order_id}`, icon: ICONS.swap, action: () => startReassign(order.order_id, uid) } : null,
        { divider: true },
        d.active ? { label: 'Sacar de turno', icon: ICONS.close, danger: true, action: () => forceOffShift(uid) } : null,
      ].filter(Boolean);
      showActionMenu(btn, items);
    });
  });
```

- [ ] **Step 4: The three new action helpers** — add near `confirmCancelOrder`:

```js
function showLastLocation(uid) {
  const d = allDrivers[uid];
  if (!d || !Number.isFinite(d.lat) || !Number.isFinite(d.lng)) return;
  if (lastLocMarker) lastLocMarker.setMap(null);
  const ago = XPD.formatStaleness(d.last_ping);
  lastLocMarker = new google.maps.Marker({
    position: { lat: d.lat, lng: d.lng }, map,
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 12, fillColor: '#64748b', fillOpacity: 0.7, strokeColor: '#131826', strokeWeight: 2 },
    label: { text: (d.name || '?').charAt(0).toUpperCase(), color: '#fff', fontFamily: 'Plus Jakarta Sans', fontSize: '11px', fontWeight: '700' },
    zIndex: 900, title: `${d.name || uid} · última ubicación ${ago}`,
  });
  infoWindow.setContent(`<div class="info-window"><div class="iw-name">${escapeHtml(d.name || '—')}</div><div class="iw-meta">Última ubicación · ${ago}</div></div>`);
  infoWindow.open(map, lastLocMarker);
  map.panTo({ lat: d.lat, lng: d.lng });
}

async function forceOffShift(uid) {
  const d = allDrivers[uid];
  if (!confirm(`¿Sacar de turno a ${d?.name || 'este repartidor'}?\n\nSe marcará fuera de turno y desaparecerá del mapa.`)) return;
  try { await XPD.endShift(uid); toast(`${d?.name || 'Repartidor'} fuera de turno`, 'success'); }
  catch (e) { toast('Error: ' + e.message, 'error'); }
}
```

For **Reasignar**, wire `startReassign(orderId, fromUid)` to the EXISTING reassign flow. Confirm the current mechanism first:

Run: `grep -n "pickerIsReassign\|reassignOrder\|function openPicker\|startReassign\|Reasignar" xpizza-dispatch/index.html`

Then implement `startReassign` as a thin call into that existing picker (open the driver picker in reassign mode for `orderId`, expected-from `fromUid`), matching whatever signature the grep reveals. If a reassign entry point already exists, reuse it verbatim; do not rebuild `reassignOrder` logic.

- [ ] **Step 5: Icon check** — confirm `ICONS.phone`, `ICONS.pin`, `ICONS.swap`, `ICONS.close` exist; if any are missing, add a minimal inline SVG to the `ICONS` map (grep `const ICONS` first).

- [ ] **Step 6: Sanity + commit**

Run the Task-2 Step-7 inline-parse check again.
```bash
git add xpizza-dispatch/index.html
git commit -m "feat(dispatch): driver action menu (call/last-location/reassign/force-off) (Phase 1a)"
```

---

### Task 4: Pre-ship verification + acceptance + advisor gate

**Files:** none (verification).

- [ ] **Step 1: Full test suite green** — `node xpizza-dispatch/driver-eta.test.js` → `6 passed`.

- [ ] **Step 2: Dark-map / no-regression diff proof**

Run:
```bash
git diff main -- xpizza-dispatch/index.html | grep -E '^\+' | grep -Ei 'mapid|advancedmarker' && echo 'REGRESSION' || echo 'OK: no mapId/AdvancedMarker'
grep -n 'styles: DARK_MAP_STYLE' xpizza-dispatch/index.html
```
Expected: `OK: no mapId/AdvancedMarker`; `DARK_MAP_STYLE` still present. Review the diff: markers/glide, GPS-dark row, alerts, removal loop untouched.

- [ ] **Step 3: ★ Maps-key API-restriction check (advisor flag — do BEFORE deploy)**

In Google Cloud Console → APIs & Services → Credentials → the browser key used by dispatch (`AIzaSyAuzS…Y0A`): confirm **Directions API** is in the key's **API restrictions** allow-list (not only that the Directions API is *enabled* on the project). If the key is restricted to "Maps JavaScript API" only, `DirectionsService` returns `REQUEST_DENIED` and the chip silently never appears. Fix the key restriction first. (This is the same key-restriction class that caused the earlier "expired-reset" head-scratch.)

- [ ] **Step 4: Hand the diff to the advisor to gate**, then — on clearance — merge to `main` and push (dispatch git-CDs from main). On-board check with a real out-for-delivery driver: the chip shows a live ETA that updates as they move; pre-pickup orders show only the phase pill; the 4 actions work; dark board intact.

---

## Self-Review

**Spec coverage (Phase 1a):**
- Panel = enriched existing expand (renderTaskRow chip + driver `⋯` menu), no new drawer. ✅
- Single-delivery ETA, out_for_delivery only (gated on `pickupStatus==='completed'`), `Directions + S_customer`, no predictor. ✅ (Task 1 `etaEligible`, Task 2)
- Route on `tasks/{id}_delivery.destination_lat/lng` (advisor correction). ✅ (Task 2 Step 3 uses `dt.destination_lat/lng`)
- 4 actions (Call/Last-location/Reassign/Force-off). ✅ (Task 3)
- Data-honesty: no ETA without eligibility; `≈` label; no promise clock. ✅
- Maps-key API-restriction check before ship. ✅ (Task 4 Step 3)
- Dark map intact, no predictor/functions/env touched, client-only. ✅

**Placeholder scan:** the only deferred detail is `startReassign` (Task 3 Step 4), which is intentionally wired to the *existing* reassign flow discovered by grep — with the exact command to find it and the rule to reuse-not-rebuild. Not a blank.

**Type consistency:** `etaEligible`/`projectArrival`/`relativeEta`/`clockTime`/`dueForRefresh`/`distanceMeters` names identical across module, tests, and wiring. `etaCache[order_id] = {arrivalMs, computedAt, driverLat, driverLng}` shape consistent between writer (Task 2 Step 3) and readers (Task 2 Step 5). `S_CUSTOMER_SEC`/`ETA_REFRESH_MS`/`ETA_MOVE_M` referenced consistently.

**Out of scope (correctly excluded):** the ready-time predictor, stacked ETA, graduation/accuracy aggregation, predictor read-grants — all 1b/1c, each its own advisor gate. `S_merchant` (1b/1c only). Per-restaurant dwell (flat for now).

**Calibration note (post-deploy, not a build step):** tune `S_CUSTOMER_SEC` from observed `delivered_at − out_for_delivery_at − Directions_travel ≈ door dwell`.
