'use strict';
/**
 * PLATFORM F2 Q0 (PLAN-F2-query-rules §0) — offline guard: a DEVICE token (auth.token.handheld === true) passes NO grant meant for
 * a human. Wired into `npm test` AND `npm run check:rules`. Run: node device-exclusion.guard.test.js
 *
 * Contract, per ALTERNATIVE (codex F2q r2): every `.read` / `.write` leaf is split into its top-level `||` alternatives (parenthesis-
 * and quote-aware; a fully parenthesised alternative is unwrapped and split again). Each alternative must be exactly one of:
 *   (i)   HUMAN  — its top-level `&&` chain contains the term `auth.token.handheld !== true`;
 *   (ii)  PUBLIC — the leaf is on the pinned PUBLIC list (exact path, value exactly `true`);
 *   (iii) DEVICE — the exact (path, alternative) is on the pinned DEVICE list and its chain begins `auth.token.handheld === true`
 *                  (empty until Q6 compiles the device query clause in).
 * `false` grants nothing. Anything else fails — finding the exclusion "somewhere" in a compound expression is not enough.
 * A TERNARY (`?:` outside quotes) is REJECTED outright (codex Q0 r1 P2-1): `x && EXCL && c ? a : b` parses as `(x && EXCL && c) ? a : b`,
 * so the exclusion would only guard the condition. Grants must be written without `?:`.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const EXCL = 'auth.token.handheld !== true';
const PUBLIC = Object.freeze([
  '/config/rewards_public/redemption_live/.read',
  '/public/brands/.read',
  '/order_tracking/$token/.read',
  '/restaurants/$restaurant_id/item_availability/.read',
  '/menus/.read',
  '/menus/_meta/.read',
]);
const DEVICE = Object.freeze([]);   // Q6: [{ leaf, alternative }] — exact strings, reviewed with the N-full artifact

// split `expr` at depth-0 occurrences of `op` ('||' or '&&'), outside quotes
function splitTop(expr, op) {
  const out = []; let depth = 0; let q = null; let cur = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (q) { cur += c; if (c === '\\') { cur += expr[++i] || ''; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (depth < 0) throw new Error(`unbalanced ) in ${expr}`);
    if (depth === 0 && expr.startsWith(op, i)) { out.push(cur.trim()); cur = ''; i += op.length - 1; continue; }
    cur += c;
  }
  if (depth !== 0 || q) throw new Error(`unbalanced expression: ${expr}`);
  out.push(cur.trim());
  return out;
}
// strip ONE pair of parentheses that wraps the whole string
function unwrap(s) {
  if (!(s.startsWith('(') && s.endsWith(')'))) return s;
  let depth = 0; let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '(') depth += 1;
    if (c === ')') { depth -= 1; if (depth === 0 && i < s.length - 1) return s; }
  }
  return s.slice(1, -1).trim();
}
// the alternatives of an expression, each as its list of top-level conjuncts
function alternatives(expr) {
  const out = [];
  for (const part of splitTop(expr, '||')) {
    let alt = part; let u = unwrap(alt);
    while (u !== alt) { alt = u; u = unwrap(alt); }
    // a fully parenthesised part that is itself a disjunction contributes each of ITS alternatives
    if (alt !== part && splitTop(alt, '||').length > 1) { out.push(...alternatives(alt)); continue; }
    out.push({ text: alt, conj: splitTop(alt, '&&').map((c) => c.trim()) });
  }
  return out;
}
function leavesOf(rules) {
  const out = [];
  (function walk(n, p) {
    for (const [k, v] of Object.entries(n)) {
      if (k === '.read' || k === '.write') out.push({ leaf: `${p || ''}/${k}`, value: v });
      else if (v && typeof v === 'object' && !k.startsWith('.')) walk(v, `${p}/${k}`);
    }
  })(rules, '');
  return out;
}
// a `?` outside quotes (RTDB's only use of `?` is the ternary operator)
function hasTernary(expr) {
  let q = null;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '?') return true;
  }
  return false;
}
// every violation of the contract (empty = compliant)
function violations(rules, device = DEVICE) {
  const bad = [];
  for (const { leaf, value } of leavesOf(rules)) {
    if (value === false) continue;
    if (PUBLIC.includes(leaf)) { if (value !== true) bad.push(`${leaf}: a PUBLIC leaf must be exactly true`); continue; }
    if (typeof value !== 'string') { bad.push(`${leaf}: non-string grant ${JSON.stringify(value)} (public leaves must be pinned)`); continue; }
    if (hasTernary(value)) { bad.push(`${leaf}: a ternary ?: is not allowed in a grant (the exclusion would only guard its condition)`); continue; }
    for (const a of alternatives(value)) {
      if (a.conj.includes(EXCL)) continue;
      const dev = device.find((d) => d.leaf === leaf && d.alternative === a.text);
      if (dev && a.conj[0] === 'auth.token.handheld === true') continue;
      bad.push(`${leaf}: alternative lacks the device exclusion — ${a.text.slice(0, 140)}`);
    }
  }
  return bad;
}

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── the splitter itself (a guard is only as good as its parser) ──
assert.deepStrictEqual(alternatives("a && b").map((x) => x.conj), [['a', 'b']]);
assert.deepStrictEqual(alternatives("a && (b || c)").map((x) => x.conj), [['a', '(b || c)']]);
assert.deepStrictEqual(alternatives("a && b || c").map((x) => x.conj), [['a', 'b'], ['c']], 'precedence: a top-level || is a separate alternative');
assert.deepStrictEqual(alternatives("(a || (b && c))").map((x) => x.conj), [['a'], ['b', 'c']], 'a wrapped disjunction is unwrapped and split');
assert.deepStrictEqual(alternatives("x === '||' && y").map((x) => x.conj), [["x === '||'", 'y']], 'operators inside quotes are not split');
assert.deepStrictEqual(alternatives("(a) && (b)").map((x) => x.conj), [['(a)', '(b)']], 'a non-wrapping pair is kept');
ok('parser: top-level ||/&& split with precedence, quotes and parentheses respected; wrapped disjunctions unwrapped');

// ── synthetic contract cells ──
const R = (o) => ({ x: o });
assert.deepStrictEqual(violations(R({ '.read': `auth != null && ${EXCL} && root.child('d').child(auth.uid).exists()` })), []);
assert.strictEqual(violations(R({ '.read': "auth != null && root.child('d').child(auth.uid).exists()" })).length, 1, 'a human grant without the exclusion fails');
assert.strictEqual(violations(R({ '.read': `auth != null && ${EXCL} && a || b` })).length, 1, 'an unguarded top-level alternative fails even though the exclusion appears elsewhere');
assert.strictEqual(violations(R({ '.read': `auth != null && (${EXCL} || a)` })).length, 1, 'the exclusion nested inside a disjunction does not guard the alternative');
assert.strictEqual(violations(R({ '.read': true })).length, 1, 'an unpinned true grant fails');
assert.deepStrictEqual(violations(R({ '.read': false, '.write': false })), []);
assert.strictEqual(violations(R({ '.read': 'auth.token.handheld === true && query.orderByChild === \'restaurant_id\'' })).length, 1, 'a device alternative must be pinned');
assert.strictEqual(violations(R({ '.read': `auth != null && ${EXCL} && false ? false : true` })).length, 1, 'codex Q0 r1: a device-permitting ternary is rejected');
assert.strictEqual(violations(R({ '.read': `auth != null && ${EXCL} && x === 'a?b'` })).length, 0, 'a ? inside quotes is not a ternary');
ok('contract: unguarded human alternative / top-level || escape / nested exclusion / unpinned true / unpinned device alternative / a ternary each fail');

// ── the real rules ──
const CANON = path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json');
const rules = JSON.parse(fs.readFileSync(CANON, 'utf8')).rules;
const v = violations(rules);
assert.deepStrictEqual(v, [], `🔴 device-exclusion contract violated:\n  ${v.join('\n  ')}`);
for (const p of PUBLIC) {
  const segs = p.split('/').filter(Boolean); const k = segs.pop();
  let node = rules; for (const s of segs) node = node && node[s];
  assert.ok(node && node[k] === true, `pinned PUBLIC leaf ${p} must exist and be true (a stale allowlist entry fails)`);
}
const grants = leavesOf(rules).filter((l) => l.value !== false);
ok(`xpizza-reference rules: all ${grants.length} grant leaves comply (${PUBLIC.length} pinned public, ${DEVICE.length} device, the rest carry ${EXCL} on every alternative)`);

// ── non-vacuity: the pre-Q0 base FAILS the contract on exactly its unguarded human grants ──
const BASE = 'b98cd04d';
let base = null;
try { base = JSON.parse(execFileSync('git', ['show', `${BASE}:xpizza-reference/database.rules.json`], { cwd: __dirname, encoding: 'utf8' })).rules; } catch (_) { /* shallow clone */ }
if (base) {
  const bv = violations(base);
  assert.strictEqual(bv.length, 69, `non-vacuity: the pre-Q0 base ${BASE} has 69 unguarded grant alternatives (got ${bv.length})`);
  ok(`non-vacuity: the pre-Q0 base ${BASE} fails with ${bv.length} unguarded alternatives`);
} else console.log(`  · base ${BASE} unavailable (shallow clone) — non-vacuity cell skipped`);

console.log(`device-exclusion.guard: OK (${n})`);
module.exports = { alternatives, violations, hasTernary, EXCL, PUBLIC };
