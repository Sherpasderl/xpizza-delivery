'use strict';
// S2-srv-tip (Customer App S2, PLAN-capp-S2-r4 §3/§4.1) — the slice's index.js + pinned-module seams. This slice is the NEWEST:
// its inverses are composed INNERMOST (stripped first) into every index.js fold guard (tools/s2tip-inverse.js) and every
// pinned-module fold chain (tools/s2tip-module-inverse.js). This guard proves both inverses reproduce 276ed944 byte-for-byte,
// that the index.js hunks insert NO line (R3 region binds pin index.js lines), and that each hunk is sensitive.
// Run: node s2tip-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, unapplyS2tipIndex, BASE } = require('./tools/s2tip-inverse');
const MI = require('./tools/s2tip-module-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const show = (f) => execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });
const live = require('./tools/s2app-inverse').unapplyS2appIndex(require('./tools/area-inverse').unapplyAreaIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(require('./tools/formbake-inverse').unapplyFormbakeIndex(require('./tools/s4hours-inverse').unapplyS4HoursIndex(require('./tools/pausa-inverse').unapplyPausaIndex(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'))))))))))) /* DRYRUN R-WIRE (2e): 10 cross-side layers innermost */));   // S2-srv-app composes on top of this slice (stripped first)
const baseIdx = show('index.js');

// ── 1. index.js: the exact inverse, same-line hunks only ──
assert.notStrictEqual(live, baseIdx, 'non-vacuity: index.js carries the S2-srv-tip hunks');
assert.strictEqual(unapplyS2tipIndex(live), baseIdx, `🔴 index.js minus the S2-srv-tip hunks is not ${BASE}:index.js — something beyond the stated seams changed`);
assert.strictEqual(live.split('\n').length, baseIdx.split('\n').length, 'the hunks insert NO line (R3 region binds pin index.js lines)');
for (const [now] of HUNKS) assert.ok(/TIP\.|PE\.|tip_cents|payer_email_unconfigured|require\('\.\/tip'\)/.test(now), `every hunk is a tip / payer-email seam: ${now.slice(0, 80)}`);
ok(`unapplyS2tipIndex(index.js) === ${BASE}:index.js byte-for-byte (${HUNKS.length} same-line hunks, no line inserted); every hunk is a tip / payer-email seam`);

const [first] = HUNKS[0];
const last = HUNKS[HUNKS.length - 1][0];
assert.throws(() => unapplyS2tipIndex(live.replace(first, first.replace('TIP', 'TIPX'))), /exactly once/, 'a byte INSIDE a hunk');
assert.throws(() => unapplyS2tipIndex(live + last), /exactly once/, 'a DUPLICATED hunk');
assert.throws(() => unapplyS2tipIndex(live.replace(last, '')), /exactly once/, 'a MISSING hunk');
assert.notStrictEqual(unapplyS2tipIndex(`\n${live}`), baseIdx, 'a byte OUTSIDE every hunk survives the inverse (the base compare catches it)');
ok('index.js sensitivity: a byte inside a hunk, a duplicated hunk and a missing hunk throw; a byte outside is caught');

// ── 2. the pinned modules: the exact module inverse ──
const changed = execFileSync('git', ['diff', '--diff-filter=M', '--name-only', BASE, 'cb7e9bfd', '--', '.'],   // bounded at the approved S2-srv-tip tip: later slices' modules have their own guards
   { cwd: __dirname, encoding: 'utf8' })
  .split('\n').filter(Boolean).map((f) => f.replace(/^xpizza-functions\//, ''))
  .filter((f) => f !== 'index.js' && /\.js$/.test(f) && !/\.test\.js$/.test(f) && !/^tools\//.test(f));
assert.deepStrictEqual([...MI.FILES].sort(), [...changed].sort(), 'the module inverse covers EXACTLY the modules this slice modified (no more, no fewer)');
for (const f of MI.FILES) {
  // colonia (newest) composes on top of charge-inputs.js: its ONE address_area entry stripped first, INNERMOST (entry_mode stays)
  const src = require('./tools/area-charge-inputs-inverse').unapplyAreaChargeInputsModule(f, require('./tools/drvc-inverse').unapplyDrvcModule(f, fs.readFileSync(path.join(__dirname, f), 'utf8')));   // DRYRUN R-WIRE (2e): main's DRIVER C whatsapp.js hunks first
  const base = show(f);
  assert.notStrictEqual(src, base, `non-vacuity: ${f} carries S2-srv-tip hunks`);
  assert.strictEqual(MI.unapplyS2tipModule(f, src), base, `🔴 ${f} minus the S2-srv-tip hunks is not ${BASE}:${f}`);
  const h = MI.HUNKS.find((x) => x.file === f);
  assert.throws(() => MI.unapplyS2tipModule(f, src.replace(h.now, `${h.now}\u0000`).replace(h.now, h.now.replace(/\S/, 'Z'))), /exactly once/, `${f}: a byte INSIDE a hunk`);
  assert.throws(() => MI.unapplyS2tipModule(f, src + h.now), /exactly once/, `${f}: a duplicated hunk`);
  assert.notStrictEqual(MI.unapplyS2tipModule(f, `\n${src}`), base, `${f}: a byte OUTSIDE every hunk is caught`);
}
ok(`module inverse: unapplyS2tipModule → ${BASE} byte-for-byte for ${MI.FILES.length} modules (${MI.HUNKS.length} hunks); inside / duplicate / outside each caught`);

// ── 3. the factura builders stay byte-identical twins ──
assert.strictEqual(fs.readFileSync(path.join(__dirname, 'factura', 'build-record.js'), 'utf8'),
  fs.readFileSync(path.join(__dirname, '..', 'xpizza-factura', 'src', 'build-record.js'), 'utf8'), '🔴 the two factura builders diverged');
ok('both factura builders (xpizza-functions/factura + xpizza-factura/src) are byte-identical, tip exclusion included');

console.log(`\ns2tip-wiring.guard: OK (${n})`);
