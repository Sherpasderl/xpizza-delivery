'use strict';
// BRAND-AGNOSTIC SERVER (PLAN-brand-agnostic-server r3 + r0 §5) — the index.js inverse-fold guard for this slice.
// Run: node brand-server-wiring.guard.test.js
//   (i)  unapplyBrandServerIndex(index.js) === df4a1bdb:index.js BYTE-FOR-BYTE; a byte changed inside a hunk, outside every hunk,
//        and a duplicated hunk are each detected;
//   (ii) non-vacuity: the live index.js differs from df4a1bdb, every hunk is present exactly once, and the hunks carry the
//        return-base copy, the identity-hub ingest + guarded transition, the reassertAssignable preload and the hub-less paths.
// Base = df4a1bdb (train 32f6f17e + the release-race fix) — the slice is stacked on it in the next train. This slice is the newest layer, so
// its inverse is applied INNERMOST in every index.js fold consumer.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyBrandServerIndex, unapplyBrandServerModule, INDEX_HUNKS, MODULE_HUNKS, FILES } = require('./tools/brand-server-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const idx = require('./tools/dlite-push-inverse').unapplyDlitePushIndex(require('./tools/membership-inverse').unapplyMembershipIndex(require('./tools/portalui-inverse').unapplyPortalUiIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'))))));   // DISPATCH-LITE PUSH (newer layer) reversed first
const BASE = execFileSync('git', ['show', 'df4a1bdb:xpizza-functions/index.js'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

assert.strictEqual(unapplyBrandServerIndex(idx), BASE, '🔴 index.js minus the brand-server hunks is not df4a1bdb:index.js');
{
  const inHunk = idx.replace('async function alertHubUnresolved(', 'async function alertHubUnresolveD(');
  assert.notStrictEqual(inHunk, idx);
  let detected; try { detected = unapplyBrandServerIndex(inHunk) !== BASE; } catch (_) { detected = true; }
  assert.ok(detected, 'a byte changed INSIDE a hunk is detected');
  const outside = idx.replace('exports.cancelPaidOrder = onRequest(', 'exports.cancelPaidOrder = onRequest( ');
  assert.notStrictEqual(outside, idx);
  assert.notStrictEqual(unapplyBrandServerIndex(outside), BASE, 'a byte changed OUTSIDE every hunk is detected');
  assert.throws(() => unapplyBrandServerIndex(idx + INDEX_HUNKS[0][0]), /occurs 2×/, 'a duplicated hunk is refused');
}
ok(`PROOF (i): unapplyBrandServerIndex(index.js) === df4a1bdb:index.js byte-for-byte (${INDEX_HUNKS.length} hunks); inside / outside / duplicated changes detected`);

assert.notStrictEqual(idx, BASE, '🔴 the live index.js equals df4a1bdb — the brand-agnostic server slice is MISSING');
for (const [now] of INDEX_HUNKS) assert.strictEqual(idx.split(now).length - 1, 1, `hunk present once: ${JSON.stringify(now.slice(0, 60))}`);
const all = INDEX_HUNKS.map(([now]) => now).join('\n');
for (const must of ['withReturnCopy(updates, priorRid', 'hubForPeek(db, ingestRid)', "if (status !== driver.status || arrived) {", "trackerHold('assign:hub'",
  'sameHubRids(preTasks, driverId, newOrderId)', 'async function alertHubUnresolved(', 'const timeoutHub = await resolveAssignHub(db, orderForTimeout);',
  'hubFor: (rid) => hubForFresh(db, rid)']) assert.ok(all.includes(must), `the hunks carry ${must}`);
for (const gone of ['RESTAURANT_LAT', 'RESTAURANT_LNG', 'X_PIZZA_HUB']) assert.ok(!idx.includes(gone), `${gone} is gone from index.js`);
ok('PROOF (ii): the live index.js differs from df4a1bdb; every hunk is present once and they carry the return copy, the identity-hub ingest + guarded transition, the hub preload, the hub-less paths and the materialize hubFor; no static hub constant remains');
// (iii) the pinned materialize modules (r3 §E): each restores df4a1bdb byte-for-byte; non-vacuous; inside / duplicated detected
assert.deepStrictEqual([...FILES].sort(), ['materialize.js', 'pixelpay-confirm.js', 'resolve-manual.js']);
for (const f of FILES) {
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  const base = execFileSync('git', ['show', `df4a1bdb:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.notStrictEqual(src, base, `non-vacuity: ${f} carries the slice`);
  assert.strictEqual(unapplyBrandServerModule(f, src), base, `🔴 ${f} minus the brand-server hunks is not df4a1bdb:${f}`);
  const [now] = MODULE_HUNKS[f][0];
  assert.throws(() => unapplyBrandServerModule(f, src + now), /occurs 2×/, `${f}: a duplicated hunk is refused`);
  assert.ok(MODULE_HUNKS[f].some(([h]) => h.includes('materializeRestaurant')), `${f}: the hunks carry materializeRestaurant`);
}
assert.strictEqual(unapplyBrandServerModule('whatsapp.js', 'x'), 'x', 'an unlisted module passes through');
{ // DRIVER C (newer) edits whatsapp.js, an unlisted module here: its own inverse (applied first) restores the pre-C bytes exactly
  const { unapplyDrvcModule } = require('./tools/drvc-inverse');
  const live = fs.readFileSync(path.join(__dirname, 'whatsapp.js'), 'utf8');
  const preC = execFileSync('git', ['show', 'c8b08cf1:xpizza-functions/whatsapp.js'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.strictEqual(unapplyBrandServerModule('whatsapp.js', unapplyDrvcModule('whatsapp.js', live)), preC, '🔴 whatsapp.js minus the DRIVER C hunks is not the pre-C whatsapp.js');
}
ok(`PROOF (iii): unapplyBrandServerModule restores df4a1bdb byte-for-byte for ${FILES.join(', ')}; a duplicated hunk is refused; an unlisted module passes through`);
console.log(`brand-server-wiring.guard: OK (${n} cases)`);
