'use strict';
// D4-c5 phase 1 — every existing-order refusal through the REAL handlers on the RTDB + Firestore emulators, composed
// with BOTH brands' real order pages. Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:order-exists
//
// For each case (both restaurants) the order under test is made by the REAL writer — createOrder / chargeOnlineOrder
// themselves, then the state the later writers leave (the real cancelOrderCore; the KDS / driver / webhook field
// writes) — and the retried request goes through the real handler. Recorded per case: the HTTP status and body, the
// ordered RTDB + Firestore call sequence the handler issued, and the set of database paths it changed.
//
// REPRODUCE-FIRST. ORDER_EXISTS_CAPTURE=<file>, run inside a checkout of the integration parent f17466e (whose seven
// emitters are byte-identical to the plan's bb37684 — order-exists-census.guard.test.js), asserts today's self-heal
// literal on every refusal, drives the real page with it (→ the page MINTS a second id), and writes the trace. That
// file is frozen as test/order-exists-base.golden.json — never regenerate it from the candidate.
// CANDIDATE (default): every case's status, call sequence and changed-path set must EQUAL the base's — the refusal
// paths add no read and change no write, and every success / read-failure control is unchanged — and ONLY the body of
// the refusals differs, exactly as plan §1/§2 prescribe; the real page then sends exactly ONE request.
// The seventh emitter, :832 client_update_race, needs the client floor ON: its cases run in a second phase with the floor
// written (codex build r1 SF — recorded and composed like the other six).
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const path = require('path');
const fsys = require('fs');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'oe-secret';
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
let FAIL_CLASSIFY = false; let FAIL_ACQUIRE = false;
require.cache[hc] = { id: hc, filename: hc, loaded: true, children: [], paths: [], exports: { ...realHC,
  classifyHostedAttempt: async (...a) => { if (FAIL_CLASSIFY) throw new Error('UNAVAILABLE (injected classify failure)'); return realHC.classifyHostedAttempt(...a); },
  acquireHostedAttempt: async (...a) => { if (FAIL_ACQUIRE) throw new Error('UNAVAILABLE (injected acquire failure)'); return realHC.acquireHostedAttempt(...a); } } };

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const { cancelOrderCore } = require('../cancel-order-core');
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { publishVersion } = require('../catalog/catalog-publish');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');

