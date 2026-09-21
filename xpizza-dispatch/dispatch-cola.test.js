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
  assert.match(colaJs, /\$\{escapeHtml\(stalledName\)\}/, 'stalled driver name escaped');
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
  assert.match(us, /getActionQueue\(Date\.now\(\)\)\.counts\.all/, 'topbar KPI stat-pending = getActionQueue().counts.all');
  assert.doesNotMatch(us, /getPendingOrders\(\)\.length/, 'KPI no longer the unassigned-only count');
  ok('ONE count mirrored: Cola meta + 4 segment chips + topbar KPI all from the same counts');
}

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION GUARD — Recoger(pickup) + Programados(scheduled) STAY visible in En Fila; badge zeroed; Entrega
// now excludes unassigned (moved to the Cola).
// ─────────────────────────────────────────────────────────────────────────────
{
  const p = html.slice(html.indexOf('function renderPedidosTab('), html.indexOf('function renderCommsTab('));
  assert.match(p, /getPickupQueue\(\)/, 'pickup queue still rendered (Recoger not dropped)');
  assert.match(p, /allScheduled/, 'scheduled still rendered (Programados not dropped)');
  assert.match(p, /cat\('Recoger'/, 'Recoger category present');
  assert.match(p, /cat\('Programados'/, 'Programados category present');
  assert.match(p, /getDeliveryQueue\(\)\.filter\(o => allTasks\[`\$\{o\.order_id\}_delivery`\]\?\.assigned_driver_id\)/, 'Entrega now ASSIGNED-only (unassigned moved to Cola)');
  assert.match(p, /setTabBadge\('tab-pedidos-n', 0\)/, 'En Fila attention badge zeroed (one count lives in the Cola)');
  ok('En Fila keeps Recoger + Programados (pickup/scheduled not dropped); badge zeroed; Entrega assigned-only');
}

// ─────────────────────────────────────────────────────────────────────────────
// Torre retires the order-action alert types (the Cola owns them); payment/driver alerts stay.
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.match(html, /const COLA_OWNED_ALERT_TYPES = new Set\(\['no_drivers_available', 'no_response_takeover', 'assignment_strand'\]\)/, 'order-alert types set defined');
  assert.match(html, /sortAlertEntries\(alerts\)\.filter\(\(e\) => !\(e\.alert && COLA_OWNED_ALERT_TYPES\.has\(e\.alert\.type\)\)\)/, 'renderDispatcherAlerts filters order-alert types out of the Torre');
  ok('Torre retires no_drivers_available / no_response_takeover / assignment_strand (Cola owns them)');
}

console.log(`\ndispatch-cola: OK (${n} groups)`);
