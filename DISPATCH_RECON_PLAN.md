# Dispatch: Reconciliación panel + click-to-expand active orders (PLAN)

_Executor build for the auditor + Codex gate. Two dispatch-UI features. CLIENT-ONLY (no server change),
additive, serves X. Pizza + La Musa. Diff: `xpizza-dispatch/index.html` (+135/−30), `xpizza-dispatch/
xpizza-delivery.js` (+41/−~2). Diff file: `/tmp/dispatch-recon.diff`._

## Goal
1. **Reconciliación panel** — a dispatch sidebar group listing all open `manual_reconciliation` orders
   (money-ambiguous online checkouts) regardless of date, with `Materializar` / `Reembolsar` / `Descartar`
   wired to the existing audited `resolveManualReconciliation`. Fixes the gap where the same-day view
   can't reach aged flagged orders, so the reconcile-breach banner couldn't be cleared from the UI.
2. **Click-to-expand active orders** — make unassigned + assigned order cards open the same detail modal
   that completed orders already use.

## Why (context)
The dispatch only shows same-day orders and had **no manual_reconciliation resolver UI at all** — those
orders could only be resolved from admin. Aged ones keep tripping the 6h `reconcilePayments` breach alert
with no UI path to clear. (Three test-order breaches were just cleared from admin; this prevents recurrence,
which matters for real customers who abandon a PixelPay checkout.)

## Design — data layer (`xpizza-delivery.js`)
- `subscribeToManualReconciliation(cb)` — **indexed** query `orders` `orderByChild('status').equalTo('pending_payment')`
  (existing `.indexOn`), then client-filter `payment_status === 'manual_reconciliation'`. Rationale:
  `manual_reconciliation ⊆ pending_payment` (flagged before materialization; `status` stays pending_payment),
  and `subscribeToOrders`'s `filterLiveOrders` hides these — so a dedicated view is required. **No rules
  change** (reuses the status index; avoids a `payment_status` index + deploy).
- `resolveReconciliation(orderId, action, note)` — `auth.currentUser.getIdToken()` → POST
  `{ order_id, action, note }` to `resolveManualReconciliation` with `Authorization: Bearer <idToken>`.
  Throws on non-2xx (surfaced as a toast). The server function already has `cors: true` + `authorizeDispatcherAction`
  (accepts a verified dispatcher ID token) + all its guards (abandon refused if a `payment_uuid` exists, etc.).

## Design — dispatch UI (`index.html`)
- New `#reconciliation-group` sidebar tree-group (above "Cerrados hoy"), **auto-hidden when empty**, red
  left-border + pulsing count badge (`.tree-group-meta.hot`, existing).
- Own subscription → `reconciliationOrders` global → `renderReconciliationSection()` (also called from
  `renderSidebar`). Cards render **their own markup** (these orders are NOT in `allOrders`, so the shared
  detail modal can't reach them — deliberate). Each card: id · brand · customer · age + the 3 action buttons.
- `resolveReconciliationAction(orderId, action)` — `confirm()` with an action-specific warning → `XPD.resolveReconciliation`
  → toast. Server does the real work + audit.
- **Feature 2:** `.unassigned-card` and `.task-row` click handlers changed from inline-expand+map-fit to
  `openOrderDetailModal(orderId)` (matching the existing `.delivered-card` handler). The modal is already
  generic (any order in `allOrders`, any status); active orders ARE in `allOrders`. Button clicks still
  guarded by `closest('button')`.

## What the gate should verify
- **X. Pizza dispatch safety** — additive; existing assign/cancel/driver/delivered flows untouched. Feature 2
  swaps two click handlers (inline-expand → modal) — no regression; modal handles active orders (fields an
  active order lacks are already null-guarded per the map).
- **Query correctness** — the `manual_reconciliation ⊆ pending_payment` invariant (else a flagged order with
  another status would be missed). Confirm no code path sets `payment_status:'manual_reconciliation'` on a
  non-`pending_payment` order.
- **Money-action safety** — no way to bypass the server guards; `order_id`/`action` payload correct
  (`materialize|refund|abandon`); ID-token auth; error handling; confirm dialogs present. The UI can only
  *trigger* the already-gated resolver.
- **CORS/auth** — resolver `cors:true` handles preflight; Bearer token from `auth.currentUser`.
- **No modal misuse** — reconciliation orders (not in `allOrders`) are never passed to `openOrderDetailModal`.
- **Show/hide + no-secret** — `#reconciliation-group.hidden` CSS present; the hardcoded function URL is a
  public endpoint (fine).

## Gate round 1 → 4 client folds applied (re-gate)
1. **Buttons disabled while a resolve is in flight** — the order's 3 buttons disable on click, re-enable in
   `finally` (no same-tab double-fire).
2. **Honest outcome, not toast-on-2xx** — `RECON_SUCCESS_OUTCOMES = {materialized, confirmed, already_confirmed,
   refunded, abandoned}`; any other 2xx outcome (refund_pending / confirm_claim_failed / attempt_superseded /
   kept_queued) shows `"<outcome> — revisar"`, never a fake success.
3. **Function URL from `app.options.projectId`** (not hardcoded prod) — a preview/staging/emulator dispatch
   page targets its own project's functions, never prod money actions.
4. **Operator note** — collected via the prompt; **required for `abandon`**, optional for refund/materialize;
   passed to the server (which audits it).

## ⚠️ Known residual (server-side, pre-existing — NOT in this PR)
`resolveManualReconciliation` reads `payment_status` then mutates non-atomically (`index.js:1296`), so two
tabs / two dispatchers on the same order can both pass the guard and interleave materialize + refund. This PR
doesn't introduce it, but the new UI makes it reachable. Fold #1 stops a **same-tab** double-click only. The
robust fix (separate server change, own gate): an **atomic claim** (`manual_reconciliation → resolving:<action>`
transaction before any side effect) + an **honest status contract** (2xx only for genuinely-final outcomes).
Sequencing (ship client now + server fast-follow, vs hold for coordinated change) is Xavier's decision.

## Out of scope / notes
- Money actions route through the existing server resolver (already gated) — this PR only adds the trigger UI.
- `Materializar`/`Reembolsar` touch PixelPay (real capture/void); `Descartar` = the abandon path (matches the
  admin cleanup just performed). Recommend exercising `Descartar` first on a throwaway abandoned checkout.
- Deploy is Netlify (`xpizza-dispatch/`); module cache-buster bumped `?v=16 → ?v=17`.
