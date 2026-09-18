'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D1 — THE DURABLE TYPED IDENTITY REGISTRY.
//
// 🔴 WHAT THIS IS FOR. Today a dish IS its name (x_pizza) or its authored slug (la_musa): rename the
// dish and every reference to it — price lookup, 86 state, reward eligibility, the SAR factura line —
// silently points at nothing. This module mints a platform id that does not move when the name does,
// and records id↔legacy-key durably so the mapping survives a republish, a rollback, and a merchant
// who renames "Margherita" to "Margarita" on a Tuesday.
//
// 🔴 WHAT IT MUST NOT DO IN D1, WHICH IS ALMOST EVERYTHING. Nothing here may reach a business answer.
// Pricing, availability, rewards and the factura all continue to resolve by the LEGACY key, exactly as
// they do today, on every path including every failure path. The id is written beside the money data
// and read by nobody who decides anything. That is not timidity — it is what makes D1 revertible: if
// this module is wrong, the worst case is an id that is absent or wrong on a record nothing consults.
//
// THE REGISTRY IS THE SOURCE OF TRUTH, not the catalog. Version payloads stay id-less (rewriting
// immutable history is D4), so the served menu gets its ids by OVERLAY from here, after the version's
// hash has already been verified. That ordering is the whole safety argument: identity cannot corrupt
// a hash it is applied after.
//
// LAYOUT — both are DOCUMENT paths (even segment count), not collections:
//   restaurants/{rid}/identity/{kind}/ids/{canonical_id}   → { legacy_key, status, created_at }
//   restaurants/{rid}/identity/{kind}/keys/{encoded_key}   → { canonical_id }
// The second is not a cache of the first. It is the SERIALIZATION POINT: first-assignment transacts on
// the key document, so two concurrent seeds of the same dish contend on one row and exactly one id is
// minted. Reserving only the random id would let both win — they would be reserving different rows.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const KINDS = Object.freeze(['dish', 'extra']);
const STATUS_LIVE = 'live';
const STATUS_RETIRED = 'retired';

/* 🔴 BASE32 WITHOUT THE AMBIGUOUS GLYPHS. These ids are opaque and machine-only today, but D4 puts
   them in support conversations and log greps, and 0/O and 1/I/l are where a human transcription
   turns one dish into another. Crockford's alphabet, which drops exactly those. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_LEN = 10;

function randomToken(len = ID_LEN) {
  // crypto, not Math.random: an id that is guessable is an id that can be probed for across merchants.
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function assertKind(kind) {
  if (!KINDS.includes(kind)) throw new Error(`identity_bad_kind: ${String(kind)}`);
  return kind;
}

/* A legacy key is a dish NAME on x_pizza and an authored slug on la_musa, so it can contain anything a
   merchant can type — including '/', which would silently change the document path, and '.', which
   Firestore rejects in a document id. Encoded rather than sanitised: sanitising is lossy, and two keys
   that sanitise to the same string would collapse into one identity. */
function encodeKey(legacyKey) {
  if (typeof legacyKey !== 'string' || !legacyKey) throw new Error('identity_bad_legacy_key');
  return Buffer.from(legacyKey, 'utf8').toString('base64url');
}

const idsColOf = (db, rid, kind) => db.collection('restaurants').doc(rid).collection('identity').doc(assertKind(kind)).collection('ids');
const keysColOf = (db, rid, kind) => db.collection('restaurants').doc(rid).collection('identity').doc(assertKind(kind)).collection('keys');

