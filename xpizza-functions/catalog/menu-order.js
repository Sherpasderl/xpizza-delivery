'use strict';
// §3 FISCAL (PLAN-menu-ordering §3, codex serialization r1 + the advisor's fiscal ruling) — THE FACTURA'S LINES IN MENU ORDER.
//
// The forms used to send an order's lines in MENU order; they now send them in cart INSERTION order (form-serial-order.js).
// The factura's per-line PRECIO bases are reconciled to the subtotal by giving the rounding residual to the LAST line
// (factura/money.js reconcileLineBases), so the line order is part of what the factura ASSERTS. That must not change
// without the owner: the factura's lines are put back into the MENU order of the very catalog version that priced the
// order, so it is byte-identical to what it was before §3, whatever order the body arrived in.
//
//   • WHICH order: the `item_order` of the version that PRICED the order — that version's immutable meta/menu_structure,
//     as the gate reader ALREADY holds it (catalog/menu-gates.js peekItemOrder, the intake gates' snapshot; no read). The version is the
//     one the resolved pricing tables carry in their envelope (pricing-tables.js envelopeOf: live, last_good or mirror
//     alike), never "the active version now".
//   • CACHED under the immutable (rid, versionId), LRU-bounded; behind a DEADLINE, so a hung read can never hang an order.
//   • NEVER THROWS. Any failure — no version (flat layout), a read error, a timeout, an absent or malformed item_order —
//     returns null with a LOUD log, and the factura keeps the body's order (exactly today's behaviour on that order).
//
// Brand-agnostic: a line is ranked by the first of its own identity fields (name, id, dish_id) that the version's
// item_order holds — the same pricing key the catalog keys that brand's items by.

const DEFAULT_DEADLINE_MS = 250;   // on the order path; the production source only PEEKS a cached snapshot (no read)
const DEFAULT_MAX_VERSIONS = 64;

function validItemOrder(v) {
  return Array.isArray(v) && v.length > 0 && v.every((k) => typeof k === 'string' && k.length > 0) && new Set(v).size === v.length;
}

function withDeadline(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('menu_order_read_timeout')), ms); })])
    .finally(() => clearTimeout(t));
}

// readStructure(rid, versionId) → the version's menu_structure data (or null when the document is absent).
function createMenuOrderSource({ readStructure, deadlineMs = DEFAULT_DEADLINE_MS, maxVersions = DEFAULT_MAX_VERSIONS, log = (...a) => console.error(...a) } = {}) {
  const cache = new Map();   // `${rid}::${versionId}` → item_order (immutable per version)
  const vkey = (rid, versionId) => `${rid}::${versionId}`;
  const loud = (reason, detail) => { try { log('factura_menu_order_unavailable', JSON.stringify({ reason, ...detail })); } catch (_) {} };
  // `ctx.orderId` rides into every log line, so an order whose factura fell back to body order is identifiable afterwards
  async function orderFor(rid, versionId, ctx = {}) {
    const oid = ctx && ctx.orderId != null ? String(ctx.orderId) : null;
    try {
      if (typeof versionId !== 'string' || !versionId) { loud('no_version', { order_id: oid, restaurantId: rid }); return null; }
      const k = vkey(rid, versionId);
      if (cache.has(k)) { const v = cache.get(k); cache.delete(k); cache.set(k, v); return v; }
      const data = await withDeadline(Promise.resolve().then(() => readStructure(rid, versionId)), deadlineMs);
      // VERSION IDENTITY: an answer that names its version must name THE PRICING version — another version's order
      // (a stale cache, a publish in between, a fallback snapshot) is never used: body order + the loud log
      if (data && Object.prototype.hasOwnProperty.call(data, 'versionId') && String(data.versionId) !== String(versionId)) {
        loud('version_mismatch', { order_id: oid, restaurantId: rid, versionId, snapshotVersion: data.versionId == null ? null : String(data.versionId) });
        return null;
      }
      const order = data && data.item_order;
      if (!validItemOrder(order)) { loud(data ? 'malformed_item_order' : 'no_structure', { order_id: oid, restaurantId: rid, versionId }); return null; }
      const frozen = Object.freeze(order.slice());
      cache.set(k, frozen);
      while (cache.size > maxVersions) cache.delete(cache.keys().next().value);
      return frozen;
    } catch (e) {
      loud(e && e.message === 'menu_order_read_timeout' ? 'read_timeout' : e && e.message === 'gate_snapshot_not_cached' ? 'not_cached' : 'read_failed', { order_id: oid, restaurantId: rid, versionId: versionId || null, error: String((e && e.message) || e).slice(0, 160) });
      return null;   // never cached: the next order tries again
    }
  }
  return { orderFor, _cache: cache };
}

