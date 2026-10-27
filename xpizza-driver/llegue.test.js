// llegue.test.js — the arrived-at-customer delivery screen (prototype S.llegue), rendered by the PURE stacked-view
// builders stopHeaderHtml + activeCardHtml. Proves the flag-ON / flag-OFF split (no dead/false controls):
//   • header: «Estás donde {Nombre}» always (true by geofence); sub = «avisamos a las {t}…» only flag-ON + a notify
//     time, else the truthful «{area}» / «antes de {deadline}»;
//   • arrival banner «{name} ya sabe que llegaste» + the «Has llegado» note suppression: flag-ON only;
//   • the «entregá todo» items card: shown once arrived (display-only, existing order data);
//   • the body «Problema con este pedido»: flag-ON (canReportProblem) only;
//   • NOT arrived / pickup: none of the above (byte-stable).
// Run: `node llegue.test.js`
import assert from 'node:assert/strict';
import { stopHeaderHtml, activeCardHtml, problemaSheetHtml, problemaReasonLabel } from './stacked-view.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const __dir = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(join(__dir, 'index.html'), 'utf8');   // for the compose carves + the ARRIVAL-ACTION listener
const { JSDOM } = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'))('jsdom');

const ICONS = new Proxy({}, { get: (_, k) => `<svg data-ic="${String(k)}"></svg>` });
const deps = { ICONS, esc: (s) => String(s == null ? '' : s), scheduledBadge: () => '', RESTAURANT: { lat: 15.5, lng: -88.03 }, navPref: 'Waze' };

const order = {
  customer_name: 'Daniela Reyes', total: 385, payment_method: 'cash',
  address_detected: 'Col. Trejo, 12 calle, casa 1215', address_details: 'Portón negro',
  customer_phone: '+504 9999 0000',
  summary_lines: [{ name: 'Pizza grande', qty: 1, cents: 28000 }, { name: 'Coca-Cola', qty: 1, cents: 4500 }, { name: 'Salsa', qty: 2, cents: 2000 }],
};
const deliveryEntry = { orderId: 'o1', phase: 'delivery', order, deliveryTask: { id: 'd1', destination_address: order.address_detected, recipient_name: 'Daniela' }, pickupTask: { id: 'p1', destination_lat: 15.5, destination_lng: -88.03 } };
// the SOLO arrived-at-customer card passes the explicit soloArrival discriminator (Codex P2-4)
const card = (opts) => activeCardHtml(deliveryEntry, deps, { ordinal: 1, solo: true, showActualPill: true, navLabel: '', previewHtml: '', soloArrival: true, ...opts });
// the driver has written tasks/{id}/arrived (dep C) AND the caller acknowledged it (Codex r2 P2-6: arrivalAck true =
// its own update() resolved AND arrived.by === this uid) → the banner / «avisamos a las {t}» are allowed.
const notifiedEntry = { ...deliveryEntry, deliveryTask: { ...deliveryEntry.deliveryTask, arrived: { at: 1799999000000, by: 'drv' } } };
const cardN = (opts) => activeCardHtml(notifiedEntry, deps, { ordinal: 1, solo: true, showActualPill: true, navLabel: '', previewHtml: '', soloArrival: true, arrivalAck: true, ...opts });
// a STACKED / promoted-survivor delivery card: NO soloArrival → must stay byte-identical (the arrival restyle never applies)
const stackedCard = (opts) => activeCardHtml(deliveryEntry, deps, { ordinal: 2, solo: false, showActualPill: true, navLabel: '', previewHtml: '<div class="after-card"></div>', ...opts });

let passed = 0;
const t = (name, fn) => { try { fn(); passed += 1; } catch (e) { console.error(`✗ ${name}`); throw e; } };

