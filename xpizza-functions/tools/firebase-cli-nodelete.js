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

function checkInstalled(opts = {}) {
  const { root, version } = findFirebaseTools(opts);
  const api = fs.readFileSync(path.join(root, 'lib', 'firestore', 'api.js'), 'utf8');
  const prompt = fs.readFileSync(path.join(root, 'lib', 'prompt.js'), 'utf8');
  return { root, version, fails: checkSources({ api, prompt }) };
}

module.exports = { findFirebaseTools, checkSources, checkInstalled };
