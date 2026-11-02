#!/usr/bin/env node
'use strict';
// IDENTITY-USABLE CHECK — READ-ONLY owner CLI: the ACTIVE-CATALOG IDENTITY ELIGIBILITY of each restaurant.
// It runs buildIdentityManifest's judgement (content integrity intact + complete + registry-confirmed, unexpired) per
// restaurant and prints ONLY booleans and counts — never a label, key or id.
//   node tools/identity-usable-check.js --project xpizza-delivery
// What «eligible» does and does NOT mean: the request side ALSO requires the served version/seq provenance and the served
// prices to match the context (catalog/context-source.js project()), plus a warm resolve on the serving instance — so an
// eligible catalog makes dish_id resolvable, it does not guarantee a given request attaches it.
// 🔴 WRITES NOTHING, CONTACTS ONLY GOOGLE. Installed BEFORE the project guard touches any client:
//   - emulator configuration is refused (this is a production diagnostic);
//   - every outbound connection to a host outside the Google API / Firebase domains is refused;
//   - every write path of Firestore, the Realtime Database, Storage and Auth throws (class level, process-wide); Firestore
//     transactions are allowed ONLY with { readOnly: true } (the read path uses them);
//   - the Firestore handle the judgement receives is a read-only facade as well (defence in depth).
// Any restaurant whose check errors makes the run exit 1.
const net = require('net');
const tls = require('tls');

const REASONS = new Set(['no_active_version', 'active_version_missing', 'content_integrity', 'row_invalid']);
const RID_RE = /^[a-z][a-z0-9_]{0,40}$/;
const GOOGLE_HOSTS = [/\.googleapis\.com$/, /^googleapis\.com$/, /\.firebaseio\.com$/, /\.firebasedatabase\.app$/, /^accounts\.google\.com$/, /^oauth2\.googleapis\.com$/, /^metadata\.google\.internal$/];
const EMULATOR_VARS = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB', 'PUBSUB_EMULATOR_HOST'];

const refused = (what) => new Error(`identity-usable-check: refused ${what} — this tool is read-only`);

function refuseEmulatorConfig(env = process.env) {
  const set = EMULATOR_VARS.filter((k) => env[k]);
  if (set.length) throw new Error(`identity-usable-check: emulator configuration present (${set.join(', ')}) — this is a production diagnostic`);
}

function googleHost(host) { return typeof host === 'string' && GOOGLE_HOSTS.some((re) => re.test(host.toLowerCase().replace(/\.$/, ''))); }

// Refuse any outbound socket to a non-Google host (hostname-level; an IP literal or a missing host is refused).
function restrictEgress() {
  const hostOf = (args) => {
    const a0 = args[0];
    if (Array.isArray(a0)) return hostOf(a0);
    if (a0 && typeof a0 === 'object') return a0.servername || a0.host || null;
    if (typeof args[1] === 'string') return args[1];
    return null;
  };
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const h = hostOf(args);
    if (!googleHost(h)) throw new Error('identity-usable-check: egress refused (only Google API / Firebase hosts are allowed)');
    return origConnect.apply(this, args);
  };
  const origTls = tls.connect;
  tls.connect = function guardedTls(...args) {
    const h = hostOf(args);
    if (!googleHost(h)) throw new Error('identity-usable-check: egress refused (only Google API / Firebase hosts are allowed)');
    return origTls.apply(this, args);
  };
}

function patch(cls, methods, label) {
  if (!cls || !cls.prototype) throw new Error(`identity-usable-check: ${label} class missing — refusing to run unguarded`);
  const out = [];
  for (const m of methods) {
    if (typeof cls.prototype[m] !== 'function') continue;
    cls.prototype[m] = function denied() { throw refused(`${label}.${m}`); };
    out.push(`${label}.${m}`);
  }
  return out;
}

// Class-level, process-wide write denial for every service the admin SDK can reach. Returns the patched method names.
function denyAllWrites() {
  const F = require('firebase-admin/firestore');
  const patched = [
    ...patch(F.DocumentReference, ['set', 'update', 'delete', 'create'], 'DocumentReference'),
    ...patch(F.CollectionReference, ['add'], 'CollectionReference'),
    ...patch(F.WriteBatch, ['set', 'update', 'delete', 'create', 'commit'], 'WriteBatch'),
    ...patch(F.Transaction, ['set', 'update', 'delete', 'create'], 'Transaction'),
    ...patch(F.BulkWriter, ['set', 'update', 'delete', 'create', 'flush', 'close'], 'BulkWriter'),
    ...patch(F.Firestore, ['batch', 'bulkWriter', 'recursiveDelete'], 'Firestore'),
  ];
  const origTx = F.Firestore.prototype.runTransaction;
  F.Firestore.prototype.runTransaction = function readOnlyTx(fn, opts) {
    if (!opts || opts.readOnly !== true) throw refused('Firestore.runTransaction without { readOnly: true }');
    return origTx.call(this, fn, opts);
  };
  patched.push('Firestore.runTransaction(non-readOnly)');
  const R = require('@firebase/database-compat/standalone');   // the classes behind admin.database() AND getDatabase()
  patched.push(...patch(R.Reference, ['set', 'update', 'remove', 'push', 'transaction', 'setWithPriority', 'setPriority'], 'Reference'));
  patched.push(...patch(R.OnDisconnect, ['set', 'update', 'remove', 'setWithPriority', 'cancel'], 'OnDisconnect'));
  const S = require('@google-cloud/storage');
  patched.push(...patch(S.File, ['save', 'delete', 'copy', 'move', 'rename', 'setMetadata', 'makePublic', 'makePrivate', 'createWriteStream', 'createResumableUpload'], 'File'));
  patched.push(...patch(S.Bucket, ['upload', 'deleteFiles', 'delete', 'setMetadata', 'makePublic', 'makePrivate', 'combine', 'create'], 'Bucket'));
  const A = require('firebase-admin/auth');
  patched.push(...patch(A.BaseAuth, ['createUser', 'deleteUser', 'deleteUsers', 'updateUser', 'setCustomUserClaims', 'revokeRefreshTokens', 'importUsers',
    'createSessionCookie', 'generatePasswordResetLink', 'generateEmailVerificationLink', 'generateVerifyAndChangeEmailLink', 'generateSignInWithEmailLink',
    'deleteProviderConfig', 'updateProviderConfig', 'createProviderConfig'], 'Auth'));
  return patched;
}

