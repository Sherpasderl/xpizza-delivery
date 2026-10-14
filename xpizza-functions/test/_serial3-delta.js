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
const { orderContentKey, orderContentKeyVerbatim, legacyItemsText } = require('../order-dedup');

const LEAF = /^recent_order_content\/([^/]+)\/([0-9a-f]{32})$/;
const pathsOf = (e) => (e && typeof e.path === 'string' ? [e.path] : []).concat(e && Array.isArray(e.paths) ? e.paths : []);
const withLeaf = (e, phone, key) => ({ ...e, path: `recent_order_content/${phone}/${key}` });

// codex r2 P2 — THE MODE IS DECLARED, never inferred from the trace. Each suite case states, from what the case IS (its
// request and what it persists), whether its content stamp is BOUND to known content or UNBOUND (a request that stamps
// content it does not persist: a refusal, a changed binding).
//   bound:   content = the content the server hashed. EVERY content-stamp leaf must be its canonical key, except — on
//            createOrder's route only — the one read right after it, which must be its LEGACY key (the pre-§3 text of the
//            cart, rebuilt in menu order — order-dedup.js legacyItemsText; `menuNames` when the suite has them, else the
//            text as is, which is the legacy text of any one-line cart). Any other key is RED. The canonical leaf is then
//            compared as the legacy key, which is what the frozen golden (a pre-§3 client) recorded.
//   unbound: leaves normalised to <content-key> on BOTH sides; ONE key per request; NO twin collapse (an extra read stays).
function expectedKeys(content, menuNames) {
  const legacyText = legacyItemsText(content.itemsText, menuNames);
  const legacy = legacyText != null ? orderContentKeyVerbatim({ ...content, itemsText: legacyText }) : orderContentKeyVerbatim(content);
  return { canonical: orderContentKey(content), legacy };
}
function boundDelta(ops, { content, route = '', label = '', menuNames = null }) {
  const k = content ? expectedKeys(content, menuNames) : null;   // a bound case that stamps nothing needs nothing to bind
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    const e = ops[i];
    const m = typeof (e && e.path) === 'string' ? LEAF.exec(e.path) : null;
    if (!m) { out.push(e); continue; }
    if (!k) throw new Error(`🔴 serial3-delta ${label}: a BOUND case stamped content but no content was declared for it`);
    if (m[2] !== k.canonical) throw new Error(`🔴 serial3-delta ${label}: content-stamp ${e.op} of ${m[2]} — the bound content's key is ${k.canonical}`);
    out.push(withLeaf(e, m[1], k.legacy));
    const next = ops[i + 1];
    const nm = next && typeof next.path === 'string' ? LEAF.exec(next.path) : null;
    if (route === 'createOrder' && e.db === 'rtdb' && e.op === 'once' && nm && next.db === 'rtdb' && next.op === 'once' && nm[1] === m[1] && k.legacy !== k.canonical) {
      if (nm[2] !== k.legacy) throw new Error(`🔴 serial3-delta ${label}: the legacy read is ${nm[2]} — the bound content's legacy key is ${k.legacy}`);
      i += 1;   // the declared legacy-key read
    }
  }
  return out;
}
function unboundDelta(ops, label = '') {
  const keys = new Set();
  const out = ops.map((e) => { const m = typeof (e && e.path) === 'string' ? LEAF.exec(e.path) : null; if (!m) return e; keys.add(m[2]); return withLeaf(e, m[1], '<content-key>'); });
  if (keys.size > 1) throw new Error(`🔴 serial3-delta ${label}: one request touched ${keys.size} different content keys (${[...keys].join(', ')}) — a reader / writer split the normalisation must not hide`);
  return out;
}
// kept for the unit test's direct checks
function contentKeyDelta(ops, { content = null, route = '', label = '', menuNames = null } = {}) {
  return content ? boundDelta(ops, { content, route, label, menuNames }) : unboundDelta(ops, label);
}

function compareShape(actualOps, goldenOps, { mode, content = null, route = '', label = '', menuNames = null } = {}) {
  if (mode !== 'bound' && mode !== 'unbound') throw new Error(`🔴 serial3-delta ${label}: the case must DECLARE its mode (bound | unbound), got ${mode}`);
  return mode === 'bound'
    ? { bound: true, actual: boundDelta(actualOps, { content, route, label, menuNames }), expected: goldenOps }
    : { bound: false, actual: unboundDelta(actualOps, label), expected: goldenUnbound(goldenOps, label) };
}

