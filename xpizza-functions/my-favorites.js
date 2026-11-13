'use strict';
// PLAN-3a-capp-member-reads r4 (APPROVED) — (1) the member's FAVORITES and recent restaurants, for the capp's hearts and «Para vos».
//   GET  getMyFavorites ?context=platform                     header x-firebase-id-token (never a URL or body token — rule 20)
//        → 200 { ok, favorites: [rid…] (newest first, ≤ FAV_MAX), more, recent: [{ rid, last_at }…] (≤ RECENT_ROWS) }
//   POST setFavorite { context: 'platform', rid, on: boolean } header x-firebase-id-token
//        → 200 { ok, on } (idempotent) | 404 unknown_restaurant (on only) | 409 too_many (on only)
//   both → 400 bad_request | 401 unauthenticated | 403 deleted | 405 | 429 rate_limited (+ Retry-After) | 503 unavailable
// MEMBER-ONLY through member-auth (a customer token, never a handheld; none of the three tombstones) — checked BEFORE any favorites
// read or write. That entry check is also the guard for accounts deleted before the fence shipped (no `_deleted` on their node).
// WRITES ARE SERVER-ONLY (rules: user_favorites/$uid .write false) and every one is a PARENT transaction on user_favorites/{uid}:
//   · the deletion FENCE (R3.1): deleteAccountCore's one atomic update replaces the node with { _deleted: at }; an OBSERVED fence
//     aborts every write (403), so no favorite can outlive the account — no journal, no drain, no timeout-based closure;
//   · a COLD null (R4.1) never aborts: `on` returns { [rid]: {createdAt} } and `off` returns null — RTDB commits either ONLY if the
//     server is null too, else it re-runs the updater with the real node;
//   · the cap is exact: a bounded pre-check (one orderByChild(createdAt).limitToLast(FAV_MAX + 1) — never the whole node) refuses a
//     full or legacy-oversized node, then the transaction re-counts.
// Identity (restaurants/{rid}/identity exists) is checked on ADD only: a removed restaurant's favorite is always removable.
// recent = ONE orderByChild('ts').limitToLast(RECENT_ROWS) on user_orders/{uid} (a ROW-COUNT budget, R4.2): distinct rids, newest
// first, cancelled skipped; rids and dates only.
const MA = require('./member-auth');
const { RID_RE } = require('./platform-manifest');

const FAV_MAX = 50;
const RECENT_ROWS = 10;
const FENCE = '_deleted';
const RATE_READ = Object.freeze({ windowMs: 60 * 1000, max: 60 });         // an EXPLICIT limiter policy (checkRateLimit fails OPEN without one)
const RATE_WRITE = Object.freeze({ windowMs: 10 * 60 * 1000, max: 60 });
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const ridKeys = (node) => Object.keys(isObj(node) ? node : {}).filter((k) => k !== FENCE && RID_RE.test(k));

// the parent-transaction updater. out.outcome ∈ added | kept | removed | absent | fenced | too_many
function favUpdater({ op, rid, now }, out) {
  return (cur) => {
    if (cur === null) { out.outcome = op === 'on' ? 'added' : 'absent'; return op === 'on' ? { [rid]: { createdAt: now } } : null; }
    const p = isObj(cur) ? cur : {};
    if (p[FENCE] != null) { out.outcome = 'fenced'; return undefined; }
    if (op === 'on') {
      if (p[rid]) { out.outcome = 'kept'; return undefined; }
      if (ridKeys(p).length >= FAV_MAX) { out.outcome = 'too_many'; return undefined; }
      out.outcome = 'added';
      return { ...p, [rid]: { createdAt: now } };
    }
    if (!p[rid]) { out.outcome = 'absent'; return undefined; }
    const rest = { ...p }; delete rest[rid];
    out.outcome = 'removed';
    return Object.keys(rest).length ? rest : null;
  };
}

const hasBody = (req) => {
  const b = req.body;
  return (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 0) || (b != null && (typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length > 0));
};

