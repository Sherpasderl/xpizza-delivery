'use strict';
// S4 SECTIONS (PLAN-structure-S4-r4; carried onto main by PLAN-3a-s4-carry-r0) — the wiring guard for tools/s4sect-module-inverse.js:
// (1) the inverse returns each owned file to its BASE (main 31f05c8a4) byte-for-byte; a byte inside a hunk, a duplicated hunk and a byte
// outside every hunk are each caught; an unowned file passes through; the edits are same-line only EXCEPT catalog/choice-compare.js
// (advisor 11-19: S4's section-compare edges + the S3 label_too_long block are inserted lines).
// (2) PLACEMENT (advisor ruling 11-19): every peel chain that composes a layer owning an s4sect file peels s4sect DIRECTLY INSIDE its
// innermost such layer, once — read from the SYNTAX TREE (acorn); the owners are derived from every tools/*-inverse.js FILES, never
// listed by hand; a chain reading a fixed file s4sect does not own is pass-through. Only the declared own-guard sites peel it elsewhere.
// Run: node s4sect-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const acorn = require('acorn');
const { BASE, HUNKS, FILES, unapplyS4sectModule } = require('./tools/s4sect-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const git = (args, cwd = __dirname) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 27 });
const INSERTS = new Set(['catalog/choice-compare.js']);

// ── 1. the inverse ──
assert.strictEqual(BASE, '31f05c8a4', 'the layer is generated against main 31f05c8a4');
assert.deepStrictEqual([...FILES].sort(), ['catalog/add-product.js', 'catalog/choice-compare.js', 'catalog/edit-catalog-handler.js', 'catalog/form-menu-source.js', 'catalog/platform-structure.js', 'catalog/publish-edited-handler.js', 'catalog/publish-request.js', 'catalog/source-store.js'], 'the owned (pinned) files S4 edits');
for (const f of FILES) {
  const src = require('./tools/pending-module-inverse').unapplyPendingModule(f, fs.readFileSync(path.join(__dirname, f), 'utf8'));
  const b = git(['show', `${BASE}:xpizza-functions/${f}`]);
  assert.notStrictEqual(src, b, `non-vacuity: ${f} differs from ${BASE}`);
  assert.strictEqual(require('./tools/rewardgroups-module-inverse').unapplyRewardGroupsModule(f, unapplyS4sectModule(f, src)), b, `🔴 S4SECT-BASE: ${f} minus the s4sect hunks (then asm12's reward-groups layer, below it on choice-compare.js) is not ${BASE}:${f}`);
  if (!INSERTS.has(f)) assert.strictEqual(src.split('\n').length, b.split('\n').length, `🔴 ${f}: same-line edits only (no line added or moved)`);
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = h.now.search(/[A-Za-z]/);
    assert.throws(() => unapplyS4sectModule(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${f}: a byte inside a hunk`);
    assert.throws(() => unapplyS4sectModule(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(unapplyS4sectModule(f, '\n' + src), b, `${f}: a byte OUTSIDE every hunk survives`);
}
assert.strictEqual(unapplyS4sectModule('tb-unowned.js', 'x\n'), 'x\n', 'an unowned file passes through');
ok(`${FILES.length} files → ${BASE} byte-for-byte (same-line except ${[...INSERTS].join(', ')}); inside / duplicate / outside caught (${HUNKS.length} hunks); unowned passes`);

// ── 2. the placement ──
const OWNERS = new Set();
for (const t of fs.readdirSync(path.join(__dirname, 'tools')).filter((x) => /-inverse\.js$/.test(x) && x !== 's4sect-module-inverse.js' && x !== 'pending-module-inverse.js')) {   // S3 r1: the NEWER pending layer is peeled inside s4sect (innermost, on the raw read) — not an older owner
  const m = require(`./tools/${t}`);
  const F = m.FILES ? [...m.FILES] : (Array.isArray(m.HUNKS) ? m.HUNKS.map((h) => h.file) : (typeof m.FILE === 'string' ? [m.FILE] : []));
  if (F.some((f) => FILES.includes(f))) OWNERS.add(t.replace(/\.js$/, ''));
}
assert.ok(OWNERS.size >= 10 && OWNERS.has('extrasflip-module-inverse') && OWNERS.has('s3choice-module-inverse'), `non-vacuity: the owners are derived (${[...OWNERS].join(', ')})`);
const RE = /^([./]*)tools\/([a-z0-9-]+-inverse)$/;
const peel = (x) => {
  if (!x || x.type !== 'CallExpression' || x.arguments.length !== 2) return null;
  const c = x.callee; if (c.type !== 'MemberExpression' || c.computed || !/^unapply\w+Module$/.test(c.property.name)) return null;
  const o = c.object; if (o.type !== 'CallExpression' || o.callee.type !== 'Identifier' || o.callee.name !== 'require' || o.arguments.length !== 1 || o.arguments[0].type !== 'Literal') return null;
  const m = RE.exec(String(o.arguments[0].value)); return m ? m[2] : null;
};
const walk = (x, cb) => { if (!x || typeof x.type !== 'string') return; cb(x); for (const k of Object.keys(x)) { const v = x[k]; if (Array.isArray(v)) v.forEach((y) => walk(y, cb)); else if (v && typeof v.type === 'string') walk(v, cb); } };
// the declared own-guard sites (each peels s4sect directly under its own owner's bare call, or on a raw read with no owner in the chain)
// asm13 merge: extrasflip-wiring's raw-read chain now carries s4sect directly inside reward-groups (its innermost owner: by the rule, not
// declared); reward-groups' OWN guard peels s4sect on its raw read (declared)
const DECLARED = { 's3-served.test.mjs': 1, 'xpizza-functions/s2bext-wiring.guard.test.js': 1, 'xpizza-functions/rewardgroups-wiring.guard.test.js': 1 };
const top = git(['rev-parse', '--show-toplevel']).trim();
const files = git(['ls-files', '*.js', '*.mjs'], top).split('\n').filter((f) => f && !/(^|\/)tools\/[a-z0-9-]+-inverse\.js$/.test(f) && f !== 'xpizza-functions/s4sect-wiring.guard.test.js');
// the next peel BELOW a peel: its src argument, followed THROUGH non-layer wrappers (a call that hands its last argument on —
// e.g. keymode-wiring's peelTip(f, s)), so a chain split by a helper is still ONE peel sequence (slot 11-19: the wrap had placed
// s4sect once per segment of keymode's chain, and this cell, reading segments, passed it)
const below = (x) => { let a = x.arguments[1]; while (a && !peel(a) && a.type === 'CallExpression' && a.arguments.length) a = a.arguments[a.arguments.length - 1]; return peel(a) ? a : null; };
let placed = 0; const bad = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(top, f), 'utf8');
  if (!/-inverse'\)\.unapply/.test(src)) continue;
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: f.endsWith('.mjs') ? 'module' : 'script', allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
  const peels = []; const inner = new Set(); let s4 = 0;
  walk(ast, (x) => { const l = peel(x); if (!l) return; peels.push(x); if (l === 's4sect-module-inverse') s4++; const b = below(x); if (b) inner.add(b); });
  let here = 0;
  for (const t of peels.filter((x) => !inner.has(x))) {
    const a1 = t.arguments[0];
    if (a1.type === 'Literal' && typeof a1.value === 'string' && !FILES.includes(a1.value)) continue;
    const chain = [t]; for (let b = below(t); b; b = below(b)) chain.push(b);
    const layers = chain.map(peel); let k = -1; layers.forEach((l, i) => { if (OWNERS.has(l)) k = i; });
    if (k < 0) continue;
    const at = layers.indexOf('s4sect-module-inverse');
    if (at !== k + 1 || layers.lastIndexOf('s4sect-module-inverse') !== at) bad.push(`${f}@${t.start} (${layers.slice(Math.max(0, k - 1), k + 3).join(' > ')})`);
    else here++;
  }
  placed += here;
  if (s4 - here !== (DECLARED[f] || 0)) bad.push(`${f}: ${s4 - here} s4sect peel(s) outside the rule (declared ${DECLARED[f] || 0})`);
}
assert.ok(placed >= 50, `non-vacuity: the rule covers the chains (${placed})`);
assert.deepStrictEqual(bad, [], `🔴 S4SECT-PLACEMENT: s4sect must sit directly inside the innermost owner of every chain:\n  ${bad.join('\n  ')}`);
ok(`s4sect sits directly inside the innermost owner at all ${placed} chains (${OWNERS.size} derived owners); ${Object.keys(DECLARED).length} declared own-guard sites`);
console.log(`\ns4sect-wiring.guard: OK (${n})`);
