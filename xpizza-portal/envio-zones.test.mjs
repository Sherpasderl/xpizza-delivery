// ENVÍO step 2 — the NO-DELIVERY ZONES, the portal's NON-DRAWING half (advisor 11-13; 5f PLAN-envio-zones-step2-r2 + zones_lock f976331a):
// the contract envio-logic.js speaks with getDeliveryPricing / setDeliveryPricing — the read's zones and the closed-only lock, the body
// (zones only when sent; a fees-only body never carries them), every refusal mapped to a PLACEHOLDER copy key (the owner approves the
// strings with the addendum), the recovery that compares the SENT zones, and which outcomes keep the client's draft.
// The server is 5f's REAL getDeliveryPricingCore / setDeliveryPricingCore on the strict faithful RTDB fake, the lock running the REAL
// loadSchedule over the REAL getIdentity (zones-writer.test.js's world). Clock: Wednesday 12:00 in Honduras.
// Run: node --test envio-zones.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as EL from './envio-logic.js';

const req = createRequire(new URL('../xpizza-functions/package.json', import.meta.url));
const { fakeRtdb } = req('./test/_fake-rtdb-sdk');
const A = req('./delivery/pricing-admin-core');
const Z = req('./delivery/zones');
const ZL = req('./delivery/zones-lock');
const RC = req('./restaurant-config');

const PATH = 'platform_config/delivery_pricing';
const BANDS = [{ max_km: 3, cents: 3000 }, { max_km: 6, cents: 5000 }, { max_km: 9.5, cents: 7000 }];
const ROWS = EL.rowsFromBands(BANDS);
const NOW = Date.UTC(2026, 10, 11, 18, 0);
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const hoursAll = (start, end) => Object.fromEntries(DAYS.map((d) => [d, start ? { open: true, start, end } : { open: false }]));
const ID = (name, hours) => ({ name, phone: '+50499990000', active: true, version: 1, hub_lat: 15.5, hub_lng: -88.0, delivery_radius_km: 8, location_name: `Sucursal ${name}`, hours });
const CLOSED = hoursAll(null), OPEN = hoursAll('10:00', '22:00');
const ZONE = (id = 'z_aaaaaaaa', name = 'Sector A', o = 0) => ({ id, name, points: [
  { lat: 15.5 + o, lng: -88.03 }, { lat: 15.5 + o, lng: -88.02 }, { lat: 15.509 + o, lng: -88.02 }, { lat: 15.509 + o, lng: -88.03 }] });
let AT = 1762800000000;
function world({ identities = { tb_r1: ID('Uno', CLOSED), tb_r2: ID('Dos', CLOSED) }, init = {}, uid = 'tbowner', registry, faultPath } = {}) {
  RC._cache.clear();
  const restaurants = Object.fromEntries(Object.entries(identities).map(([rid, identity]) => [rid, { identity }]));
  const db = fakeRtdb({ platform_admins: { tbowner: true }, restaurants, ...init }, { strict: true });
  if (faultPath) { const real = db.ref.bind(db); db.ref = (p) => (String(p).startsWith(faultPath) ? { once: async () => { throw new Error('down'); }, get: async () => { throw new Error('down'); } } : real(p)); }
  const deps = { db, verifyIdToken: async () => ({ uid }), timestamp: () => ++AT,
    readRegistry: registry || (async () => ({ ok: true, fresh: true, ids: Object.keys(identities) })),
    getIdentity: (d, rid, now) => RC.getIdentity(d, rid, now), readGrace: (d) => ZL.readGraceMinutesStrict(d), now: () => NOW };
  const rq = (body) => ({ get: (h) => (String(h).toLowerCase() === 'authorization' ? 'Bearer x' : null), body });
  return { db, set: (body) => A.setDeliveryPricingCore(deps, rq(body)), get: () => A.getDeliveryPricingCore(deps, rq()) };
}
const OPEN_WORLD = () => ({ identities: { tb_r1: ID('Uno', OPEN), tb_r2: ID('Dos', CLOSED) } });