// the CHANGED-PATH set of the same request, under the same declared mode
// §3 r3 (codex r3 P1): chargeOnlineOrder persists the content keys on the pending order it WRITES. Declared, and only there:
// a BOUND charge request whose changed paths add `orders/<id>/content_key` (required) plus exactly one of
// `content_legacy_order` (r4: the menu-order permutation — RTDB stores it as index leaves `…/content_legacy_order/<i>`) /
// `content_key_legacy_reason`, none of them in the golden. Their VALUES are asserted by the suite against the persisted
// order (content_key = the stamped content's key). Anywhere else these leaves stay RED.
const KEY_LEAF = /^(orders\/[^/]+)\/(content_key|content_key_legacy_reason|content_legacy_order(?:\/\d+)?)$/;
function withoutPersistedKeys(actual, golden, route, label) {
  if (golden.some((p) => KEY_LEAF.test(p))) throw new Error(`🔴 serial3-delta ${label}: the golden already carries persisted content keys`);
  const added = actual.filter((p) => KEY_LEAF.test(p));
  if (!added.length) return actual;
  if (route !== 'chargeOnlineOrder') throw new Error(`🔴 serial3-delta ${label}: persisted content keys written on ${route || 'an undeclared route'}`);
  const byOrder = new Map(); for (const p of added) { const [, o, f] = KEY_LEAF.exec(p); if (!byOrder.has(o)) byOrder.set(o, new Set()); byOrder.get(o).add(f.replace(/\/\d+$/, '')); }
  for (const [o, f] of byOrder) {
    if (!f.has('content_key') || f.size !== 2) throw new Error(`🔴 serial3-delta ${label}: ${o} persists ${[...f].sort().join(' + ')} — content_key + exactly one of content_legacy_order / content_key_legacy_reason`);
  }
  return actual.filter((p) => !KEY_LEAF.test(p));
}
function changedShape(actual, golden, { content = null, bound = false, menuNames = null, route = null, label = '' } = {}) {
  const rx = /^(recent_order_content\/[^/]+\/)([0-9a-f]{32})(\/.*)?$/;
  if (bound) {
    const k = expectedKeys(content, menuNames);
    const rest_ = withoutPersistedKeys(actual, golden, route, label);
    return { actual: rest_.map((p) => p.replace(rx, (m, a, key, rest) => a + (key === k.canonical ? k.legacy : key) + (rest || ''))).sort(), expected: golden };
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

// the content read back from the order a request PERSISTED. NOT the stamp's input when the server rewrites items_text after
// stamping (a reward's "… (Recompensa)" append, rewards-redeem-intake.js) — bind a request's stamp with contentOfRequest.
function contentOfOrder(o) {
  if (!o || typeof o.items_text !== 'string' || !o.customer_phone) return null;
  const sf = require('../scheduled-orders').normalizeScheduledFor(o.scheduled_for);
  return { phone: o.customer_phone, itemsText: o.items_text, orderType: o.order_type, scheduledFor: Number.isFinite(sf) ? sf : null };
}

// the content the stamp hashes, read from the body the test actually POSTED (the real writer): customer_phone, the client's
// items_text, order_type and the normalised slot — exactly what createOrder / chargeOnlineOrder pass to the stamp
function contentOfRequest(b) {
  if (!b || typeof b.items_text !== 'string' || !b.customer_phone) return null;
  const sf = require('../scheduled-orders').normalizeScheduledFor(b.scheduled_for);
  return { phone: b.customer_phone, itemsText: b.items_text, orderType: b.order_type, scheduledFor: Number.isFinite(sf) ? sf : null };
}

// the content a BOUND request's stamp hashed, per route (pre-existing, not §3): createOrder stamps the POSTED text before its
// reward append (index.js createOrder: stamp, then `fields.items_text = rd.itemsText`); chargeOnlineOrder appends first
// (`fields.items_text = prep.itemsText`) and stamps the FINAL text. The final text is read from the order only when it is
// exactly the posted text + server-appended "(Recompensa)" lines — i.e. this request's content — else the posted text.
const SERVER_LINE = / \(Recompensa\)$/;
function stampContent({ route, sent, post }) {
  const req = contentOfRequest(sent);
  if (!req || route !== 'chargeOnlineOrder') return req;
  const t = post && typeof post.items_text === 'string' ? post.items_text : null;
  if (t == null || t === req.itemsText || !t.startsWith(req.itemsText + ' | ')) return req;
  const extra = t.slice(req.itemsText.length + 3).split(' | ');
  return extra.every((l) => SERVER_LINE.test(l)) ? { ...req, itemsText: t } : req;
}

module.exports = { contentKeyDelta, goldenUnbound, compareShape, changedShape, contentOfOrder, contentOfRequest, stampContent, LEAF };
