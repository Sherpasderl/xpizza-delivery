# Driver P2 (stacked-order detail) + P3 (cash) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]`.

**Goal:** Build the stacked-order view-only detail sheet (P2) and the cash feature — vuelto sheet + clock-out cuadre + `/driver_cash` record/rules + day-summary efectivo (P3) — into the shipped Clean Light Pro driver app, **pixel-matching `~/Downloads/sherpa-p2p3-mock.html` exactly**.

**Architecture:** All driver UI is in `xpizza-driver/index.html` (non-bundled ES modules). Pure cash math goes in a NEW `xpizza-driver/cash-helpers.js` (TDD via `node cash-helpers.test.js` + assert), imported by index.html. SDK write (`recordCuadre`) added to `xpizza-delivery.js`. Rules in `xpizza-reference/database.rules.json`. Mirror changed driver files → native `www/` → cap copy → App Distribution. Worktree: `~/Downloads/xpizza-cash` (branch `feature/driver-stacked-cash` off main).

**Fidelity rule:** the mock's CSS classes (`.qcard/.seq/.sheetwrap/.sheet/.vt-*/.receipt/.rc-*` etc.) are ported VERBATIM into index.html's `<style>`; the markup builders reproduce the mock's DOM exactly. No reinterpretation.

---

## Task 1 — Pure cash helpers (TDD)
**Files:** Create `xpizza-driver/cash-helpers.js`, Test `xpizza-driver/cash-helpers.test.js`

- [ ] **computeVuelto(total, tendered)** → `tendered - total` when `tendered >= total`, else `null` (don't show a negative). Test: (370,500)=130; (370,370)=0; (370,300)=null; bad input → null.
- [ ] **vueltoSuggestions(total)** → up to 3 ascending round-up amounts ≥ total: next 100, next 500, next 1000 (dedup, drop any == total only if a higher exists). Test: 370 → [400,500,1000]; 500 → [600,1000,1500]? (decide: next-100=600, next-500=1000, next-1000=1500) — keep [600,1000,1500]; 1000 → [1100,1500,2000].
- [ ] **computeShiftCash(allTasks, allOrders, uid, sinceMs)** → `{ deliveries, totalCollected, cashOwed, cashOrderCount }`. Iterate delivery tasks assigned to uid, `status==='completed'`, `completed_at >= sinceMs`: deliveries++, totalCollected += order.total; if `payment_method` includes 'efectivo' → cashOwed += order.total, cashOrderCount++. (Same logic as `syncIdleStats`, extracted + returns the full set.) Test with a fixture of mixed cash/card/old/other-driver tasks.
- [ ] Each: write failing test → `node cash-helpers.test.js` (FAIL) → implement → PASS. Refactor `syncIdleStats` to call `computeShiftCash` (no behavior change; keep the idle "Efectivo hoy" line working).

## Task 2 — P2 stacked-order detail sheet
**Files:** Modify `xpizza-driver/index.html`

- [ ] Port mock CSS: `.qcard/.seq/.qmid/.qname/.qaddr/.qpay/.qchev`, `.sheetwrap/.sheet/.grab/.sh-head/.sh-name/.sh-pill/.cn/.hr/.adr/.pay/.nav/.locked/.closebtn` verbatim.
- [ ] Rewrite `renderQueue(orders)`: section label `ORDEN DE DESPACHO`; each card = `.qcard` with `.seq` = `${i+2}º`, name, address, payment chip (`Efectivo`/`Tarjeta` via the same isCash/isCard logic as the active card), chevron; `data-q="${i}"` for tap.
- [ ] Stash the queued `o` objects module-level (`queuedOrders = rest`) in `renderActiveAndQueue` so the tap handler can render detail from the real order.
- [ ] Add a hidden `#queue-sheet` container; `renderQueueDetail(o)` builds the sheet markup (mock-exact): name + `Nº · EN COLA` pill, Llamar/WhatsApp (reuse the active-card contact builder), address, A COBRAR + payment chip, Waze/Maps (reuse nav builder), `.locked` note "Orden de entrega asignada por despacho.", `Cerrar`.
- [ ] Handlers (event-delegated): tap `.qcard` → open sheet for `queuedOrders[data-q]`; `Cerrar` / backdrop tap → close. VIEW-ONLY (no state writes). Completion stays sequential (unchanged).

## Task 3 — P3 vuelto: exact change FROM THE ORDER (display-first) + override sheet
**Files:** Modify `xpizza-driver/index.html`
**Key data:** the order already carries the customer's stated cash amount as **`order.cash_tendered_cents`** (integer cents; set by the order form's "¿Con cuánto vas a pagar?" only when ≥ total — else absent/exact). `order.total` is in **Lempiras**. So `tendered_L = cash_tendered_cents/100`, `change = computeVuelto(order.total, tendered_L)`.

