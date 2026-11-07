'use strict';
// PLAN 3 — behavioral rules suite: a client (signed out, signed in, a dispatcher) can neither READ nor WRITE
// /form_signals or /form_signal_limits. Only the Admin SDK (the formSignal function, the CLI) touches them.
// Run: npm run test:form-signal-rules     (RTDB emulator)
require('./_emulator-required')('database');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('form-signal-rules(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-formsignal-rules', database: { rules: RULES } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref('dispatchers/disp-uid').set(true);
    await ctx.database().ref('form_signals/2026-10-26/la_musa/send').set({ _count: 1, repriced: 1 });
    await ctx.database().ref('form_signal_limits/abc').set({ count: 1, window_start: 1 });
  });
  const clients = [['signed out', env.unauthenticatedContext()], ['signed in', env.authenticatedContext('cust-uid')], ['a dispatcher', env.authenticatedContext('disp-uid')]];
  for (const [label, ctx] of clients) {
    const db = ctx.database();
    for (const p of ['form_signals', 'form_signals/2026-10-26/la_musa/send', 'form_signal_limits', 'form_signal_limits/abc']) {
      await assertFails(db.ref(p).once('value'));
      await assertFails(db.ref(p).set({ x: 1 }));
    }
    await assertFails(db.ref('form_signals/2026-10-26/la_musa/send/_count').set(99));
    ok(`${label}: read AND write denied on form_signals + form_signal_limits (root, nested, a counter leaf)`);
  }
  // premise: the seeded data is still there, untouched by any client
  await env.withSecurityRulesDisabled(async (ctx) => {
    await assertSucceeds(ctx.database().ref('form_signals').once('value'));
    const v = (await ctx.database().ref('form_signals/2026-10-26/la_musa/send/_count').once('value')).val();
    if (v !== 1) throw new Error(`a client write landed: _count=${v}`);
  });
  ok('the admin-seeded counters are unchanged');
  await env.cleanup();
  FINISHED = true;
  console.log(`\nform-signal-rules(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('form-signal-rules(emulator): FAILED', e); process.exit(1); });
