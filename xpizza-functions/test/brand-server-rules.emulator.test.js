/**
 * BRAND-AGNOSTIC SERVER (PLAN-brand-agnostic-server r3 §A / §F / §H + r0 §1.4) — behavioural suite for the server-prerequisite
 * rules, against the RTDB emulator (real rules):
 *   F  identity.uses_platform_factura (B1) is Admin-only: no client create / change / field-delete / multipath-null / omitting
 *      replacement, and no delete of an identity (branded OR unbranded) that carries it; coordinate-only edits still pass
 *   M  identity.display_mark is a 1–2 character string; the B1 flag survives a mark edit
 *   R  drivers/{uid}/return_restaurant_id is server-only (svc-assigner) for every client token; the whole driver node cannot be
 *      deleted by any client; the genuine shift-open batch, the driver-app profile create and dispatcher edits still pass
 *   npm run test:brand-server-rules
 */
require('./_emulator-required')('database');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const DISP = 'disp-uid'; const KIT = 'kit-uid'; const DRV = 'drv-uid'; const SVC = 'svc-assigner'; const NEW = 'new-drv';
const HOURS = { sun: { open: true, start: '12:00', end: '19:45' } };
const IDENT = { name: 'Loc', hub_lat: 15.5, hub_lng: -88.0, phone: '+504', whatsapp_instance: 'i', whatsapp_enabled: false, delivery_radius_km: 5, hours: HOURS, active: true, version: 1 };
const FLAGGED = { ...IDENT, uses_platform_factura: true };
const FLAGGED_BRANDED = { ...FLAGGED, brand_id: 'tb_brand' };
const DRIVER = { name: 'Drv', status: 'returning', active: true, current_shift_id: 's1', current_restaurant_id: null, return_restaurant_id: 'tb_centro' };

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-brand-server-rules', database: { rules: RULES } });
  const admin = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.database()));
  const raw = async (p) => { let v; await admin(async (db) => { v = (await db.ref(p).once('value')).val(); }); return v; };
  const idp = (rid) => `restaurants/${rid}/identity`;
  const reset = () => admin(async (db) => {
    await db.ref().set(null);
    await db.ref(`dispatchers/${DISP}`).set(true);
    await db.ref(`kitchen/${KIT}`).set(true);
    await db.ref(`driver_accounts/${DRV}`).set({ enabled: true });
    await db.ref(`driver_accounts/${NEW}`).set({ enabled: true });
    await db.ref(`drivers/${DRV}`).set(DRIVER);
    await db.ref(idp('tb_centro')).set(FLAGGED_BRANDED);
    await db.ref(idp('tb_norte')).set(FLAGGED);
    await db.ref(idp('leg_x')).set(IDENT);
  });
  await reset();
  const disp = env.authenticatedContext(DISP).database();
  const hhDisp = env.authenticatedContext(DISP, { handheld: true }).database();
  const custDisp = env.authenticatedContext(DISP, { customer: true }).database();
  const hh = env.authenticatedContext('hh-uid', { handheld: true }).database();
  const kit = env.authenticatedContext(KIT).database();
  const drv = env.authenticatedContext(DRV).database();
  const svc = env.authenticatedContext(SVC).database();
  const anon = env.unauthenticatedContext().database();
  const cust = env.authenticatedContext('cust-uid', { customer: true }).database();
  const newDrv = env.authenticatedContext(NEW).database();
  let n = 0;
  const ok = async (l, p) => { await assertSucceeds(p); console.log(`  ✓ ${++n} ${l}`); };
  const no = async (l, p) => { await assertFails(p); console.log(`  ✓ ${++n} ${l}`); };
  const pass = (l) => console.log(`  ✓ ${++n} ${l}`);

  // ── F: identity.uses_platform_factura (B1) — Admin-only ──
  await ok('F1: dispatcher reads the flag', disp.ref(`${idp('tb_centro')}/uses_platform_factura`).get());
  await no('F2: handheld cannot read the flag', hh.ref(`${idp('tb_centro')}/uses_platform_factura`).get());
  await no('F3: customer cannot read the flag', cust.ref(`${idp('tb_centro')}/uses_platform_factura`).get());
  await no('F4: customer+dispatcher token cannot read the flag (READ excludes customer)', custDisp.ref(`${idp('tb_centro')}/uses_platform_factura`).get());
  await no('F5: dispatcher cannot CREATE the flag on an unflagged identity', disp.ref(`${idp('leg_x')}/uses_platform_factura`).set(true));
  await no('F6: dispatcher cannot MODIFY the flag', disp.ref(`${idp('tb_norte')}/uses_platform_factura`).set(false));
  await no('F7: dispatcher cannot DELETE the flag field', disp.ref(`${idp('tb_norte')}/uses_platform_factura`).remove());
  await no('F8: dispatcher cannot null the flag in a MULTIPATH update', disp.ref().update({ [`${idp('tb_norte')}/uses_platform_factura`]: null, [`${idp('tb_norte')}/version`]: 2 }));
  await no('F9: dispatcher cannot replace the whole identity OMITTING the flag', disp.ref(idp('tb_norte')).set({ ...IDENT, version: 2 }));
  await no('F10: dispatcher cannot delete a BRANDED identity carrying the flag', disp.ref(idp('tb_centro')).remove());
  await no('F11: dispatcher cannot delete an UNBRANDED identity carrying the flag', disp.ref(idp('tb_norte')).remove());
  await ok('F12: dispatcher may still delete an unbranded, unflagged identity (legacy behaviour kept)', disp.ref(idp('leg_x')).remove());
  await ok('F13: dispatcher COORDINATE-only edit on a flagged identity', disp.ref(idp('tb_norte')).update({ hub_lat: 15.6, hub_lng: -88.1, version: 2 }));
  assert.strictEqual(await raw(`${idp('tb_norte')}/uses_platform_factura`), true, 'F13: the flag must survive a coordinate edit');
  await ok('F14: dispatcher whole-identity replacement that KEEPS the flag', disp.ref(idp('tb_norte')).set({ ...FLAGGED, version: 3 }));
  await no('F15: handheld+dispatcher token cannot edit coordinates (write excludes handheld)', hhDisp.ref(idp('tb_norte')).update({ hub_lat: 15.7, version: 4 }));
  await no('F16: handheld+dispatcher token cannot touch the flag', hhDisp.ref(`${idp('tb_norte')}/uses_platform_factura`).remove());
  // the WRITE asymmetry (identity .write has no customer term): observed result documented by the assertion itself
  await ok('F17: customer+dispatcher token CAN edit coordinates (identity .write has no customer term — documented asymmetry)', custDisp.ref(idp('tb_norte')).update({ hub_lat: 15.8, version: 5 }));
  await no('F18: customer+dispatcher token cannot modify the flag', custDisp.ref(`${idp('tb_norte')}/uses_platform_factura`).set(false));
  await no('F19: customer+dispatcher token cannot delete the flag', custDisp.ref(`${idp('tb_norte')}/uses_platform_factura`).remove());
  for (const [who, db] of [['kitchen', kit], ['driver', drv], ['anon', anon]]) {
    await no(`F: ${who} cannot set the flag`, db.ref(`${idp('leg_x')}/uses_platform_factura`).set(true));
    await no(`F: ${who} cannot delete a flagged identity`, db.ref(idp('tb_norte')).remove());
  }
  assert.strictEqual(await raw(`${idp('tb_norte')}/uses_platform_factura`), true, 'F: the flag is still present after every denied attempt');
  pass('F: the flag is intact after the whole matrix');

  // ── M: identity.display_mark ──
  await reset();
  await ok("M1: dispatcher sets display_mark 'X'", disp.ref(`${idp('tb_norte')}/display_mark`).set('X'));
  await ok("M2: dispatcher sets a 2-char display_mark 'LM'", disp.ref(`${idp('leg_x')}/display_mark`).set('LM'));
  await no("M3: empty display_mark ''", disp.ref(`${idp('leg_x')}/display_mark`).set(''));
  await no("M4: 3-char display_mark 'XYZ'", disp.ref(`${idp('leg_x')}/display_mark`).set('XYZ'));
  await no('M5: numeric display_mark', disp.ref(`${idp('leg_x')}/display_mark`).set(7));
  assert.strictEqual(await raw(`${idp('tb_norte')}/uses_platform_factura`), true, 'M1: the B1 flag must survive a mark edit');
  assert.strictEqual(await raw(`${idp('tb_norte')}/display_mark`), 'X');
  pass('M6: the B1 flag is preserved alongside the mark');

  // ── R: drivers/{uid}/return_restaurant_id — server-only; no client delete of a driver node ──
  const rp = `drivers/${DRV}/return_restaurant_id`;
  const roles = [['driver-self', drv], ['dispatcher', disp], ['handheld+dispatcher', hhDisp], ['kitchen', kit], ['anon', anon]];
  for (const [who, db] of roles) {
    await no(`R: ${who} cannot MODIFY return_restaurant_id`, db.ref(rp).set('leg_x'));
    await no(`R: ${who} cannot DELETE return_restaurant_id`, db.ref(rp).remove());
    await no(`R: ${who} cannot null it in a MULTIPATH update`, db.ref().update({ [rp]: null, [`drivers/${DRV}/name`]: 'Drv2' }));
    await no(`R: ${who} cannot replace the driver node OMITTING it`, db.ref(`drivers/${DRV}`).set({ name: 'Drv' }));
    await no(`R: ${who} cannot delete the whole driver node`, db.ref(`drivers/${DRV}`).remove());
  }
  await admin((db) => db.ref(rp).remove());
  for (const [who, db] of roles) await no(`R: ${who} cannot CREATE return_restaurant_id`, db.ref(rp).set('leg_x'));
  await no('R: dispatcher cannot create it through a parent update', disp.ref(`drivers/${DRV}`).update({ return_restaurant_id: 'leg_x' }));
  assert.strictEqual(await raw(rp), null);
  await ok('R: svc-assigner SETS return_restaurant_id', svc.ref(rp).set('tb_centro'));
  await no('R: svc-assigner cannot set a non-string', svc.ref(rp).set(5));
  await ok('R: svc-assigner CLEARS return_restaurant_id', svc.ref(rp).remove());
  await ok('R: svc-assigner sets it back', svc.ref(rp).set('tb_centro'));
  await ok('R: dispatcher existing driver edit (name) still passes', disp.ref(`drivers/${DRV}/name`).set('Renamed'));
  await ok('R: dispatcher existing driver edit (push_reachable) still passes', disp.ref(`drivers/${DRV}/push_reachable`).set(true));
  await ok('R: driver-self existing edit (lat/lng) still passes', drv.ref(`drivers/${DRV}`).update({ lat: 15.5, lng: -88 }));
  assert.strictEqual(await raw(rp), 'tb_centro', 'R: every permitted client edit leaves return_restaurant_id intact');
  // the genuine shift-open batch (startDriverShift, svc handle) carrying the return copy
  const shiftOpen = (uid, extra = {}) => ({
    [`drivers/${uid}/active`]: true, [`drivers/${uid}/status`]: 'available', [`drivers/${uid}/shift_started_at`]: 1, [`drivers/${uid}/last_ping`]: 1,
    [`drivers/${uid}/current_task_id`]: null, [`drivers/${uid}/current_hub_lat`]: null, [`drivers/${uid}/current_hub_lng`]: null,
    [`drivers/${uid}/current_restaurant_id`]: null, [`drivers/${uid}/current_hub_task_id`]: null, [`drivers/${uid}/current_shift_id`]: `shift-${uid}`,
    [`drivers/${uid}/location_source`]: 'pwa', ...extra,
  });
  await admin((db) => db.ref(`drivers/${DRV}`).update({ active: false, status: 'off_shift', current_shift_id: null, current_restaurant_id: 'leg_x' }));
  await ok('R: the genuine startDriverShift batch (svc handle) with the return copy passes', svc.ref().update(shiftOpen(DRV, { [rp]: 'leg_x' })));
  assert.strictEqual(await raw(rp), 'leg_x');
  // delete → recreate → clock-in cannot shed the history
  await no('R: driver-self whole-node delete DENIED', drv.ref(`drivers/${DRV}`).remove());
  await no('R: driver-self recreate omitting the field DENIED (validate pin)', drv.ref(`drivers/${DRV}`).set({ name: 'Drv', active: false, status: 'off_shift' }));
  await admin((db) => db.ref(`drivers/${DRV}`).update({ active: false, status: 'off_shift', current_shift_id: null }));
  await ok('R: a genuine clock-in after the denied delete/recreate', svc.ref().update(shiftOpen(DRV)));
  assert.strictEqual(await raw(rp), 'leg_x', 'R: the clock-in still finds return_restaurant_id');
  pass('R: delete → recreate → clock-in cannot shed return_restaurant_id');
  // the driver app's profile creation (ensureDriverProfile, xpizza-driver/xpizza-delivery.js) on a missing node still passes
  await ok('R: ensureDriverProfile whole-node CREATE on a missing node passes', newDrv.ref(`drivers/${NEW}`).set({
    name: 'New', phone: null, active: false, status: 'off_shift', lat: null, lng: null, last_ping: null, current_task_id: null, shift_started_at: null,
  }));
  await no('R: ensureDriverProfile-shaped create cannot smuggle a return_restaurant_id', newDrv.ref(`drivers/${NEW}`).set({ name: 'New', return_restaurant_id: 'leg_x' }));
  await ok('R: Admin may delete a driver record (account removal)', admin((db) => db.ref(`drivers/${NEW}`).remove()));

  await env.cleanup();
  console.log(`\nbrand-server-rules.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
