'use strict';

// Golden unit tests for the KDS-2b availability auto-reset core (availability-reset.js).
// Run: node availability-reset.test.js
//
// Injected-clock + fake-RTDB (no emulator). Proves: closed-gate SKIPS when open; the marker date is correct
// in Tegucigalpa (an evening reset can't roll to tomorrow's UTC date); ONLY {available:false} is cleared
// (available:true / absent untouched); a staff 86 with updated_at > the SERVER-time started_at SURVIVES
// (R4 — the cutoff is RTDB server time, not the CF Date.now()); a crash-resume PRESERVES the original
// started_at (fresh 86 survives, old 86 cleared); 'in_progress' resumes / 'done' aborts; and the reset
// touches NO non-availability path. See KDS_2B_AUTORESET_PLAN.md.

const assert = require('assert');
const AR = require('./availability-reset');

let n = 0;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const MIN = 60000;
// local (UTC−6) wall-clock → UTC ms (matches scheduled-orders.test.js helper)
const L = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h + 6, mi);

// La-Musa-shaped hours: Mon closed; Tue–Thu 17:00–20:45; Fri/Sat 17:00–21:45; Sun 12:00–20:45
const HOURS = {
  sun: { open: true, start: '12:00', end: '20:45' }, mon: { open: false, start: '00:00', end: '00:00' },
  tue: { open: true, start: '17:00', end: '20:45' }, wed: { open: true, start: '17:00', end: '20:45' },
  thu: { open: true, start: '17:00', end: '20:45' }, fri: { open: true, start: '17:00', end: '21:45' },
  sat: { open: true, start: '17:00', end: '21:45' },
};

// The real firebase-admin ServerValue.TIMESTAMP sentinel shape. The fake db resolves it to `serverTime`.
const SV = { TIMESTAMP: { '.sv': 'timestamp' } };

// ── minimal in-memory RTDB fake ────────────────────────────────────────────────────────────────────────
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function makeDb(initial, serverTime) {
  const data = clone(initial) || {};
  const resolve = (v) => {
    if (v && typeof v === 'object' && v['.sv'] === 'timestamp') return serverTime;
    if (v && typeof v === 'object') { const o = Array.isArray(v) ? [] : {}; for (const k of Object.keys(v)) o[k] = resolve(v[k]); return o; }
    return v;
  };
  const get = (path) => path.split('/').reduce((o, k) => (o == null ? undefined : o[k]), data);
  const set = (path, val) => {
    const segs = path.split('/');
    let o = data;
    for (let i = 0; i < segs.length - 1; i++) { if (o[segs[i]] == null || typeof o[segs[i]] !== 'object') o[segs[i]] = {}; o = o[segs[i]]; }
    const last = segs[segs.length - 1];
    if (val === null) delete o[last]; else o[last] = val;
  };
  return {
    _data: data,
    ref(path) {
      return {
        once() { return Promise.resolve({ val: () => { const v = get(path); return v === undefined ? null : clone(v); } }); },
        transaction(fn) {
          const cur = get(path);
          const out = fn(cur === undefined ? null : clone(cur));
          if (out === undefined) return Promise.resolve({ committed: false, snapshot: { val: () => (cur === undefined ? null : clone(cur)) } });
          const resolved = out === null ? null : resolve(out);
          set(path, resolved);
          return Promise.resolve({ committed: true, snapshot: { val: () => (resolved === null ? null : clone(resolved)) } });
        },
        update(obj) { const cur = get(path); const merged = { ...(cur && typeof cur === 'object' ? cur : {}) }; for (const k of Object.keys(obj)) merged[k] = resolve(obj[k]); set(path, merged); return Promise.resolve(); },
      };
    },
  };
}
const quietLog = { info() {}, error() {} };
const avail = (available, updated_at) => ({ available, updated_at });

