// H1b T5 — feeds.js over a fake RTDB adapter: ONE /orders query (A-2), the control / brand / menu / availability / offset /
// connected listeners, `loaded` = the query's first snapshot, sessionLost on any listener cancel, full teardown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFeeds } from './feeds.js';
import * as M from './model.js';

function fakeRtdb() {
  const queries = []; const values = new Map(); let live = 0;
  return {
    onQuery(path, child, value, h) { const q = { path, child, value, h, on: true }; queries.push(q); live++; return () => { q.on = false; live--; }; },
    onValue(path, cb, err) { const v = { cb, err, on: true }; values.set(path, v); live++; return () => { v.on = false; live--; }; },
    q: () => queries[0], v: (p) => values.get(p), live: () => live, paths: () => [...values.keys()].sort(), queries,
  };
}
const order = (id, over = {}) => ({ order_id: id, restaurant_id: 'tb_norte', status: 'new', created_at: 1, ...over });

test('attaches exactly ONE /orders query (orderByChild restaurant_id == rid) + the six value listeners', () => {
  const db = fakeRtdb();
  startFeeds({ rtdb: db, rid: 'tb_norte', brandId: 'tb', onState: () => {} });
  assert.equal(db.queries.length, 1);
  assert.deepEqual([db.q().path, db.q().child, db.q().value], ['orders', 'restaurant_id', 'tb_norte']);
  assert.deepEqual(db.paths(), ['.info/connected', '.info/serverTimeOffset', 'menus/tb', 'order_control/tb_norte', 'public/brands/tb', 'restaurants/tb_norte/item_availability']);
});

test('not loaded yet → loaded:false (the list shows the offline banner, never an empty state); first snapshot → loaded', () => {
  const db = fakeRtdb(); const seen = [];
  startFeeds({ rtdb: db, rid: 'tb_norte', brandId: 'tb', onState: (s) => seen.push(s) });
  db.q().h.added('o1', order('o1'));
  assert.equal(seen.at(-1).loaded, false);
  db.q().h.loaded();
  assert.equal(seen.at(-1).loaded, true);
  assert.deepEqual(Object.keys(seen.at(-1).orders), ['o1']);
});

test('new → preparing is a CHANGE, not a disappearance; a cancelled order stays in the map (BC2 reads it authoritatively)', () => {
  const db = fakeRtdb(); let st;
  startFeeds({ rtdb: db, rid: 'tb_norte', brandId: 'tb', onState: (s) => { st = s; } });
  db.q().h.added('o1', order('o1')); db.q().h.loaded();
  db.q().h.changed('o1', order('o1', { status: 'preparing' }));
  assert.equal(st.orders.o1.status, 'preparing');
  assert.deepEqual(M.queues(st.orders).prep.map((o) => o.id), ['o1']);
  db.q().h.changed('o1', order('o1', { status: 'cancelled' }));
  assert.equal(M.rejectState(st.orders.o1), 'cancelled');
  assert.deepEqual(M.queues(st.orders), { nuevos: [], prep: [], listos: [] }, 'off the lists, still known');
  db.q().h.removed('o1');
  assert.equal(st.orders.o1, undefined);
});

test('control / brand / menu / availability / offset / connected land in the state', () => {
  const db = fakeRtdb(); let st;
  startFeeds({ rtdb: db, rid: 'tb_norte', brandId: 'tb', onState: (s) => { st = s; } });
  db.v('order_control/tb_norte').cb({ busy: { add_min: 15, until: 9 } });
  db.v('public/brands/tb').cb({ name: 'Marca TB' });
  db.v('menus/tb').cb({ items: {} });
  db.v('restaurants/tb_norte/item_availability').cb({ x: false });
  db.v('.info/serverTimeOffset').cb(-420);
  db.v('.info/connected').cb(true);
  assert.deepEqual([st.control.busy.add_min, st.brand.name, typeof st.menu, st.availability.x, st.offset, st.connected], [15, 'Marca TB', 'object', false, -420, true]);
});

test('a permission error (or any cancel) on ANY listener → sessionLost', () => {
  for (const which of ['query', 'order_control/tb_norte', 'menus/tb']) {
    const db = fakeRtdb(); let st;
    startFeeds({ rtdb: db, rid: 'tb_norte', brandId: 'tb', onState: (s) => { st = s; } });
    const e = Object.assign(new Error('permission_denied at /x'), { code: 'PERMISSION_DENIED' });
    if (which === 'query') db.q().h.error(e); else db.v(which).err(e);
    assert.equal(st.sessionLost, true, which);
  }
});

test('stop() tears EVERYTHING down; late events after stop are ignored (branch change)', () => {
  const db = fakeRtdb(); const seen = [];
  const f = startFeeds({ rtdb: db, rid: 'tb_norte', brandId: 'tb', onState: (s) => seen.push(s) });
  assert.equal(db.live(), 7);
  f.stop();
  assert.equal(db.live(), 0);
  const n = seen.length;
  db.q().h.added('o9', order('o9')); db.v('.info/connected').cb(false);
  assert.equal(seen.length, n);
});

test('emitted states are snapshots (a consumer mutating one cannot corrupt the feed)', () => {
  const db = fakeRtdb(); let st;
  startFeeds({ rtdb: db, rid: 'tb_norte', brandId: 'tb', onState: (s) => { st = s; } });
  db.q().h.added('o1', order('o1'));
  st.orders.o1.status = 'hacked'; delete st.orders.o1;
  db.q().h.loaded();
  assert.equal(st.orders.o1.status, 'new');
});
