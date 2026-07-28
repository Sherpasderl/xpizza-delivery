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

  // Admin-seed (rules disabled) — the shape rewards-earn.js writes: balance/lifetime + a ledger push.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref(`user_rewards/${A}/x_pizza`).set({ balance: 2, lifetime: 2, ledger: { L1: { type: 'earn', delta: 2, ts: 1, config_version: 1 } } });
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

  // ── C: reward_welcome fully deny-all (un-farmable tombstone) ──
  await no('C client CANNOT read reward_welcome', get(aDb, 'reward_welcome/ph_seed/x_pizza'));
  await no('C anon CANNOT read reward_welcome', get(anonDb, 'reward_welcome/ph_seed/x_pizza'));
  await no('C client CANNOT write reward_welcome (forge a tombstone to block/farm)', set(aDb, 'reward_welcome/ph_seed/x_pizza', null));
  await no('C client CANNOT create a reward_welcome tombstone', set(aDb, 'reward_welcome/ph_new/x_pizza', 1));

  await env.cleanup();
  console.log(`\nrewards-rules: ${n} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
