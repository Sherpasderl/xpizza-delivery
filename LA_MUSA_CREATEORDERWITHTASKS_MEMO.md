# Memo — `createOrderWithTasks` and the "no la_musa order while dark" guarantee

_Executor → Auditor. Decision/grounding artifact (no code change). Establishes that the dispatcher
client's `createOrderWithTasks` does not undermine the safety guarantee that **no La Musa order can
exist while `la_musa.active = false`**, and records its restaurant-awareness as a hard pre-launch
gate. Verification-only — every claim below is grounded in the real files._

---

## Why this memo exists
The "no la_musa order while dark" guarantee (Proposal A safety section) rests on the server
**active-gate**: `createOrder` / `chargeOnlineOrder` resolve `getIdentity(la_musa)` and reject
before any persist. But there is **one other writer** of `orders/*` — the SDK function
`createOrderWithTasks` — which writes RTDB directly and **bypasses the active-gate**. This memo
verifies it cannot produce a La Musa order in practice, so the guarantee holds.

## Claim 1 — Zero production call sites (creation is server-only for both restaurants)
`createOrderWithTasks` is an **SDK function**, defined in 5 copies of `xpizza-delivery.js` — the
**4 deployed app bundles** (`xpizza-dispatch`, `xpizza-driver`, `xpizza-dashboard`, `xpizza-kitchen`)
**+ the `xpizza-reference` dev directory**. The **only call site in the entire repo** is
`xpizza-reference/test-harness.html:371` — a **test harness that lives in the non-deployed reference
dir**, which only strengthens "no production caller".

Exhaustiveness — the SDK's **only order-creation path is `createOrderWithTasks`**: the only other
`orders/*` write in the SDK is `update(ref(db, 'orders/${orderId}'), { status })`
(`xpizza-delivery.js:300`), a **status update on an existing order**, not creation. Production order
creation for **both** restaurants flows exclusively through the **server HTTP endpoints**
(`createOrder` / `chargeOnlineOrder`), which are active-gated (Phase 1).

## Claim 2 — Incapable of emitting a La Musa order
`createOrderWithTasks` (`xpizza-delivery.js:857`):
- The pickup task hardcodes the **x_pizza hub** — `destination_lat/lng/address`,
  `recipient_name/phone` all read from the module-level `RESTAURANT` const (`:39`, X. Pizza coords).
  So even a tampered call routes pickup to X. Pizza's kitchen, not La Musa's.
- It **stamps no `restaurant_id`** of its own — it spreads `...order`, so it only carries a
  `restaurant_id` if a *caller* supplies one. The sole caller (the test harness) supplies none, and
  **there is no La Musa dispatcher/manual-order UI** that would.

→ In practice it cannot emit a (correctly-routed) La Musa order: no la_musa caller exists, and the
hub is x_pizza-hardcoded regardless.

## Claim 3 — The dispatcher RTDB-write rule is pre-existing X. Pizza parity (not widened for la_musa)
`orders/$order_id .write` = `auth != null && root.child('dispatchers').child(auth.uid).exists()`
(`database.rules.json:52`); `tasks/$task_id .write` is the same dispatcher-or-assigned-driver check
(`:37`). This is the **pre-existing** trust model: an authenticated **dispatcher** (trusted staff,
in `/dispatchers`) may write orders/tasks. It is **restaurant-agnostic** and was **not introduced or
widened for la_musa**. Tightening it *only* for la_musa would violate the prime directive ("behave
exactly like X. Pizza"), so it is **left as the shared trust assumption** — the same one X. Pizza
already operates under.

## Claim 4 — Conclusion on record
**"No la_musa order while dark" holds.** The only **wired** order-creation paths
(`createOrder` / `chargeOnlineOrder`) reject la_musa at the server active-gate before any persist.
`createOrderWithTasks` bypasses that gate but has **no production caller** and is **x_pizza-hardcoded**,
so it cannot create a La Musa order. **No code change** is made here; **X. Pizza bundles and RTDB
rules are untouched** (byte-for-byte).

## Deferred — HARD pre-launch gate (before `la_musa.active = true`)
When La Musa gets a dispatcher / manual-order path that *can* create orders, `createOrderWithTasks`
**must be made restaurant-aware** — stamp + validate `restaurant_id`, select the hub per restaurant
(not the hardcoded `RESTAURANT` const), and honor the active-gate. This is recorded as a **hard gate
that must land before the `active:true` flip**, alongside the other launch gates
(`PIXELPAY_RETURN_URL_LA_MUSA`, the dual-key allowlist, the Netlify site, `PREVIEW_MODE=false`).
