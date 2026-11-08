// «Marca» (NOTE-portal-marca-build; approved mockup R1pshGArpS5Af2tzcdCvTW) under a REAL DOM: jsdom over the shipped index.html with
// the REAL app.js, ventas.js, shell.js and marca.js (auth.js stubbed). The brand-profile endpoints are answered by a CONTRACT FAKE
// written from 3a's agreed contract (BRIEF-3a-marca-server + the 11-07 additions), AT LEAST AS STRICT as the server: exactly the four
// keys, the same field rules (written here independently of brand-fields.js), a CAS on expected_version, and the exact response
// shapes. A body the server would refuse is refused here too, and one the portal should never send (an untrimmed name, a hex accent,
// a logo) fails the test outright. When 3a's real core lands, the composed test replaces the fake's verdicts with the real ones.
// Run: node --test xpizza-portal/marca.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { DIR, installFetch, okJson, errJson } from './ventas-harness.mjs';
import * as BF from './brand-fields.js';

const { JSDOM } = createRequire(join(DIR, '..', 'xpizza-functions', 'package.json'))('jsdom');
const HTML = readFileSync(join(DIR, 'index.html'), 'utf8');
const OWNER_CAPS = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'catalog.fiscal_ack', 'stats.read', 'availability.set', 'location.prep',
  'location.pause', 'location.hours', 'team.invite', 'team.revoke', 'brand.settings'];
const MANAGER_CAPS = ['stats.read', 'availability.set', 'location.prep', 'location.pause', 'location.hours'];
const branch = (rid, name, caps = OWNER_CAPS, role = 'owner') => ({ rid, brand_id: 'marca_t', role, state: 'member', caps, name,
  identity_version: 2, editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null });
const E1 = (over = {}) => ({ brands: [{ brand_id: 'marca_t', name: 'Pizzería Del Valle' }], branches: [branch('r_cen', 'Centro'), branch('r_tre', 'Col. Trejo')],
  membership_writes_enabled: true, ...over });
