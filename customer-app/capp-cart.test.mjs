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
  assert.deepEqual(createCart(m).hydrate(over), { dropped: 51 }, 'a restored line over the limit is dropped and counted');
});

test('P2 issued snapshot: deeply immutable — the resent body can never differ from what was issued', () => {
  const m = MENU.x_pizza; const d = configurable(m); const c = createCart(m); c.add(d.key, [m.extrasFor(d.key)[0].key], 2);
  const body = { ...serialize(c, m) }; const snap = issuedSnapshot(body); const before = JSON.stringify(resendBody(snap));
  body.items[0].qty = 9;
  const r = resendBody(snap); r.items[0].qty = 9;
  assert.throws(() => { 'use strict'; snap.json = '{}'; }, TypeError);
  assert.equal(JSON.stringify(resendBody(snap)), before, 'neither the source body nor a resent copy reaches the snapshot');
});
