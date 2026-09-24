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
// 4. a11y — dialog semantics + focus-trap + focus-restore + Esc, added WITHOUT touching the content generator.
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.match(html, /<div class="order-detail-card" role="dialog" aria-modal="true" aria-labelledby="order-detail-title">/, 'drawer card is an aria dialog');
  assert.match(html, /<button class="order-detail-close" id="order-detail-close" aria-label="Cerrar"><svg class="ic sm"><use href="#i-close"\/><\/svg><\/button>/, 'close is a labelled line-icon button');
  const open = fnSrc(html, 'openOrderDetailModal');
  const close = fnSrc(html, 'closeOrderDetailModal');
  assert.match(open, /detailOpener = document\.activeElement/, 'open remembers the focus opener');
  assert.match(open, /\$\('order-detail-close'\)\.focus\(/, 'open moves focus into the drawer');
  assert.match(close, /pickerReturnFocusTarget\(opener, returnOrderId, document\)/, 'close restores focus via the shared cascade (no black-hole)');
  // Esc + Tab-trap wired on the container
  assert.match(html, /if \(e\.key === 'Escape' && \$\('order-detail-modal'\)\.classList\.contains\('open'\)\) \{\s*closeOrderDetailModal\(\);/, 'Esc closes the drawer');
  assert.match(html, /\$\('order-detail-modal'\)\.addEventListener\('keydown', \(e\) => \{[\s\S]*?e\.key !== 'Tab'[\s\S]*?focusTrapTarget\(e\.shiftKey/, 'Tab is trapped within the drawer');
  ok('a11y: aria dialog + focus into drawer on open + shared-cascade restore on close + Esc + Tab-trap');
}

console.log(`\ndispatch-drawer: OK (${n} groups)`);
