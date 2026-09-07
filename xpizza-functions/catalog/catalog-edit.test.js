'use strict';
// Portal 2b-1 Task 1 — the DIFF and the hash-bound token. Run: node catalog/catalog-edit.test.js
//
// 2a's yardstick was "the store must equal the code". From 2b on, divergence is the POINT, so that
// yardstick is gone and two things replace it: a server-generated diff that a human reviews, and a
// token that binds the publish to exactly that reviewed state.
//
// Both are load-bearing in a way worth naming. The diff is the ONLY thing standing between a merchant
// and a mistyped price, so a change it fails to surface is a change nobody reviewed. The token is the
// only thing making the review binding — without it, a publish could land a draft that was edited after
// the diff was shown, and the review would be of something else entirely.
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);   // set BEFORE require
const { catalogDiff, issueEditToken, verifyEditToken } = require('./catalog-edit');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// A built catalog in the shape publish/parity already use: { items, structure, extras }.
const build = (rid, mutate) => {
  const src = buildSourceFromCode(rid);
  if (mutate) mutate(src);
  const { priceTable, formData, extras } = sourceToBuildInputs(src);
  return { ...buildCatalogV2(rid, { formData, priceTable }), extras };
};
const find = (list, key) => list.filter((x) => x.key === key);
const fieldOf = (d, key, field) => d.changed.find((c) => c.key === key && c.field === field);

// ── (a) NO CHANGE → an empty diff. The baseline everything else is measured against. ────────────
for (const rid of ['x_pizza', 'la_musa']) {
  const d = catalogDiff(build(rid), build(rid));
  assert.deepStrictEqual(d.added, [], `${rid}: nothing added`);
  assert.deepStrictEqual(d.removed, [], `${rid}: nothing removed`);
  assert.deepStrictEqual(d.renamed, [], `${rid}: nothing renamed`);
  assert.deepStrictEqual(d.changed, [], `${rid}: nothing changed`);
  assert.deepStrictEqual(d.largeChangeSet, [], `${rid}: no sanity trips`);
}
ok('no-change → a fully empty diff, both brands (the baseline: any noise here is a false alarm forever)');

// ── (b) A PRICE CHANGE, over and under the sanity threshold ────────────────────────────────────
{
  const live = build('x_pizza');
  const base = live.items.find((i) => i.key === 'Margherita').price;
  const modest = build('x_pizza', (s) => { s.items.find((i) => i.key === 'Margherita').price = base + 30; });
  const d = catalogDiff(live, modest);
  const c = fieldOf(d, 'Margherita', 'price');
  assert.ok(c, 'a price change must appear in `changed`');
  assert.deepStrictEqual([c.surface, c.old, c.new], ['item', base, base + 30], 'with the exact old and new');
  assert.strictEqual(d.largeChangeSet.length, 0, 'a modest change must NOT trip the sanity threshold');
  assert.strictEqual(d.added.length + d.removed.length + d.renamed.length, 0, 'and must not look like an add/remove');

  // the fat-finger: an extra zero
  const fat = build('x_pizza', (s) => { s.items.find((i) => i.key === 'Margherita').price = base * 10; });
  const df = catalogDiff(live, fat);
  const lc = find(df.largeChangeSet, 'Margherita');
  assert.strictEqual(lc.length, 1, 'a 10x price MUST trip the sanity set — this is the fat-finger case');
  assert.deepStrictEqual([lc[0].reason, lc[0].old, lc[0].new], ['swing_gt_50', base, base * 10], 'reported with the reason and both prices');
  assert.ok(fieldOf(df, 'Margherita', 'price'), 'and it is still in `changed` (the sanity set is an overlay, not a replacement)');

  // a large DROP trips too — a 90%-off mistake costs money just as fast as a 10x
  const cheap = build('x_pizza', (s) => { s.items.find((i) => i.key === 'Margherita').price = Math.round(base * 0.1); });
  assert.strictEqual(find(catalogDiff(live, cheap).largeChangeSet, 'Margherita').length, 1, 'a large DOWNWARD swing trips too — losing money is still money');

  // and the boundary is a boundary: just under 50% must not trip, just over must
  const under = build('x_pizza', (s) => { s.items.find((i) => i.key === 'Margherita').price = Math.floor(base * 1.49); });
  const over = build('x_pizza', (s) => { s.items.find((i) => i.key === 'Margherita').price = Math.ceil(base * 1.51); });
  assert.strictEqual(catalogDiff(live, under).largeChangeSet.length, 0, '+49% does not trip');
  assert.strictEqual(catalogDiff(live, over).largeChangeSet.length, 1, '+51% does');
}
ok('price changes: exact old→new in `changed`; >50% swing either direction trips the sanity set; the boundary holds');

