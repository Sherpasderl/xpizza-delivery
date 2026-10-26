'use strict';
// ORCHESTRATION O1a (PLAN-multi-location-orchestration r3.1 §2.1, §4, §5) — the pure branch-lifecycle planners.
// Owner rulings: location (pin, address) + zone are Sherpa-admin writes only; the pin moves only while the branch is OFF (inactive ≥ 10
// min, zero non-terminal orders); hours are same-day, all 7 days. Run: node branches/branch-ops.test.js
const assert = require('assert');
const O = require('./branch-ops');
const { validateBranchIdentity } = require('../brands/brand-model');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const DAY = { open: true, start: '11:00', end: '22:00' };
const H7 = { sun: DAY, mon: { open: false }, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: DAY };
const DRAFT_IN = { brand_id: 'tb_brand', location_name: 'Centro', phone: '+50499990000', hours: H7, prep_default_min: 20 };
const BOUNDS = { min_lat: 13, max_lat: 17, min_lng: -90, max_lng: -83 };
const NOW = 1_800_000_000_000;

// ── draft input ──
assert.deepStrictEqual(O.draftErrors(DRAFT_IN), []);
for (const [patch, code] of [
  [{ location_name: '' }, 'bad_name'], [{ location_name: ' Centro' }, 'bad_name'], [{ location_name: 'x'.repeat(61) }, 'bad_name'],
  [{ phone: '9999' }, 'bad_phone'], [{ phone: 50499990000 }, 'bad_phone'],
  [{ prep_default_min: 4 }, 'bad_prep'], [{ prep_default_min: 121 }, 'bad_prep'], [{ prep_default_min: 20.5 }, 'bad_prep'],
  [{ hours: { ...H7, sat: undefined } }, 'bad_hours'],                                   // all 7 days required (R2)
  [{ hours: { ...H7, fri: { open: true, start: '22:00', end: '01:00' } } }, 'bad_hours'], // same-day only: no past midnight
  [{ hours: { ...H7, fri: { open: true, start: '11:00', end: '11:00' } } }, 'bad_hours'],
  [{ hours: { ...H7, fri: { open: true, start: '24:00', end: '23:00' } } }, 'bad_hours'],
  [{ hours: { ...H7, fri: { open: true } } }, 'bad_hours'],
  [{ hours: { ...H7, xyz: DAY } }, 'bad_hours'],
  [{ brand_id: 'Bad-Id' }, 'bad_brand'],
]) assert.ok(O.draftErrors({ ...DRAFT_IN, ...patch }).includes(code), `${JSON.stringify(patch)} → ${code}`);
assert.deepStrictEqual(O.hours7Errors(H7), []);
ok('draft input: name 1–60 unpadded, E.164 phone, prep 5–120 integer, hours ALL 7 days and SAME-DAY (no past-midnight), valid brand id');

// ── materialize (Sherpa admin): draft + location → the full identity ──
const draft = { ...DRAFT_IN, created_at: 1, created_by: 'owner1', op_id: 'op1' };
const loc = { hub: { lat: 15.51, lng: -88.03 }, address_line: 'Blvd. Los Próceres 1', address_reference: 'Frente al parque' };
const m = O.planMaterialize({ draft, location: loc, brandName: 'Third', bounds: BOUNDS, now: NOW });
assert.strictEqual(m.ok, true, JSON.stringify(m.errors));
assert.deepStrictEqual(m.identity, {
  name: 'Third', brand_id: 'tb_brand', location_name: 'Centro', phone: '+50499990000', hours: H7, prep_default_min: 20,
  hub_lat: 15.51, hub_lng: -88.03, address_line: 'Blvd. Los Próceres 1', address_reference: 'Frente al parque',
  zone: { type: 'circle', radius_km: 5 }, delivery_radius_km: 5, whatsapp_instance: '', whatsapp_enabled: false,
  active: false, active_changed_at: NOW, version: 1,
});
assert.deepStrictEqual(validateBranchIdentity('tb_brand_centro', m.identity, 'tb_brand'), { ok: true }, 'the materialized identity passes the F1 branch validator');
assert.strictEqual(O.planMaterialize({ draft, location: { ...loc, zone_radius_km: 8 }, brandName: 'Third', bounds: BOUNDS, now: NOW }).identity.zone.radius_km, 8);
for (const [args, code] of [
  [{ bounds: null }, 'service_bounds_unset'],
  [{ location: { ...loc, hub: { lat: 40.7, lng: -74 } } }, 'out_of_bounds'],
  [{ location: { ...loc, hub: { lat: 'x', lng: -88 } } }, 'bad_hub'],
  [{ location: { ...loc, hub: { lat: 95, lng: -88 } } }, 'bad_hub'],
  [{ location: { ...loc, address_line: '' } }, 'bad_address'],
  [{ location: { ...loc, address_reference: 'x'.repeat(121) } }, 'bad_address'],
  [{ location: { ...loc, zone_radius_km: 0 } }, 'bad_zone'],
  [{ location: { ...loc, zone_radius_km: 51 } }, 'bad_zone'],
  [{ draft: { ...draft, hours: {} } }, 'bad_hours'],
]) {
  const r = O.planMaterialize({ draft, location: loc, brandName: 'Third', bounds: BOUNDS, now: NOW, ...args });
  assert.ok(!r.ok && r.errors.includes(code), `${JSON.stringify(Object.keys(args))} → ${code} (${JSON.stringify(r.errors)})`);
}
ok('materialize: routing-valid identity (inactive, version 1, zone == delivery radius, default 5 km, WhatsApp per brand); bounds / hub / address / zone / hours refused');