test('zonesFromBody: the read\'s zones + lock — editable ONLY when zones_editable is true AND zones_lock is null; anything else fails closed', async () => {
  const closed = EL.zonesFromBody((await world().get()).body);
  assert.deepEqual(closed, { zones: [], editable: true, lock: null, caps: { zones_max: 8, points_max: 24, points_min: 3, name_max: 30, bbox_max_km: 20 } });
  const open = EL.zonesFromBody((await world(OPEN_WORLD()).get()).body);
  assert.equal(open.editable, false);
  assert.deepEqual(open.lock, { reason: 'open', branches: [{ rid: 'tb_r1', name: 'Sucursal Uno', state: 'open' }] }, '🔴 the lock names the open branch');
  const down = EL.zonesFromBody((await world({ registry: async () => { throw new Error('x'); } }).get()).body);
  assert.deepEqual([down.editable, down.lock && down.lock.reason], [false, 'unavailable']);
  for (const bad of [{}, { zones_editable: true }, { zones_editable: true, zones_lock: { reason: 'open', branches: [] } }, { zones_editable: 'true', zones_lock: null },
    { zones_editable: true, zones_lock: null, no_delivery_zones: 'x' }, null]) {
    const z = EL.zonesFromBody(bad);
    assert.equal(z.editable, false, `fails closed: ${JSON.stringify(bad)}`);
  }
  assert.equal(EL.zonesFromBody({ current_malformed: true }).zones, null, 'a malformed node: no zones to show');
});

test('toBody: zones ride ONLY when passed — without them the body is today\'s, byte for byte; the real writer accepts both', async () => {
  assert.deepEqual(EL.toBody(ROWS, 0), { expected_policy_version: 0, bands: BANDS });
  assert.equal(JSON.stringify(EL.toBody(ROWS, 0, [], undefined)), JSON.stringify(EL.toBody(ROWS, 0)), 'undefined zones: today\'s body');
  const withZ = EL.toBody(ROWS, 0, [], [ZONE()]);
  assert.deepEqual(withZ.no_delivery_zones, [ZONE()]);
  const w = world();
  const r = await w.set(withZ);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await w.get()).body.no_delivery_zones, [ZONE()], '🔴 round-trips through the real writer');
  assert.deepEqual(EL.toBody(ROWS, 1, [], []).no_delivery_zones, [], 'an empty list is sent (clears every zone)');
});

test('every refusal → a PLACEHOLDER copy key (and the claim the recovery reads), from the REAL writer', async () => {
  const twoPoint = { ...ZONE(), points: ZONE().points.slice(0, 2) };
  const nine = Array.from({ length: 9 }, (_, i) => ZONE(`z_${String(i).repeat(8)}`, `S${i}`, i * 0.02));
  const cases = [
    ['not_authorized', world({ uid: 'stranger' }), EL.toBody(ROWS, 0, [], [ZONE()]), 403, 'zones.not_authorized', 'forbidden'],
    ['bad zones', world(), EL.toBody(ROWS, 0, [], [twoPoint]), 400, 'zones.invalid', 'zones_refused'],
    ['zone_caps', world(), EL.toBody(ROWS, 0, [], nine), 400, 'zones.caps', 'zones_refused'],
    ['superseded', world(), EL.toBody(ROWS, 5, [], [ZONE()]), 409, 'zones.superseded', 'superseded'],
    ['current_malformed', world({ init: { platform_config: { delivery_pricing: { policy_version: 2, bands: BANDS, no_delivery_zones: [{ id: 'z_aaaaaaaa', name: 'A', points: [[15.5, -88.03], [15.5, -88.02]] }] } } } }), EL.toBody(ROWS, 2, [], [ZONE()]), 409, 'zones.current_malformed', 'current_malformed'],
    ['locked while open', world(OPEN_WORLD()), EL.toBody(ROWS, 0, [], [ZONE()]), 409, 'zones.locked', 'zones_locked'],
    ['hours unavailable', world({ registry: async () => ({ ok: false }) }), EL.toBody(ROWS, 0, [], [ZONE()]), 503, 'zones.hours_unavailable', 'hours_unavailable'],
    ['unavailable', world({ faultPath: PATH }), EL.toBody(ROWS, 0, [], [ZONE()]), 503, 'zones.unavailable', 'unavailable'],
  ];
  for (const [label, w, body, status, key, claim] of cases) {
    const r = await w.set(body);
    const res = { status: r.status, body: r.body };
    assert.equal(r.status, status, `premise ${label}: ${JSON.stringify(r.body)}`);
    assert.equal(EL.zonesRefusalKey(res), key, `🔴 ${label} → ${key}`);
    assert.equal(EL.postClaim(res), claim, `${label}: the claim`);
  }
  assert.ok(Object.values(EL.ZONES_COPY_KEYS).every((k) => /^zones\.[a-z_]+$/.test(k)), 'keys only — the strings come with the approved addendum');
  assert.equal(EL.zonesRefusalKey({ status: 200, body: { ok: true } }), null);
});

