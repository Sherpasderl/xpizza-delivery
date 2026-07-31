# HANDOFF → AUDITOR: pickup-order completion — codex DESIGN gate (before build)

**Written:** 2026-07-31 (executor). **Action:** run a codex **design/plan gate** on the pickup-completion SPEC (no code yet). Return **VERDICT: APPROVED / REVISE** with findings. Executor revises → then writing-plans → build → separate codex-on-diff (money-adjacent). This is a **money-adjacent order-lifecycle** change → gate it hard.

## Gate this

- **Spec:** `docs/superpowers/specs/2026-07-31-pickup-order-completion-design.md` (commit `ab1e15a`, branch `docs/dispatch-redesign-spec`).
- **Supporting scope doc:** `docs/superpowers/FOLLOWUP-pickup-order-completion.md`.
- Read-only, from the repo root (`/Users/xavierlacayo/Downloads/xpizza-delivery`): `~/.npm-global/bin/codex exec -c sandbox_mode="read-only" "$PROMPT" </dev/null`.

## The design in one paragraph

Pickup orders (`order_type:'pickup'`) never reach a terminal status (no driver/delivery-task → the only `delivered` transition, `completeDeliveryTask` at `xpizza-dispatch/xpizza-delivery.js:461`, never fires), so they linger in dispatch **En Fila → Recoger** (and are invisible to Cerrados/delivered-stats). Fix: in the KDS "Completar" handler (`xpizza-kitchen/index.html` ~`:2082`), **only when `order.order_type === 'pickup'`**, also `await XPD.setOrderStatus(id,'delivered')`. Dispatch then reads `status` (zero dispatch change; `getPickupQueue` already excludes `delivered`). Reuse `delivered` (not a new status); Option A = write status only (no `delivered_at`, no rules change); pickup-scoped dry-run backfill for stuck orders.

## Grounding facts to VERIFY (executor asserts these — challenge them)

1. KDS "Completar" is **localStorage-only** today (`completedSet` ← `localStorage.xpizza_kds_completed`, `xpizza-kitchen/index.html:1586`/`:1645`); writes nothing to `/orders.status` (`:2034`). → nothing published for dispatch to read.
2. `setOrderStatus(id,status)` (`xpizza-kitchen/xpizza-delivery.js`) = `update(ref,'orders/'+id,{status})` — **no status whitelist**; La Musa KDS ownership guard returns `false` for non-`la_musa` (pickup belongs to its KDS → `true`). Writes **only** `status`.
3. RTDB rules (`xpizza-reference/database.rules.json` == `xpizza-functions/database.rules.json`): `orders/$id/status .write` **permits the `kitchen` role** for any value (only `cancelled`-on-paid-online guarded — not hit). `orders/$id/delivered_at .write` does **NOT** permit kitchen → a `{status,delivered_at}` write would be **atomically rejected** → Option A (status only) is necessary, not just chosen.
4. Dispatch `getPickupQueue` excludes `status ∈ {delivered,cancelled}` → reused `delivered` makes completed pickups leave the queue with no dispatch change.

## HARDEST thing to check — unintended consequences of reusing `delivered` on a PICKUP

A pickup order set to `status='delivered'` (with `order_type:'pickup'`, no delivery task, no driver, no `delivered_at`). **Enumerate every consumer of `status==='delivered'`** across functions + clients and confirm none misbehaves for a driverless pickup. Specifically probe:
- **Cloud Functions triggers** on `orders/{id}/status` → `delivered` (status-mirror, WhatsApp automessages, tracking `order_tracking/*/delivered_at`, ready-time/predictor timeline, any driver-settlement/cash or `user_orders` mirror). Does any assume a driver/delivery-task exists and break, double-fire, or send a wrong customer message ("tu pedido fue entregado" to a walk-in)?
- **Customer tracker** page rendering "Entregado" for a pickup — acceptable or wrong-copy?
- **`delivered_at` absence** — anything that reads `delivered_at` unconditionally on a delivered order (NPE / bad sort / bad timeline)?
- **Cancel path** (`xpizza-functions/cancel-order.js`): `delivered → not_cancelable` — correct for a collected pickup? (yes expected, but confirm no refund-axis oddity for prepaid-online pickups).
- **Stats conflation:** pickups now counted in delivered totals — intended, but flag if any report must separate them.

## Invariants to confirm the design PRESERVES

- **Delivery/driver path byte-untouched:** branch gated on `order_type==='pickup'`; delivery Completar stays a local `completedSet` bump; `completeDeliveryTask` unmodified; **no rules edit**. (Owner's hard constraint: do not tamper with the working driver status path.)
- **Idempotency:** only transition a non-terminal pickup; honor `setOrderStatus` return (`false`/throw → no local bump, surface error).
- **Backfill:** strictly `order_type==='pickup'` + non-terminal; dry-run list reviewed before writing; cannot touch a delivery `order_id`.

## Deploy note (not gated, FYI)
`xpizza-kitchen/` = per-folder Netlify, TWO sites (lamusakitchendisplay + X. Pizza) — explicit `--site` each. No functions/rules deploy (Option A).

**OUTPUT:** VERDICT APPROVED/REVISE + numbered findings (BLOCKING/NON-BLOCKING), with the `delivered`-reuse consumer audit front and center. If any Cloud Function trigger misbehaves for a driverless pickup, that's the design-changing finding.
