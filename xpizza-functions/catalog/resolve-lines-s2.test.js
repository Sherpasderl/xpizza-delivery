'use strict';
// S2 (D4c-grill/item-s1/S2-DESIGN.md §2 r1 A + A2; advisor rulings 2026-11-10) — ONE resolved identity for every money consumer.
//   A  «item_key wins»: a held item_key decides the line whatever its legacy field says; a cart carrying ANY item_key is fully
//      resolved (the option-A passthrough is for item_key-free carts only, i.e. today's clients, byte-identically).
//   A2 a reward line that CARRIES item_key and disagrees (or is malformed) is refused before preparation, on the line the brand's
//      reward calculator actually consumes; a key-less reward line keeps today's passthrough.
// Tables are built as the reader builds them (a real built catalog → docs → buildTablesFromDocs). Run: node catalog/resolve-lines-s2.test.js
const assert = require('assert');
const { resolveLines, resolutionRefusal } = require('./resolve-lines');
const { PRICING_KEY_STAMP, attachTablesKeyMode, itemPricingKey } = require('../menu-pricing');
const { pricedLineItems } = require('../factura/pricing');
const { buildTablesFromDocs } = require('./catalog-transform');
const { buildSourceCandidate } = require('./candidate-validate');
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const tablesOf = (rid) => {
  const { built } = buildSourceCandidate(rid, buildSourceFromCode(rid));
  const t = buildTablesFromDocs(built.items.map((i) => ({ key: i.key, price: i.price })), (built.extras || []).map((e) => ({ key: e.key, price: e.price })));
  return attachTablesKeyMode({ restaurantId: rid, ...t }, built.key_mode);
};
const XP = tablesOf('x_pizza'); const LM = tablesOf('la_musa');
// two held keys with DIFFERENT prices, per brand
const pair = (T) => { const ks = Object.keys(T.menu); const a = ks[0]; const b = ks.find((k) => T.menu[k] !== T.menu[a]); return [a, b]; };
const [XA, XB] = pair(XP); const [LA, LB] = pair(LM);
assert.ok(XB && LB, 'premise: each menu has two differently priced dishes');
const stampOf = (line) => line[PRICING_KEY_STAMP];
const refused = (r) => [r.ok, r.code];

// ── A: a held item_key decides the line, whatever its legacy field says ──
{
  const b = { items: [{ item_key: XA, name: XB, qty: 1 }] };
  assert.deepStrictEqual(resolveLines('x_pizza', b, XP), { ok: true }, 'S2A-KEY-WINS a held key with a disagreeing legacy name resolves');
  assert.strictEqual(stampOf(b.items[0]), XA, 'S2A-KEY-WINS stamped with the KEY');
  assert.strictEqual(itemPricingKey(b.items[0], 'x_pizza'), XA, 'S2A-PRICE pricing reads the key, never the legacy name');
  const f = pricedLineItems(b.items, XP.menu, XP.extras, null, null);
  assert.strictEqual(f.items[0].line_gross_cents, XP.menu[XA] * 100, 'S2A-PRICE the factura line is priced by the key (never the different-priced legacy dish)');
  const l = { items: [{ item_key: LA, id: LB, name: 'Otro', qty: 1 }] };
  assert.deepStrictEqual(resolveLines('la_musa', l, LM), { ok: true }, 'S2A-KEY-WINS-ID id-keyed too');
  assert.strictEqual(itemPricingKey(l.items[0], 'la_musa'), LA, 'S2A-PRICE-ID');
  ok('a held item_key wins over a disagreeing legacy field; price and factura follow the key');
}

