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
    // EXACTLY 3, 4, 6 or 8 hex digits. `{3,8}` accepted #12345, which is not a colour any renderer
    // understands — it is simply painted as nothing, silently.
    if (!/^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(v)) return 'is not a #rgb/#rgba/#rrggbb/#rrggbbaa colour';
    return null;
  },
};

// 🔴 TYPE AS THE SAFETY MECHANISM. Some values reach an unescaped body sink and are only ever
// meaningful as a number — `'desde L ' + VARIANT_ITEMS[p.id].basePrice`. Constraining the CHARACTERS
// would be the wrong tool: the right statement is that this is a number, and a number cannot carry
// markup at all. Checked before the string contexts, because these are not strings.
const TYPED = {
  numeric(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a finite number (it reaches an unescaped sink, and a number cannot carry markup)';
    return null;
  },
  boolean(value) {
    if (typeof value !== 'boolean') return 'must be a boolean';
    return null;
  },
  // A list of lookup keys — each selects a badge definition. An entry that is not an identifier
  // matches no definition and renders nothing, silently.
  identifier_list(value) {
    if (!Array.isArray(value)) return 'must be an array';
    for (const entry of value) {
      if (typeof entry !== 'string') return 'contains a non-string entry';
      const reason = CHECKS.identifier(entry);
      if (reason) return `contains an entry that ${reason}`;
    }
    return null;
  },
};

function checkValue(value, context) {
  if (value === undefined || value === null) return null;      // absence is the schema's business, not safety's
  const typed = TYPED[context];
  if (typed) return typed(value);                              // typed contexts inspect the VALUE, not its text
  const check = CHECKS[context];
  if (!check) return `unknown sink context ${context}`;
  // 🔴 NO STRINGIFICATION. This used to be String(value), which meant `{}` became "[object Object]" —
  // a perfectly safe-looking string that passed every content rule and then rendered as
  // "[object Object]" on a menu. Safety answers ONE question: does this string carry an injection.
  // Whether it should have been a string at all is the type rule's job, and conflating the two let a
  // whole class of wrong-typed values through the only check that looked at them.
  // A FINITE NUMBER IS SAFE ANYWHERE. x_pizza interpolates a numeric dish id bare into
  // `openDetailModal(${p.id})`, and a number cannot carry markup or close a quote — so safety has
  // nothing to say about it. WHICH type a field must be is the validator's business, not this
  // module's; conflating the two is what this split exists to stop.
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'must be a finite number';
  if (typeof value !== 'string') return 'must be a string (it reaches a text sink; stringifying it would hide the wrong type behind a safe-looking value)';
  const v = value;
  if (v === '' && context === 'identifier') return 'is empty, and reaches an inline event handler';
  return check(v);
}

// ── THE SINK MAP, read off the shipped renderers ─────────────────────────────────────────────────
// Each entry is the STRICTEST context that field reaches in any current form. The provenance table
// below names the file and line it was read from — a sink map nobody can trace to shipped code is a
// guess, and a guess here is an XSS.
const FIELD_SINKS = {
  item: {
    id: 'identifier', cat: 'identifier', name: 'attribute', desc: 'body', subcat: 'body',
    emoji: 'body', img: 'url', color: 'color',
    choice: 'body',            // the variant's own label, shown in the required-choice list
    tags: 'identifier_list',   // badge lookup keys
  },
  extra: { id: 'identifier', cat: 'body', name: 'body' },
  category: { id: 'identifier', name: 'body', layout: 'identifier' },
  // 🔴 VARIANT SPECS WERE NOT ENUMERATED AT ALL, and basePrice reaches TWO unescaped body sinks.
  // A sink map can be traced, field by field, and still be INCOMPLETE — provenance proves each entry
  // is real, never that the set is whole. That is what the field census in the tests exists for.
  variant: { label: 'body', basePrice: 'numeric' },
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
  'category.layout': 'la-musa-orders/index.html:2204 c.layout === \'list\' — selects the list vs grid template',
  'item.choice': 'la-musa-orders/index.html:4148 <span class="detail-extras-name">${escapeHtml(v.choice)}</span> (escaped today; constrained anyway)',
  'item.tags': 'la-musa-orders/index.html:1800 tags.includes(t) → TAG_BADGES lookup; an unknown tag silently renders no badge',
  'variant.label': 'la-musa-orders/index.html:4140 ${escapeHtml(cfg.label)} (escaped today; constrained anyway)',
  'variant.basePrice': '🔴 la-musa-orders/index.html:2165 \'desde L \' + VARIANT_ITEMS[p.id].basePrice AND :4136 `desde L ${cfg.basePrice}` — BOTH UNESCAPED',
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
