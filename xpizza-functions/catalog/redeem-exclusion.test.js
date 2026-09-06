'use strict';
// Portal 2a Task 6b — KILL THE EXCLUDE GLOBS. Run: node catalog/redeem-exclusion.test.js
//
// La Musa eligibility was an implicit DENYLIST over a growing set: "every MENU dish except beer_*,
// sauce_*, protein_*". That is a same-brand silent-drift landmine, not a merchant-#3 concern — once
// La Musa edits their own menu, a dish in ANY new namespace (wine_, cocktail_, spirits_) is silently
// redeemable, because a hardcoded glob cannot know about a namespace invented after it was written.
// Free wine, no code change, no alarm.
//
// The fix is a COMPLETE store-authored ALLOWLIST: eligible = (item's category is authored) OR (the item
// itself is authored) OR (the extra is authored). No glob for a new namespace to escape, and the
// default for anything unauthored is NOT redeemable — the correct default when the answer is money.
//
// Categories alone cannot express it: `bebidas` holds 8 beers (never redeemable) AND 4 soft drinks
// (redeemable today). That is why the per-ITEM allowlist exists alongside the per-category one.
const assert = require('assert');
const { redeemEligibleFrom, createGateReader } = require('./menu-gates');
const { isRedeemEligible, LA_MUSA_ACOMP } = require('../rewards-redeem-config');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs, validateSource } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const { assertStoreCodeParity } = require('./publish-parity');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
let ITEM_ONLY = null;
process.on('exit', (code) => { if (code === 0 && !FINISHED) { console.error('redeem-exclusion: FAILED — exited without completing'); process.exitCode = 1; } });

const srcFor = (rid, mutate) => { const s = buildSourceFromCode(rid); if (mutate) mutate(s); return s; };
const builtFor = (rid, mutate) => { const { priceTable, formData } = sourceToBuildInputs(srcFor(rid, mutate)); return buildCatalogV2(rid, { formData, priceTable }); };
const tablesFor = (rid) => ({ restaurantId: rid, menu: MENU_BY_RESTAURANT[rid], extras: EXTRAS_BY_RESTAURANT[rid] });

// ── (1) The store authors the COMPLETE answer, and it reproduces today EXACTLY ─────────────────
{
  const s = srcFor('la_musa');
  assert.deepStrictEqual(s.structure.redeem_eligible_cats, ['crudo', 'dim_sum', 'house_specials', 'noodles', 'rice', 'soups_salads', 'starters'],
    'the seven wholly-food categories are authored as categories');
  assert.deepStrictEqual(s.structure.redeem_eligible_items, ['soft_01', 'soft_02', 'soft_03', 'soft_04'],
    'the four soft drinks are authored individually — `bebidas` also holds 8 beers, so the category cannot carry them');
  assert.deepStrictEqual(s.structure.redeem_eligible_extras, [...LA_MUSA_ACOMP].sort(), 'and the acompañamientos, unchanged');
  validateSource(s, 'la_musa');
  ok('la_musa authors categories + the 4 mixed-category items + the extras (a complete, glob-free answer)');
}
{
  // The whole migration is a no-op or it is nothing: EVERY key must answer identically.
  const el = redeemEligibleFrom('la_musa', builtFor('la_musa'));
  const t = tablesFor('la_musa');
  const keys = [...Object.keys(MENU_BY_RESTAURANT.la_musa), ...Object.keys(EXTRAS_BY_RESTAURANT.la_musa)];
  let yes = 0, no = 0;
  for (const k of keys) {
    const was = isRedeemEligible('la_musa', k, t);              // today: the denylist
    assert.strictEqual(isRedeemEligible('la_musa', k, t, el), was, `verdict changed for ${k}`);
    was ? yes++ : no++;
  }
  assert.strictEqual(yes, 39, 'non-vacuity: 36 menu + 3 acompañamientos, exactly as today');
  assert.strictEqual(no, 19, 'non-vacuity: 8 beers + 11 modifiers, exactly as today');
  // spot-pin the two halves of the mixed category, which is where a category-only fold would break
  assert.strictEqual(isRedeemEligible('la_musa', 'soft_01', t, el), true, 'a soft drink in `bebidas` stays redeemable');
  assert.strictEqual(isRedeemEligible('la_musa', 'beer_01', t, el), false, 'a beer in the SAME category stays ineligible');
  ok(`identical verdict for all ${keys.length} la_musa keys (${yes}/${no}) — including both halves of the mixed \`bebidas\` category`);
}

