// xpizza-dispatch/dispatch-cash-recon.test.js
//
// Slice D3 — roster + cash/cuadre bar + the reconReason no-regression PORT (design:
// docs/superpowers/specs/2026-09-20-dispatch-D-chrome-rail-drawer-design.md).
//
// Guards:
//  • reconReason PORT — the live paid-after-close fix from origin/main c954558 (which the overhaul branch was
//    cut before) is present, byte-identical, all 4 blocked_reason branches EXECUTED, and wired into the card.
//  • Cash/cuadre bar — DISPLAY + "Reconciliar" LINK only: no DB write; the Reconciliar button activates the
//    existing Caja rtab (executed); reads the pending-reconciliation count from the existing global.
//  • Roster — renderDriverNode is BYTE-IDENTICAL to base (liveness predicates + presentation untouched).
import assert from 'node:assert';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'index.html');
const BASE = 'd867a7e';
const html = fs.readFileSync(FILE, 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const fnSrc = (src, name) => { const s = src.indexOf(`function ${name}(`); const e = src.indexOf('\n}\n', s); return s < 0 || e < 0 ? null : src.slice(s, e + 2); };

// ─────────────────────────────────────────────────────────────────────────────
// 1. reconReason PORT — present + byte-identical to origin/main + all 4 branches EXECUTED + wired in the card.
// ─────────────────────────────────────────────────────────────────────────────
{
  let originHtml;
  try { originHtml = execSync('git show origin/main:xpizza-dispatch/index.html', { cwd: __dirname, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { console.error('  ! could not load origin/main blob:', e.message); process.exit(1); }
  const cur = fnSrc(html, 'reconReason'); const origin = fnSrc(originHtml, 'reconReason');
  assert.ok(cur && origin, 'reconReason present in current + origin/main');
  assert.strictEqual(cur, origin, 'reconReason is BYTE-IDENTICAL to the live origin/main impl (clean rebase)');
  // EXECUTE all four blocked_reason branches
  const reconReason = new Function(`${cur}\nreturn reconReason;`)();
  assert.strictEqual(reconReason({ blocked_reason: 'manual_refund_required_paid_after_close' }), 'Pagado después del cierre — <strong>reembolsar manualmente</strong>', 'manual-refund branch');
  assert.strictEqual(reconReason({ blocked_reason: 'refund_pending_paid_after_close' }), 'Reembolso en curso — no requiere acción', 'refund-pending branch');
  assert.strictEqual(reconReason({ blocked_reason: 'refunded_paid_after_close' }), 'Reembolsado (pagado después del cierre)', 'refunded branch');
  assert.strictEqual(reconReason({ blocked_reason: 'something_else' }), 'Pago en línea sin confirmar', 'default (unknown) falls back to the original text');
  assert.strictEqual(reconReason(null), 'Pago en línea sin confirmar', 'null-safe default');
  // wired into the recon card (replaced the hardcoded string)
  assert.match(html, /<div class="recon-reason">\$\{reconReason\(o\)\}<\/div>/, 'recon card renders ${reconReason(o)} (not the hardcoded reason)');
  assert.doesNotMatch(html, /<div class="recon-reason">Pago en línea sin confirmar<\/div>/, 'the hardcoded recon-reason line is gone');
  ok('reconReason ported byte-identical; 4 blocked_reason branches execute; wired into the recon card');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Cash/cuadre bar — EXECUTED: display + Reconciliar link only, no write; Reconciliar activates the Caja rtab.
// ─────────────────────────────────────────────────────────────────────────────
{
  const src = fnSrc(html, 'renderCashBar');
  assert.ok(src, 'located renderCashBar');
  // no DB write / subscription / money call — reads values + sets innerHTML + wires a nav click only
  assert.doesNotMatch(src, /\.ref\(|\bfirebase\b|database\(|\bsubscribe/i, 'cash bar performs no write/subscription');
  assert.doesNotMatch(src, /XPD\.(set|update|write|create|delete|save|resolve|cancel|refund|assign)\w*\(/i, 'cash bar makes no money/assign call');

  // execute it against a shim
  let rtabClicked = 0;
  const cashEl = { innerHTML: '' };
  const reconBtn = { _l: {}, addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }, dispatch(t, e) { (this._l[t] || []).forEach(fn => fn(e)); } };
  const caja = { classList: { contains: () => false }, click() { rtabClicked++; } };
  const els = { 'cash-bar': cashEl, 'cash-recon-btn': reconBtn };
  const $ = (id) => els[id] || null;
  const doc = { querySelector: (sel) => (sel.includes('data-tab="caja"') ? caja : null) };
  const reconciliationOrders = { o1: {}, o2: {}, o3: {} };     // 3 pending → "Cuadres pendientes"
  const esc = (s) => String(s);
  const cash = { drvA: { s1: { cuadre: { closed_at: Date.now(), cash_owed: 500 } } }, drvB: { s1: { cuadre: { closed_at: Date.now(), cash_owed: 240 } } } };
  const renderCashBar = new Function('$', 'document', 'reconciliationOrders', 'escapeHtml', `${src}\nreturn renderCashBar;`)($, doc, reconciliationOrders, esc);
  renderCashBar(cash);
  assert.match(cashEl.innerHTML, /Efectivo del turno/, 'shows the shift-cash label');
  assert.match(cashEl.innerHTML, /L 740/, 'sums the already-closed cuadres (read-only): 500 + 240');
  assert.match(cashEl.innerHTML, /Cuadres pendientes/, 'shows the pending-reconciliation label');
  assert.match(cashEl.innerHTML, /<b>3<\/b>/, 'pending count read from reconciliationOrders (3)');
  assert.match(cashEl.innerHTML, /Reconciliar/, 'shows the Reconciliar link');
  // Reconciliar → activates the existing Caja rtab
  reconBtn.dispatch('click', {});
  assert.strictEqual(rtabClicked, 1, 'Reconciliar activates the existing Caja rtab (navigation only)');
  // freshness: the recon subscription refreshes the cash bar's pending count
  assert.match(html, /renderReconciliationSection\(\);\s*setTabBadge\('tab-caja-n'[^\n]*\n\s*renderCashBar\(\);/, 'recon subscription calls renderCashBar() to refresh the pending count');
  ok('cash bar: display + Reconciliar→Caja rtab, no write; reads cash total + pending recon count; refreshed on recon updates');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Roster — renderDriverNode BYTE-IDENTICAL to base: liveness predicates (isStalePing/hasPushReachability/
//    gpsDark, dot vocab, active-order count, GPS-dark alarm row) + presentation untouched.
// ─────────────────────────────────────────────────────────────────────────────
{
  let baseHtml;
  try { baseHtml = execSync(`git show ${BASE}:xpizza-dispatch/index.html`, { cwd: __dirname, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { console.error('  ! could not load base blob:', e.message); process.exit(1); }
  assert.strictEqual(fnSrc(html, 'renderDriverNode'), fnSrc(baseHtml, 'renderDriverNode'), 'renderDriverNode byte-identical to base (roster logic + presentation untouched)');
  // the predicates the roster relies on are the existing ones (documents what byte-identity protects)
  const node = fnSrc(html, 'renderDriverNode');
  for (const pred of ['XPD.isStalePing(', 'hasPushReachability(', 'staleDriverUids.has(', 'getOrdersForDriver(']) assert.ok(node.includes(pred), `roster uses existing predicate ${pred}`);
  ok('roster renderDriverNode byte-identical — existing liveness predicates + presentation unchanged');
}

console.log(`\ndispatch-cash-recon: OK (${n} groups)`);
