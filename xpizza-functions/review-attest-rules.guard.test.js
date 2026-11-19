'use strict';
// «Marcar como revisado» (Codex #217 P2-1) — the static pin over the REAL rules file: a client (the dispatcher's orders/$order_id write is the
// only client write on an order) can NEVER create, change or delete the attestation (manual_review_closed) or its episode stamp
// (manual_review_since) — only the server (Admin SDK) writes them. Leaf compares: null === null when absent, so create, edit, delete and a
// whole-order replace are all pinned. Behaviourally (the emulator, every role): test/review-attest-rules.emulator.test.js (slot).
// Run: node review-attest-rules.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const R = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json'), 'utf8')).rules;
const w = R.orders.$order_id['.write'];
const LEAVES = [...['outcome', 'amount_cents', 'note', 'by', 'at', 'episode', 'audited'].map((k) => `manual_review_closed/${k}`), 'manual_review_since'];
for (const leaf of LEAVES) assert.ok(w.includes(`newData.child('${leaf}').val() === data.child('${leaf}').val()`), `🔴 RAR: the dispatcher order write must keep ${leaf}`);
const { RECORD_FIELDS } = require('./payments/review-attest');
assert.deepStrictEqual([...RECORD_FIELDS].sort(), ['amount_cents', 'at', 'audited', 'by', 'episode', 'note', 'outcome'], '🔴 RAR: the closure record gained a field — pin it here and in the rules');
ok(`the dispatcher's order write keeps every attestation leaf and the episode stamp unchanged (${LEAVES.length} leaves)`);
console.log(`review-attest-rules.guard: OK (${n})`);
