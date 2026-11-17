// Customer app S-picker (PLAN-intl-phone r2.3 §2A; MOCKUP-intl-phone-picker-APPROVED-2026-10-27): the country module and the
// checkout's per-country validation / E.164 wire. Light: no DOM.
// Run: node --test customer-app/capp-phone.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('./capp-phone.js');
const C = require('./capp-checkout.js');

test('S-picker countries: the plan\'s SUPPORTED set, in the mockup\'s order, with its national lengths and placeholders (Honduras the default)', () => {
  assert.deepEqual(P.COUNTRIES.map((c) => [c.name, c.cc, c.len, c.ph]), [
    ['Honduras', '504', 8, '9999-9999'], ['Estados Unidos', '1', 10, '(555) 123-4567'], ['México', '52', 10, '55 1234 5678'],
    ['Guatemala', '502', 8, '9999-9999'], ['El Salvador', '503', 8, '9999-9999'], ['Nicaragua', '505', 8, '9999-9999'],
    ['Costa Rica', '506', 8, '9999-9999'], ['Panamá', '507', 8, '6999-9999'], ['Belice', '501', 7, '622-1234'], ['España', '34', 9, '612 34 56 78']]);
  assert.equal(P.DEFAULT_CC, '504');
  // every placeholder is its own format of a full-length number (one source for the shape)
  for (const c of P.COUNTRIES) assert.equal(P.format(c.cc, c.ph), c.ph, `${c.name}: the format IS the placeholder's shape`);
});
test('S-picker format: the local format while typing, never past the national length', () => {
  assert.equal(P.format('1', '3055550147'), '(305) 555-0147'); assert.equal(P.format('1', '305'), '(305'); assert.equal(P.format('1', '3055'), '(305) 5');
  assert.equal(P.format('1', '305555014799'), '(305) 555-0147', '🔴 capped at 10');
  assert.equal(P.format('52', '5512345678'), '55 1234 5678'); assert.equal(P.format('501', '6221234'), '622-1234'); assert.equal(P.format('34', '612345678'), '612 34 56 78');
  assert.equal(P.format('504', '9999 0000'), '9999-0000'); assert.equal(P.format('504', '+504 9999-0000'), '5049-9990', 'digits only — a pasted +504 is not stripped by the formatter');
  assert.equal(P.format('504', ''), '');
});
test('S-picker E.164: compose only when complete; parse only a QUALIFIED number of a supported country with its exact length (+44 rejected, never guessed)', () => {
  assert.equal(P.toE164('1', '(305) 555-0147'), '+13055550147');
  assert.equal(P.valid('1', '305555014799'), false, '🔴 over the national length is not valid'); assert.equal(P.valid('1', '3055550147'), true); assert.equal(P.toE164('504', '9999-0000'), '+50499990000'); assert.equal(P.toE164('1', '305555014'), '', 'incomplete ⇒ nothing');
  for (const c of P.COUNTRIES) { const n = P.digits(c.ph); assert.deepEqual(P.parseE164('+' + c.cc + n), { cc: c.cc, national: n }, `${c.name} round-trips`); }
  assert.deepEqual(P.parseE164('+1 (305) 555-0147'), { cc: '1', national: '3055550147' }, 'punctuation tolerated');
  assert.equal(P.parseE164('+44 20 7946 0958'), null, '🔴 an unsupported country (+44) is rejected');
  assert.equal(P.parseE164('+130555501'), null, 'a wrong length is rejected');
  assert.equal(P.parseE164('99990000'), null, 'unqualified is not E.164');
  assert.equal(P.parseE164('+504 9999-000'), null);
  assert.equal(P.display('1', '3055550147'), '+1 (305) 555-0147');
});
test('S-picker checkout: a chosen country validates ITS length and sends E.164 (+504 too); no country ⇒ today\'s +504 path, byte for byte', () => {
  const ctx = { restaurantId: 'rid_a', orderId: 'TA1', items: [], itemsText: '' };
  const f = C.freshFlow(null); Object.assign(f, { name: 'Ana', phone: '9999-0000' });
  assert.equal(C.orderBody(f, ctx).customer_phone, '+504 9999-0000', 'no country: the forms\' format, unchanged');
  assert.equal(C.orderBody({ ...f, cc: '504' }, ctx).customer_phone, '+50499990000', 'the picker: E.164 for +504 too');
  assert.equal(C.orderBody({ ...f, cc: '1', phone: '(305) 555-0147' }, ctx).customer_phone, '+13055550147', '🔴 the chosen country on the wire');
  const need = (g) => C.missingStep(g, { member: null });
  assert.equal(need({ ...f, mode: 'pickup', cc: '1', phone: '(305) 555-01' }), C.COPY.phone, '🔴 a US number short of 10 digits is incomplete');
  assert.notEqual(need({ ...f, mode: 'pickup', cc: '1', phone: '(305) 555-0147' }), C.COPY.phone);
  assert.notEqual(need({ ...f, mode: 'pickup', cc: '501', phone: '622-1234' }), C.COPY.phone, 'Belice: 7 digits is complete');
  assert.equal(need({ ...f, mode: 'pickup', phone: '9999-000' }), C.COPY.phone, 'no country: 8 digits, as today');
});
test('no restaurant literal in the country module', () => {
  assert.equal(readFileSync(new URL('./capp-phone.js', import.meta.url), 'utf8').match(/x_pizza|la_musa|xpizza|lamusa|X\.? ?Pizza|La Musa/i), null);
});
test('S-picker checkout guard: with a country, a MEMBER\'s unreadable number is incomplete too (never sent); no country ⇒ the member path as today', () => {
  const f = C.freshFlow(null); Object.assign(f, { name: 'Ana', mode: 'pickup' });
  assert.equal(C.missingStep({ ...f, cc: '504', phone: '' }, { member: { uid: 'u1' } }), C.COPY.phone, '🔴 a member with no readable number is stopped');
  assert.notEqual(C.missingStep({ ...f, cc: '1', phone: '(305) 555-0147' }, { member: { uid: 'u1' } }), C.COPY.phone);
  assert.notEqual(C.missingStep({ ...f, phone: '' }, { member: { uid: 'u1' } }), C.COPY.phone, 'no country: a member is not re-validated, as today');
});

