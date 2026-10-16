// run: `node onboarding-helpers.test.js` (no framework, repo idiom). Pure S1b-companion decision logic.
import assert from 'node:assert/strict';
import {
  classifyAccount, companionDecision, isApprovalTransition,
  classifySubmitOutcome, isDeactivatedDenial, sessionCurrent, isLatestRefresh,
} from './onboarding-helpers.js';

let passed = 0;
function t(name, fn) { fn(); passed++; }

// ---- classifyAccount ----
t('classify: valid records (pending / profile_submitted / active+enabled / active+disabled / deactivated)', () => {
  assert.deepEqual(classifyAccount({ onboarding_state: 'pending', enabled: false }), { meta: 'valid', deactivated: false, enabled: false, state: 'pending' });
  assert.deepEqual(classifyAccount({ onboarding_state: 'profile_submitted', enabled: false }), { meta: 'valid', deactivated: false, enabled: false, state: 'profile_submitted' });
  assert.deepEqual(classifyAccount({ onboarding_state: 'active', enabled: true }), { meta: 'valid', deactivated: false, enabled: true, state: 'active' });
  assert.deepEqual(classifyAccount({ onboarding_state: 'active', enabled: false }), { meta: 'valid', deactivated: false, enabled: false, state: 'active' });
  assert.equal(classifyAccount({ onboarding_state: 'active', enabled: true, deactivated: true }).deactivated, true);
});
t('classify: missing (null/undefined) vs malformed (non-object / array / unknown state / non-bool enabled)', () => {
  assert.equal(classifyAccount(null).meta, 'missing');
  assert.equal(classifyAccount(undefined).meta, 'missing');
  assert.equal(classifyAccount('x').meta, 'malformed');
  assert.equal(classifyAccount([]).meta, 'malformed');
  assert.equal(classifyAccount({ onboarding_state: 'bogus', enabled: true }).meta, 'malformed');
  assert.equal(classifyAccount({ onboarding_state: 'void', enabled: true }).meta, 'valid');   // void is a KNOWN state
  assert.equal(classifyAccount({ onboarding_state: 'active' }).meta, 'malformed');             // enabled missing, not deactivated
  assert.equal(classifyAccount({ onboarding_state: 'active', deactivated: true }).meta, 'valid'); // deactivated needs no enabled
});
t('classify: deactivated is STRICT true, not truthy (catches a truthiness mutant)', () => {
  assert.equal(classifyAccount({ onboarding_state: 'active', enabled: true, deactivated: 1 }).deactivated, false);
  assert.equal(classifyAccount({ onboarding_state: 'active', enabled: true, deactivated: 'true' }).deactivated, false);
  assert.equal(classifyAccount({ onboarding_state: 'active', enabled: true, deactivated: 0 }).deactivated, false);
});

// ---- companionDecision (the §3 precedence) ----
const V = (state, enabled, deactivated = false) => ({ meta: 'valid', state, enabled, deactivated });
t('decision: flag !== true is always legacy (inert), whatever the account says', () => {
  assert.equal(companionDecision(false, V('active', true)), 'legacy');
  assert.equal(companionDecision(null, V('active', false, true)), 'legacy');   // even a deactivated record
  assert.equal(companionDecision(undefined, { meta: 'missing' }), 'legacy');
  assert.equal(companionDecision('true', V('pending', false)), 'legacy');      // strict: the string "true" is NOT enabled
});
t('decision: unresolved / error → legacy (never a hold, never deactivation)', () => {
  assert.equal(companionDecision(true, { meta: 'unresolved' }), 'legacy');
  assert.equal(companionDecision(true, { meta: 'error' }), 'legacy');
});
t('decision: missing / malformed / void → neutral-hold (never destructive)', () => {
  assert.equal(companionDecision(true, { meta: 'missing' }), 'neutral-hold');
  assert.equal(companionDecision(true, { meta: 'malformed' }), 'neutral-hold');
  assert.equal(companionDecision(true, V('void', false)), 'neutral-hold');
});
t('decision: deactemphasis — deactivated WINS over enabled/active (catches deactivated→!enabled and truthiness mutants)', () => {
  assert.equal(companionDecision(true, V('active', true, true)), 'deactivated');   // enabled+active but deactivated
  assert.equal(companionDecision(true, V('active', false, false)), 'suspended');   // !enabled but NOT deactivated → suspended, NOT deactivated
  assert.equal(companionDecision(true, V('pending', false, true)), 'deactivated'); // deactivated during onboarding still signs out
});
t('decision: the onboarding/waiting/app rows', () => {
  assert.equal(companionDecision(true, V('pending', false)), 'onboarding');
  assert.equal(companionDecision(true, V('profile_submitted', false)), 'waiting');
  assert.equal(companionDecision(true, V('active', true)), 'app');
});

// ---- isApprovalTransition ----
t('approval transient: only observed profile_submitted → active&&enabled; not initial load, not suspension removal', () => {
  assert.equal(isApprovalTransition(V('profile_submitted', false), V('active', true)), true);
  assert.equal(isApprovalTransition(null, V('active', true)), false);                      // initial load of an active account
  assert.equal(isApprovalTransition(V('active', false), V('active', true)), false);        // suspension removal is NOT the transient
  assert.equal(isApprovalTransition(V('profile_submitted', false), V('active', false)), false); // approved but not enabled yet
  assert.equal(isApprovalTransition({ meta: 'error' }, V('active', true)), false);
});

// ---- classifySubmitOutcome (simplified — no account read; any later read decides) ----
t('submit outcome: ok → ok; an explicit deactivation message → deactivated (E2, no sign-out)', () => {
  assert.equal(classifySubmitOutcome(true, null, null), 'ok');
  assert.equal(classifySubmitOutcome(false, 'functions/permission-denied', 'Tu cuenta está desactivada.'), 'deactivated');
  assert.equal(classifySubmitOutcome(false, 'permission-denied', 'Tu cuenta está desactivada.'), 'deactivated');   // bare too
});
t('submit outcome: real functions/ error codes map correctly', () => {
  assert.equal(classifySubmitOutcome(false, 'functions/invalid-argument', 'bad'), 'field-error');
  assert.equal(classifySubmitOutcome(false, 'functions/permission-denied', 'Tu sesión expiró.'), 'reauth');   // non-deactivation denial
  assert.equal(classifySubmitOutcome(false, 'functions/unauthenticated', ''), 'reauth');
  assert.equal(classifySubmitOutcome(false, 'functions/unavailable', ''), 'error');
  assert.equal(classifySubmitOutcome(false, 'functions/deadline-exceeded', ''), 'error');
});

// ---- isDeactivatedDenial ----
t('deactivated denial: only permission-denied + the desactivada message; a generic denial never implies it', () => {
  assert.equal(isDeactivatedDenial('permission-denied', 'Tu cuenta está desactivada.'), true);
  assert.equal(isDeactivatedDenial('permission-denied', 'Tu sesión expiró.'), false);
  assert.equal(isDeactivatedDenial('failed-precondition', 'Tu cuenta está desactivada.'), false);
  assert.equal(isDeactivatedDenial('permission-denied', ''), false);
});

// ---- async-session safety ----
t('session/refresh guards', () => {
  const tag = {};
  assert.equal(sessionCurrent(tag, tag), true);
  assert.equal(sessionCurrent(tag, {}), false);
  assert.equal(sessionCurrent(null, null), false);   // null is never "current"
  assert.equal(isLatestRefresh(3, 3), true);
  assert.equal(isLatestRefresh(2, 3), false);
});

console.log(`✓ onboarding-helpers: ${passed} tests passed`);