// ── (c) A NEW PRICED ITEM has no baseline to sanity-check against → always surfaced ─────────────
{
  const live = build('la_musa');
  const withNew = build('la_musa', (s) => {
    s.items.push({ key: 'dimsum_99', price: 240, display: { id: 'dimsum_99', cat: 'dim_sum', name: 'Har Gow', price: 240 } });
    s.structure.item_order.push('dimsum_99');
  });
  const d = catalogDiff(live, withNew);
  assert.deepStrictEqual(d.added.map((a) => a.key), ['dimsum_99'], 'the new dish is an addition');
  assert.strictEqual(d.added[0].surface, 'item', 'on the item surface');
  const lc = find(d.largeChangeSet, 'dimsum_99');
  assert.deepStrictEqual([lc.length, lc[0].reason, lc[0].old, lc[0].new], [1, 'new_priced', null, 240],
    'a new priced item has NO baseline, so it can never be sanity-checked — it is always surfaced');
  assert.deepStrictEqual(d.removed, [], 'and nothing was removed');
}
ok('a new priced item is `added` + always in the sanity set (`new_priced`) — no baseline means no threshold');

// ── (d) A RENAME must not read as a deletion. x_pizza prices BY NAME, so a rename moves the key. ─
{
  const live = build('x_pizza');
  const price = live.items.find((i) => i.key === 'Margherita').price;
  const renamed = build('x_pizza', (s) => {
    const it = s.items.find((i) => i.key === 'Margherita');
    it.key = 'Margherita DOP'; it.display.name = 'Margherita DOP';
    s.structure.item_order[s.structure.item_order.indexOf('Margherita')] = 'Margherita DOP';
  });
  const d = catalogDiff(live, renamed);
  assert.deepStrictEqual(d.renamed, [{ surface: 'item', from: 'Margherita', to: 'Margherita DOP', price }],
    'a rename must be PAIRED — shown as add+remove it reads as "a dish was deleted", which is a different decision');
  assert.deepStrictEqual(d.added, [], 'not reported as an addition');
  assert.deepStrictEqual(d.removed, [], 'nor as a removal');
  assert.strictEqual(d.largeChangeSet.length, 0, 'and a pure rename changes no price, so nothing trips');

  // AMBIGUITY MUST NOT BE GUESSED. Two dishes at the same price, one removed and one added, cannot be
  // told apart from a rename — and calling a deletion a "rename" hides it from the person reviewing.
  const same = live.items.filter((i) => i.price === price).map((i) => i.key);
  assert.ok(same.length >= 1, 'premise');
  const twoWay = build('x_pizza', (s) => {
    s.items = s.items.filter((i) => i.key !== 'Margherita' && i.key !== 'Pepperoni');
    s.structure.item_order = s.structure.item_order.filter((k) => k !== 'Margherita' && k !== 'Pepperoni');
    for (const nm of ['Alpha', 'Beta']) {
      s.items.push({ key: nm, price, display: { id: 900, cat: 'individual', name: nm, price } });
      s.structure.item_order.push(nm);
    }
  });
  const amb = catalogDiff(live, twoWay);
  assert.strictEqual(amb.renamed.length, 0, 'ambiguous pairing must NOT be guessed');
  assert.ok(amb.removed.some((r) => r.key === 'Margherita'), 'the removals stay visible as removals');
  assert.ok(amb.added.some((a) => a.key === 'Alpha'), 'and the additions as additions');
  // TWO renames, arriving in live order (Mushroom idx 3 before Anchovies idx 8) but sorting the other
  // way. A single rename is ordered by accident — the same one-element trap as the lists below.
  const twoRenames = catalogDiff(live, build('x_pizza', (s) => {
    for (const [from, to] of [['Mushroom', 'Aaa Mushroom'], ['Anchovies', 'Zzz Anchovies']]) {
      const it = s.items.find((i) => i.key === from);
      it.key = to; it.display.name = to;
      s.structure.item_order[s.structure.item_order.indexOf(from)] = to;
    }
  }));
  assert.strictEqual(twoRenames.renamed.length, 2, 'both renames pair');
  assert.deepStrictEqual(twoRenames.renamed.map((r) => r.from), ['Anchovies', 'Mushroom'],
    'and are emitted in a deterministic order — renames are hashed into the token like everything else');
}
ok('a rename is paired (not a hidden deletion); an AMBIGUOUS pairing is never guessed; multiple renames are ordered');