(async () => {
// ── (1) localDateInTZ — evening UTC-rollover stays on the same Tegucigalpa day ───────────────────────────
// Teg Tue Jan 6 20:00 == UTC Wed Jan 7 02:00. The marker date MUST be 2026-01-06, not 2026-01-07.
assert.strictEqual(AR.localDateInTZ(L(2026, 0, 6, 20, 0)), '2026-01-06'); ok('localDateInTZ: Teg 20:00 (UTC next-day 02:00) → 2026-01-06 (no UTC roll)');
assert.strictEqual(AR.localDateInTZ(L(2026, 0, 5, 19, 0)), '2026-01-05'); ok('localDateInTZ: Teg Mon 19:00 → 2026-01-05');

// ── (2) closed-gate SKIPS when the restaurant is OPEN ────────────────────────────────────────────────────
{
  const nowOpen = L(2026, 0, 6, 18, 0); // Tue 18:00 local — OPEN
  const db = makeDb({ restaurants: { x_pizza: { identity: { hours: HOURS }, item_availability: { Pizza: avail(false, 1) } } } }, nowOpen);
  const [r] = await AR.runAvailabilityReset({ db, ServerValue: SV, now: nowOpen, restaurants: ['x_pizza'], log: quietLog });
  assert.deepStrictEqual(r, { rid: 'x_pizza', skipped: true, reason: 'open' }); ok('closed-gate: OPEN → skipped (reason=open)');
  assert.deepStrictEqual(db._data.restaurants.x_pizza.item_availability, { Pizza: avail(false, 1) }); ok('closed-gate: OPEN → item_availability untouched');
  assert.strictEqual(db._data.restaurants.x_pizza.availability_reset_marker, undefined); ok('closed-gate: OPEN → no marker written');
}

// ── (3+4) CLOSED fresh run: clears available:false ≤ cutoff; leaves available:true, absent, and R4 fresh-86 ─
{
  const nowWall = L(2026, 0, 5, 19, 0);   // Mon 19:00 local — CLOSED (Mon open:false)
  const serverTime = nowWall - 10 * MIN;  // RTDB clock is BEHIND the CF wall clock → started_at resolves here
  const db = makeDb({ restaurants: { la_musa: {
    identity: { hours: HOURS },
    item_availability: {
      Old86:     avail(false, nowWall - 60 * MIN),  // sold-out before cutoff → CLEARED
      Available: avail(true,  nowWall - 60 * MIN),  // available:true → UNTOUCHED (never widened-to-sold-out either)
      FreshR4:   avail(false, nowWall - 5 * MIN),   // updated_at > serverTime(started_at) but < wall now → R4: SURVIVES
    },
    orders: { PZX1: { status: 'new', total: 500 } },   // a NON-availability sibling — must be untouched
  } } }, serverTime);

  const [r] = await AR.runAvailabilityReset({ db, ServerValue: SV, now: nowWall, restaurants: ['la_musa'], log: quietLog });
  const ia = db._data.restaurants.la_musa.item_availability;

  assert.strictEqual(r.count, 1); assert.deepStrictEqual(r.cleared, ['Old86']); ok('clear: exactly the stale 86 (Old86) cleared');
  assert.strictEqual(ia.Old86, undefined); ok('clear: Old86 (available:false ≤ cutoff) → removed (absent = available)');
  assert.deepStrictEqual(ia.Available, avail(true, nowWall - 60 * MIN)); ok('clear: available:true → UNTOUCHED');
  assert.deepStrictEqual(ia.FreshR4, avail(false, nowWall - 5 * MIN)); ok('R4: staff 86 with updated_at > SERVER started_at (but < CF Date.now()) → SURVIVES');
  assert.strictEqual(r.started_at, serverTime); ok('R4: cutoff = RTDB server-time started_at (read back), not the wall clock');

  const mk = db._data.restaurants.la_musa.availability_reset_marker;
  assert.strictEqual(mk.status, 'done'); assert.strictEqual(mk.date, '2026-01-05'); assert.strictEqual(mk.started_at, serverTime); assert.strictEqual(mk.completed_at, serverTime); ok('marker: finalized done, date/started_at correct');
  assert.deepStrictEqual(db._data.restaurants.la_musa.orders, { PZX1: { status: 'new', total: 500 } }); ok('isolation: non-availability sibling (orders) untouched');
}

// ── (5) 'done' today ABORTS; re-run is a no-op ───────────────────────────────────────────────────────────
{
  const nowWall = L(2026, 0, 5, 19, 0);
  const db = makeDb({ restaurants: { la_musa: {
    identity: { hours: HOURS },
    item_availability: { Late86: avail(false, nowWall - MIN) }, // a NEW 86 after the reset already completed
    availability_reset_marker: { date: '2026-01-05', status: 'done', started_at: nowWall - 100 * MIN, completed_at: nowWall - 90 * MIN },
  } } }, nowWall);
  const [r] = await AR.runAvailabilityReset({ db, ServerValue: SV, now: nowWall, restaurants: ['la_musa'], log: quietLog });
  assert.deepStrictEqual(r, { rid: 'la_musa', skipped: true, reason: 'already_done' }); ok('lease: date==today && done → aborts (already_done)');
  assert.deepStrictEqual(db._data.restaurants.la_musa.item_availability, { Late86: avail(false, nowWall - MIN) }); ok('lease: post-reset staff 86 preserved (not cleared by a later tick)');
}

// ── (6) crash-resume: 'in_progress' RESUMES, PRESERVES the original started_at (fresh 86 survives) ────────
{
  const nowWall = L(2026, 0, 5, 19, 0);
  const T0 = nowWall - 20 * MIN;          // original started_at from the crashed run
  const serverTime = nowWall - MIN;       // if the resume WRONGLY overwrote started_at, it would use THIS (later) cutoff
  const db = makeDb({ restaurants: { la_musa: {
    identity: { hours: HOURS },
    item_availability: {
      Old86:   avail(false, T0 - 30 * MIN),  // before T0 → CLEARED
      Fresh86: avail(false, T0 + 5 * MIN),   // after T0 but before serverTime → survives ONLY if started_at preserved at T0
    },
    availability_reset_marker: { date: '2026-01-05', status: 'in_progress', started_at: T0, completed_at: null },
  } } }, serverTime);

  const [r] = await AR.runAvailabilityReset({ db, ServerValue: SV, now: nowWall, restaurants: ['la_musa'], log: quietLog });
  const ia = db._data.restaurants.la_musa.item_availability;
  const mk = db._data.restaurants.la_musa.availability_reset_marker;
  assert.strictEqual(r.started_at, T0); ok('resume: cutoff = PRESERVED original started_at (T0), not the new server time');
  assert.strictEqual(ia.Old86, undefined); ok('resume: pre-T0 86 cleared');
  assert.deepStrictEqual(ia.Fresh86, avail(false, T0 + 5 * MIN)); ok('resume: staff 86 after T0 SURVIVES the crash-resume (stable cutoff)');
  assert.strictEqual(mk.status, 'done'); assert.strictEqual(mk.started_at, T0); ok('resume: finalized done, started_at unchanged');
}

// ── (7) no non-availability path touched — write-surface is EXACTLY the 2 paths ───────────────────────────
// Instrument every write; assert each write path is under item_availability or availability_reset_marker.
{
  const nowWall = L(2026, 0, 5, 19, 0);
  const serverTime = nowWall - 5 * MIN;
  const base = makeDb({ restaurants: { x_pizza: {
    identity: { hours: HOURS }, item_availability: { A: avail(false, 1), B: avail(true, 1) },
    orders: { O: 1 }, tasks: { T: 1 }, availability_audit: { A: { x: 1 } },
  } } }, serverTime);
  const writes = [];
  const wrap = (path) => {
    const inner = base.ref(path);
    return {
      once: inner.once,
      transaction: (fn) => { const p = inner.transaction(fn); return p.then((res) => { if (res.committed) writes.push(path); return res; }); },
      update: (obj) => { writes.push(path); return inner.update(obj); },
    };
  };
  const db = { _data: base._data, ref: wrap };
  await AR.runAvailabilityReset({ db, ServerValue: SV, now: nowWall, restaurants: ['x_pizza'], log: quietLog });
  const OK = (p) => /^restaurants\/x_pizza\/(item_availability(\/|$)|availability_reset_marker$)/.test(p);
  for (const p of writes) assert.ok(OK(p), `FAIL: wrote outside the availability surface: ${p}`);
  assert.ok(writes.some((p) => p.includes('availability_reset_marker')) && writes.some((p) => p.includes('item_availability/A'))); ok('isolation: every write is under item_availability or availability_reset_marker (grep-proved at runtime)');
  assert.deepStrictEqual(base._data.restaurants.x_pizza.availability_audit, { A: { x: 1 } }); ok('isolation: availability_audit (staff record) NOT clobbered');
  assert.deepStrictEqual(base._data.restaurants.x_pizza.orders, { O: 1 }); ok('isolation: orders untouched');
}

// ── (8) per-restaurant independent try/catch — one restaurant erroring never fails the other ─────────────
{
  const nowWall = L(2026, 0, 5, 19, 0);
  const good = makeDb({ restaurants: { la_musa: { identity: { hours: HOURS }, item_availability: { A: avail(false, 1) } } } }, nowWall - MIN);
  // A db whose x_pizza reads throw, but la_musa delegates to the good fake.
  const db = { ref(path) {
    if (path.startsWith('restaurants/x_pizza')) return { once: () => Promise.reject(new Error('boom')), transaction: () => Promise.reject(new Error('boom')), update: () => Promise.reject(new Error('boom')) };
    return good.ref(path);
  } };
  const res = await AR.runAvailabilityReset({ db, ServerValue: SV, now: nowWall, restaurants: ['x_pizza', 'la_musa'], log: quietLog });
  assert.strictEqual(res[0].reason, 'error'); ok('resilience: x_pizza error → swallowed (reason=error)');
  assert.strictEqual(res[1].count, 1); ok('resilience: la_musa still fully reset despite x_pizza error');
  assert.strictEqual(good._data.restaurants.la_musa.item_availability.A, undefined); ok('resilience: la_musa 86 cleared');
}

console.log(`\navailability-reset: ${n} assertions passed`);
})().catch((e) => { console.error('availability-reset: FAILED\n', e); process.exit(1); });
