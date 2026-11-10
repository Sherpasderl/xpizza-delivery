// Customer app S1a1 (PLAN-capp-S1.FINAL §2–§4) — the menu adapter, the per-instance cart and the serializer, over the REAL
// served envelopes (the S0 rig's real publish: x_pizza, la_musa, the r3 synthetic third brand) and the REAL server pricing
// (menu-pricing computeServerTotal + factura pricedLineItems over each brand's published tables). Light: no emulator.
// Run: node --test customer-app/capp-cart.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { adaptMenu, extraSupported } = require('./capp-menu.js');
const { createCart, fromLegacy, sigOf, MAX_QTY } = require('./capp-cart.js');
const { serialize, issuedSnapshot, resendBody, ITEMS_TEXT_LIMIT } = require('./capp-serialize.js');
const { SYSTEM_VERSION } = require('./capp-version.js');
const { computeServerTotal } = require(join(ROOT, 'xpizza-functions/menu-pricing.js'));
const { pricedLineItems } = require(join(ROOT, 'xpizza-functions/factura/pricing.js'));
const { provisionBrand, boot } = await import(join(ROOT, 'xpizza-functions/contract/capp/capture.mjs'));
const { provisionThirdBrand } = await import(join(ROOT, 'xpizza-functions/contract/capp/third-brand-fork.mjs'));
const { candidateFromSource } = require(join(ROOT, 'xpizza-functions/contract/third-brand.js'));
const { buildSourceFromCode } = require(join(ROOT, 'xpizza-functions/tools/seed-source-store'));
const { makeDb } = require(join(ROOT, 'xpizza-functions/catalog/firestore-fake'));
const { publishVersion } = require(join(ROOT, 'xpizza-functions/catalog/catalog-publish'));
const { buildPublicMenu } = require(join(ROOT, 'xpizza-functions/catalog/public-menu'));
const { orderContentKey } = require(join(ROOT, 'xpizza-functions/order-dedup.js'));
// a brand's REAL source with some extras' display names changed, published through the real publish path into an in-memory
// catalog, served as getPublicMenu serves it
async function publishRenamed(rid, map) {
  const db = makeDb();
  // the DISPLAY names only (the pricing keys stay: the identity bootstrap refuses an unpriced key)
  const src = buildSourceFromCode(rid);
  for (const e of src.extras) if (e.display && Object.prototype.hasOwnProperty.call(map, e.display.name)) e.display = { ...e.display, name: map[e.display.name] };
  await quiet(() => publishVersion(db, rid, { ...candidateFromSource(rid, src), source_sha: 'capp-s1-renamed' }, { expected: { activeVersionId: null } }));
  const m = await quiet(() => buildPublicMenu(db, rid, { known: new Set([rid]), isActive: async () => true }));
  return { rid: m.rid, representation_version: m.representation_version, menu: m.body };
}
const { closeAll, settle } = await import(join(ROOT, 'form-harness.mjs'));

const quiet = async (fn) => { const w = console.warn, l = console.log; console.warn = console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };
const PROV = {};
for (const rid of ['x_pizza', 'la_musa']) PROV[rid] = await quiet(() => provisionBrand(rid));
const THIRD = await quiet(() => provisionThirdBrand());
const MENU = { x_pizza: adaptMenu(PROV.x_pizza.envelope), la_musa: adaptMenu(PROV.la_musa.envelope), r3: adaptMenu(THIRD.envelope) };
const BRANDS = ['x_pizza', 'la_musa'];
const configurable = (m) => m.dishes.find((d) => !d.launcher && m.extrasFor(d.key).length >= 2);
const plainDish = (m, not) => m.dishes.find((d) => !d.launcher && d.key !== not);
const serverCents = (rid, items) => { const r = computeServerTotal(items, rid, PROV[rid].tables); assert.equal(r.error, null, r.error); return r.total * 100; };

