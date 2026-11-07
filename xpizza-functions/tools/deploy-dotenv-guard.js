#!/usr/bin/env node
'use strict';
/* PRE-DEPLOY INVARIANT (owner ruling 2026-10-26): a functions deploy runs from a FRESH worktree with NO dotenv file.
 *
 * notifyArrivedOnTap (index.js, drvc block) binds MAKE_SECRET, ULTRAMSG_INSTANCE_ID, ULTRAMSG_TOKEN,
 * ULTRAMSG_INSTANCE_ID_LA_MUSA, ULTRAMSG_TOKEN_LA_MUSA and TRACKING_BASE_LA_MUSA as Secret Manager secrets. firebase-tools
 * 15.16.0 lib/deploy/functions/prepare.js:104-116 copies the codebase dotenv into `environmentVariables` on EVERY endpoint
 * (no per-function exclusion), so a dotenv file holding those names would give notifyArrivedOnTap the same name as plain env
 * AND as a secret env var. With no dotenv the CLI copies nothing: existing functions keep their deployed env
 * (prepare.js inferDetailsFromExisting) and notifyArrivedOnTap gets no plain env at all.
 *
 * A predeploy hook is not told which functions the deploy selected (--only), so this FAILS CLOSED: any dotenv file in the
 * deployed functions source — `.env`, `.env.<project>`, `.env.<alias>`, `.env.local`, any `.env.<x>` except the committed
 * `.env.example` — blocks every functions deploy. Only FILE NAMES are reported; a dotenv file is never opened.
 * The scanned dir is $RESOURCE_DIR ITSELF (codex r1 P2): the CLI gives the hook the functions source being deployed, and
 * that dir's own files are what prepare.js loads — a firebase.json found there is NEVER followed (a nested config pointing
 * elsewhere would scan the wrong dir and pass). An unset, empty, missing or non-directory root BLOCKS.
 *   node tools/deploy-dotenv-guard.js --root <functions-source-dir>   (else $RESOURCE_DIR) → exit 0 clean, 1 otherwise
 */
const fs = require('fs');
const path = require('path');

const DOTENV = /^\.env(\..+)?$/;

// the dotenv files in the deployed source dir itself (names relative to it), sorted
function dotenvFiles(dir) {
  return fs.readdirSync(dir).sort().filter((name) => DOTENV.test(name) && name !== '.env.example');
}

// the deployed dir: --root's value when --root is given (even empty), else $RESOURCE_DIR; it must be an existing directory
function deployedDir(argv, env) {
  const ri = argv.indexOf('--root');
  const raw = ri > -1 ? argv[ri + 1] : env.RESOURCE_DIR;
  if (typeof raw !== 'string' || raw === '') { const e = new Error('no deployed dir'); e.code = 'ENOROOT'; throw e; }
  const dir = path.resolve(raw);
  if (!fs.statSync(dir).isDirectory()) { const e = new Error('not a directory'); e.code = 'ENOTDIR'; throw e; }
  return dir;
}

function main({ argv = process.argv, env = process.env, out = (m) => console.log(m), err = (m) => console.error(m) } = {}) {
  try {
    const found = dotenvFiles(deployedDir(argv, env));
    if (found.length) {
      err(`\n🔴 DEPLOY DOTENV GUARD — dotenv file(s) in the functions deploy dir:\n   ${found.join('\n   ')}`);
      err('   The CLI copies a dotenv into EVERY function (prepare.js:104-116): notifyArrivedOnTap would carry its Secret Manager');
      err('   secret names (MAKE_SECRET, ULTRAMSG_*) as plain env too — a secret / plain env overlap. Deploy from a fresh worktree with NO dotenv.\n');
      return 1;
    }
    out('deploy-dotenv-guard: OK — no dotenv file in the functions deploy dir');
    return 0;
  } catch (e) {
    err(`\n🔴 deploy-dotenv-guard: internal error; deploy BLOCKED (${e && typeof e.code === 'string' ? e.code : 'unexpected'})\n`);
    return 1;
  }
}

module.exports = { dotenvFiles, deployedDir, main };
if (require.main === module) process.exitCode = main() === 0 ? 0 : 1;
