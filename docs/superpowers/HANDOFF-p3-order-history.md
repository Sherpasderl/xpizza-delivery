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

---

# PHASE 2 (frontend: finish T7 + T8 reorder + T9 mirror + T10) — cart-model integration notes

Phase 1 (backend T1–T6) is LIVE + verified (functions no-prune, rules read-own emulator-green, unauth read 401). Phase 2 = the frontend, continuing from tip `8a1f1ab` (partial T7 on La Musa). The advisor grounded the risky T8 cart-seed below so you don't rediscover it — but DO your own full exploration of both cart models before wiring T8 (it's money-adjacent; reproduce lines EXACTLY).

## Verified cart-model facts (both `*/index.html`)
- **Base add = `chg(id, d)`** — id-keyed cart. X. Pizza uses a `qty[p.id]` map; La Musa likewise via `chg`.
- **La Musa variants are DISTINCT menu ids** (e.g. `noodle_01_pollo`, `variantOf:"noodle_01"`, `choice:"Pollo"`) → `chg(variantId, qty)` reproduces the exact protein line directly (NO modal needed for the variant itself).
- **Extras are STAGED, not a bare chg:** `stagedExtras = {extraId: qty}` (+ `stagedVariantId`) are set in the detail modal, then COMMITTED to a line. A line WITH extras must reproduce the staged extras via the commit path — a bare `chg()` won't attach them.
- **KEY-MISMATCH — the silent-bug trap:** the phase-1 reorder recipe keys **X. Pizza by item NAME** (mirrors `computeServerTotal`'s x_pizza name-match) but the **cart keys by item ID** (`qty[p.id]`). So T8 for X. Pizza must **resolve recipe-key(name) → current-menu item → its id → chg(id, qty)**. La Musa recipe keys by id → `chg(id, qty)` directly. An item whose name/id no longer resolves in today's menu → DROP it (with the "N productos ya no están disponibles" notice).

## T8 build direction (your call after exploring — these are constraints, not code)
1. For each `entry.items[]` recipe line: resolve its key against TODAY's menu (name→item for x_pizza, id→item for la_musa) + check `item_availability`; drop unresolved/86'd → count for the notice.
2. Add resolved lines via the form's OWN add path: base/variant → `chg(id, qty)`; a line WITH extras → the staged-commit path (reproduce `stagedExtras`/`stagedVariantId` then commit) so the extras attach exactly like a manual add. If exact-extras reproduction proves intractable cleanly, STOP and flag it to the advisor rather than shipping an approximate money line.
3. **Smart cart:** empty → add directly; non-empty → prompt "Agregar a mi pedido" / "Empezar de nuevo" (clear-then-add).
4. **Do NOT add a new submit path.** After seeding, the customer goes through the NORMAL review→`processPayment`→`createOrder`/`chargeOnlineOrder`, which re-prices + re-gates server-side and re-applies pickup-only/category in the frontend review. Reorder reimplements NO money logic.

## Phase-2 scope + non-negotiables (unchanged)
- Finish/verify **T7** (the partial La Musa `renderOrdersPane` — wire its Reordenar to T8; ensure it reads own, restaurant-filters via `CONFIG.restaurant_id`, renders escaped `items_text`, never raw `items[]`), build **T8**, **T9** (mirror both account.js identical past CONFIG), **T10** (guest-safety, proofs, push).
- Guest byte-identical; both forms identical past CONFIG; no money-path change; no cheap emoji.
- Push `feat/p3-order-history`, report the frontend SHA. Advisor runs codex-on-diff (heavy on the reorder cart-seed money-adjacency + guest byte-identical + parity) → owner deploys the FORMS (Netlify per-folder) as phase-2 (backend already live).
