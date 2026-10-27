#!/usr/bin/env node
'use strict';
// S7a directory — the PRESENTATION writer (PLAN-capp-S7a-r2 §0), on the seed_identity pattern, until the portal writer exists.
// Writes ONLY restaurants/{rid}/presentation, shape-validated by the SHARED assertPresentationShape (the directory's reader
// uses the same shape). Admin SDK; --project REQUIRED; dry-run unless --apply; per field idempotent — an existing field is
// never overwritten unless --force. Every write is read back and compared.
//   node tools/seed-presentation.js --project <id> --file <presentation.json> [--apply] [--force]
//   presentation.json = { "<rid>": { kicker, unit, cuisines, logo_url, logo_wide, hero_url, asset_base, eta_delivery_min,
//                                    eta_pickup_min, payments, pickup, order_id_prefix, house, meals } }
const fs = require('fs');
const { assertPresentationShape } = require('../directory/presentation-shape');
const RID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function parseArgs(argv) {
  const o = { apply: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--force') o.force = true;
    else if (a === '--project') o.project = argv[++i];
    else if (a === '--file') o.file = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.project) throw new Error('--project is required (never inherited)');
  if (!o.file) throw new Error('--file is required');
  return o;
}

// PURE: the per-field plan for one rid → { write: {field: value}, skipped: [field] }
function planFor(current, desired, force) {
  const cur = current && typeof current === 'object' ? current : {};
  const write = {}; const skipped = [];
  for (const [k, v] of Object.entries(desired)) {
    if (cur[k] !== undefined && !force) { skipped.push(k); continue; }
    if (JSON.stringify(cur[k]) === JSON.stringify(v)) { skipped.push(k); continue; }
    write[k] = v;
  }
  return { write, skipped };
}

async function run(db, input, { apply, force }, log = console.log) {
  for (const [rid, p] of Object.entries(input)) {
    if (!RID.test(rid)) throw new Error(`bad rid ${rid}`);
    assertPresentationShape(rid, p);                       // refuse everything if any payload is malformed
  }
  const results = {};
  for (const [rid, p] of Object.entries(input)) {
    const ref = db.ref(`restaurants/${rid}/presentation`);
    const cur = (await ref.once('value')).val();
    const { write, skipped } = planFor(cur, p, force);
    results[rid] = { write: Object.keys(write), skipped };
    log(`[presentation] ${rid}: write ${Object.keys(write).join(',') || '-'}; skip ${skipped.join(',') || '-'}${apply ? '' : ' (dry-run)'}`);
    if (!apply || !Object.keys(write).length) continue;
    await ref.update(write);
    const back = (await ref.once('value')).val() || {};
    for (const [k, v] of Object.entries(write)) if (JSON.stringify(back[k]) !== JSON.stringify(v)) throw new Error(`${rid}: read-back mismatch on ${k}`);
  }
  return results;
}

module.exports = { parseArgs, planFor, run };

if (require.main === module) {
  (async () => {
    const o = parseArgs(process.argv.slice(2));
    require('./emu-mixed-guard')('seed-presentation');
    const admin = require('firebase-admin');
    admin.initializeApp({ projectId: o.project, databaseURL: process.env.FB_DATABASE_URL });
    const input = JSON.parse(fs.readFileSync(o.file, 'utf8'));
    await run(admin.database(), input, o);
    process.exit(0);
  })().catch((e) => { console.error(`[presentation] ${e.message}`); process.exit(1); });
}
