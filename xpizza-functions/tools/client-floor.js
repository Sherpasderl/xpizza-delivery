#!/usr/bin/env node
'use strict';
// P-SELFUPDATE — the OWNER's floor CLI. DRY RUN unless --apply.
//
//   node tools/client-floor.js --project <id> kitchen set|raise <N> [--apply] [--force]
//   node tools/client-floor.js --project <id> kitchen delete [--apply]        ← the KITCHEN KILL SWITCH (all restaurants)
//   node tools/client-floor.js --project <id> orders  set|raise <N> [--apply] [--force]
//   node tools/client-floor.js --project <id> orders  delete [--apply]        ← the HTTP floor OFF (instances re-read within one TTL)
//   node tools/client-floor.js --project <id> status                          ← every floor, read-only
//
// Kitchen: ONE multi-path update covering every restaurant (the registry ∪ every RTDB restaurant ∪ every existing floor
// node). set/raise REFUSE if the registry cannot be read; delete needs RTDB only. Verified by a full RTDB re-scan.
// Rollback ordering (PLAN §6): to undo D4-c, FIRST restore server/data behaviour compatible with older pages, THEN lower
// or delete floors; the kitchen kill switch may be used at any time if the rule itself misbehaves.
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject();      // FIRST: states the project, before any client is constructed
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const { planFloor, discoverRestaurants, readCurrent, applyPlan, ORDERS_PATH } = require('./client-floor-admin');
const { PLATFORM } = require('../platform-manifest');
const { makeFirestoreRegistryReader } = require('../catalog/restaurant-registry');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--project') && a !== PROJECT_ID);
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const pos = args.filter((a) => !a.startsWith('--'));
const usage = () => { console.error('usage: client-floor.js --project <id> (kitchen|orders) (set|raise <N> | delete) [--apply] [--force] | status'); process.exit(2); };

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
const rtdb = admin.database();

(async () => {
  // discovery: registry ∪ every RTDB restaurant key ∪ every existing floor node; a registry failure is REPORTED (codex B1)
  const disc = await discoverRestaurants(rtdb, () => makeFirestoreRegistryReader(admin.firestore())());
  const { rids, floorKeys, registryOk } = disc;
  if (!registryOk) console.error(`client-floor: WARNING — restaurant registry discovery failed (${disc.registryError}); set/raise will be refused, delete covers every floor node found in RTDB`);
  if (pos[0] === 'status') {
    const k = await readCurrent(rtdb, 'kitchen', rids, floorKeys);
    const o = await readCurrent(rtdb, 'orders', rids);
    console.log(JSON.stringify({ project: PROJECT_ID, registry: registryOk ? 'ok' : `FAILED: ${disc.registryError}`, kitchen: k, orders: o[ORDERS_PATH], compat: PLATFORM.compat.generations }, null, 2));
    process.exit(0);
  }
  const [kind, op, raw] = pos;
  if (!kind || !op || (op !== 'delete' && raw === undefined)) usage();
  const value = op === 'delete' ? null : Number(raw);
  const current = await readCurrent(rtdb, kind, rids, floorKeys);
  const plan = planFloor({ kind, op, value, current, rids, floorKeys, registryOk, maxCompat: PLATFORM.maxCompat(kind), force: FORCE });
  if (!plan.ok) { console.error(`client-floor: REFUSED — ${plan.error}`); process.exit(1); }
  console.log(`client-floor ${APPLY ? 'APPLY' : 'DRY RUN'} — project ${PROJECT_ID}, ${kind} ${op}${value === null ? '' : ` ${value}`}`);
  for (const r of plan.rows) console.log(`  ${r.path}: ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}`);
  if (!APPLY) { console.log('(dry run — nothing written; add --apply)'); process.exit(0); }
  const res = await applyPlan(rtdb, plan, { kind, target: value });
  if (!res.ok) { console.error(`client-floor: READ-BACK MISMATCH — ${res.mismatched.join('; ')}`); process.exit(1); }
  console.log(`client-floor: applied in ONE update and read back (${plan.rows.length} path(s))`);
  process.exit(0);
})().catch((e) => { console.error('client-floor FAILED:', e && e.message); process.exit(1); });
