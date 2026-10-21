/**
 * PLAN-portal-membership r3 §7.3 (codex build r1 P2-6) — the cutover's RULES comparison: for every principal × location in
 * the census population, the order-path reads under the base / N-human / N-full rules are IDENTICAL before and after the
 * cutover — the e8e77e24 artifacts with today's legacy grants vs the current artifacts with the backfilled brand_members grants
 * (legacy nodes kept, as the cutover leaves them). Run: npm run test:membership-cutover-rules
 *   The population: MEMBERSHIP_RULES_FIXTURE=<file> (from `membership-admin rules-fixture <file>` against prod) or the built-in
 *   prod-shaped default (1 owner of 2 legacy brands, one kitchen staff each, one dispatcher, no managers).
 */
require('./_emulator-required')('database');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const BASE = 'e8e77e24';
const ROOT = path.join(__dirname, '..', '..');
const legacyBrand = (rid) => ({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
const FX = process.env.MEMBERSHIP_RULES_FIXTURE ? JSON.parse(fs.readFileSync(process.env.MEMBERSHIP_RULES_FIXTURE, 'utf8')) : {
  owners: [{ uid: 'ownerP1', rid: 'x_pizza' }, { uid: 'ownerP1', rid: 'la_musa' }],
  dispatchers: ['dispatch01'], kitchen: [{ uid: 'kitchenA1', rid: 'x_pizza' }, { uid: 'kitchenB1', rid: 'la_musa' }],
  kitchen_global: ['kitchenA1', 'kitchenB1'], brands: { x_pizza: legacyBrand('x_pizza'), la_musa: legacyBrand('la_musa') },
  identities: { x_pizza: { brand_id: null }, la_musa: { brand_id: null } },
};
const RIDS = [...new Set([...FX.owners.map((o) => o.rid), ...FX.kitchen.map((k) => k.rid)])].sort();
const UIDS = [...new Set([...FX.owners.map((o) => o.uid), ...FX.dispatchers, ...FX.kitchen.map((k) => k.uid), 'cmpNobody01'])].sort();

function legacySeed() {
  const s = {};
  for (const d of FX.dispatchers) s[`dispatchers/${d}`] = true;
  for (const k of FX.kitchen_global || []) s[`kitchen/${k}`] = true;
  for (const { uid, rid } of FX.kitchen) s[`restaurants/${rid}/kitchen_staff/${uid}`] = true;
  for (const { uid, rid } of FX.owners) { s[`restaurants/${rid}/owners/${uid}`] = true; s[`owner_restaurants/${uid}/${rid}`] = true; }
  for (const [rid, rec] of Object.entries(FX.brands)) s[`brands/${rid}`] = rec;
  for (const [rid, id] of Object.entries(FX.identities)) if (id && id.brand_id) s[`restaurants/${rid}/identity/brand_id`] = id.brand_id;
  for (const rid of RIDS) {
    s[`orders/O_${rid}`] = { order_id: `O_${rid}`, status: 'preparing', restaurant_id: rid, payment_method: 'cash' };
    s[`order_timelines/O_${rid}/e1`] = { at: 1 };
    s[`kds_cancel_acks/O_${rid}`] = { at: 1, by: 'x' };
  }
  return s;
}
function newSeed() {   // the post-backfill state: legacy nodes untouched + the brand_members grants + the discovery index
  const s = legacySeed();
  for (const { uid, rid } of FX.owners) { s[`brand_members/${rid}/owners/${uid}`] = { granted_at: 1, granted_by: 'cli:cutover' }; s[`member_of/${uid}/brands/${rid}`] = 'owner'; }
  return s;
}
const OPS = {
  rid_query: (db, rid) => db.ref('orders').orderByChild('restaurant_id').equalTo(rid).once('value'),
  point_read: (db, rid) => db.ref(`orders/O_${rid}`).once('value'),
  timeline: (db, rid) => db.ref(`order_timelines/O_${rid}`).once('value'),
  kds_ack_read: (db, rid) => db.ref(`kds_cancel_acks/O_${rid}`).once('value'),
};
async function decisions(rules, seed, label) {
  const env = await initializeTestEnvironment({ projectId: `demo-mcr-${label}`, database: { rules } });
  await env.withSecurityRulesDisabled((ctx) => ctx.database().ref().update(seed));
  const out = {};
  for (const uid of UIDS) {
    const db = env.authenticatedContext(uid, {}).database();
    for (const rid of RIDS) for (const [op, fn] of Object.entries(OPS)) {
      let ok;
      try { await assertSucceeds(fn(db, rid)); ok = 'A'; } catch (_) { try { await assertFails(fn(db, rid)); ok = 'D'; } catch (e) { ok = `ERR:${String(e.message).slice(0, 40)}`; } }
      out[`${uid}|${rid}|${op}`] = ok;
    }
  }
  await env.cleanup();
  return out;
}

(async () => {
  const gitShow = (p) => execFileSync('git', ['show', `${BASE}:${p}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const VARIANTS = [['base', 'xpizza-reference/database.rules.json'], ['N-human', 'xpizza-reference/f2-narrow/N-human.rules.json'], ['N-full', 'xpizza-reference/f2-narrow/N-full.rules.json']];
  let n = 0; let allows = 0;
  for (const [name, file] of VARIANTS) {
    const before = await decisions(gitShow(file), legacySeed(), `${name.toLowerCase()}-old`);
    const after = await decisions(read(file), newSeed(), `${name.toLowerCase()}-new`);
    const diffs = Object.keys(before).filter((k) => before[k] !== after[k]).map((k) => `${k}: ${before[k]} → ${after[k]}`);
    assert.deepStrictEqual(diffs, [], `🔴 ${name}: the cutover changes order-path decisions:\n  ${diffs.join('\n  ')}`);
    assert.ok(!Object.values(after).some((v) => v.startsWith('ERR')), `${name}: every cell decided`);
    allows += Object.values(after).filter((v) => v === 'A').length;
    console.log(`  ✓ ${++n} ${name}: ${Object.keys(after).length} principal × location × op decisions identical before / after the cutover`);
  }
  assert.ok(allows > 0, 'non-vacuity: some reads are ALLOWED (a sandbox denying everything would pass a pure equality)');
  console.log(`membership-cutover-rules.emulator: OK (${n}; population ${UIDS.length} uids × ${RIDS.length} locations${process.env.MEMBERSHIP_RULES_FIXTURE ? ', PROD fixture' : ', built-in prod-shaped fixture'})`);
  process.exit(0);
})().catch((e) => { console.error('membership-cutover-rules.emulator: FAIL\n', e); process.exit(1); });
