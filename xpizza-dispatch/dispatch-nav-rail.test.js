// xpizza-dispatch/dispatch-nav-rail.test.js
//
// Slice D2 — nav rail (design: docs/superpowers/specs/2026-09-20-dispatch-D-chrome-rail-drawer-design.md).
// The left icon rail is NAVIGATION OVER EXISTING SURFACES — no new backend. These guards EXECUTE the real
// initNavRail wiring against a DOM shim so each item's route to its existing surface is proven at runtime
// (not just in source text) [structural-tests-blind-to-runtime], plus structural presence/mapping.
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const fnSrc = (name) => { const s = html.indexOf(`function ${name}(`); const e = html.indexOf('\n})();', s); return s < 0 || e < 0 ? null : html.slice(s, e + 2); };

// ─────────────────────────────────────────────────────────────────────────────
// 1. Structure — the rail + its 7 items (Despacho active, Ajustes disabled), tooltips, Comms badge, brand mark,
//    the 54px layout shift, and the added line icons.
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.match(html, /<nav class="nav-rail" id="nav-rail" aria-label="Navegación">/, 'nav rail present');
  const items = ['despacho', 'pedidos', 'comms', 'programados', 'reconciliacion', 'repartidores', 'ajustes'];
  for (const it of items) assert.match(html, new RegExp(`data-nav="${it}"`), `nav item ${it} present`);
  assert.match(html, /data-nav="despacho"[^>]*class="nav on"|class="nav on" data-nav="despacho"/, 'Despacho starts active');
  assert.match(html, /<button class="nav on" data-nav="despacho"[^>]*aria-current="page">/, 'Despacho is aria-current');
  assert.match(html, /data-nav="ajustes"[^>]*disabled|disabled[^>]*data-nav="ajustes"/, 'Ajustes is a disabled placeholder');
  assert.match(html, /data-nav="ajustes" data-tip="Ajustes · próximamente"/, 'Ajustes tooltip = próximamente');
  assert.match(html, /<span class="nav-badge" id="nav-comms-badge" hidden>/, 'Comms nav badge present + hidden by default');
  assert.match(html, /<div class="nav-mk" aria-hidden="true">X<\/div>/, 'brand mark present');
  // each item has a tooltip
  for (const it of items) assert.match(html, new RegExp(`data-nav="${it}" data-tip="[^"]+"`), `nav item ${it} has a tooltip`);
  // added line icons + layout shift
  for (const ic of ['i-tower', 'i-users', 'i-gear']) assert.match(html, new RegExp(`<symbol id="${ic}"`), `sprite icon ${ic} added`);
  assert.match(html, /header\.topbar, \.app \{ margin-left: 54px; \}/, 'topbar + app shift right by the 54px rail');
  ok('nav rail: 7 items (Despacho active, Ajustes disabled placeholder), tooltips, Comms badge, brand mark, 54px shift, icons');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. EXECUTED routing — each nav click fires the correct EXISTING handler (rail toggle / rtab / messages
//    modal / scroll). Run the real initNavRail against a shim; dispatch clicks; assert the recorded effects.
// ─────────────────────────────────────────────────────────────────────────────
{
  const src = fnSrc('initNavRail');
  assert.ok(src, 'located initNavRail');

  const calls = { togRail: [], openMessages: 0, scrolled: [], rtabClicked: [] };
  const mkEl = (extra = {}) => {
    const cls = new Set(), attr = {}, ls = {};
    return {
      classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, on) => { on ? cls.add(c) : cls.delete(c); }, contains: c => cls.has(c) },
      setAttribute: (k, v) => { attr[k] = v; }, removeAttribute: k => { delete attr[k]; }, getAttribute: k => attr[k], hasAttribute: k => k in attr,
      addEventListener: (t, fn) => { (ls[t] || (ls[t] = [])).push(fn); }, dispatch: (t, e) => { (ls[t] || []).forEach(fn => fn(e)); },
      scrollIntoView: () => { calls.scrolled.push(extra.name); }, ...extra,
    };
  };
  const app = mkEl();                                   // starts with NO open classes → ensureRailOpen must togRail
  const navs = {};
  for (const k of ['despacho', 'pedidos', 'comms', 'programados', 'reconciliacion', 'repartidores']) navs[k] = mkEl({ dataset: { nav: k }, disabled: false });
  navs.ajustes = mkEl({ dataset: { nav: 'ajustes' }, disabled: true });
  const navList = Object.values(navs);
  navs.despacho.classList.add('on');
  const rail = { querySelectorAll: () => navList };
  const rtab = (tab) => mkEl({ _tab: tab, click() { calls.rtabClicked.push(tab); } });
  const rtabs = { pedidos: rtab('pedidos'), caja: rtab('caja') };
  const els = { 'nav-rail': rail, app, 'pedidos-list': mkEl({ name: 'pedidos-list' }), 'drivers-live-group': mkEl({ name: 'drivers-live-group' }) };
  const $ = (id) => els[id] || null;
  const doc = {
    querySelector: (sel) => {
      const m = sel.match(/data-tab="(\w+)"/); if (m) return rtabs[m[1]] || null;
      if (sel.includes('[data-cat="Programados"]')) return mkEl({ name: 'programados-anchor' });
      return null;
    },
  };
  const togRail = (cls) => { calls.togRail.push(cls); app.classList.add(cls); };
  const openMessagesModal = () => { calls.openMessages++; };
  new Function('$', 'document', 'togRail', 'openMessagesModal', `${src}\ninitNavRail();`)($, doc, togRail, openMessagesModal);

  const click = (k) => navs[k].dispatch('click', {});
  // despacho → ensure both rails open
  click('despacho');
  assert.deepStrictEqual(calls.togRail, ['left-open', 'right-open'], 'Despacho ensures both rails open');
  // pedidos → right rail + pedidos rtab + scroll pedidos-list
  calls.togRail = []; calls.rtabClicked = []; calls.scrolled = []; app.classList.remove('right-open');
  click('pedidos');
  assert.deepStrictEqual(calls.rtabClicked, ['pedidos'], 'Pedidos activates the En Fila rtab');
  assert.ok(calls.scrolled.includes('pedidos-list'), 'Pedidos scrolls the list into view');
  assert.ok(navs.pedidos.classList.contains('on') && !navs.despacho.classList.contains('on'), 'Pedidos becomes the active nav');
  // comms → the shipped messages MODAL; active highlight must NOT move
  calls.rtabClicked = [];
  click('comms');
  assert.strictEqual(calls.openMessages, 1, 'Comms opens the messages modal');
  assert.ok(navs.pedidos.classList.contains('on') && !navs.comms.classList.contains('on'), 'a modal does not move the active nav');
  // programados → right rail + pedidos rtab + scroll the Programados subsection anchor
  calls.rtabClicked = []; calls.scrolled = []; app.classList.remove('right-open');
  click('programados');
  assert.deepStrictEqual(calls.rtabClicked, ['pedidos'], 'Programados activates the En Fila rtab');
  assert.ok(calls.scrolled.includes('programados-anchor'), 'Programados scrolls to the scheduled subsection anchor');
  // reconciliacion → caja rtab
  calls.rtabClicked = []; app.classList.remove('right-open');
  click('reconciliacion');
  assert.deepStrictEqual(calls.rtabClicked, ['caja'], 'Reconciliación activates the Caja rtab');
  // repartidores → scroll roster
  calls.scrolled = []; app.classList.remove('right-open'); calls.togRail = [];
  click('repartidores');
  assert.ok(calls.togRail.includes('right-open'), 'Repartidores ensures the right rail is open');
  assert.ok(calls.scrolled.includes('drivers-live-group'), 'Repartidores scrolls the roster into view');
  // ajustes → disabled → NOTHING fires
  calls.togRail = []; calls.rtabClicked = []; calls.scrolled = []; const before = calls.openMessages;
  click('ajustes');
  assert.deepStrictEqual([calls.togRail, calls.rtabClicked, calls.scrolled, calls.openMessages], [[], [], [], before], 'Ajustes (disabled) is a no-op');
  ok('EXECUTED routing: each nav item drives its existing surface; Comms=modal (no active move); Ajustes=no-op');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Comms badge MIRRORS the topbar unhandled count (single source), and the Programados scroll anchor exists.
