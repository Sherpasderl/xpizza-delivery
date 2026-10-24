// Shared test fixture: a RELEASED scheduled order built from the real releaseOne writer, under a
// frozen logical clock so the test is deterministic regardless of wall-clock time (the writer's
// release-time window validation rejects a slot computed as `now + 90min` near the 23:59 close —
// a classic wall-clock time bomb; see memory test-wall-clock-time-bomb). Used by both the node test
// and the headless-Chrome geometry runner so they share ONE source of the released-order shape.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const { releaseOne } = require('../xpizza-functions/scheduled-release-core.js');
const HERE = dirname(fileURLToPath(import.meta.url));

// 04:29Z — the instant Codex names: 22:29 America/Tegucigalpa, deep enough into the evening that a
// `now + 90min` slot would have crossed the 23:59 close. A fixed valid slot (+30min) stays open.
export const FROZEN = Date.UTC(2026, 9, 24, 4, 29, 0);

// Stub the WHOLE Date (not only Date.now): no-arg `new Date()` and `Date.now()` return the frozen
// instant; `new Date(arg)` still builds a real date (slot-format formats specific timestamps).
export async function withFrozenClock(fn) {
  const RealDate = globalThis.Date;
  class FrozenDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(FROZEN); else super(...a); }
    static now() { return FROZEN; }
  }
  globalThis.Date = FrozenDate;
  try { return await fn(); } finally { globalThis.Date = RealDate; }
}

function makeDb(initial) {
  const root = JSON.parse(JSON.stringify(initial));
  const get = (p) => (p ? p.split('/').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), root) : root);
  const set = (p, v) => { const ks = p.split('/').filter(Boolean); let o = root; for (let i = 0; i < ks.length - 1; i++) { o[ks[i]] ??= {}; o = o[ks[i]]; } const last = ks[ks.length - 1]; if (v === null) delete o[last]; else o[last] = v; };
  return {
    get,
    ref: (p = '') => ({
      async transaction(fn) { const cur = get(p) ?? null; const res = fn(cur); if (res === undefined) return { committed: false, snapshot: { val: () => get(p) ?? null } }; set(p, res); return { committed: true, snapshot: { val: () => res } }; },
      async update(obj) { if (!p) { for (const [k, v] of Object.entries(obj)) set(k, v); } else { const cur = get(p) || {}; for (const [k, v] of Object.entries(obj)) { if (v === null) delete cur[k]; else cur[k] = v; } set(p, cur); } },
      async once() { return { val: () => get(p) ?? null }; },
    }),
  };
}

const OPEN_ALL_DAY = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, { start: '00:00', end: '23:59' }]));

// Build a released scheduled order by running the REAL writer against an in-memory DB. Call inside
// withFrozenClock so `now`/`scheduled_for` are deterministic. released_at lands `agoMin` before FROZEN.
export async function makeReleasedOrder({ agoMin = 8, rid = 'la_musa' } = {}) {
  const now = FROZEN - agoMin * 60 * 1000;
  const SF = FROZEN + 30 * 60 * 1000;                      // a fixed valid slot inside the open window
  const scheduled = {
    status: 'scheduled', release_at: now - 1000, scheduled_for: SF, restaurant_id: rid,
    created_at: FROZEN - 5 * 3600 * 1000,                  // placed 5 h before release
    customer_name: 'Rodrigo Fúnez', customer_phone: '+504 3345-7788', order_type: 'delivery',
    total: 430, items_text: '2× Pizza', address_detected: 'Res. Villas del Sol',
    hub_lat: 15.5, hub_lng: -88.0, restaurant_name: 'La Musa', restaurant_display_name: 'La Musa',
  };
  const db = makeDb({ orders: { o1187: scheduled }, restaurants: { [rid]: { identity: { hours: OPEN_ALL_DAY } } } });
  const res = await releaseOne({ db, genToken: () => 'tok', restaurantFallback: { lat: 15.5, lng: -88.0, name: 'La Musa', phone: '' } }, { orderId: 'o1187', now, claimId: 'c1' });
  if (!res.released) throw new Error('fixture: the real writer did not release the order: ' + JSON.stringify(res));
  return { order: db.get('orders/o1187'), SF };
}
