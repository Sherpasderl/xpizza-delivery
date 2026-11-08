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
// The real index.html + the real styles.css (inlined, so visibility is the CSS's own verdict) + gate-early.js run as the page
// runs it (a classic script, before the module graph). boot.js's imports: auth.js → a stub that hands the test the watchAuth
// callback; the five feature modules → empty. Timers are node:test's mock timers (the deadlines are proven, not assumed).
const CSS = readFileSync(join(DIR, 'styles.css'), 'utf8');
const EARLY = (() => { try { return readFileSync(join(DIR, 'gate-early.js'), 'utf8'); } catch (_) { return ''; } })();   // RED-first: absent → assertions fail, not the load
function pageDom({ hint = false } = {}) {
  const dom = new JSDOM(HTML.replace('<link rel="stylesheet" href="./styles.css">', `<style>${CSS}</style>`), { url: 'https://portal.test/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window;
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'localStorage', 'sessionStorage']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  if (hint) w.localStorage.setItem('sherpa.portal.session', '1');
  w.setTimeout = (fn, ms) => globalThis.setTimeout(fn, ms);   // the page's timers are the (mocked) node ones
  w.eval(EARLY);                                                // <head>: before the module graph, before the first paint
  return { dom, w, d: w.document };
}
async function loadBoot(w) {
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
}
async function bootPage(opts) {
  const p = pageDom(opts);
  await loadBoot(p.w);
  return { ...p, signIn: (email = 'duena@ejemplo.test') => globalThis.__authCb({ uid: 'u1', email }), signOut: () => globalThis.__authCb(null) };
}
// shown = the element and every ancestor render (no display:none from the stylesheet, no [hidden])
const shown = (d, id) => { for (let n = d.getElementById(id); n && n.nodeType === 1; n = n.parentElement) { if (n.hidden || d.defaultView.getComputedStyle(n).display === 'none') return false; } return true; };
const ready = (d) => d.dispatchEvent(new d.defaultView.CustomEvent('portal:ready'));
function assertWaitCard(d) {
  assert.ok(shown(d, 'gate'), 'the card stays');
  assert.ok(!shown(d, 'loginform'), 'the form is gone');
  assert.ok(!shown(d, 'gatelede'), 'the sign-in lede gives way…');
  assert.ok(shown(d, 'gatewait'), '…to the one quiet line');
  assert.equal(d.getElementById('gatewait').textContent, WAIT);
  assert.equal(d.getElementById('gatewait').getAttribute('role'), 'status');
  assert.ok(d.getElementById('gatewait').classList.contains('wait') && d.getElementById('gatewait').classList.contains('lede'), 'the mockup\'s .lede.wait');
  assert.ok(!shown(d, 'app'), 'nothing of the portal paints before it is final');
  assert.ok(!shown(d, 'gatefail'));
}
function assertFormCard(d) {
  assert.ok(shown(d, 'gate') && shown(d, 'loginform') && shown(d, 'gatelede'));
  assert.ok(!shown(d, 'gatewait') && !shown(d, 'gatefail') && !shown(d, 'app'));
}

test('A — signed in, discovery pending: the card holds with «Abriendo tu portal…» (role=status, form hidden); the portal is not shown', async () => {
  const { d, signIn } = await bootPage();
  assertFormCard(d);   // a first visit: today's card
  signIn();
  assertWaitCard(d);
});

test('A — `portal:ready` reveals the portal ONCE, in the same task: the card goes, the app shows; a second one is a no-op', async () => {
  const { d, signIn } = await bootPage();
  signIn(); ready(d);
  assert.ok(!shown(d, 'gate') && shown(d, 'app'));
  ready(d);
  assert.ok(!shown(d, 'gate') && shown(d, 'app'));
});

test('A — sign-out puts today\'s card back (form, lede) and hides the portal', async () => {
  const { d, signIn, signOut } = await bootPage();
  signIn(); ready(d); signOut();
  assertFormCard(d);
});

test('A — `portal:ready` before any sign-in (or after a sign-out) never reveals the portal', async () => {
  const { d, signIn, signOut } = await bootPage();
  ready(d);
  assertFormCard(d);
  signIn(); signOut(); ready(d);
  assertFormCard(d);
});

test('R5 / P2 first paint — a page that HAD a session is in the wait state from gate-early.js, BEFORE the module graph runs', () => {
  const { d } = pageDom({ hint: true });   // boot.js has not run (nor loaded)
  assertWaitCard(d);
  const fresh = pageDom();
  assertFormCard(fresh.d);
});

test('R5 — the hint is set on sign-in and cleared on sign-out; a stale hint falls back to the form when auth says signed-out', async () => {
  const { w, d, signIn, signOut } = await bootPage({ hint: true });
  signOut();
  assertFormCard(d);
  assert.equal(w.localStorage.getItem('sherpa.portal.session'), null);
  signIn();
  assert.equal(w.localStorage.getItem('sherpa.portal.session'), '1');
});

test('P1 deadline (Codex r3 ruling) — a hint whose auth NEVER answers → after AUTH_DEADLINE_MS the RECOVERY card, never the form', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { d } = await bootPage({ hint: true });
  assertWaitCard(d);
  t.mock.timers.tick(5999);
  assertWaitCard(d);
  t.mock.timers.tick(1);
  assert.ok(shown(d, 'gatefail'), 'the outage box + «Reintentar»');
  assert.ok(!shown(d, 'loginform') && !shown(d, 'gatewait') && !shown(d, 'app'), 'never the form: a deadline is not a signed-out answer');
  assert.equal(d.activeElement, d.getElementById('gatefailbtn'));
});

