// S3 (PLAN-structure-S3-r4 §1b, §7 REWARD-UNCHANGED / RENAME-FROZEN) — today's free-item rewards keep working across the S3 edits
// (owner 11-12), judged on REAL published versions: the S3 writer (choice-transitions) → the save's own steps (rederive + recordRenames;
// the real allocator) → publishVersion (the Firestore fake) → the ENDPOINT body (buildPublicMenu) and the production pricing tables
// (catalog reader + pricing resolver) → the forms' REAL reward pickers (buildRedeemCatalog, the booted page) and the server's REAL
// calculator (computeRedemption) with the catalog-authored allowlist (menu-gates redeemEligibleFrom). Run: node s3-rewards.test.mjs
//   1 UNCHANGED: a reward on an UNAFFECTED dish — before vs after D3 / an option rename / an option add — the same canonical and fingerprint
//   2 RENAME la_musa: a renamed option keeps its key (= its id); the picker row is {key: kept, name: new}; it redeems at the same price
//   3 RENAME x_pizza: a NEW sized pizza (Q3: allowed in a reward category) whose option is then renamed — the key is kept (the old
//     composed name, a recorded frozen key); the live picker sends that key and it redeems; the baked bundle (no item_keys) sends the
//     NEW name, which is ineligible_item before any money step (the accepted F2 class)
//   4 D3 la_musa: the removed options' keys are gone — a stale reward naming one is ineligible_item; the now-plain dish is redeemable
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { counter, settle, loadForm, serve, closeAll } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { makeDb } = require('./catalog/firestore-fake');
const { publishVersion } = require('./catalog/catalog-publish');
const { buildSourceCandidate } = require('./catalog/candidate-validate');
const { buildPublicMenu } = require('./catalog/public-menu');
const { buildSourceFromCode } = require('./tools/seed-source-store');
const { canonicalize } = require('./catalog/source-store');
const { createCatalogReader } = require('./catalog/catalog');
const { createPricingResolver } = require('./catalog/pricing-tables');
const CF = require('./catalog/catalog-firestore');
const { redeemEligibleFrom } = require('./catalog/menu-gates');
const { computeRedemption, redemptionFingerprint } = require('./rewards-redeem');
const AP = require('./catalog/add-product');
const FK = require('./catalog/frozen-keys');
const CT = require('./catalog/choice-transitions');
const CC = require('./catalog/choice-compare');
const { ok } = counter();
const WATCHDOG = setTimeout(() => { console.error('s3-rewards: FAILED — watchdog'); process.exit(1); }, 240000);
const clone = (v) => JSON.parse(JSON.stringify(v));
const KNOWN = new Set(['x_pizza', 'la_musa']);
const MODE = { x_pizza: 'name', la_musa: 'id' };
const DIR = { x_pizza: 'xpizza-orders', la_musa: 'la-musa-orders' };
const quiet = async (fn) => { const l = console.log, wn = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = wn; } };
const apply = (src, op) => CT.apply(src, op).source;

