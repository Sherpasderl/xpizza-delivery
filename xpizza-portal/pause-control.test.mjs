// «Pausar pedidos» moves inside «Sucursales» (PLAN-portal-pausar-in-sucursales-r0 §2.1 + §2.4, approved 2026-11-13). This step changes
// NO screen: the pause control (the card's action, the #pausemodal confirm, send → setBranchPause) is extracted VERBATIM into
// pause-control.js, and the «Pausar pedidos» view keeps using it — so every cell below is a PARITY cell on today's behaviour, through
// the REAL app.js / ventas.js / shell.js (shell.test.mjs's harness). §2.4: pauseLanding — where an old «pausas» entry lands once the
// nav entry goes (§2.3, after the owner-approved frames): the single branch's page, or the list for «Todas».
// Run: node --test pause-control.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  mods.shell.goto('pausas'); await settle(5);
  return { byId, calls, mods, view: byId.get('viewpausas'), modal: byId.get('pausemodal'), pauses: () => calls.filter((c) => c.fn === 'setBranchPause').map((c) => c.body) };
}
const PAUSED = (until = Date.now() + 1800e3) => ({ state: 'paused', paused_until: until, pause_reason: 'Falta personal', pause_since: Date.now() });

test('ONE control: pause-control.js holds the action, the confirm and the request; pausas.js only lays out the cards through it', () => {
  const pc = readFileSync(new URL('./pause-control.js', import.meta.url), 'utf8');
  const pv = readFileSync(new URL('./pausas.js', import.meta.url), 'utf8');
  assert.match(pc, /export function pauseControl\(/);
  assert.ok(pc.includes('setBranchPause(') && pc.includes("$('pausemodal')"), 'the request and the confirm live in the control');
  assert.ok(!pv.includes('setBranchPause') && !pv.includes('pausemodal') && !pv.includes('pausescrim'), '🔴 pausas.js no longer carries its own copy');
  assert.match(pv, /from '\.\/pause-control\.js'/);
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

test('parity: who sees a control — a branch without location.pause has no card; an inactive one says «Para activarla, escribinos.»', async () => {
  const noCap = branch('r_b', { caps: OWNER_CAPS.filter((c) => c !== 'location.pause') });
  const inactive = branch('r_c', { control: { state: 'inactive', paused_until: null, pause_reason: null, pause_since: null } });
  const P = await open([branch('r_a'), noCap, inactive], () => okJson({ ok: true }));
  const t = textOf(P.view);
  assert.ok(t.includes('R_A') && !t.includes('R_B'), 'no card without the capability');
  assert.ok(t.includes('Para activarla, escribinos.'), 'the inactive note');
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
