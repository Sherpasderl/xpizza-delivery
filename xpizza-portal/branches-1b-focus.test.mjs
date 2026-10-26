// PORTAL-UI 1b — codex 1b r1 #5: keyboard focus in the Sucursales modals, on a REAL DOM (jsdom over the real index.html) with the
// REAL shell.js / branches-view.js / api.js (only auth.js is stubbed, as in every portal suite). The fake harness DOM cannot see
// focus; jsdom tracks document.activeElement and runs the real keydown handlers.
//   • a repaint (typing the WhatsApp, picking an hours chip, the prep stepper) keeps the focused control focused;
//   • Tab / Shift+Tab are contained in the modal (wrap at both ends);
//   • closing (Cancelar, Escape) returns focus to the control that opened the modal — also after the list was repainted.
// Run: node --test xpizza-portal/branches-1b-focus.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadModules, settle } from './ventas-harness.mjs';

const require = createRequire(new URL('../xpizza-functions/x.js', import.meta.url));
const { JSDOM } = require('jsdom');
const { capsFor } = require('../xpizza-functions/access/membership.js');

const HTML = readFileSync(new URL('./index.html', import.meta.url), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const WEEK = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((k) => [k, { open: true, start: '11:00', end: '22:00' }]));
const row = (rid, name) => ({ rid, brand_id: 'marca_s', role: 'owner', state: 'member', caps: capsFor({ owner: true }, 'member'), name,
  identity_version: 7, editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: WEEK, phone: '+50497952893' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 1, last_order_today: null, lifecycle: 'active',
  profile: { location_name: name, phone: '+50497952893', hours: WEEK, prep_default_min: 20 }, location: { address_line: `Dirección ${name}`, address_reference: null, hub: { lat: 1, lng: 2 }, zone_radius_km: 4 }, version: 7 });
const E1 = { brands: [{ brand_id: 'marca_s', name: 'Marca S', caps: ['brand.locations'], activation: 'on', drafts: [] }], branches: [row('r_a', 'Centro'), row('r_b', 'Norte')], membership_writes_enabled: true };

async function boot(extra) {
  const dom = new JSDOM(HTML, { url: 'https://portal.test/' });
  const w = dom.window;
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'KeyboardEvent', 'HTMLElement', 'Node', 'sessionStorage', 'localStorage']) globalThis[k] = k === 'window' ? w : w[k];
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.scrollTo = () => {};
  globalThis.__branchesDirect = true;
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  globalThis.fetch = async (url) => {
    const fn = new URL(String(url)).pathname.split('/').pop();
    const x = extra && extra(fn);
    if (x) return x;
    if (fn === 'getMyBranches') return json(E1);
    if (fn === 'getEditableCatalog') return json({ source: { restaurant_id: 'r_a', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'getBranchAvailability') return json({ branches: [] });
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }), text: async () => '', headers: { get: () => null } };
  };
  const mods = await loadModules();
  w.document.dispatchEvent(new w.CustomEvent('portal:auth', { detail: { uid: 'uFocus' } }));
  w.document.dispatchEvent(new w.CustomEvent('portal:signed-in'));
  await settle(25);
  mods.shell.goto('suc');
  await settle(5);
  const doc = w.document;
  const $ = (id) => doc.getElementById(id);
  const active = () => doc.activeElement && doc.activeElement.id;
  const key = (k, shift = false) => doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true }));
  const type = (id, v) => { const i = $(id); i.focus(); i.value = v; i.dispatchEvent(new w.Event('input', { bubbles: true })); i.dispatchEvent(new w.Event('change', { bubbles: true })); };
  return { w, doc, $, active, key, type, mods };
}

