# Plan: KDS Redesign — Square visual language + scheduled-order identity

_Design locked via brainstorming (Claude + Xavier), 2026-07-07. Revised after Codex Round 1. Visual reference: the `kds-redesign` artifact (https://claude.ai/code/artifact/51815d6f-3f44-43cc-818b-ae92a85a4aa6)._

_Governance: this session (auditor/advisor) authored the design; the **executor** builds; advisor gates the diff (read-only + both-restaurant parity + KDS golden tests + `node --check` + a manual smoke checklist). Owner deploys._

## Goal

Rebuild the X. Pizza / La Musa kitchen display in the **Square KDS visual language** — bold sans-serif, bright white cards on a low-glare dark board, a **full-color header band that encodes order aging** — while **preserving the 3-column workflow, the extras rendering, every order-handling behavior, and all live DOM contracts**. Add a **glanceable scheduled-order identity** (gold band + slot line) that also appears on Dispatch and the Driver app.

**This is a client-only, presentational overhaul.** No *changes* to Firebase read/write paths (the apps keep their existing reads/writes — this pass adds none), no Cloud Functions, no order-lifecycle, tracking, factura, assignment, or money-path changes. The only JS edits are **render-only** (card/band markup, an all-day roll-up, `mm:ss` formatting, and pure scheduled-badge helpers).

## Ubiquitous terms

- **Aging band** — the colored header strip on each ticket; color driven by the **display-aging** rule below, not the workflow column.
- **Display-aging** — a KDS-local presentational metric = elapsed since the aging anchor (`released_at || created_at`). **Distinct from the `ready-nudge` prep-overdue alert** (which is a per-restaurant ~25-min threshold on `order_timelines.preparing_at`). The two are independent and neither replaces the other.
- **Workflow column** — the existing Nuevo / En preparación / Listo columns; still carries the prep stage.
- **Scheduled identity** — the gold band + "⏰ Entregar/Recoger \<slot\>" line on an order carrying `scheduled_for`, shown **only pre-slot** (see precedence).
- **Extras (`↳`)** — the indented sub-line under an item, now **red** (`#DC2626`); produced by the untouched `renderItems`.

## Scope — THIS PASS (all client, render-only)

1. **Square-language tickets** (both restaurants — the KDS is one host-derived folder).
   - **Header band** = display-aging color. Contents: line 1 = **customer name** (bold) + **order type** (`🛵 Delivery` / `🏪 Pickup`); line 2 = **timer (`mm:ss`)** + **order id**. (No driver/employee field — the KDS does not subscribe assignment data and this pass adds no Firebase reads.)
   - **Body** (white): the **preserved** item list — bold qty (`2×`), item name, `↳` extras sub-line in red with the existing per-instance `Pizza N:` and `todas` logic **kept verbatim**; `⚠` notes kept.
   - **Actions**: existing buttons restyled; drag/tap advance unchanged.
2. **Display-aging on the band** — see model + precedence below.
3. **All-day make-count rail** — top-bar roll-up + open count (see rail spec).
4. **Scheduled identity across 3 surfaces** — KDS (restyle the existing chip), Dispatch, Driver (see cross-surface spec).

## Display-aging model + precedence

Band color resolves by this **precedence (first match wins)** — resolving the "band = timer vs Listo/scheduled" conflict explicitly:

1. **Cancelado** → existing cancelled styling (unchanged).
2. **Listo** (in Listo column) → green `#46A24A`, white text.
3. **Scheduled pre-slot** (`scheduled_for` present **AND** `now < scheduled_for` **AND** not Listo) → gold `#E6B93E`, dark text, + slot line. **After the slot passes, it falls through to elapsed aging** so a late scheduled order is never hidden gold.
4. **Elapsed aging** on `released_at || created_at`:

| State | Threshold | Band | Text |
|---|---|---|---|
| Fresh | 0–8 min | `#E9E9E9` | dark |
| Warning | 8–15 min | `#EE9F3C` | dark |
| Late | 15+ min | `#C4392A` + pulse | white |

Thresholds live in a **new KDS-local display-aging config constant** (e.g. `AGING = {warnMin:8, lateMin:15}`) — **NOT** forked from or conflated with `ready-nudge.js` (different metric, different anchor). The late pulse uses a **separate display class `.aging-late`** that reuses only the keyframes/timing — **NOT** the `.nudge-overdue` state class, which stays owned by `ready-nudge.js` (sharing it would let the nudge controller toggle the display pulse incorrectly). The nudge controller stays independent and untouched.

## Design tokens

- **Font**: Square Sans is proprietary/not licensable → use **Hanken Grotesk** (closest free grotesque). **Vendor the `.woff2` files under `xpizza-kitchen/` with their SIL license file; declare via a relative `@font-face` (no CDN link); remove the existing Google Fonts `<link>`.** KDS only; customer surfaces keep their identity.
- **Board** `#131313` on `#0F0F0F`; **cards** `#FFFFFF`.
- **Aging palette** per table; **extras** `#DC2626`; **accent** terracotta `#E8763A` (wayfinding only, never a status).
- Timer format **`mm:ss`** counting up (replaces `4m`).

## PRESERVED VERBATIM — do not rename/remove (update controllers in the same diff if any hook moves)

**DOM contracts the live controllers depend on** — the restyle MUST keep these or fix every dependent in the same commit:
- `#card-${id}` (ready-nudge targets it), `.nudge-overdue` class (nudge overlay), `#elapsed-${id}` (the elapsed ticker), `.card` draggable + `dragStart/dragEnd/dragOver/drop` handlers (touch/mouse advance), inline `onclick` handlers `moveOrder(...)` / `showLog(...)`.

**Logic kept byte-for-byte:**
- 3 workflow columns + drag/tap advance + `moveOrder` + `KDS_TO_ORDER_STATUS` (Nuevo→new, En preparación→preparing, Listo→ready) + local `Archivado`.
- `renderItems` and its extras logic (`Pizza N:` per-instance, `todas` collapse) — **only** the CSS color/weight changes.
- `order-filter.js` + its golden test; `ready-nudge.js` controller (thresholds/anchor untouched); `kdsRestaurantFromHost` + `KDS_RESTAURANT_ID` + `applyKdsBrand()`.
- **The KDS scheduled chip already exists** in `mapFirebaseOrderToCard()`/`renderCard()` (`scheduled_for` + `released_at || created_at` anchor). **Restyle its presentation only — do not rebuild the mapping or the anchor.**
- All Firebase/tracking/factura/lifecycle. **Zero** functions/backend changes.

## All-day rail spec

- Compute from the **same post-filter `activeOrders`** passed to `render()` — **exclude `Cancelado` and local `Archivado`** (and any non-live/wrong-restaurant orders already filtered upstream). Never compute off raw `/orders`.
- **Copy the bracket-aware splitter** (the ` | `-respecting-`[...]`-depth loop) into a **new rail-only helper** — do **NOT** refactor `renderItems` itself (it stays byte-for-byte), and do **NOT** reuse `parseItems()` (its naive ` | ` split miscounts bracketed extras).
- **New golden test** for the rail parser/count covering: bracketed extras containing ` | `, per-instance `Pizza N:`, and `(todas)` cases.

## Host-agnostic invariant (both restaurants, one folder)

All restaurant identity stays derived from `KDS_RESTAURANT_ID` / `applyKdsBrand()` **only**. No hardcoded "X Pizza"/logo text, no per-host font/asset paths. Verify the redesign renders correctly for both `xpizza` and `la_musa` hosts and stays byte-identical/host-agnostic.

## Cross-surface scheduled badge (Dispatch + Driver) — read-only, pure helpers

Add a pure `formatScheduledSlot(scheduled_for)` + a badge-markup helper that returns HTML; **splice the returned HTML into existing render templates only** — no changes to event handlers, SDK calls, `assignOrderToDriver`, slide-confirm, or cash/vuelto UI. Enumerated target renderers:
- **Dispatch** (name the exact renderers; executor confirms against source): `renderUnassignedSection` (order card), `renderTaskRow` (assigned row), `renderOrderExpanded`, and `renderOrderDetailModal`. (Skip map info-windows / delivered / cancelled unless trivial.)
- **Driver**: the active task card + the incoming-order banner + the queue card + **`renderQueueDetail(o, seq)`** (so slot context survives opening the queue detail sheet). Badge reads `order.scheduled_for` only.

Guard: badge insertion sits **away from** `total`, assign buttons, and payment rows so it can't disturb event delegation or money rows.

## Non-goals / deferred to NEXT

- **Target-time SLA** (recolor by time-vs-predicted-ready — needs the Phase-1 predictor). This pass is raw-minute display-aging only.
- **Bump bar / keyboard + Recall**, **sound + flash on new order**, **station tabs**, **throughput header**.
- **Changing scheduled-order auto-assign timing** (hold-until-ready) — deferred to the ready-time work; this pass is label/visual only.

## Implementation requirements (not just risks)

- **Contrast**: every band/text pair meets legible contrast — white on `#C4392A`/`#46A24A`, dark on `#E9E9E9`/`#EE9F3C`/`#E6B93E`, red `#DC2626` extras on white. State the tested values in the diff.
- **Reduced motion**: `@media (prefers-reduced-motion: reduce)` disables the pulse/transitions and substitutes a static outline (the `nudge-overdue` animation too).

## Testing / gate

1. Executor builds on a branch off `main` (KDS + dispatch/driver badge).
2. **Automated**: `order-filter` + `ready-nudge` + the new **rail-parser** golden tests green; `node --check` on the real `.js` modules (`order-filter.js`, `ready-nudge.js`); the **inline `<script type="module">` in `index.html` is syntax-checked by extraction** (not `node --check` on the HTML, which is a fake gate).
3. **Manual smoke** (both host pins — `xpizza` + `la_musa`): login/load, cards render, elapsed ticks + `nudge-overdue` fires on an overdue card, drag AND touch advance write the correct Firebase status, scheduled card shows gold + slot pre-slot and falls to aging after, dispatch + driver show the badge, extras `↳`/`Pizza N:`/`todas` render, no external font fetch (offline check).
4. Advisor light gate: read-only diff, both-restaurant parity, money/lifecycle untouched, DOM contracts intact, contrast + reduced-motion present.
5. Owner deploys (client redeploy only — Netlify git-CD; 0 functions, no prune).

## Out of scope

Customer order form + tracker (keep identity), the assignment engine, any functions/Firebase/money code, and everything under "deferred to Next."

## Verified anchors (advisor read-only pass, 2026-07-07)

Confirmed against `origin/main` so the executor starts clean — **anchor by function/selector, not line** (line numbers drift as you edit the ~2016-line KDS file):

- **Named renderers all present:**
  - Dispatch — `renderUnassignedSection` (~:2643), `renderTaskRow` (~:2948), `renderOrderExpanded` (~:2731), `renderOrderDetailModal` (~:3216).
  - Driver — `renderActiveCard` (~:2005, active card), `renderIncomingBanners` (~:1886, incoming banner), `renderQueue` (~:2283, queue card), `renderQueueDetail` (~:2312, queue detail sheet).
- **KDS preserve-hooks all present:** `#card-${order.id}`, `#elapsed-${order.id}`, `.nudge-overdue` (CSS ~:216 + nudge controller ~:942/974-976), `.card` `draggable="true"`, inline `moveOrder()`/`showLog()` handlers.
- **Font sourcing:** Hanken Grotesk is **SIL OFL** (Google Fonts / Hanken Design Co release). Vendor the **400/600/700 `.woff2`** under `xpizza-kitchen/fonts/`, add `OFL.txt`, declare via a **relative `@font-face`**, and remove the existing Google Fonts `<link>`. Do NOT hotlink `fonts.gstatic.com`.

## Gate (advisor, when the diff returns)

`order-filter` + `ready-nudge` + the new rail-parser goldens; extracted-inline-module syntax check + `node --check` on the real `.js` modules; both-host-pin parity; read-only diff pass on the invariants — DOM contracts intact, `.aging-late` (NOT `.nudge-overdue`) for the display pulse, no new Firebase reads, money/lifecycle untouched, contrast + `prefers-reduced-motion` present.
