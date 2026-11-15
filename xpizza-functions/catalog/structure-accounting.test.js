'use strict';
// S2-core (PLAN-structure-S2core-r3 §1.2, Codex #4 / ruling R1) — EXHAUSTIVE ACCOUNTING. compareToActive explains a change only
// through its rules; a field the draft AUTHORS that no rule compares (la_musa's badge_priority, schema_version, an unknown field),
// an unknown row field, or a key-mode change was accepted silently. Every such residual now refuses `structure_unexplained` with
// its path — platform-wide, switch OFF. Today's free edits stay free: item prices, existing-EXTRA repricing (authoritative +
// mirror; Salsa Roja 39→40, rice_white 50→51) and a mixed item + extra edit; an UNAUTHORED (code-derived) field keeps its skip.
// Run: node catalog/structure-accounting.test.js
const assert = require('assert');
const AP = require('./add-product');
const { buildSourceCandidate } = require('./candidate-validate');
const { rendererContract } = require('./source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');

let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const compare = (rid, src, draftBuilt, activeBuilt) => AP.compareToActive({ draftBuilt, activeBuilt, draftAuthored: Object.keys(src.structure), renderedCategories: rendererContract(rid).renderedCategories });
const refusedWith = (fn, code, field) => { try { fn(); } catch (e) { assert.strictEqual(e.code, code, `refused with ${e.code}: ${e.message}`); if (field) assert.strictEqual(e.field, field, `the path: ${e.field}`); return; } assert.fail(`not refused (${code})`); };

for (const rid of ['x_pizza', 'la_musa']) {
  const src = buildSourceFromCode(rid);
  const active = buildSourceCandidate(rid, src).built;
  const extraKey = rid === 'x_pizza' ? 'Salsa Roja' : 'rice_white';
  const priced = (b, { extra = 1, item = 0 } = {}) => {
    const d = clone(b);
    const e = d.extras.find((x) => x.key === extraKey); e.price += extra; e.display.price = e.price;
    if (item) { d.items[0].price += item; d.items[0].display.price = d.items[0].price; }
    return d;
  };
  cell(`ACCT-EXTRA-REPRICE-FREE ${rid}: an existing extra repriced (authoritative + mirror) passes with every switch off`, () => {
    compare(rid, src, priced(active), active);
  });
  cell(`ACCT-MIXED-PRICE-FREE ${rid}: an item price + an extra price in one draft passes`, () => {
    compare(rid, src, priced(active, { item: 5 }), active);
  });
  cell(`ACCT-UNKNOWN-STRUCT ${rid}: an authored field no rule compares refuses structure_unexplained`, () => {
    const d = clone(active); d.structure.tb_unknown = ['x'];
    refusedWith(() => AP.compareToActive({ draftBuilt: d, activeBuilt: active, draftAuthored: [...Object.keys(src.structure), 'tb_unknown'], renderedCategories: rendererContract(rid).renderedCategories }), 'structure_unexplained', 'structure.tb_unknown');
  });
  cell(`ACCT-SCHEMA-VERSION ${rid}: an authored schema_version change refuses`, () => {
    const d = clone(active); d.structure.schema_version = (d.structure.schema_version || 0) + 1;
    refusedWith(() => compare(rid, src, d, active), 'structure_unexplained', 'structure.schema_version');
  });
  cell(`ACCT-UNAUTHORED-SKIPPED ${rid}: a code-derived (unauthored) field keeps today's skip`, () => {
    const d = clone(active); d.structure.tb_derived = 1;   // not in the draft's authored set
    compare(rid, src, d, active);
  });
  cell(`ACCT-ROW-FIELD ${rid}: an unknown field on an existing item row refuses`, () => {
    const d = clone(active); d.items[0].tb_row = 1;
    refusedWith(() => compare(rid, src, d, active), 'structure_unexplained', `items.${active.items[0].key}.tb_row`);
  });
  cell(`ACCT-EXTRA-ROW-FIELD ${rid}: an unknown field on an existing extra row refuses`, () => {
    const d = clone(active); d.extras[0].tb_row = 1;
    refusedWith(() => compare(rid, src, d, active), 'structure_unexplained', `extras.${active.extras[0].key}.tb_row`);
  });
  cell(`ACCT-KEY-MODE ${rid}: a key-mode change refuses`, () => {
    const d = clone(active); d.key_mode = d.key_mode === 'id' ? 'name' : 'id';
    refusedWith(() => compare(rid, src, d, active), 'structure_unexplained', 'key_mode');
  });
}
cell('ACCT-BADGE-PRIORITY la_musa: the authored badge_priority (Codex r1 probe) refuses', () => {
  const src = buildSourceFromCode('la_musa'); const active = buildSourceCandidate('la_musa', src).built;
  const s2 = clone(src); s2.structure.badge_priority = [...s2.structure.badge_priority].reverse();
  const d = buildSourceCandidate('la_musa', s2).built;
  refusedWith(() => compare('la_musa', s2, d, active), 'structure_unexplained', 'structure.badge_priority');
});

if (fails.length) { console.log(`structure-accounting FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
console.log(`structure-accounting: OK (${n})`);
