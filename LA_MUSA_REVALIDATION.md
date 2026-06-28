# La Musa Integration — Plan RE-VALIDATION against current `main`

_The executor prompt's literal FIRST MOVE: re-validate `LA_MUSA_PLAN.md` (locked 2026-06-10,
committed 9f8b37c) against current `main`. Verified against HEAD `8057a29` (branch
`docs/lamusa-executor-prompt`, even with `origin/main`) on 2026-06-28 by Claude + Xavier.
Terms per `CONTEXT.md`. Pure re-validation — does NOT re-open locked decisions or edit the
executor prompt._

## Verdict

**The plan's design holds; its code references have drifted.** Every architectural decision
(flat `/orders` + `restaurant_id`, config plane, one Merchant, restaurant-keyed pricing/tax,
fail-closed routing) is still valid against current `main`. The locked decisions remain
compatible with hosted payments and the **intended** factura carve-out — but the **code**
carve-out is incomplete (see F3), so this is confirmation-plus-corrections, not redesign. Three
classes of correction are needed before building: **(S) re-point to modules/symbols that
moved**, **(F) factual claims/gaps in the plan (F1–F4)**, and **(P0) the Phase 0 RTDB-rules
open question**. No finding invalidates a phase.

## Method

Verified the plan's per-phase code claims against current `xpizza-functions/` and the app
folders via targeted reads + three parallel code sweeps (Phase 1 write-paths, Phase 2–3
consumers, Phase 4 notifications). Line numbers below are **current**; the prompt already says
cite by symbol, not line.

## HOLDS — plan baseline accurate, work genuinely still open

| Plan item | Current state | Evidence |
|---|---|---|
| 3 server order-creation paths | All present, route as described | `createOrder` `index.js:701`, `chargeOnlineOrder` `:961`, `confirmOnlinePayment→materialize` `:1094` / `materialize.js` |
| `MENU_PRICES` flat + `computeServerTotal` rejects unknown | Single-menu, X-Pizza-only; La Musa carts would reject | `index.js:213`, `:253` (reject at `:261`) |
| Server tax hardcoded ISV 15% inclusive | Single rate `/1.15`, no per-item/restaurant | `priceBreakdownCents` `index.js:289` |
| `restaurant_id` stamped but never validated | Hardcoded `FACTURA_RESTAURANT_ID='x_pizza'` on order construction; **zero** client-supplied id read or mismatch check | `index.js:75, 549, 840` (pending-order/order stamping) |
| No server-side hours enforcement | Only the form checks hours; `RESTAURANT` const has no `hours` | `index.js` `createOrder`/`chargeOnlineOrder` |
| `createOrderWithTasks` likely removable | SDK-only (`xpizza-delivery.js:857`), **no static production caller** (only `xpizza-reference/test-harness.html:371`) | step 10a still requires confirming no deployed manual/UI workflow uses the exported helper before deleting — not "deletable" on static call-sites alone |
| `payment_attempts` not yet `restaurant_id`-tagged | `acquireHostedAttempt` writes order_id/state/totals/tokens but **no Restaurant field** | plan step 11 already mandates stamping it; flagged as still-open + the attempt update/reconciliation paths must preserve it |
| Hub/pricing still in-code constants | `RESTAURANT_LAT=15.5074… :2717`, comment still "hardcoded for now" | config-plane migration genuinely un-started |
| X. Pizza form emits no `restaurant_id` | Zero matches in `xpizza-orders/index.html` → **step 23a gates the strict flip (step 8)** | flip first = reject all live X. Pizza orders |
| Global `whatsapp_enabled`, 4 brand literals, `sendMessage(to,body)`, token in `.env` | All confirmed; token is plain env var (plan upgrades to per-restaurant secret) | `whatsapp.js:116,145,170,211`; `whatsapp_inbound.js:20`; `sendMessage` `:68` |
| Inbound webhook scans all orders by phone, no instance→restaurant map | Returns newest across both restaurants | `onIncomingWhatsApp` order scan `index.js:2619`, sort `:2635` |
| Dispatcher map / tracker / KDS / `pickEligibleDriver` hardcoded X. Pizza | All center/brand/route on the constant | dispatch `index.html:1998…`, track `index.html:8`, `materialize.js:82`, `pickEligibleDriver` `index.js:2805/2890`, KDS `setOrderStatus` `xpizza-kitchen/xpizza-delivery.js:299` (no guard) |
| `pickEligibleDriver(db, excludeDriverIds)` has no order/hub context | Both auto-assign **and the timeout-reassignment caller** invoke it the same way; `reassertAssignable` has no same-Restaurant capacity check | step 17 must pass the parent Order's hub snapshot/`restaurant_id` on **both** call sites |
| `pickupComplete` stacks cross-restaurant unguarded | No `restaurant_id` check before auto-stacking | `xpizza-dispatch/xpizza-delivery.js:743–756` |
| `last_hub` already dropped | Zero references anywhere | confirms plan §17 "dropped from scope" |

