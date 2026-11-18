#!/usr/bin/env node
'use strict';
// Calificaciones v2 (PLAN-3a-merchant-reviews-v2 r1 §0 B1, r6.1 §1) — the OWNER's ratings-disclosure CLI. DRY RUN unless --apply.
//
//   node tools/ratings-config.js --project xpizza-delivery --show                                              ← read-only
//   node tools/ratings-config.js --project xpizza-delivery --enable --policy-url <published policy URL> --by <who> [--apply]
//   node tools/ratings-config.js --project xpizza-delivery --disable [--apply]
//
// --enable sets disclosure_v 1 + policy_ack { at, by, policy_url } and, on the FIRST enable, stamps disclosure_cutover_at with the
// SERVER timestamp, all in ONE transaction on platform_config/ratings (ratings/ratings-config.js). The cut-over never moves again: a
// disable keeps it, a re-enable keeps the first one. Run --enable only AFTER the published privacy policy states that restaurants see
// the customer's first name + last initial and the order details (date, total, dishes, new/returning) with the rating, and after the
// capp build that sends `disclosure` is in the stores. Prints names / states only. --project must be the explicit flag.
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });   // the project guard FIRST, before any client

function parseArgs(argv) {
  const out = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') { i++; continue; }
    if (a.startsWith('--project=')) continue;
    if (a === '--apply') out.apply = true;
    else if (a === '--show' || a === '--enable' || a === '--disable') { if (out.mode) return { error: 'exactly one of --show / --enable / --disable' }; out.mode = a.slice(2); }
    else if (a === '--policy-url' || a === '--by') { const v = argv[++i]; if (typeof v !== 'string' || !v.trim()) return { error: `${a} needs a value` }; out[a === '--by' ? 'by' : 'policyUrl'] = v.trim(); }
    else return { error: `unknown argument ${a}` };
  }
  if (!out.mode) return { error: 'one of --show / --enable / --disable is required' };
  if (out.mode === 'enable' && (!out.policyUrl || !out.by)) return { error: '--enable needs --policy-url and --by' };
  if (out.mode !== 'enable' && (out.policyUrl || out.by)) return { error: '--policy-url / --by go with --enable only' };
  if (out.mode === 'show' && out.apply) return { error: '--show is read-only' };
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (args.error) { console.error(`ratings-config: REFUSED — ${args.error}`); process.exit(2); }
const admin = require('firebase-admin');
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const RC = require('../ratings/ratings-config');

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
const db = admin.database();
const state = (cfg) => {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const cut = c.disclosure_cutover_at;
  return `disclosure_v=${c.disclosure_v === 1 ? 1 : 0} policy_ack=${RC.validAck(c.policy_ack) ? 'valid' : c.policy_ack == null ? 'absent' : 'MALFORMED'} cutover=${cut == null ? 'absent' : RC.validCutover(cut) ? new Date(cut).toISOString() : 'MALFORMED'}`;
};

(async () => {
  const cur = (await db.ref(RC.PATH).once('value')).val();
  console.log(`ratings-config ${args.mode === 'show' ? 'READ-ONLY' : args.apply ? 'APPLY' : 'DRY RUN'} — project ${PROJECT_ID} — ${RC.PATH}: ${state(cur)}`);
  if (args.mode === 'show') process.exit(0);
  const ack = args.mode === 'enable' ? { at: Date.now(), by: args.by, policy_url: args.policyUrl } : (cur && cur.policy_ack) || null;
  const payload = { disclosure_v: args.mode === 'enable' ? 1 : 0, ...(ack ? { policy_ack: ack } : {}) };
  const plan = RC.planRatingsConfig(cur, { payload, stamp: Date.now() });
  if (!plan.ok) { console.error(`ratings-config: REFUSED — ${plan.error}`); process.exit(1); }
  console.log(`  planned: ${state(plan.node)}${cur && cur.disclosure_cutover_at != null ? '' : args.mode === 'enable' ? ' (the cut-over is stamped with the SERVER time at --apply)' : ''}`);
  if (!args.apply) { console.log('(dry run — nothing written; add --apply)'); process.exit(0); }
  const r = await RC.writeRatingsConfig(db, { payload, stamp: admin.database.ServerValue.TIMESTAMP });
  if (!r.ok) { console.error(`ratings-config: REFUSED — ${r.error}`); process.exit(1); }
  console.log(`ratings-config: written — ${state((await db.ref(RC.PATH).once('value')).val())}`);
  process.exit(0);
})().catch((e) => { console.error('ratings-config FAILED:', e && e.message); process.exit(1); });
