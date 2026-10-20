'use strict';
// TRACKER FIXES r2.10.1 (C) — driverNameFrom(uid, record) === resolveDriverName(db, uid) over EVERY record shape (codex r2.10 C list).
// resolveDriverName runs for real against an in-memory db whose drivers/{uid} is the record (children of a scalar / missing record
// read as null, as in RTDB). Run: node tracking/driver-name.test.js
const assert = require('assert');
const { resolveDriverName, DRIVER_DISPLAY_NAMES } = require('../driver-attribution');
const { driverNameFrom } = require('./driver-name');

const dbOf = (uid, record) => ({ ref: (p) => ({ once: async () => {
  const [, u, k] = p.split('/');
  const v = u !== uid ? null : (k === undefined ? record : (record && typeof record === 'object' ? record[k] : null));
  return { val: () => (v === undefined ? null : v) };
} }) });
const CANON = Object.keys(DRIVER_DISPLAY_NAMES)[0];
const U = 'u_plain_driver_000000000';
const cases = [
  ['missing (undefined)', U, undefined], ['missing (null)', U, null],
  ['scalar string', U, 'ana'], ['scalar number', U, 7], ['scalar true', U, true],
  ['empty object', U, {}],
  ['display_name wins', U, { display_name: 'Ana María', name: 'zzz' }],
  ['empty display_name → name', U, { display_name: '', name: 'beto' }],
  ['whitespace display_name returned as-is (no trim)', U, { display_name: '   ', name: 'beto' }],
  ['whitespace name capitalised as-is', U, { name: '  carlos' }],
  ['numeric display_name → string name fallback', U, { display_name: 42, name: 'dora' }],
  ['object display_name → name', U, { display_name: { x: 1 }, name: 'eva' }],
  ['numeric name, no display', U, { name: 5 }],
  ['empty name', U, { name: '' }],
  ['capitalization: all caps', U, { name: 'FERNANDO' }],
  ['capitalization: mixed', U, { name: 'gUiLlErMo' }],
  ['capitalization: one char', U, { name: 'h' }],
  ['unicode first char', U, { name: 'ñandu' }],
  ['canonical override beats display_name', CANON, { display_name: 'Other', name: 'other' }],
  ['canonical override with a missing record', CANON, null],
  ['no uid', null, { name: 'x' }], ['empty uid', '', { name: 'x' }],
];
(async () => {
  for (const [label, uid, record] of cases) {
    const want = await resolveDriverName(dbOf(uid, record), uid);
    assert.strictEqual(driverNameFrom(uid, record), want, `${label}: ${JSON.stringify(record)} → ${JSON.stringify(want)}`);
  }
  console.log(`  ✓ 1 driverNameFrom == resolveDriverName over ${cases.length} record shapes (missing / scalar / empty / whitespace (no trim) / non-string with fallback / canonical override / capitalization)`);
  console.log('driver-name: OK (1)');
})().catch((e) => { console.error('driver-name: FAIL\n', e); process.exit(1); });
