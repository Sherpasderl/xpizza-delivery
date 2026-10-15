// run: `node onboarding-controller.test.js` (no framework, repo idiom). Exercises the REAL read-once controller
// orchestration (sequencing, async-session safety, submit reconcile, E2 triggers, flag-off) with a fake env.
import assert from 'node:assert/strict';
import { makeCompanionController } from './onboarding-helpers.js';

let passed = 0;
async function t(name, fn) { await fn(); passed++; }
const tick = () => new Promise((r) => setTimeout(r, 0));
const V = (state, enabled, extra = {}) => ({ onboarding_state: state, enabled, ...extra });

// A programmable env. flag/account are functions so a test can vary them per call or defer them.
function makeEnv(over = {}) {
  const calls = { rerender: 0, signOut: 0, teardown: 0 };
  const env = {
    uid: 'A',
    getUid: () => env.uid,
    readFlag: over.readFlag || (async () => true),
    readAccount: over.readAccount || (async () => V('pending', false)),
    submit: over.submit || (async () => ({ ok: true })),
    clearDraft: () => { calls.clearDraft = (calls.clearDraft || 0) + 1; },
    localTeardown: async () => { calls.teardown++; if (over.teardown) await over.teardown(); },
    signOut: async () => { calls.signOut++; if (over.signOut) await over.signOut(); },
    rerender: () => { calls.rerender++; },
  };
  return { env, calls };
}

// ---- flag gate (flag-off = legacy, byte-identical intent) ----
await t('flag false / absent / read-error ⇒ decide() legacy, account never read', async () => {
  for (const f of [async () => false, async () => undefined, async () => { throw new Error('x'); }]) {
    let accountRead = 0;
    const { env } = makeEnv({ readFlag: f, readAccount: async () => { accountRead++; return V('pending', false); } });
    const c = makeCompanionController(env); c.resetSession();
    await c.refresh();
    assert.equal(c.decide().action, 'legacy');
    assert.equal(c._state.flag, false);
    assert.equal(accountRead, 0, 'flag-off must NOT read the account');
  }
});
await t('flag true re-enables on a later read (no persistent watcher) — false → true across two refreshes', async () => {
  let flag = false;
  const { env } = makeEnv({ readFlag: async () => flag, readAccount: async () => V('pending', false) });
  const c = makeCompanionController(env); c.resetSession();
  await c.refresh(); assert.equal(c.decide().action, 'legacy');
  flag = true;
  await c.refresh(); assert.equal(c.decide().action, 'show');
});

// ---- precedence via the controller ----
await t('deactivated read ⇒ decide() deactivate; pending ⇒ onboarding; profile_submitted ⇒ waiting; active&enabled ⇒ legacy(app)', async () => {
  const mk = (acct) => { const { env } = makeEnv({ readAccount: async () => acct }); const c = makeCompanionController(env); c.resetSession(); return c; };
  let c = mk(V('active', true, { deactivated: true })); await c.refresh(); assert.equal(c.decide().action, 'deactivate');
  c = mk(V('pending', false)); await c.refresh(); assert.equal(c.decide().action, 'show'); assert.equal(c.decide().view, 'onboarding');
  c = mk(V('profile_submitted', false)); await c.refresh(); assert.equal(c.decide().view, 'waiting');
  c = mk(V('active', true)); await c.refresh(); const d = c.decide(); assert.equal(d.action, 'legacy'); assert.equal(d.suspended, false);
  c = mk(V('active', false)); await c.refresh(); assert.equal(c.decide().suspended, true);   // suspended overlay
});

// ---- row 1: a transient read error keeps the last valid screen, never a hold/deactivation ----
await t('read error after a valid pending keeps onboarding (last valid), never legacy/deactivate', async () => {
  let mode = 'ok';
  const { env } = makeEnv({ readAccount: async () => { if (mode === 'throw') throw new Error('net'); return V('pending', false); } });
  const c = makeCompanionController(env); c.resetSession();
  await c.refresh(); assert.equal(c.decide().view, 'onboarding');
  mode = 'throw';
  await c.refresh();
  assert.equal(c._state.account.meta, 'error');
  assert.equal(c.decide().view, 'onboarding', 'a blip must not drop the onboarding screen');
});

// ---- NEW-3 async-session safety ----
await t('a previous session’s delayed read is DISCARDED (A logout → B login → A’s read resolves deactivated)', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  let acct = V('pending', false);
  const { env, calls } = makeEnv({ readFlag: async () => true, readAccount: async () => { await gate; return acct; } });
  const c = makeCompanionController(env); c.resetSession();         // session A
  acct = V('active', false, { deactivated: true });                // A’s read will report deactivation
  const pA = c.refresh();                                          // in flight, awaiting the gate
  c.resetSession(); env.uid = 'B';                                 // B logs in
  release(); await pA; await tick();
  assert.equal(c._state.account.meta, 'unresolved', 'A’s result must not land on B');
  assert.notEqual(c.decide().action, 'deactivate', 'A’s deactivation must never sign out B');
});
await t('overlapping refreshes: an older in-flight result cannot overwrite a newer one (coalesce)', async () => {
  const gates = {};
  let which = 'a';
  const { env } = makeEnv({ readFlag: async () => true, readAccount: async () => {
    const key = which;
    return await new Promise((r) => { gates[key] = () => r(key === 'a' ? V('pending', false) : V('profile_submitted', false)); });
  } });
  const c = makeCompanionController(env); c.resetSession();
  which = 'a'; const pa = c.refresh(); await tick();   // A passes readFlag, reaches readAccount (gate a, seq 1)
  which = 'b'; const pb = c.refresh(); await tick();   // B passes readFlag, reaches readAccount (gate b, seq 2)
  gates.b(); await pb;                                  // the newer resolves → profile_submitted applies
  gates.a(); await pa;                                  // the older resolves LATE → its post-read seq check fails → discarded
  assert.equal(c.decide().view, 'waiting', 'the newer (profile_submitted) result wins; the stale pending is dropped');
});

