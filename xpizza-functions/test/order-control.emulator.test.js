'use strict';
// D4-c4 "Pausar pedidos" — every enforcement seam through the REAL handlers on the RTDB + Firestore emulators, composed with
// BOTH brands' real order pages (PLAN-D4c4 rev 13 §3/§3a/§0.2/§0.4/§0.5/§8). Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:order-control
//
// Each case's state is made by the REAL writers (createOrder / chargeOnlineOrder themselves, the KDS / webhook field
// writes) and the request goes through the real handler — createOrder, chargeOnlineOrder, the scheduled sweep
// (sweepScheduledReleases.run) and the manual release (releaseScheduledOrder). Every case runs under each switch state:
//   absent · open (paused:false) · expired (paused, until in the past) · paused (no end) · paused_until (future until) ·
//   unknown_read (the switch read fails) · unknown_malformed ({paused:"true", until:"123"})
// Recorded per case: status, response BODY, the relevant headers (Retry-After), the ordered RTDB + Firestore call
// sequence, and the set of changed database paths.
//
// REPRODUCE-FIRST / BASELINE. ORDER_CONTROL_CAPTURE=<file>, run inside a checkout of e1aeb3f (no pause switch), records
// every case — the switch node is inert there, so every state behaves as today. That file is frozen as
// test/order-control-base.golden.json — never regenerate it from the candidate.
// CANDIDATE (default):
//   · every case that must be UNCHANGED (any switch state for an existing-order answer, a reuse, in_progress,
//     already_paid; OPEN / absent / expired-until for everything) EQUALS the baseline: status, body, headers, call
//     sequence (minus ONLY the added control read — and createOrder's existing-order paths add NONE), changed paths;
//   · every case that must be REFUSED (fresh intake while paused / unknown; a classifier failure while paused / unknown;
//     the race guard) answers EXACTLY 423 ordering_paused or the retryable 503 (+ Retry-After 2), wrote NOTHING to orders /
//     payment_attempts / rate limits, and left reward holds as the plan says (this call's own released; an existing
//     payable checkout's kept) — while the baseline ADMITTED it (reproduce-first);
//   · the scheduled seam holds (control_held {at, cause}), auto-resumes at `until` and releases; an expired slot keeps
//     today's block; the manual release is refused without clearing a block; a stale releasing claim is held.
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const path = require('path');
const fsys = require('fs');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'oc-secret';
process.env.RECON_SECRET = process.env.RECON_SECRET || 'oc-recon-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
const realWhatsapp = require('../whatsapp');
const wr = require.resolve('../whatsapp');
require.cache[wr] = { id: wr, filename: wr, loaded: true, children: [], paths: [], exports: { ...realWhatsapp, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) } };
const ph = require.resolve('../pixelpay-hosted');
const realHosted = require('../pixelpay-hosted');
require.cache[ph] = { id: ph, filename: ph, loaded: true, children: [], paths: [], exports: { ...realHosted, createHostedCharge: async (r) => ({ ok: true, url: `https://pay.test/${r.pixelpayOrderId}` }) } };
const fa = require.resolve('firebase-admin/auth');
const realAuth = require('firebase-admin/auth');
require.cache[fa] = { id: fa, filename: fa, loaded: true, children: [], paths: [], exports: { ...realAuth, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) } };
const hc = require.resolve('../pixelpay-hosted-charge');
const realHC = require('../pixelpay-hosted-charge');
let FAIL_CLASSIFY = false; let DRIFT = null;
require.cache[hc] = { id: hc, filename: hc, loaded: true, children: [], paths: [], exports: { ...realHC,
  // the race: the REAL classification, then the order/attempt drifts (as a concurrent writer would) before the acquire
  classifyHostedAttempt: async (...a) => { if (FAIL_CLASSIFY) throw new Error('UNAVAILABLE (injected classify failure)'); const r = await realHC.classifyHostedAttempt(...a); if (DRIFT) await DRIFT(a[1]); return r; } } };

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const SCHED = require('../scheduled-orders');
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { publishVersion } = require('../catalog/catalog-publish');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
// the candidate's reader cache is reset between cases (absent at the baseline — the switch does not exist there)
let OC = null; try { OC = require('../order-control'); } catch (_) { OC = null; }
const resetReader = () => { if (OC) OC._resetForTests(); };

