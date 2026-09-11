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
const { pricingKeyOf, deriveStartingPrice } = require('./form-menu-source');
const { assertDisplaySafe, checkValue: assertFieldSafe } = require('./display-safety');

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

// ═══ THE RENDERER CONTRACT ═══════════════════════════════════════════════════════════════════════
// 🔴 SOME FACTS ARE NOT THE SUBMISSION'S TO DECIDE. Whether a category label is printed, and which
// badges exist at all, are properties of the SHIPPED RENDERER — so they must be read from the
// renderer, not inferred from the document being validated.
//
// Inferring them from the submission is a validator that can be talked out of its own rules. Requiring
// a category name only when "some names remain" means deleting EVERY name satisfies it. Checking tags
// against the badges the SOURCE declares means a source can define a ghost badge and reference it —
// and the renderer, which selects from its own list, silently shows nothing.
//
// Derived per brand from that brand's own shipped form, so there is no new restaurant literal here:
// a brand whose form has no CATEGORIES literal renders id-only categories and legitimately carries no
// names; a brand with no badge literal has no badge system to reference.
// 🔴 READ FROM THE COMMITTED ARTIFACT, NOT FROM THE FORM. Deriving this at request time by reading
// the shipped form worked locally and was a hole in production: the forms are not in the functions
// deploy bundle, so the read threw, the throw was caught, and the contract quietly constrained
// nothing — precisely where the constraint mattered. tools/generate-renderer-contract.js bakes it
// into the package and a parity test regenerates and compares, so it cannot drift.
//
// FAIL CLOSED. A missing or unparseable artifact is a broken deployment, not a licence to validate
// less. Everything stops.
let CONTRACT_TABLE = null;
function contractTable() {
  if (CONTRACT_TABLE) return CONTRACT_TABLE;
  let table;
  try { table = require('./renderer-contract.generated'); } catch (e) {
    throw new Error(`source_malformed: the renderer contract artifact is missing or unreadable (${e.message}); refusing to validate against an unknown renderer`);
  }
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    throw new Error('source_malformed: the renderer contract artifact is not a table; refusing to validate against an unknown renderer');
  }
  CONTRACT_TABLE = table;
  return table;
}

function rendererContract(rid) {
  const table = contractTable();
  // 🔴 ABSENT AND FALSY ARE DIFFERENT ANSWERS. `if (!entry)` read null, false, 0 and "" as "this brand
  // is not in the table" — so a corrupted entry for la_musa re-opened exactly the fail-open hole the
  // artifact was baked to close, for that brand only and silently. Own-property membership separates
  // "nobody described this brand" from "this brand's description is broken".
  if (!Object.prototype.hasOwnProperty.call(table, rid)) {
    // No bespoke renderer to honour. The badge set is EMPTY — never the keys the submission declares,
    // which would be the document deciding its own rules again — and categories need no labels,
    // because nothing prints them.
    return { categoriesNamed: false, badges: new Set() };
  }
  const entry = table[rid];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || typeof entry.categoriesNamed !== 'boolean' || !Array.isArray(entry.badges)) {
    throw new Error(`source_malformed: the renderer contract for ${rid} is present but malformed; refusing to validate against a renderer it does not describe`);
  }
  return { categoriesNamed: entry.categoriesNamed, badges: new Set(entry.badges) };
}

// THREE SEPARATE QUESTIONS PER FIELD: is it required, what TYPE must it be, and is its content safe.
// Answering them with one check is how wrong-typed values got through — `desc: {}` stringified to
// "[object Object]", a perfectly safe-looking string, so the only rule that looked at it passed. Each
// field now declares all three and they are evaluated in that order: a missing field is not a type
// error, and a wrong-typed one is not an injection.
const TYPES = {
  string: (v) => (typeof v === 'string' ? null : 'must be a string'),
  number: (v) => (typeof v === 'number' && Number.isFinite(v) ? null : 'must be a finite number'),
  int_positive: (v) => (isPositiveInt(v) ? null : 'must be a positive integer'),
  boolean: (v) => (typeof v === 'boolean' ? null : 'must be a boolean'),
  object: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? null : 'must be an object'),
  array: (v) => (Array.isArray(v) ? null : 'must be an array'),
  string_array: (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : 'must be an array of strings'),
  id_ref: (v) => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? null : 'must be a string or a number'),
};

