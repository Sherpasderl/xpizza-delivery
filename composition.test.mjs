// Portal 1C Task 9 — THE COMPOSITION HARNESS. Run: node composition.test.mjs
//
// 🔴 WHY THIS EXISTS. The closing gate demonstrated a defect that every other suite in this repo
// missed: rename `body.expected_net_cents` at the two charge handlers and the ENTIRE test suite stays
// green — client tests pass (the client still emits the field), gate tests pass (the gate still
// consumes the field it is handed) — while a real expired-token order silently overcharges again.
//
// Nothing tested the SEAM. Each side was verified against its own idea of the contract, and the
// contract itself — these exact field names, in this exact shape, travelling from the browser to the
// gate — was the one thing no test held. Two of this initiative's defects have now lived there:
//   · iat/exp vs issued_at/expires_at — my own fixtures signed tokens that never verified, so cells
//     asserting "the signed gate refused" were passing through a completely different path;
//   · token-XOR-ceiling — the client sent one OR the other, so an expired token had no ceiling to
//     fall back to, which is the overcharge the closing gate found.
//
// So this composes the REAL pieces and asserts the money rule across the whole matrix:
//     the client's own send() output  →  the production request→gate adapter  →  the real gate
// with real menu tables. No fake gate, no hand-built payload, no re-implementation of the mapping.
// If any of the three stops agreeing with the others, the rule breaks here.
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));

const { gateConfirmedNet, gateInputFromRequest } = require('./token-gate');
const { signQuoteToken, cartFingerprint, normalizeCartForFingerprint } = require('./quote-token');
const { issueQuote } = require('./quote-issue');
const { computeServerNet } = require('./compute-server-net');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');
const { CARTS } = require('./parity-carts.fixture');
const { createConfirmQuote } = require(new URL('./xpizza-orders/form-confirm-quote.js', import.meta.url).pathname);

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const SECRET = 'composition-1c';
const T = (rid) => ({ restaurantId: rid, menu: MENU_BY_RESTAURANT[rid], extras: EXTRAS_BY_RESTAURANT[rid] });
const withSecret = (fn) => {
  const prev = process.env.QUOTE_TOKEN_SECRET;
  process.env.QUOTE_TOKEN_SECRET = SECRET;
  try { return fn(); } finally { if (prev === undefined) delete process.env.QUOTE_TOKEN_SECRET; else process.env.QUOTE_TOKEN_SECRET = prev; }
};

/* A cart priced DEARER than it was quoted, by editing the tables the server prices against. This is
   how the catalog moving under a confirmed quote is modelled without a browser: same cart, same token,
   a server that now wants more. */
function movedTables(rid, items, deltaLempira) {
  const base = T(rid);
  const key = require('./menu-pricing').itemPricingKey(items[0], rid);
  return { ...base, menu: { ...base.menu, [key]: base.menu[key] + deltaLempira } };
}

/* THE COMPOSITION, end to end. The client decides what to put on the body; the production adapter maps
   that body into a gate input; the real gate judges it. The only thing this function adds is the menu
   the server prices against. */
function compose({ rid, items, tables, store, cartSig, shownCents, enforce = false }) {
  const body = { items, order_id: 'CMP-1' };              // the shape both handlers send
  const mode = store.send(body, cartSig, shownCents);     // ← the REAL client
  const gateInput = gateInputFromRequest(body, {          // ← the REAL production adapter
    reward: null, rid, tables, secret: SECRET, enforce, nowMs: Date.now(),
  });
  return { body, mode, result: gateConfirmedNet(gateInput) };   // ← the REAL gate
}

