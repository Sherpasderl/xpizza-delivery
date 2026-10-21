// PORTAL-UI 1a — the pure branch decisions. Run: node --test xpizza-portal/branch-logic.test.mjs
// Fixtures are SYNTHETIC brands (brand-agnostic): nothing here is a real restaurant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from './branch-logic.js';

const HOURS = { mon: { open: true, start: '11:00', end: '22:00' }, tue: { open: true, start: '11:00', end: '22:00' }, wed: { open: false },
  thu: { open: true, start: '11:00', end: '22:00' }, fri: { open: true, start: '11:00', end: '23:00' }, sat: { open: true, start: '11:00', end: '23:00' },
  sun: { open: true, start: '12:00', end: '21:00' } };
const at = (iso) => Date.parse(iso);   // UTC instants; Honduras = UTC−6
const OWNER_CAPS = ['catalog.read_editor', 'stats.read', 'availability.set', 'location.prep', 'location.pause', 'location.hours'];
const MGR_CAPS = ['stats.read', 'availability.set', 'location.prep', 'location.pause', 'location.hours'];
const br = (rid, extra = {}) => ({ rid, brand_id: 'marca_t', role: 'owner', state: 'member', caps: OWNER_CAPS, name: rid.toUpperCase(),
  identity_version: 3, editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 3.5, hours: HOURS, phone: '+50400000000' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null, ...extra });
const E1 = (branches, brands = [{ brand_id: 'marca_t', name: 'Marca T' }]) => ({ brands, branches });

test('the radius is printed EXACTLY as stored — never rounded or clamped', () => {
  assert.equal(L.kmText(7), '7');
  assert.equal(L.kmText(9.66), '9.66');
  assert.equal(L.kmText(3.5), '3.5');
  assert.equal(L.kmText(12.125), '12.125');
  assert.equal(L.kmText(null), '—');
  assert.equal(L.kmText(NaN), '—');
});

test('state model: every control state, with the r5 copy (no routing / ETA claims)', () => {
  const mon1400 = at('2026-10-19T20:00:00Z');   // Monday 14:00 in Honduras
  let m = L.stateModel(br('a'), mon1400);
  assert.deepEqual([m.state, m.pillCls, m.label, m.line1, m.line2], ['open', 'open', 'Abierta', 'Abierta · recibe pedidos', 'Cierra a las 22:00']);
  m = L.stateModel(br('a', { control: { state: 'paused', paused_until: at('2026-10-19T20:30:00Z'), pause_reason: 'Cocina llena', pause_since: mon1400 } }), mon1400);
  assert.deepEqual([m.state, m.label, m.line1, m.line2], ['paused', 'Pausada', 'Pausada · Cocina llena', 'Desde las 14:00 · hasta las 14:30']);
  m = L.stateModel(br('a', { control: { state: 'paused', paused_until: null, pause_reason: null, pause_since: null } }), mon1400);
  assert.deepEqual([m.line1, m.line2], ['Pausada · Manual', 'Hasta que la reanudés']);
  m = L.stateModel(br('a', { control: { state: 'closed' } }), at('2026-10-21T20:00:00Z'));   // Wednesday (closed all day)
  assert.deepEqual([m.state, m.label, m.line1, m.line2], ['closed', 'Cerrada', 'Cerrada por horario', 'Abre mañana a las 11:00']);
  m = L.stateModel(br('a', { control: { state: 'closed' } }), at('2026-10-19T15:00:00Z'));   // Monday 09:00, opens later today
  assert.equal(m.line2, 'Abre a las 11:00');
  m = L.stateModel(br('a', { control: { state: 'inactive' } }), mon1400);
  assert.deepEqual([m.state, m.pillCls, m.label, m.line1], ['inactive', 'closed', 'Inactiva', 'Inactiva · no recibe pedidos']);
  m = L.stateModel(br('a', { control: { state: 'weird' } }), mon1400);
  assert.deepEqual([m.state, m.label], ['unknown', 'Sin datos']);
  m = L.stateModel({ rid: 'x' }, mon1400);
  assert.equal(m.state, 'unknown');
  for (const st of ['open', 'paused', 'closed', 'inactive', 'unknown']) {
    const t = L.stateModel(br('a', { control: { state: st } }), mon1400);
    assert.ok(!/ruta|más cercana|listo en/i.test(`${t.line1} ${t.line2}`), `${st}: no routing / customer-ETA promise`);
  }
});

