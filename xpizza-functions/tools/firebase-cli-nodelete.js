'use strict';
// ---------------------------------------------------------------------------
// Does the INSTALLED Firebase CLI still refuse to delete during a non-interactive index deploy?
//
// The ONLY sanctioned index deploy is tools/deploy-indexes.js (`npm run deploy:indexes`):
//     firebase deploy --only firestore:indexes --non-interactive --project <pinned>      (never --force)
// Its safety is Firebase's own code, not a re-implemented diff. In firebase-tools 15.16.0
// (lib/firestore/api.js ~86-160) a remote composite index or field override missing from
// firestore.indexes.json is deleted only if `shouldDelete*` becomes true. That flag starts as
// `options.force`, and otherwise comes from `confirm({ nonInteractive, force, default: false })`, which
// (lib/prompt.js guard()) returns the DEFAULT, false, in non-interactive mode. The CLI only logs
// "To delete them, run this command with the --force flag".
//
// This checks that structure STILL EXISTS in the installed source, for indexes AND field overrides,
// so an upgrade that changes the behaviour fails loudly here (and in deploy-indexes.js before it runs)
// instead of silently deleting. Structural, text-level, deliberately strict.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Locate the firebase-tools package behind the `firebase` on PATH (the one the deploy will execute).
function findFirebaseTools({ which = () => execFileSync('which', ['firebase'], { encoding: 'utf8' }).trim() } = {}) {
  let p;
  try { p = fs.realpathSync(which()); } catch (e) { throw new Error('firebase_cli_not_found: no `firebase` on PATH — install firebase-tools before deploying indexes'); }
  for (let d = path.dirname(p); d !== path.dirname(d); d = path.dirname(d)) {
    const pj = path.join(d, 'package.json');
    if (fs.existsSync(pj)) {
      try { const j = JSON.parse(fs.readFileSync(pj, 'utf8')); if (j.name === 'firebase-tools') return { root: d, version: j.version }; } catch (_) { /* keep walking */ }
    }
  }
  throw new Error(`firebase_cli_not_found: ${p} is not inside a firebase-tools package`);
}

const ws = (s) => s.replace(/\s+/g, ' ');
/**
 * checkSources({ api, prompt }) → [] when the no-delete guarantees hold, else a list of failures with
 * clear text. `api` = lib/firestore/api.js, `prompt` = lib/prompt.js (their source text).
 */
function checkSources({ api, prompt }) {
  const fails = [];
  const A = ws(api), P = ws(prompt);
  for (const [what, flag, list] of [['indexes', 'shouldDeleteIndexes', 'indexesToDelete'], ['field overrides', 'shouldDeleteFields', 'fieldOverridesToDelete']]) {
    const need = [
      [`let ${flag} = options.force;`, `${what}: the delete flag must START as options.force`],
      [`if (options.nonInteractive && !options.force) {`, `${what}: the non-interactive / no --force branch is gone`],
      [`${what} defined in your project that are not present in your`, `${what}: the "not present in your firestore indexes file" notice is gone`],
      [`if (!${flag}) { ${flag} = await (0, prompt_1.confirm)({ nonInteractive: options.nonInteractive, force: options.force, default: false,`, `${what}: the confirm must be non-interactive-aware with default: false`],
      [`if (${flag} && ${list}.length > 0) {`, `${what}: deletion must be gated on ${flag}`],
    ];
    for (const [needle, msg] of need) if (!A.includes(ws(needle))) fails.push(`🔴 firebase-tools lib/firestore/api.js — ${msg}`);
  }
  // confirm() must RETURN guard()'s value (codex build r4): a guard that computes the default is no use if
  // confirm() ignores it. Checked inside confirm()'s own body, not anywhere in the file.
  const cStart = P.indexOf('async function confirm(opts) {');
  const cEnd = cStart < 0 ? -1 : P.indexOf('return inquirer.confirm(opts);', cStart);
  const confirmBody = cStart < 0 || cEnd < 0 ? '' : P.slice(cStart, cEnd);
  if (!confirmBody) fails.push('🔴 firebase-tools lib/prompt.js — confirm() not found (or no longer ends in inquirer.confirm)');
  else if (!confirmBody.includes(ws('const { shouldReturn, value } = guard(opts); if (shouldReturn) { return value; }'))) {
    fails.push('🔴 firebase-tools lib/prompt.js — confirm() no longer RETURNS guard()\'s value in non-interactive mode');
  }
  const notices = A.split('firestore indexes file. To delete them, run this command with the --force flag.').length - 1;
  if (notices < 2) fails.push(`🔴 firebase-tools lib/firestore/api.js — expected the "run this command with the --force flag" notice for BOTH indexes and field overrides (found ${notices})`);
  const promptNeed = [
    ['if (opts.force) { return true; }', 'confirm() with force returns true (expected — the wrapper NEVER passes --force)'],
    ['if (!opts.nonInteractive) { return { shouldReturn: false, value: undefined }; }', 'guard(): non-interactive handling changed'],
    ['if (typeof opts.default !== "undefined") { return { shouldReturn: true, value: opts.default }; }', 'guard(): non-interactive no longer returns the DEFAULT'],
  ];
  for (const [needle, msg] of promptNeed) if (!P.includes(ws(needle))) fails.push(`🔴 firebase-tools lib/prompt.js — ${msg}`);
  return fails;
}

