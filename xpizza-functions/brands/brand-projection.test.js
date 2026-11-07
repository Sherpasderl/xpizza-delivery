'use strict';
// PLATFORM F1 — the /public/brands projection builder (PLAN-F1 r2 §1). Run: node brands/brand-projection.test.js
const assert = require('assert');
const { buildPublicBrand } = require('./brand-projection');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const HOURS = { sun: { open: true, start: '12:00', end: '19:45', note: 'x' }, mon: { open: false } };
const branch = (name, over = {}) => ({ name: 'Cfg', hub_lat: 15.5, hub_lng: -88.0, phone: '+50400000000', whatsapp_instance: 'secret-inst', whatsapp_enabled: true,
  delivery_radius_km: 5, hours: HOURS, active: true, version: 3, display_name: 'Disp', brand_id: 'tb_brand', location_name: name,
  zone: { type: 'circle', radius_km: 5 }, prep_default_min: 20, ...over });
const TB = { name: 'Third', active: true, locations: { tb_centro: 'member', tb_norte: 'member', tb_viejo: 'retired' }, activation: { state: 'on', since: 2 } };
const IDS = { tb_centro: branch('Centro'), tb_norte: branch('Norte', { hub_lat: 15.6 }), tb_viejo: branch('Viejo') };
const HOURS_OUT = { sun: { open: true, start: '12:00', end: '19:45' }, mon: { open: false } };

const r = buildPublicBrand('tb_brand', TB, IDS);
assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
assert.deepStrictEqual(r.projection, {
  name: 'Third',
  locations: {
    tb_centro: { location_name: 'Centro', hub: { lat: 15.5, lng: -88.0 }, zone: { type: 'circle', radius_km: 5 }, hours: HOURS_OUT, prep_default_min: 20, active: true },
    tb_norte: { location_name: 'Norte', hub: { lat: 15.6, lng: -88.0 }, zone: { type: 'circle', radius_km: 5 }, hours: HOURS_OUT, prep_default_min: 20, active: true },
  },
});
ok('exact shape (v2, orchestration §6): members only (retired omitted), hours filtered to open/start/end, active');

const s = JSON.stringify(r.projection);
for (const leak of ['phone', 'whatsapp', 'secret-inst', 'version', 'display_name', 'Disp', 'brand_id', 'note', 'Viejo', 'Cfg'])
  assert.ok(!s.includes(leak), `allowlist: ${leak} never projected`);
ok('allowlist: phone / whatsapp / version / display_name / brand_id / unknown hour keys / retired / config name never appear');

const refused = (brandId, b, ids, why) => { const x = buildPublicBrand(brandId, b, ids); assert.strictEqual(x.ok, false, why); assert.ok(x.errors.length > 0, why); };
refused('tb_brand', { ...TB, palette: {} }, IDS, 'invalid brand');
refused('tb_brand', TB, { ...IDS, tb_norte: branch('Norte', { brand_id: 'other_b' }) }, 'membership mismatch');
refused('tb_brand', TB, { ...IDS, tb_norte: branch('') }, 'invalid member identity');
refused('tb_brand', TB, { tb_centro: IDS.tb_centro, tb_viejo: IDS.tb_viejo }, 'member identity missing');
refused('tb_brand', TB, { ...IDS, tb_sur: branch('Sur') }, 'unlisted claimant');
const legacy = { name: 'Legacy', active: true, locations: { leg_a: 'member' }, activation: { state: 'legacy', since: 1 } };
const { brand_id: _b, location_name: _l, zone: _z, prep_default_min: _p, ...legacyIdent } = branch('x');
refused('leg_a', legacy, { leg_a: legacyIdent }, 'legacy without branch fields (Q4)');
ok('refusals: invalid brand, membership mismatch, invalid / missing member, unlisted claimant, legacy without branch fields');

// RTDB drops empty objects: the builder never emits one (codex P2-4)
const allRetired = { ...TB, locations: { tb_centro: 'retired', tb_norte: 'retired', tb_viejo: 'retired' } };
const ar = buildPublicBrand('tb_brand', allRetired, IDS);
assert.strictEqual(ar.ok, true, JSON.stringify(ar.errors));
assert.deepStrictEqual(ar.projection, { name: 'Third' }, 'all retired → no locations key');
const eh = buildPublicBrand('tb_brand', { ...TB, locations: { tb_centro: 'member' } }, { tb_centro: branch('Centro', { hours: {} }) });
assert.strictEqual(eh.ok, true, JSON.stringify(eh.errors));
assert.ok(!('hours' in eh.projection.locations.tb_centro), 'empty hours → no hours key');
ok('empty representation: all-retired → {name}; empty hours → no hours key');

// ── ORCHESTRATION O1a §6: projection v2 — address fields, active, staged never projected ──
{
  const B2 = { ...TB, locations: { tb_centro: 'member', tb_norte: 'member', tb_sur: 'staged' } };
  const ids2 = { tb_centro: branch('Centro', { address_line: 'Blvd. 1', address_reference: 'Frente al parque', active: false }),
    tb_norte: branch('Norte', { address_line: 'Calle 2' }), tb_sur: branch('Sur', { active: false, address_line: 'Hidden' }) };
  const v2 = buildPublicBrand('tb_brand', B2, ids2);
  assert.strictEqual(v2.ok, true, JSON.stringify(v2.errors));
  assert.deepStrictEqual(Object.keys(v2.projection.locations), ['tb_centro', 'tb_norte'], 'staged never projected');
  assert.deepStrictEqual([v2.projection.locations.tb_centro.active, v2.projection.locations.tb_centro.address_line, v2.projection.locations.tb_centro.address_reference],
    [false, 'Blvd. 1', 'Frente al parque'], 'an inactive member is projected with active:false and its address');
  assert.ok(!('address_reference' in v2.projection.locations.tb_norte), 'an absent reference is not emitted');
  assert.ok(!JSON.stringify(v2.projection).includes('Hidden'), 'nothing of a staged branch leaks');
}
ok('projection v2: active + address_line / address_reference for members; staged never projected; absent fields omitted');

console.log(`brand-projection: OK (${n})`);
