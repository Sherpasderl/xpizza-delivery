'use strict';
/*
 * UID-PATH admission at the HANDLER level (Codex #270 P1): every onCall in index.js that calls the shared driver hard-stop
 * (lib/driver-callable-guard.js assertDriverCallerActive) — the list is DERIVED from index.js source, not hand-kept — is invoked
 * through its real exported handler (.run) by a caller whose verified uid ALIASES a real driver's node (`drv1/` ≡ `drv1`) or carries
 * an ASCII control. Each is refused permission-denied by the guard with NO Auth lookup and the database byte-identical (the lifted
 * unregisterDriverPushToken removed the real driver's push registration before the fix). A space-bearing uid is a legitimate uid
 * and passes the guard (whatever the handler decides next, it is never the guard's refusal).
 * Run: npm run test:uid-path (RTDB emulator).
 */
require('./_emulator-required')('database');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'uidpath-secret';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../lib/admin');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const fns = require('../index');
const authCalls = [];
Object.getPrototypeOf(getAuth()).getUser = async (uid) => { authCalls.push(uid); return { uid, disabled: false, tokensValidAfterTime: null }; };

const db = getDatabase();
assert.match(db.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost)/);
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// the consumers, from source: every `exports.X = onCall(` whose body awaits assertDriverCallerActive
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const CONSUMERS = [];
for (const m of SRC.matchAll(/^exports\.(\w+) = onCall\(/gm)) {
  const next = SRC.slice(m.index + 1).search(/^exports\.\w+ = /m);
  const body = SRC.slice(m.index, next < 0 ? undefined : m.index + 1 + next);
  if (/await assertDriverCallerActive\(uid, request\.auth\?\.token/.test(body)) CONSUMERS.push(m[1]);
}

const SEED = {
  config: { driver_admin_enabled: true },
  driver_accounts: { drv1: { enabled: true, onboarding_state: 'pending', version: 1, email: 'd@x.hn', invited_by: 'disp1' } },
  drivers: { drv1: { name: 'Uno', status: 'offline', active: false, push_token: 'REAL-TOKEN', push_reachable: true } },
  driver_push_tokens: { drv1: { token: 'REAL-TOKEN' } },
};
const DATA = { name: 'N', phone: '99990000', vehicle: 'moto', plate: 'P1', token: 'ATTACKER', lat: 15.5, lng: -88.0 };

(async () => {
  assert.deepStrictEqual([...CONSUMERS].sort(), ['endDriverShift', 'registerDriverPushToken', 'startDriverShift', 'submitDriverProfile', 'unregisterDriverPushToken'],
    `🔴 UIDPATH-HANDLERS: the guard's consumers in index.js changed (${CONSUMERS.join(',')}) — review each before updating this list`);
  ok(`the guard's consumers, derived from index.js: ${CONSUMERS.join(', ')}`);

  for (const name of CONSUMERS) {
    for (const bad of ['drv1/', 'drv1/x', 'drv1\u0000', 'drv1\u007f']) {
      await db.ref().set(SEED);
      const before = JSON.stringify((await db.ref().once('value')).val());
      authCalls.length = 0;
      let err = null;
      try { await fns[name].run({ auth: { uid: bad, token: { uid: bad, auth_time: Math.floor(Date.now() / 1000) } }, data: DATA }); } catch (e) { err = e; }
      assert.ok(err && err.code === 'permission-denied' && /no es válida/.test(err.message), `🔴 UIDPATH-HANDLERS: ${name}(${JSON.stringify(bad)}) must be refused by the guard (got ${err ? `${err.code} ${err.message}` : 'success'})`);
      assert.deepStrictEqual(authCalls, [], `🔴 UIDPATH-HANDLERS: ${name}(${JSON.stringify(bad)}) reached Auth (${authCalls.join(',')})`);
      assert.strictEqual(JSON.stringify((await db.ref().once('value')).val()), before, `🔴 UIDPATH-HANDLERS: ${name}(${JSON.stringify(bad)}) changed the database`);
    }
  }
  ok(`each of the ${CONSUMERS.length} handlers refuses an aliasing / control-char uid before Auth, with the database unchanged`);

  for (const name of CONSUMERS) {
    await db.ref().set(SEED);
    let err = null;
    try { await fns[name].run({ auth: { uid: 'drv 1', token: { uid: 'drv 1', auth_time: Math.floor(Date.now() / 1000) } }, data: DATA }); } catch (e) { err = e; }
    assert.ok(!(err && /no es válida/.test(err.message || '')), `🔴 UIDPATH-HANDLERS: ${name}: a space-bearing uid is legitimate — the guard must admit it`);
  }
  ok('a space-bearing uid passes the guard at every handler');

  console.log(`\nuid-path(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('uid-path(emulator) FAILED:', e && e.stack || e); process.exit(1); });
