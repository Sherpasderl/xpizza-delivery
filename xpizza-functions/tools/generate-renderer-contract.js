'use strict';
// ---------------------------------------------------------------------------
// 🔴 THE RENDERER CONTRACT, BAKED. Some validation facts belong to the SHIPPED FORM, not to the
// document being validated: whether a brand's renderer prints category labels, and which badges it
// can actually select. Deriving them by reading the form at request time looked fine locally and was
// a hole in production — the forms live outside xpizza-functions/ and are NOT in the functions deploy
// bundle, so every read threw, every throw was caught, and the contract silently constrained nothing
// exactly where it mattered most.
//
// So it is generated here and COMMITTED inside the functions package, the same shape as the form
// bundle: a parity test regenerates from the real forms and compares, so the artifact cannot drift
// from the renderers it describes.
// ---------------------------------------------------------------------------
const { writeFileSync } = require('fs');
const { join } = require('path');
const { formSource, formSiblingSource, readLiteral } = require('../catalog/form-menu-source');

const BRANDS = ['x_pizza', 'la_musa'];

// What one brand's shipped form implies about the documents it can render.
function deriveContract(restaurantId, root) {
  const src = formSource(restaurantId, root);
  // Does the renderer PRINT a category label? A form with no CATEGORIES literal renders id-only
  // categories, and requiring a name there would reject a menu that is correct as it stands.
  let categoriesNamed = false;
  try {
    const cats = readLiteral(src, 'CATEGORIES');
    categoriesNamed = Array.isArray(cats) && cats.length > 0 && cats.every((c) => typeof c.name === 'string' && c.name);
  } catch (_) { categoriesNamed = false; }
  // Which badges can it SELECT? badgeHtmlFor walks TAG_PRIORITY and looks each entry up, so a
  // definition the priority list omits is never chosen — the selectable set is the intersection.
  let badges = [];
  try {
    const defs = readLiteral(src, 'TAG_BADGES', '{', '}') || {};
    const priority = readLiteral(src, 'TAG_PRIORITY') || [];
    const defined = new Set(Object.keys(defs));
    // Intersected. Today TAG_PRIORITY lists exactly the defined badges, so dropping the filter
    // produces an identical artifact and mutation reports it as a survivor — it is the accurate
    // statement of what the renderer can choose, and it starts mattering the day someone adds a
    // definition without a priority entry.
    badges = priority.filter((t) => defined.has(t));
  } catch (_) { badges = []; }        // no badge system in this renderer: it can select NOTHING
  // 1D add-product B (rev 6; advisor ruling 2026-10-10, plan §0/§0b.6/§2 "badges gains recommended" read as choiceBadges):
  // the badges the shared group PICKER can draw on a CHOICE row — derived from the same strict marker as render, never a
  // per-restaurant flag. A card cannot show them, so they live apart from `badges`.
  const choiceBadges = formShipsPicker(restaurantId, root) ? CHOICE_BADGES.slice() : [];
  return { categoriesNamed, badges, renderedCategories: renderedCategoriesOf(src), choiceBadges };
}

