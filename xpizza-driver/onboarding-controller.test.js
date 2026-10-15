// run: `node onboarding-controller.test.js` (no framework, repo idiom). Exercises the REAL read-once controller
// orchestration (boot barrier, flag deadline, async-session safety, submit reconcile + barrier, E2 triggers,
// flag-off) with a fake env. Callable fakes use REAL Firebase error codes (functions/…).
import assert from 'node:assert/strict';
import { makeCompanionController } from './onboarding-helpers.js';

let passed = 0;
async function t(name, fn) { try { await fn(); } catch (e) { console.error(`✗ ${name}`); throw e; } passed++; }
const tick = () => new Promise((r) => setTimeout(r, 0));
const V = (state, enabled, extra = {}) => ({ onboarding_state: state, enabled, ...extra });

function makeEnv(over = {}) {
  const calls = { rerender: 0, signOut: 0, teardown: 0, clearDraft: 0 };
  const env = {
    uid: 'A',
    bootDone: true,
    getUid: () => env.uid,
    readFlag: over.readFlag || (async () => true),
    readAccount: over.readAccount || (async () => V('pending', false)),
    submit: over.submit || (async () => ({ ok: true })),
    clearDraft: () => { calls.clearDraft++; },
    localTeardown: async () => { calls.teardown++; if (over.teardown) await over.teardown(); },
    signOut: async () => { calls.signOut++; if (over.signOut) await over.signOut(); },
    bootSettled: over.bootSettled || (async () => { /* settled by default */ }),
    rerender: () => { calls.rerender++; },
    flagDeadlineMs: over.flagDeadlineMs || 50,
  };
  return { env, calls };
}
const mk = (over) => { const { env, calls } = makeEnv(over); const c = makeCompanionController(env); c.resetSession(); return { c, env, calls }; };

