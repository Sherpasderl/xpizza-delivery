#!/usr/bin/env node
'use strict';
// BRAND-AGNOSTIC SERVER B1 (PLAN-brand-agnostic-server r0 §1.2) — the OWNER's factura-flag projection CLI. DRY RUN unless --apply.
//
//   node tools/identity-factura-flag.js --project <id>            ← plan: which identities would change (read-only)
//   node tools/identity-factura-flag.js --project <id> --apply    ← write the planned leaves, then read every identity back
//
// Projects factura/eligibility's FACTURA_PLATFORM_RESTAURANTS (OWNER RULE: only X. Pizza issues facturas) onto
// restaurants/{rid}/identity/uses_platform_factura: `true` for a platform-factura restaurant, ABSENT for every other one.
// Admin bypasses the rules (clients cannot create, change or remove the flag). Exit 1 on a read-back mismatch or a
// platform-factura restaurant without an identity node. --project must be the explicit flag (an inherited
// GOOGLE_CLOUD_PROJECT is refused, for the dry run and --apply alike).
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const { discoverRestaurants } = require('./client-floor-admin');
const { makeFirestoreRegistryReader } = require('../catalog/restaurant-registry');
const { readIdentities, planFlags, applyFlags, readBack } = require('./identity-factura-flag-core');

const APPLY = process.argv.slice(2).includes('--apply');

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
const rtdb = admin.database();

(async () => {
  const { rids, registryOk, registryError } = await discoverRestaurants(rtdb, () => makeFirestoreRegistryReader(admin.firestore())());
  if (!registryOk) console.warn(`identity-factura-flag: registry read FAILED (${registryError}) — using the RTDB restaurant keys only`);
  const { rows, missing } = planFlags(await readIdentities(rtdb, rids));
  console.log(`identity-factura-flag ${APPLY ? 'APPLY' : 'DRY RUN'} — project ${PROJECT_ID} — ${rids.length} restaurants, ${rows.length} change(s)`);
  for (const r of rows) console.log(`  ${r.path}: ${JSON.stringify(r.from)} → ${r.to === null ? 'ABSENT' : JSON.stringify(r.to)}`);
  if (missing.length) { console.error(`identity-factura-flag: REFUSED — no identity node for platform-factura restaurant(s) ${missing.join(', ')}`); process.exit(1); }
  if (!APPLY) { console.log('(dry run — nothing written; add --apply)'); process.exit(0); }
  const { unversioned } = await applyFlags(rtdb, rows);
  if (unversioned.length) { console.error(`identity-factura-flag: REFUSED — identity without a numeric version: ${unversioned.join(', ')} (nothing written for it)`); process.exit(1); }
  const problems = await readBack(rtdb, rids);
  if (problems.length) { console.error('identity-factura-flag: READ-BACK MISMATCH'); for (const p of problems) console.error(`  ${p}`); process.exit(1); }
  console.log('identity-factura-flag: applied and read back (every identity carries the projected value)');
  process.exit(0);
})().catch((e) => { console.error('identity-factura-flag FAILED:', e && e.message); process.exit(1); });
