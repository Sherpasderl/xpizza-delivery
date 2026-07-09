'use strict';
/**
 * Unit tests for checkItemAvailability (KDS Phase 2b · Slice 4 — the server intake "86" fail-safe).
 * Run: `node availability-gate.test.js`
 *
 * Proves: fail-open matrix (absent/false/read-error/unknown-key/non-boolean), per-restaurant key
 * resolution mirrors pricing (x_pizza→name, la_musa→id), human labels, dedup, and a SINGLE read of
 * /restaurants/{rid}/item_availability (never N per-item reads).
 */
const assert = require('assert');
const { checkItemAvailability } = require('./availability-gate');
const { availKey } = require('./avail-key');
const { itemPricingKey } = require('./menu-pricing');

// Mock db. `throwOnRead` makes .once() reject (simulates a Firebase hiccup). Counts reads so we can
// assert exactly ONE read of the item_availability node.
function makeDb(node, { throwOnRead = false } = {}) {
  const reads = [];
  return {
    reads,
    ref(path) {
      return {
        async once() {
          reads.push(path);
          if (throwOnRead) throw new Error('simulated RTDB read failure');
          return { val: () => node };
        }
      };
    }
  };
}
// Build an item_availability node from a {rawKey: available} map, encoding keys via availKey.
function nodeFrom(map) {
  const n = {};
  for (const [raw, available] of Object.entries(map)) {
    n[availKey(raw)] = (available && typeof available === 'object') ? available : { available, updated_at: 1 };
  }
  return n;
}

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

