'use strict';
// MENU-ORDERING §3, codex serialization r1 — THE DECLARED DELTA the frozen DB-call-sequence goldens see (test-only).
//
// The goldens (d4b-charge-trace @717f97e, order-exists @f17466e, order-control, the P-SELFUPDATE traces @ba29282) are
// frozen and NEVER recaptured. §3 r1 changes exactly these things on those routes, and this module declares them:
//
//   1. THE CONTENT KEY. recent_order_content/<phone>/<KEY> is now keyed by the ORDER-INDEPENDENT content key. Same reads,
//      same writes, same order — only the hash differs when the hashed items_text has more than one line (the server
//      appends a reward's free line, so even a one-dish test cart can).
//        • CONTENT-BOUND (the default): the suite passes the content the server hashed — read back from the order the
//          request persisted ({ phone, itemsText, orderType, scheduledFor }). The canonical key of THAT content is mapped
//          to the verbatim key of THAT content; any other leaf stays as recorded, so the golden's real hash is compared.
//        • Only a request that persisted nothing (a refusal) has no content to bind: there the leaf is normalised to
//          <content-key> on BOTH sides and every content-stamp op of the request must use ONE key — a reader / writer
//          split stays RED. The hash's value is asserted where it is computed (order-dedup.test, f3-duplicate-decision).
//   2. createOrder's PRIOR-STAMP read also reads the pre-§3 VERBATIM key (readContentStamp: both, latest wins) — one extra
//      `once` of the verbatim leaf right after the canonical one, never written. Collapsed ONLY when the suite names the
//      createOrder route; on any other route the extra read stays in (RED).
//   (The factura's menu order adds NO read: its item_order comes from the gate reader's cached snapshot of the version.)
const { orderContentKey, orderContentKeyVerbatim } = require('../order-dedup');

const LEAF = /^recent_order_content\/([^/]+)\/([0-9a-f]{32})$/;
const pathsOf = (e) => (e && typeof e.path === 'string' ? [e.path] : []).concat(e && Array.isArray(e.paths) ? e.paths : []);
const withLeaf = (e, phone, key) => ({ ...e, path: `recent_order_content/${phone}/${key}` });

// (1)+(2) on ONE request's actual ops (already normalised by the suite in every other respect).
//   content: { phone, itemsText, orderType, scheduledFor } the server hashed, or null when the request persisted nothing
//   route:   'createOrder' enables the legacy-twin collapse; anything else forbids it
function contentKeyDelta(ops, { content = null, route = '', label = '' } = {}) {
  const bound = content ? { canonical: orderContentKey(content), verbatim: orderContentKeyVerbatim(content) } : null;
  const out = []; const keys = new Set();
  for (let i = 0; i < ops.length; i++) {
    const e = ops[i];
    const m = typeof (e && e.path) === 'string' ? LEAF.exec(e.path) : null;
    if (!m) { out.push(e); continue; }
    const next = ops[i + 1];
    const nm = next && typeof next.path === 'string' ? LEAF.exec(next.path) : null;
    const twin = route === 'createOrder' && e.db === 'rtdb' && e.op === 'once' && nm && next.db === 'rtdb' && next.op === 'once' && nm[1] === m[1] && nm[2] !== m[2]
      && !ops.slice(i + 2).some((x) => pathsOf(x).includes(next.path))
      && (!bound || (m[2] === bound.canonical && nm[2] === bound.verbatim));
    keys.add(m[2]);
    if (bound) out.push(m[2] === bound.canonical ? withLeaf(e, m[1], bound.verbatim) : e);   // only THIS content's key maps
    else out.push(withLeaf(e, m[1], '<content-key>'));
    if (twin) i += 1;   // the declared verbatim-key read
  }
  if (!bound && keys.size > 1) throw new Error(`🔴 serial3-delta ${label}: one request touched ${keys.size} different content keys (${[...keys].join(', ')}) — a reader / writer split the normalisation must not hide`);
  return out;
}

// BIND WHEN THE CONTENT IS THE ONE HASHED: the persisted content binds only if its canonical key is a leaf the request
// touched; otherwise the request stamped content it did not persist (a refusal, a changed binding) → the unbound mode.
// Returns { actual, expected } ready to compare, and `bound` for the suite's report.
function compareShape(actualOps, goldenOps, { content = null, route = '', label = '' } = {}) {
  const touched = new Set(actualOps.map((e) => (typeof (e && e.path) === 'string' ? LEAF.exec(e.path) : null)).filter(Boolean).map((m) => m[2]));
  const bound = !!content && touched.has(orderContentKey(content));
  return bound
    ? { bound, actual: contentKeyDelta(actualOps, { content, route, label }), expected: goldenOps }
    : { bound, actual: contentKeyDelta(actualOps, { content: null, route, label }), expected: goldenUnbound(goldenOps, label) };
}

// the CHANGED-PATH set of the same request, under the same binding decision (a stamp's leaf + its fields)
function changedShape(actual, golden, { content = null, bound = false } = {}) {
  const rx = /^(recent_order_content\/[^/]+\/)([0-9a-f]{32})(\/.*)?$/;
  if (bound) {
    const c = orderContentKey(content), v = orderContentKeyVerbatim(content);
    return { actual: actual.map((p) => p.replace(rx, (m, a, k, rest) => a + (k === c ? v : k) + (rest || ''))).sort(), expected: golden };
  }
  const un = (list) => list.map((p) => p.replace(rx, (m, a, k, rest) => `${a}<content-key>${rest || ''}`)).sort();
  return { actual: un(actual), expected: un(golden) };
}

// the golden side, for a request with NO bound content: only the leaf is normalised (one key per request there too)
function goldenUnbound(ops, label = '') {
  const keys = new Set();
  const out = ops.map((e) => { const m = typeof (e && e.path) === 'string' ? LEAF.exec(e.path) : null; if (!m) return e; keys.add(m[2]); return withLeaf(e, m[1], '<content-key>'); });
  if (keys.size > 1) throw new Error(`🔴 serial3-delta ${label} [golden]: ${keys.size} content keys in one request`);
  return out;
}

// the content the server hashed, read back from the order a request PERSISTED (the stamp is computed from the same
// fields: customer_phone, the final items_text, order_type and the normalised slot)
function contentOfOrder(o) {
  if (!o || typeof o.items_text !== 'string' || !o.customer_phone) return null;
  const sf = require('../scheduled-orders').normalizeScheduledFor(o.scheduled_for);
  return { phone: o.customer_phone, itemsText: o.items_text, orderType: o.order_type, scheduledFor: Number.isFinite(sf) ? sf : null };
}

module.exports = { contentKeyDelta, goldenUnbound, compareShape, changedShape, contentOfOrder, LEAF };
