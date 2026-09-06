'use strict';
// Portal 2a Task 6 — REWARD ELIGIBILITY sourced from the catalog. Run: node catalog/redeem-eligibility.test.js
//
// MONEY-ADJACENT (redemption). Two opposite failure modes, and neither is acceptable:
//   • wrongly ELIGIBLE  → an expensive item is comped for free. The current code is an explicit
//     fail-closed allowlist precisely so an unknown/forged name can never free an 18" NY pie.
//   • wrongly REJECTED  → a legitimate redemption is refused; the customer paid punches for nothing.
// So the fallback on any failure is the STATIC set — today's exact answer, which is neither.
const assert = require('assert');
const { redeemEligibleFrom, createGateReader } = require('./menu-gates');
const { isRedeemEligible, X_PIZZA_REDEEM_ELIGIBLE, LA_MUSA_ACOMP } = require('../rewards-redeem-config');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs, validateSource } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const { assertStoreCodeParity } = require('./publish-parity');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (code) => {
  if (code === 0 && !FINISHED) { console.error('redeem-eligibility: FAILED — exited without completing (a hang or an early return)'); process.exitCode = 1; }
});

const srcFor = (rid, mutate) => { const s = buildSourceFromCode(rid); if (mutate) mutate(s); return s; };
const builtFor = (rid, mutate) => {
  const { priceTable, formData } = sourceToBuildInputs(srcFor(rid, mutate));
  return buildCatalogV2(rid, { formData, priceTable });
};
const tablesFor = (rid) => ({ restaurantId: rid, menu: MENU_BY_RESTAURANT[rid], extras: EXTRAS_BY_RESTAURANT[rid] });

// ── (1) The store AUTHORS the eligibility, and the seed authors today's answer exactly ──────────
{
  const xs = srcFor('x_pizza'), ls = srcFor('la_musa');
  assert.deepStrictEqual(xs.structure.redeem_eligible_cats, ['individual'], 'x_pizza eligibility is the individual category');
  assert.deepStrictEqual(ls.structure.redeem_eligible_extras, [...LA_MUSA_ACOMP].sort(), 'la_musa acompañamientos are authored explicitly');
  validateSource(xs, 'x_pizza'); validateSource(ls, 'la_musa');
  ok('the seed authors redeem eligibility into the store, and validateSource accepts it');
}

// ── (1b) validateSource REJECTS a broken eligibility reference ─────────────────────────────────
// A dangling reference is silent in production: an unknown category simply matches no dish, so the
// reward becomes unredeemable and nobody finds out until a customer complains.
{
  const bad = [
    ['x_pizza', (s) => { s.structure.redeem_eligible_cats = 'individual'; }, /must be an array/],
    ['x_pizza', (s) => { s.structure.redeem_eligible_cats = ['individual', 'individual']; }, /duplicates/],
    ['x_pizza', (s) => { s.structure.redeem_eligible_cats = ['indivdual']; }, /unknown category indivdual/],   // a typo a merchant could make
    ['la_musa', (s) => { s.structure.redeem_eligible_extras = { a: 1 }; }, /must be an array/],
    ['la_musa', (s) => { s.structure.redeem_eligible_extras = ['rice_white', 'rice_white']; }, /duplicates/],
    ['la_musa', (s) => { s.structure.redeem_eligible_extras = ['rice_white', 'not_an_extra']; }, /unknown extra not_an_extra/],
    // a MENU id is not an extra: the acompañamiento allowlist lives in the extras namespace only
    ['la_musa', (s) => { s.structure.redeem_eligible_extras = ['dimsum_01']; }, /unknown extra dimsum_01/],
  ];
  for (const [rid, mutate, re] of bad) {
    assert.throws(() => validateSource(srcFor(rid, mutate), rid), re, `validateSource must reject: ${re}`);
  }
  // non-vacuity: the UNMUTATED sources still pass, so the throws above are about the mutation
  validateSource(srcFor('x_pizza'), 'x_pizza'); validateSource(srcFor('la_musa'), 'la_musa');
  ok(`validateSource rejects all ${bad.length} broken eligibility references (a dangling one is silently unredeemable)`);
}

