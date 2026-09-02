'use strict';
// Phase 1d Stage 2c — the fail-closed order reject. Run: node fail-closed-reject.test.js
//
// After the flip there is no code net. A resolver/ladder failure MUST become a clean typed reject, and
// the placement of that guard is the whole safety property — not its existence. Source-level, because
// index.js cannot be imported without Firebase init; the checks are about ORDERING, which is exactly
// what source position expresses.
const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const SRC = readFileSync(join(__dirname, 'index.js'), 'utf8');
const at = (needle, from = 0) => { const i = SRC.indexOf(needle, from); assert.notStrictEqual(i, -1, `not found: ${needle}`); return i; };

// ── The typed reject exists and is retryable ───────────────────────────────────────────────────
assert.ok(/function pricingUnavailable\(res\) \{\s*return res\.status\(503\)\.json\(\{ error: 'pricing_unavailable', retryable: true \}\);/.test(SRC),
  'a DISTINCT retryable 503 — not a generic 400/500 — so the client can say "retry the same cart"');
ok('typed reject: 503 { error: pricing_unavailable, retryable: true }');

// ── resolvePricingTables returns null (no code net) ────────────────────────────────────────────
{
  const fn = SRC.slice(at('async function resolvePricingTables'), at('function pricingUnavailable'));
  assert.ok(/return null;/.test(fn), 'a genuine failure returns null');
  assert.ok(!/MENU_BY_RESTAURANT\[restaurantId\]/.test(fn), 'and NEVER the in-code tables — the code net is retired');
  assert.ok(/pricing_resolver_failed/.test(fn), 'the catastrophic case still alarms');
  ok('no code net: resolvePricingTables returns null on failure, never the retired code tables');
}

// ── createOrder: the guard is the FIRST statement after the resolver, before every pricing seam ──
{
  const call = at('const pricingTables = await resolvePricingTables(restaurantId);');
  const guard = at('if (!pricingTables) return pricingUnavailable(res);', call);
  // From AFTER the resolver statement to the guard: nothing executable may sit between them.
  const between = SRC.slice(call + 'const pricingTables = await resolvePricingTables(restaurantId);'.length, guard).replace(/\/\/[^\n]*/g, '');
  assert.ok(!/[a-zA-Z]\w*\s*\(/.test(between), `nothing may execute between the resolver and the guard, found: ${JSON.stringify(between.trim())}`);
  // and the guard precedes every seam that could price, throw, write or charge
  for (const seam of ['validateOrderPayload(body, restaurantId, pricingTables)', 'computeIncomingFingerprint(', 'resolveRedemptionForOrder(', 'pricedLineItems(']) {
    assert.ok(at(seam, call) > guard, `createOrder: the guard must precede ${seam}`);
  }
  ok('createOrder: the guard is the FIRST statement after the resolver, ahead of validate / fingerprint / reserve / factura');
}
// ── chargeOnlineOrder: same, and ahead of anything that moves money or strands a pending ────────
{
  const call = at('const pricingTables = await resolvePricingTables(restaurantId);', at('chargeOnlineOrder: restaurant_id'));
  const guard = at('if (!pricingTables) return pricingUnavailable(res);', call);
  const between = SRC.slice(call + 'const pricingTables = await resolvePricingTables(restaurantId);'.length, guard).replace(/\/\/[^\n]*/g, '');
  assert.ok(!/[a-zA-Z]\w*\s*\(/.test(between), 'nothing may execute between the resolver and the guard');
  for (const seam of ['validateOrderPayload(body, restaurantId, pricingTables)', 'prepareRedemption(', 'acquireHostedAttempt(', 'createHostedCharge(', 'pricedLineItems(']) {
    assert.ok(at(seam, call) > guard, `chargeOnlineOrder: the guard must precede ${seam}`);
  }
  ok('chargeOnlineOrder: guard precedes validate / prepareRedemption / acquireHostedAttempt / createHostedCharge / factura — no money moves, no pending stranded');
}

// ── 🔒 THE FISCAL BARRIER. fiscal's own resolvePriceTables(null) falls back to CODE, so the ONLY
//    thing preventing a code-priced factura on a Void-only SAR document is this upstream reject. ──
{
  for (const [label, anchor] of [['createOrder', 'createOrder: restaurant_id'], ['chargeOnlineOrder', 'chargeOnlineOrder: restaurant_id']]) {
    const call = at('const pricingTables = await resolvePricingTables(restaurantId);', at(anchor));
    const guard = at('if (!pricingTables) return pricingUnavailable(res);', call);
    const factura = at('pricedLineItems(body.items', call);
    assert.ok(guard < factura, `${label}: the reject MUST be upstream of the factura pricer`);
    // nothing between the guard and the factura can re-enter pricing with a null
    assert.ok(!/resolvePricingTables\(/.test(SRC.slice(guard, factura)), `${label}: no second resolver call between the guard and the factura`);
  }
  ok('FISCAL BARRIER: no factura path is reachable after a null — the reject is upstream of pricedLineItems on BOTH handlers');
}

// ── The quote endpoints fail SOFT (display-only), and quoteRedemption MUST be guarded ───────────
{
  const qo = SRC.slice(at('exports.quoteOrder = onRequest('), at('exports.quoteRedemption = onRequest('));
  assert.ok(/if \(!tables\) return res\.status\(200\)\.json\(\{ ok: false, error: 'pricing_unavailable' \}\);/.test(qo),
    'quoteOrder fails soft — a preview outage must not block checkout');
  const qr = SRC.slice(at('exports.quoteRedemption = onRequest('), at('exports.quoteRedemption = onRequest(') + 4000);
  const qrCall = qr.indexOf('const quoteTables = await resolvePricingTables(restaurantId);');
  const qrGuard = qr.indexOf('if (!quoteTables) return res.status(200).json({ ok: false');
  assert.ok(qrGuard > qrCall && qrGuard < qr.indexOf('quoteRedemptionCore(db,'),
    'quoteRedemption must guard BEFORE quoteRedemptionCore — its requireTables throws on null, which would surface as a 500 rather than a clean ok:false');
  ok('quotes fail SOFT: both return ok:false; quoteRedemption is guarded before requireTables can throw');
}

// ── Exactly four call sites, each guarded — a fifth added later must be guarded too ─────────────
{
  const sites = SRC.split('resolvePricingTables(restaurantId)').length - 1 - 1;   // minus the definition
  assert.strictEqual(sites, 4, `expected exactly 4 resolver call sites, found ${sites} — a new one must add its own fail-closed guard`);
  const guards = (SRC.match(/if \(!pricingTables\) return pricingUnavailable\(res\);/g) || []).length
               + (SRC.match(/if \(!tables\) return res\.status\(200\)\.json\(\{ ok: false, error: 'pricing_unavailable' \}\);/g) || []).length
               + (SRC.match(/if \(!quoteTables\) return res\.status\(200\)\.json\(\{ ok: false, error: 'pricing_unavailable' \}\);/g) || []).length;
  assert.strictEqual(guards, 4, `all 4 call sites must be guarded, found ${guards}`);
  ok('exactly 4 resolver call sites, exactly 4 fail-closed guards — a new call site without one fails here');
}
console.log(`fail-closed-reject: OK (${n})`);
