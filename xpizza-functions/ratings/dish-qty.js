'use strict';
// S-B step 3 (ruling F1) — the order's DISH IDENTITY snapshot, stamped at intake on every order (guests included):
//   dish_qty = { <canonical dish id>: <qty> }   from the CHARGED body lines (body.items), through the ONE resolver (the D4-a context of
//   the SAME guarded pricing tables that priced the order → canonical-binding.identityMap; itemPricingKey picks each line's legacy key,
//   exactly as computeServerTotal does). An unusable context, or ANY line that does not map, ⇒ null (the field is omitted — never a
//   partial or guessed identity). Pure; reads nothing but its arguments.
const { itemPricingKey } = require('../menu-pricing');
const { identityMap } = require('../catalog/canonical-binding');

function dishQtyOf(bodyItems, restaurantId, context, keyMode) {
  const map = identityMap(context);
  if (!map || !Array.isArray(bodyItems) || !bodyItems.length) return null;
  const out = {};
  for (const it of bodyItems) {
    const key = itemPricingKey(it, restaurantId, keyMode);
    const cid = key ? map.dish.get(key) : undefined;
    const qty = Number(it && it.qty);
    if (!cid || !Number.isInteger(qty) || qty < 1 || qty > 50) return null;
    out[cid] = (out[cid] || 0) + qty;
  }
  return out;
}

module.exports = { dishQtyOf };
