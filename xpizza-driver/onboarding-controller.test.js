// run: `node onboarding-controller.test.js` (no framework, repo idiom). Executes the REAL simplified read-once
// controller (no auto sign-out, no submit barrier, no write-denied re-read) with a fake env. Callable fakes use
// REAL Firebase error codes (functions/…).
import assert from 'node:assert/strict';
import { makeCompanionController } from './onboarding-helpers.js';

let passed = 0;
async function t(name, fn) { try { await fn(); } catch (e) { console.error(`✗ ${name}`); throw e; } passed++; }
const tick = () => new Promise((r) => setTimeout(r, 0));
const V = (state, enabled, extra = {}) => ({ onboarding_state: state, enabled, ...extra });

function makeEnv(over = {}) {
  const calls = { rerender: 0, clearDraft: 0 };
  const env = {
    uid: 'A',
    getUid: () => env.uid,
    readFlag: over.readFlag || (async () => true),
    readAccount: over.readAccount || (async () => V('pending', false)),
    submit: over.submit || (async () => ({ ok: true })),
    clearDraft: () => { calls.clearDraft++; },
    bootSettled: over.bootSettled || (async () => {}),
    rerender: () => { calls.rerender++; },
    flagDeadlineMs: over.flagDeadlineMs || 50,
  };
  return { env, calls };
}
const mk = (over) => { const { env, calls } = makeEnv(over); const c = makeCompanionController(env); c.resetSession(); return { c, env, calls }; };

(async () => {
  // ---- flag gate ----
  await t('flag false / absent / read-error / read-timeout ⇒ legacy; account never read', async () => {
    for (const f of [async () => false, async () => undefined, async () => { throw new Error('x'); }, () => new Promise(() => {})]) {
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
  await t('precedence: deactivated→deactivate(SHOW E2); pending→onboarding; profile_submitted→waiting; active→legacy/suspended; void→neutral-hold', async () => {
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

  // ---- boot barrier (P1-1) ----
  await t('refresh waits for bootSettled; a resume refresh during a pending boot does not act early', async () => {
    let release; const booted = new Promise((r) => { release = r; });
    const { c, calls } = mk({ bootSettled: () => booted, readAccount: async () => V('active', false, { deactivated: true }) });
    const p = c.refresh();
    await tick();
    assert.equal(c._state.account.meta, 'unresolved', 'must not read/act before boot settles');
    assert.equal(calls.rerender, 0);
    release(); await p;
    assert.equal(c.decide().action, 'deactivate');
  });
  await t('a boot barrier that REJECTS still lets the companion read (deactivated persisted session reaches E2)', async () => {
    const { c } = mk({ bootSettled: async () => { throw new Error('ensureDriverProfile failed'); }, readAccount: async () => V('active', false, { deactivated: true }) });
    await c.refresh();
    assert.equal(c.decide().action, 'deactivate');
  });

  // ---- async-session safety for READS ----
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
  await t('an older in-flight refresh cannot overwrite a newer one (coalesce)', async () => {
    const gates = {}; let which = 'a';
    const { c } = mk({ readFlag: async () => true, readAccount: async () => { const k = which; return new Promise((r) => { gates[k] = () => r(k === 'a' ? V('pending', false) : V('profile_submitted', false)); }); } });
    which = 'a'; const pa = c.refresh(); await tick();
    which = 'b'; const pb = c.refresh(); await tick();
    gates.b(); await pb; gates.a(); await pa;
    assert.equal(c.decide().view, 'waiting');
  });

  // ---- submit (simplified: outcome mapping; one in-flight; no auto sign-out) ----
  await t('submit: success → ok; explicit deactivation message → deactivated; real functions/ error mappings', async () => {
    const run = async (over) => { const { c } = mk(over); return c.submit({ name: 'n' }); };
    assert.equal(await run({ submit: async () => ({ ok: true }) }), 'ok');
    assert.equal(await run({ submit: async () => { throw { code: 'functions/permission-denied', message: 'Tu cuenta está desactivada.' }; } }), 'deactivated');
    assert.equal(await run({ submit: async () => { throw { code: 'functions/invalid-argument', message: '' }; } }), 'field-error');
    assert.equal(await run({ submit: async () => { throw { code: 'functions/permission-denied', message: 'Tu sesión expiró.' }; } }), 'reauth');
    assert.equal(await run({ submit: async () => { throw { code: 'functions/unavailable', message: '' }; } }), 'error');
  });
  await t('submit is single in-flight; a previous session submit is discarded without touching B state', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const { c, env } = mk({ submit: async () => { await gate; return { ok: true }; } });
    const p1 = c.submit({ name: 'n' });
    assert.equal(await c.submit({ name: 'n' }), undefined, 'second concurrent submit dropped');
    c.resetSession(); env.uid = 'B';   // B logs in while A's callable is in flight
    release();
    assert.equal(await p1, undefined, 'A discarded under B (never applied to B)');
    assert.equal(c._state.submitInFlight, false, 'B submitInFlight untouched by A');
  });

  // ---- approval transient ----
  await t('approval transient only on observed profile_submitted→active&enabled, consumed once', async () => {
    let acct = V('profile_submitted', false);
    const { c } = mk({ readAccount: async () => acct });
    await c.refresh(); assert.equal(c.decide().view, 'waiting');
    acct = V('active', true); await c.refresh(); assert.equal(c.decide().action, 'activated');
    c.consumeApprovalTransition(); assert.equal(c.decide().action, 'legacy');
  });

  // ---- resetSession ----
  await t('resetSession clears flag/account/session', async () => {
    const { c } = mk();
    await c.refresh(); assert.equal(c._state.flag, true);
    c.resetSession();
    assert.equal(c._state.flag, null);
    assert.equal(c._state.account.meta, 'unresolved');
    assert.equal(c.decide().action, 'legacy');
  });

  console.log(`✓ onboarding-controller: ${passed} tests passed`);
})().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
