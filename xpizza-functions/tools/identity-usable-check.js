#!/usr/bin/env node
'use strict';
// IDENTITY-USABLE CHECK — READ-ONLY owner CLI: the ACTIVE-CATALOG IDENTITY ELIGIBILITY of each restaurant.
// It runs buildIdentityManifest's judgement (content integrity intact + complete + registry-confirmed, unexpired) per
// restaurant and prints ONLY booleans and counts — never a label, key or id.
//   node tools/identity-usable-check.js --project xpizza-delivery
//   node tools/identity-usable-check.js --project xpizza-delivery --capture <file>   before a certification's one-way step
//   node tools/identity-usable-check.js --project xpizza-delivery --against <file>   after it: coverage against that capture
// The capture holds, per restaurant, the active version, its seq and one sha256 per catalog object — no catalog text — and is
// written once (an existing file is never overwritten: it is the pre-cut-over evidence). It is the only thing this tool writes,
// and only to the local disk.
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
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const dns = require('dns');

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
const isIp = (h) => typeof h === 'string' && net.isIP(h) !== 0;
// gRPC (Firestore) resolves a Google host itself and then connects to the ADDRESS: an IP is allowed only if THIS process
// resolved it from an allowed Google host name.
const RESOLVED = new Set();
const noteResolved = (addrs) => { for (const a of [].concat(addrs || [])) { const ip = typeof a === 'string' ? a : a && a.address; if (isIp(ip)) RESOLVED.add(ip); } };
function egressAllowed(host) { return googleHost(host) || (isIp(host) && RESOLVED.has(host)); }
// A fixed CLASS for a refused destination — never the destination itself.
function hostClass(host) {
  if (typeof host !== 'string' || !host) return 'none';
  const h = host.toLowerCase();
  if (/(^|\.)googleapis\.com$/.test(h)) return 'googleapis';
  if (/\.firebaseio\.com$|\.firebasedatabase\.app$/.test(h)) return 'firebaseio';
  if (h === 'metadata.google.internal' || h === '169.254.169.254') return 'metadata';
  if (isIp(h)) return 'ip';
  return 'other';
}
const lastRefusal = { hostClass: null, guard: null };
function egressError(host) {
  lastRefusal.hostClass = hostClass(host);
  return Object.assign(new Error('identity-usable-check: egress refused (only Google API / Firebase hosts are allowed)'), { iucClass: `EGRESS_REFUSED:${lastRefusal.hostClass}` });
}

// Refuse any outbound socket / name resolution outside the Google API / Firebase domains.
function restrictEgress() {
  const hostOf = (args) => {
    const a0 = args[0];
    if (Array.isArray(a0)) return hostOf(a0);
    if (a0 && typeof a0 === 'object') return a0.servername || a0.host || null;
    if (typeof args[1] === 'string') return args[1];
    return null;
  };
  const origLookup = dns.lookup;
  dns.lookup = function guardedLookup(hostname, options, cb) {
    const callback = typeof options === 'function' ? options : cb;
    if (!googleHost(hostname) && !isIp(hostname)) { const e = egressError(hostname); return process.nextTick(() => callback(e)); }
    return origLookup.call(dns, hostname, typeof options === 'function' ? {} : options, (err, address, family) => { if (!err && googleHost(hostname)) noteResolved(Array.isArray(address) ? address : [address]); callback(err, address, family); });   // only a Google NAME's addresses become connectable
  };
  const origPLookup = dns.promises.lookup;
  dns.promises.lookup = async function guardedPLookup(hostname, options) {
    if (!googleHost(hostname) && !isIp(hostname)) throw egressError(hostname);
    const r = await origPLookup.call(dns.promises, hostname, options);
    if (googleHost(hostname)) noteResolved(Array.isArray(r) ? r : [r]);   // only a Google NAME's addresses become connectable
    return r;
  };
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const h = hostOf(args);
    if (!egressAllowed(h)) throw egressError(h);
    return origConnect.apply(this, args);
  };
  const origTls = tls.connect;
  tls.connect = function guardedTls(...args) {
    const h = hostOf(args);
    if (!egressAllowed(h)) throw egressError(h);
    return origTls.apply(this, args);
  };
}

