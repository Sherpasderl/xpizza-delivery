'use strict';
// R3-FIX D12 — the pickup line a customer reads on the tracker ("Recoger en …"): ONE source for every order builder
// (create-order-build.js for the immediate path, materialize.js for every pending → live path). It names the brand
// from the restaurant's OWN config — restaurants/{rid}/identity — never a literal:
//   display_name  the brand as customers see it (optional; e.g. "X. Pizza", whose config `name` is "X Pizza")
//   name          the restaurant's configured name (always present on a routable identity)
// and says "Recoger en el restaurante" when neither is usable. A value that is not a short, non-blank string is treated
// as absent, so a malformed config can never print garbage or an empty "Recoger en ".
const BRAND_MAX = 60;
const READ_TIMEOUT_MS = 1500;

// codex D12b r1 P2-1: control characters and private-use code points are never a brand (refused by the owner CLI, absent here)
const UNSHOWABLE = /[\u0000-\u001F\u007F-\u009F\uE000-\uF8FF]|[\uDB80-\uDBFF][\uDC00-\uDFFF]/;
function brandText(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && t.length <= BRAND_MAX && !UNSHOWABLE.test(t) ? t : null;
}

// candidates, most preferred first: the first usable one IS the brand (or null when none is usable). D12b: the same
// resolution feeds the pickup line, the public order_tracking.restaurant_display_name and the WhatsApp copy.
function brandOf(...candidates) {
  for (const c of candidates) { const b = brandText(c); if (b) return b; }
  return null;
}
function pickupLabel(...candidates) {
  const b = brandOf(...candidates);
  return b ? `Recoger en ${b}` : 'Recoger en el restaurante';
}

// The live identity's two names, for an order that carries no display-name snapshot (created before D12, or before the
// 3b hub snapshot). Fail-SOFT: a slow or failed read returns null and the label falls back — a pickup line must never
// block or fail a materialize (the money is already captured on that path).
async function readLiveBrand(db, rid) {
  if (!db || typeof rid !== 'string' || !rid) return null;
  const base = `restaurants/${rid}/identity`;
  const read = Promise.all([db.ref(`${base}/display_name`).once('value'), db.ref(`${base}/name`).once('value')])
    .then(([d, n]) => ({ display_name: d.val(), name: n.val() }));
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS); });
  try { return await Promise.race([read, timeout]); } catch (_) { return null; } finally { clearTimeout(timer); }
}

module.exports = { pickupLabel, brandOf, brandText, readLiveBrand, BRAND_MAX };