// ── setBranchLocation (Sherpa admin): only while OFF ≥ 10 min with zero live orders; radius-only allowed while active ──
const idOff = { ...m.identity, active: false, active_changed_at: NOW - 10 * 60_000, version: 4 };
const mv = O.planSetLocation({ identity: idOff, input: { hub: { lat: 15.52, lng: -88.04 }, address_line: 'Nueva 2' }, bounds: BOUNDS, liveOrders: 0, now: NOW, expectedVersion: 4 });
assert.deepStrictEqual(mv, { ok: true, patch: { hub_lat: 15.52, hub_lng: -88.04, address_line: 'Nueva 2', version: 5 } });
const refuse = (args, code) => { const r = O.planSetLocation({ identity: idOff, input: { hub: { lat: 15.52, lng: -88.04 } }, bounds: BOUNDS, liveOrders: 0, now: NOW, expectedVersion: 4, ...args });
  assert.ok(!r.ok && r.errors.includes(code), `${code}: ${JSON.stringify(r)}`); };
refuse({ identity: { ...idOff, active: true } }, 'branch_active');
refuse({ identity: { ...idOff, active_changed_at: NOW - 9 * 60_000 } }, 'branch_recently_active');
refuse({ identity: { ...idOff, active_changed_at: undefined } }, 'branch_recently_active');
refuse({ liveOrders: 1 }, 'branch_has_live_orders');
refuse({ expectedVersion: 3 }, 'stale_branch');
refuse({ input: { hub: { lat: 40, lng: -74 } } }, 'out_of_bounds');
const radiusOnly = O.planSetLocation({ identity: { ...idOff, active: true }, input: { zone_radius_km: 7 }, bounds: BOUNDS, liveOrders: 3, now: NOW, expectedVersion: 4 });
assert.deepStrictEqual(radiusOnly, { ok: true, patch: { zone: { type: 'circle', radius_km: 7 }, delivery_radius_km: 7, version: 5 } }, 'radius-only on an ACTIVE branch with live orders');
assert.deepStrictEqual(O.planSetLocation({ identity: idOff, input: {}, bounds: BOUNDS, liveOrders: 0, now: NOW, expectedVersion: 4 }), { ok: false, errors: ['noop'] });
ok('setBranchLocation: pin / address move only while OFF ≥ 10 min with zero live orders; radius-only allowed while active; CAS; bounds; noop');

// ── profile patch (portal later, O1b; the planner is shared): never hub / address / zone ──
const idOn = { ...m.identity, active: true, version: 6 };
assert.deepStrictEqual(O.planProfilePatch({ current: idOn, patch: { hours: { ...H7, mon: DAY }, prep_default_min: 25 }, expectedVersion: 6 }),
  { ok: true, patch: { hours: { ...H7, mon: DAY }, prep_default_min: 25, version: 7 }, groups: ['hours', 'prep'] });
assert.deepStrictEqual(O.planProfilePatch({ current: idOn, patch: { location_name: 'Centro Uno', phone: '+50499990001' }, expectedVersion: 6 }).groups, ['profile']);
for (const [patch, code] of [[{ hub_lat: 1 }, 'forbidden_field'], [{ address_line: 'x' }, 'forbidden_field'], [{ zone: {} }, 'forbidden_field'],
  [{ active: false }, 'forbidden_field'], [{ brand_id: 'x' }, 'forbidden_field'], [{ hours: {} }, 'bad_hours'], [{ location_name: '' }, 'bad_name'], [{}, 'noop'],
  [{ prep_default_min: 20 }, 'noop']]) {
  const r = O.planProfilePatch({ current: idOn, patch, expectedVersion: 6 });
  assert.ok(!r.ok && r.errors.includes(code), `${JSON.stringify(patch)} → ${code} (${JSON.stringify(r)})`);
}
assert.ok(O.planProfilePatch({ current: idOn, patch: { prep_default_min: 25 }, expectedVersion: 5 }).errors.includes('stale_branch'));
ok('profile patch: name / phone / hours / prep only (field groups reported for O1b auth); hub / address / zone / active / brand_id forbidden; CAS; noop');

