// PORTAL-UI 1a (PLAN-portal-ui-slice1-sucursales r5 §5 + §11) — the shell: discovery (getMyBranches), the brand / branch
// switcher, the nav, and the ONE selection per page load.
//
//   • A selection = { brand_id, scope: rid | 'all' }, kept per uid in sessionStorage. Changing it (switcher, a strip chip,
//     «Mi sucursal») writes it and RELOADS the page, guarded by canLeave() — so one page = one selection, and the editor /
//     Ventas listeners each fire at most once per page (no in-page selection race).
//   • canLeave() = the editor's self-update guard (unsaved draft, pending write, publish, review, focused field) AND the ops
//     screens' own dirty / in-flight state. Blocked → nothing changes and D13 shows.
//   • Boot runs on the FIRST portal:signed-in of a page; any later sign-in on the same page is a guarded reload (A1).
//   • Persisted state is cleared ONLY on sign-out or an account change — never on the initial auth restoration (A2).
//   • The editor opens (app.js openEditor) ONLY for a branch holding catalog.read_editor; Ventas rides on it, owner-only (A3).
import { getMyBranches } from './api.js';
import { token } from './auth.js';
import { openEditor, editorCanLeave } from './app.js';
import * as L from './branch-logic.js';
import { $, el, icon, errBox, OFFLINE } from './ops-dom.js';
import { mountBranches } from './branches-view.js';
import { mountPausas } from './pausas.js';
import { mountAvailability } from './availability.js';

const SEL_KEY = (uid) => `sherpa.portal.sel.${uid}`;
const CACHE_KEY = (uid) => `sherpa.portal.branches.${uid}`;
const EDITOR_KEY = (uid, b) => `sherpa.portal.editor.${uid}.${b}`;
const BLOCKED_TEXT = 'Guardá o descartá tus cambios antes de cambiar de sucursal.';   // D13

const S = {
  uid: null, bootedUid: null, gen: 0,
  e1: null, partial: false, sel: null, view: 'menu', editorRid: null, sales: false, decision: null,
  reloadedOnce: false, waitTimer: null,
  busy: new Set(),            // ops requests in flight (pause / save / availability)
  dirty: new Set(),           // ops screens with unsaved edits
  views: {},
};

// ── storage (every access wrapped: private mode / blocked storage must never break the page) ──────────────────────────
const store = {
  get(k) { try { const v = sessionStorage.getItem(k); return v === null ? null : JSON.parse(v); } catch (_) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* not worth failing over */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch (_) { /* nothing to do */ } },
};
function clearPersisted(uid) {
  if (!uid) return;
  store.del(SEL_KEY(uid));
  store.del(CACHE_KEY(uid));
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) { const k = sessionStorage.key(i); if (k && k.startsWith(`sherpa.portal.editor.${uid}.`)) sessionStorage.removeItem(k); }
  } catch (_) { /* nothing to do */ }
}

// ── guards ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function canLeave() {
  let editorOk = true;
  try { editorOk = editorCanLeave() === true; } catch (_) { editorOk = false; }
  return editorOk && S.busy.size === 0 && S.dirty.size === 0;
}
// codex 1a r1 P1-2: the self-update coordinator must ask the SAME composite question. app.js registered the editor-only
// adapter at import (above); registering here replaces it with one whose canReload is the editor's guard AND the ops
// screens' dirty / in-flight state — same notice copy as app.js's.
try {
  const SC = window.SherpaClient;
  if (SC && !SC.inert) SC.registerAdapter({ canReload: () => canLeave(), blockedNotice: 'Nueva versión: guardá tus cambios para actualizar' });
} catch (_) {
  /* the module never breaks the portal */
}
function showBlocked(on) {
  const n = $('scopenote');
  if (n) { n.textContent = on ? BLOCKED_TEXT : ''; n.classList.toggle('hidden', !on); }
  if (on) toast(BLOCKED_TEXT);
}
const reload = () => { try { window.location.reload(); } catch (_) { /* test harness */ } };
// A guarded reload: now if allowed, else D13 and a once-per-second re-check (never releases a pending write).
export function requestReload() {
  if (canLeave()) { reload(); return true; }
  showBlocked(true);
  if (!S.waitTimer) S.waitTimer = globalThis.setInterval(() => { if (canLeave()) { globalThis.clearInterval(S.waitTimer); S.waitTimer = null; reload(); } }, 1000);
  return false;
}
// a NEW selection → persisted, then a guarded reload. Blocked → nothing changes.
export function select(next) {
  if (!S.uid || !next) return false;
  if (!canLeave()) { showBlocked(true); return false; }
  store.set(SEL_KEY(S.uid), { brand_id: next.brand_id, scope: next.scope });
  reload();
  return true;
}

