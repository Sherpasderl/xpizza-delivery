// PLAN-portal-shell-no-shift R1 + R5 — owner-approved MOCKUP-portal-shell-wait.html, option A (2026-11-01): the sign-in card
// holds with «Abriendo tu portal…» while the session opens, and the portal is revealed ONCE, already in its final shape.
//   • boot.js (jsdom over the real index.html; its five feature modules stubbed — they are covered by their own suites): the
//     card's wait state, the single reveal on `portal:ready`, the form back on sign-out, and no login form on a reload that had a
//     session (R5).
//   • shell.js (the ventas harness, real modules, auth stubbed): `portal:ready` fires EXACTLY ONCE per page on every terminal
//     outcome of discovery, and only once the chrome it reveals is already rendered.
// Run: node --test xpizza-portal/shell-wait.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DIR, installDom, installFetch, loadModules, okJson, errJson, settle } from './ventas-harness.mjs';

const require = createRequire(import.meta.url);
const { JSDOM } = createRequire(join(DIR, '..', 'xpizza-functions', 'package.json'))('jsdom');
const { capsFor } = require('../xpizza-functions/access/membership.js');
const HTML = readFileSync(join(DIR, 'index.html'), 'utf8');
const WAIT = 'Abriendo tu portal…';

// ── boot.js over the real page ────────────────────────────────────────────────────────────────────────────────────────
// boot.js's own imports: auth.js → a stub that hands the test the watchAuth callback; the five feature modules → empty.
async function bootPage({ hint = false } = {}) {
  const dom = new JSDOM(HTML, { url: 'https://portal.test/', pretendToBeVisual: true });
  const w = dom.window;
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'localStorage', 'sessionStorage']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  if (hint) w.localStorage.setItem('sherpa.portal.session', '1');
  const tag = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const files = [];
  const put = (name, src) => { const p = join(DIR, `__sw-${name}.${tag}.mjs`); writeFileSync(p, src); files.push(p); return `./__sw-${name}.${tag}.mjs`; };
  const empty = put('empty', 'export {};\n');
  const auth = put('auth', 'export const login = async () => {}; export const logout = async () => {}; export const authErrorMessage = () => "";\n'
    + 'export const watchAuth = (cb) => { globalThis.__authCb = cb; };\n');
  let src = readFileSync(join(DIR, 'boot.js'), 'utf8').replace("from './auth.js'", `from '${auth}'`);
  for (const m of ['app.js', 'ventas.js', 'shell.js', 'team.js', 'pubreq.js']) {
    const re = new RegExp(`import '\\./${m.replace('.', '\\.')}';`);
    assert.ok(re.test(src), `premise: boot.js imports ./${m}`);
    src = src.replace(re, `import '${empty}';`);
  }
  const bootFile = put('boot', src);
  try { await import(`${pathToFileURL(join(DIR, bootFile.slice(2))).href}?t=${tag}`); } finally { for (const f of files) { try { unlinkSync(f); } catch (_) { /* best effort */ } } }
  const d = w.document;
  return { w, d, signIn: (email = 'duena@ejemplo.test') => globalThis.__authCb({ uid: 'u1', email }), signOut: () => globalThis.__authCb(null) };
}
const shown = (d, id) => !d.getElementById(id).classList.contains('hidden');
const lede = (d) => d.querySelector('#gate .gatecard .lede');

test('A — signed in, discovery pending: the card holds with «Abriendo tu portal…» (role=status, form hidden); the portal is not shown', async () => {
  const { d, signIn } = await bootPage();
  assert.ok(shown(d, 'loginform') && !shown(d, 'app'), 'premise: a first visit shows the sign-in form');
  signIn();
  assert.ok(shown(d, 'gate'), 'the card stays');
  assert.ok(!shown(d, 'loginform'), 'the form is gone');
  assert.equal(lede(d).textContent, WAIT);
  assert.equal(lede(d).getAttribute('role'), 'status');
  assert.ok(lede(d).classList.contains('wait'));
  assert.ok(!shown(d, 'app'), 'nothing of the portal paints before it is final');
});

test('A — `portal:ready` reveals the portal ONCE, in the same task: the card goes, the app shows', async () => {
  const { d, signIn } = await bootPage();
  signIn();
  d.dispatchEvent(new d.defaultView.CustomEvent('portal:ready'));
  assert.ok(!shown(d, 'gate') && shown(d, 'app'));
  d.dispatchEvent(new d.defaultView.CustomEvent('portal:ready'));   // a second one is a no-op
  assert.ok(!shown(d, 'gate') && shown(d, 'app'));
});

test('A — sign-out puts the form back exactly as it was (today\'s card), and hides the portal', async () => {
  const { d, signIn, signOut } = await bootPage();
  const before = lede(d).textContent;
  signIn(); d.dispatchEvent(new d.defaultView.CustomEvent('portal:ready'));
  signOut();
  assert.ok(shown(d, 'gate') && shown(d, 'loginform') && !shown(d, 'app'));
  assert.equal(lede(d).textContent, before);
  assert.equal(lede(d).getAttribute('role'), null);
  assert.ok(!lede(d).classList.contains('wait'));
});

