#!/usr/bin/env node
'use strict';
/* PRE-DEPLOY INVARIANT (codex R1-build ruling): the functions DEPLOY environment carries NO emulator signal.
 *
 * lib/admin.js enters its emulator branch on FUNCTIONS_EMULATOR === "true" or any non-empty emulator host var. In
 * production none of those may be set — a deployed FIRESTORE_EMULATOR_HOST would point the live app at a local address
 * (or, with lib/admin's guard, refuse at cold start). That was a documented residual ("production assumes the signals
 * are absent"); this turns it into a CHECKED invariant over exactly what `firebase deploy --only functions` loads:
 * firebase-tools 15.16.0 functions/env.js findEnvfiles() → `.env`, `.env.<projectId>`, `.env.<alias>` (+ `.env.local`
 * for the emulator only), in the functions source dir — for every project and alias in .firebaserc.
 *
 * Reads KEY NAMES only. Values are never printed or returned: these files hold production secrets.
 *   node tools/deploy-env-guard.js [--root <functions-dir>]   → exit 0 clean, 1 if a forbidden key is present
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// The five lib/admin.js signals, every host var the launcher clears, and the launcher's own run identity.
const FORBIDDEN = new Set([
  'FUNCTIONS_EMULATOR', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_FIRESTORE_EMULATOR_ADDRESS', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB',
  'CLOUD_EVENTARC_EMULATOR_HOST', 'CLOUD_TASKS_EMULATOR_HOST', 'DATA_CONNECT_EMULATOR_HOST', 'FIREBASE_DATACONNECT_EMULATOR_HOST',
  'FIREBASE_DATA_CONNECT_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_LOGGING_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST',
  'STORAGE_EMULATOR_HOST', 'PUBSUB_EMULATOR_HOST', 'FUNCTIONS_EMULATOR_HOST',
  'XPIZZA_EMU_RUN', 'XPIZZA_EMU_OFFSET', 'XPIZZA_EMU_SERVICES', 'XPIZZA_EMU_DEAD', 'XPIZZA_EMU_FS_RULES', 'XPIZZA_EMU_STARTED_FILE',
]);

const KEY = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const keysOf = (text) => String(text).split(/\r?\n/).map((l) => KEY.exec(l)).filter(Boolean).map((m) => m[1]);

function deployEnvFiles(root = ROOT) {
  const rcPath = [path.join(root, '.firebaserc'), path.join(root, '..', '.firebaserc')].find((p) => fs.existsSync(p));
  const rc = rcPath ? JSON.parse(fs.readFileSync(rcPath, 'utf8')) : { projects: {} };
  const names = new Set(['.env']);
  for (const [alias, id] of Object.entries(rc.projects || {})) { names.add(`.env.${id}`); if (alias !== 'default') names.add(`.env.${alias}`); }
  const fb = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'));
  const sources = [].concat(fb.functions || []).map((f) => path.resolve(root, f.source || '.'));
  const out = [];
  for (const dir of sources) for (const n of names) out.push(path.join(dir, n));
  return out;
}

function violations(root = ROOT) {
  const checked = []; const bad = [];
  for (const f of deployEnvFiles(root)) {
    if (!fs.existsSync(f)) continue;
    checked.push(path.relative(root, f) || path.basename(f));
    for (const k of keysOf(fs.readFileSync(f, 'utf8'))) if (FORBIDDEN.has(k)) bad.push(`${path.relative(root, f)}: ${k}`);
  }
  return { checked, bad };
}

module.exports = { FORBIDDEN, keysOf, deployEnvFiles, violations };
if (require.main !== module) return;
const ri = process.argv.indexOf('--root');
const { checked, bad } = violations(ri > -1 ? path.resolve(process.argv[ri + 1]) : ROOT);
if (bad.length) {
  console.error(`\n🔴 DEPLOY ENV GUARD — emulator signal(s) in the functions deploy env:\n   ${bad.join('\n   ')}`);
  console.error('   lib/admin.js would enter its emulator branch in production. Remove them before deploying.\n');
  process.exit(1);
}
console.log(`deploy-env-guard: OK — ${checked.length ? checked.join(', ') : 'no deploy env files present'} carry no emulator signal`);
