/**
 * Behavioral suite for the B2 config rules — the CLIENT-READABLE LIVE FLAG leaf + the staff-only allowlist.
 * Run: firebase emulators:exec --only database --project demo-xpizza "node test/rewards-config-rules.emulator.test.js"
 * (Java on PATH; npm run sync:rules first so the functions copy matches xpizza-reference.)
 *
 * RTDB read grants cascade DOWNWARD and a descendant CANNOT revoke an ancestor grant — so the leaf grant must
 * be at EXACTLY config/rewards_public/redemption_live, never the parent (a parent grant would expose every
 * future sibling). This proves: a customer CAN read the leaf; CANNOT read the parent / a sibling /
 * config/redemption_allowlist / any other config/*; CANNOT write the leaf; and the staff-only config read is
 * intact. Plain-node style, mirroring user-profiles-rules.emulator.test.js.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const CUST = 'u_cccc00000000000000000';

// ── Static rules-inspection (plan-gate #3): properties the emulator CANNOT prove via a write test ──
// A client canary write is denied at .write:false BEFORE .validate runs; an Admin write bypasses rules — so
// ".validate admits canary:true" is a STATIC structural property, not an emulator assertion. Likewise the
// leaf-only grant is a static shape (no .read on the parent). Assert both from the rules source directly.
{
  const R = JSON.parse(RULES).rules;
  assert.strictEqual(R.user_rewards['$uid']['.validate'], '!newData.isString() && !newData.isNumber() && !newData.isBoolean()',
    'user_rewards/$uid .validate must stay OBJECT-ONLY (so an Admin-written canary:true boolean child is structurally admissible)');
  assert.strictEqual(R.config.rewards_public.redemption_live['.read'], true, 'the live-flag leaf must be world-readable (.read:true)');
  assert.ok(!('.read' in R.config.rewards_public), 'config/rewards_public must have NO own .read — leaf-only grant, no cascade to siblings');
  assert.ok(/customer !== true/.test(R.config['.read']), 'config .read must stay staff-only (customers excluded)');
  assert.strictEqual(R.user_rewards['$uid']['.write'], false, 'user_rewards/$uid stays .write:false (canary is Admin-only)');
  console.log('  ok (static) user_rewards/$uid .validate object-only + .write:false; live-flag LEAF-only grant; config staff-only read');
}

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });

  // Admin-seed (rules disabled): the leaf + a sibling under rewards_public + the staff-only allowlist + another config child.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref('config/rewards_public/redemption_live').set(false);
    await db.ref('config/rewards_public/some_future_sibling').set('secret');
    await db.ref('config/redemption_allowlist/' + CUST).set(true);
    await db.ref('config/another_secret').set('x');
  });

  const custDb = env.authenticatedContext(CUST, { customer: true }).database();   // a real customer token
  const staffDb = env.authenticatedContext('disp_1').database();                  // non-customer (token.customer !== true) — staff
  const anonDb = env.unauthenticatedContext().database();

  let n = 0;
  const ok = async (label, pr) => { await assertSucceeds(pr); console.log(`  ok ${++n} ${label}`); };
  const no = async (label, pr) => { await assertFails(pr); console.log(`  ok ${++n} ${label}`); };
  const get = (db, p) => db.ref(p).get();
  const set = (db, p, v) => db.ref(p).set(v);

  // ── the leaf IS customer-readable ──
  await ok('customer CAN read config/rewards_public/redemption_live (the leaf grant)', get(custDb, 'config/rewards_public/redemption_live'));
  await ok('anon CAN read the leaf too (public flag, .read:true)', get(anonDb, 'config/rewards_public/redemption_live'));

  // ── the grant is LEAF-ONLY — no cascade to the parent / siblings / other config ──
  await no('customer CANNOT read the PARENT config/rewards_public (no grant → staff-only)', get(custDb, 'config/rewards_public'));
  await no('customer CANNOT read a SIBLING under rewards_public', get(custDb, 'config/rewards_public/some_future_sibling'));
  await no('customer CANNOT read config/redemption_allowlist (staff-only)', get(custDb, 'config/redemption_allowlist'));
  await no('customer CANNOT read its own allowlist entry', get(custDb, 'config/redemption_allowlist/' + CUST));
  await no('customer CANNOT read config itself', get(custDb, 'config'));
  await no('customer CANNOT read any other config child', get(custDb, 'config/another_secret'));
  await no('anon CANNOT read config itself', get(anonDb, 'config'));

  // ── the leaf is READ-only for clients — write inherits config (dispatchers only) ──
  await no('customer CANNOT write the live flag', set(custDb, 'config/rewards_public/redemption_live', true));
  await no('anon CANNOT write the live flag', set(anonDb, 'config/rewards_public/redemption_live', true));

  // ── staff config read is intact (non-customer token) ──
  await ok('staff (non-customer) CAN read config (unchanged)', get(staffDb, 'config'));
  await ok('staff CAN read the allowlist', get(staffDb, 'config/redemption_allowlist'));
  await ok('staff CAN read the leaf', get(staffDb, 'config/rewards_public/redemption_live'));

  await env.cleanup();
  console.log(`\nrewards-config-rules: ${n} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