## SHIFTED — re-point the plan (no design change)

- **S1 — Online charge module moved.** The plan targets `acquireOnlineAttempt` /
  `pixelpay-charge.js`. That function is **dead in production** (only its own test references
  it). The live path is **`acquireHostedAttempt` in `pixelpay-hosted-charge.js`** (+
  `pixelpay-hosted.js`, `pixelpay-hosted-webhook.js`/`handleHostedCallback`). NB the shared
  helpers `orderFingerprint` / `genAttemptId` / `centsToLempiras` still live in
  `pixelpay-charge.js` and are re-used (`index.js:741, 815`; `pixelpay-hosted-charge.js:14`),
  so that file is **not** fully dead — only `acquireOnlineAttempt` is. Steps 4(b), 9, 10 must
  re-point to the hosted module; the `orderFingerprint` folding in step 9 still applies as-is.
- **S2 — Internal confirm-caller list is slightly wrong; external endpoint persists.** The
  callers that reach `confirmAndMaterialize` and must derive `restaurant_id` from the pending
  order are **`handleHostedCallback` (webhook `:1172`), `resolveManualReconciliation` (`:1394`),
  `materializeOnConfirm` (`:1435`)**. **`sweepStalePending` is NOT one** — it only flags orders
  to `manual_reconciliation` (`:1259`); materialization happens later via
  `resolveManualReconciliation`. Separately, the **public `confirmOnlinePayment` endpoint is
  still exported and still reaches `confirmAndMaterialize`** (hosted reduced its form usage but
  did not retire it) — so step 10's external-vs-internal split still applies in full: the public
  endpoint must validate client `restaurant_id` against the pending order, not only the
  webhook/manual-recovery paths.
- **S3 — Every line number drifted** (~+60 to +600 lines: `createOrder` 701 not 550,
  `pickEligibleDriver` 2805 not 2176, `MENU_PRICES` 213 not 151, etc.). The dispatcher map
  also has **more `fitBounds` sites than step 15 enumerates** (`index.html:2592, 2723, 3218,
  3759`). Cite by symbol; enumerate all consumers before deleting the constant (plan step 2
  already mandates this).

## GAPS — claims now false / plan silent

- **F1 — md5-equality gate (step 16) is already false, but benignly.**
  `xpizza-dashboard/xpizza-delivery.js` has diverged from the other four — it is base **+ a
  7-line dashboard-only `resetPassword()` feature** (`:21, 156–160`), not routing/schema drift.
  The other four (`dispatch, driver, kitchen, reference`) remain byte-identical to each other.
  → Apply SDK edits to all 5; gate equality on the **4 non-dashboard copies**; treat dashboard
  as base + known password-reset delta.
- **F2 / P0 — OPEN QUESTION for the executor (Phase 0).** factura already writes **sensitive
  fiscal data** to `/restaurants/{rid}/factura_config` (CAI, range, `seq` counters), reached
  **only via the Admin SDK**. Precise rules state: the **deployed** rules file
  (`xpizza-functions/database.rules.json`, per `firebase.json:3`) has **no `/restaurants`
  stanza at all** → `/restaurants` is client default-deny today. The **`xpizza-reference` copy
  *does* have a `/restaurants/$rid/factura_config: {.read:false,.write:false}` deny** (`:111`)
  — but it is **not the deployed file**, so the two rules copies have **drifted** (a
  reconciliation item in its own right). Plan step 1a adds `/restaurants` with
  `.read: auth != null`; **as written that would expose `factura_config` to every authenticated
  device.** Flagged, not prescribed: the Phase 0 proposal must define the rule shape (e.g. scope
  read to identity children; carry the `factura_config` deny into the deployed file) and align
  the two rules copies, vetted by auditor + Codex. _Verified context: no authenticated **client**
  reads `factura_config` — print agent, seed, and allocator all use `applicationDefault()` Admin
  credentials; the print agent watches `/facturas/{rid}`, not the config node._