test('version: SYSTEM_VERSION is 0.1.0 (pre-launch semver)', () => {
  assert.match(SYSTEM_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(SYSTEM_VERSION, '0.1.0');
});

test('adapter: the REAL served envelope → keys by dish_id, legacy fields kept, extras per dish, groups, gates from the envelope', () => {
  for (const rid of BRANDS) {
    const m = MENU[rid]; const env = PROV[rid].envelope.menu;
    assert.equal(m.dishes.length, env.dishes.length);
    for (const d of m.dishes) { const s = env.dishes.find((x) => String(x.id) === String(d.id)); assert.equal(d.key, String(s.dish_id)); assert.equal(d.name, s.name); assert.equal(d.price, s.price); }
    const d = configurable(m); assert.ok(d, `${rid}: a dish with extras`);
    const ex = m.extrasFor(d.key);
    const cats = (env.extras_by_item && env.extras_by_item[String(d.id)]) || env.extras_by_category[String(d.cat)];
    assert.deepEqual(ex.map((e) => e.key).sort(), env.extras.filter((e) => cats.includes(e.cat)).map((e) => String(e.extra_id)).sort().filter((k) => ex.some((x) => x.key === k)));
    assert.deepEqual([...m.pickupOnlyCats], env.pickup_only_cats || []);
    assert.deepEqual([...m.weekendOnlyCats], env.weekend_only_cats || []);
  }
  const g = Object.entries(MENU.la_musa.groups); assert.ok(g.length > 0, 'premise: the served menu has a variant launcher');
  const [lk, grp] = g[0];
  assert.ok(MENU.la_musa.dish(lk).launcher && grp.choices.length >= 2 && grp.choices.every((c) => MENU.la_musa.dish(c).variantOf));
  assert.equal(MENU.r3.extras.length, 0, 'the r3 envelope carries no extras (S0 rig) — S1a2 provisions toggle extras through the real publish');
});

test('adapter: extras are TOGGLES only — any quantity semantics → unsupported (never offered as selectable)', () => {
  assert.equal(extraSupported({ id: 'a', price: 1 }), true);
  assert.equal(extraSupported({ id: 'a', price: 1, max: 1 }), true);
  for (const e of [{ max: 2 }, { max: 0 }, { max_qty: 3 }, { qty: 2 }, { step: 1 }, { min: 1 }]) assert.equal(extraSupported({ id: 'a', price: 1, ...e }), false, JSON.stringify(e));
  for (const rid of BRANDS) assert.ok(MENU[rid].extras.every((e) => e.supported), `${rid}: today every served extra is a toggle`);
  // one INCOMPATIBLE stepper case on the real envelope: the extra is unsupported, the cart refuses it, the serializer refuses it
  const env = JSON.parse(JSON.stringify(PROV.la_musa.envelope)); env.menu.extras[0].max = 2;
  const m = adaptMenu(env); const bad = m.extras[0]; assert.equal(bad.supported, false);
  const dish = m.dishes.find((d) => !d.launcher && m.extrasFor(d.key).some((e) => e.key === bad.key));
  const cart = createCart(m);
  assert.throws(() => cart.add(dish.key, [bad.key], 1), (e) => e.code === 'unsupported_extra_quantity');
  assert.equal(cart.count(), 0);
  const raw = createCart(MENU.la_musa); raw.add(dish.key, [bad.key], 1);   // the same line built where the extra was a toggle…
  assert.throws(() => serialize({ lines: () => raw.lines() }, m), (e) => e.code === 'unsupported_extra_quantity', '…is refused at serialization');
  const r = createCart(m).hydrate(raw.snapshot());
  assert.equal(r.dropped, 1, 'a restored line carrying it is dropped and counted');
});

test('cart: one write point — pad / truncate / re-index; no instance ≥ qty; menu "−" drops the last', () => {
  for (const rid of BRANDS) {
    const m = MENU[rid]; const d = configurable(m); const [e1, e2] = m.extrasFor(d.key);
    const c = createCart(m);
    c.inc(d.key); c.inc(d.key); c.add(d.key, [e1.key], 1);
    assert.equal(c.count(), 3);
    // the 2026-10-13 hotfix shape: extras on the LAST instance, then the menu "−" → that instance goes, no stale extra remains
    c.dec(d.key);
    let l = c.lines()[0]; assert.equal(l.qty, 2); assert.equal(l.ex.length, 2); assert.ok(l.ex.every((x) => sigOf(x) === ''));
    // a middle removal re-indexes 0..qty-1
    c.add(d.key, [e2.key], 1); c.inc(d.key);
    c.lineDec(d.key, sigOf({ [e2.key]: 1 }));
    l = c.lines()[0]; assert.equal(l.qty, 3); assert.equal(l.ex.length, 3); assert.ok(l.ex.every((x) => sigOf(x) === ''));
    c.setQty(d.key, 1); l = c.lines()[0]; assert.deepEqual([l.qty, l.ex.length], [1, 1]);
    c.setQty(d.key, 0); assert.equal(c.lines().length, 0);
  }
});

test('cart: line "+" clones THAT configuration, line "−" removes one OF THAT configuration; grouping is derived', () => {
  for (const rid of BRANDS) {
    const m = MENU[rid]; const d = configurable(m); const [e1, e2] = m.extrasFor(d.key);
    const c = createCart(m);
    c.add(d.key, [e1.key], 2); c.inc(d.key); c.add(d.key, [e2.key, e1.key], 1);
    const sigA = sigOf({ [e1.key]: 1 }); const sigB = sigOf({ [e1.key]: 1, [e2.key]: 1 });
    assert.deepEqual(c.groups().map((g) => [g.sig, g.n]), [[sigA, 2], ['', 1], [sigB, 1]]);
    c.lineInc(d.key, sigB); c.lineDec(d.key, sigA);
    assert.deepEqual(c.groups().map((g) => [g.sig, g.n]), [[sigA, 1], ['', 1], [sigB, 2]]);
    const total = c.groups().reduce((s, g) => s + g.total, 0);
    assert.equal(total, d.price * 4 + e1.price * 3 + e2.price * 2);
  }
});

test('cart: Editar replaces EVERY instance of the group (a fresh add × n); a choice edit moves them into the target line', () => {
  const m = MENU.x_pizza; const d = configurable(m); const [e1, e2] = m.extrasFor(d.key);
  const c = createCart(m); c.add(d.key, [e1.key], 2); c.add(d.key, [e2.key], 1);
  c.edit(d.key, sigOf({ [e1.key]: 1 }), [e2.key]);
  assert.deepEqual(c.groups().map((g) => [g.sig, g.n]), [[sigOf({ [e2.key]: 1 }), 3]], 'edit then regroup');
  const lm = MENU.la_musa; const [lk, grp] = Object.entries(lm.groups)[0]; const [ca, cb] = grp.choices;
  const k = createCart(lm); k.add(ca, [], 2); k.add(cb, [], 1);
  assert.throws(() => k.add(lk, [], 1), (e) => e.code === 'choice_required', 'a launcher itself is never orderable');
  k.edit(ca, '', [], cb);
  assert.deepEqual(k.lines().map((l) => [l.key, l.qty]), [[cb, 3]], 'edited INTO the existing choice line');
});

test('cart: refusals — an extra the menu does not offer this dish; an unknown dish', () => {
  const m = MENU.x_pizza; const d = configurable(m); const other = m.extras.find((e) => !m.extrasFor(d.key).some((x) => x.key === e.key));
  const c = createCart(m);
  if (other) assert.throws(() => c.add(d.key, [other.key], 1), (e) => e.code === 'extra_not_offered');
  assert.throws(() => c.add('nope', [], 1), (e) => e.code === 'unknown_dish');
  assert.throws(() => c.inc('nope'), (e) => e.code === 'unknown_dish');
});

test('cart: hydrate drops (and counts) what no longer fits — unknown dish, launcher, quantity ≠ 1, an extra not offered', () => {
  const m = MENU.la_musa; const d = configurable(m); const [e1] = m.extrasFor(d.key); const [lk] = Object.keys(m.groups);
  const ok = { key: d.key, qty: 1, ex: [{ [e1.key]: 1 }], added: 1 };
  const snap = { v: 2, lines: [ok, { key: 'gone', qty: 2, ex: [{}, {}], added: 2 }, { key: lk, qty: 1, ex: [{}], added: 3 },
    { key: plainDish(m, d.key).key, qty: 1, ex: [{ [e1.key]: 2 }], added: 4 }] };
  const c = createCart(m); const r = c.hydrate(snap);
  assert.equal(r.dropped, 4);
  assert.deepEqual(c.lines().map((l) => [l.key, l.qty]), [[d.key, 1]]);
});

test('serializer: per-instance lines with BOTH legacy keys; the REAL server total == the displayed subtotal == Σ groups; factura reconciles', () => {
  for (const rid of BRANDS) {
    const m = MENU[rid]; const d = configurable(m); const [e1, e2] = m.extrasFor(d.key); const p = plainDish(m, d.key);
    const c = createCart(m); c.add(d.key, [e1.key], 2); c.add(d.key, [e1.key, e2.key], 1); c.inc(d.key); c.inc(p.key); c.inc(p.key);
    const grp = Object.values(m.groups)[0]; if (grp) c.add(grp.choices[0], [], 1);
    const s = serialize(c, m);
    assert.equal(s.items.length, c.count(), 'one items[] line per instance');
    assert.ok(s.items.every((it) => it.qty === 1 && 'id' in it && 'name' in it && it.dish_id != null));
    assert.ok(s.items.every((it) => it.subtotal === it.price + it.extras.reduce((a, e) => a + m.extra(e.extra_id).price, 0)), 'F1: subtotal incl. extras');
    assert.equal(s.subtotal_cents, c.subtotalCents());
    assert.equal(serverCents(rid, s.items), s.subtotal_cents, `${rid}: computeServerTotal == displayed subtotal`);
    // factura prices by NAME (factura/pricing.js) for the platform-factura restaurant: its N structured lines reconcile
    const f = pricedLineItems(s.items, PROV[rid].tables.menu, PROV[rid].tables.extras);
    if (rid === 'x_pizza') {
      assert.equal(f.error, null, f.error);
      assert.equal(f.items.length, s.items.length, 'today\'s builder: one factura line per items[] line — the factura-grouping server slice (owner ruling b, after S1a2) regroups identical instances');
      assert.equal(f.items.reduce((a, l) => a + l.line_gross_cents, 0), s.subtotal_cents, 'factura line gross reconciles to the food subtotal');
    }
  }
});

test('serializer: items_text — one row per configuration group, " | " between groups, " + " between extras, deterministic', () => {
  const m = MENU.x_pizza; const d = configurable(m); const [e1, e2] = m.extrasFor(d.key); const p = plainDish(m, d.key);
  const c = createCart(m); c.add(d.key, [e2.key, e1.key], 2); c.inc(p.key); c.inc(d.key);
  const names = [e1, e2].sort((a, b) => (a.key < b.key ? -1 : 1)).map((e) => e.name).join(' + ');
  const s = serialize(c, m);
  assert.equal(s.items_text, `2x ${d.name} (L${d.price}) [${names}] | 1x ${d.name} (L${d.price}) | 1x ${p.name} (L${p.price})`);
  assert.ok(!/,/.test(s.items_text));
  const again = serialize(c, m);
  assert.equal(JSON.stringify(again), JSON.stringify(s), 'byte-identical re-serialization');
  const h = createCart(m); h.hydrate(c.snapshot());
  assert.equal(JSON.stringify(serialize(h, m)), JSON.stringify(s), 'a restored cart serializes byte-identically');
  const snap = issuedSnapshot({ items: s.items, items_text: s.items_text });
  c.inc(p.key);
  assert.deepEqual(resendBody(snap), { items: s.items, items_text: s.items_text }, 'the ISSUED body is resent, not the edited cart');
});

test('serializer: refusals — an unsafe extra label, an empty cart, the 1,500-character limit (1,500 accepted, 1,501 refused)', () => {
  for (const bad of ['Arroz, Blanco', 'Arroz | Blanco', 'Arroz + Blanco', 'Arroz [Blanco]']) {
    const env = JSON.parse(JSON.stringify(PROV.la_musa.envelope)); const k = String(env.menu.extras[0].extra_id);
    const okm = adaptMenu(env); env.menu.extras[0].name = bad; const m = adaptMenu(env);
    assert.equal(m.extra(k).supported, false, `${bad}: an unsafe label is never offered`);
    const d = okm.dishes.find((x) => !x.launcher && okm.extrasFor(x.key).some((e) => e.key === k));
    assert.throws(() => createCart(m).add(d.key, [k], 1), (e) => e.code === 'unsupported_extra_quantity');
    const c = createCart(okm); c.add(d.key, [k], 1);   // built where the label was safe…
    assert.throws(() => serialize({ lines: () => c.lines() }, m), (e) => e.code === 'unsupported_extra_quantity' || e.code === 'unsafe_extra_label', `${bad}: …refused at serialization`);
  }
  assert.throws(() => serialize(createCart(MENU.la_musa), MENU.la_musa), (e) => e.code === 'empty_cart');
  // a cart whose text is EXACTLY the limit (one dish, its served name lengthened in a copy of the real envelope), then one more
  const pad = JSON.parse(JSON.stringify(PROV.x_pizza.envelope));
  const dish = adaptMenu(pad).dishes.find((x) => !x.launcher);
  const base = `1x ${dish.name} (L${dish.price})`;
  const d0 = pad.menu.dishes.find((x) => String(x.id) === String(dish.id));
  d0.name = 'N'.repeat(ITEMS_TEXT_LIMIT - base.length + dish.name.length);
  const pm = adaptMenu(pad); const pc = createCart(pm); pc.inc(dish.key);
  assert.equal(serialize(pc, pm).items_text.length, ITEMS_TEXT_LIMIT, 'exactly 1,500 is accepted');
  d0.name += 'N'; const pm2 = adaptMenu(pad); const pc2 = createCart(pm2); pc2.inc(dish.key);
  assert.throws(() => serialize(pc2, pm2), (e) => e.code === 'cart_text_too_long', '1,501 is refused');
});

test('legacy: the REAL live La Musa page\'s line-level cart → instance 0 (total unchanged); a quantity ≠ 1 is dropped and counted', async () => {
  const { w } = await quiet(() => boot('la-musa-orders', PROV.la_musa.envelope));
  try {
    const m = MENU.la_musa; const d = configurable(m); const [e1] = m.extrasFor(d.key);
    w.chg(d.id, 2); await settle();
    w.eval(`pizzaExtras[${JSON.stringify(String(d.id))}] = { ${JSON.stringify(String(e1.id))}: 1 }`);
    const old = w.snapshotForm();
    const dishOf = (k) => (m.dishes.find((x) => String(x.id) === String(k)) || {}).key;
    const extraOf = (k) => (m.extras.find((x) => String(x.id) === String(k)) || {}).key;
    const c = createCart(m); const r = c.hydrate(fromLegacy({ lines: old.cart.lines, extras: old.extras }, dishOf, extraOf));
    assert.equal(r.dropped, 0);
    assert.deepEqual(c.groups().map((g) => [g.sig, g.n]), [[sigOf({ [e1.key]: 1 }), 1], ['', 1]], 'the line-level extra moves to instance 0');
    assert.equal(c.subtotalCents(), (d.price * 2 + e1.price) * 100, 'the total is unchanged');
    w.eval(`pizzaExtras[${JSON.stringify(String(d.id))}] = { ${JSON.stringify(String(e1.id))}: 2 }`);
    const old2 = w.snapshotForm();
    const c2 = createCart(m); const r2 = c2.hydrate(fromLegacy({ lines: old2.cart.lines, extras: old2.extras }, dishOf, extraOf));
    assert.equal(r2.dropped, 2, 'a line-level quantity 2 (a stepper) cannot be carried by S1 → the line is dropped and counted');
  } finally { closeAll(); }
});

test('P1 regression (REAL publish): extras «B», «A» and «B + A» — the ambiguous label is refused, so two different configurations can never share a text / content key', async () => {
  // the id-keyed restaurant: its display names are not pricing keys, so three real extras of one category can be relabelled
  const cat = PROV.la_musa.envelope.menu.extras[0].cat;
  const three = PROV.la_musa.envelope.menu.extras.filter((e) => e.cat === cat).slice(0, 3).map((e) => e.name);
  assert.equal(three.length, 3, 'premise: three extras in one category');
  const env = await publishRenamed('la_musa', { [three[0]]: 'B', [three[1]]: 'A', [three[2]]: 'B + A' });
  const m = adaptMenu(env);
  const [eB, eA, eBA] = ['B', 'A', 'B + A'].map((n) => m.extras.find((e) => e.name === n));
  assert.ok(eB && eA && eBA, `premise: the published menu serves the three labels (${m.extras.map((e) => e.name).join(' / ')})`);
  assert.equal(eBA.supported, false, 'the ambiguous label is not offered');
  const d = m.dishes.find((x) => !x.launcher && [eB, eA, eBA].every((e) => m.extrasFor(x.key).some((y) => y.key === e.key)));
  assert.ok(d, 'premise: one dish offers all three');
  assert.throws(() => createCart(m).add(d.key, [eBA.key], 1), (e) => e.code === 'unsupported_extra_quantity');
  const two = createCart(m); two.add(d.key, [eB.key, eA.key], 1);
  const t = serialize(two, m).items_text;
  assert.match(t, /\[(A \+ B|B \+ A)\]/);
  // the collision Codex reproduced: the only text «B + A» could produce is the two-extra configuration's — it can no longer be built
  const phone = '99887766';
  assert.ok(orderContentKey({ phone, itemsText: t, orderType: 'delivery', scheduledFor: null }), 'premise: the two-extra configuration has its content key');
});

test('P2 adapter: per-item extra categories are UNIONED with the category defaults (the shipped forms\' rule)', () => {
  const m = MENU.la_musa; const env = PROV.la_musa.envelope.menu;
  const [itemId, extraCats] = Object.entries(env.extras_by_item)[0];
  const d = m.dishes.find((x) => String(x.id) === itemId);
  const want = new Set([...(env.extras_by_category[String(d.cat)] || []), ...extraCats]);
  const got = new Set(m.extrasFor(d.key).map((e) => e.cat));
  assert.deepEqual([...got].sort(), [...want].filter((c) => env.extras.some((e) => e.cat === c)).sort(), `${d.name}: category + per-item extra categories`);
  const rice = m.extrasFor(d.key).find((e) => (env.extras_by_category[String(d.cat)] || []).includes(e.cat));
  assert.ok(rice, `${d.name} keeps its category extras`);
  const c = createCart(m); c.add(d.key, [rice.key], 2);
  assert.deepEqual(createCart(m).hydrate(c.snapshot()), { dropped: 0 }, 'restoring two instances with a category extra drops nothing');
});

test('P2 cart: ONE quantity policy — every write refuses over MAX_QTY (no clamp), so "+" never reduces a quantity', () => {
  const m = MENU.la_musa; const d = configurable(m); const [e1] = m.extrasFor(d.key); const p = plainDish(m, d.key);
  assert.equal(MAX_QTY, 50);
  const c = createCart(m);
  assert.throws(() => c.add(d.key, [e1.key], 52), (e) => e.code === 'qty_limit');
  assert.equal(c.count(), 0, 'a refused add leaves no line behind');
  c.add(d.key, [e1.key], 50);
  assert.throws(() => c.inc(d.key), (e) => e.code === 'qty_limit'); assert.equal(c.count(), 50, 'menu "+" at the limit: refused, never reduced');
  assert.throws(() => c.lineInc(d.key, sigOf({ [e1.key]: 1 })), (e) => e.code === 'qty_limit'); assert.equal(c.count(), 50, 'line "+" at the limit: refused');
  assert.throws(() => c.setQty(d.key, 51), (e) => e.code === 'qty_limit'); assert.equal(c.count(), 50);
  c.dec(d.key); assert.equal(c.count(), 49, '"−" removes exactly one');
  c.add(p.key, [], 2); assert.throws(() => c.edit(p.key, '', [], d.key), (e) => e.code === 'qty_limit');
  assert.deepEqual(c.lines().map((l) => [l.key, l.qty]), [[d.key, 49], [p.key, 2]], 'an edit that would exceed the target line is refused BEFORE any write');
  const over = { v: 2, lines: [{ key: d.key, qty: 51, ex: Array.from({ length: 51 }, () => ({})), added: 1 }] };
  assert.deepEqual(createCart(m).hydrate(over), { dropped: 1 }, 'a restored line over the limit is dropped and counted as ONE unavailable line');
  // every requested quantity is validated BEFORE coercion or allocation (codex r2): no wrap-around, no huge array, no change
  const before = JSON.stringify(c.snapshot());
  const realFrom = Array.from; let allocated = 0;
  Array.from = function (...a) { allocated += 1; return realFrom.apply(this, a); };
  try {
    for (const [label, fn] of [['add(4294967297)', () => c.add(p.key, [], 4294967297)], ['setQty(2147483648)', () => c.setQty(d.key, 2147483648)],
      ['setQty(100000)', () => c.setQty(d.key, 100000)], ['setQty(-1)', () => c.setQty(d.key, -1)], ['setQty(1.5)', () => c.setQty(d.key, 1.5)],
      ['add(0)', () => c.add(p.key, [], 0)], ['add("2")', () => c.add(p.key, [], '2')]]) {
      assert.throws(fn, (e) => e.code === 'qty_limit', `${label} is refused`);
      assert.equal(JSON.stringify(c.snapshot()), before, `${label}: the cart is unchanged`);
    }
    assert.equal(allocated, 0, 'no instance array was allocated for a refused quantity');
  } finally { Array.from = realFrom; }
  const huge = { v: 2, lines: [{ key: d.key, qty: 4294967297, ex: [], added: 1 }] };
  assert.deepEqual(createCart(m).hydrate(huge), { dropped: 1 }, 'a restored absurd quantity is refused before its instances are read');
  const twice = { v: 2, lines: [{ key: d.key, qty: 30, ex: Array.from({ length: 30 }, () => ({})), added: 1 }, { key: d.key, qty: 30, ex: Array.from({ length: 30 }, () => ({})), added: 2 }] };
  const h = createCart(m);
  assert.deepEqual(h.hydrate(twice), { dropped: 30 }, 'hydrate goes through the ONE write point: the same dish restored twice merges, and the part over 50 is refused');
  assert.deepEqual(h.lines().map((l) => [l.key, l.qty]), [[d.key, 30]]);
});

test('P2 issued snapshot: deeply immutable — the resent body can never differ from what was issued', () => {
  const m = MENU.x_pizza; const d = configurable(m); const c = createCart(m); c.add(d.key, [m.extrasFor(d.key)[0].key], 2);
  const body = { ...serialize(c, m) }; const snap = issuedSnapshot(body); const before = JSON.stringify(resendBody(snap));
  body.items[0].qty = 9;
  const r = resendBody(snap); r.items[0].qty = 9;
  assert.throws(() => { 'use strict'; snap.json = '{}'; }, TypeError);
  assert.equal(JSON.stringify(resendBody(snap)), before, 'neither the source body nor a resent copy reaches the snapshot');
});

test('cart: setInstance dresses ONE instance through the single write point (validated; others untouched)', () => {
  const m = MENU.x_pizza; const d = configurable(m); const [e1, e2] = m.extrasFor(d.key);
  const c = createCart(m); c.inc(d.key); c.inc(d.key);
  c.setInstance(d.key, 1, [e2.key, e1.key]);
  assert.deepEqual(c.lines()[0].ex, [{}, { [e1.key]: 1, [e2.key]: 1 }].map((x) => Object.fromEntries(Object.entries(x).sort())));
  c.setInstance(d.key, 1, []);
  assert.deepEqual(c.lines()[0].ex, [{}, {}]);
  assert.throws(() => c.setInstance(d.key, 2, []), (e) => e.code === 'bad_instance');
  const other = m.extras.find((e) => !m.extrasFor(d.key).some((x) => x.key === e.key));
  if (other) assert.throws(() => c.setInstance(d.key, 0, [other.key]), (e) => e.code === 'extra_not_offered');
  assert.deepEqual(c.lines()[0].ex, [{}, {}], 'a refused write changes nothing');
});

// ── S3 (D4c-grill/item-s1/S3-DESIGN.md D1/D2): the line's item_key from the served map; the server's own stage judges every body ──
const { published: s3Published } = await import(join(ROOT, 'item-s3-fixtures.mjs'));
const { resolveLines } = require(join(ROOT, 'xpizza-functions/catalog/resolve-lines.js'));
const S3 = {
  x_pizza: await quiet(() => s3Published('x_pizza')),
  la_musa: await quiet(() => s3Published('la_musa')),
  renamed: await quiet(() => s3Published('x_pizza', { rename: { key: 'Carnivora', to: 'Carnívora Suprema' } })),
  minted: await quiet(() => s3Published('la_musa', { mint: { name: 'Bao Nuevo', key: 'i_aaaaaaaaaaac' } })),
};
const s3Body = (P, cart, m) => ({ items: serialize(cart, m).items });
const noKey = (items) => items.map((l) => { const { item_key, ...rest } = l; return rest; });

test('S3 adapter: each dish carries the served item_key (the map keyed by display id); absent / malformed → null', () => {
  for (const rid of BRANDS) {
    const env = S3[rid].env; const m = adaptMenu(env);
    assert.ok(Object.keys(env.menu.item_keys).length === env.menu.dishes.length, `premise: the endpoint body maps every dish (${rid})`);
    for (const d of m.dishes) assert.equal(d.item_key, env.menu.item_keys[String(d.id)], `🔴 ${rid}: a dish carries its served item_key (S3-CAPP-ADAPT)`);
    const bare = JSON.parse(JSON.stringify(env)); delete bare.menu.item_keys;
    assert.ok(adaptMenu(bare).dishes.every((d) => d.item_key === null), `🔴 ${rid}: no map → item_key null (S3-CAPP-ADAPT-ABSENT)`);
    const bad = JSON.parse(JSON.stringify(env)); const [a, b] = bad.menu.dishes; bad.menu.item_keys[String(a.id)] = 7; bad.menu.item_keys[String(b.id)] = '';
    const mb = adaptMenu(bad);
    assert.deepEqual([mb.dish(m.dishes[0].key).item_key, mb.dish(m.dishes[1].key).item_key], [null, null], `🔴 ${rid}: a non-string or empty entry is no key (S3-CAPP-ADAPT-MALFORMED)`);
  }
});

test('S3 serializer (D1): item_key appended LAST; name kept; id kept only when it IS the key; no map = today\'s exact lines; the stage accepts', () => {
  for (const rid of BRANDS) {
    const P = S3[rid]; const m = adaptMenu(P.env); const d = configurable(m); const [e1] = m.extrasFor(d.key); const p = plainDish(m, d.key);
    const c = createCart(m); c.add(d.key, [e1.key], 1); c.inc(p.key);
    const s = serialize(c, m);
    for (const line of s.items) {
      const dish = m.dishes.find((x) => String(x.dish_id) === String(line.dish_id));
      assert.equal(line.item_key, dish.item_key, `🔴 ${rid}: the line carries the dish's item_key (S3-CAPP-LINE-KEY)`);
      assert.equal(Object.keys(line).at(-1), 'item_key', `🔴 ${rid}: …appended LAST (S3-CAPP-LINE-LAST)`);
      assert.equal(line.name, dish.name, `${rid}: the name is kept`);
      assert.equal('id' in line, String(dish.id) === dish.item_key, `🔴 ${rid}: the id is kept exactly when it equals the key (S3-CAPP-LINE-ID)`);
    }
    assert.deepEqual(resolveLines(rid, JSON.parse(JSON.stringify({ items: s.items })), P.tables), { ok: true }, `${rid}: the server's stage accepts the body`);
    // no map: the same cart serializes to today's exact lines (id AND name, no item_key)
    const bare = JSON.parse(JSON.stringify(P.env)); delete bare.menu.item_keys;
    const mb = adaptMenu(bare); const cb = createCart(mb); cb.add(d.key, [e1.key], 1); cb.inc(p.key);
    const sb = serialize(cb, mb);
    assert.ok(sb.items.every((l) => !('item_key' in l) && 'id' in l && 'name' in l), `🔴 ${rid}: no map → today's lines, both legacy keys (S3-CAPP-NOMAP)`);
    assert.deepEqual(sb.items.map((l) => l.name), s.items.map((l) => l.name));
    assert.equal(sb.items_text, s.items_text, `${rid}: items_text is untouched by S3`);
  }
});

test('S3 serializer: a RENAMED x_pizza dish → {name: new label, item_key: kept key} resolves; a MINTED la_musa dish → item_key ALONE resolves', () => {
  {
    const P = S3.renamed; const m = adaptMenu(P.env); const d = m.dishes.find((x) => x.name === 'Carnívora Suprema');
    assert.ok(d && d.item_key === 'Carnivora', 'premise: the renamed dish is served under its new label with its kept key');
    const c = createCart(m); c.inc(d.key);
    const body = s3Body(P, c, m); const line = body.items[0];
    assert.deepEqual([line.name, line.item_key, 'id' in line], ['Carnívora Suprema', 'Carnivora', false], '🔴 the renamed line (S3-CAPP-RENAME-LINE)');
    assert.deepEqual(resolveLines('x_pizza', JSON.parse(JSON.stringify(body)), P.tables), { ok: true }, '🔴 the server resolves it (S3-CAPP-RENAME-RESOLVE)');
    assert.equal(resolveLines('x_pizza', { items: noKey(body.items) }, P.tables).code, 'menu_changed', 'premise: without item_key it is the server\'s menu_changed');
  }
  {
    const P = S3.minted; const m = adaptMenu(P.env); const d = m.dishes.find((x) => x.name === 'Bao Nuevo');
    assert.ok(d && d.id === 'bao_nuevo' && d.item_key === 'i_aaaaaaaaaaac', 'premise: the minted dish keeps today\'s id; its key is opaque');
    const c = createCart(m); c.inc(d.key);
    const body = s3Body(P, c, m); const line = body.items[0];
    assert.deepEqual([line.item_key, 'id' in line], ['i_aaaaaaaaaaac', false], '🔴 the minted line sends item_key ALONE (S3-CAPP-MINT-NOID)');
    assert.deepEqual(resolveLines('la_musa', JSON.parse(JSON.stringify(body)), P.tables), { ok: true }, '🔴 the server resolves it (S3-CAPP-MINT-RESOLVE)');
    assert.equal(resolveLines('la_musa', { items: [{ id: 'bao_nuevo', ...line }] }, P.tables).code, 'invalid_line', 'premise: with its display id it is the server\'s invalid_line');
  }
});

test('S3 deny list: a renamed dish\'s denied extra (the eligibility deny keyed by its item_key) is never offered', () => {
  const P = S3.renamed; const env = JSON.parse(JSON.stringify(P.env)); const m0 = adaptMenu(env);
  const d = m0.dishes.find((x) => x.name === 'Carnívora Suprema'); const offered = m0.extrasFor(d.key);
  assert.ok(offered.length >= 2, 'premise: the renamed dish offers extras');
  const victim = offered[0];
  // the served eligibility deny map, keyed as the server keys it (extras-eligibility.js:89 denyLegacy[itemKey]) — by the ITEM KEY
  env.menu.extras_eligibility = { ...(env.menu.extras_eligibility || {}), deny: { Carnivora: [victim.name] } };
  const m = adaptMenu(env);
  assert.ok(!m.extrasFor(d.key).some((e) => e.key === victim.key), '🔴 the extra denied under the item_key is not offered (S3-CAPP-DENY)');
  assert.equal(m.extrasFor(d.key).length, offered.length - 1, 'only that one');
});
