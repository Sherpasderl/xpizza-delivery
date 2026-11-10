'use strict';
// S2-2 drift guard (advisor ruling 2026-11-10) — catalog/move-rules.js and the REAL validator (catalog/source-store.js
// validateSource) give the SAME coverage/emptiness answer, byte for byte, on:
//   · EVERY single-product move of both real sources: each item × each declared section × {each of its subsections, none,
//     an undeclared one};
//   · crafted edge cases (the last dish of a section / of a subsection moved away; into a subsectioned section with none; an
//     undeclared subsection; a subsection into a section that declares none).
// And the validator's coverage/emptiness REASONS are enumerated from its own source text, so a new reason added there turns
// this guard red until move-rules states it. Run: node catalog/move-rules-parity.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateSource } = require('./source-store');
const { firstMoveFailure } = require('./move-rules');
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── 1. the reason set, enumerated from validateSource's source ──
{
  const src = fs.readFileSync(path.join(__dirname, 'source-store.js'), 'utf8');
  const covStart = src.indexOf('// ── SUBCATEGORY COVERAGE'); const covEnd = src.indexOf('// ── EXTRAS AS FIRST-CLASS DISPLAY RECORDS');
  const empStart = src.indexOf('const usedExtraCats = new Set(source.extras'); const empEnd = src.indexOf('}', src.indexOf('for (const sc of c.subcats) {', empStart) + 40);
  assert.ok(covStart > 0 && covEnd > covStart && empStart > covEnd && empEnd > empStart, 'premise: both validator blocks located');
  // EVERY fail( call in the blocks, in any quoting style (Codex S2 code r1 P2-5): each must be a single literal this guard can read
  const reasons = (block) => {
    const calls = (block.match(/\bfail\(/g) || []).length;
    const lits = [...block.matchAll(/\bfail\((`[^`]*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\)/g)].map((m) => m[1].slice(1, -1).replace(/\$\{[^}]*\}/g, '…'));
    assert.strictEqual(lits.length, calls, `🔴 MR-REASONS every fail( call in the block is one readable literal (${lits.length} of ${calls})`);
    return lits;
  };
  const found = [...reasons(src.slice(covStart, covEnd)), ...reasons(src.slice(empStart, empEnd + 200))].sort();
  const STATED = [
    '…/… — category … groups by subcategory, so an item without a subcat would not render at all',
    '…/… — subcat … is not declared by category …, so the item would not render at all',
    '…/… — declares subcat … but category … declares no subcategories',
    '… — category … is declared but no dish is in it (it would render an empty section)',
    '… — category … declares subcategory … but no dish is in it (it would render an empty heading)',
  ];
  // the extra-category emptiness reason lives in the same block but concerns EXTRAS, which a product move never changes
  const EXEMPT = ['… — extra-category … is declared but no extra is in it (it would render an empty option group)'];
  assert.deepStrictEqual(found, [...STATED, ...EXEMPT].sort(), '🔴 MR-REASONS validateSource\'s coverage/emptiness reasons are exactly the ones move-rules states (+ the extras-only one, exempt)');
  ok(`the validator's ${found.length} coverage/emptiness reasons are enumerated from its source: ${STATED.length} stated, 1 extras-only exempt`);
}

