'use strict';
// PLAN-guest-checkout-server r4 §1 — S1 handlers (requestCheckoutCode / verifyCheckoutCode) over an in-memory RTDB whose
// TRANSACTION semantics match production: returning undefined ABORTS (committed:false, no write), null DELETES, the snapshot is
// the committed value. The real handlers + real otp-lib + real checkout-guest-lib; only the DB, the clock and the provider fetch
// are injected. (The emulator run of the exported endpoints is the S1 heavy cell.)
// Run: node checkout-otp.test.js
process.env.OTP_SALT = process.env.OTP_SALT || 'test-salt-'.padEnd(40, 'x');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeCheckoutOtp, sendPlatformOtp, pruneCheckoutState } = require('./checkout-otp');
const OTP = require('./otp-lib');
const G = require('./checkout-guest-lib');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const H = (c) => c.repeat(64);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function fakeDb() {
  const tree = {};
  const get = (p) => p.split('/').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => { const ks = p.split('/').filter(Boolean); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v); };
  const snap = (v) => ({ exists: () => v != null, val: () => (v == null ? null : clone(v)) });
  return { tree, get, set, ref: (p) => ({
    get: async () => snap(get(p)),
    set: async (v) => set(p, v),
    orderByChild: (field) => ({ endAt: (c) => ({ once: async () => snap(Object.fromEntries(Object.entries(get(p) || {}).filter(([, r]) => r && typeof r[field] === 'number' && r[field] <= c))) }) }),
    transaction: async (fn) => { const next = fn(clone(get(p)) ?? null); if (next === undefined) return { committed: false, snapshot: snap(get(p)) }; set(p, next); return { committed: true, snapshot: snap(get(p)) }; },
  }) };
}
function res() { const r = { statusCode: 0, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; }
const ENV = { ULTRAMSG_INSTANCE_ID_PLATFORM: 'inst', ULTRAMSG_TOKEN_PLATFORM: 'tok', CHECKOUT_OTP_TEMPLATE: 'Tu código: {code}' };
function harness({ env = ENV, accept = true, known = ['x_pizza', 'la_musa'] } = {}) {
  const db = fakeDb(); let clock = 1.8e12; const sent = [];
  const fetchImpl = async (url, init) => { const q = new URLSearchParams(init.body); sent.push({ url, to: q.get('to'), body: q.get('body') }); return { ok: true, json: async () => (accept ? { sent: 'true', id: 1 } : {}) }; };
  const h = makeCheckoutOtp({ getDatabase: () => db, knownRid: async (r) => known.includes(r), now: () => clock, env, fetchImpl });
  const call = async (fn, body, ip = '1.2.3.4') => { const r = res(); await h[fn]({ method: 'POST', body, ip }, r); return r; };
  return { db, sent, call, tick: (ms) => { clock += ms; }, now: () => clock, codeOf: () => (sent.length ? sent[sent.length - 1].body.match(/\d{6}/)[0] : null) };
}
const PHONE = '+50499990000', FP = H('c');
const reqBody = (o = {}) => ({ phone_e164: PHONE, restaurant_id: 'x_pizza', cart_fp: FP, ...o });

(async () => {
  // ── 1. request: happy path — the platform sender, its own record, the durable budget ──
  {
    const t = harness();
    const r = await t.call('requestCheckoutCode', reqBody());
    assert.deepStrictEqual([r.statusCode, r.body], [200, { ok: true, resend_in_s: 30 }]);
    assert.strictEqual(t.sent.length, 1); assert.strictEqual(t.sent[0].url, 'https://api.ultramsg.com/inst/messages/chat'); assert.strictEqual(t.sent[0].to, '50499990000');
    assert.match(t.sent[0].body, /^Tu código: \d{6}$/, 'the CONFIGURED template, never a literal');
    const h = OTP.phoneHash('50499990000');
    const rec = t.db.get('checkout_otp/' + h);
    assert.ok(rec && rec.rid === 'x_pizza' && rec.cart_fp === FP && rec.attempts === 0 && rec.code_hash && rec.phone === '50499990000');
    assert.deepStrictEqual(t.db.get('otp_budget/' + h), { sends: [t.now()], last: t.now() }, 'the checkout send is recorded durably');
    assert.strictEqual(t.db.get('otp/' + h), undefined, 'the signup record is never touched');
  }
  ok('request: platform sender + configured template, its OWN checkout_otp record (rid + cart_fp bound), the durable budget, signup otp/{h} untouched');

  // ── 2. request: input refusals (no send, no budget) ──
  {
    const t = harness();
    for (const [b, want] of [[reqBody({ phone_e164: '99990000' }), 'bad_request'], [reqBody({ phone_e164: '+4412345678901' }), 'country_not_allowed'],
      [reqBody({ phone_e164: '+5049999000' }), 'country_not_allowed'], [reqBody({ restaurant_id: 'nope' }), 'bad_request'], [reqBody({ restaurant_id: undefined }), 'bad_request'],
      [reqBody({ cart_fp: 'abc' }), 'bad_request'], [{}, 'bad_request']]) {
      const r = await t.call('requestCheckoutCode', b);
      assert.deepStrictEqual([r.statusCode, r.body], [400, { error: want }], JSON.stringify(b));
    }
    assert.strictEqual(t.sent.length, 0); assert.deepStrictEqual(t.db.tree.otp_budget, undefined);
    const r = res(); await makeCheckoutOtp({ getDatabase: () => t.db, knownRid: async () => true })['requestCheckoutCode']({ method: 'GET', body: {} }, r); assert.strictEqual(r.statusCode, 405);
  }
  ok('request: malformed phone ⇒ bad_request; non-allow-listed country ⇒ country_not_allowed; unknown / missing rid (never defaulted) or bad cart_fp ⇒ bad_request; non-POST 405 — nothing sent, no budget used');

  // ── 3. request: limits — the 30 s gap, 3 per window, the shared IP budget, the signup union ──
  {
    const t = harness();
    assert.strictEqual((await t.call('requestCheckoutCode', reqBody())).statusCode, 200);
    let r = await t.call('requestCheckoutCode', reqBody());
    assert.strictEqual(r.statusCode, 429); assert.strictEqual(r.body.error, 'rate_limited'); assert.strictEqual(r.body.retry_in_s, 30);
    t.tick(31e3); assert.strictEqual((await t.call('requestCheckoutCode', reqBody())).statusCode, 200);
    t.tick(31e3); assert.strictEqual((await t.call('requestCheckoutCode', reqBody())).statusCode, 200);
    t.tick(31e3); r = await t.call('requestCheckoutCode', reqBody()); assert.strictEqual(r.statusCode, 429, '3 per 10 min');
    // signup's live sends count toward the window (the advisor-accepted union) …
    const u = harness(); const h = OTP.phoneHash('50499990000');
    u.db.set('otp/' + h, { sends: [u.now() - 40e3, u.now() - 100e3, u.now() - 200e3] });
    assert.strictEqual((await u.call('requestCheckoutCode', reqBody())).statusCode, 429, 'signup sends in the window count');
    // … but after signup's verify deletes otp/{h}, checkout = its own durable sends (ownership proven)
    u.db.set('otp/' + h, null); assert.strictEqual((await u.call('requestCheckoutCode', reqBody())).statusCode, 200);
    // the SHARED per-IP budget (otp_ip) — 10/h across signup and checkout
    const v = harness();
    for (let i = 0; i < 10; i++) { const r2 = await v.call('requestCheckoutCode', reqBody({ phone_e164: '+5049999' + String(1000 + i) })); assert.strictEqual(r2.statusCode, 200); }
    r = await v.call('requestCheckoutCode', reqBody({ phone_e164: '+50499992000' })); assert.deepStrictEqual([r.statusCode, r.body.error], [429, 'rate_limited']);
  }
  ok('request limits: 30 s gap (retry_in_s), 3 per window, signup sends counted while live, checkout\'s own budget after a signup verify, the shared otp_ip budget');

  // ── 4. request: the platform sender fails closed ──
  {
    for (const env of [{}, { ...ENV, CHECKOUT_OTP_TEMPLATE: 'no placeholder' }, { ...ENV, ULTRAMSG_TOKEN_PLATFORM: '' }]) {
      const t = harness({ env });
      const live = { code_hash: 'h', expires_at: t.now() + 60e3, attempts: 0, rid: 'x_pizza', cart_fp: FP, phone: '50499990000' };
      t.db.set('checkout_otp/' + OTP.phoneHash('50499990000'), live);
      const r = await t.call('requestCheckoutCode', reqBody());
      assert.deepStrictEqual([r.statusCode, r.body], [502, { error: 'send_failed', attempt: 0, max_attempts: 3 }], 'unconfigured ⇒ 502, never a silent success');
      assert.strictEqual(t.sent.length, 0);
      // Codex r1 P2-3: checked BEFORE every reservation — no shared IP allowance, no phone budget, the live code untouched
      assert.strictEqual(t.db.get('otp_ip'), undefined, '🔴 the shared per-IP allowance (the forms\' too) is not burned');
      assert.strictEqual(t.db.get('otp_budget'), undefined, '🔴 the durable phone budget is not burned');
      assert.deepStrictEqual(t.db.get('checkout_otp/' + OTP.phoneHash('50499990000')), live, '🔴 the live code is not replaced');
      const again = await t.call('requestCheckoutCode', reqBody());
      assert.deepStrictEqual([again.statusCode, again.body.error], [502, 'send_failed'], 'an immediate retry is still 502, never 429');
    }
    const t = harness({ accept: false });
    const r = await t.call('requestCheckoutCode', reqBody());
    assert.strictEqual(r.statusCode, 502, 'a provider answer without a POSITIVE acceptance (isSendConfirmed) is a failure');
    t.tick(31e3); const r2 = await t.call('requestCheckoutCode', reqBody()); assert.deepStrictEqual([r2.statusCode, r2.body.attempt], [502, 2], 'attempt counts the window');
  }
  ok('platform sender fails closed: unset instance / token / template (or no {code}) ⇒ 502 send_failed BEFORE any reservation (no IP / budget / code state; a retry is 502, not 429); an unconfirmed provider answer ⇒ 502; attempt / max_attempts reported');

  // ── 4b. Codex r1 P1-1: issuance and verification on SEPARATE instances — the verifier's SDK has no cache of the challenge ──
  {
    const t = harness();
    assert.strictEqual((await t.call('requestCheckoutCode', reqBody())).statusCode, 200);
    // a second "instance": the SAME server tree, but every transaction's FIRST run sees null (the uncached SDK); a non-undefined
    // result is re-checked against the server and the updater RE-RUNS with the stored value; undefined ABORTS (production semantics)
    const uncached = { ...t.db, ref: (p) => { const r = t.db.ref(p); return { ...r, transaction: async (fn) => {
      const first = fn(null);
      if (first === undefined) return { committed: false, snapshot: { exists: () => false, val: () => null } };
      if (t.db.get(p) == null) return r.transaction(() => first);
      return r.transaction(fn);
    } }; } };
    const h2 = makeCheckoutOtp({ getDatabase: () => uncached, knownRid: async () => true, now: t.now, env: ENV, fetchImpl: async () => ({ ok: true, json: async () => ({ sent: 'true' }) }) });
    const r = res(); await h2.verifyCheckoutCode({ method: 'POST', body: { ...reqBody(), order_id: 'XPZ-1', code: t.codeOf() }, ip: '9.9.9.9' }, r);
    assert.strictEqual(r.statusCode, 200, `🔴 a valid code on an uncached instance must verify (${JSON.stringify(r.body)})`);
    assert.match(r.body.checkout_ticket, /^ct_[0-9a-f]{32}$/);
    const r2 = res(); await h2.verifyCheckoutCode({ method: 'POST', body: { ...reqBody(), order_id: 'XPZ-1', code: t.codeOf() }, ip: '9.9.9.9' }, r2);
    assert.deepStrictEqual([r2.statusCode, r2.body], [400, { error: 'code_expired' }], 'consumed ⇒ truly absent ⇒ code_expired');
  }
  ok('verify on an UNCACHED instance (Codex r1 P1-1): the first null run no longer aborts — a valid code issued elsewhere verifies; a consumed one is code_expired');

  // ── 5. verify: success ⇒ the order-id-bound ticket; the code is consumed ──
  {
    const t = harness();
    await t.call('requestCheckoutCode', reqBody());
    const code = t.codeOf();
    const r = await t.call('verifyCheckoutCode', reqBody({ order_id: 'XPZ-ORD-1', code }));
    assert.strictEqual(r.statusCode, 200); assert.match(r.body.checkout_ticket, /^ct_[0-9a-f]{32}$/);
    const h = OTP.phoneHash('50499990000');
    const rec = t.db.get('checkout_tickets/' + G.ticketKey(r.body.checkout_ticket));
    assert.deepStrictEqual(rec, { phone: '50499990000', phone_hash: h, rid: 'x_pizza', cart_fp: FP, order_id: 'XPZ-ORD-1', exp: t.now() + 15 * 60e3 });
    assert.strictEqual(G.ticketValid(rec, { now: t.now(), rid: 'x_pizza', orderId: 'XPZ-ORD-1', cartFp: FP, phoneHash: h }), true);
    assert.strictEqual(t.db.get('checkout_otp/' + h), undefined, 'the code is consumed');
    const again = await t.call('verifyCheckoutCode', reqBody({ order_id: 'XPZ-ORD-1', code }));
    assert.deepStrictEqual([again.statusCode, again.body], [400, { error: 'code_expired' }], 'a consumed code never verifies twice');
    assert.strictEqual(r.body.token, undefined, 'no custom token is minted — the guest stays a guest');
  }
  ok('verify: success issues ct_… stored as {phone, phone_hash, rid, cart_fp, order_id, exp} (no state) and consumes the code; no token minted; a reused code ⇒ code_expired');

  // ── 6. verify: refusals ──
  {
    const t = harness();
    await t.call('requestCheckoutCode', reqBody()); const code = t.codeOf();
    const wrong = code === '000000' ? '111111' : '000000';
    let r = await t.call('verifyCheckoutCode', reqBody({ order_id: 'O1', code, cart_fp: H('d') })); assert.deepStrictEqual([r.statusCode, r.body], [400, { error: 'code_wrong' }], 'another cart: no oracle');
    r = await t.call('verifyCheckoutCode', reqBody({ order_id: 'O1', code, restaurant_id: 'la_musa' })); assert.deepStrictEqual(r.body, { error: 'code_wrong' }, 'another restaurant');
    r = await t.call('verifyCheckoutCode', reqBody({ order_id: 'O1', code: '12' })); assert.deepStrictEqual(r.body, { error: 'code_wrong' });
    r = await t.call('verifyCheckoutCode', reqBody({ order_id: 'bad id', code })); assert.deepStrictEqual(r.body, { error: 'bad_request' });
    for (let i = 1; i <= 4; i++) { r = await t.call('verifyCheckoutCode', reqBody({ order_id: 'O1', code: wrong })); assert.deepStrictEqual(r.body, { error: 'code_wrong' }, `wrong #${i}`); }
    r = await t.call('verifyCheckoutCode', reqBody({ order_id: 'O1', code: wrong })); assert.strictEqual(r.statusCode, 429); assert.strictEqual(r.body.error, 'too_many_attempts'); assert.ok(r.body.retry_in_s > 0);
    r = await t.call('verifyCheckoutCode', reqBody({ order_id: 'O1', code })); assert.strictEqual(r.statusCode, 429, 'even the right code is refused after 5 attempts');
    const e = harness(); await e.call('requestCheckoutCode', reqBody()); const c2 = e.codeOf(); e.tick(5 * 60e3);
    r = await e.call('verifyCheckoutCode', reqBody({ order_id: 'O1', code: c2 })); assert.deepStrictEqual([r.statusCode, r.body], [400, { error: 'code_expired' }]);
    assert.strictEqual(e.db.get('checkout_otp/' + OTP.phoneHash('50499990000')), undefined, 'an expired code is cleared');
    // a SIGNUP code never verifies a checkout (separate records)
    const s = harness(); const h = OTP.phoneHash('50499990000');
    s.db.set('otp/' + h, { code_hash: OTP.hashCode('123456'), expires_at: s.now() + 60e3, attempts: 0, sends: [] });
    r = await s.call('verifyCheckoutCode', reqBody({ order_id: 'O1', code: '123456' })); assert.deepStrictEqual(r.body, { error: 'code_expired' }, 'no checkout code ⇒ never the signup code');
    assert.ok(s.db.get('otp/' + h), 'the signup record is untouched');
  }
  ok('verify refusals: another cart / restaurant ⇒ code_wrong (no oracle); bad code ⇒ code_wrong; bad order_id ⇒ bad_request; 5 attempts ⇒ 429 too_many_attempts (even the right code after); expiry ⇒ code_expired + cleared; a signup code never verifies');

  // ── 7. rules: the three new nodes are server-only (no nested grant) ──
  {
    const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json'), 'utf8')).rules;
    for (const k of ['checkout_otp', 'otp_budget', 'checkout_tickets']) {
      assert.ok(rules[k], k); assert.strictEqual(rules[k]['.read'], false); assert.strictEqual(rules[k]['.write'], false);
      assert.deepStrictEqual(Object.keys(rules[k]).filter((x) => !x.startsWith('.')), [], `${k}: no nested grant`);
    }
    assert.deepStrictEqual(rules.checkout_tickets['.indexOn'], ['exp']);
    assert.deepStrictEqual(rules.checkout_otp['.indexOn'], ['expires_at']); assert.deepStrictEqual(rules.otp_budget['.indexOn'], ['last']);
  }
  ok('rules: checkout_otp / otp_budget / checkout_tickets are server-only with no nested grant; checkout_tickets indexOn exp (prune)');

  // ── 9. the prune: expired rows only, re-checked inside a transaction ──
  {
    const db = fakeDb(); const now = 2e12, W = G.BUDGET.WINDOW;
    db.set('checkout_tickets/a', { exp: now - 1 }); db.set('checkout_tickets/b', { exp: now + 60e3 });
    db.set('checkout_otp/c', { expires_at: now - 5 }); db.set('checkout_otp/d', { expires_at: now + 5 });
    db.set('otp_budget/e', { sends: [now - W - 10], last: now - W - 10 }); db.set('otp_budget/f', { sends: [now - 1000], last: now - 1000 });
    const out = await pruneCheckoutState(db, now);
    assert.deepStrictEqual(out, { tickets: 1, codes: 1, budgets: 1 });
    assert.deepStrictEqual(Object.keys(db.tree.checkout_tickets), ['b']); assert.deepStrictEqual(Object.keys(db.tree.checkout_otp), ['d']); assert.deepStrictEqual(Object.keys(db.tree.otp_budget), ['f']);
    assert.deepStrictEqual(await pruneCheckoutState(db, now), { tickets: 0, codes: 0, budgets: 0 }, 'idempotent');
  }
  ok('prune: expired tickets / codes and window-old budgets removed (each re-checked in a transaction); live rows kept; idempotent');

  // ── 8. sendPlatformOtp never throws ──
  assert.deepStrictEqual(await sendPlatformOtp('50499990000', '123456', { env: ENV, fetchImpl: async () => { throw new Error('net'); }, isSendConfirmed: () => true }), { ok: false, reason: 'threw' });
  ok('sendPlatformOtp: a network error is a failure result, never a throw');

  console.log(`\ncheckout-otp: OK (${n})`);
})().catch((e) => { console.error('checkout-otp: FAILED', e); process.exit(1); });
