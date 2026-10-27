// postact-route.test.js — the Inicio (b) post-activation checklist routing, the 4 owner-named paths + suspended.
// Run: `node postact-route.test.js`
import assert from 'node:assert/strict';
import { postActRoute } from './postact-route.js';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; };

// 1. Legacy already-active driver with NO device flag (everyone on upgrade) → straight to the app.
t('legacy active, no flag → app (never the checklist)', () => {
  const r = postActRoute(true, 'legacy', false);
  assert.equal(r.showChecklist, false, 'an already-active driver must NOT be pushed into the checklist');
  assert.equal(r.setPending, false, 'no flag is written for a legacy (non-transition) render');
});

// 2. Fresh approval OBSERVED on this device → set the flag + show the checklist.
t('fresh activation (observed transition) → set flag + checklist', () => {
  const r = postActRoute(true, 'activated', false);
  assert.equal(r.setPending, true, 'the device checklist-pending flag is set on the observed transition');
  assert.equal(r.showChecklist, true, 'the checklist shows at activation');
});

// 3. Re-open before «Terminar» (flag still set, no new transition) → checklist again.
t('re-open before Terminar (flag set) → checklist', () => {
  const r = postActRoute(true, 'legacy', true);
  assert.equal(r.showChecklist, true, 'the checklist persists across re-opens until Terminar');
  assert.equal(r.setPending, false, 'no re-set on a plain re-open');
});

// 4. After «Terminar» cleared the flag → app.
t('after Terminar (flag cleared) → app', () => {
  const r = postActRoute(true, 'legacy', false);
  assert.equal(r.showChecklist, false, 'once Terminar clears the flag the driver goes to the app');
});

// A suspended account (activeEnabled false) never lands in the checklist, even if a stale flag exists.
t('suspended (not active&&enabled) → never checklist, even with a stale flag', () => {
  assert.equal(postActRoute(false, 'legacy', true).showChecklist, false);
  assert.equal(postActRoute(false, 'activated', false).setPending, false, 'no flag set while not active&&enabled');
});

// Flag set is gated on the transition, not merely on being active (prevents re-flagging on every active render).
t('active + legacy + no flag never sets the flag', () => {
  assert.equal(postActRoute(true, 'legacy', false).setPending, false);
});

console.log(`✓ postact-route: ${passed} tests passed`);
