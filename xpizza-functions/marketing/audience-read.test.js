'use strict';
// offer-audience BUILD T3 (PLAN-5f-offer-audience r4.1 §2 «quote» row, r2 §1/§2) — resolveAudience: the customer's KIND at a brand, read at
// the quote. Inputs from the REAL writers:
//   · user_orders/{uid}: create-order-build attachCustomerAttribution (the entry) + status-mirror decideStatusMirror (its status leaf);
//   · user_private/{uid}.email + email_verified: signup-core completeProfile, VERIFIED only through signup-core linkIdentity('email');
//   · user_profiles/{uid}: verifyOtp writes it INLINE (index.js:7307, no extractable writer) — the cells write that exact expression,
//     { phone: OTP.normalizePhone(phone), phone_hash: OTP.phoneHash(phone) } (ledger ruling T3);
//   · the brand: the REAL brands/restaurants identity nodes read by marketing/brand-of.
//   Marker cells (a returning identity seen via customer_seen) run in T8 against markers written by the REAL fulfilment writer.
// Run: node marketing/audience-read.test.js
const assert = require('assert');
process.env.OTP_SALT = process.env.OTP_SALT || 'x'.repeat(40);
const OTP = require('../otp-lib');
const { createFakeDb } = require('../merchant/_fake-db');
const SC = require('../signup-core');
const { attachCustomerAttribution } = require('../create-order-build');
const { decideStatusMirror } = require('../status-mirror');
const BO = require('./brand-of');
const AC = require('./audience-core');
const AR = require('./audience-read');

