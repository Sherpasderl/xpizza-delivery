// PLAN 5 — form-cart.js disclosed adoption, unit level (the shared, byte-identical module). Run: node form-cart-disclosure.test.mjs
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCart } = require('./xpizza-orders/form-cart.js');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const adapter = { itemKey: (r) => String(r.id), pricingKey: (r) => String(r.id), extraKey: (r) => String(r.id), extraPricingKey: (r) => String(r.id), extraKeysFor: () => [] };
const A = { id: 'a', name: 'Alpha', price: 100 }, B = { id: 'b', name: 'Beta', price: 50 };
const menuOf = (...recs) => { const m = new Map(recs.map((r) => [String(r.id), r])); return (k) => m.get(k) || null; };
const fresh = () => { const c = createCart({ adapter }); c.setQty(A, 1); c.setQty(B, 2); return c; };

{ // eligibility: repriced-only → changes; anything else → null
  const c = fresh(); const A2 = { ...A, price: 130 };
  const lines = c.resolve(menuOf(A2, B));
  assert.deepStrictEqual(c.priceNoticeChanges(lines).map(({ live, ...x }) => x), [{ key: 'a', name: 'Alpha', from: 100, to: 130 }]);
  assert.strictEqual(c.priceNoticeChanges(lines, { blockedByContext: true }), null, 'context (resume/reward) → null');
  assert.strictEqual(c.priceNoticeChanges(lines, { isUnavailable: (r) => r.id === 'a' }), null, 'repriced + unavailable → null');
  assert.strictEqual(c.priceNoticeChanges(lines, { isLauncher: (l) => l.key === 'a' }), null, 'launcher → null');
  assert.strictEqual(c.priceNoticeChanges(c.resolve(menuOf(A2))), null, 'mixed (Beta removed) → null');
  assert.strictEqual(c.priceNoticeChanges(c.resolve(menuOf(A, B))), null, 'nothing blocked → null');
  const withOpt = lines.map((l) => (l.key === 'b' ? { ...l, extras: [{ key: 'x', unresolved: 'repriced' }] } : l));
  assert.strictEqual(c.priceNoticeChanges(withOpt), null, 'any option conflict anywhere → null');
  ok('priceNoticeChanges: repriced dishes only; context, unavailable, launcher, mixed, option conflicts and a clean cart → null');
}
{ // adoption: all or nothing, reversible, recorded
  const c = fresh(); const A2 = { ...A, price: 130 };
  const ch = c.priceNoticeChanges(c.resolve(menuOf(A2, B)));
  const before = JSON.stringify(c.snapshot());
  const rollback = c.adoptPrices(ch);
  assert.strictEqual(typeof rollback, 'function');
  assert.deepStrictEqual(c.disclosed(), [{ key: 'a', name: 'Alpha', from: 100, to: 130 }]);
  assert.strictEqual(c.priceNoticeChanges(c.resolve(menuOf(A2, B))), null, 'idempotent: after adoption nothing is blocked');
  rollback();
  assert.strictEqual(JSON.stringify(c.snapshot()), before, 'rollback restores lines AND disclosures exactly');
  const partial = [...ch, { key: 'zz', name: 'Ghost', from: 1, to: 2, live: { id: 'zz', price: 2 } }];
  assert.strictEqual(c.adoptPrices(partial), null, 'a change that cannot be accepted → nothing adopted');
  assert.strictEqual(JSON.stringify(c.snapshot()), before, '…and nothing changed (all or nothing)');
  ok('adoptPrices: all-or-nothing, returns an exact rollback, records disclosures, idempotent');
}
{ // lifecycle: removal / clear / reset; snapshot unchanged when nothing disclosed; hydrate validation
  const c = fresh(); const A2 = { ...A, price: 130 };
  assert.ok(!('disclosed' in c.snapshot()), 'no disclosure → the snapshot has no `disclosed` key (byte-identical to before)');
  c.adoptPrices(c.priceNoticeChanges(c.resolve(menuOf(A2, B))));
  const snap = c.snapshot();
  assert.deepStrictEqual(snap.disclosed, [{ key: 'a', name: 'Alpha', from: 100, to: 130 }]);
  const r = createCart({ adapter }); assert.ok(r.hydrate(snap)); assert.deepStrictEqual(r.disclosed(), snap.disclosed, 'hydrate keeps a valid disclosure');
  const stale = JSON.parse(JSON.stringify(snap)); stale.disclosed[0].to = 999;
  const r2 = createCart({ adapter }); assert.ok(r2.hydrate(stale), 'a stale disclosure never blocks a restore'); assert.deepStrictEqual(r2.disclosed(), [], '…it is dropped');
  const junk = JSON.parse(JSON.stringify(snap)); junk.disclosed = [{ key: 'b' }, 7, null, { key: 'nope', name: 'x', from: 1, to: 2 }];
  const r3 = createCart({ adapter }); assert.ok(r3.hydrate(junk)); assert.deepStrictEqual(r3.disclosed(), [], 'malformed / unknown-key entries dropped');
  c.setQtyByKey('a', 0); assert.deepStrictEqual(c.disclosed(), [], 'qty 0 by key drops the disclosure');
  c.adoptPrices([{ key: 'b', name: 'Beta', from: 50, to: 60, live: { ...B, price: 60 } }]); c.clear(); assert.deepStrictEqual(c.disclosed(), [], 'clear() drops all');
  const d = fresh(); d.adoptPrices([{ key: 'a', name: 'Alpha', from: 100, to: 130, live: A2 }]); d.reset(); assert.deepStrictEqual(d.disclosed(), [], 'reset() drops all');
  const e = fresh(); e.adoptPrices([{ key: 'a', name: 'Alpha', from: 100, to: 130, live: A2 }]); e.setQty(A2, 0); assert.deepStrictEqual(e.disclosed(), [], 'setQty 0 drops it');
  ok('disclosed lifecycle: removal / clear / reset drop it; snapshot unchanged without one; hydrate keeps valid, drops stale or malformed');
}
console.log(`\nform-cart-disclosure: OK (${n})`);
