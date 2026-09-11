'use strict';
// ---------------------------------------------------------------------------
// The DISPLAY reader — the complete served payload for a restaurant, plus the IDENTITY of the
// immutable version it came from.
//
// 1A Task 5 changed three things, and each closes a way the old reader could hand back something
// that looked fine and was not:
//
//   1. THE COMPLETE SET. It returned { items, structure } and dropped extras entirely, so the
//      catalog could charge for an option it could not name. It now returns extras and the resolved
//      variant map too — everything a customer sees — and REFUSES a version that is missing any of
//      it. Half a menu is not a menu.
//
//   2. IDENTITY OVER THE WHOLE PAYLOAD. `menu_hash`/`extras_hash` cover {key: price} and nothing
//      else, which is right for money and useless for display: two versions differing only in a dish
//      name, a category order or an option-group exposure produce the SAME money hashes. 1B serves
//      display and 1C charges against it, so a version skew that changes what a customer sees has to
//      be detectable. `identity.content_hash` covers the whole served payload (content-hash.js) and
//      is compared against the value the publisher pinned into the version record.
//
//   3. NO FALLBACK. An absent active_version pointer used to fall through to the FLAT layout, which
//      has no version id, no seq and no immutable identity — so a caller asking "what is live and
//      which version is it" could get a truthful menu with a fabricated-by-omission provenance. An
//      absent pointer is now a typed, fail-closed error. The flat reader still exists for the
//      bootstrap/pre-migration paths, but it must be called BY NAME and it deliberately returns NO
//      identity: nothing can mistake it for a versioned read, because it cannot answer the question.
//
// Deliberately SEPARATE from getRestaurantDocs (the pricing reader) — pricing cannot be affected by
// a display field, and a display bug cannot reach the money path.
// ---------------------------------------------------------------------------
const { buildTablesFromDocs } = require('./catalog-transform');
const { getActiveVersionId } = require('./catalog-firestore');
const { assertComplete } = require('./catalog-integrity');
const { contentHash } = require('./content-hash');
const { resolveVariants } = require('./form-menu-source');

const SCHEMA_VERSION = 2;

// TYPED failures. The message still carries the detail a human needs, but `code` is what a caller
// branches on — a resolver deciding between "serve the fallback" and "alarm" must not have to
// pattern-match prose that any edit to this file could reword.
//
// `reader: true` MARKS the error as one this module typed. That marker, not the presence of a
// `code`, is what `coded()` below tests — because plenty of errors arrive already carrying a `code`
// that means something else entirely (a Firestore rejection has one), and treating those as
// already-typed would hand the caller a foreign vocabulary while looking exactly like success.
function fail(code, detail) {
  const e = new Error(`${code}: ${detail}`);
  e.code = code;
  e.reader = true;
  throw e;
}

// 🔴 EVERY FAILURE THAT LEAVES THIS MODULE CARRIES ONE OF OUR CODES.
//
// The fail() calls below are only the failures this module authors. The rest come from places that
// are deliberately NOT ours to change: assertComplete is shared with the money reader and must stay
// byte-identical for it, getActiveVersionId is the one pointer definition both readers use, and a
// dropped connection comes from the SDK. Those threw plain Errors, so `no fallback, and here is
// why` quietly became `no fallback, and here is a sentence` — a count mismatch arrived with
// code === undefined.
//
// So the typing happens at THIS boundary, over whole calls, rather than being bolted onto the two
// spots that happened to be noticed. Deny-by-default: anything not marked as ours is re-tagged,
// whatever it already carried, with the foreign code kept as `cause_code` for the log.
async function coded(code, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e && typeof e === 'object' && e.reader) throw e;        // already typed by us — keep the specific code
    const foreign = (e && typeof e === 'object') ? e.code : undefined;
    // Tag in place when we can, and VERIFY the tag took. A frozen or sealed error refuses the
    // assignment, and a thrown string or number has nowhere to put it — both would otherwise leave
    // untyped through the one path built to guarantee everything is typed. So the tag is read back,
    // and anything that could not carry it is replaced by an error that can.
    let tagged = false;
    if (e && typeof e === 'object') {
      try {
        if (foreign !== undefined) e.cause_code = foreign;
        e.code = code;
        e.reader = true;
        tagged = e.code === code && e.reader === true;
      } catch (_) { tagged = false; }
    }
    if (tagged) throw e;
    const wrapped = new Error(`${code}: ${String((e && e.message) || e)}`);
    wrapped.code = code;
    wrapped.reader = true;
    wrapped.cause = e;
    if (foreign !== undefined) wrapped.cause_code = foreign;
    throw wrapped;
  }
}

