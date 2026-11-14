'use strict';
// PLAN-3a-addr r0 S-ADDR-2 (advisor APPROVED 2026-11-13) — useMyAddress: the capp «Direcciones» «en uso» selection, PERSISTED as
// user_profiles/{uid}/default_address (advisor Q1).
//   POST ?context=platform   header x-firebase-id-token (never a URL or body token — rule 20)   body EXACTLY { id: a_[a-f0-9]{6,32} }
//        → 200 { ok, default_address: id } | 400 bad_request | 401 unauthenticated | 403 deleted | 404 not_found | 405 | 429 | 503
// MEMBER-ONLY through member-auth (customer, never handheld; the three tombstones) — checked BEFORE the write. A uid or any address
// content is never accepted: the server only SELECTS an entry the member's own book already holds.
// The write is ONE PARENT transaction on user_profiles/{uid} (loginTouch / sweepClaim's lifecycle node, so they linearize):
//   · a COLD null returns null — RTDB commits it ONLY if the server is null too (then nothing is written), else re-runs with the real
//     node; so a purged profile (account-lib nulls the whole node) is never resurrected, and a cold first run never aborts;
//   · deleting_at OBSERVED ⇒ abort ⇒ 403 (the sweep's claim won);
//   · the entry missing, or off the RULES' shape (address-book.isValidEntry — never repaired) ⇒ abort ⇒ 404;
//   · else default_address = id and addresses[id].last_used_at = now — nothing else; every other byte of the profile is kept.
// Owner-only PII: nothing here logs an address field.
const MA = require('./member-auth');
const AB = require('./address-book');

const RATE = Object.freeze({ windowMs: 10 * 60 * 1000, max: 60 });   // the write tier (setFavorite's); an EXPLICIT limiter policy
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// the parent-transaction updater. out.outcome ∈ used | absent | fenced | not_found
function useUpdater({ id, now }, out) {
  return (cur) => {
    if (cur === null) { out.outcome = 'absent'; return null; }
    if (!isObj(cur)) { out.outcome = 'absent'; return undefined; }
    if (cur.deleting_at != null) { out.outcome = 'fenced'; return undefined; }
    const book = isObj(cur.addresses) ? cur.addresses : {};
    if (!AB.isValidEntry(id, book[id])) { out.outcome = 'not_found'; return undefined; }
    out.outcome = 'used';
    return { ...cur, default_address: id, addresses: { ...book, [id]: { ...book[id], last_used_at: now } } };
  };
}

function makeMyAddress({ getDatabase, getAuth, checkRateLimit, now = () => Date.now() }) {
  async function useMyAddress(req, res) {
    res.set('Cache-Control', 'no-store');
    try {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
      const q = isObj(req.query) ? req.query : {};
      const b = req.body;
      if (q.context !== 'platform' || Object.keys(q).some((k) => k !== 'context')
        || !isObj(b) || Object.keys(b).length !== 1 || typeof b.id !== 'string' || !AB.ADDR_ID_RE.test(b.id)) return res.status(400).json({ ok: false, reason: 'bad_request' });
      const uid = await MA.verifiedMemberUid(typeof req.get === 'function' ? req.get('x-firebase-id-token') : null, (t) => getAuth().verifyIdToken(t));
      if (!uid) return res.status(401).json({ ok: false, reason: 'unauthenticated' });
      const db = getDatabase();
      const rl = await checkRateLimit(db, 'use_address', uid, RATE);
      if (!rl || rl.allowed !== true) { res.set('Retry-After', String((rl && rl.retryAfterSec) || 60)); return res.status(429).json({ ok: false, reason: 'rate_limited' }); }
      if (await MA.isMemberTombstoned(db, uid)) return res.status(403).json({ ok: false, reason: 'deleted' });
      const out = {};
      await db.ref(`user_profiles/${uid}`).transaction(useUpdater({ id: b.id, now: now() }, out));
      if (out.outcome === 'fenced') return res.status(403).json({ ok: false, reason: 'deleted' });
      if (out.outcome !== 'used') return res.status(404).json({ ok: false, reason: 'not_found' });
      return res.status(200).json({ ok: true, default_address: b.id });
    } catch (e) {
      console.error('useMyAddress', e && e.code ? e.code : 'error');
      return res.status(503).json({ ok: false, reason: 'unavailable', retryable: true });
    }
  }
  return { useMyAddress };
}

module.exports = { makeMyAddress, useUpdater, RATE };