// ── (1c) The code→store derivation refuses to guess ────────────────────────────────────────────
{
  const { redeemCatsForXPizza, redeemExtrasForLaMusa } = require('./redeem-source');
  const items = builtFor('x_pizza').items;
  // If a NY pie were ever added to the code allowlist, "individual + ny" would also comp the other six.
  assert.deepStrictEqual(redeemCatsForXPizza(items), ['individual'], 'today it is exactly one category');
  const smuggled = items.map((it) => (it.display.cat === 'ny' && X_PIZZA_REDEEM_ELIGIBLE.has(it.key) === false && it.key === items.find((i) => i.display.cat === 'ny').key
    ? { ...it, display: { ...it.display, cat: 'individual' } } : it));
  assert.throws(() => redeemCatsForXPizza(smuggled), /redeem_cats_not_category_aligned/,
    'a category containing an INELIGIBLE item must stop the migration, not silently comp it');
  assert.throws(() => redeemExtrasForLaMusa({ rice_white: 100 }), /redeem_extra_unpriced/,
    'an allowlisted extra that prices nothing can never be redeemed — fail rather than author it');
  ok('the code→store derivation throws rather than guess when the allowlist is not whole categories');
}

// ── (2) STORE == CODE: byte-identical eligible sets, both directions ────────────────────────────
{
  const x = redeemEligibleFrom('x_pizza', builtFor('x_pizza'));
  assert.deepStrictEqual([...x.allow].sort(), [...X_PIZZA_REDEEM_ELIGIBLE].sort(), 'the catalog-derived eligible set must equal the static allowlist exactly');
  assert.strictEqual(x.allow.size, 17, 'sanity: the 17 12" pizzas (non-vacuity — an empty set would trivially "match" a mutated static)');
  const l = redeemEligibleFrom('la_musa', builtFor('la_musa'));
  assert.deepStrictEqual([...l.allow].sort(), [...LA_MUSA_ACOMP].sort(), 'la_musa acompañamientos derive exactly');
  ok(`store == code: the derived eligible sets equal the static ones exactly (x_pizza ${x.allow.size}, la_musa ${l.allow.size})`);
}

// ── (3) IDENTICAL VERDICT for every key, eligible and not ──────────────────────────────────────
{
  const built = builtFor('x_pizza');
  const el = redeemEligibleFrom('x_pizza', built);
  let eligible = 0, rejected = 0;
  for (const it of built.items) {
    const was = isRedeemEligible('x_pizza', it.key, tablesFor('x_pizza'));
    const now = isRedeemEligible('x_pizza', it.key, tablesFor('x_pizza'), el);
    assert.strictEqual(now, was, `verdict changed for ${it.key}`);
    was ? eligible++ : rejected++;
  }
  assert.ok(eligible === 17 && rejected === 7, `non-vacuity: the sweep must cover BOTH answers (got ${eligible} eligible / ${rejected} rejected)`);
  // a forged / unknown name stays fail-closed
  for (const forged of ['Not A Pizza', '', 'Margherita NY ', 'individual']) {
    assert.strictEqual(isRedeemEligible('x_pizza', forged, tablesFor('x_pizza'), el), false, `forged name "${forged}" must stay ineligible`);
  }
  ok(`identical verdict for all ${built.items.length} x_pizza items (17 eligible, 7 NY rejected) + forged names still fail-closed`);
}
{
  const el = redeemEligibleFrom('la_musa', builtFor('la_musa'));
  const t = tablesFor('la_musa');
  const keys = [...Object.keys(MENU_BY_RESTAURANT.la_musa), ...Object.keys(EXTRAS_BY_RESTAURANT.la_musa)];
  let yes = 0, no = 0;
  for (const k of keys) {
    const was = isRedeemEligible('la_musa', k, t);
    assert.strictEqual(isRedeemEligible('la_musa', k, t, el), was, `verdict changed for ${k}`);
    was ? yes++ : no++;
  }
  assert.ok(yes > 0 && no > 0, `non-vacuity: both answers must appear (got ${yes}/${no})`);
  // the fail-closed rules survive the injection
  assert.strictEqual(isRedeemEligible('la_musa', 'sauce_aioli', t, el), false, 'a modifier is never redeemable');
  assert.strictEqual(isRedeemEligible('la_musa', 'protein_beef', t, el), false, 'a protein add-on is never redeemable');
  ok(`identical verdict for all ${keys.length} la_musa menu+extras keys (${yes} eligible / ${no} rejected); modifiers still rejected`);
}

