// R3 P1-a — ONE ORDINARY JOURNEY with both gates on (PLAN-R3-P1 rev 4 §8): S1 (form cash DELIVERY, x_pizza) through the
// REAL order form's UI (page harness, virtual timers, every network call routed to the real handlers), the real createOrder
// and its triggers (the P0 scheduler), the KDS's PRIVATE projection on the real KDS page, and the real order-received
// WhatsApp send. Gate A: every required cell of the enforced slice (S1 / x_pizza / LP new on R1 R9 R13 R14 R15) is compared
// against the writer-derived oracle at its region. Gate B: the tracer's site hits are ratcheted. Phase timing is reported.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:r3-p1a-journey
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('./_no-secrets');   // R3 P1-a (codex r2 P1-1c): no real credential in a test process (before any fake is set)
require('../test/_emulator-required')('database', 'firestore');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';

// gate B: the tracer is installed BEFORE any census unit loads (installServer refuses otherwise)
const T = require('./tracer');
const HITS = T.createRecorder();
const SRV = T.installServer(HITS);

const fsx = require('node:fs');
{ const m = /const ORDER_SECRET\s*=\s*'([0-9a-f]+)'/.exec(fsx.readFileSync(new URL('../../xpizza-orders/index.html', import.meta.url), 'utf8')); process.env.MAKE_SECRET = m[1]; }

// the WhatsApp SEND BOUNDARY: the REAL whatsapp.js runs end to end (isEnabledForRestaurant, sendMessage's brand resolution +
// renderTemplate); only the transport is captured — a TEST-ONLY fake UltraMsg instance (never a real credential, never read
// from any .env). whatsapp.js sends through node-fetch: its export is wrapped so a request to the fake instance is answered
// in process (recorded with the CALL STACK, to prove which writer sent it). EGRESS is refused at the PROCESS level by
// tools/egress-guard.js, which emulator-run preloads before anything loads (asserted below); nothing here allows egress.
process.env.ULTRAMSG_INSTANCE_ID = 'r3-test-instance'; process.env.ULTRAMSG_TOKEN = 'r3-test-token-not-a-secret';
const SENT = [];
const ULTRA = 'https://api.ultramsg.com/r3-test-instance/';
const capture = (realFetch, ResponseCtor) => async (u, init) => {
  if (String(u).startsWith(ULTRA)) { const p = new URLSearchParams(String(init && init.body || '')); const lim = Error.stackTraceLimit; Error.stackTraceLimit = 60; const origin = new Error().stack; Error.stackTraceLimit = lim; SENT.push({ to: p.get('to'), body: p.get('body'), ctx: CTX.now, origin }); return new ResponseCtor(JSON.stringify({ sent: 'true', id: `r3-${SENT.length}` }), { status: 200, headers: { 'content-type': 'application/json' } }); }
  return realFetch(u, init);
};
{ const nf = require.resolve('node-fetch'); const real = require('node-fetch'); const gated = capture(real, real.Response); Object.assign(gated, real, { default: gated });
  require.cache[nf] = { id: nf, filename: nf, loaded: true, children: [], paths: [], exports: gated }; }
const CTX = { now: 'boot' };
// the identity-shadow HEARTBEAT (codex P1-a r6): createOrder's sampling statement — `const shadowResult = …isSettled() …`
// — is followed unconditionally by reportIdentityShadow(...), which logs ONE synchronous `order_identity_shadow_checked`
// line per order. That statement holds no census read (its reads are call callees), so the tracer cannot hit it; its
// heartbeat is the runtime obligation: exactly one per order, from createOrder's own call site (by stack). An early
// return, a dead branch or a move that skips the sampling statement leaves no heartbeat → RED, whatever the syntax.
const SHADOW_BEATS = [];
{ const orig = console.log; console.log = function (...a) { if (a[0] === 'order_identity_shadow_checked') { const lim = Error.stackTraceLimit; Error.stackTraceLimit = 40; const stack = new Error().stack; Error.stackTraceLimit = lim; let body = null; try { body = JSON.parse(a[1]); } catch (_) { /* malformed */ } SHADOW_BEATS.push({ body, stack }); } return orig.apply(this, a); }; }
const PH = {}; const phase = async (name, fn) => { const t0 = Date.now(); try { return await fn(); } finally { PH[name] = (PH[name] || 0) + (Date.now() - t0); } };

