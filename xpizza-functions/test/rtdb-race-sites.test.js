'use strict';
// PLAN-rtdb-get-once-race-r3 §4.3 / §5 — per-SITE cells on the real Admin-loaded bundle (test/_rtdb-race-harness.js). Each class-A cell
// runs the REAL helper that owns a replaced read, issued FIRST (the hazard order, RG-1-ORDER), while the REAL competing code path
// subscribes to the same path; the server answers one frame per turn. RED at eb177fe58 (the helper's get() orphans the competitor's
// listen and the competitor's next subscription asserts «listen() called twice»); GREEN once the site reads with once('value').
// A competitor's own later failure (deps a cell does not model) is ignored: only its REGISTRATION is the competing event.
// Run: node test/rtdb-race-sites.test.js [CELL-PREFIX]
const assert = require('assert');
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'rtdb-race-make-secret';   // createOrder's bearer check (test value)
process.env.OTP_SALT = process.env.OTP_SALT || 'rtdb-race-test-salt-0123456789abcdef';   // otp-lib fails closed without one (test value)
const H = require('./_rtdb-race-harness');
let n = 0; const fails = [];
const only = process.argv[2] || '';
async function cell(label, fn) { if (only && !label.startsWith(only)) return; try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const TWICE = /listen\(\) called twice for same path\/queryId/;
const quiet = async (fn) => { const l = console.log, w = console.warn, e = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; console.error = e; } };

// the race: `read` (the site's helper) first, then `compete`; serve; then `compete` again — the competitor's NEXT subscription
// `at`: the SITE's path — the competitor subscribes while the site's get on it is IN FLIGHT (the hazard order, RG-1-ORDER), however
// many reads the helper makes before it
// `on`: the shared index.js app (H.indexApp(): one default app per process — cells there use distinct keys and are not closed)
async function race(tree, read, compete, at = null, on = null) {
  const S = H.store(tree); const c = on || H.client('site');
  const swallow = (p) => Promise.resolve(p).catch(() => {});
  const r = read(c.db); swallow(r); await H.flush();
  if (at) { await c.serve(S, { until: (sent) => sent.some((m) => m.a === 'g' && m.b.p === at && !m.__done) }); assert.ok(c.sent().some((m) => m.a === 'g' && m.b.p === at), `premise: the helper issued its get on ${at}`); }
  swallow(compete(c.db)); await H.flush();
  await c.serve(S);
  const value = await r;
  const residual = c.listens();
  // the competitor's next subscription: the assertion surfaces as a SYNC throw (a bare once) or as its async caller's REJECTION
  let asserted = false;
  const seen = (e) => { if (e && TWICE.test(e.message)) asserted = true; };
  let again; try { again = Promise.resolve(compete(c.db)).catch(seen); } catch (e) { seen(e); }
  await H.flush(); await c.serve(S); if (again) await again;
  if (!on) await c.close();
  return { value, residual, asserted };
}
// `under`: the SITE's path — a cell judges only orphans at or under it, so each site's mutant dies at its own cell even while a
// neighbouring site of the same helper is still a get (the RED at eb177fe58 shows both)
// the SCHEDULE search (deterministic): the real competitor starts first and k of its frames are served (one per turn, request order);
// then the real site helper starts and every remaining frame is served. k = 0..K; the first k whose result orphans a listen at/under the
// site's path is the class-A schedule a cell pins. null ⇒ no reachable assertion with these two code paths (class P for this pair).
// siteFirst: the SITE starts first and j frames are served before the competitor starts (every two-party start offset, both ways)
async function scheduleOf(tree, read, compete, under, K = 24, { siteFirst = false } = {}) {
  for (let k = 0; k <= K; k++) {
    const S = H.store(tree); const c = H.client(`k${k}`);
    const swallow = (p) => Promise.resolve(p).catch(() => {});
    const [first, second] = siteFirst ? [read, compete] : [compete, read];
    const cp = first(c.db); swallow(cp); await H.flush();
    let served = 0; while (served < k) { const did = await c.serve(S, { max: 1 }).catch(() => 1); if (!did) break; served += did; }
    if (served < k) { await c.close(); return null; }   // the first party finished before k: no later schedule exists
    const r = second(c.db); swallow(r); await H.flush();
    await c.serve(S); await swallow(r); await swallow(cp);
    const hit = c.listens().some(([p]) => p === under || p.startsWith(`${under}/`));
    await c.close();
    if (hit) return k;
  }
  return null;
}
// RG-OP (class P, §4.3): the REAL helper alone; its frames show the read went out as a listen (once), never the one-shot 'g' request
async function framesOf(tree, read) {
  const S = H.store(tree); const c = H.client('op'); const r = read(c.db); Promise.resolve(r).catch(() => {});
  await H.flush(); await c.serve(S); let value; try { value = await r; } catch (e) { value = { threw: e.message }; }
  const frames = c.sent().filter((m) => 'gq'.includes(m.a)).map((m) => `${m.a}:${m.b.p}`); await c.close();
  return { value, frames };
}
// nth: judge only the n-th read of `path` (0-based) — where one handler reads the same path at two sites (verifyOtp: claimPhoneUid :307 then
// index.js:7315), each site's mutant must die at its own cell
const opClean = (L, f, path, nth = null) => {
  const mine = f.frames.filter((x) => x.endsWith(`:${path}`));
  assert.ok(nth == null ? mine.length > 0 : mine.length > nth, `${L}: premise, the helper read ${path}${nth == null ? '' : ` at least ${nth + 1}×`} (${f.frames.join(' ')})`);
  const judged = nth == null ? mine : [mine[nth]];
  assert.ok(!judged.some((x) => x.startsWith('g:')), `🔴 ${L}: the helper read ${path} with the one-shot get (${f.frames.join(' ')})`);
};
// the same search on a SHARED app (the index.js default app): caseOf(k) gives fresh keys per offset → { tree, read, compete, under }
async function scheduleOn(on, caseOf, K = 24, { siteFirst = false } = {}) {
  for (let k = 0; k <= K; k++) {
    const { tree, read, compete, under } = caseOf(k); const S = H.store(tree);
    const swallow = (p) => Promise.resolve(p).catch(() => {});
    const [first, second] = siteFirst ? [read, compete] : [compete, read];
    const cp = first(on.db); swallow(cp); await H.flush();
    let served = 0; while (served < k) { const did = await on.serve(S, { max: 1 }).catch(() => 1); if (!did) break; served += did; }
    if (served < k) { for (let i = 0; i < 40; i++) { await H.flush(); await on.serve(S).catch(() => {}); } return null; }
    const r = second(on.db); swallow(r);
    for (let i = 0; i < 40; i++) { await H.flush(); await on.serve(S).catch(() => {}); }
    if (on.listens().some(([p]) => p === under || p.startsWith(`${under}/`))) return k;
  }
  return null;
}
const clean = (L, r, under = null) => {
  const mine = r.residual.filter(([p]) => !under || p === under || p.startsWith(`${under}/`));
  assert.deepStrictEqual({ residual: mine, asserted: under ? mine.length > 0 && r.asserted : r.asserted }, { residual: [], asserted: false }, `🔴 ${L}: the competitor's listen is orphaned / its next subscription asserts`);
};

