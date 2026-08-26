# HANDBACK — Phase 1b-1: order-total reads the guarded catalog

**Branch:** `feat/phase1b1-pricing-cutover` @ **`82378b9`** · worktree `~/Downloads/xpizza-1b1` · base `origin/main @ bfc37bb` · **LOCAL-ONLY, nothing pushed, nothing deployed.** 4 commits.

## Verification
| Suite | Result |
|---|---|
| `npm test` (full, incl. 2 new pure suites) | **exit 0**, 1205 assertions |
| `test:pricing-cutover` — **PIN E**, real Firestore reader | **6/6** |
| `test:catalog-parity` (1a money proof, still green) | **12/12** |
| `test:catalog-rules` (1a rules, still green) | **12/12** |

## PINs
- **A — strict `tablesEqual`.** Identical key sets for `menu` AND `extras`, exact integer equality per key. Differing price / missing key / extra key each → not equal; `'299' !== 299` (no coercion); a malformed side is not equal rather than a throw. 6 assertions.
- **B — restaurant-tagged + assert-same-rid.** Cross-brand tables **throw** in both `computeServerTotal` and `summaryLines`; **untagged** tables also throw (a tag is mandatory, not optional). 4 assertions.
- **C — scope.** Only `index.js:515` and `:973` resolve catalog tables. Grep confirms `rewards-redeem-intake.js`, `rewards-redeem-pricing.js`, `rewards-redeem.js`, `rewards-redeem-config.js` and `pricedLineItems` resolve **none** and pass **no** tables → code default, no split-brain.
- **D — fail-safe + fails-closed.** Any read failure, mismatch, malformed shape, or even a throwing alarm sink → code tables + alarm; the resolver never throws out. A key absent from the supplied tables still fails closed (`unknown menu item`), never prices at zero.
- **E — emulator uses the REAL Firestore reader.** See below.

## The money proof
18 carts across both brands (plain, multi-qty, with extras, multi-line, qty 50, plus the tamper/edge shapes) — `computeServerTotal` **and** `summaryLines` byte-identical from catalog vs code, redemption-shaped summaries included. End-to-end through the real Firestore read as well (PIN E cases 3–4).

## ⚠️ Finding: the money proof as specified was VACUOUS — fixed
The relay's money proof compares catalog-sourced output to code-sourced output. **That passes trivially if `tables` is ignored** — I confirmed it passed *before* the refactor existed, because the extra argument was simply dropped. Same tautology shape as the Phase 1a parity test.

Added non-vacuity assertions that fail against an ignore-tables implementation: a table-only price of `12345` must yield `24690` at qty 2; extras likewise; `summaryLines` cents likewise; and a key present in code but absent from the tables must still fail closed. **Recommend this pattern become standing practice for 1b-1b and 1b-2** — every "A == B" money proof needs a companion assertion proving the new source is actually consulted.

## PIN E — mutation-proven against BLOCKER-1
On parity, catalog and code values are equal, so value comparison cannot distinguish them. The test asserts object **identity** (the returned table must not be the in-code singleton) plus a silent alarm sink. Rewiring the reader to an RTDB-shaped handle (`.ref`, no `.collection`) fails with *"returned menu must be the FIRESTORE-read object, not the in-code singleton"*. **PIN E catches the exact blocker it was written for.**

## Additive guardrail
`git diff origin/main..HEAD` is **empty** for: the whole redemption cluster (`rewards-redeem-pricing.js`, `rewards-redeem.js`, `rewards-redeem-intake.js`, `rewards-redeem-config.js`), the fiscal path (`factura/`, `pricedLineItems`), both order forms, and `firestore.rules`. `itemPricingKey` is unchanged (it appears in the diff only inside a comment). Existing pricing suites — `menu-pricing`, `menu-parity`, `order-money`, `rewards-redeem-pricing`, `rewards-parity.guard` — all pass untouched.

## Structural fixes as ruled
- **Two-handle DI:** reader → Firestore (`getRestaurantDocs(firestore, rid)`), alarm → RTDB (`paymentAlert(getDatabase(), …)`). Neither passed as a raw `db`.
- **Resolve high, thread sync:** tables resolve once per handler; `validateOrderPayload` and `buildRewardStamp` stay **synchronous** with one optional trailing param. No async cascade, no missed-await 500s, `db` never enters a pure function.
- **Handles hoisted** above validation in both handlers; the now-duplicate `const db = getDatabase()` declarations removed.
- **`getFirestore` added** — `index.js`'s first Firestore touch. Lazy, module-level, so the 1a reader's 5-min cache survives across requests on a warm instance (no per-order round-trip).

## ⚠️ Deploy-gate gap for the owner runbook
`test:pricing-cutover` is bound into `firestore.predeploy` alongside the 1a suites — but **the 1b-1 deploy is scoped to FUNCTIONS, and `firestore.predeploy` does not run on a functions deploy.** So the money proof will NOT run automatically at this deploy. It must be a **named manual step**: `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:pricing-cutover` before deploying. I did not add a `functions.predeploy` — that would change deploy ergonomics for every function in the project, which is your call, not mine.

## Deploy scope (grep-confirmed)
Exactly **`exports.createOrder`** (`index.js:902`) and **`exports.chargeOnlineOrder`** (`:1464`). No other exported function calls `validateOrderPayload`, `buildRewardStamp`, `computeServerTotal` or `summaryLines` on the changed path.

## Prod-prove gate (unchanged)
After deploy: a real window with **zero `catalog_parity_mismatch` and zero `catalog_read_failed`** in `dispatcher_alerts` before 1b-1b or 1b-2 is specced. Note both alarm kinds land as `payment_catalog_*` via `paymentAlert`, and mismatch alarms carry a bounded diff (counts + up to 5 differing keys per side) so a divergence names itself.
