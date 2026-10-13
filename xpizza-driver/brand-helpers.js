// brand-helpers.js — brand-agnostic driver-facing brand label + customer greeting, sourced from the order.
// Pure, no DOM: the driver app (index.html) and its tests import the SAME functions, so a test exercises
// the real code (not a reimplementation). The brand NEVER comes from a hard-coded literal or a
// `restaurant_id === '<brand>'` ternary — it comes from the order's server-written display name.

// The brand name to show, from the order's server-stamped snapshot (create-order-build copies
// restaurant_display_name onto the order). May be '' (legacy / pre-seed / unconfigured brand).
export function brandLabel(order) {
  return String((order && order.restaurant_display_name) || '').trim();
}

// Cosmetic restaurant_id -> chip color class. COLOR ONLY; it never chooses the text. A brand we have
// no color for (a 3rd brand, or an unknown id) falls back to 'neutral'.
const BRAND_CLASS = { x_pizza: 'xp', la_musa: 'lm' };

// { label, cls } for the restaurant chip. When there is no display name the class is forced 'neutral'
// regardless of restaurant_id, so a nameless legacy x_pizza/la_musa order never shows a brand color.
export function brandMeta(order) {
  const label = brandLabel(order);
  const cls = label ? (BRAND_CLASS[order && order.restaurant_id] || 'neutral') : 'neutral';
  return { label, cls };
}

// The customer WhatsApp greeting. Brand from the order; neutral when absent — never a hard-coded brand.
// Callers URL-encode this (encodeURIComponent); it is NOT pre-HTML-escaped.
export function driverGreeting(order) {
  const label = brandLabel(order);
  return label ? `Hola, soy su repartidor de ${label}.` : 'Hola, soy su repartidor.';
}