// ---- E2 triggers ----
await t('triggerDeactivate: single-shot local teardown + sign-out; onLogout then routes to E2', async () => {
  const { env, calls } = makeEnv();
  const c = makeCompanionController(env); c.resetSession();
  await c.triggerDeactivate();
  await c.triggerDeactivate();   // second call is a no-op (single-shot)
  assert.equal(calls.teardown, 1); assert.equal(calls.signOut, 1);
  assert.equal(c.onLogout(), true);                 // deactReason set → host shows E2 (not login)
  c.clearDeactReason(); assert.equal(c.onLogout(), false);
});
await t('teardown rejection never blocks sign-out', async () => {
  const { env, calls } = makeEnv({ teardown: async () => { throw new Error('guarded callable rejected'); } });
  const c = makeCompanionController(env); c.resetSession();
  await c.triggerDeactivate();
  assert.equal(calls.signOut, 1, 'sign-out still happens despite teardown rejection');
});
await t('onWriteDenied: a permission-denied write triggers a one-shot refresh ONLY when the flag is on', async () => {
  // flag on
  let reads = 0;
  let { env } = makeEnv({ readFlag: async () => true, readAccount: async () => { reads++; return V('pending', false); } });
  let c = makeCompanionController(env); c.resetSession();
  await c.refresh(); const before = reads;
  await c.onWriteDenied({ code: 'permission-denied' }); await tick();
  assert.equal(reads, before + 1, 'denied write re-reads once');
  // flag off: a denial is ignored
  ({ env } = makeEnv({ readFlag: async () => false, readAccount: async () => { throw new Error('should not read'); } }));
  c = makeCompanionController(env); c.resetSession(); await c.refresh();
  const r = c.onWriteDenied({ code: 'permission-denied' });
  assert.equal(r, undefined);
});

// ---- submit reconciliation ----
await t('submit: ok ⇒ waiting; lost-response(error)+fresh profile_submitted ⇒ waiting; error+fresh pending ⇒ retry; error+read-fail ⇒ recoverable-wait', async () => {
  const run = async ({ submit, readAccount }) => {
    const { env } = makeEnv({ readFlag: async () => true, submit, readAccount });
    const c = makeCompanionController(env); c.resetSession(); c._state.flag = true;
    return c.submit({ name: 'n', phone: 'p', vehicle: 'moto', plate: 'x' });
  };
  assert.equal(await run({ submit: async () => ({ ok: true }), readAccount: async () => V('profile_submitted', false) }), 'waiting');
  assert.equal(await run({ submit: async () => { throw { code: 'failed-precondition', message: '' }; }, readAccount: async () => V('profile_submitted', false) }), 'waiting');
  assert.equal(await run({ submit: async () => { throw { code: 'aborted', message: '' }; }, readAccount: async () => V('pending', false) }), 'retry');
  assert.equal(await run({ submit: async () => { throw { code: 'unavailable', message: '' }; }, readAccount: async () => { throw new Error('read fail'); } }), 'recoverable-wait');
});
await t('submit: a deactivated denial ⇒ outcome deactivated AND teardown+sign-out ran', async () => {
  const { env, calls } = makeEnv({ readFlag: async () => true, submit: async () => { throw { code: 'permission-denied', message: 'Tu cuenta está desactivada.' }; } });
  const c = makeCompanionController(env); c.resetSession(); c._state.flag = true;
  const outcome = await c.submit({ name: 'n' });
  assert.equal(outcome, 'deactivated');
  assert.equal(calls.signOut, 1);
});
await t('a previous session’s submit continuation is DISCARDED under the new session (tag check; submit has no seq guard)', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const { env, calls } = makeEnv({ readFlag: async () => true, submit: async () => { await gate; return { ok: true }; }, readAccount: async () => V('profile_submitted', false) });
  const c = makeCompanionController(env); c.resetSession(); c._state.flag = true;
  const pA = c.submit({ name: 'n' });   // session A, in flight
  c.resetSession();                      // session B logs in before A's callable resolves
  release();
  const outcome = await pA;
  assert.equal(outcome, undefined, 'A’s submit continuation must be discarded under B (the session-tag guard, not the seq guard)');
  assert.equal(calls.signOut, 0);
});
await t('submit is single in-flight (a concurrent call is dropped)', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const { env } = makeEnv({ readFlag: async () => true, submit: async () => { await gate; return { ok: true }; }, readAccount: async () => V('profile_submitted', false) });
  const c = makeCompanionController(env); c.resetSession(); c._state.flag = true;
  const p1 = c.submit({ name: 'n' });
  const p2 = c.submit({ name: 'n' });          // dropped while the first is in flight
  assert.equal(await p2, undefined);
  release(); assert.equal(await p1, 'waiting');
});

// ---- approval transient ----
await t('approval transient: observed profile_submitted→active&enabled gives decide() activated, then consume → legacy(app)', async () => {
  let acct = V('profile_submitted', false);
  const { env } = makeEnv({ readFlag: async () => true, readAccount: async () => acct });
  const c = makeCompanionController(env); c.resetSession();
  await c.refresh(); assert.equal(c.decide().view, 'waiting');
  acct = V('active', true);
  await c.refresh(); assert.equal(c.decide().action, 'activated');
  c.consumeApprovalTransition();
  assert.equal(c.decide().action, 'legacy', 'after consuming, the normal app shows');
});

console.log(`✓ onboarding-controller: ${passed} tests passed`);