// ── toast ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
let toastTimer = null;
export function toast(text) {
  const t = $('opstoast');
  if (!t) return;
  t.replaceChildren(icon('check'), document.createTextNode(text));
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ── auth lifecycle (§11 A1 / A2) ──────────────────────────────────────────────────────────────────────────────────────
document.addEventListener('portal:auth', (e) => {
  const uid = e && e.detail ? e.detail.uid : null;
  if (S.bootedUid !== null && (uid === null || uid !== S.bootedUid)) clearPersisted(S.bootedUid);   // sign-out / account change
  S.uid = uid;
  S.gen += 1;                                        // every in-flight ops response of the previous session is dropped
  if (uid === null) hideOpsChrome();
});

document.addEventListener('portal:signed-in', () => {
  if (S.bootedUid === null) { boot(); return; }
  requestReload();                                    // a later sign-in on this page: the NEW page reselects (A1)
});

// ── boot ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const decisionOf = (sel) => {
  if (!sel) return 'none';
  const rid = L.editorRidFor(sel, store.get(EDITOR_KEY(S.uid, sel.brand_id)));
  return JSON.stringify({ rid, sales: L.salesFor(sel, rid), b: sel.brand.branches.map((x) => [x.rid, x.caps]) });
};

async function boot() {
  S.bootedUid = S.uid;
  const gen = S.gen;
  const uid = S.uid;
  const cached = store.get(CACHE_KEY(uid));
  if (cached && Array.isArray(cached.branches)) apply(cached);
  let fresh;
  try {
    fresh = await getMyBranches({ token, assertLive: () => { if (gen !== S.gen) throw Object.assign(new Error('obsolete'), { kind: 'obsolete' }); } });
  } catch (err) {
    if (gen !== S.gen || (err && err.kind === 'obsolete')) return;
    if (!S.e1) showBootError(err);
    return;
  }
  if (gen !== S.gen) return;
  // codex 1a r1 P2-4: a reply with a DEGRADED row (one branch's read failed) is partial — it never replaces the cached list
  // or the persisted selection, and never reads as «no administra ningún local». (An access outage is E1's 503, above.)
  const partial = Array.isArray(fresh && fresh.branches) && fresh.branches.some((b) => b && b.degraded);
  if (!partial) store.set(CACHE_KEY(uid), fresh);
  if (!S.e1) { apply(fresh, { persist: !partial }); return; }
  if (partial) return;
  const sel = L.resolveSelection(fresh, store.get(SEL_KEY(uid)));
  if (decisionOf(sel) !== S.decision && !S.reloadedOnce) { S.reloadedOnce = true; requestReload(); return; }   // the caps changed
  S.e1 = fresh; S.sel = sel;
  renderChrome();
  renderViews();
}

function apply(e1, { persist = true } = {}) {
  S.e1 = e1;
  S.partial = !persist;
  const sel = L.resolveSelection(e1, store.get(SEL_KEY(S.uid)));
  S.sel = sel;
  S.decision = decisionOf(sel);
  if (!sel) { if (persist) showNoBranches(); else showBootError({ kind: 'Unavailable' }); return; }
  // codex 1a r2: a partial answer whose DEGRADED row is the persisted selection (or inside its «Todas») never falls back to
  // another branch — that would show the wrong branch's state; it is the outage box, and the stored scope stays
  if (!persist) {
    const stored = store.get(SEL_KEY(S.uid));
    const hit = stored && e1.branches.some((b) => b && b.degraded && b.brand_id === stored.brand_id && (stored.scope === 'all' || b.rid === stored.scope));
    if (hit) { S.sel = null; showBootError({ kind: 'Unavailable' }); return; }
  }
  if (persist) store.set(SEL_KEY(S.uid), { brand_id: sel.brand_id, scope: sel.scope });
  const remembered = store.get(EDITOR_KEY(S.uid, sel.brand_id));
  const rid = L.editorRidFor(sel, remembered);
  S.editorRid = rid;
  S.sales = L.salesFor(sel, rid);
  if (persist && rid && sel.scope !== 'all') store.set(EDITOR_KEY(S.uid, sel.brand_id), rid);
  renderChrome();
  if (rid) {
    const b = sel.brand.branches.find((x) => x.rid === rid);
    openEditor(rid, { name: b ? b.name : rid, sales: S.sales });   // ONCE per page (apply runs once; a later E1 only repaints)
  }
  renderViews();
}