// the save's own steps for an edit of `live` → `draft` (edit-catalog-handler.js:113 + the allocator with the S3 preparer)
function saved(rid, live, draft) {
  let c = canonicalize(AP.rederiveOptionNames(canonicalize(draft)));
  const rec = FK.recordRenames({ draft: c, live, stored: live, textEdit: true });
  if (!rec.ok) throw new Error(`recordRenames refused (${rec.error})`);
  c = canonicalize(FK.withFrozenKeys(c, rec.frozen_keys));
  if (c.items.some((i) => i.ref)) c = canonicalize(AP.allocateAdditions({ incoming: c, stored: live, activeItems: live.items, keyMode: MODE[rid], hwm: null, registryHasKey: () => false, authoring: true, prepareExisting: CC.prepareExistingGroups }).source);
  return c;
}
// one published version of `source` → { env, tables, eligible }
async function published(rid, source) {
  const db = makeDb();
  const { inputs, built } = buildSourceCandidate(rid, source);
  await quiet(() => publishVersion(db, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 's3r',
    ...(built.key_mode == null ? {} : { key_mode: built.key_mode }), ...(built.frozen_keys == null ? {} : { frozen_keys: built.frozen_keys }) }, { expected: { activeVersionId: null } }));
  const m = await quiet(() => buildPublicMenu(db, rid, { known: KNOWN, isActive: async () => true }));
  const reader = createCatalogReader({ getRestaurantDocs: (r) => CF.getRestaurantDocs(db, r) });
  const tables = await createPricingResolver({ reader, alarm: () => {} }).getPricingTables(rid);
  return { env: { rid: m.rid, representation_version: m.representation_version, menu: clone(m.body) }, tables, eligible: redeemEligibleFrom(rid, built) };
}
const paidCart = (rid, P) => { const d = P.env.menu.dishes.find((x) => x.variantOf == null && !(P.env.menu.variant_items || {})[String(x.id)]); return [{ ...(rid === 'la_musa' ? { id: d.id } : {}), name: d.name, qty: 1, price: d.price }]; };
const redeemOf = (rid, key) => (rid === 'x_pizza' ? { type: 'free_pizza_choice', item_id: key } : { type: 'points_ala_carte', items: [{ id: key, qty: 1 }] });
const redeem = (rid, P, key) => computeRedemption({ redeem: redeemOf(rid, key), items: paidCart(rid, P), restaurantId: rid, tables: P.tables, eligible: P.eligible });
async function picker(rid, P, { live = true } = {}) { const w = loadForm(DIR[rid]); await settle(); if (live) { await serve(w, P.env); await settle(); } return w.buildRedeemCatalog(); }

