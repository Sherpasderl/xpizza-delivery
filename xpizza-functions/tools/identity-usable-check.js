#!/usr/bin/env node
'use strict';
// IDENTITY-USABLE CHECK — READ-ONLY owner CLI: is each restaurant's ACTIVE catalog D4-a identity-usable right now, i.e.
// would a dish line resolve to a canonical dish_id (getMyOrders / «Volver a pedir») or be null?
// It runs the SAME judgement the request side uses (buildIdentityManifest: content integrity intact + complete +
// registry-confirmed, unexpired) and prints ONLY booleans and counts per restaurant — never a label, key or id.
//   node tools/identity-usable-check.js --project xpizza-delivery
// 🔴 WRITES NOTHING. Every Firestore write path (document set/update/delete/create, collection add, batch, transaction,
// bulk writer, recursive delete) is patched to THROW in this process before any client exists, so the tool cannot
// become a writer by accident. It never touches the Realtime Database.
const { buildIdentityManifest } = require('../catalog/identity-manifest');

const REASONS = new Set(['no_active_version', 'active_version_missing', 'content_integrity', 'row_invalid']);
const RID_RE = /^[a-z][a-z0-9_]{0,40}$/;

// Patch the Firestore classes' write methods to throw (process-wide). Returns the list of patched method names.
function denyFirestoreWrites(F) {
  const deny = (what) => function denied() { throw new Error(`identity-usable-check: refused Firestore ${what} — this tool is read-only`); };
  const plan = [
    [F.DocumentReference, ['set', 'update', 'delete', 'create']],
    [F.CollectionReference, ['add']],
    [F.WriteBatch, ['set', 'update', 'delete', 'create', 'commit']],
    [F.Transaction, ['set', 'update', 'delete', 'create']],
    [F.BulkWriter, ['set', 'update', 'delete', 'create', 'flush', 'close']],
    [F.Firestore, ['batch', 'runTransaction', 'bulkWriter', 'recursiveDelete']],
  ];
  const patched = [];
  for (const [cls, methods] of plan) {
    if (!cls || !cls.prototype) throw new Error('identity-usable-check: a Firestore class is missing — refusing to run unguarded');
    for (const m of methods) { cls.prototype[m] = deny(`${cls.name}.${m}`); patched.push(`${cls.name}.${m}`); }
  }
  return patched;
}

// Pure core: one row of booleans/counts per restaurant. `build` is injectable for the offline tests.
async function checkIdentityUsable({ db, listIds, verifier, build = buildIdentityManifest }) {
  const ids = await listIds();
  const rids = (Array.isArray(ids) ? ids : []).filter((r) => typeof r === 'string' && RID_RE.test(r)).sort();
  const skipped = (Array.isArray(ids) ? ids.length : 0) - rids.length;
  const rows = [];
  for (const rid of rids) {
    let r;
    try { r = await build({ db, rid, verifier }); } catch (_) { rows.push({ rid, ok: false, reason: 'error', usableAsIdentity: false }); continue; }
    if (!r || r.ok !== true) {
      rows.push({ rid, ok: false, reason: REASONS.has(r && r.reason) ? r.reason : 'other', usableAsIdentity: false });
      continue;
    }
    const all = (r.node && Array.isArray(r.node.rows)) ? r.node.rows : [];
    rows.push({
      rid, ok: true, usableAsIdentity: r.usableAsIdentity === true,
      dish_rows: all.filter((x) => x && x.kind === 'dish').length,
      extra_rows: all.filter((x) => x && x.kind === 'extra').length,
      rows_with_cid: all.filter((x) => x && typeof x.cid === 'string' && x.cid).length,
    });
  }
  return { rows, skipped_ids: skipped };
}

function render({ rows, skipped_ids }) {
  const lines = ['rid                      ok     usableAsIdentity  dish_rows  extra_rows  rows_with_cid  reason'];
  for (const r of rows) {
    lines.push(`${r.rid.padEnd(24)} ${String(r.ok).padEnd(6)} ${String(r.usableAsIdentity).padEnd(17)} ${String(r.dish_rows ?? '-').padEnd(10)} ${String(r.extra_rows ?? '-').padEnd(11)} ${String(r.rows_with_cid ?? '-').padEnd(14)} ${r.reason || '-'}`);
  }
  if (skipped_ids) lines.push(`(${skipped_ids} registry id(s) skipped: not a valid restaurant id)`);
  lines.push('usableAsIdentity=true ⇒ dish_id resolves for that brand (subject to the per-instance warm-up: a cold resolve can still return null once).');
  return lines.join('\n');
}

module.exports = { checkIdentityUsable, denyFirestoreWrites, render };

if (require.main === module) {
  const { requireProject } = require('./require-project');
  const PROJECT_ID = requireProject({ requireFlag: true });   // FIRST: the operator states the project as a flag
  const F = require('firebase-admin/firestore');
  denyFirestoreWrites(F);                                       // BEFORE any client exists
  const admin = require('firebase-admin');
  const { createCatalogVerifier } = require('../catalog/catalog-verifier');
  const { makeFirestoreRegistryReader } = require('../catalog/restaurant-registry');
  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT_ID });
  const db = admin.firestore();
  const verifier = createCatalogVerifier({ db, log: () => {} });   // the verifier's own diagnostics are silenced (they can name ids)
  checkIdentityUsable({ db, listIds: makeFirestoreRegistryReader(db), verifier })
    .then((r) => { console.log(render(r)); process.exit(0); })
    .catch(() => { console.error('identity-usable-check FAILED (no details printed: they could carry catalog ids)'); process.exit(1); });
}