// ── (4) A STORE EDIT MOVES ELIGIBILITY — and the static path demonstrably does not ─────────────
{
  // Make the 18" NY pies redeemable — the change a merchant would make in the portal.
  const opened = redeemEligibleFrom('x_pizza', builtFor('x_pizza', (s) => { s.structure.redeem_eligible_cats = ['individual', 'ny']; }));
  const ny = builtFor('x_pizza').items.find((i) => i.display.cat === 'ny').key;
  assert.strictEqual(isRedeemEligible('x_pizza', ny, tablesFor('x_pizza'), opened), true, 'a store edit MUST make the NY pies redeemable');
  assert.strictEqual(isRedeemEligible('x_pizza', ny, tablesFor('x_pizza')), false, 'while the static path keeps yesterday\'s answer — the drift being killed');
  // and the reverse: revoking a category must take effect too
  const closed = redeemEligibleFrom('x_pizza', builtFor('x_pizza', (s) => { s.structure.redeem_eligible_cats = []; }));
  assert.strictEqual(isRedeemEligible('x_pizza', 'Margherita', tablesFor('x_pizza'), closed), false, 'revoking a category must take effect');
  assert.strictEqual(isRedeemEligible('x_pizza', 'Margherita', tablesFor('x_pizza')), true, 'the static path would still comp it');
  ok('a store edit moves eligibility BOTH ways; the static path does neither (the drift this kills)');
}
{
  // La Musa: a merchant adds a fourth acompañamiento; and removing one revokes it.
  const more = redeemEligibleFrom('la_musa', builtFor('la_musa', (s) => { s.structure.redeem_eligible_extras = [...LA_MUSA_ACOMP, 'sauce_aioli'].sort(); }));
  assert.strictEqual(isRedeemEligible('la_musa', 'sauce_aioli', tablesFor('la_musa'), more), true, 'an explicitly authored extra becomes redeemable');
  const fewer = redeemEligibleFrom('la_musa', builtFor('la_musa', (s) => { s.structure.redeem_eligible_extras = ['rice_white']; }));
  assert.strictEqual(isRedeemEligible('la_musa', 'papas_fritas', tablesFor('la_musa'), fewer), false, 'de-authoring an extra revokes it');
  assert.strictEqual(isRedeemEligible('la_musa', 'papas_fritas', tablesFor('la_musa')), true, 'the static path would still comp it');
  ok('la_musa acompañamientos follow the store both ways');
}

// ── (5) The PARITY GATE covers the new fields — a store-only eligibility edit cannot publish ───
{
  const code = buildCatalogV2('x_pizza');
  assertStoreCodeParity('x_pizza', builtFor('x_pizza'), code);       // clean at store == code
  assert.throws(() => assertStoreCodeParity('x_pizza', builtFor('x_pizza', (s) => { s.structure.redeem_eligible_cats = ['individual', 'ny']; }), code),
    /parity_mismatch/, 'an eligibility edit MUST trip the pre-flip parity gate — otherwise the cutover is not a no-op');
  ok('the pre-flip parity gate covers redeem eligibility (a store-only edit cannot slip through the cutover)');
}
// ── (6) A STORE-ADDED PIZZA IS REDEEMABLE — the merchant case the plan names ───────────────────
{
  const built = builtFor('x_pizza', (src) => {
    const dish = { id: 99, cat: 'individual', name: 'Truffle Funghi', price: 380, emoji: '🍕', desc: 'new' };
    src.items.push({ key: 'Truffle Funghi', price: 380, display: dish });
    src.structure.item_order.push('Truffle Funghi');
  });
  const el = redeemEligibleFrom('x_pizza', built);
  assert.strictEqual(el.allow.has('Truffle Funghi'), true, 'a pizza the merchant adds in `individual` is redeemable — no code change');
  assert.strictEqual(X_PIZZA_REDEEM_ELIGIBLE.has('Truffle Funghi'), false, 'and the code-static allowlist would omit it (the drift)');
  assert.strictEqual(el.allow.size, 18, 'exactly one more than today');
  ok('a store-added 12" pizza becomes redeemable with no code change (code-static would omit it)');
}

// ── (7) PIN B — a set applied to the WRONG brand must throw, not quietly answer "no" ───────────
{
  const x = redeemEligibleFrom('x_pizza', builtFor('x_pizza'));
  const l = redeemEligibleFrom('la_musa', builtFor('la_musa'));
  assert.throws(() => isRedeemEligible('la_musa', 'rice_white', tablesFor('la_musa'), x), /redeem_eligible_restaurant_mismatch/, 'x_pizza names must not be applied to la_musa');
  assert.throws(() => isRedeemEligible('x_pizza', 'Margherita', tablesFor('x_pizza'), l), /redeem_eligible_restaurant_mismatch/, 'and vice versa');
  // Non-vacuity: without the tag check this would NOT throw — it would silently answer false, and a
  // silent false is a refused legitimate redemption on every order.
  assert.strictEqual(x.allow.has('rice_white'), false, 'the mix-up would otherwise be a silent "no"');
  ok('PIN B: a cross-brand eligible set throws instead of silently refusing every redemption');
}

