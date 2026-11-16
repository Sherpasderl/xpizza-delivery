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
assert.deepStrictEqual([...FILES], ['index.js', 'catalog/public-menu.js'], 'the owned files');
const src = require('./tools/mktprice-module-inverse').unapplyMktPriceModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'));   // marketing price (5f, the newest layer) peeled first
const b = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });
assert.notStrictEqual(src, b, 'non-vacuity: index.js differs from the base');
assert.strictEqual(unapplyMemberReadsModule('index.js', src), b, `🔴 index.js minus the member-reads hunks is not ${BASE}:index.js`);
ok(`index.js minus the ${HUNKS.length} member-reads insertions === ${BASE}:index.js byte-for-byte`);

// (3) dish_stats (5014e1295): catalog/public-menu.js minus its hunks === the base, byte-for-byte
const pmSrc = fs.readFileSync(path.join(__dirname, 'catalog/public-menu.js'), 'utf8');
const pmBase = execFileSync('git', ['show', `${BASE}:xpizza-functions/catalog/public-menu.js`], { cwd: __dirname, encoding: 'utf8' });
assert.notStrictEqual(pmSrc, pmBase, 'non-vacuity: public-menu.js differs from the base');
assert.strictEqual(unapplyMemberReadsModule('catalog/public-menu.js', pmSrc), pmBase, `🔴 catalog/public-menu.js minus the (3) hunks is not ${BASE}:catalog/public-menu.js`);
ok(`catalog/public-menu.js minus the ${HUNKS.filter((h) => h.file === 'catalog/public-menu.js').length} (3) hunks === ${BASE}:catalog/public-menu.js byte-for-byte`);
const fileSrc = { 'index.js': src, 'catalog/public-menu.js': pmSrc };

for (const h of HUNKS) {
  const src = fileSrc[h.file];
  const k = h.now.search(/[A-Za-z]/);
  assert.throws(() => unapplyMemberReadsModule(h.file, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${h.commit}: a byte inside a hunk`);
  assert.throws(() => unapplyMemberReadsModule(h.file, src + h.now), /occurs 2 times/, `${h.commit}: a duplicated hunk`);
}
assert.notStrictEqual(unapplyMemberReadsModule('index.js', '\n' + src), b, 'a byte OUTSIDE every hunk survives');
assert.notStrictEqual(unapplyMemberReadsModule('catalog/public-menu.js', '\n' + pmSrc), pmBase, 'public-menu.js: a byte OUTSIDE every hunk survives');
{ // the (3) VERSION mutant: 1d.4 → 1d.5 ⇒ the layer refuses (and so would every public-menu.js fold)
  const mut = pmSrc.replace("const REPRESENTATION_VERSION = '1d.4';", "const REPRESENTATION_VERSION = '1d.5';");
  assert.notStrictEqual(mut, pmSrc, 'premise: the 1d.4 marker is present');
  assert.throws(() => unapplyMemberReadsModule('catalog/public-menu.js', mut), /occurs 0 times/, '🔴 a one-byte change to the (3) marker is detected');
}
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
  // (3): the 9 guards that fold catalog/public-menu.js to a fixed revision compose it too
  const PM = ['directory-wiring.guard', 'keymode-wiring.guard', 's1d-wiring.guard', 'formbake-module-wiring.guard', 'avail-identity-wiring.guard', 'photos-module-wiring.guard', 's2bext-wiring.guard', 's2core-wiring.guard', 'catalog/identity-integrity-guards'];
  for (const g of PM) {
    const s = fs.readFileSync(path.join(__dirname, `${g}.test.js`), 'utf8');
    assert.ok(/memberreads-module-inverse'\)\.unapplyMemberReadsModule\(/.test(s), `🔴 ${g} (public-menu.js fold) does not compose the member-reads layer`);
  }
  ok(`registration (3): the ${PM.length} catalog/public-menu.js folds compose the member-reads layer`);
}
console.log(`\nmemberreads-wiring.guard: OK (${n})`);
