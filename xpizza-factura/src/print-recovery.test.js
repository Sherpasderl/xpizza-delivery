'use strict';
const assert = require('assert');
const { retryCandidate, reprintDecision } = require('./print-recovery');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// --- retryCandidate ---
assert.equal(retryCandidate({ printed: false }), true);  ok('printed:false → candidate');
assert.equal(retryCandidate({}), true);                  ok('no printed field → candidate');
assert.equal(retryCandidate({ printed: true }), false);  ok('printed:true → no');
assert.equal(retryCandidate({ void: true }), false);     ok('void → no');
assert.equal(retryCandidate({ printed: false, void: true }), false); ok('void wins over unprinted');
assert.equal(retryCandidate(null), false);               ok('null → no');
console.log(`print-recovery(retryCandidate): OK (${n} cases)`);

// --- reprintDecision ---
assert.deepEqual(reprintDecision({ printed: false, factura_number: 'X' }), { action: 'reprint' }); ok('stranded → reprint');
assert.deepEqual(reprintDecision({}), { action: 'reprint' });                    ok('absent-flags → reprint');
assert.deepEqual(reprintDecision({ printed: true }), { action: 'refuse', reason: 'already_printed' }); ok('printed → refuse (fiscal copy)');
assert.deepEqual(reprintDecision({ void: true }),   { action: 'refuse', reason: 'void' });            ok('void → refuse');
assert.deepEqual(reprintDecision(null),             { action: 'refuse', reason: 'not_found' });        ok('missing → refuse');
console.log('print-recovery(reprintDecision): OK');
