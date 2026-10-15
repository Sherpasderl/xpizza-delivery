'use strict';
/**
 * PLAN-S5 §2.2 / §6 — the public restaurant leaf, on the RTDB emulator, for EVERY client role (guest, customer, kitchen staff,
 * dispatcher, a signed-in stranger):  npm run test:s5-rules
 *   - a guest reads restaurants/{rid}/public (the form's store label + prep stats);
 *   - a dispatcher writes display_name / branch_name / prep_eta_min INDIVIDUALLY, each validated (wrong type, too long, out of
 *     range → denied); nobody else writes them;
 *   - DENIED to everyone, dispatchers included: a prep_stats write, a prep_stats delete, a prep_stats/{bucket} write, a whole-
 *     public set, a whole-public delete, a mixed multipath update (display_name + prep_stats/x), an unknown child;
 *   - the siblings keep their rules (identity read/write, factura_config deny, kitchen_staff, item_availability).
 * Brand-agnostic ids throughout (merch_a).
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const DISP = 'dispuid000001', STAFF = 'staffuid00001', RANDO = 'randouid00001', CUST = 'custuid000001';
const RID = 'merch_a';
const P = `restaurants/${RID}/public`;
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-s5-rules', database: { rules: RULES } });
  const seed = async () => env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.database();
    await d.ref('/').set(null);
    await d.ref(`dispatchers/${DISP}`).set(true);
    await d.ref(`restaurants/${RID}/kitchen_staff/${STAFF}`).set(true);
    await d.ref(P).set({ display_name: 'Merch A', branch_name: 'Centro', prep_eta_min: 25, prep_stats: { weekday_dinner: { median_min: 18, p80_min: 26, n: 40 }, updated_at: 1 } });
    await d.ref(`restaurants/${RID}/identity`).set({ name: 'Merch A', hub_lat: 1, hub_lng: 2, phone: 'x', whatsapp_instance: 'i', whatsapp_enabled: false, delivery_radius_km: 5, hours: {}, active: true, version: 1 });
    await d.ref(`restaurants/${RID}/factura_config`).set({ secret: 'x' });
  });
  await seed();
  const as = (uid, claims) => env.authenticatedContext(uid, claims).database();
  const roles = { guest: env.unauthenticatedContext().database(), customer: as(CUST, { customer: true }), staff: as(STAFF), stranger: as(RANDO), dispatcher: as(DISP) };

  // ── reads ──
  for (const [name, db] of Object.entries(roles)) {
    const v = (await assertSucceeds(db.ref(P).once('value'))).val();
    assert.strictEqual(v.display_name, 'Merch A', `${name} reads the public leaf`);
    assert.strictEqual(v.prep_stats.weekday_dinner.n, 40, `${name} reads prep_stats`);
  }
  ok('every role (guest, customer, kitchen staff, stranger, dispatcher) reads restaurants/{rid}/public, prep_stats included');

  // ── dispatcher writes each leaf individually, validated ──
  const disp = roles.dispatcher;
  await assertSucceeds(disp.ref(`${P}/display_name`).set('Merch A Norte'));
  await assertSucceeds(disp.ref(`${P}/branch_name`).set('Norte'));
  await assertSucceeds(disp.ref(`${P}/prep_eta_min`).set(30));
  await assertSucceeds(disp.ref(P).update({ display_name: 'Merch A', branch_name: 'Centro' }));   // a multipath over writable leaves only
  for (const [leaf, bad] of [['display_name', 42], ['display_name', 'x'.repeat(61)], ['branch_name', true], ['branch_name', 'y'.repeat(61)], ['prep_eta_min', '25'], ['prep_eta_min', 4], ['prep_eta_min', 121]]) {
    await assertFails(disp.ref(`${P}/${leaf}`).set(bad));
  }
  await assertSucceeds(disp.ref(`${P}/prep_eta_min`).set(5)); await assertSucceeds(disp.ref(`${P}/prep_eta_min`).set(120));
  ok('a dispatcher writes display_name / branch_name / prep_eta_min individually; wrong type, > 60 chars, < 5 or > 120 → denied; 5 and 120 accepted');

  // ── nobody else writes the leaves ──
  for (const name of ['guest', 'customer', 'staff', 'stranger']) {
    for (const [leaf, val] of [['display_name', 'Z'], ['branch_name', 'Z'], ['prep_eta_min', 20]]) await assertFails(roles[name].ref(`${P}/${leaf}`).set(val));
  }
  ok('guest / customer / kitchen staff / stranger: every public leaf write → denied');

  // ── denied to EVERYONE, dispatchers included ──
  for (const [name, db] of Object.entries(roles)) {
    await assertFails(db.ref(`${P}/prep_stats`).set({ weekday_dinner: { median_min: 1, p80_min: 1, n: 99 } }));
    await assertFails(db.ref(`${P}/prep_stats`).remove());
    await assertFails(db.ref(`${P}/prep_stats/weekday_dinner`).set({ median_min: 1, p80_min: 1, n: 99 }));
    await assertFails(db.ref(`${P}/prep_stats/updated_at`).set(2));
    await assertFails(db.ref(P).set({ display_name: 'Z', branch_name: 'Z', prep_eta_min: 20 }));
    await assertFails(db.ref(P).remove());
    await assertFails(db.ref(P).update({ display_name: 'Z', 'prep_stats/x': 1 }));
    await assertFails(db.ref('/').update({ [`${P}/display_name`]: 'Z', [`${P}/prep_stats/weekday_dinner`]: null }));
    await assertFails(db.ref(`${P}/foo`).set('bar'));
    await assertFails(db.ref(`restaurants/${RID}`).update({ 'public/prep_eta_min': 20, 'public/foo': 1 }));
  }
  ok('every role, dispatchers included: prep_stats write / delete / bucket write / updated_at write, a whole-public set or delete, a mixed multipath (display_name + prep_stats), an unknown child → denied');

  // the seeded state survived every denied attempt
  let after = null; await env.withSecurityRulesDisabled(async (ctx) => { after = (await ctx.database().ref(P).once('value')).val(); });   // the helper returns nothing
  assert.deepStrictEqual(after.prep_stats, { weekday_dinner: { median_min: 18, p80_min: 26, n: 40 }, updated_at: 1 }, 'prep_stats untouched');
  assert.ok(!('foo' in after), 'no unknown child');
  ok('non-vacuity: prep_stats and the leaf set are exactly as seeded after every denied attempt');

  // ── siblings unchanged ──
  await assertFails(roles.guest.ref(`restaurants/${RID}/identity`).once('value'));
  await assertFails(roles.customer.ref(`restaurants/${RID}/identity`).once('value'));
  await assertSucceeds(roles.staff.ref(`restaurants/${RID}/identity`).once('value'));
  for (const db of Object.values(roles)) await assertFails(db.ref(`restaurants/${RID}/factura_config`).once('value'));
  await assertFails(roles.guest.ref(`restaurants/${RID}/kitchen_staff`).once('value'));
  await assertSucceeds(roles.staff.ref(`restaurants/${RID}/kitchen_staff`).once('value'));
  await assertFails(roles.guest.ref(`restaurants/${RID}`).once('value'));
  await assertFails(roles.dispatcher.ref(`restaurants/${RID}/prep_eta_min`).once('value'));
  ok('siblings unchanged: identity (no guest/customer read; staff reads), factura_config denied to all, kitchen_staff member-only, no read of the restaurant root or the private prep_eta_min');

  await env.cleanup();
  console.log(`\ns5-rules.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('s5-rules.emulator FAILED:', e && e.stack || e); process.exit(1); });
