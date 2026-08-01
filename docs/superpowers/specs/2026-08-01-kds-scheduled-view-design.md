# Design: KDS "Programados" — view-only scheduled-orders screen

_Brainstormed Claude + Xavier, 2026-08-01. Follows the shipped KDS Phase 2a arc. Governance: design → advisor gate → executor build → advisor gate → owner deploy. Client-only; contract-clean by construction._

## Goal

Give kitchen staff a **view-only heads-up on scheduled orders before they materialize onto the Abiertos board** — reached from a single minimalist top-bar button, without disturbing the existing KDS UI. Because dough production is coordinated to sales, the screen is organized **by day** and each day leads with a **make-count roll-up** (total pizzas + by-type), so a large order days out is visible early and the line can prep dough correctly.

## Why this is low-risk (the enabling fact)

The KDS already receives scheduled orders. `subscribeToOrders` streams the **whole `/orders` tree** and applies `filterLiveOrders` (which drops `status ∈ {pending_payment, scheduled, releasing}`) **inside the SDK**, so scheduled orders are already synced to the client and simply discarded before render. This feature **re-filters data that is already present** — it adds no new network subscription (a second `onValue` on the same `orders` ref reuses the existing RTDB sync), no security-rule change, no Cloud Function, and **no writes of any kind**. The live board path (`filterLiveOrders`) is left **byte-unchanged**.

## Scope

**In:** a `Programados` screen (view-only) reached from a top-bar calendar icon; scheduled orders grouped by day; per-day make-count; the hybrid day-chip + selected-day layout; the icon-only accent cue.

