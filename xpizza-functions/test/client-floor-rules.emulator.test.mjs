// P-SELFUPDATE §5 (steps 1 + 2) — the per-restaurant KITCHEN floor in the RTDB rules, on the database emulator.
// Run: npm run test:client-floor-rules
//
// The rule under test (both restaurants/{rid}/item_availability/$key and .../availability_audit/$key):
//   .write = membership && (floorAbsent || floorCondition)
//     membership     = kitchen_staff/{uid} of THIS restaurant (unchanged)
//     floorAbsent    = !restaurants/{rid}/client_floor/kitchen.exists()          → today's behaviour exactly
//     floorCondition = newData.compat is a number ≥ the floor AND newData.updated_at == now (server time)
// plus the ADDITIVE optional `compat` child (step 1): item_availability/$key/compat must be a number when present.
//
// Writes go through the REAL KDS writer (xpizza-kitchen/xpizza-delivery.js setItemAvailability — one atomic two-path
// update) wherever the scenario is "today's KDS"; its firebase CDN imports are rewritten to a shim bound to the emulator
// database of the authenticated test context (the avail-write.test.mjs loading pattern). A "module KDS" payload (with
// compat) is written with the same one-update two-path shape directly, since the module writer ships at checkpoint 2.
//
// Sections:
//   A  floor ABSENT — old payloads, new payloads, the real atomic writer, deletes, cross-rid / non-staff refusals.
//   B  floor PRESENT — allow (≥ floor, server time), refuse (below, missing, malformed compat, client time, today's
//      writer), delete refused, partial-write scope (stated limits pinned), both paths independently.
//   C  the floor node itself — member read only (own restaurant), never client-writable; malformed floor refuses.
//   D  kill switch — deleting the floor restores today's behaviour for the real writer.
//   E  UNAFFECTED with a floor set — order reads, KDS status writes, dispatcher alert read + dismiss, other restaurant.
//   F  telemetry nodes are deny-access (client_versions, client_version_limits, client_version_stats, platform_config).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert';
const require = createRequire(import.meta.url);
require('./_emulator-required.js')('database');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = readFileSync(new URL('../../xpizza-reference/database.rules.json', import.meta.url), 'utf8');
const KITCHEN = new URL('../../xpizza-kitchen/', import.meta.url);
const XSTAFF = 'xstaff', LSTAFF = 'lstaff', DISP = 'disp', KUSER = 'kuser', OUT = 'out';
const SV = { '.sv': 'timestamp' };

let n = 0;
const ok = async (label, p) => { await assertSucceeds(p); console.log(`  ✓ ${++n} ${label}`); };
const no = async (label, p) => { await assertFails(p); console.log(`  ✓ ${++n} ${label}`); };

// ── the REAL KDS writer, bound to whichever emulator database globalThis.__db points at ─────────────────────────
const shim = `
const D = () => globalThis.__db;
export function initializeApp() { return {}; }
export function getAuth() { return {}; }
export function signInWithEmailAndPassword() { return Promise.resolve({ user: {} }); }
export function signOut() { return Promise.resolve(); }
export function onAuthStateChanged() { return () => {}; }
export function getDatabase() { return {}; }
export function ref(_db, path) { return D().ref(path == null ? undefined : path); }
export function onValue() { return () => {}; }
export function set(r, v) { return r.set(v); }
export function update(r, obj) { return r.update(obj); }
export function get(r) { return r.get(); }
export function remove(r) { return r.remove(); }
export function runTransaction(r, fn) { return r.transaction(fn); }
export function serverTimestamp() { return { '.sv': 'timestamp' }; }
export function off() {}
`;
await import('data:text/javascript,' + encodeURIComponent(readFileSync(new URL('avail-key.js', KITCHEN), 'utf8')));
globalThis.location = { hostname: 'kitchen.example' };
const shimUrl = ('data:text/javascript,' + encodeURIComponent(shim)).replace(/'/g, '%27');
const sdkSrc = readFileSync(new URL('xpizza-delivery.js', KITCHEN), 'utf8')
  .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-(app|auth|database)\.js/g, shimUrl)
  .replace(/from '\.\/order-filter\.js'/g, `from '${new URL('order-filter.js', KITCHEN).href}'`);