require('../test/_catalog-clock').install();
const WITNESS = require('./version-witness').install();
const admin = require('firebase-admin');
const app = require('../index.js');
const D = require('./discovery');
const { createScheduler } = require('./scheduler');
const TRIG = D.dbTriggers(D.runtimeInventory(app));
const S = createScheduler({ admin, triggers: TRIG, run: new Set(TRIG.map((t) => t.name)) }).install();
const { makeFormRouter } = require('./form-router');
const { createFirebaseHost } = require('./rtdb-adapter');
const { bootPage } = require('./page-harness');
const { installGoogleMaps } = require('./maps-stub');
const rtdb = admin.database(); const fs = admin.firestore();
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { publishVersion } = require('../catalog/catalog-publish');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (cell, msg) => `🔴 R3-P1A:${cell} ${msg}`;
const OPEN = { open: true, start: '00:00', end: '24:00' };
const STAFF = 'staff_r3';
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
const { OBSERVABLES } = require('./observables');
const { factsOf } = require('./oracle');
const { gateA } = require('./gate-a');
const { runGateA, formatFailure } = require('./gate-a-run');
const AP = require('./applicability');
const RAT = require('./ratchet');
const SCEN = JSON.parse(fsx.readFileSync(AP.SCENARIOS, 'utf8')); const S1 = SCEN.scenarios.S1;
// C1: every step settles with its page's DECLARED horizon (contract/timer-bounds.json, guarded by timer-bounds.guard)
const TB = JSON.parse(fsx.readFileSync(new URL('./timer-bounds.json', import.meta.url), 'utf8'));
// the confirmation steps use the page's reviewed horizon EXCEPTION (the order-number poll, ≤ 45 s); every other step the standard
const HORIZON = { form: TB.pages['xpizza-orders'].horizonMs, formConfirmation: TB.pages['xpizza-orders'].exception.horizonMs, kds: TB.pages['xpizza-kitchen'].horizonMs };
const SLICE = { scenarios: ['S1'], brands: ['x_pizza'], lps: ['new'], readers: ['R1', 'R9', 'R13', 'R14', 'R15'] };
// the per-step invocation multiset (observed, then DECLARED): the triggers the pay tap fans out to, by export name
const EXPECTED_INVOCATIONS = JSON.parse(fsx.readFileSync(new URL('./p1a-expect.json', import.meta.url), 'utf8'));
const steps = []; const step = async (name, fn) => { steps.push(name); return phase('actions', fn); };
const calls = [];   // every routed cloudfunctions call, each in its OWN writer context (served-version witness)

