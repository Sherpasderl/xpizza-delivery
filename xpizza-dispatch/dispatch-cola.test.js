// xpizza-dispatch/dispatch-cola.test.js
//
// Slice B — "Cola de acción": ONE needs-action queue + ONE count (design:
// docs/superpowers/specs/2026-09-20-dispatch-B-one-queue-one-count-design.md).
//
// Two kinds of guard:
//   (1) EXECUTABLE — buildActionQueue (pure, extracted from index.html) proves the UNION / dedup / exclusive
//       partition / urgency ordering / count-consistency without the live board.
//   (2) STRUCTURAL/NO-REGRESSION — getPendingOrders byte-identical to the approved base; the Cola card escapes
//       customer fields; action buttons stopPropagation; the ONE count is mirrored (Cola meta + segments +
//       topbar KPI); Recoger(pickup) + Programados(scheduled) STAY visible in En Fila (badge zeroed); the
//       Torre retires the order-action alert types.
import assert from 'node:assert';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'index.html');
const BASE = '792631999ff2'; // approved base (origin/main tip this slice stack was cut from)
const html = fs.readFileSync(FILE, 'utf8');
let baseHtml = null;
try { baseHtml = execSync(`git show ${BASE}:xpizza-dispatch/index.html`, { cwd: __dirname, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
catch (e) { console.error('  ! could not load base blob for byte-identity guards:', e.message); process.exit(1); }

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// Isolate the Cola render block so structural asserts don't match stray text.
const colaStart = html.indexOf('function buildActionQueue(');
const colaEnd = html.indexOf('function initColaSegments(');
assert.ok(colaStart > -1 && colaEnd > colaStart, 'located buildActionQueue…initColaSegments region');
const colaJs = html.slice(colaStart, html.indexOf('\n}', colaEnd) + 2);

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTABLE — buildActionQueue: union, dedup, exclusive partition, urgency order, count consistency.
// ─────────────────────────────────────────────────────────────────────────────
{
  const m = html.match(/function buildActionQueue\(unassigned, stalled, atrisk, bandOf\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'buildActionQueue source located');
  // eslint-disable-next-line no-new-func
  const build = new Function(`${m[0]}; return buildActionQueue;`)();

  // o1 unassigned(green) · o2 unassigned+atrisk(amber) · o3 stalled(red) · o4 atrisk(amber) · o5 stalled+atrisk(red)
  const o = (id, t) => ({ order_id: id, created_at: t });
  const o1 = o('o1', 10), o2 = o('o2', 20), o3 = o('o3', 30), o4 = o('o4', 40), o5 = o('o5', 50);
  const bands = { o1: 'green', o2: 'amber', o3: 'red', o4: 'amber', o5: 'red' };
  const unassigned = [o1, o2];
  const stalled = [o3, o5];
  const atrisk = [o2, o4, o5];
  const { entries, counts } = build(unassigned, stalled, atrisk, (x) => bands[x.order_id]);

  // UNION (no drop / no double): the queue's order set == the DISTINCT union of the three sources.
  const want = new Set([...unassigned, ...stalled, ...atrisk].map(x => x.order_id));   // {o1..o5}
  const got = entries.map(e => e.orderId);
  assert.strictEqual(new Set(got).size, got.length, 'no order appears twice (deduped)');
  assert.deepStrictEqual(new Set(got), want, 'queue order-set == union of unassigned ∪ stalled ∪ at-risk');
  assert.strictEqual(entries.length, 5, 'exactly the 5 distinct orders');

  // EXCLUSIVE PARTITION by priority unassigned > stalled > atrisk.
  const primaryOf = (id) => entries.find(e => e.orderId === id).primary;
  assert.strictEqual(primaryOf('o1'), 'unassigned');
  assert.strictEqual(primaryOf('o2'), 'unassigned', 'unassigned wins over at-risk for the same order');
  assert.strictEqual(primaryOf('o3'), 'stalled');
  assert.strictEqual(primaryOf('o4'), 'atrisk');
  assert.strictEqual(primaryOf('o5'), 'stalled', 'stalled wins over at-risk for the same order');

  // COUNT CONSISTENCY — segment sum partitions the total (Todos == Sin asignar + Detenidos + En riesgo == len).
  assert.strictEqual(counts.all, entries.length, 'counts.all == queue length');
  assert.strictEqual(counts.unassigned + counts.stalled + counts.atrisk, counts.all, 'segments partition the total');
  assert.deepStrictEqual(
    { u: counts.unassigned, s: counts.stalled, a: counts.atrisk },
    { u: 2, s: 2, a: 1 }, 'partition counts (o1,o2 | o3,o5 | o4)');

  // URGENCY ORDER — red band before amber before green.
  const bandRank = (b) => (b === 'red' ? 0 : b === 'amber' ? 1 : 2);
  for (let i = 1; i < entries.length; i++) {
    assert.ok(bandRank(entries[i - 1].band) <= bandRank(entries[i].band), 'entries ordered red→amber→green');
  }
  assert.strictEqual(entries[0].band, 'red');
  assert.strictEqual(entries[entries.length - 1].band, 'green');

  // Empty input → empty queue, zero counts (never throws).
  const empty = build([], [], [], () => 'green');
  assert.strictEqual(empty.entries.length, 0);
  assert.strictEqual(empty.counts.all, 0);
  ok('buildActionQueue: union == distinct(unassigned ∪ stalled ∪ at-risk); dedup; exclusive partition; urgency order; counts partition total');
}

// ─────────────────────────────────────────────────────────────────────────────
// NO-REGRESSION — getPendingOrders predicate BYTE-IDENTICAL to the approved base (superset view, not a new rule)
// ─────────────────────────────────────────────────────────────────────────────
{
  const grab = (s) => { const i = s.indexOf('function getPendingOrders()'); return s.slice(i, s.indexOf('\n}', i) + 2); };
  assert.strictEqual(grab(html), grab(baseHtml), 'getPendingOrders() is byte-identical to base');
  assert.match(html, /!dt\.assigned_driver_id && dt\.status !== 'cancelled' && dt\.status !== 'completed'/, 'pending predicate intact');
  ok('getPendingOrders() byte-identical to base (the Cola is a superset VIEW, not a different pending rule)');
}

// ─────────────────────────────────────────────────────────────────────────────
// XSS — every customer field in the Cola card is escapeHtml(String(...))'d (body + the data-* attribute sinks).
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.match(colaJs, /\$\{escapeHtml\(o\.customer_name \|\| '—'\)\}/, 'customer_name escaped');
  assert.match(colaJs, /\$\{escapeHtml\(o\.items_text \|\| o\.address_detected \|\| '—'\)\}/, 'items_text/address escaped');
  assert.match(colaJs, /\$\{escapeHtml\(nm\)\}/, 'stalled driver name escaped');
  assert.match(colaJs, /data-order-id="\$\{escapeHtml\(o\.order_id\)\}"/, 'data-order-id attribute escaped');
  // no raw interpolation of a customer field straight into the template
  assert.doesNotMatch(colaJs, /\$\{o\.customer_name\}/, 'no raw customer_name');
  assert.doesNotMatch(colaJs, /\$\{o\.items_text\}/, 'no raw items_text');
  ok('Cola card escapes every customer field (body + attribute sinks)');
}

// ─────────────────────────────────────────────────────────────────────────────
// stopPropagation — action buttons act without opening the detail modal (no swallowed assign).
// ─────────────────────────────────────────────────────────────────────────────
{
  const w = html.slice(html.indexOf('function wireColaHandlers('), html.indexOf('function initColaSegments('));
  assert.match(w, /if \(e\.target\.closest\('button'\)\) return;/, 'card click ignores button clicks');
  const stops = (w.match(/e\.stopPropagation\(\);/g) || []).length;
  assert.ok(stops >= 3, `action buttons stopPropagation (found ${stops})`);
  assert.match(w, /openPicker\(btn\.dataset\.assignOrder\)/, 'Asignar → picker');
  assert.match(w, /openPicker\(btn\.dataset\.reassignOrder, true\)/, 'Reasignar → picker (isReassign)');
  ok('card body → detail modal; action buttons stopPropagation (assign/reassign/self/more)');
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE count mirrored — Cola header meta + the four segment chips + the topbar KPI all read the same counts.
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = html.slice(html.indexOf('function renderCola('), html.indexOf('function colaCard('));
  assert.match(r, /meta\.textContent = String\(counts\.all\)/, 'Cola header meta = counts.all');
  assert.match(r, /setSeg\('seg-all-n', counts\.all\)/, 'segment Todos = counts.all');
  assert.match(r, /setSeg\('seg-unassigned-n', counts\.unassigned\)/, 'segment Sin asignar = counts.unassigned');
  assert.match(r, /setSeg\('seg-stalled-n', counts\.stalled\)/, 'segment Detenidos = counts.stalled');
  assert.match(r, /setSeg\('seg-atrisk-n', counts\.atrisk\)/, 'segment En riesgo = counts.atrisk');
  const us = html.slice(html.indexOf('function updateStats('), html.indexOf('function getDotClass('));
  assert.match(us, /const pendingCount = \(precomputed \|\| getActionQueue\(Date\.now\(\)\)\)\.counts\.all;/, 'topbar KPI stat-pending = shared queue counts.all');
  assert.doesNotMatch(us, /getPendingOrders\(\)\.length/, 'KPI no longer the unassigned-only count');
  // The KPI LABEL must match its count (the whole queue), not the "Sin asignar" segment — else it can read
  // "1 En cola" while the Sin asignar segment says 0. Spec: the stat-pending KPI label is "En cola".
  const kpiTag = html.match(/<div class="tb-kpi" id="kpi-pending">[\s\S]*?<\/div>/);
  assert.ok(kpiTag, 'kpi-pending KPI markup located');
  assert.match(kpiTag[0], /<span>En cola<\/span>/, 'stat-pending KPI label is "En cola" (matches the union count)');
  assert.doesNotMatch(kpiTag[0], /Sin asignar/, 'KPI label is no longer the segment-only "Sin asignar"');
  ok('ONE count mirrored: Cola meta + 4 segment chips + topbar KPI (labelled "En cola") all from the same counts');
}

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION GUARD — Recoger(pickup) + Programados(scheduled) STAY visible in En Fila; badge zeroed; Entrega
// now excludes unassigned (moved to the Cola).
// ─────────────────────────────────────────────────────────────────────────────
{
  const full = html.slice(html.indexOf('function renderPedidosTab('), html.indexOf('function renderCommsTab('));
  // Strip // line-comments so the guard CANNOT be satisfied by prose — the vacuity the gate flagged (the words
  // "Recoger"/"Programados" appear in comments). Assert on the executable code that iterates the data arrays.
  const body = full.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  assert.match(body, /const pickup = getPickupQueue\(\);/, 'pickup sourced from getPickupQueue()');
  assert.match(body, /const scheduled = Object\.values\(allScheduled \|\| \{\}\)/, 'scheduled sourced from allScheduled');
  assert.match(body, /const pickupRows = pickup\.map\(/, 'pickup array iterated into rows');
  assert.match(body, /const schedRows = scheduled\.map\(/, 'scheduled array iterated into rows');
  // …and those rows are assembled into el.innerHTML off the array length (empty array → the category vanishes).
  assert.match(body, /cat\('Recoger', pickup\.length, pickupRows\)/, 'Recoger rows assembled into el.innerHTML');
  assert.match(body, /cat\('Programados', scheduled\.length, schedRows\)/, 'Programados rows assembled into el.innerHTML');
  assert.match(body, /getDeliveryQueue\(\)\.filter\(o => allTasks\[`\$\{o\.order_id\}_delivery`\]\?\.assigned_driver_id\)/, 'Entrega assigned-only (unassigned moved to Cola)');
  assert.match(body, /setTabBadge\('tab-pedidos-n', 0\)/, 'En Fila attention badge zeroed');
  ok('En Fila iterates Recoger(pickup) + Programados(scheduled) into the DOM (code, not comment tokens); Entrega assigned-only; badge zeroed');
}

// ─────────────────────────────────────────────────────────────────────────────
// Torre retires the order-action alert types (the Cola owns them); payment/driver alerts stay.
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.match(html, /const COLA_OWNED_ALERT_TYPES = new Set\(\['no_drivers_available', 'no_response_takeover', 'assignment_strand'\]\)/, 'order-alert types set defined');
  assert.match(html, /sortAlertEntries\(alerts\)\.filter\(\(e\) => !\(e\.alert && COLA_OWNED_ALERT_TYPES\.has\(e\.alert\.type\)\)\)/, 'renderDispatcherAlerts filters order-alert types out of the Torre');
  ok('Torre retires no_drivers_available / no_response_takeover / assignment_strand (Cola owns them)');
}

// ─────────────────────────────────────────────────────────────────────────────
// P1-a — a retired-alert order (delivery-claimed strand / no-drivers / takeover) is SOURCED INTO the Cola.
// The SAME COLA_OWNED_ALERT_TYPES set drives BOTH retirement and inclusion → filter-set == inclusion-set,
// per type, landing red + in counts.all (Detenidos). So retiring the Torre alert can't make an order vanish.
// ─────────────────────────────────────────────────────────────────────────────
{
  // Comment-stripped structural: the fourth source is computed AND wired in (concat) AND forced red — so a
  // reversion parked in a comment can't satisfy the guard.
  const modJs0 = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  assert.match(modJs0, /const exceptions = collectExceptionOrders\(latestAlerts, allOrders, COLA_OWNED_ALERT_TYPES\)/, 'exceptions sourced from the same owned-types set');
  assert.match(modJs0, /const stalled = timerStalled\.concat\(exceptions\);/, 'exceptions unioned into the stalled (Detenidos) input');
  assert.match(modJs0, /exceptionIds\.has\(o\.order_id\) \? 'red' : riskOf\(o\)\.band/, 'exceptions forced red');

  const setSrc = html.match(/const COLA_OWNED_ALERT_TYPES = new Set\((\[[^\]]*\])\)/);
  assert.ok(setSrc, 'COLA_OWNED_ALERT_TYPES literal located');
  const OWNED = JSON.parse(setSrc[1].replace(/'/g, '"'));
  assert.ok(OWNED.includes('assignment_strand') && OWNED.includes('no_drivers_available') && OWNED.includes('no_response_takeover'),
    'owned set covers all three order-action alert types');
  const owned = new Set(OWNED);

  // Drive the REAL getActionQueue adapter (collectExceptionOrders + buildActionQueue are real source; the rest
  // are strand-shaped stubs). This exercises the actual wiring end-to-end — "computed but not unioned" fails.
  const grab = (re) => { const m = html.match(re); assert.ok(m, 'source located: ' + re); return m[0]; };
  const adapterSrc = grab(/function collectExceptionOrders\(alertsObj, ordersObj, ownedTypes\)\s*\{[\s\S]*?\n\}/) + '\n'
    + grab(/function buildActionQueue\(unassigned, stalled, atrisk, bandOf\)\s*\{[\s\S]*?\n\}/) + '\n'
    + grab(/function getActionQueue\(nowTs\)\s*\{[\s\S]*?\n\}/) + '\n; return getActionQueue;';
  const DEPS = ['deliveryRisk', 'agingSeconds', 'agingBaselineMs', 'etaSnapshots', 'etaCache', 'getPendingOrders',
    'allOrders', 'allTasks', 'allDrivers', 'isStalledAssignment', 'latestAlerts', 'COLA_OWNED_ALERT_TYPES', 'getOrdersForDriver'];

  for (const type of OWNED) {
    // Strand shape: the order exists, its delivery task is CLAIMED, it is NOT pending, NOT timer-stalled, NOT
    // aging — so only the retired alert names it. If getActionQueue didn't union collectExceptionOrders into
    // its stalled input, this order would be invisible → entries.length 0 → red.
    // eslint-disable-next-line no-new-func
    const getAQ = new Function(...DEPS, adapterSrc)(
      () => ({ level: 'ok', band: 'green' }),          // deliveryRisk
      () => 0, () => 0,                                // agingSeconds, agingBaselineMs
      { baseline: () => null }, {},                    // etaSnapshots, etaCache
      () => [],                                        // getPendingOrders (strand not pending)
      { S1: { order_id: 'S1', created_at: 1 } },       // allOrders
      { S1_delivery: { assigned_driver_id: 'd1' } },   // allTasks (delivery claimed, pickup unassigned)
      {},                                              // allDrivers
      () => false,                                     // isStalledAssignment (no armed timer)
      { a1: { type, order_id: 'S1' } },                // latestAlerts (the retired alert)
      owned,                                           // COLA_OWNED_ALERT_TYPES
      () => [],                                        // getOrdersForDriver
    );
    const { entries, counts } = getAQ(1000);
    assert.strictEqual(entries.length, 1, `type ${type}: the REAL getActionQueue includes the strand`);
    assert.strictEqual(entries[0].orderId, 'S1');
    assert.strictEqual(entries[0].band, 'red', `type ${type}: red band (act now)`);
    assert.strictEqual(entries[0].primary, 'stalled', `type ${type}: Detenidos segment`);
    assert.strictEqual(counts.all, 1, `type ${type}: in counts.all`);
  }

  // Robustness: collectExceptionOrders must skip a malformed id (array/empty) rather than coerce it into a real
  // order; a valid string id still resolves; two alerts for one order dedupe.
  // eslint-disable-next-line no-new-func
  const collect = new Function(`${grab(/function collectExceptionOrders\(alertsObj, ordersObj, ownedTypes\)\s*\{[\s\S]*?\n\}/)}; return collectExceptionOrders;`)();
  assert.deepStrictEqual(collect({ a: { type: 'assignment_strand', order_id: ['S1'] } }, { S1: { order_id: 'S1' } }, owned), [], 'array id skipped (no coercion into order S1)');
  assert.deepStrictEqual(collect({ a: { type: 'assignment_strand', order_id: '' } }, { '': { x: 1 } }, owned), [], 'empty id skipped');
  assert.deepStrictEqual(collect({ z: { type: 'driver_freshness_stale', order_id: 'S1' } }, { S1: {} }, owned), [], 'non-owned alert type not sourced');
  assert.deepStrictEqual(collect({ a: { type: 'assignment_strand', order_id: 'S1' } }, { S1: { order_id: 'S1' } }, owned).map(o => o.order_id), ['S1'], 'valid string id still resolves');
  assert.strictEqual(collect({ a: { type: 'assignment_strand', order_id: 'S1' }, b: { type: 'no_drivers_available', order_id: 'S1' } }, { S1: { order_id: 'S1' } }, owned).length, 1, 'same order via two owned alerts → deduped');
  ok('real getActionQueue unions retired-alert orders per COLA_OWNED_ALERT_TYPES (red · Detenidos · counts.all); malformed ids skipped; deduped');
}

// ─────────────────────────────────────────────────────────────────────────────
// P1-b — the Cola header and the topbar KPI are driven by ONE shared queue per render cycle (the 5s tick can
// never refresh one count without the other; no two-timestamp divergence).
// ─────────────────────────────────────────────────────────────────────────────
{
  const sync = html.slice(html.indexOf('function syncActionQueueViews('), html.indexOf('function renderCola('));
  assert.match(sync, /const q = precomputed \|\| getActionQueue\(Date\.now\(\)\);/, 'shared path computes the queue ONCE');
  assert.match(sync, /renderCola\(q\);/, 'shared path feeds the Cola header the shared queue');
  assert.match(sync, /updateStats\(q\);/, 'shared path feeds the topbar KPI the SAME shared queue');
  const sb = html.slice(html.indexOf('function renderSidebar('), html.indexOf('function renderSidebar(') + 500);
  assert.match(sb, /syncActionQueueViews\(\);/, 'renderSidebar routes through the shared count path');
  assert.doesNotMatch(sb, /\brenderCola\(\)/, 'renderSidebar never refreshes the Cola alone (that would skip the KPI on a tick)');
  assert.match(html, /function renderCola\(precomputed\)/, 'renderCola accepts a precomputed queue');
  assert.match(html, /function updateStats\(precomputed\)/, 'updateStats accepts a precomputed queue');
  assert.match(html, /const pendingCount = \(precomputed \|\| getActionQueue\(Date\.now\(\)\)\)\.counts\.all;/, 'KPI reads counts.all from the shared queue');
  const tick = html.slice(html.indexOf('function startRenderTick('), html.indexOf('function startRenderTick(') + 260);
  assert.match(tick, /renderSidebar\(\);/, 'the 5s render tick calls renderSidebar (→ the shared count path)');
  // CALLER COVERAGE (the whole-flow guard the last round missed — it proved the shared path works, not that
  // every caller uses it): renderCola( and updateStats( each appear EXACTLY twice in the module — their own
  // definition + the ONE call inside syncActionQueueViews. Any bare bypass caller (segment click, subscription
  // callback) makes the count 3+ → red. Comments stripped so a commented reference can't inflate it.
  const modJs = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  assert.strictEqual((modJs.match(/renderCola\(/g) || []).length, 2, 'renderCola( only at its def + inside syncActionQueueViews (no bypass caller)');
  assert.strictEqual((modJs.match(/updateStats\(/g) || []).length, 2, 'updateStats( only at its def + inside syncActionQueueViews (no bypass caller)');
  ok('one shared queue drives Cola header + KPI; every caller routes through syncActionQueueViews (no bypass)');
}

console.log(`\ndispatch-cola: OK (${n} groups)`);
