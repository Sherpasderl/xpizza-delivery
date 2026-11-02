// S-D (PLAN §S-D) — BOTH forms' reorder readers still render a history entry carrying the additive `price_snapshot` sibling:
// recipe_format is NOT bumped, so every legacy scenario's outcome is EXACTLY the frozen 717f97e result with a snapshot attached
// (aligned or not — the readers ignore it). The canonical-format path is untouched by S-D (its parity lives in d4b-reorder.test).
// Run: node reorder-price-snapshot-reader.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { runReorder, legacyScenarios } from './d4b-reorder-reader.mjs';

const GOLDEN = JSON.parse(readFileSync(new URL('./xpizza-functions/catalog/d4b-reorder.golden.json', import.meta.url), 'utf8'));
const ACCOUNT = { 'xpizza-orders': readFileSync(new URL('./xpizza-orders/account.js', import.meta.url), 'utf8'), 'la-musa-orders': readFileSync(new URL('./la-musa-orders/account.js', import.meta.url), 'utf8') };
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

let compared = 0;
for (const dir of Object.keys(ACCOUNT)) {
  for (const [name, sc] of legacyScenarios()) {
    const items = Array.isArray(sc.entry && sc.entry.items) ? sc.entry.items : [];
    const snapshot = { v: 1, lines: items.map((_, i) => ({ unit_cents: 10000 + i, line_cents: 20000 + i })) };
    const withSnap = { ...sc, entry: { ...sc.entry, price_snapshot: snapshot } };
    assert.ok(!('recipe_format' in withSnap.entry) || withSnap.entry.recipe_format === sc.entry.recipe_format, 'premise: the format is untouched');
    assert.deepStrictEqual(runReorder(ACCOUNT[dir], withSnap), GOLDEN.results[`${dir}/${name}`], `🔴 ${dir} ${name}: a price_snapshot sibling changed the reorder`);
    compared += 1;
  }
}
assert.ok(compared >= 20, `premise: the legacy scenarios ran (${compared})`);
ok(`both forms' reorder readers: ${compared} legacy scenarios with a price_snapshot sibling equal the frozen results — the readers still render`);
console.log(`reorder-price-snapshot-reader: OK (${n})`);