- [ ] Port mock CSS: `.ac-card/.ac-payrow/.paywith` + `.vt-title/.vt-sub/.vt-total/.vt-inlbl/.vt-input/.chips/.chip/.vt-result/.vt-done`.
- [ ] **Active card (cash order):** compute `change = computeVuelto(order.total, (order.cash_tendered_cents||0)/100)`. If `change != null` → render the green **`.paywith`** line "Paga con **L{tendered}** · Vuelto **L{change}**" (tappable → sheet, prefilled). If `change == null` (no stated amount / exact) → keep the plain **`Calcular vuelto`** link (manual fallback).
- [ ] Add hidden `#vuelto-sheet`; opening it prefills "Cliente paga con" with `tendered_L` when known (else empty), total shown, chips = `vueltoSuggestions(order.total)`.
- [ ] Numeric input (inputmode numeric); on input/chip → `computeVuelto(total,tendered)` → live `Vuelto: L X` (green) or hide if null. Sub-copy: "El cliente indicó este monto al ordenar — editá solo si paga con otra cosa." `Listo`/backdrop closes. **Nothing persisted** (override is in-memory only; `cash_owed` stays = Σ total, untouched by change).

## Task 4 — P3 clock-out cuadre + record + rules
**Files:** Modify `xpizza-driver/index.html`, `xpizza-driver/xpizza-delivery.js`, `xpizza-reference/database.rules.json`

- [ ] SDK `recordCuadre(driverId, shiftId, { cash_owed, cash_order_count })` → `update(ref(db, \`driver_cash/${driverId}/${shiftId}/cuadre\`), { cash_owed, cash_order_count, closed_at: serverTimestamp() })`.
- [ ] Rules: add `driver_cash` — read = own uid OR dispatcher; write = own uid; validate cuadre has `cash_owed`(number), `cash_order_count`(number), `closed_at`(number).
- [ ] Port mock CSS: `.receipt/.rc-title/.rc-date/.dash/.rc-row/.rc-big/.rc-note/.rc-confirm/.rc-back`.
- [ ] Intercept `handleEndShift`: replace the `confirm('¿Terminar el turno?')` with the **cuadre screen** (`#cuadre-screen`, receipt-exact) populated from `computeShiftCash(allTasks, allOrders, uid, shiftStartMs)` — Entregas, Total cobrado, Pedidos en efectivo, big **EFECTIVO A ENTREGAR**. `shiftStartMs` from `driverState.shift_started_at` (fallback today-midnight). 
- [ ] `Confirmar entrega de efectivo` → `recordCuadre(uid, driverState.current_shift_id, {cashOwed,cashOrderCount})` (best-effort; don't block clock-out on a write failure — log) → then the existing cleanup + `stopNativeTracking`/`endShift`. `Volver` → cancel (stay on shift).

## Task 5 — Mirror, build, deploy rules, distribute
- [ ] Mirror changed driver files (index.html, cash-helpers.js, xpizza-delivery.js) → native `www/`; `npx cap copy android`; bump versionCode + `SYSTEM_VERSION` → 2.1.0.
- [ ] **Deploy rules** (separate, safe): `firebase deploy --only database` (rules-only — does NOT touch functions). MUST land before cuadre writes work.
- [ ] gradle assembleRelease → App Distribution (testers) → on-device validation: queue tap→sheet→Cerrar; vuelto math; clock-out cuadre + confirm writes `/driver_cash`; idle "Efectivo hoy" still correct.

---

## Risks / notes
- **Rules deploy is required** for cuadre writes; until deployed, `recordCuadre` fails (caught/logged, clock-out still proceeds). Don't bundle with a functions deploy.
- Mirror must be byte-verified (past silent rsync failure). Pure helpers + SDK + new module all need mirroring to www/.
- Out of scope (per design): tips, short-pays, office confirm UI, reorder/promote of queue.
