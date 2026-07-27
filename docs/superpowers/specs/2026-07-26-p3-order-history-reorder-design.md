# P3 — Order History + Reorder — Design Spec

**Date:** 2026-07-26 · Advisor-designed, owner-approved (combined batch, this-restaurant scope, smart reorder-to-cart). Branch `feat/p3-order-history` (off live `main` `337ffc8`). Spans **functions + RTDB rules + frontend (both forms)**. Owner directive: maximally methodical; both halves seamless. codex design-gate R1 REVISE folded (see end).

## Goal
A logged-in customer sees **"Mis pedidos"** (their past orders on this restaurant) and can **"Reordenar"** — re-price the past order against today's menu and load the available items into the cart. Guest byte-identical; money path (re-price + 86-gate) reused, never reimplemented.

## Verified foundation (from source — R1-corrected; do NOT re-derive)
- **`/user_orders` is ALREADY written today** (server-only, currently `.read`-denied — the stub `user_orders:{"$uid":{".read":false,".write":false}}` was designed to open "until P3"). TWO writers, both OLD shape `user_orders/{customer_uid}/{orderId} = {ts,total,order_type,items_text}`:
  - `xpizza-functions/create-order-build.js` → `attachCustomerAttribution()` (cash/card-delivery, at intake).
  - `xpizza-functions/materialize.js` (~L51-55) → online, at **materialize (payment-confirm)** — field-level paths (can't call attachCustomerAttribution). Shared by confirmOnlinePayment/webhook/sweep/scheduled-release.
  - Both are NO-OP for guests (no `customer_uid`). Both have unit tests.
- **Attribution is server-verified** (`X-Firebase-ID-Token` → `verifyIdToken` + `customer:true` + tombstone; client body uid NEVER trusted). Online pending_payment order carries `customer_uid` but **no `user_orders` entry** (materialize writes it only at confirm) — so unpaid/abandoned online checkouts are already NOT in history.
- **Account deletion** (`xpizza-functions/account-lib.js`) deletes `{user_profiles/{uid}:null, user_orders/{uid}:null}` + tombstone. **Keeping the `user_orders/{uid}/...` path means this stays correct with NO change** (the reason we do NOT re-nest under restaurant).
- **Re-price + 86-gate on every submit:** `computeServerTotal(body.items, restaurantId)` (menu-pricing.js) recomputes total + **rejects unknown item/extra/qty**; `checkItemAvailability(db, body.items, restaurantId)` (availability-gate.js, **fail-OPEN** on RTDB read failure). NOTE: neither enforces UI-only rules — **X. Pizza pickup-only categories + La Musa category applicability are FRONTEND-enforced** at review/submit, not in `validateOrderPayload`.
- **Structured items:** `body.items` (structured cart) is available server-side at order time for BOTH brands; persisted `order.items` is x_pizza factura-only → the index MUST capture `body.items`, never `order.items`/factura lines.
- **Rules canonical:** `xpizza-reference/database.rules.json` (the `xpizza-functions/` copy is gitignored, synced via `npm run sync:rules`). No `numChildren()`; ALWAYS run the RTDB emulator before a rules deploy.
- **Deploy sensitivity:** functions gcloud-managed — COMPLETE env, BOTH driver-native + payment code, zero-prune. Forms via Netlify per-folder.

## Data model — extend the existing entry (NO key restructure)
Keep the existing path `user_orders/{customer_uid}/{orderId}`. Extend each entry with `restaurant`, `status`, and a **normalized `items[]`**:
```
user_orders/{customer_uid}/{orderId} = {
  ts, total, order_type, items_text,     // existing (items_text = sanitized DISPLAY summary)
  restaurant,                            // NEW: 'x_pizza' | 'la_musa' (client filters to its own)
  status,                                // NEW: order status (initial; kept fresh by the trigger)
  items: [ { id, qty, options? } ... ]   // NEW: NORMALIZED reorder recipe — ids/qty/allowlisted option ids ONLY
}
```
- **`items[]` is a normalized allowlist** — the **menu-recognized KEY** per restaurant (`la_musa` → item **id**; `x_pizza` → item **name**, because `computeServerTotal` matches x_pizza by name) + quantity + recognized option/extra keys, derived from `body.items` at write time AND **validated against the current menu (menu-pricing) — any key the menu doesn't recognize is dropped, never stored**. That validation (menu-allowlisted keys only) is what makes it safe: **NO raw/arbitrary client names or prices are stored** (they'd be an XSS/trust vector). Display name + price are always re-resolved from the CURRENT menu by key (at render/reorder). Cap the array length (bounded to the order's real line count). Build a shared per-restaurant normalizer that mirrors `computeServerTotal`'s matching (name-keyed x_pizza / id-keyed la_musa).
- **Display uses `items_text`** (already server-sanitized + capped) — the history row never renders raw `items[]`. Frontend still escapes on render (defense-in-depth).
- **`restaurant`** field lets each form show only its own orders (client-side filter) — no key re-nesting, so account-deletion + the old path stay intact.

## Part 1 — Backend: extend BOTH existing writers (per-brand fields + normalized items[])
Update `create-order-build.js attachCustomerAttribution()` AND `materialize.js` to add `restaurant`, `status`, and the normalized `items[]` to the `user_orders/{uid}/{orderId}` entry they already write. Normalize via a shared pure helper (unit-tested) that mirrors `computeServerTotal`'s per-restaurant matching (menu-allowlisted keys only; drop unrecognized).
- **Cash/card-delivery (create path):** source the recipe from `body.items` (available in `createOrder`).
- **Online (codex R2 build-callout — must plumb):** `materialize.js` receives the pending order RECORD from RTDB and does NOT have `body.items` (the pending record only conditionally carries x_pizza factura `items`, never the normalized recipe for both brands). So: at **`chargeOnlineOrder`** time, compute the normalized recipe from `body.items` and **persist it on the pending order** (e.g. `orders/{id}/reorder_items`); then `materialize.js` **copies `reorder_items` into `user_orders/{uid}/{orderId}.items` only at materialize (confirm)**. Do NOT use `order.items`/factura lines.
- **Update both builders' existing unit tests** to the new shape. Guests still NO-OP. Idempotent. Online writes to history only at materialize (confirm) — never pending.

## Part 2 — Backend: status-sync trigger (UPDATE-ONLY-IF-EXISTS)
`onValueWritten('orders/{orderId}/status')` → read `orders/{orderId}/customer_uid`; if absent (guest) → no-op. If present, **check `user_orders/{customer_uid}/{orderId}` EXISTS; only then update its `status`** (never create). This guarantees a `pending_payment` status write (which has no entry yet — materialize hasn't run) does NOT create a partial history entry for an unpaid checkout (codex R1 HIGH-1). Fail-open (mirror failure never affects the order-status write); no feedback loop (writes a different subtree). Handle the race (entry created by materialize slightly after a status write) by the existence check — the terminal statuses that matter (delivered/cancelled) come well after materialize.

## Part 3 — RTDB rules (xpizza-reference/database.rules.json) + emulator tests
Open the stub to read-own on the EXISTING path:
```
"user_orders": {
  "$uid": {
    ".read": "auth != null && auth.uid === $uid",
    ".write": false,          // Admin SDK (functions) only; clients never write
    ".indexOn": ["ts"]        // history ordered by ts
  }
}
```
A customer reads ONLY their own `user_orders/{uid}` (all their orders; the form filters to its restaurant client-side); cannot read others', cannot write. **Run the RTDB emulator before deploy**, with tests: wrong-uid read DENIED, unauthenticated read DENIED, client write DENIED, own read ALLOWED, and the pending→no-entry trigger case (no entry materializes for an unpaid online order).

## Part 4 — Account deletion / privacy (UNCHANGED — verify)
Because we kept `user_orders/{uid}`, `account-lib.js` `user_orders/{uid}:null` already deletes ALL of a customer's history on account deletion — **no change needed**. Spec requires the executor to VERIFY (a test) that deletion still removes the extended entries (it does — it nulls the whole `user_orders/{uid}` subtree).

## Part 5 — Frontend: "Mis pedidos" pane (both account.js)
The account-sheet "Pronto" row becomes live → a pane (`acct-pane-orders`, existing sheet/pane system) that reads `user_orders/{uid}` (account Firebase SDK, marker-gated), **filters to `entry.restaurant === CONFIG.restaurant_id`**, sorts by `ts` desc, shows the **last ~15**. Each row: date, `items_text` (escaped, truncated), `total`, a **status pill** (Entregado/Cancelado/En camino/Pendiente… mapped), and **"Reordenar"**. Empty state: "Todavía no tenés pedidos." Per-brand palette (near-white X. Pizza / cream La Musa). Reads only. Never render raw `items[]`.

## Part 6 — Frontend: Reorder (re-resolve by id; seed cart; submit-path authoritative)
Tap **"Reordenar"**:
1. **Re-resolve + availability pre-check (UX):** for each normalized `items[].id`, look it up in the CURRENT menu (the form's menu / menu-pricing source) → get today's name + price; check the restaurant's `item_availability` node. Items not on the current menu OR 86'd are **dropped with a clear notice** ("2 productos ya no están disponibles"). This is UX-only (best-effort; availability is fail-open).
2. **Smart cart:** empty cart → add the available items directly; non-empty → prompt **"Agregar a tu pedido"** vs **"Empezar de nuevo"** (clear-then-add). Add via the form's existing cart-add path so qty/options/variant lines land exactly like a manual add.
3. **Authoritative safety = the normal submit path:** the customer proceeds through the normal review → `processPayment` → `createOrder`/`chargeOnlineOrder`, which **re-prices (`computeServerTotal`) and re-checks availability (`checkItemAvailability`) server-side**, and the FRONTEND review re-applies UI rules (X. Pizza pickup-only cats, La Musa category/variant) since reorder flows through the normal cart+review. So reorder **cannot charge a stale price or add an unknown item** (server), and **respects pickup-only/category rules** (frontend review) — it reimplements NO money/rule logic, only seeds the cart. (Caveat, stated honestly: the 86-drop is best-effort — availability read is fail-open; a true 86 during an availability-DB outage could pass, exactly as a normal order would today.)

## Non-negotiables
- **Guest byte-identical** — pane + reads marker-gated (no SDK on guest load); guest order submit untouched; both writers already NO-OP for guests.
- **Attribution not weakened** — reuse the existing server-verified `customer_uid` (client uid never trusted); phone-immutable; the H2 1.5s online deadline unchanged (loses history attribution, never money safety).
- **No client writes** to `/user_orders` or `/orders` (rules `.write:false`; Admin SDK only).
- **No raw client item strings stored or rendered** — normalized `items[]` (ids/qty/option-ids); display via sanitized `items_text`; escape on render.
- **Reorder money/rule-safe** — seeds cart; server re-price + item-existence + frontend UI-rule review are authoritative (reused).
- **account.js identical past CONFIG**; per-brand only via CONFIG (restaurant id + palette). La Musa + X. Pizza both get the feature.
- **Deploy order: functions + rules BEFORE forms.** Functions = complete env, both code paths, zero-prune. Rules = sync from xpizza-reference + emulator first. Forms = Netlify per-folder. Intermediate state (new backend, old forms) is safe (backend just writes richer entries no one reads yet); (new forms, old rules) would only show an empty/denied pane — so backend/rules first.
- **No cheap emoji.**

## Forward-only history (owner note — confirm)
Only orders placed AFTER deploy get the NEW fields (`restaurant`/`items[]`); existing old-shape entries (written since Task 0) lack `items[]` → they're **skipped in the pane** (or shown display-only without a working Reordenar). No backfill (attribution is recent; a backfill is a separate gated migration). **Recommendation: forward-only** — history fills going forward. Old entries without `restaurant` are simply filtered out (no crash).

## Out of scope
Backfill/migration of old-shape entries. Cross-brand unified history. Editing a past order. Reorder that re-creates scheduled-order timing.

## Codex R1 REVISE — folded (all accepted)
- HIGH-1 status trigger → **update-only-if-exists** (no pending/unpaid history).
- HIGH-2 old-schema/two writers → spec now targets BOTH `create-order-build.js` + `materialize.js` (+ their unit tests) explicitly; **extend fields, no key restructure**.
- HIGH-3 deletion PII → **kept `user_orders/{uid}` path so account deletion stays correct unchanged** (verify with a test).
- HIGH-4 business-rule claim → corrected: server enforces price + item-existence; **pickup-only/category are frontend-enforced** via the review path reorder flows through.
- MED items[] source → capture `body.items` (never `order.items`/factura); MED XSS/size → **normalized allowlist ids/qty/option-ids, display via sanitized items_text, escape on render, capped**.
- Rules → read-own on existing path + `.indexOn:["ts"]` + emulator test matrix. Deploy backend-before-forms confirmed. Availability fail-open caveat stated.

## Gate focus (codex design-review R2)
1. Extending BOTH writers to the new shape (fields only, no restructure) — is the write still idempotent, guest-NOOP, online-only-at-materialize, and do the existing builder unit tests get correctly updated? Does the online path have `body.items` available at materialize (or must it be carried on the pending record)?
2. Status trigger update-only-if-exists — airtight against indexing a pending/unpaid order; fail-open; no loop; race handled.
3. Normalized `items[]` (ids/qty/option-ids) faithfully drives reorder (variant/option lines reproduce) AND carries nothing renderable-unsafe; display via items_text is safe.
4. Reorder money/rule-safety restated accurately (server price+existence; frontend pickup-only/category) — no bypass; availability fail-open acknowledged.
5. Rules read-own on `user_orders/{uid}` + client filter by `restaurant` correctly scopes per-brand without leaking; account deletion still catches everything.
6. Guest byte-identical; both forms identical past CONFIG; deploy order + functions-deploy safety.
