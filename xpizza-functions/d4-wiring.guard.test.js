'use strict';
// D4 — the in-app card payment server (PLAN-sdk-d4-r11 §A7) — the wiring guard for tools/d4-intake-inverse.js: the inverse returns
// each owned file to its BASE byte-for-byte; a byte inside a hunk, a duplicated hunk and a byte outside every hunk are each caught;
// an unowned file passes through; and the layer is registered INNERMOST at every raw read that composes the older layers (the
// 711ee39f precedent), so no historical byte-pin chain reads a D4 byte. D4's hunks are multi-line (an inserted function), so
// there is no same-line rule here. Run: node d4-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyD4Module } = require('./tools/d4-intake-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
assert.strictEqual(BASE, '53edc481', 'D4-WIRING: the base is the D4 branch point');
assert.deepStrictEqual([...FILES].sort(), ['index.js', 'pixelpay-hosted-charge.js', 'rewards-reserve.js'], 'D4-WIRING: the owned files');
for (const f of FILES) {
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  const b = execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
  assert.notStrictEqual(src, b, `D4-WIRING: non-vacuity: ${f} differs from ${BASE}`);
  assert.strictEqual(unapplyD4Module(f, src), b, `D4-WIRING: 🔴 ${f} minus the D4 hunks is not ${BASE}:${f}`);
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = h.now.search(/[A-Za-z]/);
    assert.throws(() => unapplyD4Module(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `D4-WIRING: ${f}: a byte inside a hunk`);
    assert.throws(() => unapplyD4Module(f, src + h.now), /occurs 2 times/, `D4-WIRING: ${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(unapplyD4Module(f, '\n' + src), b, `D4-WIRING: ${f}: a byte OUTSIDE every hunk survives`);
}
assert.strictEqual(unapplyD4Module('tb-unowned.js', 'x\n'), 'x\n', 'D4-WIRING: an unowned file passes through');
ok(`${FILES.length} file(s) → ${BASE} byte-for-byte; inside / duplicate / outside caught (${HUNKS.length} hunks); unowned passes`);
// the portal fold of index.js carries every D4 index.js hunk exactly once (the guards that read the fold peel this layer)
{
  const fold = require('./tools/portal-split').foldPortalSplit();
  for (const h of HUNKS.filter((x) => x.file === 'index.js')) assert.strictEqual(fold.split(h.now).length - 1, 1, `D4-WIRING: an index.js hunk survives the portal fold exactly once (${h.now.slice(0, 80)})`);
  ok('the portal fold carries each D4 index.js hunk exactly once');
}
// registration: every raw-read site that composes the previous innermost layer (dpao) composes D4 INSIDE it, at the same site
{
  const files = execFileSync('git', ['ls-files', '*.js'], { cwd: __dirname, encoding: 'utf8' }).split('\n').filter(Boolean);
  const DPAO = /require\('[./]*(?:tools\/)?dpao-module-inverse'\)\.unapplyDpaoModule\(/g;
  const PAIR = /require\('[./]*(?:tools\/)?dpao-module-inverse'\)\.unapplyDpaoModule\([^,]+, require\('[./]*(?:tools\/)?d4-intake-inverse'\)\.unapplyD4Module\(/g;
  let sites = 0;
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const a = (s.match(DPAO) || []).length; const p = (s.match(PAIR) || []).length;
    assert.strictEqual(p, a, `D4-WIRING: ${f}: ${a - p} raw read(s) compose dpao WITHOUT the D4 layer innermost`);
    sites += a;
  }
  assert.ok(sites >= 70, `D4-WIRING: premise — the registration covers the chains (${sites} sites)`);
  ok(`the D4 layer sits innermost at all ${sites} raw-read sites that compose the older layers`);
}
// §A7 NEVER composed: the CURRENT-code checks must SEE the SDK code — none of them may read through the D4 layer
for (const f of ['order-creators.guard.test.js', 'contract/census.js', 'contract/census-build.js', 'sdk-intake-branch.guard.test.js', 'tools/egress-guard.js', 'catalog/no-code-authority.guard.test.js']) {
  const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
  assert.ok(!/d4-intake-inverse|unapplyD4Module/.test(s), `D4-WIRING: ${f} must read index.js RAW (a current-code check never composes the D4 inverse)`);
}
ok('the current-code checks read the raw files (never through the D4 layer)');
console.log(`\nd4-wiring.guard: OK (${n})`);
