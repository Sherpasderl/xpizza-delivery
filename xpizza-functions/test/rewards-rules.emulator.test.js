/**
 * Behavioral suite for the Rewards Phase A RTDB rules (user_rewards + reward_welcome).
 * Run: firebase emulators:exec --only database --project demo-xpizza "node test/rewards-rules.emulator.test.js"
 * (Java on PATH; npm run sync:rules first so the functions copy matches xpizza-reference.)
 *
 * Covers — the whole fraud surface is that these are Admin-SDK-write-ONLY:
 *   A — user_rewards/$uid is read-OWN (auth.uid === $uid); others + anon denied.
 *   B — a client CANNOT write its own user_rewards (balance / ledger push / scalar) — Admin SDK only.
 *   C — reward_welcome is fully deny-all (read + write) to every client (the un-farmable welcome tombstone).
 * Plain-node style (no jest), mirroring user-profiles-rules.emulator.test.js.
 */
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const A = 'u_aaaa00000000000000000';
const B = 'u_bbbb00000000000000000';

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });

  // Admin-seed (rules disabled) — the FULL Phase-B1 shape rewards-reserve.js writes: balance/lifetime/reserved
  // + a deterministic-key ledger + a reservations/{orderId} record. Confirms the $uid .validate (object)
  // ADMITS the child shape (the seed succeeds) and the .read-own / .write:false spine still holds over it.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref(`user_rewards/${A}/x_pizza`).set({
      balance: 2, lifetime: 2, reserved: 8,
      ledger: { L1: { type: 'earn', delta: 2, ts: 1, config_version: 1 }, rsv_PZX1_1: { type: 'reserve', delta: 0, cost: 8, order_id: 'PZX1', state: 'reserved', ts: 1 } },
      reservations: { PZX1: { state: 'reserved', cost: 8, fp: 'abc', order_fingerprint: 'of', config_version: 1, attempt_id: null, hosted_expires_at: null, created_at: 1, updated_at: 1, seq: 1, canonical: { restaurant_id: 'x_pizza', model: 'discount', cost: 8, discount_cents: 29900, free_item_key: 'Margherita' } } },
    });
    await ctx.database().ref('reward_welcome/ph_seed/x_pizza').set(1700000000000);
  });

  const aDb = env.authenticatedContext(A).database();
  const bDb = env.authenticatedContext(B).database();
  const anonDb = env.unauthenticatedContext().database();

  let n = 0;
  const ok = async (label, pr) => { await assertSucceeds(pr); console.log(`  ok ${++n} ${label}`); };
  const no = async (label, pr) => { await assertFails(pr); console.log(`  ok ${++n} ${label}`); };
  const get = (db, p) => db.ref(p).get();
  const set = (db, p, v) => db.ref(p).set(v);
  const upd = (db, p, v) => db.ref(p).update(v);

  // ── A: read-own ──
  await ok('A owner reads its own user_rewards', get(aDb, `user_rewards/${A}`));
  await ok('A owner reads its own per-brand node', get(aDb, `user_rewards/${A}/x_pizza`));
  await no('A a different authed user CANNOT read another\'s user_rewards', get(bDb, `user_rewards/${A}`));
  await no('A anon CANNOT read user_rewards', get(anonDb, `user_rewards/${A}`));

  // ── B: no client write (Admin SDK only — the fraud surface) ──
  await no('B owner CANNOT set() its balance', set(aDb, `user_rewards/${A}/x_pizza/balance`, 999));
  await no('B owner CANNOT update() balance+lifetime', upd(aDb, `user_rewards/${A}/x_pizza`, { balance: 999, lifetime: 999 }));
  await no('B owner CANNOT push a ledger entry', set(aDb, `user_rewards/${A}/x_pizza/ledger/forged`, { type: 'earn', delta: 999, ts: 2, config_version: 1 }));
  await no('B owner CANNOT write a whole per-brand object', set(aDb, `user_rewards/${A}/la_musa`, { balance: 100, lifetime: 100 }));
  await no('B owner CANNOT write a scalar at the $uid node (.validate rejects scalar)', set(aDb, `user_rewards/${A}`, 5));
  await no('B a different user CANNOT write into another\'s user_rewards', set(bDb, `user_rewards/${A}/x_pizza/balance`, 999));

  // ── B2 (Phase B1): the reservations + rsv_ ledger child shape inherits the SAME spine ──
  await ok('B2 owner reads its own reservations subtree', get(aDb, `user_rewards/${A}/x_pizza/reservations`));
  await ok('B2 owner reads a specific reservation record (its own hold)', get(aDb, `user_rewards/${A}/x_pizza/reservations/PZX1`));
  await ok('B2 owner reads its reserved counter + rsv_ ledger (validate admits the Admin-written shape)', get(aDb, `user_rewards/${A}/x_pizza/reserved`));
  await no('B2 a different user CANNOT read another\'s reservations', get(bDb, `user_rewards/${A}/x_pizza/reservations`));
  await no('B2 anon CANNOT read reservations', get(anonDb, `user_rewards/${A}/x_pizza/reservations`));
  await no('B2 owner CANNOT forge a reservation (write:false — Admin-only spine)', set(aDb, `user_rewards/${A}/x_pizza/reservations/FORGED`, { state: 'reserved', cost: 8 }));
  await no('B2 owner CANNOT tamper a reservation cost', set(aDb, `user_rewards/${A}/x_pizza/reservations/PZX1/cost`, 0));
  await no('B2 owner CANNOT set the reserved counter', set(aDb, `user_rewards/${A}/x_pizza/reserved`, 0));
  await no('B2 owner CANNOT push an rsv_ ledger entry', set(aDb, `user_rewards/${A}/x_pizza/ledger/rsv_forged_1`, { type: 'redeem', delta: -8, ts: 2 }));

  // ── C: reward_welcome fully deny-all (un-farmable tombstone) ──
  await no('C client CANNOT read reward_welcome', get(aDb, 'reward_welcome/ph_seed/x_pizza'));
  await no('C anon CANNOT read reward_welcome', get(anonDb, 'reward_welcome/ph_seed/x_pizza'));
  await no('C client CANNOT write reward_welcome (forge a tombstone to block/farm)', set(aDb, 'reward_welcome/ph_seed/x_pizza', null));
  await no('C client CANNOT create a reward_welcome tombstone', set(aDb, 'reward_welcome/ph_new/x_pizza', 1));

  await env.cleanup();
  console.log(`\nrewards-rules: ${n} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
