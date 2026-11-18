'use strict';
// PLAN-3a-addr r0 S-ADDR-2 (advisor APPROVED 2026-11-13) — useMyAddress: the capp «Direcciones» «en uso» selection, PERSISTED as
// user_profiles/{uid}/default_address (advisor Q1).
//   POST ?context=platform   header x-firebase-id-token (never a URL or body token — rule 20)
//        body EXACTLY { id: a_[a-f0-9]{6,32}, expected_rev: safe integer ≥ 0, expected_default: an address id | null }
//        → 200 { ok, default_address: id, default_address_rev } | 409 stale_address { default_address, default_address_rev }
//          | 400 bad_request | 401 unauthenticated | 403 deleted | 404 not_found | 405 | 429 | 503
// PLAN-3a-addr-rev r0 (advisor GO 2026-11-18): a REVISION CAS — default_address_rev (address-book.revOf: absent/malformed ⇒ 0) must
// equal expected_rev, else 409 stale_address with the PROJECTED current selection + rev and NOTHING written; an accepted write mints
// rev + 1. So an older write landing late never overwrites its successor. Refusal order: 401 → 429 → 403 → 409 → 404. A lost-reply
// resend sees 409 with its own id at expected_rev + 1 (the client counts that as success).
// r1 (advisor GO, Option B — rule 6b: no known gap accepted): the CAS ALSO compares the selection — expected_default (what the client
// last saw: getMyProfile, a 200 or a 409) must equal the PROJECTED current default_address (address-book.projectBook: the value
// getMyProfile serves, so a malformed stored default never locks a client out). The frozen forms' saveAddress / deleteAddress change
// default_address without the rev; this half refuses an older write over such a change, the no-rev window included. A → B → A back to
// the client's own view is accepted (nothing newer is lost); a content edit of the selected entry is not a selection change.
// MEMBER-ONLY through member-auth (customer, never handheld; the three tombstones) — checked BEFORE the write. A uid or any address
// content is never accepted: the server only SELECTS an entry the member's own book already holds.
// The write is ONE PARENT transaction on user_profiles/{uid} (loginTouch / sweepClaim's lifecycle node, so they linearize):
//   · a COLD null returns null — RTDB commits it ONLY if the server is null too (then nothing is written), else re-runs with the real
//     node; so a purged profile (account-lib nulls the whole node) is never resurrected, and a cold first run never aborts;
//   · deleting_at OBSERVED ⇒ abort ⇒ 403 (the sweep's claim won);
//   · the stored rev ≠ expected_rev, or the projected default ≠ expected_default ⇒ abort ⇒ 409 (the current selection captured
//     from THIS run's node);
//   · the entry missing, or off the RULES' shape (address-book.isValidEntry — never repaired) ⇒ abort ⇒ 404;
//   · else default_address = id, default_address_rev = rev + 1 and addresses[id].last_used_at = now — nothing else; every other
//     byte of the profile is kept.
// Owner-only PII: nothing here logs an address field.
const MA = require('./member-auth');
const AB = require('./address-book');

const RATE = Object.freeze({ windowMs: 10 * 60 * 1000, max: 60 });   // the write tier (setFavorite's); an EXPLICIT limiter policy
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// the parent-transaction updater. out.outcome ∈ used | absent | fenced | stale | not_found; out.current (stale) / out.rev (used)
function useUpdater({ id, expectedRev, expectedDefault, now }, out) {
  return (cur) => {
    out.current = null; out.rev = null;
    if (cur === null) { out.outcome = 'absent'; return null; }
    if (!isObj(cur)) { out.outcome = 'absent'; return undefined; }
    if (cur.deleting_at != null) { out.outcome = 'fenced'; return undefined; }
    const p = AB.projectBook(cur);
    const rev = p.default_address_rev;
    if (rev !== expectedRev || p.default_address !== expectedDefault) {
      out.outcome = 'stale'; out.current = { default_address: p.default_address, default_address_rev: rev };
      return undefined;
    }
    const book = isObj(cur.addresses) ? cur.addresses : {};
    if (!AB.isValidEntry(id, book[id])) { out.outcome = 'not_found'; return undefined; }
    out.outcome = 'used'; out.rev = rev + 1;
    return { ...cur, default_address: id, default_address_rev: rev + 1, addresses: { ...book, [id]: { ...book[id], last_used_at: now } } };
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
        || !isObj(b) || Object.keys(b).length !== 3 || typeof b.id !== 'string' || !AB.ADDR_ID_RE.test(b.id)
        || !Number.isSafeInteger(b.expected_rev) || b.expected_rev < 0
        || !('expected_default' in b) || !(b.expected_default === null || (typeof b.expected_default === 'string' && AB.ADDR_ID_RE.test(b.expected_default)))) return res.status(400).json({ ok: false, reason: 'bad_request' });
      const uid = await MA.verifiedMemberUid(typeof req.get === 'function' ? req.get('x-firebase-id-token') : null, (t) => getAuth().verifyIdToken(t));
      if (!uid) return res.status(401).json({ ok: false, reason: 'unauthenticated' });
      const db = getDatabase();
      const rl = await checkRateLimit(db, 'use_address', uid, RATE);
      if (!rl || rl.allowed !== true) { res.set('Retry-After', String((rl && rl.retryAfterSec) || 60)); return res.status(429).json({ ok: false, reason: 'rate_limited' }); }
      if (await MA.isMemberTombstoned(db, uid)) return res.status(403).json({ ok: false, reason: 'deleted' });
      const out = {};
      await db.ref(`user_profiles/${uid}`).transaction(useUpdater({ id: b.id, expectedRev: b.expected_rev, expectedDefault: b.expected_default, now: now() }, out));
      if (out.outcome === 'fenced') return res.status(403).json({ ok: false, reason: 'deleted' });
      if (out.outcome === 'stale') return res.status(409).json({ ok: false, reason: 'stale_address', ...out.current });
      if (out.outcome !== 'used') return res.status(404).json({ ok: false, reason: 'not_found' });
      return res.status(200).json({ ok: true, default_address: b.id, default_address_rev: out.rev });
    } catch (e) {
      console.error('useMyAddress', e && e.code ? e.code : 'error');
      return res.status(503).json({ ok: false, reason: 'unavailable', retryable: true });
    }
  }
  return { useMyAddress };
}

module.exports = { makeMyAddress, useUpdater, RATE };
