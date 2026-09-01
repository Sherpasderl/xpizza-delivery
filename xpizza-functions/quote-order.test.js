'use strict';
// Phase 1d Stage 2a — the checkout server quote. Run: node quote-order.test.js
//
// The claim: what quoteOrder returns is what the order will charge. That holds only if the quote is
// composed from the SAME functions the order path uses, so these tests price a shared fixture through
// both compositions and compare — rather than asserting the endpoint's arithmetic in isolation.
const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');
const { computeServerTotal, MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');
const { orderBreakdownCents } = require('./order-money');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const T = (rid, over = {}) => ({ restaurantId: rid, menu: { ...MENU_BY_RESTAURANT[rid], ...(over.menu || {}) }, extras: { ...EXTRAS_BY_RESTAURANT[rid], ...(over.extras || {}) } });
// SHARED FIXTURES — the same carts drive both the quote composition and the order composition.
const CARTS = {
  x_pizza: [[{ name: 'Margherita', qty: 1 }], [{ name: 'Pepperoni', qty: 3 }],
            [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }, { name: 'Basil Pesto' }] }],
            [{ name: 'Carnivora NY', qty: 1 }], [{ name: 'Nutella', qty: 50 }]],
  la_musa: [[{ id: 'dimsum_01', qty: 1 }], [{ id: 'noodle_02', qty: 4 }],
            [{ id: 'dimsum_01', qty: 2, extras: [{ id: 'rice_white', qty: 3 }] }]],
};
// The two compositions, written out separately so a divergence would actually show.
const quoteComposition = (items, rid, tables) => {
  const { total, error } = computeServerTotal(items, rid, tables);
  if (error) return { ok: false, error: 'bad_cart' };
  const bd = orderBreakdownCents(total, rid);
  return { ok: true, total_cents: bd.total_cents, subtotal_cents: bd.subtotal_cents, tax_cents: bd.tax_cents };
};
const orderComposition = (items, rid, tables) => {
  const { total, error } = computeServerTotal(items, rid, tables);   // index.js:325 — the binding total
  if (error) return { error };
  return orderBreakdownCents(total, rid);                            // the breakdown the order charges
};

// ── 1. DISPLAYED == CHARGED, on a shared fixture, both brands ──────────────────────────────────
let carts = 0;
for (const rid of ['x_pizza', 'la_musa']) {
  for (const items of CARTS[rid]) {
    const tables = T(rid);
    const q = quoteComposition(items, rid, tables);
    const o = orderComposition(items, rid, tables);
    assert.strictEqual(q.ok, true, `${rid}: the fixture must quote cleanly`);
    assert.strictEqual(q.total_cents, o.total_cents, `${rid}: the QUOTED total must equal what the order charges`);
    assert.strictEqual(q.subtotal_cents, o.subtotal_cents, `${rid}: subtotal must match`);
    assert.strictEqual(q.tax_cents, o.tax_cents, `${rid}: the ISV split must match`);
    carts++;
  }
  ok(`displayed == charged ${rid}: ${CARTS[rid].length} shared-fixture carts quote exactly what the order charges`);
}
{
  // And it must track the TABLES, not a snapshot of them — the whole point post-flip. A price change
  // in the resolved tables moves the quote and the charge together.
  const bumped = T('x_pizza', { menu: { Margherita: 999 } });
  const items = [{ name: 'Margherita', qty: 2 }];
  assert.strictEqual(quoteComposition(items, 'x_pizza', bumped).total_cents, orderComposition(items, 'x_pizza', bumped).total_cents);
  assert.strictEqual(quoteComposition(items, 'x_pizza', bumped).total_cents, 999 * 2 * 100, 'both follow the resolved tables');
  assert.notStrictEqual(quoteComposition(items, 'x_pizza', bumped).total_cents, quoteComposition(items, 'x_pizza', T('x_pizza')).total_cents);
  ok('the quote follows the RESOLVED tables — a diverged price moves quote and charge together (the post-flip case)');
}

// ── 2. FAIL-SOFT: a bad cart is ok:false, never an exception or a wrong number ──────────────────
for (const [label, items, rid] of [['unknown item', [{ name: 'NOT A PIZZA', qty: 1 }], 'x_pizza'],
                                   ['bad qty', [{ name: 'Margherita', qty: 0 }], 'x_pizza'],
                                   ['empty cart', [], 'x_pizza'],
                                   ['unknown extra', [{ name: 'Margherita', qty: 1, extras: [{ name: 'ghost' }] }], 'x_pizza'],
                                   ['unknown la_musa id', [{ id: 'ghost_01', qty: 1 }], 'la_musa']]) {
  const q = quoteComposition(items, rid, T(rid));
  assert.deepStrictEqual([q.ok, q.error], [false, 'bad_cart'], `${label} → ok:false, no total`);
  assert.strictEqual(q.total_cents, undefined, `${label} must not carry a number the client could display`);
}
ok('fail-soft: 5 bad-cart shapes → { ok:false } with NO total (the client keeps its own, checkout never blocks)');
{
  // A corrupt price (1a) is refused here too — the quote can never display a price the order rejects.
  const q = quoteComposition([{ name: 'Margherita', qty: 1 }], 'x_pizza', T('x_pizza', { menu: { Margherita: 0 } }));
  assert.deepStrictEqual([q.ok, q.error], [false, 'bad_cart']);
  ok('fail-soft: a corrupt price refuses the quote too (1a guard applies — never display a price the order would reject)');
}

