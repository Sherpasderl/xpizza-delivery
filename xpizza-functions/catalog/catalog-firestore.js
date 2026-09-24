'use strict';
// Real Firestore read adapter for the catalog (the PRICING reader — MONEY). Returns the
// {itemDocs, extraDocs} shape the pure buildTablesFromDocs (catalog-transform.js) consumes. Wired into
// createCatalogReader → the 1b guarded resolver.
//
// 1c-b2 — VERSIONED PUBLISH: the reader no longer reads the flat `restaurants/{rid}/menu_items` layout
// directly. It resolves the `restaurants/{rid}/meta/active_version` POINTER, then reads the pointed
// IMMUTABLE version's docs and VERIFIES completeness (count + full menu_hash/extras_hash) BEFORE
// returning. The atomic flip of that pointer is the whole cutover; a mid-publish reader sees the OLD
// version until the flip.
//
// 🔒 POINTER-ABSENT vs ERROR — TWO DISTINCT STATES, never conflated (grill blocker #3):
//   • CLEAN pointer not-found (the doc does not exist — an un-migrated restaurant) → fall back to the
//     FLAT layout (zero-window migration). If the flat layout is ALSO absent → throw restaurant_not_found.
//   • MALFORMED pointer / read error / version missing / completeness (count/hash) mismatch → THROW.
//     The 1b resolver fail-safes the throw → code tables + alarm, never a drop, never a plausible-empty.
// The reader distinguishes a clean doc-absent (snap.exists === false) from a read ERROR (a thrown
// rejection propagates). Fail-safe: if it cannot tell, the throw wins.
//
// The TRUST BOUNDARY (Codex) is UNCHANGED from 1a/1b: malformed data must NEVER read back as a
// plausible success. Every doc is validated — non-string/missing key, duplicate key, and any price that
// isn't a POSITIVE INTEGER are rejected (a non-integer price would reach `total += menu[key]*qty` in
// 1b → {total:NaN, error:null}).
//
// Phase 1d Stage 1a tightened `>= 0` to `> 0`: a zero price is not a free item, it is a corrupt or
// fat-fingered one. Because this validation is shared by the flat layout AND a version's docs, and
// readVersionDocs runs inside publishVersion's pre-flip verify, the rule ALSO blocks the version
// pointer from ever flipping to a version containing a zero price — the guard reaches publish time
// with no separate publish-side change.
const { buildTablesFromDocs } = require('./catalog-transform');
const { assertComplete } = require('./catalog-integrity');

// Shared per-doc validation → [{key, price}]. Identical rules for the flat layout AND a version's docs.
function mapDocs(snap, where) {
  const seen = new Set();
  return snap.docs.map((d) => {
    const v = d.data() || {};
    if (typeof v.key !== 'string' || !v.key) throw new Error(`catalog_bad_doc: ${where}/${d.id} — missing/non-string key`);
    if (!Number.isInteger(v.price) || v.price <= 0) throw new Error(`catalog_bad_doc: ${where}/${v.key} — price not a positive integer`);
    if (seen.has(v.key)) throw new Error(`catalog_dup_key: ${where}/${v.key}`);
    seen.add(v.key);
    return { key: v.key, price: v.price };
  });
}

// ── The active-version POINTER (cheap read) ─────────────────────────────────────────────────────
// Returns the versionId string, or null for a CLEAN pointer-absent (→ flat fallback). Throws on a
// MALFORMED pointer. A Firestore read error rejects and propagates (never masked as "absent").
/* 🔴 1D D4-P1 — THE POINTER READ THAT ALSO CARRIES THE ACTIVATION GENERATION, captured TOGETHER.
   Every registry writer must fence on {version, generation} as a PAIR: reading them in two calls
   leaves a window where the version is from before an activation and the generation from after, and a
   fence built on a torn pair is worse than none — it reads as verified.
   It lives here, beside getActiveVersionId, because this module is the pointer's READ side.
   catalog-publish.js owns the WRITE and keeps its own private ref; publish-paths.test.js enforces that
   the write-side reference never escapes that module, which is why this does not reuse it. A pre-P1
   pointer carries no generation and reads as 0 — not an error, just the pre-cutover state. */
