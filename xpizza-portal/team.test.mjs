// PLAN-portal-team-invites T-b — «Equipo de trabajo» under a REAL DOM: jsdom over the shipped index.html with the REAL app.js,
// ventas.js, shell.js and team.js (auth.js and invite-mail.js stubbed — the two modules that import the Firebase CDN; fetch
// stubbed per function). Every state, the invite / mail-failure / reissue / edit / remove paths, draft retention across a nav
// switch, and the privacy rules (a stale response or a stale invite never renders or mails after the account changes).
// Run: node --test xpizza-portal/team.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { DIR, installFetch, okJson, errJson } from './ventas-harness.mjs';
import * as TL from './team-logic.js';

const { JSDOM } = createRequire(join(DIR, '..', 'xpizza-functions', 'package.json'))('jsdom');
const HTML = readFileSync(join(DIR, 'index.html'), 'utf8');
const OWNER_CAPS = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'catalog.fiscal_ack', 'stats.read', 'availability.set', 'location.prep',
  'location.pause', 'location.hours', 'team.invite', 'team.revoke'];
const branch = (rid, name, caps = OWNER_CAPS, state = 'member') => ({ rid, brand_id: 'marca_t', role: 'owner', state, caps, name,
  identity_version: 2, editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null });
const E1 = (over = {}) => ({ brands: [{ brand_id: 'marca_t', name: 'Pizzería Del Valle' }], branches: [branch('r_cen', 'Centro'), branch('r_tre', 'Col. Trejo')],
  membership_writes_enabled: true, ...over });
const INV = (n) => `inviteT${String(n).padStart(4, '0')}AAAAAAAAAAAAAAAA`;
// now: one injected clock — the pure test passes the SAME instant to the fixture and to rowsFrom (a DOM page renders later, so its interval only grows)
const LIST = (over = {}, now = Date.now()) => ({ ok: true, owner: { uid: 'uOwnerT1', name: 'Marcela Pineda', email: 'duena@m.hn' },
  managers: [{ uid: 'mgrT0001', name: 'Jorge Ayala', email: 'jorge@m.hn', rids: ['r_cen'], can_edit_menu: false }],
  pending: [{ inviteId: INV(1), name: 'Ana Reyes', email: 'ana@m.hn', rids: ['r_tre'], can_edit_menu: true, created_at: now - 2 * 3600e3, expires_at: now + 5 * 864e5 }],
  uses_platform_factura: false, ...over });
