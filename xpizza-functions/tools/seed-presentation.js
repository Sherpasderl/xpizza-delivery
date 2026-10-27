#!/usr/bin/env node
'use strict';
// S7a directory — the PRESENTATION writer (PLAN-capp-S7a-r2 §0), on the seed_identity pattern, until the portal writer exists.
// Writes ONLY restaurants/{rid}/presentation, shape-validated by the SHARED assertPresentationShape (the directory's reader
// uses the same shape). Admin SDK; dry-run unless --apply; per field idempotent — an existing field is never overwritten
// unless --force. Every write is read back and compared STRUCTURALLY (RTDB reorders map keys; array order is kept).
//
// TARGET SAFETY (Codex directory r1 P1): the project is stated with --project and matched against .firebaserc by the shared
// project guard (tools/require-project.js, which also refuses mixed / foreign emulator signals) BEFORE anything else. The
// RTDB destination is the repo's own constant for that project (catalog/mirror-rtdb RTDB_URL) — never an inherited
// FB_DATABASE_URL / FIREBASE_DATABASE_URL / FIREBASE_CONFIG — and any such variable that names a DIFFERENT database is a
// REFUSAL, not a silent override. Nothing is constructed, read or written before every check passes.
//
// EXPLICIT EMPTINESS (Codex directory r1 P2-3): RTDB deletes an empty array, so an input `house: []` («no
// recommendations») is persisted as `house_hidden: true` (and `house` removed); the directory serves it as `house: []`.
// An EMPTY `cuisines: []` / `meals: {}` (Codex directory r2 P2-1) means «no tags / no mappings»: it CLEARS the field (with
// --force when one is stored; absent stays absent).
//
// PER RESTAURANT (Codex directory r2 P2-1): a malformed entry is REJECTED and reported on its own; it writes nothing, the other
// restaurants still run, and the process exits 1.
//
//   node tools/seed-presentation.js --project <id> --file <presentation.json> [--apply] [--force]
const fs = require('fs');
const { isDeepStrictEqual } = require('util');
const { presentationErrors } = require('../directory/presentation-shape');
const RID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function refuse(detail) { const e = new Error(detail); e.code = 'seed_presentation_refused'; throw e; }

function parseArgs(argv) {
  const o = { apply: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--force') o.force = true;
    else if (a === '--project') o.project = argv[++i];
    else if (a === '--file') o.file = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.project) throw new Error('--project is required (never inherited)');
  if (!o.file) throw new Error('--file is required');
  return o;
}

// PURE: the RTDB URL this run may write to, or a refusal. `url` is the repo's constant; every ambient variable that could
// name a database must agree with it (or be unset); and the constant itself must belong to the stated project.
const normUrl = (u) => String(u).trim().replace(/\/+$/, '').toLowerCase();
function assertDatabaseTarget(projectId, url, env = process.env) {
  let host;
  try { const u = new URL(url); if (u.protocol !== 'https:') refuse(`database URL ${url} is not https`); host = u.host; } catch (e) { if (e.code) throw e; refuse(`database URL ${url} is not a URL`); }
  const own = new Set([`${projectId}-default-rtdb.firebaseio.com`, `${projectId}.firebaseio.com`]);
  if (!own.has(host)) refuse(`database ${url} does not belong to project ${projectId}`);
  for (const k of ['FB_DATABASE_URL', 'FIREBASE_DATABASE_URL']) {
    const v = env[k];
    if (typeof v === 'string' && v.trim() && normUrl(v) !== normUrl(url)) refuse(`${k}=${v} names a different database than ${url} (project ${projectId})`);
  }
  if (typeof env.FIREBASE_CONFIG === 'string' && env.FIREBASE_CONFIG.trim().startsWith('{')) {
    let cfg = null;
    try { cfg = JSON.parse(env.FIREBASE_CONFIG); } catch (_) { refuse('FIREBASE_CONFIG is not valid JSON'); }
    if (cfg && cfg.databaseURL && normUrl(cfg.databaseURL) !== normUrl(url)) refuse(`FIREBASE_CONFIG.databaseURL names a different database than ${url}`);
    if (cfg && cfg.projectId && cfg.projectId !== projectId) refuse(`FIREBASE_CONFIG.projectId ${cfg.projectId} is not ${projectId}`);
  }
  return url;
}

// PURE: the STORED representation of one desired presentation (house: [] → house_hidden: true; cuisines: [] / meals: {} →
// null, i.e. a deletion)
const CLEARABLE = Object.freeze(['cuisines', 'meals']);
const isEmpty = (v) => (Array.isArray(v) ? v.length === 0 : v !== null && typeof v === 'object' && Object.keys(v).length === 0);
function toStored(desired) {
  const out = { ...desired };
  if (Array.isArray(out.house) && out.house.length === 0) { delete out.house; out.house_hidden = true; }
  for (const k of CLEARABLE) if (out[k] !== undefined && isEmpty(out[k])) out[k] = null;
  return out;
}
const withoutClears = (p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null));
// the LOGICAL fields of a stored presentation: house / house_hidden are ONE field ('house')
const logicalKey = (k) => (k === 'house_hidden' ? 'house' : k);
const COUNTERPART = Object.freeze({ house: 'house_hidden', house_hidden: 'house' });