// ONE bijection rule, asked twice. item_order and extra_order make the same promise — every record
// named exactly once, nothing named that does not exist, nothing existing that is not named — and
// writing it twice would be two rules that drift, with the extras copy (the newer, less-exercised
// one) the likelier to rot. Three legs, because any two of them pass on a set that is wrong.
function assertBijection(order, byKey, what, where) {
  if (!Array.isArray(order) || order.length === 0) fail('menu_structure_bad', `${where} — ${what} missing/empty`);
  if (new Set(order).size !== order.length) fail('menu_structure_bad', `${where} — ${what} has duplicate keys`);
  for (const k of order) if (!byKey.has(k)) fail('menu_structure_bad', `${where} — ${what} references missing record ${k}`);
  if (order.length !== byKey.size) fail('menu_structure_bad', `${where} — ${what} covers ${order.length} of ${byKey.size} records`);
}

// A priced, named record — the shape both items and extras take. Every rule here is the reader's
// half of one the validator already enforces at publish; re-checking on READ is deliberate, because
// what is served is what came back from Firestore, not what was once submitted.
function mapRecords(snap, kind, where) {
  const seen = new Set();
  return snap.docs.map((d) => {
    const v = d.data() || {};
    if (typeof v.key !== 'string' || !v.key) fail('catalog_bad_doc', `${where}/${d.id} — ${kind} has a missing/non-string key`);
    if (seen.has(v.key)) fail('catalog_dup_key', `${where}/${v.key}`);
    seen.add(v.key);
    if (!Number.isInteger(v.price) || v.price <= 0) fail('catalog_bad_doc', `${where}/${v.key} — ${kind} price is not a positive integer`);
    if (!v.display || typeof v.display !== 'object' || Array.isArray(v.display)) fail('catalog_missing_display', `${where}/${v.key}`);
    // 🔴 THE TWO PRICES MUST AGREE. `price` is what the customer is CHARGED; `display.price` is what
    // they are SHOWN. They live in different namespaces and nothing structural keeps them equal, so a
    // version where they disagree is one where the menu lies about its own prices — checked by key
    // presence, so a record that dropped the shown price is caught rather than read as "no opinion".
    if (!Object.prototype.hasOwnProperty.call(v.display, 'price')) {
      fail('catalog_display_price_missing', `${where}/${v.key} — ${kind} display record carries no price`);
    }
    if (v.display.price !== v.price) {
      fail('catalog_price_disagreement', `${where}/${v.key} — ${kind} is charged ${v.price} and shown ${v.display.price}`);
    }
    const rec = { key: v.key, price: v.price, display: v.display };
    if (v.has_photo !== undefined) rec.has_photo = v.has_photo;
    return rec;
  });
}

// The complete payload from a snapshot triple. `where` tags every error with the flat rid or the
// version path, so a failure names which menu could not be served.
function buildMenu(items, extras, structureSnap, where) {
  if (items.empty) fail('catalog_empty', where);
  if (!structureSnap.exists) fail('menu_structure_missing', where);
  const structure = structureSnap.data() || {};
  const itemRecords = mapRecords(items, 'item', where);
  const extraRecords = mapRecords(extras, 'extra', where);
  const byItem = new Map(itemRecords.map((r) => [r.key, r]));
  const byExtra = new Map(extraRecords.map((r) => [r.key, r]));
  assertBijection(structure.item_order, byItem, 'item_order', where);
  // extra_order is NOT conditional on there being extras: a menu whose options lost their ordering
  // reads back as a menu whose options are in whatever order Firestore hashed them into.
  if (extraRecords.length > 0) assertBijection(structure.extra_order, byExtra, 'extra_order', where);
  const ordered = {
    items: structure.item_order.map((k) => byItem.get(k)),
    extras: extraRecords.length > 0 ? structure.extra_order.map((k) => byExtra.get(k)) : [],
    structure,
  };
  // Variants come from the SAME resolver the bundle generator uses, so a version cannot read back
  // one starting price and generate another.
  ordered.variants = resolveVariants(ordered.items, structure);
  ordered.records = itemRecords;
  ordered.extraRecords = extraRecords;
  return ordered;
}