// ── (e) EXTRAS are priced too, so the diff must cover them ─────────────────────────────────────
{
  const live = build('la_musa');
  const key = Object.keys(live.extras)[0];
  const was = live.extras[key];
  const d = catalogDiff(live, build('la_musa', (s) => { s.extras.find((e) => e.key === key).price = was + 15; }));
  const c = fieldOf(d, key, 'price');
  assert.ok(c && c.surface === 'extra', 'an EXTRA price change must be surfaced — extras are money too');
  assert.deepStrictEqual([c.old, c.new], [was, was + 15], 'with the exact old and new');
  // and on the other brand, where extras are keyed by NAME rather than id
  const xl = build('x_pizza');
  const xk = Object.keys(xl.extras)[0];
  const xd = catalogDiff(xl, build('x_pizza', (s) => { s.extras.find((e) => e.key === xk).price = xl.extras[xk] * 3; }));
  assert.ok(fieldOf(xd, xk, 'price'), 'x_pizza extras (name-keyed) are covered too');
  assert.strictEqual(find(xd.largeChangeSet, xk).length, 1, 'and a 3x extra trips the sanity set like any other price');
}
ok('extras are diffed on both brands (id-keyed and name-keyed) and trip the sanity set like items');

// ── (f) NON-PRICE surfaces a customer sees, and the GATES that decide what is orderable ────────
{
  const live = build('x_pizza');
  const d = catalogDiff(live, build('x_pizza', (s) => { s.items.find((i) => i.key === 'Margherita').display.desc = 'a new description'; }));
  assert.ok(fieldOf(d, 'Margherita', 'desc'), 'a description edit is a real change the merchant should see');
  assert.strictEqual(d.largeChangeSet.length, 0, 'but it is not a money change, so it does not trip the sanity set');

  // GATE membership, per item — the thing 2a proved can silently change what is orderable/redeemable.
  // Expressed per ITEM, not as "weekend_only_cats changed": the category list is not what a human checks.
  const gated = catalogDiff(live, build('x_pizza', (s) => { s.structure.weekend_only_cats = []; }));
  const g = fieldOf(gated, 'Margherita NY', 'weekend_only');
  assert.ok(g, 'releasing a weekend gate must surface PER ITEM, not as an opaque category-list change');
  assert.deepStrictEqual([g.old, g.new], [true, false], 'showing what actually changed for that dish');
  const red = catalogDiff(live, build('x_pizza', (s) => { s.structure.redeem_eligible_cats = []; }));
  assert.ok(fieldOf(red, 'Margherita', 'redeem_eligible'), 'and so must redemption eligibility — it decides what is comped free');

  // la_musa authors eligibility as categories UNION per-item keys (2a Task 6b: `bebidas` holds both
  // beers and redeemable softs, so the softs are listed individually). A diff reading only the category
  // half would show nothing when a merchant de-authorises a soft drink — and this brand is the ONLY
  // place that half is exercised, which is exactly how the la_musa reader bug hid in 2a.
  const lmLive = build('la_musa');
  assert.ok((lmLive.structure.redeem_eligible_items || []).includes('soft_01'), 'premise: la_musa lists items individually');
  const lmDiff = catalogDiff(lmLive, build('la_musa', (s) => {
    s.structure.redeem_eligible_items = s.structure.redeem_eligible_items.filter((k) => k !== 'soft_01');
  }));
  const lg2 = fieldOf(lmDiff, 'soft_01', 'redeem_eligible');
  assert.ok(lg2, 'de-authorising an individually-listed item MUST surface (the category half alone would miss it)');
  assert.deepStrictEqual([lg2.old, lg2.new], [true, false], 'showing it losing eligibility');
  // and the reverse: authorising a beer must surface, because that comps alcohol for free
  const beerDiff = catalogDiff(lmLive, build('la_musa', (s) => { s.structure.redeem_eligible_items = [...s.structure.redeem_eligible_items, 'beer_01']; }));
  const bg = fieldOf(beerDiff, 'beer_01', 'redeem_eligible');
  assert.ok(bg && bg.old === false && bg.new === true, 'authorising a beer must surface — free alcohol is exactly what a human must see');
}
ok('display edits, and the per-item weekend/redeem GATE flags, are all surfaced (gates per item, not per category)');

