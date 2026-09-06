'use strict';
// Portal 2a Task 5 — the WEEKEND GATE sourced from the catalog, not a static code Set.
// Run: node catalog/menu-gates.test.js
//
// MONEY-ADJACENT: this is a PRE-CHARGE gate. It decides whether an order is accepted at all, so its
// failure modes matter as much as its verdicts. The migration must (a) return the identical verdict
// while store == code, and (b) actually TRACK a store edit — a static set would keep enforcing
// yesterday's menu after a portal change, which is the silent-drift landmine this phase exists to kill.
const assert = require('assert');
const { createGateReader, weekendOnlyKeysFrom } = require('./menu-gates');
const { weekendOnlyViolation, X_PIZZA_WEEKEND_ONLY } = require('../menu-pricing');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const MON = Date.UTC(2026, 8, 7, 18, 0, 0);   // a Monday in Honduras (UTC-6)
const SAT = Date.UTC(2026, 8, 12, 18, 0, 0);  // a Saturday
const builtFor = (rid, mutate) => {
  const s = buildSourceFromCode(rid); if (mutate) mutate(s);
  const { priceTable, formData } = sourceToBuildInputs(s);
  return buildCatalogV2(rid, { formData, priceTable });
};

// ── (a) IDENTICAL VERDICT while store == code ─────────────────────────────────────────────────
{
  const keys = weekendOnlyKeysFrom('x_pizza', builtFor('x_pizza'));
  assert.deepStrictEqual([...keys].sort(), [...X_PIZZA_WEEKEND_ONLY].sort(),
    'the catalog-derived weekend-only set must equal the static code set exactly');
  ok(`store == code: the catalog-derived weekend set equals X_PIZZA_WEEKEND_ONLY exactly (${keys.size} items)`);
  // and item-by-item through the real predicate, on a weekday AND a weekend
  const built = builtFor('x_pizza');
  for (const it of built.items) {
    for (const [label, ms] of [['weekday', MON], ['weekend', SAT]]) {
      const codeVerdict = weekendOnlyViolation([{ name: it.key }], 'x_pizza', ms);
      const storeVerdict = weekendOnlyViolation([{ name: it.key }], 'x_pizza', ms, weekendOnlyKeysFrom('x_pizza', built));
      assert.strictEqual(storeVerdict, codeVerdict, `${it.key} on a ${label}: store-sourced verdict must equal code-sourced`);
    }
  }
  ok(`store == code: identical verdict for all ${built.items.length} x_pizza items × weekday and weekend`);
  // la_musa has no weekend gate — must stay a no-op, not become one by accident
  assert.strictEqual(weekendOnlyViolation([{ id: 'dimsum_01' }], 'la_musa', MON, weekendOnlyKeysFrom('la_musa', builtFor('la_musa'))), null);
  assert.strictEqual(weekendOnlyKeysFrom('la_musa', builtFor('la_musa')).size, 0, 'la_musa has no weekend-only categories');
  ok('la_musa: still a no-op (no weekend categories) — the gate stays x_pizza-scoped');
}

// ── (b) A STORE EDIT MUST FLIP ENFORCEMENT — the whole point ───────────────────────────────────
{
  // Move the gate to a category that today has NO weekend restriction: every 'individual' pizza
  // becomes weekend-only and the NY ones become always-available. A static set cannot do this.
  const edited = builtFor('x_pizza', (s) => { s.structure.weekend_only_cats = ['individual']; });
  const keys = weekendOnlyKeysFrom('x_pizza', edited);
  assert.ok(keys.has('Margherita'), 'a store edit makes an individual pizza weekend-only');
  assert.ok(!keys.has('Margherita NY'), 'and releases the NY ones');
  assert.strictEqual(weekendOnlyViolation([{ name: 'Margherita' }], 'x_pizza', MON, keys), 'Margherita', 'the edit is ENFORCED on a weekday');
  assert.strictEqual(weekendOnlyViolation([{ name: 'Margherita NY' }], 'x_pizza', MON, keys), null, 'and the old restriction is lifted');
  // the static code path would have done the exact opposite — that is the drift being eliminated
  assert.strictEqual(weekendOnlyViolation([{ name: 'Margherita' }], 'x_pizza', MON), null, 'the STATIC path ignores the edit (yesterday\'s menu)');
  assert.strictEqual(weekendOnlyViolation([{ name: 'Margherita NY' }], 'x_pizza', MON), 'Margherita NY', 'and keeps enforcing the old one');
  ok('store edit FLIPS enforcement both ways — and the static path demonstrably does not (the drift this kills)');
}
{
  // Removing the gate entirely must release everything.
  const none = weekendOnlyKeysFrom('x_pizza', builtFor('x_pizza', (s) => { s.structure.weekend_only_cats = []; }));
  assert.strictEqual(none.size, 0);
  assert.strictEqual(weekendOnlyViolation([{ name: 'Margherita NY' }], 'x_pizza', MON, none), null, 'clearing the gate releases everything');
  ok('clearing weekend_only_cats releases every item (the gate is data, not code)');
}

// ── FALLBACK: a reader failure must preserve TODAY's behaviour, never open the gate ────────────
(async () => {
  {
    let calls = 0;
    const reader = createGateReader({ getMenu: async () => { calls++; throw new Error('firestore down'); } });
    const keys = await reader.getWeekendOnlyKeys('x_pizza', 'v-1');
    assert.deepStrictEqual([...keys].sort(), [...X_PIZZA_WEEKEND_ONLY].sort(),
      'a read failure falls back to the STATIC set — identical to today, never an open gate');
    assert.strictEqual(weekendOnlyViolation([{ name: 'Margherita NY' }], 'x_pizza', MON, keys), 'Margherita NY', 'and enforcement still happens');
    ok('fail-safe: a catalog read failure falls back to the static set — today\'s exact behaviour, gate never opens');
  }
  {
    // Version-keyed cache: versions are immutable, so one read per version, not per order.
    let calls = 0;
    const built = builtFor('x_pizza');
    const reader = createGateReader({ getMenu: async () => { calls++; return built; } });
    for (let i = 0; i < 5; i++) await reader.getWeekendOnlyKeys('x_pizza', 'v-7');
    assert.strictEqual(calls, 1, 'five orders on the same version → ONE read (versions are immutable)');
    await reader.getWeekendOnlyKeys('x_pizza', 'v-8');
    assert.strictEqual(calls, 2, 'a new version re-reads');
    ok('version-keyed cache: one read per version, not per order (immutability makes this safe)');
  }
  {
    // A bounded read — a hung structure read must not hang a pre-charge gate.
    const reader = createGateReader({ getMenu: () => new Promise(() => {}), deadlineMs: 30 });
    const t0 = Date.now();
    const keys = await reader.getWeekendOnlyKeys('x_pizza', 'v-9');
    assert.ok(Date.now() - t0 < 2000, 'must time out, not hang the order');
    assert.deepStrictEqual([...keys].sort(), [...X_PIZZA_WEEKEND_ONLY].sort(), 'and fall back to the static set');
    ok('bounded: a hung read times out and falls back — a pre-charge gate can never hang an order');
  }
  console.log(`menu-gates: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
