/*
 * Emulator rule suite for kds_cancel_acks/{orderId} — the KDS cancelados cross-device archive ack.
 * Run: npm run test:kds-cancel-acks   (tools/emulator-run.js --only database)
 *
 * The node is the shared SERVER truth that makes "Archivar" sync across a 2-device kitchen (a cancelled order
 * has no server terminal flag, so the old per-device localStorage ack never synced). Rule contract:
 *   • a KITCHEN-role user (flat /kitchen/{uid} member — the load-bearing KDS contract, same check as the
 *     orders-status write) CAN read the map, write an ack {at,by}, and DELETE one (the recall un-archive);
 *   • a non-kitchen authed user and an unauthenticated user CANNOT read or write;
 *   • the value shape is validated: `at` required (number|string), `by` string-only, no extra keys;
 *   • the kitchen role does NOT escalate — it still cannot write /orders beyond status.
 */
require('./_emulator-required')('database');   // refuse if the emulator host vars are unset (would hit real infra)

const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(
  path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'),
  'utf8',
);

const KUSER = 'kuser-uid';   // a flat /kitchen member — the KDS actor
const OUT = 'out-uid';       // authenticated, no role at all

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'demo-xpizza-kca-rules',
    database: { rules: RULES },
  });

  // Seed roles + fixtures with rules disabled.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref('kitchen/' + KUSER).set(true);                                   // flat kitchen membership
    await db.ref('orders/O1').set({ status: 'new', payment_method: 'cash', payment_status: 'none' });
    await db.ref('kds_cancel_acks/SEED').set({ at: 1, by: KUSER });               // an existing ack for read tests
  });

  const kDb = env.authenticatedContext(KUSER).database();
  const outDb = env.authenticatedContext(OUT).database();
  const anonDb = env.unauthenticatedContext().database();

  const get = (db, p) => db.ref(p).get();
  const set = (db, p, v) => db.ref(p).set(v);

  let n = 0;
  const ok = async (label, pr) => { await assertSucceeds(pr); console.log(`  ✓ ${++n} ${label}`); };
  const no = async (label, pr) => { await assertFails(pr); console.log(`  ✓ ${++n} ${label}`); };

  // ── kitchen CAN read / write / delete ──
  await ok('kitchen writes kds_cancel_acks/{id} = {at,by}', set(kDb, 'kds_cancel_acks/PZX-1', { at: 1, by: KUSER }));
  await ok('kitchen writes {at} only (by optional)', set(kDb, 'kds_cancel_acks/PZX-2', { at: 2 }));
  await ok('kitchen reads the kds_cancel_acks map (the subscription)', get(kDb, 'kds_cancel_acks'));
  await ok('kitchen reads one ack', get(kDb, 'kds_cancel_acks/SEED'));
  await ok('kitchen DELETEs an ack (recall un-archive, set null)', set(kDb, 'kds_cancel_acks/PZX-1', null));

  // ── .validate: {at,by} shape, no extra keys ──
  await no('missing `at` → DENIED (.validate hasChild at)', set(kDb, 'kds_cancel_acks/PZX-3', { by: KUSER }));
  await no('`at` as an object → DENIED (number|string only)', set(kDb, 'kds_cancel_acks/PZX-3', { at: { x: 1 } }));
  await no('`by` as a non-string → DENIED', set(kDb, 'kds_cancel_acks/PZX-3', { at: 1, by: 123 }));
  await no('an EXTRA key → DENIED ($other:false, no tamper surface)', set(kDb, 'kds_cancel_acks/PZX-3', { at: 1, by: KUSER, evil: true }));

  // ── non-kitchen + unauth DENIED ──
  await no('non-kitchen authed user WRITES → DENIED', set(outDb, 'kds_cancel_acks/PZX-9', { at: 1 }));
  await no('non-kitchen authed user READS → DENIED', get(outDb, 'kds_cancel_acks'));
  await no('unauthenticated WRITES → DENIED', set(anonDb, 'kds_cancel_acks/PZX-9', { at: 1 }));
  await no('unauthenticated READS → DENIED', get(anonDb, 'kds_cancel_acks'));

  // ── no escalation: the kitchen role still cannot write /orders beyond status ──
  await ok('kitchen writes /orders/{id}/status (existing load-bearing contract)', set(kDb, 'orders/O1/status', 'preparing'));
  await no('kitchen writes a NON-status /orders field → DENIED (no escalation via the ack node)', set(kDb, 'orders/O1/total', 999));

  await env.cleanup();
  console.log(`kds-cancel-acks-rules: OK (${n} cases)`);
})().catch((e) => { console.error(e); process.exit(1); });