(async () => {
  const LM = canonicalize(buildSourceFromCode('la_musa'));
  const PAD = 'noodle_01';
  const opts = LM.structure.variant_items[PAD].variantIds.map((id) => LM.items.find((i) => String(i.display.id) === String(id)).key);
  const mark = (s) => apply(s, { op: 'choice.recommended', launcher: PAD, option: opts[0] });

  // ── 1. UNCHANGED ──
  {
    const base = await published('la_musa', LM);
    const steady = 'noodle_02';
    const r0 = redeem('la_musa', base, steady);
    assert.ok(r0.ok, `premise: ${steady} redeems at the base (${r0.reason})`);
    for (const [label, src] of [
      ['D3', saved('la_musa', LM, apply(LM, { op: 'choice.remove', launcher: PAD, price_from: opts[1] }))],
      ['rename', saved('la_musa', LM, mark(apply(LM, { op: 'option.rename', key: opts[1], choice: 'Pollo al Wok' })))],
      ['add', saved('la_musa', LM, mark(apply(LM, { op: 'option.add', launcher: PAD, ref: 'tmp:s3r-tofu-xxxx', choice: 'Tofu', price: 330 })))],
    ]) {
      const P = await published('la_musa', src);
      const r = redeem('la_musa', P, steady);
      assert.deepStrictEqual(r.canonical, r0.canonical, `🔴 UNCHANGED after ${label}: the same canonical redemption`);
      assert.strictEqual(redemptionFingerprint(r.canonical), redemptionFingerprint(r0.canonical), `🔴 UNCHANGED after ${label}: the same fingerprint`);
    }
    ok('UNCHANGED: a reward on an unaffected dish redeems identically (canonical + fingerprint) after D3, an option rename and an option add');
  }

  // ── 2. RENAME la_musa ──
  {
    const base = await published('la_musa', LM);
    const P = await published('la_musa', saved('la_musa', LM, mark(apply(LM, { op: 'option.rename', key: opts[1], choice: 'Pollo al Wok' }))));
    const row = (await picker('la_musa', P)).find((x) => x.key === opts[1]);
    assert.ok(row, 'premise: the renamed option is a reward row');
    assert.strictEqual(row.name, `${LM.items.find((i) => i.key === PAD).display.name} - Pollo al Wok`, 'the picker shows the new name');
    const r = redeem('la_musa', P, row.key); const r0 = redeem('la_musa', base, opts[1]);
    assert.ok(r.ok && r0.ok, `both redeem (${r.reason} ${r0.reason})`);
    assert.deepStrictEqual(r.canonical, r0.canonical, '🔴 RENAME-LM: the kept key redeems at the same price and points');
    closeAll();
    ok('RENAME la_musa: the renamed option keeps its key; the picker row is {kept key, new name}; it redeems exactly as before');
  }

  // ── 3. RENAME x_pizza (a NEW sized pizza, Q3) ──
  {
    const XP = canonicalize(buildSourceFromCode('x_pizza'));
    const add = clone(XP);
    add.items.push({ ref: 'tmp:s3r-pie-xxxxxx', price: 300, display: { name: 'Pizza Doble S3', cat: 'individual', price: 300 } });
    add.structure.item_order.push('tmp:s3r-pie-xxxxxx');
    add.structure.variant_items = add.structure.variant_items || {};
    add.structure.variant_items['tmp:s3r-pie-xxxxxx'] = { label: 'Tamaño', variantIds: ['tmp:s3r-p12-xxxxxx', 'tmp:s3r-p18-xxxxxx'] };
    for (const [ref, choice, price] of [['tmp:s3r-p12-xxxxxx', '12 pulgadas', 300], ['tmp:s3r-p18-xxxxxx', '18 pulgadas', 520]]) {
      add.items.push({ ref, price, display: { variantOf: 'tmp:s3r-pie-xxxxxx', choice, price } });
      add.structure.item_order.push(ref);
    }
    const v1 = saved('x_pizza', XP, add);
    const small = v1.items.find((i) => i.display.choice === '12 pulgadas');
    assert.strictEqual(small.key, 'Pizza Doble S3 - 12 pulgadas', 'premise: name mode — the option key is its composed name');
    const lid = String(v1.items.find((i) => i.key === 'Pizza Doble S3').display.id);
    let v2 = apply(v1, { op: 'option.rename', key: small.key, choice: 'Personal' });
    v2 = apply(v2, { op: 'choice.recommended', launcher: 'Pizza Doble S3', option: small.key });
    v2 = saved('x_pizza', v1, v2);
    assert.ok(Object.values(v2.frozen_keys || {}).includes('Pizza Doble S3 - 12 pulgadas'), 'premise: the rename recorded the kept key');
    const P = await published('x_pizza', v2);
    const live = (await picker('x_pizza', P)).find((x) => x.name === 'Pizza Doble S3 - Personal');
    assert.ok(live, 'premise: the renamed option is a reward row (individual = the reward category)');
    assert.strictEqual(live.key, 'Pizza Doble S3 - 12 pulgadas', '🔴 RENAME-XP: the live picker sends the kept key');
    const r = redeem('x_pizza', P, live.key);
    assert.ok(r.ok, `🔴 RENAME-XP: the kept key redeems (${r.reason})`);
    // the baked bundle (no item_keys): the picker keys the row by its NAME — the new name is not a key → refused before money
    const baked = clone(P); delete baked.env.menu.item_keys;
    const bk = (await picker('x_pizza', baked)).find((x) => x.name === 'Pizza Doble S3 - Personal');
    assert.ok(bk && bk.key === 'Pizza Doble S3 - Personal', 'premise: without item_keys the row is keyed by its name');
    assert.strictEqual(redeem('x_pizza', P, bk.key).reason, 'ineligible_item', '🔴 RENAME-XP baked: the new name is ineligible_item (safe, before any money step)');
    void lid;
    closeAll();
    ok('RENAME x_pizza: a new sized pizza\'s renamed option keeps its key; the live picker redeems it; the baked bundle\'s name is ineligible_item');
  }

  // ── 4. D3 la_musa ──
  {
    const P = await published('la_musa', saved('la_musa', LM, apply(LM, { op: 'choice.remove', launcher: PAD, price_from: opts[1] })));
    assert.strictEqual(redeem('la_musa', P, opts[2]).reason, 'ineligible_item', '🔴 D3: a stale reward naming a removed option is refused');
    const r = redeem('la_musa', P, PAD);
    assert.ok(r.ok, `D3: the now-plain dish is redeemable (${r.reason})`);
    assert.strictEqual(r.canonical.items[0].price_cents, LM.items.find((i) => i.key === opts[1]).price * 100, 'D3: at its option price');
    const rows = await picker('la_musa', P);
    assert.ok(rows.some((x) => x.key === PAD) && !rows.some((x) => opts.includes(x.key)), 'D3: the picker offers the plain dish, no removed option');
    closeAll();
    ok('D3 la_musa: removed option keys are ineligible_item; the plain dish is a reward at its option price, in the picker');
  }
  clearTimeout(WATCHDOG);
  console.log('s3-rewards: OK');
})().catch((e) => { console.error('s3-rewards FAILED:', e && e.message); process.exit(1); });