function showBootError(err) {
  $('shopname').textContent = '—';
  $('shopsub').textContent = '';
  const d = $('detail');
  if (!d) return;
  const isOutage = !err || err.kind === 'Unavailable' || err.status === 0 || err.status >= 500;
  d.replaceChildren(isOutage ? errBox(OFFLINE[0], OFFLINE[1], reload) : errBox('No tenés acceso a este portal', 'Si esperabas ver tu restaurante, escribinos y lo revisamos.'));
}
function showNoBranches() {
  $('shopname').textContent = '—';
  $('shopsub').textContent = '';
  const d = $('detail');
  if (d) {
    const e = el('div', 'empty');
    e.append(el('b', null, 'Tu cuenta no administra ningún local todavía'), el('span', null, 'Si esperabas ver uno, escribinos y lo revisamos.'));
    d.replaceChildren(e);
  }
  hideOpsChrome();
}

// ── chrome: switcher, scope, nav ──────────────────────────────────────────────────────────────────────────────────────
function hideOpsChrome() {
  for (const id of ['scopewrap', 'navopslabel', 'navsuc', 'navpausas', 'mnsuc', 'mnpausas', 'mtop', 'mscopemenu', 'availstrip', 'menulock']) { const n = $(id); if (n) n.classList.add('hidden'); }
  for (const id of ['viewsuc', 'viewpausas']) { const n = $(id); if (n) { n.classList.add('hidden'); n.replaceChildren(); } }
  const app = $('app'); if (app) app.classList.remove('opsview');
}

