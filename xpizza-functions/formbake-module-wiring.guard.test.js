'use strict';
// PLAN 4 (bake from published, r3) — THE MODULE INVERSE, PROVEN: tools/formbake-module-inverse.js turns each module it touches
// back into 486f71aa BYTE-FOR-BYTE, so the older guards that pin those modules (identity-integrity-guards by sha, extras-wiring
// against 537bbbc) can reverse this slice first and keep pinning everything else. An edit inside a hunk, a duplicated hunk
// and a byte outside every hunk are each caught.
// Run: node formbake-module-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyFormbakeModule, FILES, HUNKS } = require('./tools/formbake-module-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const BASE = '486f71aa';
const read = (f) => require('./tools/keymode-module-inverse').unapplyKeyModeModule(f, require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule(f, require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule(f, require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule(f, require('./tools/s1d-module-inverse').unapplyS1dModule(f, require('./tools/s2-module-inverse').unapplyS2Module(f, require('./tools/s2core-module-inverse').unapplyS2coreModule(f, require('./tools/grpid-module-inverse').unapplyGrpidModule(f, require('./tools/s3choice-module-inverse').unapplyS3choiceModule(f, fs.readFileSync(path.join(__dirname, f), 'utf8'))))))))));   // S0 key mode (newest) reversed first
const baseOf = (f) => execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

assert.deepStrictEqual([...FILES].sort(), ['catalog/form-menu-source.js', 'catalog/public-menu.js', 'catalog/source-store.js']);
for (const f of FILES) {
  const DM = require('./tools/directory-module-inverse');   // DRYRUN R-WIRE (2e): S7a directory (newest) first, on the modules it lists
  const aiSrc = require('./tools/avail-identity-inverse').unapplyAvailIdentity(f, require('./tools/photos-module-inverse').unapplyPhotosModule(f, read(f)));   // DRYRUN R-WIRE (2e): photos A2 (newest) innermost, then avail-identity   // DRYRUN R-WIRE (2e): PLAN-avail-identity (newest) innermost
  const src = Object.prototype.hasOwnProperty.call(DM.HUNKS, f) ? DM.unapplyDirectoryModule(f, aiSrc) : aiSrc;
  assert.notStrictEqual(unapplyFormbakeModule(f, src), src, `non-vacuity: ${f} carries the hunks`);
  assert.strictEqual(unapplyFormbakeModule(f, src), baseOf(f), `🔴 ${f} minus the plan-4 hunks is not ${BASE}:${f}`);
}
{
  const f = 'catalog/source-store.js'; const src = read(f);
  const h = HUNKS.find((x) => x.file === f && x.now.includes('badge_priority names'));
  assert.ok(h, 'premise: the badge_priority hunk exists');
  assert.throws(() => unapplyFormbakeModule(f, src.replace(h.now, h.now.replace('badge_priority names', 'badge_priority nameS'))), /occurs 0 times/, 'a byte INSIDE a hunk');
  assert.throws(() => unapplyFormbakeModule(f, src + h.now), /occurs 2 times/, 'a duplicated hunk');
  assert.notStrictEqual(unapplyFormbakeModule(f, src.replace("'use strict';", "'use strict'; ")), baseOf(f), 'a byte OUTSIDE every hunk is detected');
}
ok(`modules: unapplyFormbakeModule → ${BASE} byte-for-byte for ${FILES.join(', ')} (${HUNKS.length} hunks); inside / duplicate / outside each caught`);
console.log(`\nformbake-module-wiring: OK (${n})`);
