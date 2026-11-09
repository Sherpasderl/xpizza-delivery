'use strict';
// S1b (D4c-grill/item-s1/S1b-DESIGN.md D4 + the advisor's rulings) — the readers that follow the RESOLVED key: the factura's
// menu order and the weekend gate read the key the resolution stage stamped; the identity backfill keeps keying a published
// record by its own `key`. Run: node catalog/resolve-lines-readers.test.js
const assert = require('assert');
const { PRICING_KEY_STAMP, weekendOnlyViolation, attachTablesKeyMode } = require('../menu-pricing');
const MO = require('./menu-order');
const { resolveLines } = require('./resolve-lines');
const { legacyKeyOf } = require('./identity-backfill');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const MON = Date.parse('2026-11-09T18:00:00Z'); const SAT = Date.parse('2026-11-07T18:00:00Z');

// ── the factura's menu order ranks a line by its stamped key (menu-pricing's own symbol — one symbol, not a look-alike) ──
{
  const stamp = (line, key) => { line[PRICING_KEY_STAMP] = key; return line; };
  const body = [stamp({ name: 'Label B', qty: 1 }, 'K2'), stamp({ name: 'Label A', qty: 1 }, 'K1')];
  const priced = { items: [{ d: 'b' }, { d: 'a' }], factura_items: [{ d: 'b' }, { d: 'a' }], error: null };
  const out = MO.facturaLinesInMenuOrder(priced, body, ['K1', 'K2'], () => {});
  assert.deepStrictEqual(out.items, [{ d: 'a' }, { d: 'b' }], 'RLR-RANK a stamped line ranks by the key that priced it, not by its label');
  const plain = [{ name: 'K2', qty: 1 }, { name: 'K1', qty: 1 }];
  assert.deepStrictEqual(MO.facturaLinesInMenuOrder(priced, plain, ['K1', 'K2'], () => {}).items, [{ d: 'a' }, { d: 'b' }], 'RLR-RANK-LEGACY an unstamped line ranks by name exactly as before');
  ok('the factura\'s menu order reads the stamped key first, then today\'s fields');
}

// ── the weekend gate reads the resolved key ──
{
  // id-keyed (la_musa): the catalog's weekend keys are ids; today the gate compared them with NAMES and never matched
  const LM_TABLES = attachTablesKeyMode({ restaurantId: 'la_musa', menu: { dimsum_01: 249 }, extras: {} }, 'id');
  const b = { items: [{ id: 'dimsum_01', name: 'Sichuan Spicy Wonton', qty: 1 }] };
  assert.deepStrictEqual(resolveLines('la_musa', b, LM_TABLES), { ok: true }, 'premise: the line resolves');
  assert.strictEqual(weekendOnlyViolation(b.items, 'la_musa', MON, new Set(['dimsum_01'])), 'Sichuan Spicy Wonton', 'RLR-WEEKEND-ID an id-keyed weekend-only dish is gated on a weekday (the latent fix — the base answers null)');
  assert.strictEqual(weekendOnlyViolation(b.items, 'la_musa', SAT, new Set(['dimsum_01'])), null, 'RLR-WEEKEND-ID allowed on a Saturday');
  // name-keyed (x_pizza): the resolved key IS the name — every verdict equals today's name rule, stamped or not
  const XP_KEYS = new Set(['Margherita NY', 'Jamon NY']);
  for (const name of ['Margherita NY', 'Jamon NY', 'Carnivora', 'Margherita']) {
    for (const ms of [MON, SAT]) {
      const today = (XP_KEYS.has(name) && ms === MON) ? name : null;   // the base rule: keys.has(it.name)
      const t = attachTablesKeyMode({ restaurantId: 'x_pizza', menu: { [name]: 100 }, extras: {} }, 'name');
      const line = { name, qty: 1 };
      assert.strictEqual(weekendOnlyViolation([line], 'x_pizza', ms, XP_KEYS), today, `RLR-WEEKEND-NAME ${name} unstamped`);
      resolveLines('x_pizza', { items: [line] }, t);
      assert.strictEqual(line[PRICING_KEY_STAMP], name, 'premise: stamped');
      assert.strictEqual(weekendOnlyViolation([line], 'x_pizza', ms, XP_KEYS), today, `RLR-WEEKEND-NAME ${name} stamped`);
    }
  }
  assert.strictEqual(weekendOnlyViolation([{ name: 'Margherita NY', qty: 1 }], 'x_pizza', MON), 'Margherita NY', 'RLR-WEEKEND-STATIC the static fallback is unchanged');
  ok('the weekend gate reads the resolved key: an id-keyed dish is now gated; a name-keyed verdict is today\'s, stamped or not');
}

// ── the identity backfill keys a published record by its own key (a renamed record keeps its key) ──
{
  assert.strictEqual(legacyKeyOf('tb_merch_4', { key: 'Dish One', name: 'Dish One Renamed', display: { id: 1, name: 'Dish One Renamed' } }), 'Dish One', 'RLR-BACKFILL a renamed record is still keyed by record.key');
  ok('the backfill keys a renamed published record by record.key (needs no S1b change — pinned)');
}

console.log(`\nresolve-lines-readers: OK (${n})`);
