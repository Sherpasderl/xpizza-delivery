'use strict';
// Guarded pricing resolver — pure/DI'd tests. Run: node catalog/pricing-tables.test.js
const assert = require('assert');
const { createPricingResolver, tablesEqual, menuHash } = require('./pricing-tables');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
// A never-settling await inside the async IIFE drains the event loop and Node exits 0 having run only
// part of the file — a HANG would read as a PASS. This turns "exited before the end" into a failure.
let finished = false;
process.on('exit', (code) => {
  if (code === 0 && !finished) { console.error('FATAL: pricing-tables.test.js exited early (a hang?) without completing'); process.exitCode = 1; }
});

const CODE = { x_pizza: { menu: { Margherita: 299, Pepperoni: 307 }, extras: { Mozzarella: 50 } },
               la_musa: { menu: { dimsum_01: 223 }, extras: { rice_white: 50 } } };
const codeFor = (rid) => ({ menu: CODE[rid].menu, extras: CODE[rid].extras });
const clone = (rid) => JSON.parse(JSON.stringify(CODE[rid]));
const mk = (getTables, opts = {}) => { const seen = []; return { resolver: createPricingResolver({ reader: { getTables }, alarm: async (k, d) => { seen.push([k, d]); }, ...opts }), seen }; };

(async () => {
  // ── PIN A: tablesEqual is STRICT — key sets + exact integer values ──
  assert.strictEqual(tablesEqual(clone('x_pizza'), CODE.x_pizza), true); ok('tablesEqual: identical → true');
  const price = clone('x_pizza'); price.menu.Margherita = 300;
  assert.strictEqual(tablesEqual(price, CODE.x_pizza), false); ok('PIN A: a single differing price → NOT equal');
  const missing = clone('x_pizza'); delete missing.menu.Pepperoni;
  assert.strictEqual(tablesEqual(missing, CODE.x_pizza), false); ok('PIN A: a missing key → NOT equal');
  const extra = clone('x_pizza'); extra.menu.Ghost = 1;
  assert.strictEqual(tablesEqual(extra, CODE.x_pizza), false); ok('PIN A: an extra key → NOT equal');
  const exMiss = clone('x_pizza'); delete exMiss.extras.Mozzarella;
  assert.strictEqual(tablesEqual(exMiss, CODE.x_pizza), false); ok('PIN A: EXTRAS are compared too (missing extra → NOT equal)');
  const strPrice = clone('x_pizza'); strPrice.menu.Margherita = '299';
  assert.strictEqual(tablesEqual(strPrice, CODE.x_pizza), false); ok("PIN A: '299' !== 299 — exact integer equality, no coercion");

  // ── parity holds → the CATALOG is the source (this is the cutover) ──
  for (const rid of ['x_pizza', 'la_musa']) {
    const { resolver, seen } = mk(async (r) => clone(r));
    const t = await resolver.getPricingTables(rid);
    assert.deepStrictEqual(t, { restaurantId: rid, menu: CODE[rid].menu, extras: CODE[rid].extras });
    assert.strictEqual(seen.length, 0, 'no alarm when parity holds');
    ok(`parity holds ${rid} → returns catalog tables, restaurant-TAGGED, no alarm`);
  }

  // ═══ Phase 1d Stage 2c — THE FLIP. The catalog is AUTHORITATIVE. ═══════════════════════════════
  // These assertions are deliberately the INVERSE of the pre-flip ones. Before 2c a catalog that
  // diverged from the code tables was REFUSED and code served; that was correct while code was the
  // source of truth and is exactly wrong now — after a portal edit the catalog is SUPPOSED to differ,
  // and refusing it would silently suppress the edit and keep charging the old price.
  const mkLadder = (over = {}) => ({
    calls: [], recordActive() {}, recordGood() {},
    snapshotFor: async () => { throw new Error('snapshot_fallback_unavailable: x_pizza'); },
    ...over,
  });

  // ── A DIVERGENT catalog is now SERVED (the whole point of the flip) ────────────────────────────
  for (const [label, mutate, expect] of [
    ['a raised price', (c) => { c.menu.Margherita = 350; }, 350],
    ['a lowered price', (c) => { c.menu.Margherita = 199; }, 199],
  ]) {
    const { resolver, seen } = mk(async (r) => { const c = clone(r); mutate(c); return c; });
    const t = await resolver.getPricingTables('x_pizza');
    assert.strictEqual(t.menu.Margherita, expect, `${label} must be SERVED — a portal edit takes effect`);
    assert.notStrictEqual(t.menu.Margherita, CODE.x_pizza.menu.Margherita, 'and it must differ from the retired code table');
    assert.deepStrictEqual(seen, [], 'NO parity alarm — divergence is expected, not an incident');
    ok(`FLIP: ${label} in the catalog is served (pre-flip this fell back to code)`);
  }
  {
    // A NEW item and a REMOVED item both take effect — the catalog defines the menu now.
    const { resolver } = mk(async (r) => { const c = clone(r); c.menu.NewDish = 500; delete c.menu.Pepperoni; return c; });
    const t = await resolver.getPricingTables('x_pizza');
    assert.strictEqual(t.menu.NewDish, 500, 'a catalog-only item is served');
    assert.ok(!('Pepperoni' in t.menu), 'and a removed item is gone');
    ok('FLIP: added and removed items take effect (the catalog defines the menu, not the code table)');
  }
  {
    // The code tables are no longer consulted at all — codeFor is not even a parameter now.
    const resolver = createPricingResolver({ reader: { getTables: async () => ({ menu: { Only: 42 }, extras: {}, versionId: 'v', seq: 1 }) }, alarm: () => {}, ladder: mkLadder() });
    const t = await resolver.getPricingTables('x_pizza');
    assert.deepStrictEqual(t, { restaurantId: 'x_pizza', menu: { Only: 42 }, extras: {} }, 'served purely from the catalog');
    ok('FLIP: the resolver takes no codeFor — the in-code tables are not consulted on the serve path');
  }

  // ── READ FAILURE now falls to the LADDER, not to code ──────────────────────────────────────────
  {
    let asked = null;
    const ladder = mkLadder({ snapshotFor: async (rid) => { asked = rid; return { source: 'last_good', menu: { Margherita: 111 }, extras: { E: 1 } }; } });
    const { resolver, seen } = mk(async () => { throw new Error('firestore down'); }, { ladder });
    const t = await resolver.getPricingTables('x_pizza');
    assert.strictEqual(asked, 'x_pizza', 'the ladder was consulted');
    assert.deepStrictEqual(t, { restaurantId: 'x_pizza', menu: { Margherita: 111 }, extras: { E: 1 } }, 'and its tables served');
    assert.notStrictEqual(t.menu.Margherita, CODE.x_pizza.menu.Margherita, 'NOT the code table — there is no code net any more');
    assert.strictEqual(seen[0][0], 'catalog_read_failed', 'the read failure still alarms');
    ok('FLIP: a catalog read failure falls to the LADDER (not to the code tables) + still alarms');
  }
  {
    const ladder = mkLadder({ snapshotFor: async () => ({ menu: { M: 7 }, extras: {} }) });
    const { resolver, seen } = mk(() => new Promise(() => {}), { ladder, deadlineMs: 20 });
    const t = await resolver.getPricingTables('x_pizza');
    assert.deepStrictEqual(t.menu, { M: 7 }, 'a HANG also falls to the ladder');
    assert.strictEqual(seen[0][0], 'catalog_read_timeout', 'and is still distinguished from an error');
    ok('FLIP: a catalog HANG falls to the ladder too, bounded, with the distinct timeout alarm');
  }

  // ── FAIL-CLOSED: the ladder can refuse, and that PROPAGATES (the caller turns it into a reject) ──
  {
    const { resolver } = mk(async () => { throw new Error('firestore down'); }, { ladder: mkLadder() });
    await assert.rejects(() => resolver.getPricingTables('x_pizza'), /snapshot_fallback_unavailable/,
      'when the ladder cannot vouch for anything the resolver THROWS — it must never invent a price');
    ok('FLIP: ladder fail-closed propagates out of the resolver (no silent code-serve, no guessed price)');
  }
  {
    // No ladder wired at all is also fail-closed, not a quiet code-serve.
    const resolver = createPricingResolver({ reader: { getTables: async () => { throw new Error('down'); } }, alarm: () => {} });
    await assert.rejects(() => resolver.getPricingTables('x_pizza'), /pricing_unavailable/);
    ok('FLIP: with no ladder injected a read failure fail-closes (never falls back to code)');
  }

  // ── The SERVE-PATH TRIPWIRE replaces the parity alarm's visibility ─────────────────────────────
  {
    const logs = [];
    const orig = console.log; console.log = (...a) => { logs.push(a.join(' ')); };
    try {
      // A FRESH restaurant id: the fingerprint/heartbeat throttles are module-level maps, so a rid an
      // earlier case already stamped with a real Date.now() would suppress a synthetic-clock emit here.
      let t = 0;
      const resolver = createPricingResolver({ reader: { getTables: async () => ({ menu: { A: 1, B: 2 }, extras: { E: 3 }, versionId: 'v-9', seq: 4 }) },
        alarm: () => {}, now: () => (t += 120000), ladder: mkLadder() });
      await resolver.getPricingTables('fp_shop_a');
      const fp = logs.find((l) => l.startsWith('catalog_serve_fingerprint'));
      assert.ok(fp, 'a catalog serve must emit the fingerprint');
      const d = JSON.parse(fp.slice('catalog_serve_fingerprint '.length));
      assert.deepStrictEqual([d.restaurantId, d.version, d.seq, d.item_count, d.extra_count], ['fp_shop_a', 'v-9', 4, 2, 1]);
      assert.strictEqual(d.menu_hash, menuHash({ A: 1, B: 2 }), 'the hash identifies WHICH menu served');
      assert.notStrictEqual(menuHash({ A: 1, B: 2 }), menuHash({ A: 1, B: 3 }), 'and a changed price changes the hash');
    } finally { console.log = orig; }
    ok('FLIP: a catalog serve emits catalog_serve_fingerprint (version + menu hash + counts) — the parity alarm\'s replacement');
  }
  {
    // Sampled, not per-order: a busy hour is a handful of lines, not thousands.
    const logs = [];
    const orig = console.log; console.log = (...a) => { logs.push(a.join(' ')); };
    try {
      let t = 1000;
      const resolver = createPricingResolver({ reader: { getTables: async () => ({ menu: { A: 1 }, extras: {}, versionId: 'v', seq: 1 }) }, alarm: () => {}, now: () => t, ladder: mkLadder() });
      for (let i = 0; i < 5; i++) await resolver.getPricingTables('fp_shop_b');
      assert.strictEqual(logs.filter((l) => l.startsWith('catalog_serve_fingerprint')).length, 1, 'throttled within the window');
      t += 120000;
      await resolver.getPricingTables('fp_shop_b');
      assert.strictEqual(logs.filter((l) => l.startsWith('catalog_serve_fingerprint')).length, 2, 'emits again after the window');
    } finally { console.log = orig; }
    ok('FLIP: the fingerprint is sampled per restaurant (observability, not a per-order log)');
  }

  // ── The ladder keeps WARMING on the happy path (it is load-bearing now) ────────────────────────
  {
    const rec = [];
    const ladder = mkLadder({ recordGood: (rid, r) => rec.push(['good', rid, r.seq]), recordActive: (rid, v, sq) => rec.push(['active', rid, sq]) });
    const { resolver } = mk(async (r) => ({ ...clone(r), versionId: 'v-2', seq: 2 }), { ladder });
    await resolver.getPricingTables('x_pizza');
    assert.deepStrictEqual(rec, [['active', 'x_pizza', 2], ['good', 'x_pizza', 2]], 'both recorders fire on a serve');
    ok('FLIP: the happy path still records active + last-good — the ladder stays warm for the next outage');
  }

  // ── INERT AT FLIP: on a frozen menu (catalog == code) the served price is unchanged ────────────
  {
    const { resolver } = mk(async (r) => clone(r));
    for (const rid of ['x_pizza', 'la_musa']) {
      assert.deepStrictEqual(await resolver.getPricingTables(rid), { restaurantId: rid, menu: CODE[rid].menu, extras: CODE[rid].extras },
        `${rid}: with catalog == code the flip changes nothing served`);
    }
    ok('INERT AT FLIP: on the frozen menu (catalog == code) the served tables are byte-identical to pre-flip');
  }

  finished = true;
  console.log(`pricing-tables: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
