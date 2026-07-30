/**
 * Emulator suite for Track A claimPrefillCore (claim-prefill.js) — the token-gated profile-claim soft-fill
 * lookup. Run:
 *   firebase emulators:exec --only database --project demo-xpizza "node test/claim-prefill.emulator.test.js"
 * Proves: valid token↔order → {name, phone}; unknown/mismatched/missing/path-injection token → 403 (no phone);
 * token valid but order gone → 404. The tracking_token is the capability; the .order_id STRICT bind is the gate.
 */
const assert = require('assert');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { claimPrefillCore } = require('../claim-prefill');

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: '{ "rules": { ".read": true, ".write": true } }' } });
  let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref('orders/PZX1').set({ order_id: 'PZX1', customer_name: 'Ana', customer_phone: '+50499990000', customer_uid: 'uA', tracking_token: 'Tok12abc34XY' });
    await db.ref('order_tracking/Tok12abc34XY').set({ order_id: 'PZX1', restaurant_id: 'x_pizza' });

    let r = await claimPrefillCore(db, 'PZX1', 'Tok12abc34XY');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.name, 'Ana'); assert.strictEqual(r.body.phone, '+50499990000');
    assert.ok(!('customer_uid' in r.body) && !('address' in r.body)); ok('valid token↔order → 200 {name, phone} ONLY (no uid/address)');

    r = await claimPrefillCore(db, 'PZX1', 'WrongTokenZZ'); assert.strictEqual(r.status, 403); ok('unknown token → 403 (no phone)');

    await db.ref('order_tracking/OtherTok999').set({ order_id: 'PZX2', restaurant_id: 'x_pizza' });
    r = await claimPrefillCore(db, 'PZX1', 'OtherTok999'); assert.strictEqual(r.status, 403); ok('token bound to a DIFFERENT order → 403 (STRICT .order_id bind)');

    r = await claimPrefillCore(db, '', 'Tok12abc34XY'); assert.strictEqual(r.status, 403); ok('missing order_id → 403');
    r = await claimPrefillCore(db, 'PZX1', ''); assert.strictEqual(r.status, 403); ok('missing token → 403');
    r = await claimPrefillCore(db, 'PZX1', 'bad/../evil'); assert.strictEqual(r.status, 403); ok('path-injection token → 403 (charset guard, no RTDB path escape)');

    await db.ref('order_tracking/Ghost123abcd').set({ order_id: 'GHOST' });
    r = await claimPrefillCore(db, 'GHOST', 'Ghost123abcd'); assert.strictEqual(r.status, 404); ok('token valid but order absent → 404');

    // MF-B (R2) — the per-TOKEN throttle the claimPrefill wrapper applies BEFORE the DB read. Exercises the
    // REAL checkRateLimit + claim_token bucket from index.js (require-safe under the emulator): same token,
    // (max+1)th call in-window → not allowed (→ the wrapper returns 429 + Retry-After). Per-TOKEN, so it's
    // independent of the Cloud-Run IP-spoofability problem (the token is the spoof-proof capability).
    const { checkRateLimit, RATE_LIMIT_BUCKETS } = require('../index.js');
    const CT = RATE_LIMIT_BUCKETS.claim_token; const tkn = 'RateLimTok01';
    for (let i = 0; i < CT.max; i++) { const rr = await checkRateLimit(db, 'claim_token', tkn, CT); assert.strictEqual(rr.allowed, true); }
    const over = await checkRateLimit(db, 'claim_token', tkn, CT);
    assert.strictEqual(over.allowed, false); assert.ok(over.retryAfterSec > 0); ok(`per-token throttle: same token → call ${CT.max + 1} in-window → throttled (429, Retry-After ${over.retryAfterSec}s)`);
    const other = await checkRateLimit(db, 'claim_token', 'DifferentTok9', CT);
    assert.strictEqual(other.allowed, true); ok('per-token throttle: a DIFFERENT token has its own bucket (independent)');
  });

  await env.cleanup();
  console.log(`\nclaim-prefill: ${n} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