test('P1 deadline — signed in, discovery NEVER ends: after DISCOVERY_DEADLINE_MS `portal:deadline` asks the shell for its retry state', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { d, signIn } = await bootPage();
  const asked = [];
  d.addEventListener('portal:deadline', () => asked.push(1));
  signIn();
  t.mock.timers.tick(19999);
  assert.equal(asked.length, 0);
  t.mock.timers.tick(1);
  assert.equal(asked.length, 1);
  assert.ok(shown(d, 'app') && !shown(d, 'gate'), 'nothing answered (the shell is stubbed here): boot.js reveals the portal as it stands — never stuck');
  ready(d);
  assert.ok(shown(d, 'app'));
  t.mock.timers.tick(60000);
  assert.equal(asked.length, 1, 'only once');
});

test('P1 deadline — a reveal in time cancels both deadlines', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { d, signIn } = await bootPage({ hint: true });
  const asked = [];
  d.addEventListener('portal:deadline', () => asked.push(1));
  signIn(); ready(d);
  t.mock.timers.tick(60000);
  assert.equal(asked.length, 0);
  assert.ok(shown(d, 'app') && !shown(d, 'gate'));
});

test('P2 bootstrap failure — if the module graph never starts, gate-early.js shows the recovery card after BOOT_DEADLINE_MS; never an unwired form', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const hint of [true, false]) {
    const { w, d } = pageDom({ hint });   // boot.js never runs: a module / CDN failure
    t.mock.timers.tick(9999);
    assert.ok(!shown(d, 'gatefail'));
    t.mock.timers.tick(1);
    assert.ok(shown(d, 'gatefail'), `hint=${hint}: the recovery card`);
    assert.ok(!shown(d, 'loginform') && !shown(d, 'gatewait'), 'never the unwired form');
    const btn = d.getElementById('gatefailbtn');
    assert.equal(d.activeElement, btn, 'focus on «Reintentar»');
    let reloaded = 0;
    w.__portalReload = () => { reloaded += 1; };   // jsdom cannot stub location.reload: gate-early.js's one seam
    btn.click();
    assert.equal(reloaded, 1, '«Reintentar» reloads the page');
  }
});

test('P2 bootstrap — once boot.js runs, the boot deadline never fires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { d } = await bootPage();
  t.mock.timers.tick(60000);
  assert.ok(!shown(d, 'gatefail'));
  assertFormCard(d);
});

