# Plan 5: Cart price-change notice (Amazon style), the owner-approved build target, every restaurant

**Status:** PLAN r0. Money-adjacent: plan → Codex FULL → build.
- **Build target:** the owner-approved mockup v2, recorded in DECISIONS.md 2026-10-26. It is the EXACT build target: https://claude.ai/artifact/6TC6bjSMXnLELC9qVuHdwp (version 2).
- **Brand-agnostic:** the rule lives in the shared, byte-identical `form-cart.js`. Each form only renders.
- **No dependency on plan 4 either way.** Plan 4 changes what the forms boot from; this changes how the cart treats a line whose captured price disagrees with the menu.

## Behaviour (as approved)

1. **Repriced-only carts.** When EVERY blocked line's only conflict is a new price (the dish, its options, or both), there's NO checkout block and NO extra button. The cart ADOPTS the new prices and DISCLOSES them:
   - A calm notice above the cart, one line per changed item: `Cambió el precio de {name}: antes L {from}, ahora L {to}.`
     - It uses the form's existing tokens: `--cream` background, `--border2` border, `--charcoal` text, radius 10, padding 12/14, 14 px.
     - `role="status"`, no emoji.
     - It appears in the cart sheet (top of `#cart-review-body`) and at checkout (directly above `#s2-summary`, inside the summary's own side margins).
   - Each changed line shows its old price struck through (`--muted`, 0.82 em). In the cart sheet it is stacked above the new price, because one row overflowed at 390 px in the mockup. In the summary it is inline.
   - The summary, total and cart pill are the form's own rendering at the new price.
2. **Removing or continuing.**
   - The customer removes a dish with the EXISTING remove control (the qty minus/trash). Removing the line removes its notice entry.
   - Or the customer continues: continuing to checkout is the acceptance.
3. **Mixed cases keep today's blocking messages, unchanged:** a removed or renamed dish, «Agotado», a choice to make again, an uncaptured option.
   - Repriced lines in a mixed cart are NOT adopted while anything else blocks.
   - The rule re-evaluates whenever the cart changes. Once the customer removes the blocking dish, the remaining repriced-only lines are adopted and disclosed.
4. **No silent adoption** (form-cart.js:15-21 says lines are "never resolved silently… not by quietly adopting the new price"). The rule becomes: a price is adopted only together with its disclosure, and never at the send. The header comment is updated to say exactly that.

## Design

### `form-cart.js` (shared; the drift test keeps both copies byte-identical)
- **New `discloseRepriced(findRecord, findExtra, isUnavailable)`:**
  - It resolves the cart. If there are blocked lines and every one of them is `unresolved === 'repriced'` or an option `repriced`, with no other dish or option problem, it adopts each through the existing `accept(key, live)` / `acceptExtra(key, live)` (:224/:232, today unwired: "Task 6 wires the control").
  - It records each change in a `disclosed` map: `{ key → { name, from, to } }`.
    - `from` is the price the customer FIRST saw, kept across successive changes.
    - `to` is the current price.
    - An entry whose price returns to `from` is dropped.
  - It returns `{ adopted: [...], disclosed: [...] }`. It's pure over its arguments and idempotent: a second call adopts nothing.
- **`disclosed()` getter.** `setQty(…, 0)` / `setQtyByKey(…, 0)` drop the line's entry.
- **Persistence:** `snapshot()` / `hydrate()` carry `disclosed`, so a page restore keeps the notice. Plain JSON, validated on hydrate: a malformed entry is dropped and never blocks.
- **Unchanged:** `resolve()` / `classify()` stay as they are. The send gate still refuses any line that is still repriced. That's the invariant: a line reaches an order only at a price the customer has had displayed.

### Forms (both; the same call sites in each)
`discloseRepriced` runs ONLY at these moments, and each one renders the notice in the same step:
- **(a) After a live apply commits:** `liveMenuCommit`, la-musa :2847, xpizza :2464.
- **(b) After a restore resolves:** `restoreOrderForm`, :5118 / :4720.
- **(c) After any cart quantity change:** `chg` / `chgFromCart`. This is how a mixed cart re-evaluates after a removal.
- **(d) When the cart sheet opens and when checkout renders:** `openCartReview` / `updateCartReviewBody`, and `renderStage2Summary` (la-musa :3846 / xpizza :3410).

It is NEVER called from `refuseConflictedSend`, `buildOrder` or `submitOrder`. A live apply never commits while checkout is open (`liveMenuBusy`, :2669 / :2286), so prices cannot change between the checkout render and the send.
- **Rendering:** `updateCartReviewBody` and `renderStage2Summary` add the notice and the struck price from `CART.disclosed()`, through `textContent` only (no HTML injection), exactly as drawn in the mockup.
- **When the notice clears:**
  - the order completes (s5) or the cart empties, through the existing reset paths;
  - all entries are removed;
  - every price returns to its `from`.

## Money and identity

- **Server unchanged.** The server already prices every order from the published catalog (index.js:512 → catalog/pricing-tables.js). This slice changes only what the client shows and which captured price a line carries.
- **After adoption, client == live == server price.** That's exactly today's state for a line added after the live menu applied.
- **Order payloads:** the order serializes from the line's live record. `items`, `items_text`, the quote cart fingerprint, `chargeInputsFingerprint` and the pending-order pin behave exactly as for a line added at the new price.
- **Stash:** a stash written before adoption and resumed after it is a genuine cart change. It follows today's replacement-order rule (form-serial-order.js), and the tests below prove that.

## Tests

- **form-cart unit tests (shared):**
  - repriced-only → adopted and disclosed;
  - an option repriced → disclosed with the option's name;
  - mixed (repriced + removed / unavailable / choice / uncaptured option) → nothing adopted, today's classification intact;
  - removal of the blocking line → re-evaluated and adopted;
  - successive reprices keep the first `from`; a price returning to `from` drops the entry;
  - idempotent second call;
  - snapshot/hydrate round-trip, with malformed `disclosed` dropped;
  - qty 0 drops the entry;
  - `accept` is never called without a disclosure entry. Invariant test: every adopted key appears in `disclosed()`.
- **Both forms, jsdom, the REAL paths** (live apply through `window.__liveMenu.applier.apply`, the real cart and checkout renderers):
  - **Unblocked case:** a repriced dish gives no block, the exact notice copy in the cart and at checkout, the struck old price, and total and pill at the new price. The send proceeds and the payload price equals live.
  - **Two dishes:** two notice lines.
  - **Mixed carts:** today's blocking message, byte-identical. After removing the gone dish → disclosure and send proceeds.
  - **Restore:** a reload keeps the notice.
  - **Live updates:** a second apply updates `to`. An apply back to the original price removes the entry.
  - **Timing:** an apply deferred while checkout is open does not change prices until idle.
  - **No adoption at the send:** a test drives a repriced line straight to `submitOrder` / the charge with no prior render moment, and asserts the refusal.
- **Money suites re-run unchanged and green:** cart-identity(-order), cart-serial-order, g2-order-exists-recovery, charge-boundary, cart-extras-money, d4b, whole-flow, reorder-whole-page, and the redemption form tests.
- **Visual check:** each form in real Chrome at 390 px, compared side by side with mockup v2. Every difference is classified ([[ui-handback-side-by-side-screenshots]]).
- **Mutation entries:** the repriced-only predicate, the "not at send" rule, `from` retention, entry removal on qty 0, and each form's call sites.
- **Pins:** form-source-inventory, the 2e pins client-form edits re-open (timer-bounds, applicability), the form-cart drift test, the R3 regen, and a full `npm test` in the heavy slot.

## Out of scope
Server changes; the counter (plan 3); the menu source (plan 4).
