// xpizza-dispatch/dispatch-drawer.test.js
//
// Slice D1 — order-detail MODAL → right-side DRAWER (design:
// docs/superpowers/specs/2026-09-20-dispatch-D-chrome-rail-drawer-design.md).
//
// The gate criterion (per the advisor): the order-detail CONTENT GENERATOR's output must be BYTE-IDENTICAL to
// the shipped renderOrderDetailModal — every field, every escapeHtml, Factura·RTN iff rtn_cliente, vuelto/pago,
// timeline, cancel-reason — with ONLY the container/presentation + focus-trap/Esc/restore changed. Source
// byte-identity ⟹ output byte-identical by construction, so the fiscal Factura·RTN block is provably a pure
// MOVE. These guards enforce exactly that, plus the drawer shell + read-only-on-open + a11y.
import assert from 'node:assert';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'index.html');
const BASE = 'd867a7e';                       // approved C-2 tip D1 stacks on (content generator frozen here)
const html = fs.readFileSync(FILE, 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// extract a top-level `function <name>(` … up to its closing brace at column 0
const fnSrc = (src, name) => {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const end = src.indexOf('\n}\n', start);
  return end < 0 ? null : src.slice(start, end + 2);
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. GATE CRITERION — the content generator is byte-identical to the shipped base. A pure move: no field,
//    escape, Factura gate, vuelto, timeline, or cancel-reason changed.
// ─────────────────────────────────────────────────────────────────────────────
{
  let baseHtml;
  try { baseHtml = execSync(`git show ${BASE}:xpizza-dispatch/index.html`, { cwd: __dirname, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { console.error('  ! could not load base blob:', e.message); process.exit(1); }
  const cur = fnSrc(html, 'renderOrderDetailModal');
  const base = fnSrc(baseHtml, 'renderOrderDetailModal');
  assert.ok(cur && base, 'located renderOrderDetailModal in both');
  assert.strictEqual(cur, base, 'renderOrderDetailModal is BYTE-IDENTICAL to base (content generator untouched)');
  // and the fiscal/money invariants are present in that (frozen) source — documents what byte-identity protects
  assert.match(cur, /if \(order\.rtn_cliente\) \{/, 'Factura block still gated on rtn_cliente');
  assert.match(cur, /Factura · RTN/, 'Factura · RTN label present');
  assert.match(cur, /odRow\('RTN'/, 'RTN row present');
  assert.match(cur, /odRow\('Vuelto'/, 'vuelto row present');
  assert.match(cur, /isCashPayment\(order\.payment_method\)/, 'pay method via existing isCashPayment');
  ok('content generator byte-identical to base — Factura·RTN / vuelto / pago / timeline are a pure move');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Presentation is now a right-side DRAWER (scrim + slide-in card), not a centered modal.
// ─────────────────────────────────────────────────────────────────────────────
{
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const card = (style.match(/\.order-detail-card \{([^}]*)\}/) || [])[1] || '';
  assert.match(card, /position:\s*fixed/, 'drawer card is position:fixed');
  assert.match(card, /right:\s*0/, 'drawer card pinned to the right edge');
  assert.match(card, /transform:\s*translateX\(100%\)/, 'drawer card starts off-screen (translateX 100%)');
  assert.match(card, /transition:\s*transform/, 'drawer card slides via a transform transition');
  assert.match(style, /\.order-detail-modal\.open \.order-detail-card \{ transform: none; \}/, 'opening slides the card in (transform:none)');
  const scrim = (style.match(/\.order-detail-modal \{([^}]*)\}/) || [])[1] || '';
  assert.match(scrim, /position:\s*fixed/, 'scrim is a fixed full-screen backdrop');
  assert.match(scrim, /pointer-events:\s*none/, 'scrim ignores pointer events when closed');
  ok('order-detail is a right-side drawer: fixed card, slides in from translateX(100%) on .open');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. READ-ONLY on open — opening the drawer performs no DB write and adds no subscription. (The content
//    generator only reads state + sets innerHTML + wires click handlers that reuse existing gated flows.)
// ─────────────────────────────────────────────────────────────────────────────
{
  const render = fnSrc(html, 'renderOrderDetailModal');
  const open = fnSrc(html, 'openOrderDetailModal');
  // DB/firebase writes + money/assign/cancel calls — NOT array .push()/.set which are legitimate here.
  const dbWrite = /\.ref\(|\bfirebase\b|database\(|XPD\.(set|update|write|create|delete|save|assign|resolve|cancel|refund)\w*\(/i;
  for (const [name, src] of [['renderOrderDetailModal', render], ['openOrderDetailModal', open]]) {
    assert.doesNotMatch(src, /\bsubscribe/i, `${name}: no subscription added on open`);
    assert.doesNotMatch(src, dbWrite, `${name}: no DB write / money call on open`);
  }
  // footer actions reuse the EXISTING gated handlers (deferred to user click, not fired on open)
  assert.match(render, /confirmCancelOrder\(oid\)/, 'Cancelar reuses the gated confirmCancelOrder flow');
  assert.match(render, /openPicker\(oid, true\)/, 'Reasignar reuses the CAS-safe picker');
  assert.match(render, /showLookupPin\(order\)/, 'Ver en mapa reuses the existing lookup-pin');
  ok('read-only on open: no subscription / DB write / money call; footer reuses existing gated handlers');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. a11y — EXECUTED against a real DOM (not source text): the Tab handler runs, so the id/class null-deref
//    (the panel needs id="order-detail-card", not just the class) goes red, and the edges actually wrap. The
//    DOM's getElementById mirrors the real HTML's ids, so a missing id makes $() return null → the handler
//    throws exactly as the browser would. [structural-tests-blind-to-runtime]
// ─────────────────────────────────────────────────────────────────────────────
{
  // static semantics
  assert.match(html, /<div class="order-detail-card" id="order-detail-card" role="dialog" aria-modal="true" aria-labelledby="order-detail-title">/, 'drawer card is an id-addressable aria dialog');
  assert.match(html, /<button class="order-detail-close" id="order-detail-close" aria-label="Cerrar"><svg class="ic sm"><use href="#i-close"\/><\/svg><\/button>/, 'close is a labelled line-icon button');
  assert.match(html, /<div class="order-detail-modal" id="order-detail-modal" inert>/, 'the drawer starts inert (closed = out of tab order + a11y tree)');

  // ---- build a DOM whose getElementById reflects the REAL HTML's ids ----
  const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map(m => m[1]));
  const dom = { activeElement: null };
  const focusList = [];
  const mkEl = (id) => {
    const cls = new Set(), attr = {}, ls = {};
    const el = {
      id, offsetParent: {}, isConnected: true,
      classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) },
      setAttribute: (k, v) => { attr[k] = v === undefined ? '' : v; }, removeAttribute: (k) => { delete attr[k]; },
      hasAttribute: (k) => k in attr, getAttribute: (k) => attr[k],
      addEventListener: (t, fn) => { (ls[t] || (ls[t] = [])).push(fn); }, dispatch: (t, e) => { (ls[t] || []).forEach(fn => fn(e)); },
      focus() { dom.activeElement = el; }, querySelectorAll: () => focusList,
    };
    return el;
  };
  const registry = {};
  const getEl = (id) => { if (!ids.has(id)) return null; return registry[id] || (registry[id] = mkEl(id)); };
  // focusables inside the card: close + two action buttons (share the card's querySelectorAll)
  const closeBtn = getEl('order-detail-close'); const btnA = mkEl('a'); const btnB = mkEl('b');
  focusList.push(closeBtn, btnA, btnB);
  getEl('order-detail-modal').setAttribute('inert', '');       // initial closed state (mirrors the HTML)
  const win = { matchMedia: () => ({ matches: false }) };
  const externalOpener = mkEl('ext'); dom.activeElement = externalOpener;

  const focusTrapSrc = fnSrc(html, 'focusTrapTarget');
  const openSrc = fnSrc(html, 'openOrderDetailModal');
  const closeSrc = fnSrc(html, 'closeOrderDetailModal');
  const trapStart = html.indexOf("$('order-detail-modal').addEventListener('keydown'");
  const trapSrc = html.slice(trapStart, html.indexOf('\n});', trapStart) + 4);
  assert.ok(focusTrapSrc && openSrc && closeSrc && trapStart > -1, 'located a11y source blocks');

  const api = new Function('$', 'document', 'window', 'renderOrderDetailModal', 'toast', 'pickerReturnFocusTarget', 'allOrders', 'allScheduled',
    `${focusTrapSrc}\n${openSrc}\n${closeSrc}\n${trapSrc}\n; return { openOrderDetailModal, closeOrderDetailModal };`
  )(getEl, dom, win, () => {}, () => {}, () => ({ el: externalOpener, temp: false }), { o1: { order_id: 'o1' } }, {});

  // OPEN — clears inert, opens, moves focus into the drawer
  api.openOrderDetailModal('o1');
  const modal = getEl('order-detail-modal');
  assert.ok(!modal.hasAttribute('inert'), 'open clears inert (drawer re-enters tab order)');
  assert.ok(modal.classList.contains('open'), 'open adds .open');
  assert.strictEqual(dom.activeElement, closeBtn, 'open moves focus to the close button inside the drawer');

  // TAB at the last focusable wraps to the first; SHIFT-TAB at the first wraps to the last. This EXECUTES the
  // real handler — if the panel lacked id="order-detail-card", $('order-detail-card') is null and this throws.
  dom.activeElement = btnB;
  modal.dispatch('keydown', { key: 'Tab', shiftKey: false, preventDefault() {}, stopPropagation() {} });
  assert.strictEqual(dom.activeElement, closeBtn, 'Tab at the last focusable wraps to the first');
  dom.activeElement = closeBtn;
  modal.dispatch('keydown', { key: 'Tab', shiftKey: true, preventDefault() {}, stopPropagation() {} });
  assert.strictEqual(dom.activeElement, btnB, 'Shift-Tab at the first focusable wraps to the last');

  // CLOSE — restores focus outward and marks the drawer inert (out of tab order + a11y tree)
  api.closeOrderDetailModal();
  assert.ok(!modal.classList.contains('open'), 'close removes .open');
  assert.strictEqual(dom.activeElement, externalOpener, 'close restores focus outward (via the cascade)');
  assert.ok(modal.hasAttribute('inert'), 'closed drawer is inert — offscreen close/links are not Tab/SR reachable');
  ok('a11y EXECUTED: Tab/Shift-Tab wrap at the edges (real handler); open clears inert + focuses in; close restores focus + re-inerts');
}

console.log(`\ndispatch-drawer: OK (${n} groups)`);