**Out (explicitly):** any order actions (no Empezar/Completar/recall/edit/cancel — these orders aren't on the line yet); editing or rescheduling; a countdown to materialization (Xavier chose **slot time only**); notifications; touching the Abiertos/Completados board, the live filter, or any server code.

## UX — locked to the approved mockup

Approved visual target: the `kds-prog-hybrid` artifact. Committed to the KDS's single dark-kitchen world; Hanken, dark board / white cards, the existing gold scheduled identity, inline-SVG line icons (no emoji).

**Entry — one quiet icon.** A calendar `.ibtn` joins `menu` / `refresh` in the top-bar left group (same button chrome, nothing added to the bar). **Cue:** when scheduled orders exist, **only the calendar glyph turns accent orange** (`--accent #F26B38`); the button box is untouched. No count badge. Accent means exactly one thing on this bar: something is scheduled.

**The screen.** Tapping the icon opens a **main-window screen** (same pattern as the `Ajustes`/`openSettings` screen — hides the board, `✕` returns to it exactly as it was). Screen header: `✕` + title `Programados` + subtitle "Pedidos agendados — antes de llegar al tablero".

**Layout — hybrid (day chips + selected day in full).**
- A **day-chip row** shows **every scheduled day at once** (Hoy · Mañana · weekday+date …), so a day can never hide below a fold. Each chip carries its **pizza count**; a **heavy-dough day** gets a calm amber count (no accent). Selected chip = a **quiet grey fill + brighter label** (the KDS's own active-tab language `#323236`, NOT an accent flood).
- Below, the **selected day in full**: a header line (`Hoy · lunes 1 ago · 4 pedidos · 10 pizzas`), the **make-count roll-up** (by-type chips, amber numerals, tabular), then the day's **scheduled cards**.
- **Scheduled cards** reuse the existing gold identity: gold header band, name + type (Recoger/Entregar), the **slot time** (`6:30 PM`, clock icon), and the item list via the **unchanged `renderItems`** (red `↳` extras). **No CTA, no ring, no timer** — view-only. Sorted **soonest-slot-first** within the day.

**Empty state.** No scheduled orders → the calendar glyph stays grey (no accent); opening the screen shows a calm "Sin pedidos programados".

## Architecture — three small, testable units + the screen

**1. `order-filter.js` (pure) — `filterScheduledOrders(orders, restaurantId)`.** Mirrors `filterLiveOrders`' restaurant match exactly, but selects **`status ∈ {scheduled, releasing}` only** (deliberately **excludes `pending_payment`** — an unpaid online order must never appear as prep-worthy). `filterLiveOrders` is untouched.
```js
export const SCHEDULED_ORDER_STATUSES = new Set(['scheduled', 'releasing']);
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

**2. A pure day-grouping helper — `groupScheduledByDay(orders, nowMs, tz)`** (new pure module, e.g. `scheduled-view.js`, node-testable). Returns an ordered array of day groups:
`[{ dayKey, label, dateLabel, count, pizzas, makeCount, orders }]` where
- days are keyed by the **local calendar day of `scheduled_for` in `America/Tegucigalpa`** (the restaurant timezone — same tz the KDS already uses for `formatScheduled`), so "Hoy" is correct for the kitchen;
- `label` = `Hoy` / `Mañana` / weekday (e.g. `Sábado`), `dateLabel` = `lunes 1 ago` / `6 ago`;
- `orders` sorted ascending by `scheduled_for` (soonest first; invalid/absent `scheduled_for` sorts last with an id tie-break — mirrors the `orderForTab` robustness);
- `makeCount` = **`railCount(orders.map(o => o.items_text))`** (reuses the existing golden-tested roll-up), `pizzas` = its qty sum, `count` = order count;
- groups sorted ascending by day.

**3. KDS SDK — `subscribeScheduledOrders(callback)`** (in `xpizza-kitchen/xpizza-delivery.js`). A second `onValue(ref(db,'orders'), snap => callback(filterScheduledOrders(snap.val()||{}, KDS_RESTAURANT_ID)))` — reuses the already-open `/orders` sync (no new network read), host-derived restaurant. Read-only; symmetric with `subscribeToOrders`.

**4. `index.html` — the screen + wiring (view-only).**
- The calendar `.ibtn` in the top bar; `openScheduled()` / `closeScheduled()` mirror `openSettings()`/`closeSettings()` (hide board → show screen → `✕` restores).
- On load, subscribe via `subscribeScheduledOrders`; keep the latest scheduled set in memory. Drive the **glyph-accent** off `scheduled.length > 0` (live). Render lazily when the screen is open; re-render on new snapshots while open.
- Render = day-chip row (from `groupScheduledByDay`) + selected day (make-count + gold cards). Selected day is local UI state (default: the first/soonest day, typically Hoy). Item lists via `renderItems` verbatim.
- A per-minute tick (reuse the existing clock tick) re-evaluates day membership so an order doesn't linger under the wrong day across midnight; cheap, no writes.

## Contract / invariants (view-only, verified on the diff)

- **Zero writes** — no `setOrderStatus`, no `order_timelines`, no any RTDB write. No action handlers on scheduled cards.
- **No new network subscription** — `subscribeScheduledOrders` is a second `onValue` on the already-synced `orders` ref; **no rule change** (the KDS already reads the whole `/orders` tree), **no Cloud Function**.
- **`filterLiveOrders` byte-unchanged**; the Abiertos/Completados board is untouched.
- **`renderItems` md5-identical** (reused for the item lists).
- **Host-agnostic** — restaurant is `KDS_RESTAURANT_ID`/host-derived; both restaurants, one folder. `prefers-reduced-motion` → instant transitions.

## Edge cases

- **No scheduled orders** → grey glyph + "Sin pedidos programados".
- **`pending_payment`** (unpaid online, possibly scheduled) → excluded (never prep-worthy).
- **`releasing`** (mid-materialization) → included (about to land; still not on the board).
- **Missing/invalid `scheduled_for`** on a scheduled order → sorts last; grouped under a defensive bucket rather than crashing (shouldn't occur — held orders always carry a slot).
- **Timezone** — grouping + slot labels use `America/Tegucigalpa` (matches existing KDS formatting); a slot near midnight lands in the correct local day.
- **Many days / a busy day** — the chip row scrolls; the selected day's cards use the same responsive grid as the board.

## Testing / gate

- **Goldens (pure):** `filterScheduledOrders` (selects scheduled/releasing only, excludes pending_payment + wrong-restaurant, both host pins); `groupScheduledByDay` (day bucketing in Tegucigalpa incl. a midnight-boundary case, Hoy/Mañana labels, soonest-first sort + invalid-slot-last tie-break, per-day `railCount` make-count, group ordering). `railCount` reused (already golden).
- **Regression:** existing suites stay green (`order-filter` incl. `filterLiveOrders` unchanged, `rail-count`, `ready-nudge`, `card-model`, `kds-smoke`).
- **Inspection:** grep-confirm the scheduled view performs **zero** `setOrderStatus`/`order_timelines`/RTDB writes; `renderItems` md5-identical; `subscribeScheduledOrders` is read-only; both-host reasoning.
- `node --check` on the `.js` modules + the extracted inline module.
- **Manual smoke** (both host pins): calendar glyph greys/accents with scheduled presence; open → day chips (all days), quiet selection, per-day make-count, gold view-only cards, slot-sorted; `✕` restores the board unchanged.

## Deliverables

`order-filter.js` (+`filterScheduledOrders`, +golden), new pure `scheduled-view.js` (+golden), `xpizza-delivery.js` (+`subscribeScheduledOrders`), `index.html` (calendar button + Programados screen + wiring). All under `xpizza-kitchen/`. Zero functions, zero rules, zero writes, order forms untouched.
