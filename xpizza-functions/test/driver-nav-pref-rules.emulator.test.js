/**
 * R7 — the drivers/{uid}/nav_app RTDB rule (nav-preference). Run: npm run test:driver-nav-pref-rules
 *   = firebase emulators:exec --only database "node test/driver-nav-pref-rules.emulator.test.js"
 *
 * Proves, against the REAL compiled ruleset (xpizza-reference/database.rules.json), that nav_app is a
 * self-service enum field:
 *   A. an ENABLED own driver writes 'waze' / 'maps' → OK; any other value or a non-string → DENIED (.validate).
 *   B. ANOTHER non-privileged uid, a HANDHELD token, a CUSTOMER token and a DEACTIVATED driver → DENIED.
 *   C. DOCUMENTED inherited-grant behaviour: a DISPATCHER may write a driver's nav_app (the admin grant on
 *      drivers/$id covers every field), and a driver may set nav_app through a PARENT object write — but only
 *      with `name` present (the parent .validate) AND a valid enum value; dropping name or a bad enum is denied.
 *
 * Plain-node style (no jest) to match the repo's existing `node *.test.js` tests.
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');

const DISP    = 'u_disp00000000000000000';   // a dispatcher
const D_EN    = 'u_enabled000000000000000';   // enabled, active, NOT deactivated
const D_OTHER = 'u_other0000000000000000';    // a different enabled driver
const D_DEACT = 'u_deactivated0000000000';    // deactivated:true

(async () => {
  let n = 0;
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref(`dispatchers/${DISP}`).set({ role: 'dispatcher' });
    await db.ref(`driver_accounts/${D_EN}`).set({ enabled: true, onboarding_state: 'active' });
    await db.ref(`driver_accounts/${D_OTHER}`).set({ enabled: true, onboarding_state: 'active' });
    await db.ref(`driver_accounts/${D_DEACT}`).set({ enabled: true, onboarding_state: 'active', deactivated: true });
    // Pre-existing driver profile nodes (so a leaf nav_app write targets a real driver node; a parent .validate
    // recheck on a LEAF write does not fire — validation does not cascade to ancestors).
    await db.ref(`drivers/${D_EN}`).set({ name: 'Marvin', status: 'off_shift', active: false });
    await db.ref(`drivers/${D_OTHER}`).set({ name: 'Otro', status: 'off_shift', active: false });
    await db.ref(`drivers/${D_DEACT}`).set({ name: 'Baja', status: 'off_shift', active: false });
  });

  const en    = env.authenticatedContext(D_EN).database();
  const other = env.authenticatedContext(D_OTHER).database();
  const hand  = env.authenticatedContext(D_EN, { handheld: true }).database();
  const cust  = env.authenticatedContext(D_EN, { customer: true }).database();
  const deact = env.authenticatedContext(D_DEACT).database();
  const disp  = env.authenticatedContext(DISP).database();

  const ok = async (label, pr) => { await assertSucceeds(pr); console.log(`  ok ${++n} ${label}`); };
  const no = async (label, pr) => { await assertFails(pr); console.log(`  ok ${++n} ${label}`); };

  // ---------- A. own enabled driver: enum ----------
  await ok('own enabled driver writes nav_app = "waze"', en.ref(`drivers/${D_EN}/nav_app`).set('waze'));
  await ok('own enabled driver writes nav_app = "maps"', en.ref(`drivers/${D_EN}/nav_app`).set('maps'));
  await no('own driver writes nav_app = "bogus" (not in the enum)', en.ref(`drivers/${D_EN}/nav_app`).set('bogus'));
  await no('own driver writes nav_app = 123 (not a string)', en.ref(`drivers/${D_EN}/nav_app`).set(123));
  await no('own driver writes nav_app = true (not a string)', en.ref(`drivers/${D_EN}/nav_app`).set(true));

  // ---------- B. everyone else is denied ----------
  await no('ANOTHER uid cannot write D_EN nav_app (not own-uid, not dispatcher)', other.ref(`drivers/${D_EN}/nav_app`).set('waze'));
  await no('a HANDHELD token cannot write its own nav_app (parent .write excludes handheld)', hand.ref(`drivers/${D_EN}/nav_app`).set('waze'));
  await no('a CUSTOMER token cannot write its own nav_app (nav_app .validate excludes customer)', cust.ref(`drivers/${D_EN}/nav_app`).set('waze'));
  await no('a DEACTIVATED driver cannot write its own nav_app (parent .write requires not-deactivated)', deact.ref(`drivers/${D_DEACT}/nav_app`).set('waze'));

  // ---------- C. documented inherited-grant behaviour ----------
  // A dispatcher may write a driver's nav_app — the admin grant on drivers/$id covers every field (same as the
  // dispatcher's existing ability to write a driver's other fields). nav_app .validate still enforces the enum.
  await ok('a DISPATCHER may write a driver nav_app (admin grant on drivers/$id — documented)', disp.ref(`drivers/${D_EN}/nav_app`).set('maps'));
  await no('a DISPATCHER still cannot write a bad nav_app value (enum .validate holds)', disp.ref(`drivers/${D_EN}/nav_app`).set('bogus'));
  // A driver may set nav_app through a PARENT object write, but the parent .validate requires `name`, and the
  // nav_app child .validate still enforces the enum.
  await ok('own driver parent write {name, nav_app:"waze"} OK (name present + valid enum)', en.ref(`drivers/${D_EN}`).set({ name: 'Marvin', status: 'off_shift', active: false, nav_app: 'waze' }));
  await no('own driver parent write {name, nav_app:"bogus"} DENIED (enum .validate on the child)', en.ref(`drivers/${D_EN}`).set({ name: 'Marvin', status: 'off_shift', active: false, nav_app: 'bogus' }));
  await no('own driver parent write {nav_app:"waze"} without name DENIED (parent .validate hasChildren name)', en.ref(`drivers/${D_EN}`).set({ nav_app: 'waze' }));

  await env.cleanup();
  console.log(`driver-nav-pref-rules.emulator: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