// A FIXED error class for a failure — the message itself is never printed (it could carry ids). Allowlisted outputs only.
function classifyError(e) {
  if (!e) return 'UNKNOWN';
  if (typeof e.iucClass === 'string' && /^(EGRESS_REFUSED:(googleapis|firebaseio|metadata|ip|other|none)|GUARD_TRIPPED:[A-Za-z.()-]+)$/.test(e.iucClass)) return e.iucClass;
  const m = String(e.message || '');
  const code = e.code;
  if (/egress refused/.test(m)) return `EGRESS_REFUSED:${lastRefusal.hostClass || 'none'}`;
  if (/this tool is read-only/.test(m)) { const g = m.match(/refused (?:Firestore )?([A-Za-z]+\.[A-Za-z]+)/); return `GUARD_TRIPPED:${g ? g[1] : 'unknown'}`; }
  if (/Could not load the default credentials|could not find default credentials|ENOENT.*application_default_credentials|Failed to read credentials from file|Failed to initialize Google Cloud Firestore client with the available credentials/i.test(m)) return 'ADC_MISSING';
  if (/invalid_grant|invalid_rapt|reauth|expired/i.test(m)) return 'ADC_EXPIRED';
  if (/invalid_client|unauthorized_client|Getting metadata from plugin failed/.test(m)) return 'ADC_INVALID';
  if (code === 7 || /PERMISSION_DENIED/.test(m)) return 'PERMISSION_DENIED';
  if (code === 16 || /UNAUTHENTICATED/.test(m)) return 'UNAUTHENTICATED';
  if (code === 14 || code === 4 || /UNAVAILABLE|DEADLINE_EXCEEDED|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/.test(m) || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/.test(String(code))) return 'FIRESTORE_UNAVAILABLE';
  return 'UNKNOWN';
}
const REMEDY = {
  ADC_MISSING: 'run: gcloud auth application-default login   (this tool uses Application Default Credentials, not the gcloud user token)',
  ADC_EXPIRED: 'run: gcloud auth application-default login   (the stored ADC grant expired or needs re-auth)',
  ADC_INVALID: 'run: gcloud auth application-default login   (the Application Default Credentials file is not a valid credential)',
  PERMISSION_DENIED: 'the ADC identity lacks Firestore read access on xpizza-delivery',
  UNAUTHENTICATED: 'the ADC credential was rejected — re-run gcloud auth application-default login',
};