// Evaluate one field against its rule. The ORDER is the point: required, then type, then value, then
// content safety.
function checkField(value, rule, label, field) {
  // 🔴 NULL IS PRESENT, NOT ABSENT. Treating them the same let `structure.badges = null` pass the type
  // gate as "not there" and then crash on Object.entries(null) further down — a TypeError instead of
  // a rejection. Absent means the field was never written; null means it was written as nothing.
  if (value === undefined) {
    if (rule.required) fail(`${label} — ${field} is required`);
    return;
  }
  const typeReason = TYPES[rule.type](value);
  if (typeReason) fail(`${label} — ${field} ${typeReason} (got ${typeof value})`);
  if (rule.nonEmpty && typeof value === 'string' && !value.trim()) fail(`${label} — ${field} must not be blank`);
  if (rule.enum && !rule.enum.includes(value)) fail(`${label} — ${field} must be one of ${rule.enum.join(', ')} (got ${String(value)})`);
  if (rule.unique && Array.isArray(value) && new Set(value).size !== value.length) fail(`${label} — ${field} has duplicate entries`);
  if (rule.sink) {
    const unsafe = assertFieldSafe(value, rule.sink);
    if (unsafe) fail(`display_unsafe: ${label} — ${field} ${unsafe} [${rule.sink} sink]`);
  }
}

