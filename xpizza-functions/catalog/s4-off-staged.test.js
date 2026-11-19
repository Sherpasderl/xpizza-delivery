'use strict';
// S4 carry (PLAN-3a-s4-carry-r0, advisor 11-19) — with the REAL sections switch OFF, a save can never STORE staged categories. The
// REAL editCatalogCore on the s2core harness's Firestore fake (test/_s2core-harness.js stubs only the extras / text-edit switches; the
// sections switch is platform-structure's own SECTIONS constant, read live by the handler at the assertSameAuthoredFields call).
// The helper cells (s4-staging STG-OFF-KEY / STG-OFF-VALUE) pass the option by hand; this pins the handler's wiring to the switch.
// Run: node catalog/s4-off-staged.test.js
const assert = require('assert');
const H = require('../test/_s2core-harness');
const fs = require('fs');
const path = require('path');
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const quiet = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };
// x_pizza with its categories NAMED (prod: 2 of 2 named — the advisor's read 11-13), as s4-three-path.test.js builds it
const LIVE = (() => { const s = buildSourceFromCode('x_pizza'); s.structure.categories.forEach((c) => { c.name = c.id === 'ny' ? 'NY' : 'Individual'; }); return s; })();

(async () => {
  await cell('S4-OFF-PREMISE: the REAL switch is OFF (the shipped constant, read live)', async (L) => {
    assert.match(fs.readFileSync(path.join(__dirname, 'platform-structure.js'), 'utf8'), /const SECTIONS = false;/, `${L}: the constant`);
    assert.strictEqual(require('./platform-structure').structureCapabilities().sections, false, `${L}: structureCapabilities`);
  });
  await cell('S4-OFF-STAGED-SAVE: sections OFF → a save that ADDS staged_categories is refused structure_changed by the REAL handler, and nothing is written', async (L) => {
    const w = H.world('x_pizza', { live: LIVE });
    const before = await w.draft();
    const r = await quiet(() => w.save((d) => { d.structure.staged_categories = [{ id: 'postres', name: 'Postres', after: null }]; }));
    assert.strictEqual(r && r.status, 400, `🔴 S4-OFF-STAGED-SAVE: refused (${JSON.stringify(r && r.body)})`);
    assert.strictEqual(r.body.error || r.body.code, 'structure_changed', `🔴 S4-OFF-STAGED-SAVE: structure_changed (${JSON.stringify(r.body)})`);
    const after = await w.draft();
    assert.deepStrictEqual(after.source, before.source, `${L}: the stored draft is unchanged`);
    assert.strictEqual(after.updateTime && String(after.updateTime), before.updateTime && String(before.updateTime), `${L}: no write (the update time did not move)`);
    assert.ok(!('staged_categories' in (after.source.structure || {})), `${L}: no staged_categories stored`);
  });
  await cell('S4-OFF-CONTROL: the SAME world accepts the same save without the staged key (the refusal is the key, not the world)', async (L) => {
    const w = H.world('x_pizza', { live: LIVE });
    const r = await quiet(() => w.save(() => {}));
    assert.strictEqual(r && r.status, 200, `${L}: ${JSON.stringify(r && r.body)}`);
  });
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`s4-off-staged: OK(${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
