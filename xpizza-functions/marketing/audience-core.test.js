'use strict';
// offer-audience BUILD T1 (PLAN-5f-offer-audience r4.1 §2 / §5, r2 §2) — the PURE audience core: the brand-scoped identity codes, the HN
// month / day keys the markers and the deadline index use, the retention cutoff, and the NEW / RETURNING decision from read facts.
//   Inputs from the REAL writers: the phone hash is otp-lib phoneHash (what user_profiles/{uid}/phone_hash and guest_verified.phone_hash
//   hold); the history rows are create-order-build's own user_orders entry shape (attachCustomerAttribution).
// Run: node marketing/audience-core.test.js
const assert = require('assert');
process.env.OTP_SALT = process.env.OTP_SALT || 'x'.repeat(40);
const OTP = require('../otp-lib');
const AC = require('./audience-core');

let n = 0; let FINISHED = false; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ audience-core: exited without completing\n'); process.exitCode = 1; } });

const KEY = 'k'.repeat(48);
const PH = OTP.phoneHash('+504 8888-4444');
const PH2 = OTP.phoneHash('+504 9999-1111');
const hn = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h + 6, mi);   // HN = UTC−6, no DST

cell('AI-BRAND: the same verified phone gives different codes at two brands (unlinkable without the key)', (L) => {
  const a = AC.idsOf({ key: KEY, brandId: 'tb', phoneHash: PH });
  const b = AC.idsOf({ key: KEY, brandId: 'lm', phoneHash: PH });
  assert.ok(a && b && /^[0-9a-f]{64}$/.test(a.p) && /^[0-9a-f]{64}$/.test(b.p), `${L}: hex HMACs`);
  assert.notStrictEqual(a.p, b.p, `${L}: brand-scoped`);
  assert.strictEqual(a.kv, 'v1', `${L}: key version`);
  assert.deepStrictEqual(AC.idsOf({ key: KEY, brandId: 'tb', phoneHash: PH }), a, `${L}: deterministic`);
  assert.notStrictEqual(AC.idsOf({ key: KEY, brandId: 'tb', phoneHash: PH2 }).p, a.p, `${L}: another phone, another code`);
  assert.ok(!a.p.includes(PH) && !JSON.stringify(a).includes('8888'), `${L}: no input in the output`);
});

cell('AI-EMAIL: only a VERIFIED email is coded; trimmed + lower-cased; the phone and email codes never collide', (L) => {
  const typed = AC.idsOf({ key: KEY, brandId: 'tb', email: 'Ana@Mail.hn', emailVerified: false });
  assert.strictEqual(typed, null, `${L}: a typed (unverified) email is never used`);
  const v1 = AC.idsOf({ key: KEY, brandId: 'tb', email: '  Ana@Mail.HN ', emailVerified: true });
  const v2 = AC.idsOf({ key: KEY, brandId: 'tb', email: 'ana@mail.hn', emailVerified: true });
  assert.ok(v1 && v1.e && !('p' in v1), `${L}: e only`);
  assert.strictEqual(v1.e, v2.e, `${L}: normalised`);
  assert.strictEqual(AC.idsOf({ key: KEY, brandId: 'tb', email: 'ana@mail.hn', emailVerified: 'true' }), null, `${L}: verified means === true`);
  const both = AC.idsOf({ key: KEY, brandId: 'tb', phoneHash: PH, email: 'ana@mail.hn', emailVerified: true });
  assert.deepStrictEqual(Object.keys(both).sort(), ['e', 'kv', 'p'], `${L}: both`);
  assert.notStrictEqual(both.p, both.e, `${L}: domain-separated`);
});

cell('AI-FAILCLOSED: no key / a short key / no brand / no identity ⇒ null (never a guessed code)', (L) => {
  for (const key of [undefined, null, '', 'short', 42]) assert.strictEqual(AC.idsOf({ key, brandId: 'tb', phoneHash: PH }), null, `${L}: key ${JSON.stringify(key)}`);
  for (const brandId of [undefined, null, '', 7]) assert.strictEqual(AC.idsOf({ key: KEY, brandId, phoneHash: PH }), null, `${L}: brand ${JSON.stringify(brandId)}`);
  assert.strictEqual(AC.idsOf({ key: KEY, brandId: 'tb' }), null, `${L}: nothing to code`);
  assert.strictEqual(AC.idsOf({ key: KEY, brandId: 'tb', phoneHash: '' }), null, `${L}: empty phone hash`);
});

