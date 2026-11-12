'use strict';
// ENVÍO STEP 2 — the owner-only writer with drawn no-delivery zones, and the hours lock (PLAN-envio-zones-step2-r2 §2, §3; owner D1/D4;
// Codex r1 F2/F3/F6/F10). The REAL setDeliveryPricingCore on the strict faithful RTDB fake (speculative null first pass, pruning);
// the lock runs the REAL loadSchedule over the REAL getIdentity (its warm cache cleared per case) on grammar-valid identities.
// Clock: Wednesday 12:00 in Honduras (UTC−6) = 18:00Z. Run: node delivery/zones-writer.test.js
const assert = require('assert');
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');
const A = require('./pricing-admin-core');
const Z = require('./zones');
const P = require('./delivery-pricing');
const ZL = require('./zones-lock');
const RC = require('../restaurant-config');
const { loadSchedule } = require('../schedule/load-schedule');

let n = 0; const fails = [];
async function cell(label, fn) { RC._cache.clear(); try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

const PATH = 'platform_config/delivery_pricing';
const BANDS = [{ max_km: 3, cents: 3000 }, { max_km: 6, cents: 5000 }, { max_km: 9.5, cents: 7000 }];
const NOW = Date.UTC(2026, 10, 11, 18, 0);   // Wed 2026-11-11 12:00 local
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const hoursAll = (start, end) => Object.fromEntries(DAYS.map((d) => [d, start ? { open: true, start, end } : { open: false }]));
const ID = (name, hours, extra = {}) => ({ name, phone: '+50499990000', active: true, version: 1, hub_lat: 15.5, hub_lng: -88.0, delivery_radius_km: 8, location_name: `Sucursal ${name}`, ...(hours === undefined ? {} : { hours }), ...extra });
const CLOSED = hoursAll(null), OPEN = hoursAll('10:00', '22:00'), JUST_CLOSED = hoursAll('08:00', '11:55'), CLOSED_20 = hoursAll('08:00', '11:40');
const ZONE = (id = 'z_aaaaaaaa', name = 'Sector A', o = 0) => ({ id, name, points: [
  { lat: 15.5 + o, lng: -88.03 }, { lat: 15.5 + o, lng: -88.02 }, { lat: 15.509 + o, lng: -88.02 }, { lat: 15.509 + o, lng: -88.03 }] });
const req = (body) => ({ get: (h) => (String(h).toLowerCase() === 'authorization' ? 'Bearer admin' : null), body });
let AT = 1762800000000;

// faults: { [pathPrefix]: 'throw' } — a read of a matching path throws (an outage)
function world({ ids = ['tb_r1', 'tb_r2'], identities = { tb_r1: ID('Uno', CLOSED), tb_r2: ID('Dos', CLOSED) }, init = {}, registry, grace } = {}) {
  const restaurants = Object.fromEntries(Object.entries(identities).filter(([, v]) => v).map(([rid, identity]) => [rid, { identity }]));
  const db = fakeRtdb({ platform_admins: { tbowner: true }, restaurants, ...(grace === undefined ? {} : { config: { order_grace_minutes: grace } }), ...init }, { strict: true });
  const faults = {};
  const realRef = db.ref.bind(db);
  db.ref = (p) => { const k = Object.keys(faults).find((f) => String(p).startsWith(f)); if (!k) return realRef(p); const boom = async () => { throw new Error('down'); }; return { once: boom, get: boom }; };
  let identityReads = 0;
  const deps = { db, verifyIdToken: async () => ({ uid: 'tbowner' }), timestamp: () => ++AT,
    readRegistry: registry || (async () => ({ ok: true, fresh: true, ids })),
    getIdentity: (d, rid, now) => { identityReads++; return RC.getIdentity(d, rid, now); },
    readGrace: (d) => ZL.readGraceMinutesStrict(d), now: () => NOW };
  return { db, deps, faults, reads: () => identityReads,
    set: (body) => A.setDeliveryPricingCore(deps, req(body)), get: () => A.getDeliveryPricingCore(deps, req()) };
}
const body = (over = {}) => ({ expected_policy_version: 0, bands: BANDS, ...over });
const node = (w) => w.db.get(PATH);

(async () => {
  // ── the data contract (F6) ──
  await cell('ZWR-FIRST-SAVE-EMPTY-IS-ABSENT', async (L) => {
    const w = world();
    const r = await w.set(body({ no_delivery_zones: [] }));
    assert.deepStrictEqual([r.status, r.body.ok], [200, true], `${L}: ${JSON.stringify(r.body)}`);
    assert.strictEqual('no_delivery_zones' in node(w), false, `${L}: an empty list is stored ABSENT`);
    assert.deepStrictEqual(node(w).history[0].new, { bands: BANDS, zones: { count: 0, sha256: Z.sha([]) } }, `${L}: history records count + sha of the logical []`);
  });

  await cell('ZWR-SAVE-ROUNDTRIP', async (L) => {
    const w = world();
    const input = [ZONE(), ZONE('z_bbbbbbbb', 'Sector B', 0.02)];
    const r = await w.set(body({ no_delivery_zones: input }));
    assert.strictEqual(r.status, 200, `${L}: ${JSON.stringify(r.body)}`);
    assert.deepStrictEqual(node(w).no_delivery_zones[0].points[0], [15.5, -88.03], `${L}: stored as compact pairs`);
    const g = await w.get();
    assert.deepStrictEqual(g.body.no_delivery_zones, input, `${L}: portal object → compact → portal object`);
    assert.deepStrictEqual(node(w).history[0].new.zones, { count: 2, sha256: Z.sha(node(w).no_delivery_zones) }, `${L}: history: count + sha, never the shapes`);
    assert.strictEqual(JSON.stringify(node(w).history).includes('points'), false, `${L}: no shape is copied into history (D4)`);
    assert.deepStrictEqual([g.body.caps.zones_max, g.body.caps.points_max], [8, 24], `${L}: the zone caps are served`);
  });

  await cell('ZWR-OMITTED-FIELD-KEEPS-VALUE-AND-PRESENCE', async (L) => {
    const w = world();
    await w.set(body({ no_delivery_zones: [ZONE()] }));
    const before = JSON.stringify(node(w).no_delivery_zones);
    const r = await w.set({ expected_policy_version: 1, bands: [{ max_km: 3, cents: 3500 }] });
    assert.strictEqual(r.status, 200, `${L}: a bands-only save`);
    assert.strictEqual(JSON.stringify(node(w).no_delivery_zones), before, `${L}: the stored zones are kept byte-identical`);
    const w2 = world();
    await w2.set(body());
    await w2.set({ expected_policy_version: 1, bands: BANDS });
    assert.strictEqual('no_delivery_zones' in node(w2), false, `${L}: an absent field stays absent`);
  });

  await cell('ZWR-REMOVE-LAST-ZONE-IS-ABSENT', async (L) => {
    const w = world();
    await w.set(body({ no_delivery_zones: [ZONE()] }));
    const r = await w.set({ expected_policy_version: 1, bands: BANDS, no_delivery_zones: [] });
    assert.strictEqual(r.status, 200, `${L}: ${JSON.stringify(r.body)}`);
    assert.strictEqual('no_delivery_zones' in node(w), false, `${L}: the last zone removed → the field is absent`);
  });

  await cell('ZWR-REFUSALS', async (L) => {
    const w = world();
    const bad = await w.set(body({ no_delivery_zones: [{ ...ZONE(), points: ZONE().points.slice(0, 2) }] }));
    assert.deepStrictEqual([bad.status, bad.body.error, bad.body.field, bad.body.zone_id], [400, 'bad_request', 'zones', 'z_aaaaaaaa'], `${L}: a malformed zone → 400 with its id (${JSON.stringify(bad.body)})`);
    const nine = Array.from({ length: 9 }, (_, i) => ZONE(`z_${String(i).padStart(8, '0')}`, `S${i}`, i * 0.02));
    assert.deepStrictEqual([(await w.set(body({ no_delivery_zones: nine }))).body.field], ['zone_caps'], `${L}: 9 zones → zone_caps`);
    assert.strictEqual((await w.set(body({ no_delivery_zones: {} }))).status, 400, `${L}: not a list`);
    assert.strictEqual(node(w), null, `${L}: nothing written`);
  });

  await cell('ZWR-MALFORMED-STORED-ZONES', async (L) => {
    const w = world({ init: { platform_config: { delivery_pricing: { policy_version: 1, bands: BANDS, no_delivery_zones: [{ id: 'z_aaaaaaaa', name: 'X', points: [[15.5, -88.03], [15.5, -88.02]] }] } } } });
    const g = await w.get();
    assert.strictEqual(g.body.current_malformed, true, `${L}: GET reports the stored zones malformed`);
    const s = await w.set({ expected_policy_version: 1, bands: BANDS });
    assert.deepStrictEqual([s.status, s.body.error], [409, 'current_malformed'], `${L}: a save over malformed zones is refused`);
  });

  // ── the hours lock (D1; F2, F3) ──
  await cell('LOCK-ALL-CLOSED-SAVES', async (L) => {
    const w = world({ identities: { tb_r1: ID('Uno', CLOSED), tb_r2: ID('Dos', CLOSED_20) } });
    const r = await w.set(body({ no_delivery_zones: [ZONE()] }));
    assert.strictEqual(r.status, 200, `${L}: every branch closed beyond grace → saved (${JSON.stringify(r.body)})`);
  });

  await cell('LOCK-OPEN-AT-CHECK-REFUSES', async (L) => {
    const w = world({ identities: { tb_r1: ID('Uno', CLOSED), tb_r2: ID('Dos', OPEN) } });
    const r = await w.set(body({ no_delivery_zones: [ZONE()] }));
    assert.deepStrictEqual([r.status, r.body.error, r.body.branches], [409, 'zones_locked_while_open', [{ rid: 'tb_r2', location_name: 'Sucursal Dos', reason: 'open' }]], `${L}: a branch open at the check → refused, named (${JSON.stringify(r.body)})`);
    assert.strictEqual(node(w), null, `${L}: nothing written`);
  });

  await cell('LOCK-WITHIN-GRACE-REFUSES', async (L) => {
    const w = world({ identities: { tb_r1: ID('Uno', JUST_CLOSED), tb_r2: ID('Dos', CLOSED) } });
    const r = await w.set(body({ no_delivery_zones: [ZONE()] }));
    assert.deepStrictEqual([r.status, r.body.error], [409, 'zones_locked_while_open'], `${L}: closed 5 min ago (grace 15) → still locked`);
    const w30 = world({ identities: { tb_r1: ID('Uno', CLOSED_20), tb_r2: ID('Dos', CLOSED) }, grace: 30 });
    assert.strictEqual((await w30.set(body({ no_delivery_zones: [ZONE()] }))).status, 409, `${L}: a configured 30-min grace is honoured (closed 20 min ago)`);
  });

  await cell('LOCK-GRACE-READ-FAILS-503', async (L) => {
    const w = world({ identities: { tb_r1: ID('Uno', CLOSED_20), tb_r2: ID('Dos', CLOSED) }, grace: 30 });
    w.faults['config/order_grace_minutes'] = 'throw';
    const r = await w.set(body({ no_delivery_zones: [ZONE()] }));
    assert.deepStrictEqual([r.status, r.body.error, r.body.retryable], [503, 'hours_unavailable', true], `${L}: a failed grace read never falls back to 15 here (F2)`);
  });

  await cell('LOCK-CACHE-SOURCED-503', async (L) => {
    const w = world();
    await loadSchedule(w.db, 'tb_r1', { now: NOW });   // warm the cache with a good identity
    await w.db.ref('restaurants/tb_r1/identity').remove();   // then the identity is deleted
    const r = await w.set(body({ no_delivery_zones: [ZONE()] }));
    assert.deepStrictEqual([r.status, r.body.error], [503, 'hours_unavailable'], `${L}: a warm cache after deletion is not fresh evidence (${JSON.stringify(r.body)})`);
    const w2 = world();
    await loadSchedule(w2.db, 'tb_r1', { now: NOW });
    w2.faults['restaurants/tb_r1'] = 'throw';
    assert.strictEqual((await w2.set(body({ no_delivery_zones: [ZONE()] }))).status, 503, `${L}: a warm cache after a failed fresh read → 503`);
    const w3 = world();
    w3.faults['restaurants/tb_r1'] = 'throw';
    assert.strictEqual((await w3.set(body({ no_delivery_zones: [ZONE()] }))).status, 503, `${L}: no cache + a failed read → 503`);
  });

  await cell('LOCK-HOURS-UNKNOWN-409', async (L) => {
    for (const [label, hours] of [['missing hours', undefined], ['grammar-invalid hours (24:00)', hoursAll('00:00', '24:00')]]) {
      const w = world({ identities: { tb_r1: ID('Uno', hours), tb_r2: ID('Dos', CLOSED) } });
      const r = await w.set(body({ no_delivery_zones: [ZONE()] }));
      assert.deepStrictEqual([r.status, r.body.error, r.body.branches && r.body.branches[0].reason], [409, 'zones_locked_while_open', 'hours_unknown'], `${L}: ${label} → hours_unknown (${JSON.stringify(r.body)})`);
    }
  });

  await cell('LOCK-REGISTRY-NOT-FRESH-503', async (L) => {
    const w = world({ registry: async () => ({ ok: true, fresh: false, ids: ['tb_r1'] }) });
    assert.deepStrictEqual([(await w.set(body({ no_delivery_zones: [ZONE()] }))).status], [503], `${L}: a stale registry`);
    const w2 = world({ registry: async () => { throw new Error('down'); } });
    assert.strictEqual((await w2.set(body({ no_delivery_zones: [ZONE()] }))).status, 503, `${L}: a failed registry`);
  });

  await cell('LOCK-BANDS-ONLY-NEVER-LOCKED', async (L) => {
    const w = world({ identities: { tb_r1: ID('Uno', OPEN), tb_r2: ID('Dos', OPEN) } });
    assert.strictEqual((await w.set(body())).status, 200, `${L}: a bands-only save while open`);
    assert.strictEqual(w.reads(), 0, `${L}: no hours read for a bands-only save`);
    // identical zones re-sent while open = a bands-only change
    const w2 = world({ identities: { tb_r1: ID('Uno', CLOSED), tb_r2: ID('Dos', CLOSED) } });
    await w2.set(body({ no_delivery_zones: [ZONE()] }));
    await w2.db.ref('restaurants/tb_r2/identity').set(ID('Dos', OPEN)); RC._cache.clear();
    const before = w2.reads();
    const r = await w2.set({ expected_policy_version: 1, bands: [{ max_km: 3, cents: 4000 }], no_delivery_zones: [ZONE()] });
    assert.deepStrictEqual([r.status, w2.reads() - before], [200, 0], `${L}: identical zones re-sent while open → saved, no hours read (${JSON.stringify(r.body)})`);
  });

  await cell('LOCK-ZONES-EDITABLE-MIRRORS', async (L) => {
    assert.strictEqual((await world().get()).body.zones_editable, true, `${L}: all closed → editable`);
    assert.strictEqual((await world({ identities: { tb_r1: ID('Uno', OPEN), tb_r2: ID('Dos', CLOSED) } }).get()).body.zones_editable, false, `${L}: one open → not editable`);
  });

  // ── F8: the order path's read size at caps, from the REAL writer's committed output ──
  await cell('ZWR-READ-BYTES-AT-CAPS', async (L) => {
    // Codex build r1 #4 / r2 #4: the TRUE legal maximum of the node every order reads, measured on what the REAL writer commits:
    // ONE real save at the top version (VERSION_LIMIT − 1) over the worst history the writer RETAINS (historyOk/entryOk accept it):
    // 9 entries with 128-unit actor uids that JSON-escape to 6 bytes each (\u00XX), both flags, versions at VERSION_LIMIT − 1,
    // safe-int clocks, 20 band caps and an 8-zone summary. The saving admin: a 128-unit uid of 3-byte characters (the worst valid
    // RTDB key). The zones: 8 × 24 at the worst legal encoding, inside |lat| ≤ 60 (20 bands at the caps; malformed stored bands).
    const r6 = (x) => Math.round(x * 1e6) / 1e6;
    const worst = (x) => { let v = r6(x); while (Math.abs(Math.round(v * 1e6)) % 10 === 0) v = r6(v - 1e-6); return v; };
    const shapes = Array.from({ length: 8 }, (_, z) => ({ id: `z_${String(z).padStart(8, '0')}`, name: '€'.repeat(29) + String.fromCharCode(0x4e00 + z),
      points: Array.from({ length: 24 }, (_, i) => { const a = (2 * Math.PI * i) / 24; return { lat: worst(-59.123457 + z * 0.03 + 0.009 * Math.sin(a)), lng: worst(-179.123457 + 0.009 * Math.cos(a)) }; }) }));
    const twenty = Array.from({ length: 20 }, (_, i) => ({ max_km: (i + 1) / 2, cents: 15000 }));
    const TOP = 1e15 - 1;
    const kept = { actor_uid: '\u0001'.repeat(128), prev_version: TOP, new_version: TOP, new: { bands: twenty, zones: { count: 8, sha256: 'f'.repeat(64) }, limits: { set: 300, deleted: 300, sha256: 'f'.repeat(64) } }, at: Number.MAX_SAFE_INTEGER, prev_malformed: true, history_reset: true };
    // envío restaurant limit (r5 §6, LIMITS-ACCUMULATED-READ-BUDGET; Codex build r1 P2-5): the worst LEGAL request over the map at its cap — 300 entries
    // stored at the longest key the writer can store (a registry id, RID_RE: 40 ASCII) with max_km 9.5; this save makes the maximum 200 mutations:
    // 100 deletions + 100 new entries, so the map stays at 300 and the summary carries 3-digit counts (set 100, deleted 100)
    const RIDS = Array.from({ length: 400 }, (_, i) => `r${String(i).padStart(3, '0')}`.padEnd(40, '_'));
    const MAP = Object.fromEntries(RIDS.slice(0, 300).map((rid) => [rid, { max_km: 9.5 }]));
    const MUTATIONS = [...RIDS.slice(0, 100).map((rid) => ({ rid, km: null })), ...RIDS.slice(300, 400).map((rid) => ({ rid, km: 9.5 }))];
    assert.ok(A.historyOk(Array(9).fill(kept)), `${L}: premise — the writer RETAINS such a history (historyOk)`);
    const U = '€'.repeat(128);
    const w = world({ ids: RIDS, identities: Object.fromEntries(RIDS.map((rid, i) => [rid, ID(`R${i}`, CLOSED)])), init: { platform_admins: { [U]: true }, [PATH.split('/')[0]]: { [PATH.split('/')[1]]: { policy_version: TOP - 1, bands: 'malformed', history: Array(9).fill(kept), restaurants: MAP } } } });
    w.deps.verifyIdToken = async () => ({ uid: U });
    w.deps.timestamp = () => Number.MAX_SAFE_INTEGER;
    const r = await w.set(body({ expected_policy_version: TOP - 1, bands: twenty, no_delivery_zones: shapes, limits: MUTATIONS }));
    const committed = node(w);
    const bytes = Buffer.byteLength(JSON.stringify(committed), 'utf8');
    // the byte pin FIRST (the writer commits before its own verification answers), then the premises
    assert.strictEqual(bytes, A.READ_BYTES_AT_CAPS, `${L}: the pinned worst case of every order read — the complete committed node (got ${bytes})`);
    assert.strictEqual(r.status, 200, `${L}: premise — the writer accepted the save (${JSON.stringify(r.body)})`);
    assert.deepStrictEqual([committed.policy_version, committed.history.length, committed.history[0].prev_malformed, committed.no_delivery_zones.length, Object.keys(committed.restaurants).length, committed.history[0].new.limits.set, committed.history[0].new.limits.deleted], [TOP, 10, true, 8, 300, 100, 100], `${L}: premise — the node is at its bound`);
  });

  // ── Codex build r1 #1 (P1, driver safety): EXACT geometry on the 6-decimal grid — a saved diagonal edge's points are INSIDE ──
  const orderPath = (w, pin) => { const pr = P.readPricing({ ...node(w), restaurants: { app: { active: true, free_delivery: false } } }, 'app');
    return P.quoteDelivery({ pricing: pr, hub: { lat: 15.5, lng: -88.0 }, mode: 'delivery', pin: { ...pin, confirmed: true }, customerUid: null }); };
  await cell('ZWR-DIAGONAL-EDGE-INSIDE', async (L) => {
    const w = world();
    const tri = { id: 'z_tttttttt', name: 'Triángulo', points: [{ lat: 15.5, lng: -88.03 }, { lat: 15.501, lng: -88.026 }, { lat: 15.49, lng: -88.01 }] };
    const r = await w.set(body({ no_delivery_zones: [tri] }));
    assert.deepStrictEqual([r.status, r.body.ok], [200, true], `${L}: premise: the writer saves the triangle (${JSON.stringify(r.body)})`);
    for (const pin of [{ lat: 15.5005, lng: -88.028 }, { lat: 15.5, lng: -88.03 }, { lat: 15.501, lng: -88.026 }, { lat: 15.4955, lng: -88.018 }]) {
      assert.strictEqual(orderPath(w, pin).refusal, 'no_delivery_zone', `${L}: the border point ${JSON.stringify(pin)} is inside (D5: border = inside)`);
    }
    assert.ok(!orderPath(w, { lat: 15.52, lng: -88.028 }).refusal, `${L}: a point well outside is priced`);
  });
  await cell('ZWR-COLLINEAR-REFUSED', async (L) => {
    const w = world();
    // exactly collinear on the 6-decimal grid (step +0.002149 / +0.001163); the float area is not 0, so only exact arithmetic sees it
    const line = { id: 'z_llllllll', name: 'Línea', points: [{ lat: 15.804975, lng: -88.024646 }, { lat: 15.807124, lng: -88.023483 }, { lat: 15.809273, lng: -88.02232 }] };
    const r = await w.set(body({ no_delivery_zones: [line] }));
    assert.deepStrictEqual([r.status, r.body.error, r.body.field], [400, 'bad_request', 'zones'], `${L}: a collinear 3-point polygon has zero area (${JSON.stringify(r.body)})`);
    assert.strictEqual(node(w), null, `${L}: nothing written`);
  });
  // ── Codex build r2 #1 (advisor ruling): every vertex |lat| ≤ 60 (zone_out_of_range); a polar or antimeridian zone is refused ──
  await cell('ZWR-POLAR-ANTIMERIDIAN-REFUSED', async (L) => {
    const w = world();
    const polar = { id: 'z_pppppppp', name: 'Polo', points: [{ lat: 89.95, lng: -180 }, { lat: 89.95, lng: 180 }, { lat: 90, lng: 0 }] };
    const r = await w.set(body({ no_delivery_zones: [polar] }));
    assert.deepStrictEqual([r.status, r.body.error, r.body.field], [400, 'bad_request', 'zone_out_of_range'], `${L}: a polar zone (${JSON.stringify(r.body)})`);
    const edge = { id: 'z_qqqqqqqq', name: 'Borde', points: [{ lat: 60.000001, lng: -88.03 }, { lat: 60.000001, lng: -88.02 }, { lat: 60.009, lng: -88.02 }] };
    const r2 = await w.set(body({ no_delivery_zones: [edge] }));
    assert.deepStrictEqual([r2.status, r2.body.field], [400, 'zone_out_of_range'], `${L}: a vertex just past 60° (${JSON.stringify(r2.body)})`);
    const anti = { id: 'z_rrrrrrrr', name: 'Antimeridiano', points: [{ lat: 10, lng: 179.99 }, { lat: 10, lng: -179.99 }, { lat: 10.01, lng: -179.99 }, { lat: 10.01, lng: 179.99 }] };
    const r3 = await w.set(body({ no_delivery_zones: [anti] }));
    assert.deepStrictEqual([r3.status, r3.body.field], [400, 'zone_caps'], `${L}: an antimeridian zone spans 359.98° of longitude — over the box cap (${JSON.stringify(r3.body)})`);
    assert.strictEqual(node(w), null, `${L}: nothing written`);
  });

  // ── Codex build r1 #3: a zone id must be a STRING before the regex and the uniqueness check ──
  await cell('ZWR-ID-NOT-STRING-REFUSED', async (L) => {
    const w = world();
    const r = await w.set(body({ no_delivery_zones: [{ ...ZONE(), id: ['z_aaaaaaaa'] }, { ...ZONE('z_aaaaaaaa', 'Sector B', 0.02), id: ['z_aaaaaaaa'] }] }));
    assert.deepStrictEqual([r.status, r.body.error, r.body.field], [400, 'bad_request', 'zones'], `${L}: an array id is refused (${JSON.stringify(r.body)})`);
    assert.strictEqual(node(w), null, `${L}: nothing written`);
  });

  if (fails.length) { console.log(`zones-writer FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`zones-writer: OK (${n})`);
})();
