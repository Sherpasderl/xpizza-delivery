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
async function ensureIdentity(db, { rid, kind, legacyKey, now = null, shouldStop = null }) {
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

    /* ── 1D D4 — ADOPT AN ORPHANED LIVE ID RATHER THAN MINTING A DUPLICATE ───────────────────
       🔴 THE DUPLICATE-ID BUG, CLOSED AT THE WRITER. We only reach this point because the key row is
       missing. That does NOT mean the object has no id: the reverse row can be gone while the id row
       survives — retirement deletes the key row, a partial write loses it, a sweep repairs half. In
       that state x_pizza MINTS A SECOND LIVE ID for one object, because proposeId returns a random
       token and nothing looks for the one already there. Two live ids for one dish is split identity:
       orders written either side of the mint disagree about what they were, permanently.
       So before minting, ask whether a live id already claims this key. The query runs inside the same
       transaction that serializes on the key row, so two racing ensureIdentity calls converge on one
       adoption rather than one adopting and one minting.
       🔴 IT ADOPTS, IT DOES NOT ARBITRATE. A retired id is never revived — the reservation exists
       precisely so a freed id cannot be handed out again. And two LIVE ids already claiming one key is
       a corruption this function must not silently pick a winner for: picking would make the loser's
       historical orders unresolvable and would hide the corruption. It refuses and reports. */
    const orphan = await findOrphanedLiveId(tx, db, rid, kind, legacyKey);
    if (orphan) {
      tx.set(keyRef, { canonical_id: orphan, kind, created_at: stamp, adopted_at: stamp });
      return { canonical_id: orphan, created: false, adopted: true };
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

    /* 🔴 THE LAST INSTANT BEFORE A WRITE, AND THE ONLY PLACE ABANDONMENT CAN ACTUALLY HAPPEN. The
       caller's deadline previously stopped the LOOP from starting new transactions, which left the one
       already in flight to finish and write whenever its store came back — so a publish could report
       identity_preserve_timeout and then land rows anyway, minutes later. Checking before the loop is
       not enough: by then this transaction has already begun.
       Here, after every read and before the first write, abandonment is genuinely free — throwing
       aborts the transaction and Firestore commits nothing, so the deadline means exactly what the
       publish hook says it means: after it fires, no registry row appears. The object simply stays
       unregistered and the next publish or backfill picks it up, which is the designed fallback. */
    if (typeof shouldStop === 'function' && shouldStop()) {
      throw new Error(`identity_abandoned: ${rid}/${kind}/${legacyKey} — the caller's deadline passed before this transaction wrote`);
    }

    tx.set(idsColOf(db, rid, kind).doc(canonicalId), {
      legacy_key: legacyKey, status: STATUS_LIVE, created_at: stamp, kind,
    });
    tx.set(keyRef, { canonical_id: canonicalId, kind, created_at: stamp });
    return { canonical_id: canonicalId, created: true };
  });
}

/* ── 1D D4-grace — THE FORWARD RESOLVER (id → legacy key) ─────────────────────────────────────
   D1's lookupByLegacyKeys reads the REVERSE index: given a key, which id does the registry hold. D3
   uses it to check a claim. This reads the PRIMARY direction — given an id, which object does the
   registry say it is — and that is the direction an eventual enforce would key by. Exercising it now,
   under grace, is the point: the resolver and its wiring get proven on live traffic while a
   disagreement is still harmless, instead of the first time it decides a price.

   🔴 THREE OUTCOMES, AND THE THIRD IS THE ONE THAT MATTERS. `resolved` and `unresolved` are both
   ANSWERS — the id maps to a live object, or it definitely does not (absent doc, retired, malformed).
   `read_error` is the absence of an answer: Firestore threw, timed out, or the budget ran out. Under
   grace all three fall back to the legacy key, so collapsing them changes nothing today — which is
   exactly why it must not be collapsed today. Under enforce, `unresolved` refuses an order and
   `read_error` must NOT, or a transient Firestore hiccup starts rejecting paid carts. The distinction
   has to be built and tested while it is free.

   Never throws: a resolver that can fail a charge is worse than one that resolves nothing. */
const RESOLVE_TIMEOUT_MS = 800;        // its own deadline, unrelated to the pricing reader's
const RESOLVE_CACHE_TTL_MS = 60000;    // status is MUTABLE (retirement), so it cannot inherit the immutable-version TTL
const RESOLVE_CACHE_MAX = 500;
const RESOLVE_MAX_LOOKUPS = 40;        // comfortably above a real cart; the cap is what bounds load
const RESOLVE_CONCURRENCY = 8;

const _resolveCache = new Map();       // `${rid}/${kind}/${id}` -> { outcome, legacyKey, readStartedAt }

/* 🔴 SHAPE VALIDATION, NOT ALPHABET VALIDATION. x_pizza mints a token from a fixed alphabet, but
   la_musa GRANDFATHERS its slug — `dimsum_01` is a perfectly valid canonical id — so checking the
   minted alphabet here would classify every la_musa id as invalid and quietly turn the whole brand
   into `unresolved`. What can actually be validated is what Firestore requires of a document id, which
   is the read this is about to perform. An id failing this is a CLEAN unresolved and costs no read. */
