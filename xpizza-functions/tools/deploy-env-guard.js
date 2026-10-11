#!/usr/bin/env node
'use strict';
/* 🔴 FIRST, before anything else runs (codex r7): as the CLI, ANY uncaught exception or unhandled rejection writes ONE
   fixed line straight to fd 2 and HARD-exits 1 — prepended, so a pre-existing listener that swallows, or a
   --unhandled-rejections=warn flag, can never turn a failure into a passing deploy, and no error text (which can carry
   dotenv content) is ever printed. Only when run as the CLI: a test that require()s this module keeps its own handlers. */
if (require.main === module) {
  const hardFail = () => { try { require('fs').writeSync(2, '\n🔴 deploy-env-guard: internal error; deploy BLOCKED\n'); } catch { /* nothing to do */ } process.exit(1); };
  process.prependListener('uncaughtException', hardFail);
  process.prependListener('unhandledRejection', hardFail);
}
/* PRE-DEPLOY INVARIANT (codex R1-build ruling): the functions DEPLOY environment carries NO emulator signal.
 *
 * lib/admin.js enters its emulator branch on FUNCTIONS_EMULATOR === "true" or any non-empty emulator host var. In
 * production none of those may be set — a deployed FIRESTORE_EMULATOR_HOST would point the live app at a local address
 * (or, with lib/admin's guard, refuse at cold start). That was a documented residual ("production assumes the signals
 * are absent"); this turns it into a CHECKED invariant over exactly what `firebase deploy --only functions` loads:
 * firebase-tools 15.16.0 functions/env.js findEnvfiles() → `.env`, `.env.<projectId>`, `.env.<alias>` (+ `.env.local`
 * for the emulator only), in the functions source dir — for every project and EVERY alias in .firebaserc, `default`
 * included. ENFORCED on the deploy path: firebase.json runs it as the FIRST functions predeploy hook.
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

/* PARSE WITH THE FIREBASE-TOOLS THAT WILL DEPLOY — NO FALLBACK (codex r4 P1-2). Deploy loads each dotenv file with
   firebase-tools' functions/env.js parseStrict (loadUserEnvs). Any other parser can disagree: measured, dotenv.parse
   reads a backtick "multiline" as ONE value and MISSES an embedded FIRESTORE_EMULATOR_HOST line that parseStrict
   returns as a key. So the parser is resolved the way the deploy resolves the CLI — the `firebase` executable on PATH,
   realpath'd to its firebase-tools package — and if it cannot be resolved the guard FAILS CLOSED (deploy blocked). */
function resolveFirebaseTools(env = process.env) {
  /* The FIRST executable `firebase` on PATH is the one the deploy runs (codex r5 P2) — never skip past it to a later
     candidate: if its realpath is not inside a firebase-tools package with functions/env.js, FAIL CLOSED (return null). */
  let first = null;
  // an EMPTY PATH entry means the CURRENT DIRECTORY (POSIX execvp) — it is a real candidate, never dropped (codex r6 P2)
  for (const d of String(env.PATH || '').split(path.delimiter).map((x) => (x === '' ? '.' : x))) {
    const bin = path.join(d, 'firebase');
    try { const st = fs.statSync(bin); if (!st.isFile()) continue; fs.accessSync(bin, fs.constants.X_OK); first = bin; break; } catch { /* not here */ }
  }
  if (!first) return null;
  let real;
  try { real = fs.realpathSync(first); } catch { return null; }
  for (let dir = path.dirname(real); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const pj = path.join(dir, 'package.json');
    if (!fs.existsSync(pj)) continue;
    let name = null; try { name = JSON.parse(fs.readFileSync(pj, 'utf8')).name; } catch { /* unreadable */ }
    if (name !== 'firebase-tools') return null;            // the nearest package is NOT firebase-tools ⇒ fail closed
    /* parseStrict = parse() + reserved-key validation; it THROWS on a reserved key (e.g. any FIREBASE_* name), which would
       hide WHICH keys are there. So the keys come from the same CLI's parse() — identical parsing — and a parse ERROR
       is itself blocking (parseStrict would refuse that file at deploy too). */
    try {
      const E = require(path.join(dir, 'lib', 'functions', 'env.js'));
      if (typeof E.parse !== 'function' || typeof E.parseStrict !== 'function') return null;
      return {
        root: dir, name: `firebase-tools functions/env.js parse (${dir})`,
        keys: (t) => {
          const r = E.parse(t);
          if (r.errors && r.errors.length) {
            /* codex r5 P1: r.errors are the RAW unmatched lines — they can CONTAIN a secret. Report only the COUNT and
               the line NUMBERS (computed here), never the content. */
            const lines = String(t).replace(/\r\n?/g, '\n').split('\n');
            const nums = r.errors.map((raw) => lines.indexOf(String(raw).replace(/\r$/, '')) + 1).filter((x) => x > 0);
            const e = new Error(`parse error: ${r.errors.length} unparseable line(s)${nums.length ? ` (line ${nums.join(', ')})` : ''} — the deploy's parseStrict would refuse this file too`);
            e.code = 'EUNPARSEABLE'; throw e;
          }
          return Object.keys(r.envs || {});
        },
      };
    } catch { return null; }
  }
  return null;
}
let PARSER = null;
const parser = () => {
  if (!PARSER) PARSER = resolveFirebaseTools();
  if (!PARSER) {
    const e = new Error('cannot resolve the firebase-tools that deploys (the FIRST `firebase` on PATH is missing, or is not inside a firebase-tools package providing lib/functions/env.js parse/parseStrict) — the deploy env cannot be read with the deploy\'s own parser, so the deploy is BLOCKED. Fix: install firebase-tools (npm i -g firebase-tools) so `firebase` is on PATH, then re-run.');
    e.code = 'ENOPARSER';
    throw e;
  }
  return PARSER;
};
const keysOf = (text) => parser().keys(String(text));

