// S2b (PLAN-structure-S2b-r3 §2.6, Codex r2 P1-3) — the PAID kitchen text. When a resolved line carries an AFFECTED extra (its key is
// label-required: a minted reuse or a rename), the server derives the order's items_text with its OWN byte copy of the capp serializer
// (catalog/capp-serialize.js) from the client's lines and the server LABELS, and refuses a client text that differs —
// items_text_mismatch (409) — judged inside resolveLines (every intake, before any fingerprint, reservation, charge or write) when the
// body carries an items_text. A cart with no affected extra, and a quote body with no items_text, are today's path. Real publish → the real pricing tables; the honest body is
// the REAL capp (adaptMenu → createCart → serialize) over the REAL endpoint body; the kitchen's REAL renderItems (extracted from
// xpizza-kitchen/index.html) and the REAL handheld orderView read the accepted text.
// Run: node --test s2b-paid-text.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = dirname(fileURLToPath(import.meta.url));
const F = (p) => require(join(ROOT, 'xpizza-functions', p));
const { adaptMenu } = require('./customer-app/capp-menu.js');
const { createCart } = require('./customer-app/capp-cart.js');
const { serialize } = require('./customer-app/capp-serialize.js');
const { makeDb } = F('catalog/firestore-fake.js');
const { publishVersion } = F('catalog/catalog-publish.js');
const { buildSourceCandidate } = F('catalog/candidate-validate.js');
const { buildPublicMenu } = F('catalog/public-menu.js');
const { buildSourceFromCode } = F('tools/seed-source-store.js');
const { createCatalogReader } = F('catalog/catalog.js');
const { createPricingResolver } = F('catalog/pricing-tables.js');
const CF = F('catalog/catalog-firestore.js');
const { resolveLines, resolutionRefusal } = F('catalog/resolve-lines.js');
const { orderView } = await import(pathToFileURL(join(ROOT, 'xpizza-handheld/model.js')).href);

function extractFn(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `premise: ${name} exists in the shipped source`);
  let depth = 0; let j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
  return src.slice(i, j + 1);
}
const kdsSrc = readFileSync(join(ROOT, 'xpizza-kitchen/index.html'), 'utf8');
const kdsRender = new Function(`${extractFn(kdsSrc, 'escapeHtml')}\n${extractFn(kdsSrc, 'renderItems')}\nreturn renderItems;`)();

const clone = (o) => JSON.parse(JSON.stringify(o));
const quiet = async (f) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await f(); } finally { console.log = l; console.warn = w; } };
const MK = 'i_aaaaaaaaaabt';
// [0] renamed (key kept), [1] retired-and-reused under a minted key
function recorded(rid) {
  const s = clone(buildSourceFromCode(rid));
  const r = s.extras[0]; const oldR = r.display.name; r.display.name = 'Renombrado S2b';
  const m = s.extras[1]; const old = m.key; const oldM = m.display.name;
  if (rid === 'la_musa') m.display.id = MK;
  if (Array.isArray(s.structure.extra_order)) s.structure.extra_order = s.structure.extra_order.map((k) => (k === old ? MK : k));
  for (const f of ['extras_by_category', 'extras_by_item']) if (s.structure[f]) for (const v of Object.values(s.structure[f])) if (Array.isArray(v)) { const i = v.indexOf(old); if (i >= 0) v[i] = MK; }
  if (Array.isArray(s.structure.redeem_eligible_extras)) s.structure.redeem_eligible_extras = s.structure.redeem_eligible_extras.map((k) => (k === old ? MK : k));
  m.key = MK; m.display.name = 'Reusado S2b';
  s.frozen_extra_keys = { [r.key]: { display_id: String(r.display.id), field: 'name' }, [MK]: { display_id: String(m.display.id), minted: true, reuses: old } };
  return { s, renamed: r, minted: m, oldR, oldM };
}
const inputOf = (rid, src) => { const { inputs, built } = buildSourceCandidate(rid, src);
  return { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 'pt', ...(built.key_mode == null ? {} : { key_mode: built.key_mode }), ...(built.frozen_keys == null ? {} : { frozen_keys: built.frozen_keys }), ...(built.frozen_extra_keys == null ? {} : { frozen_extra_keys: built.frozen_extra_keys }) }; };
async function served(rid, src) {
  const db = makeDb(); await quiet(() => publishVersion(db, rid, inputOf(rid, src), { expected: { activeVersionId: null } }));
  const m = await quiet(() => buildPublicMenu(db, rid, { known: new Set(['x_pizza', 'la_musa']), isActive: async () => true }));
  const reader = createCatalogReader({ getRestaurantDocs: (r) => CF.getRestaurantDocs(db, r) });
  const tables = await quiet(() => createPricingResolver({ reader, alarm: () => {} }).getPricingTables(rid));
  return { menu: adaptMenu({ rid: m.rid, representation_version: m.representation_version, menu: clone(m.body) }), tables };
}
// the honest capp body: a dish with BOTH affected extras ×2, the same dish with the minted one ×1, and a plain dish
function honest(menu, keys) {
  const ex = (k) => menu.extras.find((e) => e.extra_key === k);
  const d = menu.dishes.find((x) => !x.launcher && keys.every((k) => menu.extrasFor(x.key).some((e) => e.extra_key === k)));
  assert.ok(d, 'premise: a dish offers both affected extras');
  const p = menu.dishes.find((x) => !x.launcher && x.key !== d.key);
  const c = createCart(menu); c.add(d.key, keys.map((k) => ex(k).key), 2); c.add(d.key, [ex(keys[1]).key], 1); c.inc(p.key);
  return serialize(c, menu);
}
// the REAL intake judgment: resolveLines (both order intakes call it on the resolution line) and its HTTP refusal
const judge = (rid, body, tables) => { const r = resolveLines(rid, clone(body), tables); return r.ok ? null : resolutionRefusal(r); };
const MISMATCH = { status: 409, body: { error: 'items_text_mismatch' } };

