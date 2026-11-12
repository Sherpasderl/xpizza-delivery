'use strict';
// D4 (Codex handler r1 P1 + r2 design gaps) — hosted no-regression, DETERMINISTICALLY, BASE vs TIP, through the real exports.
//   (a) ISOLATED graphs: every scenario loads a FRESH module graph per side — the BASE graph from git (53edc481, the WHOLE
//       transitive relative graph, so no tip module ever leaks into it) and the TIP graph from the working tree — so caches start
//       cold on both sides. Shared: node_modules and the ONE firebase-admin app (lib/admin.js, asserted byte-identical at base).
//   (b) ORDERED writes, type-preserving: every RTDB write (set / update / remove / push / transaction) is recorded in order with
//       its CLIENT-side value (a server timestamp stays the {'.sv'} sentinel), and EVERY response header except date / connection.
//   (c) TIME is pinned (a logical clock, the same instant for both sides of a scenario); each scenario first asserts that the BASE
//       reaches its INTENDED outcome, then that the TIP is identical.
//   (d) the matrix: fresh issuance + reuse, a changed cart, closed, the pause, an 86'd item, pause + 86'd (competing), malformed
//       bearers, an unknown restaurant, cash fresh + retry, DELIVERY, SCHEDULED, REDEMPTION (quote-token path) and the
//       MISSING-ATTEMPT recovery. Random ids (attempt / poll / push keys) are renamed in first-appearance order.
// The one ACCEPTED difference (advisor): log order only. Run: npm run test:sdk-hosted-parity
require('./_emulator-required')('database', 'firestore');
const REAL_NOW = Date.now.bind(Date);
let CLOCK = REAL_NOW() + 3600 * 1000;
Date.now = () => CLOCK;

const assert = require('assert');
const http = require('http');
const path = require('path');
const fsys = require('fs');
const Module = require('module');
const { execFileSync } = require('child_process');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'sdk-parity-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'sdk-parity-quote-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lm.example';
// the external effects: stubbed IDENTICALLY in both graphs
const STUBS = {
  'whatsapp.js': (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }),
  'pixelpay-hosted.js': (r) => ({ ...r, createHostedCharge: async (q) => ({ ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }) }),
};
{ const p = require.resolve('firebase-admin/auth'); const real = require('firebase-admin/auth'); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: { ...real, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) } }; }