// PURE: the per-field plan for one rid → { write: {key: value|null}, skipped: [field] }
function planFor(current, desired, force) {
  const cur = current && typeof current === 'object' ? current : {};
  const want = toStored(desired);
  const present = new Set(Object.keys(cur).map(logicalKey));
  const write = {}; const skipped = [];
  for (const [k, v] of Object.entries(want)) {
    const lk = logicalKey(k);
    if (v === null && cur[k] === undefined) { skipped.push(lk); continue; }   // clearing an absent field: nothing to do
    if (present.has(lk) && !force) { skipped.push(lk); continue; }
    // the OTHER house representation is removed BEFORE the equality short-circuit (Codex directory r2 P2-2): a stored
    // house + house_hidden conflict is repaired by --force even when the requested value already matches
    const other = COUNTERPART[k];
    if (other && cur[other] !== undefined) write[other] = null;
    if (v !== null && isDeepStrictEqual(cur[k], v)) { if (!(other && other in write)) skipped.push(lk); continue; }
    write[k] = v;
  }
  return { write, skipped };
}

const exitCodeFor = (results) => (Object.values(results).some((r) => r && r.rejected) ? 1 : 0);

async function run(db, input, { apply, force }, log = console.log) {
  const results = {};
  for (const [rid, p] of Object.entries(input)) {        // validate EACH restaurant; a rejection is reported, never batch-fatal
    const errs = !RID.test(rid) ? [`bad rid ${rid}`]
      : (p === null || typeof p !== 'object' || Array.isArray(p)) ? ['presentation must be an object']
        : presentationErrors(withoutClears(toStored(p)));
    if (errs.length) { results[rid] = { rejected: errs }; log(`🔴 [presentation] REJECTED ${rid}: ${errs.join('; ')} — nothing written for it`); }
  }
  for (const [rid, p] of Object.entries(input)) {
    if (results[rid]) continue;
    const ref = db.ref(`restaurants/${rid}/presentation`);
    const cur = (await ref.once('value')).val();
    const { write, skipped } = planFor(cur, p, force);
    const keys = Object.keys(write).filter((k) => write[k] !== null);
    const clear = Object.keys(write).filter((k) => write[k] === null && cur && cur[k] !== undefined);
    results[rid] = { write: keys, clear, skipped };
    log(`[presentation] ${rid}: write ${keys.join(',') || '-'}; clear ${clear.join(',') || '-'}; skip ${skipped.join(',') || '-'}${apply ? '' : ' (dry-run)'}`);
    if (!apply || !Object.keys(write).length) continue;
    await ref.update(write);
    const back = (await ref.once('value')).val() || {};
    for (const [k, v] of Object.entries(write)) {
      const got = back[k] === undefined ? null : back[k];
      if (!isDeepStrictEqual(got, v)) throw new Error(`${rid}: read-back mismatch on ${k}`);   // structural: key order irrelevant
    }
  }
  return results;
}

module.exports = { parseArgs, planFor, run, toStored, assertDatabaseTarget, exitCodeFor };

if (require.main === module) {
  // FIRST, before parsing or any client: the stated project, matched against .firebaserc, + the mixed-signal guard.
  const { requireProject } = require('./require-project');
  const PROJECT_ID = requireProject({ requireFlag: true });
  (async () => {
    const o = parseArgs(process.argv.slice(2));
    if (o.project !== PROJECT_ID) refuse(`--project ${o.project} is not the guarded project ${PROJECT_ID}`);
    const { RTDB_URL } = require('../catalog/mirror-rtdb');
    const databaseURL = assertDatabaseTarget(PROJECT_ID, RTDB_URL, process.env);
    const admin = require('firebase-admin');
    admin.initializeApp({ projectId: PROJECT_ID, databaseURL });
    const input = JSON.parse(fs.readFileSync(o.file, 'utf8'));
    const results = await run(admin.database(), input, o);
    const rejected = Object.keys(results).filter((rid) => results[rid].rejected);
    if (rejected.length) console.error(`🔴 ${rejected.length} restaurant(s) REJECTED (nothing written for them): ${rejected.join(', ')}`);
    process.exit(exitCodeFor(results));
  })().catch((e) => {
    console.error(e && e.code === 'seed_presentation_refused' ? `🔴 REFUSED — ${e.message}\nnothing was read and nothing was written.` : `[presentation] ${e.message}`);
    process.exit(e && e.code === 'seed_presentation_refused' ? 2 : 1);
  });
}
