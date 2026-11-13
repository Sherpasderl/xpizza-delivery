'use strict';
// S4 (PLAN-structure-S4-r4 R2.9; advisor 11-13) — the REAL-WRITER cells: drafts produced by portal-ui's «S4 portal writer»
// (xpizza-portal/editor.js — addCategory · renameCategory · dropStagedCategory · moveItem with promotion · addSubcat · renameSubcat ·
// reorderSections · reorderSubcats · reorderItems), judged by the REAL server rules (validateSource, edit-preflight with the stored draft,
// section-compare, review-diff, the three paths). The writer is read from portal-ui's branch ref WRITER_REF until it merges here (the
// ref's file written to a temp module and imported — the server half never trusts a copy it cannot name). Its section-transitions copy at
// that ref must be byte-identical to catalog/section-transitions.js (the module it previews with). Run: node catalog/s4-real-writer.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const WRITER_REF = '71720530e';   // feat/portal-structure-s3-ui (portal-ui; S4-C «add promotes» 083d76bb7 + 1c82272e1) — replace by the repo's own xpizza-portal/editor.js once merged
const S = { sections: true };
{ const p = require.resolve('./platform-structure'); const real = require(p); require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, structureCapabilities: () => ({ ...real.structureCapabilities(), sections: S.sections }) } }; }
const ST = require('./section-transitions');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const SS = require('./source-store');
const PF = require('./edit-preflight');
const SC = require('./section-compare');
const { reviewDiff } = require('./review-diff');
let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const atRef = (rel) => execFileSync('git', ['show', `${WRITER_REF}:${rel}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
const ON = { sections: true };
const LM = buildSourceFromCode('la_musa');
const built = (rid, src) => { const b = buildSourceCandidate(rid, src).built; return { items: b.items, extras: b.extras, structure: b.structure }; };
// the server's verdict on a writer-produced source against the live version and the stored draft — the save's own checks, in the save's
// order (edit-catalog-handler: the edit preflight BEFORE validateSource, then the structural judgment)
function serverVerdict(rid, live, stored, draft) {
  const L = built(rid, live);
  const pf = PF.editPreflight({ draft, live: { items: L.items, structure: L.structure }, renderedCategories: SS.rendererContract(rid).renderedCategories, stored });
  if (pf) return pf.body.error;
  try { SS.validateSource(draft, rid); } catch (e) { return `invalid_source: ${String(e.message).slice(0, 120)}`; }
  try { SC.compareToActive({ draftBuilt: built(rid, draft), activeBuilt: L, draftAuthored: Object.keys(draft.structure), renderedCategories: SS.rendererContract(rid).renderedCategories, deletedIds: [], textEdit: true }); } catch (e) { return e.code; }
  return 'ok';
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's4rw-'));
  fs.writeFileSync(path.join(tmp, 'editor.mjs'), atRef('xpizza-portal/editor.js'));
  globalThis.SectionTransitions = ST;
  const E = await import(require('url').pathToFileURL(path.join(tmp, 'editor.mjs')).href);
  const draftOf = (src) => E.createDraft(clone(src));
  const ok = (r, L) => assert.ok(r && r.ok, `${L}: the writer refused ${JSON.stringify(r)}`);

  await cell('S4-RW-SYNC: portal-ui\'s section-transitions copy at the writer ref is byte-identical to the server module', (L) => {
    assert.strictEqual(atRef('xpizza-portal/section-transitions.js'), fs.readFileSync(path.join(__dirname, 'section-transitions.js'), 'utf8'), L);
  });
  await cell('S4-RW-STAGED: addCategory → a staged entry the server accepts (validate, preflight vs stored, section-compare)', (L) => {
    const d = draftOf(LM); ok(E.addCategory(d, 'Postres', { after: 'bebidas' }, ON), L);
    const src = clone(E.draftSource(d));
    assert.deepStrictEqual(src.structure.staged_categories, [{ id: 'postres', name: 'Postres', after: 'bebidas' }], L);
    assert.strictEqual(serverVerdict('la_musa', LM, LM, src), 'ok', L);
  });
  await cell('S4-RW-SLUG: the writer\'s ids are the server\'s re-derivation (digit-leading, accents, a collision)', (L) => {
    const d = draftOf(LM); ok(E.addCategory(d, '2x1 Promos', {}, ON), `${L}: digit`); ok(E.addCategory(d, 'Bebidas frías', {}, ON), `${L}: accents`); ok(E.addCategory(d, 'Promos 2x1!', {}, ON), `${L}: third`);
    const src = clone(E.draftSource(d));
    assert.deepStrictEqual(src.structure.staged_categories.map((e) => e.id), ['c_2x1_promos', 'bebidas_frias', 'promos_2x1'], L);
    assert.strictEqual(serverVerdict('la_musa', LM, LM, src), 'ok', L);
  });
  await cell('S4-RW-PROMOTE: moveItem into a staged category promotes it; the server re-verifies; two saves on one anchor → B before A', (L) => {
    const d0 = draftOf(LM); ok(E.addCategory(d0, 'Aa', { after: 'crudo' }, ON), L); ok(E.addCategory(d0, 'Bb', { after: 'crudo' }, ON), L);
    const s0 = clone(E.draftSource(d0));
    const d1 = draftOf(s0); ok(E.moveItem(d1, 'dimsum_01', { cat: 'aa' }, ON), `${L}: save 1`);
    const s1 = clone(E.draftSource(d1));
    assert.strictEqual(serverVerdict('la_musa', LM, s0, s1), 'ok', `${L}: save 1`);
    const d2 = draftOf(s1); ok(E.moveItem(d2, 'dimsum_02', { cat: 'bb' }, ON), `${L}: save 2`);
    const s2 = clone(E.draftSource(d2));
    assert.strictEqual(serverVerdict('la_musa', LM, s1, s2), 'ok', `${L}: save 2`);
    const ids = s2.structure.categories.map((c) => c.id); const at = ids.indexOf('crudo');
    assert.deepStrictEqual(ids.slice(at, at + 3), ['crudo', 'bb', 'aa'], `${L}: B before A`);
    assert.ok(!('staged_categories' in s2.structure) || s2.structure.staged_categories.length > 0, `${L}: never an EMPTY staged list (validateStaged refuses [])`);
  });
  await cell('S4-RW-SUB-FIRST: addSubcat on an ungrouped section with every member → accepted by the server; one missing → subcat_partial in the writer', (L) => {
    const keys = LM.items.filter((i) => i.display.cat === 'dim_sum').map((i) => i.key);
    const d = draftOf(LM); ok(E.addSubcat(d, 'dim_sum', 'Vapor', keys, ON), L);
    assert.strictEqual(serverVerdict('la_musa', LM, LM, clone(E.draftSource(d))), 'ok', L);
    const e = draftOf(LM); const r = E.addSubcat(e, 'dim_sum', 'Vapor', keys.slice(1), ON);
    assert.deepStrictEqual([r.ok, r.code, r.missing], [false, 'subcat_partial', [keys[0]]], L);
  });
  await cell('S4-RW-ORDER: reorderSections / reorderItems / renameSubcat → accepted, with the review\'s sections lines', (L) => {
    const d = draftOf(LM); const ids = LM.structure.categories.map((c) => c.id); [ids[0], ids[1]] = [ids[1], ids[0]];
    ok(E.reorderSections(d, ids, ON), L);
    const order = [...LM.structure.item_order]; const i = order.indexOf('dimsum_01'); const j = order.indexOf('dimsum_02'); [order[i], order[j]] = [order[j], order[i]];
    ok(E.reorderItems(d, order, ON), L); ok(E.renameSubcat(d, 'bebidas', 'Sodas', 'Refrescos', ON), L);
    const src = clone(E.draftSource(d));
    assert.strictEqual(serverVerdict('la_musa', LM, LM, src), 'ok', L);
    const a = built('la_musa', LM); const b = built('la_musa', src);
    const s = reviewDiff({ rid: 'la_musa', live: a, liveExtraRecords: a.extras, draftBuilt: b, draftExtraRecords: b.extras }).sections;
    assert.deepStrictEqual([!!s.categories, s.items.length, s.subcats], [true, 2, [{ cat: 'bebidas', change: 'renamed', old: 'Sodas', new: 'Refrescos' }]], L);
  });
  await cell('S4-RW-RENAME-ALONE (Q8): the writer refuses an S4 op while a live section rename is pending (the server\'s rename_not_alone, held at the state boundary)', (L) => {
    const d = draftOf(LM); ok(E.renameCategory(d, 'crudo', 'Crudos', ON), L);
    const r = E.reorderSections(d, LM.structure.categories.map((c) => c.id).reverse(), ON);
    assert.strictEqual(r.ok, false, `${L}: ${JSON.stringify(r)}`);
  });
  await cell('S4-RW-DROP: dropping the LAST staged category leaves a source the server accepts (no empty staged list)', (L) => {
    const d = draftOf(LM); ok(E.addCategory(d, 'Postres', {}, ON), L); ok(E.dropStagedCategory(d, 'postres', ON), L);
    assert.strictEqual(serverVerdict('la_musa', LM, LM, clone(E.draftSource(d))), 'ok', L);
  });
  await cell('S4-RW-FOLD: a name that differs from an existing one only by accents / spacing — the writer and the server agree', (L) => {
    const d = draftOf(LM); const r = E.addCategory(d, 'Dím  Sum', {}, ON);
    assert.deepStrictEqual([r.ok, r.code], [false, 'category_name_taken'], `${L}: the writer (nameFold, ruling 2a) — ${JSON.stringify(r)}`);
    const s = clone(LM); s.structure.staged_categories = [{ id: 'dim_sum_2', name: 'Dím  Sum', after: null }];
    assert.strictEqual(serverVerdict('la_musa', LM, LM, s), 'category_name_taken', `${L}: the server, typed (ruling 2b), for a draft written any other way`);
  });
  await cell('S4-RW-SLUG-ORDER: two colliding new categories, the SECOND promoted first — the server accepts the writer\'s ids', (L) => {
    const d0 = draftOf(LM); ok(E.addCategory(d0, 'Postres!', { after: 'crudo' }, ON), L); ok(E.addCategory(d0, 'postres?', { after: 'crudo' }, ON), L);
    const ids = E.draftSource(d0).structure.staged_categories.map((e) => e.id);
    ok(E.moveItem(d0, 'dimsum_01', { cat: ids[1] }, ON), L);
    assert.strictEqual(serverVerdict('la_musa', LM, LM, clone(E.draftSource(d0))), 'ok', `${L}: ids ${JSON.stringify(ids)}`);
  });
  await cell('S4-RW-ADD-PROMOTES (S4-C): addProduct into a STAGED section promotes it — the REAL save (allocation, preflight vs stored) accepts it, the owner publish too', async (L) => {
    const H = require('../test/_s2core-harness'); H.SW.extrasCatalog = false;
    const quiet = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };
    const w = H.world('la_musa', { live: LM });
    const d0 = draftOf(LM); ok(E.addCategory(d0, 'Postres', { after: 'crudo' }, ON), `${L}: stage`);
    const r1 = await quiet(() => w.save(clone(E.draftSource(d0))));
    assert.strictEqual(r1.status, 200, `${L}: save 1 (staged) ${JSON.stringify(r1.body)}`);
    const d1 = draftOf(r1.body.source); const ref = 'tmp:rwadd-0001';
    E.addProduct(d1, { ref, cat: 'postres' }, ON); E.setAddition(d1, ref, 'name', 'Flan de Coco', ON); E.setAddition(d1, ref, 'price', '120', ON);
    const src = clone(E.draftSource(d1));
    assert.ok(src.structure.categories.some((c) => c.id === 'postres') && !(src.structure.staged_categories || []).some((e) => e.id === 'postres'), `${L}: the writer promoted it`);
    const r2 = await quiet(() => w.save(src));
    assert.strictEqual(r2.status, 200, `${L}: save 2 (the promoting addition) ${JSON.stringify(r2.body)}`);
    const saved = r2.body.source; const ids = saved.structure.categories.map((c) => c.id);
    assert.deepStrictEqual(ids.slice(ids.indexOf('crudo'), ids.indexOf('crudo') + 2), ['crudo', 'postres'], `${L}: promoted at its anchor`);
    const added = saved.items.find((i) => i.display && i.display.name === 'Flan de Coco');
    assert.ok(added && typeof added.key === 'string' && !added.ref && added.display.cat === 'postres', `${L}: allocated, in the promoted section`);
    const { token, diff } = await w.tokenFor();
    const pub = await quiet(() => w.ownerPublish(token, diff.largeChangeSet.map((l) => ({ key: l.key, surface: l.surface }))));   // a new dish's sanity row: today's acknowledgement
    assert.strictEqual(pub.status, 200, `${L}: the owner publish ${JSON.stringify(pub.body)}`);
  });
  await cell('S4-RW-OFF: sections OFF → every writer op refuses sections_off (nothing written)', (L) => {
    const d = draftOf(LM); const before = JSON.stringify(E.draftSource(d));
    for (const r of [E.addCategory(d, 'Postres', {}, {}), E.reorderSections(d, LM.structure.categories.map((c) => c.id), {}), E.moveItem(d, 'dimsum_01', { cat: 'rice' }, {})]) assert.deepStrictEqual([r.ok, r.code], [false, 'sections_off'], L);
    assert.strictEqual(JSON.stringify(E.draftSource(d)), before, L);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`OK(${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
