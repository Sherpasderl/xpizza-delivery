'use strict';
// LEDGER S4 (PLAN-5f-ledger-shadow-s1-r3 §1 S4; r4.6 §4) — the commission RATE in effect for an order, PURE. ledger_settings/commission/
// {_default | rid}/{push} = { bp, effective_from }: append-only, versioned, never retro. The rate of an order = its restaurant's own
// latest entry effective at the order's AUTHORITATIVE date (orders/{id}.created_at), else the platform default's; none ⇒ null (the
// projector then reports rate_missing). Run: node ledger/commission-rate.test.js
const assert = require('assert');
const R = require('./commission-rate');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const cell = (label, fn) => { try { fn(); } catch (e) { console.error(`  ✗ ${label}`); throw e; } ok(label); };
const D = (s) => Date.parse(s);
const S = { _default: { a: { bp: 1000, effective_from: D('2026-11-20T06:00:00Z') }, b: { bp: 1200, effective_from: D('2027-01-01T06:00:00Z') } },
  la_musa: { c: { bp: 800, effective_from: D('2026-12-01T06:00:00Z') } } };

cell('CR-DEFAULT: an order uses the platform default in effect at its date — the latest entry with effective_from ≤ the date', () => {
  assert.deepStrictEqual(R.rateAt(S, 'x_pizza', D('2026-11-25T00:00:00Z')), { bp: 1000, scope: '_default', key: 'a' });
  assert.deepStrictEqual(R.rateAt(S, 'x_pizza', D('2027-02-01T00:00:00Z')), { bp: 1200, scope: '_default', key: 'b' }, 'a later default entry takes over from its instant');
  assert.deepStrictEqual(R.rateAt(S, 'x_pizza', D('2026-11-20T06:00:00Z')), { bp: 1000, scope: '_default', key: 'a' }, 'effective_from itself is in effect (inclusive)');
});

cell('CR-RESTAURANT: a restaurant\'s own entry in effect wins over the default; before it takes effect the default applies', () => {
  assert.deepStrictEqual(R.rateAt(S, 'la_musa', D('2026-12-05T00:00:00Z')), { bp: 800, scope: 'la_musa', key: 'c' });
  assert.deepStrictEqual(R.rateAt(S, 'la_musa', D('2026-11-25T00:00:00Z')), { bp: 1000, scope: '_default', key: 'a' }, 'before its own entry ⇒ the default');
});

cell('CR-NEVER-RETRO: an order dated BEFORE every entry has no rate (null) — a later entry never re-rates an earlier order', () => {
  assert.strictEqual(R.rateAt(S, 'x_pizza', D('2026-11-19T00:00:00Z')), null);
  assert.strictEqual(R.rateAt({}, 'x_pizza', D('2027-01-01T00:00:00Z')), null, 'no settings ⇒ null');
  assert.strictEqual(R.rateAt(null, 'x_pizza', D('2027-01-01T00:00:00Z')), null);
});

cell('CR-MALFORMED: malformed entries are ignored by the reader (bp outside 0–10000 or not an integer, effective_from not an integer ms ≥ 2026-01-01); a bad rid / date ⇒ null', () => {
  const bad = { _default: { a: { bp: 10001, effective_from: D('2026-11-20T06:00:00Z') }, b: { bp: 9.5, effective_from: D('2026-11-21T06:00:00Z') }, c: { bp: '1000', effective_from: D('2026-11-22T06:00:00Z') },
    d: { bp: 1000, effective_from: 5 }, e: null, f: { bp: 700, effective_from: D('2026-11-01T06:00:00Z') } } };
  assert.deepStrictEqual(R.rateAt(bad, 'x_pizza', D('2026-12-01T00:00:00Z')), { bp: 700, scope: '_default', key: 'f' }, 'only the valid entry counts');
  for (const rid of ['', '_default', 'X/Y', null, 5]) assert.strictEqual(R.rateAt(S, rid, D('2026-12-05T00:00:00Z')), null, `an invalid rid ${JSON.stringify(rid)} (incl. the reserved _default) ⇒ null`);
  for (const at of [undefined, null, NaN, '2026-12-05', 1.5]) assert.strictEqual(R.rateAt(S, 'x_pizza', at), null, `date ${JSON.stringify(at)} ⇒ null`);
});

cell('CR-TIE: two valid entries at the same instant (append refuses it; defensive) ⇒ the greater key, deterministically', () => {
  const t = D('2026-11-20T06:00:00Z');
  assert.strictEqual(R.rateAt({ _default: { k1: { bp: 900, effective_from: t }, k2: { bp: 950, effective_from: t } } }, 'x_pizza', t + 1).key, 'k2');
});
console.log(`commission-rate: OK (${n})`);
