'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decideReserve } = require('../src/allocate');

// decideReserve(seq, opts) is the PURE core of the RTDB sequence transaction:
//   seq = { last_reserved, pending: { orderId: number } }  (or null if unseeded)
// It advances a single monotonic high-water (last_reserved) AND records pending[orderId]
// in one step, so concurrent reservations can never take the same number (ADR-0003).
// Dates are ISO 'YYYY-MM-DD' so lexical compare == chronological compare (Codex #14).

const base = { rangeStart: 1, rangeEnd: 8000, todayISO: '2026-06-25', fechaLimiteISO: '2026-11-20' };

test('first reservation takes range_start and records the pending entry', () => {
  const seq = { last_reserved: 0, pending: {} };
  const d = decideReserve(seq, { ...base, orderId: 'A' });
  assert.equal(d.action, 'commit');
  assert.equal(d.reserved, 1);
  assert.deepEqual(d.nextSeq, { last_reserved: 1, pending: { A: 1 } });
});

test('two sequential reservations get distinct consecutive numbers', () => {
  const d1 = decideReserve({ last_reserved: 0, pending: {} }, { ...base, orderId: 'A' });
  const d2 = decideReserve(d1.nextSeq, { ...base, orderId: 'B' });
  assert.equal(d1.reserved, 1);
  assert.equal(d2.reserved, 2);
  assert.deepEqual(d2.nextSeq.pending, { A: 1, B: 2 });
});

test('re-running for an order already pending is idempotent (no new number)', () => {
  const seq = { last_reserved: 5, pending: { A: 3 } };
  const d = decideReserve(seq, { ...base, orderId: 'A' });
  assert.equal(d.action, 'idempotent');
  assert.equal(d.reserved, 3);
  assert.equal(d.nextSeq, undefined); // no write
});

test('fail-closed when the next number would exceed range_end', () => {
  const seq = { last_reserved: 8000, pending: {} };
  const d = decideReserve(seq, { ...base, orderId: 'A' });
  assert.equal(d.action, 'abort');
  assert.equal(d.reason, 'range_exhausted');
  assert.equal(d.reserved, null);
});

test('fail-closed when today is past fecha_limite', () => {
  const seq = { last_reserved: 10, pending: {} };
  const d = decideReserve(seq, { ...base, orderId: 'A', todayISO: '2026-11-21' });
  assert.equal(d.action, 'abort');
  assert.equal(d.reason, 'expired');
});

test('reservation on the exact fecha_limite day is still allowed', () => {
  const seq = { last_reserved: 10, pending: {} };
  const d = decideReserve(seq, { ...base, orderId: 'A', todayISO: '2026-11-20' });
  assert.equal(d.action, 'commit');
});

test('fail-closed when config node is missing (null seq)', () => {
  const d = decideReserve(null, { ...base, orderId: 'A' });
  assert.equal(d.action, 'abort');
  assert.equal(d.reason, 'config_missing');
});

test('last allowed number (range_end) is reservable', () => {
  const seq = { last_reserved: 7999, pending: {} };
  const d = decideReserve(seq, { ...base, orderId: 'Z' });
  assert.equal(d.action, 'commit');
  assert.equal(d.reserved, 8000);
});