const WELCOME_RID = Object.entries(require('../rewards-core').REWARDS_CONFIG).find(([, v]) => v && v.welcome > 0)[0];
const ORDER = { o1: { order_type: 'pickup', payment_status: 'pending', payment_flow: 'sdk_auth_v1', status: 'new' } };
const settle = (db) => require('../payments/sdk/coordinator').settleTerminal({ db, clock: () => 1 }, { orderId: 'o1' });   // coordinator.js:328 readOrder: once orders/{id}

(async () => {
  // ── demonstrated (#386): the charge path's stored-order reads ─────────────────────────────────────────────────────────────────────
  await cell('RG-SITE-10 payments/sdk/stored-admission.js:14 storedAdmission vs the SDK coordinator\'s order once (settleTerminal)', async (L) => {
    const r = await race({ orders: ORDER }, (db) => require('../payments/sdk/stored-admission').storedAdmission(db, 'o1', async () => null), settle);
    assert.deepStrictEqual(r.value, { order: ORDER.o1, refusal: null }, `${L}: the helper's own answer`);
    clean(L, r, '/orders/o1');
  });
  await cell('RG-SITE-3 delivery/delivery-wire.js:57 chargeContext vs the SDK coordinator\'s order once (settleTerminal)', async (L) => {
    const dq = { ctx: null, marker: 'dq' };
    const r = await race({ orders: ORDER }, (db) => require('../delivery/delivery-wire').chargeContext(db, 'o1', dq, { order_type: 'pickup' }, 1, Promise.resolve(null)), settle);
    assert.strictEqual(r.value, dq, `${L}: the helper's own answer (same fulfilment ⇒ this request's dq)`);
    clean(L, r, '/orders/o1');
  });


  // ── the deleted_uids family (rows 1, 12; the competitor is the saved-card path's tombstone once, cards.js:153) ───────────────────
  const tombOnce = (db) => require('../payments/sdk/cards').isDeletedUid(db, 'u1');
  await cell('RG-SITE-1 checkout-guest-gate.js:87 chargeUidOf\'s tombstone read vs the saved-card tombstone once (cards.js:153)', async (L) => {
    const req = { get: (h) => (h === 'x-firebase-id-token' ? 't' : undefined) };
    const r = await race({ deleted_uids: { u1: true } }, (db) => require('../checkout-guest-gate').chargeUidOf(req, { getAuth: () => ({ verifyIdToken: async () => ({ customer: true, uid: 'u1' }) }), getDatabase: () => db, attributionUid: (d, tomb) => (tomb ? null : d.uid), deadlineMs: 60000 }), tombOnce, '/deleted_uids/u1');
    assert.strictEqual(r.value, null, `${L}: a tombstoned member is never attributed`);
    clean(L, r, '/deleted_uids/u1');
  });
  await cell('RG-SITE-12 rewards-earn.js:17 isDeleted (via creditWelcome) vs the saved-card tombstone once (cards.js:153)', async (L) => {
    const r = await race({ deleted_uids: { u1: true } }, (db) => require('../rewards-earn').creditWelcome(db, { uid: 'u1', phoneHash: 'ph', restaurantId: WELCOME_RID, now: 1 }), tombOnce, '/deleted_uids/u1');
    assert.deepStrictEqual(r.value, { credited: false }, `${L}: a purged account is never credited`);
    clean(L, r, '/deleted_uids/u1');
  });

  // ── rewards: the consumed reservation's collateral read (row 13) vs the SDK terminal consume's state once (coordinator.js:320) ─────
  await cell('RG-SITE-13 rewards-reserve.js:59 alertIfUndercollateralized (via consumeRedemption) vs consumeFulfilledRedemption\'s state once (descendant)', async (L) => {
    const RES = '/user_rewards/u1/x_pizza/reservations/o1';
    const tree = { user_rewards: { u1: { x_pizza: { balance: 500, reserved: 100, seq: 1, reservations: { o1: { state: 'reserved', cost: 100, debit_applied: 100 } } } } } };
    const order = { payment_flow: 'sdk_auth_v1', status: 'delivered', redemption: { cost: 100 }, customer_uid: 'u1', restaurant_id: 'x_pizza' };
    const r = await race(tree, (db) => require('../rewards-reserve').consumeRedemption(db, { uid: 'u1', rid: 'x_pizza', orderId: 'o1', now: 1 }),
      (db) => require('../payments/sdk/coordinator').consumeFulfilledRedemption({ db, clock: () => 1 }, 'o1', order), RES);
    assert.ok(r.value && r.value.ok === true, `${L}: the consume applied (${JSON.stringify(r.value)})`);
    clean(L, r, RES);
  });

  await cell('RG-SITE-6 delivery/zone-resume.js:40 preBookkeepingRefusal (null-dq retry) vs the SDK coordinator\'s order once (settleTerminal)', async (L) => {
    const r = await race({ orders: ORDER }, (db) => require('../delivery/zone-resume').preBookkeepingRefusal(db, 'o1', null, Promise.resolve(null)), settle, '/orders/o1');
    clean(L, r, '/orders/o1');
  });

  await cell('RG-SITE-5 delivery/delivery-wire.js:146 quoteDeliveryFor\'s tombstone read vs the audience member resolver\'s once (audience-place.js:21)', async (L) => {
    const req = { get: (h) => (h === 'x-firebase-id-token' ? 't' : undefined) };
    const auth = { getAuth: () => ({ verifyIdToken: async () => ({ customer: true, uid: 'u1' }) }), attributionUid: (d, tomb) => (tomb ? null : d.uid) };
    const r = await race({ deleted_uids: { u1: true } },
      (db) => require('../delivery/delivery-wire').quoteDeliveryFor(req, db, 'x_pizza', { entry_mode: 'app', mode: 'pickup' }, { ...auth, getIdentity: async () => null, pricingP: Promise.resolve({ pricing: {} }) }).catch((e) => ({ later: e.message })),
      (db) => require('../marketing/audience-place').memberOf(req, db, auth)(), '/deleted_uids/u1');
    clean(L, r, '/deleted_uids/u1');
  });

  // ── the daily reconciliation sweeps' order reads (rows 21–24) vs a superseded-capture evidence pass on the same order
  //    (recordEvidence → acquireLease → underLease, superseded-capture.js:182 once), started while the sweep's root read is in flight
  const evidence = (db) => require('../superseded-capture').recordEvidence(db, { orderId: 'o1', attemptId: 'a1', now: 1, clock: () => 1 });
  const sweepTree = (rec) => ({ user_rewards: { u1: { x_pizza: { balance: 0, reserved: 100, reservations: { o1: { state: 'reserved', cost: 100, ...rec } } } } },
    orders: { o1: { status: 'new', payment_status: 'pending', customer_uid: 'u1', restaurant_id: 'x_pizza' } }, payment_attempts: { a1: { hosted_state: 'created' } } });
  for (const [row, line, fn, rec] of [[21, 384, 'sweepStaleReservations', { hosted_expires_at: 9e12 }], [22, 389, 'sweepStaleReservations', { hosted_expires_at: 0 }],
    [23, 402, 'sweepStaleReservations', {}], [24, 532, 'sweepConsumeRecovery', {}]]) {
    await cell(`RG-SITE-${row} rewards-reserve.js:${line} ${fn}'s order read vs a superseded-capture evidence pass's order once (superseded-capture.js:182)`, async (L) => {
      const k = await scheduleOf(sweepTree(rec), (db) => require('../rewards-reserve')[fn](db, { now: 1000 }), evidence, '/orders/o1');
      assert.strictEqual(k, null, `🔴 ${L}: the evidence pass's order listen is orphaned when it starts ${k} frame(s) ahead of the sweep`);
    });
  }
  // ── RG-INTRO (#392, rows 25 / 27): the hazard the CANDIDATE introduces — the competitor is a read this build converts to once, so the
  //    cell is meaningful only on the candidate tree: at eb177fe58 its premise fails (the competitor still uses get); GREEN on the full
  //    candidate; RED on the candidate with only this site reverted (its mutant)
  const candidateSubscribes = async (L, tree, compete, path) => { const f = await framesOf(tree, compete); assert.ok(f.frames.includes(`q:${path}`), `${L}: premise (candidate) — the competitor subscribes to ${path} (${f.frames.join(' ')})`); };
  await cell('RG-INTRO-25 claim-order.js:50 claimOrderCore\'s tombstone read vs another claim\'s earn credit (rewards-earn.js:17, converted) via creditEarnForOrder', async (L) => {
    const tree = { deleted_uids: { u1: true }, user_profiles: { u1: { phone_hash: 'h' } }, orders: { o1: { phone_hash: 'h' } } };
    const earn = (db) => require('../rewards-earn').creditEarnForOrder(db, { orderId: 'o2', order: { customer_uid: 'u1', restaurant_id: 'x_pizza', items: [{ name: 'x', price: 200, qty: 1 }], subtotal_cents: 20000 }, now: 1 });
    await candidateSubscribes(L, tree, earn, '/deleted_uids/u1');
    const r = await race(tree, (db) => require('../claim-order').claimOrderCore(db, { uid: 'u1', orderId: 'o1', token: null, now: 1 }), earn, '/deleted_uids/u1');
    clean(L, r, '/deleted_uids/u1');
  });
  await cell('RG-INTRO-27 rewards-reserve.js:34 reserveRedemption\'s tombstone read vs another hosted charge\'s attribution read (checkout-guest-gate.js:87, converted)', async (L) => {
    const tree = { deleted_uids: { u1: true } };
    const req = { get: (h) => (h === 'x-firebase-id-token' ? 't' : undefined) };
    const attrib = (db) => require('../checkout-guest-gate').chargeUidOf(req, { getAuth: () => ({ verifyIdToken: async () => ({ customer: true, uid: 'u1' }) }), getDatabase: () => db, attributionUid: (d, t) => (t ? null : d.uid), deadlineMs: 60000 });
    await candidateSubscribes(L, tree, attrib, '/deleted_uids/u1');
    const r = await race(tree, (db) => require('../rewards-reserve').reserveRedemption(db, { uid: 'u1', rid: 'x_pizza', orderId: 'o1', cost: 100, canonical: {}, orderFingerprint: 'fp', configVersion: require('../rewards-redeem-config').REDEMPTION_CONFIG_VERSION, now: 1 }), attrib, '/deleted_uids/u1');
    clean(L, r, '/deleted_uids/u1');
  });
  // ── index.js inline reads, through the REAL exported handlers on the harness default app (H.indexApp)
  // the catalog the money handlers price from: published into the Firestore fake by the REAL writer (publishVersion), as in production
  const FS = require('../catalog/firestore-fake').makeDb();
  const X = H.indexApp({ firestore: FS });
  const CATALOG = (() => { const { buildSourceCandidate } = require('../catalog/candidate-validate'); const { inputs, built } = buildSourceCandidate('x_pizza', require('../tools/seed-source-store').buildSourceFromCode('x_pizza')); return { inputs, built }; })();
  await quiet(() => require('../catalog/catalog-publish').publishVersion(FS, 'x_pizza', { items: CATALOG.built.items, structure: CATALOG.built.structure, extras: CATALOG.inputs.extras, extraRecords: CATALOG.built.extras, source_sha: 'rg0', ...(CATALOG.built.key_mode == null ? {} : { key_mode: CATALOG.built.key_mode }) }, { expected: { activeVersionId: null } }));
  const CARNIVORA = CATALOG.built.items.find((i) => i.key === 'Carnivora');
  const OPEN = { open: true, start: '00:00', end: '24:00' };
  const IDENTITY = { name: 'X', phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN } };
  const tok = (uid) => H.idToken(uid, { customer: true });
  const handler = (name, uid, body) => () => H.call(X.idx[name], { headers: { 'x-firebase-id-token': tok(uid), origin: 'https://sherpa.hn' }, body });
  await cell('RG-INTRO-26 index.js:2791 claimOrder\'s tombstone read vs another claim\'s earn credit (rewards-earn.js:17, converted)', async (L) => {
    const tree = { deleted_uids: { u26: true } };
    const earn = (db) => require('../rewards-earn').creditEarnForOrder(db, { orderId: 'o26b', order: { customer_uid: 'u26', restaurant_id: 'x_pizza', items: [{ name: 'x', price: 200, qty: 1 }], subtotal_cents: 20000 }, now: 1 });
    await candidateSubscribes(L, tree, earn, '/deleted_uids/u26');
    const r = await race(tree, handler('claimOrder', 'u26', { order_id: 'o26' }), earn, '/deleted_uids/u26', X);
    assert.deepStrictEqual(r.value, { status: 403, body: { error: 'forbidden' } }, `${L}: the handler's own answer`);
    clean(L, r, '/deleted_uids/u26');
  });
  // RG-OP through a REAL handler on the shared index.js app: only the frames from this call onward count
  const framesVia = async (tree, run) => {
    const S = H.store(tree); const from = X.sent().length; const p = Promise.resolve().then(run); p.catch(() => {});
    for (let i = 0; i < 40; i++) { await H.flush(); await X.serve(S).catch(() => {}); }
    let value; try { value = await Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), 200))]); } catch (e) { value = { threw: e.message }; }
    return { value, frames: X.sent().slice(from).filter((m) => 'gq'.includes(m.a)).map((m) => `${m.a}:${m.b.p}`) };
  };
  await cell('RG-OP-29 index.js:7463 quoteRedemption reads the caller\'s tombstone with once, never get (deleted_uids family rule)', async (L) => {
    opClean(L, await framesVia({ deleted_uids: { u29: true } }, handler('quoteRedemption', 'u29', { restaurant_id: 'x_pizza', order_id: 'o29' })), '/deleted_uids/u29');
  });
  await cell('RG-OP-18 index.js:7536 pruneInactiveAccounts reads user_profiles (root) with once, never get', async (L) => {
    opClean(L, await framesVia({ user_profiles: {} }, () => X.idx.pruneInactiveAccounts.run({ scheduleTime: new Date(0).toISOString() })), '/user_profiles');
  });
  await cell('RG-OP-14 index.js:7315 verifyOtp (forms) reads phone_index with once, never get', async (L) => {
    const OTP = require('../otp-lib'); const phone = '+50499990014'; const ph = OTP.phoneHash(phone);
    const tree = { otp: { [ph]: { code_hash: OTP.hashCode('123456'), expires_at: 9e12, attempts: 0, sends: [1] } }, phone_index: { [ph]: 'u14' }, user_profiles: { u14: { created_at: 1 } } };
    opClean(L, await framesVia(tree, () => H.call(X.idx.verifyOtp, { headers: { origin: 'https://sherpa.hn' }, body: { phone, code: '123456' } })), `/phone_index/${ph}`, 1);   // the 2nd phone_index read = :7315 (the 1st is claimPhoneUid :307, row 16)
  });
  await cell('RG-SITE-11 ratings/rate-order.js:66 fencedAfterWrite\'s tombstone read vs another rating\'s member check (member-auth.js:26 once)', async (L) => {
    const tree = { orders: { o11: { customer_uid: 'u11', status: 'delivered', restaurant_id: 'x_pizza', delivered_at: 1 } } };
    const verify = async () => ({ uid: 'u11', customer: true });
    const r = await race(tree, (db) => require('../ratings/rate-order').rateOrderCore(db, { body: { order_id: 'o11', thumb: 'up' }, idToken: 't', now: 2, verifyIdToken: verify }),
      (db) => require('../member-auth').memberUidOf(db, 't', verify), '/deleted_uids/u11');
    assert.ok(r.value && r.value.httpStatus === 200, `${L}: the rating was recorded (${JSON.stringify(r.value)})`);
    clean(L, r, '/deleted_uids/u11');
  });
  await cell('RG-SITE-15 index.js:7325 verifyOtp\'s profile read vs a platform sign-in\'s completion check (signup-core.js:303/:311 once, descendant)', async (L) => {
    const OTP = require('../otp-lib'); const SC = require('../signup-core');
    const caseOf = (k) => {
      const phone = `+5049999${String(1500 + k).padStart(4, '0')}`; const ph = OTP.phoneHash(phone); const uid = `u15k${k}`;
      const tree = { otp: { [ph]: { code_hash: OTP.hashCode('123456'), expires_at: 9e12, attempts: 0, sends: [1] } }, phone_index: { [ph]: uid },
        user_profiles: { [uid]: { created_at: 5, name: 'N' } }, signup_config: { rollout_at: 1 },
        platform_config: { legal: { terms_url: 't', privacy_url: 'p', terms_version: '1', privacy_version: '1', promos_copy_version: '1' } } };
      return { tree, under: `/user_profiles/${uid}`, read: () => H.call(X.idx.verifyOtp, { headers: { origin: 'https://sherpa.hn' }, body: { phone, code: '123456' } }),
        compete: (db) => SC.completionState(db, uid, SC.PLATFORM_SCOPE, {}) };
    };
    const kc = await scheduleOn(X, caseOf, 24); const ks = kc == null ? await scheduleOn(X, (k) => caseOf(100 + k), 24, { siteFirst: true }) : null;
    assert.deepStrictEqual({ competitorFirst: kc, siteFirst: ks }, { competitorFirst: null, siteFirst: null }, `🔴 ${L}: an asserting schedule exists`);
  });
  await cell('RG-INTRO-28 index.js:865 createOrder\'s tombstone read vs another order\'s redemption reserve (rewards-reserve.js:34, converted)', async (L) => {
    const tree = { deleted_uids: { u28: true }, restaurants: { x_pizza: { identity: IDENTITY } } };
    const reserve = (db) => require('../rewards-reserve').reserveRedemption(db, { uid: 'u28', rid: 'x_pizza', orderId: 'o28b', cost: 100, canonical: {}, orderFingerprint: 'fp', configVersion: require('../rewards-redeem-config').REDEMPTION_CONFIG_VERSION, now: 1 });
    await candidateSubscribes(L, tree, reserve, '/deleted_uids/u28');
    const body = { restaurant_id: 'x_pizza', order_id: 'o28', payment_method: 'cash', items: [{ name: CARNIVORA.display.name, qty: 1, price: CARNIVORA.price, extras: [] }], items_text: `1x ${CARNIVORA.display.name}`, customer_name: 'Ana', customer_phone: '99551234', customer_email: 'a@example.com', order_type: 'pickup' };
    const r = await race(tree, () => H.call(X.idx.createOrder, { headers: { authorization: 'Bearer rtdb-race-make-secret', 'x-firebase-id-token': tok('u28'), origin: 'https://sherpa.hn' }, body }), reserve, '/deleted_uids/u28', X);
    clean(L, r, '/deleted_uids/u28');
  });
  // ── class P (preventive): no reachable assertion with the real competitor (§4.3) — the op guard + the §3.2 matrix carry them ──────
  await cell('RG-OP-4 delivery/delivery-wire.js:61 chargeContext reads the active attempt with once, never get', async (L) => {
    const tree = { orders: { o1: { order_type: 'pickup', payment_status: 'pending', active_attempt_id: 'a1' } }, payment_attempts: { a1: { hosted_state: 'created', hosted_expires_at: 9e12, hosted_checkout_url: 'u' } } };
    opClean(L, await framesOf(tree, (db) => require('../delivery/delivery-wire').chargeContext(db, 'o1', { ctx: null }, { order_type: 'pickup' }, 1, Promise.resolve(null))), '/payment_attempts/a1');
  });
  await cell('RG-OP-2 claim-order.js:56 claimOrderCore reads the order with once, never get', async (L) => {
    const tree = { user_profiles: { u1: { phone_hash: 'h' } }, orders: { o1: { phone_hash: 'h', status: 'delivered' } } };
    opClean(L, await framesOf(tree, (db) => require('../claim-order').claimOrderCore(db, { uid: 'u1', orderId: 'o1', token: null, now: 1 })), '/orders/o1');
  });
  const REWARDS_TREE = { user_rewards: { u1: { x_pizza: { balance: 0, reserved: 0, reservations: {} } } } };
  await cell('RG-OP-19 rewards-reserve.js:375 sweepStaleReservations reads user_rewards (root) with once, never get', async (L) => {
    opClean(L, await framesOf(REWARDS_TREE, (db) => require('../rewards-reserve').sweepStaleReservations(db, { now: 1 })), '/user_rewards');
  });
  await cell('RG-OP-20 rewards-reserve.js:524 sweepConsumeRecovery reads user_rewards (root) with once, never get', async (L) => {
    opClean(L, await framesOf(REWARDS_TREE, (db) => require('../rewards-reserve').sweepConsumeRecovery(db, { now: 1 })), '/user_rewards');
  });
  await cell('RG-OP-16 signup-endpoints.js:307 claimPhoneUid reads phone_index with once, never get', async (L) => {
    opClean(L, await framesOf({ phone_index: { ph: 'u0' } }, (db) => require('../signup-endpoints').claimPhoneUid(db, 'ph', 'u1')), '/phone_index/ph');
  });
  await cell('RG-OP-17 catalog/identity-record-writer.js:229 readCursor reads the cursor with once, never get', async (L) => {
    const W = require('../catalog/identity-record-writer');
    opClean(L, await framesOf({ catalog_ctx_cursor: { x_pizza: { seq: 1 } } }, (db) => W.readCursor(W.gateIo(db.ref('catalog_ctx_cursor/x_pizza'), { stopped: () => false, remaining: () => 60000 }), { ms: 60000 })), '/catalog_ctx_cursor/x_pizza');
  });
  if (process.env.RG_SEARCH) {   // class-run aid: print the first asserting schedule per pair (not a cell)
    const tree4 = { orders: { o1: { order_type: 'pickup', payment_status: 'pending', active_attempt_id: 'a1' } }, payment_attempts: { a1: { hosted_state: 'created', hosted_expires_at: 9e12, hosted_checkout_url: 'u' } } };
    const cc = (db) => require('../delivery/delivery-wire').chargeContext(db, 'o1', { ctx: null }, { order_type: 'pickup' }, 1, Promise.resolve(null));
    console.log('row4 probe     k =', await scheduleOf(tree4, cc, (db) => require('../client-floor').liveCheckoutProbe(db, 'o1', 1), '/payment_attempts/a1'));
    console.log('row4 classify  k =', await scheduleOf(tree4, cc, (db) => require('../pixelpay-hosted-charge').classifyHostedAttempt(db, 'o1', 'fp', 1), '/payment_attempts/a1'));
    console.log('row3 settle    k =', await scheduleOf({ orders: ORDER }, (db) => require('../delivery/delivery-wire').chargeContext(db, 'o1', { ctx: null }, { order_type: 'pickup' }, 1, Promise.resolve(null)), settle, '/orders/o1'));
  }
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`rtdb-race-sites: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