// The handle the judgement receives: reads pass straight through; a non-readOnly transaction, a batch, a bulk writer or a
// recursive delete is refused at the handle too.
function readOnlyFirestore(db) {
  return new Proxy(db, { get(t, k) {
    if (k === 'runTransaction') return (fn, opts) => { if (!opts || opts.readOnly !== true) throw refused('runTransaction without { readOnly: true }'); return t.runTransaction(fn, opts); };
    if (k === 'batch' || k === 'bulkWriter' || k === 'recursiveDelete') return () => { throw refused(String(k)); };
    const v = Reflect.get(t, k, t);
    return typeof v === 'function' ? v.bind(t) : v;
  } });
}

// Pure core: one row of booleans/counts per restaurant. `build` defaults to the real manifest builder.
async function checkIdentityUsable({ db, listIds, verifier, build }) {
  const builder = build || require('../catalog/identity-manifest').buildIdentityManifest;
  const ids = await listIds();
  const rids = (Array.isArray(ids) ? ids : []).filter((r) => typeof r === 'string' && RID_RE.test(r)).sort();
  const skipped = (Array.isArray(ids) ? ids.length : 0) - rids.length;
  const rows = [];
  for (const rid of rids) {
    let r;
    try { r = await builder({ db, rid, verifier }); } catch (_) { rows.push({ rid, ok: false, reason: 'error', eligible: false }); continue; }
    if (!r || r.ok !== true) {
      rows.push({ rid, ok: false, reason: REASONS.has(r && r.reason) ? r.reason : 'other', eligible: false });
      continue;
    }
    const all = (r.node && Array.isArray(r.node.rows)) ? r.node.rows : [];
    rows.push({
      rid, ok: true, eligible: r.usableAsIdentity === true,
      dish_rows: all.filter((x) => x && x.kind === 'dish').length,
      extra_rows: all.filter((x) => x && x.kind === 'extra').length,
      rows_with_cid: all.filter((x) => x && typeof x.cid === 'string' && x.cid).length,
    });
  }
  return { rows, skipped_ids: skipped, errored: rows.filter((x) => x.reason === 'error').length };
}

function render({ rows, skipped_ids, errored }) {
  const lines = ['rid                      ok     identity_eligible  dish_rows  extra_rows  rows_with_cid  reason'];
  for (const r of rows) {
    lines.push(`${r.rid.padEnd(24)} ${String(r.ok).padEnd(6)} ${String(r.eligible).padEnd(18)} ${String(r.dish_rows ?? '-').padEnd(10)} ${String(r.extra_rows ?? '-').padEnd(11)} ${String(r.rows_with_cid ?? '-').padEnd(14)} ${r.reason || '-'}`);
  }
  if (skipped_ids) lines.push(`(${skipped_ids} registry id(s) skipped: not a valid restaurant id)`);
  if (errored) lines.push(`(${errored} restaurant(s) could not be checked — exit 1)`);
  lines.push('identity_eligible = the ACTIVE catalog passes integrity + completeness + registry confirmation. A request additionally needs');
  lines.push('its served version/seq and prices to match the context, and a warm resolve on its instance, before dish_id attaches.');
  return lines.join('\n');
}

module.exports = { checkIdentityUsable, denyAllWrites, readOnlyFirestore, restrictEgress, refuseEmulatorConfig, googleHost, render };

if (require.main === module) {
  try { refuseEmulatorConfig(); restrictEgress(); denyAllWrites(); }                 // BEFORE the project guard touches any client
  catch (e) { console.error(`\n🔴 REFUSED — ${String(e && e.message).replace(/^identity-usable-check: /, 'identity-usable-check: ')}\n`); process.exit(2); }
  const { requireProject } = require('./require-project');
  const PROJECT_ID = requireProject({ requireFlag: true });
  const admin = require('firebase-admin');
  const { createCatalogVerifier } = require('../catalog/catalog-verifier');
  const { makeFirestoreRegistryReader } = require('../catalog/restaurant-registry');
  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT_ID });
  const db = readOnlyFirestore(admin.firestore());
  const verifier = createCatalogVerifier({ db, log: () => {} });   // the verifier's own diagnostics are silenced (they can name ids)
  checkIdentityUsable({ db, listIds: makeFirestoreRegistryReader(db), verifier })
    .then((r) => { console.log(render(r)); process.exit(r.errored ? 1 : 0); })
    .catch(() => { console.error('identity-usable-check FAILED (no details printed: they could carry catalog ids)'); process.exit(1); });
}
