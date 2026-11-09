'use strict';
// S1b (PLAN-portal-item-edit r6 §2.4; D4c-grill/item-s1/S1b-DESIGN.md + the advisor's rulings) — the resolution stage, pure.
// STRICT in S1b: every accepted line resolves to a key EQUAL to its legacy field (name on a name-keyed menu, id on an id-keyed
// one), so pricing, rewards and fingerprints see exactly today's keys. Tables are built as the reader builds them: a real built
// catalog → its {key, price} docs → buildTablesFromDocs → the key mode attached. Run: node catalog/resolve-lines.test.js
const assert = require('assert');
const { resolveLines, labelGap, resolutionRefusal } = require('./resolve-lines');
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
  assert.deepStrictEqual(resolveLines('x_pizza', only, XP), { ok: true }, 'RL-KEY-ONLY S1d (ruling Q2): an item_key line with no legacy field resolves when the tables hold the key');
  assert.strictEqual(stampOf(only.items[0]), 'Carnivora', 'RL-KEY-ONLY stamped with its key');
  const onlyUnknown = body([{ item_key: 'Nope', qty: 1 }]);
  assert.deepStrictEqual(resolveLines('x_pizza', onlyUnknown, XP), { ok: false, code: 'menu_changed', at: 'items', index: 0 }, 'RL-KEY-ONLY-UNKNOWN an unknown item_key alone refuses menu_changed');
  const lm = body([{ item_key: 'dimsum_01', id: 'dimsum_01', qty: 1 }]);
  assert.deepStrictEqual(resolveLines('la_musa', lm, LM), { ok: true }, 'RL-KEY-AGREE-ID');
  ok('an item_key line resolves when it agrees with its legacy field, or alone (S1d); an unknown item_key refuses menu_changed');
}

