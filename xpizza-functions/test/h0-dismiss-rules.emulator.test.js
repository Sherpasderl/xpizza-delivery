/**
 * PLAN-H0 (ruling B/C) — the dispatch × on a payment alert, under the REAL database rules. Run: npm run test:h0-dismiss-rules
 *
 * The × sends ONE multi-path update built by the dispatch page's own builder (xpizza-dispatch/dispatch-h0-dismiss.js):
 *   dispatcher_alerts/{id}: null + orders/{o}/paid_evidence/{a}/{dismissed_kind, dismissed_version}.
 *   - authenticated AS A DISPATCHER (not admin) → it SUCCEEDS, and exactly those paths change;
 *   - a customer, kitchen staff, a driver, a plain signed-in user and anonymous → DENIED (nothing changes).
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { h0DismissUpdate } = require('../../xpizza-dispatch/dispatch-h0-dismiss.js');
const { alertRecord } = require('../superseded-capture');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const DISP = 'u_disp00000000000000000';
const KITCHEN = 'u_kitchen000000000000000';
const DRIVER = 'u_driver0000000000000000';
const PLAIN = 'u_plain00000000000000000';
const OID = 'PZXH0RULES1', AID = 'a1a1a1a1a1a1a1a1';
const AK = `paid_superseded_${OID}_${AID}`;
const EV = { kind: 'paid_superseded', version: 'v1hash0000000000', seq: 1, fence: 5, payment_uuid: 'U', amount_cents: 29900, alert_state: 'delivered', first_seen_at: 1 };
const ORDER = { order_id: OID, restaurant_id: 'x_pizza', status: 'cancelled', payment_status: 'confirmed', payment_method: 'online', total: 299, paid_evidence: { [AID]: EV } };

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });
  const seed = async () => env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref('/').set(null);
    await db.ref(`dispatchers/${DISP}`).set({ name: 'D' });
    await db.ref(`kitchen/${KITCHEN}`).set({ name: 'K' });
    await db.ref(`restaurants/x_pizza/kitchen_staff/${KITCHEN}`).set(true);
    await db.ref(`drivers/${DRIVER}`).set({ name: 'R' });
    await db.ref(`orders/${OID}`).set(ORDER);
    await db.ref(`payment_attempts/${AID}`).set({ order_id: OID, hosted_state: 'paid', hosted_callback_verified: true, payment_uuid: 'U' });
    await db.ref(`dispatcher_alerts/${AK}`).set(alertRecord(OID, AID, EV, ORDER, 5));
  });
  const snapshot = async () => { let v; await env.withSecurityRulesDisabled(async (ctx) => { v = (await ctx.database().ref('/').get()).val(); }); return v; };
  const flat = (o, p = '', out = {}) => { if (o && typeof o === 'object') { for (const k of Object.keys(o)) flat(o[k], p ? `${p}/${k}` : k, out); } else out[p] = o; return out; };
  let n = 0;

  // the EXACT update the dispatch × sends, from the real record
  await seed();
  const rec = (await snapshot()).dispatcher_alerts[AK];
  const update = h0DismissUpdate(AK, rec);
  assert.deepStrictEqual(Object.keys(update).sort(), [`dispatcher_alerts/${AK}`, `orders/${OID}/paid_evidence/${AID}/dismissed_kind`, `orders/${OID}/paid_evidence/${AID}/dismissed_version`].sort(), 'premise: the × update is exactly three paths');

  // denied for every non-dispatcher principal — and nothing changes
  const others = {
    customer: env.authenticatedContext('u_cust000000000000000000', { customer: true }).database(),
    kitchen: env.authenticatedContext(KITCHEN).database(),
    driver: env.authenticatedContext(DRIVER).database(),
    plain: env.authenticatedContext(PLAIN).database(),
    anon: env.unauthenticatedContext().database(),
  };
  for (const [who, db] of Object.entries(others)) {
    await seed();
    const before = flat(await snapshot());
    await assertFails(db.ref().update(update));
    assert.deepStrictEqual(flat(await snapshot()), before, `${who}: nothing changed`);
    console.log(`  ok ${++n} ${who}: the × update is DENIED and nothing changes`);
  }

  // a dispatcher (not admin): succeeds, and exactly the alert + the two dismissal fields change
  await seed();
  const before = flat(await snapshot());
  await assertSucceeds(env.authenticatedContext(DISP).database().ref().update(update));
  const after = flat(await snapshot());
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort();
  assert.deepStrictEqual(changed.filter((k) => !k.startsWith(`dispatcher_alerts/${AK}/`)),
    [`orders/${OID}/paid_evidence/${AID}/dismissed_kind`, `orders/${OID}/paid_evidence/${AID}/dismissed_version`]);
  assert.strictEqual(after[`orders/${OID}/paid_evidence/${AID}/dismissed_kind`], 'paid_superseded');
  assert.strictEqual(after[`orders/${OID}/paid_evidence/${AID}/dismissed_version`], EV.version);
  assert.ok(!Object.keys(after).some((k) => k.startsWith(`dispatcher_alerts/${AK}/`)), 'the alert is removed');
  console.log(`  ok ${++n} dispatcher (authenticated, NOT admin): the exact × update SUCCEEDS under the real rules; only the alert removal + the two dismissal fields change`);

  await env.cleanup();
  console.log(`\nh0-dismiss-rules emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('h0-dismiss-rules emulator FAILED:', e); process.exit(1); });
