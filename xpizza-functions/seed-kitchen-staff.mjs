'use strict';
// ── seed-kitchen-staff — OWNER-RUN migration: flat /kitchen/{uid} → per-restaurant kitchen_staff ──
// (KDS Phase 2b · Slice 3 · KDS_2B_PLAN.md §10 [R4 #3] "REQUIRED sequenced migration")
//
// ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
// ║  SEQUENCING — DO NOT DEVIATE (a wrong order LOCKS OUT live kitchen staff):                      ║
// ║    1. RUN THIS SEED  ── node seed-kitchen-staff.mjs --commit                                    ║
// ║         → populates /restaurants/{rid}/kitchen_staff/{uid} for BOTH restaurants.                ║
// ║    2. VERIFY  a real signed-in KDS user can WRITE /restaurants/{rid}/item_availability/{key}    ║
// ║         (i.e. their uid now resolves as kitchen_staff on both x_pizza AND la_musa).             ║
// ║    3. ONLY THEN deploy the tightened RTDB rule that binds availability writes to kitchen_staff. ║
// ║  NEVER deploy the tightened write-rule BEFORE this seed lands — that denies every live staffer  ║
// ║  the Disponibilidad toggle. Seed → verify → tighten. Not the other way around.                 ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
//
// DECISION (coordinator-confirmed): the default seeds ALL current /kitchen/{uid} users into BOTH
// restaurants' lists (x_pizza + la_musa) — matches the single-operator (Sherpa) reality and guarantees
// no staff lockout. There is no per-restaurant staff split modeled anywhere today (auth is flat
// /kitchen/{uid}; membership is existence + truthy, per xpizza-delivery.js isKitchen()).
//
// SAFETY / shape (mirrors seed_identity.js + publish-menus.mjs):
//   • Idempotent: skips any {rid}/kitchen_staff/{uid} that already exists (never clobbers).
//   • DEFAULT = dry-run: reads live state, PRINTS what it WOULD write for BOTH restaurants, writes NOTHING.
//     With --commit: writes `true` for each missing uid (Admin SDK bypasses rules — an owner action).
//   • Only truthy /kitchen/{uid} entries are seeded (matches isKitchen(): v !== false/null/0/'').
//   • Touches ONLY /restaurants/{rid}/kitchen_staff — never /kitchen, /identity, or /factura_config.
//
// Config (same as seed_identity.js): GOOGLE_APPLICATION_CREDENTIALS (applicationDefault) + FB_DATABASE_URL.
// For a credential-free DRY demonstration, set SEED_KITCHEN_UIDS="uidA,uidB" to inject the source uids
// (skips the live /kitchen read) — used by seed-kitchen-staff.test.mjs.
//   node seed-kitchen-staff.mjs            # dry-run: read + print plan for both restaurants, no write
//   node seed-kitchen-staff.mjs --commit   # owner: write /restaurants/{rid}/kitchen_staff/{uid}=true
import { createRequire } from 'node:module';
import { RESTAURANT_IDS } from './menu-extract.mjs';

const COMMIT = process.argv.includes('--commit');
const DB_URL = process.env.FB_DATABASE_URL || 'https://xpizza-delivery-default-rtdb.firebaseio.com';

// isKitchen() truthiness (xpizza-kitchen/xpizza-delivery.js): a member is present AND truthy.
export function isTruthyMember(v) {
  return v !== false && v !== null && v !== 0 && v !== '' && v !== undefined;
}

/**
 * Pure planner (unit-testable, no Firebase): given the source kitchen uids and the CURRENT
 * kitchen_staff membership per restaurant, produce the idempotent write plan for BOTH restaurants.
 * Seeds EVERY kitchen uid into EVERY restaurant; already-present uids are skipped (idempotent).
 * @param {string[]} kitchenUids       truthy /kitchen/{uid} ids
 * @param {Object<string,Set<string>|Object>} existingByRid  rid → set/map of uids already in kitchen_staff
 * @param {string[]} rids              target restaurant ids (defaults to RESTAURANT_IDS)
 * @returns {Object<string,{toWrite:string[],skip:string[]}>}
 */
