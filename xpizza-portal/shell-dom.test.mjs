// PORTAL-UI follow-up (codex follow-up r1): registerView / setNavBadge under a REAL DOM (jsdom over the shipped index.html),
// so DOM-API assumptions the array-based harness cannot see (Element.children is an HTMLCollection, textContent rewrites
// drop child nodes, Node.after) are exercised for real. The real app.js / ventas.js / shell.js load (auth stubbed, as in
// ventas-harness.mjs); fetch is stubbed per function.
// Run: node --test xpizza-portal/shell-dom.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { DIR, loadModules, installFetch, okJson, errJson } from './ventas-harness.mjs';

const { JSDOM } = createRequire(join(DIR, '..', 'xpizza-functions', 'package.json'))('jsdom');
const HTML = readFileSync(join(DIR, 'index.html'), 'utf8');
const OWNER_CAPS = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'stats.read', 'availability.set', 'location.prep', 'location.pause', 'location.hours'];
const branch = (rid) => ({ rid, brand_id: 'marca_s', role: 'owner', state: 'member', caps: OWNER_CAPS, name: rid.toUpperCase(),
  identity_version: 2, editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null });
const MENU = () => okJson({ source: { restaurant_id: 'r_a', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function realPage(e1) {
  const dom = new JSDOM(HTML, { url: 'https://portal.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};   // jsdom does not implement it
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'MutationObserver', 'sessionStorage', 'localStorage']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  globalThis.__branchesDirect = true;
  installFetch((fn) => {
    if (fn === 'getMyBranches') return okJson(e1);
    if (fn === 'getEditableCatalog') return MENU();
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    return errJson(404, { error: 'not_found' });
  });
  const mods = await loadModules();
  return { dom, w, d: w.document, mods };
}
async function signIn(uid) {
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle(30);
}
const view = (log, extra = {}) => ({ id: 'equipo', group: 'Negocio', label: 'Equipo de trabajo', icon: 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21a8 8 0 0 1 16 0',
  visible: (sel) => sel.role === 'owner' && sel.membership_writes_enabled === true,
  mount: (el) => { log.push('mount'); el.textContent = 'Equipo'; }, unmount: () => log.push('unmount'), canLeave: () => true, ...extra });

test('REAL DOM: registerView places the item after Ventas (desktop + mobile) with its icon; setNavBadge works on an HTMLCollection', async () => {
  const { d, mods } = await realPage({ brands: [{ brand_id: 'marca_s', name: 'Marca S' }], branches: [branch('r_a'), branch('r_b')], membership_writes_enabled: true });
  const log = [];
  mods.shell.registerView(view(log));
  await signIn('uOwnerDom01');
  const [r] = mods.shell._registered;
  assert.ok(d.getElementById('navventas').nextElementSibling === r.nav, 'desktop: right after Ventas');
  assert.ok(d.getElementById('mnventas').nextElementSibling === r.mn, 'mobile: right after Ventas');
  assert.ok(!r.nav.classList.contains('hidden') && !d.getElementById('navbiz').classList.contains('hidden'));
  assert.equal(r.nav.querySelector('svg path').getAttribute('d'), view([]).icon);
  assert.ok(r.nav.children instanceof d.defaultView.HTMLCollection, 'non-vacuity: a real HTMLCollection');
  mods.shell.setNavBadge('menu', '1');
  mods.shell.setNavBadge('equipo', '2');
  assert.equal(d.querySelector('#navprod [data-navbadge="1"]').textContent, '1');
  assert.equal(d.querySelector('#mnprod [data-navbadge="1"]').textContent, '1');
  assert.equal(r.nav.querySelector('[data-navbadge="1"]').textContent, '2');
  mods.shell.setNavBadge('menu', null);
  assert.ok(d.querySelector('#navprod [data-navbadge="1"]').classList.contains('hidden'));
});

test('REAL DOM: a badge on mobile Sucursales survives the chrome repaint that rewrites its label; unknown ids are no-ops', async () => {
  const { d, mods } = await realPage({ brands: [{ brand_id: 'marca_s', name: 'Marca S' }], branches: [branch('r_a'), branch('r_b')], membership_writes_enabled: false });
  mods.shell.setNavBadge('suc', '3');                      // before the first chrome render
  await signIn('uOwnerDom02');
  assert.equal(d.querySelector('#mnsuc [data-navbadge="1"]').textContent, '3', 'applied after the label was written');
  assert.equal(d.querySelector('#navsuc [data-navbadge="1"]').textContent, '3');
  assert.equal(d.getElementById('mnsuc').firstChild.nodeType, 3, 'non-vacuity: renderChrome rewrote the label (a text node first)');
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'nada']) assert.doesNotThrow(() => mods.shell.setNavBadge(id, 'x'), id);
  assert.equal(d.querySelectorAll('[data-navbadge="1"]').length, 2, 'no stray badge anywhere');
});

test('REAL DOM: clicking the already-open registered view does not mount it twice', async () => {
  const { mods } = await realPage({ brands: [{ brand_id: 'marca_s', name: 'Marca S' }], branches: [branch('r_a')], membership_writes_enabled: true });
  const log = [];
  mods.shell.registerView(view(log));
  await signIn('uOwnerDom03');
  const [r] = mods.shell._registered;
  r.nav.click();
  r.nav.click();
  r.mn.click();
  assert.deepEqual(log, ['mount'], 'one mount, no unmount');
  document.getElementById('navprod').click();
  assert.deepEqual(log, ['mount', 'unmount']);
  r.nav.click();
  assert.deepEqual(log, ['mount', 'unmount', 'mount'], 'a fresh enter mounts again');
});
