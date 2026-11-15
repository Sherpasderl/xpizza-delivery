'use strict';
// S2b (PLAN-structure-S2b-r3 §6, Codex r2 P1-1) — the ADMISSION GATE. With MINT_OPAQUE_EXTRAS ON, the 4 identity intakes (createOrder,
// chargeOnlineOrder, quoteOrder, quoteRedemption) admit ONLY the platform orders deployment and its declared native deployment (manifest
// DATA: PLATFORM.isAppDeployment, X-Client-App = orders); every restaurant-context orders deployment (the frozen forms), a header-less
// request and an unknown / foreign one are refused client_retired (410) — right after the client_version log line, before the floor
// read and any write. OFF: no check (null for every request). The request headers are the REAL ones: the shared client
// (platform/client/sherpa-client.js) stamped as each manifest deployment, its wrapper's headers lower-cased as Express delivers them,
// read by the REAL client-floor.readClientHeaders. Run: node catalog/s2b-admission.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SW = { on: false };
{ const p = require.resolve('./extra-identity'); const real = require('./extra-identity');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, extraIdentityCapabilities: () => ({ mintExtras: SW.on }) } }; }
const CF = require('../client-floor');
const { PLATFORM } = require('../platform-manifest');
const SherpaClient = require('../../platform/client/sherpa-client.js');
let n = 0; const fails = [];
function cell(label, fn) { return Promise.resolve().then(fn).then(() => console.log(`  ✓ ${++n} ${label}`), (e) => { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); }); }
const ON = async (fn) => { SW.on = true; try { return await fn(); } finally { SW.on = false; } };
const gate = () => require('./client-retired').retiredClientRefusal;

// the REAL stamped request: the shared client created over a page whose meta tags are the build stamp's for that deployment
async function stampedHeaders(identity, endpoint = 'createOrder') {
  const meta = identity ? { 'sherpa-app': identity.app, 'sherpa-deployment': identity.deployment, 'sherpa-context': identity.context, 'app-build': 'b1', 'app-compat': '3', 'sherpa-env': 'production' } : {};
  const doc = { querySelector: (sel) => { const m = /name="([^"]+)"/.exec(sel); const v = m && meta[m[1]]; return v == null ? null : { getAttribute: () => v }; }, addEventListener() {}, visibilityState: 'visible' };
  let seen = null;
  const w = { document: doc, location: { reload() {} }, console: { warn() {} }, setTimeout: () => 0, setInterval: () => 0, addEventListener() {}, sessionStorage: null };
  const c = SherpaClient.create({ window: w, document: doc, fetch: async (u, init) => { if (String(u).endsWith(`/${endpoint}`)) seen = (init && init.headers) || {}; return { ok: true, status: 200, json: async () => ({}) }; }, setTimeout: () => 0, setInterval: () => 0 });
  await c.fetch(`https://example.invalid/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  return { headers: Object.fromEntries(Object.entries(seen || {}).map(([k, v]) => [k.toLowerCase(), v])) };
}
const RETIRED = { status: 410, body: { error: 'client_retired' } };
const deployments = PLATFORM.sites.deployments;
const forms = deployments.filter((d) => d.app === 'orders' && d.context !== 'platform');
const app = deployments.find((d) => d.app === 'orders' && d.context === 'platform');

(async () => {
  await cell('premise: the manifest declares the restaurant-context orders deployments and the platform app + its native', () => {
    assert.ok(forms.length >= 2, 'at least two restaurant-context orders deployments');
    assert.ok(app && PLATFORM.nativeDeployment(), 'the platform orders deployment and its native one');
  });
  await cell('ADM-OFF: switch OFF → no check for any request (null), the stamped forms and a header-less request included', async () => {
    for (const d of forms) assert.strictEqual(gate()(CF.readClientHeaders(await stampedHeaders({ app: d.app, deployment: d.id, context: d.context }))), null, d.id);
    assert.strictEqual(gate()(CF.readClientHeaders(await stampedHeaders(null))), null, 'header-less');
  });
  await cell('ADM-FORMS: ON, every restaurant-context orders deployment (a REAL stamped request) → client_retired 410', () => ON(async () => {
    for (const d of forms) {
      const req = await stampedHeaders({ app: d.app, deployment: d.id, context: d.context });
      assert.strictEqual(req.headers['x-client-deployment'], d.id, `premise: the client stamped ${d.id}`);
      assert.deepStrictEqual(gate()(CF.readClientHeaders(req)), RETIRED, d.id);
    }
  }));
  await cell('ADM-HEADERLESS: ON, an unstamped (cached-form) request carries no X-Client-* → client_retired', () => ON(async () => {
    const req = await stampedHeaders(null);
    assert.ok(!('x-client-app' in req.headers), 'premise: no headers when unstamped');
    assert.deepStrictEqual(gate()(CF.readClientHeaders(req)), RETIRED);
  }));
  await cell('ADM-APP: ON, the platform orders deployment and its declared native deployment are admitted (null)', () => ON(async () => {
    assert.strictEqual(gate()(CF.readClientHeaders(await stampedHeaders({ app: app.app, deployment: app.id, context: app.context }))), null, app.id);
    assert.strictEqual(gate()(CF.readClientHeaders(await stampedHeaders({ app: app.app, deployment: PLATFORM.nativeDeployment(), context: app.context }))), null, 'native');
  }));
  await cell('ADM-FOREIGN: ON, an unknown deployment and a non-orders app naming the app deployment → client_retired', () => ON(async () => {
    assert.deepStrictEqual(gate()(CF.readClientHeaders(await stampedHeaders({ app: 'orders', deployment: 'orders-otro', context: 'platform' }))), RETIRED, 'unknown');
    assert.deepStrictEqual(gate()(CF.readClientHeaders(await stampedHeaders({ app: 'portal', deployment: app.id, context: 'platform' }))), RETIRED, 'foreign app');
  }));
  await cell('ADM-WIRING: the 4 identity intakes refuse on the client_version log line — before the floor read and any write', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8').split('\n');
    for (const ep of ['createOrder', 'chargeOnlineOrder', 'quoteOrder', 'quoteRedemption']) {
      const i = src.findIndex((l) => l.includes(`CF.logClientVersion('${ep}', clientHdr);`));
      assert.ok(i > 0, `premise: ${ep} logs its client`);
      assert.ok(src[i].trim() === `CF.logClientVersion('${ep}', clientHdr); { const rc = require('./catalog/client-retired').retiredClientRefusal(clientHdr); if (rc) return res.status(rc.status).json(rc.body); }   // S2b §6: the admission gate (ON only)`, `${ep}: the gate on the log line`);
      assert.ok(/floorFor\('orders'\)/.test(src[i + 1]), `${ep}: the floor read comes after`);
    }
  });
  if (fails.length) { console.error(`s2b-admission FAILED ${fails.length} cell(s): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`s2b-admission: OK (${n})`);
})();