const CAPTURE = process.env.ORDER_CONTROL_CAPTURE || '';
const GOLDEN = path.join(__dirname, 'order-control-base.golden.json');
// the §5 strings — written out here (not required) so this file runs unchanged at the baseline
const PAUSED_BODY = { error: 'ordering_paused', detail: 'Este restaurante no está recibiendo pedidos en este momento. Probá de nuevo más tarde.' };
const UNAV_BODY = { error: 'Service temporarily unavailable', detail: 'Tuvimos un problema momentáneo, probá de nuevo.', retryable: true };

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('order-control(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the recorder (the d4b-charge-trace / order-exists recipe) ─────────────────────────────────────────────────────────
let REC = null;
const rel = (u) => { try { return decodeURIComponent(new URL(u).pathname).replace(/^\//, ''); } catch (_) { return String(u); } };
function patchChain(obj, names, describe) {
  const done = new Set();
  for (let p = Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const nm of names) {
      if (done.has(nm) || !Object.prototype.hasOwnProperty.call(p, nm) || typeof p[nm] !== 'function') continue;
      done.add(nm);
      const orig = p[nm];
      p[nm] = function (...a) { if (REC) REC.push(describe(this, nm, a)); return orig.apply(this, a); };
    }
  }
}
const writeShape = (v) => (v && typeof v === 'object' ? { keys: Object.keys(v).sort() } : { type: v === null ? 'null' : typeof v });
patchChain(rtdb.ref('x'), ['get', 'once', 'set', 'update', 'remove', 'transaction', 'push'], (self, nm, a) => ({ db: 'rtdb', op: nm, path: rel((self.ref || self).toString()),
  ...((nm === 'update' || nm === 'set' || (nm === 'push' && a.length)) ? writeShape(a[0]) : {}) }));
const fsDescribe = (self, nm, a) => ({ db: 'fs', op: nm, path: self.path !== undefined ? self.path : (self._queryOptions ? `${self._queryOptions.parentPath.relativeName}/${self._queryOptions.collectionId}?query` : '?'),
  ...((nm === 'set' || nm === 'update' || nm === 'create' || nm === 'add') ? writeShape(a[0]) : {}) });
const docPaths = (a) => a.filter((d) => d && typeof d === 'object' && typeof d.path === 'string' && typeof d.get === 'function').map((d) => d.path);
patchChain(fs.doc('a/b'), ['get', 'set', 'update', 'create', 'delete', 'listCollections'], fsDescribe);
patchChain(fs.collection('a').where('x', '==', 1), ['get'], fsDescribe);
patchChain(fs.collection('a'), ['get', 'add'], fsDescribe);
patchChain(fs, ['getAll', 'runTransaction'], (self, nm, a) => (nm === 'getAll' ? { db: 'fs', op: nm, paths: docPaths(a) } : { db: 'fs', op: nm, path: '' }));
const WRITE_OPS = new Set(['set', 'update', 'remove', 'transaction', 'push', 'create', 'delete', 'add', 'runTransaction']);
const isControlRead = (o) => o.db === 'rtdb' && /^order_control\//.test(o.path);
// the baseline was captured with the test's own per-request `remove rate_limits` inside the recording — not a handler op
const isTestOp = (o) => o.db === 'rtdb' && o.op === 'remove' && o.path === 'rate_limits';
// a TTL-cached config read (the client floor) refreshes on its own clock, not the request's — excluded on BOTH sides
const isCacheRefresh = (o) => o.db === 'rtdb' && /^platform_config\/client_floor\//.test(o.path);

const onceProto = (() => { let p = Object.getPrototypeOf(rtdb.ref('x')); while (p && !Object.prototype.hasOwnProperty.call(p, 'once')) p = Object.getPrototypeOf(p); return p; })();
const realOnce = onceProto.once;
let FAIL_PREFIX = null;   // a read failure injected on every path under this prefix
onceProto.once = function (...a) { if (FAIL_PREFIX && rel(this.toString()).startsWith(FAIL_PREFIX)) return Promise.reject(new Error('UNAVAILABLE (injected read failure)')); return realOnce.apply(this, a); };
async function vanishingOrderAt(pathEq, nth, fn) {
  let k = 0; const prev = onceProto.once;
  onceProto.once = async function (...a) { if (rel(this.toString()) === pathEq && ++k === nth) await rtdb.ref(pathEq).remove(); return prev.apply(this, a); };
  try { return await fn(); } finally { onceProto.once = prev; }
}
const H_LOW = { 'x-client-app': 'orders', 'x-client-deployment': 'orders-xpizza', 'x-client-build': 'b1', 'x-client-compat': '1' };
const H_EQ = { 'x-client-app': 'orders', 'x-client-deployment': 'orders-xpizza', 'x-client-build': 'b2', 'x-client-compat': '2' };
const FLOOR = 2;

// ── the switch states ──────────────────────────────────────────────────────────────────────────────────────────────
const STATES = {
  absent: null,
  open: () => ({ paused: false, version: 2, op_id: 'op-open' }),
  expired: () => ({ paused: true, until: Date.now() - 1000, version: 3, op_id: 'op-exp' }),
  paused: () => ({ paused: true, version: 4, op_id: 'op-p' }),
  paused_until: () => ({ paused: true, until: Date.now() + 3600000, version: 5, op_id: 'op-pu' }),
  unknown_read: () => ({ paused: false, version: 6, op_id: 'op-ur' }),   // stored OPEN — but the read fails
  unknown_malformed: () => ({ paused: 'true', until: '123', version: 7, op_id: 'op-m' }),
};
const ADMIT = new Set(['absent', 'open', 'expired']);
const KIND = { paused: 'paused', paused_until: 'paused', unknown_read: 'unavailable', unknown_malformed: 'unavailable' };
async function setSwitch(rid, state) {
  FAIL_PREFIX = null;
  const v = STATES[state];
  if (v === null) await rtdb.ref(`order_control/${rid}`).remove();
  else await rtdb.ref(`order_control/${rid}/current`).set(v());
  resetReader();
  if (state === 'unknown_read') FAIL_PREFIX = 'order_control/';
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────
async function seed(rid) {
  await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: `oc-${rid}` });
  await publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(fs, rid, catalogSnapshot(rid), { captured: await getActivePointer(fs, rid) });
}
function post(handler, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...headers }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t, headers: { 'retry-after': r.headers.get('retry-after') } }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
const identityFor = (rid) => ({ name: `Rest ${rid}`, phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: HOURS });
let PH = 0;
const phoneFor = () => `9955${String(PH += 1).padStart(4, '0')}`;
function bodyFor(rid, oid, method, { qty = 1, redeem = false, phone, scheduledFor = null }) {
  const s = catalogSnapshot(rid);
  const it = s.items.find((i) => (rid === 'x_pizza' ? i.key === 'Carnivora' : i.key === 'dimsum_01'));
  const items = rid === 'x_pizza' ? [{ name: it.display.name, qty, price: it.price, extras: [] }] : [{ id: it.key, name: it.display.name, cat: it.display.cat, qty, price: it.price, extras: [] }];
  const rd = rid === 'x_pizza' ? { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' } : { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 1, name: 'Arroz' }] };
  return { restaurant_id: rid, order_id: oid, customer_name: 'Order Control', customer_phone: phone, customer_email: 'oc@example.com', items_text: `${qty}x ${it.display.name}`, order_type: 'pickup', payment_method: method, items,
    ...(redeem ? { redeem: rd } : {}), ...(scheduledFor ? { scheduled_for: scheduledFor } : {}) };
}
const send = async (rid, oid, method, opts) => {
  const rec = REC; REC = null;   // the test's own reset is not recorded as the handler's
  await rtdb.ref('rate_limits').remove();   // every request is 127.0.0.1 — the per-IP limit is reset between requests (test env only)
  REC = rec;
  return post(method === 'online' ? app.chargeOnlineOrder : app.createOrder, bodyFor(rid, oid, method, opts), { 'x-firebase-id-token': `u_${rid}`, ...(opts.hdr || {}) });
};
function leaves(v, pre = '', out = new Map()) {
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) leaves(v[k], pre ? `${pre}/${k}` : k, out); } else out.set(pre, JSON.stringify(v));
  return out;
}
const tree = async () => leaves((await rtdb.ref().get()).val() || {});

