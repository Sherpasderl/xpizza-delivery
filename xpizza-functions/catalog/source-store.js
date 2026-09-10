'use strict';
// ---------------------------------------------------------------------------
// Portal Phase 2a — THE SOURCE STORE. `restaurants/{rid}/meta/source` becomes the single authority
// for everything menu-derived: prices, display records, category structure, variants, photo flags,
// the gate categories, and the form-side extras exposure maps.
//
// Everything here is FAIL-CLOSED. A source that is missing, malformed, or internally inconsistent
// throws rather than returning partial build inputs — a half-read source would publish a half-menu,
// and a publish is what customers are charged from.
//
// KEY ASYMMETRY (the thing most likely to be got wrong): the pricing key is per-brand, and it applies
// to EXTRAS as well as items. x_pizza keys both by NAME; la_musa keys both by ID. The store carries
// `key` explicitly and validates it against the display record, so the two can never drift apart.
// ---------------------------------------------------------------------------
const { pricingKeyOf } = require('./form-menu-source');
const { assertDisplaySafe } = require('./display-safety');

// The COMPLETE display schema. A source stamped with this validates as a full customer-display
// payload — every dish priced and described, every extra a first-class record, exposure resolvable,
// the variant graph closed, and nothing in it able to carry an XSS payload to today's renderers.
const SCHEMA_VERSION = 2;

// The EXTRAS pricing key, per brand — the mirror of pricingKeyOf for items. x_pizza extras are keyed
// by NAME (their display `id` is a form-local handle like 'e1' that prices nothing); la_musa extras
// are keyed by that id slug. Kept beside the item rule so the two cannot drift apart.
const extrasKeyOf = (restaurantId, display) => (restaurantId === 'la_musa' ? (display && display.id) : (display && display.name));

// The code-path literals this schema covers. The completeness test asserts every literal the code
// path reads appears here — so a future code-only field cannot silently become uneditable in 2b.
// EXTRAS / EXTRAS_BY_CATEGORY / EXTRAS_BY_ITEM are form-side (no server consumer today) but are
// menu-derived data the portal must own, so they are carried too.
const SOURCE_COVERED_LITERALS = [
  'MENU', 'CATEGORIES', 'VARIANT_ITEMS', 'HAS_PHOTO', 'PICKUP_ONLY_CATS', 'WEEKEND_ONLY_CATS',
  'EXTRAS', 'EXTRAS_BY_CATEGORY', 'EXTRAS_BY_ITEM',
];

const sourceRefOf = (db, rid) => db.collection('restaurants').doc(rid).collection('meta').doc('source');

// Stable RECURSIVE key ordering. Arrays are left alone: their order is CONTENT here (item_order,
// categories, variant lists), and sorting them would silently rewrite the menu.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

const isPositiveInt = (p) => Number.isInteger(p) && p > 0;   // same rule as the reader + the calculators

function fail(msg) { throw new Error(`source_malformed: ${msg}`); }

