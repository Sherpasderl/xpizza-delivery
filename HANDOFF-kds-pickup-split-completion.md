# HANDOFF (KDS executor) — split pickup completion: Listo (notify + wait) vs Entregado (collected + earn)

**Type:** MONEY-ADJACENT (moves the earn/consume trigger to the real handover) → **codex money-gate on the diff.** Do NOT self-approve.
**Surface:** `xpizza-kitchen/index.html` (`commitStatusWrite`/`listo`/`startCompletion` + card CTA + bucket) + `xpizza-kitchen/card-model.js` (action→status + bucket). Both KDS sites (one folder). Zero forms/functions/rules change (the earn trigger `earnRewardsOnCompletion` on `status='completed'` is unchanged — we only change WHEN the KDS writes `completed` for a pickup).
**Design gate:** APPROVED (advisor 2026-08-02). **Base:** current `main`.

## The problem (verified from source)
Today the KDS "Completar" hold does BOTH `ready` (fires `notifyPickupReady` WhatsApp) and, ~700ms later, `completed` (earns) — one gesture (`commitStatusWrite('listo')` → `'ready'` → `if(action==='listo') startCompletion(id)` at index.html:2060 → `'completed'` for pickup). So for a PICKUP, "notify the customer it's ready" and "mark completed + give the reward" are collapsed into one action — there is no correct moment to tap it: hold-when-made → reward fires before the customer collects/pays (cash reward before cash, or reward on a never-collected order); hold-when-collected → the "come pick up" WhatsApp fires when they're already at the counter.

## The fix — split the PICKUP flow into two steps (delivery untouched)
`new → (Empezar) preparing → (Listo) ready → (Entregado) completed`
1. **Listo, for a PICKUP order:** write `'ready'` (fires the WhatsApp, unchanged) but do NOT chain into `startCompletion`. The order **stays on the active board** in a "Listo · esperando recogida" state.
2. **Entregado (new) on a `ready` PICKUP order:** a hold-to-confirm CTA (reuse the existing hold-ring pattern) → `startCompletion` → writes `'completed'` (the pickup-completion path, already gated) → earn + consume + bump to Completados.
3. **DELIVERY orders: byte-unchanged.** For delivery, `commitStatusWrite('listo')` still chains to the local completion beat (the driver owns the `'delivered'` terminal). Gate on `order.order_type` exactly like the current pickup `completed`-write does.
4. **Card CTA + bucket:** a `ready` pickup card renders "Listo · esperando recogida" + an **Entregado** hold CTA (not bumped off); it stays in the active pool until Entregado. A `ready` delivery card is unchanged. Verify the bucket/estado map keeps a `ready` pickup ACTIVE (not "nuevo", not bumped) — and note `notifyPickupReady`'s WhatsApp still fires exactly once on the `ready` write.

## Invariants the money-gate WILL check
- **Earn/consume fires ONCE, at Entregado (`completed`), NOT at Listo (`ready`).** A `ready`-but-not-yet-Entregado pickup has NO earn, NO consume → **no reward on an uncollected order** (closes the cash-timing leak).
- **`notifyPickupReady` WhatsApp fires once on `ready`** (Listo) — the customer is notified when it's actually ready.
- **DELIVERY path byte-untouched** — the driver still owns `'delivered'`; no pickup change leaks into delivery (order_type-gated).
- **Fail-closed** — the Entregado `completed` write gates the local bump (exactly like today's `startCompletion` pickup guard: `setOrderStatus`===true before the beat).
- **Idempotent** (re-tap / recall safe); recall on a `ready` pickup returns it to the board, not a phantom complete.
- **Supersedes the coalescing fix in this region** — `ready` (Listo) and `completed` (Entregado) are now two deliberate staff actions minutes apart, so there is no per-gesture ready→completed coalescing to defend against; the deferred-`completed`-write can stay (harmless, no adjacent `ready` write) or be simplified — call it out either way.
- Both KDS sites (parity — one folder).

## CTA label
"Entregado" (staff handed it over). Adjustable — the downstream status pill already reads "Recogido" for `completed` pickups. Owner can tweak the word; the mechanics are what matter.

## Flow
Build on `main` → `kds-smoke.test.mjs` + card-model tests green (add: pickup Listo→ready-stays-on-board no-earn; pickup Entregado→completed earns once; delivery unchanged) → **codex-on-diff money-gate** (earn fires only at Entregado; delivery untouched; ready-pickup un-earned) → owner deploys KDS ×2 (xpizzakitchendisplay + lamusakitchendisplay).
