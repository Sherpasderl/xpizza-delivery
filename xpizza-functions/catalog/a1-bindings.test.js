'use strict';
// PLAN-A A-1 (A8a step 1) — the binding writers on the recording fake RTDB. Run: node catalog/a1-bindings.test.js
//   1. DIFFERENTIAL vs the BASE commit (advisor Q3): the BASE source of pixelpay-charge.js (acquireOnlineAttempt — the
//      dormant direct path), pixelpay-hosted-charge.js, rewards-reserve.js and catalog/canonical-binding.js is compiled
//      from `git show` (in memory, requires wired base→base) and run through the SAME scenarios as today's modules. With
//      no 'a8' artifact and no text binding, every {result, ordered calls, resulting data} is identical.
//   2. THE 'a8' CELLS (today's modules only): a record marked 'a8' is judged ONLY by the a8 candidate (never the legacy
//      fp, even when the legacy fp equals the stored value); a malformed marker → binding_format_invalid; a fresh 'a8'
//      binding with no candidate never writes a mixed record; the reservation's marker selects its own binding,
//      survives a release → re-reserve, and is carried to the caller as selected_text_version.
const assert = require('assert');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const { createFakeRtdb } = require('../test/d4b-fake-rtdb');
const { scenarios } = require('../test/d4b-callseq');
const { REDEMPTION_CONFIG_VERSION } = require('../rewards-redeem-config');
const { BASE } = require('../tools/a1-inverse');
const hosted = require('../pixelpay-hosted-charge');
const direct = require('../pixelpay-charge');
const reserve = require('../rewards-reserve');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const DIR = path.join(__dirname, '..');

// ── the BASE modules, compiled from git, each `require` of a sibling binding module resolved to its BASE twin ──
const BASE_IDS = { './catalog/canonical-binding': 'catalog/canonical-binding.js', '../pixelpay-charge': 'pixelpay-charge.js',
  './pixelpay-charge': 'pixelpay-charge.js', '../rewards-reserve': 'rewards-reserve.js', './rewards-reserve': 'rewards-reserve.js' };