const CAPTURE = process.env.ORDER_EXISTS_CAPTURE || '';
const GOLDEN = path.join(__dirname, 'order-exists-base.golden.json');
// the plan §1 string — written out here (not required from ../order-exists) so this file runs unchanged at the base
const DETAIL = 'Ya hay un pedido en curso con este número. Revisá tu pedido o pago anterior antes de volver a intentar.';
const ENUM = new Set(['method', 'closed', 'cart', 'cart_unverifiable', 'binding_format_invalid', 'client_update_race', 'conflict']);

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('order-exists(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the recorder (the d4b-charge-trace recipe): every RTDB + Firestore call the handler issues, in order ─────────────
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

// a read failure injected on ONE path (the RTDB Reference prototype's `once`)
const onceProto = (() => { let p = Object.getPrototypeOf(rtdb.ref('x')); while (p && !Object.prototype.hasOwnProperty.call(p, 'once')) p = Object.getPrototypeOf(p); return p; })();
const realOnce = onceProto.once;
async function failingReadsOf(pathEq, fn) {
  onceProto.once = function (...a) { if (rel(this.toString()) === pathEq) return Promise.reject(new Error('UNAVAILABLE (injected read failure)')); return realOnce.apply(this, a); };
  try { return await fn(); } finally { onceProto.once = realOnce; }
}

// the :832 race (as test/client-floor-http.emulator.test.js drives it): the order exists at the floor's admission probe
// and is GONE at the create decision — the nth read of the order path removes it first
async function vanishingOrderAt(pathEq, nth, fn) {
  let k = 0;
  onceProto.once = async function (...a) { if (rel(this.toString()) === pathEq && ++k === nth) await rtdb.ref(pathEq).remove(); return realOnce.apply(this, a); };
  try { return await fn(); } finally { onceProto.once = realOnce; }
}
const H_LOW = { 'x-client-app': 'orders', 'x-client-deployment': 'orders-xpizza', 'x-client-build': 'b1', 'x-client-compat': '1' };
const H_EQ = { 'x-client-app': 'orders', 'x-client-deployment': 'orders-xpizza', 'x-client-build': 'b2', 'x-client-compat': '2' };
const FLOOR = 2;

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────
async function seed(rid) {
  await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: `oe-${rid}` });
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
        s.close(() => resolve({ status: r.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const OPEN = { open: true, start: '00:00', end: '24:00' };
const identityFor = (rid) => ({ name: `Rest ${rid}`, phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1,
  hours: { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN } });
let PH = 0;
const phoneFor = () => `9944${String(PH += 1).padStart(4, '0')}`;
function bodyFor(rid, oid, method, { qty = 1, redeem = false, phone }) {
  const s = catalogSnapshot(rid);
  const it = s.items.find((i) => (rid === 'x_pizza' ? i.key === 'Carnivora' : i.key === 'dimsum_01'));
  const items = rid === 'x_pizza' ? [{ name: it.display.name, qty, price: it.price, extras: [] }] : [{ id: it.key, name: it.display.name, cat: it.display.cat, qty, price: it.price, extras: [] }];
  const rd = rid === 'x_pizza' ? { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' } : { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 1, name: 'Arroz' }] };
  return { restaurant_id: rid, order_id: oid, customer_name: 'Order Exists', customer_phone: phone, customer_email: 'oe@example.com', items_text: `${qty}x ${it.display.name}`, order_type: 'pickup', payment_method: method, items, ...(redeem ? { redeem: rd } : {}) };
}
const send = async (rid, oid, method, opts) => {
  await rtdb.ref('rate_limits').remove();   // every request is 127.0.0.1 — the per-IP limit is reset between requests (test env only)
  return post(method === 'online' ? app.chargeOnlineOrder : app.createOrder, bodyFor(rid, oid, method, opts), { 'x-firebase-id-token': `u_${rid}`, ...(opts.hdr || {}) });
};

// flatten a tree into leaf paths → JSON value
function leaves(v, pre = '', out = new Map()) {
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) leaves(v[k], pre ? `${pre}/${k}` : k, out); } else out.set(pre, JSON.stringify(v));
  return out;
}
const tree = async () => leaves((await rtdb.ref().get()).val() || {});

// one recorded request; request-local ids normalised
async function traced(c, rid, setupState) {
  const before = await tree();
  const pre = (await rtdb.ref(`orders/${c.oid}`).get()).val() || {};
  REC = [];
  const r = await c.request(rid, setupState);
  await wait(300);   // a fire-and-forget write the handler issued lands inside the recording
  const calls = REC; REC = null;
  const after = await tree();
  const post_ = (await rtdb.ref(`orders/${c.oid}`).get()).val() || {};
  const subs = [];
  for (const o of [pre, post_]) for (const [k, v] of Object.entries(o)) if (/attempt_id$|poll_token$|tracking_token$|claim_id$/.test(k) && typeof v === 'string' && v.length >= 8) subs.push([v, `<${k}>`]);
  subs.push([c.oid, '<oid>'], [`u_${rid}`, '<uid>']);
  const norm = (s) => subs.reduce((acc, [from, to]) => acc.split(from).join(to), String(s))
    .replace(/\/-[A-Za-z0-9_-]{19}/g, '/<push>')
    .replace(/(restaurants\/[^/]+\/identity\/[^/]+\/ids\/)[^/?]+/g, '$1<id>')
    .replace(/(rate_limits\/[^/]+\/)[^/]+/g, '$1<key>')
    .replace(/(recent_order_content\/)[^/]+/g, '$1<key>');
  const ops = calls.map((x) => ({ ...x, ...(x.path !== undefined ? { path: norm(x.path) } : {}), ...(x.paths ? { paths: x.paths.map(norm).sort() } : {}), ...(x.keys ? { keys: x.keys.map(norm) } : {}) }));
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k)).map(norm).sort();
  const body = r.json ? JSON.parse(norm(JSON.stringify(r.json)).replace(/https:\/\/pay\.test\/[^"]+/g, '<checkout_url>')) : null;
  // request-local random tokens a body can carry that live on records other than the order (e.g. the attempt's poll_token)
  if (body) for (const k of ['poll_token', 'tracking_token', 'attempt_id']) if (typeof body[k] === 'string') body[k] = `<${k}>`;
  return { status: r.status, body, ops, changed, raw: r.json };
}

// ── the cases: setup (the real writers) → the retried request (the real handler) ─────────────────────────────────
// kind: 'refusal' (a covered emitter; base = a legacy literal), 'terminal' (terminal-safe — the literal stays),
//       'control' (a success / read-failure outcome — identical everywhere)
// want: the candidate body for a refusal; `site` names the emitter (f17466e line → plan bb37684 line)
const CASES = [];
const def = (name, o) => CASES.push({ name, ...o });
const cashMade = async (rid, oid, phone, opts = {}) => { const r = await send(rid, oid, 'cash', { phone, ...opts }); assert.strictEqual(r.status, 200, `setup cash ${oid}: ${r.text.slice(0, 160)}`); return (await rtdb.ref(`orders/${oid}`).get()).val(); };
const cardMade = async (rid, oid, phone, opts = {}) => { const r = await send(rid, oid, 'online', { phone, ...opts }); assert.strictEqual(r.status, 200, `setup card ${oid}: ${r.text.slice(0, 160)}`); return (await rtdb.ref(`orders/${oid}`).get()).val(); };
const otherRid = (rid) => (rid === 'x_pizza' ? 'la_musa' : 'x_pizza');
const kdsStatus = (oid, status) => rtdb.ref(`orders/${oid}/status`).set(status);   // the KDS / driver app's own status write
const realCancel = async (oid) => {
  const r = await cancelOrderCore({ db: rtdb, voidOrRefund: async () => ({ ok: true, outcome: 'voided' }), alert: async () => {}, serverTimestamp: Date.now() },
    { orderId: oid, actor: 'test', reason: 'test', now: Date.now(), claimId: `claim-${oid}` });
  assert.ok(r.status === 200, `setup: the real cancelOrderCore cancelled ${oid}: ${JSON.stringify(r)}`);
};

// createOrder — :818 (plan :808), the classifier
def('cash idempotent retry (same cart)', { kind: 'control', path: 'cash', setup: async (rid, oid, ph) => cashMade(rid, oid, ph), request: (rid, s) => send(rid, s.oid, 'cash', { phone: s.ph }) });
def('cash live order, price/cart change', { kind: 'refusal', path: 'cash', site: '818 (808) cart', want: 'cart', setup: async (rid, oid, ph) => cashMade(rid, oid, ph), request: (rid, s) => send(rid, s.oid, 'cash', { phone: s.ph, qty: 2 }) });
def('cash live order, reward change', { kind: 'refusal', path: 'cash', site: '818 (808) cart', want: 'cart', setup: async (rid, oid, ph) => cashMade(rid, oid, ph, { redeem: true }), request: (rid, s) => send(rid, s.oid, 'cash', { phone: s.ph }) });
def('live ONLINE order retried on cash', { kind: 'refusal', path: 'cash', site: '818 (808) method', want: 'method', setup: async (rid, oid, ph) => cardMade(rid, oid, ph), request: (rid, s) => send(rid, s.oid, 'cash', { phone: s.ph }) });
for (const ps of ['confirmed', 'manual_review']) {
  def(`cash order payment_status ${ps}`, { kind: 'refusal', path: 'cash', site: '818 (808) closed', want: 'closed', setup: async (rid, oid, ph) => { await cashMade(rid, oid, ph); await rtdb.ref(`orders/${oid}/payment_status`).set(ps); }, request: (rid, s) => send(rid, s.oid, 'cash', { phone: s.ph }) });
}
for (const st of ['delivered', 'completed']) {
  def(`TERMINAL-SAFE cash ${st}`, { kind: 'terminal', path: 'cash', setup: async (rid, oid, ph) => { await cashMade(rid, oid, ph); await kdsStatus(oid, st); }, request: (rid, s) => send(rid, s.oid, 'cash', { phone: s.ph }) });
}
def('TERMINAL-SAFE cash cancelled (real cancelOrderCore)', { kind: 'terminal', path: 'cash', setup: async (rid, oid, ph) => { await cashMade(rid, oid, ph); await realCancel(oid); }, request: (rid, s) => send(rid, s.oid, 'cash', { phone: s.ph }) });
def('TERMINAL-SAFE card_delivery delivered', { kind: 'terminal', path: 'cash', method: 'card_delivery', setup: async (rid, oid, ph) => { const r = await send(rid, oid, 'card_delivery', { phone: ph }); assert.strictEqual(r.status, 200, r.text); await kdsStatus(oid, 'delivered'); }, request: (rid, s) => send(rid, s.oid, 'card_delivery', { phone: s.ph }) });
def('near-miss: delivered cash order WITH a redemption', { kind: 'refusal', path: 'cash', site: '818 (808) closed', want: 'closed', setup: async (rid, oid, ph) => { await cashMade(rid, oid, ph, { redeem: true }); await kdsStatus(oid, 'delivered'); }, request: (rid, s) => send(rid, s.oid, 'cash', { phone: s.ph, redeem: true }) });
def('near-miss: delivered cash order WITH payment_status refunded', { kind: 'refusal', path: 'cash', site: '818 (808) closed', want: 'closed', setup: async (rid, oid, ph) => { await cashMade(rid, oid, ph); await kdsStatus(oid, 'delivered'); await rtdb.ref(`orders/${oid}/payment_status`).set('refunded'); }, request: (rid, s) => send(rid, s.oid, 'cash', { phone: s.ph }) });
def('near-miss: cancelled cash order WITH a cancel_claim_id (a cancel in flight)', { kind: 'refusal', path: 'cash', site: '818 (808) closed', want: 'closed', setup: async (rid, oid, ph) => { await cashMade(rid, oid, ph); await kdsStatus(oid, 'cancelled'); await rtdb.ref(`orders/${oid}/cancel_claim_id`).set('c-inflight'); }, request: (rid, s) => send(rid, s.oid, 'cash', { phone: s.ph }) });
def('near-miss: terminal-safe-looking order of ANOTHER restaurant (cash)', { kind: 'refusal', path: 'cash', site: '818 (808) restaurant', want: 'conflict', crossRestaurant: true, setup: async (rid, oid, ph) => { await cashMade(otherRid(rid), oid, ph); await kdsStatus(oid, 'delivered'); }, request: (rid, s) => send(rid, s.oid, 'cash', { phone: s.ph }) });
def('near-miss: terminal-safe-looking card_delivery order retried on cash (method)', { kind: 'refusal', path: 'cash', site: '818 (808) method', want: 'method', setup: async (rid, oid, ph) => { const r = await send(rid, oid, 'card_delivery', { phone: ph }); assert.strictEqual(r.status, 200, r.text); await kdsStatus(oid, 'delivered'); }, request: (rid, s) => send(rid, s.oid, 'cash', { phone: s.ph }) });
// :832 (plan :822) — needs the client floor ON; these cases run in a second phase, after the floor is written and the
// instance's floor cache has expired (one TTL)
def('cash below-floor request, order VANISHES before the create decision (client_update_race)', { kind: 'refusal', path: 'cash', site: '832 (822) race', want: 'client_update_race', floor: true,
  setup: async (rid, oid, ph) => cashMade(rid, oid, ph, { hdr: H_EQ }),
  request: (rid, s) => vanishingOrderAt(`orders/${s.oid}`, 2, () => send(rid, s.oid, 'cash', { phone: s.ph, hdr: H_LOW })) });
def('cash existence read FAILS', { kind: 'control', path: 'cash', setup: async (rid, oid, ph) => cashMade(rid, oid, ph), request: (rid, s) => failingReadsOf(`orders/${s.oid}`, () => send(rid, s.oid, 'cash', { phone: s.ph })) });

// chargeOnlineOrder — :1504 / :1698 / :1706 / :1813 / :1817 (plan :1494 / :1688 / :1696 / :1803 / :1807), and the success controls
const att = async (oid) => (await rtdb.ref(`orders/${oid}/active_attempt_id`).get()).val();
def('card live checkout REUSE (same cart)', { kind: 'control', path: 'card', setup: async (rid, oid, ph) => cardMade(rid, oid, ph), request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph }) });
def('card IN PROGRESS (attempt creating)', { kind: 'control', path: 'card', setup: async (rid, oid, ph) => { await cardMade(rid, oid, ph); await rtdb.ref(`payment_attempts/${await att(oid)}/hosted_state`).set('creating'); }, request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph }) });
def('card ROTATE (checkout expired)', { kind: 'control', path: 'card', setup: async (rid, oid, ph) => { await cardMade(rid, oid, ph); await rtdb.ref(`payment_attempts/${await att(oid)}/hosted_expires_at`).set(1); }, request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph }) });
def('card ALREADY PAID', { kind: 'control', path: 'card', setup: async (rid, oid, ph) => { await cardMade(rid, oid, ph); await rtdb.ref(`orders/${oid}/payment_status`).set('confirmed'); }, request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph }) });
def('card changed binding × PAID (already_paid wins)', { kind: 'control', path: 'card', setup: async (rid, oid, ph) => { await cardMade(rid, oid, ph); await rtdb.ref(`orders/${oid}/payment_status`).set('confirmed'); }, request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph, qty: 2 }) });
def('card changed binding × LIVE checkout', { kind: 'refusal', path: 'card', site: '1813 (1803) acquire conflict', want: 'conflict', setup: async (rid, oid, ph) => cardMade(rid, oid, ph), request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph, qty: 2 }) });
def('card changed binding × CREATING', { kind: 'refusal', path: 'card', site: '1813 (1803) acquire conflict', want: 'conflict', setup: async (rid, oid, ph) => { await cardMade(rid, oid, ph); await rtdb.ref(`payment_attempts/${await att(oid)}/hosted_state`).set('creating'); }, request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph, qty: 2 }) });
def('card changed binding × POINTER WITHOUT ATTEMPT', { kind: 'refusal', path: 'card', site: '1813 (1803) acquire conflict', want: 'conflict', setup: async (rid, oid, ph) => { await cardMade(rid, oid, ph); await rtdb.ref(`payment_attempts/${await att(oid)}`).remove(); }, request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph, qty: 2 }) });
def('card changed binding WITH a reward hold this call owns (cleanup)', { kind: 'refusal', path: 'card', site: '1813 (1803) acquire conflict', want: 'conflict', setup: async (rid, oid, ph) => cardMade(rid, oid, ph), request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph, qty: 2, redeem: true }) });
def('card order CANCELLED', { kind: 'refusal', path: 'card', site: '1817 (1807) acquire closed', want: 'closed', setup: async (rid, oid, ph) => { await cardMade(rid, oid, ph); await kdsStatus(oid, 'cancelled'); }, request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph }) });
def('card order REFUNDED', { kind: 'refusal', path: 'card', site: '1817 (1807) acquire closed', want: 'closed', setup: async (rid, oid, ph) => { await cardMade(rid, oid, ph); await rtdb.ref(`orders/${oid}/payment_status`).set('refunded'); }, request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph }) });
def('card attempt VOIDED', { kind: 'refusal', path: 'card', site: '1817 (1807) acquire closed', want: 'closed', setup: async (rid, oid, ph) => { await cardMade(rid, oid, ph); await rtdb.ref(`payment_attempts/${await att(oid)}/hosted_state`).set('voided'); }, request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph }) });
def('card malformed binding tag (classify snapshot)', { kind: 'refusal', path: 'card', site: '1504 (1494) classify binding', want: 'binding_format_invalid', setup: async (rid, oid, ph) => { await cardMade(rid, oid, ph); await rtdb.ref(`orders/${oid}/fp_format`).set('bogus'); }, request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph }) });
def('card malformed binding tag, CLASSIFY FAILS (degraded probe)', { kind: 'refusal', path: 'card', site: '1706 (1696) degraded binding', want: 'binding_format_invalid', setup: async (rid, oid, ph) => { await cardMade(rid, oid, ph); await rtdb.ref(`orders/${oid}/fp_format`).set('bogus'); }, request: async (rid, s) => { FAIL_CLASSIFY = true; try { return await send(rid, s.oid, 'online', { phone: s.ph }); } finally { FAIL_CLASSIFY = false; } } });
def('card order of ANOTHER restaurant', { kind: 'refusal', path: 'card', site: '1698 (1688) restaurant', want: 'conflict', crossRestaurant: true, setup: async (rid, oid, ph) => cardMade(otherRid(rid), oid, ph), request: (rid, s) => send(rid, s.oid, 'online', { phone: s.ph }) });
def('card CLASSIFY FAILS on a live checkout (fail-open → reuse)', { kind: 'control', path: 'card', setup: async (rid, oid, ph) => cardMade(rid, oid, ph), request: async (rid, s) => { FAIL_CLASSIFY = true; try { return await send(rid, s.oid, 'online', { phone: s.ph }); } finally { FAIL_CLASSIFY = false; } } });
def('card order PROBE read FAILS', { kind: 'control', path: 'card', setup: async (rid, oid, ph) => cardMade(rid, oid, ph), request: async (rid, s) => { FAIL_CLASSIFY = true; try { return await failingReadsOf(`orders/${s.oid}`, () => send(rid, s.oid, 'online', { phone: s.ph })); } finally { FAIL_CLASSIFY = false; } } });
def('card ACQUIRE FAILS', { kind: 'control', path: 'card', setup: async (rid, oid, ph) => cardMade(rid, oid, ph), request: async (rid, s) => { FAIL_ACQUIRE = true; try { return await send(rid, s.oid, 'online', { phone: s.ph, qty: 2 }); } finally { FAIL_ACQUIRE = false; } } });

