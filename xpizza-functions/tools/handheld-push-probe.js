#!/usr/bin/env node
'use strict';
// H1c STEP 0 — the OWNER-RUN hardware-gate sender (PLAN-H1c "Step 0"). Sends ONE high-priority data message to the probe APK's token:
//   node tools/handheld-push-probe.js --project xpizza-delivery --token <t> --trial a|b|c|d
// --project is REQUIRED and checked against .firebaserc by tools/require-project (requireFlag: an env var alone never satisfies it;
// a missing / wrong project exits 2 before any client exists). The token is never printed; only FCM's message id is. The message is
// {type: 'probe', sent_at, trial} — no order data, no brand — and the production app ignores it (PushPayload accepts only
// new_order / resolved). Nothing is read or written in the database.
const TRIALS = new Set(['a', 'b', 'c', 'd']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!['--project', '--token', '--trial'].includes(k)) throw new Error(`unknown argument ${k}`);
    const v = argv[++i];
    if (v == null || v.startsWith('--')) throw new Error(`${k} needs a value`);
    out[k.slice(2)] = v;
  }
  if (!out.token || out.token.length < 32) throw new Error('--token <the probe screen\'s token> is required');
  if (!TRIALS.has(out.trial)) throw new Error('--trial a|b|c|d is required (a dismissed, b killed, c Doze, d reboot)');
  return out;
}

function buildProbeMessage(token, trial, now) {
  return { token, data: { type: 'probe', sent_at: String(now), trial }, android: { priority: 'high', ttl: 10 * 60 * 1000 } };
}

async function main() {
  const PROJECT_ID = require('./require-project').requireProject({ requireFlag: true });   // FIRST: refuses (exit 2) before anything else
  const args = parseArgs(process.argv.slice(2));
  const admin = require('firebase-admin');
  const { applicationDefault } = require('firebase-admin/app');
  const app = admin.initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID }, 'handheld-push-probe');
  const id = await require('firebase-admin/messaging').getMessaging(app).send(buildProbeMessage(args.token, args.trial, Date.now()));
  console.log(`sent (trial ${args.trial}) · project ${PROJECT_ID} · message ${id}`);
  await app.delete();
}

module.exports = { parseArgs, buildProbeMessage };
if (require.main === module) main().catch((e) => { console.error(`🔴 ${e.code || ''} ${e.message}`); process.exit(1); });
