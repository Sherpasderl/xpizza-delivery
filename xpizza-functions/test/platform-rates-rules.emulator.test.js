'use strict';
// PAY RATE (PROPOSAL-driver-pay-rate-reader r2) — behavioral rules suite for /platform_rates/driver_per_delivery:
//   READ  allowed: a driver (signed in, no special claim), a dispatcher;
//   READ  denied:  a customer token, a handheld token, signed out;
//   WRITE denied:  everyone above (set an entry, push a new one, overwrite the node) — only the Admin SDK (the owner CLI) writes.
// Run: npm run test:platform-rates-rules     (RTDB emulator — HEAVY, slot only)
require('./_emulator-required')('database');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const NODE = 'platform_rates/driver_per_delivery';
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('platform-rates-rules(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-platform-rates-rules', database: { rules: RULES } });
  const SEED = { '-Nseed': { cents: 7000, effective_from: 0 } };
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref('dispatchers/disp-uid').set(true);
    await ctx.database().ref(NODE).set(SEED);
  });
  const readers = [['a driver', env.authenticatedContext('drv-uid')], ['a dispatcher', env.authenticatedContext('disp-uid')]];
  const denied = [['a customer', env.authenticatedContext('cust-uid', { customer: true })], ['a handheld', env.authenticatedContext('hh-uid', { handheld: true })], ['signed out', env.unauthenticatedContext()]];
  for (const [label, ctx] of readers) {
    const db = ctx.database();
    const v = (await assertSucceeds(db.ref(NODE).once('value'))).val();
    if (JSON.stringify(v) !== JSON.stringify(SEED)) throw new Error(`${label} read ${JSON.stringify(v)}`);
    await assertSucceeds(db.ref('platform_rates').once('value'));
  }
  ok('a driver and a dispatcher READ platform_rates (the node and its parent)');
  for (const [label, ctx] of denied) {
    const db = ctx.database();
    await assertFails(db.ref(NODE).once('value'));
    await assertFails(db.ref('platform_rates').once('value'));
    await assertFails(db.ref(`${NODE}/-Nseed`).once('value'));
  }
  ok('a customer, a handheld and a signed-out client are DENIED reading platform_rates');
  for (const [label, ctx] of [...readers, ...denied]) {
    const db = ctx.database();
    await assertFails(db.ref(`${NODE}/-Nx`).set({ cents: 9000, effective_from: 1 }));
    await assertFails(db.ref(NODE).push({ cents: 9000, effective_from: 1 }));
    await assertFails(db.ref(NODE).set({ a: { cents: 1, effective_from: 1 } }));
    await assertFails(db.ref(`${NODE}/-Nseed/cents`).set(1));
    await assertFails(db.ref('platform_rates').set(null));
  }
  ok('NO client can WRITE: set an entry, push one, overwrite the node, edit a seeded cents, or delete the parent (driver, dispatcher, customer, handheld, signed out)');
  await env.withSecurityRulesDisabled(async (ctx) => {
    const v = (await ctx.database().ref(NODE).once('value')).val();
    if (JSON.stringify(v) !== JSON.stringify(SEED)) throw new Error(`a client write landed: ${JSON.stringify(v)}`);
  });
  ok('the admin-seeded entry is unchanged');
  await env.cleanup();
  FINISHED = true;
  console.log(`\nplatform-rates-rules(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('platform-rates-rules(emulator): FAILED', e); process.exit(1); });
