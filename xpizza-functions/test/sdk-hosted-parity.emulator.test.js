'use strict';
// D4 (Codex handler r1 P1: real-export parity) — hosted no-regression, DETERMINISTICALLY, BASE vs TIP. The BASE handlers
// (53edc481, compiled from git in memory; every module D4 CHANGED resolves to its base twin) and the TIP handlers answer the
// SAME hosted / cash request matrix from the SAME starting state; status, the response body and EVERY database write
// (normalised: attempt ids, poll tokens, timestamps, URLs) must be identical. The matrix covers fresh issuance, the reuse of a
// live checkout, a changed cart, a closed order, the pause, an 86'd item, the competing pause + 86'd refusals, a malformed
// bearer, an unknown restaurant, and cash (fresh + retry). The one ACCEPTED difference (advisor): log order only — never a
// response byte or a write. Run: npm run test:sdk-hosted-parity
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'sdk-parity-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lm.example';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => ({ ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }) }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { availKey } = require('../avail-key');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('sdk-hosted-parity: FAILED — exited without completing'); process.exitCode = 1; } });
const DIR = path.join(__dirname, '..');
const BASE = '53edc481';
// every module D4 CHANGED (git diff --name-only 53edc481, non-test); D4's NEW modules do not exist at base, so base never loads them
const BASE_FILES = ['index.js', 'pixelpay-hosted-charge.js', 'rewards-reserve.js', 'payments/sdk/coordinator.js', 'payments/sdk/deps.js', 'payments/sdk/fake-adapter.js',
  'payments/sdk/functions.js', 'payments/sdk/psp-adapter.js', 'payments/sdk/rules-clauses.js', 'payments/sdk/sweeper.js'];
