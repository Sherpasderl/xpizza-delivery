// Unit test for the shared driver-callable hard-stop (PLAN-S1 §6). Run: node lib/driver-callable-guard.test.js
const assert = require('node:assert/strict');
const { assertDriverCallerActive } = require('./driver-callable-guard');

class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const deps = (deactivated, user) => ({
  db: { ref: (p) => ({ once: async () => { assert.match(p, /^driver_accounts\/.+\/deactivated$/); return { val: () => deactivated }; } }) },
  auth: { getUser: async () => user },
  HttpsError,
});
const ACTIVE = { disabled: false, tokensValidAfterTime: undefined };

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log(`  ok ${passed} ${name}`); };
const rejects = (p, code, re) => assert.rejects(p, (e) => e.code === code && (!re || re.test(e.message)));

(async () => {
  await t('DARK: an active driver (no marker, not disabled, not revoked) passes', async () => {
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
  console.log(`\ndriver-callable-guard: ${passed} tests passed`);
})().catch((e) => { console.error('driver-callable-guard FAILED:', e && e.stack || e); process.exit(1); });
