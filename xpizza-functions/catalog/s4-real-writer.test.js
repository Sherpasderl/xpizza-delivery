'use strict';
// S4 (PLAN-structure-S4-r4 R2.9; advisor 11-13) — the REAL-WRITER cells are KNOWN_RED until portal-ui's «S4 portal writer» lands in
// xpizza-portal/editor.js (addCategory · moveItem into staged / declared categories with promotion · addSubcat (atomic) · renameSubcat ·
// reorderSections · reorderSubcats · reorderItems; itemCategoryProblem relaxed for staged targets). Until then every S4 cell in this repo
// builds its drafts by editing the SOURCE the way that writer must, and none is labelled real-writer.
// This file PINS that state: it passes while the writer is absent and goes RED the day editor.js exports it — at which point the cells
// below are written for real (the server half re-run on writer-produced drafts) and this pin is replaced. Run: node catalog/s4-real-writer.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const EDITOR = path.join(__dirname, '..', '..', 'xpizza-portal', 'editor.js');
const WRITER = ['addCategory', 'addSubcat', 'renameSubcat', 'reorderSections', 'reorderSubcats', 'reorderItems'];
const KNOWN_RED = [
  'S4-RW-STAGED: addCategory → save → publish → the version carries the staged entry (section-compare + emulator round trip)',
  'S4-RW-PROMOTE: moveItem into a staged category → the writer\'s promotedOrder preview = the save\'s re-verification (two saves → B before A)',
  'S4-RW-SLUG: the writer\'s categorySlug preview = the save\'s re-derivation (collisions, digit-leading, empty)',
  'S4-RW-SUB-FIRST: addSubcat on an ungrouped section assigns EVERY member in the same save (subcat_partial otherwise)',
  'S4-RW-ORDER: reorderSections / reorderItems → s4OpPresent lines + diffHash; a live rename beside them → rename_not_alone',
  'S4-RW-THREE-PATH: the same writer-produced draft refused / accepted identically at save, publish and the manager request',
];
const src = fs.readFileSync(EDITOR, 'utf8');
const exported = WRITER.filter((f) => new RegExp(`export (function|const) ${f}\\b`).test(src));
assert.deepStrictEqual(exported, [], `🔴 S4-RW-PIN portal-ui's S4 writer has landed (${exported.join(', ')}): write the real-writer cells below and replace this pin`);
for (const c of KNOWN_RED) console.log(`  KNOWN_RED ${c} — awaiting portal-ui's «S4 portal writer» (R2.9)`);
console.log('  ✓ 1 S4-RW-PIN: the writer is not in xpizza-portal/editor.js yet; the real-writer cells stay KNOWN_RED (listed above)');
console.log('\ns4-real-writer: OK (1)');
