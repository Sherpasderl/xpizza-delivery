/**
 * Behavioral suite for the KDS Phase 2b · Slice 3 RTDB rules (KDS_2B_PLAN.md §10/§11).
 *
 * Run against the Firebase RTDB emulator:
 *   npm run test:kitchen-staff-rules
 *     = firebase emulators:exec --only database --project demo-xpizza \
 *         "node test/kitchen-staff-rules.emulator.test.js"
 *
 * Section A — NEW nodes (item_availability / availability_audit / kitchen_staff / menus) enforcement:
 *   own-rid seeded-staff write OK; cross-rid write DENIED; non-staff write DENIED; public (unauth) read of
 *   item_availability OK; availability_audit public read DENIED (staff-only) + staff read/write OK;
 *   kitchen_staff NOT self-writable (dispatcher/admin only); /menus public read OK + public write DENIED.
 * Section R — REGRESSION: the additive diff did NOT break existing paths — an /orders/{id}/status write by
 *   a kitchen member still works (the load-bearing KDS contract), the flat /kitchen node is unchanged
 *   (authed read OK, non-dispatcher write DENIED), and the pre-2b /restaurants access controls still hold.
 *
 * Plain-node style (no jest) to match the repo's existing emulator tests.
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

const DISP = 'disp-uid';      // a dispatcher (admin role)
const XSTAFF = 'xstaff-uid';  // seeded kitchen_staff on x_pizza ONLY
const LSTAFF = 'lstaff-uid';  // seeded kitchen_staff on la_musa ONLY
const KUSER = 'kuser-uid';    // flat /kitchen member (legacy) — NOT in any kitchen_staff
const OUT = 'out-uid';        // authenticated, no role at all

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'demo-xpizza-ks-rules',
    database: { rules: RULES },
  });

  // Seed roles + fixtures with rules disabled.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref('dispatchers/' + DISP).set(true);
    await db.ref('restaurants/x_pizza/kitchen_staff/' + XSTAFF).set(true);
    await db.ref('restaurants/la_musa/kitchen_staff/' + LSTAFF).set(true);
    await db.ref('kitchen/' + KUSER).set(true);          // legacy flat kitchen membership (regression)
    await db.ref('kitchen/' + XSTAFF).set(true);         // x-staff is also a legacy kitchen member
    await db.ref('restaurants/x_pizza/item_availability/Pizza%20N1').set({ available: true, updated_at: 1 });
    await db.ref('menus/x_pizza').set([{ key: 'Pizza N1', label: 'Pizza N1', category: 'Pizzas' }]);
    // An order with a kitchen-updatable status (regression on the load-bearing KDS contract).
    await db.ref('orders/O1').set({ status: 'new', payment_method: 'cash', payment_status: 'none' });
  });

  const dispDb = env.authenticatedContext(DISP).database();
  const xstaffDb = env.authenticatedContext(XSTAFF).database();
  const lstaffDb = env.authenticatedContext(LSTAFF).database();
  const kuserDb = env.authenticatedContext(KUSER).database();
  const outDb = env.authenticatedContext(OUT).database();
  const anonDb = env.unauthenticatedContext().database();

  const get = (db, p) => db.ref(p).get();
  const set = (db, p, v) => db.ref(p).set(v);

  let n = 0;
  const ok = async (label, pr) => { await assertSucceeds(pr); console.log(`  ✓ ${++n} ${label}`); };
  const no = async (label, pr) => { await assertFails(pr); console.log(`  ✓ ${++n} ${label}`); };

  // ── Section A — NEW node enforcement ───────────────────────────────────────
  // item_availability: own-rid staff write OK, cross-rid + non-staff DENIED, public read OK.
  await ok('A: x_pizza staff writes own-rid item_availability', set(xstaffDb, 'restaurants/x_pizza/item_availability/Empanada', { available: false, updated_at: 2 }));
  await no('A: x_pizza staff writes CROSS-rid (la_musa) item_availability — DENIED', set(xstaffDb, 'restaurants/la_musa/item_availability/Empanada', { available: false, updated_at: 2 }));
  await no('A: la_musa staff writes CROSS-rid (x_pizza) item_availability — DENIED', set(lstaffDb, 'restaurants/x_pizza/item_availability/Empanada', { available: false, updated_at: 2 }));
  await no('A: legacy flat /kitchen user (no kitchen_staff) writes item_availability — DENIED', set(kuserDb, 'restaurants/x_pizza/item_availability/Empanada', { available: false, updated_at: 2 }));
  await no('A: role-less authed user writes item_availability — DENIED', set(outDb, 'restaurants/x_pizza/item_availability/Empanada', { available: false, updated_at: 2 }));
  await ok('A: PUBLIC (unauth) reads item_availability node — OK (fail-open order forms)', get(anonDb, 'restaurants/x_pizza/item_availability'));
  await ok('A: PUBLIC (unauth) reads a single item_availability key — OK', get(anonDb, 'restaurants/x_pizza/item_availability/Pizza%20N1'));

  // availability_audit: staff read+write OK, NEVER public (no staff-identity leak), cross-rid DENIED.
  await ok('A: x_pizza staff writes own-rid availability_audit', set(xstaffDb, 'restaurants/x_pizza/availability_audit/Empanada', { updated_by: XSTAFF, updated_at: 2 }));
  await ok('A: x_pizza staff reads own-rid availability_audit', get(xstaffDb, 'restaurants/x_pizza/availability_audit/Empanada'));
  await no('A: PUBLIC (unauth) reads availability_audit — DENIED (staff-only, no identity leak)', get(anonDb, 'restaurants/x_pizza/availability_audit/Empanada'));
  await no('A: role-less authed user reads availability_audit — DENIED', get(outDb, 'restaurants/x_pizza/availability_audit/Empanada'));
  await no('A: cross-rid staff reads availability_audit — DENIED', get(lstaffDb, 'restaurants/x_pizza/availability_audit/Empanada'));
  await no('A: cross-rid staff writes availability_audit — DENIED', set(lstaffDb, 'restaurants/x_pizza/availability_audit/X', { updated_by: LSTAFF, updated_at: 3 }));

  // kitchen_staff: dispatcher/admin write only (NOT self-writable — else cross-restaurant self-add), staff read.
  await no('A: a user CANNOT add THEMSELVES to kitchen_staff (self-write DENIED)', set(outDb, 'restaurants/la_musa/kitchen_staff/' + OUT, true));
  await no('A: even an existing staffer cannot add a uid to kitchen_staff (not admin) — DENIED', set(xstaffDb, 'restaurants/x_pizza/kitchen_staff/hacker', true));
  await ok('A: dispatcher/admin writes kitchen_staff (the seed/admin writer)', set(dispDb, 'restaurants/x_pizza/kitchen_staff/newcook', true));
  await ok('A: staff reads own-rid kitchen_staff', get(xstaffDb, 'restaurants/x_pizza/kitchen_staff'));
  await ok('A: dispatcher reads kitchen_staff', get(dispDb, 'restaurants/la_musa/kitchen_staff'));
  await no('A: PUBLIC (unauth) reads kitchen_staff — DENIED', get(anonDb, 'restaurants/x_pizza/kitchen_staff'));

  // menus: public read OK, public/non-admin write DENIED, admin write OK.
  await ok('A: PUBLIC (unauth) reads /menus/{rid} — OK', get(anonDb, 'menus/x_pizza'));
  await no('A: PUBLIC (unauth) writes /menus/{rid} — DENIED', set(anonDb, 'menus/x_pizza', [{ key: 'x' }]));
  await no('A: role-less authed writes /menus/{rid} — DENIED', set(outDb, 'menus/x_pizza', [{ key: 'x' }]));
  await ok('A: dispatcher/publish writes /menus/{rid}', set(dispDb, 'menus/x_pizza', [{ key: 'Pizza N1', label: 'Pizza N1', category: 'Pizzas' }]));

  // ── Section R — REGRESSION: additive diff did NOT loosen/break existing paths ──
  // The load-bearing KDS contract: a flat /kitchen member can write /orders/{id}/status.
  await ok('R: flat /kitchen member writes /orders/{id}/status (KDS contract intact)', set(kuserDb, 'orders/O1/status', 'preparing'));
  await no('R: role-less authed writes /orders/{id}/status — still DENIED', set(outDb, 'orders/O1/status', 'preparing'));
  // The flat /kitchen node itself is unchanged by the diff.
  await ok('R: authed reads flat /kitchen (unchanged)', get(outDb, 'kitchen/' + KUSER));
  await no('R: non-dispatcher writes flat /kitchen (unchanged) — DENIED', set(outDb, 'kitchen/hacker', true));
  await ok('R: dispatcher writes flat /kitchen (unchanged)', set(dispDb, 'kitchen/newk', true));
  // Pre-2b /restaurants access controls still hold (identity authed-read; parent + factura_config locked).
  await no('R: authed reads /restaurants/$rid parent — still DENIED (no cascade from new public children)', get(outDb, 'restaurants/x_pizza'));
  await no('R: authed reads factura_config — still DENIED', get(outDb, 'restaurants/x_pizza/factura_config'));
  await ok('R: authed reads identity/name — still OK', get(outDb, 'restaurants/x_pizza/identity/name'));
  await no('R: non-dispatcher writes identity — still DENIED', set(outDb, 'restaurants/x_pizza/identity/name', 'x'));

  await env.cleanup();
  console.log(`kitchen-staff-rules.emulator: OK (${n} assertions)`);
})().catch((e) => {
  console.error('kitchen-staff-rules.emulator: FAIL\n', e);
  process.exit(1);
});
