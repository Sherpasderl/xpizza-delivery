'use strict';
// S2b (PLAN-structure-S2b-r3 §2) — ONE identity per cart extra. `extra_key` (the customer app's field, sent only while the menu serves
// extra_keys) is validated by resolveLines BEFORE any money step and then read by EVERY consumer through pricing's own resolver
// (extraPricingKey): the total and summary, the eligibility intake, reorder, the quote fingerprint. Without it: today's legacy field.
// Tables from the REAL build of a source carrying a minted extra. Run: node catalog/s2b-resolve.test.js
const assert = require('assert');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { resolveLines } = require('./resolve-lines');
const MP = require('../menu-pricing');
const QT = require('../quote-token');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const MK = 'i_aaaaaaaaaabq';
// la_musa with ONE extra re-keyed to a minted key (its display id = the key; the recorded entry), priced 61
function tablesWithMinted() {
  const s = clone(buildSourceFromCode('la_musa')); const m = s.extras[1]; const old = m.key;
  m.key = MK; m.display.id = MK; m.price = 61; m.display.price = 61;
  for (const f of ['extra_order']) if (Array.isArray(s.structure[f])) s.structure[f] = s.structure[f].map((k) => (k === old ? MK : k));
  for (const f of ['extras_by_category', 'extras_by_item']) if (s.structure[f]) for (const v of Object.values(s.structure[f])) if (Array.isArray(v)) { const i = v.indexOf(old); if (i >= 0) v[i] = MK; }
  if (Array.isArray(s.structure.redeem_eligible_extras)) s.structure.redeem_eligible_extras = s.structure.redeem_eligible_extras.map((k) => (k === old ? MK : k));
  s.frozen_extra_keys = { [MK]: { display_id: MK, minted: true, reuses: old } };
  const { inputs, built } = buildSourceCandidate('la_musa', s);
  const menu = {}; for (const it of built.items) menu[it.key] = it.price;
  return { tables: MP.attachTablesLabels(MP.attachTablesKeyMode({ restaurantId: 'la_musa', menu, extras: inputs.extras }, 'id'), { [`x:${MK}`]: 'Reusado', [`x?:${MK}`]: '1' }) /* the minted extra's label (s2b-labels: an unlabelled minted key is refused) */, other: s.extras[0].key, dish: built.items.find((i) => !i.display.variantOf && !(built.structure.variant_items || {})[i.display.id]) };
}
const T = tablesWithMinted();
const line = (extras) => ({ id: T.dish.key, name: T.dish.display.name, qty: 1, price: T.dish.price, extras });

cell('RESOLVE-KEY: a cart extra naming the minted key by extra_key resolves and PRICES by that key (the legacy field ignored)', () => {
  const body = { items: [line([{ id: 'whatever_legacy', name: 'Algo', qty: 1, extra_key: MK }])] };
  assert.deepStrictEqual(resolveLines('la_musa', body, T.tables), { ok: true });
  const t = MP.computeServerTotal(body.items, 'la_musa', T.tables);
  assert.ok(!t.error && t.total === T.dish.price + 61, `priced by the key (${JSON.stringify(t)})`);
});
cell('STAMP (Codex S2b r1 P2-5): resolveLines stamps ONE server identity on every cart extra; pricing reads the stamp — a wire extra_key changed AFTER resolution never re-prices', () => {
  const body = { items: [line([{ id: 'whatever_legacy', name: 'Algo', qty: 1, extra_key: MK }])] };
  assert.deepStrictEqual(resolveLines('la_musa', body, T.tables), { ok: true });
  const ex = body.items[0].extras[0];
  assert.strictEqual(ex[MP.PRICING_KEY_STAMP], MK, 'the extra carries the resolved key as its stamp');
  ex.extra_key = T.other;   // mutated after the judgment
  assert.strictEqual(MP.extraPricingKey(ex, 'la_musa', 'id'), MK, 'pricing reads the stamp, not the wire extra_key');
  const t = MP.computeServerTotal(body.items, 'la_musa', T.tables);
  assert.ok(!t.error && t.total === T.dish.price + 61, `still priced by the resolved key (${JSON.stringify(t)})`);
  const legacy = { items: [line([{ id: T.other, name: 'X', qty: 1 }])] };
  resolveLines('la_musa', legacy, T.tables);
  assert.strictEqual(legacy.items[0].extras[0][MP.PRICING_KEY_STAMP], T.other, 'a legacy extra is stamped with its legacy key (the same price as today)');
});
cell('RESOLVE-NO-KEY: without extra_key the legacy field decides (today)', () => {
  const body = { items: [line([{ id: T.other, name: 'X', qty: 1 }])] };
  assert.deepStrictEqual(resolveLines('la_musa', body, T.tables), { ok: true });
  assert.strictEqual(MP.extraPricingKey(body.items[0].extras[0], 'la_musa', 'id'), T.other);
});
cell('RESOLVE-BAD: an inactive extra_key is menu_changed; a malformed one, or one contradicting an active legacy key of ANOTHER extra, is invalid_line — never a fallback to the legacy field', () => {
  assert.strictEqual(resolveLines('la_musa', { items: [line([{ id: T.other, qty: 1, extra_key: 'i_zzzzzzzzzzzz' }])] }, T.tables).code, 'menu_changed');
  assert.strictEqual(resolveLines('la_musa', { items: [line([{ id: T.other, qty: 1, extra_key: 7 }])] }, T.tables).code, 'invalid_line');
  assert.strictEqual(resolveLines('la_musa', { items: [line([{ id: T.other, qty: 1, extra_key: MK }])] }, T.tables).code, 'invalid_line');
});
cell('BIND: the quote fingerprint keys an extra by extra_key — same price, different key → a different fingerprint', () => {
  const f = (ek) => QT.cartFingerprint(QT.normalizeCartForFingerprint([line([{ id: 'x', qty: 1, extra_key: ek }])], 'la_musa', 'id'), null);
  assert.notStrictEqual(f(MK), f(T.other));
});

if (fails.length) { console.error(`s2b-resolve FAILED ${fails.length} cell(s): ${fails.join(' | ')}`); process.exit(1); }
console.log(`s2b-resolve: OK (${n})`);
