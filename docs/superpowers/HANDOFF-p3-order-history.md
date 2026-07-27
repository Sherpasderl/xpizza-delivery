# HANDOFF → order-form executor session — P3 Order History + Reorder

**What:** Add "Mis pedidos" (order history) + "Reordenar" for logged-in customers. Spans **functions + RTDB rules + both `account.js` forms**. Owner directive: **maximally methodical; both halves seamless; money path untouched.** Design-gate APPROVED R2. Owner-approved mockup: https://claude.ai/code/artifact/070789b5-b041-4a76-84a7-a2687e33f01e

**Branch:** `feat/p3-order-history` (tip = design docs, off live `main` `337ffc8`). Check out fresh.

**Read (on the branch), in order:**
- Spec: `docs/superpowers/specs/2026-07-26-p3-order-history-reorder-design.md`
- Plan (10 tasks, exact files/tests): `docs/superpowers/plans/2026-07-26-p3-order-history-reorder.md`

## The single most important rule
**Reorder SEEDS THE CART ONLY.** It must NOT recompute price or re-implement the availability decision for money — the normal submit (`createOrder`/`chargeOnlineOrder`) already re-prices (`computeServerTotal`) and re-gates (`checkItemAvailability`) server-side, and the frontend review re-applies UI rules (X. Pizza pickup-only cats, La Musa category/variant). Do not create any new submit path or new trust. This is what makes reorder money-safe by construction.

## Foundation (verified — don't re-derive)
- `/user_orders` is ALREADY written today (old shape, `.read`-denied). Two writers: `create-order-build.js attachCustomerAttribution()` (cash) + `materialize.js` (online, at confirm). **Extend them — keep the `user_orders/{uid}/{orderId}` path** (so account deletion stays correct). Do NOT re-nest under restaurant.
- Attribution is server-verified (`X-Firebase-ID-Token` → verified `customer_uid`; client uid never trusted). Guests are NO-OP.
- `menu-pricing.js` matches **x_pizza by NAME, la_musa by id** — the reorder recipe keys accordingly (Task 1 normalizer).

## The two build-callouts codex flagged (get these right)
1. **Online has no `body.items` at materialize.** `materialize.js` gets the pending order RECORD from RTDB, which doesn't carry the recipe. So at **`chargeOnlineOrder`** compute the normalized recipe and persist `orders/{id}/reorder_items`; `materialize.js` copies it into the history entry **only at materialize (confirm)** — never at pending_payment. (Task 3)
2. **Normalized `items[]` = menu-allowlisted keys only** (name for x_pizza / id for la_musa) + qty + recognized options — validated against the current menu, unrecognized dropped. **No raw client names/prices stored.** Display uses the already-sanitized `items_text`; reorder re-resolves name/price from today's menu by key. (Task 1)

## Other non-negotiables
- **Status trigger = update-only-if-exists** (Task 4) — reads the entry, updates status only if present; a pending/unpaid order (no entry yet) → NO-OP. Never index an unpaid checkout. Fail-open.
- **Rules** (Task 5): `user_orders/{uid}` read-own (`auth.uid === $uid`) + `.write:false` + `.indexOn:["ts"]`, in `xpizza-reference/database.rules.json`. **Run the RTDB emulator** with the test matrix (own/wrong-uid/unauth/client-write). No `numChildren()`.
- **Account deletion** (Task 6): unchanged (`user_orders/{uid}:null` already purges everything) — add a test proving it.
- **No raw client item strings stored or rendered** — display via escaped `items_text`; `items[]` never rendered.
- **Guest byte-identical** (Task 9); **both forms identical past CONFIG** (`CONFIG.restaurant_id`, per-brand palette); update the existing builder + account-lib unit tests; run the functions test suite green.
- **Do NOT prune functions** — adding the trigger export must keep ALL existing fns (driver + payment). 

## Deploy (owner runs; report so the owner sequences it)
**Backend + rules BEFORE forms.** Functions = complete env, both driver+payment code, zero-prune (gcloud). Rules = `npm run sync:rules` then `deploy:rules` (emulator first). Forms = Netlify per-folder (xpizzaorders 6f09559f / lamusaorders f8bac377). Forward-only (no backfill).

## FILE COORDINATION
Advisor is NOT editing these files — you are the SOLE editor on this branch (functions + both account.js). Advisor reads + runs codex-on-diff only. Push `feat/p3-order-history`, report the tip SHA + per-task commits + emulator + test-suite results. **Do NOT deploy/merge/run codex.** Advisor runs codex-on-diff (heavy on money-safety, attribution integrity, the status trigger, rules, guest byte-identical) → loop to APPROVED → owner deploys in the sequenced order.