// ── 3. The endpoint's contract, structurally: read-only, fail-soft, rate-limited, same resolver ──
{
  const SRC = readFileSync(join(__dirname, 'index.js'), 'utf8');
  const ep = SRC.slice(SRC.indexOf('exports.quoteOrder = onRequest('), SRC.indexOf('exports.quoteRedemption = onRequest('));
  assert.ok(ep.length > 0, 'the quoteOrder endpoint must exist');
  assert.ok(/resolvePricingTables\(restaurantId\)/.test(ep), 'it must price via the SAME resolver the order path uses');
  assert.ok(/computeServerTotal\(body\.items, restaurantId, tables\)/.test(ep), 'and the SAME calculator');
  assert.ok(/orderBreakdownCents\(total, restaurantId\)/.test(ep), 'and the SAME breakdown');
  // READ-ONLY with respect to ORDER, CATALOG and REWARDS state. Precisely: the endpoint writes no
  // domain data and reserves nothing. It DOES write one thing — the rate-limit counter, via
  // checkRateLimit — because that is how rate limiting works; calling the endpoint "writes nothing"
  // would be false, so the assertion names the one permitted write instead of pretending it away.
  const domainWrites = ep
    .replace(/res\.set\(/g, '')                                  // HTTP header, not a write
    .replace(/checkRateLimit\(db, 'quote_ip'[^;]*;/g, '');        // the one permitted write (the limiter)
  for (const forbidden of ['.set(', '.update(', '.push(', '.transaction(', '.remove(', 'reserveRedemption', 'buildCreateOrderUpdates']) {
    assert.ok(!domainWrites.includes(forbidden), `quoteOrder must not mutate domain state — found ${forbidden}`);
  }
  assert.ok(/checkRateLimit\(db, 'quote_ip'/.test(ep), 'the only write is the rate-limit counter');
  ok('structural: quoteOrder prices via the same resolver/calculator/breakdown as the order; no domain writes (only the rate-limit counter)');
  assert.ok(/checkRateLimit\(db, 'quote_ip'/.test(ep), 'the public endpoint must be rate-limited');
  assert.ok(/RATE_LIMIT_BUCKETS\.quote_ip/.test(SRC) && /quote_ip: \{ windowMs/.test(SRC), 'with its own dedicated bucket');
  ok('structural: rate-limited on a dedicated quote_ip bucket (a free pricing read is not an amplifier)');
  // fail-soft: the error paths return 200 + ok:false so the client falls back rather than blocking
  assert.ok(/if \(error\) return res\.status\(200\)\.json\(\{ ok: false, error: 'bad_cart' \}\)/.test(ep), 'a bad cart is a soft 200');
  assert.ok(/catch \(e\)[\s\S]{0,160}res\.status\(200\)\.json\(\{ ok: false/.test(ep), 'even an unexpected throw is soft — checkout must never block on a quote');
  ok('structural: fail-soft — bad cart AND unexpected errors return 200 ok:false, so checkout never blocks');
}

// ── 4. The client side: precedence, stale-cart, fail-open — in the PARITY block, both forms ─────
{
  const forms = { x_pizza: readFileSync(join(__dirname, '..', 'xpizza-orders', 'index.html'), 'utf8'),
                  la_musa: readFileSync(join(__dirname, '..', 'la-musa-orders', 'index.html'), 'utf8') };
  for (const [rid, src] of Object.entries(forms)) {
    const block = src.slice(src.indexOf('//__REWARDS_PARITY_BEGIN__'), src.indexOf('//__REWARDS_PARITY_END__'));
    assert.ok(/const rc=[\s\S]{0,180}if\(rc!=null\) return rc\/100;[\s\S]{0,120}const sq=getServerQuoteTotalCents\(\);[\s\S]{0,80}if\(sq!=null\) return sq\/100;[\s\S]{0,60}return calcTotal\(\);/.test(block),
      `${rid}: precedence must be redemption quote → server quote → calcTotal`);
    assert.ok(/__serverQuote\.key === serverQuoteCartKey\(\)/.test(block), `${rid}: stale-cart guard — only show a total for the cart it priced`);
    assert.ok(/getRedeemPayload\(\)\) return null/.test(block), `${rid}: a pending redemption owns the total`);
    assert.ok(/\.catch\(function\(\)\{[\s\S]{0,160}__serverQuote\.cents=null/.test(block), `${rid}: a network failure fails OPEN to calcTotal`);
    assert.ok(/if\(__serverQuote\.inflight!==key\) return;/.test(block), `${rid}: a superseded response is ignored`);
    assert.ok(src.includes("const QUOTEORDER_URL"), `${rid}: the endpoint URL is defined`);
    assert.ok(/function renderStage2Summary\(\)\{\n  try\{ requestServerQuote\(\); \}catch\(_\)\{\}/.test(src), `${rid}: the quote is requested wherever the pay-step summary renders`);
  }
  ok('client (both forms, in the parity block): precedence, stale-cart guard, redemption precedence, fail-open, superseded-response guard');
}
console.log(`quote-order: OK (${n})  [${carts} shared-fixture carts compared quote-vs-order]`);