/* 🔴 THE RULE: GRANDFATHER A KEY THAT IS ALREADY A STABLE NAME-INDEPENDENT SLUG; MINT WHERE THE KEY
   IS A DISPLAY NAME. Both brands reach the same invariant by different routes — la_musa's slug is
   already decoupled from the label a merchant edits, and x_pizza's minted token is decoupled from its
   mutable name. Minting a second id for an object that already has a stable one would give the
   migration two answers for one object.

   WRITTEN AS AN EXPLICIT TABLE, NOT A PREDICATE, and that is the important part. "Does this key look
   like a slug?" is a heuristic, and a heuristic here decides IDENTITY — wrong once and it is wrong
   permanently, because the id it mints is the one every later record points at. A table is auditable,
   is wrong only where someone wrote it wrong, and forces a deliberate entry when a third merchant
   arrives rather than letting them inherit whichever branch their key shape happens to fall down.
   Checked against the live tables rather than assumed: la_musa keys are rice_white / dimsum_01 on both
   kinds, x_pizza's are "Salsa Roja" / "Carnívora" on both. */
const GRANDFATHERED = Object.freeze({
  la_musa: Object.freeze(['dish', 'extra']),
});

function isGrandfathered(rid, kind) {
  const kinds = GRANDFATHERED[rid];
  return Array.isArray(kinds) && kinds.includes(kind);
}

/* A grandfathered slug becomes the object's FROZEN immutable id. The portal edits the LABEL, never the
   slug; changing a slug is an identity change (a delete + create at D4), never a silent remap — which
   is what keeps "grandfathered" from quietly meaning "name-derived". */
function proposeId(rid, kind, legacyKey) {
  if (isGrandfathered(rid, kind)) return String(legacyKey);
  return randomToken();
}

/* Assign an id to ONE legacy object, exactly once, whatever else is happening concurrently.
   Returns { canonical_id, created } — created:false means it was already there, which is the ordinary
   case on every re-run and every ordinary write. */
async function ensureIdentity(db, { rid, kind, legacyKey, now = null }) {
  assertKind(kind);
  const keyRef = keysColOf(db, rid, kind).doc(encodeKey(legacyKey));
  const stamp = now || new Date().toISOString();

  return db.runTransaction(async (tx) => {
    /* EVERY READ FIRST — a Firestore transaction refuses a read after a write. The key document is the
       contention point: both concurrent seeds read THIS row, so one of them loses and retries, and the
       retry sees the winner's id. */
    const keySnap = await tx.get(keyRef);
    if (keySnap.exists) {
      const existing = (keySnap.data() || {}).canonical_id;
      if (typeof existing === 'string' && existing) return { canonical_id: existing, created: false };
    }

    /* A fresh id must not collide with a live OR a RETIRED one. Retired ids stay reserved forever:
       a freed id handed to a new object would make old records — an order snapshot, a factura line,
       a support ticket — resolve to a dish nobody meant. Alias non-reuse is cheap to keep and
       impossible to repair after the fact. */
    let canonicalId = null;
    for (let attempt = 0; attempt < 5 && canonicalId === null; attempt += 1) {
      const candidate = proposeId(rid, kind, legacyKey);
      const idSnap = await tx.get(idsColOf(db, rid, kind).doc(candidate));
      if (!idSnap.exists) canonicalId = candidate;
      else if (isGrandfathered(rid, kind)) {
        /* The grandfathered slug is deterministic, so a collision here is not bad luck — it means this
           slug is already registered to something. Retrying would mint a random id for an object whose
           identity is supposed to BE its slug, quietly splitting the migration. Refuse instead. */
        const held = idSnap.data() || {};
        /* 🔴 PRESERVATION ONLY WHERE THE ROW IS STILL LIVE. Matching on legacy_key alone reported a
           RETIRED id back as a successfully preserved one — and retirement deletes the key row, so this
           is exactly the path a re-created object takes: the slug row is found, the legacy keys match,
           and the caller is handed an id the registry has permanently reserved against reuse. That is
           the one thing the reservation exists to prevent, returned as { created: false } — the
           quietest possible shape for it, indistinguishable from an ordinary idempotent re-run.
           For a grandfathered brand the slug IS the identity, so there is no alternative to mint: the
           only honest answer is to refuse and let a human decide whether this is a resurrection or a
           new object that needs a new slug. */
        if (held.status === STATUS_RETIRED) {
          throw new Error(`identity_slug_retired: ${rid}/${kind}/${legacyKey} — this slug is retired and permanently reserved; it cannot be re-assigned`);
        }
        if (held.legacy_key === legacyKey) return { canonical_id: candidate, created: false };
        throw new Error(`identity_slug_conflict: ${rid}/${kind}/${legacyKey} — slug already registered to a different object`);
      }
    }
    if (canonicalId === null) throw new Error(`identity_mint_exhausted: ${rid}/${kind}/${legacyKey}`);

    tx.set(idsColOf(db, rid, kind).doc(canonicalId), {
      legacy_key: legacyKey, status: STATUS_LIVE, created_at: stamp, kind,
    });
    tx.set(keyRef, { canonical_id: canonicalId, kind, created_at: stamp });
    return { canonical_id: canonicalId, created: true };
  });
}

