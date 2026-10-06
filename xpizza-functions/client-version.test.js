'use strict';
// P-SELFUPDATE §4 (codex CP1 S3) — a structurally invalid heartbeat costs NOTHING: zero registry calls and zero database
// calls, counted by spies (an unchanged-database check cannot prove "no work"). Run: node client-version.test.js
const assert = require('assert');
const CV = require('./client-version');
const { PLATFORM } = require('./platform-manifest');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('client-version FAILED: exited without completing'); process.exitCode = 1; } });

function spies() {
  const calls = { registry: 0, db: 0 };
  const registry = { ready: async () => { calls.registry += 1; }, known: () => { calls.registry += 1; return new Set(['x_pizza', 'la_musa']); } };
  const tx = async () => ({ committed: true, snapshot: { val: () => null } });
  const db = { ref: () => { calls.db += 1; return { transaction: tx, update: async () => {}, once: async () => ({ val: () => null }) }; } };
  return { calls, registry, db };
}
function res() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; }, end() { return this; } };
}
const SV = { TIMESTAMP: { '.sv': 'timestamp' }, increment: (k) => ({ '.sv': { increment: k } }) };
const R = (o = {}) => ({ app: 'orders', deployment: 'orders-xpizza', context: 'x_pizza', build: 'b1', compat: 1, instance: 'inst_000001', ...o });
const call = async (body, sp) => { const r = res(); await CV.handleReport({ method: 'POST', body, headers: { 'x-forwarded-for': '10.0.0.1' } }, r, { db: sp.db, ServerValue: SV, platform: PLATFORM, registry: sp.registry }); return r; };

(async () => {
  // every structural / manifest defect, INCLUDING ones whose context names a real restaurant (codex's repro: an invalid
  // app with a restaurant context used to warm the registry first)
  const invalid = [
    ['unknown app + a restaurant context', R({ app: 'nope' })],
    ['app/deployment mismatch', R({ deployment: 'kitchen-xpizza' })],
    ['context ≠ the deployment\'s', R({ context: 'la_musa' })],
    ['compat 0', R({ compat: 0 })], ['compat too high', R({ compat: 99 })], ['compat string', R({ compat: '1' })],
    ['bad build', R({ build: 'a/b' })], ['bad instance', R({ instance: 'x' })], ['extra field', R({ last_seen: 1 })],
    ['bad diag', R({ diag: 'nope' })], ['array body', [R()]], ['null body', null], ['context not a string', R({ context: 7 })],
  ];
  for (const [label, body] of invalid) {
    const sp = spies();
    const r = await call(body, sp);
    assert.strictEqual(r.code, 400, `${label}: 400`);
    assert.deepStrictEqual(sp.calls, { registry: 0, db: 0 }, `🔴 ${label}: a structurally invalid report made registry/database calls ${JSON.stringify(sp.calls)}`);
  }
  ok(`${invalid.length} structurally invalid reports → 400 with ZERO registry calls and ZERO database calls (spied)`);

  // a structurally valid report with an UNREGISTERED restaurant context: the registry is consulted, the database is not
  const sp1 = spies(); sp1.registry.known = () => { sp1.calls.registry += 1; return new Set(['la_musa']); };
  const r1 = await call(R(), sp1);
  assert.strictEqual(r1.code, 400); assert.deepStrictEqual(r1.body, { error: 'invalid_report', field: 'context' });
  assert.ok(sp1.calls.registry > 0, 'membership IS checked for a structurally valid report'); assert.strictEqual(sp1.calls.db, 0, 'and an unregistered context never reaches the database');
  // a registry that cannot answer → the context is unverified → refused, no database work
  const sp2 = spies(); sp2.registry.ready = async () => { sp2.calls.registry += 1; throw new Error('down'); };
  const r2 = await call(R(), sp2);
  assert.strictEqual(r2.code, 400); assert.strictEqual(sp2.calls.db, 0);
  // a platform-context report never touches the registry
  const sp3 = spies();
  const r3 = await call(R({ app: 'legal', deployment: 'legal', context: 'platform', instance: 'inst_legal01' }), sp3);
  assert.strictEqual(r3.code, 204); assert.strictEqual(sp3.calls.registry, 0, 'a platform page never consults the registry');
  // a valid, registered report does the work (limiter + record)
  const sp4 = spies();
  assert.strictEqual((await call(R(), sp4)).code, 204); assert.ok(sp4.calls.registry > 0 && sp4.calls.db > 0);
  ok('ordering: structure → registry membership → database. An unregistered or unverifiable restaurant context is refused with no database work; a platform page never touches the registry; a valid report records');

  FINISHED = true;
  console.log(`client-version: OK (${n})`);
})().catch((e) => { console.error('client-version FAILED:', e); process.exit(1); });
