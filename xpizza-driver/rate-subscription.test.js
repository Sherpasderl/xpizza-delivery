// rate-subscription.test.js — the platform-rate subscription lifecycle (subscribeDriverRate / unsubscribeDriverRate),
// lifted REAL from index.html's module script and driven with a fake fbOnValue that counts live listeners and captures
// the onNext / onError callbacks. Covers the review fixes (2f, advisor-requested alongside STOP 5):
//   (1) the error/cancel callback re-renders — an amount already on screen is dropped, not left stale;
//   (2) idempotence / teardown — one listener across a double boot, and zero listeners after sign-out, matching the
//       feed's disposeDriverFeed lifecycle (unsubscribeDriverRate is called from the auth-transition teardown).
// Run: `node rate-subscription.test.js`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, 'index.html'), 'utf8');
const SCRIPT = SRC.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
function liftFn(name) {
  let start = SCRIPT.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  if (SCRIPT.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0, seen = false;
  for (let i = start; i < SCRIPT.length; i++) {
    if (SCRIPT[i] === '{') { depth++; seen = true; }
    else if (SCRIPT[i] === '}') { depth--; if (seen && depth === 0) return SCRIPT.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

// A harness that mounts the REAL subscribeDriverRate + unsubscribeDriverRate over module vars (driverRateEntries,
// driverRateUnsub) with injected deps. The fake fbOnValue mirrors Firebase onValue: it returns an unsubscribe that
// removes exactly one live listener, and it captures the onNext / onError the function passes so the test can fire them.
function mount({ seedEntries = null } = {}) {
  const env = { live: 0, onValueCalls: 0, render: 0, refresh: 0, onNext: null, onError: null };
  const fbOnValue = (ref, onNext, onError) => {
    env.onValueCalls += 1; env.live += 1; env.onNext = onNext; env.onError = onError;
    let alive = true;
    return () => { if (alive) { alive = false; env.live -= 1; } };   // idempotent unsub (Firebase's returned fn)
  };
  const fbRef = (db, path) => ({ db, path });
  const XPD = { getDb: () => ({}) };
  const render = () => { env.render += 1; };
  const refreshOpenCashSurfaces = () => { env.refresh += 1; };
  const body = `
    let driverRateEntries = _seed;
    let driverRateUnsub = null;
    ${liftFn('subscribeDriverRate')}
    ${liftFn('unsubscribeDriverRate')}
    return {
      subscribe: subscribeDriverRate,
      unsubscribe: unsubscribeDriverRate,
      getEntries: () => driverRateEntries,
      hasHandle: () => driverRateUnsub != null,
    };
  `;
  const api = new Function('fbOnValue', 'fbRef', 'XPD', 'render', 'refreshOpenCashSurfaces', '_seed', body)(
    fbOnValue, fbRef, XPD, render, refreshOpenCashSurfaces, seedEntries);
  return { env, api };
}

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── (1) error/cancel → blank amounts, and a re-render drops a stale amount off-screen ──────────────────────────────
{
  const { env, api } = mount();
  api.subscribe();
  assert.equal(env.onValueCalls, 1); assert.equal(env.live, 1);
  // a real rate arrives → an amount is now on screen
  env.onNext({ val: () => ({ push1: { cents: 7000, effective_from: Date.UTC(2026, 0, 1) } }) });
  assert.deepEqual(api.getEntries(), { push1: { cents: 7000, effective_from: Date.UTC(2026, 0, 1) } });
  const renderAfterData = env.render, refreshAfterData = env.refresh;
  assert.ok(renderAfterData >= 1 && refreshAfterData >= 1, 'onNext re-renders');
  // the listener is cancelled (permission denied / lost) → entries blanked AND the screen re-rendered (the fix)
  env.onError(new Error('PERMISSION_DENIED'));
  assert.equal(api.getEntries(), null, 'error callback blanks the cached rate');
  assert.equal(env.render, renderAfterData + 1, 'error callback re-renders (a stale amount cannot remain on screen)');
  assert.equal(env.refresh, refreshAfterData + 1, 'error callback refreshes the open cash surfaces too');
  ok('error/cancel callback blanks the rate AND re-renders — no stale amount left on screen');
}

// ── (2a) idempotent subscribe — a second subscribe while already subscribed is a no-op (one listener) ──────────────
{
  const { env, api } = mount();
  api.subscribe();
  api.subscribe();   // e.g. a stray second call in the same session
  assert.equal(env.onValueCalls, 1, 'the guard blocks a second onValue registration');
  assert.equal(env.live, 1, 'exactly one live listener');
  ok('double subscribe → the `if (driverRateUnsub) return` guard keeps exactly one listener');
}

// ── (2b) double boot → one listener (the real per-transition sequence: teardown then subscribe) ────────────────────
{
  const { env, api } = mount();
  // boot 1
  api.subscribe();
  assert.equal(env.live, 1);
  // boot 2 = the auth transition runs unsubscribeDriverRate (INICIO-DEMO-TEARDOWN), then the boot hook re-subscribes
  api.unsubscribe();
  api.subscribe();
  assert.equal(env.live, 1, 'after a second boot there is still exactly one live listener');
  assert.equal(env.onValueCalls, 2, 'the second boot really re-subscribed (fresh listener), not reused the stale one');
  ok('double boot → one live listener (teardown-before-resubscribe)');
}

// ── (3) sign-out → no listener; a re-login then re-subscribes cleanly ──────────────────────────────────────────────
{
  const { env, api } = mount();
  api.subscribe();
  assert.equal(env.live, 1); assert.equal(api.hasHandle(), true);
  // sign-out: the auth transition tears the listener down (no boot hook follows on `!user`)
  api.unsubscribe();
  assert.equal(env.live, 0, 'signed out → zero live rate listeners');
  assert.equal(api.hasHandle(), false, 'the unsub handle is cleared');
  api.unsubscribe();   // idempotent: a double teardown must not throw or go negative
  assert.equal(env.live, 0);
  // re-login re-subscribes
  api.subscribe();
  assert.equal(env.live, 1, 're-login re-subscribes a single listener');
  ok('sign-out → no listener (idempotent teardown); re-login re-subscribes exactly one');
}

console.log(`\nrate-subscription: OK (${n})`);