/* The overlay's read. Batched by key, tolerant by design: an id that cannot be resolved comes back
   absent, and the caller serves the record without one. It must never throw its way into a serve. */
async function lookupByLegacyKeys(db, { rid, kind, legacyKeys }) {
  assertKind(kind);
  const wanted = [...new Set((legacyKeys || []).filter((k) => typeof k === 'string' && k))];
  const out = new Map();
  if (!wanted.length) return out;
  const col = keysColOf(db, rid, kind);
  const snaps = await Promise.all(wanted.map((k) => col.doc(encodeKey(k)).get()));
  wanted.forEach((k, i) => {
    const d = snaps[i] && snaps[i].exists ? (snaps[i].data() || {}) : null;
    if (d && typeof d.canonical_id === 'string' && d.canonical_id) out.set(k, d.canonical_id);
  });
  return out;
}

/* Retire an id without freeing it. D1 never calls this from a live path — the delete/rename machinery
   is explicitly untouched here — but the reservation it writes is what makes a future D4 rename safe,
   and the registry is the only place that reservation can live. */
async function retireIdentity(db, { rid, kind, canonicalId, now = null }) {
  assertKind(kind);
  const idRef = idsColOf(db, rid, kind).doc(canonicalId);
  const stamp = now || new Date().toISOString();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(idRef);
    if (!snap.exists) return { retired: false, reason: 'absent' };
    const d = snap.data() || {};
    if (d.status === STATUS_RETIRED) return { retired: false, reason: 'already_retired' };
    tx.set(idRef, { ...d, status: STATUS_RETIRED, retired_at: stamp });
    tx.delete(keysColOf(db, rid, kind).doc(encodeKey(d.legacy_key)));
    return { retired: true, legacy_key: d.legacy_key };
  });
}

/* 🔴 SERVER OWNS IDS. A submitted id is evidence of nothing: the portal round-trips records through a
   browser, and an id that arrives in a request may be stale, from another merchant, from the other
   kind, or edited. So a claim is only ever CHECKED against the registry, never adopted. The swap case
   is the one worth naming — two valid ids exchanged between two real objects is the shape that reads
   as legitimate to every field-level validation and is caught only by asking the registry what the
   key actually maps to. */
async function validateClaim(db, { rid, kind, legacyKey, claimedId }) {
  assertKind(kind);
  if (typeof claimedId !== 'string' || !claimedId) return { ok: false, reason: 'absent' };
  const map = await lookupByLegacyKeys(db, { rid, kind, legacyKeys: [legacyKey] });
  const actual = map.get(legacyKey) || null;
  if (actual === null) return { ok: false, reason: 'unregistered_key', actual: null };
  if (actual !== claimedId) return { ok: false, reason: 'swapped', actual };
  return { ok: true, actual };
}

module.exports = {
  ensureIdentity, lookupByLegacyKeys, retireIdentity, validateClaim,
  encodeKey, randomToken, proposeId, isGrandfathered, GRANDFATHERED, idsColOf, keysColOf,
  KINDS, STATUS_LIVE, STATUS_RETIRED, ID_LEN, ALPHABET,
};
