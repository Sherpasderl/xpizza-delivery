# Plan 5: Cart price-change notice (Amazon style), the owner-approved build target, every restaurant

**Status:** PLAN r2. r2 folds in Codex scoped r2 (1 P1, 1 P2); r1 answered Codex FULL r1 (3 P1, 2 P2). It answers Codex FULL r1 (3 P1, 2 P2), per the advisor's rulings of 2026-10-26 under the owner's simplicity rule: **narrow the scope to the common case, and keep TODAY's block for every rare one.**
- **Build target:** the owner-approved mockup v2, recorded in DECISIONS.md 2026-10-26. It is the exact build target.
- **Delivery:** money-adjacent, so plan → Codex → build. Brand-agnostic: the rule lives in the shared, byte-identical `form-cart.js`, and each form only renders. No dependency on plan 4.

## Scope (r1, narrowed)

**The common case, which is handled:** the cart has one or more blocked lines, and EVERY blocked line is a dish whose price changed, nothing else. No other conflict on any line, no option conflict anywhere, no availability problem, no pending choice, and no payment resume in progress. There:
- there's no checkout block and no extra button;
- a calm notice gives one line per dish: `Cambió el precio de {name}: antes L {from}, ahora L {to}.` These are **unit** prices;
- each changed line shows its old **unit** price struck through: stacked above the new price in the cart sheet, inline in the summary;
- line subtotals, the summary, the total and the pill are the form's existing rendering at the new price (qty × new unit + options, exactly as today);
- the customer removes the dish with the existing remove control, or continues; continuing is the acceptance.

**Everything else keeps TODAY's block, byte-identical message and behaviour, and nothing is adopted:**
- a dish that's removed, renamed or unavailable, including a dish that is repriced AND unavailable;
- ANY option conflict, including an option that's only repriced (P2-4);
- a launcher/choice line;
- an uncaptured option;
- an empty cart;
- **any payment stash/resume in progress** (P1-3);
- **any attached reward.**

## Eligibility: computed cart-wide BEFORE any mutation (P1-1)

The forms call a new pure predicate, `priceNoticeEligibility()`. It reads; it never writes.
- **Lines:** it takes the forms' EFFECTIVE lines, `cartLines()`. That's `CART.resolve` plus `GroupPicker.markLauncherLines`, so `choice` is included (form-group-picker.js:116).
- **Eligible ⇔ all of these hold:**
  - (i) at least one blocked line exists;
  - (ii) every blocked line has `unresolved === 'repriced'`;
  - (iii) no line, blocked or not, has any option with an `unresolved` value: `extras.some(x => x.unresolved)` is false everywhere;
  - (iv) **an independent availability check** passes for every blocked line: `isSoldOut(live)` is false. That's the form's own predicate, the same one the tiles use, run regardless of the classifier, because `classify()` returns `repriced` before it checks availability (form-cart.js:163);
  - (v) no blocked line is a launcher (`GroupPicker.isLauncher`);
  - (vi) no resume and no reward: `window.__resumeOrderId` is unset, `serialPinLive()` is false, and NO reward is attached. `window.__ACCOUNT && __ACCOUNT.getRedeemPayload && __ACCOUNT.getRedeemPayload()` is falsy.
    - An applied or restored redeem already holds a reservation for its order (account.js:558).
    - Under the simplicity ruling, ANY attached reward keeps today's block, so no reservation is ever re-priced under.
- **Output:** `{ eligible: true, changes: [{ key, name, from: line.added.price, to: live.price }] }`, or `{ eligible: false }`. Ineligible means nothing happens and today's code path runs unchanged.

## The notice is part of the renderer; the adopt boundary is the FINAL render (P1-2, r2)

**The notice and the struck price are RECONSTRUCTED from `CART.disclosed()` inside every render** of the cart sheet (`updateCartReviewBody`) and of the checkout summary (`renderStage2Summary`). They're a persistent part of those renderers, not a one-off insert. So a later re-render, a quantity change on another line, or a quote refresh redraws them, and nothing can erase a disclosure while its entry exists. Codex r2 P1: step 5 of r1 replaced `#cart-review-body`'s innerHTML and erased the inserted notice.
- **Copy:** `textContent` only. Tokens `--cream`, `--border2`, `--charcoal`, radius 10, padding 12/14, 14 px, `role="status"`.
- **Placement:** the cart sheet gets it at the top of `#cart-review-body`; the checkout gets it immediately above `#s2-summary`, inside its margins.
- **Struck price:** the old UNIT price, stacked in the sheet and inline in the summary.

**Adoption happens ONLY at two explicit, visible moments.** Never in `liveMenuPaint`, `liveMenuCommit`, `chg`/`chgFromCart`, `restoreOrderForm`, a hidden or background summary refresh, `refuseConflictedSend`, `buildOrder` or `submitOrder`. The two moments:
- **(A)** the cart sheet, AFTER `#cart-review-sheet` has `.open`. Codex r2 P2: today `openCartReview` renders before it adds `.open`, so disclosure is wired after the class is set, in `openCartReview` and in `chgFromCart` while the sheet is open;
- **(B)** the checkout summary, while the `s2` stage is active AND `#s2-summary` is visible (`getClientRects().length > 0`).

