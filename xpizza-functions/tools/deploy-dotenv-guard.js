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
 * A predeploy hook is not told which functions the deploy selected (--only), so this FAILS CLOSED: any dotenv file in a
 * functions source dir — `.env`, `.env.<project>`, `.env.<alias>`, `.env.local`, any `.env.<x>` except the committed
 * `.env.example` — blocks every functions deploy. Only FILE NAMES are reported; a dotenv file is never opened.
 *   node tools/deploy-dotenv-guard.js [--root <functions-dir>]   → exit 0 clean, 1 if a dotenv file is present
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOTENV = /^\.env(\..+)?$/;

function dotenvFiles(root = ROOT) {
  const fb = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'));
  const out = [];
  for (const f of [].concat(fb.functions || [])) {
    const dir = path.resolve(root, f.source || '.');
    for (const name of fs.readdirSync(dir).sort()) {
      if (DOTENV.test(name) && name !== '.env.example') out.push(path.relative(root, path.join(dir, name)) || name);
    }
  }
  return out;
}

function main({ argv = process.argv, out = (m) => console.log(m), err = (m) => console.error(m) } = {}) {
  try {
    const ri = argv.indexOf('--root');
    const found = dotenvFiles(ri > -1 ? path.resolve(argv[ri + 1]) : ROOT);
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

module.exports = { dotenvFiles, main };
if (require.main === module) process.exitCode = main() === 0 ? 0 : 1;
