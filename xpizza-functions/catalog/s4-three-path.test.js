'use strict';
// S4 (PLAN-structure-S4-r4 §7 S4-THREE-PATH, R2.2/R3.1) — the SAVE, the OWNER PUBLISH and the MANAGER REQUEST answer the same for every S4
// draft: the REAL editCatalogCore / publishEditedCore / requestPublishCore on one Firestore fake (test/_s2core-harness.js; the token is
// the canonical review diff, rid included as the handlers pass it). x_pizza with its categories NAMED (prod: 2 of 2 named — the advisor's
// read 11-13), the brand a manager requests on. Accepted drafts publish on both paths; a refused draft is STORED directly (an older server
// or a raced save left it) and refused with the SAME code by the publish and the request. Server-built drafts (the portal writer's real
// cells: catalog/s4-real-writer.test.js, KNOWN_RED). Run: node catalog/s4-three-path.test.js
const assert = require('assert');
const S = { sections: true };
{ const p = require.resolve('./platform-structure'); const real = require(p); require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, structureCapabilities: () => ({ ...real.structureCapabilities(), sections: S.sections }) } }; }
const H = require('../test/_s2core-harness');
H.SW.extrasCatalog = false;
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const LIVE = (() => { const s = buildSourceFromCode('x_pizza'); s.structure.categories.forEach((c) => { c.name = c.id === 'ny' ? 'NY' : 'Individual'; }); return s; })();
const DISH = LIVE.items.find((i) => i.display.cat === 'individual' && i.display.variantOf == null).key;
const code = (r) => (r && r.status === 200 ? 200 : r && r.body && (r.body.error || r.body.code));
const quiet = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };

async function threePaths(mutate) {
  const w = H.world('x_pizza', { live: LIVE });
  const saved = await quiet(() => w.save(mutate));
  if (saved.status !== 200) { const d = clone((await w.draft()).source); mutate(d); await w.store(d); }
  const { token } = await w.tokenFor();
  const pub = await quiet(() => w.ownerPublish(token));
  const req = await quiet(() => w.request(token));
  return { save: code(saved), publish: code(pub), request: code(req) };
}
const newCat = (d) => { d.structure.categories.push({ id: 'postres', name: 'Postres' }); d.items.find((i) => i.key === DISH).display.cat = 'postres'; };

(async () => {
  await cell('S4-3P-NEWCAT: a new category + a dish moved in → 200 on the save, the publish and the request', async (L) => {
    assert.deepStrictEqual(await threePaths(newCat), { save: 200, publish: 200, request: 200 }, L);
  });
  await cell('S4-3P-STAGED: a staged (empty) category → 200 on all three', async (L) => {
    assert.deepStrictEqual(await threePaths((d) => { d.structure.staged_categories = [{ id: 'postres', name: 'Postres', after: null }]; }), { save: 200, publish: 200, request: 200 }, L);
  });
  await cell('S4-3P-RENAME-ALONE (Q8): a section reorder + a live rename → rename_not_alone on all three', async (L) => {
    const r = await threePaths((d) => { const c = d.structure.categories; [c[0], c[1]] = [c[1], c[0]]; c[0].name = `${c[0].name} 2`; });
    assert.deepStrictEqual(r, { save: 'rename_not_alone', publish: 'rename_not_alone', request: 'rename_not_alone' }, L);
  });
  await cell('S4-3P-NO-DELETE (Q6): a live category removed → structure_changed on all three', async (L) => {
    const r = await threePaths((d) => { for (const i of d.items) if (i.display.cat === 'ny') i.display.cat = 'individual'; d.structure.categories = d.structure.categories.filter((c) => c.id !== 'ny'); d.structure.weekend_only_cats = []; d.structure.pickup_only_cats = []; });
    assert.strictEqual(new Set(Object.values(r)).size, 1, `${L}: one answer (${JSON.stringify(r)})`);
    assert.notStrictEqual(r.save, 200, L);
  });
  await cell('S4-3P-OFF: sections OFF → the new-category draft is refused, the SAME code on all three', async (L) => {
    S.sections = false;
    try {
      const r = await threePaths(newCat);
      assert.strictEqual(new Set(Object.values(r)).size, 1, `${L}: one answer (${JSON.stringify(r)})`);
      assert.notStrictEqual(r.save, 200, L);
    } finally { S.sections = true; }
  });
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`OK(${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