async function traced(oid, rid, request) {
  const prevFail = FAIL_PREFIX; FAIL_PREFIX = null;
  await rtdb.ref('rate_limits').remove();   // before the snapshot: the request's own reset (in send) is then a no-op
  const before = await tree();
  const pre = (await rtdb.ref(`orders/${oid}`).get()).val() || {};
  FAIL_PREFIX = prevFail;
  REC = [];
  const r = await request();
  await wait(300);   // a fire-and-forget write the handler issued lands inside the recording
  const calls = REC; REC = null;
  FAIL_PREFIX = null;
  const after = await tree();
  const post_ = (await rtdb.ref(`orders/${oid}`).get()).val() || {};
  const subs = [];
  for (const o of [pre, post_]) for (const [k, v] of Object.entries(o)) if (/attempt_id$|poll_token$|tracking_token$|claim_id$/.test(k) && typeof v === 'string' && v.length >= 8) subs.push([v, `<${k}>`]);
  subs.push([oid, '<oid>'], [`u_${rid}`, '<uid>']);
  const norm = (s) => subs.reduce((acc, [from, to]) => acc.split(from).join(to), String(s))
    .replace(/\/-[A-Za-z0-9_-]{19}/g, '/<push>')
    .replace(/versions\/v-\d+-[0-9a-f]+/g, 'versions/<v>')   // the catalog version id is minted per run (publishVersion)
    .replace(/(restaurants\/[^/]+\/identity\/[^/]+\/ids\/)[^/?]+/g, '$1<id>')
    .replace(/(rate_limits\/[^/]+\/)[^/]+/g, '$1<key>')
    .replace(/(recent_order_content\/)[^/]+/g, '$1<key>');
  const ops = calls.map((x) => ({ ...x, ...(x.path !== undefined ? { path: norm(x.path) } : {}), ...(x.paths ? { paths: x.paths.map(norm).sort() } : {}), ...(x.keys ? { keys: x.keys.map(norm) } : {}) }));
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k)).map(norm).sort();
  const body = r.json ? JSON.parse(norm(JSON.stringify(r.json)).replace(/https:\/\/pay\.test\/[^"]+/g, '<checkout_url>')) : null;
  if (body) for (const k of ['poll_token', 'tracking_token', 'attempt_id']) if (typeof body[k] === 'string') body[k] = `<${k}>`;
  return { status: r.status, body, headers: r.headers || {}, ops, changed, raw: r.json };
}

// ── the cases ─────────────────────────────────────────────────────────────────────────────────────────────────────
// expect: 'same' (unchanged in every switch state) | 'fresh' (refused when paused / unknown) | 'classify_failed' (503 when
// paused / unknown) | 'race' (the armed race guard refuses with the request's kind)
const CASES = [];
const def = (name, o) => CASES.push({ name, ...o });
const cashMade = async (rid, oid, phone, opts = {}) => { const r = await send(rid, oid, 'cash', { phone, ...opts }); assert.strictEqual(r.status, 200, `setup cash ${oid}: ${r.text.slice(0, 160)}`); };
const cardMade = async (rid, oid, phone, opts = {}) => { const r = await send(rid, oid, 'online', { phone, ...opts }); assert.strictEqual(r.status, 200, `setup card ${oid}: ${r.text.slice(0, 160)}`); };
const att = async (oid) => (await rtdb.ref(`orders/${oid}/active_attempt_id`).get()).val();
const resv = async (rid, oid) => (await rtdb.ref(`user_rewards/u_${rid}/${rid}/reservations/${oid}`).get()).val();

// createOrder
def('cash FRESH order', { path: 'cash', expect: 'fresh', setup: async () => {}, request: (rid, s) => send(rid, s.oid, 'cash', { phone: s.ph }) });
def('card_delivery FRESH order', { path: 'cash', expect: 'fresh', setup: async () => {}, request: (rid, s) => send(rid, s.oid, 'card_delivery', { phone: s.ph }) });
def('cash FRESH order with a reward', { path: 'cash', expect: 'fresh', setup: async () => {}, request: (rid, s) => send(rid, s.oid, 'cash', { phone: s.ph, redeem: true }) });
def('cash MATCHING retry of an accepted order', { path: 'cash', expect: 'same', noControlRead: true, setup: async (rid, oid, ph) => cashMade(rid, oid, ph), request: (rid, s) => send(rid, s.oid, 'cash', { phone: s.ph }) });
def('cash existing order, cart changed (order_exists)', { path: 'cash', expect: 'same', noControlRead: true, setup: async (rid, oid, ph) => cashMade(rid, oid, ph), request: (rid, s) => send(rid, s.oid, 'cash', { phone: s.ph, qty: 2 }) });
def('cash TERMINAL-SAFE delivered order (legacy literal)', { path: 'cash', expect: 'same', noControlRead: true, compose: 'mint', setup: async (rid, oid, ph) => { await cashMade(rid, oid, ph); await rtdb.ref(`orders/${oid}/status`).set('delivered'); }, request: (rid, s) => send(rid, s.oid, 'cash', { phone: s.ph }) });
def('cash below-floor request, order VANISHES before the create decision (:839 client_update_race)', { path: 'cash', expect: 'same', noControlRead: true, floor: true,
  setup: async (rid, oid, ph) => cashMade(rid, oid, ph, { hdr: H_EQ }), request: (rid, s) => vanishingOrderAt(`orders/${s.oid}`, 2, () => send(rid, s.oid, 'cash', { phone: s.ph, hdr: H_LOW })) });
// chargeOnlineOrder
def('card FRESH checkout', { path: 'card', expect: 'fresh', setup: async () => {}, request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph }) });
def('card FRESH checkout with a reward (nothing reserved)', { path: 'card', expect: 'fresh', setup: async () => {}, request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph, redeem: true }) });
def('card REUSE of a live checkout', { path: 'card', expect: 'same', setup: async (rid, oid, ph) => cardMade(rid, oid, ph), request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph }) });
def('card REUSE of a live checkout holding a reward (the hold stays)', { path: 'card', expect: 'same', setup: async (rid, oid, ph) => cardMade(rid, oid, ph, { redeem: true }), request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph, redeem: true }) });
def('card IN PROGRESS (attempt creating)', { path: 'card', expect: 'same', setup: async (rid, oid, ph) => { await cardMade(rid, oid, ph); await rtdb.ref(`payment_attempts/${await att(oid)}/hosted_state`).set('creating'); }, request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph }) });
def('card ALREADY PAID', { path: 'card', expect: 'same', setup: async (rid, oid, ph) => { await cardMade(rid, oid, ph); await rtdb.ref(`orders/${oid}/payment_status`).set('confirmed'); }, request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph }) });
def('card existing checkout, cart changed (order_exists)', { path: 'card', expect: 'same', setup: async (rid, oid, ph) => cardMade(rid, oid, ph), request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph, qty: 2 }) });
def('card CLASSIFIER FAILS on a live checkout', { path: 'card', expect: 'classify_failed', setup: async (rid, oid, ph) => cardMade(rid, oid, ph),
  request: async (rid, s) => { FAIL_CLASSIFY = true; try { return await send(rid, s.oid, 'online', { phone: s.ph }); } finally { FAIL_CLASSIFY = false; } } });