const MENU = () => okJson({ source: { restaurant_id: 'r_cen', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v' });
const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// the palette as 3a serves it (platform/brand-palette.json, verbatim from the approved mockup)
const PALETTE = [['verde', 'Verde', '#1B6E3A'], ['ladrillo', 'Ladrillo', '#B8321F'], ['terracota', 'Terracota', '#B4531B'], ['azul', 'Azul', '#1F4FA3'],
  ['ciruela', 'Ciruela', '#6B3A86'], ['petroleo', 'Petróleo', '#0E6B6B'], ['cafe', 'Café', '#6B4A2B'], ['carbon', 'Carbón', '#2B2B2E']]
  .map(([id, label, hex]) => ({ id, label, light: hex, dark: hex, on: '#FFFFFF' }));

// ── the CONTRACT FAKE ── the server's verdicts, written from the contract text (never from brand-fields.js)
const SINK = /[<>\u0000-\u001f\u007f]/;
function serverVerdict(fields) {
  const keys = ['display_name', 'accent', 'logo', 'pickup_note'];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { field: 'fields', reason: 'unknown_key' };
  for (const k of Object.keys(fields)) if (!keys.includes(k)) return { field: k, reason: 'unknown_key' };
  for (const k of keys) if (!Object.prototype.hasOwnProperty.call(fields, k)) return { field: k, reason: 'unknown_key' };
  const n = fields.display_name;
  if (typeof n !== 'string' || n.trim() === '') return { field: 'display_name', reason: 'blank' };
  if (SINK.test(n)) return { field: 'display_name', reason: 'bad_chars' };
  if (n.trim().length < 2) return { field: 'display_name', reason: 'too_short' };
  if (n.trim().length > 40) return { field: 'display_name', reason: 'too_long' };
  if (!PALETTE.some((p) => p.id === fields.accent)) return { field: 'accent', reason: 'unknown_accent' };
  if (fields.logo !== null) return { field: 'logo', reason: 'not_null' };
  const p = fields.pickup_note;
  if (typeof p !== 'string' || SINK.test(p)) return { field: 'pickup_note', reason: 'bad_chars' };
  if (p.length > 140) return { field: 'pickup_note', reason: 'too_long' };
  return null;
}
function makeServer(over = {}) {
  const sv = { version: null, fields: null, seed: { display_name: 'Pizzería Del Valle' }, platform: { whatsapp_number: null, menu_url: 'https://orders.delvalle.test' },
    projected: 2, violations: [], posts: [], gets: 0, ...over };
  sv.get = () => {
    sv.gets += 1;
    return okJson({ ok: true, brand_id: 'marca_t', version: sv.version, fields: sv.fields ? { ...sv.fields } : null, ...(sv.fields ? {} : { seed: sv.seed }),
      palette: PALETTE, platform: sv.platform, projection: { branches: 2, in_sync: 2 } });
  };
  sv.post = (body) => {
    sv.posts.push(body);
    if (!body || body.brand_id !== 'marca_t') return errJson(403, { error: 'not_authorized' });
    const f = body.fields;
    // what the PORTAL must never send (stricter than the server, which would merely refuse): fail the test, do not just 400
    if (f && typeof f.display_name === 'string' && f.display_name !== f.display_name.trim()) sv.violations.push('untrimmed name sent');
    if (f && typeof f.accent === 'string' && f.accent.startsWith('#')) sv.violations.push('hex accent sent');
    const v = serverVerdict(f);
    if (v) return errJson(400, { error: 'invalid', ...v });
    if (body.expected_version !== sv.version) return errJson(409, { error: 'version_conflict', version: sv.version });
    sv.version = (sv.version || 0) + 1;
    sv.fields = { ...f };
    return okJson({ ok: true, version: sv.version, projected: sv.projected });
  };
  return sv;
}

async function loadAll() {
  const tag = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const auth = join(DIR, `__marca-auth-stub.${tag}.mjs`);
  writeFileSync(auth, 'export const token = async () => "TK-marca";\nexport const login = async () => {};\nexport const logout = async () => {};\nexport const authErrorMessage = () => "";\n');
  const tmp = (n) => join(DIR, `__marca-under-test.${n}.${tag}.mjs`);
  const url = (n) => `./__marca-under-test.${n}.${tag}.mjs`;
  const files = [auth];
  const mods = {};
  try {
    for (const name of ['app', 'ventas', 'shell', 'marca']) {
      const src = readFileSync(join(DIR, `${name}.js`), 'utf8')
        .replace(/from '\.\/auth\.js'/g, `from './__marca-auth-stub.${tag}.mjs'`)
        .replace(/from '\.\/app\.js'/g, `from '${url('app')}'`)
        .replace(/from '\.\/shell\.js'/g, `from '${url('shell')}'`);
      writeFileSync(tmp(name), src); files.push(tmp(name));
      mods[name] = await import(pathToFileURL(tmp(name)).href);
    }
    return mods;
  } finally { for (const f of files) { try { unlinkSync(f); } catch (_) { /* best effort */ } } }
}

async function page({ e1 = E1(), server = makeServer(), on = {} } = {}) {
  const dom = new JSDOM(HTML, { url: 'https://portal.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'MutationObserver', 'sessionStorage', 'localStorage']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  globalThis.__branchesDirect = true;
  const st = { e1 };
  const calls = installFetch((fn) => {
    const last = calls[calls.length - 1];
    if (on[fn]) { const r = on[fn](last, server); if (r) return r; }
    if (fn === 'getMyBranches') return okJson(st.e1);
    if (fn === 'getEditableCatalog') return MENU();
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    if (fn === 'getBrandProfile') { assert.equal(last.query.brand_id, 'marca_t', 'GET carries brand_id'); assert.equal(last.auth, 'Bearer TK-marca'); return server.get(); }
    if (fn === 'updateBrandProfile') { assert.equal(last.auth, 'Bearer TK-marca'); return server.post(last.body); }
    return errJson(404, { error: 'not_found' });
  });
  const mods = await loadAll();
  const d = w.document;
  const reg = () => mods.shell._registered.find((r) => r.id === 'marca');
  const host = () => reg().main;
  const text = () => host().textContent.replace(/\s+/g, ' ');
  const btn = (label, root = host()) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  const n = (fn) => calls.filter((c) => c.fn === fn);
  const signIn = async (uid = 'uOwnerT1') => {
    d.dispatchEvent(new w.CustomEvent('portal:auth', { detail: { uid } }));
    d.dispatchEvent(new w.CustomEvent('portal:signed-in'));
    await settle(40);
  };
  const open = async () => { reg().nav.click(); await settle(); };
  const type = (id, v) => { const i = d.getElementById(id); i.value = v; i.dispatchEvent(new w.Event('input')); };
  const blur = (id) => d.getElementById(id).dispatchEvent(new w.Event('blur'));
  const swatch = (id) => host().querySelector(`.mk-sw[data-accent="${id}"]`);
  const toastText = () => (d.getElementById('opstoast').textContent || '').trim();
  return { dom, w, d, mods, st, server, calls, reg, host, text, btn, n, signIn, open, type, blur, swatch, toastText };
}

// ── pure rules (the mirror) ───────────────────────────────────────────────────────────────────────────────────────────
test('brand-fields: the mirror agrees with the contract on every boundary', () => {
  const cases = [['', 'blank'], ['   ', 'blank'], ['A', 'too_short'], [' A ', 'too_short'], ['Ab', null], ['x'.repeat(40), null], [` ${'x'.repeat(40)} `, null],
    ['x'.repeat(41), 'too_long'], ['Pizza <b>', 'bad_chars'], ['Pizza\u0007', 'bad_chars'], ['Pizza > todo', 'bad_chars'], ['Pizzería Del Valle', null]];
  for (const [v, want] of cases) {
    assert.equal(BF.nameReason(v), want, JSON.stringify(v));
    const server = serverVerdict({ display_name: v.trim() === '' ? v : v.trim(), accent: 'verde', logo: null, pickup_note: '' });
    assert.equal(server ? server.reason : null, want, `server agrees on ${JSON.stringify(v)}`);
  }
  for (const [v, want] of [['', null], ['x'.repeat(140), null], ['x'.repeat(141), 'too_long'], ['a<b', 'bad_chars'], ['linea\nnueva', 'bad_chars']]) {
    assert.equal(BF.noteReason(v), want, JSON.stringify(v));
    const server = serverVerdict({ display_name: 'Ab', accent: 'verde', logo: null, pickup_note: v });
    assert.equal(server ? server.reason : null, want, `server agrees on note ${JSON.stringify(v)}`);
  }
  assert.equal(BF.accentReason('verde', PALETTE), null);
  for (const a of ['#1B6E3A', 'Verde', null, undefined, 'rojo']) assert.equal(BF.accentReason(a, PALETTE), 'unknown_accent', String(a));
  assert.deepEqual(Object.keys(BF.toFields({ display_name: '  Café  ', accent: 'cafe', pickup_note: 'x', extra: 1 })), ['display_name', 'accent', 'logo', 'pickup_note']);
  assert.deepEqual(BF.toFields({ display_name: '  Café  ', accent: 'cafe', pickup_note: 'x' }), { display_name: 'Café', accent: 'cafe', logo: null, pickup_note: 'x' });
  assert.equal(BF.initial('  ñandú'), 'Ñ');
  assert.equal(BF.changedLine(['accent', 'pickup_note']), 'Cambios sin guardar: color, nota.');
});

// ── visibility ───────────────────────────────────────────────────────────────────────────────────────────────────────
test('the «Marca» nav: owner with brand.settings only, placed right after «Ventas»; a manager never sees it', async () => {
  const p = await page();
  await p.signIn();
  assert.ok(!p.reg().nav.classList.contains('hidden') && !p.reg().mn.classList.contains('hidden'), 'owner → shown');
  assert.equal(p.d.getElementById('navventas').nextElementSibling, p.reg().nav, 'beside Ventas (mockup)');
  assert.equal(p.reg().nav.textContent.trim(), 'Marca');
  const m = await page({ e1: E1({ branches: [branch('r_cen', 'Centro', MANAGER_CAPS, 'manager')] }) });
  await m.signIn('uMgr0001');
  assert.ok(m.reg().nav.classList.contains('hidden') && m.reg().mn.classList.contains('hidden'), 'manager → absent');
  assert.equal(m.n('getBrandProfile').length, 0, 'a hidden view never reads the brand profile');
  const o = await page({ e1: E1({ branches: [branch('r_cen', 'Centro', OWNER_CAPS.filter((c) => c !== 'brand.settings'))] }) });
  await o.signIn();
  assert.ok(o.reg().nav.classList.contains('hidden'), 'owner without brand.settings → absent');
});

// ── B1: never saved ──────────────────────────────────────────────────────────────────────────────────────────────────
test('B1 never saved: the seed name pre-fills, no swatch chosen, save disabled, «Datos de Sherpa» read-only', async () => {
  const p = await page();
  await p.signIn(); await p.open();
  assert.equal(p.n('getBrandProfile').length, 1);
  assert.equal(p.d.getElementById('mk-name').value, 'Pizzería Del Valle', 'seed.display_name');
  assert.equal(p.host().querySelectorAll('.mk-sw').length, PALETTE.length, 'one swatch per SERVED palette entry');
  assert.equal(p.host().querySelectorAll('.mk-sw.on').length, 0, 'nothing chosen yet');
  assert.ok(p.btn('Guardar cambios').disabled, 'nothing changed → disabled');
  assert.ok(p.btn('Descartar').classList.contains('hidden'));
  const t = p.text();
  for (const s of ['Marca', 'Identidad', 'Nombre de la marca', 'Color de la marca', 'Sin logo todavía', 'Tus clientes ven tu inicial sobre tu color.', 'Para recoger',
    'Nota para quien recoge', 'Así te ven tus clientes', 'Empezar pedido', 'Datos de Sherpa', 'Solo lectura', 'Ver en Sucursales', 'Definidas por Sherpa',
    'Los cambios llegan a tus clientes al guardar; no hay que publicar.', '18/40', '0/140', 'orders.delvalle.test', 'Definido por Sherpa']) assert.ok(t.includes(s), s);
  assert.ok(!t.includes('Subí tu logo'), 'M1: no uploader until the logo pipeline');
  assert.equal(p.host().querySelector('.mk-prevname').textContent, 'Pizzería Del Valle');
  assert.equal(p.host().querySelector('.mk-prev .mk-mono').textContent, 'P');
  assert.ok(!t.includes('https://'), 'the menu address is shown without its scheme');
});

// ── B2 → B3: edit and save ───────────────────────────────────────────────────────────────────────────────────────────
test('B2→B3: pick a colour + type a note → the dirty line; save sends EXACTLY the contract body; «Marca guardada»; clean again', async () => {
  const p = await page();
  await p.signIn(); await p.open();
  p.swatch('terracota').click();
  p.type('mk-note', 'Pasá por la ventanilla de la izquierda y decí tu número de pedido.');
  assert.equal(p.swatch('terracota').getAttribute('aria-checked'), 'true');
  assert.ok(p.text().includes('Seleccionado: Terracota.'));
  assert.ok(p.text().includes('Cambios sin guardar: color, nota.'));
  assert.equal(p.host().querySelector('.mk-prevbtn').style.background.replace(/\s/g, ''), 'rgb(180,83,27)', 'the preview follows the colour');
  assert.ok(!p.btn('Guardar cambios').disabled && !p.btn('Descartar').classList.contains('hidden'));
  p.btn('Guardar cambios').click(); await settle();
  assert.deepEqual(p.server.posts, [{ brand_id: 'marca_t', expected_version: null,
    fields: { display_name: 'Pizzería Del Valle', accent: 'terracota', logo: null, pickup_note: 'Pasá por la ventanilla de la izquierda y decí tu número de pedido.' } }]);
  assert.deepEqual(p.server.violations, []);
  assert.equal(p.toastText(), 'Marca guardada');
  assert.ok(p.btn('Guardar cambios').disabled, 'saved = the new baseline');
  assert.ok(p.text().includes('Los cambios llegan a tus clientes al guardar; no hay que publicar.'));
  // a second edit carries the server's version
  p.type('mk-name', '  Del Valle  ');
  p.btn('Guardar cambios').click(); await settle();
  assert.equal(p.server.posts[1].expected_version, 1);
  assert.equal(p.server.posts[1].fields.display_name, 'Del Valle', 'trimmed before it leaves');
  assert.deepEqual(p.server.violations, []);
});

test('projected:false → «Guardado. Tus clientes lo ven en unos minutos.»', async () => {
  const p = await page({ server: makeServer({ projected: false }) });
  await p.signIn(); await p.open();
  p.swatch('azul').click();
  p.btn('Guardar cambios').click(); await settle();
  assert.equal(p.toastText(), 'Guardado. Tus clientes lo ven en unos minutos.');
});

// ── conflicts and refusals ───────────────────────────────────────────────────────────────────────────────────────────
test('409 version_conflict: re-read, the owner\'s edits STAY on screen, a notice; the next save carries the new version', async () => {
  const p = await page({ server: makeServer({ version: 3, fields: { display_name: 'Del Valle', accent: 'verde', logo: null, pickup_note: '' } }) });
  await p.signIn(); await p.open();
  p.swatch('ciruela').click();
  p.server.version = 4; p.server.fields = { display_name: 'Del Valle', accent: 'azul', logo: null, pickup_note: 'Otra nota' };   // someone saved first
  p.btn('Guardar cambios').click(); await settle(40);
  assert.equal(p.n('getBrandProfile').length, 2, 're-read after the conflict');
  assert.ok(p.text().includes('Alguien guardó la marca antes que vos'));
  assert.equal(p.swatch('ciruela').getAttribute('aria-checked'), 'true', 'the owner\'s pick is kept, never overwritten');
  assert.ok(p.text().includes('Cambios sin guardar: color, nota.'), 'dirty against the NEW baseline');
  assert.equal(p.server.fields.accent, 'azul', 'nothing was overwritten');
  p.btn('Guardar cambios').click(); await settle();
  assert.equal(p.server.posts[1].expected_version, 4);
  assert.equal(p.server.fields.accent, 'ciruela');
});

test('a server-only 400 lands on its field with the reason\'s copy', async () => {
  const p = await page({ on: { updateBrandProfile: () => errJson(400, { error: 'invalid', field: 'display_name', reason: 'too_long' }) } });
  await p.signIn(); await p.open();
  p.swatch('verde').click();
  p.btn('Guardar cambios').click(); await settle();
  const err = p.d.getElementById('mk-name-err');
  assert.ok(err && err.textContent.includes('Hasta 40 caracteres.'));
  assert.equal(p.d.getElementById('mk-name').getAttribute('aria-invalid'), 'true');
  assert.ok(!p.toastText().includes('guardada'));
});

test('client mirror: a forbidden character shows at once and NO request leaves; a short name shows on blur; Descartar restores', async () => {
  const p = await page();
  await p.signIn(); await p.open();
  p.swatch('verde').click();
  p.type('mk-name', 'Pizza <b>');
  assert.ok(p.d.getElementById('mk-name-err').textContent.includes('Sin los signos < ni >.'), 'live');
  p.btn('Guardar cambios').click(); await settle();
  assert.equal(p.server.posts.length, 0, 'refused locally');
  p.type('mk-name', 'P');
  assert.ok(p.d.getElementById('mk-name-err'), 'after a refused save attempt, errors stay visible');
  p.btn('Descartar').click(); await settle();
  assert.equal(p.d.getElementById('mk-name').value, 'Pizzería Del Valle');
  assert.equal(p.host().querySelectorAll('.mk-sw.on').length, 0);
  assert.equal(p.d.getElementById('mk-name-err'), null);
  const q = await page();
  await q.signIn(); await q.open();
  q.type('mk-name', 'P');
  assert.equal(q.d.getElementById('mk-name-err'), null, 'not while typing');
  q.blur('mk-name');
  assert.ok(q.d.getElementById('mk-name-err').textContent.includes('Escribí al menos 2 caracteres.'));
});

test('never saved: a name change with NO colour chosen is refused locally — the colour error shows, nothing is sent', async () => {
  const p = await page();
  await p.signIn(); await p.open();
  p.type('mk-name', 'Del Valle');
  assert.ok(!p.btn('Guardar cambios').disabled, 'a change exists');
  p.btn('Guardar cambios').click(); await settle();
  assert.equal(p.server.posts.length, 0);
  assert.ok(p.d.getElementById('mk-color-err').textContent.includes('Elegí uno de los colores.'));
  p.swatch('verde').click();
  assert.equal(p.d.getElementById('mk-color-err'), null, 'picking one clears it');
});

test('the pickup note stays one line: a typed or pasted line break becomes a space, and the body passes the server', async () => {
  const p = await page();
  await p.signIn(); await p.open();
  p.swatch('verde').click();
  p.type('mk-note', 'Ventanilla\r\nizquierda\nde la entrada');
  assert.equal(p.d.getElementById('mk-note').value, 'Ventanilla izquierda de la entrada');
  assert.equal(p.d.getElementById('mk-note-err'), null);
  p.btn('Guardar cambios').click(); await settle();
  assert.equal(p.server.posts[0].fields.pickup_note, 'Ventanilla izquierda de la entrada');
  assert.equal(p.toastText(), 'Marca guardada');
});

// ── lifecycle ────────────────────────────────────────────────────────────────────────────────────────────────────────
test('unsaved edits survive a nav switch (same owner + brand), canLeave holds a reload while dirty; a sign-out drops them', async () => {
  const p = await p0();
  async function p0() { const x = await page(); await x.signIn(); await x.open(); return x; }
  p.swatch('cafe').click();
  assert.equal(p.reg().canLeave(), false, 'dirty → a self-update reload waits');
  p.d.getElementById('navventas').click(); await settle();
  await p.open();
  assert.equal(p.swatch('cafe').getAttribute('aria-checked'), 'true', 'restored');
  assert.ok(p.text().includes('Cambios sin guardar: color.'));
  // park the edits again (nav away), THEN the account changes: the parked edits must not outlive the session
  p.d.getElementById('navventas').click(); await settle();
  assert.notEqual(p.mods.marca._marcaState.kept, null, 'non-vacuity: the edits are parked in memory');
  p.d.dispatchEvent(new p.w.CustomEvent('portal:auth', { detail: { uid: 'uOther01' } })); await settle();
  assert.equal(p.mods.marca._marcaState.kept, null, 'a sign-out / account change drops them');
  assert.equal(p.mods.marca._marcaState.st, null);
});

test('a GET answered after the account changed never renders', async () => {
  let release;
  const hold = new Promise((r) => { release = r; });
  const p = await page({ on: { getBrandProfile: () => null } });
  // hold the first read: answer it only after the account changed
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, o) => { if (String(u).includes('getBrandProfile')) { await hold; } return orig(u, o); };
  await p.signIn(); p.reg().nav.click(); await settle(10);
  p.d.dispatchEvent(new p.w.CustomEvent('portal:auth', { detail: { uid: 'uOther01' } }));
  release(); await settle(40);
  assert.equal(p.d.getElementById('mk-name'), null, 'the stale answer was dropped');
});

test('one source: no palette colour is hard-coded in the page module', () => {
  const src = readFileSync(join(DIR, 'marca.js'), 'utf8');
  for (const p of PALETTE) assert.ok(!src.toUpperCase().includes(p.light.toUpperCase()), p.id);
  assert.ok(!/\btorre\b/i.test(src));
});
