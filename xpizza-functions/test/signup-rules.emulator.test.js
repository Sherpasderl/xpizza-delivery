'use strict';
/**
 * PLAN-signup-email-social r3 §5 + BC1 — the RTDB rules, behaviourally (the real rules file on the emulator):  npm run test:signup-rules
 *   1 user_private: the owner reads its own node, nobody reads another's; EVERY client role (owner customer, another customer,
 *     staff, unauthenticated) is denied set / update / null / nested null / whole-node writes;
 *   2 user_profiles: the owner's legitimate name and address writes still pass (a live account);
 *   3 BC1 — the deletion window, for BOTH callers: after the deletion core's FIRST step (the BC2 tombstone, written exactly as
 *     signup-core.tombstone writes it — deleteAccount without a cutoff, the inactivity sweep with one) and before the removals,
 *     the owner's still-valid session can no longer write its profile (name, address, whole node);
 *   4 the server-only nodes (auth_links, link_tickets, auth_challenges, signup_config, restaurants/$rid/legal) are denied to
 *     every client role, read and write.
 */
require('./_emulator-required')('database');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const S = require('../signup-core');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const U = 'u_' + 'a'.repeat(24), U2 = 'u_' + 'b'.repeat(24);
const RID = 'merch_a';
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const PROFILE = (ph) => ({ phone: '50499990000', phone_hash: ph, created_at: 1, last_login: 1, name: 'Ana' });
const ADDR = { label: 'Casa', detected: 'Col. Palmira', details: '', lat: 14.1, lng: -87.2, created_at: 1, last_used_at: 1 };

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });
  const seed = async () => env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref('/').set(null);
    await db.ref(`user_profiles/${U}`).set(PROFILE('ph_a'));
    await db.ref(`user_profiles/${U2}`).set(PROFILE('ph_b'));
    await db.ref(`user_private/${U}`).set({ email: 'ana@gmail.com', email_verified: false, email_source: 'typed', last_active: 5, consent: { [RID]: { terms: { version: 't', privacy_version: 'p', at: 5 }, promos: { value: false, copy_version: 'c', at: 5 } } } });
    await db.ref('auth_links/google/g1').set({ uid: U, at: 1 });
    await db.ref('link_tickets/t1').set({ state: 'issued' });
    await db.ref('auth_challenges/c1').set({ used: false });
    await db.ref('signup_config/rollout_at').set(1);
    await db.ref(`restaurants/${RID}/legal`).set({ terms_url: 'https://t', privacy_url: 'https://p', terms_version: 't', privacy_version: 'p', promos_copy_version: 'c' });
  });
  const owner = env.authenticatedContext(U, { customer: true }).database();
  const other = env.authenticatedContext(U2, { customer: true }).database();
  const staff = env.authenticatedContext('disp_1').database();
  const anon = env.unauthenticatedContext().database();
  const ROLES = [['owner', owner], ['another customer', other], ['staff', staff], ['unauthenticated', anon]];

  // ── 1. user_private ──
  await seed();
  await assertSucceeds(owner.ref(`user_private/${U}`).once('value'));
  await assertSucceeds(owner.ref(`user_private/${U}/consent/${RID}`).once('value'));
  await assertFails(other.ref(`user_private/${U}`).once('value'));
  await assertFails(staff.ref(`user_private/${U}`).once('value'));
  await assertFails(anon.ref(`user_private/${U}`).once('value'));
  await assertFails(owner.ref('user_private').once('value'));
  let writes = 0;
  for (const [label, db] of ROLES) {
    const base = db.ref(`user_private/${U}`);
    for (const [what, op] of [
      ['set whole node', () => base.set({ email: 'x@y.co' })],
      ['set null (delete node)', () => base.set(null)],
      ['remove', () => base.remove()],
      ['update email_verified', () => base.update({ email_verified: true })],
      ['update deleted_at null', () => base.update({ deleted_at: null })],
      ['nested set consent terms', () => base.child(`consent/${RID}/terms/version`).set('forged')],
      ['nested null consent', () => base.child(`consent/${RID}`).set(null)],
      ['set deleted_at', () => base.child('deleted_at').set(1)],
      ['root multipath', () => db.ref().update({ [`user_private/${U}/email`]: 'x@y.co' })],
    ]) { await assertFails(op()); writes++; void what; void label; }
  }
  await env.withSecurityRulesDisabled(async (ctx) => assert.strictEqual((await ctx.database().ref(`user_private/${U}/email`).once('value')).val(), 'ana@gmail.com'));
  ok(`user_private: owner-read only (another customer / staff / anonymous / the parent → denied); ${writes} client writes denied across 4 roles (set, null, remove, update, nested set / null, root multipath) — data unchanged`);

  // ── 2. legitimate profile writes still pass ──
  await assertSucceeds(owner.ref(`user_profiles/${U}/name`).set('Ana María'));
  await assertSucceeds(owner.ref(`user_profiles/${U}/addresses/a_abcdef12`).set(ADDR));
  await assertSucceeds(owner.ref(`user_profiles/${U}/default_address`).set('a_abcdef12'));
  await assertFails(other.ref(`user_profiles/${U}/name`).set('x'));
  ok('user_profiles: a live owner\'s name / address / default-address writes still pass; another customer still denied');

  // ── 3. BC1 — the window after the tombstone, before the removals, for BOTH deletion callers ──
  for (const [caller, opts] of [['deleteAccount', {}], ['the inactivity sweep', { staleBefore: 10 }]]) {
    await seed();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      assert.strictEqual(await S.tombstone(db, U, { now: 99, ...opts }), true, `${caller}: the core's first step stands`);
      assert.deepStrictEqual((await db.ref(`user_private/${U}`).once('value')).val(), { deleted_at: 99 }, 'BC2 replace');
      assert.ok((await db.ref(`user_profiles/${U}`).once('value')).exists(), 'premise: the window — the profile is not removed yet');
      assert.ok(!(await db.ref(`deleted_uids/${U}`).once('value')).exists(), 'premise: no deleted_uids yet (only the in-node tombstone guards)');
    });
    await assertFails(owner.ref(`user_profiles/${U}/name`).set('after delete'));
    await assertFails(owner.ref(`user_profiles/${U}/addresses/a_abcdef99`).set(ADDR));
    await assertFails(owner.ref(`user_profiles/${U}`).set(PROFILE('ph_a')));
    await assertSucceeds(other.ref(`user_profiles/${U2}/name`).set('Beto'));   // only THAT account is barred
  }
  ok('BC1: in the window after the deletion core\'s tombstone and before its removals — deleteAccount (no cutoff) AND the inactivity sweep (cutoff) — the old session cannot write the profile (name, address, whole node); other accounts unaffected');

  // ── 4. the server-only nodes ──
  await seed();
  let denied = 0;
  for (const p of ['auth_links', 'auth_links/google', 'auth_links/google/g1', 'link_tickets/t1', 'auth_challenges/c1', 'signup_config', `restaurants/${RID}/legal`]) {
    for (const [, db] of ROLES) { await assertFails(db.ref(p).once('value')); await assertFails(db.ref(p).set({ uid: U })); await assertFails(db.ref(p).set(null)); denied += 3; }
  }
  ok(`the server-only nodes (auth_links, link_tickets, auth_challenges, signup_config, restaurants/$rid/legal): ${denied} client reads / writes / deletes denied across 4 roles`);

  await env.cleanup();
  console.log(`\nsignup-rules.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('signup-rules.emulator FAILED:', e && e.stack || e); process.exit(1); });