function renderChrome() {
  const sel = S.sel;
  if (!sel) return;
  const brands = L.brandsOf(S.e1);
  const label = L.scopeLabel(sel);
  // the footer's role label (index.html says «Dueño» by default)
  const role = $('whorole');
  if (role) role.textContent = sel.owner ? 'Dueño' : (sel.locked ? `Gerente · ${sel.brand.branches[0].name}` : 'Gerente');
  // the brand switcher (the existing #switcher, re-labelled: brand name + scope)
  $('shopname').textContent = sel.brand.name;
  $('shopsub').textContent = label;
  const sw = $('switcher');
  const multiBrand = brands.length > 1;
  sw.classList.toggle('locked', !multiBrand);
  const chev = sw.querySelector('.chev'); if (chev) chev.classList.toggle('hidden', !multiBrand);
  sw.setAttribute('aria-expanded', 'false');
  const menu = $('switchmenu');
  menu.replaceChildren();
  for (const b of brands) {
    const it = el('button', `switchmenu-item${b.brand_id === sel.brand_id ? ' on' : ''}`);
    it.type = 'button';
    it.append(document.createTextNode(b.name), el('span', null, `${b.branches.length} ${b.branches.length === 1 ? 'sucursal' : 'sucursales'}`));
    it.addEventListener('click', () => { closeMenus(); if (b.brand_id !== sel.brand_id) select({ brand_id: b.brand_id, scope: null }); });
    menu.append(it);
  }
  // the scope button + menu
  $('scopewrap').classList.remove('hidden');
  const btn = $('scopebtn');
  btn.replaceChildren();
  btn.classList.toggle('locked', sel.locked);
  if (sel.locked) btn.append(spanIcon('lock'));
  else if (sel.scope === 'all') btn.append(spanIcon('grid'));
  else btn.append(dotFor(sel.brand.branches.find((x) => x.rid === sel.scope)));
  btn.append(el('span', 'sl', label));
  const canOpen = !sel.locked;
  if (canOpen) btn.append(el('span', 'scchev', '▾'));
  btn.setAttribute('aria-expanded', 'false');
  fillScopeMenu($('scopemenu'), 'switchmenu-item');
  // mobile top bar
  $('mtop').classList.remove('hidden');
  $('mbrand').textContent = sel.brand.name;
  $('mscope').textContent = label;
  $('mchev').classList.toggle('hidden', !canOpen && !multiBrand);
  fillScopeMenu($('mscopemenu'), 'msi', true);
  // nav
  const nav = L.navModel(sel);
  $('navopslabel').classList.remove('hidden');
  $('navsuc').classList.remove('hidden');
  $('navsuctext').textContent = nav.sucLabel;
  const cnt = $('navsuccount');
  cnt.classList.toggle('hidden', nav.sucCount === null);
  cnt.textContent = nav.sucCount === null ? '' : String(nav.sucCount);
  $('navpausas').classList.toggle('hidden', !nav.pause);
  $('mnsuc').classList.remove('hidden');
  $('mnsuc').textContent = nav.sucLabel;
  $('mnpausas').classList.toggle('hidden', !nav.pause);
  $('mnav').classList.add('show');
  $('mnventas').classList.toggle('hidden', !S.sales);
}
function spanIcon(name) { const s = el('span', 'lk'); s.append(icon(name)); return s; }
function dotFor(b) {
  const d = el('span', 'scdot');
  const st = b ? L.stateModel(b, Date.now()).state : 'unknown';
  d.classList.add(`st-${st}`);
  return d;
}
function fillScopeMenu(menu, itemCls, withBrands) {
  const sel = S.sel;
  menu.replaceChildren();
  const list = sel.brand.branches;
  // codex 1a r1 P2-5: a locked BRANCH (one-branch manager) never hides the other BRANDS on mobile — the lock is within a brand
  if (withBrands) {
    for (const b of L.brandsOf(S.e1)) {
      if (b.brand_id === sel.brand_id) continue;
      const it = el('button', `scopeitem ${itemCls}`, b.name);
      it.type = 'button';
      it.addEventListener('click', () => { closeMenus(); select({ brand_id: b.brand_id, scope: null }); });
      menu.append(it);
    }
  }
  if (sel.locked) return;
  if (sel.owner && list.length > 1) {
    const all = el('button', `scopeitem ${itemCls}${sel.scope === 'all' ? (itemCls === 'msi' ? ' msion' : ' on') : ''}`);
    all.type = 'button';
    all.append(document.createTextNode(itemCls === 'msi' ? 'Todas' : 'Todas las sucursales'));
    if (itemCls !== 'msi') all.append(el('span', null, String(list.length)));
    all.addEventListener('click', () => { closeMenus(); if (sel.scope !== 'all') select({ brand_id: sel.brand_id, scope: 'all' }); });
    menu.append(all);
  }
  for (const b of list) {
    const it = el('button', `scopeitem ${itemCls}${sel.scope === b.rid ? (itemCls === 'msi' ? ' msion' : ' on') : ''}`);
    it.type = 'button';
    it.append(document.createTextNode(b.name));
    if (itemCls !== 'msi') it.append(el('span', null, L.stateModel(b, Date.now()).label));
    it.addEventListener('click', () => { closeMenus(); if (sel.scope !== b.rid) select({ brand_id: sel.brand_id, scope: b.rid }); });
    menu.append(it);
  }
}
function closeMenus() {
  for (const [m, b] of [['switchmenu', 'switcher'], ['scopemenu', 'scopebtn'], ['mscopemenu', 'mswitch']]) {
    const menu = $(m); if (menu) menu.classList.add('hidden');
    const btn = $(b); if (btn) btn.setAttribute('aria-expanded', 'false');
  }
}
function toggleMenu(m, b) {
  const menu = $(m), btn = $(b);
  if (!menu || !btn) return;
  const open = menu.classList.contains('hidden') && menu.childNodes.length > 0;
  closeMenus();
  if (open) { menu.classList.remove('hidden'); btn.setAttribute('aria-expanded', 'true'); }
}
$('switcher').addEventListener('click', (e) => { e.stopPropagation(); if (S.sel && L.brandsOf(S.e1).length > 1) toggleMenu('switchmenu', 'switcher'); });
$('scopebtn').addEventListener('click', (e) => { e.stopPropagation(); if (S.sel && !S.sel.locked) toggleMenu('scopemenu', 'scopebtn'); });
$('mswitch').addEventListener('click', (e) => { e.stopPropagation(); if (S.sel) toggleMenu('mscopemenu', 'mswitch'); });
document.addEventListener('click', (e) => { if (!e.target.closest || (!e.target.closest('.switchwrap') && !e.target.closest('#mtop') && !e.target.closest('#mscopemenu'))) closeMenus(); });

