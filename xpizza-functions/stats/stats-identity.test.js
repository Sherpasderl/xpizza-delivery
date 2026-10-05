'use strict';
// Merchant STATS — customer identity + privacy. Run: node stats/stats-identity.test.js
const assert = require('assert');
const I = require('./stats-identity');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const SECRET = 'x'.repeat(40);

// Capture EVERY console channel, so a log of any kind is seen.
function capture(fn) {
  const seen = [];
  const keep = {};
  for (const k of ['log', 'warn', 'error', 'info', 'debug']) { keep[k] = console[k]; console[k] = (...a) => seen.push(a.map(String).join(' ')); }
  const so = process.stdout.write, se = process.stderr.write;
  process.stdout.write = (c, ...r) => { seen.push(String(c)); return true; };
  process.stderr.write = (c, ...r) => { seen.push(String(c)); return true; };
  try { fn(); } finally { Object.assign(console, keep); process.stdout.write = so; process.stderr.write = se; }
  return seen;
}

// 1. Same valid-phone behaviour as whatsapp.js normalizePhone on VALID inputs (parity, not reuse).
{
  const W = require('../whatsapp');
  for (const p of ['+50488884444', '504 8888-4444', '88884444', '8888-4444', '(504) 8888 4444', '+1 305 555 0101', '50431234567']) {
    assert.strictEqual(I.normalizePhoneSilent(p), W.normalizePhone(p), p);
  }
  ok('parity with whatsapp.js on valid phones');
}

// 2. STRICTER: letters / stray symbols invalid (whatsapp.js would strip them into a number).
{
  for (const p of ['call 8888-4444', '8888#4444', '8888*4444', '+504+88884444', 'abc', '', '1234', '1'.repeat(16), {}, [], true]) {
    assert.strictEqual(I.normalizePhoneSilent(p), null, JSON.stringify(p));
  }
  assert.strictEqual(I.normalizePhoneSilent(null), null);
  assert.strictEqual(I.normalizePhoneSilent(88884444), '50488884444', 'a numeric phone (RTDB may store one)');
  ok('strict digit validation; invalid → null (anonymous)');
}

// 3. 🔴 SILENT: no input phone appears in ANY captured output, for valid and invalid inputs alike.
{
  const inputs = ['+50488884444', '8888-4444', 'call 8888-4444', '123', '99999999999999999'];
  const k = I.makeCustomerKeyer(SECRET);
  const seen = capture(() => { for (const p of inputs) { I.normalizePhoneSilent(p); k('r1', p); } });
  assert.strictEqual(seen.length, 0, `stats identity wrote output: ${seen.join(' | ')}`);
  // Non-vacuity: the capture DOES see a log when one is made (so an empty capture means silence).
  const W = require('../whatsapp');
  const control = capture(() => W.normalizePhone('123'));
  assert(control.some((l) => l.includes('123')), 'control: whatsapp.js logs the raw phone, and the capture sees it');
  ok('normalizer + keyer are SILENT (capture proven non-vacuous against whatsapp.js:98)');
}

// 4. Keyer: versioned, restaurant-scoped, deterministic, normalisation-stable, not the raw phone.
{
  const k = I.makeCustomerKeyer(SECRET);
  const a = k('r1', '+504 8888-4444');
  assert.match(a, I.CUSTOMER_KEY_RE);
  assert.strictEqual(a, k('r1', '88884444'), 'same person, different spelling → same key');
  assert.notStrictEqual(a, k('r2', '88884444'), 'restaurant-scoped: unrelated keys at two restaurants');
  assert.notStrictEqual(a, I.makeCustomerKeyer('y'.repeat(40))('r1', '88884444'), 'keyed by the secret');
  assert(!a.includes('8888'), 'no phone digits leak into the key');
  assert.strictEqual(k('r1', 'garbage'), null, 'invalid phone → anonymous');
  assert.strictEqual(k('r1', undefined), null);
  ok('h1: versioned, restaurant-scoped HMAC; invalid/missing → anonymous');
}

// 5. FAILS CLOSED on a missing / short secret; the error names the variable, never a value.
{
  assert.throws(() => I.loadStatsSecret({}), /stats_secret_unavailable/);
  assert.throws(() => I.loadStatsSecret({ STATS_HMAC_SECRET: 'zq7Vw' }), (e) => /stats_secret_unavailable/.test(e.message) && !e.message.includes('zq7Vw'));
  assert.throws(() => I.loadStatsSecret({ STATS_HMAC_SECRET: ' '.repeat(40) }), /stats_secret_unavailable/);
  assert.strictEqual(I.loadStatsSecret({ STATS_HMAC_SECRET: SECRET }), SECRET);
  assert.throws(() => I.makeCustomerKeyer(''), /stats_secret_unavailable/);
  assert.throws(() => I.makeCustomerKeyer(undefined), /stats_secret_unavailable/);
  ok('secret loading fails CLOSED; message never echoes a value');
}
console.log(`\nstats-identity: ${n} cells passed`);
