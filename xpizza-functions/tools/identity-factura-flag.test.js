'use strict';
// BRAND-AGNOSTIC SERVER B1 (PLAN-brand-agnostic-server r0 §1.2) — the owner's factura-flag projection: the plan writes ONLY the
// one leaf per changed identity (true for a platform-factura restaurant, ABSENT for every other), never creates an identity,
// is idempotent, and the read-back fails on any drift; the CLI refuses to run without a stated --project.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { planFlags, applyFlags, readBack, readIdentities, desired } = require('./identity-factura-flag-core');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ORCHESTRATION O1a (advisor ruling: EVERY identity write bumps version) — the faithful Admin-SDK fake (cached-null first pass)
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');

const IDENT = { name: 'Loc', hub_lat: 15.5, hub_lng: -88, active: true, version: 3, hours: { sun: { open: true } } };

(async () => {
  assert.strictEqual(desired('x_pizza'), true, 'the platform-factura restaurant gets true');
  for (const rid of ['tb_centro', 'tb_norte', 'la_musa']) assert.strictEqual(desired(rid), null, `${rid} gets ABSENT`);
  ok('desired: true only for the platform-factura restaurant (OWNER RULE), ABSENT for every other rid');

  const db = fakeRtdb({ restaurants: {
    x_pizza: { identity: { ...IDENT } },
    tb_centro: { identity: { ...IDENT, uses_platform_factura: true } },   // a stray flag → removed
    tb_norte: { identity: { ...IDENT } },
    tb_floor_only: { kitchen: {} },                                        // no identity → never created
  } });
  const rids = ['tb_centro', 'tb_floor_only', 'tb_norte', 'x_pizza'];
  const plan = planFlags(await readIdentities(db, rids));
  assert.deepStrictEqual(plan, { missing: [], rows: [
    { rid: 'tb_centro', path: 'restaurants/tb_centro/identity/uses_platform_factura', from: true, to: null },
    { rid: 'x_pizza', path: 'restaurants/x_pizza/identity/uses_platform_factura', from: null, to: true },
  ] });
  ok('plan: one row per drifted identity (set true / remove a stray flag); an identity-less rid is skipped, never created');

  const before = JSON.parse(JSON.stringify(db.root));
  assert.deepStrictEqual(await readBack(db, rids), [
    'tb_centro: uses_platform_factura reads true, expected ABSENT',
    'x_pizza: uses_platform_factura reads null, expected true',
  ], 'the read-back names every drift before the apply');
  assert.deepStrictEqual(await applyFlags(db, plan.rows), { unversioned: [] });
  assert.deepStrictEqual(db.writes.map((w) => [w[0], w[1]]), [['txn', 'restaurants/tb_centro/identity'], ['txn', 'restaurants/x_pizza/identity']], 'ONE identity transaction per changed rid');
  for (const rid of ['x_pizza', 'tb_centro', 'tb_norte']) {
    const { uses_platform_factura: a, version: va, ...restAfter } = db.root.restaurants[rid].identity;
    const { uses_platform_factura: b, version: vb, ...restBefore } = before.restaurants[rid].identity;
    assert.deepStrictEqual(restAfter, restBefore, `${rid}: every other identity field is byte-equal`);
    assert.strictEqual(va, rid === 'tb_norte' ? vb : vb + 1, `${rid}: version ${rid === 'tb_norte' ? 'unchanged (no change)' : 'bumped by exactly 1'}`);
  }
  assert.strictEqual(db.get('restaurants/tb_floor_only/identity'), null, 'no identity node is created');
  assert.deepStrictEqual(await readBack(db, rids), [], 'read-back clean after the apply');
  ok('apply: ONE identity transaction per changed rid — the leaf + version + 1 (every other field byte-equal, an unchanged rid not bumped), then a clean read-back');

  assert.deepStrictEqual(planFlags(await readIdentities(db, rids)).rows, [], 'a second run plans 0 changes');
  await applyFlags(db, []);
  await applyFlags(db, plan.rows);   // re-applying the OLD plan: the commit-time check sees the leaf already right
  assert.strictEqual(db.writes.length, 2, 'and writes nothing (no second bump)');
  const race = fakeRtdb({ restaurants: { x_pizza: { identity: { ...IDENT } }, tb_v: { identity: { ...IDENT, version: 'x', uses_platform_factura: true } } } });
  const rplan = planFlags(await readIdentities(race, ['x_pizza', 'tb_v']));
  race.root.restaurants.x_pizza.identity.uses_platform_factura = true;   // a concurrent writer already set it
  assert.deepStrictEqual(await applyFlags(race, rplan.rows), { unversioned: ['tb_v'] }, 'an unversioned identity is refused at commit and named');
  assert.deepStrictEqual([race.writes, race.root.restaurants.x_pizza.identity.version], [[], IDENT.version], 'nothing written, nothing bumped');
  ok('idempotent: a second run plans 0 rows and writes nothing; a stale plan re-checks AT COMMIT (no write, no bump); an unversioned identity is refused and named');

  const noX = fakeRtdb({ restaurants: { tb_norte: { identity: { ...IDENT } } } });
  assert.deepStrictEqual(planFlags(await readIdentities(noX, ['tb_norte'])).missing, ['x_pizza'], 'the platform restaurant absent from discovery is reported');
  assert.deepStrictEqual(planFlags(await readIdentities(noX, ['tb_norte', 'x_pizza'])).missing, ['x_pizza'], 'a platform restaurant with no identity node is reported');
  assert.ok((await readBack(noX, ['tb_norte'])).some((p) => /x_pizza: platform-factura restaurant has no identity node/.test(p)), 'and fails the read-back');
  ok('a platform-factura restaurant with no identity node is REFUSED (plan.missing) and fails the read-back');

  const drift = fakeRtdb({ restaurants: { x_pizza: { identity: { ...IDENT, uses_platform_factura: 'true' } } } });
  assert.deepStrictEqual(await readBack(drift, ['x_pizza']), ['x_pizza: uses_platform_factura reads "true", expected true'], 'a non-boolean value is a mismatch');
  ok('read-back: a string "true" is not the boolean true');

  // 🔴 the spawned CLI can NEVER reach a real database: RTDB goes to a dead local port, the credentials point nowhere
  const env = { ...process.env, FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:1', GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/creds.json' };
  delete env.GOOGLE_CLOUD_PROJECT; delete env.GCLOUD_PROJECT; delete env.NODE_OPTIONS;
  const cli = path.join(__dirname, 'identity-factura-flag.js');
  const r = spawnSync(process.execPath, [cli], { env, encoding: 'utf8', timeout: 20000 });
  assert.notStrictEqual(r.status, 0, 'refuses without --project');
  assert.ok(!/identity-factura-flag (APPLY|DRY RUN)/.test(r.stdout), 'and reads nothing');
  const expected = require('./require-project').expectedProject();
  for (const v of ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT']) {
    const r2 = spawnSync(process.execPath, [cli, '--apply'], { env: { ...env, [v]: expected }, encoding: 'utf8', timeout: 20000 });
    assert.notStrictEqual(r2.status, 0, `${v}=${expected} without --project is refused`);
    assert.match(r2.stderr, /explicit flag/, 'with the explicit-flag refusal');
    assert.ok(!/DRY RUN|APPLY|applied/.test(r2.stdout), 'and nothing is planned, read or written');
  }
  ok('the CLI refuses to run (dry run or --apply) without a stated --project — an inherited GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT is NOT enough');

  console.log(`\nidentity-factura-flag: OK (${n})`);
})().catch((e) => { console.error('identity-factura-flag FAILED:', e); process.exit(1); });
