# Plan Review Log: Factura (SAR) integration for X. Pizza

Act 1 (grill-with-docs) complete — plan locked at `FACTURA_PLAN.md`; `CONTEXT.md` updated
(Factura, Sale, CAI, Range, Forma de Pago, Cash tendered/Cambio, ISV, Void, Factura status)
and ADR-0003 (allocation lifecycle + fail-closed) and ADR-0004 (facturas nested per
restaurant) written. MAX_ROUNDS=5. PLAN_FILE=FACTURA_PLAN.md.

## Round 1 — Codex (thread 019effca-ace4-7f83-a3e0-fffb78656e1b)

VERDICT: REVISE. 14 findings, all specific and code-grounded:

1. Off-by-one: transaction issues `current_sequence+1` but go-live sets `current_sequence=range_start` → first factura = range_start+1.
2. Order-id idempotency not race-safe: check-then-increment can double-burn under concurrent allocators.
3. "Fail-closed" contradicts non-blocking allocation: goal says no Sale left without a valid factura, but failures leave `pending` — guarantee is "eventually issued," not synchronous.
4. `createOrder` early idempotent return (index.js:465) runs before any post-write hook → a retry won't repair a first-attempt allocation failure.
5. Online allocation misses recovery routes: materialization happens in `confirmAndMaterialize`, `resolveManualReconciliation`, and `materializeOnConfirm` (index.js:1311) — a hook only in the HTTPS confirm wrapper misses them.
6. `factura_status: pending` on `pending_payment` is dangerous: those aren't Sales; a reconciler over pending could issue facturas for abandoned cards.
7. Items not stored: `createOrder`/`chargeOnlineOrder` validate `body.items` but store only `items_text`; not a fiscal line source.
8. Extras line model underspecified: `computeServerTotal` folds extras into the total; must define whether extras print as lines and prove `sum(items[].line_total)===subtotal_cents`.
9. Void trigger races: cancel-before-allocation no-ops, then allocator later issues a non-void factura, or the void is never recorded.
10. Dispatcher direct-create (`createOrderWithTasks`, xpizza-delivery.js:857) writes `/orders` from the browser, bypassing server pricing AND the planned hooks → manual Sales bypass factura.
11. Cash-tender validation incomplete: server ignores `cash_tendered`; no cents/lempiras, decimal, or method scoping defined.
12. Security rules missing: no `/facturas` or `/restaurants` rules; KDS "set printed:false" from client is either denied or lets clients mutate fiscal records.
13. Print claiming not concurrency-safe: agent prints every `printed===false && !void`; two listeners/agents can double-print.
14. Expiry date format fragile: `DD/MM/YYYY` parses ambiguously in JS.

