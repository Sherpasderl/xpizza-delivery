# Dispatch Redesign — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Phase-1 "Torre de Control" foundation for the dispatch board — an exceptions-first alert registry, delivery-risk/aging on order rows, a first-observed-ETA snapshot, and a read-only comms-thread assembler — as pure, Node-tested modules, then wire them into `index.html` with one coordinated integration patch.

**Architecture:** Follow the established dispatch module pattern (`driver-glide.js` / `driver-eta.js`): pure, dependency-free ES modules (no `google.maps`, no DOM, no globals; `now` injected as epoch ms), each with a Node test file, imported into the `<script type="module">` block with a `?v=N` cache-bust query. **Part A** builds the modules (new files — zero `index.html` contention, buildable immediately). **Part B** is the single thin `index.html` integration patch, executed only after `index.html` ownership is coordinated with the parallel Rewards B1 session.

**Tech Stack:** Vanilla ES modules, `node --test`-style assertions via `node:assert` (mirroring `driver-eta.test.js` / `driver-glide.test.js`), Firebase RTDB (existing subscriptions), Google Maps JS (existing, unchanged).

---

## Global Constraints (non-negotiable — from the gate-approved spec)

1. **Zero writes, no money-path change.** `assignOrderToDriver`, `cancelOrderRemote`, `resolveReconciliation`, and the glide (`driver-glide.js`) stay untouched. Phase 1 only reads + renders.
2. **Shadow boundary inviolable.** Any `order_predictions` read is display-only, model/version-labeled, never written back. (Only relevant if the optional on-time preview is included — it is **not** in this plan's tasks; see §1b.)
3. **Every read-only subscription explicitly declared.** New reads (scheduled-orders; optional `order_timelines`; optional `order_predictions`) must be added as named, read-only subscriptions — no hand-waved reads. This plan adds **no new subscription** unless a task explicitly declares one (Task 8 uses only already-subscribed `orders`/`tasks`/`etaCache` data).
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
- `dispatch-delivery-risk.js` — `deliveryRisk(...)` combining aging + snapshot slippage with the no-baseline→aging-only fallback. Pure.
- `dispatch-delivery-risk.test.js`
- `dispatch-comms-thread.js` — `assembleThread(...)` read-only ordering of inbound messages + automessage events (display-only; no send — send is Phase 2). Pure.
- `dispatch-comms-thread.test.js`

**Modified file (Part B — one coordinated patch):**
- `xpizza-dispatch/index.html` — import the modules (`?v=1`), add the icon sprite + visual-system CSS (ported from the reviewed mockup), swap the imperative alert if-chain for a registry-driven Torre render, add aging/delivery-risk to order rows, rebuild the right rail (persistent roster + surfaced call + cash bar + switchable tabs), add collapsible rails + Cobertura, and a read-only Comms inbound thread.

**Visual source of truth for Part B markup/CSS:** the gate-reviewed mockup `.superpowers/brainstorm/*/content/board-v6.html` (full "v6" — true palette, glass depth, line-icon sprite, pastel action icons). Part B ports its markup/CSS; it is a real artifact, not a placeholder.

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
- `sortAlerts(alerts)` → new array sorted most-severe-first (stable).

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
import { classifyAlert, sortAlerts } from './dispatch-alerts.js';

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
// sort is most-severe-first, stable within severity
{
  const sorted = sortAlerts([
    { type: 'payment_reconcile_breaches' },   // neutral
    { type: 'no_drivers_available' },          // red
    { type: 'assignment_strand' },             // amber
  ]);
  assert.deepStrictEqual(sorted.map(a => a.type),
    ['no_drivers_available', 'assignment_strand', 'payment_reconcile_breaches']);
  ok('sortAlerts: red → amber → neutral');
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

export function sortAlerts(alerts) {
  return alerts
    .map((a, i) => ({ a, i, order: classifyAlert(a).order }))
    .sort((x, y) => x.order - y.order || x.i - y.i)   // stable within severity
    .map((x) => x.a);
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
- `deliveryRisk({ agingSeconds, agingThresholds = { amber: 300, red: 600 }, baselineArrivalMs = null, currentArrivalMs = null, slipThresholdMs = 240000 })` → `{ level, slipMs }`
  - `level`: `'ok' | 'aging' | 'slipping'`
  - **No-baseline fallback (behavioral contract):** if `baselineArrivalMs` is `null` OR `currentArrivalMs` is `null`, the slipping comparison is **suppressed** — `level` is aging-only (`'aging'` iff `agingSeconds >= agingThresholds.red`, else `'ok'`), and `slipMs` is `null`.
  - With both present: `slipMs = currentArrivalMs - baselineArrivalMs`; `level = 'slipping'` iff `slipMs >= slipThresholdMs`; else falls back to the aging rule above.

- [ ] **Step 1: Write the failing test**

```js
// xpizza-dispatch/dispatch-delivery-risk.test.js
import assert from 'node:assert';
import { deliveryRisk } from './dispatch-delivery-risk.js';

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// no baseline → aging only, never "slipping"
{
  const r = deliveryRisk({ agingSeconds: 700, baselineArrivalMs: null, currentArrivalMs: 999999 });
  assert.strictEqual(r.level, 'aging');   // red-aging, but NOT slipping
  assert.strictEqual(r.slipMs, null);
  ok('no baseline → aging only, slip suppressed');
}
{
  const r = deliveryRisk({ agingSeconds: 120, baselineArrivalMs: null, currentArrivalMs: null });
  assert.strictEqual(r.level, 'ok'); assert.strictEqual(r.slipMs, null);
  ok('no baseline + young → ok');
}
// baseline present, slipped past threshold → slipping
{
  const base = 1_000_000, cur = base + 5 * 60 * 1000;   // slipped 5 min
  const r = deliveryRisk({ agingSeconds: 60, baselineArrivalMs: base, currentArrivalMs: cur });
  assert.strictEqual(r.level, 'slipping');
  assert.strictEqual(r.slipMs, 5 * 60 * 1000);
  ok('baseline + 5min slip → slipping');
}
// baseline present, within tolerance → aging rule
{
  const base = 1_000_000, cur = base + 60 * 1000;       // only 1 min
  const r = deliveryRisk({ agingSeconds: 700, baselineArrivalMs: base, currentArrivalMs: cur });
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
 * Pure delivery-risk classifier (dispatch Phase 1). Combines static aging with a
 * "slipping vs first observed estimate" signal. NEVER a promise-based "late-by":
 * with no observed baseline, the slip comparison is suppressed and only aging is used.
 */
export function deliveryRisk({
  agingSeconds,
  agingThresholds = { amber: 300, red: 600 },
  baselineArrivalMs = null,
  currentArrivalMs = null,
  slipThresholdMs = 240000,   // 4 min slip vs first observed
}) {
  const agingLevel = agingSeconds >= agingThresholds.red ? 'aging' : 'ok';
  // No baseline (browser opened mid-delivery / no ETA observed yet) → aging only.
  if (baselineArrivalMs == null || currentArrivalMs == null) {
    return { level: agingLevel, slipMs: null };
  }
  const slipMs = currentArrivalMs - baselineArrivalMs;
  if (slipMs >= slipThresholdMs) return { level: 'slipping', slipMs };
  return { level: agingLevel, slipMs };
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
  - `inbound` items: `{ body, received_at }` → `{ kind:'in', text: body, ts: received_at }`.
  - `autoEvents` items: `{ label, at }` → `{ kind:'auto', text: label, ts: at }`.
  - Items with a non-finite `ts` are dropped (can't be ordered). No HTML here — escaping happens at render (Guardrail 6).

- [ ] **Step 1: Write the failing test**

```js
// xpizza-dispatch/dispatch-comms-thread.test.js
import assert from 'node:assert';
import { assembleThread } from './dispatch-comms-thread.js';

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

{
  const t = assembleThread({
    inbound: [{ body: '¿ya viene?', received_at: 200 }],
    autoEvents: [{ label: 'Pedido recibido', at: 100 }],
  });
  assert.deepStrictEqual(t, [
    { kind: 'auto', text: 'Pedido recibido', ts: 100 },
    { kind: 'in', text: '¿ya viene?', ts: 200 },
  ]);
  ok('merges + sorts inbound and auto by ts');
}
{
  const t = assembleThread({ inbound: [{ body: 'x', received_at: NaN }], autoEvents: [] });
  assert.deepStrictEqual(t, []);
  ok('drops items with non-finite ts');
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
    if (Number.isFinite(m.received_at)) items.push({ kind: 'in', text: m.body, ts: m.received_at });
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

# PART B — Integration into `index.html` (ONE thin patch — COORDINATED)

> **STOP — coordination gate (Guardrail 5).** Do not begin Part B until `index.html` ownership is coordinated with the parallel Rewards B1 session. Part A above is safe to complete first (new files only). Confirm current tree = `origin/main` before editing (`git fetch`; the spec branch base is byte-identical to `origin/main` per the executor brief, but re-verify at build time).

**How to verify Part B (no Node harness — `index.html` is not unit-tested):** load the dispatch board locally, and for each task check the "Expected" acceptance notes with the browser console open (zero errors) and confirm the Guardrail-6 regression list still works.

**Markup/CSS source:** port from `.superpowers/brainstorm/*/content/board-v6.html` (the gate-reviewed v6). Keep the true palette tokens from `index.html:18–35`; add depth/glass as gradient+shadow layers on top (do not change base token values).

## Task 6: Imports + icon sprite + visual-system CSS

**Files:** Modify `xpizza-dispatch/index.html`

- [ ] **Step 1: Add module imports** after `index.html:1880` (the `driver-eta.js` import), each with `?v=1`:

```js
import { classifyAlert, sortAlerts } from './dispatch-alerts.js?v=1';
import { agingBaselineMs, agingSeconds, agingBand, formatAging } from './dispatch-aging.js?v=1';
import { createEtaSnapshotStore } from './dispatch-eta-snapshot.js?v=1';
import { deliveryRisk } from './dispatch-delivery-risk.js?v=1';
import { assembleThread } from './dispatch-comms-thread.js?v=1';
const etaSnapshots = createEtaSnapshotStore();
```

- [ ] **Step 2: Add the SVG icon sprite** — copy the `<svg ...><defs>…</defs></svg>` sprite block from `board-v6.html` (symbols `i-menu, i-panel, i-search, i-chevdown, i-close, i-phone, i-message, i-send, i-more, i-maximize, i-layers, i-signaloff, i-userx, i-clock, i-phoneoff, i-card`) into the top of `<body>`. **Add one more symbol `i-alert`** (fallback-bucket icon), e.g. Feather `alert-triangle`. **Critical:** set `fill:none;stroke:currentColor;stroke-width:2` on each `<symbol>` (or the rendered `.ic` svg) — NOT on a wrapping `<g>` in `<defs>` (that does not propagate through `<use>` and renders black-filled). Add `.ic{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}` to the stylesheet.

- [ ] **Step 3: Add the visual-system CSS** — port the depth/glass/pastel classes from `board-v6.html` (card elevation gradients + shadow, glass `backdrop-filter` panels, pastel `.da.call/.msg/.more`, motion keyframes) under a `@media (prefers-reduced-motion: reduce){*{animation:none!important}}` guard. Reuse existing `:root` tokens; do not redefine them.

- [ ] **Step 4: Verify** — reload; console shows no module-load errors; a temporary `<svg class="ic"><use href="#i-signaloff"/></svg>` renders as a visible line icon (not a black blob). Remove the temporary probe.

- [ ] **Step 5: Commit**

```bash
git add xpizza-dispatch/index.html
git commit -m "feat(dispatch): wire Phase-1 modules + icon sprite + visual system

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 7: Torre de Control — registry-driven render (preserve derived effects)

**Files:** Modify `xpizza-dispatch/index.html` — `renderDispatcherAlerts` (`2227`), keep `staleDriverUids` computation (`2186–2191`) UNCHANGED.

- [ ] **Step 1:** Replace the imperative `if (a.type === …)` chain in `renderDispatcherAlerts` with a registry-driven render: `sortAlerts(alerts)` → for each, `const c = classifyAlert(a)` → render an `.ex` row (icon `#${c.iconId}`, severity class from `c.severity`, title/detail from the alert fields, `escapeHtml` on all text) into the Torre list, grouping the `!c.known` alerts under an "Otros / Revisar" bucket header. Port the `.ex` markup/CSS from `board-v6.html`.
- [ ] **Step 2 (Guardrail 6 — critical):** Preserve `driver_freshness_stale`'s derived effects. Leave lines `2186–2191` (build `staleDriverUids`) and the per-episode chime intact. In the new render, `driver_freshness_stale` now ALSO appears as a red Torre row (it previously rendered no banner) — verify `staleDriverUids`, the red GPS-dark driver rows (`gpsDark`, `3048`), the chime, and `dismissDispatcherAlert` all still fire.
- [ ] **Step 3: Verify** — inject a fake `factura_cai_low` (no registry entry) and confirm it appears in the "Otros / Revisar" bucket (not dropped); a `driver_freshness_stale` alert shows a red row AND still reddens the driver's row + fires the chime once.
- [ ] **Step 4: Commit**

```bash
git add xpizza-dispatch/index.html
git commit -m "feat(dispatch): Torre registry render + fallback bucket; preserve freshness-stale effects

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 8: Order rows — aging + delivery-risk

**Files:** Modify `xpizza-dispatch/index.html` — order-row renderers (`renderUnassignedSection`/`renderTaskRow` `3128`), ETA cache (`etaCache`, set at `3007`).

- [ ] **Step 1:** Where `etaCache[orderId]` is set (`3007`), also call `etaSnapshots.observe(orderId, arrivalMs)` so the first observed ETA is captured. On order delivery/removal, call `etaSnapshots.clear(orderId)`.
- [ ] **Step 2:** In the order-row render, compute `const secs = agingSeconds(agingBaselineMs(order), Date.now())`, `const band = agingBand(secs)`, and render `formatAging(secs)` with the band color + a card-edge band class. Add the `data-tick` live-updater (mirroring the mockup) so timers count up.
- [ ] **Step 3:** Compute `const risk = deliveryRisk({ agingSeconds: secs, baselineArrivalMs: etaSnapshots.baseline(order.order_id), currentArrivalMs: etaCache[order.order_id]?.arrivalMs ?? null })`. Render a "slipping vs primer estimado" indicator ONLY when `risk.level === 'slipping'`; otherwise show aging only. **Never** render a promise-based "late-by."
- [ ] **Step 4:** Feed the Torre delivery-risk header from the same `risk` results (count of `aging`+`slipping`). No new subscription — uses `orders`/`tasks`/`etaCache` already in memory.
- [ ] **Step 5: Verify** — an order with no observed ETA shows aging only (no "slipping"); after the session observes an ETA and a later ETA slips ≥4 min, the row flags "slipping vs primer estimado."
- [ ] **Step 6: Commit**

```bash
git add xpizza-dispatch/index.html
git commit -m "feat(dispatch): order-row aging + delivery-risk (no-baseline aging-only)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 9: Right rail — persistent roster + surfaced call + cash bar + tabs

**Files:** Modify `xpizza-dispatch/index.html` — `renderDriversSection` (`2862`) / `renderDriverNode` (`3039`), sidebar structure.

- [ ] **Step 1:** Restructure the right rail per §5.5: a compact **Cash/cuadre bar** (read `driver_cash` — declare it as a read-only subscription if not already subscribed; **no writes**) + the **always-visible driver roster** + a switchable tab region (Pedidos/Programados/Comms/Caja). Port markup/CSS from `board-v6.html`.
- [ ] **Step 2:** Surface the existing driver actions on the card face as pastel line-icon buttons: **Llamar** (`tel:${d.phone}`, mint `.da.call` `#i-phone`) — reuse the exact existing `tel:` behavior (`2892`); **Mensaje in-app** (periwinkle `.da.msg` `#i-message`) — Phase-1 stub that opens the read-only Comms thread (send is Phase 2); **`⋯`** (`.da.more` `#i-more`) — the existing menu (last location / reassign / force off-shift). Do not change the underlying actions.
- [ ] **Step 3:** Keep the GPS-dark red row (`gpsDark`) exactly as-is.
- [ ] **Step 4: Verify** — roster always visible; Llamar still dials; ⋯ still reassigns / forces off-shift; switching tabs does not hide the roster.
- [ ] **Step 5: Commit**

```bash
git add xpizza-dispatch/index.html
git commit -m "feat(dispatch): persistent driver roster + surfaced call + cash bar + tabs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 10: Collapsible rails + Cobertura drawer

**Files:** Modify `xpizza-dispatch/index.html`

- [ ] **Step 1:** Add the `☰` (left rail) and `⇥` (right rail) toggles + the CSS grid-column transition (port the `tog()` helper + `.app.left-open/.right-open` classes from `board-v6.html`). When the left rail is collapsed, show the exceptions-count dot badge on `☰`.
- [ ] **Step 2:** Add the collapsible **Cobertura de capacidades** footer drawer (default collapsed).
- [ ] **Step 3: Verify** — toggles collapse/expand each rail smoothly; map fills the freed space; the badge appears on `☰` when the left rail is closed with pending exceptions; no layout break.
- [ ] **Step 4: Commit**

```bash
git add xpizza-dispatch/index.html
git commit -m "feat(dispatch): collapsible rails + Cobertura drawer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 11: Read-only Comms inbound thread

**Files:** Modify `xpizza-dispatch/index.html` — Comms tab, using the existing `incoming_messages` subscription (`2391`).

- [ ] **Step 1:** In the Comms tab, for a selected customer, build `assembleThread({ inbound: <their incoming_messages>, autoEvents: [{label:'Recibido', at: order.order_received_notified_at}] })` and render the ordered items **read-only** (glass thread from `board-v6.html`), every text through `escapeHtml`. Show the limited "Recibido: enviado / no-entregado" chip from `order_received_notified_at` / `order_received_send_unresolved_at` only.
- [ ] **Step 2 (Guardrail):** NO composer/send in Phase 1 — the "Responder" affordance stays the existing `wa.me` deep-link until Phase 2 replaces it with the audited dispatcher-send function.
- [ ] **Step 3: Verify** — inbound messages + the "Recibido" event render in time order, read-only; the existing inbound handled/unhandled marking still works.
- [ ] **Step 4: Commit**

```bash
git add xpizza-dispatch/index.html
git commit -m "feat(dispatch): read-only Comms inbound thread (assembleThread)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## §1b — Deferred (NOT in this plan)

Real SLA-based **on-time % + promise-based lateness** requires predictor graduation + a pre-pickup drive estimate. It is a separate row/plan (Phase 1b) and must NOT be added to the tasks above. The optional "estimado (preview)" off `order_predictions` (with a declared read-only subscription, display-only) is likewise **out of scope here** — add it only in a dedicated task if/when chosen.

---

## Self-Review

**Spec coverage (Phase 1 items → task):**
- Torre alert-registry + fallback bucket → Task 1 + Task 7 ✓
- `driver_freshness_stale` derived effects preserved → Task 7 Step 2 ✓
- Aging (created-time baseline, band) → Task 2 + Task 8 ✓
- Delivery-risk + first-observed-ETA snapshot + no-baseline→aging-only → Tasks 3, 4, 8 ✓
- Rich order rows (payment/WhatsApp chip/ETA already in row; aging/risk added) → Task 8 (+ existing render) ✓
- Persistent roster + surfaced call + cash bar + tabs → Task 9 ✓
- Collapsible rails + Cobertura → Task 10 ✓
- Read-only Comms inbound thread (scoped WhatsApp chip) → Task 5 + Task 11 ✓
- Visual system (icons/glass/depth/pastel) → Task 6 ✓
- On-time% / promise lateness → correctly DEFERRED to §1b ✓

**Placeholder scan:** all module tasks contain full test + implementation code. Part B tasks reference the `board-v6.html` mockup for markup/CSS (a real, committed-adjacent artifact) with exact `index.html` anchors — not "TODO"s.

**Type consistency:** `agingSeconds` (Task 2) output feeds `deliveryRisk({ agingSeconds })` (Task 4); `etaSnapshots.baseline()` (Task 3) feeds `baselineArrivalMs` (Task 4/8); `classifyAlert().iconId`/`severity` (Task 1) consumed in Task 7; `assembleThread` shape (Task 5) consumed in Task 11. Consistent.

**Guardrail coverage:** zero-write (all tasks read/render only) ✓; extraction guard (Part A modules before Part B patch) ✓; coordination stop-gate before Part B ✓; no-dropped-behavior regression list in Tasks 7/9/11 verify steps ✓; `escapeHtml` on all rendered content ✓.
