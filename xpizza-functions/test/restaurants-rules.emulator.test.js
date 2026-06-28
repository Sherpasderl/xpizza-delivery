/**
 * D3 — Behavioral suite for the /restaurants RTDB rules (Phase 0, Step 1).
 *
 * Run against the Firebase RTDB emulator:
 *   npm run test:rules
 *     = firebase emulators:exec --only database "node test/restaurants-rules.emulator.test.js"
 *
 * Proves Option B end-to-end: identity is authed-read + dispatcher-write; factura_config and all
 * ancestor/sibling paths (incl. the /restaurants root) stay locked; the identity wrapper
 * auto-covers new fields; and neither a write-cascade nor a parent-payload write can reach
 * factura_config. Plain-node style (no jest) to match the repo's existing `node *.test.js` tests.
 */
const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(
  path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'),
  'utf8'
);

const DISP = 'disp-uid'; // a dispatcher
const DRV = 'drv-uid'; // authenticated, NOT a dispatcher

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'demo-xpizza-rules',
    database: { rules: RULES }, // emulator host/port auto-detected from emulators:exec env
  });

  // Seed /dispatchers/{DISP} with rules disabled, so the dispatcher-write rule
  // (root.child('dispatchers').child(auth.uid).exists()) can pass for the allow cases.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref('dispatchers/' + DISP).set(true);
  });

  const dispDb = env.authenticatedContext(DISP).database();
  const drvDb = env.authenticatedContext(DRV).database();
  const anonDb = env.unauthenticatedContext().database();

  const get = (db, p) => db.ref(p).get();
  const set = (db, p, v) => db.ref(p).set(v);
  const upd = (db, p, v) => db.ref(p).update(v);

  let n = 0;
  const ok = async (label, pr) => { await assertSucceeds(pr); console.log(`  ✓ ${++n} ${label}`); };
  const no = async (label, pr) => { await assertFails(pr); console.log(`  ✓ ${++n} ${label}`); };

  // identity reads/writes
  await ok('driver reads identity/name', get(drvDb, 'restaurants/x_pizza/identity/name'));
  await no('authed reads factura_config', get(drvDb, 'restaurants/x_pizza/factura_config'));
  await no('driver writes identity', set(drvDb, 'restaurants/x_pizza/identity', { name: 'X' }));
  await ok('dispatcher writes identity', set(dispDb, 'restaurants/x_pizza/identity', { name: 'X' }));
  await no('dispatcher writes factura_config', set(dispDb, 'restaurants/x_pizza/factura_config', { cai: 'X' }));
  await no('unauth reads identity/name', get(anonDb, 'restaurants/x_pizza/identity/name'));

  // ancestor / sibling reads
  await no('authed reads $rid parent', get(drvDb, 'restaurants/x_pizza'));
  await no('authed reads arbitrary sibling', get(drvDb, 'restaurants/x_pizza/anything_else'));
  await ok('driver reads new identity field (wrapper auto-covers)', get(drvDb, 'restaurants/x_pizza/identity/brand_new'));

  // write-cascade + parent-payload smuggling
  await no('dispatcher update touches factura_config', upd(dispDb, 'restaurants/x_pizza', { 'factura_config/cai': 'X' }));
  await no('dispatcher parent write w/ valid identity payload', set(dispDb, 'restaurants/x_pizza', { identity: { name: 'X' } }));

  // root-collection denial
  await no('authed reads /restaurants root', get(drvDb, 'restaurants'));
  await no('unauth reads /restaurants root', get(anonDb, 'restaurants'));

  await env.cleanup();
  console.log(`restaurants-rules.emulator: OK (${n} assertions)`);
})().catch((e) => {
  console.error('restaurants-rules.emulator: FAIL\n', e);
  process.exit(1);
});
