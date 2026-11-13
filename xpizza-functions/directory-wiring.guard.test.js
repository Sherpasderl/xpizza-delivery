'use strict';
// S7a directory core — byte guards (BRIEF-5f-capp-directory; PLAN-capp-S7a r1 §1.7 / r2 §1.2):
//   (i)   catalog/public-menu.js and catalog/restaurant-registry.js minus the directory hunks === BASE byte-for-byte
//         (getPublicMenu's code path, defaultIsActive and known/ready/refresh untouched — only ADDITIVE exports);
//   (ii)  the live forms and every non-functions surface are byte-identical to BASE;
//   (iii) index.js is byte-identical to BASE (the getRestaurantDirectory endpoint is wired LATER, with the delivery readers);
//   (iv)  rules: restaurants/{rid}/presentation and platform_config have NO client read/write (server-only).
// Run: node directory-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, unapplyDirectoryModule } = require('./tools/directory-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

for (const m of Object.keys(HUNKS)) {
  const real = require('./tools/keymode-module-inverse').unapplyKeyModeModule(m, require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule(m, require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule(m, require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule(m, require('./tools/s1d-module-inverse').unapplyS1dModule(m, require('./tools/s2-module-inverse').unapplyS2Module(m, require('./tools/s2core-module-inverse').unapplyS2coreModule(m, require('./tools/s2bext-module-inverse').unapplyS2bextModule(m, require('./tools/d4-intake-inverse').unapplyD4Module(m, fs.readFileSync(path.join(__dirname, m), 'utf8'))))))))));   // S0 key mode (newest) reversed first
  const base = git(['show', `${BASE}:xpizza-functions/${m}`]);
  assert.notStrictEqual(real, base, `non-vacuity: ${m} carries the directory hunks`);
  assert.strictEqual(require('./tools/formbake-module-inverse').unapplyFormbakeModule(m, unapplyDirectoryModule(m, require('./tools/avail-identity-inverse').unapplyAvailIdentity(m, require('./tools/photos-module-inverse').unapplyPhotosModule(m, real)))), base,   // DRYRUN R-WIRE (2e): photos A2 (newest) innermost, then avail-identity, then directory, then PLAN 4's module hunks
    `🔴 ${m} minus the directory hunks is not ${BASE}:${m}`);
  assert.throws(() => unapplyDirectoryModule(m, base), /not found exactly once/, `a missing hunk is detected (${m})`);
}
ok(`MODULES: public-menu.js + restaurant-registry.js minus the directory hunks === ${BASE} byte-for-byte (additive only)`);

const changed = git(['diff', '--name-only', BASE, 'cfa03b37', '--', '.'])   /* DRYRUN (2e): bounded at the approved directory tip, as s2tip-wiring is */.split('\n').filter(Boolean);
const outside = git(['diff', '--name-only', BASE, 'cfa03b37', '--', ':(top)', ':(top,exclude)xpizza-functions']).split('\n').filter(Boolean);
assert.deepStrictEqual(outside, [], `🔴 files outside xpizza-functions changed (the forms must be byte-identical): ${outside.join(', ')}`);
assert.ok(!changed.includes('xpizza-functions/index.js') && git(['diff', BASE, 'cfa03b37', '--', 'index.js']) === '', '🔴 index.js changed (the endpoint is wired later)');
ok('FORMS + INDEX: nothing outside xpizza-functions changed; index.js byte-identical (no endpoint yet)');

const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json'), 'utf8')).rules;
const rid = rules.restaurants.$restaurant_id;
assert.ok(!('presentation' in rid) && !('.read' in rid) && !('.write' in rid) && !('$other' in rid) && !('.read' in rules.restaurants) && !('.write' in rules.restaurants),
  'presentation: no rule and no parent grant ⇒ deny-all for clients (Admin only)');
assert.deepStrictEqual(rules.platform_config, { '.read': false, '.write': false }, 'platform_config stays admin-only (promo / constants are Sherpa-only)');
ok('RULES: restaurants/{rid}/presentation has no client grant; platform_config is .read/.write false');
console.log(`\ndirectory-wiring.guard: OK (${n})`);