test('P2 focus — the reveal focuses a deliberate target: the error box\'s «Reintentar», else the view heading; the restore focuses the email', async () => {
  const { d, signIn, signOut } = await bootPage();
  signIn();
  const box = d.createElement('div'); box.className = 'errbox';
  const retry = d.createElement('button'); retry.textContent = 'Reintentar'; box.append(retry);
  d.getElementById('detail').replaceChildren(box);
  ready(d);
  assert.equal(d.activeElement, retry, 'an error state: its «Reintentar»');
  signOut();
  assert.equal(d.activeElement, d.getElementById('email'), 'the restored form: the email');
  signIn();
  d.getElementById('detail').replaceChildren();
  ready(d);
  const h = d.querySelector('#viewmenu h1');
  assert.equal(d.activeElement, h, 'the portal: the view heading');
  assert.equal(h.getAttribute('tabindex'), '-1', 'focusable without entering the tab order');
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
async function shellRun(answer, { seed, catalog, avail } = {}) {
  storage(seed);
  const byId = installDom();
  globalThis.window.location = { reload: () => {} };
  globalThis.window.scrollTo = () => {};
  globalThis.__branchesDirect = true;
  installFetch((fn) => {
    if (fn === 'getMyBranches') return typeof answer === 'function' ? answer() : answer;
    if (fn === 'getEditableCatalog' && catalog) return catalog();
    if (fn === 'getEditableCatalog') return okJson({ source: { restaurant_id: 'r_a', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'getBranchAvailability') return avail ? avail() : okJson({ branches: [] });
    return errJson(404, { error: 'not_found' });
  });
  const seen = [];
  document.addEventListener('portal:ready', () => seen.push({ shop: byId.get('shopname').textContent, detail: byId.get('detail').children.length,
    strip: !byId.get('availstrip').classList.contains('hidden'), chips: byId.get('availstrip').querySelectorAll('.bchip').length, t: Date.now() }));
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

test('shell-wait r5 (A1/R2) — the «Agotados ahora» strip is painted BEFORE the reveal: a slow availability answer holds the card until it lands', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const run = shellRun(okJson(E1([row('r_a'), row('r_b')])), { avail: async () => { await gate; return okJson({ branches: [] }); } });
  const { seen } = await run;
  assert.equal(seen.length, 0, 'no reveal while the strip has not answered (the card holds)');
  release(); await settle(25);
  assert.equal(seen.length, 1, 'one reveal once it answers');
  assert.equal(seen[0].strip, true, 'the strip is already shown at the reveal (nothing pushes the editor afterwards)');
  assert.equal(seen[0].chips, 2, 'with its branch chips in place');
});

test('shell-wait r5 — the strip wait is BOUNDED: an availability read that never answers still reveals after STRIP_WAIT_MS (1.2 s), once', async () => {
  const t0 = Date.now();
  const { seen } = await shellRun(okJson(E1([row('r_a'), row('r_b')])), { avail: () => new Promise(() => {}) });
  assert.equal(seen.length, 0, 'premise: held at first');
  await settle(1300);
  assert.equal(seen.length, 1, 'revealed once by the bound');
  assert.ok(seen[0].t - t0 >= 1150 && seen[0].t - t0 < 2500, `revealed at the bound (${seen[0].t - t0} ms)`);
  assert.equal(seen[0].strip, false, 'the strip is not drawn (it never answered)');
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

test('P1 shell — an exception ANYWHERE in boot (a malformed E1 that throws while rendering) still ends in the retry box + ONE reveal', async () => {
  const bad = E1([row('r_a')]);
  Object.defineProperty(bad.brands[0], 'name', { get() { throw new Error('render boom'); }, enumerable: true });
  const errs = []; const ce = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    const { seen, byId } = await shellRun(okJson(bad));
    assert.equal(seen.length, 1, 'revealed — never stuck on the card');
    assert.ok(seen[0].detail > 0, 'a usable recovery state is in #detail before the reveal');
    const box = byId.get('detail').children[0];
    assert.ok(box && /errbox/.test(box._class), 'the retry box');
  } finally { console.error = ce; }
  assert.ok(errs.some((e) => /render boom/.test(e)), 'the exception is logged, not swallowed');
});

test('P1 shell — `portal:deadline` before discovery ends: the retry box + the reveal; the late answer is dropped', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const { seen, byId } = await shellRun(() => held.then(() => okJson(E1([row('r_a')]))));
  assert.equal(seen.length, 0, 'premise: discovery is still pending');
  document.dispatchEvent(new CustomEvent('portal:deadline'));
  await settle(5);
  assert.equal(seen.length, 1, 'the deadline reveals');
  assert.ok(/errbox/.test(byId.get('detail').children[0]._class), 'with the retry box');
  release(); await settle(25);
  assert.equal(seen.length, 1, 'the late answer never reveals again');
  assert.ok(/errbox/.test(byId.get('detail').children[0]._class), 'nor repaints over the box');
});

test('P1 shell — `portal:deadline` after the reveal is a no-op', async () => {
  const { seen, byId } = await shellRun(okJson(E1([row('r_a')])));
  const before = byId.get('shopname').textContent;
  document.dispatchEvent(new CustomEvent('portal:deadline'));
  await settle(5);
  assert.equal(seen.length, 1);
  assert.equal(byId.get('shopname').textContent, before);
});

test('one source — the boot-failure card is the portal\'s own outage box: OFFLINE copy (ops-dom) and «Reintentar», verbatim', async () => {
  const { OFFLINE } = await import('./ops-dom.js');
  const { d } = pageDom();
  const box = d.getElementById('gatefail');
  assert.ok(box.classList.contains('errbox'));
  assert.equal(box.querySelector('b').textContent, OFFLINE[0]);
  assert.equal(box.querySelector('p').textContent, OFFLINE[1]);
  assert.equal(d.getElementById('gatefailbtn').textContent, 'Reintentar');
  assert.equal(box.getAttribute('role'), 'alert');
});

// ── Codex r2 (narrow) ────────────────────────────────────────────────────────────────────────────────────────────────
test('r2 P1 — a held catalog that answers AFTER a render failure never repaints the menu over the retry box', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const menu = { source: { restaurant_id: 'r_a', schema_version: 1, items: [{ key: 'Margarita', price: 280, display: { name: 'Margarita', cat: 'cl', price: 280 } }], extras: [],
    structure: { schema_version: 2, item_order: ['Margarita'], categories: [{ id: 'cl', name: 'Clásicas' }] } }, sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false };
  const fresh = E1([row('r_a')]);
  Object.defineProperty(fresh.brands[0], 'name', { get() { throw new Error('render boom'); }, enumerable: true });
  const ce = console.error; console.error = () => {};
  try {
    const { byId } = await shellRun(okJson(fresh), { seed: { 'sherpa.portal.branches.uSw': JSON.stringify(E1([row('r_a')])) }, catalog: () => held.then(() => okJson(menu)) });
    const box = () => byId.get('detail').children.find((c) => /errbox/.test(c._class));
    assert.ok(box(), 'premise: the render failure shows the retry box (the cached boot had started the editor load)');
    release(); await settle(30);
    assert.ok(box(), 'the late catalog answer is dropped: the retry box stays');
  } finally { console.error = ce; }
});

test('r2/r3 P2 — after the auth deadline the REAL answer decides: a valid user → the wait card (focus on the wait line); signed out → the form', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const late = await bootPage({ hint: true });
  t.mock.timers.tick(6000);
  assert.ok(shown(late.d, 'gatefail'), 'premise: the recovery card');
  late.signIn();
  assertWaitCard(late.d);
  assert.equal(late.d.activeElement, late.d.getElementById('gatewait'), 'focus is not left on the hidden «Reintentar»');
  const out = await bootPage({ hint: true });
  t.mock.timers.tick(6000);
  out.signOut();
  assertFormCard(out.d);
  assert.equal(out.d.activeElement, out.d.getElementById('email'));
});

test('r2 P2 — a boot that starts AFTER the boot deadline takes over cleanly: a page with a session goes to the wait card, not the form; focus follows', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, d } = pageDom({ hint: true });
  t.mock.timers.tick(10000);
  assert.ok(shown(d, 'gatefail'), 'premise: the recovery card');
  await loadBoot(w);   // the slow module graph finally runs
  assertWaitCard(d);
  assert.equal(d.activeElement, d.getElementById('gatewait'), 'focus leaves the hidden «Reintentar»');
  globalThis.__authCb(null);
  assertFormCard(d);
  assert.equal(d.activeElement, d.getElementById('email'));
});