- **F3 — MISS: the factura allocator fires on La Musa orders (carve-out is incomplete in
  code).** `allocateFacturaOnSale` (`onValueWritten` on `/orders`) does
  `restaurantId = after.restaurant_id || FACTURA_RESTAURANT_ID` then allocates against
  `/restaurants/{restaurantId}/factura_config`. For `la_musa` there is no `factura_config`, so a
  La Musa **Sale** that satisfies `facturaSaleEligible()` would be marked
  `factura_status:'failed'` + alert (`index.js` allocator `:1461`-region; `voidFacturaOnCancel`
  mirrors it `:1514`). CONTEXT.md/plan carve factura **out** for La Musa (Soft Restaurant POS),
  but the **existing trigger still runs on La Musa orders**. → Phase 1 must add an explicit
  La Musa opt-out predicate — **skip by `restaurant_id` at the top of the trigger, or write an
  explicit non-eligible state such as `external_pos`/`not_applicable`. Do NOT reuse
  `not_due`** (that is the Sale-pending default the reconciler/eligibility logic keys on —
  overloading it for La Musa risks the opposite of the intended skip). This is the single
  highest-value find of the review.
- **F4 — MISS: driver-native location ingest rejects `la_musa`.** `ingestDriverLocation` uses
  `current_hub_lat/lng ?? RESTAURANT_LAT/LNG` and `isHubResolvable(current_restaurant_id)`
  (`index.js:2273-2283`), which only resolves `x_pizza` — so for a La Musa-assigned native
  driver the server-side geofence state machine is **skipped/misrouted** after launch. The plan's
  Phase 2 §12 covers browser geofence + pickup target but **not** this native ingest path. → add
  `ingestDriverLocation` + `isHubResolvable()` to the Phase 2/3 hub-snapshot re-pointing.

## Phase 0 recommendation

Phase 0 is **reconcile, not greenfield.** The `/restaurants/{rid}` path already exists (factura),
so Phase 0 **adds identity siblings** (`name`, `hub_lat/lng`, `phone`, `whatsapp_instance`,
`hours`, `active`, `version`) under the existing node — it does **not** create a parallel node,
and it does **not** touch the existing `factura_config` child. The one thing the plan does not
account for is the **RTDB-rules reconciliation (F2/P0 above)**: introducing a `/restaurants`
read rule changes the access posture of an existing sensitive subtree, so the rule change is the
risk-bearing part of Phase 0, not the identity seed. Because the rules change is the sensitive
part — and per the executor's own one-small-step rule — **sequence it, don't bundle**:
1. **Rules shape + tests first** — design the `/restaurants` rule (identity-readable,
   `factura_config` denied), reconcile the deployed vs `xpizza-reference` rules drift, prove the
   `factura_config` deny holds; ship rules alone.
2. **Seed identity siblings** — `/restaurants/{x_pizza,la_musa}` identity, no behavior change.
3. **Enable server-side config reads** (cache/TTL/snapshot) only once 1–2 are in.
Each as its own dual-approved step.

## Net assessment

- **Design: unchanged.** Nothing found re-opens a locked decision.
- **Lower redesign risk than the prompt implies:** the plan already encodes hosted-payment
  internals and the *intended* factura carve-out, so less re-work than "written before those
  landed" suggests — but the carve-out is not yet complete in code (F3), so it is build work,
  not a no-op.
- **Before building:** apply S1–S3 re-pointing and the F1 gate fix; resolve F2/P0 in the
  sequenced Phase 0 proposal; and treat **F3 (factura allocator opt-out for `la_musa`)** and
  **F4 (native `ingestDriverLocation` hub resolution)** as required Phase 1/2 work items the
  locked plan omitted — F3 especially, since without it every La Musa sale fail-alerts the
  factura pipeline. Then proceed Phase 0 → Phase 1, one dual-approved step at a time.