// Reject anything that could produce a wrong or partial build. Ordering of checks is deliberate:
// identity → shape → values → bijection → structural coverage, so the error names the first real problem.
function validateSource(source, rid) {
  if (!source || typeof source !== 'object') fail(`${rid} — source is not an object`);
  if (source.restaurant_id !== rid) fail(`${rid} — restaurant_id mismatch (${String(source.restaurant_id)})`);
  if (!Array.isArray(source.items) || source.items.length === 0) fail(`${rid} — items must be a non-empty array`);
  if (!Array.isArray(source.extras)) fail(`${rid} — extras must be an array`);
  const st = source.structure;
  if (!st || typeof st !== 'object') fail(`${rid} — structure missing`);
  if (!Array.isArray(st.categories) || st.categories.length === 0) fail(`${rid} — structure.categories must be a non-empty array`);
  if (!Array.isArray(st.item_order)) fail(`${rid} — structure.item_order must be an array`);

  const catIds = new Set(st.categories.map((c) => c && c.id));
  const seen = new Set();
  for (const it of source.items) {
    if (!it || typeof it !== 'object') fail(`${rid} — a non-object item`);
    if (typeof it.key !== 'string' || !it.key) fail(`${rid} — item missing a string key`);
    if (!isPositiveInt(it.price)) fail(`${rid}/${it.key} — price is not a positive integer`);
    if (!it.display || typeof it.display !== 'object') fail(`${rid}/${it.key} — item missing its display record`);
    // The key IS the pricing identity; it must agree with the display record it describes, or an edit
    // to the display name would silently reprice (x_pizza) or orphan (la_musa) the item.
    const derived = pricingKeyOf(rid, it.display);
    if (derived !== it.key) fail(`${rid}/${it.key} — key does not match its display record (derived ${String(derived)})`);
    if (seen.has(it.key)) fail(`${rid}/${it.key} — duplicate item key`);
    seen.add(it.key);
    if (it.display.cat != null && !catIds.has(it.display.cat)) fail(`${rid}/${it.key} — references unknown category ${it.display.cat}`);
  }
  const eseen = new Set();
  for (const ex of source.extras) {
    if (!ex || typeof ex.key !== 'string' || !ex.key) fail(`${rid} — extra missing a string key`);
    if (!isPositiveInt(ex.price)) fail(`${rid}/extra ${ex.key} — price is not a positive integer`);
    if (eseen.has(ex.key)) fail(`${rid}/extra ${ex.key} — duplicate extra key`);
    eseen.add(ex.key);
    // EXTRAS CARRY THE SAME PRICING-KEY ASYMMETRY AS ITEMS, and it is easy to get wrong: x_pizza
    // extras price by NAME while their display record ALSO has an `id` ('e1'), and la_musa extras
    // price by that id. A seed that keyed x_pizza extras by `e1` would round-trip cleanly and hash
    // stably — and price nothing, because no cart line would ever match. Fail closed on it.
    if (ex.display) {
      const derived = extrasKeyOf(rid, ex.display);
      if (derived !== ex.key) fail(`${rid}/extra ${ex.key} — key does not match its display record (derived ${String(derived)}; x_pizza extras key by NAME, la_musa by id)`);
      // A display record carrying its own price must AGREE with the authoritative one, or the form
      // would render one number while the server charges another.
      if (ex.display.price !== undefined && ex.display.price !== ex.price) {
        fail(`${rid}/extra ${ex.key} — display price ${ex.display.price} disagrees with the authoritative price ${ex.price}`);
      }
    }
  }
  // The same inline-price agreement for ITEMS: the form dish records carry `price` too.
  for (const it of source.items) {
    if (it.display && it.display.price !== undefined && it.display.price !== it.price) {
      fail(`${rid}/${it.key} — display price ${it.display.price} disagrees with the authoritative price ${it.price}`);
    }
  }
  // CATEGORY SUPERSET (portal ruling): the authored categories must cover every category the dishes
  // actually use. Categories are store-authored so a merchant can rename/reorder/group them, which
  // means they can also drift — this catches both a dropped category and a dish pointing at a ghost.
  const usedCats = new Set(source.items.map((i) => i.display && i.display.cat).filter((c) => c != null));
  for (const c of usedCats) if (!catIds.has(c)) fail(`${rid} — authored categories are missing ${c}, which a dish uses`);

  // ═══ THE COMPLETE DISPLAY PAYLOAD (1A Task 2) ══════════════════════════════════════════════════
  // Everything below exists because 1A makes this source the ONE thing the customer form is built
  // from. "Valid" therefore has to mean "a customer can be shown this", not just "the prices add up".
  if (source.schema_version !== SCHEMA_VERSION) {
    fail(`${rid} — schema_version must be ${SCHEMA_VERSION} (the complete display schema); got ${String(source.schema_version)}`);
  }

  // ── DISHES: display price MANDATORY, not "checked when present" ───────────────────────────────
  // The old rule only compared display.price when it happened to exist, so a dish with no display
  // price passed validation and then rendered blank or fell back to a literal. Mandatory closes it.
  const uiIds = new Map();
  for (const it of source.items) {
    const d = it.display;
    // MANDATORY AND EQUAL IN ONE RULE. `undefined !== 340`, so strict equality already rejects a
    // missing display price — a separate presence check would be a second line that can only ever
    // fire when this one would have. The old rule's mistake was the opposite: it skipped the
    // comparison when the field was absent, which is exactly the case that renders a blank price.
    if (d.price !== it.price) fail(`${rid}/${it.key} — display price ${String(d.price)} must be present and equal to the authoritative price ${it.price}`);
    if (d.cat == null) fail(`${rid}/${it.key} — missing a category`);
    // UI ids reach the DOM as strings, so two ids that differ only by type collide there.
    const uid = String(d.id);
    if (d.id === undefined || d.id === null || uid === '') fail(`${rid}/${it.key} — missing a UI id`);
    if (uiIds.has(uid)) fail(`${rid}/${it.key} — duplicate UI id ${uid} (also ${uiIds.get(uid)}); ids collide as DOM strings`);
    uiIds.set(uid, it.key);
  }

  // ── SUBCATEGORY COVERAGE ─────────────────────────────────────────────────────────────────────
  // An item whose subcat its category never declares DISAPPEARS: the renderer groups by the declared
  // subcats and silently drops the rest. A vanished dish is indistinguishable from a deleted one.
  const subcatsByCat = new Map(st.categories.map((c) => [c && c.id, Array.isArray(c && c.subcats) ? c.subcats : null]));
  for (const it of source.items) {
    const sub = it.display.subcat;
    if (sub == null) continue;
    const declared = subcatsByCat.get(it.display.cat);
    if (!declared || !declared.includes(sub)) {
      fail(`${rid}/${it.key} — subcat ${sub} is not declared by category ${it.display.cat}, so the item would not render at all`);
    }
  }

  // ── EXTRAS AS FIRST-CLASS DISPLAY RECORDS ────────────────────────────────────────────────────
  // The extra-category namespace is SEPARATE from structure.categories: "Salsas & Queso" is not a
  // dish category and never was, so requiring membership there would reject every real extra.
  const extraCats = st.extra_categories;
  if (source.extras.length > 0) {
    if (!Array.isArray(extraCats) || extraCats.length === 0) {
      fail(`${rid} — structure.extra_categories (the ordered extra-category namespace) is required when extras exist`);
    }
    if (new Set(extraCats).size !== extraCats.length) fail(`${rid} — structure.extra_categories has duplicates`);
    for (const c of extraCats) if (typeof c !== 'string' || !c) fail(`${rid} — structure.extra_categories holds a non-string entry`);
  }
  const extraCatSet = new Set(Array.isArray(extraCats) ? extraCats : []);
  for (const ex of source.extras) {
    if (!ex.display || typeof ex.display !== 'object') fail(`${rid}/extra ${ex.key} — missing its display record (every extra is a first-class display record)`);
    for (const field of ['id', 'cat', 'name']) {
      if (ex.display[field] === undefined || ex.display[field] === null || ex.display[field] === '') {
        fail(`${rid}/extra ${ex.key} — display record missing ${field}`);
      }
    }
    if (ex.display.price !== ex.price) fail(`${rid}/extra ${ex.key} — display price ${String(ex.display.price)} must be present and equal to the authoritative price ${ex.price}`);
    if (!extraCatSet.has(ex.display.cat)) {
      fail(`${rid}/extra ${ex.key} — cat ${ex.display.cat} is not in the declared extra-category namespace (it is a separate namespace from the dish categories)`);
    }
  }

  // ── EXPOSURE MAP VALUES ──────────────────────────────────────────────────────────────────────
  // The keys were already checked; the VALUES were not, so a map could expose a category that does
  // not exist and simply offer nothing — invisible, and exactly the kind of silence 1A removes.
  // A value may name an extra-CATEGORY or an individual extra KEY (the resolver's key-level add).
  const extraKeys = new Set(source.extras.map((e) => e.key));
  const legalExposureValue = (v) => extraCatSet.has(v) || extraKeys.has(v);
  for (const field of ['extras_by_category', 'extras_by_item']) {
    const map = st[field];
    if (!map) continue;
    for (const [k, vals] of Object.entries(map)) {
      if (!Array.isArray(vals)) fail(`${rid} — structure.${field}.${k} must be an array`);
      for (const v of vals) {
        if (!legalExposureValue(v)) fail(`${rid} — structure.${field}.${k} references ${v}, which is neither a declared extra-category nor a known extra`);
      }
    }
  }

  // ── VARIANT GRAPH ────────────────────────────────────────────────────────────────────────────
  // A launcher offers a required choice between real variants. Every way that graph can be open —
  // an orphan, a dangling id, an empty choice, a cycle, a variant claimed by two launchers, a
  // variant nobody lists — ends as a dish a customer can reach and cannot order.
  const vi = st.variant_items;
  if (vi && typeof vi === 'object') {
    const byUiId = new Map(source.items.map((i) => [String(i.display.id), i]));
    const claimed = new Map();
    for (const [launcherId, spec] of Object.entries(vi)) {
      if (!byUiId.has(String(launcherId))) fail(`${rid} — variant launcher ${launcherId} is not a real item (orphan)`);
      const ids = spec && spec.variantIds;
      if (!Array.isArray(ids) || ids.length === 0) fail(`${rid} — variant launcher ${launcherId} offers an empty choice list`);
      for (const v of ids) {
        if (String(v) === String(launcherId)) fail(`${rid} — variant launcher ${launcherId} lists itself as a variant (cycle)`);
        const item = byUiId.get(String(v));
        if (!item) fail(`${rid} — variant launcher ${launcherId} lists ${v}, which is not a real item`);
        if (claimed.has(String(v))) fail(`${rid} — variant ${v} is claimed by both ${claimed.get(String(v))} and ${launcherId}`);
        claimed.set(String(v), String(launcherId));
        const parent = item.display.variantOf;
        if (String(parent) !== String(launcherId)) {
          fail(`${rid} — variant ${v} points at launcher ${String(parent)} but is listed by ${launcherId} (bad parent)`);
        }
      }
    }
    // ...and the other direction: a variant nobody lists is unreachable through its launcher.
    for (const it of source.items) {
      const parent = it.display.variantOf;
      if (parent == null) continue;
      if (!claimed.has(String(it.display.id))) fail(`${rid}/${it.key} — declares variantOf ${parent} but no launcher lists it (missing coverage)`);
    }
  }

  // ── RENDERING SAFETY, LAST ───────────────────────────────────────────────────────────────────
  // Structure first, then content: an unsafe value in a record that is also malformed should name the
  // malformation. 1B replaces the unsafe renderers; until then this is the only thing standing
  // between an authored value and an executable one.
  for (const it of source.items) assertDisplaySafe(it.display, 'item', `${rid}/${it.key}`);
  for (const ex of source.extras) assertDisplaySafe(ex.display, 'extra', `${rid}/extra/${ex.key}`);
  for (const c of st.categories) assertDisplaySafe(c, 'category', `${rid}/cat/${c && c.id}`);

  // item_order must be a BIJECTION with items — the same three-legged check the display reader uses.
  // Any two of exists/length/uniqueness can hold while the menu is still wrong.
  if (new Set(st.item_order).size !== st.item_order.length) fail(`${rid} — item_order has duplicate keys`);
  for (const k of st.item_order) if (!seen.has(k)) fail(`${rid} — item_order references missing item ${k}`);
  if (st.item_order.length !== source.items.length) fail(`${rid} — item_order covers ${st.item_order.length} of ${source.items.length} items`);
  // the gate categories must exist, or a gate would silently apply to nothing
  for (const field of ['pickup_only_cats', 'weekend_only_cats']) {
    const arr = st[field];
    if (arr === undefined) continue;
    if (!Array.isArray(arr)) fail(`${rid} — structure.${field} must be an array`);
    for (const c of arr) if (!catIds.has(c)) fail(`${rid} — structure.${field} references unknown category ${c}`);
  }
  // 2a Task 6 — redemption eligibility. Same shape of guard as the availability gates: a reference to
  // something that does not exist would make a reward silently unredeemable (or, worse, a category
  // whose contents nobody checked). MONEY-ADJACENT, so the reference check is not optional.
  if (st.redeem_eligible_cats !== undefined) {
    if (!Array.isArray(st.redeem_eligible_cats)) fail(`${rid} — structure.redeem_eligible_cats must be an array`);
    if (new Set(st.redeem_eligible_cats).size !== st.redeem_eligible_cats.length) fail(`${rid} — structure.redeem_eligible_cats has duplicates`);
    for (const c of st.redeem_eligible_cats) if (!catIds.has(c)) fail(`${rid} — structure.redeem_eligible_cats references unknown category ${c}`);
  }
  if (st.redeem_eligible_extras !== undefined) {
    if (!Array.isArray(st.redeem_eligible_extras)) fail(`${rid} — structure.redeem_eligible_extras must be an array`);
    if (new Set(st.redeem_eligible_extras).size !== st.redeem_eligible_extras.length) fail(`${rid} — structure.redeem_eligible_extras has duplicates`);
    const extraKeys = new Set((source.extras || []).map((e) => e && e.key));
    for (const k of st.redeem_eligible_extras) {
      // An unpriced allowlist entry is an entry that can never be redeemed — silent, so fail on it.
      if (!extraKeys.has(k)) fail(`${rid} — structure.redeem_eligible_extras references unknown extra ${k}`);
    }
  }
  if (st.redeem_eligible_items !== undefined) {
    if (!Array.isArray(st.redeem_eligible_items)) fail(`${rid} — structure.redeem_eligible_items must be an array`);
    if (new Set(st.redeem_eligible_items).size !== st.redeem_eligible_items.length) fail(`${rid} — structure.redeem_eligible_items has duplicates`);
    // MENU namespace only — an extra belongs in redeem_eligible_extras, and a key in neither namespace
    // is an allowlist entry that can never match anything.
    for (const k of st.redeem_eligible_items) if (!seen.has(k)) fail(`${rid} — structure.redeem_eligible_items references unknown item ${k}`);
  }
  if (st.extras_by_category) {
    for (const c of Object.keys(st.extras_by_category)) if (!catIds.has(c)) fail(`${rid} — extras_by_category references unknown category ${c}`);
  }
  if (st.extras_by_item) {
    for (const k of Object.keys(st.extras_by_item)) if (!seen.has(k)) fail(`${rid} — extras_by_item references unknown item ${k}`);
  }
}