test('«Nueva sucursal»: focus opens on the first field, survives every repaint, Tab is contained, Escape returns it to «Agregar sucursal»', async () => {
  const { $, active, key, type, doc } = await boot();
  assert.ok($('suc1b-add'), 'non-vacuity: the real list rendered');
  $('suc1b-add').focus();
  $('suc1b-add').click();
  assert.equal(active(), 'nv1b-nombre', 'the modal opens on its first field');
  type('nv1b-tel', '33905521');                       // change → a full repaint (the number is formatted)
  assert.equal($('nv1b-tel').value, '+504 3390-5521', 'non-vacuity: the modal DID repaint');
  assert.equal(active(), 'nv1b-tel', 'the WhatsApp field keeps focus across the repaint');
  $('nv1b-chip-1').focus(); $('nv1b-chip-1').click();
  assert.equal(active(), 'nv1b-chip-1', 'the chip keeps focus across the repaint');
  $('nv1b-up').focus(); $('nv1b-up').click();
  assert.equal(active(), 'nv1b-up', 'the stepper keeps focus across the repaint');
  // containment: from the last control Tab wraps to the first; Shift+Tab from the first wraps to the last
  const f = Array.from($('sucmodal').querySelectorAll('input, button')).filter((n) => !n.disabled);
  f[f.length - 1].focus(); key('Tab');
  assert.equal(doc.activeElement, f[0], 'Tab wraps inside the modal');
  key('Tab', true);
  assert.equal(doc.activeElement, f[f.length - 1], 'Shift+Tab wraps inside the modal');
  key('Escape');
  assert.equal($('sucscrim').classList.contains('show'), false);
  assert.equal(active(), 'suc1b-add', 'focus returns to the invoker');
});

test('S7 confirm: Cancelar returns focus to «Desactivar …» even though the detail was repainted meanwhile', async () => {
  const { $, active, mods } = await boot();
  mods.shell.goto('suc', { rid: 'r_a' });
  await settle(5);
  $('suc1b-deact').focus();
  $('suc1b-deact').click();
  assert.equal(active(), 'suc1b-mcancel', 'the confirm opens on its first button');
  mods.shell._shellState.views.suc.render();          // a repaint replaces the invoker element
  $('suc1b-mcancel').click();
  assert.equal(active(), 'suc1b-deact', 'focus returns to the (re-rendered) invoker by its stable id');
});

// ══ codex 1b r2 #5: the focused control comes back DISABLED ═════════════════════════════════════════════════════════════════
test('r2 #5: prep at 120 → focus moves to the opposite stepper; «Crear» sending → an enabled control; unavailable → the retry («Crear»)', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const { $, active, type, doc } = await boot((fn) => (fn === 'createBranchDraft' ? held : null));
  $('suc1b-add').focus(); $('suc1b-add').click();
  $('nv1b-up').focus();
  for (let i = 0; i < 30 && !$('nv1b-up').disabled; i++) $('nv1b-up').click();
  assert.equal($('nv1b-up').disabled, true, 'premise: prep reached 120');
  assert.equal(active(), 'nv1b-down', 'the opposite stepper takes focus');
  type('nv1b-nombre', 'Norte'); type('nv1b-tel', '33905521');
  $('nv1b-go').focus(); $('nv1b-go').click();
  assert.equal($('nv1b-go').disabled, true, 'premise: «Crear» is disabled while sending');
  assert.notEqual(doc.activeElement, doc.body, 'never lost to BODY');
  assert.ok($('sucmodal').contains(doc.activeElement) && !doc.activeElement.disabled, 'an enabled control inside the modal');
  release({ ok: false, status: 503, json: async () => ({ error: 'unavailable', retryable: true }), text: async () => '', headers: { get: () => null } });
  await settle(10);
  assert.equal(active(), 'nv1b-go', 'after an unavailable answer, focus is on the retry');
});

test('item 6: name_taken on a real DOM — the line is announced by the field, focus lands on the name (never BODY)', async () => {
  const bad = { ok: false, status: 409, json: async () => ({ error: 'name_taken' }), text: async () => '', headers: { get: () => null } };
  const { $, active, type } = await boot((fn) => (fn === 'createBranchDraft' ? bad : null));
  $('suc1b-add').focus(); $('suc1b-add').click();
  type('nv1b-nombre', 'Norte'); type('nv1b-tel', '33905521');
  $('nv1b-go').focus(); $('nv1b-go').click();
  await settle(10);
  assert.equal($('nv1b-nombre-err').textContent.trim(), 'Ya hay una sucursal con ese nombre en esta marca.');
  assert.equal($('nv1b-nombre').getAttribute('aria-describedby'), 'nv1b-nombre-err');
  assert.equal($('nv1b-go').disabled, true);
  assert.equal(active(), 'nv1b-nombre', 'focus moves to the field to fix');
  type('nv1b-nombre', 'Norte 2');
  assert.equal($('nv1b-nombre-err'), null);
  assert.equal(active(), 'nv1b-nombre', 'typing keeps focus across the repaint that clears the line');
  assert.equal($('nv1b-go').disabled, false);
});
