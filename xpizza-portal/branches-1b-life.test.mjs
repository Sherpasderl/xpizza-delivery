// PORTAL-UI 1b commit (b) (PLAN-portal-ui-slice1b-sucursales r4 §3.2, §3.4, §3.5, §2c, §2e, §2f B1–B8) — the lifecycle through the
// REAL shell.js / branches-view.js / api.js over the ventas harness: the S2 list + drafts, S7 / S8 / S8b / S8c / G3, Activar /
// Desactivar, «Nueva sucursal», drafts (S10), s3-legacy and the lifecycle-only shell. Capabilities from the REAL capsFor (member
// and STAGED). Synthetic brands only. Run: node --test xpizza-portal/branches-1b-life.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installDom, installFetch, loadModules, okJson, errJson, settle, textOf, findAll } from './ventas-harness.mjs';
import { E6_KEYS } from './api.js';

const require = createRequire(import.meta.url);
const { capsFor } = require('../xpizza-functions/access/membership.js');

const WEEK = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((k) => [k, { open: true, start: '11:00', end: '22:00' }]));
const OWNER = capsFor({ owner: true }, 'member');
const OWNER_STAGED = capsFor({ owner: true }, 'staged');
const MANAGER = capsFor({ manager: true }, 'member');
const CTRL = (state) => ({ state, paused_until: null, pause_reason: null, pause_since: null });
function row(rid, extra = {}) {
  const prof = { location_name: extra.name || rid.toUpperCase(), phone: '+50497952893', hours: WEEK, prep_default_min: 20, ...(extra.profile || {}) };
  const { profile, ...rest } = extra;
  return { rid, brand_id: 'marca_s', role: 'owner', state: 'member', caps: OWNER, name: prof.location_name,
    identity_version: 7, editable: { prep_default_min: prof.prep_default_min }, readonly: { active: true, radius_km: 4, hours: prof.hours, phone: prof.phone },
    control: CTRL('open'), devices: 1, last_order_today: 641, lifecycle: 'active', profile: prof,
    location: { address_line: `Dirección ${rid}`, address_reference: null, hub: { lat: 1, lng: 2 }, zone_radius_km: 4 }, version: 7, ...rest };
}
const staged = (rid, readiness, extra = {}) => row(rid, { state: 'staged', caps: OWNER_STAGED, lifecycle: 'staged', control: CTRL('inactive'), devices: 0, last_order_today: null, readonly: { active: false, radius_km: 4, hours: WEEK, phone: '+50497952893' }, ...(readiness ? { readiness } : {}), ...extra });
const inactive = (rid, readiness, extra = {}) => row(rid, { lifecycle: 'inactive', control: CTRL('inactive'), readonly: { active: false, radius_km: 4, hours: WEEK, phone: '+50497952893' }, ...(readiness ? { readiness } : {}), ...extra });
const draftOf = (rid, name, brand = 'marca_s') => ({ rid, brand_id: brand, lifecycle: 'draft', profile: { location_name: name, phone: '+50433905521', hours: WEEK, prep_default_min: 25 }, location: null, pending_location: true, version: `d.op${rid}.1.1` });
const BRAND = (drafts = [], extra = {}) => ({ brand_id: 'marca_s', name: 'Marca S', caps: ['brand.locations'], activation: 'on', drafts, ...extra });
const E1 = (branches, brands = [BRAND()], w = true) => ({ brands, branches, membership_writes_enabled: w });