test('r2 P2 — a late boot on a page WITHOUT a session takes over into the form, focus on the email', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, d } = pageDom();
  t.mock.timers.tick(10000);
  assert.ok(shown(d, 'gatefail'));
  await loadBoot(w);
  assertFormCard(d);
  assert.equal(d.activeElement, d.getElementById('email'));
});

test('r2 P2 — the boot deadline firing before the button exists still gives a WORKING «Reintentar» (delegated)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, d } = pageDom();
  const btn = d.getElementById('gatefailbtn');
  const parent = btn.parentNode, next = btn.nextSibling;
  btn.remove();                      // the head script's timer fires before the body is parsed
  t.mock.timers.tick(10000);
  parent.insertBefore(btn, next);    // the body arrives
  let reloaded = 0;
  w.__portalReload = () => { reloaded += 1; };
  btn.click();
  assert.equal(reloaded, 1);
});

test('r3 P1 — a held catalog read that FAILS after a render failure never paints its message over the retry box either', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const fresh = E1([row('r_a')]);
  Object.defineProperty(fresh.brands[0], 'name', { get() { throw new Error('render boom'); }, enumerable: true });
  const ce = console.error; console.error = () => {};
  try {
    const { byId } = await shellRun(okJson(fresh), { seed: { 'sherpa.portal.branches.uSw': JSON.stringify(E1([row('r_a')])) }, catalog: () => held.then(() => errJson(503, { error: 'unavailable' })) });
    const box = () => byId.get('detail').children.find((c) => /errbox/.test(c._class));
    assert.ok(box(), 'premise: the retry box');
    release(); await settle(30);
    assert.ok(box(), 'the late failure is dropped too: the retry box stays');
  } finally { console.error = ce; }
});