// ── (8) FAIL-SAFE: every failure lands on TODAY. Not "everything eligible", not "nothing". ─────
(async () => {
  const built = builtFor('x_pizza');
  // What a version published before Task 6 actually looks like on read: no redeem field in the
  // structure at all. (Deleting it from the SOURCE would not reproduce this — buildCatalogV2 re-derives
  // from code when the store authors nothing, which is what keeps the pre-cutover parity gate honest.)
  const legacyVersion = (rid) => { const b = builtFor(rid); delete b.structure.redeem_eligible_cats; delete b.structure.redeem_eligible_extras; return b; };
  const cases = [
    ['pointer read throws',  { getVersionId: async () => { throw new Error('pointer down'); }, getMenu: async () => built }],
    ['structure read fails', { getVersionId: async () => 'v1', getMenu: async () => { throw new Error('down'); } }],
    ['read hangs',           { getVersionId: async () => 'v1', getMenu: () => new Promise(() => {}), deadlineMs: 30 }],
    ['flat / un-migrated',   { getVersionId: async () => null, getMenu: async () => built }],
    ['no pointer wired',     { getMenu: async () => built }],
    // A version PUBLISHED BEFORE this task exists: its menu_structure has no such field at all.
    ['unauthored (pre-2a version)', { getVersionId: async () => 'v1', getMenu: async () => legacyVersion('x_pizza') }],
  ];
  for (const [label, opts] of cases) {
    const el = await createGateReader(opts).redeemEligibleFor('x_pizza');
    assert.strictEqual(el, null, `${label} → null, meaning "use the static allowlist"`);
    // BOTH errors must be absent: the eligible stay eligible AND the ineligible stay ineligible.
    assert.strictEqual(isRedeemEligible('x_pizza', 'Margherita', tablesFor('x_pizza'), el), true, `${label}: a legitimate redemption is NOT refused`);
    assert.strictEqual(isRedeemEligible('x_pizza', 'Margherita NY', tablesFor('x_pizza'), el), false, `${label}: an 18" NY pie is NOT wrongly comped`);
  }
  ok(`all ${cases.length} failure modes fall back to today's allowlist — neither wrongly eligible nor wrongly refused`);

  // The unauthored case must be null, NOT an empty set. An empty set refuses every redemption.
  const un = await createGateReader({ getVersionId: async () => 'v1', getMenu: async () => legacyVersion('la_musa') }).redeemEligibleFor('la_musa');
  assert.strictEqual(un, null, 'unauthored must be null, never an empty allow set');
  assert.strictEqual(isRedeemEligible('la_musa', 'rice_white', tablesFor('la_musa'), un), true, 'so an acompañamiento is still redeemable');
  ok('unauthored is null, never an empty set — an empty set would refuse every legitimate redemption');

  // A malformed set (a forgotten await) must degrade, not throw a 500 into the redemption path.
  for (const bad of [{ restaurantId: 'x_pizza', allow: Promise.resolve(new Set()) }, { restaurantId: 'x_pizza', allow: ['Margherita'] }, { restaurantId: 'x_pizza' }]) {
    assert.strictEqual(isRedeemEligible('x_pizza', 'Margherita', tablesFor('x_pizza'), bad), true, 'malformed → static, still redeemable');
    assert.strictEqual(isRedeemEligible('x_pizza', 'Margherita NY', tablesFor('x_pizza'), bad), false, 'malformed → static, NY still refused');
  }
  ok('a malformed eligible set degrades to the static allowlist instead of throwing');

  // The reader serves BOTH gates from ONE structure read — the weekend gate and eligibility.
  let reads = 0;
  const r = createGateReader({ getVersionId: async () => 'v5', getMenu: async () => { reads++; return built; } });
  await r.weekendOnlyKeysFor('x_pizza');
  await r.redeemEligibleFor('x_pizza');
  assert.strictEqual(reads, 1, 'both gates share the one cached version read');
  ok('the weekend gate and redemption eligibility share a single cached structure read');

  console.log(`redeem-eligibility: OK (${n})`);
  FINISHED = true;
})().catch((e) => { console.error(e); process.exit(1); });