// ── (g) THE TOKEN. It is what makes the review binding. ────────────────────────────────────────
{
  const live = build('x_pizza');
  const draft = build('x_pizza', (s) => { s.items.find((i) => i.key === 'Margherita').price += 25; });
  const diff = catalogDiff(live, draft);
  const state = { rid: 'x_pizza', baseActiveVersionId: 'v-100', sourceUpdateTime: '2026-09-07T10:00:00.000Z', sourceHash: 'abc123', diff };
  const token = issueEditToken(state);
  assert.strictEqual(typeof token, 'string', 'a token is a string');
  assert.ok(token.length > 32, 'and not a trivial one');
  assert.strictEqual(verifyEditToken(token, state).ok, true, 'it verifies against the state it was issued for');

  // Each bound field, changed one at a time. Any of these means the publish would land something other
  // than what was reviewed.
  const drift = [
    ['baseActiveVersionId', { ...state, baseActiveVersionId: 'v-101' }, 'someone else published in between'],
    ['sourceUpdateTime', { ...state, sourceUpdateTime: '2026-09-07T10:00:01.000Z' }, 'the draft moved after the diff was shown'],
    ['sourceHash', { ...state, sourceHash: 'abc124' }, 'the draft CONTENT differs from the reviewed one'],
    ['rid', { ...state, rid: 'la_musa' }, 'a token for one brand must not publish another'],
    ['diff', { ...state, diff: catalogDiff(live, build('x_pizza', (s) => { s.items.find((i) => i.key === 'Margherita').price += 26; })) }, 'the change is not the one shown'],
  ];
  for (const [field, mutated, why] of drift) {
    const v = verifyEditToken(token, mutated);
    assert.strictEqual(v.ok, false, `a changed ${field} MUST fail — ${why}`);
    assert.ok(typeof v.reason === 'string' && v.reason.length, `and say why (${field})`);
  }
  // forgery
  assert.strictEqual(verifyEditToken('not-a-token', state).ok, false, 'garbage is not a token');
  assert.strictEqual(verifyEditToken('', state).ok, false, 'and neither is nothing');
  assert.strictEqual(verifyEditToken(null, state).ok, false, 'nor null');
  const flipped = token.slice(0, -1) + (token.slice(-1) === 'a' ? 'b' : 'a');
  assert.strictEqual(verifyEditToken(flipped, state).ok, false, 'a single flipped character invalidates it');
  ok('the token binds rid + live version + draft time + draft content + the exact diff; any drift or forgery fails');
}
{
  // The largeChangeSet is bound too: a publish must not be able to acknowledge a DIFFERENT set of
  // scary changes than the one the token was issued for.
  const live = build('x_pizza');
  const price = live.items.find((i) => i.key === 'Margherita').price;
  const big = build('x_pizza', (s) => { s.items.find((i) => i.key === 'Margherita').price = price * 10; });
  const state = { rid: 'x_pizza', baseActiveVersionId: 'v1', sourceUpdateTime: 't1', sourceHash: 'h1', diff: catalogDiff(live, big) };
  assert.ok(state.diff.largeChangeSet.length > 0, 'premise: this diff has a scary change');
  const token = issueEditToken(state);
  const laundered = { ...state, diff: { ...state.diff, largeChangeSet: [] } };
  assert.strictEqual(verifyEditToken(token, laundered).ok, false,
    'a caller must not be able to strip the sanity set and publish the same change as if it were routine');
  ok('the sanity set is bound into the token — it cannot be laundered away at publish time');
}
{
  // The secret is the whole basis of the binding. A missing or weak one must fail CLOSED, loudly —
  // never fall back to an empty key, which would make every token forgeable by anyone.
  const path = require.resolve('./catalog-edit');
  const saved = process.env.EDIT_TOKEN_SECRET;
  for (const bad of [undefined, '', 'short']) {
    delete require.cache[path];
    if (bad === undefined) delete process.env.EDIT_TOKEN_SECRET; else process.env.EDIT_TOKEN_SECRET = bad;
    const fresh = require('./catalog-edit');
    assert.throws(() => fresh.issueEditToken({ rid: 'x_pizza', diff: { added: [], removed: [], renamed: [], changed: [], largeChangeSet: [] } }),
      /EDIT_TOKEN_SECRET/, `a ${bad === undefined ? 'missing' : `weak ("${bad}")`} secret must THROW, not sign with a default`);
    // ...but the pure diff must still be usable — a misconfigured secret should not take the whole module down
    assert.doesNotThrow(() => fresh.catalogDiff(build('x_pizza'), build('x_pizza')), 'the pure diff does not need the secret');
  }
  delete require.cache[path];
  process.env.EDIT_TOKEN_SECRET = saved;
  ok('a missing or too-short EDIT_TOKEN_SECRET throws on token use (never signs with a default), and does not disable the pure diff');
}
// ── (h) THE DIFF IS HASHED, so its ORDER must be a property of the content, not of the input ────
// Map iteration follows insertion order, which follows the input build's array order. If the emitted
// arrays inherited that, two logically identical reviews could hash differently — and the token binding
// would be unstable for reasons nobody could see. Sorted output is what makes the hash a function of
// the change alone.
{
  const live = build('x_pizza');
  // Every list must have SEVERAL entries arriving in an order that is not the sorted one — a list of one
  // is sorted by accident, which is how three of these four assertions passed against unsorted code.
  // Live order starts Carnivora, Crispy Bacon, Sweet Corn…, Mushroom — so removing Mushroom then
  // Carnivora arrives reversed. Additions are pushed Zeta-then-Alpha, at prices matching nothing that
  // was removed, so nothing pairs as a rename.
  const draft = build('x_pizza', (s) => {
    for (const k of ['Margherita', 'Pepperoni', 'Anchovies', 'Mushroom']) s.items.find((i) => i.key === k).price += 20;
    for (const k of ['Sweet Corn & Calabrian Chili', 'Spinach']) {   // live order Sweet-then-Spinach; sorted is the reverse
      s.items = s.items.filter((i) => i.key !== k);
      s.structure.item_order = s.structure.item_order.filter((x) => x !== k);
    }
    for (const [nm, pr] of [['Zeta', 777], ['Alpha', 888]]) {
      s.items.push({ key: nm, price: pr, display: { id: 900, cat: 'individual', name: nm, price: pr } });
      s.structure.item_order.push(nm);
    }
    // two more sanity trips, so largeChangeSet also has several and arrives in live order
    s.items.find((i) => i.key === 'Pepperoni').price *= 9;
    s.items.find((i) => i.key === 'Anchovies').price *= 8;
  });
  const d = catalogDiff(live, draft);
  assert.ok(d.changed.length >= 4, 'premise: several changes');
  for (const list of ['added', 'removed', 'largeChangeSet']) {
    assert.ok(d[list].length >= 2, `premise: ${list} must have SEVERAL entries or its ordering is untested (has ${d[list].length})`);
  }
  assert.deepStrictEqual(d.renamed, [], 'premise: nothing pairs as a rename here');
  const sortKey = (x) => x.surface + x.key + (x.field || x.reason || '');
  for (const list of ['added', 'removed', 'changed', 'largeChangeSet']) {
    const keys = d[list].map(sortKey);
    assert.deepStrictEqual(keys, [...keys].sort(), `${list} must be emitted in a deterministic order — it is hashed into the token`);
  }
  assert.strictEqual(JSON.stringify(catalogDiff(live, draft)), JSON.stringify(d), 'and recomputing over the same inputs is byte-identical');
  const st = { rid: 'x_pizza', baseActiveVersionId: 'v1', sourceUpdateTime: 't1', sourceHash: 'h1', diff: d };
  assert.strictEqual(issueEditToken(st), issueEditToken({ ...st, diff: catalogDiff(live, draft) }), 'so the token is stable across recomputation');
  ok('the diff is emitted in a deterministic order and hashes stably — the token binding depends on it');
}
console.log(`catalog-edit: OK (${n})`);
