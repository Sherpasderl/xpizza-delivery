// GUARD: xpizza-driver/stack-validity.js is a BYTE-PINNED COPY of the server's stack-copy validity rule
// (xpizza-functions/sequencing/validity.js). The driver app, server, tracker-derive and detector must decide stack
// coherence identically (provenance: stack_uid === assigned_driver_id, assigned_at <= stack_at). If the server's
// rule changes, this guard goes RED — re-pin the copy (and re-gate at HIGH, it's money-adjacent routing). Pattern
// mirrors tracking/driver-orders.guard (COPY markers).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const clientSrc = readFileSync(new URL('./stack-validity.js', here), 'utf8');
const serverSrc = readFileSync(new URL('../xpizza-functions/sequencing/validity.js', here), 'utf8');

// The client's pinned block (between the COPY markers).
const m = clientSrc.match(/\/\/ ── BEGIN COPY: validity[^\n]*\n([\s\S]*?)\n\/\/ ── END COPY: validity ──/);
assert.ok(m, 'stack-validity.js: COPY markers not found');
const clientBlock = m[1].trim();

// The server's rule text = from `const fin` through the end of validPair's body (drop 'use strict', the header
// comment and module.exports — only the executable rule is pinned).
const sMatch = serverSrc.match(/const fin = [\s\S]*?\nfunction validPair\([\s\S]*?\n\}/);
assert.ok(sMatch, 'validity.js: could not extract the validCopy/validPair rule');
const serverBlock = sMatch[0].trim();

assert.equal(clientBlock, serverBlock,
  '🔴 stack-validity.js drifted from xpizza-functions/sequencing/validity.js — re-pin the client copy (HIGH gate):\n' +
  `--- server ---\n${serverBlock}\n--- client ---\n${clientBlock}`);

// And the copy actually behaves: a valid pair, and the provenance rejections.
const { validCopy, validPair } = await import('./stack-validity.js');
const base = { stack_id: 'S', stack_uid: 'd', assigned_driver_id: 'd', stack_at: 10, assigned_at: 5 };
assert.ok(validPair({ ...base, stop_seq: 1 }, { ...base, stop_seq: 2 }), 'a well-formed same-driver pair is valid');
assert.ok(!validCopy({ ...base, stop_seq: 1, stack_uid: 'other' }), 'stack_uid != assigned_driver → invalid (reassigned away)');
assert.ok(!validCopy({ ...base, stop_seq: 1, assigned_at: 20 }), 'assigned_at > stack_at → invalid (reassigned after the stack)');
assert.ok(!validPair({ ...base, stop_seq: 1 }, { ...base, stop_seq: 1 }), 'same rank → not a pair');

console.log('stack-validity.guard: OK (copy == server validity.js; provenance rejections hold)');
