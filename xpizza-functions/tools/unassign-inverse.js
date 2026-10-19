'use strict';
// UNASSIGN (PLAN-unassign-prepickup r1.2) — the test-only INVERSE of this slice's index.js footprint (the split-file fold pattern,
// as tools/stacked-tracker-inverse.js). Proof: unapplyUnassignIndex(index.js) === e8e77e24:index.js byte-for-byte
// (unassign-wiring.guard.test.js). It is applied INNERMOST (first) in every index.js fold consumer, since this slice is newest.
// The hunks: (1) authorizeDispatcherActionWithUid + the authorizeDispatcherAction wrapper; (2) the exports.unassignOrder adapter.
// Each hunk must occur EXACTLY once, else this throws (a moved, duplicated or edited hunk is never tolerated).
// GENERATED from the base (e8e77e24) vs candidate index.js; JSON-quoted strings.

const INDEX_HUNKS = [
 [
  "// as the token simply fails path (a) and falls through to verification.\n// UNASSIGN (PLAN-unassign-prepickup r1.2 §1): the uid-returning sibling. authorizeDispatcherAction below is a thin wrapper that\n// returns EXACTLY its previous shapes ({ok, actor} / {ok:false, code, msg}) — its three existing callers are unchanged.\nasync function authorizeDispatcherActionWithUid(req) {\n  const authHeader = req.get('authorization') || '';\n  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';\n  if (!token) return { ok: false, code: 401, msg: 'missing bearer token' };\n\n  const SECRET = process.env.RECON_SECRET;\n  if (SECRET && constantTimeEqual(token, SECRET)) {\n    return { ok: true, actor: 'recon_secret', uid: null, byKind: 'recon_secret' };\n  }\n\n  let decoded;\n  try {\n    decoded = await getAuth().verifyIdToken(token);\n  } catch (_) {\n    return { ok: false, code: 401, msg: 'invalid credentials' };\n  }\n  const snap = await getDatabase().ref(`dispatchers/${decoded.uid}`).once('value');\n  if (!snap.exists()) return { ok: false, code: 403, msg: 'not authorized (dispatcher only)' };\n  return { ok: true, actor: decoded.email || decoded.uid, uid: decoded.uid, byKind: 'dispatcher' };\n}\nasync function authorizeDispatcherAction(req) {\n  const r = await authorizeDispatcherActionWithUid(req);\n  return r.ok ? { ok: true, actor: r.actor } : r;\n}\n",
  "// as the token simply fails path (a) and falls through to verification.\nasync function authorizeDispatcherAction(req) {\n  const authHeader = req.get('authorization') || '';\n  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';\n  if (!token) return { ok: false, code: 401, msg: 'missing bearer token' };\n\n  const SECRET = process.env.RECON_SECRET;\n  if (SECRET && constantTimeEqual(token, SECRET)) {\n    return { ok: true, actor: 'recon_secret' };\n  }\n\n  let decoded;\n  try {\n    decoded = await getAuth().verifyIdToken(token);\n  } catch (_) {\n    return { ok: false, code: 401, msg: 'invalid credentials' };\n  }\n  const snap = await getDatabase().ref(`dispatchers/${decoded.uid}`).once('value');\n  if (!snap.exists()) return { ok: false, code: 403, msg: 'not authorized (dispatcher only)' };\n  return { ok: true, actor: decoded.email || decoded.uid };\n}\n"
 ],
 [
  "      console.error(`[factura] void ${orderId} threw:`, e.message);\n    }\n  }\n);\n\n// UNASSIGN — \"Quitar repartidor\" for PRE-PICKUP orders (PLAN-unassign-prepickup r1.2, APPROVED). Parity with the live timeout\n// release: pre-checks, then the SAME releaseToSinAsignar the timeout path calls, the cancel core's atomic driver release (U1-b)\n// and a create-only audit. Logic in unassign-core.js; this is the HTTP adapter (cors, POST only, dispatcher auth with uid).\nexports.unassignOrder = onRequest(\n  { region: 'us-central1', cors: true, timeoutSeconds: 60, memory: '256MiB', maxInstances: 5 },\n  async (req, res) => {\n    if (req.method !== 'POST') { res.set('Allow', 'POST'); return res.status(405).json({ error: 'Method Not Allowed' }); }\n    const auth = await authorizeDispatcherActionWithUid(req);\n    if (!auth.ok) return res.status(auth.code).json({ error: 'Unauthorized', detail: auth.msg });\n    const body = req.body || {};\n    try {\n      const r = await require('./unassign-core').runUnassign(\n        { db: getDatabase(), release: releaseToSinAsignar, now: () => Date.now(), log: (m) => console.warn(m) },\n        { orderId: body.orderId, expectedFromDriver: body.expectedFromDriver, opId: body.opId, actor: auth.actor, uid: auth.uid, byKind: auth.byKind });\n      return res.status(r.status).json(r.body);\n    } catch (e) {\n      console.error('unassignOrder failed', e && e.message);\n      return res.status(500).json({ error: 'internal' });\n    }\n",
  "      console.error(`[factura] void ${orderId} threw:`, e.message);\n    }\n"
 ]
];

function apply(src, hunks, label) {
  let out = src;
  for (const [cand, base] of hunks) {
    const n = out.split(cand).length - 1;
    if (n !== 1) throw new Error(`${label}: a hunk occurs ${n}× (expected exactly once): ${JSON.stringify(cand.slice(0, 120))}`);
    out = out.replace(cand, () => base);
  }
  return out;
}
const unapplyUnassignIndex = (indexSrc) => apply(indexSrc, INDEX_HUNKS, 'unassign-inverse index.js');

module.exports = { unapplyUnassignIndex, INDEX_HUNKS };
