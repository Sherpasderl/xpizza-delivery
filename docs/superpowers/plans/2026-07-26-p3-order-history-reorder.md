# P3 — Order History + Reorder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** "Mis pedidos" history + "Reordenar" for logged-in customers. Spec: `docs/superpowers/specs/2026-07-26-p3-order-history-reorder-design.md` (codex design-gate APPROVED R2). Functions + RTDB rules + both `account.js` forms. **Money path reused, never reimplemented.** Forward-only (no backfill).

**Branch:** `feat/p3-order-history` (off live `main` `337ffc8`). Repo: `xpizza-delivery`.

## GROUND RULES (every task — the owner asked for extreme care)
- **Reorder seeds the cart ONLY.** NEVER recompute price or re-implement availability client-side for the money decision — the normal submit (`createOrder`/`chargeOnlineOrder`) re-prices (`computeServerTotal`) + re-gates (`checkItemAvailability`) server-side, and the frontend review re-applies UI rules (X. Pizza pickup-only cats, La Musa category/variant). Reorder must not create any new submit path or trust.
- **`user_orders` writes are Admin-SDK (functions) only.** Clients NEVER write it. Keep the EXISTING path `user_orders/{uid}/{orderId}` — do NOT re-nest under restaurant (keeps account-deletion correct).
- **No raw client item strings stored or rendered.** `items[]` = normalized menu-allowlisted keys (name for x_pizza / id for la_musa) + qty + recognized option keys. Display uses the already-sanitized `items_text`; escape on render.
- **Guest byte-identical** — writers already NO-OP for guests; the pane/reads are marker-gated (no SDK on guest load).
- **Both forms:** `la-musa-orders/account.js` + `xpizza-orders/account.js` identical past the ~20-line CONFIG block; per-brand only via CONFIG (`restaurant_id`, palette). Config key is **`CONFIG.restaurant_id`**.
- **Deploy sensitivity:** functions gcloud-managed (complete env, BOTH driver+payment code, zero-prune). Rules via `sync:rules` from `xpizza-reference` + **RTDB emulator FIRST**. Forms via Netlify per-folder. **Deploy order: functions + rules BEFORE forms.**
- Commit per task; TDD where tests exist (both builders + account-lib have unit tests).

---

## Task 1: Shared normalizer — `normalizeReorderItems(bodyItems, restaurantId)`
**Files:** new `xpizza-functions/reorder-normalize.js` + `xpizza-functions/reorder-normalize.test.js`.
- [ ] **Step 1 (test-first):** write tests: x_pizza input (name-keyed items + name-based extras) → `[{key:<menu name>, qty, options?}]` keeping ONLY keys the x_pizza menu recognizes; la_musa input (id-keyed) → `[{key:<id>, qty, options?}]` keeping only menu-recognized ids; unknown item/extra → DROPPED; qty preserved; array capped to real line count; empty/guest → `[]`.
- [ ] **Step 2:** implement the pure normalizer mirroring `computeServerTotal`'s per-restaurant matching (import the menu tables from `menu-pricing`). It VALIDATES every key against the current menu (allowlist) and stores only recognized keys + qty + recognized option keys — no client names/prices.
- [ ] **Step 3:** run tests green. **Commit** — `feat(p3): normalizeReorderItems — menu-allowlisted per-restaurant reorder recipe`