// the race guard: classified reuse / in_progress, then the state drifts to a fresh issuance before the acquire
const drifting = (fn) => async (rid, s) => { DRIFT = async () => { DRIFT = null; await fn(s); }; try { return await send(rid, s.oid, 'online', { phone: s.ph, ...(s.redeem ? { redeem: true } : {}) }); } finally { DRIFT = null; } };
def('RACE reuse → ROTATE (checkout expires)', { path: 'card', expect: 'race', setup: async (rid, oid, ph) => cardMade(rid, oid, ph),
  request: drifting(async (s) => rtdb.ref(`payment_attempts/${await att(s.oid)}/hosted_expires_at`).set(1)) });
def('RACE reuse → INSTALL (lock pointer cleared)', { path: 'card', expect: 'race', setup: async (rid, oid, ph) => cardMade(rid, oid, ph),
  request: drifting(async (s) => rtdb.ref(`orders/${s.oid}/active_attempt_id`).remove()) });
def('RACE reuse → RECOVER (attempt record gone)', { path: 'card', expect: 'race', setup: async (rid, oid, ph) => cardMade(rid, oid, ph),
  request: drifting(async (s) => rtdb.ref(`payment_attempts/${await att(s.oid)}`).remove()) });
def('RACE in_progress → ROTATE (create failed)', { path: 'card', expect: 'race', setup: async (rid, oid, ph) => { await cardMade(rid, oid, ph); await rtdb.ref(`payment_attempts/${await att(oid)}/hosted_state`).set('creating'); },
  request: drifting(async (s) => rtdb.ref(`payment_attempts/${await att(s.oid)}/hosted_state`).set('failed_create')) });
def('RACE with a REUSED reward hold (kept)', { path: 'card', expect: 'race', hold: 'reused', redeem: true, setup: async (rid, oid, ph) => cardMade(rid, oid, ph, { redeem: true }),
  request: drifting(async (s) => rtdb.ref(`payment_attempts/${await att(s.oid)}/hosted_expires_at`).set(1)) });
def('RACE with a RE-RESERVED reward hold (released)', { path: 'card', expect: 'race', hold: 're_reserved', redeem: true,
  setup: async (rid, oid, ph) => { await cardMade(rid, oid, ph, { redeem: true }); const r = await resv(rid, oid); await rtdb.ref(`user_rewards/u_${rid}/${rid}`).update({ [`reservations/${oid}/state`]: 'released', reserved: 0 }); assert.ok(r); },
  request: drifting(async (s) => rtdb.ref(`payment_attempts/${await att(s.oid)}/hosted_expires_at`).set(1)) });
def('RACE with a CREATED reward hold (released)', { path: 'card', expect: 'race', hold: 'created', redeem: true,
  setup: async (rid, oid, ph) => { await cardMade(rid, oid, ph, { redeem: true }); await rtdb.ref(`user_rewards/u_${rid}/${rid}`).update({ [`reservations/${oid}`]: null, reserved: 0 }); },
  request: drifting(async (s) => rtdb.ref(`payment_attempts/${await att(s.oid)}/hosted_expires_at`).set(1)) });