function activePointerRef(db, restaurantId) {
  return db.collection('restaurants').doc(restaurantId).collection('meta').doc('active_version');
}
/* 🔴 ABSENT IS PRE-P1; PRESENT-BUT-UNUSABLE IS A FAULT. These are different states and this used to
   collapse them, silently, in the direction that opens the fence:
     · a `version` that is present but not a usable string became `null` — which every caller reads as
       "nothing is published yet", so a CORRUPT pointer looked like a FRESH RESTAURANT, and a first
       publish (whose CAS expects `activeVersionId: null`) would sail past the check that exists to
       stop it overwriting a live menu;
     · a `generation` that is present but not a non-negative integer became `0` — the pre-cutover
       baseline — so a malformed fence value read as the one value every claim bound at generation 0
       compares equal to. A fence that answers "0" to garbage is a fence that opens itself, which is
       the same defect class as the pointer write that dropped the field entirely (D-1).
   🔴 AND THE TWO READERS OF THIS DOCUMENT DISAGREED. getActiveVersionId (:below) already throws
   `active_version_malformed` on exactly the bytes this function quietly turned into `null`, so the
   same pointer was a hard fault on one read path and a clean "unpublished" on the other. Whichever
   reader a caller happened to use decided whether corruption was visible.
   Absent still means pre-P1: a pointer with no generation reads 0, and no version reads null, because
   that is the genuine pre-cutover state and refusing it would refuse every un-migrated restaurant.
   🔴 THE NAME SAYS WHICH FIELD. Unifying the two readers first produced ONE reader with TWO names for
   "this pointer is unusable" — which is the same asymmetry in miniature, decided by which field
   happened to be wrong. `active_version_malformed` is the established name for an unusable version
   and two suites already alarm on it; the generation is a condition that did not exist before E-1 and
   keeps its own. One fault, one name, and the name tells an operator which field to look at. */
function pointerStateOf(data, where = '') {
  const d = data || {};
  const at = where ? `${where} — ` : '';
  const present = (v) => v !== undefined && v !== null;

  if (present(d.version) && !(typeof d.version === 'string' && d.version)) {
    throw new Error(`active_version_malformed: ${at}version is ${JSON.stringify(d.version)}; a pointer that HAS a version but not a usable one is corrupt, and reading it as "unpublished" would let a first publish overwrite a live menu`);
  }
  if (present(d.generation) && !(Number.isInteger(d.generation) && d.generation >= 0)) {
    throw new Error(`active_pointer_malformed: ${at}generation is ${JSON.stringify(d.generation)}; a fence value that is present but unusable must not read as 0, which is the value every pre-cutover claim compares equal to`);
  }
  return { version: present(d.version) ? d.version : null, generation: present(d.generation) ? d.generation : 0 };
}
/* 🔴 THE ONE PLACE A POINTER DOCUMENT IS TURNED INTO A DECISION. Both readers go through this, which
   is what E-1 set out to achieve and did not finish: the first pass fixed pointerStateOf's coercion
   but left getActiveVersionId parsing the same bytes for itself, so `{}` was "nothing published" to
   one reader and a hard fault to the other, and a generation of "0" was a fault to one and invisible
   to the other. Same document, two verdicts, decided by which function a caller happened to call.
   🔴 AN EXISTING DOCUMENT THAT NAMES NO VERSION IS A FAULT, not "nothing published yet". Only
   flipPointer writes this document and it always writes a version, so a versionless one is a partial
   write or corruption — and reading it as an empty restaurant is the same defect E-1 fixed for a
   version of the wrong TYPE: a corrupt pointer that looks like a fresh one. The ABSENT document is
   the genuine "nothing published" case, and it is the only one. */
function readPointerSnap(snap, restaurantId) {
  /* 🔴 THE SNAPSHOT REQUIREMENT IS ENFORCED, NOT ASSUMED — and it was not, which put the conflation
     this whole sequence has been closing INSIDE the guard meant to close it. `!snap.exists` is falsy
     for any plain object, so raw data read as "nothing published yet": `{}`, `{version: null}` and
     even a fully populated `{version: 'v1', generation: 9}` all came back as an absent pointer. A
     caller who reached for the raw-data habit got the most dangerous possible answer — the one a
     first publish's CAS is allowed to overwrite — from the door built to refuse it.
     The shape is checked against what a DocumentSnapshot actually guarantees: a BOOLEAN `exists` and
     a CALLABLE `data`. A plain object has neither, so it can no longer be mistaken for one. */
  if (!snap || typeof snap.exists !== 'boolean' || typeof snap.data !== 'function') {
    throw new Error(`active_pointer_not_a_snapshot: ${restaurantId} — this reader takes the pointer SNAPSHOT, not its data; it was handed ${snap === null ? 'null' : typeof snap}${snap && typeof snap === 'object' ? ` with keys [${Object.keys(snap).join(', ')}]` : ''}. Reading raw data here would report a populated pointer as "nothing published yet", which is the value a first publish is allowed to overwrite.`);
  }
  if (!snap.exists) return { version: null, generation: 0, exists: false };
  const state = pointerStateOf(snap.data(), restaurantId);
  if (state.version === null) {
    throw new Error(`active_version_malformed: ${restaurantId} — the pointer document exists but names no version; only the flip writes it and it always writes one, so this is a partial write rather than an unpublished restaurant`);
  }
  return { ...state, exists: true };
}

async function getActivePointer(db, restaurantId) {
  const { version, generation } = readPointerSnap(await activePointerRef(db, restaurantId).get(), restaurantId);
  return { version, generation };
}

/* Returns the versionId, or null for a CLEAN pointer-absent. Throws on a MALFORMED pointer — and
   "malformed" now means exactly what it means to getActivePointer, because both go through
   readPointerSnap. It used to re-implement the check here, which is how the two drifted apart:
   this one validated the version and IGNORED the generation entirely, so a pointer whose fence value
   was garbage served happily through this path while refusing through the other. */