function validIdShape(id) {
  if (typeof id !== 'string' || !id) return false;
  if (id.length > 200) return false;
  if (id.indexOf('/') !== -1) return false;
  if (id === '.' || id === '..') return false;
  if (/^__.*__$/.test(id)) return false;          // Firestore reserves __*__ ids
  return true;
}

function cacheGet(key, nowMs) {
  const hit = _resolveCache.get(key);
  if (!hit) return null;
  /* 🔴 EXPIRY IS MEASURED FROM THE READ'S START, NOT FROM WHEN IT WAS CACHED. Anchoring at write time
     does not bound staleness at all: a read can observe `live`, the retirement can commit while that
     read is still in flight, and the read can then land before its deadline and cache `live` for
     another full TTL — total staleness TTL + latency, and worse the slower the read. Stamping the
     entry with the instant the read STARTED caps it at the TTL no matter how long the read took.
     An expired entry is dropped, never served. */
  if (nowMs - hit.readStartedAt > RESOLVE_CACHE_TTL_MS) { _resolveCache.delete(key); return null; }
  return hit;
}

function cacheSet(key, value) {
  // read_error is NEVER cached — see the note at its call site.
  if (_resolveCache.size >= RESOLVE_CACHE_MAX) {
    const oldest = _resolveCache.keys().next();
    if (!oldest.done) _resolveCache.delete(oldest.value);
  }
  _resolveCache.set(key, value);
}

async function resolveLegacyByIds(fs, rid, kind, ids, opts = {}) {
  const {
    timeoutMs = RESOLVE_TIMEOUT_MS,
    maxLookups = RESOLVE_MAX_LOOKUPS,
    concurrency = RESOLVE_CONCURRENCY,
    now = Date.now,
  } = opts;
  const byId = new Map();
  let incomplete = false;
  try {
    assertKind(kind);
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => x !== undefined && x !== null))];
    if (!wanted.length) return { byId, incomplete: false };

    const toRead = [];
    for (const id of wanted) {
      if (!validIdShape(id)) { byId.set(id, { outcome: 'unresolved', reason: 'invalid_id' }); continue; }
      const ck = `${rid}/${kind}/${id}`;
      const hit = cacheGet(ck, now());
      if (hit) { byId.set(id, { outcome: hit.outcome, legacyKey: hit.legacyKey, reason: hit.reason }); continue; }
      toRead.push(id);
    }

    /* 🔴 THE BUDGET IS WHAT ACTUALLY BOUNDS LOAD. Deduping and Promise.all-ing bounds nothing — a cart
       with two hundred distinct ids issues two hundred reads at once, on the charge path. Beyond the
       cap the remainder is treated as read_error (so it degrades to grace like any other operational
       failure) and the order's coverage is marked INCOMPLETE, so the heartbeat does not count a
       partially-resolved order as clean evidence for enforce. */
    const within = toRead.slice(0, maxLookups);
    for (const id of toRead.slice(maxLookups)) {
      byId.set(id, { outcome: 'read_error', reason: 'budget_exceeded' });
      incomplete = true;
    }

    if (within.length) {
      const startedAt = now();          // the anchor for every entry cached from this batch
      const col = idsColOf(fs, rid, kind);
      let cursor = 0;
      const worker = async () => {
        while (cursor < within.length) {
          const id = within[cursor++];
          const snap = await col.doc(id).get();
          const d = snap && snap.exists ? (snap.data() || {}) : null;
          let entry;
          if (!d) entry = { outcome: 'unresolved', reason: 'absent' };
          else if (d.status === STATUS_RETIRED) entry = { outcome: 'unresolved', reason: 'retired' };
          else if (typeof d.legacy_key !== 'string' || !d.legacy_key) entry = { outcome: 'unresolved', reason: 'no_legacy_key' };
          else entry = { outcome: 'resolved', legacyKey: d.legacy_key };
          byId.set(id, entry);
          cacheSet(`${rid}/${kind}/${id}`, { ...entry, readStartedAt: startedAt });
        }
      };
      const runners = Array.from({ length: Math.min(concurrency, within.length) }, worker);

      /* The deadline bounds when this RESULT settles. It does not cancel the reads — Firestore has no
         cancellation — so a late read finishes, harmlessly, and reports nothing: whatever it would
         have said arrives after the answer was already given, and acting on it would mean a
         post-response effect on a charge path. */
      let timer = null;
      const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve('__timeout__'), timeoutMs); });
      const outcome = await Promise.race([Promise.all(runners).then(() => '__done__'), deadline]);
      if (timer) clearTimeout(timer);
      if (outcome === '__timeout__') {
        for (const id of within) {
          if (!byId.has(id)) { byId.set(id, { outcome: 'read_error', reason: 'timeout' }); incomplete = true; }
        }
      }
    }
    return { byId, incomplete };
  } catch (e) {
    /* 🔴 A FAILURE IS read_error FOR EVERY ID IT COULD NOT ANSWER — never `unresolved`. The difference
       is invisible under grace and decisive under enforce: unresolved means "there is no such live
       object", which is grounds to refuse; read_error means "I could not find out", which never is.
       Ids already answered from cache keep their answers. */
    for (const id of (Array.isArray(ids) ? ids : [])) {
      if (!byId.has(id)) byId.set(id, { outcome: 'read_error', reason: 'exception' });
    }
    return { byId, incomplete: true };
  }
}