const DIR = path.join(__dirname, '..');
const REPO = path.join(DIR, '..');
const BASE = '53edc481';
const SHARED = new Set(['xpizza-functions/lib/admin.js']);   // the ONE process-wide firebase-admin app
require('../lib/admin');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const baseList = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', BASE], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n'));
const readSrc = (side, repoRel) => (side === 'base' ? execFileSync('git', ['show', `${BASE}:${repoRel}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 }) : fsys.readFileSync(path.join(REPO, repoRel), 'utf8'));
const exists = (side, repoRel) => (side === 'base' ? baseList.has(repoRel) : fsys.existsSync(path.join(REPO, repoRel)) && fsys.statSync(path.join(REPO, repoRel)).isFile());
function loadGraph(side) {
  const mods = new Map();
  const resolveRel = (fromRepoRel, id) => {
    const abs = path.resolve(path.dirname(path.join(REPO, fromRepoRel)), id);
    const rel = path.relative(REPO, abs).replace(/\\/g, '/');
    for (const c of [rel, `${rel}.js`, `${rel}.json`, `${rel}/index.js`]) if (exists(side, c)) return c;
    throw new Error(`${side}: cannot resolve ${id} from ${fromRepoRel}`);
  };
  const load = (repoRel) => {
    if (SHARED.has(repoRel)) return require(path.join(REPO, repoRel));
    if (mods.has(repoRel)) return mods.get(repoRel).exports;
    const filename = path.join(REPO, repoRel);
    const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
    mods.set(repoRel, m);
    if (repoRel.endsWith('.json')) { m.exports = JSON.parse(readSrc(side, repoRel)); return m.exports; }
    const real = m.require.bind(m);
    m.require = (id) => (id.startsWith('.') ? load(resolveRel(repoRel, id)) : real(id));
    m._compile(readSrc(side, repoRel), filename);
    const base = path.basename(repoRel);
    if (repoRel.startsWith('xpizza-functions/') && STUBS[base] && repoRel === `xpizza-functions/${base}`) m.exports = STUBS[base](m.exports);
    return m.exports;
  };
  return load('xpizza-functions/index.js');
}
assert.strictEqual(readSrc('base', 'xpizza-functions/lib/admin.js'), readSrc('tip', 'xpizza-functions/lib/admin.js'), 'premise — the shared admin module is byte-identical at base and tip');

// (b) the ORDERED write recorder (client-side values; the same SDK serves both graphs)
const refProto = (() => { let p = Object.getPrototypeOf(rtdb.ref('x')); while (p && !Object.prototype.hasOwnProperty.call(p, 'update')) p = Object.getPrototypeOf(p); return p; })();
let REC = null;
const pathOf = (r) => { try { return decodeURIComponent(new URL(r.toString()).pathname).replace(/^\//, ''); } catch (_) { return '?'; } };
for (const op of ['set', 'update', 'remove', 'push', 'transaction', 'setWithPriority']) {
  const orig = refProto[op]; if (typeof orig !== 'function') continue;
  refProto[op] = function (...a) {
    if (!REC) return orig.apply(this, a);
    const entry = { op, path: pathOf(this) };
    if (op === 'transaction') { REC.push(entry); return orig.apply(this, a).then((res) => { entry.committed = !!(res && res.committed); entry.value = res && res.snapshot ? res.snapshot.val() : null; return res; }); }
    entry.value = a[0] === undefined ? null : JSON.parse(JSON.stringify(a[0]));
    REC.push(entry);
    return orig.apply(this, a);
  };
}
function post(handler, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json({ limit: '1mb' })); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        const hdr = {}; r.headers.forEach((v, k) => { if (!['date', 'connection', 'keep-alive'].includes(k)) hdr[k] = v; });
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
// random ids renamed in first-appearance order (type-preserving otherwise)
function canon(x) {
  const seen = new Map(); const rename = (s) => { if (!seen.has(s)) seen.set(s, `<id${seen.size + 1}>`); return seen.get(s); };
  const TOKEN_KEY = /(attempt_id|poll_token|tracking_token|claim_id|hosted_order_id|active_attempt_id)$/;
  const toks = new Set();
  (function scan(v, k) { if (v && typeof v === 'object') { for (const [kk, vv] of Object.entries(v)) { if (/^(payment_attempts|order_tracking)\//.test(String(kk)) || /^-[A-Za-z0-9_-]{19}$/.test(kk)) toks.add(kk.split('/')[1] || kk); scan(vv, kk); } } else if (typeof v === 'string' && TOKEN_KEY.test(String(k || ''))) toks.add(v); })(x);
  for (const e of (x.writes || [])) { const m = e.path.match(/^(?:payment_attempts|order_tracking)\/([^/]+)/); if (m) toks.add(m[1]); const p = e.path.match(/\/(-[A-Za-z0-9_-]{19})/); if (p) toks.add(p[1]); }
  const sorted = [...toks].filter(Boolean).sort((p, q) => q.length - p.length);
  const fix = (s) => { let o = s; for (const t of sorted) if (o.includes(t)) o = o.split(t).join(rename(t)); return o; };
  return JSON.parse(fix(JSON.stringify(x)));
}
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
const HUB = { lat: 14.1, lng: -87.2 };
const PIN = { lat: HUB.lat + 1 / 111.195, lng: HUB.lng };
const LINE = { x_pizza: { name: 'Margherita', qty: 1, price: 0 }, la_musa: { id: 'rice_02', name: 'rice_02', qty: 1, price: 0 } };
const body = (rid, oid, extra = {}) => ({ restaurant_id: rid, order_id: oid, customer_name: 'Ana Pérez', customer_phone: '99770001', customer_email: 'ana.perez@gmail.com',
  items_text: `1x ${LINE[rid].name}`, order_type: 'pickup', payment_method: 'online', items: [LINE[rid]], ...extra });
const BEARER = { Authorization: `Bearer ${process.env.MAKE_SECRET}` };

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('sdk-hosted-parity: FAILED — exited without completing'); process.exitCode = 1; } });

(async () => {
  try {
    await wipe();
    const { publishVersion } = require('../catalog/catalog-publish');
    const { buildPublishCandidate } = require('../tools/publish-version');
    const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
    const { availKey } = require('../avail-key');
    for (const rid of ['x_pizza', 'la_musa']) {
      await fs.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
      const seed = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'sdk-parity-seed' });
      await publishVersion(fs, rid, seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
      await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, hours: HOURS });
    }
    await rtdb.ref('config/redemption_enabled').set(true);
    await rtdb.ref('user_rewards/u_par/x_pizza').set({ balance: 100, reserved: 0 });
    const S0 = (await rtdb.ref().get()).val();
    const M = availKey('Margherita');
    const T0 = CLOCK;
    const slot = (() => { const d = new Date(T0 + 3 * 3600e3); d.setMinutes(0, 0, 0); return d.getTime(); })();
    const REWARD = { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' };
    const PAID = { name: 'Carnivora', qty: 1, price: 0, extras: [] };
    // [name, setup, steps (a request [kind, body, headers] | an async (h) => body-builder step), the BASE's intended statuses]
    const MATRIX = [
      ['fresh issuance + its reuse', null, [['charge', body('x_pizza', 'par_fresh'), BEARER], ['charge', body('x_pizza', 'par_fresh'), BEARER]], [200, 200]],
      ['a changed cart on the same id', null, [['charge', body('x_pizza', 'par_cart'), BEARER], ['charge', body('x_pizza', 'par_cart', { items: [{ ...LINE.x_pizza, qty: 2 }], items_text: '2x Margherita' }), BEARER]], [200, 409]],
      ['a closed (cancelled) order', async () => rtdb.ref('orders/par_closed').set({ order_id: 'par_closed', restaurant_id: 'x_pizza', status: 'cancelled', payment_method: 'online', payment_status: 'pending', created_at: 1 }), [['charge', body('x_pizza', 'par_closed'), BEARER]], [409]],
      ['the pause', async () => rtdb.ref('order_control/la_musa/current').set({ paused: true }), [['charge', body('la_musa', 'par_pause'), BEARER]], [423]],
      ['an 86\'d item', async () => rtdb.ref(`restaurants/x_pizza/item_availability/${M}`).set({ available: false, updated_at: 1 }), [['charge', body('x_pizza', 'par_86'), BEARER]], [400]],
      ['the pause + an 86\'d item (competing)', async () => { await rtdb.ref('order_control/x_pizza/current').set({ paused: true }); await rtdb.ref(`restaurants/x_pizza/item_availability/${M}`).set({ available: false, updated_at: 1 }); }, [['charge', body('x_pizza', 'par_both'), BEARER]], [423]],
      ['malformed bearers', null, [['charge', body('x_pizza', 'par_b1'), { Authorization: 'Bearer wrong' }], ['charge', body('x_pizza', 'par_b2'), { Authorization: 'Basic x' }]], [401, 401]],
      ['an unknown restaurant', null, [['charge', body('x_pizza', 'par_rid', { restaurant_id: 'no_such_rid' }), BEARER]], [400]],
      ['cash: fresh + its retry', null, [['cash', body('x_pizza', 'par_cash', { payment_method: 'cash' }), BEARER], ['cash', body('x_pizza', 'par_cash', { payment_method: 'cash' }), BEARER]], [200, 200]],
      ['delivery', null, [['charge', body('x_pizza', 'par_deliv', { order_type: 'delivery', lat: PIN.lat, lng: PIN.lng, pin_confirmed: true, address_detected: 'Calle Principal', address_details: 'portón' }), BEARER]], [200]],
      ['scheduled', null, [['charge', body('x_pizza', 'par_sched', { scheduled_for: slot }), BEARER]], [200]],
      ['redemption (quote-token path)', null, [async (h) => {
        const items = [PAID]; const q = await post(h.quoteRedemption, { restaurant_id: 'x_pizza', items, redeem: REWARD, mode: 'pickup' }, BEARER);
        return ['charge', body('x_pizza', 'par_redeem', { items, items_text: '1x Carnivora', redeem: REWARD, quote_token: q.json && q.json.quote_token, expected_net_cents: q.json && q.json.net_total_cents }), { ...BEARER, 'x-firebase-id-token': 'u_par' }];
      }], [200]],
      ['the missing-attempt recovery', null, [['charge', body('x_pizza', 'par_recover'), BEARER], async () => { const o = (await rtdb.ref('orders/par_recover').get()).val(); await rtdb.ref(`payment_attempts/${o.active_attempt_id}`).remove(); return null; }, ['charge', body('x_pizza', 'par_recover'), BEARER]], [200, 200]],
    ];
    let k = 0;
    for (const [name, setup, steps, intended] of MATRIX) {
      k += 1;
      const runOn = async (side) => {
        CLOCK = T0 + k * 3600e3;   // the SAME instant on both sides
        REC = null; await rtdb.ref().set(S0); if (setup) await setup();
        const h = loadGraph(side);
        const out = [];
        for (const st of steps) {
          REC = null; await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove();
          const req = typeof st === 'function' ? await st(h) : st;
          if (!req) continue;   // a state step (unrecorded)
          const [kind, b, hdr] = req;
          REC = [];
          const r = await post(kind === 'cash' ? h.createOrder : h.chargeOnlineOrder, b, hdr);
          await new Promise((res) => setTimeout(res, 400));   // fire-and-forget writes settle
          out.push({ status: r.status, headers: r.headers, body: r.json, writes: REC });
          REC = null;
        }
        return canon({ out });
      };
      const b = await runOn('base');
      assert.deepStrictEqual(b.out.map((x) => x.status), intended, `${name}: the BASE reaches its INTENDED outcome (${JSON.stringify(b.out.map((x) => [x.status, x.body]))})`);
      const t = await runOn('tip');
      assert.deepStrictEqual(t, b, `🔴 ${name}: the TIP's status / headers / body / ORDERED writes differ from the BASE`);
      ok(`${name}: base ≡ tip (${intended.join(', ')})`);
    }
    FINISHED = true;
    console.log(`\nsdk-hosted-parity (emulator): OK (${n})`);
    process.exit(0);
  } catch (e) { console.error('sdk-hosted-parity FAILED:', e && (e.stack || e)); process.exit(1); }
})();
