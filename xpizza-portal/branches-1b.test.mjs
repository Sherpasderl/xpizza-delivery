// PORTAL-UI 1b commit (a) (PLAN-portal-ui-slice1b-sucursales r4 §3.0, §3.3, §3.5, §2d–§2f) — the W-gated branch detail through
// the REAL shell.js / branches-view.js / api.js modules over the ventas harness (only auth.js is stubbed), with a fetch stub that
// logs every call. Capabilities come from the REAL membership capsFor (the server's writer), never a hand-made list.
// Synthetic brand marca_s only. Run: node --test xpizza-portal/branches-1b.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, installFetch, loadModules, okJson, errJson, settle, textOf, findAll } from './ventas-harness.mjs';

const require = createRequire(import.meta.url);
const { capsFor } = require('../xpizza-functions/access/membership.js');

const WEEK = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((k) => [k, { open: true, start: '11:00', end: '22:00' }]));
const OWNER = capsFor({ owner: true }, 'member');
const MANAGER = capsFor({ manager: true }, 'member');
const STAFF = capsFor({ staff: true }, 'member');
// an E1+ identity row (1a fields + the O1b additive ones), exactly the server's shape
function row(rid, extra = {}) {
  const prof = { location_name: rid.toUpperCase(), phone: '+50497952893', hours: WEEK, prep_default_min: 20, ...(extra.profile || {}) };
  const { profile, ...rest } = extra;
  return { rid, brand_id: 'marca_s', role: 'owner', state: 'member', caps: OWNER, name: prof.location_name,
    identity_version: 7, editable: { prep_default_min: prof.prep_default_min }, readonly: { active: true, radius_km: 4, hours: prof.hours, phone: prof.phone },
    control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null,
    lifecycle: 'active', profile: prof, location: { address_line: 'Calle 1, local 2', address_reference: 'Frente al parque', hub: { lat: 1, lng: 2 }, zone_radius_km: 4 },
    version: 7, ...rest };
}
const E1 = (branches, { w = true, brands } = {}) => ({ brands: brands || [{ brand_id: 'marca_s', name: 'Marca S', caps: ['brand.locations'], activation: 'on', drafts: [] }], branches, membership_writes_enabled: w });

