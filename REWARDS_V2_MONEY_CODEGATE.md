# Rewards v2 — §1 money model — CODE-GATE result (advisor)

**Reviewed:** `feat/rewards-redemption-v2 @ 4cf8d43` (diff vs `34488951`), read-only codex money code-gate.
**Verdict: REVISE** — the money model is architecturally CORRECT; blockers are stale emulator tests + two
fail-closed hardenings. No money bug in the production logic.

## Codex CONFIRMED correct (do not touch)
Aggregate single reservation/order with `Σ(cost_pts×qty)`; reserve transaction checks `balance − reserved ≥ cost`
(concurrent double-spend prevention correctly designed); La Musa multiset coalesced + sorted, server prices;
`redemptionFingerprint` folded into both cash reserve binding and online `payment_fingerprint`; release/consume/
refund/sweeps operate on aggregate `rec.cost`; X. Pizza add-free, total unchanged, cost 8, **no** earn adjustment
in production; paid-item guard server-side via `computeServerTotal` before reserve. Unit suites pass (rewards-redeem,
-config, -pricing, reward-preview).

## REQUIRED before deploy
**A. Two code hardenings (small, fail-closed):**
1. `rewards-redeem-config.js:isLaMusaEligible` (~:45) — explicitly reject `id.startsWith('sauce_') ||
   id.startsWith('protein_')` **before** the MENU lookup. (Today they're rejected only by absence from MENU;
   the binding spec requires explicit prefix exclusion → make it fail-closed, not incidental.)
2. `rewards-redeem.js:computeXPizza` (~:50) & `computeLaMusa` (~:67) — validate `redeem.type ===
   REDEMPTION_CONFIG[restaurantId].reward`. A malformed `type` with a valid `item_id`/`items` is currently
   accepted (not an undercharge, but not fail-closed). Reject on mismatch.

**B. Emulator money-proof suite (the executor already has this as in-progress) — rewrite v1→v2 + add §1e cases:**
- `test/rewards-reserve.emulator.test` + `rewards-redeem-intake.emulator.test`: stale v1 (`configVersion:1`,
  `model:'discount'`, `discount_cheapest_pizza`, discounted totals, singular `free_line`) → rewrite around
  `free_pizza_choice` + `points_ala_carte` incl. La Musa N-item aggregate costs.
- `test/rewards-earn.emulator.test` (~:140): still asserts the old X. Pizza `−1` adjustment → assert a v2 redeemed
  X. Pizza order earns exactly the paid `order.items` qty (free pizza absent from `order.items`).
- **Emulator-only claims that MUST be proven before deploy** (unit tests can't): RTDB transaction atomicity under
  concurrent La Musa reserves; `balance ≥ reserved` across reserve + earn clawback; idempotent reserve/retry/conflict;
  aggregate consume/release/refund/sweeps for N items; online reserve + acquire-failure release; payment-fingerprint
  mismatch when the redeemed set changes; paid-item guard rejecting empty/invalid paid carts before reserve.

## Then
Executor applies A + B → advisor re-runs a light money code-gate on the A-fixes + confirms the emulator suite is
green → continue §2 UI → UI eyeball vs mockup + code-gate → owner deploys **functions-first, then forms.**
