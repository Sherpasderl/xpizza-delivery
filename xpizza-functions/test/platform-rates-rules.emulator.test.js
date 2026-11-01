'use strict';
// PAY RATE (PROPOSAL-driver-pay-rate-reader r2) — behavioral rules suite for /platform_rates/driver_per_delivery:
//   READ  allowed: a driver (signed in, no special claim), a dispatcher;
//   READ  denied:  a customer token, a handheld token, signed out;
//   WRITE denied:  everyone above (set an entry, push a new one, overwrite the node) — only the Admin SDK (the owner CLI) writes.
//   .validate:     the entry bounds (pay-rate.js's contract). With .write:false everywhere RTDB never evaluates .validate for a
//                  client, and the Admin SDK skips it, so phase 2 loads a TEST-ONLY variant of the SAME rules with
//                  platform_rates/.write opened to signed-in users, and drives the real .validate string against the emulator.
// Run: npm run test:platform-rates-rules     (RTDB emulator — HEAVY, slot only)
require('./_emulator-required')('database');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const NODE = 'platform_rates/driver_per_delivery';
const P = require('../pay-rate');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('platform-rates-rules(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-platform-rates-rules', database: { rules: RULES } });
  const SEED = { '-Nseed': { cents: 7000, effective_from: P.MIN_EFFECTIVE_FROM } };
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

  // ── phase 2: the entry .validate itself (test-only write grant; the .validate string is the committed one, untouched) ──
  const parsed = JSON.parse(RULES);
  parsed.rules.platform_rates['.write'] = 'auth != null';
  const envV = await initializeTestEnvironment({ projectId: 'demo-xpizza-platform-rates-validate', database: { rules: JSON.stringify(parsed) } });
  if (parsed.rules.platform_rates.driver_per_delivery.$entry['.validate'] !== JSON.parse(RULES).rules.platform_rates.driver_per_delivery.$entry['.validate']) throw new Error('the test variant altered the .validate');
  const w = envV.authenticatedContext('writer-uid').database();
  const now = Date.now();
  const DAY = 86400000;
  let k = 0;
  const put = (e) => w.ref(`${NODE}/-Nv${++k}`).set(e);
  for (const e of [{ cents: 100, effective_from: P.MIN_EFFECTIVE_FROM }, { cents: 100000, effective_from: P.MIN_EFFECTIVE_FROM }, { cents: 7000, effective_from: now },
    { cents: 7000, effective_from: now + 365 * DAY }]) await assertSucceeds(put(e));
  ok('.validate ACCEPTS in-bounds entries: cents 100 and 100000, effective_from 2026-01-01Z, now, now + 365 d');
  for (const e of [{ cents: 99, effective_from: now }, { cents: 100001, effective_from: now }, { cents: 9007199254740991, effective_from: now }, { cents: 70.5, effective_from: now },
    { cents: 0, effective_from: now }, { cents: -5, effective_from: now }, { cents: '7000', effective_from: now },
    { cents: 7000, effective_from: -1 }, { cents: 7000, effective_from: 0 }, { cents: 7000, effective_from: P.MIN_EFFECTIVE_FROM - 1 }, { cents: 7000, effective_from: now + 0.5 },
    { cents: 7000, effective_from: now + 367 * DAY }, { cents: 7000, effective_from: String(now) }, { cents: 7000 }, { effective_from: now },
    { cents: 7000, effective_from: now, extra: 1 }]) await assertFails(put(e));
  ok('.validate REJECTS: cents 99 / 100001 / MAX_SAFE_INTEGER / fractional / 0 / negative / string; effective_from −1 / 0 / 1 ms before 2026 / fractional / > now + 366 d / string; a missing field; an extra child');
  await envV.cleanup();
  FINISHED = true;
  console.log(`\nplatform-rates-rules(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('platform-rates-rules(emulator): FAILED', e); process.exit(1); });
