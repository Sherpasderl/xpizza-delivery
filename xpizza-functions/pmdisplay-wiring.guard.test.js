'use strict';
// PLAN-public-menu-display r2 — THE MODULE INVERSE, PROVEN: tools/pmdisplay-module-inverse.js turns each module it touches
// back into acf32fc8 BYTE-FOR-BYTE, so the older guards that pin those modules (identity-integrity-guards by sha, extras-wiring
// against 537bbbc) can reverse this slice first and keep pinning everything else. An edit inside a hunk, a duplicated hunk
// and a byte outside every hunk are each caught.
// Run: node pmdisplay-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyPmdisplayModule, FILES, HUNKS } = require('./tools/pmdisplay-module-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const BASE = 'acf32fc8';
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const baseOf = (f) => execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

assert.deepStrictEqual([...FILES].sort(), ['catalog/source-store.js']);
for (const f of FILES) {
  const src = read(f);
  assert.notStrictEqual(unapplyPmdisplayModule(f, src), src, `non-vacuity: ${f} carries the hunks`);
  assert.strictEqual(unapplyPmdisplayModule(f, src), baseOf(f), `🔴 ${f} minus the public-menu-display hunks is not ${BASE}:${f}`);
}
{
  const f = 'catalog/source-store.js'; const src = read(f);
  const h = HUNKS.find((x) => x.file === f);
  assert.throws(() => unapplyPmdisplayModule(f, src.replace(h.now, h.now.replace('all-or-nothing (', 'all-or-nothinG ('))), /occurs 0 times/, 'a byte INSIDE a hunk');
  assert.throws(() => unapplyPmdisplayModule(f, src + h.now), /occurs 2 times/, 'a duplicated hunk');
  assert.notStrictEqual(unapplyPmdisplayModule(f, src.replace("'use strict';", "'use strict'; ")), baseOf(f), 'a byte OUTSIDE every hunk is detected');
}
ok(`modules: unapplyPmdisplayModule → ${BASE} byte-for-byte for ${FILES.join(', ')} (${HUNKS.length} hunk${HUNKS.length === 1 ? '' : 's'}); inside / duplicate / outside each caught`);
console.log(`\npmdisplay-wiring: OK (${n})`);
