'use strict';
const { isValidPrice } = require('../price-valid');   // 1d-1a EXTENSION: the ONE price-validity rule

/**
 * Per-line gross cents for the factura, mirroring index.js computeServerTotal's validation
 * exactly (so the line-gross sum equals the server total). Price tables are injected (they
 * live in index.js) to keep this pure + unit-testable. Whole-lempira prices -> *100 cents.
 *
 * Extras are FOLDED into their parent menu line's gross (matching computeServerTotal, which
 * adds each extra once to the item) and appended to the description; they are not separate
 * lines. Returns { items: [{qty, description, line_gross_cents}], error } — items null on error.
 */
function pricedLineItems(items, menuPrices, extraPrices) {
  if (!Array.isArray(items) || items.length === 0) {
    return { items: null, error: 'items must be a non-empty array' };
  }
  const out = [];
  for (const it of items) {
    const name = it && it.name;
    const qty = Number(it && it.qty);
    if (!name || !Object.prototype.hasOwnProperty.call(menuPrices, name)) {
      return { items: null, error: `unknown menu item: ${String(name).slice(0, 40)}` };
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
      return { items: null, error: `invalid quantity for ${name}` };
    }
    // Phase 1d Stage 1a — FAIL-CLOSED PRICE VALUE, in LOCKSTEP with computeServerTotal.
    // 🔒 Both calculators now gate on the SAME shared predicate (price-valid.js), so the rule cannot
    // drift between them — it is one function, not two copies. That matters because the factura's
    // line-gross sum has to equal the charged total: a value that rejects in one must reject in the
    // other, or an order prices but cannot produce a factura, or a factura misvalues a Void-only SAR
    // document. Change the rule in price-valid.js and both move together, by construction.
    const price = menuPrices[name];
    if (!isValidPrice(price)) {
      return { items: null, error: `invalid price for ${name}` };
    }
    let lineGrossCents = price * qty * 100;
    const extras = Array.isArray(it.extras) ? it.extras : [];
    const extraNames = [];
    for (const ex of extras) {
      const ename = ex && ex.name;
      if (!ename || !Object.prototype.hasOwnProperty.call(extraPrices, ename)) {
        return { items: null, error: `unknown extra: ${String(ename).slice(0, 40)}` };
      }
      const eprice = extraPrices[ename];                                   // 1d-1a: same rule, same lockstep
      if (!isValidPrice(eprice)) {
        return { items: null, error: `invalid price for extra ${ename}` };
      }
      lineGrossCents += eprice * 100;
      extraNames.push(ename);
    }
    const description = extraNames.length ? `${name} (+${extraNames.join(', ')})` : name;
    out.push({ qty, description, line_gross_cents: lineGrossCents });
  }
  return { items: out, error: null };
}

module.exports = { pricedLineItems };