function installStorage(seed = {}) {
  const m = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  globalThis.sessionStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
  return m;
}
function page(e1s, extra) {
  const byId = installDom();
  const reloads = { n: 0 };
  globalThis.window.location = { reload: () => { reloads.n += 1; } };
  globalThis.window.scrollTo = () => {};
  globalThis.__branchesDirect = true;
  let n = 0;
  const calls = installFetch((fn) => {
    const x = extra && extra(fn, calls);
    if (x) return x;
    if (fn === 'getMyBranches') { const r = e1s[Math.min(n, e1s.length - 1)]; n += 1; return okJson(r); }
    if (fn === 'getEditableCatalog') return okJson({ source: { restaurant_id: 'r_a', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    return errJson(404, { error: 'not_found' });
  });
  return { byId, calls, reloads, count: (fn) => calls.filter((c) => c.fn === fn).length, view: () => byId.get('viewsuc'), modal: () => byId.get('sucmodal') };
}
async function boot(P, uid = 'uOwnerLife') {
  const mods = await loadModules();
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle(20);
  return mods;
}
async function openSuc(P, rid, uid) { const mods = await boot(P, uid); mods.shell.goto('suc', rid ? { rid } : {}); await settle(5); return mods; }
const all = (root) => findAll(root, () => true);
const byText = (root, tag, t) => all(root).find((n) => n.tag === tag && textOf(n).trim() === t);
const byIdIn = (root, id) => all(root).find((n) => n.id === id);
const byAria = (root, a) => all(root).find((n) => n.attrs && n.attrs['aria-label'] === a);
const fire = (n, ev, value) => { if (value !== undefined) n.value = value; for (const fn of (n.listeners[ev] || [])) fn({ type: ev }); };
const NEVER = ['Ocupad', 'Pausada recibe', 'Definir después', 'hace un momento', 'Próximo', 'lo prepara', 'se cruza', '[pendiente]', 'provisional', 'ruta', 'pickup', 'avisa al despacho', 'ahora mismo', 'Teléfono de la sucursal'];
const noNever = (t, where) => { for (const s of NEVER) assert.ok(!t.includes(s), `${where}: never-ship «${s}»`); };

test('S2 (W on, owner): the four states, B1 legend, B2 numbering, B3 sub, B4 «Le falta», drafts + «Agregar sucursal»', async () => {
  installStorage();
  const P = page([E1([row('r_a', { name: 'Centro' }), inactive('r_b', { unmet: [] }, { name: 'Bulevar' }), staged('r_c', { unmet: ['identity_invalid', 'no_handheld_online'], identity_gaps: ['hours'] }, { name: 'Andes' })],
    [BRAND([draftOf('r_d', 'Jardines')])])]);
  await openSuc(P);
  const t = textOf(P.view());
  for (const s of ['Agregar sucursal', 'Agregar otra sucursal', 'Abierta', 'Desactivada', 'Por activar', 'Borrador', 'Dirección r_b · desactivada', 'Último pedido de hoy', '#641',
    'Lista para activar.', 'Horario, preparación y equipo en orden. Al activarla vuelve a recibir pedidos.', 'Le falta:', 'horario de los 7 días · al menos un equipo vinculado.',
    'Sherpa está configurando la ubicación', 'Vas a poder activarla cuando Sherpa termine de configurar la ubicación y la zona de entrega.',
    'no recibe pedidos, la podés activar cuando querás', 'ya tiene ubicación, falta completarla', 'El menú y los precios son los mismos para toda la marca.']) assert.ok(t.includes(s), `missing «${s}»`);
  noNever(t, 'S2');
  const draftCard = all(P.view()).find((n) => n.tag === 'button' && n.attrs['aria-label'] === 'Jardines · Borrador');
  assert.ok(draftCard && !textOf(draftCard).includes('Último pedido'), 'B2: a draft card has no numbering');
});

test('W OFF: the list is 1a\'s — no drafts, no «Agregar sucursal», no lifecycle pills', async () => {
  installStorage();
  const P = page([E1([row('r_a'), row('r_b')], [BRAND([draftOf('r_d', 'Jardines')])], false)]);
  await openSuc(P);
  const t = textOf(P.view());
  assert.ok(!t.includes('Agregar sucursal') && !t.includes('Jardines') && !t.includes('Borrador'));
  assert.ok(t.includes('Radio'), 'non-vacuity: 1a\'s card meta');
});

test('S8 checklist (staged): rows + count, Activar disabled until ready; S8b Sherpa rows; S8c notice; G3 unknown → disabled, no rows', async () => {
  for (const [readiness, want, enabled] of [
    [{ unmet: ['no_handheld_online'] }, ['Antes de activar', '1 de 7 pendientes', 'Al menos un equipo vinculado', 'Vinculá un handheld desde el equipo y encendelo una vez', 'Se habilita cuando todo esté listo. Al activarla empieza a recibir pedidos.'], false],
    [{ unmet: ['identity_invalid'], identity_gaps: ['location', 'zone'] }, ['Ubicación · pendiente — Sherpa la configura', 'Zona de entrega · pendiente — Sherpa la configura', 'Pendiente'], false],
    [{ unmet: ['brand_not_on'] }, ['Sherpa está terminando de configurar esta sucursal. Todavía no se puede activar.', 'Se habilita cuando todo esté listo.'], false],
    [null, ['Antes de activar', 'Se habilita cuando todo esté listo.'], false],
    [{ unmet: [] }, ['0 de 7 pendientes'], true],
  ]) {
    installStorage();
    const P = page([E1([staged('r_a', readiness, { name: 'Andes' })])]);
    await openSuc(P, 'r_a');
    const t = textOf(P.view());
    for (const s of want) assert.ok(t.includes(s), `${JSON.stringify(readiness)}: «${s}»`);
    if (readiness === null) assert.ok(!t.includes('Listo') && !t.includes('Falta'), 'G3: no checklist rows');
    assert.equal(byText(P.view(), 'button', 'Activar Andes').disabled, !enabled, JSON.stringify(readiness));
    noNever(t, 'S8');
  }
});

test('B8: Activar calls E8 active:true DIRECTLY with the integer token; a double tap sends exactly ONE; then E1 is re-read', async () => {
  installStorage();
  let release;
  const held = new Promise((r) => { release = r; });
  const P = page([E1([staged('r_a', { unmet: [] }, { name: 'Andes' })])], (fn) => (fn === 'setBranchActive' ? held : undefined));
  await openSuc(P, 'r_a');
  const btn = byText(P.view(), 'button', 'Activar Andes');
  btn.click(); btn.click();
  await settle(5);
  const again = byText(P.view(), 'button', 'Activar Andes');
  assert.equal(again.disabled, true, 'locked while in flight');
  again.click();
  release(okJson({ ok: true, state: 'active', projection: 'published' }));
  await settle(15);
  assert.equal(P.count('setBranchActive'), 1, 'exactly one E8');
  assert.deepEqual(P.calls.find((c) => c.fn === 'setBranchActive').body, { rid: 'r_a', expectedVersion: 7, active: true });
  assert.equal(P.count('getMyBranches'), 2, 'the §3.5 refresh');
});

test('S7: opening, Cancelar, Escape and the backdrop send NOTHING; the modal is text-only; confirm = ONE E8 active:false', async () => {
  for (const consequences of [{ live_orders: 3, scheduled_bound: 2, devices: 1 }, null, undefined]) {
    installStorage();
    const P = page([E1([row('r_a', { name: 'Centro' })])], (fn) => (fn === 'setBranchActive' ? okJson({ ok: true, state: 'inactive', ...(consequences !== undefined ? { consequences } : {}), projection: 'published' }) : undefined));
    await openSuc(P, 'r_a');
    const t0 = textOf(P.view());
    assert.ok(t0.includes('Desactivar sucursal') && t0.includes('Deja de recibir pedidos. Sus ventas, su historial y sus equipos se conservan. Es reversible: la activás de nuevo cuando querás.'));
    const before = P.calls.length;
    const openIt = () => byText(P.view(), 'button', 'Desactivar Centro').click();
    openIt();
    const mt = textOf(P.modal());
    assert.ok(P.byId.get('sucscrim').classList.contains('show'));
    for (const s of ['¿Desactivar Centro?', 'Es reversible: la activás de nuevo cuando querás. Esto es lo que pasa:', 'Pedidos en curso', 'Pedidos programados',
      'Quedan en espera hasta que la actives; no pasan a otra sucursal.', 'Equipos vinculados', 'Siguen vinculados, pero dejan de recibir pedidos nuevos.',
      'Mientras esté desactivada no recibe pedidos. Sus ventas y su historial se conservan.']) assert.ok(mt.includes(s), `modal «${s}»`);
    assert.ok(!/\d/.test(mt), 'no count anywhere in the modal');
    noNever(mt, 'S7');
    byText(P.modal(), 'button', 'Cancelar').click();
    openIt(); document.dispatchEvent({ type: 'keydown', key: 'Escape' });
    openIt(); for (const fn of P.byId.get('sucscrim').listeners.click || []) fn({ type: 'click', target: P.byId.get('sucscrim') });
    assert.equal(P.calls.length, before, 'open / Cancelar / Escape / backdrop: zero requests');
    openIt();
    byText(P.modal(), 'button', 'Desactivar Centro').click();
    await settle(15);
    assert.equal(P.count('setBranchActive'), 1);
    assert.deepEqual(P.calls.find((c) => c.fn === 'setBranchActive').body, { rid: 'r_a', expectedVersion: 7, active: false });
    assert.ok(!textOf(P.view()).match(/\b3 pedidos|\b2 programados/), 'the reply\'s consequences are never shown');
  }
});

test('s3-inactive: a Desactivada ready branch shows «Activar sucursal» (E-f) and the «· desactivada» lede; no checklist', async () => {
  installStorage();
  const P = page([E1([inactive('r_a', { unmet: [] }, { name: 'Bulevar' })])]);
  await openSuc(P, 'r_a');
  const t = textOf(P.view());
  for (const s of ['Activar sucursal', 'Empieza a recibir pedidos de nuevo. Los pedidos programados se vuelven a revisar automáticamente; algunos pueden necesitar atención del despacho.', 'Dirección r_a · desactivada', 'Desactivada']) assert.ok(t.includes(s), s);
  assert.ok(!t.includes('Antes de activar') && !t.includes('Desactivar sucursal'));
  noNever(t, 's3-inactive');
});

test('G2 s3-legacy: an active legacy row shows the one line, no Desactivar / Activar, the editors stay; no E8 is ever built', async () => {
  installStorage();
  const P = page([E1([row('r_a', { legacy: true, name: 'Centro' })], [BRAND([], { activation: 'legacy' })])]);
  await openSuc(P, 'r_a');
  const t = textOf(P.view());
  assert.ok(t.includes('Para desactivar esta sucursal, escribinos.'));
  assert.ok(!t.includes('Desactivar sucursal') && !t.includes('Activar sucursal') && !t.includes('Antes de activar'));
  assert.ok(byIdIn(P.view(), 'f1b-tel') && byIdIn(P.view(), 'h1b-mon-start'), 'WhatsApp + hours editors stay');
  assert.equal(P.count('setBranchActive'), 0);
});

test('S9 Nueva: the E6 body is exactly E6_KEYS for the CURRENT brand; the first chip pre-selected; a retry reuses the op_id; success opens the draft', async () => {
  installStorage();
  let e6 = 0;
  const P = page([E1([row('r_a', { name: 'Centro' })])], (fn) => {
    if (fn === 'createBranchDraft') { e6 += 1; return e6 === 1 ? errJson(503, { error: 'unavailable', retryable: true }) : okJson({ rid: 'r_new', state: 'draft', version: 'd.x.1.1' }); }
    if (fn === 'getMyBranches' && e6 >= 2) return okJson(E1([row('r_a', { name: 'Centro' })], [BRAND([draftOf('r_new', 'Andes')])]));
    return undefined;
  });
  await openSuc(P);
  byText(P.view(), 'button', 'Agregar sucursal').click();
  const m = P.modal();
  assert.ok(textOf(m).includes('Vos ponés el nombre, el WhatsApp, el horario y la preparación. La ubicación y la zona de entrega las configura Sherpa.'));
  assert.equal(byText(m, 'button', 'Copiar de Centro').attrs['aria-pressed'], 'true', 'the first chip is pre-selected');
  assert.ok(!textOf(m).includes('Definir después'));
  const go = () => byIdIn(P.modal(), 'nv1b-go');
  assert.equal(go().disabled, true, 'nothing typed → Crear off');
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', '  Andes ');
  fire(byIdIn(P.modal(), 'nv1b-tel'), 'input', '2234-5678');
  assert.equal(go().disabled, true, 'a landline → Crear off');
  fire(byIdIn(P.modal(), 'nv1b-tel'), 'input', '3390 5521');
  assert.equal(go().disabled, false);
  go().click();
  await settle(15);
  assert.ok(textOf(P.modal()).includes('Sin conexión con Sherpa'), 'an unresolved create is shown; the retry below re-sends it');
  go().click();
  await settle(20);
  const reqs = P.calls.filter((c) => c.fn === 'createBranchDraft');
  assert.equal(reqs.length, 2);
  assert.deepEqual(Object.keys(reqs[0].body).sort(), [...E6_KEYS].sort());
  assert.deepEqual(reqs[1].body, reqs[0].body, 'the retry of an UNRESOLVED create is the same bytes under the same op_id');
  assert.deepEqual({ ...reqs[0].body, op_id: 'X' }, { op_id: 'X', brand_id: 'marca_s', location_name: 'Andes', phone: '+50433905521', hours: WEEK, prep_default_min: 20 });
  assert.equal(P.byId.get('sucscrim').classList.contains('show'), false);
  const t = textOf(P.view());
  assert.ok(t.includes('Andes') && t.includes('Borrador') && t.includes('Eliminar borrador'), 'S9b → the new draft\'s detail (S10)');
  assert.ok(textOf(P.byId.get('opstoast')).includes('Borrador creado · Sherpa está configurando la ubicación'));
});

test('P2-3: Nueva is gated on the CURRENT brand — owner of A sees it, the same person as manager of B does not', async () => {
  for (const [brand, see] of [['marca_s', true], ['marca_m', false]]) {
    installStorage({ 'sherpa.portal.sel.uMix': { brand_id: brand, scope: null } });
    const P = page([E1([row('r_a'), row('r_m', { brand_id: 'marca_m', role: 'manager', caps: MANAGER })], [BRAND(), { brand_id: 'marca_m', name: 'Marca M', caps: [], activation: 'on' }])]);
    await openSuc(P, brand === 'marca_m' ? 'r_m' : null, 'uMix');
    assert.equal(textOf(P.view()).includes('Agregar sucursal'), see, brand);
    assert.equal(P.count('createBranchDraft'), 0);
  }
});

test('P2-7: a brand without brand.locations lists no drafts and offers no Nueva (SYNTHETIC inconsistent reply: owner rows, no brand cap, drafts)', async () => {
  installStorage();
  const P = page([E1([row('r_a'), row('r_b')], [{ brand_id: 'marca_s', name: 'Marca S', caps: [], activation: 'on', drafts: [draftOf('r_d', 'Jardines')] }])]);
  const mods = await boot(P, 'uOwnerNoCap');
  mods.shell.goto('suc'); await settle(5);
  const t = textOf(P.view());
  assert.ok(!t.includes('Jardines') && !t.includes('Agregar sucursal'));
  assert.ok(!byAria(P.view(), 'Jardines · Borrador') && textOf(P.view()).includes('R_A'), 'no draft card; non-vacuity: the list rendered');
});

test('S10 draft: editors authorized by the brand (no row caps); E7 with the STRING token; Eliminar → modal → ONE E10 → back to the list', async () => {
  installStorage();
  let deleted = false;
  const P = page([E1([row('r_a', { name: 'Centro' })], [BRAND([draftOf('r_d', 'Jardines')])])], (fn) => {
    if (fn === 'updateBranchProfile') return okJson({ version: 'd.opr_d.1.2', lifecycle: 'draft' });
    if (fn === 'deleteBranchDraft') { deleted = true; return okJson({ ok: true }); }
    if (fn === 'getMyBranches' && deleted) return okJson(E1([row('r_a', { name: 'Centro' })], [BRAND([])]));
    return undefined;
  });
  await openSuc(P, 'r_d');
  const t = textOf(P.view());
  for (const s of ['Jardines', 'Borrador', 'Sherpa está configurando la ubicación · todavía no recibe pedidos', 'Sherpa la está configurando',
    'La ubicación, la zona de entrega y la tarifa de envío las define Sherpa. Cuando estén listas, vas a poder activarla acá.', 'Ubicación y zona de entrega',
    'Si la dirección que le pasaste a Sherpa cambió, escribinos.', 'Eliminar borrador']) assert.ok(t.includes(s), s);
  assert.ok(!t.includes('Numeración') && !t.includes('Pausar pedidos') && !t.includes('Equipos ·'), 'no numbering / ops on a draft');
  assert.ok(!all(P.view()).some((n) => n.tag === 'button' && textOf(n).startsWith('Activar')) && !t.includes('Antes de activar'), 'a draft never shows Activar');
  byAria(P.view(), 'Más 5 minutos').click();
  P.byId.get('sucsave').click();
  await settle(15);
  assert.deepEqual(P.calls.find((c) => c.fn === 'updateBranchProfile').body, { rid: 'r_d', expectedVersion: 'd.opr_d.1.1', patch: { prep_default_min: 30 } });
  byText(P.view(), 'button', 'Eliminar borrador').click();
  assert.ok(textOf(P.modal()).includes('¿Eliminar el borrador «Jardines»?'));
  assert.ok(textOf(P.modal()).includes('Se borra lo que escribiste (nombre, WhatsApp, horario y preparación)'));
  assert.equal(P.count('deleteBranchDraft'), 0, 'opening the confirm sends nothing');
  byText(P.modal(), 'button', 'Eliminar borrador').click();
  await settle(20);
  assert.equal(P.count('deleteBranchDraft'), 1);
  assert.deepEqual(P.calls.find((c) => c.fn === 'deleteBranchDraft').body, { rid: 'r_d', expectedVersion: 'd.opr_d.1.1' });
  assert.ok(textOf(P.view()).includes('Agregar sucursal') && !textOf(P.view()).includes('Jardines'), 'back to the refreshed list');
});

test('§3.4 lifecycle-only shell: zero branches → nav «Sucursales» only + the s2-empty line; one draft → its card; W off → «no administra»', async () => {
  for (const [drafts, w] of [[[], true], [[draftOf('r_d', 'Jardines')], true], [[draftOf('r_d', 'Jardines')], false]]) {
    installStorage();
    const P = page([E1([], [BRAND(drafts)], w)]);
    await boot(P);
    await settle(5);
    if (!w) { assert.ok(textOf(P.byId.get('detail')).includes('Tu cuenta no administra ningún local todavía')); continue; }
    for (const id of ['navprod', 'mnprod', 'navpausas', 'navequipos', 'navventas', 'navopslabel', 'navmenulabel', 'scopewrap']) assert.ok(P.byId.get(id).classList.contains('hidden'), `${id} hidden`);
    assert.ok(!P.byId.get('navsuc').classList.contains('hidden') && !P.byId.get('viewsuc').classList.contains('hidden'), 'Sucursales shown');
    assert.equal(P.count('getEditableCatalog'), 0, 'no editor on a lifecycle-only brand');
    const t = textOf(P.view());
    assert.ok(t.includes('Agregar sucursal'));
    assert.equal(textOf(P.byId.get('shopsub')), drafts.length ? '1 sucursal' : '0 sucursales');
    if (drafts.length) { assert.ok(t.includes('Jardines') && t.includes('Agregar otra sucursal')); assert.equal(textOf(P.byId.get('navsuccount')), '1'); }
    else {
      assert.ok(t.includes('Todavía no hay sucursales en Marca S.') && t.includes('Agregá la primera. Sherpa configura la ubicación y la zona de entrega.'));
      assert.ok(!t.includes('Agregar otra sucursal'));
      assert.ok(P.byId.get('navsuccount').classList.contains('hidden'));
    }
  }
});

test('§3.4 case 3 mixed: owner of A (operational) + B (draft-only) + manager of C — the switcher lists all three; B is lifecycle-only', async () => {
  installStorage({ 'sherpa.portal.sel.uMix3': { brand_id: 'marca_b', scope: null } });
  const P = page([E1([row('r_a', { brand_id: 'marca_a' }), row('r_c', { brand_id: 'marca_c', role: 'manager', caps: MANAGER })],
    [{ brand_id: 'marca_a', name: 'Marca A', caps: ['brand.locations'], drafts: [] }, { brand_id: 'marca_b', name: 'Marca B', caps: ['brand.locations'], drafts: [draftOf('r_d', 'Jardines', 'marca_b')] },
      { brand_id: 'marca_c', name: 'Marca C', caps: [] }])]);
  const mods = await boot(P, 'uMix3');
  assert.equal(mods.shell._shellState.sel.brand_id, 'marca_b');
  assert.equal(mods.shell._shellState.sel.lifecycleOnly, true);
  assert.deepEqual(P.byId.get('switchmenu').children.map((c) => textOf(c)), ['Marca A 1 sucursal', 'Marca B 1 sucursal', 'Marca C 1 sucursal']);
  assert.ok(textOf(P.view()).includes('Jardines'));
});

test('§3.4 case 4: deleting the LAST draft keeps the brand selected as a zero-branch owned brand (no reload)', async () => {
  installStorage();
  let deleted = false;
  const P = page([E1([], [BRAND([draftOf('r_d', 'Jardines')])])], (fn) => {
    if (fn === 'deleteBranchDraft') { deleted = true; return okJson({ ok: true }); }
    if (fn === 'getMyBranches' && deleted) return okJson(E1([], [BRAND([])]));
    return undefined;
  });
  const mods = await boot(P);
  byAria(P.view(), 'Jardines · Borrador').click();
  byText(P.view(), 'button', 'Eliminar borrador').click();
  byText(P.modal(), 'button', 'Eliminar borrador').click();
  await settle(20);
  assert.equal(P.count('deleteBranchDraft'), 1);
  assert.equal(mods.shell._shellState.sel.brand_id, 'marca_s');
  assert.equal(mods.shell._shellState.sel.lifecycleOnly, true);
  assert.ok(textOf(P.view()).includes('Todavía no hay sucursales en Marca S.'));
  assert.equal(P.reloads.n, 0);
});

test('§3.4 case 5 (P3): draft → materialized STAGED → the refresh after a write makes ONE guarded reload; the new page is the operational shell (Equipos, no Pausar)', async () => {
  installStorage();
  const stagedRow = staged('r_d', { unmet: ['no_handheld_online'] }, { name: 'Jardines' });
  const P = page([E1([], [BRAND([draftOf('r_d', 'Jardines')])]), E1([stagedRow], [BRAND([])])], (fn) => (fn === 'updateBranchProfile' ? okJson({ version: 'd.x.1.2', lifecycle: 'draft' }) : undefined));
  const mods = await boot(P);
  assert.equal(mods.shell._shellState.sel.lifecycleOnly, true);
  byAria(P.view(), 'Jardines · Borrador').click();
  byAria(P.view(), 'Más 5 minutos').click();
  P.byId.get('sucsave').click();
  await settle(20);
  assert.equal(P.reloads.n, 1, 'the materialized row changes the selection → the one-time guarded reload');
  const P2 = page([E1([stagedRow], [BRAND([])])]);   // the reloaded page, same sessionStorage
  const mods2 = await boot(P2);
  assert.equal(!!mods2.shell._shellState.sel.lifecycleOnly, false, 'a staged identity is operational');
  assert.ok(!P2.byId.get('navequipos').classList.contains('hidden'), 'Equipos is reachable before activation (STAGED_CAPS ∋ device.list)');
  assert.ok(P2.byId.get('navpausas').classList.contains('hidden'), 'no Pausar (STAGED_CAPS has no location.pause)');
  mods2.shell.goto('suc', { rid: 'r_d' }); await settle(5);
  assert.ok(textOf(P2.view()).includes('Por activar') && textOf(P2.view()).includes('Antes de activar'));
});

test('§3.4 case 5b: staged → active (E8) — the caps change (STAGED → member adds location.pause) → the same one-time reload', async () => {
  installStorage();
  const P = page([E1([staged('r_a', { unmet: [] }, { name: 'Andes' })]), E1([row('r_a', { name: 'Andes' })])], (fn) => (fn === 'setBranchActive' ? okJson({ ok: true, state: 'active' }) : undefined));
  await openSuc(P, 'r_a');
  byText(P.view(), 'button', 'Activar Andes').click();
  await settle(20);
  assert.equal(P.count('setBranchActive'), 1);
  assert.equal(P.reloads.n, 1);
});

test('§3.4 case 6: W turns off while a lifecycle-only brand is selected → the next E1 falls back exactly as 1a («no administra»)', async () => {
  installStorage({ 'sherpa.portal.sel.uOwnerLife': { brand_id: 'marca_s', scope: null } });
  const P = page([E1([], [BRAND([draftOf('r_d', 'Jardines')])], false)]);
  await boot(P);
  assert.ok(textOf(P.byId.get('detail')).includes('Tu cuenta no administra ningún local todavía'));
  assert.ok(P.byId.get('navsuc').classList.contains('hidden'));
});

test('side-by-side fixes: the list order (live → Desactivada → Por activar → drafts), the nav count includes drafts (W on, owner), the Nueva phone formats on blur', async () => {
  installStorage();
  const P = page([E1([staged('r_s', { unmet: [] }, { name: 'Andes' }), inactive('r_i', { unmet: [] }, { name: 'Bulevar' }), row('r_z', { name: 'Zeta' }), row('r_a', { name: 'Alfa' })], [BRAND([draftOf('r_d', 'Jardines')])])]);
  await openSuc(P);
  const labels = all(P.view()).filter((n) => n.tag === 'button' && n.attrs['aria-label'] && n.attrs['aria-label'].includes(' · ')).map((n) => n.attrs['aria-label'].split(' · ')[0]);
  assert.deepEqual(labels, ['Alfa', 'Zeta', 'Bulevar', 'Andes', 'Jardines']);
  assert.equal(textOf(P.byId.get('navsuccount')), '5', 'every card the list shows');
  byText(P.view(), 'button', 'Agregar sucursal').click();
  fire(byIdIn(P.modal(), 'nv1b-tel'), 'input', '33905521'); fire(byIdIn(P.modal(), 'nv1b-tel'), 'change');
  assert.equal(byIdIn(P.modal(), 'nv1b-tel').value, '+504 3390-5521');
  assert.equal(byText(P.modal(), 'button', 'Copiar de Alfa').attrs['aria-pressed'], 'true');
});

test('W off: the nav count is 1a\'s (operational rows only; drafts never counted)', async () => {
  installStorage();
  const P = page([E1([row('r_a'), row('r_b')], [BRAND([draftOf('r_d', 'Jardines')])], false)]);
  await boot(P);
  assert.equal(textOf(P.byId.get('navsuccount')), '2');
});

// ══ codex 1b r1 ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
test('r1 #1: cached W on → «Nueva» open and filled → a fresh E1 with W off closes it (G4 copy) → «Crear» sends ZERO E6', async () => {
  installStorage({ 'sherpa.portal.branches.uOwnerLife': E1([row('r_a', { name: 'Centro' })]) });
  let release;
  const fresh = new Promise((r) => { release = r; });
  const P = page([E1([row('r_a', { name: 'Centro' })])], (fn) => (fn === 'getMyBranches' ? fresh : undefined));
  const mods = await boot(P);
  mods.shell.goto('suc'); await settle(5);
  byText(P.view(), 'button', 'Agregar sucursal').click();
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', 'Norte');
  fire(byIdIn(P.modal(), 'nv1b-tel'), 'input', '3390 5521');
  const go = byIdIn(P.modal(), 'nv1b-go');
  release(okJson(E1([row('r_a', { name: 'Centro' })], [BRAND()], false)));
  await settle(20);
  assert.equal(P.byId.get('sucscrim').classList.contains('show'), false, 'the modal closed on the eligibility change');
  go.click();
  await settle(10);
  assert.equal(P.count('createBranchDraft'), 0, 'zero E6');
  assert.ok(textOf(P.view()).includes('No se guardaron los cambios'), 'the filled form was discarded with G4\'s copy');
  assert.equal(mods.shell.canLeave(), true, 'nothing left dirty');
});

test('r1 #1: the S7 / S10 confirms re-check at submit — a row no longer active (fresh E1) sends no E8', async () => {
  installStorage({ 'sherpa.portal.branches.uOwnerLife': E1([row('r_a', { name: 'Centro' })]) });
  let release;
  const fresh = new Promise((r) => { release = r; });
  const P = page([E1([row('r_a', { name: 'Centro' })])], (fn) => (fn === 'getMyBranches' ? fresh : undefined));
  const mods = await boot(P);
  mods.shell.goto('suc', { rid: 'r_a' }); await settle(5);
  byText(P.view(), 'button', 'Desactivar Centro').click();
  const go = byText(P.modal(), 'button', 'Desactivar Centro');
  release(okJson(E1([inactive('r_a', { unmet: [] }, { name: 'Centro' })])));
  await settle(20);
  assert.equal(P.byId.get('sucscrim').classList.contains('show'), false);
  go.click();
  await settle(10);
  assert.equal(P.count('setBranchActive'), 0);
});

test('r1 #2: an unresolved E6 freezes its payload — the retry re-sends the SAME bytes under the same op_id; the Norte→Sur edit cannot ride it', async () => {
  installStorage();
  let e6 = 0;
  const P = page([E1([row('r_a', { name: 'Centro' })])], (fn) => {
    if (fn === 'createBranchDraft') { e6 += 1; return e6 === 1 ? errJson(503, { error: 'unavailable', retryable: true }) : e6 === 2 ? errJson(409, { error: 'op_conflict' }) : okJson({ rid: 'r_sur', state: 'draft', version: 'd.y.1.1' }); }
    return undefined;
  });
  const mods = await openSuc(P);
  byText(P.view(), 'button', 'Agregar sucursal').click();
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', 'Norte');
  fire(byIdIn(P.modal(), 'nv1b-tel'), 'input', '3390 5521');
  byIdIn(P.modal(), 'nv1b-go').click();
  await settle(15);
  assert.ok(textOf(P.modal()).includes('Sin conexión con Sherpa'), 'unresolved → the outage copy, the modal stays');
  assert.equal(byIdIn(P.modal(), 'nv1b-nombre').disabled, true, 'the fields are read-only until it resolves');
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', 'Sur');                     // a forced edit is ignored
  byText(P.modal(), 'button', 'Lun–Dom 11:00–22:00').click();                  // so is another hours choice
  byAria(P.modal(), 'Más 5 minutos').click();
  assert.equal(mods.shell.canLeave(), false, 'an unresolved create is unsaved work');
  byIdIn(P.modal(), 'nv1b-go').click();
  await settle(15);
  const [a, b] = P.calls.filter((c) => c.fn === 'createBranchDraft').map((c) => c.body);
  assert.deepEqual(b, a, 'the retry is byte-identical (name, hours, prep, op_id)');
  assert.equal(a.location_name, 'Norte');
  // op_conflict is DEFINITIVE → the form is editable again; the next «Crear» is a NEW intent (new op_id) with the new data
  assert.equal(byIdIn(P.modal(), 'nv1b-nombre').disabled, false);
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', 'Sur');
  byIdIn(P.modal(), 'nv1b-go').click();
  await settle(15);
  const c3 = P.calls.filter((c) => c.fn === 'createBranchDraft')[2].body;
  assert.equal(c3.location_name, 'Sur');
  assert.notEqual(c3.op_id, a.op_id, 'different data never rides the first op_id');
});

test('r1 #3: a filled «Nueva sucursal» is unsaved work — canLeave() is false until it is sent or discarded', async () => {
  installStorage();
  const P = page([E1([row('r_a', { name: 'Centro' })])]);
  const mods = await openSuc(P);
  byText(P.view(), 'button', 'Agregar sucursal').click();
  assert.equal(mods.shell.canLeave(), true, 'an untouched form is not dirty');
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', 'Norte');
  assert.equal(mods.shell.canLeave(), false);
  byText(P.modal(), 'button', 'Cancelar').click();
  assert.equal(mods.shell.canLeave(), true, 'discarded');
  byText(P.view(), 'button', 'Agregar sucursal').click();
  byText(P.modal(), 'button', 'Copiar de Centro').click();
  byAria(P.modal(), 'Más 5 minutos').click();
  assert.equal(mods.shell.canLeave(), false, 'the prep / hours choice counts too');
});

test('r1 #1 (submit guard, defense in depth): W flipped off in the shell\'s state WITHOUT a repaint → «Crear» still sends ZERO E6', async () => {
  installStorage();
  const P = page([E1([row('r_a', { name: 'Centro' })])]);
  const mods = await openSuc(P);
  byText(P.view(), 'button', 'Agregar sucursal').click();
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', 'Norte');
  fire(byIdIn(P.modal(), 'nv1b-tel'), 'input', '3390 5521');
  mods.shell._shellState.e1.membership_writes_enabled = false;   // no render: only the submit-time check can stop it
  byIdIn(P.modal(), 'nv1b-go').click();
  await settle(10);
  assert.equal(P.count('createBranchDraft'), 0);
});

// ══ codex 1b r2 ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
test('r2 #1: ownership revoked + W off while «Nueva» is dirty — the reload is deferred, the fresh caps still close it → ZERO E6', async () => {
  installStorage({ 'sherpa.portal.branches.uOwnerLife': E1([row('r_a', { name: 'Centro' })]) });
  let release;
  const fresh = new Promise((r) => { release = r; });
  const P = page([E1([row('r_a', { name: 'Centro' })])], (fn) => (fn === 'getMyBranches' ? fresh : undefined));
  const mods = await boot(P);
  mods.shell.goto('suc'); await settle(5);
  byText(P.view(), 'button', 'Agregar sucursal').click();
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', 'Norte');
  fire(byIdIn(P.modal(), 'nv1b-tel'), 'input', '3390 5521');
  const go = byIdIn(P.modal(), 'nv1b-go');
  release(okJson(E1([row('r_a', { name: 'Centro', role: 'manager', caps: MANAGER })], [BRAND([], { caps: [] })], false)));
  await settle(20);
  assert.equal(P.reloads.n, 0, 'premise: the reload is deferred by the unsaved form');
  assert.equal(P.byId.get('sucscrim').classList.contains('show'), false, 'the fresh caps closed the modal anyway');
  go.click();
  await settle(10);
  assert.equal(P.count('createBranchDraft'), 0);
});

test('r2 #1: the prep capability revoked under an unsaved prep edit (reload deferred) → Guardar off → ZERO E7', async () => {
  installStorage({ 'sherpa.portal.branches.uOwnerLife': E1([row('r_a', { name: 'Centro' })]) });
  let release;
  const fresh = new Promise((r) => { release = r; });
  const P = page([E1([row('r_a', { name: 'Centro' })])], (fn) => (fn === 'getMyBranches' ? fresh : undefined));
  const mods = await boot(P);
  mods.shell.goto('suc', { rid: 'r_a' }); await settle(5);
  byAria(P.view(), 'Más 5 minutos').click();
  release(okJson(E1([row('r_a', { name: 'Centro', caps: OWNER.filter((c) => c !== 'location.prep') })])));
  await settle(20);
  assert.equal(P.reloads.n, 0, 'premise: the reload is deferred by the unsaved edit');
  assert.equal(P.byId.get('sucsave').disabled, true, 'Guardar is off for a revoked group');
  assert.equal(byAria(P.view(), 'Más 5 minutos').disabled, true, 'the prep editor is disabled');
  P.byId.get('sucsave').click();
  await settle(10);
  assert.equal(P.count('updateBranchProfile'), 0);
});

test('r2 #2: a 500 / an unknown code is UNRESOLVED — locked, the retry is the same op_id + bytes; Cancelar → reopen keeps the same intent', async () => {
  installStorage();
  let e6 = 0;
  const P = page([E1([row('r_a', { name: 'Centro' })])], (fn) => {
    if (fn === 'createBranchDraft') { e6 += 1; return e6 === 1 ? errJson(500, { error: 'internal' }) : e6 === 2 ? errJson(409, { error: 'some_future_code' }) : okJson({ rid: 'r_n', state: 'draft', version: 'd.z.1.1' }); }
    return undefined;
  });
  const mods = await openSuc(P);
  byText(P.view(), 'button', 'Agregar sucursal').click();
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', 'Norte');
  fire(byIdIn(P.modal(), 'nv1b-tel'), 'input', '3390 5521');
  byIdIn(P.modal(), 'nv1b-go').click();
  await settle(15);
  assert.equal(byIdIn(P.modal(), 'nv1b-nombre').disabled, true, '500 → still locked');
  byText(P.modal(), 'button', 'Cancelar').click();
  assert.equal(P.byId.get('sucscrim').classList.contains('show'), false);
  assert.equal(mods.shell.canLeave(), false, 'the unresolved create is still unsaved work after dismissal');
  byText(P.view(), 'button', 'Agregar sucursal').click();
  assert.equal(byIdIn(P.modal(), 'nv1b-nombre').value, 'Norte', 'reopened: the same locked payload');
  assert.equal(byIdIn(P.modal(), 'nv1b-nombre').disabled, true);
  byIdIn(P.modal(), 'nv1b-go').click();
  await settle(15);
  assert.equal(byIdIn(P.modal(), 'nv1b-nombre').disabled, true, 'an unknown code → still locked');
  byIdIn(P.modal(), 'nv1b-go').click();
  await settle(20);
  const bodies = P.calls.filter((c) => c.fn === 'createBranchDraft').map((c) => c.body);
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies[1], bodies[0]); assert.deepEqual(bodies[2], bodies[0]);
  assert.equal(mods.shell.canLeave(), true, 'resolved (200) → nothing pending');
});

// ══ item 6 (OWNER-APPROVED 2026-10-26): the E6 name refusals, D-b inline under the name ═════════════════════════════════════════
test('item 6: name_taken → the owner line under the name, «Crear» off until the name changes; the changed name is a NEW intent', async () => {
  installStorage();
  let e6 = 0;
  const P = page([E1([row('r_a', { name: 'Centro' })])], (fn) => {
    if (fn === 'createBranchDraft') { e6 += 1; return e6 === 1 ? errJson(409, { error: 'name_taken' }) : okJson({ rid: 'r_n', state: 'draft', version: 'd.n.1.1' }); }
    return undefined;
  });
  await openSuc(P);
  byText(P.view(), 'button', 'Agregar sucursal').click();
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', 'Norte');
  fire(byIdIn(P.modal(), 'nv1b-tel'), 'input', '3390 5521');
  assert.equal(byIdIn(P.modal(), 'nv1b-nombre-err'), undefined, 'non-vacuity: no name error before the refusal');
  byIdIn(P.modal(), 'nv1b-go').click();
  await settle(15);
  const err = byIdIn(P.modal(), 'nv1b-nombre-err');
  assert.ok(err, 'the inline error renders');
  assert.equal(textOf(err).trim(), 'Ya hay una sucursal con ese nombre en esta marca.');
  assert.equal(err.className, 'ferr1b', 'the D-b inline style (the WhatsApp error class)');
  assert.equal(byIdIn(P.modal(), 'nv1b-nombre').attrs['aria-invalid'], 'true');
  assert.equal(byIdIn(P.modal(), 'nv1b-nombre').attrs['aria-describedby'], 'nv1b-nombre-err');
  assert.ok(!textOf(P.modal()).includes('No se guardaron los cambios'), 'not the G4 generic box');
  assert.equal(byIdIn(P.modal(), 'nv1b-nombre').disabled, false, 'definitive → editable');
  assert.equal(byIdIn(P.modal(), 'nv1b-go').disabled, true, '«Crear» off on the refused name');
  byIdIn(P.modal(), 'nv1b-go').click();
  await settle(5);
  assert.equal(P.count('createBranchDraft'), 1, 'a click on the refused name sends nothing');
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', 'Norte 2');
  assert.equal(byIdIn(P.modal(), 'nv1b-nombre-err'), undefined, 'a changed name clears the line');
  assert.equal(byIdIn(P.modal(), 'nv1b-go').disabled, false, 'and enables «Crear»');
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', ' Norte ');
  assert.ok(byIdIn(P.modal(), 'nv1b-nombre-err'), 'back to the refused name (as sent, trimmed) → the line returns');
  assert.equal(byIdIn(P.modal(), 'nv1b-go').disabled, true);
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', 'Sur');
  byIdIn(P.modal(), 'nv1b-go').click();
  await settle(15);
  const [a, b] = P.calls.filter((c) => c.fn === 'createBranchDraft').map((c) => c.body);
  assert.equal(a.location_name, 'Norte'); assert.equal(b.location_name, 'Sur');
  assert.notEqual(b.op_id, a.op_id, 'name_taken is definitive: the new name is a new op_id');
});

test('item 6: bad_name (defensive) → «Escribí un nombre de hasta 60 caracteres.» under the name, same rule', async () => {
  installStorage();
  const P = page([E1([row('r_a', { name: 'Centro' })])], (fn) => (fn === 'createBranchDraft' ? errJson(400, { error: 'bad_name' }) : undefined));
  await openSuc(P);
  byText(P.view(), 'button', 'Agregar sucursal').click();
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', 'Norte');
  fire(byIdIn(P.modal(), 'nv1b-tel'), 'input', '3390 5521');
  byIdIn(P.modal(), 'nv1b-go').click();
  await settle(15);
  assert.equal(textOf(byIdIn(P.modal(), 'nv1b-nombre-err')).trim(), 'Escribí un nombre de hasta 60 caracteres.');
  assert.equal(byIdIn(P.modal(), 'nv1b-go').disabled, true);
  assert.ok(!textOf(P.modal()).includes('No se guardaron los cambios'), 'inline, not the G4 box');
  assert.equal(byIdIn(P.modal(), 'nv1b-tel-err'), undefined, 'the name refusal never marks the WhatsApp');
});

test('item 6: op_conflict still shows the G4 box, never a name line', async () => {
  installStorage();
  const P = page([E1([row('r_a', { name: 'Centro' })])], (fn) => (fn === 'createBranchDraft' ? errJson(409, { error: 'op_conflict' }) : undefined));
  await openSuc(P);
  byText(P.view(), 'button', 'Agregar sucursal').click();
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', 'Norte');
  fire(byIdIn(P.modal(), 'nv1b-tel'), 'input', '3390 5521');
  byIdIn(P.modal(), 'nv1b-go').click();
  await settle(15);
  assert.ok(textOf(P.modal()).includes('No se guardaron los cambios'), 'the G4 box');
  assert.equal(byIdIn(P.modal(), 'nv1b-nombre-err'), undefined);
  assert.equal(byIdIn(P.modal(), 'nv1b-go').disabled, false, 'op_conflict does not lock «Crear» on the name');
});

// ══ codex 1b r3 #2: Codex's two reproductions, the portal's E6 answered by the REAL core over the faithful fake RTDB ════════════════
const CORE = require('../xpizza-functions/portal/branch-lifecycle-core.js');
const { fakeRtdb } = require('../xpizza-functions/test/_fake-rtdb-sdk.js');
const RID = require('../xpizza-functions/branches/rid-alloc.js');
const T0 = 1_800_000_000_000;
const SIDENT = (name) => ({ name: 'Marca S', brand_id: 'marca_s', location_name: name, phone: '+50431234567', hours: WEEK, prep_default_min: 20, hub_lat: 15.6, hub_lng: -88,
  zone: { type: 'circle', radius_km: 5 }, delivery_radius_km: 5, whatsapp_instance: '', whatsapp_enabled: false, active: true, active_changed_at: 1, version: 7 });
const serverWorld = (restaurants = {}) => fakeRtdb({
  platform_config: { membership_writes_enabled: true },
  brands: { marca_s: { name: 'Marca S', active: true, locations: { r_a: 'member' }, activation: { state: 'on', since: 1 }, projection_gen: 2 } },
  restaurants: { r_a: { identity: SIDENT('Centro') }, ...restaurants },
  brand_members: { marca_s: { owners: { uOwnerLife: { granted_at: 1, granted_by: 'x' } } } },
  member_of: { uOwnerLife: { brands: { marca_s: 'owner' } } },
});
let clk = 0;
const realE6 = (db, b) => CORE.createBranchDraftCore({ db, verifyIdToken: async (tok) => ({ uid: tok }), now: () => T0 + (++clk), clock: () => T0 + clk, log: { warn() {}, log() {} } },
  { method: 'POST', body: b, get: (h) => (h === 'authorization' ? 'Bearer uOwnerLife' : undefined) });
const asResponse = (r) => (r.status < 400 ? okJson(r.body) : errJson(r.status, r.body));
const draftsOf = (db) => Object.entries(db.get('restaurants') || {}).filter(([, v]) => v && v.draft && v.draft.brand_id === 'marca_s').map(([rid, v]) => ({ rid, op_id: v.draft.op_id, name: v.draft.location_name }));

test('r3 #2 (Codex repro 1): the retry meets brand_busy while the ORIGINAL E6 still holds the lease → still locked, same op_id; the original completes; ONE draft', async () => {
  installStorage();
  const db = serverWorld();
  const cand = RID.ridCandidates('marca_s', 'Norte')[0];
  let release; const gate = new Promise((r) => { release = r; });
  db.hooks[`restaurants/${cand}/draft`] = () => gate;   // the original call pauses holding the brand lease, right before its draft write
  let original = null; const answers = [];
  const P = page([E1([row('r_a', { name: 'Centro' })])], (fn, calls) => {
    if (fn !== 'createBranchDraft') return undefined;
    const b = calls[calls.length - 1].body;
    if (!original) { original = realE6(db, b); return errJson(503, { error: 'unavailable', retryable: true }); }   // its response is lost
    return realE6(db, b).then((r) => { answers.push(r.body.error || 'ok'); return asResponse(r); });
  });
  await openSuc(P);
  byText(P.view(), 'button', 'Agregar sucursal').click();
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', 'Norte');
  fire(byIdIn(P.modal(), 'nv1b-tel'), 'input', '3390 5521');
  byIdIn(P.modal(), 'nv1b-go').click();
  await settle(15);
  byIdIn(P.modal(), 'nv1b-go').click();   // the retry, while the original still holds the lease
  await settle(15);
  assert.deepEqual(answers, ['brand_busy'], 'non-vacuity: the real server answered brand_busy');
  assert.equal(byIdIn(P.modal(), 'nv1b-nombre').disabled, true, 'brand_busy is UNRESOLVED: the form stays locked');
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', 'Otra');   // a forced edit cannot ride a new intent
  release(); assert.equal((await original).status, 200, 'the original completes server-side');
  byIdIn(P.modal(), 'nv1b-go').click();
  await settle(20);
  assert.deepEqual(answers, ['brand_busy', 'ok'], 'the same op is recognised complete');
  const bodies = P.calls.filter((c) => c.fn === 'createBranchDraft').map((c) => c.body);
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies[1], bodies[0]); assert.deepEqual(bodies[2], bodies[0]);
  assert.deepEqual(draftsOf(db), [{ rid: cand, op_id: bodies[0].op_id, name: 'Norte' }], 'exactly ONE draft, the original op');
});

test('r3 #2 (Codex repro 2): draft_conflict is terminal (the server released the lock) → the form is released with the G4 box; the corrected name is a new op and succeeds', async () => {
  installStorage();
  const cand = RID.ridCandidates('marca_s', 'Norte')[0];
  const db = serverWorld({ [cand]: { draft: { brand_id: 'marca_s', location_name: 'Vieja', phone: '+50433905521', hours: WEEK, prep_default_min: 20, op_id: 'op_stray', inc: 'c0', created_at: 1, created_by: 'x' } } });
  const answers = [];
  const P = page([E1([row('r_a', { name: 'Centro' })])], (fn, calls) => (fn === 'createBranchDraft'
    ? realE6(db, calls[calls.length - 1].body).then((r) => { answers.push(r.body.error || 'ok'); return asResponse(r); }) : undefined));
  await openSuc(P);
  byText(P.view(), 'button', 'Agregar sucursal').click();
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', 'Norte');
  fire(byIdIn(P.modal(), 'nv1b-tel'), 'input', '3390 5521');
  byIdIn(P.modal(), 'nv1b-go').click();
  await settle(15);
  assert.deepEqual(answers, ['draft_conflict'], 'non-vacuity: the real server answered draft_conflict');
  assert.equal(db.get('brand_ops/marca_s'), null, 'and released its lock');
  assert.ok(textOf(P.modal()).includes('No se guardaron los cambios'), 'the G4 box (no new copy)');
  assert.equal(byIdIn(P.modal(), 'nv1b-nombre').disabled, false, 'the form is released');
  assert.equal(byIdIn(P.modal(), 'nv1b-go').disabled, false);
  fire(byIdIn(P.modal(), 'nv1b-nombre'), 'input', 'Sur');
  byIdIn(P.modal(), 'nv1b-go').click();
  await settle(20);
  assert.deepEqual(answers, ['draft_conflict', 'ok']);
  const [a, b] = P.calls.filter((c) => c.fn === 'createBranchDraft').map((c) => c.body);
  assert.notEqual(b.op_id, a.op_id, 'a new intent, a new op_id');
  assert.ok(draftsOf(db).some((d) => d.name === 'Sur' && d.op_id === b.op_id), 'the corrected create succeeded server-side');
});