try {
  await phase('setup', () => S.fixture(async () => {
    await rtdb.ref().set(null); const rid = 'x_pizza';
    await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(rid)));
    const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'p1a' });
    await publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
    await backfillIdentities(fs, rid, catalogSnapshot(rid), { captured: await getActivePointer(fs, rid) });
    { const v1 = (await getActivePointer(fs, rid)).version; const b = buildPublishCandidate(rid, { activeVersionId: v1 }, { source_sha: 'p1a-2' }); await publishVersion(fs, rid, b.input, { expected: { activeVersionId: v1 }, mirror: makeRtdbMirror(rtdb) }); }
    await rtdb.ref(`restaurants/${rid}/identity`).set({ name: 'X Pizza', display_name: 'X. Pizza', phone: '+50400000000', active: true, hub_lat: 15.5003, hub_lng: -88.025, delivery_radius_km: 8, version: 1, hours: { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN } });
    await rtdb.ref('config/auto_assign_enabled').set(false);
    for (const role of ['kitchen', 'dispatchers']) await rtdb.ref(`${role}/${STAFF}`).set(true);   // as the P0 page suites grant staff access
  }));
  const ACTIVE = (await getActivePointer(fs, 'x_pizza')).version;
  const restaurant = (await rtdb.ref('restaurants/x_pizza/identity').get()).val();

  // ── the REAL form, booted on the page harness (tracer on), network → the REAL handlers, each call its own writer context ──
  const R = makeFormRouter({ app, rtdb });
  const routed = async (u, i) => {
    const m = /cloudfunctions\.net\/([A-Za-z0-9_]+)/.exec(String(u));
    // a page's REST read of the database (e.g. the confirmation's order-number poll of order_tracking/<token>) is answered
    // only once the backend's in-flight triggers have drained: the page runs on VIRTUAL time, the backend on real time — a
    // read the page issues ≥ 700 ms of page time after a write sees what the backend's ms-scale triggers wrote by then
    if (!m) { if (/firebaseio\.com/.test(String(u))) await S.drain('rest-read'); return R.respond(String(u), i); }
    const w = await S.writer(`${m[1]}#${calls.length}`, () => R.respond(String(u), i), { served: [] });
    calls.push({ fn: m[1], served: w.store.served.map((x) => ({ versionId: x.versionId, source: x.source })) });
    return w.r;
  };
  const fhost = createFirebaseHost({ pageId: 'p1a-form', user: { uid: 'cust_p1a', email: 'c@p1a.test' }, fixture: S.fixture });
  const intent = { ...S1.intent };
  const snaps = {}; const negSnaps = {};
  CTX.now = 'S1/x_pizza/form'; HITS.setContext(CTX.now);
  // the form's DECLARED wall-clock anchor (S1.pageWallClock): 13:00 HN on the run's own HN day
  const hn = new Date(Date.now() - 6 * 3600000); const FORM_ANCHOR = Date.UTC(hn.getUTCFullYear(), hn.getUTCMonth(), hn.getUTCDate(), 19, 0, 0);
  const form = await step('form.boot', () => phase('boot', () => bootPage('xpizza-orders', { host: fhost, url: 'https://orders.test/', tracer: HITS, fetchImpl: routed, wallClockAnchorMs: FORM_ANCHOR,
    beforeScripts: (w) => {
      installGoogleMaps(w);
      w.IntersectionObserver = function () { return { observe() {}, unobserve() {}, disconnect() {}, takeRecords() { return []; } }; };
      Object.defineProperty(w.navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: (okCb) => w.setTimeout(() => okCb({ coords: { latitude: 15.5050, longitude: -88.0290, accuracy: 8 } }), 0) } });
    } })));
  const w = form.win; const doc = form.doc;
  // codex P1-a r1 P1-3: EVERY observation requires settle() === true AND a clean page + adapter (no page error, no
  // subscription-callback error, nothing refused) — a handler that rendered then threw, or left tracked work, is RED
  const CLEAN = (pg, host, label) => {
    const errs = pg.errors.filter((e) => !/Could not parse CSS/.test(e));
    assert.deepStrictEqual(errs, [], FAIL(label, `page error(s): ${errs.slice(0, 3).join(' | ').slice(0, 600)}`));
    assert.deepStrictEqual(host.callbackErrors, [], FAIL(label, `adapter callback error(s): ${JSON.stringify(host.callbackErrors).slice(0, 600)}`));
    assert.deepStrictEqual(pg.refused, [], FAIL(label, `refused: ${JSON.stringify(pg.refused)}`));
  };
  let observations = 0;
  const settled = async (pg, host, horizon, label) => { const r = await phase('settle', () => pg.settle(horizon)); assert.strictEqual(r, true, FAIL(label, `settle(${horizon}) did not settle`)); CLEAN(pg, host, label); observations += 1; };
  await settled(form, fhost, HORIZON.form, 'form.boot');
  assert.ok(form.clock.anchored && w.isOpen() === true, FAIL('clock', `the form is not open at its declared wall-clock anchor (${new Date(FORM_ANCHOR).toISOString()})`));
  const click = (el, what) => { assert.ok(el, FAIL('ui', `the control ${what} is missing`)); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); };
  const type = (el, v, what) => { assert.ok(el, FAIL('ui', `the input ${what} is missing`)); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const settleForm = (label) => settled(form, fhost, HORIZON.form, label);

  await step('form.add-dish', async () => { const add = doc.querySelector('[data-act="inc"]'); intent.dishId = add && add.closest('[data-id]') ? add.closest('[data-id]').getAttribute('data-id') : null; click(add, 'dish +'); });
  await step('form.customer', async () => { type(doc.getElementById('cname'), intent.name, '#cname'); type(doc.getElementById('cphone'), intent.phone, '#cphone'); type(doc.getElementById('cemail'), intent.email, '#cemail'); });
  await settleForm('form.cartPill');
  snaps['form.cartPill'] = OBSERVABLES['form.cartPill'].capture({ doc });
  await step('form.cart-sheet-open', async () => { click(doc.getElementById('cart-bar'), '#cart-bar'); });
  await settleForm('form.reviewSheet');
  snaps['form.reviewSheet'] = OBSERVABLES['form.reviewSheet'].capture({ doc });
  // codex r1 P1-9 negative, on the LIVE page: the same sheet content captured while the sheet is NOT open is RED
  { const sh = doc.getElementById('cart-review-sheet'); sh.classList.remove('open'); negSnaps.closedSheet = OBSERVABLES['form.reviewSheet'].capture({ doc }); sh.classList.add('open'); }
  await step('form.continue', async () => { click(doc.getElementById('btn-continuar'), '#btn-continuar'); });
  await settleForm('form.continue');
  assert.ok(doc.querySelector('#s2.stage.active'), FAIL('ui', `the pay step did not open (err1: ${text(doc.getElementById('err1'))})`));
  await step('form.address-details', async () => { type(doc.getElementById('address-details'), intent.addressDetails, '#address-details'); });
  await settleForm('form.address-details');
  await step('form.pay-cash', async () => { click(doc.getElementById('pay-cash'), '#pay-cash'); });
  await settleForm('form.pay-cash');
  await step('form.tender', async () => { click([...doc.querySelectorAll('[data-act="tender"]')].find((b) => Number(b.getAttribute('data-amt')) * 100 === intent.tenderCents), `tender chip ${intent.tenderCents}`); });
  await settleForm('form.payStep');
  snaps['form.payStep'] = OBSERVABLES['form.payStep'].capture({ doc });

  CTX.now = 'S1/x_pizza/new'; HITS.setContext(CTX.now);
  const invBefore = S.state.invs.length;
  await step('form.pay', async () => { click(doc.getElementById('btn-pay'), '#btn-pay'); });
  await settled(form, fhost, HORIZON.formConfirmation, 'form.pay');
  await S.drain('orders');
  await settled(form, fhost, HORIZON.formConfirmation, 'form.confirmation');
  const create = R.log.find((x) => x.fn === 'createOrder');
  assert.ok(create && create.status === 200, FAIL('createOrder', create ? `status ${create.status} ${String(JSON.stringify(create.res)).slice(0, 200)}` : `never answered — routed ${JSON.stringify(R.log.map((x) => `${x.fn}:${x.status}`))}; active stage ${(doc.querySelector('.stage.active') || {}).id}; visible errors ${JSON.stringify([...doc.querySelectorAll('.error-box, [id^="err"]')].map((e) => text(e)).filter(Boolean)).slice(0, 400)}`));
  const oid = create.res.order_id;
  const persisted = (await rtdb.ref(`orders/${oid}`).get()).val();
  snaps['form.confirmation'] = OBSERVABLES['form.confirmation'].capture({ doc });
  snaps['wa.orderReceived'] = OBSERVABLES['wa.orderReceived'].capture({ sends: SENT, phone: persisted.customer_phone });
  ok(`S1 through the REAL form UI: ${steps.length} steps → createOrder 200 (${oid}, #${persisted.display_number}, ${persisted.total_cents} centavos, status ${persisted.status}); the confirmation is shown; ${SENT.length} WhatsApp send(s) captured at the transport`);

  // WHICH path sent the order-received (memory: assert which path answered): the ONE send's stack passes through the
  // terminal region's call site (createOrder's sendMessage, line from contract/regions.json), not the status trigger's
  const regionsDoc = JSON.parse(fsx.readFileSync(new URL('./regions.json', import.meta.url), 'utf8'));
  const termWa = regionsDoc.regions.find((r) => r.region === 'xpizza-functions/whatsapp.js#sendMessage@xpizza-functions/index.js#createOrderApp.all>anon');
  const trigWa = regionsDoc.regions.find((r) => r.region === 'xpizza-functions/whatsapp.js#sendMessage@xpizza-functions/index.js#sendOrderStatusNotifications');
  assert.ok(SENT.length === 1 && SENT[0].origin.includes(`index.js:${termWa.line}:`) && !SENT[0].origin.includes(`index.js:${trigWa.line}:`), FAIL('wa', `the order-received was not sent (exactly once) from createOrder's call site index.js:${termWa.line} (sends ${SENT.length}; origin ${SENT[0] && SENT[0].origin.split('\n').filter((l) => /index\.js/.test(l)).slice(0, 3).join(' | ')})`));
  ok(`the ONE order-received send came from createOrder's call site (index.js:${termWa.line}), not the status trigger's (index.js:${trigWa.line})`);

  // per-step invocation multiset (observed, then declared) and hygiene
  const invs = S.state.invs.slice(invBefore).map((i) => i.name).sort();
  const ms = invs.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {});
  assert.deepStrictEqual(ms, EXPECTED_INVOCATIONS['form.pay'], FAIL('invocations', `the pay tap's trigger multiset changed:\n  observed ${JSON.stringify(ms)}\n  declared ${JSON.stringify(EXPECTED_INVOCATIONS['form.pay'])}`));
  S.assertClean(EXPECTED_INVOCATIONS.parked);
  ok(`the pay tap's invocation multiset equals the declared one (${invs.length} invocations: ${Object.entries(ms).map(([k, v]) => `${k}×${v}`).join(', ')}); no invocation error, parked = declared`);

  // per-call served version: every PRICING call served exactly {ACTIVE} live; the others are the declared non-pricing calls
  const pricing = calls.filter((c) => c.served.length);
  for (const c of pricing) assert.deepStrictEqual([...new Set(c.served.map((x) => `${x.versionId}/${x.source}`))], [`${ACTIVE}/live`], FAIL('version', `${c.fn} served ${JSON.stringify(c.served)} (expected {${ACTIVE}/live})`));
  const nonPricing = [...new Set(calls.filter((c) => !c.served.length).map((c) => c.fn))].sort();
  assert.deepStrictEqual(nonPricing, EXPECTED_INVOCATIONS.nonPricingCalls, FAIL('version', `non-pricing calls ${JSON.stringify(nonPricing)} ≠ declared ${JSON.stringify(EXPECTED_INVOCATIONS.nonPricingCalls)}`));
  assert.ok(pricing.some((c) => c.fn === 'createOrder'), FAIL('version', 'createOrder recorded no served version'));
  assert.deepStrictEqual(WITNESS.unattributed(), [], FAIL('version', `pricing outside any writer context: ${JSON.stringify(WITNESS.unattributed()).slice(0, 300)}`));
  ok(`per-call version: ${pricing.length} pricing call(s) (${[...new Set(pricing.map((c) => c.fn))].join(', ')}) each served exactly {${ACTIVE}/live}; non-pricing calls = declared (${nonPricing.join(', ')}); nothing unattributed`);

  // ── the REAL KDS (private projection), booted as staff on the same emulator ──
  // codex r1: the kitchen-action evidence is a REAL recorder — every user-action event on the KDS page is recorded; one
  // whose target is inside a ticket is a kitchen action
  const kdsHttp = []; const kdsEvents = [];
  const khost = createFirebaseHost({ pageId: 'p1a-kds', user: { uid: STAFF, email: 'staff@r3.test' }, fixture: S.fixture });
  const kds = await step('kds.boot-staff', () => phase('boot', () => bootPage('xpizza-kitchen', { host: khost, url: 'https://xpizzakitchen.netlify.app/', tracer: HITS, fetchImpl: async (u) => { kdsHttp.push(String(u)); throw new Error(`r3-p1a: KDS fetch ${u} not routed (LP new issues none)`); },
    beforeScripts: (kw) => { installGoogleMaps(kw); for (const t of ['click', 'pointerdown', 'pointerup', 'mousedown', 'touchstart', 'keydown', 'change', 'input']) kw.document.addEventListener(t, (e) => { const el = e.target && e.target.nodeType === 1 ? e.target : null; kdsEvents.push({ type: t, inTicket: !!(el && el.closest('.tk')), target: el ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}` : '?' }); }, true); } })));
  const kdsActions = () => kdsEvents.filter((e) => e.inTicket).map((e) => `${e.type}:${e.target}`);
  for (let i = 0; i < 60 && !khost.subs.length; i++) await new Promise((r) => setTimeout(r, 25));
  await khost.barrier();
  await settled(kds, khost, HORIZON.kds, 'kds.ticket');
  // §5b clocks (codex r2 P2): the ticket's elapsed timer is checked against REAL time — the writer's created_at to now
  // (the KDS runs on the real clock) — not merely blanked as a periodic part
  const clockCheck = (label) => {
    const el = kds.doc.getElementById(`elapsed-${oid}`); const m = el && /^(\d+):(\d{2})$/.exec(el.textContent.trim());
    const shown = m ? Number(m[1]) * 60 + Number(m[2]) : NaN; const real = Math.floor((Date.now() - persisted.created_at) / 1000);
    assert.ok(Number.isFinite(shown) && shown <= real + 1 && shown >= real - 2, FAIL('clock', `${label}: the ticket timer shows ${el && el.textContent} (${shown} s) but ${real} s have elapsed since created_at (real clock)`));
    return `${el.textContent} ≈ ${real} s`;
  };
  const ticket1 = OBSERVABLES['kds.ticket'].capture({ doc: kds.doc, orderId: oid });
  const clk1 = clockCheck('ticket');
  // §5b stability for the ticket: one more horizon; the ticket is byte-identical (no undeclared effect)
  await settled(kds, khost, HORIZON.kds, 'kds.ticket-stability');
  const ticket2 = OBSERVABLES['kds.ticket'].capture({ doc: kds.doc, orderId: oid });
  const clk2 = clockCheck('ticket-stability');
  // negative (codex r2 P2): a ticket timer frozen at a constant (99:59) is RED on the live page
  { const el = kds.doc.getElementById(`elapsed-${oid}`); const was = el.textContent; el.textContent = '99:59'; assert.throws(() => clockCheck('negative'), /the ticket timer shows 99:59/, FAIL('negative', 'a frozen 99:59 ticket timer passed the real-time clock check')); el.textContent = was; }
  // the only parts a declared PERIODIC may change (contract/timer-bounds.json periodic.mayChangeSelectors — e.g. the 1 s
  // elapsed timer text) are blanked; anything else that moved is an undeclared effect
  const KDS_PERIODIC_SELS = TB.periodic.filter((x) => x.key.startsWith('xpizza-kitchen/')).flatMap((x) => x.mayChangeSelectors || []);
  const steady = (html) => { const t = kds.doc.createElement('template'); t.innerHTML = html; for (const sel of KDS_PERIODIC_SELS) for (const e of t.content.querySelectorAll(sel)) e.textContent = ''; return t.innerHTML; };
  assert.strictEqual(steady(ticket2.html), steady(ticket1.html), FAIL('stability', `the KDS ticket changed after a further settle() horizon beyond its declared periodic parts (${KDS_PERIODIC_SELS.join(', ')})`));
  await step('kds.open-programados', async () => { kds.doc.getElementById('btn-scheduled').dispatchEvent(new kds.win.MouseEvent('click', { bubbles: true, cancelable: true })); });
  await settled(kds, khost, HORIZON.kds, 'kds.programados');
  snaps['kds.ticket'] = { ...ticket1, ...OBSERVABLES['kds.ticket'].captureScheduled({ doc: kds.doc }) };
  const kdsTickets = ticket1.boardIds.length;
  assert.deepStrictEqual(steps, S1.steps, FAIL('steps', `executed ${JSON.stringify(steps)} ≠ the scenario definition ${JSON.stringify(S1.steps)}`));
  ok(`the executed steps equal the S1 definition (${steps.length}); every observation settled clean (${observations}); the KDS issued ${kdsHttp.length} HTTP request(s); recorded KDS events ${kdsEvents.length} (${[...new Set(kdsEvents.map((e) => e.target))].join(', ')}), kitchen actions ${kdsActions().length}; the ticket timer agrees with real time (${clk1}; after a further horizon ${clk2})`);

  // ── GATE A over the enforced slice ──
  const t0 = Date.now();
  const facts = factsOf({ intent, response: create.res, persisted, restaurant });
  const ga = gateA({ scenarios: SLICE.scenarios, brands: SLICE.brands, lps: SLICE.lps });
  const cells = ga.cells.filter((c) => SLICE.readers.includes(c.R));
  const registry = JSON.parse(fsx.readFileSync(new URL('./outputs/registry.json', import.meta.url), 'utf8'));
  const applicability = AP.load();
  const evidence = { intent, persisted, steps, routed: R.log, kdsActions: kdsActions(), kdsHttp, kdsTickets };
  const ctx = { brandBoard: 'x_pizza', spec: JSON.parse(fsx.readFileSync(new URL('./matrix-spec.json', import.meta.url), 'utf8')).displayCells };
  const run = (sn, ev = evidence) => runGateA({ cells, registry, applicability, regionsDoc, scenariosDoc: SCEN, evidence: ev, snapshots: sn, facts, ctx, observables: OBSERVABLES });
  const res = run(snaps);
  PH.compare = Date.now() - t0;
  if (res.red.length) console.error(res.red.map(formatFailure).join('\n'));
  assert.strictEqual(res.red.length, 0, FAIL('gateA', `${res.red.length} RED cell(s) in the enforced slice`));
  ok(`GATE A (S1 / x_pizza / LP new on ${SLICE.readers.join(' ')}): ${res.counts.cells} cells over ${res.counts.regions} regions — ${JSON.stringify(res.counts.byOutcome)}; by kind ${JSON.stringify(res.counts.byKindOutcome)}; ${res.counts.comparisons} distinct comparisons ${JSON.stringify(res.counts.comparisonsByMode)}; pins ${JSON.stringify(res.counts.pinsUsed)}`);
  if (process.env.R3_P1A_REPORT) fsx.writeFileSync(process.env.R3_P1A_REPORT, JSON.stringify({ counts: res.counts, comparisons: res.comparisons, results: res.results, invocations: ms, calls, phases: PH }, null, 1));

  // §5b stability (codex r1 P1-3): one more horizon on BOTH pages after the assertion, the scheduler drained again; FRESH
  // captures of the confirmation, the KDS (Programados still open) and the WhatsApp transport recompare green, the
  // confirmation is byte-identical, and the send multiplicity is still exactly one (no undeclared effect)
  {
    await S.drain('orders');
    await settled(form, fhost, HORIZON.formConfirmation, 'stability.form');
    await settled(kds, khost, HORIZON.kds, 'stability.kds');
    const fresh = { ...snaps, 'form.confirmation': OBSERVABLES['form.confirmation'].capture({ doc }), 'kds.ticket': { ...ticket2, ...OBSERVABLES['kds.ticket'].captureScheduled({ doc: kds.doc }) }, 'wa.orderReceived': OBSERVABLES['wa.orderReceived'].capture({ sends: SENT, phone: persisted.customer_phone }) };
    assert.strictEqual(fresh['form.confirmation'].html, snaps['form.confirmation'].html, FAIL('stability', 'the confirmation changed after a further settle() horizon'));
    assert.strictEqual(SENT.length, 1, FAIL('stability', `the WhatsApp send multiplicity changed: ${SENT.length}`));
    const re = run(fresh, { ...evidence, kdsActions: kdsActions() });
    assert.strictEqual(re.red.length, 0, FAIL('stability', `recompare after settle(E): ${re.red.map(formatFailure).join(' | ')}`));
    ok(`stability: after a further horizon on both pages (scheduler drained), fresh confirmation / KDS / WhatsApp captures recompare green; confirmation byte-identical, the KDS ticket unchanged, exactly one send`);
  }
  kds.close(); await khost.close();

  // negatives on THIS run's snapshots
  {
    const neg = run({ ...snaps, 'form.reviewSheet': { ...snaps['form.reviewSheet'], totalText: 'L 341' } });
    const redRegions = new Set(neg.red.map((x) => x.region));
    assert.ok(neg.red.some((x) => x.fact === 'MONEY' && x.observable === 'form.reviewSheet') && [...redRegions].every((r) => registry.regions[r].observable === 'form.reviewSheet') && neg.results.filter((x) => x.observable === 'form.cartPill').every((x) => x.outcome === 'pass'), FAIL('negative', `pill-correct / sheet-wrong was not RED on exactly the sheet (${JSON.stringify([...redRegions])})`));
    const neg2 = run(snaps, { ...evidence, kdsActions: ['click:div'] });
    assert.ok(neg2.red.length > 0 && neg2.red.every((x) => /UNMET/.test(x.detail) && /no-kitchen-action/.test(x.detail)), FAIL('negative', 'an unmet precondition (a kitchen tap) was not RED'));
    const neg3 = run({ ...snaps, 'wa.orderReceived': { sends: [], exposed: { ok: false, detail: 'no message' } } });
    assert.ok(neg3.red.some((x) => x.observable === 'wa.orderReceived'), FAIL('negative', 'a missing WhatsApp send was not RED'));
    // codex r1 P1-5: absences reject a WRONG value too
    const wa = snaps['wa.orderReceived'];
    const neg4 = run({ ...snaps, 'wa.orderReceived': { ...wa, sends: [{ ...wa.sends[0], body: `${wa.sends[0].body}\nOrden #999 · Dirección: Wrong address` }] } });
    assert.ok(['NUM', 'PLACE'].every((f) => neg4.red.some((x) => x.observable === 'wa.orderReceived' && x.fact === f)), FAIL('negative', `a WRONG order number / address in the message was not RED on NUM + PLACE (${JSON.stringify(neg4.red.map((x) => x.fact))})`));
    const tk = snaps['kds.ticket'];
    const neg5 = run({ ...snaps, 'kds.ticket': { ...tk, html: tk.html.replace('<div class="body">', '<div class="body"><div class="addr">Col. Wrong Place, casa 9</div>') } });
    assert.ok(neg5.red.some((x) => x.observable === 'kds.ticket' && x.fact === 'PLACE'), FAIL('negative', 'a WRONG address on the KDS ticket was not RED'));
    // codex r1 P1-9: the sheet captured on the LIVE page while closed
    const neg6 = run({ ...snaps, 'form.reviewSheet': negSnaps.closedSheet });
    assert.ok(neg6.red.length > 0 && neg6.red.every((x) => x.observable === 'form.reviewSheet' && /not EXPOSED/.test(x.detail)), FAIL('negative', 'the cart sheet captured while CLOSED was not RED'));
    ok(`negatives on this run's snapshots: pill right + sheet total wrong → RED on exactly the sheet (${neg.red.length}); a kitchen tap → every no-kitchen-action exclusion RED (${neg2.red.length}); no send → RED (${neg3.red.length}); a WRONG number / address in the message → NUM + PLACE RED; a WRONG address on the ticket → PLACE RED; the sheet captured CLOSED on the live page → RED (${neg6.red.length})`);
  }

  // ── GATE B: the site-hit ratchet ──
  const current = Object.fromEntries(Object.entries(HITS.hitsByContext()).map(([k, v]) => [k, [...v].sort()]));
  if (process.env.R3_RATCHET_WRITE === '1') { RAT.writeBaseline(current, 'S1 / x_pizza P1-a journey.'); console.log('  (gate B baseline rewritten — review the diff)'); }
  const { baseline, shrink } = RAT.load();
  const rt = RAT.ratchet({ baseline, shrink, current });
  assert.deepStrictEqual(rt.problems, [], FAIL('gateB', `ratchet: ${rt.problems.slice(0, 20).join(' | ')}`));
  ok(`GATE B ratchet: ${Object.entries(current).map(([k, v]) => `${k} ${v.length}`).join(', ')} sites reached ⊇ baseline (${Object.values(baseline.contexts).reduce((a, v) => a + v.length, 0)}); growth ${JSON.stringify(Object.fromEntries(Object.entries(rt.grown).map(([k, v]) => [k, v.length])))}; reviewed shrink ${(shrink.entries || []).length}; ${SRV.manifest.length} server units traced`);

  // the sampling statement RAN (codex r6): exactly one heartbeat for this order, from createOrder's reportIdentityShadow
  // call right after the reviewed justification (line from source), and its outcome agrees with gate B: status#23 (the
  // shadow `status` read) is hit iff the sample settled ('dropped' ⇒ no hit)
  {
    const idxLines = fsx.readFileSync(new URL('../index.js', import.meta.url), 'utf8').split('\n');
    const jLine = idxLines.findIndex((l) => l.includes(RAT.APPROVED_NONDETERMINISTIC[0].justification)) + 1;
    const cLine = idxLines.findIndex((l, i) => i >= jLine && /reportIdentityShadow\(db, \{/.test(l)) + 1;
    assert.ok(jLine > 0 && cLine > jLine, FAIL('shadow', `premise — the justification (line ${jLine}) and its reportIdentityShadow call (line ${cLine})`));
    const mine = SHADOW_BEATS.filter((b) => b.body && b.body.order_id === oid);
    assert.strictEqual(mine.length, 1, FAIL('shadow', `the identity-shadow sampling statement did not run exactly once for ${oid} (heartbeats ${mine.length}) — an early return / dead branch / move skipped it`));
    // codex r7: the frame that called reportIdentityShadow must be EXACTLY the reviewed call expression — the statement
    // right after the shadowResult declaration in createOrderApp.all's OWN body, located by AST in the code that RAN
    // (the tracer's line-preserving transform of index.js), line:column — and that frame is the handler itself
    // (anonymous: no nested / named helper in between). THREAT MODEL (advisor ruling): this guards accidental drift, not
    // a deliberately deceptive edit — out of scope.
    const idxPath = new URL('../index.js', import.meta.url).pathname;
    const ran = T.transform('xpizza-functions/index.js', fsx.readFileSync(idxPath, 'utf8'), { module: false }).code;
    const { walk: cwalk, parseUnit: cparse } = require('./census');
    let callPos = null;
    cwalk(cparse({ file: 'xpizza-functions/index.js', code: ran, module: false, lineOffset: 0 }), (node, fnName) => {
      if (callPos || !/Function/.test(node.type) || fnName !== 'createOrderApp.all' || !node.body || node.body.type !== 'BlockStatement') return;
      const body = node.body.body;
      const k = body.findIndex((st) => st.type === 'VariableDeclaration' && st.declarations.some((d) => d.id.type === 'Identifier' && d.id.name === 'shadowResult'));
      const nx = k >= 0 ? body[k + 1] : null;
      if (nx && nx.type === 'ExpressionStatement' && nx.expression.type === 'CallExpression' && nx.expression.callee.type === 'Identifier' && nx.expression.callee.name === 'reportIdentityShadow') callPos = { line: nx.expression.loc.start.line, col: nx.expression.loc.start.column + 1 };
    });
    assert.ok(callPos, FAIL('shadow', 'premise — the reviewed reportIdentityShadow call right after the shadowResult declaration in createOrderApp.all\'s own body (AST)'));
    const frames = mine[0].stack.split('\n').map((l) => l.trim());
    const fi = frames.findIndex((l) => /^at reportIdentityShadow \(.*catalog\/identity-shadow-validate\.js:\d+:\d+\)$/.test(l));
    const caller = fi >= 0 ? frames[fi + 1] : null;
    assert.strictEqual(caller, `at ${idxPath}:${callPos.line}:${callPos.col}`, FAIL('shadow', `the heartbeat's caller frame is not the reviewed call expression in the handler itself (expected "at ${idxPath}:${callPos.line}:${callPos.col}", got "${caller}")`));
    const hit23 = (current['S1/x_pizza/new'] || []).includes(RAT.APPROVED_NONDETERMINISTIC[0].site);
    const outcome = mine[0].body.outcome;
    assert.ok(outcome === 'dropped' ? !hit23 : hit23, FAIL('shadow', `the sample outcome "${outcome}" disagrees with gate B (status#23 hit: ${hit23})`));
    ok(`the race justification RAN: exactly one identity-shadow heartbeat for ${oid} from the reviewed call expression index.js:${callPos.line}:${callPos.col} in the handler itself (outcome "${outcome}"), consistent with gate B (status#23 ${hit23 ? 'hit' : 'not hit'})`);
  }

  // EGRESS: this process runs under the process-level guard (preloaded by emulator-run) and nothing was refused
  assert.ok(global.__R3_EGRESS_GUARD === true && process.env.R3_EGRESS_MODE !== 'record', FAIL('net', 'the process-level egress guard is not installed in refuse mode'));
  assert.deepStrictEqual(global.__R3_EGRESS_REFUSED, [], FAIL('net', `egress attempted: ${JSON.stringify(global.__R3_EGRESS_REFUSED)}`));
  ok('egress: the process-level guard is installed (refuse mode) and no non-loopback connection was attempted; the UltraMsg transport is the in-process capture');
  console.log(`P1A-PHASES ${JSON.stringify(PH)}`);
  form.close(); await fhost.close();
  console.log(`\nr3-p1a-journey: OK (${n})`);
  process.exit(0);
} catch (e) { console.error('r3-p1a-journey FAILED:', e && e.stack || e); process.exit(1); }
