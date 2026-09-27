# RELAY (executor → advisor) — proactive "preparing" WhatsApp (Fix A), for codex PLAN gate

**From:** executor (designed live with the owner). **Ask:** run the **codex PLAN gate** on this before I build, then I build LOCAL-ONLY and hand back the diff for the money-flow codex gate.

**Artifacts (branch `feat/preparing-whatsapp-notification` @ `bcf5ff0`, off `origin/main`, worktree `~/Downloads/xpizza-preparing`):**
- Spec: `docs/superpowers/specs/2026-09-26-preparing-whatsapp-notification-design.md`
- Plan: `docs/superpowers/plans/2026-09-26-preparing-whatsapp-notification.md`

## Why (owner-driven)
Customers WhatsApp asking order status *during preparation*. Source-confirmed silent window: `sendOrderStatusNotifications` (index.js:3404) notifies on `new` / `out_for_delivery` / `delivered` / `cancelled` and **deliberately skips `preparing`/`ready`** ("would be too noisy"). Fix A = one proactive "preparando — listo en ~X min" WhatsApp at the `preparing` transition. Owner approved **A now, B (AI status-responder) next**; **static config ETA first** (predictor is shadow-only), seed **X.Pizza 20 / La Musa 30**.

## Design in one paragraph
New **`notifyPreparing`** `onValueWritten('/orders/{id}/status')` trigger, **separate** from and leaving `sendOrderStatusNotifications` **byte-unchanged** — modeled exactly on the proven `notifyPickupReady`. Marker isolated in a **top-level `/preparing_notifications/{id}`** tree (never under `/orders`, so it can't re-fire the four whole-order-node watchers). At-most-once via a `claimed_at` transaction; **mark-before-send** (`send_started_at` awaited before `sendMessage`); honest `sent_at` / `send_unresolved_at`; **never throws**; fail-closed restaurant gate + `isEnabledForRestaurant`. ETA is **config-driven** (`restaurants/<rid>/prep_eta_min`) with a **single neutral fallback (25)** — no per-brand literal in code (brand-agnostic tenet); seeded 20/30. New `tplPreparing` template varies copy by `order_type` (pickup "listo para recoger" / delivery "sale hacia vos") using the existing brand helpers. Both brands.

## What I want codex to VERIFY (framing — not attack)
1. **No double-send** under trigger redelivery / concurrent `preparing` writes — is the `claimed_at` transaction + mark-before-send ordering actually sufficient, as it is for `notifyPickupReady`?
2. **Fail-open / never-throws** — can any path here affect the order or throw into the trigger? (money path must stay untouched.)
3. **Money sender frozen** — `sendOrderStatusNotifications` byte-unchanged; the new trigger adds only one order read per `preparing` transition.
4. **Marker isolation** — `/preparing_notifications/` can't re-fire materialize / factura / assign / the pickup-ready trigger.
5. **Coverage** — is "every kitchen order passes through `preparing`" sound (KDS NUEVO→Empezar→prep→Completar→ready), and does any non-KDS path write a post-`preparing` status without `preparing` in a way that would leave a NEW silent window? (Note: a jump straight to `out_for_delivery` still sends the existing "va en camino".)
6. **Brand-agnostic + both brands** — ETA config-driven, no hardcoded per-brand number, parity across x_pizza/la_musa.

## Flow from here
codex PLAN gate (VERDICT: APPROVED/REVISE) → I build LOCAL-ONLY task-by-task → hand back the diff for the **built-diff codex gate** (money-flow framing) → owner deploys `functions:notifyPreparing` + seeds `prep_eta_min` + smoke. Then Fix B.

---
*Executor-authored (owner designed this directly with the executor session); routed to the advisor for the codex plan gate.*