// ── A specific IMMUTABLE version. NEVER falls back to the active pointer or the flat layout ───────
// Asking for version V means version V or an error. Substituting anything else would answer a
// question about provenance with data that has none.
async function readVersionMenu(db, restaurantId, versionId) {
  return coded('catalog_read_failed', async () => {
    if (typeof versionId !== 'string' || !versionId) fail('version_id_required', `${restaurantId}`);
    const vref = db.collection('restaurants').doc(restaurantId).collection('versions').doc(versionId);
    const [recSnap, items, structureSnap, extras] = await Promise.all([
      vref.get(), vref.collection('menu_items').get(), vref.collection('meta').doc('menu_structure').get(), vref.collection('extras').get(),
    ]);
    if (!recSnap.exists) fail('version_missing', `${restaurantId}/${versionId}`);
    const where = `${restaurantId}/versions/${versionId}`;
    const record = recSnap.data() || {};
    const built = buildMenu(items, extras, structureSnap, where);

    // Completeness-on-read for the MONEY fields (counts + both full price hashes) — the same
    // descriptor the pricing reader verifies, shared so the two can never drift. Its errors are
    // re-tagged rather than rewritten: the money path depends on those exact messages.
    const menuTable = {}; for (const r of built.records) menuTable[r.key] = r.price;
    const { extras: extraTable } = buildTablesFromDocs([], built.extraRecords.map((r) => ({ key: r.key, price: r.price })));
    await coded('catalog_incomplete', () => assertComplete(record, menuTable, extraTable, where));

    const identity = versionIdentity(restaurantId, versionId, record, built);
    return { items: built.items, extras: built.extras, variants: built.variants, structure: built.structure, identity };
  });
}

// The version's own account of itself, checked against the version it was read from. Each field is
// required: an identity with holes in it is the thing 1B/1C would have to trust.
function versionIdentity(restaurantId, versionId, record, built) {
  const where = `${restaurantId}/versions/${versionId}`;
  // A record whose `version` field names a DIFFERENT version was copied, not published — the docs
  // under this id and the identity it claims are from two different menus.
  if (record.version !== versionId) {
    fail('version_identity_mismatch', `${where} — the record calls itself ${JSON.stringify(record.version)}`);
  }
  if (record.schema_version !== SCHEMA_VERSION) {
    fail('version_schema_unsupported', `${where} — schema_version ${JSON.stringify(record.schema_version)}, expected ${SCHEMA_VERSION}`);
  }
  // The ORDINAL. 2b's read-side ladder measures staleness in versions, and it treats an absent
  // ordinal as too-stale rather than as distance zero; a display read has the same need and no
  // reason to be laxer about it.
  if (!Number.isInteger(record.seq)) fail('version_seq_missing', `${where} — seq ${JSON.stringify(record.seq)} is not an integer`);
  const got = contentHash({
    rid: restaurantId, schema_version: SCHEMA_VERSION,
    items: built.items, extras: built.extras, structure: built.structure,
  });
  // Pinned by the publisher over what it WROTE, recomputed here over what came BACK. The money
  // descriptor already covers prices; this is what covers everything else a customer sees.
  if (typeof record.content_hash !== 'string' || !record.content_hash) {
    fail('version_content_hash_missing', `${where} — the version record pins no content hash`);
  }
  if (got !== record.content_hash) {
    fail('catalog_content_mismatch', `${where} — read ${got.slice(0, 12)} != record ${record.content_hash.slice(0, 12)}`);
  }
  return { rid: restaurantId, schema_version: SCHEMA_VERSION, version_id: versionId, seq: record.seq, content_hash: got };
}

// ── The FLAT layout — bootstrap/pre-migration only, and DELIBERATELY IDENTITY-LESS ────────────────
// Returned without an `identity` on purpose. The flat layout is mutable in place and has no version
// id, no ordinal and no pinned hash, so any identity offered for it would be invented. Callers that
// need provenance must read a version; callers that only need the records can call this by name.
async function readFlatMenu(db, restaurantId) {
  return coded('catalog_read_failed', async () => {
    const rref = db.collection('restaurants').doc(restaurantId);
    const [profile, items, structureSnap, extras] = await Promise.all([
      rref.get(), rref.collection('menu_items').get(), rref.collection('meta').doc('menu_structure').get(), rref.collection('extras').get(),
    ]);
    if (!profile.exists) fail('restaurant_not_found', restaurantId);
    const built = buildMenu(items, extras, structureSnap, restaurantId);
    return { items: built.items, extras: built.extras, variants: built.variants, structure: built.structure };
  });
}

// THE reader. Resolves the active pointer and reads THAT version — or fails closed.
async function getRestaurantMenu(db, restaurantId) {
  // A malformed pointer and a failed pointer read are ONE answer to the caller — this restaurant
  // cannot be served — and neither arrives typed from the shared resolver, so both are tagged here.
  // The distinction that matters for alarming survives verbatim in the message.
  const versionId = await coded('active_version_unreadable', () => getActiveVersionId(db, restaurantId));
  if (versionId == null) {
    // 🔴 NO FLAT FALLBACK. This used to fall through to the flat layout on a clean pointer-absent,
    // which meant an un-migrated (or mid-migration, or accidentally-deleted-pointer) restaurant
    // served a menu whose identity nobody could state. The caller is told exactly what is missing.
    fail('active_version_absent', `${restaurantId} — the display reader serves immutable versions only; there is no flat fallback`);
  }
  return readVersionMenu(db, restaurantId, versionId);
}

module.exports = { getRestaurantMenu, readVersionMenu, readFlatMenu, versionIdentity, SCHEMA_VERSION };
