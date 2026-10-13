// Unit test for the flip-prep readiness gate (PLAN-S1 §13/§14). Run: node lib/driver-flip-prep.test.js
const assert = require('node:assert/strict');
const { FLIP_PREP_READY, decideEnforcementWrite } = require('./driver-flip-prep');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ok ${passed} ${name}`); };

t('FLIP_PREP_READY is false in S1a (the §13 reader filtering is deferred to flip-prep)', () => {
  assert.equal(FLIP_PREP_READY, false);
});
t('closed is REFUSED while FLIP_PREP_READY is false (the live default)', () => {
  const d = decideEnforcementWrite('closed');
  assert.equal(d.ok, false);
  assert.match(d.reason, /FLIP_PREP_READY is false/);
});
t('closed is REFUSED with an explicit flipReady=false', () => {
  assert.equal(decideEnforcementWrite('closed', false).ok, false);
});
t('closed is ALLOWED once flipReady=true (writes "closed")', () => {
  assert.deepEqual(decideEnforcementWrite('closed', true), { ok: true, value: 'closed' });
});
t('tolerant is always allowed and REMOVES the key (null = absent = tolerant)', () => {
  assert.deepEqual(decideEnforcementWrite('tolerant'), { ok: true, value: null });
  assert.deepEqual(decideEnforcementWrite('tolerant', true), { ok: true, value: null });
});
t('an unknown mode is refused', () => {
  assert.equal(decideEnforcementWrite('enforce').ok, false);
  assert.equal(decideEnforcementWrite(undefined).ok, false);
});

console.log(`\ndriver-flip-prep: ${passed} tests passed`);