// ---- header ----
t('header: «Estás donde {Nombre}» (first name) for the arrived delivery', () => {
  const h = stopHeaderHtml({ arrivedCustomer: true, name: 'Daniela Reyes', area: 'Col. Trejo' }, deps);
  assert.match(h, /Estás donde Daniela<\/div>|Estás donde Daniela</, 'title «Estás donde Daniela» (first name only)');
  assert.doesNotMatch(h, /Reyes/, 'no last name');
});
t('header flag-OFF (truthful): sub = «{area}», NO «avisamos a las»', () => {
  const h = stopHeaderHtml({ arrivedCustomer: true, name: 'Daniela', area: 'Col. Trejo', canNotifyArrival: false, notifiedAt: '' }, deps);
  assert.match(h, /sh-sub">Col\. Trejo</, 'sub is the area');
  assert.doesNotMatch(h, /avisamos a las/, 'NO arrival-notification claim while the flag is off');
});
t('header flag-OFF with a deadline, no area → sub = «antes de {deadline}»', () => {
  const h = stopHeaderHtml({ arrivedCustomer: true, name: 'Daniela', area: '', deadline: '7:48', canNotifyArrival: false }, deps);
  assert.match(h, /sh-sub">antes de 7:48</, 'deadline-only truthful sub');
});
t('header flag-ON + notify time: sub = «avisamos a las {t} · antes de {deadline}»', () => {
  const h = stopHeaderHtml({ arrivedCustomer: true, name: 'Daniela', area: 'Col. Trejo', deadline: '7:48', canNotifyArrival: true, notifiedAt: '7:41' }, deps);
  assert.match(h, /avisamos a las 7:41 · antes de 7:48/, 'flag-on notification sub');
});
t('header: NON-arrived keeps the «Parada N de M» / «{name}·{area}» header (unchanged)', () => {
  const h = stopHeaderHtml({ ordinal: 1, total: 2, name: 'Daniela', area: 'Col. Trejo' }, deps);
  assert.match(h, /Parada 1 de 2/);
  assert.doesNotMatch(h, /Estás donde/);
});

// ---- card: items ----
t('arrived delivery: the «entregá todo» items card shows the order lines', () => {
  const html = card({ arrived: true });
  assert.ok(/sv-deliver-items/.test(html), 'items card present');
  assert.match(html, /4 artículos/, 'total article count (1+1+2)');
  assert.match(html, /entregá todo/, 'the «entregá todo» chip');
  assert.ok(/Pizza grande/.test(html) && /Coca-Cola/.test(html) && /Salsa/.test(html), 'the item lines');
});
t('NOT arrived (en route): NO items card, NO banner — the nav button shows (byte-stable)', () => {
  const html = card({ arrived: false, navLabel: 'Col. Trejo' });
  assert.ok(!/sv-deliver-items/.test(html), 'no items card before arrival');
  assert.ok(!/arrival-banner/.test(html), 'no arrival banner');
  assert.ok(/nav-primary|nav-btn/.test(html), 'the nav button is shown');
});
t('street line: HIDDEN in the arrived-at-customer card (proto S.llegue), KEPT en-route (approved card)', () => {
  assert.ok(!/address-block/.test(card({ arrived: true })), 'street address-block hidden once arrived at the customer');
  assert.ok(/address-block/.test(card({ arrived: false })), 'street kept en-route (unchanged approved card)');
  // the one-line instruction (address_details) stays as the bold ref; «Entregar en mano» has no data source → omitted
  assert.match(card({ arrived: true }), /Portón negro/, 'the instruction (address_details) is kept');
});

// ---- card: flag-gated ----
t('flag-OFF arrived: NO arrival banner, NO body problema; the «Has llegado» note is kept', () => {
  const html = card({ arrived: true, canNotifyArrival: false });
  assert.ok(!/arrival-banner/.test(html), 'no arrival banner (flag off)');
  assert.ok(!/problema-btn/.test(html), 'no body problema (flag off)');
  assert.match(html, /Has llegado donde el cliente/, 'the «Has llegado» note is kept (truthful flag-off)');
});
t('flag-ON canNotifyArrival + the driver has notified (task.arrived): the banner shows, «Has llegado» suppressed', () => {
  const html = cardN({ arrived: true, canNotifyArrival: true });
  assert.match(html, /arrival-banner/, 'arrival banner shown after the arrived write');
  assert.match(html, /Daniela ya sabe que llegaste/, 'banner copy with the first name');
  assert.ok(!/Has llegado donde el cliente/.test(html), 'the redundant «Has llegado» note is dropped');
});
t('flag-ON canNotifyArrival but NOT yet notified (no task.arrived): NO banner, «Llegué» STILL available (write-failure / pre-tap)', () => {
  const html = card({ arrived: true, canNotifyArrival: true });   // arrived geofence, but tasks/{id}/arrived not written
  assert.ok(!/arrival-banner/.test(html), 'no banner without the confirmed write (never a false claim — Codex P2-6)');
  assert.match(html, /btn-llegue/, '«Llegué» stays available until the write lands');
});
t('flag-ON canReportProblem: the body «Problema con este pedido» shows', () => {
  const html = card({ arrived: true, canReportProblem: true });
  assert.match(html, /problema-btn/, 'body problema button shown');
  assert.match(html, /Problema con este pedido/, 'problema copy');
});
t('«Llegué» gated on canNotifyArrival + NOT-notified; hidden once notified (task.arrived) + carries the delivery-task id', () => {
  assert.match(card({ arrived: false, canNotifyArrival: true }), /btn-llegue/, 'Llegué shown flag-on, not yet notified');
  assert.ok(!/btn-llegue/.test(card({ arrived: false, canNotifyArrival: false })), 'Llegué hidden flag-off');
  assert.ok(!/btn-llegue/.test(cardN({ arrived: true, canNotifyArrival: true })), 'Llegué hidden once the arrival is written (notified)');
  assert.match(card({ arrived: false, canNotifyArrival: true }), /data-task-id="d1"/, 'carries the delivery-task id for the write');
});

t('solo arrived: the ac-chiprow (bag-tag/brand/#) is HIDDEN (proto single-delivery card) + the .ac-arrived scope class is set', () => {
  const html = card({ arrived: true });
  assert.ok(!/ac-chiprow/.test(html), 'no chiprow on the solo arrived card');
  assert.match(html, /active-card ac-arrived/, 'the .ac-arrived scope class is present');
  assert.ok(/ac-chiprow/.test(card({ arrived: false })), 'en-route keeps the chiprow (unchanged)');
});
t('slide copy: solo arrived cash → «Entregado · cobré L {amt}» (no name); online-paid → «Entregado»', () => {
  assert.match(card({ arrived: true }), /Entregado · cobré L 385/, 'cash copy «cobré L 385»');
  assert.ok(!/Entregado · Daniela/.test(card({ arrived: true })), 'no name on the arrived slide');
  const paid = activeCardHtml({ ...deliveryEntry, order: { ...order, payment_method: 'card_online' } }, deps, { ordinal: 1, solo: true, arrived: true, soloArrival: true, previewHtml: '' });
  assert.match(paid, /Entregado</, 'online-paid arrived slide = plain «Entregado»');
  assert.ok(!/cobré/.test(paid), 'no «cobré» for a paid order');
});
t('slide copy: en-route / stacked keep the named slide «Entregado · {name} · L {amt}» (untouched)', () => {
  assert.match(card({ arrived: false }), /Entregado · Daniela · L 385/, 'en-route keeps the named slide');
  assert.match(stackedCard({ arrived: true }), /Entregado · Daniela · L 385/, 'a stacked arrived card keeps the named slide');
});
t('P2-4: a STACKED/promoted arrived delivery stays byte-identical — chiprow + street kept, NO .ac-arrived / items / banner / cobré slide', () => {
  const html = stackedCard({ arrived: true, canNotifyArrival: true, canReportProblem: true });
  assert.ok(/ac-chiprow/.test(html), 'chiprow kept on the stacked card');
  assert.ok(/address-block/.test(html), 'street kept on the stacked card');
  assert.ok(!/ac-arrived/.test(html), 'no .ac-arrived on the stacked card');
  assert.ok(!/sv-deliver-items/.test(html), 'no items card on the stacked card');
  assert.ok(!/arrival-banner/.test(html) && !/problema-btn/.test(html), 'no arrival banner / body problema on the stacked card');
  assert.ok(!/cobré/.test(html), 'stacked keeps the named slide, not «cobré»');
});

t('P2-8: the LLEGUE-MAP carve SUPPRESSES the map when arrived+FRESH, keeps it when stale/en-route (kills the map-restored mutant)', () => {
  const m = INDEX.match(/SLICE3DEPS:LLEGUE-MAP:START[\s\S]*?===== \*\/\n([\s\S]*?)\n\s*\/\* ===== SLICE3DEPS:LLEGUE-MAP:END/);
  assert.ok(m, 'LLEGUE-MAP carve found');
  const cond = m[1].match(/const soloMapHtml = (\(.*\))\s*$/m)[1];   // the show-map condition expression
  const show = (spArrived, spIsPickup, stale, phase, spStacked = false) => new Function('spArrived', 'spIsPickup', 'driverState', 'soloOrder', 'isStaleFix', 'spStacked',
    'return ' + cond + ';')(spArrived, spIsPickup, { last_location_ts: 0 }, { phase }, () => stale, spStacked);
  assert.equal(show(true, false, false, 'delivery'), false, 'arrived + FRESH delivery → map suppressed (prototype S.llegue)');
  assert.equal(show(true, false, true, 'delivery'), true, 'STALE GPS → map kept (en-route), one freshness predicate (P2-5)');
  assert.equal(show(false, false, false, 'delivery'), true, 'not arrived → map kept');
  assert.equal(show(true, true, false, 'pickup'), true, 'pickup → map kept (arrival restyle is delivery-only)');
  // Codex r2 P2-4: a PROMOTED arrived survivor (spStacked) keeps its map — the map uses the SAME !spStacked
  // solo-arrival discriminator as the card, so promoting doesn't strip the map out from under a stacked delivery.
  assert.equal(show(true, false, false, 'delivery', true), true, 'promoted arrived survivor (spStacked) → map KEPT');
});

t('P2-6: «Llegué» writes tasks/{id}/arrived; SUCCESS disables the button; FAILURE re-enables it + toasts (no false claim)', async () => {
  const region = INDEX.match(/SLICE3:ARRIVAL-ACTION:START[\s\S]*?===== \*\/\n([\s\S]*?)\n\s*\/\* ===== SLICE3:ARRIVAL-ACTION:END/)[1];
  const dom = new JSDOM('<!doctype html><body><div id="screen-onshift"><button class="llegue-btn" id="btn-llegue" data-task-id="d1">Llegué</button></div></body>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);
  let wrote = null, failNext = false, toasts = 0, rerenders = 0;
  const fbUpdate = (ref, val) => { if (failNext) return Promise.reject(new Error('offline')); wrote = { ref, val }; return Promise.resolve(); };
  const fbRef = (db, path) => ({ path });
  const drv2ArrivedAck = new Set();   // Codex r2 P2-6: the ack set the resolve path must populate
  const api = { $, fbUpdate, fbRef, fbServerTimestamp: () => 'TS', XPD: { getDb: () => ({}) }, currentUser: { uid: 'drv' }, toast: () => { toasts++; },
    DRV2_CAN_NOTIFY_ARRIVAL: true, DRV2_CAN_REPORT_PROBLEM: false, drv2ArrivedAck, renderActiveAndQueue: () => { rerenders++; }, openProblemaSheet: () => {} };
  new Function(...Object.keys(api), region)(...Object.values(api));   // register the REAL listener (flag-gated, flag true)
  const btn = $('btn-llegue');
  // success
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(btn.disabled, 'button disabled in flight (no double-submit)');
  await Promise.resolve(); await Promise.resolve();
  assert.match(wrote.ref.path, /^tasks\/d1$/, 'wrote tasks/{deliveryTaskId}/arrived');
  assert.deepEqual(wrote.val, { arrived: { at: 'TS', by: 'drv' } }, 'arrived = {at: serverTimestamp, by: uid} (dep C)');
  // Codex r2 P2-6: the ACK is recorded ONLY on the resolved write (local optimism alone never claims), then a re-render
  assert.ok(drv2ArrivedAck.has('d1'), 'the task id is acked only after update() RESOLVED (the claim gate)');
  assert.ok(rerenders >= 1, 're-render after the ack so the banner/«avisamos a las {t}» can appear');
  // failure: the write rejects → button re-enabled + a toast, and NOTHING claims the notification
  const btn2 = document.createElement('button'); btn2.id = 'btn-llegue'; btn2.className = 'llegue-btn'; btn2.dataset.taskId = 'd9';
  $('screen-onshift').innerHTML = ''; $('screen-onshift').appendChild(btn2);
  failNext = true;
  btn2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await Promise.resolve(); await Promise.resolve();
  assert.ok(!btn2.disabled, 'write failed → button re-enabled so the driver can retry');
  assert.equal(toasts, 1, 'a toast on failure, never a «ya sabe» claim');
  assert.ok(!drv2ArrivedAck.has('d9'), 'a FAILED (or pending/offline) write never acks → no claim, «Llegué» stays');
});

t('P2-7 threading: the solo-pickup, stacked-delivery and combined-pickup header carves each thread an order id into stopHeaderHtml (no empty data-order-id)', () => {
  const carve = (name) => { const m = INDEX.match(new RegExp('SLICE3DEPS:' + name + ':START[\\s\\S]*?===== \\*/\\n([\\s\\S]*?)\\n\\s*/\\* ===== SLICE3DEPS:' + name + ':END')); assert.ok(m, name + ' carve found'); return m[1]; };
  assert.match(carve('SOLO-PICKUP-HEADER'), /orderId: soloOrder\.orderId/, 'solo-pickup header threads soloOrder.orderId (a mutant dropping it → empty id → no button → RED with the builder guard)');
  assert.match(carve('STACKED-DELIV-HEADER'), /orderId: activeAccepted2 \? active\.orderId : ''/, 'stacked-delivery header threads active.orderId, empty for an unaccepted offer');
  assert.match(carve('COMBINED-PICKUP-HEADER'), /orderId: \(stacked2\[0\] && stacked2\[0\]\.orderId\) \|\| ''/, 'combined-pickup header threads the first bag order id');
});
t('flags-false (Codex r2): with BOTH capability flags OFF, the ARRIVAL-ACTION listener is NEVER registered (no dead handler)', () => {
  const region = INDEX.match(/SLICE3:ARRIVAL-ACTION:START[\s\S]*?===== \*\/\n([\s\S]*?)\n\s*\/\* ===== SLICE3:ARRIVAL-ACTION:END/)[1];
  const dom = new JSDOM('<!doctype html><body><div id="screen-onshift"><button class="llegue-btn" id="btn-llegue" data-task-id="d1">Llegué</button><button id="btn-problema-body" data-order-id="o1">?</button></div></body>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);
  let wrote = false, opened = 0;
  const api = { $, fbUpdate: () => { wrote = true; return Promise.resolve(); }, fbRef: () => ({}), fbServerTimestamp: () => 'TS', XPD: { getDb: () => ({}) }, currentUser: { uid: 'drv' }, toast: () => {},
    DRV2_CAN_NOTIFY_ARRIVAL: false, DRV2_CAN_REPORT_PROBLEM: false, drv2ArrivedAck: new Set(), renderActiveAndQueue: () => {}, openProblemaSheet: () => { opened++; } };
  new Function(...Object.keys(api), region)(...Object.values(api));   // run the REAL region source with both flags OFF
  $('btn-llegue').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  $('btn-problema-body').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(wrote, false, 'no arrival write — the listener was never bound while both flags are off (a mutant that registers unconditionally → write → RED)');
  assert.equal(opened, 0, 'no problema sheet opened either — no dead handler');
});
t('P2-7 builder: the S.problema sheet lists the 6 reasons by their CONTRACT keys; send disabled until a pick', () => {
  const html = problemaSheetHtml({ ICONS, esc: (s) => String(s == null ? '' : s) });
  ['waiting_restaurant', 'not_ready_incomplete', 'customer_no_answer', 'address_not_found', 'restaurant_closed', 'other']
    .forEach((k) => assert.ok(html.includes(`data-reason="${k}"`), `reason mapped by key ${k} (not the display string)`));
  assert.match(html, /id="btn-problema-send"[^>]*disabled/, 'send disabled until a reason is picked');
  assert.equal(problemaReasonLabel('customer_no_answer'), 'El cliente no contesta', 'key → display label (for the confirmation)');
});
t('P2-7/NEW-1/NEW-2: openProblemaSheet — dep-F write shape; the module in-flight guard survives a re-select; a stale ack never overwrites a newer sheet; FAILURE re-enables', async () => {
  const SCRIPT = INDEX.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  function liftFn(name) { let s = SCRIPT.indexOf('function ' + name + '('); let d = 0, seen = false; for (let i = s; i < SCRIPT.length; i++) { if (SCRIPT[i] === '{') { d++; seen = true; } else if (SCRIPT[i] === '}') { d--; if (seen && d === 0) return SCRIPT.slice(s, i + 1); } } }
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://driver.test/', pretendToBeVisual: true });
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s);
  // a CONTROLLABLE fbUpdate: each call records a deferred we resolve/reject on demand (so o1 can resolve AFTER o2 opens)
  let pids = [], updates = [], toasts = 0;
  const fbRef = (db, path) => ({ path });
  const fbPush = (r) => { const key = 'pid' + (pids.length + 1); pids.push(key); return { key }; };
  const fbUpdate = (r, val) => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); updates.push({ path: r.path, val, resolve: res, reject: rej }); return p; };
  const api = { $, ICONS, escapeHtml: esc, problemaSheetHtml, problemaEnviadoHtml: (l, t2) => `<div class="sheet done"><h4>Despacho ya lo sabe</h4><div>${esc(l)} · ${esc(t2)}</div></div>`, problemaReasonLabel, fbRef, fbPush, fbUpdate, fbServerTimestamp: () => 'TS', XPD: { getDb: () => ({}) }, currentUser: { uid: 'drv' }, toast: () => { toasts++; }, fmtClockHM: () => '7:44', document };
  // ONE instance, sharing the generation + in-flight module state via a wrapper closure (what index.html gives it).
  const openProblemaSheet = (new Function(...Object.keys(api), 'let drv2ProblemGen = 0, drv2ProblemInFlight = false;\n' + liftFn('openProblemaSheet') + '\nreturn openProblemaSheet;'))(...Object.values(api));
  const pick = (reason) => $('drv2-problema').querySelector(`[data-reason="${reason}"]`).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const tapSend = () => $('btn-problema-send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // --- write shape + in-flight ---
  openProblemaSheet('o1');
  assert.ok($('drv2-problema').classList.contains('open'), 'sheet opened');
  pick('customer_no_answer');
  assert.ok(!$('btn-problema-send').disabled, 'send enabled after a pick');
  tapSend();
  assert.ok($('btn-problema-send').disabled, 'send disabled in flight');
  assert.equal(updates.length, 1, 'one write started');
  assert.equal(updates[0].path, 'driver_problems/o1/pid1', 'driver_problems/{oid}/{fresh pid}');
  assert.deepEqual(updates[0].val, { reason: 'customer_no_answer', by: 'drv', at: 'TS' }, 'the CONTRACT key + by + at (dep F)');

  // --- NEW-1: re-selecting a reason while in flight must NOT re-enable Send; and even if the button is forced
  //     enabled by any path, the MODULE guard (not the button's disabled property) still blocks a second create ---
  pick('other');
  assert.ok($('btn-problema-send').disabled, 'NEW-1: re-selecting a reason does NOT re-enable Send while in flight');
  $('btn-problema-send').disabled = false;   // simulate ANY path re-enabling the button; the guard must be independent of it
  tapSend();
  assert.equal(updates.length, 1, 'NEW-1: the MODULE in-flight guard (not sendBtn.disabled) blocks a second create → no duplicate dispatcher alert');
  updates[0].resolve();
  await Promise.resolve(); await Promise.resolve();
  assert.match($('drv2-problema').innerHTML, /Despacho ya lo sabe/, 'o1 confirmation shows on its own resolve');

  // --- NEW-2: o1b send in flight, reopen for o2, THEN resolve o1b → o2's sheet must NOT become o1b's confirmation ---
  openProblemaSheet('o1b');
  pick('restaurant_closed');
  tapSend();
  assert.equal(updates.length, 2, 'o1b write started');
  openProblemaSheet('o2');   // reopen for another order → fresh picker + a new generation invalidates o1b's callback
  assert.ok(!/Despacho ya lo sabe/.test($('drv2-problema').innerHTML), 'o2 shows a fresh picker, not a confirmation');
  updates[1].resolve();      // o1b's STALE ack resolves after o2 opened
  await Promise.resolve(); await Promise.resolve();
  assert.ok(!/Despacho ya lo sabe/.test($('drv2-problema').innerHTML), 'NEW-2: the stale o1b ack does NOT overwrite the o2 sheet');

  // --- FAILURE: a fresh o2 send that rejects → Send re-enabled + a toast ---
  pick('address_not_found');
  tapSend();
  assert.equal(updates.length, 3, 'o2 write started');
  const before = toasts;
  updates[2].reject(new Error('x'));
  await Promise.resolve(); await Promise.resolve();
  assert.ok(!$('btn-problema-send').disabled, 'write failed → Send re-enabled for retry');
  assert.ok(toasts > before, 'a toast on failure');
});

console.log(`✓ llegue: ${passed} tests passed`);