/**
 * 🔴 THE PRIMARY PROOF IS BEHAVIOURAL (codex build r4): run the INSTALLED CLI's own code.
 *  (1) its real confirm({ nonInteractive: true, force: false, default: false }) must return false;
 *  (2) its real FirestoreApi.deploy(), with every network read STUBBED (a remote composite index and a
 *      remote TTL field override that the file omits) and every write a SPY, must make ZERO deletions with
 *      { nonInteractive: true, force: false };
 *  (3) control: the same drive with force: true MUST delete both — proving the spies see deletions at all.
 * Nothing touches the network: list/get/create/patch/delete are replaced on the instance.
 */
async function probeInstalled({ root } = {}) {
  const r = root || findFirebaseTools().root;
  const fails = [];
  const { confirm } = require(path.join(r, 'lib', 'prompt.js'));
  const c = await confirm({ nonInteractive: true, force: false, default: false, message: 'probe' });
  if (c !== false) fails.push(`🔴 BEHAVIOUR — confirm({nonInteractive:true, force:false, default:false}) returned ${JSON.stringify(c)}, not false`);

  const { FirestoreApi } = require(path.join(r, 'lib', 'firestore', 'api.js'));
  const NAME = 'projects/probe/databases/(default)/collectionGroups';
  const drive = async (force) => {
    const api = new FirestoreApi();
    const calls = { deleteIndex: 0, deleteField: 0, createIndex: 0, patchField: 0 };
    api.listIndexes = async () => [{ name: `${NAME}/orders/indexes/I1`, queryScope: 'COLLECTION', fields: [{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath: 'created_at', order: 'ASCENDING' }, { fieldPath: '__name__', order: 'ASCENDING' }], state: 'READY' }];
    api.listFieldOverrides = async () => [{ name: `${NAME}/sessions/fields/expires_at`, ttlConfig: { state: 'ACTIVE' }, indexConfig: { usesAncestorConfig: true, indexes: [] } }];
    api.getDatabase = async () => ({ databaseEdition: 'STANDARD' });
    api.deleteIndex = async () => { calls.deleteIndex++; };
    api.deleteField = async () => { calls.deleteField++; };
    api.createIndex = async () => { calls.createIndex++; };
    api.patchField = async () => { calls.patchField++; };
    const quiet = silence();
    try { await api.deploy({ project: 'probe', nonInteractive: true, force }, [], [{ collectionGroup: 'stats_customers', fieldPath: 'c', indexes: [] }]); }
    finally { quiet(); }
    return calls;
  };
  const safe = await drive(false);
  if (safe.deleteIndex || safe.deleteField) fails.push(`🔴 BEHAVIOUR — a non-interactive deploy without --force DELETED ${safe.deleteIndex} index(es) and ${safe.deleteField} field override(s)`);
  if (safe.patchField !== 1) fails.push(`🔴 BEHAVIOUR — the probe deploy did not apply the declared override (patchField ×${safe.patchField}); the drive is not exercising deploy()`);
  const forced = await drive(true);
  if (forced.deleteIndex !== 1 || forced.deleteField !== 1) fails.push(`🔴 BEHAVIOUR — control failed: with force:true the deploy deleted ${forced.deleteIndex}/${forced.deleteField} (expected 1/1), so the spies cannot be trusted`);
  return { fails, safe, forced };
}
// The CLI logs through its own logger/console; keep a probe quiet.
function silence() {
  const keep = { log: console.log, info: console.info, warn: console.warn, error: console.error, out: process.stdout.write, err: process.stderr.write };
  console.log = console.info = console.warn = console.error = () => {};
  process.stdout.write = () => true; process.stderr.write = () => true;
  return () => { Object.assign(console, { log: keep.log, info: keep.info, warn: keep.warn, error: keep.error }); process.stdout.write = keep.out; process.stderr.write = keep.err; };
}

function checkInstalled(opts = {}) {
  const { root, version } = findFirebaseTools(opts);
  const api = fs.readFileSync(path.join(root, 'lib', 'firestore', 'api.js'), 'utf8');
  const prompt = fs.readFileSync(path.join(root, 'lib', 'prompt.js'), 'utf8');
  return { root, version, fails: checkSources({ api, prompt }) };
}

module.exports = { findFirebaseTools, checkSources, checkInstalled, probeInstalled };