## Task 2: Cash/card-delivery history write — extend `attachCustomerAttribution`
**Files:** `xpizza-functions/create-order-build.js` + its unit test.
- [ ] **Step 1 (test-first):** extend the existing `attachCustomerAttribution` test to assert the entry now includes `restaurant` (from restaurantId), `status` (the order's initial status), and `items` = `normalizeReorderItems(body.items, restaurantId)`; still NO-OP for guest (no customer_uid); `items_text`/`total`/`ts`/`order_type` unchanged.
- [ ] **Step 2:** implement — pass `restaurantId` + `body.items` (+ initial status) into `attachCustomerAttribution` (adjust its signature/`meta`), add the three fields to the `user_orders/{customer_uid}/{orderId}` object. Keep the whole-object-key atomicity note intact.
- [ ] **Step 3:** update `createOrder` call sites (~L577 held / ~L604) to pass the new args. Tests green. **Commit** — `feat(p3): cash order history entry gains restaurant/status/items[]`

## Task 3: Online history write — plumb `reorder_items` onto the pending order + materialize copy
**Files:** `xpizza-functions/index.js` (chargeOnlineOrder pending write) + `xpizza-functions/materialize.js` + its test.
- [ ] **Step 1 (codex R2 callout):** in `chargeOnlineOrder`, when building the PENDING order record, compute `normalizeReorderItems(body.items, restaurantId)` and persist it as `orders/{id}/reorder_items` (only when `customer_uid` present). This is the ONLY place with `body.items` for the online path.
- [ ] **Step 2 (test-first):** extend `materialize.js` test: on materialize (online, `customer_uid` present) the `user_orders/{uid}/{orderId}` entry gains `restaurant` (order's restaurant_id), `status` (materialized status), `items` = the order's `reorder_items`; guest/no-uid NO-OP; still writes only at materialize (never pending).
- [ ] **Step 3:** implement in `materialize.js` — read `order.reorder_items` + `order.restaurant_id` and add `restaurant`/`status`/`items` to the field-level `user_orders/...` write. Do NOT use `order.items`/factura lines. Tests green. **Commit** — `feat(p3): online order history — reorder_items on pending, copied at materialize`

## Task 4: Status-sync DB trigger (update-only-if-exists)
**Files:** `xpizza-functions/index.js` (new trigger) + a unit/emulator test.
- [ ] **Step 1 (test-first):** test the trigger logic: status write on an order WITH a matching `user_orders/{uid}/{orderId}` entry → entry `status` updated; status write on a `pending_payment` order with NO entry → NO-OP (no entry created); guest order (no `customer_uid`) → NO-OP; a mirror-write failure does not throw into the order path.
- [ ] **Step 2:** implement `onValueWritten('orders/{orderId}/status')`: read `orders/{orderId}/customer_uid`; if absent → return. **Read `user_orders/{customer_uid}/{orderId}`; only if it EXISTS, update its `status`** (never create). Fail-open (try/catch, log). No write to `orders/*` (no loop).
- [ ] **Step 3:** ensure the export is added WITHOUT pruning existing functions (the deploy must include all fns). Tests green. **Commit** — `feat(p3): status-sync trigger mirrors order status into existing history entry (no pending indexing)`

## Task 5: RTDB rules — user_orders read-own (canonical + emulator)
**Files:** `xpizza-reference/database.rules.json` + emulator tests.
- [ ] **Step 1:** replace the `user_orders` stub with:
```
"user_orders": { "$uid": { ".read": "auth != null && auth.uid === $uid", ".write": false, ".indexOn": ["ts"] } }
```
- [ ] **Step 2:** RTDB EMULATOR test matrix (mandatory — no numChildren; only the emulator catches rule bugs): own read ALLOWED; wrong-uid read DENIED; unauthenticated read DENIED; any client write DENIED; `.indexOn ts` orderBy works. Confirm the rules file still compiles/deploys in the emulator.
- [ ] **Step 3:** `npm run sync:rules` parity (reference → functions copy) is the deploy step (owner runs at deploy). **Commit** — `feat(p3): rules — user_orders/{uid} read-own + indexOn ts (emulator-verified)`

## Task 6: Account-deletion — verify unchanged coverage
**Files:** `xpizza-functions/account-lib.js` test (no code change expected).
- [ ] **Step 1:** add/extend a test proving `accountDeleteUpdates(uid,...)` still nulls the WHOLE `user_orders/{uid}` subtree (so the extended entries — restaurant/status/items — are all removed on deletion). No code change (the path is unchanged); this is the PII-safety proof (codex HIGH-3). **Commit** — `test(p3): account deletion still purges all user_orders/{uid} history`

## Task 7: Frontend — "Mis pedidos" pane (both account.js)
**Files:** `la-musa-orders/account.js` (source of truth) — pane markup in the overlay template + render fn.
- [ ] **Step 1:** add `acct-pane-orders` to the overlay template; make the "Mis pedidos" account-row open it (replace the "Pronto" tag/disabled state).
- [ ] **Step 2:** `renderOrdersPane()` — read `user_orders/{uid}` (account Firebase SDK, marker-gated), FILTER `entry.restaurant === CONFIG.restaurant_id` (skip entries missing `restaurant` — old/forward-only), sort by `ts` desc, take last ~15. Row = date + `escapeHtml(items_text)` (truncated) + `total` + status pill (map status→Entregado/Cancelado/En camino/Pendiente…) + a **Reordenar** button. Empty state "Todavía no tenés pedidos." Per-brand palette; **never render raw `items[]`**.
- [ ] **Step 3:** styles via the injected account styles (reuse the palette tokens). Reads only. **Commit** — `feat(p3): Mis pedidos history pane (read-own, restaurant-filtered, sanitized display)`

## Task 8: Frontend — Reorder (re-resolve by key; seed cart; smart)
**Files:** `la-musa-orders/account.js` + reads the form's menu + cart-add path (`chg()`/cart model) + `item_availability`.
- [ ] **Step 1:** `reorderFromEntry(entry)` — for each `entry.items[].key`, resolve against the CURRENT menu (the form's menu / menu-pricing source) → today's name/price; check `item_availability`. Drop keys not on the menu OR 86'd; collect a dropped-count for the notice.
- [ ] **Step 2:** smart cart — if cart empty → add available items via the existing cart-add path (qty/options/variant lines exactly like a manual add). If cart non-empty → show the prompt ("Agregar a mi pedido" / "Empezar de nuevo" = clear-then-add). Show the "N productos ya no están disponibles" notice when any dropped.
- [ ] **Step 3:** after seeding, the customer continues through the NORMAL review→submit (no new path). Verify variant/option lines (La Musa required-protein, X. Pizza cats) reproduce and the normal review re-applies pickup-only/category rules. **Commit** — `feat(p3): Reordenar — re-resolve by menu key, availability drop+notice, smart cart seed`

## Task 9: Mirror to X. Pizza + guest-safety + self-review
- [ ] **Step 1:** port Tasks 7–8 into `xpizza-orders/account.js`; Node-compare → identical past CONFIG.
- [ ] **Step 2:** guest-safety (both forms, agent-browser): no account Firebase SDK on guest load; the "Mis pedidos" pane never opens for a guest; guest order submit untouched.
- [ ] **Step 3:** proofs — (a) reorder creates NO new submit path (seeds cart only); (b) no raw client item string rendered (display = escaped items_text; items[] never rendered); (c) `user_orders` never client-written; (d) both forms parity; (e) functions: the new trigger export doesn't prune others (list exports before/after). **Commit** — `feat(p3): X.Pizza parity + guest-safety proofs`

## Task 10: Push + report for codex-on-diff
- [ ] **Step 1:** run the full functions test suite (`npm test` in xpizza-functions) — all green (normalizer, both builders, materialize, trigger, account-lib). `node --check` both account.js.
- [ ] **Step 2:** push `feat/p3-order-history`; report the tip SHA + a per-task commit list + the emulator-test result + the test-suite result. No deploy/merge.

---

## Self-Review (author, pre-handoff)
- **Spec coverage:** normalizer (T1), cash write (T2), online plumb+materialize (T3), status trigger (T4), rules+emulator (T5), deletion proof (T6), history pane (T7), reorder (T8), mirror+guest (T9), tests+push (T10). All R1/R2 findings + both codex build-callouts.
- **Watch:** T3 is the subtle one (online has no `body.items` at materialize → must plumb `reorder_items` onto the pending record). T4 MUST be update-only-if-exists (never index a pending/unpaid order). T1 x_pizza is NAME-keyed. Reorder (T8) must not create a new submit path — seeds cart only; server + review are authoritative.
- **Placeholder scan:** none.