// 1D add-product A §1 — WHICH CATEGORIES DOES THE RENDERER ACTUALLY DRAW? A category the catalog accepts but
// the form never draws is a product that is priced, orderable and INVISIBLE, and nothing downstream would
// refuse it. So the contract carries the set, read from the shipped renderMenu itself:
//   • a renderer that walks CATEGORIES and filters `p.cat === c.id` draws every category in that literal;
//   • a renderer that filters literal ids (`p.cat==='ny'`) draws exactly those.
// Anything else — no renderMenu, an unparseable body, a CATEGORIES walk with no literal — is [] (FAIL CLOSED):
// no category is known to render, so no product can be added to one. Order is the renderer's own.
function renderedCategoriesOf(src) {
  const start = src.search(/function\s+renderMenu\s*\(/);
  if (start === -1) return [];
  const open = src.indexOf('{', start);
  if (open === -1) return [];
  let depth = 0; let end = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return [];
  const body = src.slice(open, end + 1);
  const out = [];
  const add = (id) => { if (typeof id === 'string' && id && !out.includes(id)) out.push(id); };
  if (/CATEGORIES\.forEach\(\s*\(?\s*(\w+)\s*\)?\s*=>/.test(body)) {
    const v = body.match(/CATEGORIES\.forEach\(\s*\(?\s*(\w+)\s*\)?\s*=>/)[1];
    if (new RegExp(`p\\.cat\\s*===\\s*${v}\\.id\\b`).test(body)) {
      try {
        const cats = readLiteral(src, 'CATEGORIES');
        if (Array.isArray(cats)) for (const c of cats) add(c && c.id);
      } catch (_) { /* no literal: nothing is known to render through the walk */ }
    }
  }
  for (const m of body.matchAll(/p\.cat\s*===\s*(['"])([^'"\\]+)\1/g)) add(m[2]);
  return out;
}

const deriveContracts = (brands = BRANDS) => {
  const out = {};
  for (const rid of brands) out[rid] = deriveContract(rid);
  return out;
};

const RENDER = (contracts) => `'use strict';
// GENERATED by tools/generate-renderer-contract.js — do not edit by hand.
//
// What each shipped customer form implies about the catalog documents it can render. Committed inside
// the functions package because the forms themselves are not deployed with it: read at request time,
// this would be missing in production and the validator would fall back to constraining nothing.
//
//   categoriesNamed — the renderer prints a category label, so every category must carry a name
//   badges          — the badges it can SELECT (TAG_PRIORITY intersected with TAG_BADGES). An empty
//                     list means the brand has no badge renderer, so no tag on it can be honoured.
//   renderedCategories — the category ids its renderMenu actually DRAWS. A product may be ADDED only to one
//                     of these (an unrendered category would hold a priced, invisible product). [] = none.
//   choiceBadges    — the badges the shared group picker draws on a CHOICE row (a variant), present only when the form
//                     ships the picker. A variant's tags may come from badges ∪ choiceBadges; any other item's from badges.
module.exports = ${JSON.stringify(contracts, null, 2)};
`;

function writeContract(target) {
  const file = target || join(__dirname, '..', 'catalog', 'renderer-contract.generated.js');
  writeFileSync(file, RENDER(deriveContracts()), 'utf8');
  return file;
}

// ── 1D add-product B (rev 6) — the FALLBACK group index, baked from the CODE catalogs ─────────────────────────────
// When the gate's catalog read fails, intake falls back to the code-known dishes. Those include code-defined
// LAUNCHERS (la_musa's Pad Thai), and a fallback that only knew the dish keys would read "no launchers" — letting a bare
// launcher through exactly when the catalog cannot be read (plan §0b.4). The code catalogs are built from the form
// sources, which are NOT in the functions deploy bundle, so the index is generated here and committed, like the
// contract, with a byte-parity test against a fresh derivation.
function deriveFallbackGroups() {
  const { buildCatalogV2 } = require('../catalog/form-menu-source');
  const { groupIndexFrom } = require('../catalog/group-index');
  const out = {};
  for (const rid of BRANDS) {
    const g = groupIndexFrom(buildCatalogV2(rid));
    if (!g.ok) throw new Error(`fallback_groups_unreadable: ${rid} — the code catalog's variant map does not resolve`);
    out[rid] = { launchers: [...g.launchers].sort(), parentOf: Object.fromEntries([...g.parentOf].sort((a, b) => (a[0] < b[0] ? -1 : 1))) };
  }
  return out;
}
const RENDER_FALLBACK_GROUPS = (groups) => `'use strict';
// GENERATED by tools/generate-renderer-contract.js — do not edit by hand.
//
// The required-choice groups each brand's CODE catalog defines, by PRICING KEY: the launchers (never orderable or
// redeemable on their own) and each variant's launcher. Read ONLY when the gate's catalog read fails, so the code
// fallback can still recognise a bare launcher. Live catalogs carry their own variant map (catalog/group-index.js).
module.exports = ${JSON.stringify(groups, null, 2)};
`;
function writeFallbackGroups(target) {
  const file = target || join(__dirname, '..', 'catalog', 'fallback-groups.generated.js');
  writeFileSync(file, RENDER_FALLBACK_GROUPS(deriveFallbackGroups()), 'utf8');
  return file;
}

// ── 1D add-product B (rev 6, §0c.7) — the platform RENDER capability, derived from the SHIPPED forms ────────────────
// ONE platform value: true only when EVERY brand's form SHIPS the shared group picker — STRICTLY: its index.html loads it by
// the exact tag (once), AND the module shipped beside it declares GROUP_PICKER_V1. A marker in a comment, a module nobody
// loads, or a tag naming a file that is not there each leaves render OFF.
// Until then the platform group RULES (bare launcher non-orderable / non-redeemable, parent-or-variant availability)
// stay off, because a form that cannot render a group must never meet a server that refuses its launcher.
const GROUP_PICKER_MARKER = /\bconst GROUP_PICKER_V1 = 1;/;
const GROUP_PICKER_FILE = 'form-group-picker.js';
const GROUP_PICKER_TAG = `<script src="${GROUP_PICKER_FILE}"></script>`;
// The picker's own choice badge (form-group-picker.js isRecommended / RECOMMENDED_LABEL "Recomendada"), one for every brand.
const CHOICE_BADGES = Object.freeze(['recommended']);
/* codex PB-2 r1 P2-5 — ACTIVE markup and EXECUTABLE code only, never raw text.
   activeHtml: the page with every HTML comment removed (an unterminated `<!--` runs to the end, as in a browser) and the
   bodies of inline <script>, <template>, <noscript> and <textarea> emptied (text there never loads a module) — so only a
   real element counts as the tag. */
function activeHtml(html) {
  return String(html)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/(<(script|template|noscript|textarea)\b[^>]*>)[\s\S]*?(<\/\2\s*>)/gi, (m, open, tag, close) => (/\bsrc\s*=/i.test(open) ? m : open + close));
}
/* codeOnly: the module with every comment and every string / template-literal BODY blanked (newlines kept), by a small
   scanner — so a declaration that is commented out, or that merely appears inside a string, is not a declaration. */
function codeOnly(src) {
  let out = ''; let i = 0; const n = src.length;
  const blank = (t) => t.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const j = src.indexOf('\n', i); const e = j === -1 ? n : j; out += blank(src.slice(i, e)); i = e; continue; }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); const e = j === -1 ? n : j + 2; out += blank(src.slice(i, e)); i = e; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j += 1; else if (c !== '`' && src[j] === '\n') break; j += 1; }
      const e = Math.min(n, j + 1); out += c + blank(src.slice(i + 1, e - 1)) + (e - 1 > i ? src[e - 1] : ''); i = e; continue;
    }
    out += c; i += 1;
  }
  return out;
}
// the declaration as a STATEMENT: at the start of a line or after a statement boundary, in code (not a comment / string)
const GROUP_PICKER_DECL = /(?:^|[;{}])[ \t]*const GROUP_PICKER_V1 = 1;/m;
function formShipsPicker(rid, root) {
  if (activeHtml(formSource(rid, root)).split(GROUP_PICKER_TAG).length !== 2) return false;
  const mod = formSiblingSource(rid, GROUP_PICKER_FILE, root);
  return typeof mod === 'string' && GROUP_PICKER_MARKER.test(mod) && GROUP_PICKER_DECL.test(codeOnly(mod));
}
function deriveRender(root) { return BRANDS.every((rid) => formShipsPicker(rid, root)); }
const RENDER_PLATFORM = (render) => `'use strict';
// GENERATED by tools/generate-renderer-contract.js — do not edit by hand.
//
// The platform RENDER capability for required-choice groups: true only when every shipped customer form carries the
// shared group picker (GROUP_PICKER_V1). Read by catalog/platform-groups.js; ONE value for every restaurant.
module.exports = ${JSON.stringify({ render }, null, 2)};
`;
function writePlatformRender(target) {
  const file = target || join(__dirname, '..', 'catalog', 'platform-render.generated.js');
  writeFileSync(file, RENDER_PLATFORM(deriveRender()), 'utf8');
  return file;
}

if (require.main === module) { console.log(`wrote ${writeContract()}`); console.log(`wrote ${writeFallbackGroups()}`); console.log(`wrote ${writePlatformRender()}`); }
module.exports = { deriveContract, deriveContracts, writeContract, RENDER, BRANDS, renderedCategoriesOf,
  deriveFallbackGroups, RENDER_FALLBACK_GROUPS, writeFallbackGroups, deriveRender, formShipsPicker, activeHtml, codeOnly, CHOICE_BADGES, RENDER_PLATFORM, writePlatformRender };
