'use strict';
// Phase 1d Stage 2b REVISE — production must actually WIRE the ladder. Run: node prod-ladder-wiring.test.js
//
// The point of an inert 2b is that production RECORDS during it, so 2c's flip lands on a warm ladder
// rather than a cold one. A ladder that exists but is never injected gives none of that — and "silently
// not wired" is the exact class of bug that already hit the recorders once in this phase (a name
// collision made both recorder calls throw into a swallowing catch, so nothing was ever recorded and
// every test still passed). Source-level, because index.js cannot be imported without Firebase init.
const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const SRC = readFileSync(join(__dirname, 'index.js'), 'utf8');
const resolverBlock = SRC.slice(SRC.indexOf('_pricingResolver = createPricingResolver({'), SRC.indexOf('return _pricingResolver'));

assert.ok(/require\('\.\/catalog\/snapshot-fallback'\)/.test(SRC), 'index.js must import the ladder');
assert.ok(/ladder:\s*snapshotLadder\(\)/.test(resolverBlock), 'the prod resolver MUST be constructed with a ladder — otherwise lastGood never warms in production');
ok('prod wires a ladder into createPricingResolver (so lastGood warms during 2b)');

const ladderBlock = SRC.slice(SRC.indexOf('function snapshotLadder()'), SRC.indexOf('let _pricingResolver'));
assert.ok(/makeRtdbMirrorReader\(getDatabase\(\)\)/.test(ladderBlock), 'the mirror reader must be wired now, so 2c does not have to add it under money-grill pressure');
assert.ok(/paymentAlert\(getDatabase\(\)/.test(ladderBlock), 'the ladder must be able to alarm');
ok('the ladder is built with a real RTDB mirror reader and an alarm sink');

// It must be a SINGLETON: rung 1 IS per-instance memory, so rebuilding it per request would mean the
// ladder is permanently cold no matter how many orders an instance serves.
assert.ok(/let _snapshotLadder = null;/.test(SRC) && /if \(!_snapshotLadder\)/.test(ladderBlock),
  'the ladder must be a module-level singleton — its in-memory state IS rung 1');
ok('the ladder is a module-level singleton (its per-instance memory is rung 1)');

// STILL INERT: index.js must not call snapshotFor anywhere in 2b. The flip is 2c.
assert.ok(!/\bsnapshotFor\s*\(/.test(SRC), 'index.js must NOT call snapshotFor in 2b — the failure path still returns the code tables');
ok('still INERT: index.js never calls snapshotFor (that wiring is Stage 2c)');
console.log(`prod-ladder-wiring: OK (${n})`);
