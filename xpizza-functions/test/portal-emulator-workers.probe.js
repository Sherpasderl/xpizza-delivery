'use strict';
// PORTAL SPEED P1 — EVIDENCE PROBE (not in a test chain): the REAL Functions emulator runs each trigger in a worker
// with FUNCTION_TARGET set (firebase-tools functionsEmulator.js), i.e. the production routing. Calls every portal
// function and two non-portal HTTP functions over the emulator's HTTP surface; the emulator's own log (the runner's
// output) shows `portal_isolated_entry <name>` for the portal workers and no marker for the others.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" node tools/emulator-run.js --only functions,firestore,database --project demo-xpizza "node test/portal-emulator-workers.probe.js"
const assert = require('assert');
(async () => {
  const hub = process.env.FIREBASE_EMULATOR_HUB;
  assert.ok(hub, 'run under tools/emulator-run.js');
  const list = await (await fetch(`http://${hub}/emulators`)).json();
  const fx = list.functions; assert.ok(fx, 'functions emulator running');
  const base = `http://${fx.host}:${fx.port}/demo-xpizza/us-central1`;
  const out = [];
  for (const [fn, q] of [['getMyRestaurants', ''], ['getEditableCatalog', '?restaurantId=x_pizza'], ['getSalesStats', '?restaurantId=x_pizza'], ['editCatalog', ''], ['publishEdited', ''],
    ['getPublicMenu', '/menu/x_pizza'], ['reportClientVersion', '']]) {
    const method = ['editCatalog', 'publishEdited', 'reportClientVersion'].includes(fn) ? 'POST' : 'GET';
    const r = await fetch(`${base}/${fn}${q}`, { method, headers: { 'Content-Type': 'application/json', Origin: 'https://sherpa-portal.netlify.app' }, body: method === 'POST' ? '{}' : undefined });
    const text = await r.text();
    out.push({ fn, status: r.status, body: text.slice(0, 80) });
  }
  console.log('EMULATOR_WORKER_CALLS', JSON.stringify(out));
  for (const o of out.slice(0, 5)) assert.strictEqual(o.status, o.fn === 'editCatalog' || o.fn === 'publishEdited' ? 400 : 401, `${o.fn}: ${JSON.stringify(o)}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
