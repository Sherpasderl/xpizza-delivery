# KDS Programados (Scheduled-Orders View) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a view-only "Programados" screen to the KDS that shows scheduled orders grouped by day, each day leading with a per-day make-count, reached from a minimalist top-bar calendar icon.

**Architecture:** Pure, node-tested filter + day-grouping modules feed a read-only SDK subscription (a second `onValue` on the already-synced `/orders` ref — no new network read); `index.html` renders a hybrid day-chip + selected-day screen using the existing gold scheduled identity and the unchanged `renderItems`. Zero writes; the live board path is byte-unchanged.

**Tech Stack:** Vanilla ESM browser modules (no framework), Firebase RTDB (read-only here), `node --check` + hand-rolled `assert`-based golden tests run with `node <file>.test.mjs`, `Intl.DateTimeFormat` for timezone-correct day grouping.

**Spec:** `docs/superpowers/specs/2026-08-01-kds-scheduled-view-design.md` (approved; aesthetic locked to the `kds-prog-hybrid` artifact).

## Global Constraints

- **View-only — ZERO writes.** No `setOrderStatus`, no `order_timelines`, no any RTDB write anywhere in this feature. Scheduled cards have **no action handlers**.
- **No new network subscription / rule / function.** `subscribeScheduledOrders` is a second `onValue` on the same `orders` ref (reuses the existing sync). No security-rule change, no Cloud Function, order forms untouched.
- **`filterLiveOrders` stays byte-unchanged**; the Abiertos/Completados board is untouched.
- **`renderItems` stays md5-identical** — reuse it verbatim for item lists; never edit it.
- **Host-agnostic** — restaurant is `KDS_RESTAURANT_ID` / host-derived; both `x_pizza` and `la_musa`, one folder.
- **Excludes unpaid** — only `status ∈ {scheduled, releasing}`; never `pending_payment`.
- **Slot time only** on cards (no materialization countdown).
- **Timezone** = `America/Tegucigalpa` for day grouping + labels (matches existing KDS formatting). `prefers-reduced-motion` → instant transitions.
- All files under `xpizza-kitchen/`. Commit after every task.

---

### Task 1: `filterScheduledOrders` (pure filter + golden)

**Files:**
- Modify: `xpizza-kitchen/order-filter.js` (add after `filterLiveOrders`)
- Test: `xpizza-kitchen/order-filter.test.mjs` (add cases)