async function getActiveVersionId(db, restaurantId) {
  const { version } = readPointerSnap(await activePointerRef(db, restaurantId).get(), restaurantId);
  return version;   // null ONLY when the document is absent
}

// ── Read a specific IMMUTABLE version's pricing docs + VERIFY completeness ───────────────────────
async function readVersionDocs(db, restaurantId, versionId) {
  const vref = db.collection('restaurants').doc(restaurantId).collection('versions').doc(versionId);
  const [recSnap, items, extras] = await Promise.all([vref.get(), vref.collection('menu_items').get(), vref.collection('extras').get()]);
  if (!recSnap.exists) throw new Error(`version_missing: ${restaurantId}/${versionId}`);
  const record = recSnap.data() || {};
  const where = `${restaurantId}/versions/${versionId}`;
  const itemDocs = mapDocs(items, where);
  const extraDocs = mapDocs(extras, where);
  // Completeness-on-read (money PIN): the read set MUST match the version-record's counts AND both full
  // hashes, or the read was torn/tampered → THROW (never serve partial). buildTablesFromDocs is the SAME
  // pure transform the pricing path uses, so the reader-side hashes are computed exactly as the publisher's.
  const { menu, extras: extraTable } = buildTablesFromDocs(itemDocs, extraDocs);
  assertComplete(record, menu, extraTable, where);
  // 2b-pre: surface the record's SEQ — the monotonic ordinal. Rollback builds its snapshot/mirror
  // payload from here, and without it a rollback would emit an ordinal-less fallback on exactly the
  // path where a coherent fallback matters most. Read-side (2b) treats an ABSENT seq as too-stale,
  // never as distance-zero, so a pre-ordinal mirror can never read as perfectly fresh.
  return { itemDocs, extraDocs, seq: record.seq };
}

// ── The FLAT layout (un-migrated restaurant) — byte-identical to the pre-1c-b2 reader ────────────
async function readFlatDocs(db, restaurantId) {
  const rref = db.collection('restaurants').doc(restaurantId);
  const [profile, items, extras] = await Promise.all([rref.get(), rref.collection('menu_items').get(), rref.collection('extras').get()]);
  if (!profile.exists) throw new Error(`restaurant_not_found: ${restaurantId}`);   // not-found ≠ empty
  if (items.empty) throw new Error(`catalog_empty: ${restaurantId}`);              // known restaurant, no menu items
  return { itemDocs: mapDocs(items, restaurantId), extraDocs: mapDocs(extras, restaurantId) };
}

// The pricing reader. Resolves the pointer, then reads+verifies the pointed version; falls back to the
// flat layout ONLY on a clean pointer-absent. Returns { versionId, itemDocs, extraDocs } — versionId is
// the immutable id served (or null when the flat layout served). Downstream (buildTablesFromDocs → the
// 1b resolver → the guard) is BYTE-UNCHANGED and ignores versionId.
async function getRestaurantDocs(db, restaurantId) {
  const versionId = await getActiveVersionId(db, restaurantId);   // throws on malformed / read error
  if (versionId == null) {
    const flat = await readFlatDocs(db, restaurantId);            // clean-absent → flat (throws if flat also absent)
    return { versionId: null, seq: null, itemDocs: flat.itemDocs, extraDocs: flat.extraDocs };   // 2b: flat layout has no version/ordinal
  }
  const { itemDocs, extraDocs, seq } = await readVersionDocs(db, restaurantId, versionId);   // throws on version-missing / completeness fail
  // 2b: `seq` rides along so the resolver can learn WHICH ordinal it served. Additive — every existing
  // consumer destructures only itemDocs/extraDocs and is byte-unchanged.
  return { versionId, seq, itemDocs, extraDocs };
}

/* 🔴 ONE INTERPRETATION SITE — BY CONVENTION, ENFORCED, BUT NOT BY CONSTRUCTION. Saying it precisely
   because the previous version of this comment claimed the stronger thing and the gate was right that
   the claim was false. A comment promising a guarantee the code does not provide is worse than no
   comment: the next reader stops looking.
   WHAT IS TRUE. pointerStateOf is private, so no caller can interpret this document's FIELDS for
   itself. readPointerSnap REFUSES anything that is not a real snapshot, so the raw-data habit cannot
   quietly succeed. Every production caller is routed through it, and pointer-state's census walks the
   tree to catch a new one.
   WHAT IS NOT TRUE. `activePointerRef` is exported and must stay: identity-bootstrap does two
   TRANSACTIONAL reads (`tx.get(activePointerRef(db, rid))` at :274 and :465) and a transactional read
   is impossible without the ref. So a determined caller can still fetch the snapshot and call
   `.data()` on it. What stops that is convention plus the census — a lint, in this codebase's own
   words — not construction. The census would also miss it if spelled differently, which is exactly
   how the flip's reader survived three rounds. */
module.exports = { activePointerRef, getActivePointer, readPointerSnap, getRestaurantDocs, getActiveVersionId, readVersionDocs, readFlatDocs, mapDocs };
