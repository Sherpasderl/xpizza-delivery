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
// mandatory and checked against .firebaserc FIRST, before the arguments and before any client (tools/require-project.js; the
// catalog/project-guard cell drives every connecting tool with no / the wrong project and expects ITS refusal).
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

// the stamp and its alert are cleared INDEPENDENTLY (Codex r2 P2): a run whose stamp delete succeeded but whose alert delete failed
// exits non-zero, and its retry — the stamp now absent — still removes the alert (the alert delete is idempotent; never an early
// return on "no stamp" while an alert may remain). The result says which of the two existed and what this run cleared.
async function clear(fs, rtdb, rid, { apply = false } = {}) {
  const before = await status(fs, rid);
  const alert = (await malformedAlertRef(rtdb, rid).once('value')).val() != null;
  const existed = before.exists;
  if (!existed && !alert) return { rid, existed, alert, cleared: false, apply };
  if (!apply) return { rid, existed, alert, cleared: false, apply, would: 'delete the stamp + its malformed alert', before };
  if (existed) await pendingRefOf(fs, rid).delete();
  try { await malformedAlertRef(rtdb, rid).set(null); } catch (e) {
    throw new Error(`${existed ? 'the stamp was deleted but ' : ''}the alert delete failed (${(e && e.message) || e}) — re-run clear --apply`);
  }
  return { rid, existed, alert, cleared: true, apply, stampDeleted: existed, alertDeleted: alert, before };
}

module.exports = { parseArgs, status, clear, RID_RE };

if (require.main === module) {
  const { requireProject } = require('./require-project');
  const PROJECT_ID = requireProject({ requireFlag: true });   // the project guard FIRST (its refusal banner, exit 2), before any client
  const args = parseArgs(process.argv.slice(2));               // then the arguments (pure) — still before any credential or client
  if (!args.ok) { console.error(`🔴 REFUSED — ${args.why}`); process.exit(2); }
  const admin = require('firebase-admin');
  const { RTDB_URL } = require('../catalog/mirror-rtdb');
  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT_ID, databaseURL: RTDB_URL });
  const run = args.sub === 'status' ? status(admin.firestore(), args.rid) : clear(admin.firestore(), admin.database(), args.rid, { apply: args.apply });
  run.then((r) => {
    console.log(JSON.stringify(r));
    if (args.sub === 'clear' && !args.apply && (r.existed || r.alert)) console.log('DRY RUN — nothing written. Re-run with --apply to delete this rid\'s stamp and alert.');
    process.exit(0);
  }).catch((e) => { console.error('platform-pending failed:', e && e.message); process.exit(1); });   // the message says what WAS written
}
