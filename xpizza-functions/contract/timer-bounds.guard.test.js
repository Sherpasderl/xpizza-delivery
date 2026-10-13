'use strict';
// R3 P1 §12 C1 — THE TIMER-BOUNDS GUARD (static; npm test chain). Every page timer on an asserted page whose delay exceeds
// that page's step horizon (or cannot be resolved) has a reviewed entry showing it does not reach an asserted output; the
// enforced journey settles with exactly the declared horizon. Run: node contract/timer-bounds.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('./timer-bounds');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-TIMER-BOUNDS ${m}`;
const doc = JSON.parse(fs.readFileSync(T.FILE, 'utf8'));
const r = T.check(doc);
assert.deepStrictEqual(r.problems, [], FAIL(r.problems.join('\n  ')));
ok(`${r.inventory.length} timer sites on the asserted pages (${Object.entries(doc.pages).map(([p, v]) => `${p} horizon ${v.horizonMs} ms`).join(', ')}); ${r.need.length} long / unresolved, each reviewed as not reaching an asserted output`);
const j = fs.readFileSync(path.join(__dirname, 'p1a-journey.emulator.test.mjs'), 'utf8');
assert.ok(/settle\(HORIZON\.form\)/.test(j) && /settle\(HORIZON\.kds\)/.test(j) && !/\.settle\(\)/.test(j), FAIL('the journey does not settle with the declared per-page horizons'));
ok('the enforced journey settles every step with the declared per-page horizon (no default settle())');
const clone = () => JSON.parse(JSON.stringify(doc));
const has = (d, re) => T.check(d).problems.some((p) => re.test(p));
{ const d = clone(); d.sites.shift(); assert.ok(has(d, /no reviewed entry/), FAIL('a long timer without an entry passed')); }
{ const d = clone(); d.pages['xpizza-orders'].horizonMs = 1000; assert.ok(has(d, /no reviewed entry/), FAIL('a shorter horizon exposed no new long timer')); }
{ const d = clone(); d.sites[0].sha = T.sha('x'); assert.ok(has(d, /call text changed/), FAIL('a changed timer call passed')); }
{ const d = clone(); d.sites[5].reachesAsserted = true; assert.ok(has(d, /RED \(no declaration clears it\)/), FAIL('a long timer reaching an asserted output passed')); }
{ const d = clone(); d.sites.push({ ...d.sites[0], key: 'xpizza-orders/gone.js#f:setTimeout#0' }); assert.ok(has(d, /stale entry/), FAIL('a stale entry passed')); }
ok('negatives: a long timer with no entry (or a shorter horizon exposing one), a changed call, a long timer reaching an asserted output, a stale entry → RED');
console.log(`\nr3-timer-bounds guard: OK (${n})`);
