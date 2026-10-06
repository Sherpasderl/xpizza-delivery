#!/usr/bin/env node
'use strict';
// ---------------------------------------------------------------------------
// THE ONLY SANCTIONED FIRESTORE INDEX DEPLOY:   npm run deploy:indexes
//   = firebase deploy --only firestore:indexes --non-interactive --project <pinned-and-checked>
//
// 🔴 firestore.indexes.json is the WHOLE-DATABASE index inventory. Firebase's own CLI decides what a
// deploy does with remote definitions the file omits, and in non-interactive mode WITHOUT --force it
// SKIPS them — never deletes (see tools/firebase-cli-nodelete.js for the exact source contract, which
// this re-verifies against the installed CLI BEFORE it runs). So:
//   • --non-interactive is ALWAYS passed; --force is NEVER passed, and is refused if supplied;
//   • the project is mandatory and checked (tools/require-project.js, exit 2) — never ambient;
//   • if the installed CLI no longer has the no-delete branch, this refuses (exit 1) rather than run.
// Deleting a remote index is a deliberate, separate, human decision outside this tool.
// Fields the file DOES declare are created/updated to the file's config (that is the deploy's purpose).
// ---------------------------------------------------------------------------
const { spawnSync } = require('child_process');
const path = require('path');

const buildArgs = (projectId) => ['deploy', '--only', 'firestore:indexes', '--non-interactive', '--project', projectId];

async function main(argv = process.argv.slice(2), { spawn = spawnSync, check, probe } = {}) {
  const { requireProject } = require('./require-project');
  const projectId = requireProject({ requireFlag: true });   // exit 2 on a missing / wrong project
  if (argv.some((a) => a === '--force' || a.startsWith('--force='))) {
    console.error('🔴 REFUSED — --force deletes remote indexes/overrides missing from the file. This wrapper never passes it.');
    return 1;
  }
  const { checkInstalled, probeInstalled } = require('./firebase-cli-nodelete');
  const r = (check || checkInstalled)();
  // PRIMARY proof: run the installed CLI's own confirm() and deploy() with stubbed reads + deletion spies.
  const b = await (probe || (() => probeInstalled({ root: r.root })))();
  r.fails = [...b.fails, ...r.fails];
  if (r.fails.length) {
    console.error(`🔴 REFUSED — the installed firebase-tools ${r.version} (${r.root}) no longer matches the no-delete contract:`);
    for (const f of r.fails) console.error(`  ${f}`);
    console.error('Nothing was deployed. Re-verify the CLI behaviour (tools/firebase-cli-nodelete.js) before changing this.');
    return 1;
  }
  const args = buildArgs(projectId);
  console.log(`firebase-tools ${r.version}: no-delete contract verified (behavioural probe + source). Running: firebase ${args.join(' ')}`);
  const res = spawn('firebase', args, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  return res.status == null ? 1 : res.status;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error('deploy-indexes failed:', (e && e.message) || e); process.exit(1); });

module.exports = { buildArgs, main };
