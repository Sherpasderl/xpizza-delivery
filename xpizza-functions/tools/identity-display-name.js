#!/usr/bin/env node
'use strict';
// R3-FIX D12 — the OWNER's display-name CLI. DRY RUN unless --apply.
//
//   node tools/identity-display-name.js --project <id> status                       ← every restaurant, read-only
//   node tools/identity-display-name.js --project <id> set <rid> "<name>" [--apply]  ← e.g. set x_pizza "X. Pizza"
//   node tools/identity-display-name.js --project <id> delete <rid> [--apply]        ← back to the config name
//
// Writes ONLY restaurants/{rid}/identity/display_name — the brand as customers see it, which the pickup line on the
// tracker reads ("Recoger en X. Pizza"). Status prints, per restaurant, the name, the display name and the pickup line
// it yields. The set is refused unless the restaurant's identity is ROUTING-VALID (never writes into or creates a partial one).
// --project must be the explicit flag: an inherited GOOGLE_CLOUD_PROJECT is refused, for status and writes alike.
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
// FIRST, and as an explicit FLAG (codex D12 r1 P2-1): an inherited GOOGLE_CLOUD_PROJECT must never reach --apply
const PROJECT_ID = requireProject({ requireFlag: true });
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const { discoverRestaurants } = require('./client-floor-admin');
const { makeFirestoreRegistryReader } = require('../catalog/restaurant-registry');
const { readIdentity, planDisplayName, applyDisplayName } = require('./identity-display-name-admin');
const { pickupLabel } = require('../pickup-label');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--project') && a !== PROJECT_ID);
const APPLY = args.includes('--apply');
const pos = args.filter((a) => !a.startsWith('--'));
const usage = () => { console.error('usage: identity-display-name.js --project <id> (status | set <rid> "<name>" | delete <rid>) [--apply]'); process.exit(2); };

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
const rtdb = admin.database();

(async () => {
  if (pos[0] === 'status') {
    const { rids, registryOk, registryError } = await discoverRestaurants(rtdb, () => makeFirestoreRegistryReader(admin.firestore())());
    const rows = {};
    for (const rid of rids) { const c = (await readIdentity(rtdb, rid)) || {}; rows[rid] = { name: c.name ?? null, display_name: c.display_name ?? null, pickup_line: pickupLabel(c.display_name, c.name) }; }
    console.log(JSON.stringify({ project: PROJECT_ID, registry: registryOk ? 'ok' : `FAILED: ${registryError}`, restaurants: rows }, null, 2));
    process.exit(0);
  }
  const [op, rid, value] = pos;
  if (!['set', 'delete'].includes(op) || !rid || (op === 'set' && value === undefined)) usage();
  const plan = planDisplayName({ op, rid, value, current: await readIdentity(rtdb, rid) });
  if (!plan.ok) { console.error(`identity-display-name: REFUSED — ${plan.error}`); process.exit(1); }
  console.log(`identity-display-name ${APPLY ? 'APPLY' : 'DRY RUN'} — project ${PROJECT_ID}`);
  console.log(`  ${plan.row.path}: ${JSON.stringify(plan.row.from)} → ${JSON.stringify(plan.row.to)}`);
  console.log(`  pickup line: "${plan.label.before}" → "${plan.label.after}"`);
  if (!APPLY) { console.log('(dry run — nothing written; add --apply)'); process.exit(0); }
  const res = await applyDisplayName(rtdb, plan);
  if (!res.ok) { console.error(`identity-display-name: READ-BACK MISMATCH — read ${JSON.stringify(res.back)}`); process.exit(1); }
  console.log('identity-display-name: applied and read back');
  process.exit(0);
})().catch((e) => { console.error('identity-display-name FAILED:', e && e.message); process.exit(1); });
