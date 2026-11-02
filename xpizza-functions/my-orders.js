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
const CB = require('./catalog/canonical-binding');   // identityMap: the ONE legacy-key → canonical-id resolver (via the pricing envelope's D4-a context)
const { HEAL_TERMINAL_STATUSES: TERMINAL } = require('./sweep-pending');   // {cancelled, delivered, completed} — one source

const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;   // the createOrder order_id rule
const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 50;
const QUERY_KEYS = new Set(['context', 'limit', 'cursor', 'order_id']);
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

// approved delta 2026-11-01: (1) each recipe line gains `dish_id` — the store's canonical dish id for the line's stored key, from the
// SAME resolver the server uses (CB.identityMap over contextOf(resolvePricingTables(rid)), as index.js's live displayLabel path) — or
// null when unresolvable / the context is not usable (the client discloses it, never guesses); the stored key is kept as-is. Brand-
// agnostic: the context maps itemPricingKey (whatever the brand keys by) → id. (2) `display_number`, read from orders/{id} for the
// page's rows only (≤ limit point reads, in parallel), present only when stamped (a finite number) — never the long id.
// Reads per call: 1 query + ≤ limit display_number reads + 1 context resolution per DISTINCT restaurant on the page (cached).
function withDishIds(items, map) {
  return items.map((l) => (l && typeof l === 'object' && !Array.isArray(l)
    ? { ...l, dish_id: (map && typeof l.key === 'string' && map.dish.get(l.key)) || null } : l));
}

// RECEIPT detail mode (NOTE-getMyOrders-receipt, approved 2026-11-01): ?context=platform&order_id=X (alone — no limit / cursor).
// Ownership = the caller's user_orders entry exists AND orders/{id}.customer_uid === uid; anything else ⇒ ONE uniform 404 (no
// existence oracle). 2 point reads. A WHITELIST of the order: priced lines only when the order has them (x_pizza's platform
// factura — brand-agnostic BY DATA), present totals only (never 0-filled), the tender as cash / card (never digits or a
// reference — none is stored), the customer's own address for a delivery (never coordinates).
const isInt = (v) => Number.isSafeInteger(v);
function receiptLines(items) {
  if (!Array.isArray(items) || !items.length) return null;
  const out = [];
  for (const l of items) {
    if (!l || typeof l !== 'object' || !isInt(l.qty) || l.qty < 1 || typeof l.description !== 'string' || !isInt(l.line_gross_cents)) return null;
    out.push({ qty: l.qty, description: l.description, line_cents: l.line_gross_cents });
  }
  return out;
}
const TOTAL_KEYS = ['subtotal_cents', 'tax_cents', 'delivery_cents', 'promo_discount_cents', 'tip_cents', 'total_cents'];
const TENDER = { cash: 'cash', card_delivery: 'card', online: 'card' };
function projectReceipt(id, entry, o) {
  const totals = {}; for (const k of TOTAL_KEYS) if (isInt(o[k])) totals[k] = o[k];
  const method = TENDER[o.payment_method] || null;
  const type = str(o.order_type);
  return {
    order_id: id, ...(Number.isFinite(o.display_number) ? { display_number: o.display_number } : {}),
    ts: num(entry.ts), restaurant: str(entry.restaurant), order_type: type, status: str(o.status),
    lines: receiptLines(o.items), items_text: str(o.items_text), totals,
    tender: { method, ...(method === 'cash' && isInt(o.cash_tendered_cents) ? { cash_tendered_cents: o.cash_tendered_cents } : {}) },
    ...(type === 'delivery' ? { address: { detected: str(o.address_detected), details: str(o.address_details), area: str(o.address_area) } } : {}),
  };
}

// deps: { getDatabase, getAuth, checkRateLimit, resolveContext(rid) → the pricing envelope's context }
function makeMyOrders(deps) {
  async function getMyOrders(req, res) {
    res.set('Cache-Control', 'no-store');
    try {
      if (req.method !== 'GET') return res.status(405).json({ ok: false });
      const q = req.query || {};
      // Codex r1 P2: ANY body is refused — raw bytes (the runtime's rawBody: a `{}` or `[]` body is non-empty) or a parsed body that
      // is not the runtime's empty plain object for a body-less GET (an array, a string, an object with keys)
      const b = req.body;
      const hasBody = (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 0)
        || (b != null && (typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length > 0));
      const limit = parseLimit(q.limit);
      const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
      const detailId = q.order_id;
      const badDetail = detailId !== undefined && (typeof detailId !== 'string' || !ORDER_ID_RE.test(detailId) || q.limit !== undefined || q.cursor !== undefined);
      if (q.context !== 'platform' || Object.keys(q).some((k) => !QUERY_KEYS.has(k)) || hasBody || limit === null || (q.cursor !== undefined && !cursor) || badDetail) {
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
      if (detailId !== undefined) {
        const [eS, oS] = await Promise.all([db.ref(`user_orders/${uid}/${detailId}`).once('value'), db.ref(`orders/${detailId}`).once('value')]);
        const entry = eS.val(); const order = oS.val();
        if (!entry || typeof entry !== 'object' || !order || typeof order !== 'object' || order.customer_uid !== uid) return res.status(404).json({ ok: false, reason: 'not_found' });
        return res.status(200).json({ ok: true, receipt: projectReceipt(detailId, entry, order) });
      }
      let qr = db.ref(`user_orders/${uid}`).orderByChild('ts');
      if (cursor) qr = qr.endBefore(cursor.ts, cursor.id);
      const snap = await qr.limitToLast(limit + 1).once('value');
      const asc = [];
      snap.forEach((c) => { asc.push(projectRow(c.key, c.val())); });
      const more = asc.length > limit;
      const page = (more ? asc.slice(asc.length - limit) : asc).reverse();   // newest first
      const oldest = page[page.length - 1];
      const out = { ok: true, active: [], past: [], next_cursor: more && oldest ? encodeCursor(oldest.ts, oldest.order_id) : null };
      const rids = [...new Set(page.map((r) => r.restaurant).filter((r) => typeof r === 'string' && r))];
      const ctxOf = async (rid) => { try { return CB.identityMap(await deps.resolveContext(rid)); } catch (_) { return null; } };
      const dnOf = async (id) => { try { const v = (await db.ref(`orders/${id}/display_number`).once('value')).val(); return Number.isFinite(v) ? v : null; } catch (_) { return null; } };
      const [maps, dns] = await Promise.all([Promise.all(rids.map(ctxOf)), Promise.all(page.map((r) => dnOf(r.order_id)))]);
      const mapBy = new Map(rids.map((r, i) => [r, maps[i]]));
      page.forEach((row, i) => {
        const full = { ...row, items: withDishIds(row.items, mapBy.get(row.restaurant) || null), ...(dns[i] !== null ? { display_number: dns[i] } : {}) };
        (isActive(row.status) ? out.active : out.past).push(full);
      });
      return res.status(200).json(out);
    } catch (e) {
      console.error('getMyOrders', e && e.message);
      return res.status(500).json({ ok: false });
    }
  }
  return { getMyOrders };
}

module.exports = { makeMyOrders, projectRow, decodeCursor, LIMIT_MAX };