At those moments, `discloseAndAdopt(target)` runs as ONE synchronous block (no `await`, so no send can interleave):
1. `e = priceNoticeEligibility()`. If not eligible, return. Today's path is untouched.
2. Snapshot each changing line's captured record, plus the current `disclosed` map.
3. Tentatively adopt each change with `CART.accept(key, live)` (form-cart.js:224, today unwired) and record `disclosed[key] = { name, from, to }`. If any `accept` returns false or throws, go to rollback.
4. **The FINAL render:** run the target's renderer, which draws lines, totals, the notice and the struck prices from the cart and `disclosed`.
5. **Confirm the final render:** the target exists and the renderer threw nothing. The rendered notice `isConnected`, its text contains every change's name and both amounts, and each changed line shows its struck old price.
6. **Rollback, on any failure in 3–5:** restore every line's snapshot via `accept(key, snapshot)`, restore the `disclosed` map, and render again. The lines are repriced and blocked once more, the notice is gone, and today's block stays at both send endpoints.
- **Invariant:** every adoption that survives is accompanied by a confirmed final render showing its notice. Its `from` is the price captured immediately before the adoption.
- **Return-to-original:** if the price later returns, that's a NEW change (`from` = the adopted price, `to` = the original), with the same boundary, so the invariant has no exception.

## The `disclosed` map: lifecycle (P2-4)

- **Keys:** DISH keys only, the same pricing key as `lines` (no option keys).
- **Values:** `{ name, from, to }`, unit prices. Several instances or a higher quantity of one dish share one entry. A quantity change never alters the entry; the subtotal re-renders as today.
- **Cleared:**
  - a dish's entry, when its line is removed (`setQty`/`setQtyByKey` to 0, or the remove control);
  - the whole map, on cart clear/reset, on order completion (s5) and on the form's existing reset paths.
- **Overwritten** by a later adoption of the same key.
- **Persistence:** `snapshot()` carries it. `hydrate()` keeps an entry only if its key is a captured line AND `entry.to === line.added.price` (validated against the captured record). Anything else is dropped silently; it can never block.

## Money and identity

- **Server unchanged.** Production prices only from the published catalog. After adoption, client captured price == live == server price, exactly as for a dish added after the live menu applied.
- **Oracle (P2-5):** for each case below, an adopted cart is compared with the SAME cart freshly added at the new prices, through the REAL functions: `computeServerTotal` / `computeServerNet` with the catalog-shaped tables, the quote cart fingerprint, `orderFingerprint`, `chargeInputsFingerprint`, `items` and `items_text`. They must be byte-identical, for cash and card, on both brands. Carts with a reward are ineligible by (vi), and a test proves they keep today's block. The displayed total is compared with the server net.
- **No resume path is touched:** (vi) keeps every stash/resume on today's block, so no order id, pin or reservation is ever carried across an adoption.

## Tests

- **Predicate (unit and both forms):** eligible for one or more repriced dishes. Ineligible (and a byte-identical message from the real refusal paths) for each of these, including SIMULTANEOUS conflicts on the same line:
  - repriced + unavailable dish;
  - repriced dish + repriced option;
  - option-only reprice;
  - repriced + launcher;
  - repriced + removed elsewhere in the cart;
  - an uncaptured option;
  - a pending resume (`__resumeOrderId`, a live pin);
  - any attached reward.
- **Persistent notice (r2):**
  - after adoption, a later re-render of the sheet and of the summary, a quantity change on another line, and a quote refresh all still show the notice and the struck prices;
  - removing the dish clears its entry, and its notice line disappears on the next render.
- **Opening (r2):** opening a repriced cart with no other edit (pill → sheet) discloses, because disclosure runs after `.open`. The same cart with the sheet never opened and checkout never rendered adopts nothing.
- **Atomic boundary, with failure injection:**
  - a missing target, the renderer throwing, the notice failing the confirm check, and `accept` throwing halfway (rollback);
  - in each case nothing is adopted, the notice is absent, and BOTH send endpoints (`createOrder` cash via `submitOrder`, `chargeOnlineOrder` card) refuse exactly as today;
  - adoption never happens on a hidden summary refresh, during `liveMenuPaint`/`chg`, or after a failed live apply (its restore runs with no cart mutation, as today).
- **Map lifecycle (both brands):**
  - multiple instances (X. Pizza per-instance options) and a quantity change keep one unit-price entry, with the subtotal at the new price;
  - remove/clear/reset/s5 clear entries;
  - hydrate keeps valid entries and drops stale ones;
  - a return-to-original renders its own notice.
- **Rendering (both forms):** the exact copy, the struck unit price (stacked in the sheet, inline in the summary), and the notice inside the summary margins. A real-Chrome 390 px side-by-side against mockup v2, with every difference classified.
- **Existing restore tests (P2-5):** NO intentional expectation changes.
  - cart-identity-order.test.mjs :611 and :700 are payment-resume restores. Under (vi) they keep today's block, and `buildOrder` is never an adoption point, so "a repriced line must BLOCK the send" still holds verbatim.
  - The direct undisclosed-send refusal stays covered: a repriced line driven straight to `submitOrder` / the charge with no render moment is refused.
- **Money suites re-run and green, untouched:** cart-identity(-order), cart-serial-order, g2-order-exists-recovery, charge-boundary, cart-extras-money, d4b, whole-flow, reorder-whole-page, the redemption form tests.
- **Mutation entries:** each eligibility clause (i)–(vi), render-before-adopt, the confirm check, the rollback, the hidden-refresh exclusion, and map clearing on removal.
- **Pins:** form-cart drift test, form-source-inventory, the 2e pins client-form edits re-open (timer-bounds, applicability), the R3 regen, and a full `npm test` in the heavy slot.

## Out of scope
Option price notices (they keep today's block); resumed or paid orders; server changes; the counter (plan 3); the menu source (plan 4).