// ─────────────────────────────────────────────────────────────────────────────
{
  const s = html.indexOf('function updateMessagesBadge(');
  const src = html.slice(s, html.indexOf('\n}\n', s) + 2);
  const state = {};
  const mk = () => ({ _t: '', _h: false, classList: { toggle() {} }, set textContent(v) { this._t = v; }, get textContent() { return this._t; }, set hidden(v) { this._h = v; }, get hidden() { return this._h; } });
  const els = { 'msg-btn': mk(), 'msg-badge': mk(), 'nav-comms-badge': mk() };
  const $ = (id) => els[id];
  new Function('$', `${src}\nreturn updateMessagesBadge;`)($)(3);
  assert.strictEqual(els['nav-comms-badge'].textContent, '3', 'nav badge shows the unhandled count');
  assert.strictEqual(els['nav-comms-badge'].hidden, false, 'nav badge visible when count > 0');
  new Function('$', `${src}\nreturn updateMessagesBadge;`)($)(0);
  assert.strictEqual(els['nav-comms-badge'].hidden, true, 'nav badge hidden when count is 0');
  // the En Fila category anchor the Programados route scrolls to
  assert.match(html, /`<div class="q-cat" data-cat="\$\{title\}">/, 'En Fila categories carry a data-cat anchor (Programados scroll target)');
  ok('Comms nav badge mirrors the topbar unhandled count; Programados scroll anchor present');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. No new backend — the nav wiring only reuses existing handlers (togRail / rtab click / openMessagesModal /
//    scrollIntoView); no DB write, subscription, or money/assign call.
// ─────────────────────────────────────────────────────────────────────────────
{
  const src = fnSrc('initNavRail');
  assert.doesNotMatch(src, /\bsubscribe/i, 'nav rail adds no subscription');
  assert.doesNotMatch(src, /\.ref\(|\bfirebase\b|database\(|XPD\.(set|update|write|create|delete|save|assign|resolve|cancel|refund)\w*\(/i, 'nav rail makes no DB write / money call');
  assert.match(src, /openMessagesModal\(\)/, 'Comms reuses openMessagesModal');
  assert.match(src, /togRail\(/, 'rails reuse togRail');
  assert.match(src, /\.rtab\[data-tab=/, 'tabs reuse the existing rtab handler');
  ok('no new backend: nav rail is navigation over existing surfaces only');
}

console.log(`\ndispatch-nav-rail: OK (${n} groups)`);
