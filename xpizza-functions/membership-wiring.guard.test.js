'use strict';
// PLAN-portal-membership (codex build r1 P1-1) — the membership slice's index.js wiring:
//   1. PROOF: tools/membership-inverse.js turns index.js back into e8e77e24:index.js BYTE-FOR-BYTE (the one same-line hunk,
//      exactly once); a byte inside / outside / a duplicated / a missing hunk is each detected.
//   2. NON-VACUITY: the live index.js differs from the base, and the block exports every team endpoint by name from
//      access/team-http.js (whose names are exactly the core's ROUTES).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, unapplyMembershipIndex } = require('./tools/membership-inverse');
// train/next-after-2920b705: membership is stacked on origin/main 2920b705 (e8e77e24 + tracker-fixes + release-race + brand-agnostic
// server + dlite-push, none of which touch this hunk) — the SAME hunk restores 2920b705:index.js byte-for-byte; the guard pins that base.
const BASE = '2920b705';
const { ROUTES } = require('./access/team-http-core');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const real = require('./tools/portalui-inverse').unapplyPortalUiIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')));   // PORTAL-UI 1a landed on top: stripped first
const baseIdx = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 1 << 26 });

assert.strictEqual(HUNKS.length, 1);
assert.strictEqual(unapplyMembershipIndex(real), baseIdx, `🔴 index.js minus the membership hunk is not ${BASE}:index.js`);
const h = HUNKS[0];
assert.throws(() => unapplyMembershipIndex(real.replace(h.now, h.now.replace('MEMBERSHIP_TEAM.memberRevoke', 'MEMBERSHIP_TEAM.memberRevok'))), /occurs 0 times/, 'a byte INSIDE the hunk');
assert.throws(() => unapplyMembershipIndex(real + h.now), /occurs 2 times/, 'a duplicated hunk');
assert.throws(() => unapplyMembershipIndex(real.replace(h.now, '')), /occurs 0 times/, 'a missing hunk');
const outside = real.replace('exports.getEditableCatalog = portalFunctions.getEditableCatalog;', 'exports.getEditableCatalog  = portalFunctions.getEditableCatalog;');
assert.notStrictEqual(unapplyMembershipIndex(outside), baseIdx, 'a byte OUTSIDE the hunk survives and fails the base pin');
assert.strictEqual(real.split('\n').length, baseIdx.split('\n').length, 'a SAME-LINE hunk: no index.js line moves (no R3 region bind shifts)');
ok(`PROOF: unapplyMembershipIndex(index.js) === ${BASE}:index.js byte-for-byte; inside / outside / duplicated / missing detected; line count unchanged`);

assert.notStrictEqual(real, baseIdx, 'the live index.js carries the membership block');
const names = Object.keys(ROUTES).sort();
assert.strictEqual(names.length, 11);   // + memberUpdate, catalogRequestPublish (PLAN-portal-team-invites T-a)
for (const nm of names) assert.ok(h.now.includes(`exports.${nm} = MEMBERSHIP_TEAM.${nm};`), `index.js exports ${nm}`);
assert.ok(h.now.includes("const MEMBERSHIP_TEAM = require('./access/team-http');"));
assert.deepStrictEqual(Object.keys(require('./access/team-http')).sort(), names, 'team-http.js builds exactly the core ROUTES');
ok(`NON-VACUITY: the block exports all ${names.length} team endpoints (${names.join(', ')}) from access/team-http.js`);

console.log(`membership-wiring.guard: OK (${n})`);