// Map the store object to EXACTLY the shapes buildCatalogV2 consumes. Items are emitted in
// item_order, so the built structure's ordering comes from the store rather than array happenstance.
function sourceToBuildInputs(source) {
  const byKey = new Map(source.items.map((i) => [i.key, i]));
  const ordered = source.structure.item_order.map((k) => byKey.get(k));
  const priceTable = {};
  for (const i of ordered) priceTable[i.key] = i.price;
  const extras = {};
  for (const e of source.extras) extras[e.key] = e.price;
  const formData = {
    dishes: ordered.map((i) => i.display),                    // VERBATIM — losslessness is by construction
    item_order: source.structure.item_order.slice(),
    categories: source.structure.categories,
    has_photo: ordered.filter((i) => i.has_photo).map((i) => i.key),
  };
  for (const f of ['variant_items', 'pickup_only_cats', 'weekend_only_cats', 'extras_by_category', 'extras_by_item', 'redeem_eligible_cats', 'redeem_eligible_items', 'redeem_eligible_extras']) {
    if (source.structure[f] !== undefined) formData[f] = source.structure[f];
  }
  if (Array.isArray(source.extras) && source.extras.some((e) => e.display)) {
    formData.extras_display = source.extras.map((e) => e.display).filter(Boolean);
  }
  return { priceTable, formData, extras };
}

// Read + validate in one step. There is deliberately no "read without validating" export: every
// consumer of the source gets a validated one or an exception.
async function readSource(db, rid) {
  const snap = await sourceRefOf(db, rid).get();
  if (!snap || !snap.exists) throw new Error(`source_missing: ${rid}`);
  const source = snap.data();
  validateSource(source, rid);
  return source;
}

module.exports = { SCHEMA_VERSION, readSource, validateSource, sourceToBuildInputs, canonicalize, sourceRefOf, isPositiveInt, extrasKeyOf, SOURCE_COVERED_LITERALS };
