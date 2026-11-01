'use strict';

/**
 * Dep-free unit test for the seed's self-validation (assertIdentityShape) and the real payloads.
 * Admin SDK bypasses RTDB .validate, so this strict shape check is the seed's only guard — and
 * because deep `hours` structural .validate is deferred (step-6a), the seed MUST validate hours.
 * (Emulator-level idempotency / .exists()-abort is covered separately by the test:rules suite.)
 */

// assertIdentityShape would reject x_pizza if whatsapp_instance were undefined — set the env the
// seed reads at module load, BEFORE requiring it.
process.env.ULTRAMSG_INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID || 'instance170156';

const assert = require('assert');
const { assertIdentityShape, IDENTITIES } = require('./seed_identity');

// 1) The real seed payloads pass.
for (const [rid, id] of Object.entries(IDENTITIES)) assertIdentityShape(rid, id);

// 2) La Musa ships dark + closed days are explicit (not RTDB null).
assert.strictEqual(IDENTITIES.la_musa.active, false, 'la_musa must ship dark (active:false)');
assert.strictEqual(IDENTITIES.la_musa.whatsapp_enabled, false, 'la_musa must ship dark (whatsapp_enabled:false)');
assert.deepStrictEqual(IDENTITIES.la_musa.hours.mon, { open: false }, 'closed day must be {open:false}, not null');
// the seed mirrors the LIVE la_musa hours (owner-approved 2026-10-05: Sunday closes 19:45) so a re-seed can't revert them
assert.deepStrictEqual(IDENTITIES.la_musa.hours, {
  mon: { open: false },
  tue: { open: true, start: '17:00', end: '20:45' },
  wed: { open: true, start: '17:00', end: '20:45' },
  thu: { open: true, start: '17:00', end: '20:45' },
  fri: { open: true, start: '17:00', end: '21:45' },
  sat: { open: true, start: '17:00', end: '21:45' },
  sun: { open: true, start: '12:00', end: '19:45' },
}, 'la_musa seed hours = the live hours');

// 3) Malformed payloads are rejected (proves the strict self-validation).
const base = IDENTITIES.la_musa;
const bad = (mutate, why, label) => {
  const c = JSON.parse(JSON.stringify(base));
  mutate(c);
  assert.throws(() => assertIdentityShape('test', c), why, label);
};
bad((c) => delete c.version, /version/);
bad((c) => delete c.delivery_radius_km, /delivery_radius_km/);
bad((c) => { c.hub_lat = '15.5'; }, /hub_lat/);
bad((c) => { c.active = 'no'; }, /active/);
bad((c) => { c.version = '1'; }, /version/);
bad((c) => { c.whatsapp_enabled = 'false'; }, /whatsapp_enabled/);
bad((c) => { c.hours.mon = null; }, /hours\.mon/); // null day rejected (the #3 closed-vs-missing bug)
bad((c) => { c.hours.wed = { open: true, start: '25:00', end: '21:45' }; }, /hours\.wed/); // bad HH:MM
bad((c) => { delete c.hours.sun; }, /hours\.sun/); // missing day
// S4 C′ BC-3 — the seed now validates through the ONE grammar (schedule/hours-grammar.js): a DELIBERATE, stricter policy.
// Already refused before the switch (kept): a one-digit hour and 24:00.
bad((c) => { c.hours.tue = { open: true, start: '9:00', end: '20:45' }; }, /hours\.tue/, 'BC3-ONE-DIGIT-HOUR');   // BC3-ONE-DIGIT-HOUR
bad((c) => { c.hours.tue = { open: true, start: '17:00', end: '24:00' }; }, /hours\.tue/, 'BC3-24-00');  // BC3-24-00
// NEW refusals (the stricter grammar): overnight / equal times, an extra key, a closed day carrying times, an unknown day key.
bad((c) => { c.hours.fri = { open: true, start: '22:00', end: '02:00' }; }, /hours\.fri/, 'BC3-OVERNIGHT'); // BC3-OVERNIGHT
bad((c) => { c.hours.fri = { open: true, start: '17:00', end: '17:00' }; }, /hours\.fri/, 'BC3-EQUAL'); // BC3-EQUAL
bad((c) => { c.hours.thu = { open: true, start: '17:00', end: '20:45', note: 'x' }; }, /hours\.thu: unknown key/, 'BC3-EXTRA-KEY'); // BC3-EXTRA-KEY
bad((c) => { c.hours.mon = { open: false, start: '17:00', end: '20:45' }; }, /hours\.mon: closed day has times/, 'BC3-CLOSED-WITH-TIMES'); // BC3-CLOSED-WITH-TIMES
bad((c) => { c.hours.funday = { open: false }; }, /hours\.unknown day funday/, 'BC3-UNKNOWN-DAY'); // BC3-UNKNOWN-DAY
// Codex S4 build r1: two more NEW refusals (the base check's RegExp.test coerced arrays; typeof 'object' admitted arrays)
bad((c) => { c.hours.wed = { open: true, start: ['12:00'], end: '21:45' }; }, /hours\.wed/, 'BC3-ARRAY-TIME'); // BC3-ARRAY-TIME
bad((c) => { c.hours.mon = Object.assign([], { open: false }); }, /hours\.mon/, 'BC3-ARRAY-DAY'); // BC3-ARRAY-DAY
bad((c) => { c.hours = Object.assign([], c.hours); }, /hours\.hours must be an object/, 'BC3-ARRAY-HOURS'); // BC3-ARRAY-HOURS

console.log('seed-identity: OK (real payloads valid; malformed rejected)');
