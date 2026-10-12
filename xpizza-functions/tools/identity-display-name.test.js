'use strict';
// R3-FIX D12 — the owner's display-name CLI: the plan refuses what the reader would not show and never writes into a
// non-routable identity; apply writes ONE path and reads it back; the CLI refuses to run without a stated project.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { planDisplayName, applyDisplayName, readIdentityNames } = require('./identity-display-name-admin');

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
  const X = { name: 'X Pizza', display_name: null };
  const p = planDisplayName({ op: 'set', rid: 'x_pizza', value: 'X. Pizza', current: X });
  assert.deepStrictEqual(p, { ok: true, row: { path: 'restaurants/x_pizza/identity/display_name', from: null, to: 'X. Pizza' }, label: { before: 'Recoger en X Pizza', after: 'Recoger en X. Pizza' } });
  assert.deepStrictEqual(planDisplayName({ op: 'delete', rid: 'x_pizza', current: { name: 'X Pizza', display_name: 'X. Pizza' } }).row, { path: 'restaurants/x_pizza/identity/display_name', from: 'X. Pizza', to: null });
  for (const bad of ['', '   ', ' X. Pizza', 'X. Pizza ', 'x'.repeat(61), 7, null]) assert.strictEqual(planDisplayName({ op: 'set', rid: 'x_pizza', value: bad, current: X }).ok, false, `refuses ${JSON.stringify(bad)}`);
  assert.match(planDisplayName({ op: 'set', rid: 'r3', value: 'Sushi', current: { name: null, display_name: null } }).error, /no identity name/, 'never into a non-routable identity');
  assert.strictEqual(planDisplayName({ op: 'set', rid: '../x', value: 'A', current: X }).ok, false, 'a path-like rid is refused');
  assert.strictEqual(planDisplayName({ op: 'rename', rid: 'x_pizza', value: 'A', current: X }).ok, false);
  ok('plan: set/delete one path with the before → after pickup line; refuses a value the reader would not show, a non-routable identity, a bad rid, an unknown op');

  const db = fakeRtdb({ 'restaurants/x_pizza/identity/name': 'X Pizza' });
  const cur = await readIdentityNames(db, 'x_pizza');
  assert.deepStrictEqual(cur, { name: 'X Pizza', display_name: null });
  const res = await applyDisplayName(db, planDisplayName({ op: 'set', rid: 'x_pizza', value: 'X. Pizza', current: cur }));
  assert.deepStrictEqual([res.ok, db.writes], [true, [{ 'restaurants/x_pizza/identity/display_name': 'X. Pizza' }]], 'ONE path written, read back');
  const lying = fakeRtdb({ 'restaurants/x_pizza/identity/name': 'X Pizza' }); lying.ref = ((r) => (p) => ({ ...r(p), once: async () => ({ val: () => 'other' }) }))(lying.ref);
  assert.strictEqual((await applyDisplayName(lying, planDisplayName({ op: 'set', rid: 'x_pizza', value: 'X. Pizza', current: cur }))).ok, false, 'a read-back mismatch is reported');
  ok('apply: ONE multi-path update of the single field, then a read-back that must match');

  const env = { ...process.env }; delete env.GOOGLE_CLOUD_PROJECT; delete env.GCLOUD_PROJECT; delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [path.join(__dirname, 'identity-display-name.js'), 'status'], { env, encoding: 'utf8', timeout: 20000 });
  assert.notStrictEqual(r.status, 0, 'refuses without --project');
  assert.ok(!/identity-display-name (APPLY|DRY RUN)|"restaurants"/.test(r.stdout), 'and reads nothing');
  ok('the CLI refuses to run (read or write) without a stated --project');

  console.log(`\nidentity-display-name: OK (${n})`);
})().catch((e) => { console.error('identity-display-name FAILED:', e); process.exit(1); });