// ── the real pages, composed with the real handler's answers ──────────────────────────────────────────────────────
let H = null;
// the FIRST charge request gets the recorded answer; a resend goes to the REAL handler (so a minted resubmit meets the switch)
async function pageRun(dir, c, rid, first, { realResend = false, method = 'cash', repeat = false } = {}) {
  const B = H.BRAND[dir];
  const w = H.loadForm(dir);
  const sends = [];
  const idle = new Promise(() => {});
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return H.res(H.envelope(B.rid, { dishes: [], extras: [] }));
    if (url.includes('quoteOrder')) return H.res({ ok: true, total_cents: 1, net_total_cents: 1 });
    if (/createOrder|chargeOnlineOrder/.test(url)) {
      const body = JSON.parse((init && init.body) || '{}');
      const k = sends.length; sends.push({ url, order_id: body.order_id, answer: null });
      const respond = (st, b) => { sends[k].answer = { status: st, body: b }; return Promise.resolve({ ok: st >= 200 && st < 300, status: st, headers: { get: () => null }, json: () => Promise.resolve(b), text: () => Promise.resolve(JSON.stringify(b)) }); };
      if (k === 0 || repeat) return respond(first.status, first.raw);
      if (!realResend) return respond(200, { ok: true, order_id: body.order_id, tracking_token: 't' });
      // the resubmit through the REAL handler, with the restaurant (the brand of THIS page) under the switch
      return send(rid, body.order_id, 'cash', { phone: phoneFor() }).then((r) => respond(r.status, r.json));
    }
    return idle;
  };
  await H.settle();
  const dish = w.liveMenuGlobalGet('MENU').find((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
  w.chg(dish.id, 1); w.requestServerQuote(); await H.settle();
  assert.ok(w.buildOrder(), `${dir}: premise — the page composes an order`);
  const p = method === 'card' ? (w.selectPay('online'), w.processPixelPay()) : w.submitOrder('confirmed');
  if (p && p.catch) p.catch(() => {});
  await H.settle(); await H.settle();
  return sends;
}

(async () => {
  H = await import(path.join(__dirname, '..', '..', 'form-harness.mjs'));
  for (const rid of ['x_pizza', 'la_musa']) { await seed(rid); await rtdb.ref(`restaurants/${rid}/identity`).set(identityFor(rid)); }
  await rtdb.ref('config/redemption_enabled').set(true);
  for (const rid of ['x_pizza', 'la_musa']) await rtdb.ref(`user_rewards/u_${rid}/${rid}`).set({ balance: 100000, reserved: 0 });

  const results = {};
  let ci = 0;
  const runCase = async (c) => {
    for (const state of Object.keys(STATES)) {
      for (const rid of ['x_pizza', 'la_musa']) {
        ci += 1;
        const oid = `oc_${String(ci).padStart(4, '0')}_${rid}`;
        const ph = phoneFor();
        await setSwitch(rid, 'absent'); FAIL_PREFIX = null;
        await c.setup(rid, oid, ph);                     // the REAL writers, with the switch absent
        await setSwitch(rid, state);
        const holdBefore = c.hold ? await resv(rid, oid) : null;
        const r = await traced(oid, rid, () => c.request(rid, { oid, ph, redeem: !!c.redeem }));
        FAIL_PREFIX = null;
        r.holdBefore = holdBefore; r.holdAfter = c.hold ? await resv(rid, oid) : null;
        r.orderAfter = (await rtdb.ref(`orders/${oid}`).get()).val();
        results[`${c.name} | ${state} | ${rid}`] = r;
        await setSwitch(rid, 'absent');
      }
    }
  };
  for (const c of CASES.filter((x) => !x.floor)) await runCase(c);
  await rtdb.ref('platform_config/client_floor/orders').set(FLOOR);
  await wait(require('../client-floor').FLOOR_TTL_MS + 1500);
  for (const c of CASES.filter((x) => x.floor)) await runCase(c);
  await rtdb.ref('platform_config/client_floor/orders').remove();
  await wait(require('../client-floor').FLOOR_TTL_MS + 1500);

  // ── the scheduled seam (real sweep + real manual release) ──────────────────────────────────────────────────────
  const sched = {};
  const slotFor = () => { const now = Date.now(); for (let k = 2; k < 400; k++) { const t = Math.ceil((now + k * 15 * 60000) / (15 * 60000)) * 15 * 60000; if (SCHED.validateScheduledFor(HOURS, t, now, 'pickup').valid) return t; } throw new Error('no valid slot'); };
  const schedMade = async (rid, oid) => {
    const r = await send(rid, oid, 'cash', { phone: phoneFor(), scheduledFor: slotFor() });
    assert.strictEqual(r.status, 200, `setup scheduled ${oid}: ${r.text.slice(0, 200)}`);
    const o = (await rtdb.ref(`orders/${oid}`).get()).val();
    assert.strictEqual(o.status, 'scheduled', `setup: ${oid} is held as scheduled`);
    await rtdb.ref(`orders/${oid}/release_at`).set(Date.now() - 1000);   // due now (the slot itself is still valid)
  };
  const sweep = () => app.sweepScheduledReleases.run({});
  const manual = (oid) => post(app.releaseScheduledOrder, { order_id: oid }, { Authorization: `Bearer ${process.env.RECON_SECRET}` });
  const parkOthers = async () => {   // only the order under test is due
    const all = (await rtdb.ref('orders').orderByChild('status').equalTo('scheduled').once('value')).val() || {};   // once (as the sweep): get() refuses an un-indexed query on this namespace
    const u = {}; for (const id of Object.keys(all)) u[`orders/${id}/release_at`] = Date.now() + 365 * 86400000;
    if (Object.keys(u).length) await rtdb.ref().update(u);
  };
  for (const state of Object.keys(STATES)) {
    for (const rid of ['x_pizza', 'la_musa']) {
      const oid = `ocs_${state}_${rid}`;
      await setSwitch(rid, 'absent'); await parkOthers();
      await schedMade(rid, oid);
      await setSwitch(rid, state);
      const r = await traced(oid, rid, () => sweep().then(() => ({ status: 0, json: null })));
      r.orderAfter = (await rtdb.ref(`orders/${oid}`).get()).val();
      results[`SCHEDULED sweep release | ${state} | ${rid}`] = r;
      sched[`sweep|${state}|${rid}`] = r;
      await setSwitch(rid, 'absent');
      await rtdb.ref(`orders/${oid}/release_at`).set(Date.now() + 365 * 86400000);
    }
  }

  const golden = CAPTURE ? null : JSON.parse(fsys.readFileSync(GOLDEN, 'utf8'));
  if (process.env.ORDER_CONTROL_DUMP) fsys.writeFileSync(process.env.ORDER_CONTROL_DUMP, JSON.stringify(results, null, 1));
  const FAILS = [];
  const check = (fn) => { try { fn(); } catch (e) { FAILS.push(e.message.split('\n')[0]); } };
  const stripControl = (ops) => ops.filter((o) => !isControlRead(o) && !isTestOp(o) && !isCacheRefresh(o));
  const goldOps = (ops) => ops.filter((o) => !isTestOp(o) && !isCacheRefresh(o));
  const tally = { same: 0, refused: 0 };
  for (const [key, r] of Object.entries(results)) {
    const [name, state] = key.split(' | ');
    const c = CASES.find((x) => x.name === name) || { name, expect: 'scheduled' };
    check(() => {
      if (CAPTURE) {
        assert.ok(!r.ops.some(isControlRead), `${key}: the baseline reads no switch`);
        return;
      }
      const g = golden.cases[key];
      assert.ok(g, `${key}: present in the frozen baseline`);
      const refused = c.expect !== 'same' && !ADMIT.has(state);
      if (!refused) {
        // UNCHANGED — status, body, headers, call sequence (minus only the control read), changed paths
        assert.strictEqual(r.status, g.status, `🔴 ${key}: status changed (${g.status} → ${r.status})`);
        assert.deepStrictEqual(r.body, g.body, `🔴 ${key}: body changed`);
        assert.deepStrictEqual(r.headers, g.headers, `🔴 ${key}: headers changed`);
        assert.deepStrictEqual(stripControl(r.ops), goldOps(g.ops), `🔴 ${key}: the call sequence changed beyond the control read`);
        assert.deepStrictEqual(r.changed, g.changed, `🔴 ${key}: the changed-path set changed`);
        const reads = r.ops.filter(isControlRead);
        if (c.noControlRead) assert.strictEqual(reads.length, 0, `🔴 ${key}: an existing-order / :839 answer must read NO switch (§0.5)`);
        else assert.ok(reads.every((o) => o.op === 'once' && /^order_control\/[^/]+\/current$/.test(o.path)), `${key}: only reads of order_control/<rid>/current`);
        tally.same += 1;
        return;
      }
      // REFUSED — the baseline admitted it
      const kind = c.expect === 'classify_failed' ? 'unavailable' : KIND[state];
      const want = kind === 'paused' ? { status: 423, body: PAUSED_BODY, ra: null } : { status: 503, body: UNAV_BODY, ra: '2' };
      if (c.expect === 'scheduled') return;   // asserted below
      assert.ok(g.status >= 200 && g.status < 300, `${key}: reproduce-first — the baseline ADMITTED it (${g.status})`);
      assert.strictEqual(r.status, want.status, `🔴 ${key}: ${want.status} expected, got ${r.status} ${JSON.stringify(r.raw)}`);
      assert.deepStrictEqual(r.raw, want.body, `🔴 ${key}: the exact refusal body`);
      assert.deepStrictEqual(Object.keys(r.raw), Object.keys(want.body), `${key}: the exact key set and order`);
      assert.strictEqual(r.headers['retry-after'], want.ra, `${key}: Retry-After`);
      if (c.expect === 'race') {
        // the drift itself is the concurrent writer's write; the refused request ran no CAS and claimed no attempt
        assert.ok(!r.ops.some((o) => o.db === 'rtdb' && o.op === 'transaction' && o.path === 'orders/<oid>'), `🔴 ${key}: the CAS never ran (refused BEFORE it)`);
        assert.ok(!r.ops.some((o) => o.db === 'rtdb' && o.op === 'update' && /^payment_attempts\//.test(o.path)), `🔴 ${key}: no attempt was claimed`);
        if (c.hold === 'reused') assert.strictEqual(r.holdAfter && r.holdAfter.state, 'reserved', `🔴 ${key}: an existing payable checkout's hold stays HELD`);
        if (c.hold === 're_reserved' || c.hold === 'created') assert.strictEqual(r.holdAfter && r.holdAfter.state, 'released', `🔴 ${key}: THIS call's own hold is released (never left held)`);
      } else {
        assert.ok(!r.ops.some((o) => WRITE_OPS.has(o.op) && !isTestOp(o)), `🔴 ${key}: refused BEFORE any write (${JSON.stringify(r.ops.filter((o) => WRITE_OPS.has(o.op)))})`);
        assert.deepStrictEqual(r.changed, [], `🔴 ${key}: nothing changed`);
      }
      tally.refused += 1;
    });
  }

  // the scheduled holds (candidate)
  if (!CAPTURE) {
    for (const rid of ['x_pizza', 'la_musa']) {
      for (const state of Object.keys(STATES)) {
        const r = sched[`sweep|${state}|${rid}`];
        check(() => {
          if (ADMIT.has(state)) { assert.ok(['new'].includes(r.orderAfter.status), `${rid}/${state}: released (${r.orderAfter.status})`); assert.strictEqual(r.orderAfter.control_held, undefined); return; }
          const cause = KIND[state];
          assert.strictEqual(r.orderAfter.status, 'scheduled', `🔴 sweep ${rid}/${state}: HELD, not released`);
          assert.strictEqual(r.orderAfter.release_claim_id, undefined, 'release ownership cleared'); assert.strictEqual(r.orderAfter.releasing_since, undefined);
          assert.deepStrictEqual(Object.keys(r.orderAfter.control_held).sort(), ['at', 'cause']);
          assert.strictEqual(r.orderAfter.control_held.cause, cause, `sweep ${rid}/${state}: cause ${cause}`);
          assert.ok(!r.orderAfter.tracking_token && !r.orderAfter.materialized_at && !r.orderAfter.released_at, 'NO materialization');
          assert.ok(!r.changed.some((p) => /^(tasks|order_tracking)\//.test(p)), 'no task / tracking written');
        });
      }
    }
  }

  // ── the scheduled scenarios (candidate only; the baseline has no switch) ────────────────────────────────────────
  if (!CAPTURE) {
    for (const rid of ['x_pizza', 'la_musa', 'r3_synthetic']) {
      await check2(async () => {
        if (rid === 'r3_synthetic') {
          // a THIRD synthetic restaurant at the real release seam: its own identity, a scheduled order written the shape
          // createOrder writes, paused through the same switch — held, then released after the resume, no code change
          await rtdb.ref('restaurants/r3_synthetic/identity').set(identityFor('r3_synthetic'));
          await parkOthers();
          const base = (await rtdb.ref('orders/ocs_open_x_pizza').get()).val();
          await rtdb.ref('orders/ocs3_r3').set({ ...base, order_id: 'ocs3_r3', restaurant_id: 'r3_synthetic', status: 'scheduled', scheduled_for: slotFor(), release_at: Date.now() - 1000,
            tracking_token: null, materialized_at: null, released_at: null, release_claim_id: null, releasing_since: null });
          await rtdb.ref('order_control/r3_synthetic/current').set({ paused: true, version: 1, op_id: 'op-r3' }); resetReader();
          await sweep();
          let o = (await rtdb.ref('orders/ocs3_r3').get()).val();
          assert.strictEqual(o.status, 'scheduled'); assert.strictEqual(o.control_held.cause, 'paused');
          await rtdb.ref('order_control/r3_synthetic/current').set({ paused: false, version: 2, op_id: 'op-r3b' }); resetReader();
          await sweep();
          o = (await rtdb.ref('orders/ocs3_r3').get()).val();
          assert.strictEqual(o.status, 'new', 'released after the resume'); assert.strictEqual(o.control_held, undefined, 'marker cleared');
          return;
        }
        // hold → AUTO-RESUME at until (no writer) → release; the marker cleared
        const oid = `ocs_auto_${rid}`;
        await setSwitch(rid, 'absent'); await parkOthers(); await schedMade(rid, oid);
        const until = Date.now() + 2500;
        await rtdb.ref(`order_control/${rid}/current`).set({ paused: true, until, version: 9, op_id: 'op-auto' }); resetReader();
        await sweep();
        let o = (await rtdb.ref(`orders/${oid}`).get()).val();
        assert.strictEqual(o.status, 'scheduled', `${rid}: held while paused until`); assert.strictEqual(o.control_held.cause, 'paused');
        const heldAt = o.control_held.at;
        await sweep();   // a second sweep while still paused: the marker is DEDUPLICATED (its `at` kept)
        o = (await rtdb.ref(`orders/${oid}`).get()).val();
        assert.strictEqual(o.control_held.at, heldAt, `${rid}: control_held deduplicated`);
        await wait(until - Date.now() + 200);
        await sweep();   // the SAME cached node, `until` now past → OPEN: released, no writer touched the switch
        o = (await rtdb.ref(`orders/${oid}`).get()).val();
        assert.strictEqual(o.status, 'new', `${rid}: auto-resumed → released`); assert.strictEqual(o.control_held, undefined, `${rid}: the marker is cleared on release`);
        const sw = (await rtdb.ref(`order_control/${rid}/current`).get()).val();
        assert.strictEqual(sw.op_id, 'op-auto', 'the switch itself was never written');
        // an EXPIRED slot while held → today's block-and-alert on resume, the marker cleared
        const oid2 = `ocs_exp_${rid}`;
        await setSwitch(rid, 'absent'); await parkOthers(); await schedMade(rid, oid2);
        await setSwitch(rid, 'paused'); await sweep();
        o = (await rtdb.ref(`orders/${oid2}`).get()).val(); assert.strictEqual(o.control_held.cause, 'paused');
        await rtdb.ref(`orders/${oid2}/scheduled_for`).set(Date.now() - 6 * 3600000);   // the slot passed while held
        await setSwitch(rid, 'absent'); await sweep();
        o = (await rtdb.ref(`orders/${oid2}`).get()).val();
        assert.strictEqual(o.status, 'scheduled'); assert.strictEqual(o.scheduled_blocked, true, `${rid}: today's block`); assert.strictEqual(o.blocked_reason, 'missed_window');
        assert.strictEqual(o.control_held, undefined, `${rid}: the pause marker is replaced by today's block`);
        // MANUAL release while paused: refused, NOTHING changed (an unrelated block stays)
        const before = (await rtdb.ref(`orders/${oid2}`).get()).val();
        await setSwitch(rid, 'paused');
        const m = await manual(oid2);
        assert.strictEqual(m.status, 423); assert.deepStrictEqual(m.json, PAUSED_BODY);
        assert.deepStrictEqual((await rtdb.ref(`orders/${oid2}`).get()).val(), before, `${rid}: a refused manual release changes nothing (scheduled_blocked kept)`);
        await setSwitch(rid, 'unknown_malformed');
        const m2 = await manual(oid2);
        assert.strictEqual(m2.status, 503); assert.deepStrictEqual(m2.json, UNAV_BODY); assert.strictEqual(m2.headers['retry-after'], '2');
        assert.deepStrictEqual((await rtdb.ref(`orders/${oid2}`).get()).val(), before);
        // a STALE releasing claim (owner died mid-release) is recovered INTO the hold, not materialized
        const oid3 = `ocs_stale_${rid}`;
        await setSwitch(rid, 'absent'); await parkOthers(); await schedMade(rid, oid3);
        await rtdb.ref(`orders/${oid3}`).update({ status: 'releasing', release_claim_id: 'dead-owner', releasing_since: Date.now() - 600000 });
        await setSwitch(rid, 'unknown_read');
        await sweep(); FAIL_PREFIX = null;
        o = (await rtdb.ref(`orders/${oid3}`).get()).val();
        assert.strictEqual(o.status, 'scheduled', `${rid}: stale releasing → held`); assert.strictEqual(o.control_held.cause, 'unavailable');
        assert.strictEqual(o.release_claim_id, undefined); assert.ok(!o.materialized_at);
        await setSwitch(rid, 'absent');
        await rtdb.ref(`orders/${oid3}/release_at`).set(Date.now() + 365 * 86400000);
      });
    }
  }
  async function check2(fn) { try { await fn(); } catch (e) { FAILS.push(e.message.split('\n')[0]); } }

  if (CAPTURE) {
    const out = { note: 'FROZEN — captured by test/order-control.emulator.test.js run with ORDER_CONTROL_CAPTURE inside a checkout of e1aeb3f (no pause switch); never regenerate from the candidate', cases: {} };
    for (const [k, r] of Object.entries(results)) out.cases[k] = { status: r.status, body: r.body, headers: r.headers, ops: r.ops, changed: r.changed };
    fsys.writeFileSync(CAPTURE, JSON.stringify(out, null, 1) + '\n');
    console.log(`order-control: baseline written to ${CAPTURE} (${Object.keys(out.cases).length} cases)`);
  } else {
    check(() => assert.deepStrictEqual(Object.keys(results).sort(), Object.keys(golden.cases).sort(), 'the same cases as the baseline'));
  }
  if (!FAILS.length) ok(`${CAPTURE ? 'BASELINE' : 'CANDIDATE'}: ${Object.keys(results).length} real-handler cases (${CASES.length} cases + the scheduled sweep × ${Object.keys(STATES).length} switch states × both restaurants)` +
    (CAPTURE ? ' — the switch node is inert at e1aeb3f; every state behaves as today' : ` — ${tally.same} UNCHANGED (status, body, headers, call sequence minus ONLY the control read, changed paths == baseline; the existing-order / :839 answers read NO switch); ${tally.refused} REFUSED with the exact 423 / 503 (+ Retry-After 2), nothing written, reward holds as planned — where the baseline admitted`));
  if (!CAPTURE && !FAILS.length) ok('scheduled: PAUSED / UNKNOWN hold with control_held {at, cause} (deduplicated), no materialization; AUTO-RESUME at until with no writer → released, marker cleared; an expired slot → today\'s block; a manual release refused (423 / 503 + Retry-After) changing NOTHING; a stale releasing claim held; a THIRD synthetic restaurant held and released through the same seam');

  // ── composition with both brands' real pages ────────────────────────────────────────────────────────────────────
  if (!CAPTURE) {
    let composed = 0;
    for (const rid of ['x_pizza', 'la_musa']) {
      const dir = rid === 'x_pizza' ? 'xpizza-orders' : 'la-musa-orders';
      // the chain: a terminal-safe order's legacy literal → the page MINTS a fresh id → that resubmit meets the PAUSE → 423, nothing written
      const lit = results[`cash TERMINAL-SAFE delivered order (legacy literal) | paused | ${rid}`];
      await check2(async () => {
        assert.strictEqual(lit.status, 409); assert.strictEqual(lit.raw.error, 'order_conflict');
        await setSwitch(rid, 'paused');
        const sends = await pageRun(dir, null, rid, lit, { realResend: true });
        await wait(1500 + 3000 + 600); await H.settle();
        assert.strictEqual(sends.length, 2, `${dir}: literal → exactly ONE minted resubmit (${sends.map((s) => s.order_id)})`);
        assert.notStrictEqual(sends[0].order_id, sends[1].order_id, 'the page minted a fresh id (the legacy self-heal, unchanged)');
        assert.strictEqual(sends[1].answer.status, 423, `🔴 ${dir}: the minted resubmit met the pause → 423 (${JSON.stringify(sends[1].answer)})`);
        assert.strictEqual((await rtdb.ref(`orders/${sends[1].order_id}`).get()).val(), null, `🔴 ${dir}: NO order was written for the minted id`);
        await setSwitch(rid, 'absent');
        composed += 1;
      });
      // every refusal's real answer → the real page sends exactly once
      for (const [k, method] of [[`cash FRESH order | paused | ${rid}`, 'cash'], [`cash FRESH order | unknown_malformed | ${rid}`, 'cash'], [`card FRESH checkout | paused_until | ${rid}`, 'card'], [`RACE reuse → ROTATE (checkout expires) | paused | ${rid}`, 'card'], [`card FRESH checkout | unknown_read | ${rid}`, 'card']]) {
        const r = results[k];
        await check2(async () => {
          const sends = await pageRun(dir, null, rid, r, { method, repeat: true });   // the switch stays as it was: every request meets it
          await wait(method === 'cash' && r.status === 503 ? 1500 + 3000 + 600 : 400); await H.settle();
          const want = method === 'cash' && r.status === 503 ? 3 : 1;   // a cash 503 keeps today's retry loop (same id)
          assert.strictEqual(sends.length, want, `🔴 COMPOSITION ${k} → ${dir}: ${want} request(s), saw ${sends.length}`);
          assert.strictEqual(new Set(sends.map((s) => s.order_id)).size, 1, `${k} → ${dir}: never a new order id`);
          composed += 1;
        });
      }
    }
    H.closeAll();
    if (!FAILS.length) ok(`composed with BOTH brands' real pages (${composed} page runs): the terminal-safe legacy literal → the page mints → the resubmit meets the pause → 423 with NO order written; every real refusal (423 / 503, fresh and race) → no new order id, no resend beyond today's cash 503 retry`);
  } else H.closeAll();

  if (FAILS.length) throw new Error(`${FAILS.length} failing check(s):\n  - ${FAILS.join('\n  - ')}`);
  FINISHED = true;
  console.log(`\norder-control(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('order-control(emulator) FAILED:', e && e.stack || e); process.exit(1); });