test('hours rows: Monday first, from both seed shapes', () => {
  const rows = L.hoursRows(HOURS);
  assert.deepEqual(rows.map((r) => r.d), ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']);
  assert.deepEqual(rows[2], { key: 'wed', d: 'Mié', open: false, from: '', to: '' });
  assert.deepEqual(rows[4], { key: 'fri', d: 'Vie', open: true, from: '11:00', to: '23:00' });
  const sparse = L.hoursRows({ mon: { open: false }, sun: { open: true, start: '12:00', end: '19:45' } });
  assert.equal(sparse.filter((r) => r.open).length, 1);
  assert.equal(L.hoursRows(null).every((r) => !r.open), true);
});

test('prep: 5–120 in steps of 5; an unset value starts at 20; the dirty label is the prototype\'s', () => {
  assert.equal(L.stepPrep(20, +1), 25);
  assert.equal(L.stepPrep(20, -1), 15);
  assert.equal(L.stepPrep(120, +1), 120);
  assert.equal(L.stepPrep(5, -1), 5);
  assert.equal(L.stepPrep(null, +1), 20);
  assert.equal(L.stepPrep(null, -1), 20);
  assert.equal(L.prepText(25), '25');
  assert.equal(L.prepText(null), 'Falta');
  assert.ok(L.validPrep(5) && L.validPrep(120) && !L.validPrep(4) && !L.validPrep(121) && !L.validPrep(20.5));
  assert.deepEqual(L.dirtyLabels(br('a'), { prep_default_min: 25 }), ['preparación']);
  assert.deepEqual(L.dirtyLabels(br('a'), { prep_default_min: 20 }), []);
  assert.deepEqual(L.dirtyLabels(br('a'), null), []);
  assert.equal(L.prepMissing(br('a', { editable: { prep_default_min: null } })), true);
  assert.equal(L.prepMissing(br('a')), false);
});

test('numbering: «Último pedido de hoy» or «Sin pedidos hoy» — never a «Próximo»', () => {
  assert.equal(L.lastOrderText(417), '#417');
  assert.equal(L.lastOrderText(null), 'Sin pedidos hoy');
  assert.equal(L.lastOrderText(undefined), 'Sin pedidos hoy');
});

test('selection: an owner of two branches defaults to «Todas»; a single-branch manager is locked; a stored choice is honoured only while valid', () => {
  const e1 = E1([br('t_norte'), br('t_centro')]);
  let s = L.resolveSelection(e1, null);
  assert.deepEqual([s.brand_id, s.scope, s.locked, s.owner], ['marca_t', 'all', false, true]);
  s = L.resolveSelection(e1, { brand_id: 'marca_t', scope: 't_norte' });
  assert.equal(s.scope, 't_norte');
  s = L.resolveSelection(e1, { brand_id: 'marca_t', scope: 't_gone' });
  assert.equal(s.scope, 'all', 'a revoked branch falls back');
  s = L.resolveSelection(e1, { brand_id: 'other', scope: 'x' });
  assert.equal(s.brand_id, 'marca_t');
  const mgr = E1([br('t_norte', { role: 'manager', caps: MGR_CAPS })]);
  s = L.resolveSelection(mgr, { brand_id: 'marca_t', scope: 'all' });
  assert.deepEqual([s.scope, s.locked, s.owner], ['t_norte', true, false], 'a manager can never select «Todas»');
  assert.equal(L.resolveSelection(E1([]), null), null);
  // a stats-only (retired) branch never enters the operational scope
  const withRetired = E1([br('t_norte'), { rid: 't_viejo', brand_id: 'marca_t', role: 'owner', state: 'retired', caps: ['stats.read'], name: 'Viejo' }]);
  s = L.resolveSelection(withRetired, null);
  assert.deepEqual(s.brand.branches.map((b) => b.rid), ['t_norte']);
  assert.equal(s.scope, 't_norte');
});

test('the editor opens only on a catalog.read_editor branch; Ventas is owner-only in 1a', () => {
  const owner1 = L.resolveSelection(E1([br('t_norte')]), null);
  assert.equal(L.editorRidFor(owner1, null), 't_norte');
  assert.equal(L.salesFor(owner1, 't_norte'), true);
  const mgr = L.resolveSelection(E1([br('t_norte', { role: 'manager', caps: MGR_CAPS })]), null);
  assert.equal(L.editorRidFor(mgr, null), null, 'no catalog.read_editor → no editor');
  const mgrMenu = L.resolveSelection(E1([br('t_norte', { role: 'manager', caps: [...MGR_CAPS, 'catalog.read_editor'] })]), null);
  assert.equal(L.editorRidFor(mgrMenu, null), 't_norte', 'a menu-permitted manager gets the editor');
  assert.equal(L.salesFor(mgrMenu, 't_norte'), false, 'but not Ventas (owner-only in 1a, even with stats.read)');
  const two = L.resolveSelection(E1([br('t_norte'), br('t_centro')]), null);
  assert.equal(two.scope, 'all');
  assert.equal(L.editorRidFor(two, 't_norte'), 't_norte', '«Todas»: the remembered branch');
  assert.equal(L.editorRidFor(two, null), 't_centro', '«Todas»: else the first by name');
  assert.equal(L.salesFor(null, 'x'), false);
});

test('the «Todas» union: per-branch menus, applicability per branch, the first branch names the row', () => {
  const menus = [
    { rid: 'b', published: true, items: [{ key: 'k1', name: 'Uno B', category_id: 'c1', category_name: 'Cat 1', price: 100 }, { key: 'k3', name: 'Tres', category_id: 'c2', category_name: null, price: 50 }], unavailable: ['k1'] },
    { rid: 'a', published: true, items: [{ key: 'k1', name: 'Uno A', category_id: 'c1', category_name: 'Cat 1', price: 100 }, { key: 'k2', name: 'Dos', category_id: 'c1', category_name: 'Cat 1', price: 75 }], unavailable: [] },
    { rid: 'c', published: false, items: [], unavailable: [] },
    { rid: 'd', published: null, error: 'menu_unavailable', items: [], unavailable: [] },
  ];
  const { items, categories } = L.availabilityUnion(menus, ['a', 'b', 'c', 'd']);
  assert.deepEqual([...items.keys()].sort(), ['k1', 'k2', 'k3']);
  assert.deepEqual(items.get('k1').applicable, ['a', 'b']);
  assert.deepEqual(items.get('k1').out, ['b']);
  assert.equal(items.get('k1').name, 'Uno A', 'the first branch in order names the row');
  assert.deepEqual(items.get('k2').applicable, ['a']);
  assert.deepEqual(items.get('k3').applicable, ['b']);
  assert.deepEqual(categories.map((c) => [c.id, c.name]), [['c1', 'Cat 1'], ['c2', 'c2']], 'a missing category name falls back to its id');
  assert.equal(L.soldOutCount(menus, 'b'), 1);
  assert.equal(L.soldOutCount(menus, 'zz'), 0);
});

test('price text groups thousands; nav model by role', () => {
  assert.equal(L.priceText(340), 'L 340');
  assert.equal(L.priceText(12500), 'L 12,500');
  assert.equal(L.priceText(1234567), 'L 1,234,567');
  assert.equal(L.priceText(null), '');
  const own = L.navModel(L.resolveSelection(E1([br('a'), br('b')]), null));
  assert.deepEqual([own.sucLabel, own.sucCount, own.pause], ['Sucursales', 2, true]);
  const mgr = L.navModel(L.resolveSelection(E1([br('a', { role: 'manager', caps: ['availability.set'] })]), null));
  assert.deepEqual([mgr.sucLabel, mgr.sucCount, mgr.pause], ['Mi sucursal', null, false]);
});

test('time helpers read the Honduras clock (UTC−6, no DST)', () => {
  assert.equal(L.hhmm(at('2026-10-19T05:59:00Z')), '23:59');
  assert.equal(L.hhmm(at('2026-10-19T06:00:00Z')), '00:00');
  assert.equal(L.dayKeyAt(at('2026-10-19T05:59:00Z')), 'sun');
  assert.equal(L.dayKeyAt(at('2026-10-19T06:00:00Z')), 'mon');
  assert.equal(L.closesAt(HOURS, at('2026-10-21T20:00:00Z')), null, 'closed today');
  assert.equal(L.nextOpening(null, Date.now()), null);
});

// ── slice 2 «Equipos» (PLAN-portal-ui-slice2-equipos r1.1 §2) ──────────────────────────────────────────────────────────
test('Equipos: «En línea» ≤ 3 min BEFORE THE FETCH, «Sin señal» after; never seen → «Sin señal» + «Nunca»', () => {
  const F = Date.UTC(2026, 9, 20, 18, 0);
  assert.equal(L.onlineState(F, F - 180000), 'online', '3:00 → online');
  assert.equal(L.onlineState(F, F - 180001), 'nosignal', '3:00.001 → no signal');
  assert.equal(L.onlineState(F, null), 'nosignal');
  assert.deepEqual(L.STATUS.online, { label: 'En línea', cls: 'open' });
  assert.deepEqual(L.STATUS.nosignal, { label: 'Sin señal', cls: 'eqwarn' });
  assert.equal(L.lastSeenText(F, null), 'Nunca');
  assert.equal(L.lastSeenText(F, F - 5000), 'hace 1 min');
  assert.equal(L.lastSeenText(F, F - 14 * 60000), 'hace 14 min');
  assert.equal(L.lastSeenText(F, F - 3 * 3600000), 'hace 3 h');
  assert.equal(L.lastSeenText(F, Date.UTC(2026, 9, 2, 18)), 'el 2 oct', 'older than a day → the date (Honduras time)');
});

test('Equipos: «Vinculado el … por …» — manager name / «el dueño» / date only; «Equipo N»; counts', () => {
  const at = Date.UTC(2026, 9, 2, 15);
  assert.equal(L.pairedText({ paired_at: at, paired_by_name: 'Lucía Paz', paired_by_owner: false }), 'Vinculado el 2 oct por Lucía Paz');
  assert.equal(L.pairedText({ paired_at: at, paired_by_name: null, paired_by_owner: true }), 'Vinculado el 2 oct por el dueño');
  assert.equal(L.pairedText({ paired_at: at, paired_by_name: null, paired_by_owner: false }), 'Vinculado el 2 oct');
  assert.equal(L.deviceLabel({ n: 2 }), 'Equipo 2');
  assert.deepEqual([L.countText(1), L.countText(3)], ['1 equipo', '3 equipos']);
});

test('Equipos: «Antes de vincular» — pairing off → one line, no «Lista»; on → per branch Lista / Falta preparación', () => {
  const br = [{ rid: 'b1', prep_ok: true, devices: [{}, {}] }, { rid: 'b2', prep_ok: false, devices: [] }, { rid: 'b3', error: 'devices_unavailable' }];
  const info = (rid) => ({ name: rid.toUpperCase(), prep: rid === 'b1' ? 20 : null });
  assert.deepEqual(L.pairChecks(br, false, info), { off: true, rows: [] });
  assert.deepEqual(L.pairChecks(br, 'true', info), { off: true, rows: [] }, 'only the strict boolean');
  assert.deepEqual(L.pairChecks(br, true, info).rows.map((r) => [r.name, r.state, r.sub]), [
    ['B1', 'Lista', 'Preparación normal 20 min · 2 equipos'],
    ['B2', 'Falta preparación', 'Definí el tiempo de preparación normal en la sucursal'],
  ], 'a failed branch is not listed as ready or missing');
});

test('Equipos: the revoke modal\'s last-device facts — the pause wording only for a handheld branch\'s ONLY device', () => {
  const two = { order_surface: 'handheld', devices: [{ uid: 'a' }, { uid: 'b' }] };
  assert.deepEqual(L.revokeFacts(two, 'a'), { lastOne: false, pauses: false });
  assert.deepEqual(L.revokeFacts({ order_surface: 'handheld', devices: [{ uid: 'a' }] }, 'a'), { lastOne: true, pauses: true });
  assert.deepEqual(L.revokeFacts({ order_surface: 'kds', devices: [{ uid: 'a' }] }, 'a'), { lastOne: true, pauses: false });
});

test('Equipos: navModel offers «Equipos» only when a branch of the selection holds device.list', () => {
  const sel = (caps) => ({ owner: true, brand: { branches: [{ rid: 'b1', caps }] } });
  assert.equal(L.navModel(sel(['location.pause', 'device.list'])).devices, true);
  assert.equal(L.navModel(sel(['location.pause'])).devices, false);
});