test('recovery compares the SENT zones: landed as sent → saved; landed differently → conflict; refused while open → zones_locked (draft kept)', async () => {
  const w = world();
  const a = EL.startAttempt({ uid: 'u', sessionGen: 1, expectedVersion: 0, bands: BANDS, zones: [ZONE()] });
  await w.set(EL.toBody(ROWS, 0, [], [ZONE()]));
  assert.equal(EL.classifyRecovery(a, { status: 200, body: (await w.get()).body }), 'saved');
  const b = EL.startAttempt({ uid: 'u', sessionGen: 1, expectedVersion: 0, bands: BANDS, zones: [ZONE('z_cccccccc', 'Otro')] });
  assert.equal(EL.classifyRecovery(b, { status: 200, body: (await w.get()).body }), 'conflict', '🔴 another list landed under this version');
  const c = EL.startAttempt({ uid: 'u', sessionGen: 1, expectedVersion: 0, bands: BANDS });
  assert.equal(EL.classifyRecovery(c, { status: 200, body: (await w.get()).body }), 'saved', 'an attempt without zones ignores them');
  const o = world(OPEN_WORLD());
  const d = EL.startAttempt({ uid: 'u', sessionGen: 1, expectedVersion: 0, bands: BANDS, zones: [ZONE()] });
  const r = await o.set(EL.toBody(ROWS, 0, [], [ZONE()]));
  const out = EL.classifyRecovery(d, { status: 200, body: (await o.get()).body }, EL.postClaim({ status: r.status, body: r.body }));
  assert.equal(out, 'zones_locked');
  for (const k of ['zones_locked', 'refused', 'conflict', 'not_landed', 'unknown', 'forbidden']) assert.equal(EL.keepsZonesDraft(k), true, `${k}: the draft stays on the client`);
  assert.equal(EL.keepsZonesDraft('saved'), false);
});

test('the fees-only resend: the same attempt\'s bands (and limits) WITHOUT no_delivery_zones — the real writer saves it while a branch is open and keeps the stored zones', async () => {
  const w = world();
  await w.set(EL.toBody(ROWS, 0, [], [ZONE()]));
  const open = world({ ...OPEN_WORLD(), init: { platform_config: { delivery_pricing: (await w.get()).body && w.db.get(PATH) } } });
  const a = EL.startAttempt({ uid: 'u', sessionGen: 1, expectedVersion: 1, bands: [{ max_km: 3, cents: 3500 }], zones: [ZONE('z_dddddddd', 'Nueva')] });
  const locked = await open.set({ expected_policy_version: 1, bands: a.sentBands, no_delivery_zones: a.sentZones });
  assert.equal(locked.status, 409, 'premise: the zones change is locked');
  const fees = EL.feesOnlyBody(a);
  assert.deepEqual(fees, { expected_policy_version: 1, bands: [{ max_km: 3, cents: 3500 }] }, '🔴 no no_delivery_zones key');
  const r = await open.set(fees);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await open.get()).body.no_delivery_zones, [ZONE()], 'the stored zones untouched');
});

test('sameZones (the dirty check) agrees with the server\'s sameLogical on normalized input — trim, 6-decimal rounding, order', () => {
  const base = [ZONE(), ZONE('z_bbbbbbbb', 'Sector B', 0.02)];
  const variants = [
    base,
    [{ ...base[0], name: '  Sector A ' }, base[1]],
    [{ ...base[0], points: base[0].points.map((p) => ({ lat: p.lat + 1e-8, lng: p.lng })) }, base[1]],
    [{ ...base[0], points: base[0].points.map((p) => ({ lat: p.lat + 1e-5, lng: p.lng })) }, base[1]],
    [base[1], base[0]],
    [base[0]],
    [],
  ];
  for (const v of variants) {
    const n = Z.normalizeInput(v);
    assert.ok(n.ok, `premise: valid ${JSON.stringify(v).slice(0, 60)}`);
    assert.equal(EL.sameZones(v, base), Z.sameLogical(n.zones, Z.normalizeInput(base).zones), `🔴 parity: ${JSON.stringify(v).slice(0, 80)}`);
  }
});
