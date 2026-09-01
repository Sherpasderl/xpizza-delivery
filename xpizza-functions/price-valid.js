'use strict';
// The ONE price-validity rule for the whole platform: a usable price is a POSITIVE INTEGER lempira
// amount. Zero, negative, NaN, non-integer, or undefined is corrupt/tampered. Every money/fiscal/display
// seam that multiplies a raw table price MUST gate on this — a single source of truth so the rule can
// never drift between the order total, the factura, the reward valuation, and the tracker summary.
//
// Deliberately a dependency-free LEAF module: factura/pricing.js stays standalone (no menu-pricing
// dependency) and there is no circular-require risk from the rewards graph.
function isValidPrice(p) { return Number.isInteger(p) && p > 0; }
module.exports = { isValidPrice };
