'use strict';
// R3-FIX D12 — the owner's display-name CLI: the plan refuses what the reader would not show and never writes into a
// non-routing-valid identity; apply changes ONE field (+ the version bump, orchestration O1a) in one identity transaction and
// reads it back; the CLI refuses to run without a stated project.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { planDisplayName, applyDisplayName, readIdentity } = require('./identity-display-name-admin');
const { IDENTITIES } = require('../seed_identity');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ORCHESTRATION O1a (advisor ruling: EVERY identity write bumps version) — the faithful Admin-SDK fake: the identity-level
// transaction's cached-null first pass is exercised, and every committed write is logged as [kind, path, value].
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');
const ID = 'restaurants/x_pizza/identity';
const tree = (identity) => fakeRtdb({ restaurants: { x_pizza: { identity } } });

(async () => {
  const X = { ...IDENTITIES.x_pizza, whatsapp_instance: 'i', display_name: null };   // a ROUTING-VALID identity
  const XS = { ...X }; delete XS.display_name;   // as stored (RTDB never holds a null leaf)
  const p = planDisplayName({ op: 'set', rid: 'x_pizza', value: 'X. Pizza', current: X });
  assert.deepStrictEqual(p, { ok: true, row: { path: 'restaurants/x_pizza/identity/display_name', from: null, to: 'X. Pizza' }, label: { before: 'Recoger en X Pizza', after: 'Recoger en X. Pizza' } });
  assert.deepStrictEqual(planDisplayName({ op: 'delete', rid: 'x_pizza', current: { ...X, display_name: 'X. Pizza' } }).row, { path: 'restaurants/x_pizza/identity/display_name', from: 'X. Pizza', to: null });
  for (const bad of ['', '   ', ' X. Pizza', 'X. Pizza ', 'x'.repeat(61), 7, null]) assert.strictEqual(planDisplayName({ op: 'set', rid: 'x_pizza', value: bad, current: X }).ok, false, `refuses ${JSON.stringify(bad)}`);
  // codex D12b r1 P2-1: private-use code points (a marker) and control characters are refused — never stored as a brand
  for (const bad of ['X. Pizza\uE000brand\uE000', '\uE000', 'X\u0007Pizza', 'X\u0085', 'X\uDB80\uDC00']) assert.match(planDisplayName({ op: 'set', rid: 'x_pizza', value: bad, current: X }).error || '', /display name must be/, `refuses ${JSON.stringify(bad)}`);
  for (const bad of [null, { name: 'Sushi' }, { ...X, hub_lat: 'oops' }, { ...X, active: 'yes' }, { ...X, name: '' }]) {
    assert.match(planDisplayName({ op: 'set', rid: 'r3', value: 'Sushi', current: bad }).error || '', /not routing-valid/, `never into a non-routing-valid identity ${JSON.stringify(bad && Object.keys(bad).length)}`);
  }
  assert.strictEqual(planDisplayName({ op: 'set', rid: '../x', value: 'A', current: X }).ok, false, 'a path-like rid is refused');
  assert.strictEqual(planDisplayName({ op: 'rename', rid: 'x_pizza', value: 'A', current: X }).ok, false);
  ok('plan: set/delete one path with the before → after pickup line; refuses a value the reader would not show, a non-ROUTING-VALID identity (isRoutingValid), a bad rid, an unknown op');

  const db = tree(X);
  const cur = await readIdentity(db, 'x_pizza');
  assert.deepStrictEqual(cur, XS);
  const res = await applyDisplayName(db, planDisplayName({ op: 'set', rid: 'x_pizza', value: 'X. Pizza', current: cur }));
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(db.writes, [['txn', ID, { ...XS, display_name: 'X. Pizza', version: XS.version + 1 }]], 'ONE identity transaction: the field + version + 1, nothing else');
  const lying = tree(X); lying.ref = ((r) => (p) => ({ ...r(p), once: async () => ({ val: () => 'other' }) }))(lying.ref);
  assert.strictEqual((await applyDisplayName(lying, planDisplayName({ op: 'set', rid: 'x_pizza', value: 'X. Pizza', current: cur }))).ok, false, 'a read-back mismatch is reported');
  const unversioned = tree({ ...XS, version: 'v1' });
  const ru = await applyDisplayName(unversioned, planDisplayName({ op: 'set', rid: 'x_pizza', value: 'X. Pizza', current: XS }));
  assert.deepStrictEqual([ru.ok, ru.error, unversioned.writes], [false, 'unversioned', []], 'an identity without a numeric version at COMMIT is refused, nothing written');
  ok('apply: ONE identity transaction (the field + version + 1, every other field byte-equal), then a read-back that must match; an unversioned identity is refused at commit');

  // BRAND-AGNOSTIC SERVER (PLAN r3 §F): ABSENT-FILL ONLY — equal → no-op (nothing written); different → PRESERVED + refused
  const named = { ...X, display_name: 'X. Pizza' };
  const same = planDisplayName({ op: 'set', rid: 'x_pizza', value: 'X. Pizza', current: named });
  assert.strictEqual(same.ok && same.noop, true, 'an equal display_name is a no-op');
  const dbSame = tree(named);
  assert.strictEqual((await applyDisplayName(dbSame, same)).ok, true, 'the no-op still reads the value back');
  assert.deepStrictEqual(dbSame.writes, [], 'a no-op writes nothing (no version bump)');
  const clash = planDisplayName({ op: 'set', rid: 'x_pizza', value: 'X Pizzeria', current: named });
  assert.deepStrictEqual([clash.ok, clash.conflict], [false, true], 'a different existing display_name is a conflict');
  assert.match(clash.error, /already "X. Pizza".*PRESERVED/, 'and is preserved');
  assert.deepStrictEqual(planDisplayName({ op: 'delete', rid: 'x_pizza', current: named }).row.to, null, 'delete stays the explicit way back');
  ok('absent-fill: set writes only an ABSENT display_name; equal → no-op (no write); a different value is PRESERVED and refused (conflict)');

  // set-mark: identity/display_mark — the dispatch chip mark, same contract as set
  assert.deepStrictEqual(planDisplayName({ op: 'set-mark', rid: 'x_pizza', value: 'X', current: X }), { ok: true, row: { path: 'restaurants/x_pizza/identity/display_mark', from: null, to: 'X' } });
  assert.strictEqual(planDisplayName({ op: 'set-mark', rid: 'tb_norte', value: 'TN', current: X }).ok, true, 'a 2-character mark');
  for (const bad of ['', 'XYZ', ' X', 'X ', ' ', 7, null, undefined, 'X\u0007', '']) {
    assert.match(planDisplayName({ op: 'set-mark', rid: 'x_pizza', value: bad, current: X }).error || '', /display mark must be 1–2 characters/, `refuses ${JSON.stringify(bad)}`);
  }
  assert.match(planDisplayName({ op: 'set-mark', rid: 'r3', value: 'R', current: { name: 'Sushi' } }).error || '', /not routing-valid/, 'never into a non-routing-valid identity');
  const marked = { ...X, display_mark: 'M' };
  assert.strictEqual(planDisplayName({ op: 'set-mark', rid: 'tb_norte', value: 'M', current: marked }).noop, true, 'an equal mark is a no-op');
  const markClash = planDisplayName({ op: 'set-mark', rid: 'tb_norte', value: 'X', current: marked });
  assert.deepStrictEqual([markClash.ok, markClash.conflict], [false, true], 'a different existing mark is a conflict');
  assert.match(markClash.error, /display_mark is already "M".*PRESERVED/);
  const dbMark = tree(X);
  const resMark = await applyDisplayName(dbMark, planDisplayName({ op: 'set-mark', rid: 'x_pizza', value: 'X', current: X }));
  assert.deepStrictEqual([resMark.ok, dbMark.writes], [true, [['txn', ID, { ...XS, display_mark: 'X', version: XS.version + 1 }]]], 'ONE identity transaction: the mark + version + 1, read back');
  assert.deepStrictEqual(dbMark.get(ID), { ...XS, display_mark: 'X', version: XS.version + 1 }, 'every other identity field is byte-equal');
  // codex build r1 P2: absent-fill is enforced AT COMMIT (a leaf transaction) — a value written between plan and apply is PRESERVED
  {
    const raceDb = tree(X);
    const live = raceDb.root.restaurants.x_pizza.identity;
    const markPlan = planDisplayName({ op: 'set-mark', rid: 'x_pizza', value: 'N', current: X });   // planned while absent
    live.display_mark = 'Z';                                                                         // a concurrent writer
    const res = await applyDisplayName(raceDb, markPlan);
    assert.deepStrictEqual([res.ok, res.conflict, res.back], [false, true, 'Z'], 'a mark written meanwhile is preserved and reported as a conflict');
    assert.deepStrictEqual([live.display_mark, raceDb.writes], ['Z', []], 'never overwritten, nothing written (no bump)');
    const namePlan = planDisplayName({ op: 'set', rid: 'x_pizza', value: 'X. Pizza', current: X });
    live.display_name = 'Otra';
    const res2 = await applyDisplayName(raceDb, namePlan);
    assert.deepStrictEqual([res2.ok, res2.conflict, raceDb.get(`${ID}/display_name`)], [false, true, 'Otra'], 'a display_name written meanwhile is preserved');
    live.display_mark = 'N';                                                                         // equal meanwhile → success, no write
    assert.deepStrictEqual((await applyDisplayName(raceDb, markPlan)).ok, true, 'an equal value written meanwhile is a no-op success');
    assert.deepStrictEqual(raceDb.writes, [], 'and writes nothing');
    const del = planDisplayName({ op: 'delete', rid: 'x_pizza', current: { ...X, display_name: 'Otra' } });
    assert.strictEqual((await applyDisplayName(raceDb, del)).ok, true, 'delete stays the explicit replace path');
    assert.strictEqual(raceDb.get(`${ID}/display_name`), null);
    assert.strictEqual(raceDb.get(`${ID}/version`), XS.version + 1, 'delete bumps version (ONE bump)');
    assert.strictEqual(raceDb.writes.length, 1);
    assert.deepStrictEqual(await applyDisplayName(raceDb, del), { ok: true, back: null }, 'deleting an absent value is a no-op');
    assert.strictEqual(raceDb.writes.length, 1, 'no write, no bump');
  }
  ok('absent-fill at COMMIT (identity transaction): a value written between plan and apply is preserved + conflict; an equal one is a no-op; delete stays explicit; only a real change bumps version (once)');

  ok('set-mark: one-field write (+ version bump) of a 1–2 character mark + read-back (every other identity field byte-equal); malformed / non-routing-valid refused; equal → no-op; a different existing mark PRESERVED (conflict)');

  // 🔴 the spawned CLI can NEVER reach a real database, even if a regression let it past the guard: any RTDB traffic goes to
  // a dead local port and the credentials point nowhere (the refusal reason below proves WHICH guard answered)
  const env = { ...process.env, FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:1', GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/creds.json' };
  delete env.GOOGLE_CLOUD_PROJECT; delete env.GCLOUD_PROJECT; delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [path.join(__dirname, 'identity-display-name.js'), 'status'], { env, encoding: 'utf8', timeout: 20000 });
  assert.notStrictEqual(r.status, 0, 'refuses without --project');
  assert.ok(!/identity-display-name (APPLY|DRY RUN)|"restaurants"/.test(r.stdout), 'and reads nothing');
  // codex D12 r1 P2-1: an INHERITED project variable is not a stated flag — refused even for --apply, before any client exists
  const expected = require('./require-project').expectedProject();
  for (const v of ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT']) {
    const r2 = spawnSync(process.execPath, [path.join(__dirname, 'identity-display-name.js'), 'set', 'x_pizza', 'X. Pizza', '--apply'], { env: { ...env, [v]: expected }, encoding: 'utf8', timeout: 20000 });
    assert.notStrictEqual(r2.status, 0, `${v}=${expected} without --project is refused`);
    assert.match(r2.stderr, /explicit flag/, 'with the explicit-flag refusal');
    assert.ok(!/DRY RUN|APPLY|applied/.test(r2.stdout), 'and nothing is planned, read or written');
  }
  ok('the CLI refuses to run (read or write) without a stated --project — an inherited GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT is NOT enough, even for --apply');
  // a COHERENT dead-port emulator config (RTDB + Firestore both at 127.0.0.1:1, void credentials), so the project guard passes
  // and the mark check is what answers — before initializeApp; nothing can reach any database either way
  const deadEnv = { ...env, FIRESTORE_EMULATOR_HOST: '127.0.0.1:1' };
  for (const bad of ['XYZ', '']) {
    const r3 = spawnSync(process.execPath, [path.join(__dirname, 'identity-display-name.js'), '--project', expected, 'set-mark', 'x_pizza', bad, '--apply'], { env: deadEnv, encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(r3.status, 1, `set-mark ${JSON.stringify(bad)} exits 1`);
    assert.match(r3.stderr, /REFUSED — display mark must be 1–2 characters/, 'refused by the mark check');
    assert.ok(!/DRY RUN|APPLY|applied/.test(r3.stdout), 'before any client exists: nothing planned, read or written');
  }
  ok('the CLI refuses a 3-character / empty mark BEFORE any database client exists');

  console.log(`\nidentity-display-name: OK (${n})`);
})().catch((e) => { console.error('identity-display-name FAILED:', e); process.exit(1); });