// ── (1b) THE NO-OP PROOF, checked against WRONG answers ────────────────────────────────────────
// As an inline block this could only ever fire on a future edit — no test could reach it, and the
// mutation survived. Extracted, it can be handed the two ways a derivation can be wrong.
{
  const { assertRedeemAllowMatchesToday, deriveRedeemAllow } = require('./redeem-source');
  const items = builtFor('la_musa').items;
  const right = deriveRedeemAllow('la_musa', items);
  assert.strictEqual(assertRedeemAllowMatchesToday('la_musa', items, right), true, 'the real derivation passes (non-vacuity)');
  // OVER: author the mixed category whole → the 8 beers become free.
  assert.throws(() => assertRedeemAllowMatchesToday('la_musa', items, { cats: [...right.cats, 'bebidas'], items: [] }),
    /redeem_allow_over_derived: la_musa — beer_/, 'authoring `bebidas` whole must be caught — it would comp free beer');
  // UNDER: drop the per-item half → the 4 soft drinks stop being redeemable.
  assert.throws(() => assertRedeemAllowMatchesToday('la_musa', items, { cats: right.cats, items: [] }),
    /redeem_allow_under_derived: la_musa — soft_/, 'dropping the softs must be caught — it would refuse legitimate redemptions');
  assert.throws(() => assertRedeemAllowMatchesToday('la_musa', items, { cats: [], items: [] }), /under_derived/, 'and an empty answer is not "no difference"');
  ok('the no-op proof catches BOTH over-derivation (free beer) and under-derivation (refused redemptions)');
}

// ── (1c) A store that authors ONLY items still counts as AUTHORED ──────────────────────────────
// Otherwise a merchant whose eligibility happens to be item-only would silently fall back to the code
// denylist — the landmine reappearing through the fallback door.
{
  const built = builtFor('la_musa', (src) => {
    delete src.structure.redeem_eligible_cats;
    delete src.structure.redeem_eligible_extras;
    src.structure.redeem_eligible_items = ['soft_01'];
  });
  assert.deepStrictEqual([...redeemEligibleFrom('la_musa', built).allow], ['soft_01'], 'the item-only store is the complete answer');
  ITEM_ONLY = built;   // exercised through the READER below, where the authored-check actually lives
  ok('a store authoring ONLY the per-item field is the complete answer');
}

// ── (1d) the no-op proof must actually RUN inside the derivation ───────────────────────────────
// A verifier that is never called proves nothing, and no behavioural test can tell — the derivation is
// correct today, so removing the call changes no output. Source-level, like the other wiring guards.
{
  const src = require('fs').readFileSync(require('path').join(__dirname, 'redeem-source.js'), 'utf8')
    .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const body = src.slice(src.indexOf('function deriveRedeemAllow'), src.indexOf('function assertRedeemAllowMatchesToday'));
  assert.ok(/assertRedeemAllowMatchesToday\(restaurantId, items, \{ cats, items: loose \}\);/.test(body),
    'deriveRedeemAllow must run the no-op proof on the answer it is about to return');
  assert.ok(body.indexOf('assertRedeemAllowMatchesToday(') < body.indexOf('return { cats, items: loose }'),
    'and must run it BEFORE returning — a check after the return is no check at all');
  ok('the no-op proof is actually invoked by the derivation, before it returns');
}

// ── (2) THE LANDMINE: a new namespace the globs cannot know about ──────────────────────────────
{
  // La Musa adds wine in the portal — the exact same-brand drift the globs cannot catch.
  const withWine = (src) => {
    src.structure.categories.push({ id: 'vinos' });
    const dish = { id: 'wine_01', cat: 'vinos', name: 'Malbec', price: 260 };
    src.items.push({ key: 'wine_01', price: 260, display: dish });
    src.structure.item_order.push('wine_01');
  };
  const el = redeemEligibleFrom('la_musa', builtFor('la_musa', withWine));
  const t = { restaurantId: 'la_musa', menu: { ...MENU_BY_RESTAURANT.la_musa, wine_01: 260 }, extras: EXTRAS_BY_RESTAURANT.la_musa };
  assert.strictEqual(isRedeemEligible('la_musa', 'wine_01', t, el), false,
    'a dish in a NEW namespace must NOT be redeemable — the store never authorised it');
  // and the drift is real: the code path (today's globs) would comp it, because no glob mentions wine_
  assert.strictEqual(isRedeemEligible('la_musa', 'wine_01', t), true,
    'the denylist WOULD have comped it — free wine, no code change, no alarm (the landmine)');
  ok('a new `wine_*` namespace is NOT redeemable under the store allowlist — the denylist would have comped it free');
}
{
  // The sensible default survives: a new dish in an AUTHORED food category is auto-eligible, exactly
  // as today. Only genuinely new namespaces/categories are fail-closed.
  const el = redeemEligibleFrom('la_musa', builtFor('la_musa', (src) => {
    const dish = { id: 'dimsum_99', cat: 'dim_sum', name: 'Shrimp Har Gow', price: 240 };
    src.items.push({ key: 'dimsum_99', price: 240, display: dish });
    src.structure.item_order.push('dimsum_99');
  }));
  assert.strictEqual(el.allow.has('dimsum_99'), true, 'a new dish in an authored category is auto-eligible (today\'s convenience, preserved)');
  // but a new DRINK in the mixed category is not, because `bebidas` is not an authored category
  const el2 = redeemEligibleFrom('la_musa', builtFor('la_musa', (src) => {
    const dish = { id: 'beer_99', cat: 'bebidas', name: 'New IPA', price: 120 };
    src.items.push({ key: 'beer_99', price: 120, display: dish });
    src.structure.item_order.push('beer_99');
  }));
  assert.strictEqual(el2.allow.has('beer_99'), false, 'a new drink in the MIXED category is not auto-eligible — fail-closed where it matters');
  ok('a new dish in an authored category stays auto-eligible; a new drink in the mixed category does not');
}

