'use strict';
// S0 key mode as data — the NO-OP VERDICT over two captures of test/keymode-noop.capture.js (heavy slot; not CI).
//   node test/keymode-noop.compare.js <base.json> <tip.json>
// base.json: the BASE handlers (b13a0c82), state pre. tip.json: this tip, states pre, pre_again, snap, rollback, drift.
// VOLATILE leaves are not assumed: they are the leaves that differ between tip.pre and tip.pre_again — two captures of
// the same state — and a money field may never be among them. Every tip state must then equal the base, cell for cell.
const assert = require('assert');
const fs = require('fs');
const [baseFile, tipFile] = process.argv.slice(2);
assert.ok(baseFile && tipFile, 'usage: keymode-noop.compare.js <base.json> <tip.json>');
const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
const tip = JSON.parse(fs.readFileSync(tipFile, 'utf8'));
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

function leaves(v, p = '', out = new Map()) {
  if (v && typeof v === 'object') { const ks = Object.keys(v); if (!ks.length) out.set(p, Array.isArray(v) ? '[]' : '{}'); for (const k of ks) leaves(v[k], `${p}/${k}`, out); }
  else out.set(p, JSON.stringify(v));
  return out;
}
const shape = (p) => p.replace(/\/\d+(?=\/|$)/g, '/#');   // array positions fold, so a volatile leaf is volatile in every line
const MONEY = /total|cents|price|amount|charged|items|factura|subtotal|tax|discount|redemption|balance|reserved|status|error|blocked|key|qty/i;

assert.ok(base.states && base.states.pre, 'premise: the base capture has state pre');
for (const st of ['pre', 'pre_again', 'snap', 'rollback', 'drift']) assert.ok(tip.states && tip.states[st], `premise: the tip capture has state ${st}`);
assert.notStrictEqual(base.fn, tip.fn, 'premise: the two captures ran different handler trees');

// volatile = differs between two captures of the same state
const a = leaves(tip.states.pre.cells); const b = leaves(tip.states.pre_again.cells);
assert.deepStrictEqual([...a.keys()].sort(), [...b.keys()].sort(), 'two captures of the same state have the same leaves');
const volatile = new Set([...a.keys()].filter((k) => a.get(k) !== b.get(k)).map((k) => shape(k.replace(/^\/[^/]+/, ''))));
const moneyVolatile = [...volatile].filter((p) => MONEY.test(p.split('/').pop()) && !/_at$|^\/res\/json\/quote_token$|token|expires|hosted_order_id|poll|attempt_id|idempotency|ck$|_id$/.test(p));
assert.deepStrictEqual(moneyVolatile, [], `🔴 a money / decision field differs between two identical captures — the capture is not deterministic there`);
ok(`volatile leaves derived from two captures of the same state (${volatile.size} shapes); none is a money or decision field`);

const strip = (cells) => {
  const out = {};
  for (const [cell, v] of Object.entries(cells)) {
    const l = leaves(v); const kept = {};
    for (const [p, val] of l) if (!volatile.has(shape(p))) kept[p] = val;
    out[cell] = kept;
  }
  return out;
};
const B = strip(base.states.pre.cells);
const cellCount = Object.keys(B).length;
assert.ok(cellCount >= 20, `premise: a real matrix (${cellCount} cells)`);
const succeeded = Object.entries(base.states.pre.cells).filter(([, v]) => (v.res ? v.res.status : v.status) === 200).length;
const refused = Object.entries(base.states.pre.cells).filter(([, v]) => (v.res ? v.res.status : v.status) >= 400).length;
assert.ok(succeeded >= 12 && refused >= 2, `premise: the matrix has successes AND refusals (${succeeded} ok, ${refused} refused)`);
for (const st of ['pre', 'snap', 'rollback', 'drift']) {
  const T = strip(tip.states[st].cells);
  assert.deepStrictEqual(Object.keys(T).sort(), Object.keys(B).sort(), `${st}: the same cells`);
  for (const cell of Object.keys(B)) assert.deepStrictEqual(T[cell], B[cell], `🔴 NOOP-${st.toUpperCase()} ${cell}: the tip's response / stored records differ from the base`);
  ok(`${st}: ${cellCount} cells (${succeeded} orders/quotes, ${refused} refusals) byte-identical to the base handlers on every non-volatile leaf`);
}

// the S0 state each run was actually in (non-vacuity of snap / rollback / drift)
const DEFAULT = { x_pizza: 'name', la_musa: 'id' };
for (const rid of ['x_pizza', 'la_musa']) {
  const pre = tip.states.pre.meta[rid];
  assert.deepStrictEqual([pre.record_key_mode, pre.snapshot_key_mode, pre.mirror_key_mode], [null, null, null], `${rid}: pre carries no recorded mode`);
  for (const st of ['snap', 'rollback', 'drift']) {
    const m = tip.states[st].meta[rid];
    assert.deepStrictEqual([m.record_key_mode, m.snapshot_key_mode, m.mirror_key_mode], [DEFAULT[rid], DEFAULT[rid], DEFAULT[rid]], `NOOP-META ${st} ${rid}: version record, active snapshot and mirror carry the default mode`);
    assert.deepStrictEqual(m.avail_identity, base.states.pre.meta[rid].avail_identity, `NOOP-META ${st} ${rid}: the public menu serves the same avail_identity`);
  }
  assert.strictEqual(tip.states.rollback.meta[rid].versions.length, 2, `premise: ${rid} rollback published twice`);
}
ok('pre carries no mode; snap / rollback / drift carry the default on the record, snapshot and mirror; avail_identity unchanged');

console.log(`\nkeymode-noop compare: OK (${n})`);