/* SCOPE (codex r3 P2-3b): what THIS deploy loads — `.env`, `.env.<target project>`, and `.env.<alias>` for every alias
   that maps to the target (a superset of the one alias firebase-tools selected; the predeploy hook is given the target
   as GCLOUD_PROJECT but not the alias). With NO known target, every project's and alias's file is checked and the
   message says so (fail-safe). An unselected project's file (e.g. a staging alias) never blocks this deploy. */
function deployEnvFiles(root = ROOT, project = null) {
  const rcPath = [path.join(root, '.firebaserc'), path.join(root, '..', '.firebaserc')].find((p) => fs.existsSync(p));
  const rc = rcPath ? JSON.parse(fs.readFileSync(rcPath, 'utf8')) : { projects: {} };
  const names = new Set(['.env']);
  for (const [alias, id] of Object.entries(rc.projects || {})) {
    if (project && id !== project) continue;
    names.add(`.env.${id}`); names.add(`.env.${alias}`);   // EVERY alias incl. `default` (command.js:231 / env.js:152)
  }
  if (project) names.add(`.env.${project}`);
  const fb = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'));
  const sources = [].concat(fb.functions || []).map((f) => path.resolve(root, f.source || '.'));
  const out = [];
  for (const dir of sources) for (const n of names) out.push(path.join(dir, n));
  return out;
}

function violations(root = ROOT, project = null, { keys: keysFn = keysOf, onFile = () => {} } = {}) {
  const checked = []; const bad = [];
  for (const f of deployEnvFiles(root, project)) {
    if (!fs.existsSync(f)) continue;
    const rel = path.relative(root, f) || path.basename(f);
    onFile(rel);
    checked.push(rel);
    let keys;
    try { keys = keysFn(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'EUNPARSEABLE') { bad.push(`${rel}: ${e.message}`); continue; } throw e; }
    for (const k of keys) if (FORBIDDEN.has(k)) bad.push(`${path.relative(root, f)}: ${k}`);
  }
  return { checked, bad };
}

/* main() — the CLI, behind ONE error BOUNDARY (codex r6 P1): any unexpected error (a parser exception, a permission
   error reading a dotenv file, anything) prints a FIXED message naming the file being checked and the error's code /
   name ONLY — never its message or stack, which can carry dotenv content — and blocks the deploy (exit 1).
   Injectable (parser, output) so the boundary is tested in-process. Returns the exit code. */
const SAFE_CODES = new Set(['EACCES', 'ENOENT', 'EISDIR', 'EPERM', 'EMFILE', 'ENOTDIR', 'ELOOP', 'EUNPARSEABLE', 'EINJECTED']);
function main({ argv = process.argv, env = process.env, keys = null, parserName = null, out = (m) => console.log(m), err = (m) => console.error(m) } = {}) {
  let current = '(setup)';
  try {
    let name = parserName;
    let keysFn = keys;
    if (!keysFn) {
      try { const P = parser(); keysFn = P.keys; name = P.name; } catch (e) {
        if (e.code === 'ENOPARSER') { err(`\n🔴 DEPLOY ENV GUARD — ${e.message}\n`); return 1; }
        throw e;
      }
    }
    const ri = argv.indexOf('--root');
    const pi = argv.indexOf('--project');
    const target = (pi > -1 ? argv[pi + 1] : null) || env.GCLOUD_PROJECT || null;   // the predeploy hook is given GCLOUD_PROJECT
    const { checked, bad } = violations(ri > -1 ? path.resolve(argv[ri + 1]) : ROOT, target, { keys: keysFn, onFile: (f) => { current = f; } });
    current = '(report)';
    const scope = target ? `target project ${target}` : 'NO target project known — checked EVERY project and alias (fail-safe)';
    if (bad.length) {
      err(`\n🔴 DEPLOY ENV GUARD — emulator signal(s) in the functions deploy env (${scope}; parsed with ${name}):\n   ${bad.join('\n   ')}`);
      err('   lib/admin.js would enter its emulator branch in production. Remove them before deploying.\n');
      return 1;
    }
    out(`deploy-env-guard: OK (${scope}; parsed with ${name}) — ${checked.length ? checked.join(', ') : 'no deploy env files present'} carry no emulator signal`);
    return 0;
  } catch (e) {
    /* codex r7: the suffix is an ALLOWLISTED errno code or the literal "unexpected" — never err.code / err.name verbatim
       (both are arbitrary strings) — and it is written STRAIGHT to fd 2, not through err(): a throwing writer cannot
       escape the boundary. The file name is ours (a deploy-env path we chose), never content. */
    const id = (e && typeof e.code === 'string' && SAFE_CODES.has(e.code)) ? e.code : 'unexpected';
    try { fs.writeSync(2, `\n🔴 deploy-env-guard: internal error while checking ${current}; deploy BLOCKED (${id})\n`); } catch { /* fd 2 gone */ }
    return 1;
  }
}

module.exports = { FORBIDDEN, keysOf, deployEnvFiles, violations, resolveFirebaseTools, main, parserName: () => parser().name };
if (require.main !== module) return;
// exit 0 ONLY when main() returned exactly 0; every other outcome is 1 (codex r7)
const rc = main();
process.exitCode = rc === 0 ? 0 : 1;
