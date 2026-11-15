/**
 * PLAN-3a-capp-push-tokens r0 §4 — customer_push_tokens + customer_push_prefs are SERVER-ONLY under the REAL database rules.
 * Run: npm run test:push-rules
 *   Seeded by the REAL callables (customer-push makeCustomerPush registerCustomerPushToken, on the Admin — rules-off — database), then
 *   NO client of any kind (the owner customer, another customer, staff, unauthenticated) can read, query or write either node, at
 *   any depth. Synthetic ids only.
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
const CP = require('../customer-push');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const U = 'u_' + 'c'.repeat(24), U2 = 'u_' + 'd'.repeat(24);
const TOKEN = 'fcm_rules_device_' + 'z'.repeat(40);
let n = 0; let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ push-rules: exited without completing (a hang)\n'); process.exitCode = 1; } });

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-push', database: { rules: RULES } });
  const no = async (label, pr) => { try { await assertFails(pr); } catch (e) { throw new Error(`${label} — ${e && e.message}`); } console.log(`  ✓ ${++n} ${label}`); };
  try {
    const hash = CP.hashOf(TOKEN);
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await db.ref('/').set(null);
      const h = CP.makeCustomerPush({ getDatabase: () => db, getAuth: () => ({ verifyIdToken: async () => ({ uid: U, customer: true }) }), checkRateLimit: async () => ({ allowed: true }), now: () => 1_800_000_000_000 });
      const res = { set() { return res; }, status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } };
      await h.registerCustomerPushToken({ method: 'POST', query: { context: 'platform' }, body: { token: TOKEN, platform: 'ios', app_build: '1.0.0', install_id: 'inst_rules_' + 'q'.repeat(16), pedidos: true, promociones: true }, get: () => 'id-token' }, res);
      assert.deepStrictEqual([res.code, res.body && res.body.ok], [200, true], `premise: the REAL callable registered (${JSON.stringify(res.body)})`);
      assert.ok((await db.ref(`customer_push_tokens/${hash}`).get()).exists() && (await db.ref(`customer_push_prefs/${U}`).get()).exists(), 'premise: both nodes seeded');
    });
    const ctxs = [
      ['the OWNER customer', env.authenticatedContext(U, { customer: true }).database()],
      ['another customer', env.authenticatedContext(U2, { customer: true }).database()],
      ['staff', env.authenticatedContext('disp_1').database()],
      ['unauthenticated', env.unauthenticatedContext().database()],
    ];
    const paths = ['customer_push_tokens', `customer_push_tokens/${hash}`, `customer_push_tokens/${hash}/token`, 'customer_push_prefs', `customer_push_prefs/${U}`, `customer_push_prefs/${U}/offers_consent`, 'customer_push_drain', `customer_push_drain/${U}`];
    for (const [who, db] of ctxs) {
      for (const p of paths) {
        await no(`${who} cannot READ ${p.replace(hash, '<hash>')}`, db.ref(p).get());
        await no(`${who} cannot WRITE ${p.replace(hash, '<hash>')}`, db.ref(p).set({ x: 1 }));
      }
      await no(`${who} cannot QUERY customer_push_tokens by uid`, db.ref('customer_push_tokens').orderByChild('uid').equalTo(U).get());
    }
    FINISHED = true;
    console.log(`push-rules: ${n}/${n} ok`);
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    process.exitCode = 1;
  } finally {
    await env.cleanup();
  }
})();
