'use strict';
// B3 mixed-version cell runner (Codex #421/#422): run ONE staff-push trigger of the PRIOR release (S2, 17f93d535 — its index.js +
// staff-push.js, written by the parent test to a mkdtemp OUTSIDE the source tree, relative requires rewritten absolute; the child
// gets NODE_PATH for package names) over the honest RTDB model seeded from a JSON world.
//   node test/_prior-staff-push-run.js <prior index.js path> <notify|flush> <world.json> <out.json> [event.json]
// Writes { bodies, root } (every push body captured at web-push; the RTDB root after the run). No network, no credential.
for (const k of ['FUNCTION_TARGET', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB', 'FIREBASE_AUTH_EMULATOR_HOST', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) delete process.env[k];
const fs = require('fs');
const [priorIndex, mode, worldFile, outFile, eventFile] = process.argv.slice(2);
const { makeHonestDb } = require('../_honest-rtdb-model');
const bodies = [];
const webpush = require('web-push');
webpush.sendNotification = async (sub, payload) => { try { bodies.push(JSON.parse(payload).body); } catch (_) { bodies.push(null); } return { statusCode: 201 }; };
const DB = makeHonestDb(JSON.parse(fs.readFileSync(worldFile, 'utf8')));
require('firebase-admin/database').getDatabase = () => DB;
const idx = require(priorIndex);
const snap = (v) => ({ val: () => (v == null ? null : JSON.parse(JSON.stringify(v))), exists: () => v != null });
(async () => {
  const c = console.log; console.log = () => {};   // the prior code's own log lines are not this cell's subject
  try {
    if (mode === 'notify') { const ev = JSON.parse(fs.readFileSync(eventFile, 'utf8')); await idx.notifyStaffOnNewOrder.run({ data: { before: snap(null), after: snap(ev.after) }, params: { orderId: ev.orderId } }); }
    else await idx.flushStaffPushQueue.run({});
  } finally { console.log = c; }
  fs.writeFileSync(outFile, JSON.stringify({ bodies, root: DB.root }));
  process.exit(0);
})().catch((e) => { console.error(e && e.message); process.exit(1); });
