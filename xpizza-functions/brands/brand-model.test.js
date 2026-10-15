'use strict';
// PLATFORM F1 — the brand / location model (PLAN-F1 r2 §1, §3). Run: node brands/brand-model.test.js
const assert = require('assert');
const M = require('./brand-model');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const HOURS = { sun: { open: true, start: '12:00', end: '19:45' }, mon: { open: false } };
const ident = (over = {}) => ({ name: 'Loc', hub_lat: 15.5, hub_lng: -88.0, phone: '+50400000000', whatsapp_instance: 'i', whatsapp_enabled: false,
  delivery_radius_km: 5, hours: HOURS, active: true, version: 1, ...over });
const branch = (brandId, over = {}) => ident({ brand_id: brandId, location_name: 'Centro', zone: { type: 'circle', radius_km: 5 }, prep_default_min: 20, ...over });
const legacy = (rid) => ({ name: 'Legacy', active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
const TB = { name: 'Third', active: true, locations: { tb_centro: 'member', tb_norte: 'member' }, activation: { state: 'on', since: 2 } };

// ── validateBrand ──
assert.deepStrictEqual(M.validateBrand('tb_brand', TB), { ok: true });
assert.deepStrictEqual(M.validateBrand('leg_a', legacy('leg_a')), { ok: true });
for (const [id, rec, why] of [
  ['leg_a', { ...legacy('leg_a'), locations: { leg_a: 'member', other: 'member' } }, 'legacy with an extra member'],
  ['leg_a', { ...legacy('leg_a'), locations: { leg_a: 'retired' } }, 'legacy self retired'],
  ['tb_brand', { ...TB, palette: {} }, 'unknown key'],
  ['tb_brand', { ...TB, locations: {} }, 'no locations'],
  ['tb_brand', { ...TB, locations: { tb_centro: 'active' } }, 'bad location state'],
  ['tb_brand', { ...TB, locations: { 'Bad-Id': 'member' } }, 'bad location id'],
  ['tb_brand', { ...TB, active: 'yes' }, 'active not boolean'],
  ['tb_brand', { ...TB, activation: { state: 'live', since: 1 } }, 'bad state'],
  ['tb_brand', { ...TB, activation: { state: 'on', since: NaN } }, 'since not finite'],
  ['tb_brand', { ...TB, activation: { state: 'on', since: 1, by: 'x' } }, 'extra activation key'],
  ['tb_brand', { ...TB, name: ' Third' }, 'padded name'],
  ['tb_brand', { ...TB, name: 'x'.repeat(81) }, '81-char name'],
  ['unknown', TB, "reserved id 'unknown'"],
  ['tb_brand', null, 'null record'],
]) assert.strictEqual(M.validateBrand(id, rec).ok, false, why);
ok('validateBrand: third brand + legacy valid; legacy shape exact; strict keys; types; reserved id');

// ── validateZone ──
assert.deepStrictEqual(M.validateZone({ type: 'circle', radius_km: 5 }), []);
for (const z of [{ type: 'polygon', radius_km: 5 }, { type: 'circle', radius_km: 0 }, { type: 'circle', radius_km: -1 }, { type: 'circle', radius_km: 51 },
  { type: 'circle', radius_km: Infinity }, { type: 'circle', radius_km: '5' }, { type: 'circle', radius_km: 5, points: [] }, { type: 'circle' }, null, 5])
  assert.ok(M.validateZone(z).length > 0, `zone refused: ${JSON.stringify(z)}`);
ok('validateZone: only {type:circle, 0<radius_km<=50}, no other keys');

// ── validateBranchIdentity ──
assert.deepStrictEqual(M.validateBranchIdentity('tb_centro', branch('tb_brand'), 'tb_brand'), { ok: true });
const bad = (id, brandId, why) => assert.strictEqual(M.validateBranchIdentity('tb_centro', id, brandId).ok, false, why);
const badB = (over, why) => bad(branch('tb_brand', over), 'tb_brand', why);
badB({ brand_id: 'other' }, 'brand_id ≠ brand');
bad(branch('unknown'), 'unknown', "brandId and brand_id both 'unknown'");
bad(branch(undefined), undefined, 'both absent');
badB({ location_name: '' }, "location_name ''"); badB({ location_name: 'x'.repeat(61) }, 'location_name 61 chars');
badB({ prep_default_min: 4 }, 'prep 4'); badB({ prep_default_min: 121 }, 'prep 121'); badB({ prep_default_min: 20.5 }, 'prep 20.5');
badB({ zone: { type: 'circle', radius_km: 6 } }, 'zone radius ≠ delivery_radius_km (Q2)');
badB({ hub_lat: 91 }, 'lat 91'); badB({ hub_lng: -181 }, 'lng -181');
badB({ hours: { sun: { open: 'yes' } } }, "hours open:'yes'");
badB({ hours: { sun: { open: true, start: ['12:00'], end: ['19:45'] } } }, 'array times (regex coercion)');
badB({ hours: { sun: { open: true, start: '9', end: '20:00' } } }, "start '9'");
badB({ hours: { sun: { open: true, start: '12:00', end: '12:00' } } }, 'start === end');
badB({ hours: { sun: { open: true, start: '20:00', end: '12:00' } } }, 'start > end');
badB({ active: 'true' }, 'not routing-valid');
ok('validateBranchIdentity: brand ids, location_name, prep, Q2 zone equality, ranges, string times start<end, routing-valid');

// ── brandIdOf ──
const brands = { leg_a: legacy('leg_a'), tb_brand: TB, leg_bad: { ...legacy('leg_bad'), locations: { leg_bad: 'member', z: 'member' } } };
assert.strictEqual(M.brandIdOf('tb_centro', branch('tb_brand'), brands), 'tb_brand');
assert.strictEqual(M.brandIdOf('leg_a', ident(), brands), 'leg_a', 'legacy rid, no identity brand_id');
assert.strictEqual(M.brandIdOf('leg_a', null, brands), 'leg_a', 'legacy rid, identity null');
assert.strictEqual(M.brandIdOf('leg_bad', ident(), brands), M.UNKNOWN, 'legacy record with an extra member → unknown');
assert.strictEqual(M.brandIdOf('nobody', ident(), brands), M.UNKNOWN, 'no record → unknown');
assert.strictEqual(M.brandIdOf('tb_centro', ident({ brand_id: 'Bad Id' }), brands), M.UNKNOWN, 'malformed brand_id → unknown');
assert.strictEqual(M.brandIdOf('tb_centro', ident({ brand_id: 'unknown' }), brands), M.UNKNOWN, "brand_id 'unknown' → unknown");
assert.strictEqual(M.brandIdOf('leg_a', ident(), {}), M.UNKNOWN, 'brands {} → unknown');
assert.strictEqual(M.UNKNOWN, 'unknown');
ok("brandIdOf: identity.brand_id, else a VALID legacy brand of the same id, else 'unknown'");

// ── checkMembership ──
const ids = { leg_a: ident(), tb_centro: branch('tb_brand'), tb_norte: branch('tb_brand', { location_name: 'Norte' }), tb_viejo: branch('tb_brand', { location_name: 'Viejo' }) };
const TBR = { ...TB, locations: { ...TB.locations, tb_viejo: 'retired' } };
assert.deepStrictEqual(M.checkMembership({ leg_a: legacy('leg_a'), tb_brand: TBR }, ids), [], 'consistent set incl. a retired location');
const codes = (b, i) => M.checkMembership(b, i).map((f) => `${f.code}:${f.brandId || ''}:${f.rid || ''}`);
assert.deepStrictEqual(codes({ tb_brand: TB }, { tb_centro: branch('tb_brand') }), ['identity_missing:tb_brand:tb_norte']);
assert.deepStrictEqual(codes({ tb_brand: TB }, { tb_centro: ids.tb_centro, tb_norte: branch('other_b') }), ['brand_id_mismatch:tb_brand:tb_norte', 'brand_missing:other_b:tb_norte']);
assert.deepStrictEqual(codes({ tb_brand: TB }, { tb_centro: ids.tb_centro, tb_norte: ids.tb_norte, tb_sur: branch('tb_brand') }), ['not_listed:tb_brand:tb_sur']);
assert.deepStrictEqual(codes({ leg_a: legacy('leg_a') }, { leg_a: ident({ brand_id: 'tb_brand' }) }), ['brand_id_mismatch:leg_a:leg_a', 'brand_missing:tb_brand:leg_a']);
assert.deepStrictEqual(codes({ leg_bad: brands.leg_bad }, {}), ['brand_invalid:leg_bad:']);
assert.deepStrictEqual(codes({ tb_brand: TB, leg_a: legacy('leg_a') }, { leg_a: ident({ brand_id: 'zz' }), tb_centro: ids.tb_centro }),
  ['brand_id_mismatch:leg_a:leg_a', 'brand_missing:zz:leg_a', 'identity_missing:tb_brand:tb_norte'], 'sorted by code, brandId, rid');
ok('checkMembership: both directions, retired included, invalid brand → one finding, sorted');

console.log(`brand-model: OK (${n})`);
