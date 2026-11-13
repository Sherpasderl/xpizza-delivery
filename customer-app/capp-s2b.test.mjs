// S2b (PLAN-structure-S2b-r3 §2.5, §5; Codex r1 P2-6) — the customer app and an affected extra (a minted reuse, a rename), over the REAL
// served body (real publish on the Firestore fake → buildPublicMenu) and the REAL server pricing tables:
//   SERVED   the body carries extra_keys { display id → key } ONLY when an affected extra exists; otherwise the body is today's
//   MENU     each served extra carries its extra_key; the deny list matches it by key (a renamed name-mode extra is denied by its kept key)
//   SERIAL   a cart extra sends extra_key (appended last); the server resolves and prices it by that key; items_text shows the served label
// Run: node --test customer-app/capp-s2b.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const F = (p) => require(join(ROOT, 'xpizza-functions', p));
const { adaptMenu } = require('./capp-menu.js');
const { createCart } = require('./capp-cart.js');
const { serialize } = require('./capp-serialize.js');
const { makeDb } = F('catalog/firestore-fake.js');
const { publishVersion } = F('catalog/catalog-publish.js');
const { buildSourceCandidate } = F('catalog/candidate-validate.js');
const { buildPublicMenu } = F('catalog/public-menu.js');
const { buildSourceFromCode } = F('tools/seed-source-store.js');
const { createCatalogReader } = F('catalog/catalog.js');
const { createPricingResolver } = F('catalog/pricing-tables.js');
const CF = F('catalog/catalog-firestore.js');
const { resolveLines } = F('catalog/resolve-lines.js');
const { computeServerTotal } = F('menu-pricing.js');

const clone = (o) => JSON.parse(JSON.stringify(o));
const quiet = async (f) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await f(); } finally { console.log = l; console.warn = w; } };
const MK = 'i_aaaaaaaaaabs';
// two affected extras: [0] renamed (key kept), [1] retired-and-reused under a minted key at a new price; [0] denied for one dish by its KEY
function recorded(rid) {
  const s = clone(buildSourceFromCode(rid));
  const r = s.extras[0]; r.display.name = 'Renombrado S2b';
  const m = s.extras[1]; const old = m.key;
  if (rid === 'la_musa') m.display.id = MK;
  if (Array.isArray(s.structure.extra_order)) s.structure.extra_order = s.structure.extra_order.map((k) => (k === old ? MK : k));
  for (const f of ['extras_by_category', 'extras_by_item']) if (s.structure[f]) for (const v of Object.values(s.structure[f])) if (Array.isArray(v)) { const i = v.indexOf(old); if (i >= 0) v[i] = MK; }
  if (Array.isArray(s.structure.redeem_eligible_extras)) s.structure.redeem_eligible_extras = s.structure.redeem_eligible_extras.map((k) => (k === old ? MK : k));
  m.key = MK; m.display.name = 'Reusado S2b'; m.price += 4; m.display.price = m.price;
  s.frozen_extra_keys = { [r.key]: { display_id: String(r.display.id), field: 'name' }, [MK]: { display_id: String(m.display.id), minted: true, reuses: old } };
  return { s, renamed: r, minted: m };
}
const inputOf = (rid, src) => { const { inputs, built } = buildSourceCandidate(rid, src);
  return { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 'cs2b', ...(built.key_mode == null ? {} : { key_mode: built.key_mode }), ...(built.frozen_keys == null ? {} : { frozen_keys: built.frozen_keys }), ...(built.frozen_extra_keys == null ? {} : { frozen_extra_keys: built.frozen_extra_keys }) }; };
async function served(rid, src) {
  const db = makeDb(); await quiet(() => publishVersion(db, rid, inputOf(rid, src), { expected: { activeVersionId: null } }));
  const m = await quiet(() => buildPublicMenu(db, rid, { known: new Set(['x_pizza', 'la_musa']), isActive: async () => true }));   // the ENDPOINT path (the overlay on: item_keys / extra_keys)
  const reader = createCatalogReader({ getRestaurantDocs: (r) => CF.getRestaurantDocs(db, r) });
  const tables = await quiet(() => createPricingResolver({ reader, alarm: () => {} }).getPricingTables(rid));
  return { env: { rid: m.rid, representation_version: m.representation_version, menu: clone(m.body) }, tables, etag: m.etag };
}

for (const rid of ['x_pizza', 'la_musa']) {
  test(`SERVED ${rid}: extra_keys only when an affected extra exists; otherwise today's body`, async () => {
    const { s, renamed, minted } = recorded(rid);
    const A = await served(rid, s);
    assert.deepEqual([A.env.menu.extra_keys[String(renamed.display.id)], A.env.menu.extra_keys[String(minted.display.id)]], [renamed.key, MK]);
    const B = await served(rid, buildSourceFromCode(rid));
    assert.ok(!('extra_keys' in B.env.menu), 'no affected extra → no map');
  });
  test(`MENU + SERIAL ${rid}: each served extra carries its key; the cart sends extra_key; the server prices it by that key; the text shows the label`, async () => {
    const { s, renamed, minted } = recorded(rid);
    const { env, tables } = await served(rid, s);
    const menu = adaptMenu(env);
    const ex = (k) => menu.extras.find((e) => e.extra_key === k);
    assert.ok(ex(renamed.key) && ex(MK), 'the served extras carry their keys');
    const dish = menu.dishes.find((d) => !d.launcher && menu.extrasFor(d.key).some((e) => e.extra_key === MK));
    assert.ok(dish, 'premise: a dish offers the minted extra');
    const cart = createCart(menu); cart.add(dish.key, [ex(MK).key], 1);
    const body = serialize(cart, menu);
    const line = body.items[0].extras.find((e) => e.extra_key === MK);
    assert.ok(line && Object.keys(line).at(-1) === 'extra_key', `the line extra carries extra_key, appended last (${JSON.stringify(body.items[0].extras)})`);
    assert.match(body.items_text, /\[Reusado S2b\]/, 'the kitchen text shows the label');
    const judged = clone(body);
    assert.deepEqual(resolveLines(rid, judged, tables), { ok: true });
    const t = computeServerTotal(judged.items, rid, tables);
    assert.ok(!t.error, String(t.error)); assert.equal(t.total, dish.price + minted.price, 'priced by the minted key');
  });
}
test('MENU-DENY x_pizza: a RENAMED extra denied for a dish by its kept key stays hidden (the deny list names keys)', async () => {
  const { s, renamed } = recorded('x_pizza');
  const dishKey = s.items.find((i) => i.display.cat === 'individual').key;
  s.structure.exposure.item_overrides = { ...(s.structure.exposure.item_overrides || {}), [dishKey]: { deny_extras: [renamed.key] } };
  const { env } = await served('x_pizza', s);
  const menu = adaptMenu(env); const d = menu.dishes.find((x) => x.name === s.items.find((i) => i.key === dishKey).display.name);
  assert.ok(menu.extras.some((e) => e.extra_key === renamed.key), 'premise: the renamed extra is served with its key');
  assert.ok(!menu.extrasFor(d.key).some((e) => e.extra_key === renamed.key), 'denied by its key');
});