function installStorage() {
  const m = new Map();
  globalThis.sessionStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
  return m;
}
// e1s: the getMyBranches answers in order (the last repeats); extra(fn, body) → a reply or undefined
function page(e1s, extra) {
  const byId = installDom();
  const reloads = { n: 0 };
  globalThis.window.location = { reload: () => { reloads.n += 1; } };
  globalThis.window.scrollTo = () => {};
  globalThis.__branchesDirect = true;
  let n = 0;
  const calls = installFetch((fn, q, body) => {
    const x = extra && extra(fn, body, calls);
    if (x) return x;
    if (fn === 'getMyBranches') { const r = e1s[Math.min(n, e1s.length - 1)]; n += 1; return typeof r === 'function' ? r() : okJson(r); }
    if (fn === 'getEditableCatalog') return okJson({ source: { restaurant_id: 'r_a', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    return errJson(404, { error: 'not_found' });
  });
  const count = (fn) => calls.filter((c) => c.fn === fn).length;
  return { byId, calls, reloads, count, view: () => byId.get('viewsuc') };
}
async function open(P, rid = 'r_a', uid = 'uOwner1b') {
  const mods = await loadModules();
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle(20);
  mods.shell.goto('suc', { rid });
  await settle(5);
  return mods;
}
const all = (root) => findAll(root, () => true);
const byAria = (root, a) => all(root).find((n) => n.attrs && n.attrs['aria-label'] === a);
const byIdIn = (root, id) => all(root).find((n) => n.id === id);
const byText = (root, tag, t) => all(root).find((n) => n.tag === tag && textOf(n).trim() === t);
const fire = (n, ev, value) => { if (value !== undefined) n.value = value; for (const fn of (n.listeners[ev] || [])) fn({ type: ev }); };
const NEVER = ['Ocupad', 'Próximo', 'lo prepara', 'se cruza', '[pendiente]', 'provisional', 'ruta', 'Teléfono de la sucursal', 'arranca en #1', 'Te avisamos', 'pickup', 'avisa al despacho'];

test('W on, owner: the v2 detail renders the editors + the approved truths (§2f), and no never-ship string', async () => {
  installStorage();
  const P = page([E1([row('r_a'), row('r_b', { profile: { location_name: 'Bulevar', hours: { ...WEEK, sun: { open: false } } } })])]);
  await open(P);
  const v = P.view(); const t = textOf(v);
  assert.ok(byIdIn(v, 'f1b-tel'), 'the WhatsApp input');
  assert.equal(byIdIn(v, 'f1b-tel').value, '+504 9795-2893');
  assert.ok(byIdIn(v, 'h1b-mon-start'), 'the hour inputs');
  for (const s of ['WhatsApp de la sucursal', 'Para cambiar el nombre, escribinos.', 'Calle 1, local 2', 'Frente al parque', 'Definida por Sherpa.', 'Para cambiar la ubicación, escribinos.',
    'definidas por Sherpa', 'Mismo día · sin pasar la medianoche', 'Copiar horario de', 'Lun–Dom 11:00–22:00', 'Bulevar', 'Pausar pedidos',
    'Es la base del «listo en N min» que confirma el equipo al aceptar. Obligatorio para vincular un equipo.', 'Entre 5 y 120 min. El equipo ajusta pedido por pedido.',
    'Último pedido de hoy', 'La numeración la lleva Sherpa.', 'Fuera de horario la sucursal no recibe pedidos para ahora.',
    'Desde este número el equipo llama o escribe al cliente mientras el pedido está activo. Lo pueden cambiar el dueño y el gerente.']) assert.ok(t.includes(s), `missing «${s}»`);
  for (const s of NEVER) assert.ok(!t.includes(s), `never-ship «${s}»`);
});

// codex 1b r1 #8: the W-off oracle is the BASE 1a implementation itself — shell.js + branches-view.js exactly as committed at
// 76f3a160 (git show), loaded over the same harness; every other module they import is unchanged since that base (asserted).
const BASE_SHA = '76f3a160';
const gitShow = (f) => execFileSync('git', ['show', `${BASE_SHA}:xpizza-portal/${f}`], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', maxBuffer: 1 << 26 });
async function openWith(P, transforms) {
  const mods = await loadModules(['app', 'ventas', 'shell'], transforms);
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'uOwner1b' } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle(20);
  return mods;
}
test('W OFF: the portal renders BYTE-IDENTICALLY to the base 1a implementation (76f3a160) — list, detail and chrome', async () => {
  for (const f of ['branch-logic.js', 'ops-dom.js', 'pausas.js', 'availability.js', 'equipos.js', 'app.js', 'ventas.js', 'auth-errors.js']) {
    assert.equal(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'), gitShow(f), `${f} unchanged since the base (the oracle composes it)`);
  }
  const dir = dirname(fileURLToPath(import.meta.url));
  const tag = `${process.pid}.${Date.now()}`;
  const baseView = join(dir, `__base-branches-view.${tag}.mjs`);
  writeFileSync(baseView, gitShow('branches-view.js'));
  const asBase = { shell: () => gitShow('shell.js').replace(/from '\.\/branches-view\.js'/, `from './__base-branches-view.${tag}.mjs'`) };
  const e1 = E1([row('r_a'), row('r_b', { lifecycle: 'inactive', control: { state: 'inactive', paused_until: null, pause_reason: null, pause_since: null } })], { w: false,
    brands: [{ brand_id: 'marca_s', name: 'Marca S', caps: ['brand.locations'], activation: 'on', drafts: [{ rid: 'r_d', brand_id: 'marca_s', lifecycle: 'draft', profile: { location_name: 'Borrador', phone: '+50433905521', hours: WEEK, prep_default_min: 20 }, location: null, pending_location: true, version: 'd.x.1.1' }] }] });
  const ids = ['viewsuc', 'navsuc', 'navsuccount', 'navpausas', 'navequipos', 'mnsuc', 'shopname', 'shopsub', 'scopewrap', 'switchmenu', 'sucbar', 'sucbartxt'];
  const snap = async (transforms, rid) => {
    installStorage();
    const P = page([e1]);
    const mods = await openWith(P, transforms);
    mods.shell.goto('suc', rid ? { rid } : {});
    await settle(5);
    return JSON.stringify(ids.map((id) => [id, P.byId.get(id)._class, all(P.byId.get(id)).map((n) => [n.tag, n._class, n.textContent, n.attrs, n.disabled, n.id])]));
  };
  try {
    for (const rid of [null, 'r_a', 'r_b']) {
      const base = await snap(asBase, rid);
      const now = await snap({}, rid);
      assert.equal(now, base, `W off, ${rid || 'list'}: identical to 1a`);
      assert.ok(rid ? base.includes('Solo lectura') : base.includes('Radio'), 'non-vacuity: the 1a screen rendered');
    }
  } finally { try { unlinkSync(baseView); } catch (_) { /* best effort */ } }
});

test('single writer: W on, a prep-only save is ONE updateBranchProfile and ZERO updateBranch; W off it is the reverse', async () => {
  for (const w of [true, false]) {
    installStorage();
    const P = page([E1([row('r_a')], { w })], (fn) => (fn === 'updateBranchProfile' ? okJson({ version: 8, lifecycle: 'identity', projection: 'published' }) : fn === 'updateBranch' ? okJson({ identity_version: 8, editable: { prep_default_min: 25 } }) : undefined));
    await open(P);
    byAria(P.view(), 'Más 5 minutos').click();
    P.byId.get('sucsave').click();
    await settle(15);
    if (w) {
      assert.equal(P.count('updateBranch'), 0, 'W on: never E2');
      assert.equal(P.count('updateBranchProfile'), 1);
      assert.deepEqual(P.calls.find((c) => c.fn === 'updateBranchProfile').body, { rid: 'r_a', expectedVersion: 7, patch: { prep_default_min: 25 } });
    } else {
      assert.equal(P.count('updateBranchProfile'), 0, 'W off: never E7');
      assert.equal(P.count('updateBranch'), 1);
    }
  }
});

test('a mixed save (phone + hours + prep) is ONE E7 with all three groups, the normalised phone and the exact hours shape', async () => {
  installStorage();
  const P = page([E1([row('r_a')])], (fn) => (fn === 'updateBranchProfile' ? okJson({ version: 8, lifecycle: 'identity' }) : undefined));
  await open(P);
  const v = P.view();
  fire(byIdIn(v, 'f1b-tel'), 'input', '3390 5521'); fire(byIdIn(v, 'f1b-tel'), 'change');
  byAria(P.view(), 'Abre el Mié').click();                       // Wednesday → closed
  fire(byIdIn(P.view(), 'h1b-fri-end'), 'change', '2330');       // Friday closes 23:30
  byAria(P.view(), 'Más 5 minutos').click();
  P.byId.get('sucsave').click();
  await settle(15);
  const reqs = P.calls.filter((c) => c.fn === 'updateBranchProfile');
  assert.equal(reqs.length, 1);
  assert.equal(P.count('updateBranch'), 0);
  const { patch, expectedVersion } = reqs[0].body;
  assert.equal(expectedVersion, 7);
  assert.deepEqual(Object.keys(patch).sort(), ['hours', 'phone', 'prep_default_min']);
  assert.equal(patch.phone, '+50433905521');
  assert.deepEqual(patch.hours.wed, { open: false });
  assert.deepEqual(patch.hours.fri, { open: true, start: '11:00', end: '23:30' });
  assert.deepEqual(Object.keys(patch.hours).sort(), ['fri', 'mon', 'sat', 'sun', 'thu', 'tue', 'wed']);
  assert.equal(patch.prep_default_min, 25);
});

test('§3.5: after a 200 the controls stay LOCKED until E1 is re-read; the next save uses E1\'s token, never the E7 reply\'s', async () => {
  installStorage();
  let release;
  const held = new Promise((r) => { release = r; });
  let e1n = 0;
  const P = page([E1([row('r_a')])], (fn) => {
    if (fn === 'getMyBranches') { e1n += 1; if (e1n === 2) return held; if (e1n >= 2) return okJson(E1([row('r_a', { version: 9, identity_version: 9, profile: { prep_default_min: 25 } })])); }
    if (fn === 'updateBranchProfile') return okJson({ version: 99, lifecycle: 'identity' });
    return undefined;
  });
  const mods = await open(P);
  byAria(P.view(), 'Más 5 minutos').click();
  P.byId.get('sucsave').click();
  await settle(15);
  assert.equal(P.count('getMyBranches'), 2, 'the refresh was requested');
  assert.equal(byAria(P.view(), 'Más 5 minutos').disabled, true, 'locked while the refresh is in flight');
  assert.equal(byIdIn(P.view(), 'f1b-tel').disabled, true);
  release(okJson(E1([row('r_a', { version: 9, identity_version: 9, profile: { prep_default_min: 25 } })])));
  await settle(15);
  assert.equal(byAria(P.view(), 'Más 5 minutos').disabled, false, 'unlocked once applied');
  assert.equal(mods.shell._shellState.e1.branches[0].editable.prep_default_min, 25, 'Equipos (infoOf) reads the refreshed prep');
  byAria(P.view(), 'Más 5 minutos').click();
  P.byId.get('sucsave').click();
  await settle(15);
  const second = P.calls.filter((c) => c.fn === 'updateBranchProfile')[1];
  assert.equal(second.body.expectedVersion, 9, 'E1\'s token (9), not the E7 reply\'s (99)');
});

test('§3.5: a FAILED refresh after a 200 → 1a\'s OFFLINE box; the controls stay locked', async () => {
  installStorage();
  let e1n = 0;
  const P = page([E1([row('r_a')])], (fn) => {
    if (fn === 'getMyBranches') { e1n += 1; if (e1n >= 2) return errJson(503, { error: 'unavailable' }); }
    if (fn === 'updateBranchProfile') return okJson({ version: 8, lifecycle: 'identity' });
    return undefined;
  });
  await open(P);
  byAria(P.view(), 'Más 5 minutos').click();
  P.byId.get('sucsave').click();
  await settle(20);
  assert.ok(textOf(P.view()).includes('Sin conexión con Sherpa'));
  assert.equal(byAria(P.view(), 'Más 5 minutos').disabled, true);
  assert.equal(byIdIn(P.view(), 'f1b-tel').disabled, true);
});

test('stale: E7 stale_branch → 1a\'s stale flow; the draft is dropped and the reply body is never read for values', async () => {
  installStorage();
  const P = page([E1([row('r_a')])], (fn) => (fn === 'updateBranchProfile' ? errJson(409, { error: 'stale_branch', profile: { prep_default_min: 90 }, version: 55 }) : undefined));
  await open(P);
  byAria(P.view(), 'Más 5 minutos').click();
  P.byId.get('sucsave').click();
  await settle(15);
  const t = textOf(P.view());
  assert.ok(t.includes('Alguien más cambió esta sucursal.') && t.includes('Recargá para ver lo último.'));
  assert.ok(!t.includes('90'), 'nothing from the stale body is shown');
  assert.equal(byAria(P.view(), 'Más 5 minutos').disabled, true);
});

test('G4: a prep-only failure keeps 1a\'s string; a WhatsApp / hours failure says «No se guardaron los cambios»', async () => {
  for (const [edit, title] of [['prep', 'No se guardó el tiempo de preparación'], ['phone', 'No se guardaron los cambios'], ['hours', 'No se guardaron los cambios']]) {
    installStorage();
    const P = page([E1([row('r_a')])], (fn) => (fn === 'updateBranchProfile' ? errJson(409, { error: 'brand_busy' }) : undefined));
    await open(P);
    if (edit === 'prep') byAria(P.view(), 'Más 5 minutos').click();
    if (edit === 'phone') { fire(byIdIn(P.view(), 'f1b-tel'), 'input', '8888 1234'); fire(byIdIn(P.view(), 'f1b-tel'), 'change'); }
    if (edit === 'hours') byAria(P.view(), 'Abre el Lun').click();
    P.byId.get('sucsave').click();
    await settle(15);
    const t = textOf(P.view());
    assert.ok(t.includes(title), `${edit}: ${title}`);
    assert.ok(t.includes('Revisá el valor y volvé a intentar; si sigue igual, escribinos por WhatsApp.'));
    assert.equal(P.byId.get('sucsave').disabled, false, `${edit}: Guardar stays enabled for a retry`);
  }
});

test('W turns off mid-save: writes_disabled → the G4 box + an E1 refresh; never retried through E2', async () => {
  installStorage();
  let e1n = 0;
  const P = page([E1([row('r_a')])], (fn) => {
    if (fn === 'getMyBranches') { e1n += 1; if (e1n >= 2) return okJson(E1([row('r_a')], { w: false })); }
    if (fn === 'updateBranchProfile') return errJson(503, { error: 'writes_disabled' });
    return undefined;
  });
  await open(P);
  fire(byIdIn(P.view(), 'f1b-tel'), 'input', '3390 5521'); fire(byIdIn(P.view(), 'f1b-tel'), 'change');
  P.byId.get('sucsave').click();
  await settle(20);
  assert.equal(P.count('updateBranch'), 0, 'no silent writer switch');
  assert.equal(P.count('getMyBranches'), 2);
  const t = textOf(P.view());
  assert.ok(t.includes('No se guardaron los cambios'));
  assert.ok(!byIdIn(P.view(), 'f1b-tel'), 'W off → the 1a read-only detail');
});

test('phone: an invalid number shows D-b inline + the D-c bar, Guardar off, and nothing is sent', async () => {
  installStorage();
  const P = page([E1([row('r_a')])]);
  await open(P);
  fire(byIdIn(P.view(), 'f1b-tel'), 'input', '2234-5678'); fire(byIdIn(P.view(), 'f1b-tel'), 'change');
  const t = textOf(P.view());
  assert.ok(t.includes('Escribí un número de celular de Honduras con WhatsApp, de 8 dígitos.'));
  assert.equal(byIdIn(P.view(), 'f1b-tel').attrs['aria-invalid'], 'true');
  assert.ok(textOf(P.byId.get('sucbartxt')).includes('· contacto · corregí el número marcado en rojo para guardar'));
  assert.equal(P.byId.get('sucsave').disabled, true);
  P.byId.get('sucsave').click();
  await settle(10);
  assert.equal(P.count('updateBranchProfile'), 0);
});

test('hours: closing before opening shows the drawn S5 row error + bar; Guardar off', async () => {
  installStorage();
  const P = page([E1([row('r_a')])]);
  await open(P);
  fire(byIdIn(P.view(), 'h1b-tue-end'), 'change', '10:00');
  assert.ok(textOf(P.view()).includes('La hora de cierre tiene que ser después de la de apertura, el mismo día.'));
  assert.ok(textOf(P.byId.get('sucbartxt')).includes('· horario · corregí las horas marcadas en rojo para guardar'));
  assert.equal(P.byId.get('sucsave').disabled, true);
});

test('a LOADED invalid value is shown with its error and never silently rewritten (§3.1)', async () => {
  installStorage();
  const P = page([E1([row('r_a', { profile: { phone: '+50422345678', hours: { ...WEEK, mon: { open: true, start: '22:00', end: '11:00' } } } })])]);
  await open(P);
  const t = textOf(P.view());
  assert.equal(byIdIn(P.view(), 'f1b-tel').value, '+504 2234-5678');
  assert.ok(t.includes('Escribí un número de celular de Honduras con WhatsApp, de 8 dígitos.'));
  assert.ok(t.includes('La hora de cierre tiene que ser después de la de apertura, el mismo día.'));
  assert.equal(P.byId.get('sucbar').classList.contains('show'), false, 'nothing dirty, nothing to save');
});

test('T6: a «Copiar horario de» chip fills the draft ONLY — zero requests; Guardar then sends it', async () => {
  installStorage();
  const sib = { ...WEEK, sun: { open: false } };
  const P = page([E1([row('r_a'), row('r_b', { profile: { location_name: 'Bulevar', hours: sib } })])], (fn) => (fn === 'updateBranchProfile' ? okJson({ version: 8, lifecycle: 'identity' }) : undefined));
  await open(P);
  const before = P.calls.length;
  byText(P.view(), 'button', 'Bulevar').click();
  await settle(5);
  assert.equal(P.calls.length, before, 'a chip makes no request');
  assert.ok(textOf(P.byId.get('sucbartxt')).includes('horario'));
  byText(P.view(), 'button', 'Lun–Dom 11:00–22:00').click();
  byText(P.view(), 'button', 'Bulevar').click();
  P.byId.get('sucsave').click();
  await settle(15);
  assert.deepEqual(P.calls.find((c) => c.fn === 'updateBranchProfile').body.patch, { hours: sib });
});

test('manager: all three editors (real caps), the name read-only with «El nombre lo cambia el dueño», no chips', async () => {
  installStorage();
  const P = page([E1([row('r_a', { role: 'manager', caps: MANAGER })], { brands: [{ brand_id: 'marca_s', name: 'Marca S', caps: [], activation: 'on' }] })]);
  await open(P, 'r_a', 'uMgr1b');
  const v = P.view(); const t = textOf(v);
  assert.ok(byIdIn(v, 'f1b-tel') && byIdIn(v, 'h1b-mon-start'));
  assert.equal(byAria(v, 'Más 5 minutos').disabled, false);
  assert.ok(t.includes('El nombre lo cambia el dueño'));
  assert.ok(!t.includes('Para cambiar el nombre, escribinos.') && !t.includes('Copiar horario de'));
});

test('staff (no operational capability): the branch is never operational — no Sucursales, and E7 is never built', async () => {
  installStorage();
  const P = page([E1([{ rid: 'r_a', brand_id: 'marca_s', role: 'staff', state: 'member', caps: STAFF, name: 'R_A' }], { brands: [{ brand_id: 'marca_s', name: 'Marca S', caps: [], activation: 'on' }] })]);
  await loadModules();
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'uStaff1b' } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle(20);
  assert.ok(P.byId.get('navsuc').classList.contains('hidden'));
  assert.equal(P.count('updateBranchProfile'), 0);
});

test('SYNTHETIC partial caps (UI-only fixture): only the granted editor renders; the patch carries only that group', async () => {
  installStorage();
  const P = page([E1([row('r_a', { caps: ['availability.set', 'location.hours'] })])], (fn) => (fn === 'updateBranchProfile' ? okJson({ version: 8, lifecycle: 'identity' }) : undefined));
  await open(P);
  const v = P.view();
  assert.ok(!byIdIn(v, 'f1b-tel'), 'no WhatsApp editor');
  assert.equal(byAria(v, 'Más 5 minutos').disabled, true, 'no prep editor');
  byAria(v, 'Abre el Lun').click();
  P.byId.get('sucsave').click();
  await settle(15);
  assert.deepEqual(Object.keys(P.calls.find((c) => c.fn === 'updateBranchProfile').body.patch), ['hours']);
});

test('lifecycle pill + lede: staged «Por activar» / inactive «Desactivada» with the T7 lede', async () => {
  for (const [life, pillText, lede] of [['staged', 'Por activar', 'Calle 1, local 2 · todavía no recibe pedidos'], ['inactive', 'Desactivada', 'Calle 1, local 2 · desactivada']]) {
    installStorage();
    const P = page([E1([row('r_a', { lifecycle: life, control: { state: 'inactive', paused_until: null, pause_reason: null, pause_since: null } })])]);
    await open(P);
    const t = textOf(P.view());
    assert.ok(t.includes(pillText) && t.includes(lede), life);
  }
});

test('a valid WhatsApp shows as «+504 NNNN-NNNN» once the field is left (D-label); an invalid one is kept as typed', async () => {
  installStorage();
  const P = page([E1([row('r_a')])]);
  await open(P);
  fire(byIdIn(P.view(), 'f1b-tel'), 'input', '50433905521'); fire(byIdIn(P.view(), 'f1b-tel'), 'change');
  assert.equal(byIdIn(P.view(), 'f1b-tel').value, '+504 3390-5521');
  fire(byIdIn(P.view(), 'f1b-tel'), 'input', '2234 567'); fire(byIdIn(P.view(), 'f1b-tel'), 'change');
  assert.equal(byIdIn(P.view(), 'f1b-tel').value, '2234 567');
});

test('r1 #4 (§3.1): a LOADED landline + reversed hours keep Guardar off even when only prep changed — zero E7', async () => {
  installStorage();
  const P = page([E1([row('r_a', { profile: { phone: '+50422345678', hours: { ...WEEK, mon: { open: true, start: '22:00', end: '11:00' } } } })])]);
  await open(P);
  byAria(P.view(), 'Más 5 minutos').click();
  assert.equal(P.byId.get('sucsave').disabled, true);
  const bar = textOf(P.byId.get('sucbartxt'));
  assert.ok(bar.includes('· horario · corregí las horas marcadas en rojo para guardar') && bar.includes('· contacto · corregí el número marcado en rojo para guardar'));
  P.byId.get('sucsave').click();
  await settle(10);
  assert.equal(P.count('updateBranchProfile'), 0);
  // fixing both makes the same save valid: ONE E7 with all three groups
  fire(byIdIn(P.view(), 'f1b-tel'), 'input', '3390 5521'); fire(byIdIn(P.view(), 'f1b-tel'), 'change');
  fire(byIdIn(P.view(), 'h1b-mon-end'), 'change', '23:00');
  assert.equal(P.byId.get('sucsave').disabled, false);
});
