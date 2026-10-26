'use strict';
// ORCHESTRATION O1b (PLAN-orch-o1b r3) — the pure / small pieces: T2 the team readiness reader, T3d hours times must be strings.
// Run: node branches/o1b-pure.test.js
const assert = require('assert');
const { createFakeDb } = require('../merchant/_fake-db');
const O = require('./branch-ops');
const R = require('./readiness-readers');
const { validateBranchIdentity } = require('../brands/brand-model');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('o1b-pure: FAILED — exited without completing'); process.exitCode = 1; } });

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const H7 = Object.fromEntries(DAYS.map((d) => [d, { open: true, start: '09:00', end: '18:00' }]));
const withDay = (d, v) => ({ ...H7, [d]: v });
const g = { granted_at: 1, granted_by: 'x' };

(async () => {
  // ── T2 teamCount = owners of the brand + managers of THIS rid; an outage throws ──
  {
    const db = createFakeDb({ brand_members: { tb: { owners: { ownerA1: g, ownerA2: g }, managers: { tb_sur: { mgrS01: g }, tb_norte: { mgrN01: g, mgrN02: g } } } } });
    assert.strictEqual(await R.teamCount(db, 'tb', 'tb_sur'), 3, 'TEAM-COUNT owners + this rid\'s managers');
    assert.strictEqual(await R.teamCount(db, 'tb', 'tb_este'), 2, 'owners only (no managers here)');
    assert.strictEqual(await R.teamCount(createFakeDb({}), 'tb', 'tb_sur'), 0, 'no team → 0');
    const down = createFakeDb({}); down.failReads.add('brand_members');
    await assert.rejects(R.teamCount(down, 'tb', 'tb_sur'), /injected read failure/, 'TEAM-OUTAGE-THROWS: an outage is never a count of 0');
    ok('teamCount: brand owners + this branch\'s managers; a read failure throws (never no_owner_or_manager from an outage)');
  }

  // ── T3d hours: string times first; every value hours7Errors accepts is accepted by validateBranchIdentity ──
  {
    assert.deepStrictEqual(O.hours7Errors(H7), []);
    const bad = {
      'array times': withDay('mon', { open: true, start: ['09:00'], end: ['18:00'] }),
      'object times': withDay('mon', { open: true, start: { h: 9 }, end: { h: 18 } }),
      'number times': withDay('mon', { open: true, start: 900, end: 1800 }),
      'overnight': withDay('fri', { open: true, start: '22:00', end: '02:00' }),
      'equal times': withDay('mon', { open: true, start: '09:00', end: '09:00' }),
      'missing day': Object.fromEntries(DAYS.slice(1).map((d) => [d, H7[d]])),
      'extra day key': { ...H7, hol: { open: false } },
      'extra per-day key': withDay('mon', { open: true, start: '09:00', end: '18:00', note: 'x' }),
      'closed day with times': withDay('sun', { open: false, start: '09:00', end: '18:00' }),
      'bad HH:MM': withDay('mon', { open: true, start: '9:00', end: '18:00' }),
    };
    for (const [label, h] of Object.entries(bad)) assert.ok(O.hours7Errors(h).length > 0, `HOURS-REFUSED ${label}`);
    // the draft and profile planners refuse array-valued times (the Codex r1 #7 probe)
    const arr = withDay('mon', { open: true, start: ['09:00'], end: ['18:00'] });
    assert.ok(O.draftErrors({ brand_id: 'tb', location_name: 'Sur', phone: '+50431234567', hours: arr, prep_default_min: 20 }).includes('bad_hours'), 'HOURS-DRAFT-ARRAY');
    assert.deepStrictEqual(O.planProfilePatch({ current: { version: 3, hours: H7 }, patch: { hours: arr }, expectedVersion: 3 }).errors, ['bad_hours'], 'HOURS-PATCH-ARRAY');
    // agreement: anything hours7Errors accepts, the identity validator accepts
    const ident = (hours) => ({ name: 'TB', brand_id: 'tb', location_name: 'Sur', phone: '+50431234567', hub_lat: 15.5, hub_lng: -88.0, delivery_radius_km: 5, zone: { type: 'circle', radius_km: 5 }, prep_default_min: 20, version: 1, active: false, hours });
    for (const h of [H7, withDay('sun', { open: false }), Object.fromEntries(DAYS.map((d) => [d, { open: false }])), withDay('sat', { open: true, start: '00:00', end: '23:59' })]) {
      assert.deepStrictEqual(O.hours7Errors(h), []);
      assert.ok(validateBranchIdentity('branch', ident(h), 'tb').ok, `HOURS-AGREE ${JSON.stringify(h.sun)}`);
    }
    ok('hours7Errors: string times first (arrays / objects / numbers refused) + overnight, equal, missing / extra keys; accepted hours always validate as an identity');
  }

  FINISHED = true;
  console.log(`\no1b-pure: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