### Claude's response
Accepted all 14 (final arbiter). Root-fix several at once by restructuring allocation around a **single DB trigger** `allocateFacturaOnSale` on `/orders/{orderId}` (mirrors the existing `materializeOnConfirm` pattern) that fires when an order is a live Sale lacking a factura — uniformly covering cash/card_delivery, ALL online materialize routes (#5), and the dispatcher direct-create path (#10). Specific changes in FACTURA_PLAN.md:
- #1: `current_sequence` defined as **last-issued**; seed/swap to `range_start - 1`; issue `+1`.
- #2/#9: race-safe two-phase — claim `/facturas/{rid}/{orderId}` via transaction first; only the winner advances the sequence; allocator **skips issuance entirely if the order is already cancelled / `factura_status:void_pending`** (cancelled-before-issue needs no factura → no number burned, no void needed); residual race issues-then-voids.
- #3: reworded goal — sale is non-blocking; guarantee is "no Sale permanently without a factura" via queue+reconciler; "fail-closed" scoped to *sequence integrity* (never issue an invalid/expired number), not blocking the sale.
- #4: idempotent allocation now via the DB trigger (not a post-write hook), so `createOrder`'s early idempotent return is irrelevant — the trigger fires on the persisted order regardless.
- #6: `factura_status` defaults to **`not_due`**; the trigger sets `pending→issued/failed` only once the order is a Sale (status `new` AND, for online, `payment_status:confirmed`); reconciler filters by Sale state.
- #7/#8: order-creation paths now store a server-priced structured `items[]` (qty, description, extras as their own lines, line gross + tax-exclusive base cents + rounding adjustment) so `sum(line_total)===subtotal_cents` exactly; required because the DB trigger sees only the stored order.
- #10: dispatcher `createOrderWithTasks` must stamp the same priced cents + structured items (or the trigger marks `factura_status:failed`+alert); covered by the trigger either way.
- #11: `cash_tendered_cents` integer centavos, cash-only, server-validated `>= total_cents`, stores `cambio_cents`.
- #12: default-deny `/facturas` + `/restaurants` to clients; KDS reprint goes through a dispatcher-gated callable, not raw writes.
- #13: print agent acquires a transactional `print_claim` (owner+expiry) before sending bytes.
- #14: store `fecha_limite` as ISO `YYYY-MM-DD` for comparison (render DD/MM/YYYY); compare in America/Tegucigalpa; unit-test boundaries.

## Round 2 — Codex (same thread)

VERDICT: REVISE ("most prior issues directionally addressed"). 7 findings:
1. Two-phase still has a lost-number crash hole: sequence incremented, then record written separately → crash between consumes a number with no audit tie.
2. Claim stubs can block retries after fail-closed: Phase A writes the node, an abort leaves a stub future retries mistake for an existing factura.
3. Cancelled-before-issuance skip conflicts with "factura for every Sale" (cash/card_delivery are Sales at creation) — issue-and-void unless fiscal counsel says otherwise.
4. Trigger predicate too broad: matches legacy/dispatcher orders missing factura_status/fiscal fields.
5. Dispatcher direct-create still unresolved (left as open decision); live helper trusts browser-supplied order data.
6. Docs inconsistent: ADR-0003 still said "defaults pending"/"two code paths"; CONTEXT term omits not_due/void_pending.
7. Security rules described, not concrete: no print-agent credential model or callable auth contract.

### Claude's response
Accepted all 7 (final arbiter). Changes:
- #1: Phase B is now a transaction on `/restaurants/{rid}/factura_config/seq` (`{last_issued, pending{}}`) that atomically records `pending[orderId]=next` while reading `last_issued`; record written, then `last_issued` promoted; reconciler completes/releases orphaned reservations. Number↔order tie is crash-atomic.
- #2: factura node gains explicit `state` (`claim|reserved|issued|failed`); only `issued` is idempotent success; stale claims reclaimable.
- #3: Switched default to **issue-and-immediately-void** for any order that reached Sale state; skip-issuance demoted to a counsel-gated optimization (R6). Conservative + definitely compliant.
- #4: Narrowed trigger predicate to `factura_status ∈ {not_due,pending,failed}` + required fiscal fields present + `created_at >= FACTURA_LAUNCH_CUTOFF`.
- #5: Trigger marks Sales missing fiscal fields `failed`+alert (never silent); raised as R5 decision — real dispatcher Sales must move to a server-priced callable; confirm usage with Xavier.
- #6: Updated ADR-0003 (single-trigger, reservation-atomic, issue-and-void, narrow predicate) and CONTEXT factura-status term (not_due/void_pending added).
- #7: Concrete rules snippet (`/facturas` + `factura_config` default-deny); print agent uses Admin SDK; dispatcher reads via `getFactura` callable; reprint via dispatcher-gated `requestReprint` callable.

Two items (R5 dispatcher usage, R6 pre-print cancellation) flagged for Xavier/fiscal-counsel confirmation — conservative defaults chosen so they don't block the architecture.

## Round 3 — Codex (same thread)

VERDICT: REVISE (Round-2 findings 2–7 confirmed resolved; remaining blocker = the new reservation design). 5 findings:
1. Reservation can still duplicate numbers: recording pending[orderId]=last_issued+1 without bumping last_issued means concurrent reservations read the same last_issued.
2. Finalization regresses counter if reservations complete out of order ("promote last_issued=next" unsafe).
3. Config naming inconsistent: §1/go-live still seed current_sequence while allocation uses seq{last_issued,pending}.
4. Predicate logic bug: requiring fiscal fields present in eligibility means the missing-fields→failed path never runs.
5. Stale doc contradictions: Key decisions still says "skip issuance for cancelled-before-issue"; CONTEXT still describes current_sequence.

### Claude's response
Accepted all 5 (final arbiter). Findings 1–2 were genuine concurrency bugs in the reservation algorithm I introduced — fixed by collapsing to a single monotonic high-water counter:
- #1/#2: seq node is now `{ last_reserved, pending{} }`. ONE transaction advances `last_reserved = last_reserved+1` AND records `pending[orderId]=last_reserved` together → concurrent allocators can never reserve the same number. A reserved number is **permanently consumed** (never reused, never moved backward); orphaned `pending` entries are reconciled to terminal audit records (issued/void/abandoned), not "released." Removed the unsafe `last_issued` promote step.
- #3: Replaced `current_sequence` everywhere (§1 seed, §11 go-live, CONTEXT Range term) with the `seq{last_reserved,pending}` ledger; seed/swap to `last_reserved=range_start-1`.
- #4: Predicate now matches Sale-state + cutoff + factura_status only; field-presence check moved INSIDE the handler → missing fields ⇒ failed+alert path actually runs.
- #5: Updated Key decisions ("issued-and-immediately-voided, never skipped") and CONTEXT Range term + ADR-0003 reservation bullet to the single-counter model.

## Round 4 — Codex (same thread)

VERDICT: REVISE (reservation model confirmed concurrency-safe + crash-auditable). 2 findings:
1. `void_pending` can strand cancelled Sales: allocation trigger matches only status:'new', cancel sets void_pending after status:'cancelled', reconciler skips cancelled → nothing issues-and-voids if cancel precedes allocation.
2. ADR-0003 consequence text still described the predicate as including required money/items fields (would exclude malformed orders instead of marking failed).

### Claude's response + Xavier's R5/R6 input
- **R5 RESOLVED by code check:** `createOrderWithTasks` sole caller anywhere is `xpizza-reference/test-harness.html` — test-harness/legacy, not a production fiscal channel. Trigger failed+alert is the safety net; no server-priced callable needed for launch. Plan R5 updated to RESOLVED.
- **R6 decided by domain owner:** a factura documents a *consummated* Sale → an order cancelled BEFORE its number is issued gets **no factura** (handled as a cancellation); only an already-issued number is voided. Confirmed sound across payment types (cash/card_delivery take money at delivery, after the factura; paid online cancel is refunded by cancelPaidOrder). Flagged for accountant confirmation.
- This **dissolves finding #1**: with skip-before-issue, a cancelled order owes no factura, so there is nothing to strand; the reconciler correctly excludes cancelled. Replaced `void_pending` with terminal `factura_status:'cancelled'`; allocator skips reservation for cancelled orders, with a race-guard that voids any number issued the instant a cancel lands.
- **#2 fixed:** ADR-0003 consequence text now states the two-stage predicate (Sale-state + cutoff + factura_status in predicate; required-field presence checked inside the handler → missing ⇒ failed+alert).
- Updated CONTEXT [[Sale]] + Factura-status (dropped `void_pending`, added `cancelled`) and ADR-0003 cancellation bullet to the skip-before-issue / void-after-issue model.

## Round 5 — Codex (same thread) — FINAL

VERDICT: **APPROVED**. "No correctness blockers remain in the core design." Confirmed: reservation model concurrency-safe + crash-auditable; cancellation semantics coherent across plan/ADR/CONTEXT; R5 acceptable as scoped (createOrderWithTasks only called by test-harness.html).

One cleanup nit: FACTURA_PLAN.md summary status enum still listed `void_pending`. Fixed → `not_due|pending|issued|failed|void|cancelled` (operative sections + CONTEXT already used the new semantics).

## Resolution: CONVERGED (APPROVED in 5 rounds)
Act 1 (grill-with-docs) + Act 2 (Codex adversarial review, 4 REVISE → APPROVED) complete. Plan locked at FACTURA_PLAN.md. Two items deferred to fiscal counsel with conservative defaults: R5 (resolved/test-only) and R6 (pre-issuance cancellation = no factura; accountant to confirm). Awaiting Xavier sign-off before any code.