function makeMyFavorites({ getDatabase, getAuth, checkRateLimit, now = () => Date.now() }) {
  const verify = (t) => getAuth().verifyIdToken(t);
  // → { uid, db } | { status, body } (headers set on res)
  async function admit(req, res, bucket, policy) {
    const uid = await MA.verifiedMemberUid(typeof req.get === 'function' ? req.get('x-firebase-id-token') : null, verify);
    if (!uid) return { status: 401, body: { ok: false, reason: 'unauthenticated' } };
    const db = getDatabase();
    const rl = await checkRateLimit(db, bucket, uid, policy);
    if (!rl || rl.allowed !== true) { res.set('Retry-After', String((rl && rl.retryAfterSec) || 60)); return { status: 429, body: { ok: false, reason: 'rate_limited' } }; }
    if (await MA.isMemberTombstoned(db, uid)) return { status: 403, body: { ok: false, reason: 'deleted' } };
    return { uid, db };
  }
  const bounded = (db, uid) => db.ref(`user_favorites/${uid}`).orderByChild('createdAt').limitToLast(FAV_MAX + 1).once('value');

  async function getMyFavorites(req, res) {
    res.set('Cache-Control', 'no-store');
    try {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
      const q = isObj(req.query) ? req.query : {};
      if (q.context !== 'platform' || Object.keys(q).some((k) => k !== 'context') || hasBody(req)) return res.status(400).json({ ok: false, reason: 'bad_request' });
      const a = await admit(req, res, 'get_my_favorites', RATE_READ);
      if (!a.uid) return res.status(a.status).json(a.body);
      const [favSnap, histSnap] = await Promise.all([bounded(a.db, a.uid), a.db.ref(`user_orders/${a.uid}`).orderByChild('ts').limitToLast(RECENT_ROWS).once('value')]);
      const favs = [];
      favSnap.forEach((c) => { if (c.key !== FENCE && RID_RE.test(c.key)) favs.push(c.key); });
      favs.reverse();   // the query ascends by createdAt; newest first
      const seen = new Set(); const recent = []; const rows = [];
      histSnap.forEach((c) => { rows.push(c.val()); });
      for (const e of rows.reverse()) {
        if (!isObj(e) || e.status === 'cancelled' || typeof e.restaurant !== 'string' || !RID_RE.test(e.restaurant) || !Number.isFinite(e.ts) || seen.has(e.restaurant)) continue;
        seen.add(e.restaurant); recent.push({ rid: e.restaurant, last_at: e.ts });
      }
      return res.status(200).json({ ok: true, favorites: favs.slice(0, FAV_MAX), more: favs.length > FAV_MAX, recent });
    } catch (e) {
      console.error('getMyFavorites', e && e.code ? e.code : 'error');
      return res.status(503).json({ ok: false, reason: 'unavailable', retryable: true });
    }
  }

  async function setFavorite(req, res) {
    res.set('Cache-Control', 'no-store');
    try {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
      const b = req.body;
      if (!isObj(b) || Object.keys(b).some((k) => !['context', 'rid', 'on'].includes(k)) || b.context !== 'platform'
        || typeof b.rid !== 'string' || !RID_RE.test(b.rid) || typeof b.on !== 'boolean') return res.status(400).json({ ok: false, reason: 'bad_request' });
      const a = await admit(req, res, 'set_favorite', RATE_WRITE);
      if (!a.uid) return res.status(a.status).json(a.body);
      const { db, uid } = a; const rid = b.rid; const op = b.on ? 'on' : 'off';
      if (op === 'on') {
        // a LEAF read (advisor 11-13): identity/name is required of every routable restaurant (restaurant-config isRoutingValid; activation
        // via brand-model validateBranchIdentity; rules .validate) — never the whole identity node (it carries hours)
        const nm = (await db.ref(`restaurants/${rid}/identity/name`).once('value')).val();
        if (!(typeof nm === 'string' && nm.length > 0)) return res.status(404).json({ ok: false, reason: 'unknown_restaurant' });
        const pre = await bounded(db, uid); let count = 0; let has = false;
        pre.forEach((c) => { if (c.key === FENCE) return; if (RID_RE.test(c.key)) count += 1; if (c.key === rid) has = true; });
        // an OVERSIZED node (> FAV_MAX: a legacy owner-direct write) is refused BEFORE the parent transaction, even for a favorite it
        // already holds (Codex build r1 P2: `has` must not exempt it — the transaction would download every child); at exactly FAV_MAX an
        // `on` of a held favorite stays an idempotent 200
        if (count > FAV_MAX || (!has && count >= FAV_MAX)) return res.status(409).json({ ok: false, reason: 'too_many' });
      }
      const out = {};
      await db.ref(`user_favorites/${uid}`).transaction(favUpdater({ op, rid, now: now() }, out));
      if (out.outcome === 'fenced') return res.status(403).json({ ok: false, reason: 'deleted' });
      if (out.outcome === 'too_many') return res.status(409).json({ ok: false, reason: 'too_many' });
      return res.status(200).json({ ok: true, on: b.on });
    } catch (e) {
      console.error('setFavorite', e && e.code ? e.code : 'error');
      return res.status(503).json({ ok: false, reason: 'unavailable', retryable: true });
    }
  }

  return { getMyFavorites, setFavorite };
}

module.exports = { makeMyFavorites, favUpdater, FAV_MAX, RECENT_ROWS, FENCE, RATE_READ, RATE_WRITE };
