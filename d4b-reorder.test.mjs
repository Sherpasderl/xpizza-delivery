// Portal 1D · D4-b — REORDER (PLAN-D4b §B.5, §D; advisor Q3). Run: node d4b-reorder.test.mjs
//   1. LEGACY recipes (no tag): both forms' reorder reader reproduces the 22 results frozen from the 717f97e
//      account.js — plain, options capped to qty, merge offsets (add) and replace, drops, all-dropped, unknown fields.
//   2. CANONICAL recipes, built by the REAL server projection (canonicalRecipeLines) with canonical ids DISTINCT from
//      the legacy keys for BOTH restaurants, resolve by the SERVED canonical id per kind — to exactly the cart the
//      equivalent legacy recipe produces; an unresolvable identity is dropped like an off-menu line is today.
//   3. Any other recipe_format → every line dropped, with a diagnostic (today's unmatched behaviour).
//   4. COPY-THROUGH: materialization and guest claim carry recipe_format ONLY IF PRESENT; absent → the history entry
//      is byte-identical to today's; lines are copied opaquely (unknown fields kept, nothing re-derived).
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runReorder, legacyScenarios } from './d4b-reorder-reader.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
process.env.OTP_SALT = process.env.OTP_SALT || 'd4b-test-salt-0123456789abcdef0123456789';   // otp-lib fails closed below 32 chars
const { canonicalRecipeLines, ck } = require('./catalog/canonical-binding');
const { buildMaterializeUpdates } = require('./materialize');
const { normalizeReorderItems, normalizeReorderItemsCanonical } = require('./reorder-normalize');
const { catalogSnapshot } = require('./catalog/generate-form-bundle');
const { claimOrderCore } = require('./claim-order');
const { phoneHash } = require('./otp-lib');
const { createFakeRtdb } = require('./test/d4b-fake-rtdb');
const GOLDEN = JSON.parse(readFileSync(new URL('./xpizza-functions/catalog/d4b-reorder.golden.json', import.meta.url), 'utf8'));
const ACCOUNT = { 'xpizza-orders': readFileSync(new URL('./xpizza-orders/account.js', import.meta.url), 'utf8'), 'la-musa-orders': readFileSync(new URL('./la-musa-orders/account.js', import.meta.url), 'utf8') };
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

