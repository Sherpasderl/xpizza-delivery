#!/usr/bin/env node
'use strict';
// 1D D4-c2b — the OWNER acknowledges an identity integrity finding (PLAN-D4c2b rev 14 §4, owner option A). OWNER-RUN, DRY RUN
// unless --apply.
//
//   node tools/ack-identity-finding.js --project xpizza-delivery --rid <rid> --list
//   node tools/ack-identity-finding.js --project xpizza-delivery --rid <rid> --finding <id> --note "<what was checked>" --by "<name>" [--apply]
//
// Findings are STICKY: the monitor never closes one. Acknowledging is ONE RTDB transaction on catalog_integrity/{rid} through the
// monitor's own reducer (state.ack): it sets status acknowledged + {at, by, note} AND recomputes `summary` in the same commit,
// preserving any concurrent monitor update (the transaction re-runs on the latest node). So a deferred / backed-off restaurant's
// NEXT summary line already excludes it, and the alert closes once its 30-min window empties. A condition that reappears later
// opens a NEW finding. Runbook: docs/runbooks/identity-integrity.md.
const S = require('../catalog/identity-integrity-state');
const { INTEGRITY_PATH } = require('../catalog/identity-integrity-monitor');

function describe(id, f) {
  return `${id}  ${f.status.padEnd(12)} ${f.class.padEnd(9)} ${f.kind}${f.detail && f.detail.reason ? `{${f.detail.reason}}` : ''}`
    + `${f.detail && Number.isSafeInteger(f.detail.generation) ? ` g${f.detail.generation}` : ''}  condition ${f.condition}  first ${f.first_obs_t}  last ${f.last_obs_t}`
    + `${f.ack ? `  ack ${f.ack.by}: ${f.ack.note}` : ''}`;
}

async function list({ rtdb, rid }) {
  const node = (await rtdb.ref(`${INTEGRITY_PATH}/${rid}`).get()).val();
  if (!node) return { ok: false, refused: `no monitor state for ${rid}` };
  return { ok: true, summary: node.summary || null, findings: Object.entries(node.findings || {}).map(([id, f]) => ({ id, ...f })) };
}

async function acknowledge({ rtdb, rid, finding, note, by, apply = false, nowMs = Date.now() }) {
  if (!finding || !String(note || '').trim() || !String(by || '').trim()) return { ok: false, refused: '--finding, --note and --by are all required' };
  const ref = rtdb.ref(`${INTEGRITY_PATH}/${rid}`);
  const before = (await ref.get()).val();
  const f = before && before.findings && before.findings[finding];
  if (!f) return { ok: false, refused: `no finding ${finding} for ${rid}` };
  if (f.status !== 'open') return { ok: false, refused: `finding ${finding} is already ${f.status}` };
  if (!apply) return { ok: true, dryRun: true, finding: { id: finding, ...f }, summaryBefore: before.summary };
  let result = null;
  const tx = await ref.transaction((cur) => {
    // the SDK's FIRST call may pass its (unloaded) local cache as null: returning null makes the server compare and re-run us
    // with the real node; returning undefined would ABORT before the server value is ever seen
    if (cur === null) { result = null; return null; }
    const r = S.ack(cur, finding, { at: nowMs, by, note }); result = r;
    return r.ok ? S.withSize(r.node) : undefined;   // abort if it vanished / was acknowledged meanwhile
  }, undefined, false);
  const after = (await ref.get()).val();
  return { ok: !!(tx && tx.committed && result && result.ok), reason: result && !result.ok ? result.reason : undefined, summaryBefore: before.summary, summaryAfter: after && after.summary };
}

module.exports = { list, acknowledge, describe };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const { requireProject } = require('./require-project');
  const PROJECT_ID = requireProject({ requireFlag: true });
  const rid = val('--rid');
  if (!rid) { console.error('ack-identity-finding: REFUSED — --rid is required'); process.exit(2); }
  const admin = require('firebase-admin');
  const { RTDB_URL } = require('../catalog/mirror-rtdb');
  admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
  const rtdb = admin.database();
  (async () => {
    if (argv.includes('--list')) {
      const r = await list({ rtdb, rid });
      if (!r.ok) { console.error(`ack-identity-finding: ${r.refused}`); process.exit(1); }
      console.log(`${rid} summary ${JSON.stringify(r.summary)}`);
      for (const f of r.findings) console.log(`  ${describe(f.id, f)}`);
      process.exit(0);
    }
    const apply = argv.includes('--apply');
    const r = await acknowledge({ rtdb, rid, finding: val('--finding'), note: val('--note'), by: val('--by'), apply });
    if (r.refused) { console.error(`ack-identity-finding: REFUSED — ${r.refused}`); process.exit(1); }
    if (r.dryRun) { console.log(`DRY RUN — would acknowledge:\n  ${describe(r.finding.id, r.finding)}\n  summary now ${JSON.stringify(r.summaryBefore)} (add --apply)`); process.exit(0); }
    console.log(r.ok ? `acknowledged; summary ${JSON.stringify(r.summaryBefore)} → ${JSON.stringify(r.summaryAfter)}` : `NOT acknowledged (${r.reason || 'transaction aborted'})`);
    process.exit(r.ok ? 0 : 1);
  })().catch((e) => { console.error('ack-identity-finding: FAILED —', e && e.message); process.exit(1); });
}