// the legacy literal each refusal carried at the base (card: by site)
const legacyFor = (c) => (c.path === 'cash' ? 'order_conflict' : (/closed/.test(c.site) ? 'Order closed' : 'Order conflict'));

// ── the real pages, composed with the real handler's answer ─────────────────────────────────────────────────────
// The FIRST charge request of a real page is answered with the exact status + body the handler just returned; any
// resend gets a 200. Then every retry timer runs out. Returns the order ids the page sent.
let H = null;
async function pageSends(dir, c, firstStatus, firstBody) {
  const B = H.BRAND[dir];
  const w = H.loadForm(dir);
  const sends = [];
  const idle = new Promise(() => {});
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return H.res(H.envelope(B.rid, { dishes: [], extras: [] }));
    if (url.includes('quoteOrder')) return H.res({ ok: true, total_cents: 1, net_total_cents: 1 });
    if (/createOrder|chargeOnlineOrder/.test(url)) {
      const body = JSON.parse((init && init.body) || '{}');
      sends.push({ url, order_id: body.order_id });
      if (sends.length === 1) return Promise.resolve({ ok: firstStatus >= 200 && firstStatus < 300, status: firstStatus, headers: { get: () => null }, json: () => Promise.resolve(firstBody), text: () => Promise.resolve(JSON.stringify(firstBody)) });
      return H.res(/chargeOnlineOrder/.test(url) ? { ok: true, checkout_url: 'https://pay.test/ok', order_id: body.order_id } : { ok: true, order_id: body.order_id, tracking_token: 't' });
    }
    return idle;
  };
  await H.settle();
  const dish = w.liveMenuGlobalGet('MENU').find((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
  w.chg(dish.id, 1); w.requestServerQuote(); await H.settle();
  assert.ok(w.buildOrder(), `${dir}: premise — the page composes an order`);
  const p = c.path === 'card' ? (w.selectPay('online'), w.processPixelPay()) : w.submitOrder('confirmed');
  if (p && p.catch) p.catch(() => {});
  await H.settle(); await H.settle();
  assert.ok(sends[0] && sends[0].url.includes(c.path === 'card' ? 'chargeOnlineOrder' : 'createOrder'), `${dir}/${c.name}: premise — the page reached the handler`);
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
    for (const rid of ['x_pizza', 'la_musa']) {
      ci += 1;
      const oid = `oe_${String(ci).padStart(3, '0')}_${rid}`;
      const ph = phoneFor();
      await c.setup(rid, oid, ph);
      results[`${c.name} | ${rid}`] = await traced({ ...c, oid }, rid, { oid, ph });
    }
  };
  for (const c of CASES.filter((x) => !x.floor)) await runCase(c);
  // phase 2 — the client floor ON (it stays on; the page compositions below never reach a handler)
  await rtdb.ref('platform_config/client_floor/orders').set(FLOOR);
  await wait(require('../client-floor').FLOOR_TTL_MS + 1500);
  for (const c of CASES.filter((x) => x.floor)) await runCase(c);

  const golden = CAPTURE ? null : JSON.parse(fsys.readFileSync(GOLDEN, 'utf8'));
  const pageChecks = [];
  // every failing check is COLLECTED and reported together at the end, so a mutant's log names each cell that kills it
  // (e.g. a reverted body is caught by the body assertion AND, independently, by the page composition)
  const FAILS = [];
  const check = (fn) => { try { fn(); } catch (e) { FAILS.push(e.message.split('\n')[0]); } };
  for (const c of CASES) {
    for (const rid of ['x_pizza', 'la_musa']) {
      const key = `${c.name} | ${rid}`;
      const r = results[key];
      const L = `${key}`;
      check(() => {
      if (CAPTURE) {
        // REPRODUCE-FIRST at the base: every covered refusal answers today's self-heal literal
        if (c.kind === 'refusal' || c.kind === 'terminal') {
          assert.strictEqual(r.status, 409, `${L}: base 409 (${JSON.stringify(r.body)})`);
          assert.strictEqual(r.raw.error, legacyFor(c), `${L}: base answers the legacy literal`);
        }
      } else {
        const g = golden.cases[key];
        assert.ok(g, `${L}: present in the frozen base trace`);
        assert.strictEqual(r.status, g.status, `🔴 ${L}: status changed (${g.status} → ${r.status})`);
        assert.deepStrictEqual(r.ops, g.ops, `🔴 ${L}: the handler's database CALL SEQUENCE changed — a refusal must add no read and move no write`);
        assert.deepStrictEqual(r.changed, g.changed, `🔴 ${L}: the set of database paths the request changed is not the base's (cleanup / writes must be identical)`);
        if (c.kind === 'refusal') {
          assert.strictEqual(r.status, 409);
          assert.deepStrictEqual(Object.keys(r.raw), ['error', 'reason', 'detail', 'order_id'], `${L}: EXACTLY the four keys`);
          assert.deepStrictEqual(r.body, { error: 'order_exists', reason: c.want, detail: DETAIL, order_id: '<oid>' }, `${L}: the typed body, order_id = the request's own id`);
          assert.ok(ENUM.has(r.raw.reason), `${L}: reason in the closed enum`);
          assert.strictEqual(g.body.error, legacyFor(c), `${L}: and the base answered the legacy literal (reproduce-first)`);
          if (c.crossRestaurant) {
            const s = JSON.stringify(r.raw);
            for (const leak of [otherRid(rid), `Rest ${otherRid(rid)}`, 'restaurant', 'delivered', 'pending_payment', 'new']) assert.ok(!s.includes(leak), `🔴 ${L}: the body discloses "${leak}": ${s}`);
            assert.strictEqual(r.raw.reason, 'conflict');
          }
        } else {
          assert.deepStrictEqual(r.body, g.body, `🔴 ${L}: a ${c.kind} outcome's body changed`);
        }
      }
      });
      if (c.kind !== 'control') {
        for (const dir of ['xpizza-orders', 'la-musa-orders']) pageChecks.push({ c, key: `${L} → ${dir}`, mint: CAPTURE ? true : c.kind === 'terminal', p: pageSends(dir, c, r.status, r.raw) });
      }
    }
  }
  if (CAPTURE) {
    const out = { note: 'FROZEN — captured by test/order-exists.emulator.test.js run with ORDER_EXISTS_CAPTURE inside a checkout of f17466e; never regenerate from the candidate', cases: {} };
    for (const [k, r] of Object.entries(results)) out.cases[k] = { status: r.status, body: r.body, ops: r.ops, changed: r.changed };
    fsys.writeFileSync(CAPTURE, JSON.stringify(out, null, 1) + '\n');
    console.log(`order-exists: base trace written to ${CAPTURE} (${Object.keys(out.cases).length} cases)`);
  } else {
    check(() => assert.deepStrictEqual(Object.keys(results).sort(), Object.keys(golden.cases).sort(), 'the same cases as the base'));
  }
  const caseFails = FAILS.length;
  const kinds = (k) => CASES.filter((c) => c.kind === k).length * 2;
  if (!caseFails) ok(`${CAPTURE ? 'BASE' : 'CANDIDATE'}: ${Object.keys(results).length} real-handler cases (both restaurants) — ${kinds('refusal')} covered refusals, ${kinds('terminal')} terminal-safe controls, ${kinds('control')} success / read-failure controls` +
    (CAPTURE ? ' — every refusal answers today\'s self-heal literal' : ' — status, ordered RTDB+Firestore call sequence and changed-path set EQUAL the base on every case; only the refusals\' body changed, to EXACTLY {error:"order_exists", reason ∈ enum, detail, order_id}; terminal-safe and controls byte-identical'));

  const sends = await Promise.all(pageChecks.map((x) => x.p));
  await wait(1500 + 3000 + 300);   // every retry timer a page could have armed has run out
  await H.settle();
  let minted = 0; let once = 0;
  pageChecks.forEach((x, i) => check(() => {
    const ids = sends[i].map((s) => s.order_id);
    if (x.mint) { assert.strictEqual(ids.length, 2, `${x.key}: the page resends on the literal (${ids})`); assert.notStrictEqual(ids[0], ids[1], `${x.key}: …under a FRESH id`); minted += 1; }
    else { assert.strictEqual(ids.length, 1, `🔴 COMPOSITION ${x.key}: the page must NOT resubmit on order_exists (${ids})`); once += 1; }
  }));
  H.closeAll();
  if (FAILS.length) throw new Error(`${FAILS.length} failing check(s):\n  - ${FAILS.join('\n  - ')}`);
  ok(CAPTURE
    ? `BASE, composed with both brands' real pages: every covered refusal's real answer makes the page MINT a second order id and resend (${minted} page runs) — the defect, reproduced`
    : `CANDIDATE, composed with both brands' real pages: every covered refusal's real answer → exactly ONE request, no mint (${once} page runs); the terminal-safe controls still self-heal (${minted} page runs)`);

  FINISHED = true;
  console.log(`\norder-exists(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('order-exists(emulator) FAILED:', e && e.stack || e); process.exit(1); });
