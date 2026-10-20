'use strict';
// TRACKER FIXES (BUILD r1.5 §3.1) — the test hold seam is INERT in production: no non-test source assigns globalThis.__trackerHold,
// the seam is a no-op without it, and every hold point index.js / tracking/ use goes through tracking/hold.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { trackerHold } = require('./tracking/hold');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  if (['node_modules', 'test', 'contract', '.git'].includes(e.name)) return [];
  const p = path.join(d, e.name);
  return e.isDirectory() ? walk(p) : (/\.(c|m)?js$/.test(e.name) && !/\.test\.(c|m)?js$/.test(e.name) ? [p] : []);
});
const assigners = walk(__dirname).filter((f) => /__trackerHold\s*=(?!=)/.test(fs.readFileSync(f, 'utf8')));
assert.deepStrictEqual(assigners, [], `🔴 production source assigns the test hold: ${assigners}`);
ok('no production source assigns globalThis.__trackerHold');

(async () => {
  delete globalThis.__trackerHold;
  assert.strictEqual(await trackerHold('x', {}), undefined, 'no hook → resolves immediately, no effect');
  const seen = []; globalThis.__trackerHold = async (name) => { seen.push(name); };
  await trackerHold('seq', {}); delete globalThis.__trackerHold;
  assert.deepStrictEqual(seen, ['seq'], 'an installed test hook is called with the hold name');
  ok('the seam is a no-op without a hook and calls an installed test hook');
  const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  for (const h of ['ingest:auth', 'ingest:epoch', 'ingest:commit']) assert.strictEqual(idx.split(`trackerHold('${h}'`).length - 1, 1, `index.js hold point ${h} present once`);
  assert.ok(/const hold = deps\.hold \|\| trackerHold;/.test(fs.readFileSync(path.join(__dirname, 'tracking', 'recompute.js'), 'utf8')), 'recompute defaults to the seam');
  const rc = fs.readFileSync(path.join(__dirname, 'tracking', 'recompute.js'), 'utf8');
  assert.ok(rc.indexOf("hold('claims:grant'") > rc.indexOf('const stillMine') && rc.indexOf("hold('claims:grant'") < rc.indexOf('grantUpdater(s, at)'), 'the claims:grant hold sits after stillMine and before the grant');
  assert.ok(rc.indexOf("hold('claims:post-grant'") > rc.indexOf('grantUpdater(s, at)') && rc.indexOf("hold('claims:post-grant'") < rc.indexOf('ownerHintUpdater(s, claimOwner, at)'), 'the claims:post-grant hold sits after the grant and before the owner hint');
  ok('index.js ingest hold points (auth / epoch / commit) and the recompute default route through tracking/hold.js');
  console.log(`tracker-hold-inertness.guard: OK (${n})`);
})().catch((e) => { console.error('tracker-hold-inertness.guard: FAIL\n', e); process.exit(1); });
