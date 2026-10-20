'use strict';
// PLATFORM F2 Q1 (PLAN-F2-query-rules §1.5–1.7) — the narrow-rules transform's CONTRACT. Run: node tools/f2-narrow-rules.test.js
// Pure + deterministic; changes ONLY the allowlisted leaves; refuses a drifted source expression; every other leaf byte-equal;
// variants N-human / N-full; R-pre = the input; R-post = an alias of N-human; every artifact passes the device-exclusion guard
// (N-full with exactly its pinned device alternative).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const N = require('./f2-narrow-rules');
const { violations } = require('../device-exclusion.guard.test.js');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const BASE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8'));
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const leaves = (rules) => { const out = new Map(); (function w(x, p) { for (const [k, v] of Object.entries(x)) { if (k.startsWith('.')) out.set(`${p}/${k}`, JSON.stringify(v)); else if (v && typeof v === 'object') w(v, `${p}/${k}`); } })(rules, ''); return out; };

// ── purity + determinism ──
const frozen = deepFreeze(JSON.parse(JSON.stringify(BASE)));
const a = N.narrow(frozen, 'N-human'); const b = N.narrow(frozen, 'N-human');
assert.strictEqual(JSON.stringify(a), JSON.stringify(b), 'deterministic');
assert.strictEqual(JSON.stringify(frozen), JSON.stringify(BASE), 'the input is unmodified');
ok('pure (a deep-frozen input works and is unchanged) and deterministic');

// ── only the allowlisted leaves change ──
for (const variant of ['N-human', 'N-full']) {
  const out = N.narrow(BASE, variant);
  const L0 = leaves(BASE.rules); const L1 = leaves(out.rules);
  const changed = [...new Set([...L0.keys(), ...L1.keys()])].filter((k) => L0.get(k) !== L1.get(k)).sort();
  assert.deepStrictEqual(changed, [...N.CHANGED_LEAVES(variant)].sort(), `${variant}: exactly the allowlisted leaves change`);
}
ok(`only the allowlisted leaves change (N-human ${N.CHANGED_LEAVES('N-human').length}, N-full ${N.CHANGED_LEAVES('N-full').length}); every other leaf (validators, indexes, payment protection, driver writes, Q0 exclusions) byte-equal`);

// ── source drift is refused ──
const drift = JSON.parse(JSON.stringify(BASE)); drift.rules.orders['.read'] += ' && true';
assert.throws(() => N.narrow(drift, 'N-human'), /source drift at \/orders\/\.read/);
const pre = JSON.parse(JSON.stringify(BASE)); pre.rules.orders.$order_id['.read'] = 'auth != null';
assert.throws(() => N.narrow(pre, 'N-human'), /source drift at \/orders\/\$order_id\/\.read/, 'a leaf expected ABSENT that exists is drift too');
assert.throws(() => N.narrow(BASE, 'N-bogus'), /unknown variant/);
ok('a drifted source expression (changed, or present where ABSENT was pinned) is REFUSED; an unknown variant is refused');

// ── variants ──
const H = N.narrow(BASE, 'N-human'); const F = N.narrow(BASE, 'N-full');
assert.ok(!JSON.stringify(H).includes("child('managers')") && JSON.stringify(F).includes("child('managers')"), 'managers only in N-full');
assert.ok(!JSON.stringify(H).includes('auth.token.handheld === true') && JSON.stringify(F).includes('auth.token.handheld === true'), 'the device clause only in N-full');
assert.strictEqual(JSON.stringify(N.narrow(BASE, 'R-post')), JSON.stringify(H), 'R-post is an alias of N-human');
assert.strictEqual(JSON.stringify(N.narrow(BASE, 'R-pre')), JSON.stringify(BASE), 'R-pre is the input (base + Q0 + indexes)');
// premise: the Q1 indexes are in the base — plus TRACKER FIXES' three terminal-timestamp indexes (tracker-reconcile discovery, codex r2 P2-1)
assert.deepStrictEqual(BASE.rules.orders['.indexOn'], ['status', 'created_at', 'order_type', 'restaurant_id', 'delivered_by_driver_uid', 'delivered_by_uid', 'delivered_at', 'cancelled_at', 'completed_at'], 'premise: Q1 indexes (+ the tracker terminal-timestamp indexes) are in the base');
ok('variants: managers + device clause only in N-full; R-post === N-human; R-pre === base (+Q0 +indexes)');

// ── every artifact satisfies the device-exclusion contract (N-full with exactly its pinned device alternative) ──
assert.deepStrictEqual(violations(H.rules), [], 'N-human passes the guard with no device alternative');
assert.deepStrictEqual(violations(F.rules, N.DEVICE_ALTERNATIVES), [], 'N-full passes with its pinned device alternative');
assert.ok(violations(F.rules).length > 0, 'non-vacuity: N-full WITHOUT the pinned device list fails (the device clause is a real alternative)');
for (const [k, v] of leaves(F.rules)) if (k.endsWith('/.read') || k.endsWith('/.write')) assert.ok(!/\?/.test(String(v).replace(/'[^']*'/g, '')), `no ternary in ${k}`);
ok('N-human and N-full both satisfy the Q0 per-alternative device contract; N-full only with its pinned device alternative; no ternaries');

// ── the committed artifacts match the transform ──
for (const [variant, file] of [['N-human', 'N-human.rules.json'], ['N-full', 'N-full.rules.json']]) {
  const p = path.join(__dirname, '..', '..', 'xpizza-reference', 'f2-narrow', file);
  assert.ok(fs.existsSync(p), `committed artifact ${file} exists`);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), N.serialize(N.narrow(BASE, variant)), `${file} equals narrow(base, '${variant}') — regenerate with: node tools/f2-narrow-rules.js --write`);
}
ok('the committed artifacts xpizza-reference/f2-narrow/{N-human,N-full}.rules.json equal the transform of the current base');

console.log(`f2-narrow-rules: OK (${n})`);