// ── S1d D2 (ruling Q2): agreement widens to the version's LABEL when the tables carry labels; without them, strict as S1b ──
{
  const { attachTablesLabels, keyModeOfTables: keyModeOf } = require('../menu-pricing');
  const labelled = (t, labels) => attachTablesLabels(attachTablesKeyMode({ restaurantId: t.restaurantId, menu: t.menu, extras: t.extras }, keyModeOf(t)), labels);
  const XPL = labelled(XP, { Carnivora: 'Carnívora Suprema' });
  const agree = body([{ item_key: 'Carnivora', name: 'Carnívora Suprema', qty: 1 }]);
  assert.deepStrictEqual(resolveLines('x_pizza', agree, XPL), { ok: true }, 'RL-LABEL-AGREE a renamed dish: item_key + its current label resolves');
  assert.strictEqual(stampOf(agree.items[0]), 'Carnivora', 'RL-LABEL-AGREE stamped with the KEY, never the label');
  assert.deepStrictEqual(resolveLines('x_pizza', body([{ item_key: 'Carnivora', name: 'Carnívora Suprema', qty: 1 }]), XP), { ok: false, code: 'invalid_line', at: 'items', index: 0 }, 'RL-LABEL-NONE a route without labels stays strict');
  assert.deepStrictEqual(resolveLines('x_pizza', body([{ item_key: 'Carnivora', name: 'Otra', qty: 1 }]), XPL), { ok: false, code: 'invalid_line', at: 'items', index: 0 }, 'RL-LABEL-WRONG a name that is neither the key nor its label refuses');
  assert.deepStrictEqual(resolveLines('x_pizza', body([{ name: 'Carnívora Suprema', qty: 1 }]), XPL), { ok: false, code: 'menu_changed', at: 'items', index: 0 }, 'RL-LEGACY-NEWNAME a legacy line naming the NEW label (an old client) refuses menu_changed — legacy lines stay exact-key');
  assert.deepStrictEqual(resolveLines('x_pizza', body([{ item_key: 'Nope', name: 'Carnívora Suprema', qty: 1 }]), XPL), { ok: false, code: 'menu_changed', at: 'items', index: 0 }, 'RL-LABEL-UNKNOWN-KEY an unknown item_key refuses menu_changed even if the name is a label');
  // D3 early gate: on a route without a label for an OPAQUE resolved key, the order endpoints refuse before any write
  const OPQ = 'i_aaaaaaaaaaaa';
  const withOpaque = (labels) => attachTablesLabels(attachTablesKeyMode({ restaurantId: 'x_pizza', menu: { ...XP.menu, [OPQ]: 199 }, extras: XP.extras }, 'name'), labels);
  const gapBody = () => body([{ item_key: OPQ, qty: 1 }]);
  const g1 = gapBody(); resolveLines('x_pizza', g1, withOpaque(null));
  assert.strictEqual(labelGap(g1, withOpaque(null)), true, 'RL-LABELGAP an opaque key with no label on this route');
  const g2 = gapBody(); resolveLines('x_pizza', g2, withOpaque({ [OPQ]: 'Pizza Nueva' }));
  assert.strictEqual(labelGap(g2, withOpaque({ [OPQ]: 'Pizza Nueva' })), false, 'RL-LABELGAP-OK its label is here');
  const g3 = body([{ name: 'Carnivora', qty: 1 }]); resolveLines('x_pizza', g3, XP);
  assert.strictEqual(labelGap(g3, XP), false, 'RL-LABELGAP-LEGACY a legacy key is its own description (no gap)');
  const g4 = body([{ name: 'Carnivora', qty: 1 }], { item_id: OPQ }); resolveLines('x_pizza', g4, withOpaque(null));
  assert.strictEqual(labelGap(g4, withOpaque(null)), true, 'RL-LABELGAP-REWARD a resolved opaque reward key with no label');
  ok('S1d: item_key agrees with its legacy field OR the version\'s label; without labels strict; legacy lines exact-key');
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

// ── a malformed LEGACY field is not judged (advisor ruling, option A, 2026-11-09): today's item_malformed check (and pricing's
//    own 400) refuse it exactly as at the base, with the customer copy — the whole cart passes through unstamped ──
{
  const notJudged = [
    ['x_pizza', XP, { name: ['Carnivora'], qty: 1 }, 'RL-ARRAY an array name'],
    ['x_pizza', XP, { name: 5, qty: 1 }, 'RL-NUMBER a number name'],
    ['x_pizza', XP, { name: { toString: () => 'Carnivora' }, qty: 1 }, 'RL-OBJECT an object name'],
    ['la_musa', LM, { id: ['dimsum_01'], qty: 1 }, 'RL-ARRAY-ID an array id'],
    ['x_pizza', XP, { name: null, qty: 1 }, 'RL-NULL-NAME a null name on a name-keyed menu'],
    ['la_musa', LM, { id: null, name: 'Sichuan Spicy Wonton', qty: 1 }, 'RL-NULL-ID a null id on an id-keyed menu'],
    ['x_pizza', XP, { item_key: 'Carnivora', name: ['Carnivora'], qty: 1 }, 'RL-DISAGREE-TYPE a non-string legacy field beside item_key'],
    ['x_pizza', XP, { qty: 1 }, 'RL-ABSENT no legacy field and no item_key'],
    ['x_pizza', XP, { item_key: 'Carnivora', name: null, qty: 1 }, 'RL-NULL-NAME-KEY a null name beside an item_key (null is never read as absent)'],
  ];
  for (const [rid, t, line, label] of notJudged) {
    const good = rid === 'x_pizza' ? { name: 'Carnivora', qty: 1 } : { id: 'dimsum_01', qty: 1 };
    const b = body([good, line], { item_id: rid === 'x_pizza' ? 'Carnivora' : 'dimsum_01' });
    assert.deepStrictEqual(resolveLines(rid, b, t), { ok: true }, `${label}: not judged (today's refusal answers it)`);
    assert.deepStrictEqual([stampOf(b.items[0]), stampOf(b.items[1]), stampOf(b.redeem)], [undefined, undefined, undefined], `${label}: the whole cart passes through unstamped`);
  }
  ok('a malformed legacy field (non-string, null) or a line naming nothing is not judged: the cart passes through unstamped');
}

// ── a malformed or disagreeing item_key (the NEW field — no legacy code): invalid_line, never stamped ──
{
  const bad = [
    ['x_pizza', XP, { item_key: 5, name: 'Carnivora', qty: 1 }, 'RL-KEY-TYPE a non-string item_key'],
    ['x_pizza', XP, { item_key: '', name: 'Carnivora', qty: 1 }, 'RL-KEY-EMPTY an empty item_key'],
    ['x_pizza', XP, { item_key: ['Carnivora'], qty: 1 }, 'RL-KEY-TYPE-ALONE a non-string item_key with no legacy field'],
    ['x_pizza', XP, { item_key: '', qty: 1 }, 'RL-KEY-EMPTY-ALONE an empty item_key with no legacy field'],
    ['x_pizza', XP, { name: 'Carnivora', item_key: null, qty: 1 }, 'RL-NULL-KEY a null item_key beside a good name'],
    ['x_pizza', XP, { item_key: 'Carnivora', name: 'Margherita', qty: 1 }, 'RL-DISAGREE item_key and name disagree'],
  ];
  for (const [rid, t, line, label] of bad) {
    const b = body([line]);
    assert.deepStrictEqual(resolveLines(rid, b, t), { ok: false, code: 'invalid_line', at: 'items', index: 0 }, label);
    assert.strictEqual(stampOf(b.items[0]), undefined, `${label}: never stamped`);
  }
  // a null in the field the mode does NOT use changes nothing
  const nx = body([{ name: 'Carnivora', id: null, qty: 1 }]);
  assert.deepStrictEqual(resolveLines('x_pizza', nx, XP), { ok: true }, 'RL-NULL-OTHER a null id on a name-keyed menu is not judged');
  assert.strictEqual(stampOf(nx.items[0]), 'Carnivora', 'RL-NULL-OTHER stamped with its name');
  ok('a malformed or disagreeing item_key refuses invalid_line, never stamped');
}

// ── a cart the stage does not judge passes through untouched (validateOrderPayload keeps today's errors) ──
{
  for (const b of [{ items: [{ name: 'Carnivora', qty: 1 }, 7] }, { items: [{ name: 'Carnivora', qty: 1 }, null] }, {}, { items: null }, { items: 'x' }, { items: [] }, { items: [null] }]) {
    const before = JSON.stringify(b);
    let r; try { r = resolveLines('x_pizza', b, XP); } catch (e) { assert.fail(`RL-PASS ${before} threw (an order DROP at the endpoint): ${e.message}`); }
    assert.deepStrictEqual(r, { ok: true }, `RL-PASS ${before}`);
    assert.strictEqual(JSON.stringify(b), before, 'untouched');
    for (const it of Array.isArray(b.items) ? b.items : []) if (it && typeof it === 'object') assert.strictEqual(stampOf(it), undefined, 'RL-PASS a cart that is not judged is not stamped');
  }
  assert.deepStrictEqual(resolveLines('x_pizza', body([{ name: 'Carnivora', qty: 1 }]), null), { ok: true }, 'RL-NO-TABLES no tables ⇒ not judged (the caller has already failed closed)');
  ok('a malformed cart (not a non-empty array of objects) or absent tables pass through untouched');
}

// ── reward lines (advisor Q3 ruling: legacy refusal codes kept until the frozen forms retire) — stamped only when they
//    resolve; an unknown, malformed or item_key-only reward line is NOT refused here: it falls through to prepareRedemption,
//    whose 409 redemption_invalid the frozen forms' classifyRedeemError handles ──
{
  const r = body([{ name: 'Carnivora', qty: 1 }], { item_id: 'Carnivora' });
  assert.deepStrictEqual(resolveLines('x_pizza', r, XP), { ok: true }, 'RL-REDEEM-ID');
  assert.strictEqual(stampOf(r.redeem), 'Carnivora', 'RL-REDEEM-STAMP a resolved reward line is stamped');
  for (const [redeem, label] of [[{ item_id: 'Nope' }, 'RL-REDEEM-UNKNOWN'], [{ item_id: ['Carnivora'] }, 'RL-REDEEM-ARRAY'], [{ item_key: 'Carnivora' }, 'RL-REDEEM-KEY-ONLY'],
    [{ item_id: 'Carnivora', item_key: 'Margherita' }, 'RL-REDEEM-DISAGREE']]) {
    const b = body([{ name: 'Carnivora', qty: 1 }], redeem);
    assert.deepStrictEqual(resolveLines('x_pizza', b, XP), { ok: true }, `${label} falls through to today's reward refusal`);
    assert.strictEqual(stampOf(b.redeem), undefined, `${label}: never stamped`);
    assert.strictEqual(stampOf(b.items[0]), 'Carnivora', `${label}: the cart lines still resolve and are stamped`);
  }
  assert.deepStrictEqual(resolveLines('x_pizza', body([{ name: 'Carnivora', qty: 1 }], { item_id: 'Carnivora', item_key: 'Carnivora' }), XP), { ok: true }, 'RL-REDEEM-KEY-AGREE');
  const li = body([{ id: 'dimsum_01', qty: 1 }], { items: [{ id: 'dimsum_01' }, { id: 'nope_99' }, 'x'] });
  assert.deepStrictEqual(resolveLines('la_musa', li, LM), { ok: true }, 'RL-REDEEM-ITEMS an unknown la_musa reward item falls through');
  assert.deepStrictEqual([stampOf(li.redeem.items[0]), stampOf(li.redeem.items[1])], ['dimsum_01', undefined], 'RL-REDEEM-ITEMS only the resolved one is stamped');
  assert.deepStrictEqual(resolveLines('x_pizza', body([{ name: 'Carnivora', qty: 1 }], { points: 10 }), XP), { ok: true }, 'RL-REDEEM-NONE');
  ok('reward lines are stamped only when they resolve; any other reward line falls through to today\'s refusal (Q3)');
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