// THE ID TYPE FOLLOWS THE RENDERER, AND THE RENDERER FOLLOWS THE KEYING CONVENTION — so it is derived
// from the one place that convention already lives rather than from a second brand literal. A brand
// that prices items BY ID renders `chg('<id>',1)` and its ids are string slugs; a brand that prices BY
// NAME renders `openDetailModal(<id>)` bare, and its ids are numeric DOM handles. Getting this wrong
// is silent: 'ghost' and '2' both validated as x_pizza dish ids and neither one works.
const ID_S = 'sentinel_id';
const NAME_S = 'sentinel_name';
// A numeric UI id is a DOM handle and an argument to an inline handler — it must be a positive
// integer, not merely a number. -0.5 was accepted and would produce `openDetailModal(-0.5)`.
const dishIdTypeFor = (rid) => (pricingKeyOf(rid, { id: ID_S, name: NAME_S }) === ID_S ? 'string' : 'int_positive');


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
  // Duplicate category ids become duplicate DOM ids (`id="cat-<id>"`), so the second section is
  // unreachable and every lookup finds the first.
  if (catIds.size !== st.categories.length) fail(`${rid} — structure.categories has duplicate ids`);
  // 🔴 CATEGORY NAME IS ALL-OR-NOTHING, stated as ONE rule. A brand whose renderer prints category
  // labels must supply one for every category — dropping a single name leaves a blank tab. It is a
  // requiredness that DEPENDS ON THE DATA rather than an unconditional one, because a brand whose
  // categories are ids only (its labels still HTML literals until 1B) is a coherent state, while a
  // partially named set never is.
  //
  // An aggregate "n of m are named" check said exactly the same thing from the other direction, and
  // the two covered each other so completely that neither could be killed on its own. One rule.
  const contract = rendererContract(rid);
  const CATEGORY_RULES = {
    id: { required: true, type: 'string', nonEmpty: true, sink: 'identifier' },
    name: { required: contract.categoriesNamed, type: 'string', nonEmpty: true, sink: 'body' },
    subcats: { required: false, type: 'string_array', unique: true },
    layout: { required: false, type: 'string', enum: ['list', 'grid'] },
  };
  for (const c of st.categories) {
    for (const [f, rule] of Object.entries(CATEGORY_RULES)) checkField(c && c[f], rule, `${rid}/cat ${c && c.id}`, f);
    // Each declared subcategory becomes its own grid; declaring one twice renders every dish in it
    // twice, which reads as a duplicated menu rather than as a mistake.
    for (const sc of (Array.isArray(c.subcats) ? c.subcats : [])) {
      const unsafe = assertFieldSafe(sc, 'body');
      if (unsafe) fail(`display_unsafe: ${rid}/cat ${c.id} — subcats entry ${unsafe} [body sink]`);
    }
  }
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
    }
  }
  // (The old conditional display-price checks lived here. They only compared when the field happened
  // to be present — the case that renders a blank price was the one they skipped — and the strict
  // rules below subsume them entirely. A redundant guard no test can distinguish is how drift returns.)
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
  // Every dish field, declared once: what must be there, what type it must be, and which sink it
  // reaches. Ad-hoc checks were how `desc: {}` and a string dish id got through — each was written
  // for the one failure someone had in mind at the time.
  // The STRUCTURE carries its own version, distinct from the source's. It was ruled exempt and so was
  // never checked at all — the census refuses an exemption, which is how this surfaced.
  checkField(st.schema_version, { required: false, type: 'int_positive' }, `${rid}`, 'structure.schema_version');
  const dishIdType = dishIdTypeFor(rid);
  const ITEM_RULES = {
    key: { required: true, type: 'string', nonEmpty: true },
    price: { required: true, type: 'int_positive' },
    display: { required: true, type: 'object' },
    has_photo: { required: false, type: 'boolean' },
  };
  const DISPLAY_RULES = {
    id: { required: true, type: dishIdType, sink: 'identifier' },
    cat: { required: true, type: 'string', nonEmpty: true, sink: 'identifier' },
    name: { required: true, type: 'string', nonEmpty: true, sink: 'attribute' },
    price: { required: true, type: 'int_positive' },
    desc: { required: false, type: 'string', sink: 'body' },
    subcat: { required: false, type: 'string', nonEmpty: true, sink: 'body' },
    emoji: { required: false, type: 'string', sink: 'body' },
    color: { required: false, type: 'string', sink: 'color' },
    img: { required: false, type: 'string', sink: 'url' },
    tags: { required: false, type: 'string_array', unique: true, sink: 'identifier_list' },
    variantOf: { required: false, type: 'id_ref' },
    choice: { required: false, type: 'string', nonEmpty: true, sink: 'body' },
  };
  const uiIds = new Map();
  for (const it of source.items) {
    for (const [f, rule] of Object.entries(ITEM_RULES)) checkField(it[f], rule, `${rid}/${it.key}`, f);
    const d = it.display;
    for (const [f, rule] of Object.entries(DISPLAY_RULES)) checkField(d[f], rule, `${rid}/${it.key}`, `display.${f}`);
    // Present AND equal in one rule: `undefined !== 340`, so strict equality already rejects a missing
    // display price. The old rule's mistake was the opposite — it skipped the comparison when the
    // field was absent, which is exactly the case that renders a blank price.
    if (d.price !== it.price) fail(`${rid}/${it.key} — display price ${String(d.price)} must be present and equal to the authoritative price ${it.price}`);
    // A variant with no choice label renders a blank row in a REQUIRED selection list.
    if (d.variantOf != null && (typeof d.choice !== 'string' || !d.choice.trim())) {
      fail(`${rid}/${it.key} — is a variant but carries no choice label, so its row in the required selection would be blank`);
    }
    // UI ids reach the DOM as strings, so two that differ only by type collide there.
    const uid = String(d.id);
    if (uiIds.has(uid)) fail(`${rid}/${it.key} — duplicate UI id ${uid} (also ${uiIds.get(uid)}); ids collide as DOM strings`);
    uiIds.set(uid, it.key);
  }

  // ── SUBCATEGORY COVERAGE ─────────────────────────────────────────────────────────────────────
  // An item whose subcat its category never declares DISAPPEARS: the renderer groups by the declared
  // subcats and silently drops the rest. A vanished dish is indistinguishable from a deleted one.
  const subcatsByCat = new Map(st.categories.map((c) => [c && c.id, Array.isArray(c && c.subcats) ? c.subcats : null]));
  for (const it of source.items) {
    const sub = it.display.subcat;
    const declared = subcatsByCat.get(it.display.cat);
    // BOTH directions vanish. If the category groups by subcats, the renderer builds one grid per
    // declared subcat and an item with NO subcat is in none of them — so "absent" is as fatal as
    // "wrong", and only checking the value when it happened to exist missed exactly half of it.
    if (declared && declared.length) {
      if (sub == null) fail(`${rid}/${it.key} — category ${it.display.cat} groups by subcategory, so an item without a subcat would not render at all`);
      if (!declared.includes(sub)) fail(`${rid}/${it.key} — subcat ${sub} is not declared by category ${it.display.cat}, so the item would not render at all`);
    } else if (sub != null) {
      fail(`${rid}/${it.key} — declares subcat ${sub} but category ${it.display.cat} declares no subcategories`);
    }
  }

  // ── EXTRAS AS FIRST-CLASS DISPLAY RECORDS ────────────────────────────────────────────────────
  // The extra-category namespace is SEPARATE from structure.categories: "Salsas & Queso" is not a
  // dish category and never was, so requiring membership there would reject every real extra.
  // 🔴 TYPE-VALIDATED WHENEVER PRESENT; REQUIRED only when extras exist. The whole block used to sit
  // inside `if (extras.length > 0)`, so a menu that sells no add-ons could carry
  // `extra_categories: null` / 7 / "broken" / {} and nothing looked at it. An emptiness test may
  // decide whether a value is NEEDED; it must never decide whether a present value is CHECKED.
  const extraCats = st.extra_categories;
  checkField(extraCats, { required: source.extras.length > 0, type: 'string_array', unique: true }, `${rid}`, 'structure.extra_categories');
  if (Array.isArray(extraCats)) {
    for (const c of extraCats) if (!c.trim()) fail(`${rid} — structure.extra_categories holds a blank entry`);
  }
  if (source.extras.length > 0 && extraCats.length === 0) {
    fail(`${rid} — structure.extra_categories (the ordered extra-category namespace) must be non-empty when extras exist`);
  }
  const extraCatSet = new Set(Array.isArray(extraCats) ? extraCats : []);
  // 🔴 A THIRD NAMESPACE. Extras are selected by UI id — `EXTRAS.find(e => e.id === id)` — so two
  // extras sharing one resolve to the FIRST and the second can never be chosen, whatever the customer
  // taps. Independent of the dish ids and of the pricing keys: x_pizza extras key by NAME and their
  // ids are form-local handles, so uniqueness there is not implied by anything already checked.
  const extraUiIds = new Map();
  for (const ex of source.extras) {
    checkField(ex.display, { required: true, type: 'object' }, `${rid}/extra ${ex.key}`, 'display');
    // An extra is SELECTED by a STRING id — `EXTRAS.find(e => e.id === id)` compares against the id
    // that came back out of the DOM, so a numeric one never matches and the extra becomes
    // unselectable. The dish id follows its brand's convention; this one is a string in both.
    const EXTRA_RULES = {
      id: { required: true, type: 'string', nonEmpty: true, sink: 'identifier' },
      cat: { required: true, type: 'string', nonEmpty: true, sink: 'body' },
      name: { required: true, type: 'string', nonEmpty: true, sink: 'body' },
      price: { required: true, type: 'int_positive' },
    };
    for (const [f, rule] of Object.entries(EXTRA_RULES)) checkField(ex.display[f], rule, `${rid}/extra ${ex.key}`, `display.${f}`);
    if (ex.display.price !== ex.price) fail(`${rid}/extra ${ex.key} — display price ${String(ex.display.price)} must be present and equal to the authoritative price ${ex.price}`);
    if (!extraCatSet.has(ex.display.cat)) {
      fail(`${rid}/extra ${ex.key} — cat ${ex.display.cat} is not in the declared extra-category namespace (it is a separate namespace from the dish categories)`);
    }
    const euid = String(ex.display.id);
    if (extraUiIds.has(euid)) fail(`${rid}/extra ${ex.key} — duplicate extra UI id ${euid} (also ${extraUiIds.get(euid)}); selection resolves to the first and the second is unreachable`);
    extraUiIds.set(euid, ex.key);
  }

  // ── EXPOSURE MAP VALUES ──────────────────────────────────────────────────────────────────────
  // The keys were already checked; the VALUES were not, so a map could expose a category that does
  // not exist and simply offer nothing — invisible, and exactly the kind of silence 1A removes.
  // A value may name an extra-CATEGORY or an individual extra KEY (the resolver's key-level add).
  const extraKeys = new Set(source.extras.map((e) => e.key));
  const legalExposureValue = (v) => extraCatSet.has(v) || extraKeys.has(v);
  for (const field of ['extras_by_category', 'extras_by_item']) {
    const map = st[field];
    if (map === undefined) continue;
    // A plain object BEFORE traversal: `extras_by_item = 7` walked straight past Object.entries(7),
    // which yields nothing, so a scalar where a map belongs was silently an empty map.
    checkField(map, { required: false, type: 'object' }, `${rid}`, `structure.${field}`);
    for (const [k, vals] of Object.entries(map)) {
      // (the map's KEYS are already checked against the category/item namespaces further up; a second
      //  copy here was redundant and could not be killed on its own)
      checkField(vals, { required: true, type: 'string_array', unique: true }, `${rid}`, `structure.${field}.${k}`);
      for (const v of vals) {
        if (!legalExposureValue(v)) fail(`${rid} — structure.${field}.${k} references ${v}, which is neither a declared extra-category nor a known extra`);
      }
    }
  }

  // ── VARIANT GRAPH ────────────────────────────────────────────────────────────────────────────
  // A launcher offers a required choice between real variants. Every way that graph can be open —
  // an orphan, a dangling id, an empty choice, a cycle, a variant claimed by two launchers, a
  // variant nobody lists — ends as a dish a customer can reach and cannot order.
  // (A pre-traversal typing pass over every collection lived here. Once `null` counts as PRESENT
  //  rather than absent, each collection is already typed where it is used — badges in the badge
  //  block, the exposure maps in theirs, the gate and redemption arrays in theirs — so a present-null
  //  one is a clean rejection at that point rather than a TypeError. The extra pass was a duplicate no
  //  test could distinguish, which is the shape of a guard that quietly stops meaning anything.)
  // Typed BEFORE traversal. Substituting {} for anything non-object meant a null or a string where the
  // variant map belongs simply became "this menu has no variants" — the launcher's own dishes then
  // validated as ordinary items and the required choice vanished.
  checkField(st.variant_items, { required: false, type: 'object' }, `${rid}`, 'structure.variant_items');
  // Subsumed by the type check above (a present-but-wrong map is already rejected), so restoring the
  // old `typeof === 'object' ? x : {}` breaks no test. Kept because "absent means none" and "anything
  // I cannot read means none" are different statements, and only one of them is true.
  const vi = st.variant_items === undefined ? {} : st.variant_items;
  {
    const byUiId = new Map(source.items.map((i) => [String(i.display.id), i]));
    const claimed = new Map();
    for (const [launcherId, spec] of Object.entries(vi)) {
      if (!byUiId.has(String(launcherId))) fail(`${rid} — variant launcher ${launcherId} is not a real item (orphan)`);
      const ids = spec && spec.variantIds;
      if (!Array.isArray(ids) || ids.length === 0) fail(`${rid} — variant launcher ${launcherId} offers an empty choice list`);
      // 🔴 basePrice IS THE "desde" AND IT REACHES UNESCAPED HTML TWICE. Typed as a number, which is
      // what closes the injection: a number cannot be markup. It must also be the real minimum
      // SELECTABLE variant price — the launcher keeps its own, higher, authoritative price (Pad Thai
      // launches at L414 and starts from L307), so the two are deliberately NOT equated.
      const VARIANT_RULES = {
        label: { required: true, type: 'string', nonEmpty: true, sink: 'body' },
        variantIds: { required: true, type: 'array' },
      };
      for (const [f, rule] of Object.entries(VARIANT_RULES)) checkField(spec && spec[f], rule, `${rid}/variant ${launcherId}`, f);

      // 🔴 "DESDE" IS DERIVED, SO IT MUST NOT BE AUTHORED. Task 2 required an authored basePrice and
      // checked it equalled the cheapest selectable variant — which caught a drifted copy. Not storing
      // one at all is stronger: there is no second number for the variants to disagree with, so the
      // form's "desde" is a fact about the variants by construction rather than a claim checked after
      // the fact. Refused even when the authored value is CORRECT, because being right today is not
      // the property being protected.
      // 🔴 THE KEY, NOT THE VALUE. `spec.basePrice !== undefined` reads `{ basePrice: undefined }` —
      // an own property that is very much authored — as absent. The third time this exact confusion
      // has produced a hole here, and the answer is the same each time: ask whether the field was
      // WRITTEN, not what it was written as.
      if (spec && Object.prototype.hasOwnProperty.call(spec, 'basePrice')) {
        fail(`${rid} — variant launcher ${launcherId} authors a basePrice; "desde" is derived from the variants at emission and must not be stored (an authored copy is a number that can drift from what it summarises)`);
      }
      // ...and one must be DERIVABLE, or the form renders a launcher with no starting price at all.
      const desde = deriveStartingPrice(byUiId.get(String(launcherId)), ids.map((v) => byUiId.get(String(v))).filter(Boolean));
      if (desde == null) {
        fail(`${rid} — variant launcher ${launcherId} has no variant carrying a usable price, so no starting price could be derived for it`);
      }
      for (const v of ids) {
        // The renderer matches STRICTLY (`p.id === vid`), so a non-primitive reference silently
        // matches nothing and the choice vanishes from a REQUIRED selection. `[id]` stringifies to
        // the same text as `id`, which is exactly how it got through a String()-based comparison.
        if (typeof v !== 'string' && typeof v !== 'number') fail(`${rid} — variant launcher ${launcherId} lists a ${Array.isArray(v) ? 'array' : typeof v} where a variant id belongs; the renderer matches strictly and would drop it`);
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
    // ...and the other direction, checked UNCONDITIONALLY. This used to sit inside `if (variant_items)`,
    // so deleting the whole map made every variant in the menu orphaned and validated cleanly.
    for (const it of source.items) {
      const parent = it.display.variantOf;
      if (parent == null) continue;
      if (!claimed.has(String(it.display.id))) fail(`${rid}/${it.key} — declares variantOf ${parent} but no launcher lists it (missing coverage)`);
    }
    // 🔴 CYCLES IN GENERAL, not just self-reference. `a.variantOf = b; b.variantOf = a` has no
    // self-edge and no launcher, and walking upward from either never terminates — the old check only
    // compared a launcher against its own id, which is one shape of one case.
    for (const it of source.items) {
      const seenPath = new Set();
      let cur = it;
      while (cur && cur.display.variantOf != null) {
        const id = String(cur.display.id);
        if (seenPath.has(id)) fail(`${rid}/${it.key} — variantOf forms a cycle (${[...seenPath].join(' → ')} → ${id})`);
        seenPath.add(id);
        cur = byUiId.get(String(cur.display.variantOf));
      }
    }
  }

  // ── BADGES ───────────────────────────────────────────────────────────────────────────────────
  // A tag is a lookup key into the badge definitions. One that names no definition renders no badge —
  // the merchant sees their "Chef's pick" simply not appear, with nothing to explain it.
  // Badge DEFINITIONS are records too, and `badges.ghost = {}` was accepted — then a tag naming it
  // rendered nothing, which is the same silence the tag rule was written to stop. `cls` reaches a
  // class attribute, so it is constrained like any other attribute-context value.
  if (st.badges !== undefined) {
    checkField(st.badges, { required: false, type: 'object' }, `${rid}`, 'structure.badges');
    for (const [k, def] of Object.entries(st.badges)) {
      checkField(def, { required: true, type: 'object' }, `${rid}/badge ${k}`, 'definition');
      checkField(def.label, { required: true, type: 'string', nonEmpty: true, sink: 'body' }, `${rid}/badge ${k}`, 'label');
      checkField(def.cls, { required: true, type: 'string', nonEmpty: true, sink: 'attribute' }, `${rid}/badge ${k}`, 'cls');
    }
  }
  // The definitions a source may declare are the ones its renderer can actually select. A definition
  // outside that set renders nothing however well-formed it is.
  if (st.badges !== undefined) {                 // a null map was already rejected as a wrong type above
    for (const k of Object.keys(st.badges)) {
      if (!contract.badges.has(k)) fail(`${rid} — badge ${k} is not one the renderer can select (the badge set is fixed by the shipped form, not by this document)`);
    }
  }
  // ALWAYS the contract's set — never the source's own keys. A brand with no badge renderer has an
  // EMPTY set, so any tag on it is refused; falling back to what the document declares would hand the
  // decision back to the document.
  // Mutation reports a source-keys fallback here as a survivor, and structurally it is: definitions are
  // bound to the contract set above, so the source's keys are necessarily a subset and the two agree.
  // This stays the direct statement of the rule — tags reference what the RENDERER can select.
  const badgeKeys = contract.badges;
  for (const it of source.items) {
    for (const t of (Array.isArray(it.display.tags) ? it.display.tags : [])) {
      if (!badgeKeys.has(t)) fail(`${rid}/${it.key} — tag ${t} is not a badge the renderer can select, so it would render nothing`);
    }
  }

  // ── REVERSE MEMBERSHIP: NOTHING DECLARED AND UNUSED ──────────────────────────────────────────
  // The forward direction (every used category is declared) was already checked. 1A means COMPLETE
  // AND CONSISTENT, so the reverse holds too: a declared category nothing is in renders an empty
  // section, and a declared subcategory nothing is in renders an empty heading. Both are far more
  // likely a rename that half-landed than an intention. Refused now; if pre-creating empty categories
  // is ever wanted, that is a deliberate relaxation rather than a gap nobody noticed.
  // The same rule for the EXTRA-category namespace: a declared extra-category no extra is in renders
  // an empty option group. Reverse coverage was written for dish categories only.
  const usedExtraCats = new Set(source.extras.map((e) => e.display && e.display.cat));
  for (const c of (Array.isArray(extraCats) ? extraCats : [])) {
    if (!usedExtraCats.has(c)) fail(`${rid} — extra-category ${c} is declared but no extra is in it (it would render an empty option group)`);
  }
  const usedCatIds = new Set(source.items.map((i) => i.display.cat));
  for (const c of st.categories) {
    if (!usedCatIds.has(c.id)) fail(`${rid} — category ${c.id} is declared but no dish is in it (it would render an empty section)`);
    if (!Array.isArray(c.subcats)) continue;
    const usedSubs = new Set(source.items.filter((i) => i.display.cat === c.id).map((i) => i.display.subcat));
    for (const sc of c.subcats) {
      if (!usedSubs.has(sc)) fail(`${rid} — category ${c.id} declares subcategory ${sc} but no dish is in it (it would render an empty heading)`);
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
    // Unique, like every other reference array: gating the same category twice is not an error the
    // renderer reports, it is simply a list that says one thing twice.
    checkField(arr, { required: false, type: 'string_array', unique: true }, `${rid}`, `structure.${field}`);
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
