/**
 * PLATFORM F2 Q1 (PLAN-F2-query-rules §1.8) — the ACCESS PROOF: one expectation table, principal × variant, run against the
 * three rule artifacts in the RTDB emulator (A = allowed, D = denied):
 *   R  = R-pre  = xpizza-reference/database.rules.json      (main + Q0 + Q1 indexes — today's broad human grants)
 *   H  = N-human = xpizza-reference/f2-narrow/N-human.rules.json  (Q4; also R-post)
 *   F  = N-full  = xpizza-reference/f2-narrow/N-full.rules.json   (Q6)
 * Every principal has POSITIVE rows next to its negative rows, so no cell passes vacuously. Fixtures: the synthetic third brand
 * tb_brand (tb_centro, tb_norte) + a legacy location leg_x. Plus the reassignment fact (Q-B) on H and F.
 *   npm run test:f2-access-rules
 */
require('./_emulator-required')('database');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const REF = path.join(__dirname, '..', '..', 'xpizza-reference');
const ARTIFACTS = {
  R: fs.readFileSync(path.join(REF, 'database.rules.json'), 'utf8'),
  H: fs.readFileSync(path.join(REF, 'f2-narrow', 'N-human.rules.json'), 'utf8'),
  F: fs.readFileSync(path.join(REF, 'f2-narrow', 'N-full.rules.json'), 'utf8'),
};
const C = 'tb_centro'; const NO = 'tb_norte'; const LEG = 'leg_x';
const order = (id, rid, extra = {}) => ({ order_id: id, status: 'preparing', restaurant_id: rid, payment_method: 'cash', ...extra });
const task = (oid, type, uid) => ({ order_id: oid, type, status: 'accepted', assigned_driver_id: uid });
const SEED = {
  'dispatchers/u-disp': true,
  'kitchen/u-kitA': true, [`restaurants/${C}/kitchen_staff/u-kitA`]: true,
  [`restaurants/${C}/identity/brand_id`]: 'tb_brand', [`restaurants/${NO}/identity/brand_id`]: 'tb_brand',
  'restaurants/tb_brand/owners/u-ownA': true, [`restaurants/${LEG}/owners/u-ownL`]: true,
  [`restaurants/${C}/owners/u-ownLocal`]: true,   // a location-LOCAL owner on a location whose identity names another brand (codex Q1 r1 P1-1)
  [`restaurants/${C}/handhelds/u-devLive`]: { kind: 'handheld', revoked: false },
  [`restaurants/${C}/managers/u-mgrA`]: true,
  [`restaurants/${C}/handhelds/u-dev`]: { kind: 'handheld', revoked: false },
  [`restaurants/${C}/handhelds/u-devRev`]: { kind: 'handheld', revoked: true },
  [`restaurants/${C}/handhelds/u-devKind`]: { kind: 'kiosk', revoked: false },
  [`restaurants/${C}/handhelds/u-devNoRevoked`]: { kind: 'handheld' },
  [`restaurants/${C}/handhelds/u-devMis`]: { kind: 'handheld', revoked: false },
  [`restaurants/${C}/handhelds/u-devRole`]: { kind: 'handheld', revoked: false }, 'dispatchers/u-devRole': true, [`restaurants/${C}/kitchen_staff/u-devRole`]: true,
  'driver_accounts/u-deact': { deactivated: true },
  'orders/O1': order('O1', C), 'orders/O2': order('O2', C, { status: 'delivered', delivered_by_driver_uid: 'u-d1' }),
  'orders/O3': order('O3', NO), 'orders/O4': order('O4', LEG, { status: 'delivered', delivered_by_uid: 'u-d1' }),
  'orders/O5': order('O5', C), 'orders/O6': order('O6', C),
  'orders/O7': order('O7', C, { payment_method: 'online', payment_status: 'confirmed' }),
  'tasks/O1_pickup': task('O1', 'pickup', 'u-d1'), 'tasks/O1_delivery': task('O1', 'delivery', 'u-d1'),
  'tasks/O5_pickup': task('O5', 'pickup', 'u-d2'), 'tasks/O6_delivery': task('O6', 'delivery', 'u-deact'),
  'order_timelines/O1/e1': { at: 1 }, 'order_timelines/O3/e1': { at: 1 }, 'order_timelines/O5/e1': { at: 1 },
  'kds_cancel_acks/O1': { at: 1, by: 'u-kitA' }, 'kds_cancel_acks/O3': { at: 1, by: 'x' },
};
const DEV = (uid, rid = C) => ({ handheld: true, rid });
const PRINCIPALS = {
  disp: ['u-disp'], kitA: ['u-kitA'], ownA: ['u-ownA'], ownL: ['u-ownL'], ownLocal: ['u-ownLocal'], mgrA: ['u-mgrA'], d1: ['u-d1'], svc: ['svc-assigner', { svc_assigner: true }],
  cust: ['u-cust', { customer: true }], deact: ['u-deact'],
  dev: ['u-dev', DEV()], devRev: ['u-devRev', DEV()], devKind: ['u-devKind', DEV()], devNoRevoked: ['u-devNoRevoked', DEV()],
  devNoReg: ['u-devNoReg', DEV()], devMis: ['u-devMis', DEV('u-devMis', NO)], devRole: ['u-devRole', DEV()],
};
// query helpers (compat API)
const byRid = (db, rid) => db.ref('orders').orderByChild('restaurant_id').equalTo(rid).once('value');
const by = (db, p, child, v) => db.ref(p).orderByChild(child).equalTo(v).once('value');
const get = (db, p) => db.ref(p).once('value');
// [label, (db of principal) => promise, principal, 'RHF' expectation string]
const ROWS = [
  ['dispatcher reads /orders root', (db) => get(db, 'orders'), 'disp', 'AAA'],
  ['dispatcher reads /tasks root', (db) => get(db, 'tasks'), 'disp', 'AAA'],
  ['dispatcher reads /order_timelines root', (db) => get(db, 'order_timelines'), 'disp', 'AAA'],
  ['dispatcher reads an order', (db) => get(db, 'orders/O3'), 'disp', 'AAA'],
  ['kitchen A: rid-A query', (db) => byRid(db, C), 'kitA', 'AAA'],
  ['kitchen A: A order point read', (db) => get(db, 'orders/O1'), 'kitA', 'AAA'],
  ['kitchen A: A order rid leaf (setOrderStatus read)', (db) => get(db, 'orders/O1/restaurant_id'), 'kitA', 'AAA'],
  ['kitchen A: A timeline', (db) => get(db, 'order_timelines/O1'), 'kitA', 'AAA'],
  ['kitchen A: A ack read', (db) => get(db, 'kds_cancel_acks/O1'), 'kitA', 'AAA'],
  ['kitchen A: A ack write', (db) => db.ref('kds_cancel_acks/O1').set({ at: 2, by: 'u-kitA' }), 'kitA', 'AAA'],
  ['kitchen A: A ack delete', (db) => db.ref('kds_cancel_acks/O1').remove(), 'kitA', 'AAA'],
  ['kitchen A: A status write', (db) => db.ref('orders/O1/status').set('ready'), 'kitA', 'AAA'],
  ['kitchen A: rid-B query', (db) => byRid(db, NO), 'kitA', 'ADD'],
  ['kitchen A: B order point read', (db) => get(db, 'orders/O3'), 'kitA', 'ADD'],
  ['kitchen A: B descendant (orders/O3/status)', (db) => get(db, 'orders/O3/status'), 'kitA', 'ADD'],
  ['kitchen A: B timeline', (db) => get(db, 'order_timelines/O3'), 'kitA', 'ADD'],
  ['kitchen A: B ack read', (db) => get(db, 'kds_cancel_acks/O3'), 'kitA', 'ADD'],
  ['kitchen A: B ack write', (db) => db.ref('kds_cancel_acks/O3').set({ at: 3, by: 'u-kitA' }), 'kitA', 'ADD'],
  ['kitchen A: B status write', (db) => db.ref('orders/O3/status').set('ready'), 'kitA', 'ADD'],
  ['kitchen A: whole /orders', (db) => get(db, 'orders'), 'kitA', 'ADD'],
  ['kitchen A: whole /kds_cancel_acks', (db) => get(db, 'kds_cancel_acks'), 'kitA', 'ADD'],
  ['kitchen A: UNINDEXED orderByChild(notes)', (db) => by(db, 'orders', 'notes', 'x'), 'kitA', 'ADD'],
  // an unrelated orderBy field EQUAL TO AN AUTHORIZED rid: only the orderByChild check can deny these (codex Q1 r1 P2-6)
  ['kitchen A: orderByChild(notes).equalTo(own rid)', (db) => by(db, 'orders', 'notes', C), 'kitA', 'ADD'],
  ['kitchen A: orderByChild(status).equalTo(own rid)', (db) => by(db, 'orders', 'status', C), 'kitA', 'ADD'],
  ['kitchen A: orderByChild(status)', (db) => by(db, 'orders', 'status', 'preparing'), 'kitA', 'ADD'],
  ['kitchen A: orderByChild(created_at)', (db) => by(db, 'orders', 'created_at', 1), 'kitA', 'ADD'],
  ['kitchen A: orderByKey', (db) => db.ref('orders').orderByKey().equalTo('O1').once('value'), 'kitA', 'ADD'],
  ['kitchen A: orderByValue', (db) => db.ref('orders').orderByValue().limitToFirst(1).once('value'), 'kitA', 'ADD'],
  ['kitchen A: orderByPriority', (db) => db.ref('orders').orderByPriority().limitToFirst(1).once('value'), 'kitA', 'ADD'],
  ['kitchen A: restaurant_id with no bound', (db) => db.ref('orders').orderByChild('restaurant_id').once('value'), 'kitA', 'ADD'],
  ['kitchen A: restaurant_id equalTo(null)', (db) => by(db, 'orders', 'restaurant_id', null), 'kitA', 'ADD'],
  ["kitchen A: restaurant_id equalTo('')", (db) => by(db, 'orders', 'restaurant_id', ''), 'kitA', 'ADD'],
  ['kitchen A: restaurant_id equalTo(number)', (db) => by(db, 'orders', 'restaurant_id', 5), 'kitA', 'ADD'],
  // equalTo(v) IS startAt(v).endAt(v) on the wire, so equal bounds are the same (allowed) query — a WIDER range is denied
  ['kitchen A: equal-bound range (=== equalTo, same set)', (db) => db.ref('orders').orderByChild('restaurant_id').startAt(C).endAt(C).once('value'), 'kitA', 'AAA'],
  ['kitchen A: WIDER restaurant_id range', (db) => db.ref('orders').orderByChild('restaurant_id').startAt(C).endAt(`${C}\uf8ff`).once('value'), 'kitA', 'ADD'],
  ['kitchen A: open-ended range (startAt only)', (db) => db.ref('orders').orderByChild('restaurant_id').startAt(C).once('value'), 'kitA', 'ADD'],
  ['kitchen A: unordered limitToFirst', (db) => db.ref('orders').limitToFirst(1).once('value'), 'kitA', 'ADD'],
  ['brand owner: own-brand rid query (tb_centro)', (db) => byRid(db, C), 'ownA', 'AAA'],
  ['brand owner: own-brand rid query (tb_norte)', (db) => byRid(db, NO), 'ownA', 'AAA'],
  ['brand owner: own-brand order point read', (db) => get(db, 'orders/O3'), 'ownA', 'AAA'],
  ['brand owner: other brand rid (leg_x)', (db) => byRid(db, LEG), 'ownA', 'ADD'],
  ['legacy owner: own location query', (db) => byRid(db, LEG), 'ownL', 'AAA'],
  ['legacy owner: other location query', (db) => byRid(db, C), 'ownL', 'ADD'],
  // the rid-local owners list counts ONLY when the identity names no brand (codex Q1 r1 P1-1)
  ['rid-local owner of a BRANDED location: rid query denied', (db) => byRid(db, C), 'ownLocal', 'ADD'],
  ['rid-local owner of a BRANDED location: order point read denied', (db) => get(db, 'orders/O1'), 'ownLocal', 'ADD'],
  ['manager A: rid-A query', (db) => byRid(db, C), 'mgrA', 'ADA'],
  ['manager A: A point read', (db) => get(db, 'orders/O1'), 'mgrA', 'ADA'],
  ['manager A: rid-B query', (db) => byRid(db, NO), 'mgrA', 'ADD'],
  ['driver: own-task query', (db) => by(db, 'tasks', 'assigned_driver_id', 'u-d1'), 'd1', 'AAA'],
  ['driver: own task point read', (db) => get(db, 'tasks/O1_pickup'), 'd1', 'AAA'],
  ['driver: own-task order point read', (db) => get(db, 'orders/O1'), 'd1', 'AAA'],
  ['driver: own-task timeline', (db) => get(db, 'order_timelines/O1'), 'd1', 'AAA'],
  ['driver: history query (primary)', (db) => by(db, 'orders', 'delivered_by_driver_uid', 'u-d1'), 'd1', 'AAA'],
  ['driver: history query (legacy)', (db) => by(db, 'orders', 'delivered_by_uid', 'u-d1'), 'd1', 'AAA'],
  ['driver: order via primary attribution after task deletion', (db) => get(db, 'orders/O2'), 'd1', 'AAA'],
  ['driver: order via legacy attribution (union, accepted)', (db) => get(db, 'orders/O4'), 'd1', 'AAA'],
  ["driver: another uid's task query", (db) => by(db, 'tasks', 'assigned_driver_id', 'u-d2'), 'd1', 'ADD'],
  ['driver: whole /tasks', (db) => get(db, 'tasks'), 'd1', 'ADD'],
  ['driver: whole /orders', (db) => get(db, 'orders'), 'd1', 'ADD'],
  ["driver: another driver's order", (db) => get(db, 'orders/O5'), 'd1', 'ADD'],
  ["driver: another driver's timeline", (db) => get(db, 'order_timelines/O5'), 'd1', 'ADD'],
  ["driver: another driver's task", (db) => get(db, 'tasks/O5_pickup'), 'd1', 'ADD'],
  ["driver: history query for another uid", (db) => by(db, 'orders', 'delivered_by_driver_uid', 'u-d2'), 'd1', 'ADD'],
  ['svc-assigner: derived leaf (assigned_driver_id)', (db) => get(db, 'tasks/O1_delivery/assigned_driver_id'), 'svc', 'AAA'],
  ['svc-assigner: whole task', (db) => get(db, 'tasks/O1_delivery'), 'svc', 'ADD'],
  ['svc-assigner: ordinary task query', (db) => by(db, 'tasks', 'assigned_driver_id', 'svc-assigner'), 'svc', 'ADD'],
  ['svc-assigner: whole /orders', (db) => get(db, 'orders'), 'svc', 'ADD'],
  ['customer: whole /orders', (db) => get(db, 'orders'), 'cust', 'DDD'],
  ['customer: rid query', (db) => byRid(db, C), 'cust', 'DDD'],
  ['deactivated driver: own-task query', (db) => by(db, 'tasks', 'assigned_driver_id', 'u-deact'), 'deact', 'DDD'],
  ['deactivated driver: own-task order', (db) => get(db, 'orders/O6'), 'deact', 'DDD'],
  ['device: own rid query (registered, kind ok, revoked false, claim = rid)', (db) => byRid(db, C), 'dev', 'DDA'],
  ['device: order point read', (db) => get(db, 'orders/O1'), 'dev', 'DDD'],
  ['device: order child', (db) => get(db, 'orders/O1/status'), 'dev', 'DDD'],
  ['device: task point read', (db) => get(db, 'tasks/O1_pickup'), 'dev', 'DDD'],
  ['device: timeline', (db) => get(db, 'order_timelines/O1'), 'dev', 'DDD'],
  ['device: another rid query', (db) => byRid(db, NO), 'dev', 'DDD'],
  ['device: whole /orders', (db) => get(db, 'orders'), 'dev', 'DDD'],
  ['device: revoked', (db) => byRid(db, C), 'devRev', 'DDD'],
  ['device: wrong kind', (db) => byRid(db, C), 'devKind', 'DDD'],
  ['device: revoked absent', (db) => byRid(db, C), 'devNoRevoked', 'DDD'],
  ['device: no registration', (db) => byRid(db, C), 'devNoReg', 'DDD'],
  ['device: claim rid ≠ registered rid (queries its claim rid)', (db) => byRid(db, NO), 'devMis', 'DDD'],
  ['device: claim rid ≠ queried rid', (db) => byRid(db, C), 'devMis', 'DDD'],
  ['device with dispatcher + kitchen roles: whole /orders', (db) => get(db, 'orders'), 'devRole', 'DDD'],
  ['device with dispatcher + kitchen roles: order point read', (db) => get(db, 'orders/O1'), 'devRole', 'DDD'],
  ['payment protection: kitchen cancels an online confirmed order', (db) => db.ref('orders/O7/status').set('cancelled'), 'kitA', 'DDD'],
  // the dispatcher's whole-order .write grant cascades over the leaf protection — unchanged behaviour in every variant
  ['dispatcher cancel of an online confirmed order: unchanged (parent write grant)', (db) => db.ref('orders/O7/status').set('cancelled'), 'disp', 'AAA'],
];