(async () => {
  // ---- flag gate / flag-off (P1-5) ----
  await t('flag false / absent / read-error / read-timeout ⇒ legacy; account never read', async () => {
    for (const f of [async () => false, async () => undefined, async () => { throw new Error('x'); }, () => new Promise(() => {})/*hang→deadline*/]) {
      let reads = 0;
      const { c } = mk({ readFlag: f, readAccount: async () => { reads++; return V('pending', false); }, flagDeadlineMs: 20 });
      await c.refresh();
      assert.equal(c.decide().action, 'legacy');
      assert.equal(c._state.flag, false);
      assert.equal(reads, 0, 'flag-off/undetermined must not read the account');
    }
  });
  await t('flag false→true across two refreshes re-enables (no persistent watcher)', async () => {
    let flag = false;
    const { c } = mk({ readFlag: async () => flag });
    await c.refresh(); assert.equal(c.decide().action, 'legacy');
    flag = true; await c.refresh(); assert.equal(c.decide().action, 'show');
  });

  // ---- precedence ----
  await t('precedence: deactivated/pending/profile_submitted/active/suspended/void', async () => {
    let a = mk({ readAccount: async () => V('active', true, { deactivated: true }) }); await a.c.refresh(); assert.equal(a.c.decide().action, 'deactivate');
    a = mk({ readAccount: async () => V('pending', false) }); await a.c.refresh(); assert.equal(a.c.decide().view, 'onboarding');
    a = mk({ readAccount: async () => V('profile_submitted', false) }); await a.c.refresh(); assert.equal(a.c.decide().view, 'waiting');
    a = mk({ readAccount: async () => V('active', true) }); await a.c.refresh(); assert.equal(a.c.decide().action, 'legacy'); assert.equal(a.c.decide().suspended, false);
    a = mk({ readAccount: async () => V('active', false) }); await a.c.refresh(); assert.equal(a.c.decide().suspended, true);
    a = mk({ readAccount: async () => V('void', false) }); await a.c.refresh(); assert.equal(a.c.decide().view, 'neutral-hold');
  });
  await t('row-1: a read error after a valid pending keeps onboarding (last valid), never a hold/deactivate', async () => {
    let mode = 'ok';
    const { c } = mk({ readAccount: async () => { if (mode === 'throw') throw new Error('net'); return V('pending', false); } });
    await c.refresh(); assert.equal(c.decide().view, 'onboarding');
    mode = 'throw'; await c.refresh();
    assert.equal(c._state.account.meta, 'error');
    assert.equal(c.decide().view, 'onboarding');
  });

  // ---- P1-1 boot barrier ----
  await t('refresh waits for bootSettled; a resume refresh during a pending boot does not act early', async () => {
    let release; const booted = new Promise((r) => { release = r; });
    let acct = V('active', false, { deactivated: true });
    const { c, calls } = mk({ bootSettled: () => booted, readAccount: async () => acct });
    const p = c.refresh();            // a resume/reconnect refresh fired while boot is still pending
    await tick();
    assert.equal(c._state.account.meta, 'unresolved', 'must not read/act before boot settles');
    assert.equal(calls.rerender, 0);
    release(); await p;               // boot settles (even on a deactivated account) → now it acts
    assert.equal(c.decide().action, 'deactivate');
  });
  await t('boot barrier that REJECTS still lets the companion read (deactivated persisted session reaches E2)', async () => {
    const { c } = mk({ bootSettled: async () => { throw new Error('ensureDriverProfile failed'); }, readAccount: async () => V('active', false, { deactivated: true }) });
    await c.refresh();
    assert.equal(c.decide().action, 'deactivate', 'a failed boot must not stop E2');
  });

  // ---- P1-2 / NEW-3 async-session safety ----
  await t('a previous session refresh result is discarded (A read deactivated lands AFTER B login)', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    let acct = V('pending', false);
    const { c, env } = mk({ readAccount: async () => { await gate; return acct; } });
    acct = V('active', false, { deactivated: true });
    const pA = c.refresh();
    c.resetSession(); env.uid = 'B';
    release(); await pA; await tick();
    assert.equal(c._state.account.meta, 'unresolved', 'A result must not land on B');
    assert.notEqual(c.decide().action, 'deactivate');
  });
  await t('triggerDeactivate is session+flag guarded: a stale teardown never signs out B', async () => {
    let release; const td = new Promise((r) => { release = r; });
    const { c, env, calls } = mk({ teardown: () => td });
    c._state.flag = true;
    const pA = c.triggerDeactivate();   // session A
    c.resetSession(); env.uid = 'B';    // B logs in during A's teardown (resetSession clears tornDown+deactReason)
    release(); await pA;
    assert.equal(calls.signOut, 0, 'A must not sign out B');
    assert.equal(c.onLogout(), false, 'B has no deactivation reason');
  });
  await t('triggerDeactivate: single-shot; flag-guarded (no sign-out under flag-off)', async () => {
    const { c, calls } = mk();
    c._state.flag = true;
    await c.triggerDeactivate(); await c.triggerDeactivate();
    assert.equal(calls.teardown, 1); assert.equal(calls.signOut, 1);
    assert.equal(c.onLogout(), true);
    // flag off → never signs out
    const b = mk(); b.c._state.flag = false;
    await b.c.triggerDeactivate();
    assert.equal(b.calls.signOut, 0);
  });
  await t('teardown rejection never blocks sign-out', async () => {
    const { c, calls } = mk({ teardown: async () => { throw new Error('guarded reject'); } });
    c._state.flag = true;
    await c.triggerDeactivate();
    assert.equal(calls.signOut, 1);
  });

  // ---- P1-3 real Firebase error codes ----
  await t('submit maps REAL functions/ codes: deactivated→E2, invalid-argument→field-error, non-deactivation permission-denied→reauth', async () => {
    const run = async (over) => { const { c } = mk({ readFlag: async () => true, ...over }); c._state.flag = true; return c.submit({ name: 'n' }); };
    assert.equal(await run({ submit: async () => { throw { code: 'functions/permission-denied', message: 'Tu cuenta está desactivada.' }; } }), 'deactivated');
    assert.equal(await run({ submit: async () => { throw { code: 'functions/invalid-argument', message: 'bad' }; } }), 'field-error');
    assert.equal(await run({ submit: async () => { throw { code: 'functions/permission-denied', message: 'Tu sesión expiró.' }; } }), 'reauth');
  });

  // ---- P1-6 submit shares ONE ordering (S.seq) ----
  await t('a refresh that supersedes an in-flight submit discards the submit (one ordering)', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const { c } = mk({ readFlag: async () => true, submit: async () => { await gate; return { ok: true }; }, readAccount: async () => V('profile_submitted', false) });
    c._state.flag = true;
    const pS = c.submit({ name: 'n' });   // bumps seq
    await tick();
    await c.refresh();                     // a newer refresh bumps seq again → supersedes the submit
    release();
    assert.equal(await pS, undefined, 'the superseded submit is dropped');
  });
  await t('an older refresh cannot overwrite a newer one (coalesce)', async () => {
    const gates = {}; let which = 'a';
    const { c } = mk({ readFlag: async () => true, readAccount: async () => { const k = which; return new Promise((r) => { gates[k] = () => r(k === 'a' ? V('pending', false) : V('profile_submitted', false)); }); } });
    which = 'a'; const pa = c.refresh(); await tick();
    which = 'b'; const pb = c.refresh(); await tick();
    gates.b(); await pb; gates.a(); await pa;
    assert.equal(c.decide().view, 'waiting');
  });

  // ---- P1-7 submit barrier / acknowledge immediately ----
  await t('submit acknowledges success IMMEDIATELY as waiting, before the confirming read', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const { c } = mk({ readFlag: async () => true, submit: async () => ({ ok: true }), readAccount: async () => { await gate; return V('pending', false); } });
    c._state.flag = true;
    const p = c.submit({ name: 'n' });
    await tick();
    assert.equal(c.decide().view, 'waiting', 'waiting shows before the (stalled) read resolves');
    release(); await p;
  });
  await t('the submit barrier persists across an ordinary render (pending + submitState=waiting ⇒ waiting, not the checklist)', async () => {
    const { c } = mk({ readFlag: async () => true, submit: async () => ({ ok: true }), readAccount: async () => V('pending', false) });
    c._state.flag = true;
    await c.submit({ name: 'n' });                 // server still shows pending (lost-response style)
    assert.equal(c.decide().view, 'waiting');      // an ordinary render still shows waiting, not onboarding
  });
  await t('submit error reconciles from the FRESH read: profile_submitted→waiting, pending→retry(onboarding), read-fail→recoverable-wait', async () => {
    const run = async (over) => { const { c } = mk({ readFlag: async () => true, ...over }); c._state.flag = true; const o = await c.submit({ name: 'n' }); return { o, c }; };
    let r = await run({ submit: async () => { throw { code: 'functions/failed-precondition', message: '' }; }, readAccount: async () => V('profile_submitted', false) });
    assert.equal(r.o, 'waiting');
    r = await run({ submit: async () => { throw { code: 'functions/aborted', message: '' }; }, readAccount: async () => V('pending', false) });
    assert.equal(r.o, 'retry'); assert.equal(r.c.decide().view, 'onboarding', 'retry lets the driver resubmit');
    r = await run({ submit: async () => { throw { code: 'functions/unavailable', message: '' }; }, readAccount: async () => { throw new Error('read fail'); } });
    assert.equal(r.o, 'recoverable-wait'); assert.equal(r.c.decide().view, 'waiting');
  });

  // ---- P1-5 flag-off mid-submit never signs out ----
  await t('flag flips off mid-submit ⇒ no sign-out, barrier cleared (P1-5)', async () => {
    const { c, calls } = mk({ readFlag: async () => true, submit: async () => { throw { code: 'functions/permission-denied', message: 'Tu cuenta está desactivada.' }; }, readAccount: async () => V('active', false, { deactivated: true }) });
    c._state.flag = true;
    const p = c.submit({ name: 'n' });
    c._state.flag = false;          // a concurrent refresh flipped the flag off
    const o = await p;
    assert.equal(o, 'flag-off');
    assert.equal(calls.signOut, 0, 'must never sign out under flag-off');
  });

  // ---- single in-flight + A→B submit ----
  await t('submit is single in-flight; a previous session submit is discarded without touching B state', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const { c, env, calls } = mk({ readFlag: async () => true, submit: async () => { await gate; return { ok: true }; }, readAccount: async () => V('profile_submitted', false) });
    c._state.flag = true;
    const p1 = c.submit({ name: 'n' });   // session A, seq → 1
    const p2 = c.submit({ name: 'n' });   // dropped (in-flight)
    assert.equal(await p2, undefined);
    c.resetSession(); env.uid = 'B';      // B logs in (tag changes, seq resets to 0)
    await c.refresh();                     // B does an op → seq → 1 again (COLLIDES with A's captured seq): now ONLY the tag guard discriminates
    release();
    assert.equal(await p1, undefined, 'A discarded under B by the session TAG even though the seq collides');
    assert.equal(calls.signOut, 0);
  });

  // ---- onWriteDenied ----
  await t('onWriteDenied: permission-denied triggers one re-read only when flag on', async () => {
    let reads = 0;
    let s = mk({ readFlag: async () => true, readAccount: async () => { reads++; return V('pending', false); } });
    await s.c.refresh(); const before = reads;
    await s.c.onWriteDenied({ code: 'permission_denied' }); await tick();
    assert.equal(reads, before + 1);
    s = mk({ readFlag: async () => false, readAccount: async () => { throw new Error('nope'); } });
    await s.c.refresh();
    assert.equal(s.c.onWriteDenied({ code: 'permission-denied' }), undefined);
  });

  // ---- approval transient ----
  await t('approval transient only on observed profile_submitted→active&enabled, consumed once', async () => {
    let acct = V('profile_submitted', false);
    const { c } = mk({ readFlag: async () => true, readAccount: async () => acct });
    await c.refresh(); assert.equal(c.decide().view, 'waiting');
    acct = V('active', true); await c.refresh(); assert.equal(c.decide().action, 'activated');
    c.consumeApprovalTransition(); assert.equal(c.decide().action, 'legacy');
  });

  // ---- P2-10 resetSession clears deactReason + submit barrier ----
  await t('resetSession clears deactReason and the submit barrier', async () => {
    const { c } = mk();
    c._state.flag = true; await c.triggerDeactivate(); assert.equal(c.onLogout(), true);
    c._state.submitState = 'waiting';
    c.resetSession();
    assert.equal(c.onLogout(), false);
    assert.equal(c._state.submitState, null);
  });

  console.log(`✓ onboarding-controller: ${passed} tests passed`);
})().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
