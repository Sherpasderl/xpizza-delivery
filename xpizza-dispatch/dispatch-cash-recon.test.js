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
// 2. Cash/cuadre bar — DRIVER-CUADRE breakdown driven through the REAL renderCashBar (extracted + executed):
//    final vs provisional vs legacy vs escape-hatch, unresolved detail, and an explicit ERROR state (never L0).
//    DISPLAY-only: no DB write; Reconciliar activates the Caja rtab; pending stays SEPARATE from driver cuadres.
// ─────────────────────────────────────────────────────────────────────────────
{
  const src = fnSrc(html, 'renderCashBar');
  assert.ok(src, 'located renderCashBar');
  // no DB write / subscription / money call — reads values + sets innerHTML + wires a nav click only
  assert.doesNotMatch(src, /\.ref\(|\bfirebase\b|database\(|\bsubscribe/i, 'cash bar performs no write/subscription');
  assert.doesNotMatch(src, /XPD\.(set|update|write|create|delete|save|resolve|cancel|refund|assign)\w*\(/i, 'cash bar makes no money/assign call');

  const today = Date.now();
  // Execute the REAL renderer against a shim. lastDriverCash/driverCashError are module-level in index.html, so
  // inject fresh lexical bindings per run for isolation. Returns { html, reconBtn, rtabClicks }.
  function run(cash, reconOrders = {}) {
    let rtabClicked = 0;
    const cashEl = { innerHTML: '' };
    const reconBtn = { _l: {}, addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }, dispatch(t, e) { (this._l[t] || []).forEach(fn => fn(e)); } };
    const caja = { classList: { contains: () => false }, click() { rtabClicked++; } };
    const els = { 'cash-bar': cashEl, 'cash-recon-btn': reconBtn };
    const $ = (id) => els[id] || null;
    const doc = { querySelector: (sel) => (sel.includes('data-tab="caja"') ? caja : null) };
    const esc = (s) => String(s);
    const fn = new Function('$', 'document', 'reconciliationOrders', 'escapeHtml',
      `let lastDriverCash={},driverCashError=null;\n${src}\nreturn renderCashBar;`)($, doc, reconOrders, esc);
    fn(cash);
    return { html: cashEl.innerHTML, reconBtn, rtabClicks: () => rtabClicked };
  }
  const C = (o) => ({ cuadre: { closed_at: today, cash_order_count: 1, ...o } });   // a today-closed cuadre fixture (schema-required count defaulted; override to test a bad count)

  // (a) FINAL-only — provisional:false records sum into "Efectivo final".
  {
    const r = run({ dA: { s1: C({ cash_owed: 500, provisional: false }) }, dB: { s1: C({ cash_owed: 240, provisional: false }) } });
    assert.match(r.html, /Efectivo final \(2\)/, 'final count = 2');
    assert.match(r.html, /L 740/, 'final total = 500 + 240');
    assert.doesNotMatch(r.html, /Provisional \(/, 'no provisional line when there are none');
  }
  // (b) PROVISIONAL-only — its own warn-styled line; the final line stays at a real L0 (NOT an error); unresolved shown.
  {
    const r = run({ dA: { s1: C({ cash_owed: 300, provisional: true, unresolved_count: 2, unresolved_ids: ['o1', 'o2'] }) } });
    assert.match(r.html, /cash-prov/, 'provisional line present (warn style)');
    assert.match(r.html, /Provisional \(1\)/, 'provisional count = 1');
    assert.match(r.html, /L 300/, 'provisional total');
    assert.match(r.html, /Efectivo final \(0\)/, 'final line present at a REAL 0 (not an error)');
    assert.match(r.html, /Sin resolver/, 'unresolved line shown');
    assert.match(r.html, /<b>2<\/b>/, 'unresolved count = 2');
    assert.match(r.html, /title="[^"]*: 2"/, 'unresolved driver/shift detail in the title');
  }
  // (c) MIXED — final + provisional bucketed independently.
  {
    const r = run({ dA: { s1: C({ cash_owed: 500, provisional: false }) }, dB: { s1: C({ cash_owed: 120, provisional: true, unresolved_count: 1 }) } });
    assert.match(r.html, /Efectivo final \(1\)/, 'final count 1');
    assert.match(r.html, /L 500/, 'final total 500');
    assert.match(r.html, /Provisional \(1\)/, 'provisional count 1');
    assert.match(r.html, /L 120/, 'provisional total 120');
  }
  // (d) NEEDS DISPATCH REVIEW — a cuadre Admin-flagged needs_dispatch_review:true (escape-hatch path, always
  //     provisional) stands out as "requiere reconciliación manual", keyed on the FLAG (not the source), DISTINCT
  //     from an ordinary provisional cuadre, and NEVER summed as a clean final. (2f r3.)
  {
    const r = run({ dA: { s1: C({ cash_owed: 90, provisional: true, needs_dispatch_review: true, source: 'escape_hatch' }) } });
    assert.match(r.html, /cash-escape/, 'needs-review line present (accent style)');
    assert.match(r.html, /Requiere reconciliación manual/, 'needs-review label');
    assert.match(r.html, /Efectivo final \(0\)/, 'needs-review NOT summed as a clean final');
    assert.doesNotMatch(r.html, /Provisional \(/, 'needs-review NOT double-counted as an ordinary provisional');
    // keyed on the FLAG, not the source: needs_dispatch_review:true with NO `source` → still the review bucket.
    const r2 = run({ dB: { s1: C({ cash_owed: 40, provisional: true, needs_dispatch_review: true }) } });
    assert.match(r2.html, /Requiere reconciliación manual/, 'review bucket keyed on needs_dispatch_review (no source needed)');
    assert.doesNotMatch(r2.html, /Provisional \(/, 'a flag-only review record is not counted as ordinary provisional');
  }
  // (e) LEGACY — pre-feature record (NO provisional/metadata): must not crash; shown on its OWN SUBORDINATE
  //     "Heredado" line (dim, cash-legacy) so unverified pre-2.5.0 cash can NEVER read as a verified-final figure,
  //     and is NEVER merged into a grand total that hides it. (advisor: keep separate; must not read as final.)
  {
    const r = run({ dA: { s1: C({ cash_owed: 500, provisional: false }) }, dB: { s1: C({ cash_owed: 180 }) } });   // final 500 + legacy 180
    assert.match(r.html, /<div class="ci cash-legacy"><b>[^<]*<\/b><span>Heredado \(1\)/, 'legacy shown on its OWN subordinate cash-legacy line (not crashed, not mislabeled)');
    assert.match(r.html, /L 180/, 'legacy cash shown (display as before)');
    assert.match(r.html, /Efectivo final \(1\)/, 'final count EXCLUDES legacy (1 final, not 2)');
    assert.match(r.html, /L 500/, 'final total excludes legacy (500)');
    assert.doesNotMatch(r.html, /L 680/, 'NO merged grand total that hides the legacy figure (500 and 180 stay separate)');
    assert.doesNotMatch(r.html, /class="ci cash-legacy"><b>L 500/, 'the Efectivo final value is NOT dimmed/legacy-styled');
  }
  // (f) ERROR STATE — a subscription/permission failure renders an explicit error, NEVER an L0.
  {
    const r = run({ __error: true, code: 'PERMISSION_DENIED' });
    assert.match(r.html, /cash-error/, 'error line present');
    assert.match(r.html, /Error al leer cuadres/, 'explicit error message');
    assert.doesNotMatch(r.html, /Efectivo final|Efectivo del turno|L 0\b/, 'NEVER renders a cash figure / L0 on error');
  }
  // (g) Reconciliar → Caja rtab (navigation only); the pending count is SEPARATE from driver cuadres.
  {
    const r = run({ dA: { s1: C({ cash_owed: 500, provisional: false }) } }, { o1: {}, o2: {}, o3: {} });
    assert.match(r.html, /Cuadres pendientes/, 'payment-recon pending label present');
    assert.match(r.html, /<b>3<\/b>/, 'pending count from reconciliationOrders (3) — SEPARATE from cuadres');
    assert.match(r.html, /Reconciliar/, 'Reconciliar link present');
    r.reconBtn.dispatch('click', {});
    assert.strictEqual(r.rtabClicks(), 1, 'Reconciliar activates the Caja rtab (navigation only)');
  }
  // (h) MALFORMED money → explicit "registro de caja inválido" error (with driver/shift), NEVER a verified L0,
  //     and NEVER a throw — incl. an object cash_owed where Number({toString:'x'}) would TypeError. (codex P1)
  for (const bad of [
    { cash_owed: 'oops' },                          // string
    { cash_owed: null },                            // null
    { provisional: false },                         // missing cash_owed
    { cash_owed: { toString: 'x' } },               // object → Number() would throw
    { cash_owed: -5 },                              // negative
    { cash_owed: 100, cash_order_count: 'nope' },   // mistyped count (schema-required field)
    { cash_owed: 100, provisional: 'yes' },         // mistyped boolean
  ]) {
    let threw = false, r;
    try { r = run({ dA: { s1: C({ provisional: false, ...bad }) } }); } catch (_) { threw = true; }
    assert.ok(!threw, `malformed record ${JSON.stringify(bad)} must NOT throw`);
    assert.match(r.html, /Registro de caja inválido/, `malformed record ${JSON.stringify(bad)} → explicit invalid error`);
    assert.doesNotMatch(r.html, /Efectivo final|L 0\b/, `malformed record ${JSON.stringify(bad)} → NEVER a verified L0 / cash figure`);
  }
  // (i) ERROR → INVALID/partial snapshot does NOT clear the error; a VALID snapshot recovers. (codex P1)
  {
    const cashEl = { innerHTML: '' };
    const els = { 'cash-bar': cashEl, 'cash-recon-btn': { addEventListener() {} } };
    const fn = new Function('$', 'document', 'reconciliationOrders', 'escapeHtml',
      `let lastDriverCash={},driverCashError=null;\n${src}\nreturn renderCashBar;`)((id) => els[id] || null, { querySelector: () => null }, {}, (s) => String(s));
    fn({ __error: true, code: 'PERMISSION_DENIED' });
    assert.match(cashEl.innerHTML, /Error al leer cuadres/, 'step 1: subscription error shown');
    fn({ dA: { s1: C({ cash_owed: 'oops', provisional: false }) } });   // partial/invalid snapshot after the error
    assert.doesNotMatch(cashEl.innerHTML, /Efectivo final/, 'step 2: an invalid snapshot does NOT recover to a misleading final figure');
    assert.match(cashEl.innerHTML, /Error al leer cuadres|Registro de caja inválido/, 'step 2: still an explicit error (not L0)');
    fn({ dB: { s1: C({ cash_owed: 500, cash_order_count: 3, provisional: false }) } });   // valid snapshot
    assert.match(cashEl.innerHTML, /Efectivo final \(1\)/, 'step 3: a VALID snapshot recovers to totals');
    assert.match(cashEl.innerHTML, /L 500/, 'step 3: recovered total');
  }
  // freshness: the recon subscription still refreshes the bar's pending count.
  assert.match(html, /renderReconciliationSection\(\);\s*setTabBadge\('tab-caja-n'[^\n]*\n\s*renderCashBar\(\);/, 'recon subscription calls renderCashBar() to refresh the pending count');
  // the subscription is wired with an ERROR handler → error state (never a silent L0 on permission failure).
  assert.match(html, /subscribeToDriverCash\(renderCashBar,\s*\(err\)\s*=>\s*renderCashBar\(\{\s*__error:\s*true/, 'subscribeToDriverCash wired with an error handler → explicit error state');
  // Heredado is visually SUBORDINATE (dim) so it can never read as a verified-final figure.
  assert.match(html, /\.cash-bar \.ci\.cash-legacy b \{[^}]*color: var\(--text-dim\)/, 'Heredado value is dimmed (var(--text-dim)) — subordinate to Efectivo final');
  ok('cash bar: final/provisional/legacy/escape-hatch split + unresolved detail + explicit error (never L0); Reconciliar→Caja; pending stays separate');
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