try {
  // ── 1. LEGACY parity ────────────────────────────────────────────────────────────────────────────────
  let compared = 0;
  for (const dir of Object.keys(ACCOUNT)) {
    for (const [name, sc] of legacyScenarios()) {
      assert.deepStrictEqual(runReorder(ACCOUNT[dir], sc), GOLDEN.results[`${dir}/${name}`], `🔴 ${dir} ${name}: a legacy reorder changed`);
      compared += 1;
    }
  }
  const off = GOLDEN.results['xpizza-orders/x_pizza.merge_add_offsets'];
  assert.deepStrictEqual(off.pizzaExtras['2'], { 0: { e2: 1 }, 1: { e1: 1 }, 2: { e1: 1 } }, 'premise — the golden records the merge offsets (new instances 1,2, existing 0 untouched)');
  assert.notDeepStrictEqual(runReorder(ACCOUNT['xpizza-orders'], { ...legacyScenarios()[0][1], soldOut: [2] }), GOLDEN.results['xpizza-orders/x_pizza.plain'], 'sensitivity — a sold-out line changes the outcome');
  ok(`legacy recipes: ${compared} results of both forms' reorder reader equal the frozen 717f97e results (merge offsets, replace, caps, drops, unknown fields)`);

  // ── 2. CANONICAL recipes, from the REAL server projection, canonical ids ≠ legacy keys for BOTH brands ─────
  const brands = {
    x_pizza: { dir: 'xpizza-orders', legacy: legacyScenarios().find(([k]) => k === 'x_pizza.merge_add_offsets')[1] },
    la_musa: { dir: 'la-musa-orders', legacy: legacyScenarios().find(([k]) => k === 'la_musa.merge_add')[1] },
  };
  for (const [rid, b] of Object.entries(brands)) {
    const legacyMenu = b.legacy.menu;
    const dishCid = (d) => `CID-D-${rid}-${d.id}`, extraCid = (e) => `CID-E-${rid}-${e.id}`;
    const served = { dishes: legacyMenu.dishes.map((d) => ({ ...d, dish_id: dishCid(d) })), extras: legacyMenu.extras.map((e) => ({ ...e, extra_id: extraCid(e) })) };
    const legacyKeyOfDish = (d) => (rid === 'la_musa' ? d.id : d.name), legacyKeyOfExtra = (e) => (rid === 'la_musa' ? e.id : e.name);
    const context = { usableAsIdentity: true, objects: [
      ...served.dishes.map((d) => ({ kind: 'dish', legacyKey: legacyKeyOfDish(d), canonicalId: d.dish_id })),
      ...served.extras.map((e) => ({ kind: 'extra', legacyKey: legacyKeyOfExtra(e), canonicalId: e.extra_id }))] };
    for (const o of context.objects) assert.notStrictEqual(o.canonicalId, o.legacyKey, 'premise — every canonical id differs from its legacy key');
    const proj = canonicalRecipeLines(b.legacy.entry.items, context);
    assert.ok(proj.ok, `${rid}: the server projects the recipe`);
    assert.ok(proj.lines.every((l) => l.key.startsWith('["c1","dish",')), 'keys are ck strings');
    const want = runReorder(ACCOUNT[b.dir], { ...b.legacy, menu: served });
    const got = runReorder(ACCOUNT[b.dir], { ...b.legacy, menu: served, entry: { items: proj.lines, recipe_format: 'canonical' } });
    assert.deepStrictEqual(got, want, `🔴 ${rid}: a canonical recipe must rebuild exactly the cart its legacy twin does`);
    assert.ok(Object.keys(got.qty).length > 0, 'premise — something was added');
    // a canonical recipe is NOT read as legacy, and a legacy recipe is NOT read as canonical
    const asLegacy = runReorder(ACCOUNT[b.dir], { ...b.legacy, menu: served, entry: { items: proj.lines } });
    assert.ok(asLegacy.toasts.some((t) => /ya no están disponibles/.test(t)), 'untagged ck keys match nothing (today\'s behaviour for an unknown key)');
    // an unresolvable canonical identity → dropped like an off-menu line; an unresolvable option → skipped
    const broken = { items: [{ ...proj.lines[0], key: ck('dish', 'NO-SUCH') }, { ...proj.lines[0], options: [{ ...(proj.lines[0].options || [{}])[0], ...(rid === 'la_musa' ? { id: ck('extra', 'NOPE') } : { name: ck('extra', 'NOPE') }) }] }], recipe_format: 'canonical' };
    const br = runReorder(ACCOUNT[b.dir], { ...b.legacy, menu: served, entry: broken });
    assert.ok(br.toasts.includes('1 producto ya no está disponible'), `${rid}: the unresolvable dish is dropped with today's notice`);
    // a ck naming an EXTRA in a dish position never matches a dish
    const kindSwap = runReorder(ACCOUNT[b.dir], { ...b.legacy, menu: served, entry: { items: [{ key: ck('extra', served.extras[0].extra_id), qty: 1 }], recipe_format: 'canonical' } });
    assert.deepStrictEqual(kindSwap.qty, b.legacy.cart ? b.legacy.cart.qty : {}, `${rid}: kind is part of identity`);
  }
  ok('canonical recipes (real server projection, canonical ids ≠ legacy keys for both brands) resolve by the served dish_id/extra_id to EXACTLY the cart the legacy recipe builds; untagged ck keys match nothing; unresolvable / wrong-kind identities are dropped as today');

  // ── 3. Any other recipe_format → dropped + diagnostic ───────────────────────────────────────────────
  for (const dir of Object.keys(ACCOUNT)) {
    for (const bad of ['legacy', 'Canonical', 7, null, true]) {
      const sc = legacyScenarios().find(([k]) => k === (dir === 'xpizza-orders' ? 'x_pizza.plain' : 'la_musa.plain'))[1];
      const r = runReorder(ACCOUNT[dir], { ...sc, entry: { ...sc.entry, recipe_format: bad } });
      assert.deepStrictEqual(r.qty, {}, `${dir} ${JSON.stringify(bad)}: nothing added`);
      assert.deepStrictEqual(r.toasts, ['Esos productos ya no están disponibles.'], 'today\'s unmatched notice');
      assert.ok(r.warns.some((w) => w.includes('reorder_recipe_format_invalid')), 'with a diagnostic');
    }
  }
  ok('any other recipe_format ("legacy", "Canonical", 7, null, true) → every line dropped with today\'s notice and a reorder_recipe_format_invalid diagnostic, in both forms');

  // ── 4. COPY-THROUGH: materialize + guest claim ──────────────────────────────────────────────────────
  const recipe = [{ key: 'Carnivora', qty: 2, options: [{ name: 'Salsa Roja', count: 1, zz: 'kept' }], future_field: { a: 1 } }];
  const order = { restaurant_id: 'x_pizza', customer_uid: 'u1', total: 300, order_type: 'pickup', items_text: '2x Carnivora', reorder_items: recipe, payment_method: 'online' };
  const entryOf = (o) => buildMaterializeUpdates({ orderId: 'o1', order: o, trackingToken: 't1', now: 1000, restaurant: { name: 'X' }, paymentMethod: 'online' })['user_orders/u1/o1'];
  const plain = entryOf(order);
  assert.deepStrictEqual(Object.keys(plain).sort(), ['items', 'items_text', 'order_type', 'restaurant', 'status', 'total', 'ts'], '🔴 absent tag → the history entry has exactly today\'s fields');
  assert.deepStrictEqual(plain.items, recipe, 'lines copied opaquely (unknown fields kept)');
  assert.strictEqual(entryOf({ ...order, recipe_format: 'canonical' }).recipe_format, 'canonical', 'materialize carries the tag when present');
  const claimRun = async (extra) => {
    const phone = '+50499990000';
    const db = createFakeRtdb({ user_profiles: { u2: { phone_hash: phoneHash(phone) } },
      orders: { o2: { restaurant_id: 'x_pizza', customer_phone: phone, status: 'new', total: 1, order_type: 'pickup', items_text: 'x', reorder_items: recipe, ...extra } } });
    const r = await claimOrderCore(db, { uid: 'u2', orderId: 'o2', token: null, now: 5 });
    return { r, entry: db.dump().user_orders && db.dump().user_orders.u2 && db.dump().user_orders.u2.o2 };
  };
  const c0 = await claimRun({});
  assert.ok(c0.entry, 'premise — the claim wrote a history entry');
  assert.deepStrictEqual(Object.keys(c0.entry).sort(), ['items', 'items_text', 'order_type', 'restaurant', 'status', 'total', 'ts'], '🔴 absent tag → claim entry has exactly today\'s fields');
  assert.deepStrictEqual(c0.entry.items, recipe);
  const c1 = await claimRun({ recipe_format: 'canonical' });
  assert.strictEqual(c1.entry.recipe_format, 'canonical', 'guest claim carries the tag when present');
  ok('copy-through: materialization and guest claim write today\'s exact history entry when untagged (lines opaque, unknown fields kept) and carry recipe_format unchanged when present');

  // ── 5. (codex D4-b r1 S3) the cash path's DORMANT canonical normalizer: allowlist → ONLY the keys substituted ──
  for (const rid of ['x_pizza', 'la_musa']) {
    const s = catalogSnapshot(rid);
    const tables = { restaurantId: rid, menu: Object.fromEntries(s.items.map((i) => [i.key, i.price])), extras: Object.fromEntries(s.extras.map((e) => [e.key, e.price])) };
    const ctx = { usableAsIdentity: true, objects: [...s.items.map((i, k) => ({ kind: 'dish', legacyKey: i.key, canonicalId: `CC-D-${rid}-${k}` })), ...s.extras.map((e, k) => ({ kind: 'extra', legacyKey: e.key, canonicalId: `CC-E-${rid}-${k}` }))] };
    const [d0, d1] = s.items, [e0, e1] = s.extras;
    const body = rid === 'x_pizza'
      ? [{ name: d0.display.name, qty: 2, extras: [{ name: e0.display.name }, { name: e0.display.name }, { name: e0.display.name }, { name: e1.display.name }, { name: 'Not An Extra' }] }, { name: 'Not On The Menu', qty: 1 }, { name: d1.display.name, qty: 1 }]
      : [{ id: d0.key, qty: 2, extras: [{ id: e0.key, qty: 3 }, { id: 'nope', qty: 1 }, { id: e0.key, qty: 9 }] }, { id: 'not_on_menu', qty: 1 }, { id: d1.key, qty: 1, extras: [{ id: e1.key, qty: 1 }] }];
    const legacy = normalizeReorderItems(body, rid, tables);
    const canon = normalizeReorderItemsCanonical(body, rid, tables, ctx);
    assert.ok(canon.ok, `${rid}: projected`);
    assert.strictEqual(legacy.length, 2, 'premise — the allowlist drops the off-menu line');
    // INDEPENDENT expectation: the legacy lines with ONLY their keys mapped through the context
    const dishCid = new Map(ctx.objects.filter((o) => o.kind === 'dish').map((o) => [o.legacyKey, o.canonicalId]));
    const extraCid = new Map(ctx.objects.filter((o) => o.kind === 'extra').map((o) => [o.legacyKey, o.canonicalId]));
    const expected = legacy.map((l) => ({ ...l, key: JSON.stringify(['c1', 'dish', dishCid.get(l.key)]),
      ...(l.options ? { options: l.options.map((o) => (o.id !== undefined ? { ...o, id: JSON.stringify(['c1', 'extra', extraCid.get(o.id)]) } : { ...o, name: JSON.stringify(['c1', 'extra', extraCid.get(o.name)]) })) } : {}) }));
    assert.deepStrictEqual(canon.lines, expected, `${rid}: canonical recipe = the allowlisted legacy recipe with ONLY keys substituted (counts/qty kept)`);
    if (rid === 'x_pizza') assert.deepStrictEqual(legacy[0].options.map((o) => o.count), [2, 1], 'premise — extras counts capped to the line qty');
    else assert.deepStrictEqual(legacy[0].options, [{ id: e0.key, qty: 3 }], 'premise — la_musa dedups by id, keeps the first qty, drops unknown ids');
    assert.strictEqual(normalizeReorderItemsCanonical(body, rid, tables, { ...ctx, usableAsIdentity: false }).ok, false, `${rid}: an unusable context → { ok:false } (never a legacy recipe mislabelled canonical)`);
    assert.strictEqual(normalizeReorderItemsCanonical(body, rid, tables, { usableAsIdentity: true, objects: ctx.objects.filter((o) => o.legacyKey !== d1.key) }).ok, false, `${rid}: an unresolvable dish → { ok:false }`);
  }
  ok('cash path (S3): normalizeReorderItemsCanonical = the allowlisted legacy recipe (off-menu drops, x_pizza counts capped, la_musa id dedup) with ONLY its keys substituted, for both brands; an unusable context or an unresolvable dish → { ok:false }');

  console.log(`d4b-reorder: OK (${n})`);
  process.exit(0);
} catch (e) {
  console.error('d4b-reorder FAILED:', e);
  process.exit(1);
}