// PURE. `priced` is the factura pricing result ({ items, factura_items?, error }) whose paid lines map 1:1, in order, to
// `bodyItems` (pricedLineItems prices line by line); any lines after them in factura_items (the comped reward line) stay
// LAST. Returns a NEW result with the paid lines stably sorted into `itemOrder` (lines it does not rank keep their body
// order, after the ranked ones), or `priced` itself when there is nothing to do or the mapping cannot be trusted.
function facturaLinesInMenuOrder(priced, bodyItems, itemOrder, log = (...a) => console.error(...a), orderId = null) {
  if (!priced || !Array.isArray(priced.items) || !priced.items.length || !Array.isArray(itemOrder)) return priced;
  const n = priced.items.length;
  if (!Array.isArray(bodyItems) || bodyItems.length !== n) {
    try { log('factura_menu_order_unavailable', JSON.stringify({ reason: 'line_mapping', order_id: orderId, lines: n, body: Array.isArray(bodyItems) ? bodyItems.length : null })); } catch (_) {}
    return priced;
  }
  const fi = priced.factura_items;
  if (fi != null && (!Array.isArray(fi) || fi.length < n || fi.slice(0, n).some((l, i) => JSON.stringify(l) !== JSON.stringify(priced.items[i])))) {
    try { log('factura_menu_order_unavailable', JSON.stringify({ reason: 'factura_items_mapping', order_id: orderId, lines: n })); } catch (_) {}
    return priced;
  }
  const rank = new Map(itemOrder.map((k, i) => [String(k), i]));
  const rankOf = (it) => {
    for (const f of ['name', 'id', 'dish_id']) { if (it && it[f] != null && rank.has(String(it[f]))) return rank.get(String(it[f])); }
    return Infinity;
  };
  const perm = bodyItems.map((it, i) => ({ i, r: rankOf(it) })).sort((a, b) => (a.r - b.r) || (a.i - b.i)).map((x) => x.i);
  if (perm.every((p, i) => p === i)) return priced;
  const out = { ...priced, items: perm.map((i) => priced.items[i]) };
  if (Array.isArray(fi)) out.factura_items = perm.map((i) => fi[i]).concat(fi.slice(n));
  return out;
}

// The PRODUCTION readStructure: the gate reader's snapshot of THAT version, ONLY if it is already cached (catalog/menu-gates.js
// peekItemOrder — the intake gates load the active version earlier in the same request). It NEVER reads: a version the gate
// reader does not hold (cold, a publish in between, a last_good / mirror pricing, a gate read that failed) → THROW
// 'gate_snapshot_not_cached' → body order + the loud log, never another version's order and never an extra read.
const fromGateReader = (gateReader) => async (rid, versionId) => {
  const got = gateReader().peekItemOrder(rid, versionId);
  if (!got || !Array.isArray(got.itemOrder)) throw new Error('gate_snapshot_not_cached');
  return { item_order: got.itemOrder, versionId: got.versionId };   // the version the snapshot was READ FOR — checked by orderFor
};

// THE ONE CALL each factura site makes. Nothing to order (no platform factura lines, a pricing error) → `priced` as is,
// with NO read. Otherwise the pricing version's item_order (envelope versionId) re-orders the lines; when it is
// unavailable the body's order stands and orderFor has already logged why, with the order_id.
async function facturaInMenuOrder({ source, restaurantId, versionId, orderId, bodyItems, priced, log = (...a) => console.error(...a) }) {
  try {
    if (!source || !priced || priced.error || !Array.isArray(priced.items) || !priced.items.length) return priced;
    const order = await source.orderFor(restaurantId, versionId, { orderId });
    if (!order) return priced;
    return facturaLinesInMenuOrder(priced, bodyItems, order, log, orderId == null ? null : String(orderId));
  } catch (e) {
    try { log('factura_menu_order_unavailable', JSON.stringify({ reason: 'exception', order_id: orderId == null ? null : String(orderId), restaurantId, error: String((e && e.message) || e).slice(0, 160) })); } catch (_) {}
    return priced;   // never break the order
  }
}

module.exports = { createMenuOrderSource, facturaLinesInMenuOrder, facturaInMenuOrder, fromGateReader, validItemOrder, DEFAULT_DEADLINE_MS };