// Test-only: the cache is per-instance and long-lived, which a test must be able to reset.
function _resetResolveCache() { _resolveCache.clear(); }

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

/* 🔴 AN ORPHANED LIVE ID: an `ids/*` row that is live and claims this legacy key while the reverse row
   is missing. Only called when the key row is already known absent, so "claims this key and is live"
   IS the orphan condition — there is nothing else it could be.
   A QUERY rather than a doc read, because x_pizza's id is a random token: there is no id to guess. On
   la_musa the id is the slug and the mint path would find it by candidate anyway, but routing both
   brands through the same check is what stops this from being a brand-shaped fix — the third
   one-direction miss in this programme was exactly that. */
async function findOrphanedLiveId(tx, db, rid, kind, legacyKey) {
  const q = idsColOf(db, rid, kind).where('legacy_key', '==', legacyKey).where('status', '==', STATUS_LIVE);
  const snap = await tx.get(q);
  const docs = (snap && snap.docs) ? snap.docs : [];
  if (!docs.length) return null;
  if (docs.length > 1) {
    /* Refused, not arbitrated. Two live ids for one object is already corruption; choosing one makes
       every order written under the other unresolvable and removes the evidence that it happened. */
    const ids = docs.map((d) => d.id).sort().join(',');
    throw new Error(`identity_conflicting_live_ids: ${rid}/${kind}/${legacyKey} — ${ids}`);
  }
  return docs[0].id;
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
/* ── 1D D3 — THE VERDICT, AS ONE PURE FUNCTION ─────────────────────────────────────────────────
   D3 asks the same question validateClaim asks, but for a whole cart at once and through a BATCHED
   lookup — so the verdict logic would have existed twice, in two files, agreeing today. Two copies of
   a taxonomy is how a taxonomy drifts: the batched one would be updated and the single-claim one left,
   or the other way round, and the disagreement would surface as a false `swapped` on a real order.
   So the logic lives here, once, pure, and both callers reach the same verdict by construction.

   🔴 THE ABSENT PREDICATE IS PRODUCTION'S EXACT ONE: `typeof claimedId !== 'string' || !claimedId`.
   A truthy NON-STRING — 123, true, {}, [] — is absent today, and absent means "no id was carried", so
   it takes the no-read fast path and is never reported. A laxer `!claimedId` would let those through
   to be classified against the registry, where they cannot match anything, and every one would surface
   as a fabricated `unregistered_key` or `swapped` on a real customer's order. It would also diverge
   from validateClaim, which is the fake-laxer-than-production failure this build has paid for before.

   Pure and total: it performs no read. The caller decides whether a read is even needed — `absent`
   never requires one. */
function classifyClaim({ actual, claimedId }) {
  if (typeof claimedId !== 'string' || !claimedId) return { reason: 'absent' };
  if (actual === null || actual === undefined) return { reason: 'unregistered_key' };
  if (actual !== claimedId) return { reason: 'swapped' };
  return { reason: 'ok' };
}

/* 🔴 THE EXTERNAL SHAPE IS UNCHANGED, BYTE FOR BYTE. This function's four return shapes are depended
   on by existing tests and callers: `absent` carries NO `actual`, `ok` carries NO `reason`. The
   refactor moves the verdict into classifyClaim and keeps every one of those shapes exactly as it was
   — the two APIs legitimately differ, and making them uniform would be a silent contract change
   dressed up as a cleanup. */
async function validateClaim(db, { rid, kind, legacyKey, claimedId }) {
  assertKind(kind);
  // The absent fast path, still before any read — the predicate now lives in classifyClaim.
  if (classifyClaim({ actual: null, claimedId }).reason === 'absent') return { ok: false, reason: 'absent' };
  const map = await lookupByLegacyKeys(db, { rid, kind, legacyKeys: [legacyKey] });
  const actual = map.get(legacyKey) || null;
  const { reason } = classifyClaim({ actual, claimedId });
  if (reason === 'unregistered_key') return { ok: false, reason: 'unregistered_key', actual: null };
  if (reason === 'swapped') return { ok: false, reason: 'swapped', actual };
  return { ok: true, actual };
}

module.exports = {
  ensureIdentity, lookupByLegacyKeys, retireIdentity, validateClaim, classifyClaim,
  resolveLegacyByIds, validIdShape, _resetResolveCache, findOrphanedLiveId,
  RESOLVE_TIMEOUT_MS, RESOLVE_CACHE_TTL_MS, RESOLVE_MAX_LOOKUPS,
  encodeKey, randomToken, proposeId, isGrandfathered, GRANDFATHERED, idsColOf, keysColOf,
  KINDS, STATUS_LIVE, STATUS_RETIRED, ID_LEN, ALPHABET,
};
