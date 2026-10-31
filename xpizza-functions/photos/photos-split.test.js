'use strict';
// DISH PHOTOS A1 step 6 — the photos isolation group, proven by REAL child loads of index.js (the ops-split pattern):
//   1. ROUTING: FUNCTION_TARGET ∈ {photoUploadStart, photoProcess} → ONLY the photo group is exported, the `photos_entry` marker exactly
//      once; unset / '' / wrong-case / padded / prefix / unknown / a non-photo function → the photos branch never runs.
//   2. ISOLATION: a photo instance never loads index.js's full graph (portal/functions, portal/ops-functions, whatsapp, stats, factura).
//   3. SHARP IS LAZY (advisor ruling 2026-10-26): no load of ANY sampled target puts a sharp / @img module in the require cache, and the
//      ONLY require('sharp') in the photo closure is the one inside photos/pipeline.js's processImage.
// Run: node photos/photos-split.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const WATCHDOG = setTimeout(() => { console.error('photos-split: FAILED — watchdog (300 s)'); process.kill(process.pid, 'SIGKILL'); }, 300000); WATCHDOG.unref();
const FN = path.join(__dirname, '..');
const PHOTOS = ['photoUploadStart', 'photoProcess', 'photoSweep'];
const CHILD = `
  const path = require('path');
  const m = require(path.join(${JSON.stringify(FN)}, 'index.js'));
  const keys = Object.keys(require.cache);
  const local = keys.filter((p) => !p.includes('node_modules')).map((p) => path.relative(${JSON.stringify(FN)}, p).split(path.sep).join('/')).sort();
  const sharp = keys.filter((p) => /node_modules[\\\\/](sharp|@img)[\\\\/]/.test(p)).length;
  console.log('RESULT ' + JSON.stringify({ exports: Object.keys(m).sort(), local, sharp }));`;
function load(target) {
  const env = { ...process.env };
  for (const k of ['FIREBASE_DATABASE_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']) delete env[k];
  if (target === undefined) delete env.FUNCTION_TARGET; else env.FUNCTION_TARGET = target;
  const r = spawnSync(process.execPath, ['-e', CHILD], { env, encoding: 'utf8', timeout: 120000, maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`child (${String(target)}) failed: ${(r.stderr || '').slice(-600)}`);
  const lines = r.stdout.split('\n');
  return { ...JSON.parse(lines.find((l) => l.startsWith('RESULT ')).slice(7)), markers: lines.filter((l) => l.startsWith('photos_entry')) };
}

// ── 1 + 2 + 3: the photo targets ──
for (const t of PHOTOS) {
  const r = load(t);
  assert.deepStrictEqual(r.exports, [...PHOTOS].sort(), `PHOTOS-SPLIT-EXPORTS ${t}: only the photo group`);
  assert.deepStrictEqual(r.markers, [`photos_entry ${t}`], `PHOTOS-SPLIT-MARKER ${t}: exactly once`);
  assert.ok(r.local.includes('photos/functions.js') && r.local.includes('index.js'), `premise ${t}: index.js routed to photos/functions`);
  for (const forbidden of ['portal/functions.js', 'portal/ops-functions.js', 'whatsapp.js', 'stats/stats-api.js', 'factura/build-record.js', 'order-dedup.js'])
    assert.ok(!r.local.includes(forbidden), `PHOTOS-SPLIT-ISOLATED ${t}: ${forbidden} not loaded`);
  assert.strictEqual(r.sharp, 0, `PHOTOS-SPLIT-NO-SHARP-AT-LOAD ${t}`);
}
ok('photoUploadStart / photoProcess → only the photo group, the marker once, none of the full graph, and NO sharp module loaded');

// ── 1 + 3: everything else never takes the photos branch and never loads sharp ──
const full = load(undefined);
assert.ok(full.exports.length > 100 && PHOTOS.every((k) => full.exports.includes(k)), `PHOTOS-SPLIT-FULL-LOAD re-exports the photo group (${full.exports.length})`);
assert.strictEqual(full.sharp, 0, 'PHOTOS-SPLIT-FULL-LOAD-NO-SHARP');
for (const t of ['', 'photoprocess', 'PhotoProcess', ' photoProcess', 'photoProcess ', 'photoProc', 'photoProcessX', 'createOrder', 'getMyBranches', 'getEditableCatalog', 'toString', '__proto__', 'constructor']) {
  const r = load(t);
  assert.deepStrictEqual(r.markers, [], `PHOTOS-SPLIT-NO-BRANCH ${JSON.stringify(t)}`);
  assert.strictEqual(r.sharp, 0, `PHOTOS-SPLIT-NO-SHARP ${JSON.stringify(t)}`);
}
ok('the full load and every non-photo / malformed target (incl. createOrder): no photos marker, no sharp module loaded');

// ── 3: the ONLY require('sharp') in the photo closure is the lazy one inside processImage ──
const closure = new Set(); const stack = [path.join(FN, 'photos', 'functions.js')];
while (stack.length) {
  const f = stack.pop(); if (closure.has(f)) continue; closure.add(f);
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)) if (m[2].startsWith('.')) stack.push(require.resolve(path.resolve(path.dirname(f), m[2])));
}
const sharpSites = [...closure].flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/require\(\s*['"]sharp['"]\s*\)/g)].map(() => path.relative(FN, f)));
assert.deepStrictEqual(sharpSites, ['photos/pipeline.js'], `PHOTOS-SPLIT-ONE-SHARP-SITE ${JSON.stringify(sharpSites)}`);
const pipe = fs.readFileSync(path.join(FN, 'photos', 'pipeline.js'), 'utf8');
const body = pipe.slice(pipe.indexOf('async function processImage('), pipe.indexOf('\nmodule.exports'));
assert.ok(body.includes("const sharp = require('sharp');"), 'PHOTOS-SPLIT-SHARP-INSIDE-PROCESSIMAGE');
ok(`static: the photo closure (${closure.size} local modules) requires sharp exactly once — inside photos/pipeline.js processImage (lazy)`);

console.log(`photos-split: OK (${n})`);
process.exit(0);
