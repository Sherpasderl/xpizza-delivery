'use strict';
// Portal 1D · D4-b — THE LEGACY CALL-SEQUENCE GOLDEN (PLAN-D4b Tests "Format authority": "the legacy path's
// read/transaction sequence unchanged"). Every payment/reservation binding writer is run over LEGACY records on a
// recording fake RTDB; the result, the ordered list of reads/transactions/writes, and the resulting data are one
// comparable value per scenario.
// `loadModule(name, sourceText)` compiles a module from TEXT in this directory — so the capture can run the
// BASE commit's source (git show) through exactly the same scenarios as today's.
const Module = require('module');
const path = require('path');
const { createFakeRtdb } = require('./d4b-fake-rtdb');

const DIR = path.join(__dirname, '..');
function loadModule(name, sourceText) {
  const filename = path.join(DIR, name);
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(DIR);
  m._compile(sourceText, filename);
  return m.exports;
}

const FP = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const ORDER = { restaurant_id: 'x_pizza', total_cents: 1000, status: 'pending_payment', payment_method: 'online' };
const NOW = 1767200000000;
let seq = 0;
const ids = () => `att_${String(seq += 1).padStart(4, '0')}`;

async function run(label, initial, fn) {
  seq = 0;
  const db = createFakeRtdb(initial);
  const result = await fn(db);
  return [label, { result, calls: db.calls.slice(), data: db.dump() }];
}

// hosted: acquireHostedAttempt + classifyHostedAttempt; direct: acquireOnlineAttempt; reserve: reserveRedemption
async function scenarios({ hosted, direct, reserve, REDEMPTION_CONFIG_VERSION }) {
  const out = [];
  const gen = () => ids(), tok = () => 'tok';
  const attCreated = { hosted_state: 'created', hosted_expires_at: NOW + 60000, hosted_checkout_url: 'https://pay/x', poll_token: 'pt' };
  const existing = (fp, extra = {}) => ({ orders: { o1: { ...ORDER, payment_fingerprint: fp, active_attempt_id: 'att_live', ...extra } }, payment_attempts: { att_live: attCreated } });
  out.push(await run('hosted.acquire.create', {}, (db) => hosted.acquireHostedAttempt(db, 'o1', ORDER, FP, NOW, [], gen, tok)));
  out.push(await run('hosted.acquire.reuse', existing(FP), (db) => hosted.acquireHostedAttempt(db, 'o1', ORDER, FP, NOW, [], gen, tok)));
  out.push(await run('hosted.acquire.conflict', existing(OTHER), (db) => hosted.acquireHostedAttempt(db, 'o1', ORDER, FP, NOW, [], gen, tok)));
  out.push(await run('hosted.acquire.no_fp_install', { orders: { o1: { ...ORDER } } }, (db) => hosted.acquireHostedAttempt(db, 'o1', ORDER, FP, NOW, [], gen, tok)));
  out.push(await run('hosted.classify.create', {}, (db) => hosted.classifyHostedAttempt(db, 'o1', FP, NOW)));
  out.push(await run('hosted.classify.reuse', existing(FP), (db) => hosted.classifyHostedAttempt(db, 'o1', FP, NOW)));
  out.push(await run('hosted.classify.conflict', existing(OTHER), (db) => hosted.classifyHostedAttempt(db, 'o1', FP, NOW)));
  out.push(await run('direct.acquire.create', {}, (db) => direct.acquireOnlineAttempt(db, 'o1', ORDER, FP, gen)));
  out.push(await run('direct.acquire.conflict', { orders: { o1: { ...ORDER, payment_fingerprint: OTHER } } }, (db) => direct.acquireOnlineAttempt(db, 'o1', ORDER, FP, gen)));
  const canonical = { restaurant_id: 'x_pizza', model: 'add_free', type: 'free_pizza_choice', config_version: REDEMPTION_CONFIG_VERSION, cost: 8, discount_cents: 0, free_item_key: 'Margherita' };
  const args = { uid: 'u1', rid: 'x_pizza', orderId: 'o1', cost: 8, canonical, orderFingerprint: FP, configVersion: REDEMPTION_CONFIG_VERSION, now: NOW };
  const wallet = (rec) => ({ user_rewards: { u1: { x_pizza: { balance: 100, reserved: rec ? 8 : 0, ...(rec ? { reservations: { o1: rec } } : {}) } } } });
  out.push(await run('reserve.fresh', wallet(null), (db) => reserve.reserveRedemption(db, args)));
  // the stored fp of a legacy record is whatever the legacy writer computes — reuse it from a fresh run
  const fresh = createFakeRtdb(wallet(null)); await reserve.reserveRedemption(fresh, args);
  const stored = fresh.dump().user_rewards.u1.x_pizza.reservations.o1;
  out.push(await run('reserve.reused', wallet(stored), (db) => reserve.reserveRedemption(db, args)));
  out.push(await run('reserve.released_re_reserve', wallet({ ...stored, state: 'released' }), (db) => reserve.reserveRedemption(db, { ...args, now: NOW + 5 })));
  out.push(await run('reserve.conflict', wallet({ ...stored, fp: 'f'.repeat(64) }), (db) => reserve.reserveRedemption(db, args)));
  return out;
}

module.exports = { loadModule, scenarios };
