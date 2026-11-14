'use strict';
// PLAN-3a-capp-member-reads r4 — (2) getMyLastTip: the member's LAST TIP (a UX hint for the capp's tip step, PLAN-capp-tip-step r6),
// replacing the capp's RTDB REST read `…/user_private/{uid}/last_tip.json?auth=<ID token>` — an ID token in a URL (rule 20).
//   GET ?context=platform   header x-firebase-id-token (never a URL or body token)
//   → 200 { ok, cents: int 0..CENTS_MAX | null } | 400 bad_request | 401 unauthenticated | 403 deleted | 405 | 429 | 503
// MEMBER-ONLY through member-auth (customer, never handheld; the three tombstones). ONE leaf read of the token uid's own
// user_private/{uid}/last_tip, written only by tip-pref.recordLastTip; a stored value outside the capp's bound ⇒ null. Nothing persisted.
// Completion gate (R2.6): the finding closes only when the capp's lastTip() moves to this endpoint in the SAME release.
const MA = require('./member-auth');

const CENTS_MAX = 200000;   // the capp's own bound on the hint (capp-api lastTip)
const RATE = Object.freeze({ windowMs: 60 * 1000, max: 30 });   // an EXPLICIT limiter policy (checkRateLimit fails OPEN without one)
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function makeMyLastTip({ getDatabase, getAuth, checkRateLimit }) {
  async function getMyLastTip(req, res) {
    res.set('Cache-Control', 'no-store');
    try {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
      const q = isObj(req.query) ? req.query : {};
      const b = req.body;
      const hasBody = (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 0) || (b != null && (typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length > 0));
      if (q.context !== 'platform' || Object.keys(q).some((k) => k !== 'context') || hasBody) return res.status(400).json({ ok: false, reason: 'bad_request' });
      const uid = await MA.verifiedMemberUid(typeof req.get === 'function' ? req.get('x-firebase-id-token') : null, (t) => getAuth().verifyIdToken(t));
      if (!uid) return res.status(401).json({ ok: false, reason: 'unauthenticated' });
      const db = getDatabase();
      const rl = await checkRateLimit(db, 'get_my_last_tip', uid, RATE);
      if (!rl || rl.allowed !== true) { res.set('Retry-After', String((rl && rl.retryAfterSec) || 60)); return res.status(429).json({ ok: false, reason: 'rate_limited' }); }
      if (await MA.isMemberTombstoned(db, uid)) return res.status(403).json({ ok: false, reason: 'deleted' });
      const v = (await db.ref(`user_private/${uid}/last_tip`).once('value')).val();
      const c = isObj(v) ? v.cents : undefined;
      return res.status(200).json({ ok: true, cents: Number.isSafeInteger(c) && c >= 0 && c <= CENTS_MAX ? c : null });
    } catch (e) {
      console.error('getMyLastTip', e && e.code ? e.code : 'error');
      return res.status(503).json({ ok: false, reason: 'unavailable', retryable: true });
    }
  }
  return { getMyLastTip };
}

module.exports = { makeMyLastTip, CENTS_MAX, RATE };