const baseMods = {};
function loadBase(rel) {
  if (baseMods[rel]) return baseMods[rel].exports;
  const src = execFileSync('git', ['show', `${BASE}:xpizza-functions/${rel}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
  const filename = path.join(DIR, rel);
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  const real = m.require.bind(m);
  m.require = (id) => (BASE_IDS[id] ? loadBase(BASE_IDS[id]) : real(id));
  baseMods[rel] = m;                                   // registered BEFORE compiling: the lazy cycles resolve to this instance
  m._compile(src, filename);
  return m.exports;
}
const base = { hosted: loadBase('pixelpay-hosted-charge.js'), direct: loadBase('pixelpay-charge.js'), reserve: loadBase('rewards-reserve.js') };
assert.notStrictEqual(base.reserve.reserveRedemption, reserve.reserveRedemption, 'premise — the base modules are distinct instances');
assert.ok(!/text_version/.test(execFileSync('git', ['show', `${BASE}:xpizza-functions/rewards-reserve.js`], { cwd: DIR, encoding: 'utf8' })), `premise — ${BASE} predates the marker`);

const FP = 'a'.repeat(64), OTHER = 'b'.repeat(64), A8FP = '8'.repeat(64);
const ORDER = { restaurant_id: 'x_pizza', total_cents: 1000, status: 'pending_payment', payment_method: 'online' };
const NOW = 1767200000000;
let seq = 0;
const gen = () => `att_${String(seq += 1).padStart(4, '0')}`, tok = () => 'tok';
async function run(initial, fn) { seq = 0; const db = createFakeRtdb(initial); const result = await fn(db); return { result, calls: db.calls.slice(), data: db.dump() }; }
const attCreated = { hosted_state: 'created', hosted_expires_at: NOW + 60000, hosted_checkout_url: 'https://pay/x', poll_token: 'pt' };
const attExpired = { ...attCreated, hosted_expires_at: NOW - 1 };

// ── 1. the differential ──
(async () => {
  {
    const mine = await scenarios({ hosted, direct, reserve, REDEMPTION_CONFIG_VERSION });
    const theirs = await scenarios({ ...base, REDEMPTION_CONFIG_VERSION });
    assert.strictEqual(mine.length, theirs.length);
    for (let i = 0; i < mine.length; i += 1) assert.deepStrictEqual(mine[i], theirs[i], `🔴 ${mine[i][0]} differs from ${BASE}`);
    // + the branches d4b's scenarios do not reach, both modules side by side
    const extra = [
      ['direct.reuse', { orders: { o1: { ...ORDER, payment_fingerprint: FP, active_attempt_id: 'att_live' } }, payment_attempts: { att_live: attCreated } }, (m) => (db) => m.direct.acquireOnlineAttempt(db, 'o1', ORDER, FP, gen)],
      ['direct.install', { orders: { o1: { ...ORDER } } }, (m) => (db) => m.direct.acquireOnlineAttempt(db, 'o1', ORDER, FP, gen)],
      ['direct.already_paid', { orders: { o1: { ...ORDER, payment_fingerprint: FP, payment_status: 'confirmed' } } }, (m) => (db) => m.direct.acquireOnlineAttempt(db, 'o1', ORDER, FP, gen)],
      ['direct.rotate', { orders: { o1: { ...ORDER, payment_fingerprint: FP, active_attempt_id: 'att_old' } }, payment_attempts: { att_old: { ...attExpired, hosted_state: 'failed' } } }, (m) => (db) => m.direct.acquireOnlineAttempt(db, 'o1', ORDER, FP, gen)],
      ['direct.malformed_fp_format', { orders: { o1: { ...ORDER, payment_fingerprint: FP, fp_format: 'bogus' } } }, (m) => (db) => m.direct.acquireOnlineAttempt(db, 'o1', ORDER, FP, gen)],
      ['hosted.already_paid', { orders: { o1: { ...ORDER, payment_fingerprint: FP, payment_status: 'confirmed' } } }, (m) => (db) => m.hosted.acquireHostedAttempt(db, 'o1', ORDER, FP, NOW, [], gen, tok)],
      ['hosted.cancelled', { orders: { o1: { ...ORDER, payment_fingerprint: FP, status: 'cancelled' } } }, (m) => (db) => m.hosted.acquireHostedAttempt(db, 'o1', ORDER, FP, NOW, [], gen, tok)],
      ['hosted.rotate_expired', { orders: { o1: { ...ORDER, payment_fingerprint: FP, active_attempt_id: 'att_old' } }, payment_attempts: { att_old: attExpired } }, (m) => (db) => m.hosted.acquireHostedAttempt(db, 'o1', ORDER, FP, NOW, [], gen, tok)],
      ['hosted.classify.install', { orders: { o1: { ...ORDER } } }, (m) => (db) => m.hosted.classifyHostedAttempt(db, 'o1', FP, NOW)],
      ['hosted.canonical_ok', { orders: { o1: { ...ORDER, payment_fingerprint: OTHER, fp_format: 'canonical' } } }, (m) => (db) => m.hosted.acquireHostedAttempt(db, 'o1', ORDER, FP, NOW, [], gen, tok, () => ({ ok: true, fp: OTHER }))],
      ['hosted.canonical_unverifiable', { orders: { o1: { ...ORDER, payment_fingerprint: OTHER, fp_format: 'canonical' } } }, (m) => (db) => m.hosted.acquireHostedAttempt(db, 'o1', ORDER, FP, NOW, [], gen, tok, () => ({ ok: false }))],
    ];
    for (const [label, initial, f] of extra) {
      assert.deepStrictEqual(await run(initial, f({ hosted, direct, reserve })), await run(initial, f(base)), `🔴 ${label} differs from ${BASE}`);
    }
    // the reservation lifecycle beyond d4b's four: consumed / held_paid reuse, insufficient, a cash (no expiry) reserve
    const canonical = { restaurant_id: 'x_pizza', model: 'add_free', type: 'free_pizza_choice', config_version: REDEMPTION_CONFIG_VERSION, cost: 8, discount_cents: 0, free_item_key: 'Margherita' };
    const args = { uid: 'u1', rid: 'x_pizza', orderId: 'o1', cost: 8, canonical, orderFingerprint: FP, configVersion: REDEMPTION_CONFIG_VERSION, now: NOW };
    const wallet = (rec, balance = 100) => ({ user_rewards: { u1: { x_pizza: { balance, reserved: rec ? 8 : 0, ...(rec ? { reservations: { o1: rec } } : {}) } } } });
    const fresh = await run(wallet(null), (db) => reserve.reserveRedemption(db, args));
    const stored = fresh.data.user_rewards.u1.x_pizza.reservations.o1;
    for (const [label, initial, a] of [
      ['reserve.consumed', wallet({ ...stored, state: 'consumed' }), args], ['reserve.held_paid', wallet({ ...stored, state: 'held_paid' }), args],
      ['reserve.insufficient', wallet(null, 3), args], ['reserve.hosted_expiry', wallet(null), { ...args, hostedExpiresAt: NOW + 900000 }],
      ['reserve.refunded', wallet({ ...stored, state: 'refunded' }), args],
    ]) {
      assert.deepStrictEqual(await run(initial, (db) => reserve.reserveRedemption(db, a)), await run(initial, (db) => base.reserve.reserveRedemption(db, a)), `🔴 ${label} differs from ${BASE}`);
    }
    ok(`differential: ${mine.length} d4b scenarios + ${extra.length + 5} more (direct reuse/install/paid/rotate/malformed, hosted paid/cancelled/rotate/classify/canonical, reservation lifecycle) — {result, calls, data} identical to the ${BASE} source`);
  }

  // ── 2. the 'a8' cells ──
  const marked = (fp, extra = {}) => ({ ...ORDER, payment_fingerprint: fp, payment_fingerprint_text_version: 'a8', ...extra });
  for (const [name, acquire] of [
    ['direct', (db, fp, tb) => direct.acquireOnlineAttempt(db, 'o1', ORDER, fp, gen, null, tb)],
    ['hosted', (db, fp, tb) => hosted.acquireHostedAttempt(db, 'o1', ORDER, fp, NOW, [], gen, tok, null, false, false, false, false, null, tb)],
  ]) {
    // a record marked 'a8' matches its a8 candidate → not a conflict (installs an attempt on it)
    const ok8 = await run({ orders: { o1: marked(A8FP) } }, (db) => acquire(db, FP, { a8Fp: () => A8FP, fresh: 'legacy' }));
    assert.notStrictEqual(ok8.result.outcome, 'conflict', `${name}: the a8 candidate matches (${JSON.stringify(ok8.result)})`);
    assert.strictEqual(ok8.data.orders.o1.payment_fingerprint, A8FP, 'the stored binding is unchanged');
    assert.strictEqual(ok8.data.orders.o1.payment_fingerprint_text_version, 'a8', 'the marker is kept');
    // …and is NEVER judged by the legacy fp, even when the legacy fp equals the stored value
    for (const tb of [null, { a8Fp: () => OTHER, fresh: 'legacy' }, { a8Fp: () => null, fresh: 'legacy' }]) {
      const r = await run({ orders: { o1: marked(FP) } }, (db) => acquire(db, FP, tb));
      assert.strictEqual(r.result.outcome, 'conflict', `🔴 ${name}: an 'a8' record judged by the legacy fp (${JSON.stringify(tb && tb.a8Fp())})`);
      assert.strictEqual(r.result.reason, undefined, 'today\'s conflict shape');
      assert.deepStrictEqual(r.data.orders.o1, marked(FP), 'nothing written');
    }
    // a malformed marker → binding_format_invalid, nothing written
    for (const bad of ['A8', 'legacy', '', 1]) {
      const r = await run({ orders: { o1: { ...ORDER, payment_fingerprint: FP, payment_fingerprint_text_version: bad } } }, (db) => acquire(db, FP, { a8Fp: () => FP, fresh: 'legacy' }));
      assert.deepStrictEqual([r.result.outcome, r.result.reason], ['conflict', 'binding_format_invalid'], `${name}: marker ${JSON.stringify(bad)}`);
    }
    // a malformed marker on a record WITHOUT a fingerprint: no install (never a legacy fp under a malformed marker)
    const nofp = await run({ orders: { o1: { ...ORDER, payment_fingerprint_text_version: 'zz' } } }, (db) => acquire(db, FP, null));
    assert.strictEqual(nofp.data.orders.o1.payment_fingerprint, undefined, `🔴 ${name}: installed a fp under a malformed marker`);
    // an 'a8' record WITHOUT a fingerprint is filled in ITS version (the a8 candidate), never the legacy fp
    const fill = await run({ orders: { o1: { ...ORDER, payment_fingerprint_text_version: 'a8' } } }, (db) => acquire(db, FP, { a8Fp: () => A8FP, fresh: 'legacy' }));
    assert.strictEqual(fill.data.orders.o1.payment_fingerprint, A8FP, `${name}: install fills the a8 candidate`);
    const fill0 = await run({ orders: { o1: { ...ORDER, payment_fingerprint_text_version: 'a8' } } }, (db) => acquire(db, FP, null));
    assert.strictEqual(fill0.data.orders.o1.payment_fingerprint, undefined, `🔴 ${name}: no a8 candidate → no install (never the legacy fp)`);
    // a FRESH 'a8' binding (a retained 'a8' reservation selected it): the create writes the a8 fp; no candidate → no record
    const cr = await run({}, (db) => acquire(db, FP, { a8Fp: () => A8FP, fresh: 'a8' }));
    assert.strictEqual(cr.data.orders.o1.payment_fingerprint, A8FP, `${name}: a fresh 'a8' create binds the a8 fp`);
    const cr0 = await run({}, (db) => acquire(db, FP, { a8Fp: () => null, fresh: 'a8' }));
    assert.ok(!cr0.data.orders || !cr0.data.orders.o1, `🔴 ${name}: a fresh 'a8' binding with no candidate wrote a record`);
    // the thunk is lazy: an UNMARKED record never evaluates it
    let calls = 0;
    await run({ orders: { o1: { ...ORDER, payment_fingerprint: FP } } }, (db) => acquire(db, FP, { a8Fp: () => { calls += 1; return A8FP; }, fresh: 'legacy' }));
    assert.strictEqual(calls, 0, `${name}: the a8 thunk ran for an unmarked record`);
  }
  {
    // hosted classify: the same selection
    const c8 = await run({ orders: { o1: marked(A8FP) } }, (db) => hosted.classifyHostedAttempt(db, 'o1', FP, NOW, null, () => A8FP));
    const cL = await run({ orders: { o1: marked(FP) } }, (db) => hosted.classifyHostedAttempt(db, 'o1', FP, NOW, null, null));
    assert.notStrictEqual(c8.result.outcome, 'conflict'); assert.strictEqual(cL.result.outcome, 'conflict', '🔴 classify judged an a8 record by the legacy fp');
  }
  ok("'a8' order records (direct + hosted acquire, hosted classify): judged ONLY by the a8 candidate — the legacy fp never matches one, even when equal; malformed → binding_format_invalid; install fills the a8 candidate or nothing; a fresh 'a8' create binds the a8 fp or writes nothing; the thunk is lazy");

  {
    const canonical = { restaurant_id: 'x_pizza', model: 'add_free', type: 'free_pizza_choice', config_version: REDEMPTION_CONFIG_VERSION, cost: 8, discount_cents: 0, free_item_key: 'Margherita' };
    const args = { uid: 'u1', rid: 'x_pizza', orderId: 'o1', cost: 8, canonical, orderFingerprint: FP, configVersion: REDEMPTION_CONFIG_VERSION, now: NOW };
    const wallet = (rec) => ({ user_rewards: { u1: { x_pizza: { balance: 100, reserved: rec ? 8 : 0, ...(rec ? { reservations: { o1: rec } } : {}) } } } });
    // the REAL reserve in 'a8' write mode (what A-4 will write) — the rollback-floor artifact
    const w8 = await run(wallet(null), (db) => reserve.reserveRedemption(db, { ...args, a8OrderFingerprint: A8FP, writeMode: 'a8' }));
    const rec8 = w8.data.user_rewards.u1.x_pizza.reservations.o1;
    assert.strictEqual(w8.result.selected_text_version, 'a8');
    assert.strictEqual(rec8.text_version, 'a8'); assert.strictEqual(rec8.order_fingerprint, A8FP);
    assert.strictEqual(rec8.fp, reserve.bindingFp({ canonical, orderFingerprint: A8FP, configVersion: REDEMPTION_CONFIG_VERSION }));
    // A-1 (legacy write mode) reads it back by ITS marker: reused, selected 'a8', no second debit
    const re = await run(wallet(rec8), (db) => reserve.reserveRedemption(db, { ...args, a8OrderFingerprint: A8FP }));
    assert.deepStrictEqual([re.result.ok, re.result.action, re.result.selected_text_version], [true, 'reused', 'a8']);
    assert.strictEqual(re.data.user_rewards.u1.x_pizza.reserved, 8, 'no second debit');
    // the legacy fp never matches an 'a8' record (the candidate differs past the legacy bound); no candidate → conflict
    for (const a8 of [OTHER, null]) {
      const c = await run(wallet(rec8), (db) => reserve.reserveRedemption(db, { ...args, a8OrderFingerprint: a8 }));
      assert.deepStrictEqual([c.result.ok, c.result.reason], [false, 'reservation_conflict'], `a8 candidate ${a8 && a8.slice(0, 4)}`);
      assert.deepStrictEqual(c.data.user_rewards.u1.x_pizza.reservations.o1, rec8, 'untouched');
    }
    // released → re-reserved keeps the marker and its own binding
    const rr = await run(wallet({ ...rec8, state: 'released' }), (db) => reserve.reserveRedemption(db, { ...args, a8OrderFingerprint: A8FP, now: NOW + 5 }));
    const recRR = rr.data.user_rewards.u1.x_pizza.reservations.o1;
    assert.deepStrictEqual([rr.result.action, rr.result.selected_text_version, recRR.text_version, recRR.order_fingerprint, recRR.fp], ['re_reserved', 'a8', 'a8', A8FP, rec8.fp]);
    // a released LEGACY record re-reserves WITHOUT a marker (absence preserved), selected nothing
    const wl = await run(wallet(null), (db) => reserve.reserveRedemption(db, args));
    const recL = wl.data.user_rewards.u1.x_pizza.reservations.o1;
    assert.ok(!('text_version' in recL) && !('selected_text_version' in wl.result), 'a legacy write carries no marker');
    const rl = await run(wallet({ ...recL, state: 'released' }), (db) => reserve.reserveRedemption(db, { ...args, a8OrderFingerprint: A8FP, now: NOW + 5 }));
    assert.ok(!('text_version' in rl.data.user_rewards.u1.x_pizza.reservations.o1) && !('selected_text_version' in rl.result));
    // malformed marker → binding_format_invalid, untouched
    for (const bad of ['A8', 'legacy', '', 0]) {
      const m = await run(wallet({ ...rec8, text_version: bad }), (db) => reserve.reserveRedemption(db, { ...args, a8OrderFingerprint: A8FP }));
      assert.deepStrictEqual([m.result.ok, m.result.reason], [false, 'binding_format_invalid'], `marker ${JSON.stringify(bad)}`);
    }
    // a fresh 'a8' write with no candidate → refused, nothing written
    const nc = await run(wallet(null), (db) => reserve.reserveRedemption(db, { ...args, writeMode: 'a8' }));
    assert.deepStrictEqual([nc.result.ok, nc.result.reason], [false, 'cart_unverifiable']);
    assert.ok(!nc.data.user_rewards.u1.x_pizza.reservations, 'nothing written');
    // A-1's own write mode: default legacy → byte-identical to base (the differential above), selected nothing
    assert.ok(!('selected_text_version' in wl.result));
  }
  ok("reservations: the REAL reserve in 'a8' mode writes the marker + its own binding; A-1 reuses it by its marker (selected 'a8', no second debit); the legacy fp / no candidate → reservation_conflict; released → re-reserved keeps the marker (a legacy one stays unmarked); malformed → binding_format_invalid; a fresh 'a8' without a candidate → refused, nothing written");

  console.log(`\na1-bindings.test: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