// ── A: a cart carrying ANY item_key is fully resolved — no unstamped passthrough ──
{
  const probe = { items: [{ item_key: XA, name: [XB], qty: 1 }] };
  assert.deepStrictEqual(refused(resolveLines('x_pizza', probe, XP)), [false, 'invalid_line'], 'S2A-PROBE item_key + a non-string legacy field → invalid_line (Codex: priced the legacy dish)');
  assert.strictEqual(resolutionRefusal(resolveLines('x_pizza', { items: [{ item_key: XA, name: [XB], qty: 1 }] }, XP)).status, 400, 'S2A-PROBE a 400');
  const mixed = { items: [{ item_key: XA, name: XA, qty: 1 }, { name: [XB], qty: 1 }] };
  assert.deepStrictEqual(refused(resolveLines('x_pizza', mixed, XP)), [false, 'invalid_line'], 'S2A-MIXED a keyed cart with a malformed key-less line → invalid_line');
  assert.strictEqual(stampOf(mixed.items[0]), undefined, 'S2A-MIXED nothing stamped on a refusal');
  ok('a cart carrying any item_key is fully resolved: the probe and a mixed cart are refused');
}

// ── A: today's clients (no item_key anywhere) answer byte-identically ──
{
  const legacyBad = { items: [{ name: [XB], qty: 1 }] };
  assert.deepStrictEqual(resolveLines('x_pizza', legacyBad, XP), { ok: true }, 'S2A-LEGACY-PASSTHROUGH an item_key-free malformed cart passes through (today\'s refusal answers)');
  assert.strictEqual(stampOf(legacyBad.items[0]), undefined, 'S2A-LEGACY-PASSTHROUGH unstamped');
  const legacyOk = { items: [{ name: XA, qty: 1 }] };
  assert.deepStrictEqual(resolveLines('x_pizza', legacyOk, XP), { ok: true }, 'S2A-LEGACY a legacy line resolves as today');
  assert.strictEqual(stampOf(legacyOk.items[0]), XA);
  ok('item_key-free carts answer exactly as today');
}

// ── A2: a keyed reward line that disagrees is refused before preparation, on the line the brand consumes ──
{
  const xr = { items: [{ name: XA, qty: 1 }], redeem: { type: 'free_pizza_choice', item_id: XB, item_key: XA } };
  const r = resolveLines('x_pizza', xr, XP);
  assert.deepStrictEqual(refused(r), [false, 'invalid_line'], 'S2A2-X-PROBE x_pizza: redeem.item_key A with item_id B → invalid_line (never fulfils B)');
  assert.strictEqual(resolutionRefusal(r).status, 400, 'S2A2-X-PROBE a 400');
  const lr = { items: [{ id: LA, name: 'x', qty: 1 }], redeem: { type: 'points_ala_carte', items: [{ id: LB, item_key: LA, qty: 1 }] } };
  assert.deepStrictEqual(refused(resolveLines('la_musa', lr, LM)), [false, 'invalid_line'], 'S2A2-L-PROBE la_musa: items[].item_key A with id B → invalid_line');
  const xm = { items: [{ name: XA, qty: 1 }], redeem: { type: 'free_pizza_choice', item_id: XA, item_key: XA } };
  assert.deepStrictEqual(resolveLines('x_pizza', xm, XP), { ok: true }, 'S2A2-X-MATCH a matching keyed reward resolves');
  assert.strictEqual(stampOf(xm.redeem), XA, 'S2A2-X-MATCH and is stamped');
  const xbad = { items: [{ name: XA, qty: 1 }], redeem: { type: 'free_pizza_choice', item_id: XA, item_key: '' } };
  assert.deepStrictEqual(refused(resolveLines('x_pizza', xbad, XP)), [false, 'invalid_line'], 'S2A2-X-MALFORMED a malformed reward item_key → invalid_line');
  ok('a keyed reward mismatch or malformed key is refused before preparation, both brands');
}

// ── A2: a key-less reward line keeps today's passthrough; the brand's consumed shape is the one judged ──
{
  const xl = { items: [{ name: XA, qty: 1 }], redeem: { type: 'free_pizza_choice', item_id: 'No Existe' } };
  assert.deepStrictEqual(resolveLines('x_pizza', xl, XP), { ok: true }, 'S2A2-KEYLESS an unknown key-less reward passes through (today\'s legacy codes answer)');
  const both = { items: [{ name: XA, qty: 1 }], redeem: { type: 'free_pizza_choice', item_id: XB, item_key: XA, items: [{ id: XA, item_key: XA, qty: 1 }] } };
  assert.deepStrictEqual(refused(resolveLines('x_pizza', both, XP)), [false, 'invalid_line'], 'S2A2-SHAPE x_pizza is judged on redeem.item_id (what its calculator reads), not on items[]');
  const lboth = { items: [{ id: LA, name: 'x', qty: 1 }], redeem: { type: 'points_ala_carte', item_id: LA, item_key: LA, items: [{ id: LB, item_key: LA, qty: 1 }] } };
  assert.deepStrictEqual(refused(resolveLines('la_musa', lboth, LM)), [false, 'invalid_line'], 'S2A2-SHAPE-L la_musa is judged on items[] (what its calculator reads)');
  ok('key-less rewards pass through as today; each brand is judged on the shape its calculator consumes');
}