**Interfaces:**
- Consumes: nothing (mirrors `filterLiveOrders`' restaurant logic).
- Produces: `SCHEDULED_ORDER_STATUSES: Set<string>`, `filterScheduledOrders(orders: object, restaurantId?: string): object` — returns the subset whose `status ∈ {scheduled, releasing}` AND matches the restaurant pin (la_musa: strict `=== 'la_musa'`; else everything not-la_musa).

- [ ] **Step 1: Write the failing test** — append to `order-filter.test.mjs` (before the final `console.log`), and add `filterScheduledOrders, SCHEDULED_ORDER_STATUSES` to the existing import from the module source:

```js
// ── filterScheduledOrders: held/scheduled orders only, per restaurant (Programados view) ──
{
  const orders = {
    a: { status: 'scheduled',       restaurant_id: 'x_pizza' },
    b: { status: 'releasing',       restaurant_id: 'x_pizza' },
    c: { status: 'new',             restaurant_id: 'x_pizza' },   // live → excluded
    d: { status: 'pending_payment', restaurant_id: 'x_pizza' },   // unpaid → excluded
    e: { status: 'scheduled',       restaurant_id: 'la_musa' },   // wrong restaurant for x_pizza
  };
  assert.deepEqual(Object.keys(filterScheduledOrders(orders, 'x_pizza')).sort(), ['a', 'b']);
  ok('filterScheduledOrders: x_pizza → scheduled+releasing only, excludes live/unpaid/la_musa');

  assert.deepEqual(Object.keys(filterScheduledOrders(orders, 'la_musa')), ['e']);
  ok('filterScheduledOrders: la_musa → strict own-restaurant scheduled only');

  // unpaid is NEVER prep-worthy even for the right restaurant
  assert.deepEqual(filterScheduledOrders({ x: { status: 'pending_payment', restaurant_id: 'x_pizza' } }, 'x_pizza'), {});
  ok('filterScheduledOrders: pending_payment excluded (unpaid never shown)');

  assert.deepEqual(filterScheduledOrders({}, 'x_pizza'), {});
  assert.deepEqual(filterScheduledOrders(null, 'x_pizza'), {});
  ok('filterScheduledOrders: empty/null → {} (safe)');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd xpizza-kitchen && node order-filter.test.mjs`
Expected: FAIL — `filterScheduledOrders is not a function` (import undefined).

- [ ] **Step 3: Write minimal implementation** — append to `order-filter.js`:

```js
// Held/scheduled orders (NOT operationally live, but paid+confirmed) for the Programados view.
// Deliberately EXCLUDES pending_payment (an unpaid online order must never appear as prep-worthy).
export const SCHEDULED_ORDER_STATUSES = new Set(['scheduled', 'releasing']);

// Filter a /orders snapshot to the scheduled/held orders for one restaurant. Mirrors filterLiveOrders'
// restaurant match exactly (la_musa strict; x_pizza = everything not-la_musa). Read-only, pure.
export function filterScheduledOrders(orders, restaurantId = 'x_pizza') {
  const pin = restaurantId === 'la_musa' ? 'la_musa' : 'x_pizza';
  const out = {};
  for (const id of Object.keys(orders || {})) {
    const o = orders[id];
    if (!o || !SCHEDULED_ORDER_STATUSES.has(o.status)) continue;
    if (pin === 'la_musa' ? o.restaurant_id !== 'la_musa' : o.restaurant_id === 'la_musa') continue;
    out[id] = o;
  }
  return out;
}
```

Also update the test's import line to include the new names, e.g.:
`const { ORDER_STATUS, filterLiveOrders, kdsRestaurantFromHost, filterScheduledOrders, SCHEDULED_ORDER_STATUSES } = await import('data:text/javascript,' + encodeURIComponent(src));`
(match whatever the file already imports; add the two new names.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd xpizza-kitchen && node order-filter.test.mjs && node --check order-filter.js`
Expected: PASS (all cases, including the pre-existing `filterLiveOrders` ones).

- [ ] **Step 5: Commit**

```bash
git add xpizza-kitchen/order-filter.js xpizza-kitchen/order-filter.test.mjs
git commit -m "feat(kds-sched): filterScheduledOrders — held orders per restaurant (excl. pending_payment)"
```

---

### Task 2: `groupScheduledByDay` (pure day-grouping + make-count + golden)

**Files:**
- Create: `xpizza-kitchen/scheduled-view.js`
- Test: `xpizza-kitchen/scheduled-view.test.mjs`

**Interfaces:**
- Consumes: `railCount` from `./rail-count.js` (existing; rolls `items_text[]` → `[{name, qty}]`).
- Produces: `groupScheduledByDay(orders: object, nowMs: number, tz?: string): Array<{ dayKey: string, label: string, dateLabel: string, count: number, pizzas: number, makeCount: Array<{name,qty}>, orders: Array<object> }>` — day groups ordered chronologically (invalid-slot bucket last); each `orders` sorted soonest-`scheduled_for`-first with an id tie-break.

- [ ] **Step 1: Write the failing test** — create `scheduled-view.test.mjs`:

```js
// Golden for scheduled-view.js. Loads the REAL module source as an ESM data: URL (with rail-count.js
// resolvable via a relative import baked into a small shim) so we test shipped code. Run: node scheduled-view.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// import the module directly from disk (relative import of ./rail-count.js resolves on the filesystem)
const mod = await import(pathToFileURL(new URL('./scheduled-view.js', import.meta.url).pathname).href);
const { groupScheduledByDay } = mod;

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// Tegucigalpa is UTC-6. Build timestamps as UTC = local + 6h.
const L = (y, m, d, hh, mm) => Date.UTC(y, m, d, hh + 6, mm);   // local Tegucigalpa → epoch ms
const now = L(2026, 7, 1, 6, 0);   // Aug 1 2026, 6:00 AM local

{
  const orders = {
    o1: { scheduled_for: L(2026, 7, 1, 19, 0), items_text: '2x Pepperoni', restaurant_id: 'x_pizza' },   // Hoy 7pm
    o2: { scheduled_for: L(2026, 7, 1, 18, 30), items_text: '1x Margherita | 1x Hongos', restaurant_id: 'x_pizza' }, // Hoy 6:30pm
    o3: { scheduled_for: L(2026, 7, 2, 12, 30), items_text: '1x Hawaiana', restaurant_id: 'x_pizza' },   // Mañana
  };
  const g = groupScheduledByDay(orders, now);
  assert.equal(g.length, 2, 'two day groups');
  assert.equal(g[0].label, 'Hoy'); assert.equal(g[1].label, 'Mañana');
  // Hoy sorted soonest-first → o2 (6:30) before o1 (7:00)
  assert.deepEqual(g[0].orders.map(o => o.id), ['o2', 'o1']);
  assert.equal(g[0].count, 2); assert.equal(g[0].pizzas, 4);   // 1+1 (o2) + 2 (o1)
  assert.deepEqual(g[0].makeCount, [
    { name: 'Pepperoni', qty: 2 }, { name: 'Hongos', qty: 1 }, { name: 'Margherita', qty: 1 },
  ]);
  ok('groups by day, Hoy/Mañana labels, soonest-first, per-day make-count via railCount');
}
{
  // midnight boundary: 11:30 PM local = Hoy; 12:30 AM local next day = Mañana
  const orders = {
    late:  { scheduled_for: L(2026, 7, 1, 23, 30), items_text: '1x Diávola', restaurant_id: 'x_pizza' },
    early: { scheduled_for: L(2026, 7, 2, 0, 30),  items_text: '1x Margherita', restaurant_id: 'x_pizza' },
  };
  const g = groupScheduledByDay(orders, now);
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].orders.map(o => o.id), ['late']);   // Hoy
  assert.deepEqual(g[1].orders.map(o => o.id), ['early']);  // Mañana
  ok('midnight boundary buckets into the correct local day (Tegucigalpa)');
}
{
  // invalid/missing scheduled_for → sorts last, own bucket, stable id tie-break
  const orders = {
    b: { scheduled_for: NaN, items_text: '1x Margherita', restaurant_id: 'x_pizza' },
    a: { scheduled_for: undefined, items_text: '1x Pepperoni', restaurant_id: 'x_pizza' },
    ok1: { scheduled_for: L(2026, 7, 3, 13, 0), items_text: '1x Hawaiana', restaurant_id: 'x_pizza' },
  };
  const g = groupScheduledByDay(orders, now);
  assert.equal(g[g.length - 1].label, 'Sin fecha');
  assert.deepEqual(g[g.length - 1].orders.map(o => o.id), ['a', 'b']);   // tie-break by id
  ok('invalid scheduled_for → "Sin fecha" bucket last, id tie-break');
}
assert.deepEqual(groupScheduledByDay({}, now), []);
assert.deepEqual(groupScheduledByDay(null, now), []);
ok('empty/null → []');

