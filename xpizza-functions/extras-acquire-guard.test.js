'use strict';
// PER-PRODUCT EXTRAS, stage 2 — the acquire guard at unit level (PLAN rev 2.2 §5). Run: node extras-acquire-guard.test.js
//   acquireHostedAttempt's `extrasRefuseFresh` ('extra_not_allowed' | 'eligibility_unavailable'): every FRESH issuance (create /
//   install / recover / rotate) is refused with the conflict shape and THAT reason, BEFORE the CAS — nothing written; a
//   genuine bound REUSE (a live checkout) is returned untouched (never re-judged); off by default; an unknown value arms nothing.
const assert = require('assert');
const { acquireHostedAttempt } = require('./pixelpay-hosted-charge');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
function makeDb(initial = {}) {
  const root = JSON.parse(JSON.stringify(initial));
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const ops = [];
  const getAt = (p) => { if (!p) return root; let x = root; for (const k of p.split('/')) { if (x == null) return null; x = x[k]; } return x === undefined ? null : x; };
  const setAt = (p, val) => { const a = p.split('/'); let x = root; for (let i = 0; i < a.length - 1; i++) { if (x[a[i]] == null || typeof x[a[i]] !== 'object') x[a[i]] = {}; x = x[a[i]]; } if (val === null) delete x[a[a.length - 1]]; else x[a[a.length - 1]] = val; };
  const ref = (p = '') => ({
    async once() { ops.push(['once', p]); return { val: () => clone(getAt(p)) }; },
    async transaction(fn) { ops.push(['transaction', p]); fn(null); const cur = clone(getAt(p)); const nx = fn(cur); if (nx === undefined) return { committed: false, snapshot: { val: () => cur } }; setAt(p, clone(nx)); return { committed: true, snapshot: { val: () => clone(getAt(p)) } }; },
    async update(patch) { ops.push(['update', p, Object.keys(patch).sort()]); if (!p) { for (const [k, v] of Object.entries(patch)) setAt(k, clone(v)); return; } for (const [k, v] of Object.entries(patch)) setAt(`${p}/${k}`, clone(v)); },
  });
  return { ref, getAt, ops, root };
}
const NOW = 1_000_000_000;
const FP = 'fp-abc';
const PENDING = { order_id: 'O1', status: 'pending_payment', payment_status: 'pending', payment_method: 'online', total: 299, total_cents: 29900 };
const live = (extra = {}) => ({ orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } }, payment_attempts: { AT1: { order_id: 'O1', hosted_state: 'created', hosted_expires_at: NOW + 10000, hosted_checkout_url: 'https://pay/X', poll_token: 'P', ...extra } } });
const acq = (db, reason) => acquireHostedAttempt(db, 'O1', PENDING, FP, NOW, [], () => 'ATNEW', () => 'TOKNEW', null, false, false, false, false, reason);

(async () => {
  const FRESH = {
    create: {},
    install: { orders: { O1: { ...PENDING, payment_fingerprint: FP } } },
    recover: { orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } } },
    rotate_expired: live({ hosted_expires_at: NOW - 1 }),
    rotate_failed: live({ hosted_state: 'failed_create' }),
  };
  for (const reason of ['extra_not_allowed', 'eligibility_unavailable']) {
    for (const [kind, init] of Object.entries(FRESH)) {
      const db = makeDb(init); const before = JSON.stringify(db.root);
      assert.deepStrictEqual(await acq(db, reason), { outcome: 'conflict', reason }, `${kind}: refused with ${reason}`);
      assert.strictEqual(JSON.stringify(db.root), before, `${kind}: nothing written`);
      assert.ok(!db.ops.some((o) => o[0] === 'transaction' || o[0] === 'update'), `${kind}: no CAS, no write`);
    }
  }
  ok('every FRESH issuance (create / install / recover / rotate×2) is refused with the extras reason, before the CAS, nothing written');
  {
    const r = await acq(makeDb(live()), 'extra_not_allowed');
    assert.strictEqual(r.outcome, 'reuse', 'a live bound checkout is REUSED, never re-judged');
    for (const [kind, init] of Object.entries(FRESH)) {
      assert.strictEqual((await acquireHostedAttempt(makeDb(init), 'O1', PENDING, FP, NOW, [], () => 'ATNEW', () => 'TOKNEW')).outcome, 'claimed', `${kind}: default unarmed`);
      assert.strictEqual((await acq(makeDb(init), 'something_else')).outcome, 'claimed', `${kind}: an unknown reason arms nothing`);
    }
    ok('a live bound checkout is reused untouched; unarmed by default; an unknown reason arms nothing');
  }
  console.log(`\nextras-acquire-guard: OK (${n})`);
})().catch((e) => { console.error('extras-acquire-guard FAILED:', e); process.exit(1); });
