'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decidePrintClaim } = require('../src/print-claim');

const TTL = 60000;
const NOW = 1_000_000;
const OWNER = 'agent-1';

test('claims a fresh unprinted, non-void record', () => {
  const d = decidePrintClaim({ printed: false, void: false }, { owner: OWNER, now: NOW, ttlMs: TTL });
  assert.equal(d.action, 'claim');
  assert.deepEqual(d.nextClaim, { owner: OWNER, claimed_at: NOW, expires_at: NOW + TTL });
});

test('skips an already-printed record', () => {
  const d = decidePrintClaim({ printed: true, void: false }, { owner: OWNER, now: NOW, ttlMs: TTL });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'already_printed');
});

test('skips a voided record', () => {
  const d = decidePrintClaim({ printed: false, void: true }, { owner: OWNER, now: NOW, ttlMs: TTL });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'void');
});

test('skips a record under another agent live claim', () => {
  const rec = { printed: false, void: false, print_claim: { owner: 'agent-2', expires_at: NOW + 5000 } };
  const d = decidePrintClaim(rec, { owner: OWNER, now: NOW, ttlMs: TTL });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'claimed_by_other');
});

test('reclaims a record whose prior claim has expired', () => {
  const rec = { printed: false, void: false, print_claim: { owner: 'agent-2', expires_at: NOW - 1 } };
  const d = decidePrintClaim(rec, { owner: OWNER, now: NOW, ttlMs: TTL });
  assert.equal(d.action, 'claim');
  assert.equal(d.nextClaim.owner, OWNER);
});

test('re-claims its own live claim (idempotent restart)', () => {
  const rec = { printed: false, void: false, print_claim: { owner: OWNER, expires_at: NOW + 5000 } };
  const d = decidePrintClaim(rec, { owner: OWNER, now: NOW, ttlMs: TTL });
  assert.equal(d.action, 'claim');
});

test('skips a null/absent record', () => {
  const d = decidePrintClaim(null, { owner: OWNER, now: NOW, ttlMs: TTL });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'absent');
});
