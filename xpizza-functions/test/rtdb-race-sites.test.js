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
// nth: trigger on the helper's nth read of `at` (0-based) — rateOrderCore reads deleted_uids/{uid} first in its member check, then at :66
async function race(tree, read, compete, at = null, on = null, { nth = 0 } = {}) {
  const S = tree && typeof tree.at === 'function' ? tree : H.store(tree); const c = on || H.client('site');   // a STORE carries a cell's earlier real writes
  const swallow = (p) => Promise.resolve(p).catch(() => {});
  const from = c.sent().length;
  const r = read(c.db); swallow(r); await H.flush();
  // the site's read in flight: a get ('g', the base) or a listen ('q', once / onceWithin) on its path — only the site has issued it yet
  const reads = (sent) => sent.slice(from).filter((m) => (m.a === 'g' || m.a === 'q') && m.b && m.b.p === at);
  if (at) { await c.serve(S, { until: (sent) => { const r = reads(sent)[nth]; return !!(r && c.conn().requestCBHash_[r.r]); } }); assert.ok(c.sent().slice(from).some((m) => (m.a === 'g' || m.a === 'q') && m.b && m.b.p === at), `premise: the helper issued its read on ${at}`); }
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
// RG-RACED-AFTER (r9 §RG-RACED-AFTER, #399 P1-2): the site's caller races its get against a deadline; the deadline fires and the caller
// ANSWERS while the get is still in flight (its reply is held); THEN the next request's competitor registers. Gated, the competitor
// waits until the held get settles; ungated (eb177fe58) its listen is orphaned and its next subscription asserts.
async function racedAfter({ tree, site, path, compete, on = null }) {
  const S = H.store(tree); const c = on || H.client('raced'); const sw = (p) => Promise.resolve(p).catch((e) => ({ threw: e.message }));
  const from = c.sent().length;
  // every frame is served EXCEPT the site's get on `path` (held): the caller's own deadline answers
  const hold = (m) => m.a === 'g' && m.b && m.b.p === path;
  const ans = sw(site(c.db)); let answered = false; ans.then(() => { answered = true; });
  for (let i = 0; i < 400 && !answered; i++) { await H.flush(); await c.serve(S, { skip: hold, max: 400 }).catch(() => {}); if (!answered) await new Promise((r) => setTimeout(r, 10)); }
  const answer = await ans;
  const held = c.sent().slice(from).find((m) => m.a === 'g' && m.b.p === path && c.conn().requestCBHash_[m.r]);
  assert.ok(held, `premise: the site's get on ${path} is still in flight after the caller answered (${String(JSON.stringify(answer)).slice(0, 80)})`);
  const comp = sw(compete(c.db)); await H.flush();
  const early = c.sent().slice(from).some((m) => m.a === 'q' && m.b.p === path);
  await c.serve(S); await comp;
  let asserted = false; const again = sw(compete(c.db)); await H.flush(); await c.serve(S); const a2 = await again; if (a2 && a2.threw && /listen\(\) called twice/.test(a2.threw)) asserted = true;
  const residual = c.listens().filter(([p]) => p === path); if (!on) await c.close();
  return { answer, early, residual, asserted };
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
  // ── row 4, the THREE-PARTY route (Codex #400): acquireHostedAttempt held inside its order transaction (its live listener serves the
  //    order from cache), chargeContext's attempt get on the wire, classifyHostedAttempt's attempt once registered behind it. At the
  //    pre-gate tree acquire itself later throws «listen() called twice» (rtdb-build/r9 probe); gated: clean.
  await cell('RG-SER-4-3P delivery/delivery-wire.js:61 vs classifyHostedAttempt (:285) while acquireHostedAttempt holds its order transaction', async (L) => {
    const order = { order_type: 'pickup', payment_status: 'pending', fingerprint: 'fp2', total_cents: 10000, items_text: '1x X' };
    const S = H.store({ orders: { o4: order }, payment_attempts: {} }); const c = H.client('3p'); const sw = (p) => Promise.resolve(p).catch((e) => ({ threw: e.message }));
    const HC = require('../pixelpay-hosted-charge');
    const acq = sw(HC.acquireHostedAttempt(c.db, 'o4', { ...order }, 'fp2', 1, [], () => 'a9', () => 'tok9')); await H.flush();
    await c.serve(S, { only: ['g', 'q', 'n', 'm'] }).catch(() => {});
    assert.ok(c.sent().some((m) => m.a === 'p' && m.b.p === '/orders/o4' && c.conn().requestCBHash_[m.r]), `${L}: premise, acquire is held inside its order transaction`);
    const cc = sw(require('../delivery/delivery-wire').chargeContext(c.db, 'o4', { ctx: null }, { order_type: 'pickup' }, 1, Promise.resolve(null))); await H.flush();
    const cl = sw(HC.classifyHostedAttempt(c.db, 'o4', 'fp2', 1)); await H.flush();
    await c.serve(S); const out = await Promise.all([cc, cl, acq]);
    assert.ok(!out.some((o) => o && o.threw && /listen\(\) called twice/.test(o.threw)), `🔴 ${L}: «listen() called twice» (${JSON.stringify(out).slice(0, 200)})`);
    assert.deepStrictEqual(c.listens(), [], `🔴 ${L}: an orphaned listen`);
    await c.close();
  });

  await cell('RG-RACED-AFTER-1 checkout-guest-gate.js:87: chargeUidOf answers at its deadline, its tombstone get still in flight; the next saved-card check waits', async (L) => {
    const req = { get: (h) => (h === 'x-firebase-id-token' ? 't' : undefined) };
    const r = await racedAfter({ tree: { deleted_uids: { r1: true } }, path: '/deleted_uids/r1',
      site: (db) => require('../checkout-guest-gate').chargeUidOf(req, { getAuth: () => ({ verifyIdToken: async () => ({ customer: true, uid: 'r1' }) }), getDatabase: () => db, attributionUid: (d, t) => (t ? null : d.uid), deadlineMs: 40 }),
      compete: (db) => require('../payments/sdk/cards').isDeletedUid(db, 'r1') });
    assert.strictEqual(r.answer, undefined, `${L}: the caller's own deadline answer, as today (undecided)`);
    assert.strictEqual(r.early, false, `🔴 ${L}: the competitor registered while the raced get was still in flight`);
    assert.deepStrictEqual({ residual: r.residual, asserted: r.asserted }, { residual: [], asserted: false }, `🔴 ${L}`);
  });

  // ── index.js inline reads, through the REAL exported handlers on the harness default app (H.indexApp)
  // the catalog the money handlers price from: published into the Firestore fake by the REAL writer (publishVersion), as in production
  const FS = require('../catalog/firestore-fake').makeDb();
  const X = H.indexApp({ firestore: FS });
  const CATALOG = (() => { const { buildSourceCandidate } = require('../catalog/candidate-validate'); const { inputs, built } = buildSourceCandidate('x_pizza', require('../tools/seed-source-store').buildSourceFromCode('x_pizza')); return { inputs, built }; })();
  await quiet(() => require('../catalog/catalog-publish').publishVersion(FS, 'x_pizza', { items: CATALOG.built.items, structure: CATALOG.built.structure, extras: CATALOG.inputs.extras, extraRecords: CATALOG.built.extras, source_sha: 'rg0', ...(CATALOG.built.key_mode == null ? {} : { key_mode: CATALOG.built.key_mode }) }, { expected: { activeVersionId: null } }));
  const CARNIVORA = CATALOG.built.items.find((i) => i.key === 'Carnivora');
  // the branch xp_sur (row 9) is published HERE, before any handler loads the restaurant registry (a cached, TTL'd id list)
  const pub = await quiet(() => require('../catalog/catalog-publish').publishVersion(FS, 'xp_sur', { items: CATALOG.built.items, structure: CATALOG.built.structure, extras: CATALOG.inputs.extras, extraRecords: CATALOG.built.extras, source_sha: 'rg9', ...(CATALOG.built.key_mode == null ? {} : { key_mode: CATALOG.built.key_mode }) }, { expected: { activeVersionId: null } }));
  assert.ok(pub && pub.versionId, 'premise: the branch catalog published');
  const OPEN = { open: true, start: '00:00', end: '24:00' };
  const IDENTITY = { name: 'X', phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN } };
  const tok = (uid) => H.idToken(uid, { customer: true });
  const handler = (name, uid, body) => () => H.call(X.idx[name], { headers: { 'x-firebase-id-token': tok(uid), origin: 'https://sherpa.hn' }, body });
  // RG-OP through a REAL handler on the shared index.js app: only the frames from this call onward count
  const framesVia = async (tree, run) => {
    const S = H.store(tree); const from = X.sent().length; const p = Promise.resolve().then(run); p.catch(() => {});
    for (let i = 0; i < 40; i++) { await H.flush(); await X.serve(S).catch(() => {}); }
    let value; try { value = await Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), 200))]); } catch (e) { value = { threw: e.message }; }
    return { value, frames: X.sent().slice(from).filter((m) => 'gq'.includes(m.a)).map((m) => `${m.a}:${m.b.p}`) };
  };
  await cell('RG-SITE-11 ratings/rate-order.js:66 fencedAfterWrite\'s tombstone read vs another rating\'s member check (member-auth.js:26 once)', async (L) => {
    const tree = { orders: { o11: { customer_uid: 'u11', status: 'delivered', restaurant_id: 'x_pizza', delivered_at: 1 } } };
    const verify = async () => ({ uid: 'u11', customer: true });
    const r = await race(tree, (db) => require('../ratings/rate-order').rateOrderCore(db, { body: { order_id: 'o11', thumb: 'up' }, idToken: 't', now: 2, verifyIdToken: verify }),
      (db) => require('../member-auth').memberUidOf(db, 't', verify), '/deleted_uids/u11', null, { nth: 1 });
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
  const orderBody = (oid, method) => ({ restaurant_id: 'x_pizza', order_id: oid, payment_method: method, items: [{ name: CARNIVORA.display.name, qty: 1, price: CARNIVORA.price, extras: [] }], items_text: `1x ${CARNIVORA.display.name}`, customer_name: 'Ana', customer_phone: '99551234', customer_email: 'a@example.com', order_type: 'pickup' });
  const bearer = (uid) => ({ authorization: 'Bearer rtdb-race-make-secret', 'x-firebase-id-token': tok(uid), origin: 'https://sherpa.hn' });
  await cell('RG-SITE-8 index.js:1624 chargeOnlineOrder\'s attribution tombstone read vs the saved-card tombstone once (cards.js:153)', async (L) => {
    const tree = { deleted_uids: {}, restaurants: { x_pizza: { identity: IDENTITY } } };
    const r = await race(tree, () => H.call(X.idx.chargeOnlineOrder, { headers: bearer('u8'), body: orderBody('o8', 'online') }), (db) => require('../payments/sdk/cards').isDeletedUid(db, 'u8'), '/deleted_uids/u8', X);
    clean(L, r, '/deleted_uids/u8');
  });
  await cell('RG-SITE-7 index.js:1511 placeSdkOrder\'s intake tombstone read (isTombstoned) vs the saved-card tombstone once (cards.js:153)', async (L) => {
    const tree = { deleted_uids: {}, restaurants: { x_pizza: { identity: IDENTITY } } };
    const r = await race(tree, () => H.call(X.idx.placeSdkOrder, { headers: { authorization: `Bearer ${tok('u7')}`, origin: 'https://sherpa.hn' }, body: { ...orderBody('o7', 'online'), entry_mode: 'app' } }), (db) => require('../payments/sdk/cards').isDeletedUid(db, 'u7'), '/deleted_uids/u7', X);
    clean(L, r, '/deleted_uids/u7');
  });
  await cell('RG-SITE-9 index.js:2132 chargeOnlineOrder\'s return-site brand read (a BRANCH\'s retry) vs the offers brand resolver\'s once (marketing/brand-of.js:14)', async (L) => {
    // a branch (brand_id → a brand WITH its own deployment) re-charging an order its first attempt created: the retry skips the fresh
    // identity read, so the return site resolves the brand through readBrandId. The branch's catalog is published by the real writer.
    const S = H.store({ restaurants: { xp_sur: { identity: { ...IDENTITY, brand_id: 'x_pizza' } } } });
    const body = { ...orderBody('o9', 'online'), restaurant_id: 'xp_sur', customer_phone: '99559009' };   // its own phone: the shared app keeps per-phone process state across cells
    const charge = () => H.call(X.idx.chargeOnlineOrder, { headers: { authorization: 'Bearer rtdb-race-make-secret', origin: 'https://sherpa.hn' }, body });
    const first = charge(); for (let i = 0; i < 200; i++) { await H.flush(); await X.serve(S).catch(() => {}); } const firstRes = await quiet(() => first);   // the first attempt: the pending order (its hosted create fails closed: no network)
    assert.ok(S.at('/orders/o9'), `${L}: premise, the first attempt left the pending order (it answered ${JSON.stringify(firstRes).slice(0, 200)})`);
    const r = await race(S, charge, (db) => require('../marketing/brand-of').brandOf(db, 'xp_sur', { nowMs: Date.now(), cached: false }), '/restaurants/xp_sur/identity/brand_id', X);
    clean(L, r, '/restaurants/xp_sur/identity/brand_id');
  });
  // ── class P (preventive): no reachable assertion with the real competitor (§4.3) — the op guard + the §3.2 matrix carry them ──────
  const REWARDS_TREE = { user_rewards: { u1: { x_pizza: { balance: 0, reserved: 0, reservations: {} } } } };
  // RG-RACED-AFTER rows 7 / 8 — the REAL handlers' own 1.5 s races answer while the tombstone get is held
  await cell('RG-RACED-AFTER-7 index.js:1511: placeSdkOrder\'s intake answers 503 auth_unavailable at its 1.5 s race, the get still in flight; the next saved-card check waits', async (L) => {
    const r = await racedAfter({ on: X, tree: { deleted_uids: {}, restaurants: { x_pizza: { identity: IDENTITY } } }, path: '/deleted_uids/r7',
      site: () => H.call(X.idx.placeSdkOrder, { headers: { authorization: `Bearer ${tok('r7')}`, origin: 'https://sherpa.hn' }, body: { ...orderBody('o7r', 'online'), entry_mode: 'app' } }),
      compete: (db) => require('../payments/sdk/cards').isDeletedUid(db, 'r7') });
    assert.deepStrictEqual(r.answer && [r.answer.status, r.answer.body && r.answer.body.error], [503, 'auth_unavailable'], `${L}: today's answer`);
    assert.strictEqual(r.early, false, `🔴 ${L}: the competitor registered while the raced get was in flight`);
    assert.deepStrictEqual({ residual: r.residual, asserted: r.asserted }, { residual: [], asserted: false }, `🔴 ${L}`);
  });
  await cell('RG-RACED-AFTER-8 index.js:1624: chargeOnlineOrder\'s attribution answers at its 1.5 s race (guest), the get still in flight; the next saved-card check waits', async (L) => {
    const r = await racedAfter({ on: X, tree: { deleted_uids: {}, restaurants: { x_pizza: { identity: IDENTITY } } }, path: '/deleted_uids/r8',
      site: () => H.call(X.idx.chargeOnlineOrder, { headers: bearer('r8'), body: { ...orderBody('o8r', 'online'), customer_phone: '99558008' } }),
      compete: (db) => require('../payments/sdk/cards').isDeletedUid(db, 'r8') });
    assert.ok(r.answer && typeof r.answer.status === 'number', `${L}: the handler answered (${JSON.stringify(r.answer).slice(0, 80)})`);
    assert.strictEqual(r.early, false, `🔴 ${L}: the competitor registered while the raced get was in flight`);
    assert.deepStrictEqual({ residual: r.residual, asserted: r.asserted }, { residual: [], asserted: false }, `🔴 ${L}`);
  });
  // RG-DOUBLE-TAP (r6 / r9, scoped per #399 P2-5): two concurrent identical hosted charges for ONE order through the real
  // chargeOnlineOrder, the provider create stubbed to SUCCEED (in-process, counted; no network). ONE provider call, ONE attempt; the
  // second answers per today's rules. The same cell on the pre-gate tree records today's result; the two must match.
  await cell('RG-DOUBLE-TAP hosted: two concurrent identical charges ⇒ one provider create, one attempt, answers as today', async (L) => {
    let created = 0;
    H.stubFetch((u) => (/pixelpay\.dev\/api\/v2\/transaction\/hosted/.test(u) ? (created += 1, H.jsonResponse(200, { success: true, url: `https://pay.example/c/${created}` })) : null));
    try {
      const S = H.store({ deleted_uids: {}, restaurants: { x_pizza: { identity: IDENTITY } } });
      const body = { ...orderBody('odt1', 'online'), customer_phone: '99557771' };
      const tap = () => H.call(X.idx.chargeOnlineOrder, { headers: bearer('udt1'), body });
      const a = tap(); const b = tap(); let done = 0; a.then(() => done++, () => done++); b.then(() => done++, () => done++);
      for (let i = 0; i < 600 && done < 2; i++) { await H.flush(); await X.serve(S, { max: 400 }).catch(() => {}); if (done < 2) await new Promise((r) => setTimeout(r, 5)); }
      const [ra, rb] = await Promise.all([a, b]);
      const attempts = Object.keys(S.at('/payment_attempts') || {});
      console.log(`    RG-DOUBLE-TAP answers: ${ra.status} ${JSON.stringify(ra.body).slice(0, 140)} / ${rb.status} ${JSON.stringify(rb.body).slice(0, 140)}; creates=${created}; attempts=${attempts.length}`);
      assert.strictEqual(created, 1, `🔴 ${L}: provider creates`);
      assert.strictEqual(attempts.length, 1, `🔴 ${L}: persisted attempts`);
    } finally { H.stubFetch(null); }
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
