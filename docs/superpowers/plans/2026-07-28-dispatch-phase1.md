# Dispatch Redesign — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Phase-1 "Torre de Control" foundation for the dispatch board — an exceptions-first alert registry, delivery-risk/aging on order rows, a first-observed-ETA snapshot, and a read-only comms-thread assembler — as pure, Node-tested modules, then wire them into `index.html` with one coordinated integration patch.

**Architecture:** Follow the established dispatch module pattern (`driver-glide.js` / `driver-eta.js`): pure, dependency-free ES modules (no `google.maps`, no DOM, no globals; `now` injected as epoch ms), each with a Node test file, imported into the `<script type="module">` block with a `?v=N` cache-bust query. **Part A** builds the modules (new files — zero `index.html` contention, buildable immediately). **Part B** is the single thin `index.html` integration patch, executed only after `index.html` ownership is coordinated with the parallel Rewards B1 session.

**Tech Stack:** Vanilla ES modules, `node --test`-style assertions via `node:assert` (mirroring `driver-eta.test.js` / `driver-glide.test.js`), Firebase RTDB (existing subscriptions), Google Maps JS (existing, unchanged).

**Status:** Part A ✅ + Task 6 ✅ + Task 7 ✅ (built+gated+on-device) + Task 8 ✅ (built+on-device; codex pending). Tasks 9–12 pending. **Task 13 (topbar restyle) ADDED at Xavier's request (R5) — awaiting plan-gate before build.** Building in worktree `/Users/xavierlacayo/Downloads/xpizza-dispatch-redesign`.

---

## Global Constraints (non-negotiable — from the gate-approved spec)