// ── A2 (Codex S2 code r1 P1-2): a KEYED reward line is judged FIRST, on its own, against the namespace its calculator consumes ──
{
  const refusedAt = (r) => [r.ok, r.code, r.at];
  const xUnknown = { items: [{ name: XA, qty: 1 }], redeem: { type: 'free_pizza_choice', item_key: 'not-held', item_id: XA } };
  assert.deepStrictEqual(refusedAt(resolveLines('x_pizza', xUnknown, XP)), [false, 'invalid_line', 'redeem'], 'S2A2-UNKNOWN-KEY a keyed reward naming a key the tables do not hold beside another id is refused (a mismatch), never fulfilled by its legacy id');
  const xNotHeld = { items: [{ name: XA, qty: 1 }], redeem: { type: 'free_pizza_choice', item_key: 'not-held', item_id: 'not-held' } };
  assert.deepStrictEqual(refusedAt(resolveLines('x_pizza', xNotHeld, XP)), [false, 'menu_changed', 'redeem'], 'S2A2-NOT-HELD an agreeing keyed reward the tables do not hold → menu_changed (refused, never discarded)');
  const extraKey = Object.keys(LM.extras)[0];
  const lMismatch = { items: [{ id: LA, name: 'x', qty: 1 }], redeem: { type: 'points_ala_carte', items: [{ item_key: extraKey, id: LB, qty: 1 }] } };
  assert.deepStrictEqual(refusedAt(resolveLines('la_musa', lMismatch, LM)), [false, 'invalid_line', 'redeem'], 'S2A2-L-EXTRA-MISMATCH a keyed la_musa reward naming an EXTRA key with another id is refused (never redeems the id)');
  const lExtra = { items: [{ id: LA, name: 'x', qty: 1 }], redeem: { type: 'points_ala_carte', items: [{ item_key: extraKey, id: extraKey, qty: 1 }] } };
  assert.deepStrictEqual(resolveLines('la_musa', lExtra, LM), { ok: true }, 'S2A2-L-EXTRA an agreeing keyed reward on an EXTRA (the calculator\'s second namespace) resolves');
  const bypass = { items: [{ name: [XB], qty: 1 }], redeem: { type: 'free_pizza_choice', item_key: XA, item_id: XB } };
  assert.deepStrictEqual(refusedAt(resolveLines('x_pizza', bypass, XP)), [false, 'invalid_line', 'redeem'], 'S2A2-PASSTHROUGH-BYPASS a malformed legacy cart never lets a keyed reward mismatch through');
  const emptyCart = { items: [], redeem: { type: 'free_pizza_choice', item_key: XA, item_id: XB } };
  assert.deepStrictEqual(refusedAt(resolveLines('x_pizza', emptyCart, XP)), [false, 'invalid_line', 'redeem'], 'S2A2-EMPTY-CART an empty cart never lets a keyed reward mismatch through');
  const keyless = { items: [{ name: [XB], qty: 1 }], redeem: { type: 'free_pizza_choice', item_id: 'No Existe' } };
  assert.deepStrictEqual(resolveLines('x_pizza', keyless, XP), { ok: true }, 'S2A2-KEYLESS-PASSTHROUGH a key-less reward on a legacy cart keeps today\'s passthrough');
  ok('a keyed reward is judged first against its consumed namespace: unknown → menu_changed, mismatch → invalid_line, never bypassed');
}

console.log(`\nresolve-lines-s2: OK (${n})`);
