'use strict';
// F-1 (BRIEF-portal-stale-draft-clobber; advisor ruling 2026-11-07, malformed (a)) — the OWNER's recovery for a platform-pending stamp
// (catalog/platform-pending.js). A well-formed stamp clears itself once live carries its fields; a MALFORMED one locks the menu until
// someone acts, and its owner alert points here.
//
//   status --rid <rid>            read-only: the stamp's SHAPE (exists / malformed / by / at / field count) — never the field paths
//   clear  --rid <rid> [--apply]  DRY RUN unless --apply; with --apply deletes ONLY that rid's stamp + its malformed alert
//
// ARGUMENTS ARE STRICT (the record-evidence-boundary `--rid=` lesson): the SPACE form only; `--rid=…`, a missing / malformed rid,
// an unknown flag, a repeated flag, a second subcommand, or --apply on status ⇒ exit 2 — never a silent fan-out. --project is
// mandatory and checked against .firebaserc BEFORE any client exists (tools/require-project.js).
// Run:  node tools/platform-pending.js status --project <id> --rid <rid>
//       node tools/platform-pending.js clear  --project <id> --rid <rid> [--apply]
const { pendingRefOf, readPlatformPending, malformedAlertRef } = require('../catalog/platform-pending');

const RID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;   // restaurant ids (catalog/restaurant-registry.js RID_RE)
const SUBS = new Set(['status', 'clear']);

function parseArgs(argv) {
  const a = argv.slice();
  const refuse = (why) => ({ ok: false, why });
  const sub = a.shift();
  if (!SUBS.has(sub)) return refuse('usage: platform-pending.js <status|clear> --project <id> --rid <rid> [--apply]');
  const out = { ok: true, sub, rid: null, apply: false };
  const seen = new Set();
  while (a.length) {
    const t = a.shift();
    if (seen.has(t)) return refuse(`${t} given twice`);
    seen.add(t);
    if (t === '--apply') { if (sub !== 'clear') return refuse('--apply is for clear only'); out.apply = true; continue; }
    if (t === '--project' || t === '--rid') {
      if (!a.length || a[0].startsWith('--')) return refuse(`${t} needs a value`);
      const v = a.shift();
      if (t === '--rid') { if (!RID_RE.test(v)) return refuse(`bad rid ${JSON.stringify(v)}`); out.rid = v; }
      continue;
    }
    return refuse(`unknown argument ${JSON.stringify(t)}`);
  }
  if (!out.rid) return refuse('--rid <rid> is required');
  if (!seen.has('--project')) return refuse('--project <id> is required');
  return out;
}

// the stamp's SHAPE only (never the field paths): what an operator needs to decide, nothing a log should carry
async function status(fs, rid) {
  const snap = await pendingRefOf(fs, rid).get();
  if (!snap || !snap.exists) return { rid, exists: false };
  const st = await readPlatformPending(fs, rid);
  if (st.malformed) return { rid, exists: true, malformed: true };
  return { rid, exists: true, malformed: false, by: st.by, at: st.at, fields: st.fields.length };
}

async function clear(fs, rtdb, rid, { apply = false } = {}) {
  const before = await status(fs, rid);
  if (!before.exists) return { rid, existed: false, cleared: false, apply };
  if (!apply) return { rid, existed: true, cleared: false, apply, would: 'delete the stamp + its malformed alert', before };
  await pendingRefOf(fs, rid).delete();
  await malformedAlertRef(rtdb, rid).set(null);
  return { rid, existed: true, cleared: true, apply, before };
}

module.exports = { parseArgs, status, clear, RID_RE };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ok) { console.error(`REFUSED — ${args.why}`); process.exit(2); }
  const { requireProject } = require('./require-project');
  const PROJECT_ID = requireProject({ requireFlag: true });   // before any credential or client
  const admin = require('firebase-admin');
  const { RTDB_URL } = require('../catalog/mirror-rtdb');
  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT_ID, databaseURL: RTDB_URL });
  const run = args.sub === 'status' ? status(admin.firestore(), args.rid) : clear(admin.firestore(), admin.database(), args.rid, { apply: args.apply });
  run.then((r) => {
    console.log(JSON.stringify(r));
    if (args.sub === 'clear' && !args.apply && r.existed) console.log('DRY RUN — nothing written. Re-run with --apply to delete this rid\'s stamp.');
    process.exit(0);
  }).catch((e) => { console.error('platform-pending failed (nothing more was written):', e && e.message); process.exit(1); });
}
