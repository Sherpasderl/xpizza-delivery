// «Pausar pedidos» moves inside «Sucursales» (PLAN-portal-pausar-in-sucursales-r0 §2.1–§2.4; MOCKUP-portal-pausar-in-sucursales F1–F5,
// advisor 11-13: build to the visually-checked delta). The pause control (pause-control.js: the action, the #pausemodal confirm,
// send → setBranchPause) now lives on each branch's page; every behaviour cell is a PARITY cell on today's pausing, through the REAL
// app.js / ventas.js / shell.js (shell.test.mjs's harness). The «Pausar pedidos» nav entry and view are gone; an old «pausas» entry lands
// per pauseLanding (the branch's page, or the list for «Todas»).
// Run: node --test pause-control.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { installDom, installFetch, loadModules, okJson, errJson, settle, textOf } from './ventas-harness.mjs';
import { OFFLINE } from './ops-dom.js';
import { pauseLanding } from './pause-control.js';

const MENU = () => okJson({ source: { restaurant_id: 'r_a', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
const OWNER_CAPS = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'stats.read', 'availability.set', 'location.prep', 'location.pause', 'location.hours'];
const branch = (rid, extra = {}) => ({ rid, brand_id: 'marca_s', role: 'owner', state: 'member', caps: OWNER_CAPS, name: rid.toUpperCase(),
  identity_version: 2, editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null, ...extra });
const E1 = (branches) => ({ brands: [{ brand_id: 'marca_s', name: 'Marca S' }], branches });
const all = (n) => (n && n.children ? n.children : []).flatMap((c) => (c && typeof c === 'object' ? [c, ...all(c)] : []));
const btn = (root, t) => all(root).find((n) => n.tag === 'button' && textOf(n) === t);
function storage() {
  const m = new Map();
  globalThis.sessionStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}
async function open(branches, setBranchPause) {
  storage();
  const byId = installDom();
  globalThis.window.location = { reload: () => {} };
  globalThis.window.scrollTo = () => {};
  globalThis.__branchesDirect = true;
  const calls = installFetch((fn, q) => {
    if (fn === 'setBranchPause') return setBranchPause(q);
    if (fn === 'getMyBranches') return okJson(E1(branches));
    if (fn === 'getEditableCatalog') return MENU();
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    return errJson(404, { error: 'not_found' });
  });
  const mods = await loadModules();
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'uOwnerPC' } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle(20);
  mods.shell.goto('suc', { rid: branches[0].rid }); await settle(5);
  return { byId, calls, mods, view: byId.get('viewsuc'), modal: byId.get('pausemodal'), pauses: () => calls.filter((c) => c.fn === 'setBranchPause').map((c) => c.body) };
}
const PAUSED = (until = Date.now() + 1800e3) => ({ state: 'paused', paused_until: until, pause_reason: 'Falta personal', pause_since: Date.now() });

test('ONE control on the branch page: pausas.js and its view are gone; shell.js no longer imports it; pause-control.js holds the request', () => {
  assert.equal(existsSync(new URL('./pausas.js', import.meta.url)), false, '🔴 the «Pausar pedidos» view module is gone');
  const pc = readFileSync(new URL('./pause-control.js', import.meta.url), 'utf8');
  assert.match(pc, /export function pauseControl\(/); assert.ok(pc.includes('setBranchPause(') && pc.includes("$('pausemodal')"));
  const shell = readFileSync(new URL('./shell.js', import.meta.url), 'utf8');
  assert.ok(!shell.includes('pausas.js') && !shell.includes('navpausas') && !shell.includes('viewpausas'), 'no Pausar nav / view in the shell');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.ok(!/id="(navpausas|mnpausas|viewpausas)"/.test(html), '🔴 the menu entry, its chip and its view are gone (F5)');
  assert.ok(/id="pausescrim"/.test(html) && /id="pausemodal"/.test(html), 'the confirm stays');
  const bv = readFileSync(new URL('./branches-view.js', import.meta.url), 'utf8');
  assert.ok(!bv.includes("ctx.goto('pausas')"), 'the branch page no longer navigates away to pause');
});


test('parity: «Pausar sucursal» → the confirm (title, Motivo, Hasta) → «Pausar» sends today\'s body; the answer repaints the card paused', async () => {
  const P = await open([branch('r_a')], () => okJson({ ok: true, noop: false, control: PAUSED() }));
  btn(P.view, 'Pausar sucursal').click(); await settle(2);
  assert.ok(textOf(P.modal).includes('Pausar R_A') && textOf(P.modal).includes('Mientras esté pausada no recibe pedidos nuevos.'));
  for (const t of ['Cocina llena', 'Falta personal', 'Problema técnico', 'Otro', '30 min', '1 hora', 'Hasta que la reanude', 'Cancelar']) assert.ok(btn(P.modal, t), `the confirm offers «${t}»`);
  btn(P.modal, 'Falta personal').click(); btn(P.modal, '1 hora').click();
  btn(P.modal, 'Pausar').click(); await settle(10);
  assert.deepEqual(P.pauses(), [{ rid: 'r_a', op: 'pause', reason: 'Falta personal', dur_min: 60 }], '🔴 today\'s request body');
  assert.ok(btn(P.view, 'Reanudar pedidos'), 'the card repaints from the answer\'s control');
  assert.ok(!btn(P.view, 'Pausar sucursal'));
});

test('parity: «Reanudar pedidos» sends { op: resume }; «Cancelar» sends nothing', async () => {
  const P = await open([branch('r_a', { control: PAUSED() })], () => okJson({ ok: true, noop: false, control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null } }));
  btn(P.view, 'Reanudar pedidos').click(); await settle(10);
  assert.deepEqual(P.pauses(), [{ rid: 'r_a', op: 'resume' }]);
  assert.ok(btn(P.view, 'Pausar sucursal'), 'open again');
  btn(P.view, 'Pausar sucursal').click(); await settle(2);
  btn(P.modal, 'Cancelar').click(); await settle(2);
  assert.equal(P.pauses().length, 1, 'the confirm cancelled: no request');
});

test('parity: the three failure boxes — 409, unavailable, anything else — and the card stays as it was', async () => {
  for (const [res, line] of [[errJson(409, { error: 'conflict' }), 'Otra persona cambió el estado.'], [errJson(503, { error: 'unavailable' }), OFFLINE[0]], [errJson(500, { error: 'x' }), 'No se pudo cambiar el estado']]) {
    const P = await open([branch('r_a')], () => res);
    btn(P.view, 'Pausar sucursal').click(); await settle(2);
    btn(P.modal, 'Pausar').click(); await settle(10);
    assert.deepEqual(P.pauses(), [{ rid: 'r_a', op: 'pause', reason: 'Cocina llena', dur_min: 30 }], 'the first reason and duration by default');
    assert.ok(textOf(P.view).includes(line), `🔴 ${res.status}: «${line}»`);
    assert.ok(btn(P.view, 'Pausar sucursal'), 'still open');
  }
});

test('who sees it, per branch page (F1/F4): no capability ⇒ no action and no status; CLOSED ⇒ status only, no note (D2); INACTIVE (1a) ⇒ status + «Para activarla, escribinos.»', async () => {
  const noCap = await open([branch('r_b', { caps: OWNER_CAPS.filter((c) => c !== 'location.pause') })], () => okJson({ ok: true }));
  assert.equal(btn(noCap.view, 'Pausar sucursal'), undefined); assert.equal(all(noCap.view).some((n) => (n._class || '').includes('hstatus')), false, 'no status block');
  const closed = await open([branch('r_c', { control: { state: 'closed', paused_until: null, pause_reason: null, pause_since: null } })], () => okJson({ ok: true }));
  assert.ok(all(closed.view).some((n) => (n._class || '').includes('hstatus')), 'the status block'); assert.equal(btn(closed.view, 'Pausar sucursal'), undefined);
  assert.ok(!textOf(closed.view).includes('Abre según su horario.'), '🔴 D2: no closed note');
  const inactive = await open([branch('r_d', { control: { state: 'inactive', paused_until: null, pause_reason: null, pause_since: null } })], () => okJson({ ok: true }));
  assert.ok(textOf(inactive.view).includes('Para activarla, escribinos.'), 'the inactive note (no Activar section on a 1a page)');
});

test('the open page: the action in the header\'s actions row and the status lines under the title (F1); «Equipos · N» keeps its place', async () => {
  const P = await open([branch('r_a', { caps: [...OWNER_CAPS, 'device.list'] })], () => okJson({ ok: true }));
  const top = all(P.view).find((n) => n.tag === 'div' && (n._class || '').split(' ').includes('top'));
  const acts = all(top).find((n) => (n._class || '') === 'topact');
  assert.deepEqual(acts.children.map((c) => textOf(c)), ['Pausar sucursal', 'Equipos · 0'], '🔴 the action replaces the old navigation button, Equipos stays');
  const st = all(top).find((n) => (n._class || '').includes('hstatus'));
  assert.ok((st._class || '').includes('stopen')); assert.ok(textOf(st).length > 0);
});

test('old entry points (§2.4, F5 :19): goto(\'pausas\') on ONE branch lands on its page; under «Todas» on the list; with a rid on that page', async () => {
  const one = await open([branch('r_a')], () => okJson({ ok: true }));
  one.mods.shell.goto('pausas'); await settle(5);
  assert.ok(btn(one.view, 'Pausar sucursal'), 'the branch page');
  const two = await open([branch('r_a'), branch('r_b')], () => okJson({ ok: true }));
  two.mods.shell.goto('pausas', { rid: 'r_b' }); await settle(5);
  assert.ok(textOf(two.view).includes('R_B') && btn(two.view, 'Pausar sucursal'), 'an explicit rid opens that branch');
});


test('§2.4 pauseLanding: one branch in scope → its page; «Todas» → the list; an explicit rid wins; nothing → the list', () => {
  const sel = (scope, rids = ['r_a', 'r_b']) => ({ scope, brand: { branches: rids.map((rid) => ({ rid })) } });
  assert.deepEqual(pauseLanding(sel('r_b')), { view: 'suc', rid: 'r_b' });
  assert.deepEqual(pauseLanding(sel('all')), { view: 'suc', rid: null }, '🔴 «Todas» → the list');
  assert.deepEqual(pauseLanding(sel('all', ['r_a'])), { view: 'suc', rid: 'r_a' }, 'a brand with ONE branch: its page');
  assert.deepEqual(pauseLanding(sel('all'), { rid: 'r_a' }), { view: 'suc', rid: 'r_a' }, 'an explicit rid in scope wins');
  assert.deepEqual(pauseLanding(sel('r_b'), { rid: 'r_zz' }), { view: 'suc', rid: 'r_b' }, 'a rid outside the selection is ignored');
  assert.deepEqual(pauseLanding(null), { view: 'suc', rid: null });
});