// ── PLAN-capp-picker-served-countries r1: the pickers offer only the SERVER's countries (xpizza-functions/phone-countries.js, synced
// into customer-app/ byte for byte), from that ONE list — never a second hand-written one ──
const SRV = require('../xpizza-functions/phone-countries.js');
const COPY_SRC = readFileSync(new URL('./phone-countries.js', import.meta.url), 'utf8');
test('PS-0: the server list\'s node exports are unchanged by its dual-mode tail — same keys, same frozen list, same parseE164 on a fixed table', () => {
  assert.deepEqual(Object.keys(SRV), ['COUNTRIES', 'parseE164'], '🔴 PS-0: the exports object keeps exactly its two keys');
  assert.ok(Object.isFrozen(SRV.COUNTRIES));
  assert.deepEqual(SRV.COUNTRIES, [{ cc: '504', len: 8 }, { cc: '1', len: 10 }, { cc: '502', len: 8 }, { cc: '503', len: 8 }, { cc: '505', len: 8 }, { cc: '506', len: 8 }, { cc: '52', len: 10 }, { cc: '34', len: 9 }]);
  const e = (e164, cc, national) => ({ e164, cc, national });
  // captured from f8f7815af (before the tail) — the server callers (signup-platform, checkout-otp) see the same answers
  const TABLE = [['+50499990000', e('+50499990000', '504', '99990000')], ['+13055550147', e('+13055550147', '1', '3055550147')], ['+525512345678', e('+525512345678', '52', '5512345678')],
    ['+50299990000', e('+50299990000', '502', '99990000')], ['+50399990000', e('+50399990000', '503', '99990000')], ['+50599990000', e('+50599990000', '505', '99990000')],
    ['+50699990000', e('+50699990000', '506', '99990000')], ['+34612345678', e('+34612345678', '34', '612345678')], ['+50769999999', null], ['+5016221234', null],
    ['+442079460958', null], ['50499990000', null], ['+5049999000', null], [' +50499990000 ', e('+50499990000', '504', '99990000')], ['+504 9999-0000', null], [null, null], [42, null]];
  for (const [raw, want] of TABLE) assert.deepEqual(SRV.parseE164(raw), want, `🔴 PS-0: parseE164(${JSON.stringify(raw)})`);
});
test('PS-1: in a PAGE the list is the global PhoneCountries and nothing else leaks to the window; capp-phone reads it there', async () => {
  const { JSDOM } = createRequire(new URL('../xpizza-functions/x.js', import.meta.url))('jsdom');
  const w = new JSDOM('<!doctype html><body>', { runScripts: 'outside-only' }).window;
  const before = new Set(Object.getOwnPropertyNames(w));
  w.eval(COPY_SRC);
  assert.deepEqual(Object.getOwnPropertyNames(w).filter((k) => !before.has(k)), ['PhoneCountries'], '🔴 PS-1: one global');
  assert.equal(w.eval('typeof COUNTRIES'), 'undefined', '🔴 PS-1: no top-level binding shared with the other page scripts');
  w.eval(readFileSync(new URL('./capp-phone.js', import.meta.url), 'utf8'));
  assert.deepEqual(JSON.parse(w.eval('JSON.stringify(CappPhone.served().map((c) => c.cc))')), ['504', '1', '52', '502', '503', '505', '506', '34'], '🔴 PS-1: the page\'s picker list = the global');
});
test('PS-2: served() = the COUNTRIES rows whose cc the server list carries, in the picker\'s order — Panamá and Belice gone; every served cc has a format row', () => {
  const ccs = P.served().map((c) => c.cc);
  assert.deepEqual(new Set(ccs), new Set(SRV.COUNTRIES.map((c) => c.cc)), '🔴 PS-2: exactly the server\'s set');
  assert.deepEqual(ccs, P.COUNTRIES.map((c) => c.cc).filter((cc) => ccs.includes(cc)), 'the mockup\'s order (Honduras first)');
  assert.ok(!ccs.includes('507') && !ccs.includes('501'), '🔴 PS-2: no Panamá, no Belice');
  for (const c of SRV.COUNTRIES) assert.equal(P.byCc(c.cc) && P.byCc(c.cc).len, c.len, `🔴 PS-2: +${c.cc} has a format row of the server's length (never silently missing)`);
  assert.equal(P.COUNTRIES.length, 10, 'the parse/format table is unchanged (a saved +507 still reads)');
});
test('PS-3: served(extraCc) adds a member\'s own saved country (once, in order); an unknown / served / empty extra changes nothing', () => {
  const base = P.served().map((c) => c.cc);
  assert.deepEqual(P.served('507').map((c) => c.cc), ['504', '1', '52', '502', '503', '505', '506', '507', '34'], '🔴 PS-3: Panamá kept for its member');
  assert.deepEqual(P.served('501').map((c) => c.cc).filter((cc) => !base.includes(cc)), ['501']);
  for (const x of ['1', '44', '', null, undefined]) assert.deepEqual(P.served(x).map((c) => c.cc), base, `extra ${JSON.stringify(x)}`);
});
test('PS-4: no server list (the page missed the script) ⇒ Honduras ONLY — fail closed, never every COUNTRIES row', () => {
  for (const src of [null, undefined, {}, { COUNTRIES: 'x' }]) assert.deepEqual(P.served(null, src === undefined ? null : src).map((c) => c.cc), ['504'], `🔴 PS-4: ${JSON.stringify(src)}`);
  assert.deepEqual(P.served('507', null).map((c) => c.cc), ['504', '507'], 'a member\'s own country still kept');
});