// ── activation readiness + deactivate ──
const facts = (over = {}) => ({ membership: 'staged', brandState: 'on', handheldSeen: true, teamCount: 1, menuPublished: true, ...over });
const act = O.planSetActive({ identity: { ...idOff, version: 4 }, active: true, facts: facts(), now: NOW, expectedVersion: 4 });
assert.deepStrictEqual(act, { ok: true, patch: { active: true, active_changed_at: NOW, version: 5 }, membershipTo: 'member' });
for (const [over, code] of [[{ handheldSeen: false }, 'no_handheld_online'], [{ teamCount: 0 }, 'no_owner_or_manager'], [{ menuPublished: false }, 'menu_not_published'],
  [{ brandState: 'legacy' }, 'brand_not_on'], [{ brandState: 'off' }, 'brand_not_on'], [{ membership: 'retired' }, 'not_a_branch']]) {
  const r = O.planSetActive({ identity: idOff, active: true, facts: facts(over), now: NOW, expectedVersion: 4 });
  assert.ok(!r.ok && r.error === 'not_ready' && r.unmet.includes(code), `${JSON.stringify(over)} → ${code} (${JSON.stringify(r)})`);
}
const notValid = O.planSetActive({ identity: { ...idOff, hours: { sun: DAY } }, active: true, facts: facts(), now: NOW, expectedVersion: 4 });
assert.ok(notValid.unmet.includes('identity_invalid'), 'readiness re-validates the identity incl. 7-day hours');
assert.deepStrictEqual(O.planSetActive({ identity: { ...idOff, active: true }, active: true, facts: facts({ membership: 'member' }), now: NOW, expectedVersion: 4 }), { ok: false, error: 'noop' });
const deact = O.planSetActive({ identity: { ...idOff, active: true }, active: false, facts: facts({ membership: 'member' }), now: NOW, expectedVersion: 4 });
assert.deepStrictEqual(deact, { ok: true, patch: { active: false, active_changed_at: NOW, version: 5 }, membershipTo: null }, 'deactivate always allowed; stays member');
assert.strictEqual(O.planSetActive({ identity: idOff, active: true, facts: facts({ membership: 'member' }), now: NOW, expectedVersion: 4 }).membershipTo, null, 'reactivating a member keeps member');
ok('setBranchActive: readiness (valid identity incl. 7-day hours, brand on, handheld online, owner/manager, menu) → staged→member; deactivate always; CAS; noop');

// ── enrichLegacyIdentity (Sherpa admin, before a legacy cutover): additive only ──
const legacyId = { name: 'X Pizza', hub_lat: 15.5, hub_lng: -88.0, phone: '+50400000000', whatsapp_instance: 'inst', whatsapp_enabled: true, delivery_radius_km: 7,
  hours: H7, active: true, version: 1, display_name: 'X. Pizza', uses_platform_factura: true };
const legacyBrand = { name: 'X. Pizza', active: true, locations: { tb_leg: 'member' }, activation: { state: 'legacy', since: 1 } };
const en = O.planEnrichLegacy({ rid: 'tb_leg', identity: legacyId, brand: legacyBrand, input: { location_name: 'Los Próceres', prep_default_min: 20, address_line: 'Blvd 1' }, expectedVersion: 1 });
assert.deepStrictEqual(en, { ok: true, patch: { brand_id: 'tb_leg', location_name: 'Los Próceres', zone: { type: 'circle', radius_km: 7 }, prep_default_min: 20, address_line: 'Blvd 1', version: 2 } });
assert.deepStrictEqual(validateBranchIdentity('tb_leg', { ...legacyId, ...en.patch }, 'tb_leg'), { ok: true }, 'enriched legacy identity passes the branch validator');
for (const [args, code] of [[{ brand: { ...legacyBrand, activation: { state: 'on', since: 1 } } }, 'brand_not_legacy'], [{ rid: 'other' }, 'not_the_legacy_branch'],
  [{ identity: { ...legacyId, brand_id: 'tb_leg' } }, 'already_enriched'], [{ input: { location_name: '', prep_default_min: 20 } }, 'bad_name'], [{ expectedVersion: 0 }, 'stale_branch']]) {
  const r = O.planEnrichLegacy({ rid: 'tb_leg', identity: legacyId, brand: legacyBrand, input: { location_name: 'Los Próceres', prep_default_min: 20 }, expectedVersion: 1, ...args });
  assert.ok(!r.ok && r.errors.includes(code), `${code}: ${JSON.stringify(r)}`);
}
assert.ok(!('uses_platform_factura' in en.patch) && !('display_name' in en.patch) && !('hub_lat' in en.patch), 'additive: never touches existing fields');
ok('enrichLegacyIdentity: additive brand_id / location_name / zone (== delivery radius) / prep (+ address); legacy brand + its own rid only; CAS; never overwrites');

console.log(`branch-ops: OK (${n})`);
