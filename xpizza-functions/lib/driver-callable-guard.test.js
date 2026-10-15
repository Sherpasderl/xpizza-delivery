// Unit test for the shared driver-callable hard-stop (PLAN-S1 §6 + S1b §1.1a). Run: node lib/driver-callable-guard.test.js
const assert = require('node:assert/strict');
const { assertDriverCallerActive } = require('./driver-callable-guard');

class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
// S1b: the guard now reads BOTH /deactivated and /revoke_after under driver_accounts/{uid}.
const deps = (deactivated, user, revokeAfter = null) => ({
  db: { ref: (p) => ({ once: async () => {
    assert.match(p, /^driver_accounts\/[^/]+\/(deactivated|revoke_after)$/, `unexpected ref path ${p}`);
    if (/\/deactivated$/.test(p)) return { val: () => deactivated };
    return { val: () => revokeAfter };
  } }) },
  auth: { getUser: async () => user },
  HttpsError,
});
const ACTIVE = { disabled: false, tokensValidAfterTime: undefined };

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log(`  ok ${passed} ${name}`); };
const rejects = (p, code, re) => assert.rejects(p, (e) => e.code === code && (!re || re.test(e.message)));

(async () => {
  await t('DARK: an active driver (no marker, not disabled, not revoked, no cutoff) passes', async () => {
    await assertDriverCallerActive('u1', { auth_time: 1_760_000_000 }, deps(null, ACTIVE));
  });
  await t('no uid → unauthenticated', () => rejects(assertDriverCallerActive(undefined, {}, deps(null, ACTIVE)), 'unauthenticated'));
  await t('deactivated marker true → permission-denied (desactivada)', () =>
    rejects(assertDriverCallerActive('u1', { auth_time: 1_760_000_000 }, deps(true, ACTIVE)), 'permission-denied', /desactivada/));
  await t('intermediate state: marker true but user NOT disabled/revoked → still refused', () =>
    rejects(assertDriverCallerActive('u1', { auth_time: 9_999_999_999 }, deps(true, ACTIVE)), 'permission-denied', /desactivada/));
  await t('Auth user disabled → permission-denied (desactivada)', () =>
    rejects(assertDriverCallerActive('u1', { auth_time: 1_760_000_000 }, deps(null, { disabled: true })), 'permission-denied', /desactivada/));
  await t('token minted BEFORE tokensValidAfterTime → revoked (expirada)', () =>
    rejects(assertDriverCallerActive('u1', { auth_time: 1_760_000_000 }, deps(null, { disabled: false, tokensValidAfterTime: new Date(1_760_000_050_000).toUTCString() })), 'permission-denied', /expirada/));
  await t('token minted AFTER tokensValidAfterTime → NOT revoked (passes)', async () => {
    await assertDriverCallerActive('u1', { auth_time: 1_760_000_100 }, deps(null, { disabled: false, tokensValidAfterTime: new Date(1_760_000_050_000).toUTCString() }));
  });

  // --- S1b §1.1a: monotonic revocation cutoff (revoke_after), enforced BEFORE Auth reconciliation lands ---
  await t('S1b: absent revoke_after is inert (reactivated active driver passes)', async () => {
    await assertDriverCallerActive('u1', { auth_time: 1_760_000_000 }, deps(null, ACTIVE, null));
  });
  await t('S1b: pre-cutoff session (auth_time*1000 < revoke_after) → permission-denied (expirada)', () =>
    rejects(assertDriverCallerActive('u1', { auth_time: 1_760_000_000 }, deps(null, ACTIVE, 1_760_000_050_000)), 'permission-denied', /expirada/));
  await t('S1b: session at/after cutoff (auth_time*1000 >= revoke_after) → passes', async () => {
    await assertDriverCallerActive('u1', { auth_time: 1_760_000_100 }, deps(null, ACTIVE, 1_760_000_050_000));
  });
  await t('S1b: cutoff with a deactivated marker still refuses as desactivada (marker wins first)', () =>
    rejects(assertDriverCallerActive('u1', { auth_time: 1_760_000_000 }, deps(true, ACTIVE, 1_760_000_050_000)), 'permission-denied', /desactivada/));

  console.log(`\ndriver-callable-guard: ${passed} tests passed`);
})().catch((e) => { console.error('driver-callable-guard FAILED:', e && e.stack || e); process.exit(1); });
