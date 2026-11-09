'use strict';
// S1b (PLAN-portal-item-edit r6 §2.4; D4c-grill/item-s1/S1b-DESIGN.md + the advisor's rulings) — the resolution stage, pure.
// STRICT in S1b: every accepted line resolves to a key EQUAL to its legacy field (name on a name-keyed menu, id on an id-keyed
// one), so pricing, rewards and fingerprints see exactly today's keys. Tables are built as the reader builds them: a real built
// catalog → its {key, price} docs → buildTablesFromDocs → the key mode attached. Run: node catalog/resolve-lines.test.js
const assert = require('assert');
const { resolveLines, resolutionRefusal } = require('./resolve-lines');
const { PRICING_KEY_STAMP, attachTablesKeyMode, itemPricingKey } = require('../menu-pricing');
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
assert.ok(Object.prototype.hasOwnProperty.call(XP.menu, 'Carnivora') && Object.prototype.hasOwnProperty.call(LM.menu, 'dimsum_01'), 'premise: the real menus');
const body = (items, redeem) => ({ items, ...(redeem ? { redeem } : {}) });
const stampOf = (line) => line[PRICING_KEY_STAMP];

// ── legacy lines: exact own-key equality, stamped with that key ──
{
  const b = body([{ name: 'Carnivora', qty: 1 }]);
  assert.deepStrictEqual(resolveLines('x_pizza', b, XP), { ok: true }, 'RL-LEGACY-NAME a known name resolves');
  assert.strictEqual(stampOf(b.items[0]), 'Carnivora', 'RL-STAMP the resolved key is stamped');
  assert.strictEqual(itemPricingKey(b.items[0], 'x_pizza'), 'Carnivora', 'RL-STAMP pricing reads the same key');
  const l = body([{ id: 'dimsum_01', name: 'Sichuan Spicy Wonton', qty: 1 }]);
  assert.deepStrictEqual(resolveLines('la_musa', l, LM), { ok: true }, 'RL-LEGACY-ID an id-keyed line resolves by id');
  assert.strictEqual(stampOf(l.items[0]), 'dimsum_01');
  ok('a legacy line resolves by exact equality to its own key and is stamped with it');
}

// ── item_key: must be held by the tables and agree with the legacy field (strict) ──
{
  const b = body([{ item_key: 'Carnivora', name: 'Carnivora', qty: 1 }]);
  assert.deepStrictEqual(resolveLines('x_pizza', b, XP), { ok: true }, 'RL-KEY-AGREE');
  assert.strictEqual(stampOf(b.items[0]), 'Carnivora');
  const only = body([{ item_key: 'Carnivora', qty: 1 }]);
  assert.deepStrictEqual(resolveLines('x_pizza', only, XP), { ok: false, code: 'menu_changed', at: 'items', index: 0 }, 'RL-KEY-ONLY an item_key line with no legacy field refuses menu_changed in S1b (advisor Q1)');
  assert.strictEqual(stampOf(only.items[0]), undefined, 'RL-KEY-ONLY never stamped, never priced');
  const lm = body([{ item_key: 'dimsum_01', id: 'dimsum_01', qty: 1 }]);
  assert.deepStrictEqual(resolveLines('la_musa', lm, LM), { ok: true }, 'RL-KEY-AGREE-ID');
  ok('an item_key line resolves only when it agrees with its legacy field; an item_key alone refuses (S1b)');
}

// ── unknown: menu_changed, the FIRST refused line named ──
{
  assert.deepStrictEqual(resolveLines('x_pizza', body([{ name: 'Carnivora', qty: 1 }, { name: 'Nope', qty: 1 }]), XP), { ok: false, code: 'menu_changed', at: 'items', index: 1 }, 'RL-UNKNOWN');
  assert.deepStrictEqual(resolveLines('x_pizza', body([{ item_key: 'Nope', name: 'Nope', qty: 1 }]), XP), { ok: false, code: 'menu_changed', at: 'items', index: 0 }, 'RL-UNKNOWN-KEY');
  for (const k of ['__proto__', 'toString', 'constructor', 'hasOwnProperty']) {
    assert.deepStrictEqual(resolveLines('x_pizza', body([{ name: k, qty: 1 }]), XP), { ok: false, code: 'menu_changed', at: 'items', index: 0 }, `RL-OWN only own keys resolve (${k})`);
  }
  assert.deepStrictEqual(resolveLines('la_musa', body([{ id: 'Carnivora', name: 'Carnivora', qty: 1 }]), LM), { ok: false, code: 'menu_changed', at: 'items', index: 0 }, 'RL-CROSS another menu\'s key is unknown here');
  assert.deepStrictEqual(resolveLines('x_pizza', body([{ id: 2, name: 'Nope', qty: 1 }]), XP), { ok: false, code: 'menu_changed', at: 'items', index: 0 }, 'RL-FIELD a name-keyed menu never consults id');
  ok('an unknown key refuses menu_changed, naming the first refused line; only own keys count');
}

