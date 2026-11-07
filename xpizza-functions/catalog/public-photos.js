'use strict';
// ---------------------------------------------------------------------------
// PLAN-public-menu-display r2 T2 — `photos`: the absolute dish photo URLs the new customer app reads.
//
// 🔴 A SEPARATE TOP-LEVEL FIELD, NEVER ON THE DISH RECORDS. The cart holds whole served records and serializes them into
// the order payload, the redemption canonical and the quote fingerprint (xpizza-orders/form-identity-strip.js). The forms'
// strip list is a fixed literal and the forms stay byte-identical, so a photo field on a dish would move live fingerprints.
// A map keyed by String(dish.id) — the served id the client already holds — touches no record at all.
//
// ONE RULE, KEYED ON CATALOG DATA, NOT ON THE RID:
//   a plain relative display.img     → card = hero = base + img          (x_pizza's records carry one today)
//   else has_photo === true          → base + images/<key>-card.webp / -hero.webp   (la_musa's files today)
//   else                             → absent
// The base is the brand's ORDER SITE — the one `orders` deployment of the platform manifest whose context is the rid, its one
// exact https origin — where these files are committed and served. No brand literal.
//
// 🔴 A DECORATION THAT NEVER FAILS A SERVE. photosFor never throws: no base, an ambiguous or malformed manifest, a malformed
// catalog or any throw → null, and the caller omits the field. A menu without photos is the menu served today; a menu that
// cannot be served is an outage.
// ---------------------------------------------------------------------------
const { isExactHttpsOrigin } = require('../platform-manifest');

// One path segment of a committed file: no scheme, no slash, no leading dot (so never `.` or `..`), no query, no space.
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const plainRelative = (p) => typeof p === 'string' && p !== '' && p.split('/').every((seg) => SEGMENT_RE.test(seg));

// The brand's order-site origin + '/', or null unless it is exactly one deployment with exactly one exact https origin.
function assetBaseFor(rid, sites) {
  const deps = sites && Array.isArray(sites.deployments) ? sites.deployments : [];
  const orders = deps.filter((d) => d && typeof d === 'object' && d.app === 'orders' && d.context === rid);
  if (orders.length !== 1) return null;
  const origins = orders[0].origins;
  if (!Array.isArray(origins) || origins.length !== 1 || !isExactHttpsOrigin(origins[0])) return null;
  return `${origins[0]}/`;
}

// { [String(dish.id)]: { card, hero } } for every item with a photo, in item order. Throws on a malformed catalog.
function buildPhotos(menu, base) {
  if (!menu || !Array.isArray(menu.items)) throw new Error('public_photos: the catalog has no item list');
  const out = {};
  for (const it of menu.items) {
    const d = it && it.display;
    if (!d || d.id === undefined || d.id === null) continue;
    const id = String(d.id);
    if (d.img !== undefined) {
      // an img that is not a plain relative path is SKIPPED, and never falls back to has_photo — what the record says is
      // its photo is not a photo we can serve, and guessing another file is not what it said
      if (plainRelative(d.img)) out[id] = { card: base + d.img, hero: base + d.img };
      continue;
    }
    if (it.has_photo === true && typeof it.key === 'string' && SEGMENT_RE.test(it.key)) {
      out[id] = { card: `${base}images/${it.key}-card.webp`, hero: `${base}images/${it.key}-hero.webp` };
    }
  }
  return out;
}

function photosFor(rid, menu, sites) {
  try {
    const base = assetBaseFor(rid, sites);
    return base ? buildPhotos(menu, base) : null;
  } catch (_) {
    return null;
  }
}

module.exports = { assetBaseFor, buildPhotos, photosFor };
