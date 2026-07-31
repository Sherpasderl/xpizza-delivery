# Rewards v2 — FINAL money re-gate + emulator adequacy (advisor)

**Reviewed:** `feat/rewards-redemption-v2 @ 540ef94` (guard reorder 46c7c5f + B emulator suite + §3), read-only codex.
**Verdict: APPROVE-WITH-CHANGES** — **production money-path is CORRECT**; the two changes are emulator TEST hardenings
(close two asserted-but-not-fully-proven claims). No production code change required.

## CONFIRMED correct
- **Guard reorder** (`rewards-redeem-intake.js:52`): empty/non-array → `needs_paid_item`; malformed → `bad_cart`;
  server-priced `total ≤ 0` → `needs_paid_item`; THEN `computeRedemption`, then reserve. **No bypass** — paid
  subtotal from `computeServerTotal` (server pricing, never client totals / never reward free lines). Valid
  requests still reach compute + reserve.
- **Concurrency test is real** — two `reserveRedemption` in `Promise.all` on real emulator RTDB transactions;
  exactly one wins against balance 10 / two cost-8 reserves (no shallow serial sim).
- **Fingerprint binding proven** — changed La Musa redeemed set → `reservation_conflict`.
- **Guard cases proven** (empty/tampered). **§3 both account.js DISPLAY-ONLY** — no redeem payload / quote / pricing
  / reserve / cash-tendered / submit-gate leak.

## REQUIRED before deploy — 2 emulator test additions (code unchanged)
1. **`test/rewards-reserve.emulator.test` (~:213) — prove La Musa aggregate RELEASE-while-reserved exactly once.**
   Current test proves consumed→refund credits the aggregate, but a bug in the `reserved→released` branch /
   acquire-failure release / sweep that released only `8` (X. Pizza cost) instead of the full `1619` aggregate
   could still pass (generic release tests only cover cost 8). **Add:** a La Musa aggregate reservation that calls
   `releaseRedemption` (or `reverseRedemptionForRefund(disposition:'refund')`) **while still `reserved`** → assert
   `reserved: 1619 → 0`, state `released`, balance unchanged; then retry → assert **no second release/mutation**.
2. **`test/rewards-earn.emulator.test` (~:143) — prove the WRITTEN order excludes the free pizza from `items`.**
   Current test seeds an order that already excludes the free pizza (proves the earn engine has no `−1`), but not
   that the intake/order-write path keeps the add-free pizza out of `orders/{id}/items`. A builder regression that
   wrote `free_lines` into `order.items` would still pass. **Add:** a builder/cash-create-backed redeemed X. Pizza
   order, assert the **written** order has only paid `items` (free item only in redemption/free-line display
   fields), THEN run `creditEarnForOrder` on that written order.

## Then
Executor adds the 2 test cases (green) → owner eyeballs §2 drafts vs `rewards-v2-mockups/redeem-experience.html`
→ owner merges → deploys **functions-first, then forms** → flips redemption ON only once **both** live.