const MENU = () => okJson({ source: { restaurant_id: 'r_cen', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// the harness's loader handles app / ventas / shell; team.js also imports shell.js and invite-mail.js, so this suite loads the
// four modules itself with the same rewrite technique (same module instances: shell.js is imported once, by its temp URL)
async function loadAll() {
  const tag = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const auth = join(DIR, `__team-auth-stub.${tag}.mjs`);
  const mail = join(DIR, `__team-mail-stub.${tag}.mjs`);
  writeFileSync(auth, 'export const token = async () => "TK-team";\nexport const login = async () => {};\nexport const logout = async () => {};\nexport const authErrorMessage = () => "";\n');
  writeFileSync(mail, 'export const sendInviteLink = async (email, id) => { const h = globalThis.__mail; h.calls.push([email, id]); if (h.hold) await h.hold; if (h.fail) throw new Error("mail"); };\n');
  const tmp = (n) => join(DIR, `__team-under-test.${n}.${tag}.mjs`);
  const url = (n) => `./__team-under-test.${n}.${tag}.mjs`;
  const files = [auth, mail];
  const mods = {};
  try {
    for (const name of ['app', 'ventas', 'shell', 'team']) {
      const src = readFileSync(join(DIR, `${name}.js`), 'utf8')
        .replace(/from '\.\/auth\.js'/g, `from './__team-auth-stub.${tag}.mjs'`)
        .replace(/from '\.\/invite-mail\.js'/g, `from './__team-mail-stub.${tag}.mjs'`)
        .replace(/from '\.\/app\.js'/g, `from '${url('app')}'`)
        .replace(/from '\.\/shell\.js'/g, `from '${url('shell')}'`);
      writeFileSync(tmp(name), src); files.push(tmp(name));
      mods[name] = await import(pathToFileURL(tmp(name)).href);
    }
    return mods;
  } finally { for (const f of files) { try { unlinkSync(f); } catch (_) { /* best effort */ } } }
}

async function page({ e1 = E1(), list = LIST(), on = {} } = {}) {
  const dom = new JSDOM(HTML, { url: 'https://portal.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'MutationObserver', 'sessionStorage', 'localStorage']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  globalThis.__branchesDirect = true;
  globalThis.__mail = { calls: [], fail: false, hold: null };
  const st = { list, e1 };
  const calls = installFetch((fn) => {
    const last = calls[calls.length - 1];
    if (on[fn]) return on[fn](last && last.body, st);
    if (fn === 'getMyBranches') return okJson(st.e1);
    if (fn === 'getEditableCatalog') return MENU();
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    if (fn === 'memberList') return okJson(st.list);
    return errJson(404, { error: 'not_found' });
  });
  const mods = await loadAll();
  const d = w.document;
  const reg = () => mods.shell._registered.find((r) => r.id === 'equipo');
  const host = () => reg().main;
  const text = () => host().textContent.replace(/\s+/g, ' ');
  const btn = (label, root = host()) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  const modal = () => host().querySelector('[role="dialog"]');
  const n = (fn) => calls.filter((c) => c.fn === fn);
  const signIn = async (uid = 'uOwnerT1') => {
    d.dispatchEvent(new w.CustomEvent('portal:auth', { detail: { uid } }));
    d.dispatchEvent(new w.CustomEvent('portal:signed-in'));
    await settle(40);
  };
  const open = async () => { reg().nav.click(); await settle(); };
  const type = (id, v) => { const i = d.getElementById(id); i.value = v; i.dispatchEvent(new w.Event('input')); };
  return { dom, w, d, mods, st, calls, reg, host, text, btn, modal, n, signIn, open, type };
}

// ── pure logic ───────────────────────────────────────────────────────────────────────────────────────────────────────────
test('team-logic: rows, labels, relative time, validation, modal copy — verbatim prototype v3.1', () => {
  const brs = [{ rid: 'r_cen', name: 'Centro' }, { rid: 'r_tre', name: 'Col. Trejo' }];
  const now = 1_790_000_000_000;   // fixed: no wall-clock read between the fixture and the assertion
  const rows = TL.rowsFrom(LIST({}, now), brs, now);
  assert.deepEqual(rows.map((r) => [r.kind, r.name, r.role, r.branches, r.editLabel, r.state]), [
    ['owner', 'Marcela Pineda', 'Dueño', 'Todas', 'Edita y publica', 'Activo'],
    ['manager', 'Jorge Ayala', 'Gerente de sucursal', 'Centro', 'Solo agotados', 'Activo'],
    ['pending', 'Ana Reyes', 'Gerente de sucursal', 'Col. Trejo', 'Edita y publica', 'Invitación pendiente']]);
  assert.equal(rows[2].sub, 'Invitación enviada a ana@m.hn · hace 2 h · sin usar');
  assert.equal(TL.rowsFrom(LIST({ uses_platform_factura: true }, now), brs, now)[2].editLabel, 'Edita · el dueño publica', 'factura comes from the server flag');
  assert.equal(TL.teamCount(rows), '3 persona(s)');
  for (const [ms, t] of [[0, 'ahora'], [59e3, 'ahora'], [12 * 60e3, 'hace 12 min'], [3 * 3600e3, 'hace 3 h'], [864e5, 'hace 1 día'], [4 * 864e5, 'hace 4 días']]) assert.equal(TL.relTime(now - ms, now), t);
  for (const e of ['a@b.co', 'nombre.apellido@correo.com.hn']) assert.ok(TL.emailOk(e), e);
  for (const e of ['', 'a@b', 'a b@c.com', 'a@@b.com', 'a@b.c']) assert.ok(!TL.emailOk(e), e);
  const v = TL.inviteView(TL.newDraft(), brs, false);
  assert.deepEqual([v.title, v.cta, v.foot, v.disabled], ['Invitar gerente', 'Enviar invitación', 'Elegí al menos una sucursal', true]);
  assert.equal(TL.inviteView({ ...TL.newDraft(), name: 'Ana', email: 'ana@m', rids: ['r_cen'] }, brs, false).disabled, true, 'an invalid email: refused locally (logic)');
  const full = { ...TL.newDraft(), name: 'Ana', email: 'ana@m.hn', rids: ['r_cen'], canEdit: true };
  const v2 = TL.inviteView(full, brs, true);
  assert.deepEqual([v2.disabled, v2.foot, v2.brText, v2.permText], [false, '1 sucursal(es)', 'Centro', ' y permiso para editar el menú']);
  assert.ok(v2.canEditNote.includes('factura por la plataforma') && !TL.inviteView(full, brs, false).canEditNote.includes('factura'));
  const ed = TL.inviteView(TL.editDraft(rows[1]), brs, false);
  assert.deepEqual([ed.title, ed.cta, ed.sub], ['Editar a Jorge Ayala', 'Guardar', 'Cambiá sus sucursales o su permiso de menú.']);
  assert.deepEqual(TL.removeView(rows[1], brs), { title: '¿Quitar el acceso a Jorge Ayala?', email: 'jorge@m.hn', cta: 'Quitar acceso', done: 'Acceso quitado',
    body: 'Deja de entrar al portal y al handheld de Centro en el momento. Los equipos que vinculó siguen funcionando.' });
  assert.equal(TL.removeView(rows[2], brs).title, '¿Cancelar la invitación de Ana Reyes?');
  assert.ok(TL.isStale('not_a_manager') && TL.isStale('not_reissuable:consumed') && !TL.isStale('unavailable') && !TL.isStale(undefined));
});

// ── visibility (Q1) ──────────────────────────────────────────────────────────────────────────────────────────────────
test('the Equipo nav is HIDDEN while membership_writes_enabled is off or without team.revoke; a direct goto falls back to Productos', async () => {
  const off = await page({ e1: E1({ membership_writes_enabled: false }) });
  await off.signIn();
  assert.ok(off.reg().nav.classList.contains('hidden') && off.reg().mn.classList.contains('hidden'), 'flag off → absent');
  off.mods.shell.goto('equipo'); await settle();
  assert.ok(off.host().classList.contains('hidden') && off.n('memberList').length === 0, 'a direct goto falls back; nothing is fetched');
  const mgr = await page({ e1: E1({ branches: [branch('r_cen', 'Centro', ['catalog.read_editor', 'availability.set'])] }) });
  await mgr.signIn('uMgrT0001');
  assert.ok(mgr.reg().nav.classList.contains('hidden'), 'a manager (no team.revoke) never sees it');
  const ok = await page();
  await ok.signIn();
  assert.ok(!ok.reg().nav.classList.contains('hidden'), 'owner + flag on → shown');
  assert.equal(ok.reg().nav.textContent.trim(), 'Equipo de trabajo');
});

// ── states ───────────────────────────────────────────────────────────────────────────────────────────────────────────
test('normal: the table — owner «Sos vos», a manager (Editar / Quitar acceso), a pending invite (Reenviar / Cancelar invitación); text only', async () => {
  const p = await page({ list: LIST({ managers: [{ uid: 'mgrT0001', name: '<img src=x onerror=alert(1)>', email: 'jorge@m.hn', rids: ['r_cen'], can_edit_menu: false }] }) });
  await p.signIn(); await p.open();
  const t = p.text();
  for (const s of ['Equipo de trabajo', TL.TEAM_LEDE, 'Personas', '3 persona(s)', 'Marcela Pineda', 'Sos vos', 'Gerente de sucursal', 'Centro', 'Solo agotados',
    'Invitación enviada a ana@m.hn · hace 2 h · sin usar', 'Invitación pendiente', TL.TEAM_QUIET]) assert.ok(t.includes(s), s);
  for (const b of ['Invitar gerente', 'Editar', 'Quitar acceso', 'Reenviar', 'Cancelar invitación']) assert.ok(p.btn(b), b);
  assert.equal(p.host().querySelectorAll('img').length, 0, 'a name is text, never markup');
  assert.equal(p.n('memberList')[0].body.brandId, 'marca_t');
  assert.equal(p.n('memberList')[0].auth, 'Bearer TK-team', 'the bearer in a header');
});

test('vacío / cargando / error: «Solo estás vos»; a skeleton while loading; the offline errbox + Reintentar recovers', async () => {
  const e = await page({ list: LIST({ managers: [], pending: [] }) });
  await e.signIn(); await e.open();
  assert.ok(e.text().includes('Solo estás vos') && e.text().includes(TL.EMPTY[1]) && e.btn('Invitar gerente', e.host().querySelector('.empty')));
  let release;
  const slow = await page({ on: { memberList: () => new Promise((r) => { release = r; }) } });
  await slow.signIn(); slow.reg().nav.click(); await settle();
  assert.ok(slow.host().querySelector('.skel'), 'loading → skeleton');
  release(okJson(LIST())); await settle();
  assert.ok(!slow.host().querySelector('.skel') && slow.text().includes('Jorge Ayala'));
  let fail = true;
  const er = await page({ on: { memberList: (_b, st) => (fail ? errJson(503, { error: 'unavailable' }) : okJson(st.list)) } });
  await er.signIn(); await er.open();
  assert.ok(er.text().includes('Sin conexión con Sherpa') && !er.text().includes('Jorge Ayala'));
  fail = false; er.btn('Reintentar').click(); await settle();
  assert.ok(er.text().includes('Jorge Ayala'), 'Reintentar recovers');
});

// ── invite ───────────────────────────────────────────────────────────────────────────────────────────────────────────
test('invite: memberInvite → the Firebase link to aceptar → «Invitación enviada»; the CTA waits for a name, a valid email and a branch', async () => {
  const p = await page({ list: LIST({ uses_platform_factura: true }), on: { memberInvite: (b) => okJson({ ok: true, inviteId: INV(7), email: b.email, name: b.name, expires_at: 1 }) } });
  await p.signIn(); await p.open();
  p.btn('Invitar gerente').click(); await settle();
  const m = p.modal();
  assert.equal(m.querySelector('.mt').textContent, 'Invitar gerente');
  const cta = p.btn('Enviar invitación', m);
  assert.ok(cta.disabled);
  p.type('in-name', 'Dania Reyes'); p.type('in-mail', 'dania@correo.hn');
  assert.ok(cta.disabled, 'no branch yet');
  p.btn('Col. Trejo', m).click();
  assert.equal(m.querySelector('.left').textContent, '1 sucursal(es)');
  p.type('in-mail', 'dania@correo');
  assert.ok(cta.disabled && !m.querySelector('.ferr').classList.contains('hidden'), 'an invalid email: refused locally, «Escribí un correo válido.»');
  p.type('in-mail', 'dania@correo.hn');
  m.querySelector('.togrow .tog').click();
  assert.ok(m.textContent.includes('factura por la plataforma'), 'the permiso note follows the SERVER factura flag');
  assert.ok(!cta.disabled);
  cta.click(); await settle();
  assert.deepEqual(p.n('memberInvite').map((c) => c.body), [{ brandId: 'marca_t', name: 'Dania Reyes', email: 'dania@correo.hn', rids: ['r_tre'], can_edit_menu: true }]);
  assert.deepEqual(globalThis.__mail.calls, [['dania@correo.hn', INV(7)]], 'the link is sent for THAT invite');
  const sent = p.modal();
  assert.equal(sent.querySelector('.mt').textContent, 'Invitación enviada');
  assert.ok(sent.textContent.includes('Le enviamos un correo a dania@correo.hn') && sent.textContent.includes('entra con Col. Trejo y permiso para editar el menú'));
  assert.ok(p.n('memberList').length >= 2, 'the list re-fetches after the write (no optimistic row)');
  p.btn('Listo', sent).click();
  assert.equal(p.modal(), null);
});

test('invite: the mail send fails → the invite stays pending, the prototype errbox («No pudimos enviar la invitación») + «Entendido»', async () => {
  const p = await page({ on: { memberInvite: (b) => okJson({ ok: true, inviteId: INV(8), email: b.email, name: b.name }) } });
  await p.signIn(); await p.open();
  globalThis.__mail.fail = true;
  p.btn('Invitar gerente').click(); await settle();
  p.type('in-name', 'Luis'); p.type('in-mail', 'luis@m.hn'); p.btn('Centro', p.modal()).click();
  p.btn('Enviar invitación', p.modal()).click(); await settle();
  assert.equal(p.modal(), null, 'the modal closes');
  assert.ok(p.text().includes(TL.INVITE_ERROR[0]) && p.text().includes(TL.INVITE_ERROR[1]));
  p.btn('Entendido').click(); await settle();
  assert.ok(!p.text().includes(TL.INVITE_ERROR[0]));
});

test('invite: a server failure keeps the modal and the draft (the offline panel inside it), never a toast', async () => {
  const p = await page({ on: { memberInvite: () => errJson(503, { error: 'unavailable' }) } });
  await p.signIn(); await p.open();
  p.btn('Invitar gerente').click(); await settle();
  p.type('in-name', 'Luis'); p.type('in-mail', 'luis@m.hn'); p.btn('Centro', p.modal()).click();
  p.btn('Enviar invitación', p.modal()).click(); await settle();
  assert.ok(p.modal() && p.modal().textContent.includes('Sin conexión con Sherpa'));
  assert.equal(p.d.getElementById('in-name').value, 'Luis');
  assert.equal(globalThis.__mail.calls.length, 0, 'no invite → no mail');
});

// ── row actions ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('Reenviar: memberReissueInvite → a NEW id is mailed → «Nuevo enlace enviado a … · el anterior ya no sirve»', async () => {
  const p = await page({ on: { memberReissueInvite: () => okJson({ ok: true, inviteId: INV(9), email: 'ana@m.hn', name: 'Ana Reyes' }) } });
  await p.signIn(); await p.open();
  p.btn('Reenviar').click(); await settle();
  assert.deepEqual(p.n('memberReissueInvite').map((c) => c.body), [{ inviteId: INV(1) }]);
  assert.deepEqual(globalThis.__mail.calls, [['ana@m.hn', INV(9)]], 'the NEW id, never the superseded one');
  assert.equal(p.d.getElementById('opstoast').textContent, 'Nuevo enlace enviado a ana@m.hn · el anterior ya no sirve');
});

test('Editar: ONE memberUpdate call (branches + permiso) → «Cambios guardados»; never a revoke / set-permission pair', async () => {
  const p = await page({ on: { memberUpdate: () => okJson({ ok: true }) } });
  await p.signIn(); await p.open();
  p.btn('Editar').click(); await settle();
  const m = p.modal();
  assert.equal(m.querySelector('.mt').textContent, 'Editar a Jorge Ayala');
  assert.equal(p.d.getElementById('in-name'), null, 'name / email are not editable');
  p.btn('Col. Trejo', m).click();
  m.querySelector('.togrow .tog').click();
  p.btn('Guardar', m).click(); await settle();
  assert.deepEqual(p.n('memberUpdate').map((c) => c.body), [{ brandId: 'marca_t', uid: 'mgrT0001', rids: ['r_cen', 'r_tre'], can_edit_menu: true }], 'ONE memberUpdate with the full branch set + permiso');
  assert.equal(p.n('memberRevoke').length + p.n('memberSetMenuPermission').length, 0);
  assert.equal(p.d.getElementById('opstoast').textContent, 'Cambios guardados');
  assert.equal(p.modal(), null);
});

test('Quitar acceso → memberRevoke (every branch); Cancelar invitación → memberCancelInvite; a stale target reloads quietly', async () => {
  const p = await page({ on: { memberRevoke: () => okJson({ ok: true }), memberCancelInvite: () => okJson({ ok: true }) } });
  await p.signIn(); await p.open();
  p.btn('Quitar acceso').click(); await settle();
  assert.equal(p.modal().querySelector('.mt').textContent, '¿Quitar el acceso a Jorge Ayala?');
  p.btn('Quitar acceso', p.modal()).click(); await settle();
  assert.deepEqual(p.n('memberRevoke').map((c) => c.body), [{ brandId: 'marca_t', uid: 'mgrT0001' }]);
  assert.equal(p.d.getElementById('opstoast').textContent, 'Acceso quitado');
  p.btn('Cancelar invitación').click(); await settle();
  p.btn('Cancelar invitación', p.modal()).click(); await settle();
  assert.deepEqual(p.n('memberCancelInvite').map((c) => c.body), [{ inviteId: INV(1) }]);
  assert.equal(p.d.getElementById('opstoast').textContent, 'Invitación cancelada');
  const s = await page({ on: { memberRevoke: () => errJson(409, { error: 'not_a_manager' }) } });
  await s.signIn(); await s.open();
  const before = s.n('memberList').length;
  s.btn('Quitar acceso').click(); await settle();
  s.btn('Quitar acceso', s.modal()).click(); await settle();
  assert.equal(s.modal(), null, 'stale → the modal closes');
  assert.ok(s.n('memberList').length > before && !s.text().includes('Sin conexión'), 'the list reloads; no error panel');
});

// ── draft retention ──────────────────────────────────────────────────────────────────────────────────────────────────
test('draft retention: type in the invite form → Ventas → back to Equipo → the draft (name, email, branches, permiso) is restored', async () => {
  const p = await page();
  await p.signIn(); await p.open();
  p.btn('Invitar gerente').click(); await settle();
  p.type('in-name', 'Dania Reyes'); p.type('in-mail', 'dania@correo.hn'); p.btn('Col. Trejo', p.modal()).click();
  p.modal().querySelector('.togrow .tog').click();
  p.d.getElementById('navventas').click(); await settle();
  assert.equal(p.modal(), null, 'left: the modal is gone from the DOM');
  p.reg().nav.click(); await settle();
  const m = p.modal();
  assert.ok(m, 'back: the modal is open again');
  assert.deepEqual([p.d.getElementById('in-name').value, p.d.getElementById('in-mail').value], ['Dania Reyes', 'dania@correo.hn']);
  assert.ok(p.btn('Col. Trejo', m).classList.contains('sel') && m.querySelector('.togrow .tog').getAttribute('aria-pressed') === 'true');
  // a remove confirmation is never retained
  p.btn('Cancelar', m).click();
  p.btn('Quitar acceso').click(); await settle();
  p.d.getElementById('navventas').click(); await settle(); p.reg().nav.click(); await settle();
  assert.equal(p.modal(), null);
});

test('draft retention ends at a sign-out / account change, and a submit in flight at unmount drops the draft', async () => {
  const p = await page();
  await p.signIn(); await p.open();
  p.btn('Invitar gerente').click(); await settle();
  p.type('in-name', 'Dania Reyes');
  p.d.getElementById('navventas').click(); await settle();
  p.d.dispatchEvent(new p.w.CustomEvent('portal:auth', { detail: { uid: 'uOtherT02' } })); await settle();
  assert.equal(p.mods.team._teamState.kept, null, 'an account change clears the retained draft');
  let release;
  const q = await page({ on: { memberInvite: () => new Promise((r) => { release = r; }) } });
  await q.signIn(); await q.open();
  q.btn('Invitar gerente').click(); await settle();
  q.type('in-name', 'Luis'); q.type('in-mail', 'luis@m.hn'); q.btn('Centro', q.modal()).click();
  q.btn('Enviar invitación', q.modal()).click(); await settle();
  q.d.getElementById('navventas').click(); await settle();
  release(okJson({ ok: true, inviteId: INV(5), email: 'luis@m.hn', name: 'Luis' })); await settle();
  assert.equal(globalThis.__mail.calls.length, 0, '🔴 the invite answered after the view was left: never mailed from a dead generation');
  q.reg().nav.click(); await settle();
  assert.equal(q.modal(), null, 'its draft was not retained (the write may have landed — the list shows it)');
});

// ── privacy / lifecycle (Codex P1-5) ─────────────────────────────────────────────────────────────────────────────────
test('privacy: a delayed memberList after a sign-out renders nothing; a sign-out removes names / emails at once; a stale invite never mails', async () => {
  let release;
  const p = await page({ on: { memberList: () => new Promise((r) => { release = r; }) } });
  await p.signIn(); p.reg().nav.click(); await settle();
  p.d.dispatchEvent(new p.w.CustomEvent('portal:auth', { detail: { uid: null } })); await settle();
  release(okJson(LIST())); await settle();
  assert.ok(!p.text().includes('Jorge Ayala') && !p.text().includes('jorge@m.hn'), 'the late list is dropped');
  assert.equal(p.mods.team._teamState.list, null, 'the late list is dropped from memory too (no names held for a later mount)');
  const q = await page();
  await q.signIn(); await q.open();
  assert.ok(q.text().includes('jorge@m.hn'));
  // an ACCOUNT CHANGE (another uid, before the shell's reload): the shell keeps the view mounted, so team.js's own wipe is what clears it
  q.d.dispatchEvent(new q.w.CustomEvent('portal:auth', { detail: { uid: 'uOtherT05' } }));
  assert.ok(!q.reg().main.classList.contains('hidden'), 'non-vacuity: the view is still mounted');
  assert.ok(!q.text().includes('jorge@m.hn') && !q.text().includes('Marcela Pineda'), 'removed immediately on the generation bump');
  let rel2;
  const r = await page({ on: { memberInvite: () => new Promise((res) => { rel2 = res; }) } });
  await r.signIn(); await r.open();
  r.btn('Invitar gerente').click(); await settle();
  r.type('in-name', 'Luis'); r.type('in-mail', 'luis@m.hn'); r.btn('Centro', r.modal()).click();
  r.btn('Enviar invitación', r.modal()).click(); await settle();
  r.d.dispatchEvent(new r.w.CustomEvent('portal:auth', { detail: { uid: 'uOtherT03' } }));
  rel2(okJson({ ok: true, inviteId: INV(6), email: 'luis@m.hn', name: 'Luis' })); await settle();
  assert.equal(globalThis.__mail.calls.length, 0, '🔴 an invite that answers after the account changed is never mailed');
  assert.equal(r.modal(), null);
  let rel3;
  const re = await page({ on: { memberReissueInvite: () => new Promise((res) => { rel3 = res; }) } });
  await re.signIn(); await re.open();
  re.btn('Reenviar').click(); await settle();
  re.d.dispatchEvent(new re.w.CustomEvent('portal:auth', { detail: { uid: 'uOtherT04' } }));
  rel3(okJson({ ok: true, inviteId: INV(4), email: 'ana@m.hn', name: 'Ana Reyes' })); await settle();
  assert.equal(globalThis.__mail.calls.length, 0, '🔴 a reissue that answers after the account changed is never mailed');
});

// ── Codex build r1 ───────────────────────────────────────────────────────────────────────────────────────────────────────
test('P1: a team toast naming an email leaves the shared toast — text AND DOM — on an account change, and on leaving the view', async () => {
  const p = await page({ on: { memberReissueInvite: () => okJson({ ok: true, inviteId: INV(9), email: 'ana@m.hn', name: 'Ana Reyes' }) } });
  await p.signIn(); await p.open();
  p.btn('Reenviar').click(); await settle();
  const t = p.d.getElementById('opstoast');
  assert.ok(t.textContent.includes('ana@m.hn'), 'premise: the reissue toast names the email');
  p.d.dispatchEvent(new p.w.CustomEvent('portal:auth', { detail: { uid: 'uOtherT06' } }));
  assert.ok(!t.textContent.includes('ana@m.hn'), 'gone from the visible toast');
  assert.ok(!p.d.documentElement.outerHTML.includes('ana@m.hn'), '🔴 and from the DOM');
  const q = await page({ on: { memberReissueInvite: () => okJson({ ok: true, inviteId: INV(9), email: 'ana@m.hn', name: 'Ana Reyes' }) } });
  await q.signIn(); await q.open();
  q.btn('Reenviar').click(); await settle();
  assert.ok(q.d.getElementById('opstoast').textContent.includes('ana@m.hn'), 'premise');
  q.d.getElementById('navventas').click(); await settle();
  assert.ok(!q.d.documentElement.outerHTML.includes('ana@m.hn'), 'unmount clears it too');
});

test('P2: «Invitar gerente» stays disabled until the team data is here; after load the modal has the branches and the factura copy', async () => {
  let release;
  const p = await page({ on: { memberList: () => new Promise((r) => { release = r; }) } });
  await p.signIn(); p.reg().nav.click(); await settle();
  const b = p.btn('Invitar gerente');
  assert.ok(b, 'premise: the action is drawn while loading');
  b.click(); await settle();
  assert.equal(p.modal(), null, 'a click while loading opens nothing');
  assert.ok(b.disabled, 'disabled while loading');
  release(okJson(LIST({ uses_platform_factura: true }))); await settle();
  assert.ok(!p.btn('Invitar gerente').disabled, 'enabled once loaded');
  p.btn('Invitar gerente').click(); await settle();
  const m = p.modal();
  assert.ok(p.btn('Centro', m) && p.btn('Col. Trejo', m), 'the member branches are offered');
  assert.ok(m.textContent.includes('factura por la plataforma'), 'the permiso note follows the loaded factura flag');
});

test('P2: submit → Cancelar → open + fill a new invite → the first response arrives → the new draft is unchanged; the lock frees only then', async () => {
  let release;
  const p = await page({ on: { memberInvite: () => new Promise((r) => { release = r; }) } });
  await p.signIn(); await p.open();
  p.btn('Invitar gerente').click(); await settle();
  p.type('in-name', 'Luis'); p.type('in-mail', 'luis@m.hn'); p.btn('Centro', p.modal()).click();
  p.btn('Enviar invitación', p.modal()).click(); await settle();
  p.btn('Cancelar', p.modal()).click();
  assert.equal(p.modal(), null);
  p.btn('Invitar gerente').click(); await settle();
  p.type('in-name', 'Dania Reyes'); p.type('in-mail', 'dania@correo.hn'); p.btn('Col. Trejo', p.modal()).click();
  assert.ok(p.btn('Enviar invitación', p.modal()).disabled, '🔴 the first write still holds the lock after its modal closed');
  release(okJson({ ok: true, inviteId: INV(5), email: 'luis@m.hn', name: 'Luis' })); await settle();
  assert.deepEqual(globalThis.__mail.calls, [['luis@m.hn', INV(5)]], 'the first invite exists, so its link is still mailed');
  const m = p.modal();
  assert.ok(m && m.querySelector('.mt').textContent === 'Invitar gerente', '🔴 the new draft is still the open form, never replaced by «Invitación enviada»');
  assert.deepEqual([p.d.getElementById('in-name').value, p.d.getElementById('in-mail').value], ['Dania Reyes', 'dania@correo.hn']);
  assert.ok(p.btn('Col. Trejo', m).classList.contains('sel'));
  assert.ok(!p.btn('Enviar invitación', m).disabled, 'the lock freed when the first write settled');
});

test('P2: Editar shows an EXISTING retired-branch assignment as a removable chip; moving Centro (retired) → Trejo sends only Trejo', async () => {
  const p = await page({ e1: E1({ branches: [branch('r_cen', 'Centro', OWNER_CAPS, 'retired'), branch('r_tre', 'Col. Trejo')] }), on: { memberUpdate: () => okJson({ ok: true }) } });
  await p.signIn(); await p.open();
  p.btn('Editar').click(); await settle();
  const m = p.modal();
  const chip = [...m.querySelectorAll('button')].find((x) => x.textContent.startsWith('Centro'));
  assert.ok(chip && chip.textContent.includes(TL.RETIRED_SUB) && chip.classList.contains('sel'), 'the retired assignment is shown, selected');
  p.btn('Col. Trejo', m).click();
  chip.click();
  assert.ok(![...m.querySelectorAll('button')].some((x) => x.textContent.startsWith('Centro')), 'removed — and never offered back as a new grant');
  p.btn('Guardar', m).click(); await settle();
  assert.deepEqual(p.n('memberUpdate').map((c) => c.body.rids), [['r_tre']], '🔴 only Trejo');
  const q = await page({ e1: E1({ branches: [branch('r_cen', 'Centro', OWNER_CAPS, 'retired'), branch('r_tre', 'Col. Trejo')] }) });
  await q.signIn(); await q.open();
  q.btn('Invitar gerente').click(); await settle();
  assert.ok(!q.btn('Centro', q.modal()) && q.btn('Col. Trejo', q.modal()), 'a new invite offers member branches only');
});