for (const rid of ['x_pizza', 'la_musa']) {
  console.log(`\n══ ${rid} ══`);
  const items = CARTS[rid][0];
  const tables = T(rid);
  const quotedNet = computeServerNet({ items, rid, tables }).net_total_cents;
  assert.ok(quotedNet > 0, `${rid}: premise — the fixture cart prices to a real net`);
  const SIG = 'cart-sig-1';

  // The token the real issuer produces, for the cart as quoted.
  const issued = withSecret(() => issueQuote({ items, reward: null, redemptionRef: null, rid, tables, nowMs: Date.now() }));
  assert.ok(issued.ok && issued.quote_token, `${rid}: premise — the real issuer produced a token`);

  const freshStore = () => { const s = createConfirmQuote({}); s.store(issued, SIG); return s; };

  // ── 1. 🔴 THE MATRIX: never charged more than confirmed, whatever the token is worth ──────────
  {
    const expiredTok = signQuoteToken({
      rid, customer_id: null, cart_fingerprint: cartFingerprint(normalizeCartForFingerprint(items, rid), null),
      net_total_cents: quotedNet, components: {}, redemption_ref: null,
      issued_at: 1, expires_at: 2, quote_id: 'expired',
    }, SECRET);

    const tokenStates = {
      'a valid token': () => freshStore(),
      'an EXPIRED token': () => { const s = createConfirmQuote({}); s.store({ quote_token: expiredTok }, SIG); return s; },
      'a TAMPERED token': () => { const s = createConfirmQuote({}); s.store({ quote_token: issued.quote_token.slice(0, -3) + 'aaa' }, SIG); return s; },
      'no token at all': () => createConfirmQuote({}),
    };
    const priceStates = { equal: 0, drop: -30, increase: +40 };

    let rows = 0;
    for (const [tLabel, mk] of Object.entries(tokenStates)) {
      for (const [pLabel, delta] of Object.entries(priceStates)) {
        for (const enforce of [false, true]) {
          const now = delta === 0 ? tables : movedTables(rid, items, delta);
          const serverNow = computeServerNet({ items, rid, tables: now }).net_total_cents;
          const { body, result } = compose({ rid, items, tables: now, store: mk(), cartSig: SIG, shownCents: quotedNet, enforce });
          const where = `${rid}/${tLabel}/${pLabel}/${enforce ? 'enforce' : 'grace'}`;

          /* 🔴 THE ONE RULE, ON EVERY ROW. A tampered token refuses outright; otherwise the gate either
             declines (nothing to compare) or charges — and when it charges it must charge the SERVER's
             number and never more than what the customer confirmed. */
          if (result.action === 'charge' && result.chargeNet !== null) {
            assert.strictEqual(result.chargeNet, serverNow, `${where}: 🔴 the charge must be the SERVER's recompute`);
            assert.ok(result.chargeNet <= quotedNet + 0,
              `${where}: 🔴 CHARGED ${result.chargeNet} > CONFIRMED ${quotedNet}`);
          }
          if (delta > 0 && tLabel !== 'a TAMPERED token') {
            assert.ok(result.action !== 'charge' || result.chargeNet === null,
              `${where}: 🔴 a risen price must never be charged against this confirmation (${result.action}/${result.chargeNet})`);
          }
          if (tLabel === 'a TAMPERED token') {
            assert.strictEqual(result.action, 'refuse_invalid', `${where}: 🔴 a forgery refuses in both modes`);
          }
          /* 🔴 AND THE BODY REALLY CARRIES WHAT THE GATE READ. This is the seam the typo lived in: the
             client emits these names, the adapter consumes them, and nothing else checked they match. */
          if (tLabel !== 'no token at all') {
            assert.ok('quote_token' in body, `${where}: the client put a token on the body`);
          }
          assert.strictEqual(body.expected_net_cents, quotedNet,
            `${where}: 🔴 the ceiling must be on the body under the name the adapter reads`);
          rows += 1;
        }
      }
    }
    assert.strictEqual(rows, 24, `${rid}: non-vacuity — the full matrix ran (${rows})`);
    ok(`${rid}: ${rows} composed rows — the charge is the server's net and never above the confirmation`);
  }

  // ── 2. 🔴 THE EXPIRED ROW IS THE ONE THAT OVERCHARGED. Asserted on its own, with the expiry proven.
  {
    const { verifyQuoteToken } = require('./quote-token');
    const expiredTok = signQuoteToken({
      rid, customer_id: null, cart_fingerprint: cartFingerprint(normalizeCartForFingerprint(items, rid), null),
      net_total_cents: quotedNet, components: {}, redemption_ref: null,
      issued_at: 1, expires_at: 2, quote_id: 'expired',
    }, SECRET);
    assert.strictEqual(verifyQuoteToken(expiredTok, SECRET, Date.now()).reason, 'expired',
      `${rid}: non-vacuity — the token really is EXPIRED, not merely old-looking`);

    const s = createConfirmQuote({}); s.store({ quote_token: expiredTok }, SIG);
    const dearer = movedTables(rid, items, 40);
    const serverNow = computeServerNet({ items, rid, tables: dearer }).net_total_cents;
    assert.ok(serverNow > quotedNet, `${rid}: premise — the server now wants more`);
    const { body, result } = compose({ rid, items, tables: dearer, store: s, cartSig: SIG, shownCents: quotedNet });
    assert.strictEqual(body.expected_net_cents, quotedNet, `${rid}: the ceiling rode alongside the expired token`);
    assert.strictEqual(result.action, 'refuse_increase',
      `${rid}: 🔴 THE OVERCHARGE ROW — an expired token with a ceiling must refuse, not charge ${serverNow}`);
    assert.strictEqual(result.chargeNet, serverNow, `${rid}: …reporting the server's number`);
    ok(`${rid}: an expired token + a risen price refuses through the REAL client→adapter→gate chain`);
  }

  // ── 3. 🔴 THE FIELD NAMES ARE THE CONTRACT. A rename on either side must be visible here. ──────
  {
    const s = freshStore();
    const body = { items };
    s.send(body, SIG, quotedNet);
    const gi = gateInputFromRequest(body, { reward: null, rid, tables, secret: SECRET, enforce: false, nowMs: Date.now() });
    assert.strictEqual(gi.token, body.quote_token,
      `${rid}: 🔴 the adapter must read the token under the name the client writes`);
    assert.strictEqual(gi.expectedNetCents, body.expected_net_cents,
      `${rid}: 🔴 …and the ceiling likewise — this is the mapping whose rename survived the whole suite`);
    assert.strictEqual(gi.submittedCart, body.items, `${rid}: …and the cart`);
    // …and the adapter reads NOTHING the client does not write.
    const emitted = new Set(Object.keys(body));
    for (const [gateKey, bodyKey] of [['token', 'quote_token'], ['expectedNetCents', 'expected_net_cents'], ['submittedCart', 'items']]) {
      assert.ok(emitted.has(bodyKey),
        `${rid}: 🔴 the adapter reads body.${bodyKey} for ${gateKey}, but the client never emits it`);
    }
    ok(`${rid}: the client's field names and the adapter's are the same names — checked, not assumed`);
  }
}

console.log(`\n${n} composition checks passed across both brands.`);
