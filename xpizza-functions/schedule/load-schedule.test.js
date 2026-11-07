'use strict';
// S4 C′ — loadSchedule: built on getIdentity (fresh-first / warm cache / 503), validates through the ONE grammar, serves the
// cfg the intake gate enforces. Run: node schedule/load-schedule.test.js
const assert = require('assert');
const SCHED = require('../scheduled-orders');
const { loadSchedule } = require('./load-schedule');
const RC = require('../restaurant-config');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const H7 = Object.fromEntries(DAYS.map((d) => [d, d === 'mon' ? { open: false } : { open: true, start: '12:00', end: '20:45' }]));
const ident = (hours) => ({ name: 'TB Centro', hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 5, version: 3, active: true, phone: '+50400000000', hours });

(async () => {
  {   // valid → hours served, valid, default cfg (== what validateScheduledFor enforces with no cfg), source from getIdentity
    const s = await loadSchedule(null, 'tb_centro', { getIdentity: async () => ({ ...ident(H7), _source: 'fresh' }), now: 1 });
    assert.deepStrictEqual(s.hours, H7, 'LS-VALID-HOURS');
    assert.strictEqual(s.valid, true); assert.deepStrictEqual(s.errors, []);
    assert.deepStrictEqual(s.cfg, SCHED.resolveCfg(), 'LS-CFG-IS-THE-GATE-DEFAULT');
    assert.strictEqual(s.source, 'fresh');
    ok('valid identity hours → {hours, valid:true, errors:[], cfg = resolveCfg() (the gate default), source}');
  }
  {   // grammar-invalid → hours withheld (null), valid:false, the grammar's errors
    const bad = { ...H7, fri: { open: true, start: '22:00', end: '02:00' } };
    const s = await loadSchedule(null, 'tb_centro', { getIdentity: async () => ident(bad), now: 1 });
    assert.strictEqual(s.valid, false, 'LS-INVALID'); assert.strictEqual(s.hours, null, 'LS-INVALID-HOURS-WITHHELD');
    assert.ok(s.errors.length > 0 && /fri/.test(s.errors[0]));
    const s2 = await loadSchedule(null, 'tb_centro', { getIdentity: async () => ident(undefined), now: 1 });
    assert.strictEqual(s2.valid, false, 'LS-MISSING-HOURS-INVALID'); assert.strictEqual(s2.hours, null);
    ok('grammar-invalid or missing hours → valid:false, hours:null (a new consumer can never act on them)');
  }
  {   // the identity read's 503 propagates (the consumer maps it)
    const err = Object.assign(new Error('identity unavailable'), { retryable: true, statusCode: 503 });
    await assert.rejects(() => loadSchedule(null, 'tb_centro', { getIdentity: async () => { throw err; }, now: 1 }), (e) => e === err, 'LS-503-PROPAGATES');
    ok('getIdentity failure (retryable 503) propagates unchanged');
  }
  {   // DEFAULT reader = restaurant-config.getIdentity: fresh read, then warm cache on a read error within TTL
    let fail = false;
    const db = { ref: (p) => ({ once: async () => { if (fail) throw new Error('down'); assert.strictEqual(p, 'restaurants/tb_lsdefault/identity'); return { exists: () => true, val: () => ident(H7) }; } }) };
    const a = await loadSchedule(db, 'tb_lsdefault', { now: 1000 });
    assert.strictEqual(a.source, 'fresh'); assert.strictEqual(a.valid, true);
    fail = true;
    const b = await loadSchedule(db, 'tb_lsdefault', { now: 2000 });
    assert.strictEqual(b.source, 'cache', 'LS-DEFAULT-WARM-CACHE'); assert.deepStrictEqual(b.hours, H7);
    await assert.rejects(() => loadSchedule(db, 'tb_lsdefault', { now: 1000 + RC.TTL_MS + 1 }), /fail-closed/, 'LS-DEFAULT-FAIL-CLOSED');
    ok('default reader is restaurant-config.getIdentity: fresh → warm cache within TTL → fail-closed 503');
  }
  console.log(`\nload-schedule: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