test('A — `portal:ready` before any sign-in (or after a sign-out) never reveals the portal', async () => {
  const { d, signIn, signOut } = await bootPage();
  d.dispatchEvent(new d.defaultView.CustomEvent('portal:ready'));
  assert.ok(shown(d, 'gate') && !shown(d, 'app'));
  signIn(); signOut();
  d.dispatchEvent(new d.defaultView.CustomEvent('portal:ready'));
  assert.ok(shown(d, 'gate') && shown(d, 'loginform') && !shown(d, 'app'));
});

test('R5 — a reload that HAD a session never paints the login form: the card opens in the wait state before auth answers', async () => {
  const { d, signIn } = await bootPage({ hint: true });
  assert.ok(!shown(d, 'loginform'), 'no form before the auth decision');
  assert.equal(lede(d).textContent, WAIT);
  assert.ok(!shown(d, 'app'));
  signIn();
  assert.equal(lede(d).textContent, WAIT);
});

test('R5 — the hint is set on sign-in and cleared on sign-out; a stale hint falls back to the form when auth says signed-out', async () => {
  const { w, d, signIn, signOut } = await bootPage({ hint: true });
  signOut();   // the stored session was gone after all
  assert.ok(shown(d, 'loginform') && !shown(d, 'app'));
  assert.equal(w.localStorage.getItem('sherpa.portal.session'), null);
  signIn();
  assert.equal(w.localStorage.getItem('sherpa.portal.session'), '1');
});

// ── shell.js: `portal:ready` on every terminal outcome ───────────────────────────────────────────────────────────────
const OWNER = capsFor({ owner: true }, 'member');
const WEEK = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((k) => [k, { open: true, start: '11:00', end: '22:00' }]));
const row = (rid, extra = {}) => ({ rid, brand_id: 'marca_s', role: 'owner', state: 'member', caps: OWNER, name: rid.toUpperCase(), identity_version: 7,
  editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: WEEK, phone: '+50433905521' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null, ...extra });
const E1 = (branches, brands) => ({ brands: brands || [{ brand_id: 'marca_s', name: 'Marca S' }], branches, membership_writes_enabled: false });
function storage(seed = {}) {
  const m = new Map(Object.entries(seed));
  globalThis.sessionStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}
async function shellRun(answer, { seed } = {}) {
  storage(seed);
  const byId = installDom();
  globalThis.window.location = { reload: () => {} };
  globalThis.window.scrollTo = () => {};
  globalThis.__branchesDirect = true;
  installFetch((fn) => {
    if (fn === 'getMyBranches') return typeof answer === 'function' ? answer() : answer;
    if (fn === 'getEditableCatalog') return okJson({ source: { restaurant_id: 'r_a', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    return errJson(404, { error: 'not_found' });
  });
  const seen = [];
  document.addEventListener('portal:ready', () => seen.push({ shop: byId.get('shopname').textContent, detail: byId.get('detail').children.length }));
  const mods = await loadModules(['app', 'ventas', 'shell']);
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'uSw' } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle(25);
  return { seen, mods, byId };
}

test('shell — an owner\'s E1: `portal:ready` once, after the chrome is rendered (the restaurant is already named)', async () => {
  const { seen } = await shellRun(okJson(E1([row('r_a'), row('r_b')])));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].shop, 'Marca S', 'the chrome was rendered BEFORE the reveal');
});

test('shell — no branches («no administra ningún local»): `portal:ready` once, with the empty state already in place', async () => {
  const { seen } = await shellRun(okJson(E1([])));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].shop, '—');
  assert.ok(seen[0].detail > 0, 'the empty state is in #detail before the reveal');
});

test('shell — discovery outage (503) and no access (403): `portal:ready` once each, with the error box already in place', async () => {
  for (const status of [503, 403]) {
    const { seen } = await shellRun(errJson(status, { error: status === 503 ? 'unavailable' : 'not_authorized' }));
    assert.equal(seen.length, 1, `${status}: one reveal`);
    assert.ok(seen[0].detail > 0, `${status}: the box is rendered before the reveal`);
  }
});

test('shell — a cached E1 reveals at once from the cache; the fresh answer repaints in place, never a second reveal', async () => {
  const cached = E1([row('r_a'), row('r_b')]);
  const { seen } = await shellRun(okJson(E1([row('r_a'), row('r_b')])), { seed: { 'sherpa.portal.branches.uSw': JSON.stringify(cached) } });
  assert.equal(seen.length, 1);
});

test('shell — a LATER sign-in whose reload is held by unsaved work reveals the portal (its notice lives there); never a stuck card', async () => {
  const { seen, mods } = await shellRun(okJson(E1([row('r_a')])));
  assert.equal(seen.length, 1, 'premise: the first boot revealed once');
  let reloads = 0;
  globalThis.window.location = { reload: () => { reloads += 1; } };
  mods.shell._shellState.dirty.add('unsaved');   // unsaved work holds the reload
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'uSw' } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle(5);
  assert.equal(reloads, 0, 'premise: the reload is held');
  assert.equal(seen.length, 2, 'the held reload reveals');
  mods.shell._shellState.dirty.delete('unsaved');
  if (mods.shell._shellState.waitTimer) { clearInterval(mods.shell._shellState.waitTimer); mods.shell._shellState.waitTimer = null; }
});
