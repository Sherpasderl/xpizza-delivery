// S2-checkout — the ONE boundary to the PixelPay SDK / capacitor plugin (CONTRACT-sdk-checkout r3 §2.1 card.new, §8 continuation;
// advisor Q8: the plugin binding + its runtime key belong to the native-shell slice — here only the interface and its strict wrapper).
// Whatever the binding returns is validated: anything outside the shapes is a FAILURE, never a token; nothing is ever logged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const K = require('./capp-pay-sdk.js');

const OK = { sdk_token: 'sdk-T-1', authentication_identifier: null, display: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028 } };
const fields = { kind: 'fields-handle' };   // the abstract field implementation (DOM or native secure fields)

test('absent binding (web, old OS, plugin failure) ⇒ unavailable — frame 7, never a hosted fallback', async () => {
  for (const impl of [null, undefined, {}, { available: () => { throw new Error('x'); } }, { available: () => 'yes' }]) {
    const sdk = K.createPaySdk(impl);
    assert.equal(await sdk.available(), false, `🔴 SDK-avail: ${JSON.stringify(impl)} ⇒ unavailable`);
  }
  assert.equal(await K.createPaySdk({ available: async () => true }).available(), true, 'a binding that says yes');
});

test('tokenize: a well-formed result passes through exactly; anything else (extra keys, a PAN, bad display, a throw) is a failure', async () => {
  const run = (out) => K.createPaySdk({ available: () => true, tokenize: async () => out }).tokenize(fields);
  assert.deepEqual(await run(OK), { ok: true, ...OK }, '🔴 SDK-tok: the §2.1 shape');
  for (const bad of [null, { ...OK, pan: '4242424242424242' }, { ...OK, sdk_token: '' }, { ...OK, display: { ...OK.display, last4: '42' } }, { ...OK, display: { ...OK.display, cvv: '123' } }, { ...OK, display: { ...OK.display, exp_month: 13 } }, { ...OK, authentication_identifier: 5 }]) {
    assert.deepEqual(await run(bad), { ok: false }, `🔴 SDK-tok: ${JSON.stringify(bad)} is a failure, never a token`);
  }
  assert.deepEqual(await K.createPaySdk({ available: () => true, tokenize: async () => { throw new Error('boom 4242424242424242'); } }).tokenize(fields), { ok: false }, 'a throw ⇒ failure');
  assert.deepEqual(await K.createPaySdk({ available: () => true }).tokenize(fields), { ok: false }, 'no tokenize ⇒ failure');
});

test('continue3ds (§8, VENDOR-provisional): the challenge goes to the binding; only { sdk_result } comes back', async () => {
  const ch = { continuation_id: 'c1', sdk_payload: { a: 1 }, expires_at: 9 };
  let seen = null;
  const sdk = K.createPaySdk({ available: () => true, continue3ds: async (c) => { seen = c; return { sdk_result: 'r' }; } });
  assert.deepEqual(await sdk.continue3ds(ch), { ok: true, sdk_result: 'r' }, '🔴 SDK-3ds: the result');
  assert.deepEqual(seen, ch, 'the challenge as served');
  assert.deepEqual(await K.createPaySdk({ available: () => true, continue3ds: async () => ({ sdk_result: 'r', extra: 1 }) }).continue3ds(ch), { ok: false }, '🔴 SDK-3ds: an extra key ⇒ failure');
});

test('nothing is ever logged: no console call on any path (the SDK request objects carry card data, §2 step 1)', async () => {
  const calls = []; const orig = {}; for (const k of ['log', 'info', 'warn', 'error', 'debug']) { orig[k] = console[k]; console[k] = (...a) => calls.push([k, a]); }
  try {
    const sdk = K.createPaySdk({ available: () => true, tokenize: async () => { throw new Error('4242424242424242'); }, continue3ds: async () => null });
    await sdk.tokenize(fields); await sdk.continue3ds({ continuation_id: 'c', sdk_payload: 1, expires_at: 1 }); await sdk.available();
  } finally { for (const k of Object.keys(orig)) console[k] = orig[k]; }
  assert.deepEqual(calls, [], '🔴 SDK-log: never a console call');
});
