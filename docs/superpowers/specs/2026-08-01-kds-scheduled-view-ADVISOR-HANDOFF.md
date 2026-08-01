# ADVISOR HANDOFF — KDS "Programados" scheduled-orders view (design + plan gate)

**Ask:** Read-only **design + plan gate** before any build — same rigor as every KDS piece this arc. Confirm the contract holds by construction, scrutinize the flagged decisions, and return APPROVED or REVISE with specifics.

## What it is

A **view-only** KDS screen that shows **scheduled (held) orders grouped by day**, each day leading with a **make-count roll-up** (total + by-type pizzas), so the line can coordinate **dough production** to sales — a big order days out is visible early. Reached from a **minimalist top-bar calendar icon**; opens a main-window screen (✕ back); the Abiertos/Completados board is never disturbed.

## Read these

- **Design:** `docs/superpowers/specs/2026-08-01-kds-scheduled-view-design.md`
- **Plan (6 TDD tasks):** `docs/superpowers/plans/2026-08-01-kds-scheduled-view.md`
- **Approved visual target:** the `kds-prog-hybrid` artifact (aesthetic + interaction locked with the owner).
- **Branch:** `kds-scheduled-view` (design `9853fe0` + plan `3afb87b`, off current `origin/main`). No code yet.

## The contract (verify it holds by construction)

1. **Zero writes.** No `setOrderStatus`, no `order_timelines`, no any RTDB write. Scheduled cards have **no action handlers**. (The KDS's single awaited `setOrderStatus` call count must be unchanged from base.)
2. **No new network subscription / rule / function.** `subscribeScheduledOrders` is a **second `onValue` on the same `/orders` ref** — reuses the sync `subscribeToOrders` already opened. The KDS already reads the whole `/orders` tree, so **no security-rule change**. No Cloud Function. Order forms untouched.
3. **`filterLiveOrders` byte-unchanged**; the live board path is untouched.
4. **`renderItems` md5-identical** — reused verbatim for item lists.
5. **Host-agnostic** — restaurant via `KDS_RESTAURANT_ID`; both `x_pizza` + `la_musa`.

## Decisions to scrutinize (please push on these)

- **A. Exclude unpaid.** `filterScheduledOrders` selects `status ∈ {scheduled, releasing}` **only** — deliberately **excludes `pending_payment`** so we never prep dough for an unpaid online order. Correct, or should an unpaid-but-scheduled order surface (greyed) as a heads-up? _Owner's call so far: exclude._
- **B. "Second `onValue` = no new read."** The claim is that a second listener on the already-synced `orders` ref adds no network round-trip (RTDB shares the underlying sync). If you disagree (e.g. you'd rather derive the scheduled set inside the existing `subscribeToOrders` callback to avoid a second listener entirely), say so — it's a cheap change.
- **C. Timezone.** Day bucketing + Hoy/Mañana labels use `Intl.DateTimeFormat` with `America/Tegucigalpa` (matches existing KDS `formatScheduled`). The midnight-boundary golden covers the edge. Any concern vs a fixed UTC-6 offset (Honduras has no DST today)?
- **D. Read access.** Assumption: the KDS's existing `onValue(ref(db,'orders'))` already permits reading scheduled orders (same tree), so the scheduled listener needs **no rules relaxation**. Please confirm against the deployed RTDB rules — this is the one external assumption.
- **E. Slot only.** Cards show the customer's **slot time**, no materialization countdown (owner's choice). Fine for a heads-up, or would a "lands on the board at …" line matter?

## Test plan (what the build will prove)

- **Goldens:** `filterScheduledOrders` (scheduled/releasing only; excludes live/unpaid/wrong-restaurant; both host pins). `groupScheduledByDay` (Tegucigalpa day buckets; Hoy/Mañana labels; **midnight boundary**; soonest-first + invalid-slot-last id tie-break; per-day `railCount` make-count; group ordering). `railCount` reused (already golden).
- **Regression:** existing suites stay green (`order-filter` incl. unchanged `filterLiveOrders`, `rail-count`, `ready-nudge`, `card-model`, `kds-smoke`).
- **Contract inspection on the diff:** `renderItems` md5 == base; `setOrderStatus` call count == base (feature adds none); zero `order_timelines` writes; `subscribeScheduledOrders` read-only; host-agnostic.
- **Manual smoke (both hosts):** glyph greys/accents with scheduled presence; day chips (all days), quiet selection, per-day make-count, gold view-only cards slot-sorted; ✕ restores the board unchanged.

## Out of scope

Order actions/editing/rescheduling; notifications; a materialization countdown; any change to the live board, `filterLiveOrders`, server code, rules, or the order forms.

## Gate criteria

APPROVED if: the contract holds by construction (points 1–5), decisions A–E are sound or you've flagged the fix, and the test plan proves the invariants. REVISE with specifics otherwise. On APPROVED, the executor builds the 6 tasks TDD; the completed diff comes back for the same read-only gate before merge + owner deploy.