function patch(cls, methods, label) {
  if (!cls || !cls.prototype) throw new Error(`identity-usable-check: ${label} class missing — refusing to run unguarded`);
  const out = [];
  for (const m of methods) {
    if (typeof cls.prototype[m] !== 'function') continue;
    cls.prototype[m] = function denied() { throw Object.assign(refused(`${label}.${m}`), { iucClass: `GUARD_TRIPPED:${label}.${m}` }); };
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
  let ids;
  try { ids = await listIds(); } catch (e) { throw Object.assign(new Error('registry listing failed'), { iucStage: 'registry-list', iucClass: classifyError(e) }); }
  const rids = (Array.isArray(ids) ? ids : []).filter((r) => typeof r === 'string' && RID_RE.test(r)).sort();
  const skipped = (Array.isArray(ids) ? ids.length : 0) - rids.length;
  const rows = [];
  for (const rid of rids) {
    let r;
    try { r = await builder({ db, rid, verifier }); } catch (e) { rows.push({ rid, ok: false, reason: 'error', error_class: classifyError(e), eligible: false }); continue; }
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
    lines.push(`${r.rid.padEnd(24)} ${String(r.ok).padEnd(6)} ${String(r.eligible).padEnd(18)} ${String(r.dish_rows ?? '-').padEnd(10)} ${String(r.extra_rows ?? '-').padEnd(11)} ${String(r.rows_with_cid ?? '-').padEnd(14)} ${r.reason || '-'}${r.error_class ? ` (${r.error_class})` : ''}`);
  }
  if (skipped_ids) lines.push(`(${skipped_ids} registry id(s) skipped: not a valid restaurant id)`);
  if (errored) lines.push(`(${errored} restaurant(s) could not be checked — exit 1)`);
  lines.push('identity_eligible = the ACTIVE catalog passes integrity + completeness + registry confirmation. A request additionally needs');
  lines.push('its served version/seq and prices to match the context, and a warm resolve on its instance, before dish_id attaches.');
  return lines.join('\n');
}

// The one line printed on a whole-run failure: a fixed stage + a fixed class (+ a fixed remedy). Nothing else.
function failureLine(e, stage) {
  const cls = (e && e.iucClass) || classifyError(e);
  const st = (e && e.iucStage) || stage || 'unknown';
  return `identity-usable-check FAILED — stage=${st} class=${cls}${REMEDY[cls] ? ` — ${REMEDY[cls]}` : ''}`;
}

// ── Coverage against a CAPTURED catalog (PLAN-brand-agnostic-convergence §3-E) ───────────────────────────────────
// Rows map 1:1 to the active version's objects and carry a cid only when the catalog is usable, so a ratio taken against
// the live catalog alone is 100% the moment it is eligible. The question certification must answer is narrower: every
// object that existed BEFORE the one-way step now carries an id, none vanished or appeared, and the version did not move.
const CAPTURE_KIND = 'identity-coverage-capture';
const objectHash = (kind, key) => crypto.createHash('sha256').update(`${kind}\0${key}`).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;

async function captureCatalog({ db, listIds, verifier, build, now = Date.now }) {
  const builder = build || require('../catalog/identity-manifest').buildIdentityManifest;
  const ids = await listIds();
  const rids = (Array.isArray(ids) ? ids : []).filter((r) => typeof r === 'string' && RID_RE.test(r)).sort();
  const restaurants = {}; const failed = [];
  for (const rid of rids) {
    let r;
    try { r = await builder({ db, rid, verifier }); } catch (e) { failed.push({ rid, reason: 'error' }); continue; }
    if (!r || r.ok !== true || !r.node || !Array.isArray(r.node.rows)) { failed.push({ rid, reason: REASONS.has(r && r.reason) ? r.reason : 'other' }); continue; }
    restaurants[rid] = { versionId: r.node.versionId, seq: r.node.seq, objects: r.node.rows.map((x) => objectHash(x.kind, x.key)).sort() };
  }
  return { kind: CAPTURE_KIND, v: 1, captured_at: new Date(now()).toISOString(), restaurants, failed };
}

function validCapture(c) {
  if (!c || c.kind !== CAPTURE_KIND || c.v !== 1 || !c.restaurants || typeof c.restaurants !== 'object') return false;
  const rids = Object.keys(c.restaurants);
  if (!rids.length) return false;
  return rids.every((rid) => {
    const x = c.restaurants[rid];
    return RID_RE.test(rid) && x && typeof x.versionId === 'string' && x.versionId && Array.isArray(x.objects) && x.objects.length > 0
      && x.objects.every((h) => typeof h === 'string' && HEX64.test(h)) && new Set(x.objects).size === x.objects.length;
  });
}

async function checkAgainstCapture({ db, verifier, build, capture }) {
  if (!validCapture(capture)) throw Object.assign(new Error('capture_invalid'), { iucStage: 'capture', iucClass: 'CAPTURE_INVALID' });
  const builder = build || require('../catalog/identity-manifest').buildIdentityManifest;
  const rows = [];
  for (const rid of Object.keys(capture.restaurants).sort()) {
    const cap = capture.restaurants[rid];
    const total = cap.objects.length;
    let r;
    try { r = await builder({ db, rid, verifier }); } catch (e) { rows.push({ rid, pass: false, reason: 'error', total }); continue; }
    if (!r || r.ok !== true || !r.node || !Array.isArray(r.node.rows)) { rows.push({ rid, pass: false, reason: REASONS.has(r && r.reason) ? r.reason : 'other', total }); continue; }
    const now = new Map(r.node.rows.map((x) => [objectHash(x.kind, x.key), typeof x.cid === 'string' && x.cid !== '']));
    const before = new Set(cap.objects);
    const covered = cap.objects.filter((h) => now.get(h) === true).length;
    const missing = cap.objects.filter((h) => !now.has(h)).length;
    const added = [...now.keys()].filter((h) => !before.has(h)).length;
    const eligible = r.usableAsIdentity === true;
    const versionUnchanged = r.node.versionId === cap.versionId;
    rows.push({ rid, pass: eligible && versionUnchanged && missing === 0 && added === 0 && covered === total, eligible, version_unchanged: versionUnchanged, covered, total, missing, added });
  }
  return { rows };
}

function renderCoverage({ rows }) {
  const lines = ['rid                      pass   eligible  version_unchanged  covered/total  missing  added  reason'];
  for (const r of rows) {
    lines.push(`${r.rid.padEnd(24)} ${String(r.pass).padEnd(6)} ${String(r.eligible ?? '-').padEnd(9)} ${String(r.version_unchanged ?? '-').padEnd(18)} ${`${r.covered ?? '-'}/${r.total}`.padEnd(14)} ${String(r.missing ?? '-').padEnd(8)} ${String(r.added ?? '-').padEnd(6)} ${r.reason || '-'}`);
  }
  lines.push('pass = identity eligible AND the version unchanged AND every captured object present WITH an id AND none added.');
  return lines.join('\n');
}

// Written ONCE: the capture is the pre-cut-over evidence, so an existing file is never replaced.
function writeCapture(file, capture) { fs.writeFileSync(file, `${JSON.stringify(capture, null, 1)}\n`, { flag: 'wx' }); }

// The CLI's arguments: { mode: 'check' } | { mode: 'capture'|'against', file } | { refused }. --project is the guard's.
function parseCliArgs(argv) {
  let mode = 'check'; let file = null; let modes = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project') { i += 1; continue; }
    if (a.startsWith('--project=')) continue;
    if (a === '--capture' || a === '--against') {
      const v = argv[i + 1]; i += 1;
      if (typeof v !== 'string' || v === '' || v.startsWith('-')) return { refused: `${a} needs a file (write "${a} <file>")` };
      modes += 1; mode = a.slice(2); file = v; continue;
    }
    if (a.startsWith('--capture=') || a.startsWith('--against=')) return { refused: `${a.split('=')[0]}= is not accepted — write "${a.split('=')[0]} <file>"` };
    return { refused: `unrecognised argument "${a}"` };
  }
  if (modes > 1) return { refused: 'give ONE of --capture / --against' };
  return mode === 'check' ? { mode } : { mode, file };
}

