# BUILD HOLD → ADVISOR — Phase 1b-1: 2 blockers in the integration shape (found pre-code)

**From:** executor · **Date:** 2026-08-26 · **Branch:** `feat/phase1b1-pricing-cutover` @ `bfc37bb` (worktree `~/Downloads/xpizza-1b1`, off `origin/main` as relayed). **No code written.**
**Line numbers re-anchored against current main and they MATCH the spec exactly:** `computeServerTotal` @ `index.js:325`, `summaryLines` @ `index.js:273`. The re-anchor instruction was right; the problems are structural, not positional.

---

## 🔴 BLOCKER 1 — `getPricingTables(db, restaurantId)` needs TWO different database handles

The relay specifies one `db` parameter and then uses it for both:
- **the catalog read** — `getRestaurantDocs(db, rid)` → `db.collection('restaurants').doc(rid)` (`catalog/catalog-firestore.js:9`) → **FIRESTORE**
- **the alarms** — `paymentAlert(db, kind, detail)` → `db.ref('dispatcher_alerts').push(...)` (`index.js:1452-1456`) → **RTDB** (`getDatabase()` from `firebase-admin/database`, `index.js:57`)

These are different databases with disjoint APIs. One `db` cannot be both, and the failure is quiet in the worst way:

| built as | what happens |
|---|---|
| RTDB handle passed | `db.collection` is not a function → the reader throws → **the resolver's fail-safe catches it every time** → always returns code + always alarms `catalog_read_failed`. The build "works", all tests that inject a fake reader pass, and **the cutover silently never happens.** The prod-prove gate would be 100% red — which is the good news, but only after deploy. |
| Firestore handle passed | `paymentAlert` → `db.ref` is not a function → every alarm write fails (it is try/caught, so alarms vanish silently). |

**Proposed fix:** the resolver takes both explicitly — `getPricingTables({ firestore, rtdb }, restaurantId)` (or two positional args). Names the two stores at the boundary so this cannot be mixed up again. **Needs your ruling — it changes a PINned signature.**

## 🔴 BLOCKER 2 — both target call sites are inside SYNCHRONOUS functions; `await` is impossible there

The relay says: at `:325` and `:273`, "resolve `const tables = await getPricingTables(db, restaurantId)` and pass it." Neither site can `await`, and neither has `db` in scope:

- `index.js:325` is inside **`function validateOrderPayload(body, restaurantId)`** (`:309`) — synchronous. Called at `:480` (createOrder) and `:936` (chargeOnlineOrder) as `const { errors, total, lat, lng, fields } = validateOrderPayload(body, restaurantId)` — destructured synchronously.
- `index.js:273` is inside **`function buildRewardStamp(items, restaurantId, subtotalCents, redemptionCanonical, freeName, freeItems)`** (`:262`) — synchronous. Called at `:710` and `:1006`.

**Why the naive fix is dangerous.** Making `validateOrderPayload` async cascades to both callers; if either misses the `await`, `const { errors, total, ... } = <Promise>` yields `undefined` for every field, and the very next line `if (errors.length > 0)` throws `TypeError: Cannot read properties of undefined` → **500 on every order.** It fails loudly rather than mispricing, but it is a 100% order-intake outage introduced by the money cutover.

**Proposed fix — Option A (recommended): resolve high, pass down; keep the pure functions synchronous.**
Both sites already sit inside async handlers — `createOrderApp.all('*', async (req,res)…)` (`:448`) and `chargeOnlineApp.all('*', async (req,res)…)` (`:912`). So:
```js
const tables = await getPricingTables({ firestore, rtdb: db }, restaurantId);   // in the async handler
const { errors, total, ... } = validateOrderPayload(body, restaurantId, tables); // sync, unchanged shape
const rewardStamp = buildRewardStamp(..., tables);                               // sync, unchanged shape
```
No async cascade, no missed-await failure mode, `db` never enters the pure functions, and the parity guard stays exactly where the spec puts it.

**Option B** — make both functions async and update all four call sites. More invasive, adds the outage mode above, buys nothing. Not recommended.

**Scope note this forces (your call):** PIN C says "EXACTLY TWO call sites change" and the DoD greps that no other caller passes `tables`. Under Option A that is still true of *pricing* calls, but **two function signatures gain an optional param and four call sites thread it through**. The DoD wording needs to say so, or the audit will read a larger diff than the PIN describes. No other pricing consumer moves — redemption and fiscal still pass nothing and keep the code default.

## 🟠 ORDERING — the RTDB handle is created AFTER validation runs
`const db = getDatabase()` is at `:497` (createOrder) and `:954` (chargeOnlineOrder) — **after** `validateOrderPayload` at `:480` / `:936`. Resolving tables before validation needs the handle hoisted above the validate call (or the Firestore handle obtained independently). Trivial, but it is a real edit the relay does not mention.

## 🟠 NEW SURFACE — Firestore is not initialized in `index.js` at all
`index.js` has no `admin.firestore()` / `getFirestore()`. Phase 1a's reader was never wired to a live handle — by design, nothing read the catalog. **1b-1 is where `index.js` first touches Firestore**, which is an unlisted build step and a new cold-start dependency on the money path. Worth a line in the relay so the audit expects it, and worth confirming the 1a database (Native mode, `us-central1`) is the one it binds to.

---

## What the executor needs back
1. **Blocker 1:** confirm `getPricingTables({ firestore, rtdb }, restaurantId)` (or your preferred two-handle shape).
2. **Blocker 2:** confirm **Option A** (resolve in the async handler, pure functions stay sync, one optional param each) — and confirm the DoD/PIN-C wording is adjusted to describe that diff.
3. **Ordering + Firestore init:** confirm both are in scope for this build.

Everything else in the relay is buildable as written: PIN A (strict `tablesEqual`), PIN B (restaurant-tagged + assert-same-rid), PIN D (fail-safe to code + alarm, fails-closed preserved), the test plan, and the money proof. Standing by — no code until these three are ruled.
