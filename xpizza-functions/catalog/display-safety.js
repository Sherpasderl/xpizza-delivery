'use strict';
// Task 2 — RENDERING-SAFETY CONTENT CONSTRAINTS.
//
// 🔴 WHY THIS EXISTS AT 1A, WHEN THE RENDER FIX IS 1B. 1A makes merchant-authored data the source the
// customer forms are built from, and those forms are the ones shipping TODAY — they interpolate
// catalog values straight into innerHTML, into attributes, and into inline handlers. Until 1B replaces
// that with text nodes and event listeners, the only place an XSS payload can be stopped is BEFORE it
// is activated. So "is this safe to render" is part of what a publish means.
//
// THE TWO SINKS ARE DIFFERENT AND ONE CHECK DOES NOT COVER THE OTHER. A markup filter looks like it
// covers everything until you meet the attribute case:
//
//     body       la-musa-orders/index.html:2162   '<div class="pizza-card-name">' + p.name + '</div>'
//     attribute  xpizza-orders/index.html:1731    `<img ... alt="${p.name}" ...>`   ← NOT escaped
//
// `" onmouseover="alert(1)` contains no angle brackets at all. It passes any markup check and still
// closes the alt attribute and opens an executable handler.
//
// BRAND-AGNOSTIC BY UNION, NOT BY A PER-BRAND TABLE. The same catalog field reaches an attribute sink
// in one brand and a body sink in the other, and a table keyed by restaurant would put brand logic
// back into validation — the thing this slice is removing. So each field is constrained by the
// STRICTEST context it reaches in ANY shipped renderer. Verified against the live menus of both
// brands: zero real values are rejected.

// ── CONTEXTS ─────────────────────────────────────────────────────────────────────────────────────
// Each returns a reason string when the value is unsafe, or null when it is fine.

// Sequences that DECODE to an angle bracket. Belt-and-braces: innerHTML parses entities as text
// rather than markup, so these are not exploitable through today's sinks — but a value that is
// decoded once anywhere upstream becomes markup, and the cost of refusing them is nothing.
const DECODES_TO_ANGLE = /&(?:lt|gt|#0*(?:60|62)|#x0*3[ce]);?/i;

const CHECKS = {
  // Interpolated into HTML as element content. Angle brackets become tags.
  body(v) {
    if (/[<>]/.test(v)) return 'contains markup characters (< or >), which become tags in an innerHTML sink';
    if (DECODES_TO_ANGLE.test(v)) return 'contains an entity that decodes to an angle bracket';
    return null;
  },
  // Interpolated INSIDE an attribute value. A quote ends the attribute; everything after it is
  // parsed as more attributes, which is how a name becomes an event handler.
  attribute(v) {
    const body = CHECKS.body(v);
    if (body) return body;
    if (/["'`]/.test(v)) return 'contains a quote, which closes the attribute and lets the rest become handlers';
    return null;
  },
  // Interpolated into an inline handler — quoted in one brand, BARE in the other
  // (`onclick="openDetailModal(${p.id})"`), so anything that is not a plain identifier is code.
  identifier(v) {
    if (!/^[A-Za-z0-9_-]+$/.test(v)) return 'is not a plain identifier ([A-Za-z0-9_-]+), and reaches an inline event handler';
    return null;
  },
  // src=/background:url() — a relative path under the site, nothing that carries a scheme.
  url(v) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) return 'carries a URL scheme; only site-relative paths are allowed';
    if (/^\/\//.test(v)) return 'is protocol-relative; only site-relative paths are allowed';
    if (v.includes('..')) return 'traverses upward';
    if (!/^[A-Za-z0-9._/-]+$/.test(v)) return 'contains characters not allowed in a site-relative path';
    return null;
  },
  // Interpolated into a style attribute, where a stray `;` or `url(` starts something else.
  color(v) {
    if (!/^#[0-9A-Fa-f]{3,8}$/.test(v)) return 'is not a #rgb/#rrggbb/#rrggbbaa colour';
    return null;
  },
};

function checkValue(value, context) {
  const check = CHECKS[context];
  if (!check) return `unknown sink context ${context}`;
  if (value === undefined || value === null) return null;      // absence is the schema's business, not safety's
  const v = String(value);
  if (v === '' && context === 'identifier') return 'is empty, and reaches an inline event handler';
  return check(v);
}

// ── THE SINK MAP, read off the shipped renderers ─────────────────────────────────────────────────
// Each entry is the STRICTEST context that field reaches in any current form. The provenance table
// below names the file and line it was read from — a sink map nobody can trace to shipped code is a
// guess, and a guess here is an XSS.
const FIELD_SINKS = {
  item: { id: 'identifier', cat: 'identifier', name: 'attribute', desc: 'body', subcat: 'body', emoji: 'body', img: 'url', color: 'color' },
  extra: { id: 'identifier', cat: 'body', name: 'body' },
  category: { id: 'identifier', name: 'body' },
};
const SINK_PROVENANCE = {
  'item.id': 'la-musa-orders/index.html:2158 onclick="chg(\'<id>\',1)"; xpizza-orders/index.html:1728 onclick="openDetailModal(<id>)" (BARE)',
  'item.cat': 'la-musa-orders/index.html:2118 data-cat="<cat>" + onclick="switchCat(\'<cat>\',this)"',
  'item.name': 'xpizza-orders/index.html:1731 alt="${p.name}" UNESCAPED (attribute); la-musa-orders/index.html:2162 innerHTML (body)',
  'item.desc': 'la-musa-orders/index.html:2163 innerHTML (body)',
  'item.subcat': 'la-musa-orders/index.html:2211 <h3 class="menu-subsection-title">\' + sub + \'</h3> (body)',
  'item.emoji': 'xpizza-orders/index.html:1732 <div class="pizza-photo-label">${p.emoji}</div> (body)',
  'item.img': 'xpizza-orders/index.html:1731 src="${p.img}" (attribute, URL)',
  'item.color': 'xpizza-orders/index.html:1729 style="background:${p.color}" (attribute, CSS)',
  'extra.id': 'xpizza-orders/index.html:3658 onclick="toggleDetailExtra(\'<id>\',...)"',
  'extra.cat': 'xpizza-orders/index.html:3654 <div class="detail-cat-label"> (body)',
  'extra.name': 'xpizza-orders/index.html:3661 <span class="detail-extras-name"> (body)',
  'category.id': 'la-musa-orders/index.html:2119 onclick="switchCat(\'<id>\',this)" + id="cat-<id>"',
  'category.name': 'la-musa-orders/index.html:2121 innerHTML (body)',
};

// Throw if any field of a display record would be unsafe in the sink it actually reaches.
function assertDisplaySafe(record, kind, label) {
  const fields = FIELD_SINKS[kind];
  if (!fields) throw new Error(`display_unsafe: ${label} — unknown record kind ${kind}`);
  if (!record || typeof record !== 'object') throw new Error(`display_unsafe: ${label} — not a record`);
  for (const [field, context] of Object.entries(fields)) {
    const reason = checkValue(record[field], context);
    if (reason) throw new Error(`display_unsafe: ${label} — ${field} ${reason} [${context} sink: ${SINK_PROVENANCE[`${kind}.${field}`]}]`);
  }
  // Subcategory lists are rendered the same way a subcat is.
  if (Array.isArray(record.subcats)) {
    for (const s of record.subcats) {
      const reason = checkValue(s, 'body');
      if (reason) throw new Error(`display_unsafe: ${label} — subcats entry ${reason} [body sink]`);
    }
  }
}

module.exports = { checkValue, assertDisplaySafe, FIELD_SINKS, SINK_PROVENANCE };