const XPD = await import('data:text/javascript,' + encodeURIComponent(sdkSrc));
XPD.initDelivery({});
const realWrite = (db, rid, rawKey, available, uid, compat) => { globalThis.__db = db; return XPD.setItemAvailability(rid, rawKey, available, uid, compat); };   // compat: CP2's stamped KDS
const key = (raw) => globalThis.availKey(raw);

// a "module KDS" whole-record two-path write: the same ONE atomic update, both leaves carrying compat
const moduleWrite = (db, rid, raw, available, uid, compat, ts = SV) => db.ref().update({
  [`restaurants/${rid}/item_availability/${key(raw)}`]: { available, updated_at: ts, ...(compat === undefined ? {} : { compat }) },
  [`restaurants/${rid}/availability_audit/${key(raw)}`]: { available, updated_at: ts, updated_by: uid, ...(compat === undefined ? {} : { compat }) },
});

try {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-client-floor', database: { rules: RULES } });
  const admin = async (fn) => env.withSecurityRulesDisabled(async (ctx) => fn(ctx.database()));
  await admin(async (db) => {
    await db.ref('dispatchers/' + DISP).set(true);
    await db.ref('kitchen/' + KUSER).set(true);
    await db.ref('kitchen/' + XSTAFF).set(true);
    await db.ref('restaurants/x_pizza/kitchen_staff/' + XSTAFF).set(true);
    await db.ref('restaurants/la_musa/kitchen_staff/' + LSTAFF).set(true);
    await db.ref('restaurants/x_pizza/item_availability/' + key('Margherita')).set({ available: true, updated_at: 1 });
    await db.ref('orders/O1').set({ status: 'new', payment_method: 'cash', payment_status: 'none', restaurant_id: 'x_pizza' });
    await db.ref('dispatcher_alerts/A1').set({ type: 'no_driver', ts: 1 });
  });
  const xs = env.authenticatedContext(XSTAFF).database();
  const ls = env.authenticatedContext(LSTAFF).database();
  const dp = env.authenticatedContext(DISP).database();
  const out = env.authenticatedContext(OUT).database();
  const anon = env.unauthenticatedContext().database();
  const setFloor = (rid, v) => admin((db) => db.ref(`restaurants/${rid}/client_floor/kitchen`).set(v));
  const read = (p) => { let v; return admin(async (db) => { v = (await db.ref(p).get()).val(); }).then(() => v); };

  // ═══ A. floor ABSENT — today's behaviour, plus the additive compat child ═══
  await ok('A1 absent: the REAL KDS writer (one atomic two-path update, serverTimestamp, no compat) succeeds — sold out', realWrite(xs, 'x_pizza', 'Cacio e Pepe.NY', false, XSTAFF));
  const ia = await read(`restaurants/x_pizza/item_availability/${key('Cacio e Pepe.NY')}`);
  assert.deepStrictEqual(Object.keys(ia).sort(), ['available', 'updated_at']); assert.strictEqual(ia.available, false);
  await ok('A2 absent: the REAL writer — available again', realWrite(xs, 'x_pizza', 'Cacio e Pepe.NY', true, XSTAFF));
  await ok('A3 absent: an old payload with a CLIENT number updated_at still validates (today)', xs.ref(`restaurants/x_pizza/item_availability/${key('Ham')}`).set({ available: false, updated_at: 123 }));
  await ok('A4 absent: a NEW payload carrying compat (step 1 additive child) validates — both paths in one update', moduleWrite(xs, 'x_pizza', 'Ham', true, XSTAFF, 2));
  await ok('A5 absent: a compat BELOW anything is irrelevant with no floor', moduleWrite(xs, 'x_pizza', 'Ham', false, XSTAFF, 0));
  await no('A6 absent: a non-numeric compat is refused by the additive .validate', moduleWrite(xs, 'x_pizza', 'Ham', false, XSTAFF, 'two'));
  await no('A7 absent: an unknown extra child is still refused ($other:false unchanged)', xs.ref(`restaurants/x_pizza/item_availability/${key('Ham')}`).set({ available: true, updated_at: 5, junk: 1 }));
  await ok('A8 absent: a member DELETE is allowed (today)', xs.ref(`restaurants/x_pizza/item_availability/${key('Ham')}`).remove());
  await ok('A9 absent: an audit-only member write is allowed (today: membership only)', xs.ref(`restaurants/x_pizza/availability_audit/${key('Ham')}`).set({ any: 'shape' }));
  await no('A10 absent: cross-restaurant staff refused', realWrite(ls, 'x_pizza', 'Ham', false, LSTAFF));
  await no('A11 absent: authenticated non-staff refused', realWrite(out, 'x_pizza', 'Ham', false, OUT));
  await no('A12 absent: the flat /kitchen member who is not kitchen_staff is refused (unchanged)', realWrite(env.authenticatedContext(KUSER).database(), 'x_pizza', 'Ham', false, KUSER));

  // ═══ B. floor PRESENT (x_pizza = 3) ═══
  await setFloor('x_pizza', 3);
  await ok('B1 present: compat == floor + server time, both paths atomically', moduleWrite(xs, 'x_pizza', 'Pepperoni', false, XSTAFF, 3));
  await ok('B2 present: compat ABOVE the floor passes', moduleWrite(xs, 'x_pizza', 'Pepperoni', true, XSTAFF, 4));
  await no('B3 present: compat BELOW the floor refused', moduleWrite(xs, 'x_pizza', 'Pepperoni', false, XSTAFF, 2));
  await no('B4 present: compat MISSING refused — today\'s (pre-module) writer is an old client', realWrite(xs, 'x_pizza', 'Pepperoni', false, XSTAFF));
  await no('B5 present: a non-numeric compat refused', moduleWrite(xs, 'x_pizza', 'Pepperoni', false, XSTAFF, '3'));
  await no('B6 present: a CLIENT-supplied updated_at (not server time) refused even at compat ≥ floor', moduleWrite(xs, 'x_pizza', 'Pepperoni', false, XSTAFF, 3, Date.now() - 3600000));
  assert.strictEqual((await read(`restaurants/x_pizza/item_availability/${key('Pepperoni')}`)).available, true, 'refused writes left the record as B2 wrote it');
  await no('B7 present: DELETE of item_availability refused (no newData.compat)', xs.ref(`restaurants/x_pizza/item_availability/${key('Pepperoni')}`).remove());
  await no('B8 present: DELETE of availability_audit refused', xs.ref(`restaurants/x_pizza/availability_audit/${key('Pepperoni')}`).remove());
  await no('B9 present: audit-only write without compat refused (the audit path is gated too)', xs.ref(`restaurants/x_pizza/availability_audit/${key('Pepperoni')}`).set({ available: true, updated_at: SV, updated_by: XSTAFF }));
  await ok('B10 present: audit-only write with compat ≥ floor + server time passes', xs.ref(`restaurants/x_pizza/availability_audit/${key('Pepperoni')}`).set({ available: true, updated_at: SV, updated_by: XSTAFF, compat: 3 }));
  await no('B11 present: a two-path update where ONE leaf is below the floor is refused atomically (neither lands)',
    xs.ref().update({ [`restaurants/x_pizza/item_availability/${key('Spinach')}`]: { available: false, updated_at: SV, compat: 3 },
      [`restaurants/x_pizza/availability_audit/${key('Spinach')}`]: { available: false, updated_at: SV, updated_by: XSTAFF, compat: 1 } }));
  assert.strictEqual(await read(`restaurants/x_pizza/item_availability/${key('Spinach')}`), null, 'atomic: the passing leaf did not land');
  // partial writes — the STATED scope (plan §5 codex r3 E): rules see the MERGED newData
  await no('B12 partial: a child-only update of `available` (merged updated_at is the OLD value ≠ now) is refused',
    xs.ref(`restaurants/x_pizza/item_availability/${key('Pepperoni')}`).update({ available: false }));
  await ok('B13 partial (STATED LIMIT, pinned): {available, updated_at: server} without compat INHERITS the stored compat 4 and passes — the floor guarantees whole-record writers only',
    xs.ref(`restaurants/x_pizza/item_availability/${key('Pepperoni')}`).update({ available: false, updated_at: SV }));
  await no('B14 present: cross-restaurant staff still refused (membership is ANDed, not ORed)', moduleWrite(ls, 'x_pizza', 'Pepperoni', true, LSTAFF, 9));
  await no('B15 present: non-staff refused even with a high compat', moduleWrite(out, 'x_pizza', 'Pepperoni', true, OUT, 9));
  // EACH PATH ALONE — a two-path update is refused if EITHER leaf fails, so every clause is also pinned per path
  const iaRef = (rid, raw) => xs.ref(`restaurants/${rid}/item_availability/${key(raw)}`);
  const auRef = (rid, raw) => xs.ref(`restaurants/${rid}/availability_audit/${key(raw)}`);
  await ok('B17 item_availability ALONE: compat ≥ floor + server time passes', iaRef('x_pizza', 'Olive').set({ available: false, updated_at: SV, compat: 3 }));
  await no('B18 item_availability ALONE: compat BELOW the floor refused', iaRef('x_pizza', 'Olive').set({ available: true, updated_at: SV, compat: 2 }));
  await no('B19 item_availability ALONE: client updated_at refused', iaRef('x_pizza', 'Olive').set({ available: true, updated_at: Date.now() - 3600000, compat: 3 }));
  await no('B20 availability_audit ALONE: compat BELOW the floor refused', auRef('x_pizza', 'Olive').set({ available: true, updated_at: SV, updated_by: XSTAFF, compat: 2 }));
  await no('B21 availability_audit ALONE: a STRING compat refused (no .validate on audit — the .write isNumber term decides)', auRef('x_pizza', 'Olive').set({ available: true, updated_at: SV, updated_by: XSTAFF, compat: '9' }));
  await no('B22 availability_audit ALONE: client updated_at refused', auRef('x_pizza', 'Olive').set({ available: true, updated_at: Date.now() - 3600000, updated_by: XSTAFF, compat: 3 }));
  await no('B23 item_availability ALONE: cross-restaurant staff with a passing compat refused (grouping)', ls.ref(`restaurants/x_pizza/item_availability/${key('Olive')}`).set({ available: true, updated_at: SV, compat: 9 }));
  await no('B24 availability_audit ALONE: cross-restaurant staff with a passing compat refused (grouping)', ls.ref(`restaurants/x_pizza/availability_audit/${key('Olive')}`).set({ available: true, updated_at: SV, updated_by: LSTAFF, compat: 9 }));
  await no('B26 availability_audit ALONE: a BOOLEAN compat refused', auRef('x_pizza', 'Olive').set({ available: true, updated_at: SV, updated_by: XSTAFF, compat: true }));
  await no('B25 item_availability ALONE: non-staff with a passing compat refused (grouping)', out.ref(`restaurants/x_pizza/item_availability/${key('Olive')}`).set({ available: true, updated_at: SV, compat: 9 }));
  await ok('B16 present on x_pizza only: la_musa has NO floor → today\'s REAL writer still works there', realWrite(ls, 'la_musa', 'dimsum_01', false, LSTAFF));
  // P-SELFUPDATE CP2 — the REAL writer, now stamped (setItemAvailability's 5th argument = the page's compat)
  await ok('B27 present: the REAL stamped KDS writer at compat == floor passes (both records, server time, one update)', realWrite(xs, 'x_pizza', 'Pepperoni', false, XSTAFF, 3));
  assert.deepStrictEqual(await read(`restaurants/x_pizza/item_availability/${key('Pepperoni')}`), { available: false, updated_at: (await read(`restaurants/x_pizza/item_availability/${key('Pepperoni')}`)).updated_at, compat: 3 }, 'the stamped record carries compat');
  await no('B28 present: the REAL stamped KDS writer BELOW the floor is refused', realWrite(xs, 'x_pizza', 'Pepperoni', true, XSTAFF, 2));
  assert.strictEqual((await read(`restaurants/x_pizza/item_availability/${key('Pepperoni')}`)).available, false, 'the refused stamped toggle left the record unchanged');
  await ok('B29 la_musa (no floor): the REAL stamped writer passes too (compat is an additive child)', realWrite(ls, 'la_musa', 'dimsum_01', true, LSTAFF, 1));

  // ═══ C. the floor node ═══
  await ok('C1 own-restaurant kitchen staff can READ its floor (the KDS checks it before writing)', xs.ref('restaurants/x_pizza/client_floor/kitchen').get());
  await no('C2 another restaurant\'s staff cannot read it', ls.ref('restaurants/x_pizza/client_floor/kitchen').get());
  await no('C3 unauthenticated read refused', anon.ref('restaurants/x_pizza/client_floor/kitchen').get());
  await no('C4 staff cannot WRITE the floor (lower it)', xs.ref('restaurants/x_pizza/client_floor/kitchen').set(0));
  await no('C5 staff cannot DELETE the floor', xs.ref('restaurants/x_pizza/client_floor/kitchen').remove());
  await no('C6 a dispatcher cannot write the floor either (owner CLI / Admin SDK only)', dp.ref('restaurants/x_pizza/client_floor/kitchen').set(1));
  await setFloor('x_pizza', 'abc');
  await no('C7 a MALFORMED floor (non-number, Admin-written) refuses every client write — fail closed; kill switch = delete', moduleWrite(xs, 'x_pizza', 'Pepperoni', true, XSTAFF, 99));

  // ═══ D. kill switch ═══
  await setFloor('x_pizza', null);
  await ok('D1 floor deleted → today\'s REAL writer succeeds again (instant kill switch, no deploy)', realWrite(xs, 'x_pizza', 'Pepperoni', true, XSTAFF));
  await ok('D2 floor deleted → a member delete is allowed again (today)', xs.ref(`restaurants/x_pizza/availability_audit/${key('Ham')}`).remove());

  // ═══ E. UNAFFECTED by a floor (the Q7 safety requirement) ═══
  await setFloor('x_pizza', 5); await setFloor('la_musa', 5);
  await ok('E1 floor set: a kitchen member READS /orders', xs.ref('orders').get());
  await ok('E2 floor set: the REAL KDS status write (setOrderStatus → orders/{id}/status) succeeds', (globalThis.__db = xs, XPD.setOrderStatus('O1', 'preparing')));
  assert.strictEqual(await read('orders/O1/status'), 'preparing');
  await ok('E3 floor set: status back to ready (the KDS bump path) succeeds', (globalThis.__db = xs, XPD.setOrderStatus('O1', 'ready')));
  await ok('E4 floor set: public read of item_availability unchanged (forms read it)', anon.ref('restaurants/x_pizza/item_availability').get());
  await ok('E5 floor set: staff read of availability_audit unchanged', xs.ref('restaurants/x_pizza/availability_audit').get());
  await ok('E6 floor set: a dispatcher reads dispatcher_alerts', dp.ref('dispatcher_alerts').get());
  await ok('E7 floor set: the REAL dismissDispatcherAlert (remove) succeeds', (globalThis.__db = dp, XPD.dismissDispatcherAlert('A1')));
  await ok('E8 floor set: kitchen_staff read unchanged', xs.ref('restaurants/x_pizza/kitchen_staff').get());
  await ok('E9 floor set: the restaurant identity read unchanged', xs.ref('restaurants/x_pizza/identity').get());
  await setFloor('x_pizza', null); await setFloor('la_musa', null);

  // ═══ F. telemetry / config nodes are deny-access ═══
  for (const p of ['client_versions/orders/i1', 'client_version_limits/k', 'client_version_stats/2026100512', 'platform_config/client_floor/orders']) {
    await no(`F ${p}: staff read refused`, xs.ref(p).get());
    await no(`F ${p}: dispatcher write refused`, dp.ref(p).set(1));
  }

  await env.cleanup();
  console.log(`client-floor-rules(emulator): OK (${n})`);
  process.exit(0);
} catch (e) {
  console.error('client-floor-rules(emulator) FAILED:', e);
  process.exit(1);
}