// ── (3) The globs survive ONLY as the static fallback (= today) ────────────────────────────────
(async () => {
  const built = builtFor('la_musa');
  const t = tablesFor('la_musa');
  for (const [label, opts] of [
    ['read fails', { getVersionId: async () => 'v1', getMenu: async () => { throw new Error('down'); } }],
    ['unauthored', { getVersionId: async () => 'v1', getMenu: async () => { const b = builtFor('la_musa'); delete b.structure.redeem_eligible_cats; delete b.structure.redeem_eligible_items; delete b.structure.redeem_eligible_extras; return b; } }],
    ['flat',       { getVersionId: async () => null, getMenu: async () => built }],
  ]) {
    const el = await createGateReader(opts).redeemEligibleFor('la_musa');
    assert.strictEqual(el, null, `${label} → static`);
    assert.strictEqual(isRedeemEligible('la_musa', 'dimsum_01', t, el), true, `${label}: a legitimate dish is still redeemable`);
    assert.strictEqual(isRedeemEligible('la_musa', 'beer_01', t, el), false, `${label}: a beer is still refused (the globs still apply on THIS path)`);
    assert.strictEqual(isRedeemEligible('la_musa', 'sauce_aioli', t, el), false, `${label}: a modifier is still refused`);
  }
  ok('the exclude globs survive only as the static fallback — today\'s exact answer when the catalog is unreadable');

  // The authored-check must accept ANY of the three fields. If it only looked at categories, a store
  // whose eligibility is item-only would return null and silently fall back to the code denylist —
  // the landmine reappearing through the fallback door, and invisible to a direct derivation test.
  const itemOnly = await createGateReader({ getVersionId: async () => 'v1', getMenu: async () => ITEM_ONLY }).redeemEligibleFor('la_musa');
  assert.notStrictEqual(itemOnly, null, 'an item-only store must count as AUTHORED, not fall back to the denylist');
  assert.deepStrictEqual([...itemOnly.allow], ['soft_01'], 'and the reader must return that exact answer');
  assert.strictEqual(isRedeemEligible('la_musa', 'dimsum_01', t, itemOnly), false, 'so an unauthored dish is NOT redeemable (the denylist would have allowed it)');
  ok('the reader treats an item-only store as authored — the denylist cannot return through the fallback door');

  // The catalog path must NOT consult the globs: a store that authors a beer means the store wins.
  const authored = redeemEligibleFrom('la_musa', builtFor('la_musa', (src) => { src.structure.redeem_eligible_items = ['soft_01', 'soft_02', 'soft_03', 'soft_04', 'beer_01']; }));
  assert.strictEqual(isRedeemEligible('la_musa', 'beer_01', tablesFor('la_musa'), authored), true,
    'the STORE is the authority: an explicitly authored item is redeemable even though a glob names it');
  ok('the catalog path never consults the globs — the store is the single authority');

  // Parity: both build paths emit the new field, so the cutover stays a provable no-op.
  assertStoreCodeParity('la_musa', builtFor('la_musa'), buildCatalogV2('la_musa'));
  assert.throws(() => assertStoreCodeParity('la_musa', builtFor('la_musa', (s) => { s.structure.redeem_eligible_items = ['soft_01']; }), buildCatalogV2('la_musa')),
    /parity_mismatch/, 'an item-allowlist edit must trip the pre-flip parity gate');
  ok('store == code on the new field, and an edit to it trips the pre-flip parity gate');

  console.log(`redeem-exclusion: OK (${n})`);
  FINISHED = true;
})().catch((e) => { console.error(e); process.exit(1); });
