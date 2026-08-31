'use strict';
const assert = require('assert');
const { retryCandidate, reprintDecision, printedAckFailed } = require('./print-recovery');
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
// REGRESSION (codex): a printed_ack_failed record has printed:false but ALREADY printed ON PAPER — reprintDecision
// must REFUSE it (its own gate), NOT fall through to 'reprint', else the manual tool duplicates the número (the
// automatic agent path is skip-guarded; this closes the manual bypass).
assert.deepEqual(reprintDecision({ printed: false, print_error: 'printed_ack_failed: EPIPE' }), { action: 'refuse', reason: 'printed_ack_failed' }); ok('printed_ack_failed (printed:false) → refuse (no duplicate physical print)');
assert.deepEqual(reprintDecision({ void: true, print_error: 'printed_ack_failed: X' }),   { action: 'refuse', reason: 'void' });            ok('void wins over printed_ack_failed');
assert.deepEqual(reprintDecision({ printed: true, print_error: 'printed_ack_failed: X' }), { action: 'refuse', reason: 'already_printed' }); ok('printed:true wins → already_printed');
console.log('print-recovery(reprintDecision): OK');

// --- printedAckFailed (Fix A marker → skip-guard) ---
assert.equal(printedAckFailed({ print_error: 'printed_ack_failed: EPIPE' }), true); ok('marker → true');
assert.equal(printedAckFailed({ print_error: 'printer not found' }), false);        ok('other error → false');
assert.equal(printedAckFailed({ printed: false }), false);                          ok('no error → false');
assert.equal(printedAckFailed(null), false);                                        ok('null → false');
console.log('print-recovery(printedAckFailed): OK');