cell('AI-IDSOK: idsShapeOk accepts exactly what idsOf produces (the frozen audience_ids / a signed aud.ids)', (L) => {
  const both = AC.idsOf({ key: KEY, brandId: 'tb', phoneHash: PH, email: 'a@b.hn', emailVerified: true });
  assert.ok(AC.idsShapeOk(both) && AC.idsShapeOk(AC.idsOf({ key: KEY, brandId: 'tb', phoneHash: PH })), `${L}: produced shapes`);
  for (const bad of [null, {}, { kv: 'v1' }, { p: 'x', kv: 'v1' }, { p: both.p }, { p: both.p, kv: 'v2' }, { p: both.p, kv: 'v1', uid: 'u' }, [both.p]]) {
    assert.strictEqual(AC.idsShapeOk(bad), false, `${L}: ${JSON.stringify(bad)}`);
  }
});

cell('AM-MONTH: HN month / day keys at the UTC−6 boundary; the 24-month cutoff', (L) => {
  assert.strictEqual(AC.hnMonthOf(hn(2026, 11, 1, 0, 0)), '2026-11', `${L}: HN midnight on the 1st`);
  assert.strictEqual(AC.hnMonthOf(Date.UTC(2026, 10, 1, 5, 59)), '2026-10', `${L}: 05:59 UTC on the 1st is still October in HN`);
  assert.strictEqual(AC.hnDayOf(Date.UTC(2026, 10, 17, 5, 59)), '2026-11-16', `${L}: day key`);
  assert.strictEqual(AC.cutoffMonth(hn(2026, 11, 16, 12)), '2024-11', `${L}: current HN month − 24`);
  assert.strictEqual(AC.cutoffMonth(hn(2026, 1, 3)), '2024-01', `${L}: across a year`);
  assert.strictEqual(AC.dayBefore(hn(2026, 11, 16, 12), 30), '2026-10-17', `${L}: deadline day key (today − 30)`);
  assert.strictEqual(AC.hnMonthOf(NaN), null, `${L}: no clock ⇒ null`);
});

// history rows exactly as create-order-build attachCustomerAttribution writes them (restaurant + status; the trigger keeps status fresh)
const row = (restaurant, status) => ({ ts: 1, total: 100, order_type: 'delivery', items_text: 'x', restaurant, status, items: [] });

cell('AK-KIND: RETURNING ⇔ a delivered/completed order at the BRAND (any branch) or any marker; else NEW', (L) => {
  const brands = { tb_centro: 'tb', tb_norte: 'tb', lm_1: 'lm' };
  const k = (rows, markers = {}) => AC.kindOf({ brandId: 'tb', rows, brandOfRid: brands, markers });
  assert.strictEqual(k([]), 'new', `${L}: no history`);
  assert.strictEqual(k([row('tb_norte', 'delivered')]), 'returning', `${L}: another branch of the same brand`);
  assert.strictEqual(k([row('tb_centro', 'completed')]), 'returning', `${L}: pickup completed`);
  assert.strictEqual(k([row('lm_1', 'delivered')]), 'new', `${L}: another brand`);
  for (const s of ['new', 'scheduled', 'preparing', 'ready', 'cancelled', 'abandoned', 'pending_payment', null]) assert.strictEqual(k([row('tb_centro', s)]), 'new', `${L}: status ${s}`);
  assert.strictEqual(k([], { p: true }), 'returning', `${L}: phone marker`);
  assert.strictEqual(k([], { e: true }), 'returning', `${L}: email marker`);
  assert.strictEqual(k([], { p: false, e: false }), 'new', `${L}: no markers`);
  assert.strictEqual(AC.kindOf({ brandId: 'tb', rows: [row('tb_x', 'delivered')], brandOfRid: {}, markers: {} }), 'new', `${L}: an unresolved history rid never counts`);
});

FINISHED = true;
if (fails.length) { console.log(`audience-core: ${fails.length} FAILED`); process.exit(1); }
console.log(`audience-core: OK (${n})`);
