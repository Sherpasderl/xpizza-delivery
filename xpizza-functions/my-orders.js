'use strict';
// NOTE-getMyOrders (D4c-grill, approved 2026-11-01) — getMyOrders: the customer app's «Pedidos» history read.
//   GET ?context=platform[&limit=N][&cursor=C]   header x-firebase-id-token (the capp transport; never a URL or body token)
//   → 200 { ok, active: [Row], past: [Row], next_cursor } | 400 bad_request | 401 unauthenticated | 403 deleted | 405 | 429
// MEMBER-ONLY: the uid comes ONLY from the verified customer token (guests have no user_orders — attribution is a no-op for
// them). ONE bounded query on user_orders/{uid} (orderByChild('ts') [.endBefore(ts, id)] .limitToLast(limit + 1), the existing
// .indexOn) and no other read but the tombstone check: no fan-out. Rules unchanged (Admin read; the node stays owner-read-only).
// Row = a WHITELIST of the stored entry; `items` + `recipe_format` (the server-authored, menu-allowlisted reorder recipe) pass
// through as stored, so 31's S-D additive price snapshot reaches the capp with no change here. active = a status outside the
// terminal set; a stale non-terminal status (status-mirror is fail-open) stays active — the stored truth (backlog: a reconciler).
const S = require('./signup-core');
const { HEAL_TERMINAL_STATUSES: TERMINAL } = require('./sweep-pending');   // {cancelled, delivered, completed} — one source

const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;   // the createOrder order_id rule
const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 50;
const QUERY_KEYS = new Set(['context', 'limit', 'cursor']);
const RATE = Object.freeze({ windowMs: 10 * 60 * 1000, max: 60 });   // per verified uid

const encodeCursor = (ts, id) => Buffer.from(JSON.stringify([ts, id])).toString('base64url');
// → { ts, id } | null. ts is a finite number or null (RTDB sorts a missing ts first); id is an order id.
function decodeCursor(c) {
  if (typeof c !== 'string' || c.length > 200 || !/^[A-Za-z0-9_-]+$/.test(c)) return null;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== 2) return null;
    const [ts, id] = v;
    if (!(ts === null || Number.isFinite(ts)) || typeof id !== 'string' || !ORDER_ID_RE.test(id)) return null;
    return { ts, id };
  } catch (_) { return null; }
}
function parseLimit(raw) {
  if (raw === undefined) return LIMIT_DEFAULT;
  if (typeof raw !== 'string' || !/^[1-9]\d{0,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= LIMIT_MAX ? n : null;
}
const str = (v) => (typeof v === 'string' ? v : null);
const num = (v) => (Number.isFinite(v) ? v : null);
function projectRow(id, e) {
  const x = e && typeof e === 'object' ? e : {};
  return {
    order_id: id, ts: num(x.ts), total: num(x.total), order_type: str(x.order_type), restaurant: str(x.restaurant), status: str(x.status),
    items_text: str(x.items_text), items: Array.isArray(x.items) ? x.items : [],
    ...(x.recipe_format !== undefined ? { recipe_format: x.recipe_format } : {}),
  };
}
const isActive = (status) => typeof status === 'string' && status !== '' && !TERMINAL.has(status);

// deps: { getDatabase, getAuth, checkRateLimit }
function makeMyOrders(deps) {
  async function getMyOrders(req, res) {
    res.set('Cache-Control', 'no-store');
    try {
      if (req.method !== 'GET') return res.status(405).json({ ok: false });
      const q = req.query || {};
      const hasBody = req.body != null && (typeof req.body !== 'object' || Object.keys(req.body).length > 0);
      const limit = parseLimit(q.limit);
      const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
      if (q.context !== 'platform' || Object.keys(q).some((k) => !QUERY_KEYS.has(k)) || hasBody || limit === null || (q.cursor !== undefined && !cursor)) {
        return res.status(400).json({ ok: false, reason: 'bad_request' });
      }
      const t = typeof req.get === 'function' ? req.get('x-firebase-id-token') : null;
      let uid = null;
      if (t) {
        try { const dec = await deps.getAuth().verifyIdToken(t); if (dec && dec.customer === true && typeof dec.uid === 'string' && dec.uid) uid = dec.uid; } catch (_) { uid = null; }
      }
      if (!uid) return res.status(401).json({ ok: false, reason: 'unauthenticated' });
      const db = deps.getDatabase();
      const { allowed, retryAfterSec } = await deps.checkRateLimit(db, 'my_orders', uid, RATE);
      if (!allowed) { res.set('Retry-After', String(retryAfterSec)); return res.status(429).json({ ok: false, reason: 'rate_limited' }); }
      if (await S.isTombstoned(db, uid)) return res.status(403).json({ ok: false, reason: 'deleted' });
      let qr = db.ref(`user_orders/${uid}`).orderByChild('ts');
      if (cursor) qr = qr.endBefore(cursor.ts, cursor.id);
      const snap = await qr.limitToLast(limit + 1).once('value');
      const asc = [];
      snap.forEach((c) => { asc.push(projectRow(c.key, c.val())); });
      const more = asc.length > limit;
      const page = (more ? asc.slice(asc.length - limit) : asc).reverse();   // newest first
      const oldest = page[page.length - 1];
      const out = { ok: true, active: [], past: [], next_cursor: more && oldest ? encodeCursor(oldest.ts, oldest.order_id) : null };
      for (const row of page) (isActive(row.status) ? out.active : out.past).push(row);
      return res.status(200).json(out);
    } catch (e) {
      console.error('getMyOrders', e && e.message);
      return res.status(500).json({ ok: false });
    }
  }
  return { getMyOrders };
}

module.exports = { makeMyOrders, projectRow, decodeCursor, LIMIT_MAX };