const baseMods = {};
function resolveBaseId(fromFile, id) {
  if (!id.startsWith('.')) return null;
  const rel = path.relative(DIR, path.resolve(path.dirname(path.join(DIR, fromFile)), id)).replace(/\\/g, '/');
  const f = rel.endsWith('.js') ? rel : `${rel}.js`;
  return BASE_FILES.includes(f) ? f : null;
}
function loadBase(rel) {
  if (baseMods[rel]) return baseMods[rel].exports;
  const src = execFileSync('git', ['show', `${BASE}:xpizza-functions/${rel}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 28 });
  const filename = path.join(DIR, rel);
  const m = new Module(filename, module);
  m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  const real = m.require.bind(m);
  m.require = (id) => { const b = resolveBaseId(rel, id); return b ? loadBase(b) : real(id); };
  baseMods[rel] = m;
  m._compile(src, filename);
  return m.exports;
}
function post(handler, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json({ limit: '1mb' })); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        const hdr = {}; for (const k of ['retry-after', 'content-type', 'allow']) if (r.headers.get(k) != null) hdr[k] = r.headers.get(k);
        s.close(() => resolve({ status: r.status, json: j, text: t, headers: hdr }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
async function wipe() {
  const url = rtdb.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: the RTDB handle resolves to ${url}`);
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing to wipe: Firestore is not the local emulator');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
}
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
const LINE = { x_pizza: { name: 'Margherita', qty: 1, price: 0 }, la_musa: { id: 'rice_02', name: 'rice_02', qty: 1, price: 0 } };
const body = (rid, oid, extra = {}) => ({ restaurant_id: rid, order_id: oid, customer_name: 'Ana Pérez', customer_phone: '99770001', customer_email: 'ana.perez@gmail.com',
  items_text: `1x ${LINE[rid].name}`, order_type: 'pickup', payment_method: 'online', items: [LINE[rid]], ...extra });
const BEARER = () => ({ Authorization: `Bearer ${process.env.MAKE_SECRET}` });

const leaves = (v, pre = '', out = new Map()) => { if (v && typeof v === 'object') { for (const k of Object.keys(v)) leaves(v[k], pre ? `${pre}/${k}` : k, out); } else out.set(pre, v); return out; };
const snapshot = async () => (await rtdb.ref().get()).val() || {};
function normalised(before, after, resp) {
  const b = leaves(before), a = leaves(after);
  const toks = new Set();
  for (const [k, v] of a) if (/(attempt_id|poll_token|tracking_token|claim_id|hosted_order_id)$/.test(k) && typeof v === 'string') toks.add(v);
  for (const k of a.keys()) { const m = k.match(/^(?:payment_attempts|order_tracking)\/([^/]+)/); if (m) toks.add(m[1]); }
  const norm = (s) => { let x = String(s); for (const t of [...toks].sort((p, q) => q.length - p.length)) x = x.split(t).join('<tok>'); return x.replace(/https:\/\/pay\.test\/[^"\s]+/g, '<url>').replace(/\/-[A-Za-z0-9_-]{19}/g, '/<push>'); };
  const val = (k, v) => (typeof v === 'number' && v > 1.6e12 && v < 4e12 ? '<t>' : /(_at|timestamp|expires)$/.test(k) && typeof v === 'string' ? '<t>' : norm(v));
  const changed = {};
  for (const k of new Set([...b.keys(), ...a.keys()])) if (b.get(k) !== a.get(k)) changed[norm(k)] = a.has(k) ? val(k, a.get(k)) : '<deleted>';
  return { status: resp.status, headers: resp.headers, body: JSON.parse(norm(JSON.stringify(resp.json || null)).replace(/"(?:[a-z_]*_at|timestamp)":\d+/g, '"t":0')), changed };
}

(async () => {
  try {
    await wipe();
    for (const rid of ['x_pizza', 'la_musa']) {
      await fs.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
      const seed = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'sdk-parity-seed' });
      await publishVersion(fs, rid, seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
      await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: HOURS });
    }
    const base = loadBase('index.js');
    assert.ok(base.chargeOnlineOrder && base.chargeOnlineOrder !== app.chargeOnlineOrder && !base.placeSdkOrder, 'premise — the BASE handlers are distinct and have no SDK export');
    const S0 = await snapshot();
    const M = availKey('Margherita');
    // [name, setup(state ⇒ writes), the request sequence [handler, body, headers]]
    const MATRIX = [
      ['fresh issuance + its reuse', async () => {}, [['charge', body('x_pizza', 'par_fresh'), BEARER()], ['charge', body('x_pizza', 'par_fresh'), BEARER()]]],
      ['a changed cart on the same id', async () => {}, [['charge', body('x_pizza', 'par_cart'), BEARER()], ['charge', body('x_pizza', 'par_cart', { items: [{ ...LINE.x_pizza, qty: 2 }], items_text: '2x Margherita' }), BEARER()]]],
      ['a closed (cancelled) order', async () => { await rtdb.ref('orders/par_closed').set({ order_id: 'par_closed', restaurant_id: 'x_pizza', status: 'cancelled', payment_method: 'online', payment_status: 'pending', created_at: 1 }); }, [['charge', body('x_pizza', 'par_closed'), BEARER()]]],
      ['the pause', async () => { await rtdb.ref('order_control/la_musa/current').set({ paused: true }); }, [['charge', body('la_musa', 'par_pause'), BEARER()]]],
      ['an 86\'d item', async () => { await rtdb.ref(`restaurants/x_pizza/item_availability/${M}`).set({ available: false, updated_at: 1 }); }, [['charge', body('x_pizza', 'par_86'), BEARER()]]],
      ['the pause + an 86\'d item (competing refusals)', async () => { await rtdb.ref('order_control/x_pizza/current').set({ paused: true }); await rtdb.ref(`restaurants/x_pizza/item_availability/${M}`).set({ available: false, updated_at: 1 }); }, [['charge', body('x_pizza', 'par_both'), BEARER()]]],
      ['a malformed bearer', async () => {}, [['charge', body('x_pizza', 'par_bearer'), { Authorization: 'Bearer wrong' }], ['charge', body('x_pizza', 'par_bearer2'), { Authorization: 'Basic x' }]]],
      ['an unknown restaurant', async () => {}, [['charge', body('x_pizza', 'par_rid', { restaurant_id: 'no_such_rid' }), BEARER()]]],
      ['cash: fresh + its retry', async () => {}, [['cash', body('x_pizza', 'par_cash', { payment_method: 'cash' }), BEARER()], ['cash', body('x_pizza', 'par_cash', { payment_method: 'cash' }), BEARER()]]],
    ];
    const H = (h) => ({ charge: h.chargeOnlineOrder, cash: h.createOrder });
    for (const [name, setup, seq] of MATRIX) {
      const runOn = async (h) => {
        await rtdb.ref().set(S0); await setup();
        const out = [];
        for (const [kind, b, hdr] of seq) {
          await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove();
          const before = await snapshot();
          const r = await post(H(h)[kind], b, hdr);
          await new Promise((res) => setTimeout(res, 400));   // fire-and-forget writes settle
          out.push(normalised(before, await snapshot(), r));
        }
        return out;
      };
      const b = await runOn(base); const t = await runOn(app);
      assert.ok(b.length && b.every((x) => x.status > 0), `${name}: premise — the base answered`);
      assert.deepStrictEqual(t, b, `🔴 ${name}: the TIP's status / headers / body / writes differ from the BASE`);
      ok(`${name}: base ≡ tip (${b.map((x) => x.status).join(', ')})`);
    }
    FINISHED = true;
    console.log(`\nsdk-hosted-parity (emulator): OK (${n})`);
    process.exit(0);
  } catch (e) { console.error('sdk-hosted-parity FAILED:', e && (e.stack || e)); process.exit(1); }
})();