(async () => {
  let n = 0; const pass = (l) => console.log(`  ✓ ${++n} ${l}`);
  const fails = []; const reconnectEvidence = {};
  for (const [vi, v] of ['R', 'H', 'F'].entries()) {
    const env = await initializeTestEnvironment({ projectId: `demo-f2-access-${v.toLowerCase()}`, database: { rules: ARTIFACTS[v] } });
    await env.withSecurityRulesDisabled((ctx) => ctx.database().ref().update(SEED));
    const dbs = {};
    for (const [k, [uid, token]] of Object.entries(PRINCIPALS)) dbs[k] = env.authenticatedContext(uid, token || {}).database();
    for (const [label, fn, who, exp] of ROWS) {
      const want = exp[vi];
      try { await (want === 'A' ? assertSucceeds : assertFails)(fn(dbs[who])); } catch (e) { fails.push(`[${v}] ${label} — expected ${want === 'A' ? 'ALLOW' : 'DENY'}: ${String(e.message || e).slice(0, 90)}`); }
      // writes that succeeded mutate state: reseed so every row sees the same fixture
      await env.withSecurityRulesDisabled((ctx) => ctx.database().ref().update(SEED));
    }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const admin = (u) => env.withSecurityRulesDisabled((ctx) => ctx.database().ref().update(u));
    // ── Q-B reassignment (H, F; codex Q1 r1 P2-8): initial delivery ASSERTED; both legs reassigned → the retained listener is
    //    CANCELLED with PERMISSION_DENIED and gets no later value; a reconnect is denied; the NEW driver's task read is allowed ──
    if (v !== 'R') {
      const seen = []; let cancelled = null;
      const ref = env.authenticatedContext('u-d1').database().ref('orders/O1');
      ref.on('value', (s) => seen.push(s.val() && s.val().status), (e) => { cancelled = String((e && e.code) || e); });
      await sleep(600);
      if (seen[0] !== 'preparing') fails.push(`[${v}] Q-B: the initial delivery did not arrive (${JSON.stringify(seen)})`);
      await admin({ 'tasks/O1_pickup/assigned_driver_id': 'u-d2', 'tasks/O1_delivery/assigned_driver_id': 'u-d2' });
      await sleep(600);
      await admin({ 'orders/O1/status': 'after_reassign' });
      await sleep(1200);
      ref.off();
      if (!/PERMISSION_DENIED/i.test(String(cancelled))) fails.push(`[${v}] Q-B: the retained listener was not cancelled with PERMISSION_DENIED (${cancelled})`);
      if (seen.includes('after_reassign')) fails.push(`[${v}] Q-B: a reassigned-away driver received a later value (${JSON.stringify(seen)})`);
      try { await assertFails(get(env.authenticatedContext('u-d1').database(), 'orders/O1')); } catch (_) { fails.push(`[${v}] Q-B: a reconnect (fresh read) after reassignment was allowed`); }
      try { await assertFails(get(env.authenticatedContext('u-d1').database(), 'tasks/O1_pickup')); } catch (_) { fails.push(`[${v}] Q-B: the old driver still reads the task`); }
      try { await assertSucceeds(get(env.authenticatedContext('u-d2').database(), 'tasks/O1_pickup')); } catch (_) { fails.push(`[${v}] Q-B: the NEW driver cannot read its task`); }
      try { await assertSucceeds(get(env.authenticatedContext('u-d2').database(), 'orders/O1')); } catch (_) { fails.push(`[${v}] Q-B: the NEW driver cannot read the order`); }
      try { await assertSucceeds(get(env.authenticatedContext('u-d1').database(), 'orders/O2')); } catch (_) { fails.push(`[${v}] Q-B: an attribution-granted order became unreadable`); }
      await env.withSecurityRulesDisabled((ctx) => ctx.database().ref().update(SEED));
    }
    // ── a REAL reconnect (codex Q1 r2 P2): the old driver's OWN subscribed instance goes offline, the order is reassigned while it
    //    is offline, the instance comes back online → its listener must be cancelled (PERMISSION_DENIED) or never re-deliver,
    //    and a later order update must not reach it ──
    {
      const rdb = env.authenticatedContext('u-d1').database();
      const rseen = []; let rcancel = null;
      const rref = rdb.ref('orders/O1');
      rref.on('value', (snap) => rseen.push(snap.val() && snap.val().status), (e) => { rcancel = String((e && e.code) || e); });
      await sleep(600);
      if (rseen[0] !== 'preparing') fails.push(`[${v}] reconnect: the initial delivery did not arrive (${JSON.stringify(rseen)})`);
      rdb.goOffline();
      await admin({ 'tasks/O1_pickup/assigned_driver_id': 'u-d2', 'tasks/O1_delivery/assigned_driver_id': 'u-d2', 'orders/O1/status': 'while_offline' });
      await sleep(400);
      rdb.goOnline();
      await sleep(1200);
      await admin({ 'orders/O1/status': 'after_reconnect' });
      await sleep(1200);
      rref.off();
      const leaked = rseen.filter((x) => x === 'while_offline' || x === 'after_reconnect');
      if (v === 'R') { if (!rseen.includes('after_reconnect')) fails.push(`[R] reconnect CONTROL: under the broad grant the old driver must keep receiving (${JSON.stringify(rseen)})`); }
      else if (leaked.length) fails.push(`[${v}] reconnect: the old driver received ${JSON.stringify(leaked)} after reconnecting`);
      if (rcancel !== null && !/PERMISSION_DENIED/i.test(rcancel)) fails.push(`[${v}] reconnect: cancelled with an unexpected error (${rcancel})`);
      reconnectEvidence[v] = { seen: rseen, cancelled: rcancel };
      await env.withSecurityRulesDisabled((ctx) => ctx.database().ref().update(SEED));
    }
    // ── device revoked DURING an active subscription (F only: the device query is allowed there) → the listener is cancelled ──
    if (v === 'F') {
      const seen = []; let cancelled = null;
      const q = env.authenticatedContext('u-devLive', { handheld: true, rid: C }).database().ref('orders').orderByChild('restaurant_id').equalTo(C);
      q.on('value', (s) => seen.push(Object.keys(s.val() || {}).length), (e) => { cancelled = String((e && e.code) || e); });
      await sleep(600);
      if (!(seen[0] > 0)) fails.push(`[F] device live: the initial delivery did not arrive (${JSON.stringify(seen)})`);
      await admin({ [`restaurants/${C}/handhelds/u-devLive/revoked`]: true });
      await sleep(600);
      await admin({ 'orders/O1/status': 'after_revoke' });
      await sleep(1200);
      q.off();
      if (!/PERMISSION_DENIED/i.test(String(cancelled))) fails.push(`[F] device live: revocation did not cancel the active subscription (${cancelled})`);
      if (seen.length > 1) fails.push(`[F] device live: values arrived after revocation (${JSON.stringify(seen)})`);
      try { await assertFails(env.authenticatedContext('u-devLive', { handheld: true, rid: C }).database().ref('orders').orderByChild('restaurant_id').equalTo(C).once('value')); } catch (_) { fails.push('[F] device live: a fresh query after revocation was allowed'); }
    }
    await env.cleanup();
    pass(`${v === 'R' ? 'R-pre (base + Q0 + indexes)' : v === 'H' ? 'N-human (Q4 = R-post)' : 'N-full (Q6)'}: ${ROWS.length} principal rows${v !== 'R' ? ' + the Q-B lifecycle (initial delivery, PERMISSION_DENIED cancel, fresh read denied, new driver allowed, REAL reconnect: no re-delivery)' : ''}${v === 'F' ? ' + device revoked mid-subscription → cancelled' : ''}`);
  }
  console.log(`  · real reconnect (old driver's own instance offline → reassigned → online): ${JSON.stringify(reconnectEvidence)}`);
  assert.deepStrictEqual(fails, [], `access table mismatches:\n  ${fails.join('\n  ')}`);
  console.log(`f2-access-rules.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('f2-access-rules.emulator: FAIL\n', e.message || e); process.exit(1); });
