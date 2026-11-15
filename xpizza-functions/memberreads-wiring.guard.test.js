'use strict';
// PLAN-3a-capp-member-reads (1)+(2) — index.js wiring guard for 3a's member-reads exports (advisor ruling 2026-11-13, option 2).
// PROOF: tools/memberreads-module-inverse.js removes EXACTLY 3a's two index.js insertions (5a84271f3: getMyFavorites + setFavorite;
// 32a4ce6e2: getMyLastTip), so index.js minus them === 604e96ab5:index.js byte-for-byte. Sensitivity: a byte inside a hunk, a duplicated
// hunk and a byte outside every hunk are each detected; a one-byte change to an export breaks the proof (and every fold guard that
// composes this layer). Registration: every fold guard that pins index.js to a fixed train revision composes this layer.
// Run: node memberreads-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyMemberReadsModule } = require('./tools/memberreads-module-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
assert.strictEqual(BASE, '604e96ab5', 'the base is train asm9 (the RC asm9b branches from)');
assert.deepStrictEqual([...FILES], ['index.js'], 'the owned files');
const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const b = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });
assert.notStrictEqual(src, b, 'non-vacuity: index.js differs from the base');
assert.strictEqual(unapplyMemberReadsModule('index.js', src), b, `🔴 index.js minus the member-reads hunks is not ${BASE}:index.js`);
ok(`index.js minus the ${HUNKS.length} member-reads insertions === ${BASE}:index.js byte-for-byte`);

for (const h of HUNKS) {
  const k = h.now.search(/[A-Za-z]/);
  assert.throws(() => unapplyMemberReadsModule('index.js', src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${h.commit}: a byte inside a hunk`);
  assert.throws(() => unapplyMemberReadsModule('index.js', src + h.now), /occurs 2 times/, `${h.commit}: a duplicated hunk`);
}
assert.notStrictEqual(unapplyMemberReadsModule('index.js', '\n' + src), b, 'a byte OUTSIDE every hunk survives');
assert.strictEqual(unapplyMemberReadsModule('tb-unowned.js', 'x\n'), 'x\n', 'an unowned file passes through');
// the ONE-BYTE EXPORT MUTANT: the getMyLastTip export's handler name changed by one byte ⇒ the layer refuses (and so would every fold)
{
  const mut = src.replace("require('./my-last-tip').makeMyLastTip(", "require('./my-last-tip').makeMyLastTiP(");
  assert.notStrictEqual(mut, src, 'premise: the export is present');
  assert.throws(() => unapplyMemberReadsModule('index.js', mut), /occurs 0 times/, '🔴 a one-byte change to an export is detected');
}
ok('a byte inside a hunk, a duplicated hunk, a byte outside, an unowned file and a ONE-BYTE export change are each detected');

// wired: the three exports exist where the hunks say, through the member-auth modules
for (const [name, mod] of [['getMyFavorites', 'my-favorites'], ['setFavorite', 'my-favorites'], ['getMyLastTip', 'my-last-tip']]) {
  assert.ok(new RegExp(`exports\\.${name} = onRequest\\(`).test(src), `🔴 ${name} onRequest missing`);
  assert.ok(src.includes(`require('./${mod}')`), `🔴 ${mod} require missing`);
}
ok('wired: getMyFavorites, setFavorite and getMyLastTip are onRequest exports over my-favorites / my-last-tip');

// registration: the fold guards that pin index.js to a fixed train revision compose this layer (the s2bext / s1srv pattern)
{
  const MUST = ['confirmretire', 'd4', 'dpao', 'envlim', 'hostedrace', 'keymode', 'p5a', 's1d', 's1srv', 's2', 's2bext', 'sdkpay', 'tippref', 'zones'];
  for (const g of MUST) {
    const s = fs.readFileSync(path.join(__dirname, `${g}-wiring.guard.test.js`), 'utf8');
    assert.ok(/memberreads-module-inverse'\)\.unapplyMemberReadsModule\(/.test(s), `🔴 ${g}-wiring does not compose the member-reads layer`);
  }
  ok(`registration: all ${MUST.length} train-pinned index.js fold guards compose the member-reads layer`);
}
console.log(`\nmemberreads-wiring.guard: OK (${n})`);