const validatorFailure = (rid, source) => {
  try { validateSource(source, rid); return null; } catch (e) { return String(e.message).replace(/^source_malformed: /, ''); }
};
const isMoveReason = (m) => /groups by subcategory|is not declared by category|declares no subcategories|no dish is in it/.test(m || '');
// Other validator reasons a single-product move can trip, deliberately LEFT to the validator (not move rules): reviewed, exact.
const OTHER_REASONS = [
  // a group's launcher moved without its options (or an option alone): the save re-derives every option's section from its
  // launcher before any check (add-product.js rederiveOptionNames), so the edit handlers never present this draft
  /— a variant must share its launcher's category\/subcategory \(/,
];
const unclassified = [];
const seen = new Set();
const check = (rid, source, label) => {
  const v = validatorFailure(rid, source);
  const p = firstMoveFailure(rid, source);
  if (isMoveReason(v)) {
    assert.ok(p, `🔴 MR-PARITY ${label}: the validator refuses (${v}) but move-rules sees nothing`);
    assert.strictEqual(p.message, v, `🔴 MR-PARITY ${label}: the same first failure, byte for byte`);
    seen.add(p.reason);
  } else {
    assert.strictEqual(p, null, `🔴 MR-PARITY ${label}: move-rules refuses (${p && p.message}) where the validator does not on a move reason (${v})`);
    if (v !== null && !OTHER_REASONS.some((re) => re.test(v))) unclassified.push(`${label}: ${v}`);
  }
};
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── 2. every single-product move of both real sources ──
let moves = 0;
for (const rid of ['x_pizza', 'la_musa']) {
  const base = buildSourceFromCode(rid);
  assert.strictEqual(validatorFailure(rid, base), null, `premise: ${rid}'s real source validates`);
  for (let i = 0; i < base.items.length; i += 1) {
    for (const c of base.structure.categories) {
      for (const sub of [...(Array.isArray(c.subcats) ? c.subcats : []), undefined, '__undeclared__']) {
        const s = clone(base);
        s.items[i].display.cat = c.id;
        if (sub === undefined) delete s.items[i].display.subcat; else s.items[i].display.subcat = sub;
        check(rid, s, `${rid} item ${s.items[i].key} → ${c.id}/${sub === undefined ? '-' : sub}`);
        moves += 1;
      }
    }
  }
}
assert.deepStrictEqual(unclassified.slice(0, 5), [], `🔴 MR-UNCLASSIFIED every validator failure on a move-only draft is a move reason or a reviewed other reason (${unclassified.length} unclassified)`);
ok(`every single-product move of both real sources (${moves} drafts) gets the validator's exact answer; no unclassified failure`);

// ── 3. crafted edge cases ──
{
  const lm = buildSourceFromCode('la_musa');
  const beb = lm.structure.categories.find((c) => Array.isArray(c.subcats) && c.subcats.length);
  assert.ok(beb, 'premise: a subsectioned section exists');
  // the last dish of one subsection moved to the other: the emptied subsection
  const subA = beb.subcats[0];
  const inA = lm.items.filter((i) => i.display.cat === beb.id && i.display.subcat === subA);
  const s1 = clone(lm); for (const it of s1.items) if (it.display.cat === beb.id && it.display.subcat === subA) it.display.subcat = beb.subcats[1];
  check('la_musa', s1, `crafted: every dish of ${beb.id}/${subA} moved within the section (${inA.length})`);
  // a whole section emptied by moving its dishes away
  const other = lm.structure.categories.find((c) => !Array.isArray(c.subcats) || !c.subcats.length);
  const s2 = clone(lm); for (const it of s2.items) if (it.display.cat === other.id) it.display.cat = lm.structure.categories.find((c) => c.id !== other.id && !(c.subcats || []).length).id;
  check('la_musa', s2, `crafted: every dish of ${other.id} moved away`);
  // into the subsectioned section with no subsection / an undeclared one; a subsection into a plain section
  const s3 = clone(lm); const d3 = s3.items.find((i) => i.display.cat === other.id); d3.display.cat = beb.id; delete d3.display.subcat; check('la_musa', s3, 'crafted: into a subsectioned section without a subsection');
  const s4 = clone(lm); const d4 = s4.items.find((i) => i.display.cat === other.id); d4.display.cat = beb.id; d4.display.subcat = 'nope'; check('la_musa', s4, 'crafted: an undeclared subsection');
  const s5 = clone(lm); const d5 = s5.items.find((i) => i.display.cat === beb.id); d5.display.cat = other.id; check('la_musa', s5, 'crafted: a subsection carried into a section that declares none');
  ok('crafted edge cases: emptied subsection, emptied section, missing / undeclared / stray subsection');
}

// ── 4. every stated reason was actually exercised ──
assert.deepStrictEqual([...seen].sort(), ['section_empty', 'subcat_missing', 'subcat_none_declared', 'subcat_undeclared', 'subsection_empty'], '🔴 MR-COVERED every stated reason was hit by the matrix');
ok('every one of the five stated reasons was exercised against the real validator');

console.log(`\nmove-rules-parity: OK (${n})`);