export function planKitchenStaffSeed(kitchenUids, existingByRid = {}, rids = RESTAURANT_IDS) {
  const has = (rid, uid) => {
    const e = existingByRid[rid];
    if (!e) return false;
    return e instanceof Set ? e.has(uid) : Object.prototype.hasOwnProperty.call(e, uid);
  };
  const plan = {};
  for (const rid of rids) {
    const toWrite = [];
    const skip = [];
    for (const uid of kitchenUids) (has(rid, uid) ? skip : toWrite).push(uid);
    plan[rid] = { toWrite, skip };
  }
  return plan;
}

async function main() {
  // Source uids: live /kitchen read, OR SEED_KITCHEN_UIDS override (credential-free dry demonstration).
  const override = process.env.SEED_KITCHEN_UIDS;
  let kitchenUids;
  let existingByRid = {};
  let db = null;

  if (override && !COMMIT) {
    kitchenUids = override.split(',').map((s) => s.trim()).filter(Boolean);
    console.log(`[seed-ks] source = SEED_KITCHEN_UIDS override (${kitchenUids.length} uids) — no Firebase read`);
    for (const rid of RESTAURANT_IDS) existingByRid[rid] = new Set(); // assume empty for the demonstration
  } else {
    const require = createRequire(import.meta.url);
    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DB_URL });
    db = admin.database();

    const kitchenSnap = await db.ref('kitchen').once('value');
    const kitchenVal = kitchenSnap.val() || {};
    kitchenUids = Object.keys(kitchenVal).filter((uid) => isTruthyMember(kitchenVal[uid]));
    console.log(`[seed-ks] source = /kitchen (${kitchenUids.length} truthy members) → ${DB_URL}`);

    for (const rid of RESTAURANT_IDS) {
      const snap = await db.ref(`restaurants/${rid}/kitchen_staff`).once('value');
      existingByRid[rid] = new Set(Object.keys(snap.val() || {}));
    }
  }

  if (kitchenUids.length === 0) {
    console.error('[seed-ks] ABORT — no truthy /kitchen members found; nothing to seed (refusing to write an empty set).');
    process.exit(1);
  }

  const plan = planKitchenStaffSeed(kitchenUids, existingByRid);

  let totalToWrite = 0;
  for (const rid of RESTAURANT_IDS) {
    const { toWrite, skip } = plan[rid];
    totalToWrite += toWrite.length;
    console.log(`[seed-ks] ${rid}: ${toWrite.length} to write${toWrite.length ? ' [' + toWrite.join(', ') + ']' : ''}, ${skip.length} already present (skip)`);
  }

  if (!COMMIT) {
    console.log(`[seed-ks] DRY-RUN — would write ${totalToWrite} kitchen_staff entries across ${RESTAURANT_IDS.length} restaurants (${RESTAURANT_IDS.join(', ')}). Re-run with --commit to apply.`);
    console.log('[seed-ks] REMINDER: seed → verify a real KDS user can write item_availability → THEN deploy the tightened rule.');
    process.exit(0);
  }

  // --commit: idempotent writes (Admin SDK bypasses rules). Only the missing uids; existing left untouched.
  for (const rid of RESTAURANT_IDS) {
    for (const uid of plan[rid].toWrite) {
      await db.ref(`restaurants/${rid}/kitchen_staff/${uid}`).set(true);
      console.log(`[seed-ks] wrote restaurants/${rid}/kitchen_staff/${uid} = true`);
    }
  }
  console.log(`[seed-ks] done — wrote ${totalToWrite} entries. NEXT: verify a KDS user can write item_availability, THEN deploy the tightened rule.`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('[seed-ks] FAILED:', e.message); process.exit(1); });
}