for (const rid of ['x_pizza', 'la_musa']) {
  test(`PT-HONEST ${rid}: the honest capp text is accepted; the real KDS and handheld show both labels`, async () => {
    const { s, renamed } = recorded(rid);
    const { menu, tables } = await served(rid, s);
    const body = honest(menu, [renamed.key, MK]);
    assert.equal(judge(rid, body, tables), null);
    const { items_text: _t, ...quote } = body;   // a quote body without items_text is not judged
    assert.equal(judge(rid, { ...quote, items: quote.items.map((l) => ({ ...l, extras: l.extras.map((e) => ({ ...e, name: 'viejo' })) })) }, tables), null);
    const kds = kdsRender(body.items_text);
    assert.ok(kds.includes('Renombrado S2b') && kds.includes('Reusado S2b'), 'the KDS shows both labels');
    const mods = orderView({ id: 'o1', items_text: body.items_text }).items.map((i) => i.mod).join(' / ');
    assert.ok(mods.includes('Renombrado S2b') && mods.includes('Reusado S2b'), `the handheld shows both labels (${mods})`);
  });
  test(`PT-STALE ${rid}: a paid MINTED and a paid RENAMED extra with a stale client name → items_text_mismatch`, async () => {
    const { s, renamed, oldR, oldM } = recorded(rid);
    const { menu, tables } = await served(rid, s);
    const body = honest(menu, [renamed.key, MK]);
    for (const [label, stale] of [['minted', oldM], ['renamed', oldR]]) {
      const b = clone(body); const from = label === 'minted' ? 'Reusado S2b' : 'Renombrado S2b';
      b.items_text = b.items_text.split(from).join(stale);
      for (const it of b.items) for (const e of it.extras) if (e.name === from) e.name = stale;   // the line's own name stale too: the derivation reads the LABEL
      assert.notEqual(b.items_text, body.items_text, 'premise: the text changed');
      assert.deepEqual(judge(rid, b, tables), MISMATCH, `${label}: refused`);
    }
  });
  test(`PT-NONE ${rid}: a cart with no affected extra is today's path — no derivation, no refusal (any client text)`, async () => {
    const { menu, tables } = await served(rid, buildSourceFromCode(rid));
    const d = menu.dishes.find((x) => !x.launcher && menu.extrasFor(x.key).length);
    const c = createCart(menu); c.add(d.key, [menu.extrasFor(d.key)[0].key], 1);
    const body = serialize(c, menu); body.items_text = 'lo que sea';
    assert.equal(judge(rid, body, tables), null);
  });
}
test('PT-WIRING: both order intakes judge the paid text on the resolution line (resolveLines → resolutionRefusal), before any money step', () => {
  const src = readFileSync(join(ROOT, 'xpizza-functions/index.js'), 'utf8').split('\n');
  const hits = src.filter((l) => l.includes('{ const rl = RL.resolveLines(restaurantId, body, pricingTables); if (!rl.ok) { const rf = RL.resolutionRefusal(rl); return res.status(rf.status).json(rf.body); }'));
  assert.equal(hits.length, 2, 'createOrder + chargeOnlineOrder');
  const rl = readFileSync(join(ROOT, 'xpizza-functions/catalog/resolve-lines.js'), 'utf8');
  const top = rl.slice(rl.indexOf('function resolveLines('), rl.indexOf('const items = body.items;'));
  assert.ok(top.includes("require('./paid-text').paidTextRefusal(rid, body, tables)"), 'resolveLines judges the paid text before the lines are read');
});
// KDS-FREE (§4, rewards-redeem-intake.js prepareRedemption): a REDEEMED affected extra's free kitchen line is named by the server LABEL,
// never the client's redeem name; any other free item keeps today's name (the client's sanitized name, or its id)
for (const rid of ['x_pizza', 'la_musa']) {
  test(`KDS-FREE ${rid}: freeLineLabel gives the label for an affected extra, null otherwise (today's name)`, async () => {
    const { s, renamed } = recorded(rid);
    const { tables } = await served(rid, s);
    const { freeLineLabel } = F('catalog/paid-text.js');
    assert.deepEqual([freeLineLabel(tables, MK), freeLineLabel(tables, renamed.key)], ['Reusado S2b', 'Renombrado S2b']);
    const plain = s.extras[2].key;
    assert.equal(freeLineLabel(tables, plain), null, 'an unaffected extra: today\'s name');
    const { tables: t0 } = await served(rid, buildSourceFromCode(rid));
    assert.equal(freeLineLabel(t0, s.extras[0].key), null, 'no affected extra at all: today');
  });
}
test('KDS-FREE wiring: prepareRedemption names each free line by freeLineLabel first, else today\'s name', () => {
  const src = readFileSync(join(ROOT, 'xpizza-functions/rewards-redeem-intake.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function prepareRedemption('), src.indexOf('const appends = freeItems.map('));
  assert.ok(fn.includes("name: require('./catalog/paid-text').freeLineLabel(tables, fi.item_id) != null ? sanitizeName(require('./catalog/paid-text').freeLineLabel(tables, fi.item_id), 80) : (nameMap[fi.item_id] || sanitizeName(fi.item_id, 80)),"), 'the free line reads the label');
});
