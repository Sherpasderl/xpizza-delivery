// PLAN-portal-team-invites T-d — «Enviar al dueño para publicar» under a REAL DOM: jsdom over the shipped index.html with the
// REAL app.js, ventas.js, shell.js and pubreq.js (auth.js stubbed; fetch stubbed per function). The manager's send (D2), its
// failure on the designed panels, the owner's banner + badge (D1) for both request states, «Revisar y publicar» / «Ver cambios»
// opening TODAY's review, and the owner's path never touching catalogRequestPublish.
// Run: node --test xpizza-portal/pubreq.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { DIR, installFetch, okJson, errJson } from './ventas-harness.mjs';
import { removeAddition } from './editor.js';

const { JSDOM } = createRequire(join(DIR, '..', 'xpizza-functions', 'package.json'))('jsdom');
const HTML = readFileSync(join(DIR, 'index.html'), 'utf8');
const OWNER_CAPS = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'catalog.fiscal_ack', 'stats.read', 'availability.set', 'location.prep', 'location.pause', 'location.hours'];
const MGR_CAPS = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'availability.set'];
const branch = (caps, role) => ({ rid: 'r_fx', brand_id: 'marca_f', role, state: 'member', caps, name: 'Col. Trejo', identity_version: 2,
  editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null });
const SOURCE = { restaurant_id: 'r_fx', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } };
const MENU = (over = {}) => ({ source: SOURCE, sourceUpdateTime: 'T1', activeVersionId: 'v1', usesPlatformFactura: true, publish_via_request: false, ...over });
const DIFF = { added: [], removed: [], renamed: [], changed: [{ key: 'Pepperoni', surface: 'item', field: 'price', old: 245, new: 285 }], largeChangeSet: [] };   // review.test.mjs MODEST's shape
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function loadAll() {
  const tag = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const auth = join(DIR, `__pubreq-auth-stub.${tag}.mjs`);
  writeFileSync(auth, 'export const token = async () => "TK-pr";\nexport const login = async () => {};\nexport const logout = async () => {};\nexport const authErrorMessage = () => "";\n');
  const tmp = (n) => join(DIR, `__pubreq-under-test.${n}.${tag}.mjs`);
  const url = (n) => `./__pubreq-under-test.${n}.${tag}.mjs`;
  const files = [auth];
  const mods = {};
  try {
    for (const name of ['app', 'ventas', 'shell', 'pubreq']) {
      const src = readFileSync(join(DIR, `${name}.js`), 'utf8')
        .replace(/from '\.\/auth\.js'/g, `from './__pubreq-auth-stub.${tag}.mjs'`)
        .replace(/from '\.\/app\.js'/g, `from '${url('app')}'`)
        .replace(/from '\.\/shell\.js'/g, `from '${url('shell')}'`);
      writeFileSync(tmp(name), src); files.push(tmp(name));
      mods[name] = await import(pathToFileURL(tmp(name)).href);
    }
    return mods;
  } finally { for (const f of files) { try { unlinkSync(f); } catch (_) { /* best effort */ } } }
}