1. **Zero writes, no money-path change.** `assignOrderToDriver`, `cancelOrderRemote`, `resolveReconciliation`, and the glide (`driver-glide.js`) stay untouched. Phase 1 only reads + renders.
2. **Shadow boundary inviolable.** Any `order_predictions` read is display-only, model/version-labeled, never written back. (Only relevant if the optional on-time preview is included — it is **not** in this plan's tasks; see §1b.)
3. **Every read-only subscription explicitly declared.** New reads (scheduled-orders; optional `order_timelines`; optional `order_predictions`) must be added as named, read-only subscriptions — no hand-waved reads. In this plan: **Task 10 declares a read-only `subscribeToDriverCash`** (`driver_cash`, no writes) for the cash bar; Task 9 (order rows) uses only already-subscribed `orders`/`tasks`/`etaCache` data; no other new subscription is added.
4. **Extraction guard.** Pure modules + Node tests FIRST (Part A), then ONE thin `index.html` integration patch (Part B). No opportunistic rewrites of untouched code.
5. **Coordinate `index.html` ownership** with the Rewards B1 session before starting Part B — it is the shared hot file. Part A touches only new files and is safe to build in parallel.
6. **No dropped behavior.** Regression-preserve: the alert set + the `factura_*`/unknown fallback bucket, `driver_freshness_stale`'s derived effects (`staleDriverUids`, red GPS-dark rows, the per-episode chime, dismiss), all dispatcher actions, scheduled orders, `#N`, delivered+search, reconciliation. Route ALL rendered order/message content through the existing `escapeHtml` (`index.html:3994`).
7. **1b is deferred.** Real SLA-based on-time%/lateness is tied to predictor graduation — NOT in these tasks (see §1b at the end).

**Commit convention:** conventional-commit messages, each ending with:
```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

**Test-run convention:** each module is Node-executable directly, like the existing tests:
```
node xpizza-dispatch/dispatch-<name>.test.js
```
Expected output ends with `N passed`.

---

## File Structure

**New files (Part A — `xpizza-dispatch/`):**
- `dispatch-alerts.js` — alert registry: classify a raw dispatcher alert → `{category, severity, order, iconId, known}`, with a fallback bucket for unknown/`factura_*`/no-`type` alerts. Pure.
- `dispatch-alerts.test.js`
- `dispatch-aging.js` — `agingBaselineMs`, `agingSeconds`, `agingBand`, `formatAging`. Pure.
- `dispatch-aging.test.js`
- `dispatch-eta-snapshot.js` — `createEtaSnapshotStore()` factory (session-scoped first-observed-ETA baseline per order). Pure.
- `dispatch-eta-snapshot.test.js`
- `dispatch-delivery-risk.js` — `deliveryRisk(...)` returning `{ band, level, slipMs }` (aging + snapshot slippage, no-baseline→aging-only). Pure. **Imports `agingBand` from `dispatch-aging.js`** (so build Task 2 before Task 4) — same band function drives both the row edge and the header count.
- `dispatch-delivery-risk.test.js`
- `dispatch-comms-thread.js` — `assembleThread(...)` read-only ordering of inbound messages + automessage events (display-only; no send — send is Phase 2). Pure.
- `dispatch-comms-thread.test.js`

**Modified files (Part B — one coordinated patch):**
- `xpizza-dispatch/index.html` — import the modules (`?v=1`), add the icon sprite + visual-system CSS (ported from the reviewed mockup), swap the imperative alert if-chain for a registry-driven Torre render, add aging/delivery-risk to order rows, rebuild the right rail (persistent roster + surfaced call + cash bar + switchable tabs), add collapsible rails + Cobertura, and a read-only Comms inbound thread.
- `xpizza-dispatch/xpizza-delivery.js` — add the read-only `subscribeToDriverCash(cb)` helper (Task 10).

**Visual source of truth for Part B markup/CSS:** the gate-reviewed mockup `docs/superpowers/mockups/dispatch-board-v6.html` (full "v6" — true palette, glass depth, line-icon sprite, pastel action icons). Part B ports its markup/CSS; it is a real artifact, not a placeholder.

---

# PART A — Pure modules (build now; no `index.html` contention)

## Task 1: `dispatch-alerts.js` — alert registry + fallback bucket

**Files:**
- Create: `xpizza-dispatch/dispatch-alerts.js`
- Test: `xpizza-dispatch/dispatch-alerts.test.js`

**Interface:**
- `classifyAlert(alert)` → `{ category, severity, order, iconId, known }`
  - `category`: `'driver-dark' | 'no-driver' | 'takeover' | 'payment' | 'fiscal' | 'otros'`
  - `severity`: `'red' | 'amber' | 'neutral'`
  - `order`: numeric sort key (red=0, amber=1, neutral=2) for "most-severe-first"
  - `iconId`: sprite id (`'i-signaloff' | 'i-userx' | 'i-clock' | 'i-phoneoff' | 'i-card' | 'i-alert'`)
  - `known`: boolean (false → fell into the fallback bucket)
- `sortAlertEntries(alertsObj)` → array of `{ id, alert, category, severity, iconId, known }` sorted most-severe-first (stable). **`alertsObj` is the keyed RTDB object** (`{ alertId: alert }`) exactly as delivered by `subscribeToDispatcherAlerts` (`index.html:2168` — the code uses `Object.keys/values`, not an array). The `id` is preserved so the Torre row can keep the existing dismiss wiring (`dismissDispatcherAlert(id)`, `index.html:2339`).

**Registry (must reproduce today's known types — `index.html:2239–2321`):**

| type | category | severity | iconId |
|---|---|---|---|
| `driver_freshness_stale` | driver-dark | red | i-signaloff |
| `no_drivers_available` | no-driver | red | i-userx |
| `no_response_takeover` | takeover | amber | i-phoneoff |
| `assignment_strand` | takeover | amber | i-phoneoff |
| `payment_hosted_stale_no_callback` | payment | amber | i-card |
| `payment_reconcile_breaches` | payment | neutral | i-card |
| `payment_aged_refund_pending` | payment | neutral | i-card |

**Fallback rule:** any alert whose `type` is not in the registry — **including alerts with no `type` at all (e.g. `factura_*`) and unknown payment/scheduled sub-kinds** — classifies to `category:'otros'`, `severity:'amber'`, `iconId:'i-alert'`, `known:false`. This guarantees nothing is ever dropped (Guardrail 6). A `type` beginning `factura` maps to `category:'fiscal'` (still surfaced), `severity:'amber'`, `iconId:'i-alert'`, `known:false`.

- [ ] **Step 1: Write the failing test**

```js
// xpizza-dispatch/dispatch-alerts.test.js
import assert from 'node:assert';
import { classifyAlert, sortAlertEntries } from './dispatch-alerts.js';

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// known types keep today's category/severity
{
  const c = classifyAlert({ type: 'driver_freshness_stale', driver_id: 'u1' });
  assert.strictEqual(c.category, 'driver-dark');
  assert.strictEqual(c.severity, 'red');
  assert.strictEqual(c.iconId, 'i-signaloff');
  assert.strictEqual(c.known, true);
  ok('driver_freshness_stale → driver-dark/red');
}
{
  const c = classifyAlert({ type: 'no_drivers_available' });
  assert.strictEqual(c.category, 'no-driver'); assert.strictEqual(c.severity, 'red');
  ok('no_drivers_available → no-driver/red');
}
{
  const c = classifyAlert({ type: 'payment_aged_refund_pending' });
  assert.strictEqual(c.category, 'payment'); assert.strictEqual(c.severity, 'neutral');
  ok('payment_aged_refund_pending → payment/neutral');
}
// unknown / no-type / factura → fallback bucket, NEVER dropped
{
  const u = classifyAlert({ type: 'some_new_kind' });
  assert.strictEqual(u.category, 'otros'); assert.strictEqual(u.known, false);
  const noType = classifyAlert({ message: 'x' });         // no `type` at all
  assert.strictEqual(noType.category, 'otros'); assert.strictEqual(noType.known, false);
  const fac = classifyAlert({ type: 'factura_cai_low' });
  assert.strictEqual(fac.category, 'fiscal'); assert.strictEqual(fac.known, false);
  ok('unknown / no-type / factura_* → surfaced in fallback bucket');
}
// keyed RTDB object → sorted entries, id preserved, most-severe-first
{
  const entries = sortAlertEntries({
    a1: { type: 'payment_reconcile_breaches' },  // neutral
    a2: { type: 'no_drivers_available' },         // red
    a3: { type: 'assignment_strand' },            // amber
  });
  assert.deepStrictEqual(entries.map(e => e.id), ['a2', 'a3', 'a1']);
  assert.strictEqual(entries[0].alert.type, 'no_drivers_available');
  assert.strictEqual(entries[0].category, 'no-driver');
  ok('sortAlertEntries: keyed obj → severity-sorted, id preserved');
}

console.log(`\n${pass} passed`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node xpizza-dispatch/dispatch-alerts.test.js`
Expected: FAIL — `Cannot find module './dispatch-alerts.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// xpizza-dispatch/dispatch-alerts.js
/**
 * Pure alert registry for the Torre de Control (dispatch Phase 1).
 * Classifies a raw dispatcher alert into a category/severity/icon for the
 * exceptions-first queue. Unknown / no-type / factura_* alerts fall into a
 * generic bucket so NOTHING is ever dropped (visibility guarantee).
 * No DOM, no globals — Node-testable.
 */
const SEV_ORDER = { red: 0, amber: 1, neutral: 2 };

const REGISTRY = {
  driver_freshness_stale:          { category: 'driver-dark', severity: 'red',     iconId: 'i-signaloff' },
  no_drivers_available:            { category: 'no-driver',   severity: 'red',     iconId: 'i-userx' },
  no_response_takeover:            { category: 'takeover',    severity: 'amber',   iconId: 'i-phoneoff' },
  assignment_strand:               { category: 'takeover',    severity: 'amber',   iconId: 'i-phoneoff' },
  payment_hosted_stale_no_callback:{ category: 'payment',     severity: 'amber',   iconId: 'i-card' },
  payment_reconcile_breaches:      { category: 'payment',     severity: 'neutral', iconId: 'i-card' },
  payment_aged_refund_pending:     { category: 'payment',     severity: 'neutral', iconId: 'i-card' },
};

export function classifyAlert(alert) {
  const type = alert && typeof alert.type === 'string' ? alert.type : '';
  const hit = REGISTRY[type];
  if (hit) return { ...hit, order: SEV_ORDER[hit.severity], known: true };
  // fallback bucket — surfaced, never dropped
  const category = type.startsWith('factura') ? 'fiscal' : 'otros';
  return { category, severity: 'amber', order: SEV_ORDER.amber, iconId: 'i-alert', known: false };
}

// Operates on the keyed RTDB object; preserves each alert's id (needed for dismiss).
export function sortAlertEntries(alertsObj) {
  return Object.entries(alertsObj || {})
    .map(([id, alert], i) => {
      const c = classifyAlert(alert);
      return { id, alert, category: c.category, severity: c.severity, iconId: c.iconId, known: c.known, _o: c.order, _i: i };
    })
    .sort((x, y) => x._o - y._o || x._i - y._i)   // stable within severity
    .map(({ _o, _i, ...rest }) => rest);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node xpizza-dispatch/dispatch-alerts.test.js`
Expected: PASS — `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add xpizza-dispatch/dispatch-alerts.js xpizza-dispatch/dispatch-alerts.test.js
git commit -m "feat(dispatch): alert registry + fallback bucket (Phase 1 Torre)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `dispatch-aging.js` — order aging + band

**Files:**
- Create: `xpizza-dispatch/dispatch-aging.js`
- Test: `xpizza-dispatch/dispatch-aging.test.js`

**Interface:**
- `agingBaselineMs(order)` → epoch ms baseline. Phase-1 rule: **created-time** for the unassigned queue (`order.created_at`), falling back to `order.created_at` when in flight (status-relative baselines beyond created are a later refinement; created-time is the honest Phase-1 baseline). Returns `null` if no timestamp.
- `agingSeconds(baselineMs, nowMs)` → whole seconds ≥ 0 (0 if baseline null).
- `agingBand(seconds, thresholds = { amber: 300, red: 600 })` → `'green' | 'amber' | 'red'`.
- `formatAging(seconds)` → `'m:ss'` (mono display).

- [ ] **Step 1: Write the failing test**

```js
// xpizza-dispatch/dispatch-aging.test.js
import assert from 'node:assert';
import { agingBaselineMs, agingSeconds, agingBand, formatAging } from './dispatch-aging.js';

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

{
  assert.strictEqual(agingBaselineMs({ created_at: 1000 }), 1000);
  assert.strictEqual(agingBaselineMs({}), null);
  ok('baseline = created_at (null when absent)');
}
{
  assert.strictEqual(agingSeconds(1000, 1000 + 65 * 1000), 65);
  assert.strictEqual(agingSeconds(null, 5000), 0);
  ok('agingSeconds = (now - baseline)/1000, 0 when no baseline');
}
{
  assert.strictEqual(agingBand(120), 'green');
  assert.strictEqual(agingBand(400), 'amber');
  assert.strictEqual(agingBand(700), 'red');
  ok('band thresholds green/amber/red');
}
{
  assert.strictEqual(formatAging(65), '1:05');
  assert.strictEqual(formatAging(600), '10:00');
  ok('formatAging m:ss');
}

console.log(`\n${pass} passed`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node xpizza-dispatch/dispatch-aging.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// xpizza-dispatch/dispatch-aging.js
/**
 * Pure order-aging helpers (dispatch Phase 1). Baseline = created-time for the
 * unassigned queue (honest Phase-1 baseline); `now` injected as epoch ms.
 */
export function agingBaselineMs(order) {
  return order && Number.isFinite(order.created_at) ? order.created_at : null;
}

export function agingSeconds(baselineMs, nowMs) {
  if (baselineMs == null) return 0;
  return Math.max(0, Math.floor((nowMs - baselineMs) / 1000));
}

export function agingBand(seconds, thresholds = { amber: 300, red: 600 }) {
  if (seconds >= thresholds.red) return 'red';
  if (seconds >= thresholds.amber) return 'amber';
  return 'green';
}

export function formatAging(seconds) {
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node xpizza-dispatch/dispatch-aging.test.js`
Expected: PASS — `4 passed`.

- [ ] **Step 5: Commit**

```bash
git add xpizza-dispatch/dispatch-aging.js xpizza-dispatch/dispatch-aging.test.js
git commit -m "feat(dispatch): order aging + band (Phase 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `dispatch-eta-snapshot.js` — session-scoped first-observed-ETA store

**Files:**
- Create: `xpizza-dispatch/dispatch-eta-snapshot.js`
- Test: `xpizza-dispatch/dispatch-eta-snapshot.test.js`

**Interface (factory, instance holds a private `Map` — no globals):**
- `createEtaSnapshotStore()` → `{ observe(orderId, arrivalMs), baseline(orderId), clear(orderId), has(orderId) }`
  - `observe`: records the arrivalMs **only if** none recorded yet for that orderId AND `arrivalMs` is finite (first-observed wins; later ETAs ignored).
  - `baseline`: returns the stored first-observed arrivalMs, or `null`.
  - `clear`: drops the order (call on delivery/removal).

**Contract:** this store is created fresh per page load, so it only ever holds ETAs **this dispatcher session has observed** — a browser opened after `out_for_delivery` has no baseline until it observes one. Delivery-risk (Task 4) treats a null baseline as "aging only," never a false "slipping."

- [ ] **Step 1: Write the failing test**

```js
// xpizza-dispatch/dispatch-eta-snapshot.test.js
import assert from 'node:assert';
import { createEtaSnapshotStore } from './dispatch-eta-snapshot.js';

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

{
  const s = createEtaSnapshotStore();
  assert.strictEqual(s.baseline('o1'), null);
  assert.strictEqual(s.has('o1'), false);
  ok('no baseline before observing');
}
{
  const s = createEtaSnapshotStore();
  s.observe('o1', 5000);
  s.observe('o1', 9000);                 // later ETA ignored — first observed wins
  assert.strictEqual(s.baseline('o1'), 5000);
  ok('first observed wins, later ignored');
}
{
  const s = createEtaSnapshotStore();
  s.observe('o1', NaN);                  // non-finite ignored
  assert.strictEqual(s.baseline('o1'), null);
  ok('non-finite arrival not recorded');
}
{
  const s = createEtaSnapshotStore();
  s.observe('o1', 5000); s.clear('o1');
  assert.strictEqual(s.baseline('o1'), null);
  ok('clear drops baseline');
}

console.log(`\n${pass} passed`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node xpizza-dispatch/dispatch-eta-snapshot.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// xpizza-dispatch/dispatch-eta-snapshot.js
/**
 * Session-scoped first-observed-ETA store (dispatch Phase 1 delivery-risk).
 * Holds only the FIRST ETA this dispatcher session observed per order, so a
 * browser opened mid-delivery honestly has no baseline until it observes one.
 * Pure — a fresh instance per page load; no globals.
 */
export function createEtaSnapshotStore() {
  const first = new Map(); // orderId -> arrivalMs
  return {
    observe(orderId, arrivalMs) {
      if (!first.has(orderId) && Number.isFinite(arrivalMs)) first.set(orderId, arrivalMs);
    },
    baseline(orderId) { return first.has(orderId) ? first.get(orderId) : null; },
    clear(orderId) { first.delete(orderId); },
    has(orderId) { return first.has(orderId); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node xpizza-dispatch/dispatch-eta-snapshot.test.js`
Expected: PASS — `4 passed`.

- [ ] **Step 5: Commit**

```bash
git add xpizza-dispatch/dispatch-eta-snapshot.js xpizza-dispatch/dispatch-eta-snapshot.test.js
git commit -m "feat(dispatch): session-scoped first-observed-ETA store (Phase 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `dispatch-delivery-risk.js` — delivery-risk (aging + slip, no-baseline→aging-only)

**Files:**
- Create: `xpizza-dispatch/dispatch-delivery-risk.js`
- Test: `xpizza-dispatch/dispatch-delivery-risk.test.js`

**Interface:**
- `deliveryRisk({ agingSeconds, agingThresholds = { amber: 300, red: 600 }, baselineArrivalMs = null, currentArrivalMs = null, slipThresholdMs = 240000 })` → `{ band, level, slipMs }`
  - `band`: `'green' | 'amber' | 'red'` — computed with the SAME `agingBand` used on the rows (imported from `dispatch-aging.js`), so the row edge color and this value can never diverge. **Drives the row edge.**
  - `level`: `'ok' | 'aging' | 'slipping'` — **drives the Torre header count** (count rows where `level !== 'ok'`).
  - **Explicit contract (removes the row/header divergence):** an **amber band alone is a visual heads-up and does NOT count** (`level:'ok'`). Only **red-band aging** (`level:'aging'`) and a **slip** (`level:'slipping'`) count in the header.
  - **No-baseline fallback (behavioral contract):** if `baselineArrivalMs` is `null` OR `currentArrivalMs` is `null`, the slipping comparison is **suppressed** — `level` is aging-only (`'aging'` iff `band === 'red'`, else `'ok'`), and `slipMs` is `null`.
  - With both present: `slipMs = currentArrivalMs - baselineArrivalMs`; `level = 'slipping'` iff `slipMs >= slipThresholdMs`; else falls back to the aging rule above. `band` is always returned regardless of `level`.

- [ ] **Step 1: Write the failing test**

```js
// xpizza-dispatch/dispatch-delivery-risk.test.js
import assert from 'node:assert';
import { deliveryRisk } from './dispatch-delivery-risk.js';

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// no baseline + red band → aging only, never "slipping"
{
  const r = deliveryRisk({ agingSeconds: 700, baselineArrivalMs: null, currentArrivalMs: 999999 });
  assert.strictEqual(r.band, 'red');
  assert.strictEqual(r.level, 'aging');   // red-aging, but NOT slipping
  assert.strictEqual(r.slipMs, null);
  ok('no baseline + red band → aging, slip suppressed');
}
// amber band alone → visual heads-up but does NOT count (level ok)
{
  const r = deliveryRisk({ agingSeconds: 400, baselineArrivalMs: null, currentArrivalMs: null });
  assert.strictEqual(r.band, 'amber');
  assert.strictEqual(r.level, 'ok');
  assert.strictEqual(r.slipMs, null);
  ok('amber band alone → level ok (row shows amber, header does not count)');
}
// baseline present, slipped past threshold → slipping (band still reflects aging)
{
  const base = 1_000_000, cur = base + 5 * 60 * 1000;   // slipped 5 min
  const r = deliveryRisk({ agingSeconds: 60, baselineArrivalMs: base, currentArrivalMs: cur });
  assert.strictEqual(r.band, 'green');
  assert.strictEqual(r.level, 'slipping');
  assert.strictEqual(r.slipMs, 5 * 60 * 1000);
  ok('baseline + 5min slip → slipping (band=green, level=slipping)');
}
// baseline present, within tolerance + old → aging rule
{
  const base = 1_000_000, cur = base + 60 * 1000;       // only 1 min
  const r = deliveryRisk({ agingSeconds: 700, baselineArrivalMs: base, currentArrivalMs: cur });
  assert.strictEqual(r.band, 'red');
  assert.strictEqual(r.level, 'aging');
  ok('baseline + small slip + old → aging');
}

console.log(`\n${pass} passed`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node xpizza-dispatch/dispatch-delivery-risk.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// xpizza-dispatch/dispatch-delivery-risk.js
/**
 * Pure delivery-risk classifier (dispatch Phase 1). Returns BOTH the aging `band`
 * (drives the row edge) and the risk `level` (drives the Torre header count), using
 * the SAME agingBand as the rows so the two can never diverge. Amber band alone is a
 * heads-up (level 'ok'); only red-aging and slip count. NEVER a promise-based "late-by":
 * with no observed baseline the slip comparison is suppressed and only aging is used.
 */
import { agingBand } from './dispatch-aging.js';

export function deliveryRisk({
  agingSeconds,
  agingThresholds = { amber: 300, red: 600 },
  baselineArrivalMs = null,
  currentArrivalMs = null,
  slipThresholdMs = 240000,   // 4 min slip vs first observed
}) {
  const band = agingBand(agingSeconds, agingThresholds);
  const agingLevel = band === 'red' ? 'aging' : 'ok';   // amber alone does NOT count
  // No baseline (browser opened mid-delivery / no ETA observed yet) → aging only.
  if (baselineArrivalMs == null || currentArrivalMs == null) {
    return { band, level: agingLevel, slipMs: null };
  }
  const slipMs = currentArrivalMs - baselineArrivalMs;
  if (slipMs >= slipThresholdMs) return { band, level: 'slipping', slipMs };
  return { band, level: agingLevel, slipMs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node xpizza-dispatch/dispatch-delivery-risk.test.js`
Expected: PASS — `4 passed`.

- [ ] **Step 5: Commit**

```bash
git add xpizza-dispatch/dispatch-delivery-risk.js xpizza-dispatch/dispatch-delivery-risk.test.js
git commit -m "feat(dispatch): delivery-risk classifier w/ no-baseline aging-only fallback (Phase 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `dispatch-comms-thread.js` — read-only inbound thread assembly

**Files:**
- Create: `xpizza-dispatch/dispatch-comms-thread.js`
- Test: `xpizza-dispatch/dispatch-comms-thread.test.js`

**Scope note:** Phase 1 uses this ONLY for a **read-only** view of existing inbound `incoming_messages` + order automessage state in the Comms tab. The composer/send and driver-messaging are Phase 2 — do NOT add any send here.

**Interface:**
- `assembleThread({ inbound = [], autoEvents = [] })` → array of `{ kind, text, ts }` sorted ascending by `ts`.
  - `inbound` items follow the **real `incoming_messages` shape** (confirmed in `xpizza-functions/index.js`): **chat** messages carry `received_at` = `ServerValue.TIMESTAMP` (epoch **ms**, `index.js:3487`); **non-chat/media** messages carry `time` (epoch **seconds**, `index.js:3382`) and **no `received_at`**, with `body` possibly `null`. Derive `ts = received_at` if finite, else `time * 1000` if finite, else DROP. `text = body ?? '(media)'`. → `{ kind:'in', text, ts }`. **This prevents silently dropping non-chat inbound messages** (the naive `received_at`-only version would drop them).
  - `autoEvents` items: `{ label, at }` → `{ kind:'auto', text: label, ts: at }` (drop non-finite `at`).
  - No HTML here — escaping happens at render (Guardrail 6).

- [ ] **Step 1: Write the failing test**

```js
// xpizza-dispatch/dispatch-comms-thread.test.js
import assert from 'node:assert';
import { assembleThread } from './dispatch-comms-thread.js';

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

{
  const t = assembleThread({
    inbound: [
      { body: '¿ya viene?', received_at: 200 },       // chat, ms
      { type: 'image', body: null, time: 1 },          // non-chat: time=1s → 1000ms, body null
    ],
    autoEvents: [{ label: 'Pedido recibido', at: 100 }],
  });
  assert.deepStrictEqual(t, [
    { kind: 'auto', text: 'Pedido recibido', ts: 100 },
    { kind: 'in', text: '¿ya viene?', ts: 200 },
    { kind: 'in', text: '(media)', ts: 1000 },         // time*1000, media fallback text
  ]);
  ok('merges chat(received_at) + non-chat(time*1000) + auto; media fallback');
}
{
  const t = assembleThread({ inbound: [{ body: 'x' }], autoEvents: [] });  // no received_at, no time
  assert.deepStrictEqual(t, []);
  ok('drops inbound with no orderable timestamp');
}
{
  assert.deepStrictEqual(assembleThread({}), []);
  ok('empty input → empty thread');
}

console.log(`\n${pass} passed`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node xpizza-dispatch/dispatch-comms-thread.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// xpizza-dispatch/dispatch-comms-thread.js
/**
 * Pure read-only comms-thread assembler (dispatch Phase 1). Orders existing
 * inbound WhatsApp messages + order automessage events into a single timeline
 * for a read-only Comms view. Display-only — no send (send is Phase 2).
 */
export function assembleThread({ inbound = [], autoEvents = [] } = {}) {
  const items = [];
  for (const m of inbound) {
    // chat → received_at (ms); non-chat/media → time (seconds). Never silently drop non-chat.
    const ts = Number.isFinite(m.received_at) ? m.received_at
             : Number.isFinite(m.time) ? m.time * 1000
             : null;
    if (ts == null) continue;
    items.push({ kind: 'in', text: m.body ?? '(media)', ts });
  }
  for (const e of autoEvents) {
    if (Number.isFinite(e.at)) items.push({ kind: 'auto', text: e.label, ts: e.at });
  }
  return items.sort((a, b) => a.ts - b.ts);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node xpizza-dispatch/dispatch-comms-thread.test.js`
Expected: PASS — `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add xpizza-dispatch/dispatch-comms-thread.js xpizza-dispatch/dispatch-comms-thread.test.js
git commit -m "feat(dispatch): read-only comms-thread assembler (Phase 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# PART B — Integration into `index.html` (grid foundation + content tasks — COORDINATED)

> **Sequenced (R2):** the approved design is a **3-column board**, so Part B leads with a **grid-foundation task (Task 7)** that transforms the skeleton, then renders content into the established containers (Tasks 8–12). Task 7 is the one non-additive task; the rest are render/restyle into the grid. One commit per task, in order, each gated by codex-on-diff before the next.

> **STOP — coordination gate (Guardrail 5).** Do not begin Part B until `index.html` ownership is coordinated with the parallel Rewards B1 session. Part A above is safe to complete first (new files only). Confirm current tree = `origin/main` before editing (`git fetch`; the spec branch base is byte-identical to `origin/main` per the executor brief, but re-verify at build time). **Line-number anchors in the tasks are as of the plan base — Task 6 shifted them ≈ +54; re-locate by the named symbol.**

**How to verify Part B (no Node harness — `index.html` is not unit-tested):** load the dispatch board locally, and for each task check the "Expected" acceptance notes with the browser console open (zero errors) and confirm the Guardrail-6 regression list still works.

**Markup/CSS source:** port from `docs/superpowers/mockups/dispatch-board-v6.html` (the gate-reviewed v6). Keep the true palette tokens from `index.html:18–35`; add depth/glass as gradient+shadow layers on top (do not change base token values).

> **⚠ DO-NOT-PORT exclusions (guardrail — applies to every Part-B porting task 7/8/10/11/12).** The mockup contains **out-of-scope future UI** that is forbidden by the Global Constraints (1b deferred; read-only comms, no send). When porting markup/CSS, **do NOT port**:
> - the **On-time % / "A tiempo" KPI** (mockup `:253`) — that's 1b (no SLA/promise exists yet).
> - the **"tarde" / "sobre ETA" late-by copy** (mockup `:272`) — Phase 1 shows delivery-risk/aging + "slipping vs primer estimado" only, never a promise-based late-by.
> - the **"Chat cliente" / "Mensaje" composer/send input** (mockup `:402`) — Phase 1 comms is **read-only** (send is Phase 2).
> Port structure, layout, the icon sprite, depth/glass, pastel actions, aging timers, and the exceptions/roster/cash chrome only. If in doubt, a control that *writes* or *promises* is out of scope.

## Task 6: Imports + icon sprite + visual-system CSS

**Files:** Modify `xpizza-dispatch/index.html`

- [ ] **Step 1: Add module imports** after `index.html:1880` (the `driver-eta.js` import), each with `?v=1`:

```js
import { classifyAlert, sortAlertEntries } from './dispatch-alerts.js?v=1';
import { agingBaselineMs, agingSeconds, agingBand, formatAging } from './dispatch-aging.js?v=1';
import { createEtaSnapshotStore } from './dispatch-eta-snapshot.js?v=1';
import { deliveryRisk } from './dispatch-delivery-risk.js?v=1';
import { assembleThread } from './dispatch-comms-thread.js?v=1';
const etaSnapshots = createEtaSnapshotStore();
```

- [ ] **Step 2: Add the SVG icon sprite** — copy the `<svg ...><defs>…</defs></svg>` sprite block from `docs/superpowers/mockups/dispatch-board-v6.html` (symbols `i-menu, i-panel, i-search, i-chevdown, i-close, i-phone, i-message, i-send, i-more, i-maximize, i-layers, i-signaloff, i-userx, i-clock, i-phoneoff, i-card`) into the top of `<body>`. **Add one more symbol `i-alert`** (fallback-bucket icon), e.g. Feather `alert-triangle`. **Critical:** set `fill:none;stroke:currentColor;stroke-width:2` on each `<symbol>` (or the rendered `.ic` svg) — NOT on a wrapping `<g>` in `<defs>` (that does not propagate through `<use>` and renders black-filled). Add `.ic{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}` to the stylesheet.

- [ ] **Step 3: Add the visual-system CSS** — port the depth/glass/pastel classes from `docs/superpowers/mockups/dispatch-board-v6.html` (card elevation gradients + shadow, glass `backdrop-filter` panels, pastel `.da.call/.msg/.more`, motion keyframes) under a `@media (prefers-reduced-motion: reduce){*{animation:none!important}}` guard. Reuse existing `:root` tokens; do not redefine them. **Honor the ⚠ DO-NOT-PORT exclusions above** — do not bring over the on-time% KPI, late-by copy, or composer markup/CSS.

- [ ] **Step 4: Verify** — reload; console shows no module-load errors; a temporary `<svg class="ic"><use href="#i-signaloff"/></svg>` renders as a visible line icon (not a black blob). Remove the temporary probe.

- [ ] **Step 5: Commit**

```bash
git add xpizza-dispatch/index.html
git commit -m "feat(dispatch): wire Phase-1 modules + icon sprite + visual system

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 7: Grid foundation — 3-column board + collapse rails (SKELETON TRANSFORM)

**Files:** Modify `xpizza-dispatch/index.html` (DOM structure + CSS + a `tog()` helper).

> **The one non-additive, skeleton-transforming task in Part B — it carries the Guardrail-6 risk and gets the hardest gate.** The gate-approved design (R4) is a **3-column board: Torre (left) │ map (center) │ right rail**, with ☰/⇥ collapse rails. The current DOM is a different skeleton (`position:fixed` floating alert strip + a **resizable** `<aside class="sidebar">` + map). This task replaces that skeleton with the approved grid; content Tasks 8–12 then render into the established containers. **Zero-write, no money path, no subscription.** (Line-number anchors below are as of the plan base — Task 6 shifted them ≈ +54; re-locate by the named symbol at build time.)

- [ ] **Step 1 — grid shell + CSS + Torre render target.** Wrap the board in `.app` (default `class="app left-open right-open"`); add `.main` 3-col grid + `.col` columns + collapse transitions ported from `docs/superpowers/mockups/dispatch-board-v6.html`: `.main{display:grid;grid-template-columns:var(--lw) 1fr var(--rw);transition:grid-template-columns .26s}`, `.app:not(.left-open) .main{--lw:0px}`, `.app:not(.right-open) .main{--rw:0px}`, `.col`/`.col.left`/`.col.right`/`.scroll`. Add `--lw`/`--rw` tokens; reuse the Task-6 tokens. **Create an empty `<div id="torre-list">` at the TOP of the left `.col`** (ahead of the migrated sidebar content) — this is Task 8's render target; without it Task 8 would guess.
- [ ] **Step 2 — migrate existing regions (real elements only — no phantoms).** Reparent the **existing `#map-container`** (`1792`) — its `#map` (`1803`), `#map-fit-btn` (`1793`), the `google.maps` instance from init (`~2140`), glide pins + all markers — **untouched**, into the **center `.col`**. **There are NO layers controls and NO legend in the live DOM — do not invent them.** Reparent the existing sidebar sections `#unassigned-group` (`1810`), `#drivers-group` (`1818`), `#reconciliation-group` (`1826`), `#delivered-group` (`1836`) into the **left `.col`** *below* `#torre-list`, as-is (splitting the roster → right rail is Task 10). Add an **empty right `.col`** placeholder (populated in Task 10). **Verify the map renders/pans/glides and every migrated section still works.**
- [ ] **Step 3 — collapse rails + `tog()` (module-scope safe) + map-resize (Guardrail 6).** Add the topbar **☰** (`#i-menu`, toggles `left-open`) and **⇥** (`#i-panel`, toggles `right-open`) buttons. **The code runs in `<script type="module">` (`1877`), so an inline `onclick="tog()"` will NOT resolve** — wire the buttons with **`addEventListener`** (or assign `window.tog = …`). **CRITICAL:** after a collapse/expand changes the rail widths, **re-trigger the map resize** — `google.maps.event.trigger(map, 'resize')` — once the grid-column transition finishes (listen for `transitionend` on `.main`, or fire after the ~260 ms transition), exactly as the retired sidebar handlers did. Without this the map renders mis-sized after a collapse.
- [ ] **Step 4 — retire the drag-resize sidebar model (POINT-2, flagged for Xavier).** The spec/mockup use ☰/⇥ collapse, **not** drag-resize. Remove `#sidebar-resize-handle`, `#sidebar-collapse-btn`, `#sidebar-show-btn`, the width-persistence (`4152`), and their handlers (`4081–4090`, `4192–4215`) — an intentional user-facing change (drag-resize → collapse-rails), not a silent drop. **Those handlers ALSO held the `google.maps.event.trigger(map,'resize')` calls (`4084/4090/4192/4215`) — that behavior is NOT dropped; it moves to the collapse listener in Step 3.** **CRITICAL — also remove the pre-handler icon-init at `4077–4078`** (`$('sidebar-collapse-btn').querySelector('.sb-icon')…` and `$('sidebar-show-btn')…`): they deref the removed buttons and would throw a null-deref in the module script *before board wiring finishes* → the whole board breaks on load. **Keep line `4079`** (`$('delivered-toggle')…` — unrelated, still needed). Confirm nothing else depends on the removed handles/persistence.
- [ ] **Step 5 — no-gap behavior preservation (Guardrail 6).** The `position:fixed` floating alert strip (`#dispatcher-alerts`, `1788`) **stays functional and in place** — floats over the new grid, keeps rendering (staleDriverUids / red GPS-dark rows / per-episode chime / dismiss all live). Alerts relocate into `#torre-list` **only in Task 8** — there is **never a window where alerts render nowhere**.
- [ ] **Step 6 — Verify:** board loads as 3 columns; ☰/⇥ collapse each rail AND the map re-fits correctly (the resize trigger fires); map + every migrated section + the floating alerts all still work; console clean; `prefers-reduced-motion` respected.
- [ ] **Step 7 — Commit**

```bash
git add xpizza-dispatch/index.html
git commit -m "feat(dispatch): Part B Task 7 — 3-column grid foundation + collapse rails (retire drag-resize)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 8: Torre de Control — registry-driven render (preserve derived effects)

**Files:** Modify `xpizza-dispatch/index.html` — `renderDispatcherAlerts`, keep the `staleDriverUids` computation UNCHANGED. Now that **Task 7** created the `#torre-list` container, this task **relocates** the alert render into it (under a "Torre de control" section header) and **retires** the `position:fixed` floating `#dispatcher-alerts` strip.

- [ ] **Step 1:** Replace the imperative `if (a.type === …)` chain in `renderDispatcherAlerts(alerts)` with a registry-driven render, targeting the **`#torre-list`** container (from Task 7) under a **"Torre de control"** header. `alerts` is the keyed RTDB object — iterate `for (const e of sortAlertEntries(alerts))` and render an `.ex` row per entry: icon `#${e.iconId}`, severity class from `e.severity`, title/detail from `e.alert` fields (all through `escapeHtml`), and a dismiss button carrying `data-dismiss-id="${e.id}"` so the existing dismiss wiring (`dismissDispatcherAlert(id)`) still fires. **Preserve the per-type copy** for the 7 known types (do NOT regress the existing bespoke titles/details); unknown/`factura_*` (`!e.known`) group under an **"Otros / Revisar"** bucket header (humanized type). Port the `.ex` markup/CSS from `docs/superpowers/mockups/dispatch-board-v6.html`.
- [ ] **Step 2 (Guardrail 6 — critical):** Preserve `driver_freshness_stale`'s derived effects. Leave lines `2186–2191` (build `staleDriverUids`) and the per-episode chime intact. In the new render, `driver_freshness_stale` now ALSO appears as a red Torre row (it previously rendered no banner) — verify `staleDriverUids`, the red GPS-dark driver rows (`gpsDark`, `3048`), the chime, and `dismissDispatcherAlert` all still fire.
- [ ] **Step 3: Verify** — inject a fake `factura_cai_low` (no registry entry) and confirm it appears in the "Otros / Revisar" bucket (not dropped); a `driver_freshness_stale` alert shows a red row AND still reddens the driver's row + fires the chime once.
- [ ] **Step 4: Commit**

```bash
git add xpizza-dispatch/index.html
git commit -m "feat(dispatch): Torre registry render + fallback bucket; preserve freshness-stale effects

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 9: Order rows — aging + delivery-risk

**Files:** Modify `xpizza-dispatch/index.html` — order-row renderers (`renderUnassignedSection`/`renderTaskRow` `3128`), ETA cache (`etaCache`, set at `3007`).

- [ ] **Step 1 (observe — extract the local):** at `index.html:3007`, `arrivalMs` is currently computed *inline inside the object literal*, so it is not a local variable. Extract it first, then observe:

```js
const arrivalMs = projectArrival(t, travelSec, S_CUSTOMER_SEC);
etaCache[orderId] = { arrivalMs, computedAt: t, driverLat: dLat, driverLng: dLng };
etaSnapshots.observe(orderId, arrivalMs);   // first-observed-ETA baseline
renderDriversSection();
```

- [ ] **Step 2 (clear — anchor to the delete branch):** at `index.html:~2989`, the not-eligible branch does `delete etaCache[o.order_id]; continue;`. Add the snapshot cleanup right after the delete so a delivered/removed order drops its baseline:

```js
delete etaCache[o.order_id];
etaSnapshots.clear(o.order_id);
continue;
```

- [ ] **Step 3:** In the order-row render, compute `const secs = agingSeconds(agingBaselineMs(order), Date.now())` and render `formatAging(secs)`. Add the `data-tick` live-updater (mirroring the mockup) so timers count up.
- [ ] **Step 4:** Compute risk once and drive BOTH the row edge and the header from it (they cannot diverge):

```js
const risk = deliveryRisk({
  agingSeconds: secs,
  baselineArrivalMs: etaSnapshots.baseline(order.order_id),
  currentArrivalMs: etaCache[order.order_id]?.arrivalMs ?? null,
});
// row edge color = risk.band (green|amber|red)
// show "slipping vs primer estimado" ONLY when risk.level === 'slipping'; else aging only.
// NEVER a promise-based "late-by".
```

- [ ] **Step 5:** Feed the Torre delivery-risk header count from the same `risk` per row: `count = rows.filter(r => r.level !== 'ok').length` (i.e. `aging` + `slipping`; an amber band alone is `level:'ok'` and correctly does NOT count — see the `deliveryRisk` contract). No new subscription — uses `orders`/`tasks`/`etaCache` already in memory.
- [ ] **Step 6: Verify** — an order with no observed ETA shows aging only (no "slipping"); an amber-band order shows the amber edge but is NOT in the header count; a red-band order IS counted; after the session observes an ETA and a later ETA slips ≥4 min, the row flags "slipping vs primer estimado" and IS counted.
- [ ] **Step 7: Commit**

```bash
git add xpizza-dispatch/index.html
git commit -m "feat(dispatch): order-row aging + delivery-risk (no-baseline aging-only)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 10: Right rail — persistent roster + surfaced call + cash bar + tabs

**Files:**
- Modify `xpizza-dispatch/index.html` — `renderDriversSection` (`2862`) / `renderDriverNode` (`3039`), sidebar structure.
- Modify `xpizza-dispatch/xpizza-delivery.js` — add the read-only `subscribeToDriverCash(cb)` helper next to the existing `subscribeTo*` helpers (`xpizza-delivery.js:504/606`). **Commit this file too** (see Step 5).

- [ ] **Step 1 (cash bar — fully specified, grounded in the rules):** Restructure the right rail per §5.5: a compact **Cash/cuadre bar** + the **always-visible driver roster** + a switchable tab region (Pedidos/Programados/Comms/Caja). Port markup/CSS from `docs/superpowers/mockups/dispatch-board-v6.html`. **Honor the ⚠ DO-NOT-PORT exclusions above** — the mockup's topbar "A tiempo %" KPI and the cash bar's live "Efectivo en calle" number are out of scope (1b / deferred); port the roster + cuadre-total chrome only.
  - **New read-only subscription (declare it):** add `subscribeToDriverCash(cb)` to `xpizza-dispatch/xpizza-delivery.js`, mirroring the existing `subscribeTo*` helpers — `onValue(ref(db, 'driver_cash'), snap => cb(snap.val() || {}))`. Read-only, **no writes**.
  - **State shape (from `database.rules.json:113`, dispatcher-readable):** `driver_cash/{driverId}/{shiftId}/cuadre/{ cash_owed:number, cash_order_count:number, closed_at:number }`. These are **CLOSED cuadre records only** — the rules define no other child under a shift.
  - **Aggregation (honest, grounded):** "Cuadre hoy" = across every `cuadre` whose `closed_at` falls on today (America/Tegucigalpa), `sum(cash_owed)` and `sum(cash_order_count)`. Render `Cuadre hoy: L{total} · {count} pedidos`.
  - **Scope note (no guessing):** an **open "efectivo en calle" (un-settled) figure is NOT derivable from `driver_cash`** — only closed cuadres live there. So the Phase-1 cash bar shows **settled cuadre totals only**; the mockup's live "Efectivo en calle (turno)" number is **deferred** until its real source (active cash orders) is defined in a follow-up. Do not fabricate it from `driver_cash`.
- [ ] **Step 2:** Surface the existing driver actions on the card face as pastel line-icon buttons: **Llamar** (`tel:${d.phone}`, mint `.da.call` `#i-phone`) — reuse the exact existing `tel:` behavior (`2892`); **Mensaje in-app** (periwinkle `.da.msg` `#i-message`) — Phase-1 stub that opens the read-only Comms thread (send is Phase 2); **`⋯`** (`.da.more` `#i-more`) — the existing menu (last location / reassign / force off-shift). Do not change the underlying actions.
- [ ] **Step 3:** Keep the GPS-dark red row (`gpsDark`) exactly as-is.
- [ ] **Step 4: Verify** — roster always visible; Llamar still dials; ⋯ still reassigns / forces off-shift; switching tabs does not hide the roster.
- [ ] **Step 5: Commit** (include BOTH files — the helper in `xpizza-delivery.js` and the render in `index.html`):

```bash
git add xpizza-dispatch/xpizza-delivery.js xpizza-dispatch/index.html
git commit -m "feat(dispatch): persistent driver roster + surfaced call + cash bar + tabs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 11: Cobertura drawer + collapse polish

**Files:** Modify `xpizza-dispatch/index.html`

> The ☰/⇥ collapse rails + `tog()` themselves were built in **Task 7** (grid foundation). This task adds the remaining polish that depends on the content being in place.

- [ ] **Step 1:** Add the collapsible **Cobertura de capacidades** footer drawer (default collapsed) — port markup/CSS from `docs/superpowers/mockups/dispatch-board-v6.html`. (Honor the ⚠ DO-NOT-PORT exclusions.)
- [ ] **Step 2:** Add the **exceptions-count dot badge on `☰`** shown when the left rail is collapsed *and* the Torre has pending exceptions (depends on the Torre living in the left rail — Task 8).
- [ ] **Step 3: Verify** — Cobertura drawer opens/closes; the ☰ badge appears only when the left rail is closed with pending exceptions; no layout break; `prefers-reduced-motion` respected.
- [ ] **Step 4: Commit**

```bash
git add xpizza-dispatch/index.html
git commit -m "feat(dispatch): Cobertura drawer + collapse-rail exceptions badge polish

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 12: Read-only Comms inbound thread

**Files:** Modify `xpizza-dispatch/index.html` — Comms tab, using the existing `incoming_messages` subscription (`2391`).

- [ ] **Step 1:** In the Comms tab, for a selected customer, build `assembleThread({ inbound: <their incoming_messages>, autoEvents: [{label:'Recibido', at: order.order_received_notified_at}] })` and render the ordered items **read-only** (glass thread from `docs/superpowers/mockups/dispatch-board-v6.html`), every text through `escapeHtml`. Show the limited "Recibido: enviado / no-entregado" chip from `order_received_notified_at` / `order_received_send_unresolved_at` only. **Honor the ⚠ DO-NOT-PORT exclusions above — port the thread bubbles/header ONLY; do NOT port the "Chat cliente / Mensaje" composer/send input (mockup `:402`).**
- [ ] **Step 2 (Guardrail):** NO composer/send in Phase 1 — the "Responder" affordance stays the existing `wa.me` deep-link until Phase 2 replaces it with the audited dispatcher-send function.
- [ ] **Step 3: Verify** — inbound messages + the "Recibido" event render in time order, read-only; the existing inbound handled/unhandled marking still works.
- [ ] **Step 4: Commit**

```bash
git add xpizza-dispatch/index.html
git commit -m "feat(dispatch): read-only Comms inbound thread (assembleThread)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 13: Topbar restyle (visual parity with the mockup)

**Added at Xavier's request (2026-07-28)** for full v6 parity, **conditioned on preserving every advisor-flagged behavior** — this is a *visual restyle only*, no new behavior, no dropped handler.

**Files:** Modify `xpizza-dispatch/index.html` (topbar markup + CSS).

- [ ] **Step 1 — restyle to the mockup topbar**, porting markup/CSS from `docs/superpowers/mockups/dispatch-board-v6.html`: KPI **chips** (En turno · Sin asignar · Activos · Entregados), the **auto-asignar pill**, the **messages** icon-button (with badge), an **avatar pill**, and a **restaurant-name display pill** (**display only — NOT a switcher**; dispatch is single-restaurant). Keep the ☰ (left) / ⇥ (right) toggles from Task 7. Map mockup tokens to the real `--text-*` tokens.
- [ ] **Step 2 — preserve EVERY existing behavior + binding (Guardrail 6), named explicitly:**
  - **`topbar-user`** — the live auth wiring is `$('topbar-user').textContent = user.email` (`index.html:2115`). **Keep `#topbar-user` and its auth-state binding.** The avatar shows initials **derived from that same element's value** (do NOT introduce a parallel unbound element that would null-deref on login or get overwritten by the email). Render the initials via **`textContent` / `escapeHtml`** — display-only.
  - **Restaurant pill** — the name is `XPD.RESTAURANT.name` (`xpizza-delivery.js:47`); render it via **`textContent` / `escapeHtml`**, display-only.
  - **`auto-assign-toggle`** → `setAutoAssignEnabled` + its on/off state sync; **`msg-btn`** → `openMessagesModal` + the `msg-badge` count; **`signout-btn`**; the live stat bindings `stat-drivers` / `stat-pending` / `stat-active` / `stat-delivered`; the `data-version-display` tag.
  - **Rail toggles** — keep the exact ids/handlers from Task 7: `#rail-toggle-left` → `togRail('left-open')` and `#rail-toggle-right` → `togRail('right-open')` (`index.html:4111–4112`). Restyle only; do not detach them.
  - Restyle the elements; **do not rewire any of them.**
- [ ] **Step 3 — EXCLUDE the design-deferred controls (DO-NOT-PORT):** **no On-time % / "A tiempo" KPI** (→ 1b) and **no ⌘K search / command palette** (→ Phase 3). The 4 existing stats stay (relabeled to the mockup style, same underlying ids/bindings).
- [ ] **Step 4 — Verify (on-device):** auto-assign toggles + reflects state; messages opens the modal + badge updates; signout works; all four stats still update live; ☰/⇥ still collapse the rails; console clean; `prefers-reduced-motion` respected.
- [ ] **Step 5 — Commit**

```bash
git add xpizza-dispatch/index.html
git commit -m "feat(dispatch): Part B Task 13 — topbar restyle to v6 (chips/pills/avatar), handlers preserved

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## §1b — Deferred (NOT in this plan)

Real SLA-based **on-time % + promise-based lateness** requires predictor graduation + a pre-pickup drive estimate. It is a separate row/plan (Phase 1b) and must NOT be added to the tasks above. The optional "estimado (preview)" off `order_predictions` (with a declared read-only subscription, display-only) is likewise **out of scope here** — add it only in a dedicated task if/when chosen.

---

## Self-Review

**Spec coverage (Phase 1 items → task):**
- 3-column grid + collapse rails + skeleton migration → Task 7 (grid foundation) ✓
- Torre alert-registry + fallback bucket → Task 1 + Task 8 ✓
- `driver_freshness_stale` derived effects preserved → Task 7 Step 5 (no-gap) + Task 8 Step 2 ✓
- Aging (created-time baseline, band) → Task 2 + Task 9 ✓
- Delivery-risk + first-observed-ETA snapshot + no-baseline→aging-only → Tasks 3, 4, 9 ✓
- Rich order rows (payment/WhatsApp chip/ETA already in row; aging/risk added) → Task 9 (+ existing render) ✓
- Persistent roster + surfaced call + cash bar + tabs → Task 10 ✓
- Collapse rails → Task 7; Cobertura drawer + ☰ badge polish → Task 11 ✓
- Read-only Comms inbound thread (scoped WhatsApp chip) → Task 5 + Task 12 ✓
- Visual system (icons/glass/depth/pastel) → Task 6 ✓
- On-time% / promise lateness → correctly DEFERRED to §1b ✓

**Placeholder scan:** all module tasks contain full test + implementation code. Part B tasks reference `docs/superpowers/mockups/dispatch-board-v6.html` for markup/CSS — a **tracked, committed artifact** (`54b4e13`+) available to a fresh executor — with exact `index.html` anchors, not "TODO"s.

**Plan revision R1 (2026-07-28) — folded in the plan-gate REVISE (6 grounding blockers):**
1. Task 1: `sortAlerts(array)` → `sortAlertEntries(keyedObj)` preserving each alert `id` (real `alerts` is a keyed RTDB object; id needed for `dismissDispatcherAlert`). Task 7 consumes id via `data-dismiss-id`.
2. Task 4: `deliveryRisk` now returns `{ band, level, slipMs }` (imports `agingBand`) so the row edge and header count share one band — amber-alone = `level:'ok'` (heads-up, uncounted); Task 8 counts `level !== 'ok'`.
3. Task 5: `assembleThread` derives `ts` from `received_at` (chat, ms) **or** `time*1000` (non-chat, sec), `text = body ?? '(media)'` — non-chat inbound no longer silently dropped.
4. Committed the v6 mockup to a tracked path `docs/superpowers/mockups/dispatch-board-v6.html`; all Part-B references repointed.
5. Task 8: `arrivalMs` extracted to a local before `etaCache` assignment (it was inline at 3007) so `observe` has a value.
6. Task 8: `etaSnapshots.clear` anchored to the `delete etaCache[...]` branch (~2989); Task 9 `driver_cash` fully specified (helper + shape `{cash_owed,cash_order_count,closed_at}` + closed-cuadre-only aggregation + open-cash explicitly deferred, not guessed).

**Type consistency:** `agingSeconds` (Task 2) output feeds `deliveryRisk({ agingSeconds })` (Task 4); `etaSnapshots.baseline()` (Task 3) feeds `baselineArrivalMs` (Task 4/9); `classifyAlert().iconId`/`severity` (Task 1) consumed in Task 8; `assembleThread` shape (Task 5) consumed in Task 12. Consistent.

**Guardrail coverage:** zero-write (all tasks read/render only) ✓; extraction guard (Part A modules → Task 6 primitives → Task 7 grid → content tasks) ✓; coordination stop-gate before Part B ✓; no-dropped-behavior called out in Task 7 (skeleton migration + no-gap floating-strip) and Task 8 (freshness effects) verify steps ✓; `escapeHtml` on all rendered content ✓.

**Plan revision R2 (2026-07-28) — grid-foundation sequencing fix (advisor ruling (B)):**
- **Root cause:** the plan-gate verified leaf anchors/symbols/contracts but NOT that the mockup's 3-column skeleton maps onto the live DOM. At Task 6→7 build time the executor caught it: the live board is a `position:fixed` floating alert strip + a **resizable** `<aside class="sidebar">` + map — there is no left-rail "Torre list" container, and the grid arrived last (old Task 10) instead of first.
- **Fix:** inserted a new **Task 7 — grid foundation** (the one non-additive, skeleton-transforming task): establishes the `.app`/`.main` 3-column grid + Torre/map/right-rail containers + ☰/⇥ collapse + `tog()`, migrates the existing map + sidebar content, **consciously retires the drag-resize sidebar** for the collapse-rails model (point-2, user-facing — flagged for Xavier), and keeps the floating alert strip live until Task 8 (no window where alerts render nowhere).
- **Re-sequenced** old Tasks 7–11 → 8–12: Torre render (8, now targets the left-rail container + retires the floating strip), order rows (9), right rail (10), Cobertura + ☰-badge polish (11), Comms (12). Historical R1 log entries above use the old numbers; the current headers are the source of truth.
- Gate-critical logic unchanged (registry render, freshness effects, fallback bucket, escapeHtml) — only container placement moved.

**Plan revision R3 (2026-07-28) — 4 grounded Task-7 corrections (plan-gate REVISE):**
1. **No phantom map controls** — live map region is `#map-container`/`#map`/`#map-fit-btn` only; there are NO layers controls or legend. Reworded Step 2 to the real elements.
2. **Map-resize preserved (real Guardrail-6 drop)** — the retired sidebar handlers held `google.maps.event.trigger(map,'resize')` (`4084/4090/4192/4215`); Task 7 Step 3 now re-triggers the resize after the collapse transition, and Step 4 states the behavior moves rather than drops.
3. **`tog()` module-scope** — code runs in `<script type="module">`, so inline `onclick="tog()"` won't resolve; Step 3 wires ☰/⇥ via `addEventListener` (or `window.tog`).
4. **Torre seam** — Task 7 Step 1 now creates an explicit empty `#torre-list` render target; Task 8 targets `#torre-list` (no guessing).

**Plan revision R4 (2026-07-28) — one residual (plan-gate REVISE):** the drag-resize retirement (Step 4) also had to account for the pre-handler icon-init at `4077–4078` (`$('sidebar-collapse-btn')…` / `$('sidebar-show-btn')…`) — leaving those after removing the buttons throws a null-deref in the module script before board wiring finishes (whole board breaks on load). Step 4 now names them for removal, keeping line `4079` (`delivered-toggle`).

**Plan revision R5 (2026-07-28) — added Task 13 (topbar restyle):** Xavier requested full v6 topbar parity in Phase 1, conditioned on preserving every advisor-flagged behavior. Added **Task 13** as a *visual-only* restyle (KPI chips, auto-asignar pill, messages, avatar, restaurant-name display pill) that keeps every existing handler/binding (auto-assign toggle + state sync, messages modal + badge, signout, live stats, version tag, ☰/⇥) and **excludes** the design-deferred controls (on-time% → 1b, ⌘K → Phase 3). Restaurant selector is display-only (dispatch is single-restaurant; a switcher would be new scope, not a restyle).
