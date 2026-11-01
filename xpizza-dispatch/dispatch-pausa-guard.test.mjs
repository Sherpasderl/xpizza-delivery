// xpizza-dispatch/dispatch-pausa-guard.test.mjs
/* «Pausa» (PLAN-driver-pausa-server r1.1 §5 / §4, owner ruling BLOCK): the REAL dispatch SDK (desktop AND mobile copies, executed
 * — not regexed) refuses to hand-assign or reassign onto a paused driver, writes NOTHING when it refuses, is byte-unchanged for an
 * available driver, catches a driver who paused AFTER the picker opened (the stale picker / stale mobile confirmation), and the
 * forced clock-out (endShift — the Torre's forceOffShift) clears break_since.
 * The Firebase web SDK is replaced by an in-memory RTDB stub at the module boundary (data: URL modules); every SDK line runs.
 * Run: node xpizza-dispatch/dispatch-pausa-guard.test.mjs */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ── an in-memory RTDB behind the web-SDK surface the dispatch SDK imports ──
globalThis.__tbStore = { data: {}, writes: 0 };
const STUB = `
const S = globalThis.__tbStore;
const parts = (p) => String(p || '').split('/').filter(Boolean);
const getAt = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), S.data);
const setAt = (p, v) => { const ks = parts(p); if (!ks.length) { S.data = v ?? {}; return; } let o = S.data; for (const k of ks.slice(0, -1)) o = o[k] = (o[k] && typeof o[k] === 'object') ? o[k] : {}; if (v === null || v === undefined) delete o[ks.at(-1)]; else o[ks.at(-1)] = v; };
const TS = '__tb_ts__';
const resolve = (v) => (v === TS ? 1800000000000 : (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)])) : v));
export const initializeApp = () => ({});
export const getAuth = () => ({}); export const signInWithEmailAndPassword = async () => ({}); export const signOut = async () => {}; export const onAuthStateChanged = () => () => {};
export const getDatabase = () => ({});
export const ref = (db, p) => ({ path: p || '' });
export const serverTimestamp = () => TS;
export async function get(r) { const v = getAt(r.path); return { val: () => (v === undefined ? null : JSON.parse(JSON.stringify(v))), exists: () => v !== undefined }; }
export async function set(r, v) { S.writes++; setAt(r.path, resolve(v)); }
export async function update(r, obj) { S.writes++; for (const [k, v] of Object.entries(obj)) setAt((r.path ? r.path + '/' : '') + k, resolve(v)); }
export async function remove(r) { S.writes++; setAt(r.path, null); }
export async function runTransaction(r, fn) {
  const cur = getAt(r.path); const next = fn(cur === undefined ? null : JSON.parse(JSON.stringify(cur)));
  if (next === undefined) return { committed: false, snapshot: { val: () => (cur === undefined ? null : cur) } };
  S.writes++; setAt(r.path, resolve(next)); return { committed: true, snapshot: { val: () => getAt(r.path) ?? null } };
}
export const onValue = () => () => {}; export const off = () => {}; export const query = (...a) => a[0]; export const orderByChild = () => ({}); export const equalTo = () => ({});
`;
const enc = (t) => encodeURIComponent(t).replace(/'/g, '%27');   // a specifier lives inside '…': escape the quote too
const stubUrl = `data:text/javascript,${enc(STUB)}`;
const h0Url = `data:text/javascript,${enc(fs.readFileSync(path.join(here, 'dispatch-h0-dismiss.js'), 'utf8'))}`;
async function loadSdk(file) {
  const src = fs.readFileSync(file, 'utf8')
    .replace(/from 'https:\/\/www\.gstatic\.com\/firebasejs\/[^']+';/g, `from '${stubUrl}';`)
    .replace(/from '\.\/dispatch-h0-dismiss\.js\?v=1';/, `from '${h0Url}';`);
  assert.ok(!/^(?:import|\}).*from '(?:https:|\.\/)/m.test(src), `premise: every import of ${path.basename(path.dirname(file))} is stubbed`);
  return import(`data:text/javascript,${enc(src)}`);
}

const D_PAUSED = 'tb_drv_paused', D_OK = 'tb_drv_ok', OID = 'tb_o1';
const seed = () => ({
  drivers: { [D_PAUSED]: { name: 'Tb P', active: true, status: 'on_break', break_since: 1799999000000 }, [D_OK]: { name: 'Tb A', active: true, status: 'available' } },
  tasks: {
    [`${OID}_pickup`]: { order_id: OID, type: 'pickup', status: 'pending', assigned_driver_id: null, restaurant_id: 'tb_rest', destination_lat: 15.1, destination_lng: -88.1 },
    [`${OID}_delivery`]: { order_id: OID, type: 'delivery', status: 'pending', assigned_driver_id: null },
  },
});
const reset = (d) => { globalThis.__tbStore.data = clone(d); globalThis.__tbStore.writes = 0; };
const snap = () => clone(globalThis.__tbStore.data);

for (const [key, file] of [['desktop', path.join(here, 'xpizza-delivery.js')], ['mobile', path.join(here, '..', 'xpizza-dispatch-mobile', 'xpizza-delivery.js')]]) {
  const SDK = await loadSdk(file);
  SDK.initDelivery({});

  // assign onto a paused driver → refused, NOTHING written
  reset(seed());
  const before = snap();
  const r = await SDK.assignOrderToDriver(OID, D_PAUSED);
  assert.deepStrictEqual(r, { ok: false, reason: 'on_break' }, `PAUSA-ASSIGN-REFUSED ${key}`);
  assert.deepStrictEqual(snap(), before, `PAUSA-ASSIGN-NOWRITE ${key}: the refusal writes nothing`);
  assert.strictEqual(globalThis.__tbStore.writes, 0, `PAUSA-ASSIGN-NOWRITE-COUNT ${key}`);

  // an AVAILABLE driver → assigned exactly as today
  reset(seed());
  const ra = await SDK.assignOrderToDriver(OID, D_OK);
  assert.deepStrictEqual(ra, { ok: true, stacked: false }, `PAUSA-ASSIGN-OK ${key}`);
  assert.strictEqual(snap().tasks[`${OID}_delivery`].assigned_driver_id, D_OK, `PAUSA-ASSIGN-OK-WRITE ${key}`);
  assert.strictEqual(snap().tasks[`${OID}_pickup`].status, 'assigned', `PAUSA-ASSIGN-OK-STATUS ${key}`);

  // reassign onto a paused driver → refused, nothing written (the order stays with its current driver)
  const assigned = snap();
  globalThis.__tbStore.writes = 0;
  const rr = await SDK.reassignOrder(OID, D_PAUSED, D_OK);
  assert.deepStrictEqual(rr, { ok: false, reason: 'on_break' }, `PAUSA-REASSIGN-REFUSED ${key}`);
  assert.deepStrictEqual(snap(), assigned, `PAUSA-REASSIGN-NOWRITE ${key}`);

  // the STALE picker / stale mobile confirmation: the target was available when the picker opened, paused before the click
  reset(seed());
  globalThis.__tbStore.data.drivers[D_OK].status = 'on_break';   // paused after the picker rendered it as available
  assert.deepStrictEqual(await SDK.assignOrderToDriver(OID, D_OK), { ok: false, reason: 'on_break' }, `PAUSA-STALE-PICKER ${key}`);
  assert.strictEqual(snap().tasks[`${OID}_delivery`].assigned_driver_id, null, `PAUSA-STALE-PICKER-NOWRITE ${key}`);

  // «A mí» / self-assign: the dispatcher's own uid is just another target — refused while paused
  reset(seed());
  assert.deepStrictEqual(await SDK.assignOrderToDriver(OID, D_PAUSED, snap().tasks), { ok: false, reason: 'on_break' }, `PAUSA-SELF ${key} (pre-fetched tasks path too)`);

  // the forced clock-out clears the pause
  reset(seed());
  await SDK.endShift(D_PAUSED);
  const dv = snap().drivers[D_PAUSED];
  assert.strictEqual(dv.status, 'off_shift', `PAUSA-ENDSHIFT-STATUS ${key}`);
  assert.strictEqual(dv.break_since, undefined, `PAUSA-ENDSHIFT-CLEAR ${key}: forceOffShift ends the pause`);
  assert.strictEqual(dv.active, false, `PAUSA-ENDSHIFT-ACTIVE ${key} (existing behaviour kept)`);
  ok(`${key}: assign / reassign / stale picker / self-assign onto a paused driver → {ok:false, reason:'on_break'}, nothing written; an available driver is assigned as today; endShift clears break_since`);
}

assert.strictEqual(fs.readFileSync(path.join(here, 'xpizza-delivery.js'), 'utf8'), fs.readFileSync(path.join(here, '..', 'xpizza-dispatch-mobile', 'xpizza-delivery.js'), 'utf8'), 'PAUSA-PARITY the two SDK copies stay byte-identical');
ok('the desktop and mobile SDK copies are byte-identical');
console.log(`\n${pass} passed`);
