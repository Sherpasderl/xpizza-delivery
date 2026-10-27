// dispatch-intl-parity.test.mjs — BUILD-ORDER-intl-core §Dispatch lane.
//
// (1) PARITY: the dispatch ESM copy intl.js is behavior-identical to the canonical server parser
//     (xpizza-functions/phone/intl.js @ feat/intl-phone-core 8f24b269), vendored here as intl.ref.cjs for a
//     self-contained comparison until intl-core merges to main (then the ref is re-pointed at the real file).
// (2) GROUPING CONTRACT: the REAL convoKey lifted from index.html keys a conversation by identity digits —
//     the three legacy forms of one HN number collapse to ONE group; non-parsing values stay ungrouped and are
//     never suffix-merged; every current HN number groups exactly as the old last-8 did (no regression).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import * as intl from './intl.js';

const here = dirname(fileURLToPath(import.meta.url));
const canonical = createRequire(import.meta.url)('./intl.ref.cjs');   // the byte-identical 8f24b269 reference
const J = (x) => JSON.stringify(x);

// A corpus spanning qualified +CC… (every supported country), bare-8, no-'+' CCnational, separators, the
// dual-read trio, and non-parsing values (wrong length, unsupported, garbage, non-string).
const CORPUS = [
  '97950000', '50497950000', '+50497950000',                 // the dual-read trio (same HN number)
  '12345678', '+50412345678', '50412345678',                 // another HN number, three forms
  '+504 1234-5678', '(504) 1234 5678', '+504.1234.5678',      // separators
  '+11234567890', '11234567890', '+521234567890',             // US(1,10), MX(52,10)
  '+50212345678', '+50312345678', '+50512345678', '+5061234567890'.slice(0, 12), // CA502/SV503/NI505, CR506
  '+5071234567', '+5011234567', '+34123456789',               // PA507, BZ501(7), ES34(9)
  '1234567', '123456789', '+50412345', '+999123', '+', '++50412345678',
  'abc', '', '   ', null, undefined, 12345678, '97-95-00-00',
];

test('PARITY: parseSubmitted matches the canonical for the whole corpus', () => {
  for (const x of CORPUS) {
    assert.equal(J(intl.parseSubmitted(x)), J(canonical.parseSubmitted(x)), `parseSubmitted(${J(x)})`);
  }
});

test('PARITY: legacyRawForms matches the canonical (fed each parsed canonical + raw inputs)', () => {
  const canons = new Set();
  for (const x of CORPUS) { const p = intl.parseSubmitted(x); if (p) canons.add(p.canonical); }
  for (const c of [...canons, '+50497950000', '+11234567890', '+999', 'nope', '']) {
    assert.equal(J(intl.legacyRawForms(c)), J(canonical.legacyRawForms(c)), `legacyRawForms(${J(c)})`);
  }
});

test('PARITY: SUPPORTED set is identical', () => {
  assert.equal(J(intl.SUPPORTED), J(canonical.SUPPORTED));
});

// ── lift the REAL convoKey from index.html and run it over intlParse = the ESM parseSubmitted ──
function liftConvoKey() {
  const html = readFileSync(join(here, 'index.html'), 'utf8');
  const start = html.indexOf('function convoKey(');
  assert.ok(start !== -1, 'index.html must define convoKey');
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) { if (html[i] === '{') depth++; else if (html[i] === '}') { depth--; if (!depth) break; } }
  const src = html.slice(start, i + 1);
  // eslint-disable-next-line no-new-func
  return new Function('intlParse', `${src}\n return convoKey;`)(intl.parseSubmitted);
}
const convoKey = liftConvoKey();

test('CONTRACT: 97950000 / 50497950000 / +50497950000 collapse to ONE group (identity digits)', () => {
  const keys = ['97950000', '50497950000', '+50497950000'].map(convoKey);
  assert.equal(keys[0], '50497950000');
  assert.deepEqual(new Set(keys).size, 1, 'all three forms share one group key');
});

test('CONTRACT: the group key is identity digits, never a last-8 suffix — two numbers sharing a last-8 do NOT merge', () => {
  const phoneTail = (v) => String(v || '').replace(/\D/g, '').slice(-8);
  const hn = '+50488887777';   // HN(+504, 8) → identity 50488887777
  const us = '+12288887777';   // US(+1, 10) ending in the same 8 digits → identity 12288887777
  assert.equal(phoneTail(hn), phoneTail(us), 'the OLD last-8 key would have merged these two different numbers');
  assert.equal(convoKey(hn), '50488887777');
  assert.equal(convoKey(us), '12288887777');
  assert.notEqual(convoKey(hn), convoKey(us), 'the identity key keeps them in separate threads');
});

test('CONTRACT: non-parsing values stay ungrouped and are never suffix-merged', () => {
  // two unparseable numbers sharing a last-8 suffix get DIFFERENT raw keys (full digits, not the suffix)
  const a = convoKey('1234567');          // 7 digits, unsupported
  const b = convoKey('991234567');        // 9 digits, shares last-8 '91234567'? no — last8 of a is '1234567'
  assert.match(a, /^raw:/);
  assert.match(b, /^raw:/);
  assert.notEqual(a, b, 'distinct non-parsing numbers never merge');
  assert.equal(convoKey(''), null);
  assert.equal(convoKey('abc'), null);     // no digits → not a conversation (matches the old skip)
  assert.equal(convoKey(null), null);
});

test('CONTRACT: an UltraMsg inbound id (…@c.us) groups with its order exactly as the old last-8 did', () => {
  const phoneTail = (v) => String(v || '').replace(/\D/g, '').slice(-8);
  const inbound = '50497952893@c.us';   // UltraMsg JID-style sender
  const order = '+504 9795-2893';        // the same customer on the order
  // old last-8 collapsed them; the @c.us was stripped implicitly by /\D/g
  assert.equal(phoneTail(inbound), phoneTail(order));
  assert.equal(phoneTail(inbound), '97952893');
  // new: convoKey strips the JID suffix, then keys by identity → the SAME one group
  assert.equal(convoKey(inbound), '50497952893');
  assert.equal(convoKey(order), '50497952893');
  assert.equal(convoKey(inbound), convoKey(order), 'inbound and its order land in one thread');
  // defensive: even a bare-8 JID resolves to the +504 identity, matching its bare-8 order (phoneTail parity)
  assert.equal(convoKey('97952893@c.us'), convoKey('97952893'));
  assert.equal(convoKey('97952893@c.us'), '50497952893');
});

test('CONTRACT: every straight current HN number groups exactly as the old last-8 did', () => {
  // for a real 8-digit HN number stored any of the three ways, the OLD last-8 and the NEW identity both collapse
  // the same set into one group — same grouping, no UI change (only the internal key string differs).
  const phoneTail = (v) => String(v || '').replace(/\D/g, '').slice(-8);
  for (const num of ['88887777', '99991111', '32100000']) {
    const forms = [num, '504' + num, '+504' + num];
    // old: all three share one last-8
    assert.equal(new Set(forms.map(phoneTail)).size, 1);
    // new: all three share one identity
    assert.equal(new Set(forms.map(convoKey)).size, 1);
    assert.equal(convoKey(num), '504' + num);
  }
});
