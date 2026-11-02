'use strict';
// S-D (PLAN §S-D, advisor rulings 2026-11-02) — the INVERSE of the reorder price snapshot slice. NEWEST layer: composed INNERMOST in
// every chain that reads these files (index.js: inside unapplyLifecycleIndex; the pinned modules: innermost in each module chain).
//   index.js — removes EXACTLY the named `/* sd:begin NAME */ … /* sd:end NAME */` whole-line hunk (each marker exactly once, each on
//              its OWN line); the hunk is INSERTED whole lines — no base line is edited.
//   modules  — create-order-build.js / materialize.js / claim-order.js / reorder-normalize.js: each hunk is whole lines INSERTED after one unchanged anchor
//              line; `now` (anchor + inserted lines) must occur EXACTLY once and becomes `was` (the anchor alone).
// GENERATED from the git diff (pure insertions; the generator refuses anything else). Do not hand-edit.
const NAMES = ['reorder-price-snapshot'];
const HUNKS = NAMES.map((n) => ({ name: n, begin: `/* sd:begin ${n} */`, end: `/* sd:end ${n} */` }));
const count = (s, t) => s.split(t).length - 1;
function unapplySdIndex(src) {
  let out = src;
  for (const h of HUNKS) {
    if (count(out, h.begin) !== 1 || count(out, h.end) !== 1) throw new Error(`sd-inverse: the ${h.name} hunk is missing or its marker appears more than once`);
    const a = out.lastIndexOf('\n', out.indexOf(h.begin)) + 1;
    const eAt = out.indexOf(h.end);
    if (eAt < a) throw new Error(`sd-inverse: the ${h.name} hunk is malformed`);
    if (out.slice(a, out.indexOf(h.begin)).trim() !== '' || out[eAt + h.end.length] !== '\n') throw new Error(`sd-inverse: the ${h.name} markers must sit on their own lines`);
    out = out.slice(0, a) + out.slice(eAt + h.end.length + 1);
  }
  if (/sd:(begin|end) /.test(out)) throw new Error('sd-inverse: an unknown sd hunk remains');
  return out;
}
const MODULE_HUNKS = [
  {
    "file": "create-order-build.js",
    "now": "  };\n  // S-D: the reorder price snapshot — aligned 1:1 with `items` (the same normalizer, line by line), priced by the existing\n  // computeServerTotal from the SAME committed tables that charged this order; absent ⇒ the client's generic disclosure.\n  const priceSnapshot = require('./reorder-normalize').reorderPriceSnapshot(meta.items, meta.restaurantId, meta.tables);\n  if (priceSnapshot) updates[`user_orders/${customer_uid}/${orderId}`].price_snapshot = priceSnapshot;\n",
    "was": "  };\n"
  },
  {
    "file": "materialize.js",
    "now": "      ...(order.recipe_format !== undefined ? { recipe_format: order.recipe_format } : {}),\n      // S-D: the reorder price snapshot (captured at the online charge from the committed prices) travels with its recipe, ONLY IF\n      // PRESENT and VERBATIM — never re-priced here; a legacy pending order without one keeps today's entry byte-identical.\n      ...(order.reorder_price_snapshot !== undefined ? { price_snapshot: order.reorder_price_snapshot } : {}),\n",
    "was": "      ...(order.recipe_format !== undefined ? { recipe_format: order.recipe_format } : {}),\n"
  },
  {
    "file": "claim-order.js",
    "now": "      ...(committed.recipe_format !== undefined ? { recipe_format: committed.recipe_format } : {}),\n      // S-D: the reorder price snapshot, ONLY IF PRESENT and VERBATIM (never re-priced from a later menu).\n      ...(committed.reorder_price_snapshot !== undefined ? { price_snapshot: committed.reorder_price_snapshot } : {}),\n",
    "was": "      ...(committed.recipe_format !== undefined ? { recipe_format: committed.recipe_format } : {}),\n"
  },
  {
    "file": "reorder-normalize.js",
    "now": "module.exports = { normalizeReorderItems, normalizeReorderItemsCanonical };\n\n/* S-D (PLAN §S-D) — the reorder PRICE SNAPSHOT: an additive sibling of the recipe (recipe_format is NOT bumped), captured from the\n   COMMITTED prices when the recipe is first written and copied verbatim afterwards (materialize / claim never re-price).\n     { v:1, lines:[{ unit_cents, line_cents }] }  — aligned 1:1 with the recipe lines normalizeReorderItems keeps\n   unit_cents = the dish's menu price; line_cents = the line EXACTLY as charged. ONE pricer, untouched: line_cents is the existing\n   computeServerTotal on a ONE-LINE cart — its loop carries no state across lines (per-line validation, per-line extras dedup, a plain\n   running sum), so Σ line_cents === the cart's charged subtotal (proven over a generated corpus for both brands). x_pizza extras\n   count once per entry, la_musa extras by their own qty — whatever computeServerTotal charges. The pairing is single-pass: each body\n   line is normalized on its own (normalizeReorderItems carries no cross-line state either, only the MAX_LINES cap, applied here) and\n   priced on its own, so a dropped line drops from BOTH. Any line the pricer refuses ⇒ NO snapshot at all (never a partial one — the\n   client's generic disclosure covers it; a charged cart always prices). Client price fields on the body are never read. */\nfunction normalizeReorderItemsWithPrices(bodyItems, restaurantId, tables = null) {\n  const { menu } = resolvePriceTables(restaurantId, tables);   // PIN B asserts the tag\n  if (!menu || !Array.isArray(bodyItems)) return { items: [], snapshot: null };\n  const items = [];\n  const lines = [];\n  let priced = true;\n  let truncated = false;\n  for (const it of bodyItems) {\n    const one = normalizeReorderItems([it], restaurantId, tables);\n    if (one.length !== 1) continue;\n    if (items.length >= MAX_LINES) { truncated = true; break; }   // the recipe is capped; the CHARGE is not (Codex S-D r1)\n    items.push(one[0]);\n    const unit = menu[one[0].key];\n    const r = require('./menu-pricing').computeServerTotal([it], restaurantId, tables);\n    if (r.error || !Number.isInteger(r.total) || !Number.isInteger(unit)) { priced = false; continue; }\n    lines.push({ unit_cents: unit * 100, line_cents: r.total * 100 });\n  }\n  // a TRUNCATED recipe ⇒ NO snapshot (Σ line_cents would no longer equal the charge; the client's generic disclosure covers it)\n  return { items, snapshot: priced && !truncated && items.length > 0 ? { v: 1, lines } : null };\n}\n// the snapshot alone (the online pending writer's insert-only hunk: reorder_items itself is written by the unchanged base line)\nfunction reorderPriceSnapshot(bodyItems, restaurantId, tables = null) {\n  return normalizeReorderItemsWithPrices(bodyItems, restaurantId, tables).snapshot;\n}\nmodule.exports.normalizeReorderItemsWithPrices = normalizeReorderItemsWithPrices;\nmodule.exports.reorderPriceSnapshot = reorderPriceSnapshot;\n",
    "was": "module.exports = { normalizeReorderItems, normalizeReorderItemsCanonical };\n"
  }
];
const FILES = [...new Set(MODULE_HUNKS.map((h) => h.file))];
function unapplySdModule(file, src) {
  let out = src;
  for (const h of MODULE_HUNKS.filter((x) => x.file === file)) {
    const c = count(out, h.now);
    if (c !== 1) throw new Error(`sd-inverse: a ${file} hunk occurs ${c} times (must be exactly once)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
// the chain form: a file this slice does not touch passes through unchanged (module chains read several files through one reader)
const unapplySdModuleIfAny = (file, src) => (FILES.includes(file) ? unapplySdModule(file, src) : src);
module.exports = { HUNKS, MODULE_HUNKS, FILES, unapplySdIndex, unapplySdModule, unapplySdModuleIfAny };
