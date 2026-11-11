// S2-core (PLAN-structure-S2core-r3 §1.2, T1 / ruling R1 gate) — ZERO RESIDUAL over today's real flows: every draft the REAL
// portal writers produce (xpizza-portal/editor.js + item-edit-logic.js, under node) saves through the REAL editCatalogCore with
// accounting on and is never refused `structure_unexplained` — both brands, every switch as shipped (item_text_edit ON, extras
// authoring OFF). Flows: a dish's name / description / price, a section move, an existing extra's price (the drawer), an option
// price, a section rename, a new product. Run: node --test catalog/structure-accounting-flows.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import * as ED from '../../xpizza-portal/editor.js';
import * as IE from '../../xpizza-portal/item-edit-logic.js';

const require = createRequire(import.meta.url);
// the page's classic script — the portal's OWN copy of the extras evaluator, run as the browser runs it (item-edit-drawer.test.mjs:19-22),
// so the drawer can compute a move's consequences exactly as on the page
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
runInThisContext(readFileSync(new URL('../../xpizza-portal/extras-eligibility.js', import.meta.url), 'utf8'));
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const { editCatalogCore } = require('./edit-catalog-handler');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');

const T0 = '2026-11-11T10:00:00.000000Z', T1 = '2026-11-11T11:00:00.000000Z', ACTIVE = 'v-active-1';
const clone = (x) => JSON.parse(JSON.stringify(x));
const base = (rid) => clone(buildSourceFromCode(rid));
const owner = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'o@x.hn' });
// the live version as the reader returns it (category-rename-flow.test.js's harness)
const liveRead = (rid) => async () => { const src = base(rid); const i = sourceToBuildInputs(src); const b = buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }); return { built: { ...b, extras: i.extras }, versionId: ACTIVE, extraRecords: b.extras }; };
function saveDb(rid) {
  const state = { source: { data: base(rid), updateTime: T0 } };
  const doc = (path) => ({
    get: async () => {
      if (path === `restaurants/${rid}/meta/source`) { const frozen = clone(state.source.data); return { exists: true, data: () => frozen, updateTime: state.source.updateTime }; }
      if (path === `restaurants/${rid}/meta/active_version`) return { exists: true, data: () => ({ version: ACTIVE }) };
      return { exists: false, data: () => ({}) };
    },
    set: async (data) => { state.source = { data, updateTime: T1 }; return { writeTime: T1 }; },
    update: async (data, pre) => { if (!pre || pre.lastUpdateTime !== state.source.updateTime) { const e = new Error('FAILED_PRECONDITION'); e.code = 9; throw e; } state.source = { data, updateTime: T1 }; return { writeTime: T1 }; },
  });
  // a new product commits the draft and the high-water mark TOGETHER (edit-catalog-handler.js): a batch whose draft update keeps its
  // precondition; the mark's create is recorded (this harness has no mark store — frozen-keys-handler.test.js's shape)
  const batch = () => { const ops = []; return { update: (ref, data, pre) => ops.push(() => ref.update(data, pre)), create: () => ops.push(async () => ({ writeTime: T1 })), commit: async () => { const out = []; for (const op of ops) out.push(await op()); return out; } }; };
  return { batch, collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${d}/${c2}/${d2}`) }), get: async () => ({ exists: true, data: () => ({}) }) }) }) };
}
// the add-product dependency as frozen-keys-handler.test.js supplies it with no store (no retired names, no reserved keys)
const addProductOf = (mode) => ({ readKeyMode: async () => mode, hwmRef: () => ({ path: null, get: async () => ({ exists: false, data: () => undefined }) }),
  registryKeysTaken: async () => new Set(), syncKds: async () => ({ pending: false, written: false, reason: 'superseded' }), readReservedKeys: async () => require('./reserved-keys').reservedKeySet(undefined) });
const save = (rid, source) => editCatalogCore({ db: saveDb(rid), authorize: owner, readActiveBuilt: liveRead(rid), addProduct: addProductOf(rid === 'la_musa' ? 'id' : 'name') }, { restaurantId: rid, source, baseSourceUpdateTime: T0 }, {});
const noResidual = (r, label) => {
  assert.notStrictEqual(r.body && r.body.error, 'structure_unexplained', `${label}: residual ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.status, 200, `${label}: the save is accepted (${JSON.stringify(r.body).slice(0, 300)})`);
};
// one drawer edit through the real drawer logic, on a fresh draft of today's source
function drawer(rid, pick, edits) {
  const draft = ED.createDraft(base(rid));
  const row = ED.draftSource(draft).items.find(pick);
  const s = IE.open(draft, row.key);
  for (const [field, value] of edits(row, draft)) IE.set(s, field, value);
  const r = IE.save(draft, s);
  assert.ok(r.ok, `premise: the drawer saves (${JSON.stringify(r)})`);
  return ED.draftSource(draft);
}
const plain = (src) => (it) => it.display && !it.display.variantOf && !(src.structure.variant_items || {})[it.display.id];