(async () => {
  // ── FAIL-OPEN MATRIX ──────────────────────────────────────────────────────
  // absent node ⇒ allow all
  {
    const db = makeDb(null);
    const r = await checkItemAvailability(db, [{ name: 'Margherita', qty: 1 }], 'x_pizza');
    assert.deepStrictEqual(r.blocked, []);
    ok('absent node ⇒ allow (fail-open)');
  }
  // explicit available:false ⇒ BLOCK
  {
    const db = makeDb(nodeFrom({ 'Margherita': false }));
    const r = await checkItemAvailability(db, [{ name: 'Margherita', qty: 1 }], 'x_pizza');
    assert.deepStrictEqual(r.blocked, ['Margherita']);
    ok('available:false ⇒ block');
  }
  // read error (throw) ⇒ allow all
  {
    const db = makeDb(nodeFrom({ 'Margherita': false }), { throwOnRead: true });
    const r = await checkItemAvailability(db, [{ name: 'Margherita', qty: 1 }], 'x_pizza');
    assert.deepStrictEqual(r.blocked, []);
    ok('read error (throw) ⇒ allow (fail-open, no 500)');
  }
  // unknown key (node has other items, not this one) ⇒ allow
  {
    const db = makeDb(nodeFrom({ 'Pepperoni': false }));
    const r = await checkItemAvailability(db, [{ name: 'Margherita', qty: 1 }], 'x_pizza');
    assert.deepStrictEqual(r.blocked, []);
    ok('unknown key (absent from node) ⇒ allow');
  }
  // available:true ⇒ allow
  {
    const db = makeDb(nodeFrom({ 'Margherita': true }));
    const r = await checkItemAvailability(db, [{ name: 'Margherita', qty: 1 }], 'x_pizza');
    assert.deepStrictEqual(r.blocked, []);
    ok('available:true ⇒ allow');
  }
  // non-boolean `available` (string "false", 0, null, missing prop) ⇒ allow (only strict === false blocks)
  {
    for (const bad of ['false', 0, null, 1, {}, [], undefined]) {
      const db = makeDb({ [availKey('Margherita')]: { available: bad, updated_at: 1 } });
      const r = await checkItemAvailability(db, [{ name: 'Margherita', qty: 1 }], 'x_pizza');
      assert.deepStrictEqual(r.blocked, [], `available:${JSON.stringify(bad)} must NOT block`);
    }
    // entry itself not an object
    for (const bad of [false, 'x', 3, true]) {
      const db = makeDb({ [availKey('Margherita')]: bad });
      const r = await checkItemAvailability(db, [{ name: 'Margherita', qty: 1 }], 'x_pizza');
      assert.deepStrictEqual(r.blocked, [], `non-object entry ${JSON.stringify(bad)} must NOT block`);
    }
    ok('non-boolean available / non-object entry ⇒ allow (only strict boolean false blocks)');
  }

  // ── KEY RESOLUTION MIRRORS PRICING ────────────────────────────────────────
  // x_pizza keys by NAME — a matching id must be IGNORED
  {
    const db = makeDb(nodeFrom({ 'Margherita': false }));
    // Line has an `id` that would 86 nothing (x_pizza ignores id); name is what matters.
    const r = await checkItemAvailability(db, [{ id: 'ignored', name: 'Margherita', qty: 1 }], 'x_pizza');
    assert.deepStrictEqual(r.blocked, ['Margherita']);
    // Confirm the resolver used is the pricing resolver.
    assert.strictEqual(itemPricingKey({ id: 'ignored', name: 'Margherita' }, 'x_pizza'), 'Margherita');
    ok('x_pizza resolves by NAME (id ignored) — mirrors pricing');
  }
  // la_musa keys by ID — the human `name` becomes the label, id is the availability key
  {
    const db = makeDb(nodeFrom({ 'noodle_01': false }));
    const r = await checkItemAvailability(db, [{ id: 'noodle_01', name: 'Dan Dan Noodles', qty: 1 }], 'la_musa');
    assert.deepStrictEqual(r.blocked, ['Dan Dan Noodles']);   // human label, not the slug
    assert.strictEqual(itemPricingKey({ id: 'noodle_01', name: 'Dan Dan Noodles' }, 'la_musa'), 'noodle_01');
    ok('la_musa resolves by ID; label is the human name — mirrors pricing');
  }
  // la_musa without a name falls back to the raw id as the label
  {
    const db = makeDb(nodeFrom({ 'noodle_01': false }));
    const r = await checkItemAvailability(db, [{ id: 'noodle_01', qty: 1 }], 'la_musa');
    assert.deepStrictEqual(r.blocked, ['noodle_01']);
    ok('la_musa without name ⇒ label falls back to raw id');
  }
  // key with special chars (availKey encoding round-trips) — a name with "/" and "." blocks correctly
  {
    const raw = 'Cacio e Pepe . NY/2';
    const db = makeDb(nodeFrom({ [raw]: false }));
    const r = await checkItemAvailability(db, [{ name: raw, qty: 1 }], 'x_pizza');
    assert.deepStrictEqual(r.blocked, [raw]);
    ok('name with RTDB-forbidden chars (./ ) blocks via availKey encoding');
  }

  // ── MIXED CART, DEDUP, ONE READ ───────────────────────────────────────────
  {
    const db = makeDb(nodeFrom({ 'Margherita': false, 'Anchovies': false, 'Pepperoni': true }));
    const items = [
      { name: 'Margherita', qty: 1 },
      { name: 'Pepperoni', qty: 2 },   // available
      { name: 'Anchovies', qty: 1 },
      { name: 'Margherita', qty: 3 },  // duplicate 86'd line → label appears once
      { name: 'Ham', qty: 1 }          // unknown key → available
    ];
    const r = await checkItemAvailability(db, items, 'x_pizza');
    assert.deepStrictEqual(r.blocked, ['Margherita', 'Anchovies']);  // order preserved, deduped
    assert.strictEqual(db.reads.length, 1, 'exactly ONE read of item_availability for a 5-line cart');
    assert.strictEqual(db.reads[0], 'restaurants/x_pizza/item_availability');
    ok('mixed cart: blocks only unavailable lines, dedups labels, SINGLE node read (not N)');
  }

  // ── DEGENERATE INPUTS ─────────────────────────────────────────────────────
  {
    for (const bad of [null, undefined, [], 'x', 42, {}]) {
      const db = makeDb(nodeFrom({ 'Margherita': false }));
      const r = await checkItemAvailability(db, bad, 'x_pizza');
      assert.deepStrictEqual(r.blocked, [], `items=${JSON.stringify(bad)} ⇒ blocked:[]`);
      assert.strictEqual(db.reads.length, 0, 'empty/invalid items ⇒ no read at all');
    }
    // unkeyed line (no name/id) ⇒ skipped, available
    const db = makeDb(nodeFrom({ 'Margherita': false }));
    const r = await checkItemAvailability(db, [{ qty: 1 }], 'x_pizza');
    assert.deepStrictEqual(r.blocked, []);
    ok('empty/invalid items ⇒ blocked:[] + no read; unkeyed line ⇒ available');
  }

  console.log(`\nAll ${pass} checkItemAvailability test groups passed.`);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
