# Portal Single-Source 1C — Charge == Confirmed Net Quote — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee the amount charged (cash collected / card charged) is the server's own live recompute and is only ever **≤ the net total the customer confirmed on screen** — never silently more — via a signed quote token verified at both money endpoints.

**Architecture:** One shared `computeServerNet` produces the all-in net (items + extras − reward + delivery + fiscal). A stateless HMAC-signed quote token binding {rid, customer, cart_fingerprint, net, expiry, quote_id} is issued on the existing quote responses and echoed at charge. `createOrder` and `chargeOnlineOrder` verify it and apply the humane hybrid (equal→charge; lower→charge the lower; higher→409 re-confirm). The client keeps a fresh token via silent background refresh; a quote outage degrades to an unsigned `expected_net_cents` raw comparison (never fail-closed). Rollout is grace(accept-but-log)→enforce via a `token_enforce` config flag.

**Tech Stack:** Node 22 Cloud Functions (firebase-functions v2 `onRequest`), RTDB, plain-JS browser forms (UMD-lite shared modules with byte-identical copies + drift tests), `node --test` + bespoke node test scripts, the mutation-sweep harness.

## Global Constraints

- **Base:** origin/main `179c441` (1A+1B live). Build in an isolated worktree off `179c441`.
- **Money invariant (verbatim):** the charge is the server's own recompute, and it is **only ever ≤ what the customer confirmed**; never silently more.
- **HARD RULE (owner):** customer experience is priority — seamless + frictionless. The ONLY visible friction allowed is the re-confirm on a genuine price **increase**. Issuance, expiry, silent refresh, quote outage, and price **drops** must be invisible.
- **Server is authoritative:** the charge is always `computeServerNet` of the submitted cart; the token/`expected_net` is only a tripwire, never trusted as the charge amount.
- **ONE net function:** the quote-issuer, `createOrder`, and `chargeOnlineOrder` MUST compute the net through the single `computeServerNet` (Task 1). No second net path.
- **Shared browser modules stay byte-identical** across `xpizza-orders/` and `la-musa-orders/`, guarded by a drift test in the `npm test` chain (the 1B pattern). New client logic goes in one canonical module + a byte-identical copy.
- **Money-adjacent governance:** every task → advisor source-audit + codex money-gate (verification framing, read-only, `-C <worktree>`), never self-approve; Task 1 (net consolidation) and Tasks 4/5 (both live money endpoints) get the hardest gates + the whole-flow gate at Task 9. Owner deploys.
- **Rollout order:** server first (grace mode) → both Netlify forms → flip `token_enforce` (config, both-flag, smoke fresh order/brand, [[redemption-flip-two-flags]]).
- **Units:** `computeServerTotal(items, rid, tables)` currently returns `{total, error}`; confirm its unit against the real code and make `computeServerNet` return `net_total_cents` in **integer cents** (reconcile with the reward path's `total_cents`). All token/gate math is in integer cents.
- **No secret in the client:** the HMAC signing secret is server-only, env-managed (the `PIXELPAY_WEBHOOK_SECRET` pattern). The client treats the token as opaque.

---

## File Structure

- **Create `xpizza-functions/compute-server-net.js`** — the single net function. `computeServerNet({items, reward, deliveryContext, rid, tables}) → {net_total_cents, components}`. Pure; wraps `computeServerTotal` (base) + the reward discount + delivery (0 today) + fiscal.
- **Create `xpizza-functions/quote-token.js`** — the signed-token lib: `cartFingerprint(normItems, reward)`, `signQuoteToken(payload, secret)`, `verifyQuoteToken(token, secret, nowMs) → {ok, reason, payload}`. Pure crypto (node `crypto` HMAC-SHA256).
- **Modify `xpizza-functions/index.js`** — `quoteOrder` (issue token in the response); `createOrder` + `chargeOnlineOrder` (verify + hybrid + grace/enforce + record `quote_id`/net); the reward-quote endpoint (issue token over the reward net). Route all three through `computeServerNet`.
- **Modify `xpizza-functions/rewards-redeem-*.js`** — the reward net flows through `computeServerNet`'s reward component (no divergent reward math).
- **Create `xpizza-orders/form-confirm-quote.js`** (+ byte-identical `la-musa-orders/form-confirm-quote.js`) — client token store, silent-refresh scheduler, the confirm state machine (`Ready`/`Stale`), the send-attach hook, and the degraded `expected_net` fallback. UMD-lite, drift-tested.
- **Modify `xpizza-orders/index.html` + `la-musa-orders/index.html`** — wire `form-confirm-quote` into the quote fetch (`requestServerQuote`/`requoteRedeem`), the two charge sends, and the re-confirm UI (silent drop / increase sheet).
- **Config:** `config/rewards_public/token_enforce` (bool) in RTDB — the enforce flag (grace when false).
- **Tests:** `compute-server-net.test.js`, `quote-token.test.js`, `quote-order.test.js` (token issuance, extend existing), `charge-boundary.test.mjs` (extend — token gate from the real serializer), `whole-flow.test.mjs` (cell 12 + reward-skew flip to asserted-closed), `xpizza-orders/form-confirm-quote.test.mjs` + `form-confirm-quote.copy.test.mjs` (drift), and the mutation-sweep `b9`/`token` slice. Runbook `docs/superpowers/runbooks/2026-09-15-portal-1c-confirmed-quote-smoke.md`.

---

### Task 1: `computeServerNet` — the single net function

**Files:**
- Create: `xpizza-functions/compute-server-net.js`
- Create: `xpizza-functions/compute-server-net.test.js`
- Reference (do not diverge from): `xpizza-functions/menu-pricing.js:157` (`computeServerTotal`), `xpizza-functions/rewards-redeem-pricing.js` (reward net `total_cents`).

**Interfaces:**
- Produces: `computeServerNet({ items, reward=null, deliveryContext=null, rid, tables=null }) → { net_total_cents, components: { items_cents, extras_cents, reward_discount_cents, delivery_cents, fiscal_cents } }` and `{ error }` on an unpriceable cart (never a partial/zero). `reward` is the redemption payload (or null); `deliveryContext` carries what delivery pricing needs (null/none today → `delivery_cents: 0`).

- [ ] **Step 1: Write the failing test** — net equals base for a no-reward cart; reward reduces net; unpriceable item errors; delivery is 0 today; the result is the same the reward path already produces.

```js
const assert = require('node:assert');
const { computeServerNet } = require('./compute-server-net');
const { computeServerTotal } = require('./menu-pricing');

// no reward, no delivery: net == base recompute
const base = computeServerTotal([{ id: 2, qty: 1 }], 'x_pizza');   // Carnívora
const net = computeServerNet({ items: [{ id: 2, qty: 1 }], rid: 'x_pizza' });
assert.strictEqual(net.error, undefined);
assert.strictEqual(net.components.delivery_cents, 0, 'delivery is free today');
assert.strictEqual(net.net_total_cents, net.components.items_cents + net.components.extras_cents
  - net.components.reward_discount_cents + net.components.delivery_cents + net.components.fiscal_cents,
  'net foots to its components');
// components.items_cents+extras must reconcile with computeServerTotal (unit-normalized to cents)
// (assert exact equality once the unit of computeServerTotal.total is confirmed)

// unpriceable item is an error, never a free/zero line
assert.ok(computeServerNet({ items: [{ id: 'does-not-exist', qty: 1 }], rid: 'x_pizza' }).error);
```

- [ ] **Step 2: Run to verify it fails** — `cd xpizza-functions && node compute-server-net.test.js` → FAIL (module missing).
- [ ] **Step 3: Implement** — `computeServerNet` calls `computeServerTotal` for the base, applies the reward discount by delegating to the existing reward pricing (do NOT re-derive reward math — call/route the same code `rewards-redeem-pricing.js` uses so there is ONE reward computation), sets `delivery_cents` from `deliveryContext` (0 when none), returns cents integers + the footed `net_total_cents`. Confirm/normalize `computeServerTotal`'s unit to cents.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git add xpizza-functions/compute-server-net.js xpizza-functions/compute-server-net.test.js && git commit -m "feat(1c): computeServerNet — the single net function (items+extras-reward+delivery+fiscal)"`

**Gate focus (HARDEST):** this is the money-consolidation. The gate must confirm the net for real carts is byte-identical to what `createOrder`/`chargeOnlineOrder`/the reward path produce **today** (no charged-value change), reward math is not duplicated, and an unpriceable cart errors (never zeroes).

---

### Task 2: `quote-token.js` — sign / verify / fingerprint

**Files:**
- Create: `xpizza-functions/quote-token.js`
- Create: `xpizza-functions/quote-token.test.js`

**Interfaces:**
- Produces:
  - `cartFingerprint(normItems, reward) → string` — stable hash of the server-normalized cart + reward selection (order-independent by construction; same shape the reward `cart_fingerprint`/`orderFingerprint` uses).
  - `signQuoteToken(payload, secret) → string` — `payload = { rid, customer_id, cart_fingerprint, net_total_cents, components, issued_at, expires_at, quote_id }`; returns `base64url(json).base64url(HMAC-SHA256(json, secret))`.
  - `verifyQuoteToken(token, secret, nowMs) → { ok, reason, payload }` — `reason ∈ {ok, bad_format, bad_signature, expired}`.

- [ ] **Step 1: Write the failing test** — round-trip valid; tamper rejected; expiry respected; fingerprint stable + order-independent.

```js
const assert = require('node:assert');
const { signQuoteToken, verifyQuoteToken, cartFingerprint } = require('./quote-token');
const SEC = 'test-secret';
const p = { rid:'x_pizza', customer_id:'c1', cart_fingerprint:'fp', net_total_cents:34000,
  components:{}, issued_at:1000, expires_at:901000, quote_id:'q1' };

const t = signQuoteToken(p, SEC);
assert.deepStrictEqual(verifyQuoteToken(t, SEC, 5000), { ok:true, reason:'ok', payload:p });
assert.strictEqual(verifyQuoteToken(t, SEC, 902000).reason, 'expired');
assert.strictEqual(verifyQuoteToken(t, 'wrong-secret', 5000).reason, 'bad_signature');
assert.strictEqual(verifyQuoteToken(t.slice(0,-3)+'zzz', SEC, 5000).reason, 'bad_signature');
assert.strictEqual(verifyQuoteToken('garbage', SEC, 5000).reason, 'bad_format');
// fingerprint: order-independent, sensitive to items/reward
assert.strictEqual(cartFingerprint([{id:1,qty:2},{id:2,qty:1}], null),
                   cartFingerprint([{id:2,qty:1},{id:1,qty:2}], null));
assert.notStrictEqual(cartFingerprint([{id:1,qty:2}], null), cartFingerprint([{id:1,qty:3}], null));
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — node `crypto.createHmac('sha256', secret)`; constant-time compare (`crypto.timingSafeEqual`); `cartFingerprint` canonicalizes (sort by id, include qty + per-item extras + reward id) and hashes.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(1c): signed quote-token lib (HMAC sign/verify + cart fingerprint)"`

**Gate focus:** signature is HMAC-SHA256, compare is constant-time, expiry is enforced, fingerprint is order-independent and sensitive to items+qty+extras+reward.

---

### Task 3: Issue the token on the quote responses

**Files:**
- Modify: `xpizza-functions/index.js` — `quoteOrder` (index.js:5830) and the reward-quote endpoint; attach a signed token computed from `computeServerNet`.
- Modify: `xpizza-functions/rewards-redeem-*.js` if the reward-quote endpoint lives there.
- Test: extend `xpizza-functions/quote-order.test.js`.

**Interfaces:**
- Consumes: `computeServerNet` (T1), `signQuoteToken`/`cartFingerprint` (T2).
- Produces: quote responses gain `quote_token` (string) + echo `net_total_cents`; the reward-quote response likewise carries a token over the **reward net**.

- [ ] **Step 1: Write the failing test** — `quoteOrder` returns a `quote_token` that `verifyQuoteToken` accepts and whose `payload.net_total_cents === computeServerNet(...).net_total_cents` and `payload.cart_fingerprint === cartFingerprint(...)` for the requested cart/rid; a redemption quote's token carries the reward-reduced net.

```js
// drive quoteOrder's handler with a real cart; assert the token verifies and binds the net+fingerprint
const res = await callQuoteOrder({ items:[{id:2,qty:1}], rid:'x_pizza', customer_id:'c1' });
const v = verifyQuoteToken(res.quote_token, SECRET, Date.now());
assert.ok(v.ok);
assert.strictEqual(v.payload.net_total_cents, computeServerNet({items:[{id:2,qty:1}], rid:'x_pizza'}).net_total_cents);
assert.strictEqual(v.payload.cart_fingerprint, cartFingerprint([{id:2,qty:1}], null));
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — both quote paths compute `computeServerNet`, build the payload (`issued_at=now`, `expires_at=now+EXPIRY_MS` where `EXPIRY_MS` is generous, e.g. 15 min — a named constant), sign with the env secret, include `quote_token` + `net_total_cents` in the response. Guest → `customer_id:null`.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(1c): issue signed quote token on quoteOrder + reward-quote responses"`

**Gate focus:** the token binds the SAME net `computeServerNet` produces (no divergent issuance math); reward quotes bind the reward-reduced net; expiry is generous (invisible per the hard rule).

---

### Task 4: Verify + hybrid at `createOrder` (cash)

**Files:**
- Modify: `xpizza-functions/index.js` — `createOrder` (index.js:1046), at/after `computeServerTotal` (index.js:460), route through `computeServerNet` + verify token + hybrid + grace/enforce + record `quote_id`/net.
- Create: `xpizza-functions/token-gate.js` — `gateConfirmedNet({ tokenOrExpected, submittedCart, reward, deliveryContext, rid, secret, enforce, nowMs }) → { action, chargeNet, reason }` where `action ∈ {charge, refuse_increase, refuse_no_token}` and `chargeNet` is the server net to charge (== or the LOWER of server/confirmed). Shared by Tasks 4, 5, 6.
- Test: `xpizza-functions/token-gate.test.js` + extend createOrder tests.

**Interfaces:**
- Consumes: `computeServerNet` (T1), `verifyQuoteToken` (T2).
- Produces: `gateConfirmedNet(...)` (the shared decision), used by createOrder now and chargeOnlineOrder (T5) + degraded (T6).

- [ ] **Step 1: Write the failing test** — for a valid token: server net == confirmed → `charge` at server net; server net < confirmed → `charge` at the lower server net; server net > confirmed → `refuse_increase` (return the new net); `cart_fingerprint` mismatch → refuse; expired token (enforce) → refuse.

```js
const g = require('./token-gate');
const mk = (confirmedNet, cart) => signQuoteToken({ rid:'x_pizza', customer_id:'c1',
  cart_fingerprint: cartFingerprint(cart,null), net_total_cents: confirmedNet, components:{},
  issued_at: 0, expires_at: 9e12, quote_id:'q' }, SEC);

// equal → charge server net
let r = g.gateConfirmedNet({ tokenOrExpected:{token:mk(34000,[{id:2,qty:1}])},
  submittedCart:[{id:2,qty:1}], rid:'x_pizza', secret:SEC, enforce:true, nowMs:1 });
assert.deepStrictEqual([r.action, r.chargeNet], ['charge', 34000]);   // server recompute == 34000

// confirmed HIGHER than server (price dropped) → charge the LOWER (server)
r = g.gateConfirmedNet({ tokenOrExpected:{token:mk(40000,[{id:2,qty:1}])}, submittedCart:[{id:2,qty:1}],
  rid:'x_pizza', secret:SEC, enforce:true, nowMs:1 });
assert.deepStrictEqual([r.action, r.chargeNet], ['charge', 34000]);   // silent-honor the drop

// confirmed LOWER than server (price rose) → refuse_increase
r = g.gateConfirmedNet({ tokenOrExpected:{token:mk(30000,[{id:2,qty:1}])}, submittedCart:[{id:2,qty:1}],
  rid:'x_pizza', secret:SEC, enforce:true, nowMs:1 });
assert.strictEqual(r.action, 'refuse_increase');
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — `token-gate.js` verifies the token, recomputes `computeServerNet` for the SUBMITTED cart, compares: `server == confirmed` or `server < confirmed` → `charge` at `server` (the ≤-confirmed rule); `server > confirmed` → `refuse_increase`; fingerprint mismatch/bad-sig/expired → refuse. Wire into `createOrder`: on `charge`, proceed recording `chargeNet` + `quote_id`; on `refuse_increase`, return `409 {error:'price_increased', net_total_cents:<server>}`; respect the idempotent-return (already-gated orders skip re-gate).
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(1c): token-gate + confirmed-net verification at createOrder (cash), humane hybrid"`

**Gate focus (HARD, live money endpoint):** the charge is always the server net and only ever ≤ confirmed; the idempotent-return path does not re-charge/bypass; `refuse_increase` returns the new net; provenance (`quote_id`) recorded.

---

### Task 5: Verify + hybrid at `chargeOnlineOrder` (card)

**Files:**
- Modify: `xpizza-functions/index.js` — `chargeOnlineOrder` (index.js:1634), gate at **hosted-checkout creation** (where the amount is set), before `createHostedCharge`.
- Test: extend the pixelpay-hosted / charge tests.

**Interfaces:**
- Consumes: `gateConfirmedNet` (T4), `computeServerNet` (T1).

- [ ] **Step 1: Write the failing test** — a valid token with server net == confirmed creates the hosted checkout at the server net; server net > confirmed → `409 price_increased`, NO hosted checkout created; a resumed/reused hosted attempt reuses the already-gated amount (not re-gated against a moved price).

```js
// higher server net → refuse before hosted-checkout creation
let out = await callChargeOnline({ ...order, quote_token: mk(30000,cart) /* confirmed below server */ });
assert.strictEqual(out.status, 409);
assert.strictEqual(out.body.error, 'price_increased');
assert.strictEqual(createdHostedChargeCount, 0, 'no checkout created on refuse');
// equal → hosted checkout at server net
out = await callChargeOnline({ ...order, quote_token: mk(34000,cart) });
assert.strictEqual(out.body.checkout_url != null, true);
assert.strictEqual(lastHostedAmountCents, 34000);
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — call `gateConfirmedNet` before `createHostedCharge`; on `charge` create the hosted checkout for `chargeNet` (record `quote_id`); on `refuse_increase` return `409` with the new net and create no checkout; resume/reuse path uses the already-persisted (gated) amount.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(1c): confirmed-net gate at chargeOnlineOrder (card), gated at hosted-checkout creation"`

**Gate focus (HARDEST, live card path):** no hosted checkout is created on a price increase; the charged amount is the server net ≤ confirmed; resume reuses the gated amount; no double-charge across retry.

---

### Task 6: Degraded mode (unsigned `expected_net`) + grace/enforce flag

**Files:**
- Modify: `xpizza-functions/token-gate.js` — accept `tokenOrExpected = {expected_net_cents}` (unsigned) → raw comparison + hybrid; the accept matrix by `enforce`.
- Modify: `xpizza-functions/index.js` — read `config/rewards_public/token_enforce`; pass `enforce` to both gates; accept-but-log on grace.
- Test: `token-gate.test.js` (degraded rows) + a config-flag test.

**Interfaces:**
- Consumes: `computeServerNet` (T1). Extends `gateConfirmedNet` accept matrix.

- [ ] **Step 1: Write the failing test** — unsigned `expected_net` does the raw compare + hybrid (money-safe: a fake-low expected → `refuse_increase`, never undercharge); accept matrix: signed→full gate; unsigned→raw gate (logged degraded); neither + enforce→`refuse_no_token`; neither + grace→`charge` server net (logged, pre-1C).

```js
// unsigned expected too LOW vs server → cannot undercharge → refuse_increase
let r = g.gateConfirmedNet({ tokenOrExpected:{expected_net_cents:100}, submittedCart:[{id:2,qty:1}],
  rid:'x_pizza', secret:SEC, enforce:true, nowMs:1 });
assert.strictEqual(r.action, 'refuse_increase');
// neither, grace → charge server net (pre-1C), logged
r = g.gateConfirmedNet({ tokenOrExpected:{}, submittedCart:[{id:2,qty:1}], rid:'x_pizza',
  secret:SEC, enforce:false, nowMs:1 });
assert.deepStrictEqual([r.action, r.chargeNet], ['charge', 34000]);
// neither, enforce → refuse
r = g.gateConfirmedNet({ tokenOrExpected:{}, submittedCart:[{id:2,qty:1}], rid:'x_pizza',
  secret:SEC, enforce:true, nowMs:1 });
assert.strictEqual(r.action, 'refuse_no_token');
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — the accept matrix in `gateConfirmedNet`; `index.js` reads the `token_enforce` flag (fail-safe: default grace/false on read error, like `redeemReadLiveFlag`) and logs degraded/no-token confirmations with a typed reason.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(1c): degraded unsigned-expected floor + token_enforce grace/enforce matrix"`

**Gate focus (money):** unsigned expected cannot force an undercharge; the matrix is exactly signed→full / unsigned→raw / neither→(grace:charge · enforce:refuse); the flag read fails safe to grace.

---

### Task 7: Client — `form-confirm-quote.js` (token store + silent refresh + send-attach)

**Files:**
- Create: `xpizza-orders/form-confirm-quote.js` + byte-identical `la-musa-orders/form-confirm-quote.js`
- Modify: `xpizza-orders/index.html` + `la-musa-orders/index.html` — store `quote_token` from the quote responses (`requestServerQuote` result + `requoteRedeem`); attach the token at the two charge sends (where `refuseConflictedSend` sits); silent background refresh.
- Test: `xpizza-orders/form-confirm-quote.test.mjs` + `form-confirm-quote.copy.test.mjs` (drift, in `npm test`).

**Interfaces:**
- Produces: `createConfirmQuote({ requote, now })` → `{ store(quoteResponse), current(cartSig), attach(bodyForSend, cartSig), scheduleRefresh(), state() }`; `attach` sets `body.quote_token` when a fresh token matches `cartSig`, else marks needs-refresh.

- [ ] **Step 1: Write the failing test** — storing a quote keeps its token keyed by cart signature; `attach` puts the token on the send body only when it matches the current cart; a near-expiry token triggers a silent refresh so a fresh token is present before pay; a cart change invalidates the stored token (needs-refresh).

```js
import assert from 'node:assert';
import { createConfirmQuote } from '../xpizza-orders/form-confirm-quote.js';
let requotes = 0; const cq = createConfirmQuote({ requote: async ()=>{ requotes++; return { quote_token:'t2', cart_sig:'B', net_total_cents:1 }; }, now:()=>1000 });
cq.store({ quote_token:'t1', cart_sig:'A', net_total_cents:1 });
const body = {}; cq.attach(body, 'A'); assert.strictEqual(body.quote_token, 't1');
const body2 = {}; cq.attach(body2, 'B'); assert.strictEqual(body2.quote_token, undefined, 'stale for cart B → not attached');
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — the module stores `{token, cart_sig, net}`; `attach` compares to the current `cart_sig` (reuse the `serverQuoteCartKey`/`redeemQuoteMatches` machinery pattern); `scheduleRefresh` re-quotes before `expires_at` and on checkout-entry; wire into the forms' quote fetch + the two send points. Both copies byte-identical.
- [ ] **Step 4: Run to verify it passes** (+ drift test green).
- [ ] **Step 5: Commit** — `git commit -m "feat(1c): client confirm-quote module — token store, silent refresh, send-attach (both forms)"`

**Gate focus (HARD RULE):** silent refresh makes expiry invisible (fresh token always in hand at pay-tap); a stale-for-current-cart token is never attached; byte-identical parity.

---

### Task 8: Client — confirm state machine + hybrid UX + degraded fallback

**Files:**
- Modify: `xpizza-orders/index.html` + `la-musa-orders/index.html` — the pay-tap state machine (`Ready`/`Stale`), the re-confirm sheet on `409 price_increased`, silent price-drop, and the degraded unsigned `expected_net` on a quote outage.
- Extend: `form-confirm-quote.js` if shared logic is needed (keep byte-identical).
- Test: `xpizza-orders/form-confirm-quote.test.mjs` (state transitions) + form load-execution.

**Interfaces:**
- Consumes: `createConfirmQuote` (T7), the charge sends (both forms).

- [ ] **Step 1: Write the failing test** — pay-tap with a fresh token → send with token (Ready); pay-tap while stale → re-quote then send if unchanged/lower (auto), re-confirm sheet if higher; a `409 price_increased` response → shows the sheet with the new net, a second tap resends with the fresh token; a quote-outage → sends `expected_net_cents` (unsigned) and never blocks.

```js
// 409 price_increased → re-confirm sheet with the new net, then resend proceeds
w.__respond = (url) => /createOrder/.test(url) ? res({ok:false,status:409,json:()=>({error:'price_increased',net_total_cents:38000})}) : passthru(url);
await w.submitOrder('cash');
assert.ok(w.document.getElementById('price-change-sheet'));       // shown, not silent
assert.match(w.document.getElementById('price-change-sheet').textContent, /380/);
// a price DROP is silent (no sheet), order proceeds at the lower
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — the state machine + the increase sheet ("El precio cambió: L X → L Y. Confirmar") wired to a fresh re-quote; silent auto-proceed on unchanged/lower; the degraded `expected_net` path on quote failure (send the displayed net unsigned, never block). Copy uses `safeText` for any authored strings (1B renderer). Both forms.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(1c): confirm state machine + price-increase re-confirm sheet + degraded fallback (both forms)"`

**Gate focus (HARD RULE):** the ONLY visible friction is the increase sheet; drops silent; expiry invisible; a quote outage never blocks a sale (degraded send).

---

### Task 9: Whole-flow + charge-boundary + rollout tests + smoke runbook

**Files:**
- Modify: `whole-flow.test.mjs` — flip cell 12 (checkout-hold) and the reward-skew cell from documented-residual to **asserted-closed**; add createOrder/chargeOnlineOrder confirmed-net cells (equal/drop/increase) both brands.
- Modify: `charge-boundary.test.mjs` — a manipulated client total/price/delivery/reward with a valid token still charges the server net ≤ confirmed; from the real serializer.
- Create: `docs/superpowers/runbooks/2026-09-15-portal-1c-confirmed-quote-smoke.md` — grace→enforce steps + the money check + rollback.
- Test: the mutation-sweep `b9`/`token` slice; ensure the anchor guard covers new mutants.

**Interfaces:** Consumes all prior.

- [ ] **Step 1: Write the failing tests** — whole-flow cell 12: quote at v1 (340) → catalog moves to v2 (380) held → submit → `refuse_increase` (was: documented-open); reward-skew cell: stale reward token → server reward-net differs → refuse; both brands; charge-boundary: tamper + valid token → server net.
- [ ] **Step 2: Run to verify they fail** (cells currently record, not assert).
- [ ] **Step 3: Implement** — assertions + the runbook (grace deploy → forms → monitor no-token/degraded/409 rates → flip `token_enforce` → smoke fresh order/brand → rollback = flip off).
- [ ] **Step 4: Run the full suite green** (offline) + confirm the mutation sweep covers the token/gate mutants; note the emulator endpoint test must be run green pre-deploy.
- [ ] **Step 5: Commit** — `git commit -m "test(1c): whole-flow cell-12 + reward-skew asserted CLOSED, charge-boundary token, grace→enforce runbook"`

**Gate focus (WHOLE-FLOW, closing):** cell 12 + the reward-skew are now provably closed (not deferred); no charged-value regression; grace→enforce is safe + reversible; the seamless hard-rule holds end-to-end (no new visible step in the normal path). Per [[per-task-gates-miss-cross-boundary-state]] the closing gate runs the whole flow, not per-task.

---

## Self-Review

**Spec coverage:** §1 net incl. delivery slot → T1. §2 signed token → T2/T3. §3 one `computeServerNet` → T1 (+ used by T3/T4/T5). §4 two gate points → T4/T5. §5 hybrid → T4 (shared gate) applied in T4/T5/T8. §6 invisible expiry/silent-refresh → T3 (expiry) + T7 (refresh) + T8 (state machine). §7 degrade-never-fail-closed → T6 + T8. §8 grace→enforce → T6 (flag) + T9 (runbook). §9 tests → each task + T9. All covered.

**Placeholder scan:** representative test code + real function references throughout; the one deliberately-open item is `computeServerTotal`'s unit (flagged in Global Constraints for the executor to confirm against real code — not a placeholder, a verification instruction) and `EXPIRY_MS`'s exact value (a named constant, ~15 min, tunable). No TBDs.

**Type consistency:** `computeServerNet(...) → {net_total_cents, components}` used identically in T1/T3/T4/T5/T6; `gateConfirmedNet(...) → {action, chargeNet, reason}` defined T4, reused T5/T6; `verifyQuoteToken → {ok,reason,payload}` T2 used T3/T4; `createConfirmQuote → {store,attach,...}` T7 used T8. Consistent.

**Note for the executor:** cite real line numbers against the live code as you build (this plan names functions, not fabricated line anchors, deliberately — verify each integration point in the actual `179c441` source; do not trust remembered anchors).
