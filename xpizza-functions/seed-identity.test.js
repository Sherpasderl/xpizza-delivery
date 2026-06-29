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

// 3) Malformed payloads are rejected (proves the strict self-validation).
const base = IDENTITIES.la_musa;
const bad = (mutate, why) => {
  const c = JSON.parse(JSON.stringify(base));
  mutate(c);
  assert.throws(() => assertIdentityShape('test', c), why);
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

console.log('seed-identity: OK (real payloads valid; malformed rejected)');