// ── malformed: invalid_line (the intentional tightening — today an array name prices by coercion) ──
{
  const bad = [
    ['x_pizza', XP, { name: ['Carnivora'], qty: 1 }, 'RL-ARRAY an array name'],
    ['x_pizza', XP, { name: 5, qty: 1 }, 'RL-NUMBER a number name'],
    ['x_pizza', XP, { name: { toString: () => 'Carnivora' }, qty: 1 }, 'RL-OBJECT an object name'],
    ['la_musa', LM, { id: ['dimsum_01'], qty: 1 }, 'RL-ARRAY-ID an array id'],
    ['x_pizza', XP, { item_key: 5, name: 'Carnivora', qty: 1 }, 'RL-KEY-TYPE a non-string item_key'],
    ['x_pizza', XP, { item_key: '', name: 'Carnivora', qty: 1 }, 'RL-KEY-EMPTY an empty item_key'],
    ['x_pizza', XP, { item_key: 'Carnivora', name: 'Margherita', qty: 1 }, 'RL-DISAGREE item_key and name disagree'],
    ['x_pizza', XP, { item_key: 'Carnivora', name: ['Carnivora'], qty: 1 }, 'RL-DISAGREE-TYPE a non-string legacy field beside item_key'],
  ];
  for (const [rid, t, line, label] of bad) {
    const b = body([line]);
    assert.deepStrictEqual(resolveLines(rid, b, t), { ok: false, code: 'invalid_line', at: 'items', index: 0 }, label);
    assert.strictEqual(stampOf(b.items[0]), undefined, `${label}: never stamped`);
  }
  ok('a non-string or disagreeing field refuses invalid_line, never stamped');
}

// ── a cart the stage does not judge passes through untouched (validateOrderPayload keeps today's errors) ──
{
  for (const b of [{}, { items: null }, { items: 'x' }, { items: [] }, { items: [null] }, { items: [{ name: 'Carnivora', qty: 1 }, 7] }]) {
    const before = JSON.stringify(b);
    assert.deepStrictEqual(resolveLines('x_pizza', b, XP), { ok: true }, `RL-PASS ${before}`);
    assert.strictEqual(JSON.stringify(b), before, 'untouched');
    for (const it of Array.isArray(b.items) ? b.items : []) if (it && typeof it === 'object') assert.strictEqual(stampOf(it), undefined, 'RL-PASS a cart that is not judged is not stamped');
  }
  assert.deepStrictEqual(resolveLines('x_pizza', body([{ name: 'Carnivora', qty: 1 }]), null), { ok: true }, 'RL-NO-TABLES no tables ⇒ not judged (the caller has already failed closed)');
  ok('a malformed cart (not a non-empty array of objects) or absent tables pass through untouched');
}

// ── reward lines: the same rule (advisor Q3) ──
{
  const r = body([{ name: 'Carnivora', qty: 1 }], { item_id: 'Carnivora' });
  assert.deepStrictEqual(resolveLines('x_pizza', r, XP), { ok: true }, 'RL-REDEEM-ID');
  assert.deepStrictEqual(resolveLines('x_pizza', body([{ name: 'Carnivora', qty: 1 }], { item_id: 'Nope' }), XP), { ok: false, code: 'menu_changed', at: 'redeem', index: 0 }, 'RL-REDEEM-UNKNOWN');
  assert.deepStrictEqual(resolveLines('x_pizza', body([{ name: 'Carnivora', qty: 1 }], { item_id: ['Carnivora'] }), XP), { ok: false, code: 'invalid_line', at: 'redeem', index: 0 }, 'RL-REDEEM-ARRAY');
  assert.deepStrictEqual(resolveLines('x_pizza', body([{ name: 'Carnivora', qty: 1 }], { item_id: 'Carnivora', item_key: 'Carnivora' }), XP), { ok: true }, 'RL-REDEEM-KEY-AGREE');
  assert.deepStrictEqual(resolveLines('x_pizza', body([{ name: 'Carnivora', qty: 1 }], { item_key: 'Carnivora' }), XP), { ok: false, code: 'menu_changed', at: 'redeem', index: 0 }, 'RL-REDEEM-KEY-ONLY');
  assert.deepStrictEqual(resolveLines('la_musa', body([{ id: 'dimsum_01', qty: 1 }], { items: [{ id: 'dimsum_01' }, { id: 'nope_99' }] }), LM), { ok: false, code: 'menu_changed', at: 'redeem', index: 1 }, 'RL-REDEEM-ITEMS');
  assert.deepStrictEqual(resolveLines('la_musa', body([{ id: 'dimsum_01', qty: 1 }], { items: [{ id: 'dimsum_01' }] }), LM), { ok: true }, 'RL-REDEEM-ITEMS-OK');
  assert.deepStrictEqual(resolveLines('x_pizza', body([{ name: 'Carnivora', qty: 1 }], { points: 10 }), XP), { ok: true }, 'RL-REDEEM-NONE a redeem with no item is not judged');
  ok('reward lines (redeem.item_id / items[].id / item_key) follow the same rule');
}

// ── the refusal each endpoint sends ──
{
  assert.deepStrictEqual(resolutionRefusal({ ok: false, code: 'menu_changed', at: 'items', index: 1 }),
    { status: 409, body: { error: 'menu_changed', detail: 'El menú se actualizó, recargá la página', retryable: false } }, 'RL-REFUSAL-409');
  assert.deepStrictEqual(resolutionRefusal({ ok: false, code: 'invalid_line', at: 'redeem', index: 0 }),
    { status: 400, body: { error: 'invalid_line', at: 'redeem', index: 0 } }, 'RL-REFUSAL-400');
  ok('menu_changed → 409 «El menú se actualizó, recargá la página» (not retryable); invalid_line → 400 naming the line');
}

console.log(`\nresolve-lines: OK (${n})`);
