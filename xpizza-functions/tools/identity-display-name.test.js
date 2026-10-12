'use strict';
// R3-FIX D12 — the owner's display-name CLI: the plan refuses what the reader would not show and never writes into a
// non-routing-valid identity; apply writes ONE path and reads it back; the CLI refuses to run without a stated project.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { planDisplayName, applyDisplayName, readIdentity } = require('./identity-display-name-admin');
const { IDENTITIES } = require('../seed_identity');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

function fakeRtdb(init = {}) {
  const data = { ...init }; const writes = [];
  const ref = (p) => ({
    once: async () => ({ val: () => (p in data ? data[p] : null) }),
    update: async (u) => { writes.push(u); for (const [k, v] of Object.entries(u)) { if (v === null) delete data[k]; else data[k] = v; } },
  });
  return { ref: (p) => ref(p || ''), data, writes };
}

(async () => {
  const X = { ...IDENTITIES.x_pizza, whatsapp_instance: 'i', display_name: null };   // a ROUTING-VALID identity
  const p = planDisplayName({ op: 'set', rid: 'x_pizza', value: 'X. Pizza', current: X });
  assert.deepStrictEqual(p, { ok: true, row: { path: 'restaurants/x_pizza/identity/display_name', from: null, to: 'X. Pizza' }, label: { before: 'Recoger en X Pizza', after: 'Recoger en X. Pizza' } });
  assert.deepStrictEqual(planDisplayName({ op: 'delete', rid: 'x_pizza', current: { ...X, display_name: 'X. Pizza' } }).row, { path: 'restaurants/x_pizza/identity/display_name', from: 'X. Pizza', to: null });
  for (const bad of ['', '   ', ' X. Pizza', 'X. Pizza ', 'x'.repeat(61), 7, null]) assert.strictEqual(planDisplayName({ op: 'set', rid: 'x_pizza', value: bad, current: X }).ok, false, `refuses ${JSON.stringify(bad)}`);
  for (const bad of [null, { name: 'Sushi' }, { ...X, hub_lat: 'oops' }, { ...X, active: 'yes' }, { ...X, name: '' }]) {
    assert.match(planDisplayName({ op: 'set', rid: 'r3', value: 'Sushi', current: bad }).error || '', /not routing-valid/, `never into a non-routing-valid identity ${JSON.stringify(bad && Object.keys(bad).length)}`);
  }
  assert.strictEqual(planDisplayName({ op: 'set', rid: '../x', value: 'A', current: X }).ok, false, 'a path-like rid is refused');
  assert.strictEqual(planDisplayName({ op: 'rename', rid: 'x_pizza', value: 'A', current: X }).ok, false);
  ok('plan: set/delete one path with the before → after pickup line; refuses a value the reader would not show, a non-ROUTING-VALID identity (isRoutingValid), a bad rid, an unknown op');

  const db = fakeRtdb({ 'restaurants/x_pizza/identity': X });
  const cur = await readIdentity(db, 'x_pizza');
  assert.deepStrictEqual(cur, X);
  const res = await applyDisplayName(db, planDisplayName({ op: 'set', rid: 'x_pizza', value: 'X. Pizza', current: cur }));
  assert.deepStrictEqual([res.ok, db.writes], [true, [{ 'restaurants/x_pizza/identity/display_name': 'X. Pizza' }]], 'ONE path written, read back');
  const lying = fakeRtdb({ 'restaurants/x_pizza/identity': X }); lying.ref = ((r) => (p) => ({ ...r(p), once: async () => ({ val: () => 'other' }) }))(lying.ref);
  assert.strictEqual((await applyDisplayName(lying, planDisplayName({ op: 'set', rid: 'x_pizza', value: 'X. Pizza', current: cur }))).ok, false, 'a read-back mismatch is reported');
  ok('apply: ONE multi-path update of the single field, then a read-back that must match');

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

  console.log(`\nidentity-display-name: OK (${n})`);
})().catch((e) => { console.error('identity-display-name FAILED:', e); process.exit(1); });
