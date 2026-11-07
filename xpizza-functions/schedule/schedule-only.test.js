'use strict';
// S4 C′ (PLAN-capp-S4-r4 §2) — quoteOrder's schedule_only handler, driven directly with a recording db + limiter.
// The REAL-export wiring (hook position before the quote_ip limiter / pricing; ordinary quotes untouched) is pinned by
// s4hours-wiring.guard.test.js; the emulator suite drives the real export. Run: node schedule/schedule-only.test.js
const assert = require('assert');
const SCHED = require('../scheduled-orders');
const { resolveRestaurantId } = require('../restaurant-id');
const SO = require('./schedule-only');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const H7 = Object.fromEntries(DAYS.map((d) => [d, d === 'mon' ? { open: false } : { open: true, start: '12:00', end: '20:45' }]));
const ident = (hours) => ({ name: 'TB', hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 5, version: 1, active: true, phone: '+50400000000', hours });
const BRANDS = { tb_brand: { name: 'TB', locations: { tb_centro: { location_name: 'Centro' } } }, tb_empty: { name: 'Empty' } };

function mkDb({ brands = BRANDS, brandsThrows = false } = {}) {
  const log = [];
  return {
    log,
    ref(p) {
      return {
        once: async () => { log.push(['read', p]); if (p === 'public/brands' && brandsThrows) throw new Error('down'); return { val: () => (p === 'public/brands' ? brands : null), exists: () => p === 'public/brands' }; },
        set: async () => { log.push(['WRITE', p]); }, update: async () => { log.push(['WRITE', p]); }, transaction: async () => { log.push(['WRITE', p]); },
      };
    },
  };
}
function mkRes() {
  const r = { statusCode: null, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  return r;
}
const limiterCalls = [];
const limiter = (allowed = true, retryAfterSec = 0) => async (db, bucket, key, cfg) => { limiterCalls.push({ bucket, key, cfg }); return { allowed, retryAfterSec }; };
const run = async ({ body, rid = 'tb_centro', db = mkDb(), lim = limiter(), getIdentity = async () => ident(H7), now = 1_000_000 } = {}) => {
  const res = mkRes();
  const handled = await SO.handle({ res, body, db, restaurantId: rid, clientIp: '203.0.113.9', checkRateLimit: lim, deps: { getIdentity, now: () => now } });
  return { handled, res, db };
};

(async () => {
  {   // not an app schedule read → NOT handled (ordinary quote path runs as today), and NOTHING is read, written or limited
    for (const body of [{ schedule_only: true }, { schedule_only: true, entry_mode: 'form' }, { schedule_only: 'true', entry_mode: 'app' }, { entry_mode: 'app' }, {}]) {
      SO._resetListedCache(); limiterCalls.length = 0;
      const { handled, res, db } = await run({ body });
      assert.strictEqual(handled, false, `SO-NOT-APP ${JSON.stringify(body)}`);
      assert.strictEqual(res.statusCode, null); assert.deepStrictEqual(db.log, []); assert.strictEqual(limiterCalls.length, 0);
    }
    ok('non-app / non-strict selector → returns false: no read, no write, no limiter call (the ordinary quote runs unchanged)');
  }
  const APP = { schedule_only: true, entry_mode: 'app', restaurant_id: 'tb_centro' };
  {   // published member → the schedule; ONLY the visibility read + identity read; the limiter bucket is schedule_ip
    SO._resetListedCache(); limiterCalls.length = 0;
    const { handled, res, db } = await run({ body: APP });
    assert.strictEqual(handled, true); assert.strictEqual(res.statusCode, 200, 'SO-PUBLISHED-200');
    const c = SCHED.resolveCfg();
    assert.deepStrictEqual(res.body, { ok: true, schedule: { tz_offset_min: -360, slot_min: c.slotMin, lead_min: { pickup: 60, delivery: 60 }, horizon_h: c.maxHorizonHours, hours: H7 } }, 'SO-PUBLISHED-BODY');
    assert.deepStrictEqual(limiterCalls, [{ bucket: 'schedule_ip', key: '203.0.113.9', cfg: SO.SCHEDULE_IP_BUCKET }], 'SO-OWN-BUCKET');
    assert.ok(limiterCalls.every((l) => l.bucket !== 'quote_ip'), 'SO-NO-QUOTE-IP');
    assert.deepStrictEqual(db.log, [['read', 'public/brands']], 'SO-READS-ONLY-VISIBILITY (identity via the injected getIdentity)');
    assert.ok(!db.log.some(([k]) => k === 'WRITE'), 'SO-NO-BUSINESS-WRITE');
    ok('published member → 200 {schedule} (tz −360, slot, lead per mode, horizon, hours); own schedule_ip bucket; reads public/brands only; no write');
  }
  {   // rate-limited → 429 + Retry-After, nothing else read
    SO._resetListedCache();
    const { res, db } = await run({ body: APP, lim: limiter(false, 37) });
    assert.strictEqual(res.statusCode, 429); assert.deepStrictEqual(res.body, { ok: false, error: 'rate_limited' }); assert.strictEqual(res.headers['Retry-After'], '37');
    assert.deepStrictEqual(db.log, [], 'SO-LIMITED-NO-READ');
    ok('throttled → 429 rate_limited + Retry-After, before any read');
  }
  {   // unpublished-but-known rid → BYTE-IDENTICAL to quoteOrder's unknown-rid 400
    SO._resetListedCache();
    for (const rid of ['tb_unpub', 'tb_empty']) {
      const { res } = await run({ body: { ...APP, restaurant_id: rid }, rid });
      const unknown = { ok: false, error: 'bad_request', detail: resolveRestaurantId(rid, new Set()).error };   // quoteOrder's own unknown answer
      assert.strictEqual(res.statusCode, 400, `SO-UNPUB-400 ${rid}`);
      assert.strictEqual(JSON.stringify(res.body), JSON.stringify(unknown), `SO-UNPUB-BYTES ${rid}`);
    }
    ok('a known-but-unpublished rid gets bytes identical to the unknown-restaurant 400');
  }
  {   // grammar-invalid identity, identity 503, visibility read failure → 503 schedule_unavailable
    const bad = { ...H7, fri: { open: true, start: '22:00', end: '02:00' } };
    const cases = [
      ['invalid', { getIdentity: async () => ident(bad) }],
      ['identity-503', { getIdentity: async () => { throw Object.assign(new Error('x'), { statusCode: 503 }); } }],
      ['brands-down', { db: mkDb({ brandsThrows: true }) }],
    ];
    for (const [label, over] of cases) {
      SO._resetListedCache();
      const { res } = await run({ body: APP, ...over });
      assert.strictEqual(res.statusCode, 503, `SO-503 ${label}`);
      assert.deepStrictEqual(res.body, { ok: false, error: 'schedule_unavailable', retryable: true }, `SO-503-BODY ${label}`);
    }
    ok('grammar-invalid hours / identity unavailable / visibility read failure → 503 schedule_unavailable (retryable)');
  }
  {   // visibility warm cache: one public/brands read per TTL
    SO._resetListedCache();
    const db = mkDb();
    await run({ body: APP, db, now: 1_000_000 }); await run({ body: APP, db, now: 1_000_000 + 29_000 }); await run({ body: APP, db, now: 1_000_000 + 31_000 });
    assert.strictEqual(db.log.filter(([, p]) => p === 'public/brands').length, 2, 'SO-VISIBILITY-TTL');
    ok('visibility uses a ≤30 s warm cache (one public/brands read per window)');
  }
  {   // the served lead == the floor validateScheduledFor enforces (default cfg AND a cfg where the release lead dominates)
    const slotMs = SCHED.resolveCfg().slotMin * 60000;
    const now = slotMs * 1000;   // on the slot grid
    const allOpen = Object.fromEntries(DAYS.map((d) => [d, { open: true, start: '00:00', end: '23:59' }]));
    for (const cfg of [undefined, { minLeadMin: 30, releaseLeadDeliveryMin: 90, releaseLeadPickupMin: 45 }]) {
      const c = SCHED.resolveCfg(cfg);
      for (const type of ['pickup', 'delivery']) {
        const lead = SO.minLeadFor(type, c);
        assert.strictEqual(SCHED.validateScheduledFor(allOpen, now + lead * 60000, now, type, cfg).valid, true, `SO-LEAD-EDGE-OK ${type}`);
        assert.strictEqual(SCHED.validateScheduledFor(allOpen, now + lead * 60000 - slotMs, now, type, cfg).reason, 'below_min_lead', `SO-LEAD-EDGE-REFUSED ${type}`);
      }
    }
    ok('served lead_min equals validateScheduledFor\'s real accept/refuse edge (default cfg + a release-lead-dominant cfg)');
  }
  console.log(`\nschedule-only: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