// ── views ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const NAV = [['navprod', 'menu'], ['navventas', 'ventas'], ['navsuc', 'suc'], ['navpausas', 'pausas'], ['mnprod', 'menu'], ['mnventas', 'ventas'], ['mnsuc', 'suc'], ['mnpausas', 'pausas']];
function markNav(view) {
  for (const [id, v] of NAV) {
    const n = $(id); if (!n) continue;
    const on = v === view;
    n.classList.toggle('on', on);
    if (on) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current');
  }
}
export function goto(view, opts = {}) {
  if (view === 'menu' || view === 'ventas') { $(view === 'menu' ? 'navprod' : 'navventas').click(); return; }   // ventas.js owns those two
  S.view = view;
  $('viewmenu').classList.add('hidden');
  $('viewventas').classList.add('hidden');
  const isSuc = view === 'suc', isPausas = view === 'pausas';
  $('viewsuc').classList.toggle('hidden', !isSuc);
  $('viewpausas').classList.toggle('hidden', !isPausas);
  const app = $('app');
  app.classList.remove('vview');
  app.classList.add('opsview');
  markNav(view);
  if (view === 'suc') S.views.suc && S.views.suc.show(opts);
  if (view === 'pausas') S.views.pausas && S.views.pausas.show(opts);
  if (typeof window !== 'undefined' && window.scrollTo) { try { window.scrollTo(0, 0); } catch (_) { /* jsdom-free harness */ } }
}
// ventas.js's own nav handlers run first (they were registered at import); these hide the ops views behind them
function leaveOps(v) {
  S.view = v;
  $('viewsuc').classList.add('hidden'); $('viewpausas').classList.add('hidden');
  $('app').classList.remove('opsview');
  $('sucbar').classList.remove('show');
  markNav(v);
}
$('navsuc').addEventListener('click', () => goto('suc'));
$('navpausas').addEventListener('click', () => goto('pausas'));
$('mnsuc').addEventListener('click', () => goto('suc'));
$('mnpausas').addEventListener('click', () => goto('pausas'));
$('navprod').addEventListener('click', () => leaveOps('menu'));
$('mnprod').addEventListener('click', () => leaveOps('menu'));
$('navventas').addEventListener('click', () => leaveOps('ventas'));
$('mnventas').addEventListener('click', () => leaveOps('ventas'));

const ctx = {
  get sel() { return S.sel; },
  get e1() { return S.e1; },
  get uid() { return S.uid; },
  get editorRid() { return S.editorRid; },
  alive: (gen) => gen === S.gen,
  gen: () => S.gen,
  token,
  toast,
  select,
  goto,
  canLeave,
  setBusy(key, on) { if (on) S.busy.add(key); else S.busy.delete(key); },
  setDirty(key, on) { if (on) S.dirty.add(key); else S.dirty.delete(key); if (!on && S.dirty.size === 0) showBlocked(false); },
  // patch one branch in memory (and the uid cache) after a successful write, then repaint every view
  patchBranch(rid, patch) {
    if (!S.e1) return;
    const b = S.e1.branches.find((x) => x.rid === rid);
    if (!b) return;
    Object.assign(b, patch);
    if (!S.partial) store.set(CACHE_KEY(S.uid), S.e1);   // a partial (degraded) list is never cached
    S.sel = L.resolveSelection(S.e1, store.get(SEL_KEY(S.uid)));
    renderChrome();
    renderViews();
  },
};

function renderViews() {
  if (!S.sel) return;
  if (!S.views.suc) S.views.suc = mountBranches($('viewsuc'), ctx);
  if (!S.views.pausas) S.views.pausas = mountPausas($('viewpausas'), ctx);
  if (!S.views.avail) S.views.avail = mountAvailability(ctx);
  S.views.suc.render();
  S.views.pausas.render();
  S.views.avail.render();
}

// test-only view of the shell's state (never read by the page)
export const _shellState = S;