async function page({ caps = OWNER_CAPS, role = 'owner', menu = MENU(), on = {} } = {}) {
  const dom = new JSDOM(HTML, { url: 'https://portal.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'MutationObserver', 'sessionStorage', 'localStorage']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  globalThis.__branchesDirect = true;
  const e1 = { brands: [{ brand_id: 'marca_f', name: 'Pizzería Del Valle' }], branches: [branch(caps, role)], membership_writes_enabled: true };
  const calls = installFetch((fn) => {
    const last = calls[calls.length - 1];
    if (on[fn]) return on[fn](last && last.body);
    if (fn === 'getMyBranches') return okJson(e1);
    if (fn === 'getEditableCatalog') return okJson(menu);
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    if (fn === 'editCatalog') return okJson({ diff: DIFF, token: 'ET-1', source: SOURCE, updateTime: 'T2' });
    if (fn === 'catalogRequestPublish') return okJson({ ok: true, counts: { changed: 1, added: 0, removed: 0, large: 0 } });
    return errJson(404, { error: 'not_found' });
  });
  const mods = await loadAll();
  const d = w.document;
  d.dispatchEvent(new w.CustomEvent('portal:auth', { detail: { uid: role === 'owner' ? 'uOwnerPR1' : 'uMgrPR01' } }));
  d.dispatchEvent(new w.CustomEvent('portal:signed-in'));
  await settle(60);
  const n = (fn) => calls.filter((c) => c.fn === fn);
  const badge = () => { const b = d.querySelector('#navprod [data-navbadge="1"]'); return b && !b.classList.contains('hidden') ? b.textContent : null; };
  return { w, d, mods, calls, n, badge, banner: () => d.getElementById('pubreq') };
}

test('D2 manager (server publish_via_request): «Enviar al dueño para publicar» + the note; editCatalog → catalogRequestPublish with ITS token; toast; never publishEdited', async () => {
  const p = await page({ caps: MGR_CAPS, role: 'manager', menu: MENU({ publish_via_request: true }) });
  const rev = p.d.getElementById('review');
  assert.equal(rev.textContent, 'Enviar al dueño para publicar');
  assert.ok(p.d.getElementById('rbtxt').textContent.includes('· el dueño confirma y publica con la autorización fiscal'));
  rev.click(); await settle();
  assert.equal(p.n('editCatalog').length, 1, 'the draft is saved exactly as today');
  assert.deepEqual(p.n('catalogRequestPublish').map((c) => c.body), [{ restaurantId: 'r_fx', token: 'ET-1' }], 'the request carries the token THAT save returned');
  assert.equal(p.n('publishEdited').length, 0, '🔴 a manager on a factura brand never publishes');
  assert.ok(!p.d.getElementById('scrim').classList.contains('show'), 'no review / attestation panel');
  assert.equal(p.d.getElementById('opstoast').textContent, 'Enviado al dueño para publicar');
  assert.ok(!rev.disabled, 'the lock is handed back after the send');
});

test('D2 a new product sent to the owner stays a saved, unpublished addition — still marked new and still removable (the review flow\'s bookkeeping)', async () => {
  const canon = { ...SOURCE, items: [{ key: 'Pizza Nueva', price: 420, display: { id: 2, cat: 'c', name: 'Pizza Nueva', price: 420 } }],
    structure: { schema_version: 2, item_order: ['Pizza Nueva'], categories: [{ id: 'c', name: 'Pizzas' }] } };
  const p = await page({ caps: MGR_CAPS, role: 'manager', menu: MENU({ publish_via_request: true }),
    on: { editCatalog: () => okJson({ token: 'ET-2', updateTime: 'T2', source: canon,
      diff: { added: [{ surface: 'item', key: 'Pizza Nueva', price: 420 }], removed: [], renamed: [], changed: [], largeChangeSet: [] } }) } });
  p.d.getElementById('review').click(); await settle();
  assert.equal(p.n('catalogRequestPublish').length, 1, 'premise: sent');
  const app = p.mods.app;
  assert.ok(app.state.additionKeys.has('Pizza Nueva'), '🔴 the sent product is still known as an unpublished addition');
  removeAddition(app.state.draft, 'Pizza Nueva', app.state.additionKeys);   // what the drawer\'s «Quitar» runs
  assert.ok(!app.state.draft.state.items.some((i) => i.key === 'Pizza Nueva'), '...so it can still be removed before the owner publishes');
});

test('D2 failure: a refused request lands on the designed panel (outcomeFor), no toast, the lock released', async () => {
  const p = await page({ caps: MGR_CAPS, role: 'manager', menu: MENU({ publish_via_request: true }),
    on: { catalogRequestPublish: () => errJson(409, { error: 'edit_superseded' }) } });
  p.d.getElementById('review').click(); await settle();
  assert.ok(p.d.getElementById('scrim').classList.contains('show') && p.d.getElementById('mbody').textContent.trim().length > 0, 'a designed panel');
  assert.notEqual(p.d.getElementById('opstoast').textContent, 'Enviado al dueño para publicar');
  assert.equal(p.n('publishEdited').length, 0);
});

test('D3 / owner: without publish_via_request the CTA is today\'s «Revisar y publicar», and it never calls catalogRequestPublish', async () => {
  const p = await page();
  const rev = p.d.getElementById('review');
  assert.equal(rev.textContent, 'Revisar y publicar', 'the owner keeps today\'s CTA');
  assert.ok(!p.d.getElementById('rbtxt').textContent.includes('el dueño confirma'), 'and today\'s bar text');
  rev.click(); await settle();
  assert.equal(p.n('catalogRequestPublish').length, 0);
  assert.equal(p.n('editCatalog').length, 1);
  assert.ok(p.d.getElementById('scrim').classList.contains('show'), 'today\'s review panel opens');
});

test('D1 owner, fresh: «{name} envió N cambios para publicar · hace …», badge «1»; «Revisar y publicar» and «Ver cambios» open today\'s review', async () => {
  const req = { state: 'fresh', by_name: 'Dania Reyes', at: Date.now() - 12 * 60e3, counts: { changed: 2, added: 1, removed: 0, large: 0 } };
  const p = await page({ menu: MENU({ publish_request: req }) });
  const b = p.banner();
  assert.ok(!b.classList.contains('hidden'));
  assert.equal(b.querySelector('.pbt').textContent, 'Dania Reyes envió 3 cambios para publicar · hace 12 min');
  assert.equal(p.badge(), '1', 'the Productos badge');
  const [ver, rev] = [...b.querySelectorAll('button')];
  assert.deepEqual([ver.textContent, rev.textContent], ['Ver cambios', 'Revisar y publicar']);
  rev.click(); await settle();
  assert.ok(p.d.getElementById('scrim').classList.contains('show') && p.n('editCatalog').length === 1, '«Revisar y publicar» → today\'s review');
  assert.equal(p.n('catalogRequestPublish').length, 0);
  const q = await page({ menu: MENU({ publish_request: req }) });
  q.banner().querySelector('button').click(); await settle();
  assert.ok(q.d.getElementById('scrim').classList.contains('show') && q.n('editCatalog').length === 1, '«Ver cambios» → the same review panel');
});

test('D1 owner, draft_changed: «El borrador cambió desde que {name} lo envió», no badge; none → no banner, no badge; a sign-out clears both', async () => {
  const p = await page({ menu: MENU({ publish_request: { state: 'draft_changed', by_name: 'Dania Reyes', at: Date.now(), counts: {} } }) });
  assert.equal(p.banner().querySelector('.pbt').textContent, 'El borrador cambió desde que Dania Reyes lo envió');
  assert.ok(p.banner().querySelector('.pbis'), 'the stale icon');
  assert.equal(p.badge(), null, 'a stale request is not a «1»');
  const none = await page();
  assert.ok(none.banner().classList.contains('hidden') && none.badge() === null);
  const s = await page({ menu: MENU({ publish_request: { state: 'fresh', by_name: 'Dania Reyes', at: Date.now(), counts: { changed: 1 } } }) });
  assert.equal(s.badge(), '1');
  s.d.dispatchEvent(new s.w.CustomEvent('portal:auth', { detail: { uid: null } })); await settle();
  assert.ok(s.banner().classList.contains('hidden') && s.banner().textContent === '' && s.badge() === null, 'gone on sign-out');
});

test('D1 owner: publishing through TODAY\'s review (fiscal ack → publishEdited) retires the badge and the banner on the post-publish reload', async () => {
  let loads = 0;
  const fresh = { state: 'fresh', by_name: 'Dania Reyes', at: Date.now(), counts: { changed: 1 } };
  const p = await page({ on: {
    getEditableCatalog: () => { loads += 1; return okJson(MENU(loads === 1 ? { publish_request: fresh } : {})); },
    publishEdited: () => okJson({ ok: true, versionId: 'v2', changedProducts: 1 }),
  } });
  assert.equal(p.badge(), '1');
  p.banner().querySelectorAll('button')[1].click(); await settle();
  for (const cb of p.d.getElementById('mbody').querySelectorAll('input[type="checkbox"]')) { cb.checked = true; cb.dispatchEvent(new p.w.Event('change', { bubbles: true })); cb.dispatchEvent(new p.w.Event('input', { bubbles: true })); }
  await settle();
  const pub = p.d.getElementById('pubbtn');
  assert.ok(!pub.disabled, 'non-vacuity: the fiscal acknowledgement enabled the publish');
  pub.click(); await settle(80);
  assert.equal(p.n('publishEdited').length, 1, 'the owner publishes through the unchanged path');
  assert.ok(loads >= 2, 'the post-publish reload ran');
  assert.equal(p.badge(), null, 'the badge is retired by the publish');
  assert.ok(p.banner().classList.contains('hidden'), 'and the banner');
});

// ── train-3 Codex follow-up: a refused save's FIELD state must never take the global `.err` message block's display:none ──
// The real flow (add a product → editCatalog refuses name_taken → «Corregir el nombre» reopens the drawer) under the REAL
// styles.css: the named field and its message stay rendered (the field state is `.invalid`, not the hidden `.err` block).
test('drawer: a refused save marks the named field INVALID and keeps it visible (never the global .err display:none)', async () => {
  const src = { restaurant_id: 'r_fx', schema_version: 1, items: [{ key: 'Pepperoni', price: 245, display: { id: 1, cat: 'c', name: 'Pepperoni', price: 245 } }], extras: [],
    structure: { schema_version: 2, item_order: ['Pepperoni'], categories: [{ id: 'c', name: 'Pizzas' }] } };
  const p = await page({ menu: MENU({ source: src, usesPlatformFactura: false, renderedCategories: ['c'] }), on: {
    editCatalog: (b) => errJson(409, { error: 'name_taken', ref: b.source.items.find((i) => i.ref).ref, field: 'name' }) } });
  const css = p.d.createElement('style'); css.textContent = readFileSync(join(DIR, 'styles.css'), 'utf8'); p.d.head.append(css);
  p.d.querySelector('.addrow').click(); await settle();
  const ins = [...p.d.getElementById('drawer').querySelectorAll('input')];
  const set = (label, v) => { const i = ins.find((x) => x.getAttribute('aria-label') === label); i.value = v; i.dispatchEvent(new p.w.Event('input')); };
  set('Nombre', 'Pepperoni'); set('Precio', '420');
  p.d.getElementById('review').click(); await settle();
  const fix = [...p.d.querySelectorAll('#mbody button, #revFoot button')].find((b) => b.textContent === 'Corregir el nombre');
  assert.ok(fix, 'premise: the designed name_taken panel');
  fix.click(); await settle();
  const f = [...p.d.querySelectorAll('#drawer .fld')].find((x) => x.querySelector('.ferr'));
  assert.ok(f && f.textContent.includes('Nombre'), 'premise: the Nombre field carries the message');
  assert.ok(f.classList.contains('invalid') && !f.classList.contains('err'), 'the field state is .invalid');
  assert.notEqual(p.w.getComputedStyle(f).display, 'none', '🔴 the invalid field (and its message) stays rendered');
});