console.log(`scheduled-view: OK (${n} cases)`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd xpizza-kitchen && node scheduled-view.test.mjs`
Expected: FAIL — cannot find module `./scheduled-view.js`.

- [ ] **Step 3: Write minimal implementation** — create `scheduled-view.js`:

```js
// Pure, dependency-light (imports railCount). Groups scheduled orders by their LOCAL calendar day in the
// restaurant timezone (Tegucigalpa), each with a make-count roll-up for dough planning. No firebase/DOM.
import { railCount } from './rail-count.js';

const TZ = 'America/Tegucigalpa';
const INVALID = '9999-99-99';   // sorts last under string compare

function dayKey(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
function weekdayLabel(ms, tz) {
  const w = new Intl.DateTimeFormat('es-HN', { timeZone: tz, weekday: 'long' }).format(new Date(ms));
  return w.charAt(0).toUpperCase() + w.slice(1);
}
function dateLabel(ms, tz) {
  return new Intl.DateTimeFormat('es-HN', { timeZone: tz, day: 'numeric', month: 'short' }).format(new Date(ms)).replace(/\./g, '');
}
const finiteMs = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

export function groupScheduledByDay(orders, nowMs, tz = TZ) {
  const todayKey = dayKey(nowMs, tz);
  const tomorrowKey = dayKey(nowMs + 86400000, tz);
  const buckets = new Map();
  for (const id of Object.keys(orders || {})) {
    const o = { id, ...orders[id] };
    const t = finiteMs(o.scheduled_for);
    const key = t == null ? INVALID : dayKey(t, tz);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(o);
  }
  const out = [];
  for (const key of [...buckets.keys()].sort()) {
    const dayOrders = buckets.get(key).sort((a, b) => {
      const ta = finiteMs(a.scheduled_for) ?? Infinity;
      const tb = finiteMs(b.scheduled_for) ?? Infinity;
      return ta - tb || String(a.id).localeCompare(String(b.id));
    });
    const makeCount = railCount(dayOrders.map(o => o.items_text));
    const pizzas = makeCount.reduce((s, m) => s + m.qty, 0);
    const anchor = finiteMs(dayOrders[0] && dayOrders[0].scheduled_for);
    const valid = key !== INVALID && anchor != null;
    out.push({
      dayKey: key,
      label: !valid ? 'Sin fecha' : key === todayKey ? 'Hoy' : key === tomorrowKey ? 'Mañana' : weekdayLabel(anchor, tz),
      dateLabel: valid ? dateLabel(anchor, tz) : '',
      count: dayOrders.length,
      pizzas,
      makeCount,
      orders: dayOrders,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd xpizza-kitchen && node scheduled-view.test.mjs && node --check scheduled-view.js`
Expected: PASS (5 cases).

- [ ] **Step 5: Commit**

```bash
git add xpizza-kitchen/scheduled-view.js xpizza-kitchen/scheduled-view.test.mjs
git commit -m "feat(kds-sched): groupScheduledByDay — Tegucigalpa day buckets + per-day make-count"
```

---

### Task 3: `subscribeScheduledOrders` SDK wrapper (read-only)

**Files:**
- Modify: `xpizza-kitchen/xpizza-delivery.js` (the import-then-export of `order-filter.js`, and a new subscription near `subscribeToOrders`)

**Interfaces:**
- Consumes: `filterScheduledOrders` (Task 1); existing `db`, `ref`, `onValue`, `KDS_RESTAURANT_ID`.
- Produces: `subscribeScheduledOrders(callback: (orders: object) => void): () => void` — calls back with the filtered scheduled orders on every `/orders` change; returns the unsubscribe. Also re-exports `filterScheduledOrders`.

- [ ] **Step 1: Add the re-export** — find where `xpizza-delivery.js` imports from `./order-filter.js` and re-exports (`filterLiveOrders`, `kdsRestaurantFromHost`, …). Add `filterScheduledOrders` to both the import and the `export { … }` list.

- [ ] **Step 2: Add the subscription** — directly after the existing `subscribeToOrders`:

```js
// Programados view (read-only): the scheduled/held orders for this KDS. A SECOND onValue on the SAME
// `orders` ref → reuses the sync subscribeToOrders already opened (no new network read). Never writes.
export function subscribeScheduledOrders(callback) {
  const ordersRef = ref(db, 'orders');
  return onValue(ordersRef, (snap) => callback(filterScheduledOrders(snap.val() || {}, KDS_RESTAURANT_ID)));
}
```

- [ ] **Step 3: Verify syntax**

Run: `cd xpizza-kitchen && node --check xpizza-delivery.js`
Expected: PASS (syntax only; firebase imports aren't resolved by `--check`).

- [ ] **Step 4: Grep-confirm read-only** — the new function contains no `set(`/`update(`/`push(`/`remove(`:

Run: `awk '/function subscribeScheduledOrders/{f=1} f&&/(\.set\(|\.update\(|\.push\(|\.remove\()/{print "WRITE!"} f&&/^}/{f=0}' xpizza-delivery.js`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add xpizza-kitchen/xpizza-delivery.js
git commit -m "feat(kds-sched): subscribeScheduledOrders — read-only second onValue (reuses sync)"
```

---

### Task 4: Top-bar calendar button + Programados screen shell (open/close)

**Files:**
- Modify: `xpizza-kitchen/index.html` (CSS block, top-bar markup, a new screen container, open/close handlers)

**Interfaces:**
- Consumes: existing `openSettings()`/`closeSettings()` pattern (mirror it), the `.ibtn`/`.topbar`/`.screen-top` styles, the `#i-cal`/`#i-clock`/`#i-chevd` icon `<defs>` (add `#i-cal` if absent).
- Produces: `openScheduled()`, `closeScheduled()` (globals, like `openSettings`); a `#scheduled-screen` container; a `#btn-scheduled` calendar `.ibtn` with an `#i-cal` glyph.

- [ ] **Step 1: Add the `#i-cal` icon def** (if not already present) inside the SVG `<defs>` used by the board:

```html
<g id="i-cal"><rect x="3" y="4.5" width="18" height="16" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></g>
```

- [ ] **Step 2: Add the calendar button to the top bar** — next to `#btn-settings`/refresh in the left `.ibtn` group (do NOT touch the tabs/pager):

```html
<button class="ibtn" id="btn-scheduled" onclick="openScheduled()" title="Programados"><svg viewBox="0 0 24 24"><use href="#i-cal"/></svg></button>
```

- [ ] **Step 3: Add the screen container + CSS** — mirror the Ajustes screen. Add a hidden `#scheduled-screen` with the header, a `#sched-daysel` chip row, and a `#sched-day` selected-day area. CSS (append to the KDS `<style>`; the gold `.card`/`.mc` tokens already exist — add only what's new):

```css
  #scheduled-screen{ display:none; }
  body.scheduled-open #scheduled-screen{ display:block; }
  body.scheduled-open #board, body.scheduled-open .allday-bar{ display:none; }   /* match how openSettings hides the board */
  .ibtn.sched-on svg{ color:var(--accent); }   /* cue: only the glyph goes accent when scheduled orders exist */
  .sched-body{ padding:16px 20px 24px; }
  .daysel{ display:flex; gap:9px; flex-wrap:wrap; padding-bottom:16px; margin-bottom:17px; border-bottom:1px solid var(--stroke); overflow-x:auto; }
  .daychip{ display:inline-flex; align-items:center; gap:11px; padding:8px 13px; background:var(--panel); border:1px solid var(--stroke); border-radius:11px; cursor:pointer; white-space:nowrap; }
  .daychip .d{ font-size:14px; font-weight:800; color:var(--muted); line-height:1.15; }
  .daychip .d small{ display:block; font-size:11px; font-weight:600; color:var(--muted); opacity:.75; text-transform:capitalize; margin-top:1px; }
  .daychip .pz{ display:inline-grid; place-items:center; font-size:12px; font-weight:800; min-width:24px; height:24px; padding:0 8px; background:#26262A; color:var(--muted); border-radius:20px; font-variant-numeric:tabular-nums; }
  .daychip.on{ background:#2C2C30; border-color:#3C3C40; }
  .daychip.on .d{ color:var(--on-dark); }
  .daychip.heavy .pz{ background:rgba(224,167,60,.15); color:#E0A73C; }
  .sched-empty{ padding:40px 8px; text-align:center; color:var(--muted); font-size:14px; }
```
(Use the KDS's existing token names — `--muted`, `--on-dark`, `--panel`, `--stroke`, `--accent` — not the mockup's placeholder names. Verify the real token names in the file and match them.)

Screen markup:
```html
<div id="scheduled-screen">
  <div class="screen-top">
    <button class="x" id="btn-scheduled-close" onclick="closeScheduled()" aria-label="Cerrar" title="Cerrar">✕</button>
    <div class="ttl">Programados<small>Pedidos agendados — antes de llegar al tablero</small></div>
  </div>
  <div class="sched-body">
    <div class="daysel" id="sched-daysel"></div>
    <div id="sched-day"></div>
  </div>
</div>
```

- [ ] **Step 4: Add open/close handlers** — mirror `openSettings`/`closeSettings`:

```js
function openScheduled(){ document.body.classList.add('scheduled-open'); renderScheduled(); }
function closeScheduled(){ document.body.classList.remove('scheduled-open'); }
window.openScheduled = openScheduled;
window.closeScheduled = closeScheduled;
// renderScheduled is defined in Task 5; add a temporary no-op stub here so open/close works standalone:
function renderScheduled(){}
```

- [ ] **Step 5: Verify + commit** — extract the inline module and syntax-check it (same method the repo already uses), and eyeball open/close:

Run:
```bash
cd xpizza-kitchen
python3 -c "import re;s=open('index.html').read();m=re.search(r'<script type=\"module\">(.*?)</script>',s,re.S);open('/tmp/kds.mjs','w').write(m.group(1))"
node --check /tmp/kds.mjs && echo OK
```
Expected: OK. Then:
```bash
git add xpizza-kitchen/index.html
git commit -m "feat(kds-sched): Programados screen shell + calendar top-bar button (open/close)"
```

---

### Task 5: Subscribe + glyph cue + render (chips + selected day + make-count + gold cards)

**Files:**
- Modify: `xpizza-kitchen/index.html` (import the SDK fn + `groupScheduledByDay`; subscription; `renderScheduled`; selection state)

**Interfaces:**
- Consumes: `XPD.subscribeScheduledOrders` (Task 3), `groupScheduledByDay` (Task 2), existing `renderItems`, `formatScheduled` (slot time), `escapeHtml`.
- Produces: live `scheduledOrders` state; `renderScheduled()`; `selectSchedDay(dayKey)`.

- [ ] **Step 1: Import `groupScheduledByDay`** near the other module imports at the top of the inline module:

```js
import { groupScheduledByDay } from './scheduled-view.js?v=1';
```

- [ ] **Step 2: Subscribe + drive the glyph cue** — near where `subscribeToOrders` is wired:

```js
let scheduledOrders = {};
let schedSelectedडे = null;   // selected dayKey (null → default to first/soonest)
XPD.subscribeScheduledOrders((orders) => {
  scheduledOrders = orders || {};
  const has = Object.keys(scheduledOrders).length > 0;
  document.getElementById('btn-scheduled')?.classList.toggle('sched-on', has);
  if (document.body.classList.contains('scheduled-open')) renderScheduled();   // live refresh while open
});
```
(Rename `schedSelectedडे` to a valid identifier, e.g. `schedSelectedDay`.)

- [ ] **Step 3: Implement `renderScheduled`** — replace the Task-4 stub:

```js
function schedSlot(o){ return o.scheduled_for ? formatScheduled(o.scheduled_for).replace(/^.*,\s*/, '') : ''; }  // time portion; adjust to formatScheduled's shape

function renderScheduled(){
  const groups = groupScheduledByDay(scheduledOrders, Date.now());
  const daysel = document.getElementById('sched-daysel');
  const dayEl = document.getElementById('sched-day');
  if (!groups.length){ daysel.innerHTML=''; dayEl.innerHTML = '<div class="sched-empty">Sin pedidos programados</div>'; return; }

  // pick the selected day (default: first group), resilient to a day that has emptied out
  let sel = groups.find(g => g.dayKey === schedSelectedDay) || groups[0];
  schedSelectedDay = sel.dayKey;

  daysel.innerHTML = groups.map(g => `
    <button class="daychip${g.dayKey===sel.dayKey?' on':''}${g.pizzas>=10?' heavy':''}" onclick="selectSchedDay('${g.dayKey}')">
      <span class="d">${escapeHtml(g.label)}<small>${escapeHtml(g.dateLabel)}</small></span>
      <span class="pz">${g.pizzas}</span>
    </button>`).join('');

  const mc = sel.makeCount.map(m => `<span class="allday-item"><span class="n">${m.qty}</span><span class="nm">${escapeHtml(m.name)}</span></span>`).join('');
  const cards = sel.orders.map(o => `
    <div class="card sched-card">
      <div class="card-band" style="background:var(--band-sched)">
        <div class="card-band-r1"><span class="card-customer">${escapeHtml(o.customer_name || 'Sin nombre')}</span><span class="card-type-badge">${o.order_type==='pickup'?'Recoger':'Entregar'}</span></div>
        <div class="card-band-r2"><span class="ch-slot">${escapeHtml(schedSlot(o))}</span></div>
      </div>
      <div class="card-body"><div class="card-items">${renderItems(o.items_text)}</div></div>
    </div>`).join('');

  dayEl.innerHTML = `
    <div class="seld-head"><span class="seld-title">${escapeHtml(sel.label)}</span><span class="seld-date">${escapeHtml(sel.dateLabel)}</span>
      <span class="seld-meta"><b>${sel.count}</b> ${sel.count===1?'pedido':'pedidos'} · <b>${sel.pizzas}</b> ${sel.pizzas===1?'pizza':'pizzas'}</span></div>
    <div class="mc allday-rail">${mc}</div>
    <div class="cards ticket-grid-sched">${cards}</div>`;
}
function selectSchedDay(k){ schedSelectedDay = k; renderScheduled(); }
window.selectSchedDay = selectSchedDay;
```
(Match the real KDS class names for the gold band + item list + make-count chips — reuse `card-band`/`band-sched`/`card-items`/`allday-item` exactly as they exist in the file; adjust the snippet's classnames to the file's reality. Add the small `.seld-*`, `.ch-slot`, `.sched-card`, `.cards` grid CSS from the mockup, using existing tokens.)

- [ ] **Step 4: Verify** — inline-module syntax + `renderItems` untouched + zero writes in the scheduled path:

Run:
```bash
cd xpizza-kitchen
git show <BASE>:xpizza-kitchen/index.html | awk '/^function renderItems/{p=1} p{print} /^}/{if(p)exit}' | md5 -q
awk '/^function renderItems/{p=1} p{print} /^}/{if(p)exit}' index.html | md5 -q      # must match
grep -nE "renderScheduled|selectSchedDay|openScheduled|schedSlot" index.html | grep -iE "setOrderStatus|order_timelines" || echo "no writes in scheduled path ✓"
python3 -c "import re;s=open('index.html').read();m=re.search(r'<script type=\"module\">(.*?)</script>',s,re.S);open('/tmp/kds.mjs','w').write(m.group(1))" && node --check /tmp/kds.mjs && echo OK
```
Expected: the two md5s match; "no writes"; OK. (`<BASE>` = the branch's base commit.)

- [ ] **Step 5: Commit**

```bash
git add xpizza-kitchen/index.html
git commit -m "feat(kds-sched): render Programados — day chips + selected day + make-count + gold cards"
```

---

### Task 6: Polish, empty state, day-tick, and full contract verification

**Files:**
- Modify: `xpizza-kitchen/index.html` (per-minute re-eval, reduced-motion, empty state already in Task 5)
- Test: run all suites

**Interfaces:** consumes the existing clock/tick loop.

- [ ] **Step 1: Re-eval day membership on the existing minute tick** — in the KDS's existing per-second/per-minute tick, if `document.body.classList.contains('scheduled-open')`, call `renderScheduled()` at most once per minute (so an order crosses midnight into the right day without a manual refresh). No writes.

- [ ] **Step 2: Reduced-motion + horizontal scroll** — confirm `.daysel{ overflow-x:auto }` (many days) and that any chip/screen transition is wrapped by the existing `@media (prefers-reduced-motion: reduce)` block (reuse it; add the scheduled transitions there if you added any).

- [ ] **Step 3: Run the FULL suite** —

Run: `cd xpizza-kitchen && for t in order-filter rail-count ready-nudge card-model kds-smoke scheduled-view; do node $t.test.mjs 2>&1 | tail -1; done`
Expected: all green (order-filter now includes the filterScheduledOrders cases; scheduled-view 5).

- [ ] **Step 4: Full contract grep + host reasoning** —

Run:
```bash
cd xpizza-kitchen
echo "renderItems md5 (must match base):"; awk '/^function renderItems/{p=1} p{print} /^}/{if(p)exit}' index.html | md5 -q
echo "one setOrderStatus call site (board only):"; grep -cE "XPD.setOrderStatus\(" index.html
echo "zero order_timelines WRITES:"; grep -nE "order_timelines" index.html | grep -vE "//|never|NEVER|canonical|sourced|read" || echo "(comments/reads only)"
echo "scheduled subscription is read-only:"; grep -n "subscribeScheduledOrders" index.html
```
Expected: md5 matches base; `setOrderStatus` count unchanged from base (the board's one call site — the scheduled feature adds none); no `order_timelines` writes; the scheduled subscription is a read.
Confirm host-agnostic: nothing in the scheduled code hardcodes a restaurant (it flows through `KDS_RESTAURANT_ID` via the SDK).

- [ ] **Step 5: Commit**

```bash
git add xpizza-kitchen/index.html
git commit -m "polish(kds-sched): minute-tick day re-eval, empty state, reduced-motion; full contract verified"
```

---

## Self-Review

**Spec coverage:** entry button + icon-only accent cue (T4/T5) · main-window screen + ✕ (T4) · hybrid day chips, all days visible, quiet selection, heavy-day amber (T5) · selected day full + per-day make-count (T5) · gold view-only cards, slot-sorted (T5) · scheduled/releasing-only, excl. pending_payment (T1) · Tegucigalpa day grouping + Hoy/Mañana/midnight (T2) · read-only second onValue (T3) · empty state + tick + reduced-motion (T6) · goldens for filter + grouping (T1/T2) · full contract verification (T6). All spec sections map to a task.

**Placeholder scan:** two intentional "match the file's real token/class names" notes in T4/T5 — the executor must reconcile the mockup's placeholder names (`--stroke`, `--sel`, `.card-band`) against the KDS file's actual tokens/classes; this is a real instruction (reuse existing names), not a TODO. All code steps carry real code.

**Type consistency:** `filterScheduledOrders(orders, restaurantId)` and `groupScheduledByDay(orders, nowMs, tz?)` signatures + return shapes are used consistently across T1→T2→T3→T5. `railCount` reused as-is. `schedSelectedDay`/`renderScheduled`/`selectSchedDay` names consistent T4→T6 (fix the one deliberately-corrupted identifier flagged in T5 Step 2).

## Execution notes for the advisor/executor

- Task boundaries: T1–T3 are independently golden-testable pure/SDK units; T4–T6 are the inline UI (verified by node --check + md5 + grep-contract + the manual smoke below), since `index.html` has no unit harness beyond `kds-smoke`.
- **Manual smoke (both host pins):** calendar glyph greys with no scheduled orders / goes accent when present; open → all scheduled days show as chips, quiet selection, per-day make-count, gold view-only cards slot-sorted; a heavy day shows the amber count; ✕ restores the board unchanged; offline/DST sanity on the slot labels.