for (const rid of ['x_pizza', 'la_musa']) {
  const src0 = base(rid);
  test(`T1-FLOW-NAME-DESC-PRICE ${rid}: the drawer's name + description + price`, async () => {
    noResidual(await save(rid, drawer(rid, plain(src0), (row) => [['name', `${row.display.name} Especial`], ['desc', 'Nueva descripción'], ['price', String(row.price + 5)]])), 'name/desc/price');
  });
  test(`T1-FLOW-EXTRA-PRICE ${rid}: the drawer's existing-extra price (Salsa Roja 39→40 / rice_white 50→51 kind)`, async () => {
    const ex = src0.extras[0];
    noResidual(await save(rid, drawer(rid, plain(src0), () => [['extraPrice', { key: ex.key, raw: String(ex.price + 1) }]])), 'extra price');
  });
  test(`T1-FLOW-MIXED ${rid}: a dish price and an extra price in one save`, async () => {
    const ex = src0.extras[0];
    noResidual(await save(rid, drawer(rid, plain(src0), (row) => [['price', String(row.price + 3)], ['extraPrice', { key: ex.key, raw: String(ex.price + 2) }]])), 'mixed');
  });
  test(`T1-FLOW-MOVE ${rid}: the drawer moves a dish to another drawn section`, async () => {
    const cats = src0.structure.categories.map((c) => c.id);
    const row = src0.items.find(plain(src0));
    const target = cats.find((c) => c !== row.display.cat && require('./source-store').rendererContract(rid).renderedCategories.includes(c));
    if (!target) return;   // a brand with one drawn section has no move to make
    noResidual(await save(rid, drawer(rid, (it) => it.key === row.key, () => [['cat', target]])), 'move');
  });
  test(`T1-FLOW-NEW-PRODUCT ${rid}: «Agregar producto»`, async () => {
    const draft = ED.createDraft(base(rid));
    const cat = require('./source-store').rendererContract(rid).renderedCategories[0];
    const REF = 'tmp:newprod-0001';   // the editor's own ref rule (tmp:…) — a bad ref is silently ignored, so the premise below is asserted
    ED.addProduct(draft, { ref: REF, cat });
    ED.setAddition(draft, REF, 'name', 'Plato Nuevo de Prueba');
    ED.setAddition(draft, REF, 'price', '123');
    const src = ED.draftSource(draft);
    assert.ok(src.items.some((i) => i.ref === REF) && src.structure.item_order.includes(REF), 'premise: the editor added the product');
    const r = await save(rid, src);
    noResidual(r, 'new product');
    assert.ok(r.body.diff.added.some((a) => a.surface === 'item'), `new product: the review lists the addition (${JSON.stringify(r.body.diff.added)})`);
  });
  test(`T1-FLOW-SECTION-RENAME ${rid}: a section rename alone`, async () => {
    const draft = ED.createDraft(base(rid));
    const names = Object.fromEntries(src0.structure.categories.map((c, i) => [c.id, i === 0 ? 'Sección Renombrada' : (c.name || c.id)]));
    ED.setCategoryNames(draft, names);
    noResidual(await save(rid, ED.draftSource(draft)), 'section rename');
  });
}
test('T1-FLOW-OPTION-PRICE la_musa: the drawer prices one option of a required choice', async () => {
  const src = base('la_musa');
  const launcherId = Object.keys(src.structure.variant_items || {})[0];
  assert.ok(launcherId, 'premise: la_musa has a required choice');
  const launcher = src.items.find((it) => String(it.display.id) === String(launcherId));
  const optId = String(src.structure.variant_items[launcherId].variantIds[0]);
  const opt = src.items.find((it) => String(it.display.id) === optId);
  noResidual(await save('la_musa', drawer('la_musa', (it) => it.key === launcher.key, () => [['optionPrice', { key: opt.key, raw: String(opt.price + 4) }]])), 'option price');
});
