/**
 * PLAN-3a-marketing-server r0 §7 (steps 1–2) — the marketing nodes are SERVER-ONLY under the REAL database rules.
 * Run: npm run test:marketing-rules
 *   marketing_brand (offers + live + ops, PLAN-3a-marketing-brand-root r3) / marketing_usage / platform_config/marketing: seeded by the REAL writers on the Admin
 *   (rules-off) database — the offer by the REAL offers-core, the config by the REAL config writer — then no client token of any
 *   kind (the restaurant's owner, a customer, a handheld, unauthenticated) can read or write any of them.
 * Synthetic tb_ ids only.
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const R = require('../access/roster');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { makeRtdbMirrorReader } = require('../catalog/snapshot-fallback');
const CFG = require('../marketing/config');
const C = require('../marketing/offers-core');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const OWNER = 'ownerMkR01';
const K1 = 'i_aaaaaaaaaaaa';
const NOW = Date.UTC(2026, 10, 16, 18);
let n = 0; let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ marketing-rules: exited without completing (a hang)\n'); process.exitCode = 1; } });

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-mkt', database: { rules: RULES } });
  const no = async (label, pr) => { try { await assertFails(pr); } catch (e) { throw new Error(`${label} — ${e && e.message}`); } console.log(`  ✓ ${++n} ${label}`); };
  try {
    let offerId = null;
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await db.ref('/').set(null);
      await db.ref('brands/tb').set({ name: 'TB', active: true, locations: { tb_centro: 'member' }, activation: { state: 'on', since: 1 } });
      await db.ref('restaurants/tb_centro/identity').set({ brand_id: 'tb', name: 'Centro', active: true, version: 1 });
      assert.strictEqual((await R.mutateRoster({ db, now: () => 1 }, 'tb', { kind: 'cli', operator: 'op' }, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'D', email: 'd@tb.hn' } })).ok, true, 'premise: roster');
      await makeRtdbMirror(db)('tb_centro', { version: 'v1', seq: 1, rid: 'tb_centro', menu: { [K1]: 150 }, extras: {} });
      assert.strictEqual((await CFG.writeMarketingConfig(db, { expected: 0, config: { offers_enabled: true, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } }, actor: 'cli:op', now: 1 })).ok, true, 'premise: config');
      const deps = { db, verifyIdToken: async () => ({ uid: OWNER }), now: () => NOW, readMirror: makeRtdbMirrorReader(db) };
      const rq = (body) => ({ method: 'POST', body, get: (h) => (h === 'authorization' ? 'Bearer t' : undefined) });
      const s = await C.marketingOfferSaveCore(deps, rq({ rid: 'tb_centro', expected_rev: 0, offer: { name: 'Prueba', type: 'bogo', params: { items: [K1], free_per_order: 1 }, audience: 'all', branches: ['tb_centro'],
        schedule: { start: NOW + 86400000, days: [5], window: { from: 1260, to: 0 } } } }));
      assert.strictEqual(s.status, 200, `premise: the real core created the offer (${JSON.stringify(s.body)})`);
      offerId = s.body.offer.id;
      const p = await C.marketingOfferSetStateCore(deps, rq({ rid: 'tb_centro', offer_id: offerId, to: 'active', expected_rev: 1 }));
      assert.strictEqual(p.status, 200, 'premise: published (the live mirror exists)');
      assert.ok((await db.ref(`marketing_brand/tb/live/tb_centro/${offerId}`).get()).exists(), 'premise: the mirror landed');
    });
    const ctxs = [
      ['the brand OWNER', env.authenticatedContext(OWNER).database()],
      ['a CUSTOMER', env.authenticatedContext('custMkR01', { customer: true }).database()],
      ['a HANDHELD', env.authenticatedContext(OWNER, { handheld: true }).database()],
      ['unauthenticated', env.unauthenticatedContext().database()],
    ];
    const paths = ['marketing_brand', 'marketing_brand/tb', 'marketing_brand/tb/offers', `marketing_brand/tb/offers/${offerId}`, 'marketing_brand/tb/live', 'marketing_brand/tb/live/tb_centro', `marketing_brand/tb/live/tb_centro/${offerId}`, `marketing_usage/${offerId}`, 'platform_config/marketing',
      'anuncio_slots/W2027-03-08', 'anuncio_bookings/tb_centro', 'anuncio_bookings/tb_centro/b_aaaaaaaaaaaa',   // step 3: the Anuncio's two nodes
      'marketing_brand/tb/ops', 'marketing_brand/tb/ops/op_kkkkkkkkkkkkkkkkkkkk',   // the create / repeat op_id claims (idempotency)
      'marketing_offers/tb', 'marketing_live_b/tb', 'marketing_offer_ops/tb'];   // the retired roots stay denied until a cleanup
    for (const [who, db] of ctxs) {
      for (const p of paths) {
        await no(`${who} cannot READ ${p.replace(offerId, '<offer>')}`, db.ref(p).get());
        await no(`${who} cannot WRITE ${p.replace(offerId, '<offer>')}`, db.ref(p).set({ x: 1 }));
      }
    }
    FINISHED = true;
    console.log(`marketing-rules: ${n}/${n} ok`);
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    process.exitCode = 1;
  } finally {
    await env.cleanup();
  }
})();