let n = 0; let FINISHED = false; const fails = [];
async function cell(label, fn) { try { BO._reset(); await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ audience-read: exited without completing\n'); process.exitCode = 1; } });

const KEY = 'k'.repeat(48);
const NOW = Date.UTC(2026, 10, 16, 18);
const PHONE = '+504 8888-4444';
const LEGAL = { terms_url: 'https://t', privacy_url: 'https://p', terms_version: 't1', privacy_version: 'p1', promos_copy_version: 'c1' };

// production transaction semantics over the shared fake (the SDK's uncached first run sees null) — as offer-price.test.js
function prodDb(fake) {
  return { ref(p = '') {
    const r = fake.ref(p);
    return { ...r, get: () => r.once(),
      async transaction(fn) {
        const cold = fn(null);
        if (cold === undefined) return { committed: false, snapshot: { val: () => null } };
        if (fake.get(p) === null) { fake.put(p, cold); return { committed: true, snapshot: { val: () => fake.get(p) } }; }
        return r.transaction(fn);
      } };
  } };
}
// counts every read (once / query once) by path — the read-count cells
function counted(db) {
  const reads = [];
  const wrap = (p, o) => {
    const out = {};
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (k === 'once') out.once = async (...a) => { reads.push(p); return v(...a); };
      else if (typeof v === 'function' && ['orderByChild', 'orderByKey', 'limitToLast', 'limitToFirst', 'endBefore', 'equalTo'].includes(k)) out[k] = (...a) => wrap(p, v(...a));
      else out[k] = v;
    }
    return out;
  };
  return { reads, db: { ref: (p = '') => wrap(p, db.ref(p)) } };
}

function world() {
  const fake = createFakeDb({
    brands: { tb: { name: 'Tercera', active: true, locations: { tb_centro: 'member', tb_norte: 'member' }, activation: { state: 'on', since: 1 } },
      lm: { name: 'Lm', active: true, locations: { lm_1: 'member' }, activation: { state: 'on', since: 1 } } },
    restaurants: { tb_centro: { identity: { brand_id: 'tb' }, legal: LEGAL }, tb_norte: { identity: { brand_id: 'tb' } }, lm_1: { identity: { brand_id: 'lm' } } },
  });
  return { fake, db: prodDb(fake) };
}
// the verifyOtp profile write (index.js:7307), verbatim
const profile = (w, uid, phone = PHONE) => w.fake.put(`user_profiles/${uid}`, { phone: OTP.normalizePhone(phone), phone_hash: OTP.phoneHash(phone), created_at: 1, last_login: 1 });
// a history entry through the REAL writer, then its status through the REAL status mirror
let seq = 0;
async function order(w, uid, rid, status, ts) {
  const oid = `o${++seq}`;
  const updates = { [`orders/${oid}`]: { status: 'new' } };
  attachCustomerAttribution(updates, oid, uid, { now: ts, total: 100, orderType: 'delivery', items_text: 'x', restaurantId: rid, status: 'new', items: [], tables: null });
  await w.db.ref().update(updates);
  const d = decideStatusMirror(oid, uid, true, status);
  if (d) await w.db.ref(d.path).set(d.value);
  return oid;
}
async function verifiedEmail(w, uid, email) {
  assert.strictEqual((await SC.linkIdentity(w.db, { kind: 'email', key: SC.sha256(email.trim().toLowerCase()), uid, now: 1 })).link, 'linked', 'premise: email link');
  assert.strictEqual((await SC.completeProfile(w.db, { uid, rid: 'tb_centro', email, acceptTerms: true, promos: false, now: 1, givenName: 'Ana', familyName: 'Paz' })).ok, true, 'premise: completeProfile');
}
const resolve = (db, o = {}) => AR.resolveAudience(db, { uid: 'u1', rid: 'tb_centro', key: KEY, nowMs: NOW, log: { warn() {} }, ...o });

(async () => {
  await cell('AR-NEW: a member with a verified phone and no history ⇒ NEW at the brand, coded with the phone', async (L) => {
    const w = world(); profile(w, 'u1');
    const r = await resolve(w.db);
    assert.deepStrictEqual([r.kind, r.brandId], ['new', 'tb'], L);
    assert.deepStrictEqual(r.ids, AC.idsOf({ key: KEY, brandId: 'tb', phoneHash: OTP.phoneHash(PHONE) }), `${L}: ids = the brand-scoped phone code`);
  });
  await cell('AR-HISTORY: a delivered/completed order at ANY branch of the brand ⇒ RETURNING; another brand / an open or cancelled order ⇒ NEW', async (L) => {
    for (const [rid, status, want] of [['tb_norte', 'delivered', 'returning'], ['tb_centro', 'completed', 'returning'], ['lm_1', 'delivered', 'new'], ['tb_centro', 'preparing', 'new'], ['tb_centro', 'cancelled', 'new']]) {
      const w = world(); profile(w, 'u1'); await order(w, 'u1', rid, status, NOW - 1000);
      assert.strictEqual((await resolve(w.db)).kind, want, `🔴 ${L}: ${rid} ${status}`);
    }
  });
  await cell('AR-BOUNDED: only the LAST 50 history rows by ts are read; an older fulfilled row is outside the window', async (L) => {
    const w = world(); profile(w, 'u1');
    await order(w, 'u1', 'tb_centro', 'delivered', NOW - 100000);       // the oldest
    for (let i = 0; i < 50; i += 1) await order(w, 'u1', 'lm_1', 'delivered', NOW - 1000 + i);
    assert.strictEqual((await resolve(w.db)).kind, 'new', `🔴 ${L}: the 51st-newest row is not read`);
    await order(w, 'u1', 'tb_norte', 'delivered', NOW);
    assert.strictEqual((await resolve(w.db)).kind, 'returning', `${L}: a recent one is`);
  });
  await cell('AR-EMAIL: a VERIFIED email (email link + completeProfile) is coded beside the phone; a typed one never is', async (L) => {
    const w = world(); profile(w, 'u1'); await verifiedEmail(w, 'u1', 'Ana@Mail.hn');
    const r = await resolve(w.db);
    assert.deepStrictEqual(r.ids, AC.idsOf({ key: KEY, brandId: 'tb', phoneHash: OTP.phoneHash(PHONE), email: 'ana@mail.hn', emailVerified: true }), `🔴 ${L}: p + e`);
    const w2 = world(); profile(w2, 'u2');
    assert.strictEqual((await SC.completeProfile(w2.db, { uid: 'u2', rid: 'tb_centro', email: 'typed@mail.hn', acceptTerms: true, promos: false, now: 1, givenName: 'Bo', familyName: 'Ruiz' })).ok, true, 'premise: a typed email');
    assert.strictEqual(w2.fake.get('user_private/u2/email_verified'), false, 'premise: unverified');
    assert.ok(!('e' in (await resolve(w2.db, { uid: 'u2' })).ids), `🔴 ${L}: a typed email is never coded`);
  });
  await cell('AR-NONE: no uid / an unresolved brand / no key / no verified identity / ANY read failure ⇒ kind none (no audience offer, never a guessed NEW)', async (L) => {
    { const w = world(); const c = counted(w.db); assert.strictEqual((await resolve(c.db, { uid: null })).kind, 'none', `${L}: guest`); assert.deepStrictEqual(c.reads, [], `${L}: a guest costs zero reads`); }
    { const w = world(); profile(w, 'u1'); assert.strictEqual((await resolve(w.db, { rid: 'zz_9' })).kind, 'none', `${L}: unresolved brand`); }
    { const w = world(); profile(w, 'u1'); assert.strictEqual((await resolve(w.db, { key: '' })).kind, 'none', `${L}: no key`); }
    { const w = world(); assert.strictEqual((await resolve(w.db)).kind, 'none', `${L}: no profile, no verified email`); }
    for (const prefix of ['user_profiles/u1', 'user_private/u1', 'user_orders/u1', 'restaurants/tb_norte']) {
      const w = world(); profile(w, 'u1'); await order(w, 'u1', 'tb_norte', 'delivered', NOW - 5);
      w.fake.failReads.add(prefix);
      const r = await resolve(w.db);
      assert.deepStrictEqual([r.kind, r.ids], ['none', null], `🔴 ${L}: read failure under ${prefix}`);
    }
  });
  await cell('AR-READS: a member costs profile (1) + email (2 leaves) + history (1 bounded query) + brand per distinct UNCACHED history rid + 1 marker per code — in two rounds', async (L) => {
    const w = world(); profile(w, 'u1'); await verifiedEmail(w, 'u1', 'ana@mail.hn');
    await order(w, 'u1', 'tb_norte', 'cancelled', NOW - 3); await order(w, 'u1', 'lm_1', 'delivered', NOW - 2); await order(w, 'u1', 'lm_1', 'delivered', NOW - 1);
    const c = counted(w.db);
    await resolve(c.db);
    const by = (p) => c.reads.filter((x) => x === p || x.startsWith(p)).length;
    assert.deepStrictEqual([by('user_profiles/u1'), by('user_private/u1'), by('user_orders/u1'), by('customer_seen/tb/')], [1, 2, 1, 2], `🔴 ${L}: ${JSON.stringify(c.reads)}`);
    assert.ok(!c.reads.some((p) => p.startsWith('restaurants/tb_norte')), `🔴 ${L}: an UNFULFILLED history rid never costs a brand read`);
    assert.strictEqual(by('restaurants/lm_1') + by('brands/lm_1'), 1, `${L}: one fulfilled rid ⇒ one brand-leaf read (twice in history, read once)`);
    assert.ok(!c.reads.some((p) => p === 'user_private/u1' || p.startsWith('user_private/u1/consent') || p.startsWith('user_private/u1/given')), `${L}: only the email leaves, never the private node`);
  });
  await cell('AR-NOPII: a read failure logs a code only — never a phone, email, uid or code', async (L) => {
    const w = world(); profile(w, 'u1'); await verifiedEmail(w, 'u1', 'ana@mail.hn'); w.fake.failReads.add('user_orders/u1');
    const lines = []; const log = { warn: (...a) => lines.push(a.join(' ')), log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
    await resolve(w.db, { log });
    assert.ok(lines.length >= 1, `${L}: premise — the failure is logged`);
    const all = lines.join('\n');
    for (const bad of ['u1', '8888', OTP.phoneHash(PHONE), 'ana@mail', KEY]) assert.ok(!all.includes(bad), `🔴 ${L}: ${bad} in ${all}`);
  });
  FINISHED = true;
  if (fails.length) { console.log(`audience-read: ${fails.length} FAILED`); process.exit(1); }
  console.log(`audience-read: OK (${n})`);
})();