module.exports = { checkIdentityUsable, captureCatalog, checkAgainstCapture, renderCoverage, writeCapture, parseCliArgs, denyAllWrites, readOnlyFirestore, restrictEgress, refuseEmulatorConfig, googleHost, egressAllowed, noteResolved, hostClass, classifyError, failureLine, render };

if (require.main === module) {
  try { refuseEmulatorConfig(); restrictEgress(); denyAllWrites(); }                 // BEFORE the project guard touches any client
  catch (e) { console.error(`\n🔴 REFUSED — ${String(e && e.message).replace(/^identity-usable-check: /, 'identity-usable-check: ')}\n`); process.exit(2); }
  const { requireProject } = require('./require-project');
  const PROJECT_ID = requireProject({ requireFlag: true });
  // The mode and its file are settled BEFORE any client: a bad argument, an existing capture or an unreadable/invalid one
  // refuses with nothing read.
  const args = parseCliArgs(process.argv.slice(2));
  const stop = (why) => { console.error(`\n🔴 REFUSED — identity-usable-check: ${why}\n`); process.exit(2); };
  if (args.refused) stop(args.refused);
  let capture = null;
  if (args.mode === 'capture' && fs.existsSync(args.file)) stop('the capture file already exists — it is the pre-cut-over evidence and is never overwritten');
  if (args.mode === 'against') {
    try { capture = JSON.parse(fs.readFileSync(args.file, 'utf8')); } catch (_) { stop('the capture file cannot be read as JSON'); }
    if (!validCapture(capture)) stop('the capture file is not a valid identity coverage capture');
  }
  const admin = require('firebase-admin');
  const { createCatalogVerifier } = require('../catalog/catalog-verifier');
  const { makeFirestoreRegistryReader } = require('../catalog/restaurant-registry');
  let db, verifier;
  try {
    admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT_ID });
    db = readOnlyFirestore(admin.firestore());
    verifier = createCatalogVerifier({ db, log: () => {} });   // the verifier's own diagnostics are silenced (they can name ids)
  } catch (e) { console.error(failureLine(e, 'init')); process.exit(1); }
  if (args.mode === 'capture') {
    captureCatalog({ db, listIds: makeFirestoreRegistryReader(db), verifier })
      .then((c) => {
        for (const f of c.failed) console.error(`${f.rid}: NOT captured — ${f.reason}`);
        if (c.failed.length) { console.error('nothing written: every registered restaurant must build before a capture is taken (exit 1)'); process.exit(1); }
        writeCapture(args.file, c);
        for (const [rid, x] of Object.entries(c.restaurants)) console.log(`${rid}: captured ${x.objects.length} objects (seq ${x.seq})`);
        process.exit(0);
      })
      .catch((e) => { console.error(failureLine(e, 'capture')); process.exit(1); });
  } else if (args.mode === 'against') {
    checkAgainstCapture({ db, verifier, capture })
      .then((r) => { console.log(renderCoverage(r)); process.exit(r.rows.every((x) => x.pass) ? 0 : 1); })
      .catch((e) => { console.error(failureLine(e, 'coverage')); process.exit(1); });
  } else {
    checkIdentityUsable({ db, listIds: makeFirestoreRegistryReader(db), verifier })
      .then((r) => { console.log(render(r)); process.exit(r.errored ? 1 : 0); })
      .catch((e) => { console.error(failureLine(e, 'builder')); process.exit(1); });   // a fixed stage + class only — never the message
  }
}
