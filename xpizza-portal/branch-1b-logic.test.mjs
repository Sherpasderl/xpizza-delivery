// PORTAL-UI 1b — the pure branch-profile decisions. Run: node --test xpizza-portal/branch-1b-logic.test.mjs
// The validation tables are checked against the REAL O1b server validators (branch-ops.js hours7Errors, branch-phone.js
// HN_MOBILE), loaded read-only — the client mirrors the server, so the server is the oracle. Fixtures are synthetic
// (marca_s), brand-agnostic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as B from './branch-1b-logic.js';
import { E6_KEYS, E7_PATCH_KEYS, readResponse } from './api.js';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const OPS = require('../xpizza-functions/branches/branch-ops.js');
const PHONE = require('../xpizza-functions/portal/branch-phone.js');
const CORE = require('../xpizza-functions/portal/branch-lifecycle-core.js');

const WEEK = (start = '11:00', end = '22:00') => Object.fromEntries(B.HOUR_KEYS.map((k) => [k, { open: true, start, end }]));

test('the write gate is exactly E1.membership_writes_enabled === true', () => {
  assert.equal(B.writesOn({ membership_writes_enabled: true }), true);
  for (const v of [false, 'true', 1, null, undefined]) assert.equal(B.writesOn({ membership_writes_enabled: v }), false, String(v));
  assert.equal(B.writesOn(null), false);
});

test('phone: the client regex IS the server literal (branch-phone.js HN_MOBILE)', () => {
  assert.equal(B.HN_MOBILE.source, PHONE.HN_MOBILE.source);
  assert.equal(B.HN_MOBILE.flags, PHONE.HN_MOBILE.flags);
});

test('phone normalisation (§5): the four accepted spellings → +504NNNNNNNN; refused inputs fail the SERVER check too', () => {
  for (const raw of ['9795-2893', '+504 9795-2893', '50497952893', '+50497952893', '(504) 9795.2893', ' 9795 2893 ']) {
    const n = B.normalizePhone(raw);
    assert.equal(n, '+50497952893', raw);
    assert.equal(B.validPhone(n), true, raw);
    assert.equal(PHONE.isHnMobile(n), true, `server accepts ${raw}`);
  }
  for (const raw of ['2234-5678', '9795-289', '+1 555 123 4567', '', '+504 1234-5678', 'abc', '504979528931']) {
    const n = B.normalizePhone(raw);
    assert.equal(B.validPhone(n), false, raw);
    assert.equal(PHONE.isHnMobile(n), false, `server refuses ${raw} too`);
  }
  for (const first of ['3', '7', '8', '9']) assert.equal(B.validPhone(`+504${first}1234567`), true, first);
});

test('phone display: «+504 NNNN-NNNN» for a +504 number; anything else exactly as stored (never rewritten)', () => {
  assert.equal(B.phoneDisplay('+50497952893'), '+504 9795-2893');
  assert.equal(B.phoneDisplay('+50422345678'), '+504 2234-5678', 'a stored landline is shown, then flagged invalid by the view');
  assert.equal(B.phoneDisplay('+15551234567'), '+15551234567');
  assert.equal(B.phoneDisplay(null), '');
  assert.equal(B.PHONE_PLACEHOLDER, '+504 ____-____');
});

test('hours: validHours agrees with the SERVER hours7Errors on every case (§5)', () => {
  const cases = {
    week: WEEK(),
    fullDay: WEEK('00:00', '23:59'),
    equal: { ...WEEK(), mon: { open: true, start: '11:00', end: '11:00' } },
    overMidnight: { ...WEEK(), fri: { open: true, start: '23:00', end: '01:00' } },
    missingDay: (() => { const h = WEEK(); delete h.sun; return h; })(),
    closedOk: { ...WEEK(), wed: { open: false } },
    closedWithTimes: { ...WEEK(), wed: { open: false, start: '11:00', end: '22:00' } },
    extraKey: { ...WEEK(), mon: { open: true, start: '11:00', end: '22:00', note: 'x' } },
    unknownDay: { ...WEEK(), hol: { open: false } },
    badTime: { ...WEEK(), tue: { open: true, start: '9:00', end: '22:00' } },
    h24: { ...WEEK(), tue: { open: true, start: '11:00', end: '24:00' } },
    numberTime: { ...WEEK(), tue: { open: true, start: 1100, end: 2200 } },
    openNoBool: { ...WEEK(), tue: { open: 'yes', start: '11:00', end: '22:00' } },
    notObject: null,
    array: [],
  };
  for (const [name, h] of Object.entries(cases)) {
    assert.equal(B.validHours(h), OPS.hours7Errors(h).length === 0, name);
  }
  assert.equal(B.validHours(cases.week), true, 'non-vacuity: a valid week passes');
  assert.equal(B.validHours(cases.overMidnight), false, 'non-vacuity: same-day only');
});

test('hours: the day error kinds — only start ≥ end gets the drawn S5 message', () => {
  assert.equal(B.dayError({ open: true, start: '11:00', end: '22:00' }), null);
  assert.equal(B.dayError({ open: true, start: '22:00', end: '11:00' }), 'order');
  assert.equal(B.dayError({ open: true, start: '11:00', end: '11:00' }), 'order');
  assert.equal(B.dayError({ open: true, start: '', end: '22:00' }), 'shape');
  assert.equal(B.dayError({ open: false }), null);
  assert.equal(B.dayError(undefined), 'shape');
});

test('hours: the edit rows are Monday first; an undefined day is «Sin definir» (not an error row)', () => {
  const h = { ...WEEK(), wed: { open: false }, fri: { open: true, start: '23:00', end: '01:00' } };
  delete h.sun;
  const rows = B.hoursEditRows(h);
  assert.deepEqual(rows.map((r) => r.d), ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']);
  assert.deepEqual(rows.map((r) => [r.state, r.err]), [['open', null], ['open', null], ['closed', null], ['open', null], ['open', 'order'], ['open', null], ['undef', null]]);
});

test('hours: cleanHours builds EXACTLY the server shape (all present days, no extra keys)', () => {
  const dirty = { ...WEEK(), mon: { open: true, start: '11:00', end: '22:00', note: 'x' }, tue: { open: false, start: '1', end: '2' }, hol: { open: false } };
  const c = B.cleanHours(dirty);
  assert.deepEqual(Object.keys(c).sort(), [...B.HOUR_KEYS].sort());
  assert.deepEqual(c.mon, { open: true, start: '11:00', end: '22:00' });
  assert.deepEqual(c.tue, { open: false });
  assert.equal(OPS.hours7Errors(c).length, 0, 'the server accepts the cleaned shape');
});

test('hours: switching a day open takes its own loaded times, else the nearest earlier open day; closed drops the times', () => {
  const loaded = { ...WEEK(), wed: { open: false } };
  let d = B.editDay(loaded, loaded, 'wed', { open: true });
  assert.deepEqual(d.wed, { open: true, start: '11:00', end: '22:00' }, 'from Tuesday (the nearest earlier open day)');
  const own = { ...WEEK(), wed: { open: true, start: '12:00', end: '20:00' } };
  d = B.editDay(B.editDay(own, own, 'wed', { open: false }), own, 'wed', { open: true });
  assert.deepEqual(d.wed, { open: true, start: '12:00', end: '20:00' }, 'its own loaded times come back');
  d = B.editDay(loaded, loaded, 'mon', { open: false });
  assert.deepEqual(d.mon, { open: false });
  d = B.editDay(loaded, loaded, 'mon', { end: '23:30' });
  assert.deepEqual(d.mon, { open: true, start: '11:00', end: '23:30' });
  const none = Object.fromEntries(B.HOUR_KEYS.map((k) => [k, { open: false }]));
  assert.deepEqual(B.editDay(none, none, 'mon', { open: true }).mon, { open: true, start: '', end: '' }, 'nothing to copy → empty (red until filled)');
  assert.equal(loaded.wed.open, false, 'the input is never mutated');
});

test('hours: typed times normalise to HH:MM when they are one', () => {
  assert.equal(B.normalizeTime('1130'), '11:30');
  assert.equal(B.normalizeTime('9:00'), '09:00');
  assert.equal(B.normalizeTime('930'), '09:30');
  assert.equal(B.normalizeTime(' 22:00 '), '22:00');
  assert.equal(B.normalizeTime('25:00'), '25:00', 'kept as typed → the validation refuses it');
  assert.equal(B.normalizeTime('abc'), 'abc');
});

test('the patch carries ONLY the changed groups, ⊆ {phone, hours, prep_default_min} — never a name / location key', () => {
  const base = { location_name: 'Sucursal Uno', phone: '+50497952893', hours: WEEK(), prep_default_min: 20 };
  assert.deepEqual(B.profilePatch(base, { phone: '+50497952893', hours: WEEK(), prep_default_min: 20 }), {});
  assert.deepEqual(B.profilePatch(base, { prep_default_min: 25 }), { prep_default_min: 25 });
  const p = B.profilePatch(base, { rid: 'r_s', base: 3, phone: '+50433905521', phoneRaw: '3390-5521', hours: { ...WEEK(), wed: { open: false } }, location_name: 'Otro', hub: { lat: 1, lng: 2 } });
  assert.deepEqual(Object.keys(p).sort(), ['hours', 'phone']);
  for (const k of Object.keys(p)) assert.ok(B.PATCH_KEYS.includes(k), k);
  assert.deepEqual([...B.PATCH_KEYS].sort(), [...E7_PATCH_KEYS].sort(), 'the view and the request builder share one allowlist');
  assert.deepEqual(Object.keys(CORE.GROUP_CAP).filter((k) => k !== 'location_name').sort(), [...E7_PATCH_KEYS].sort(), 'and it is the server E7 group map minus the name');
  assert.deepEqual([...E6_KEYS], [...CORE.E6_KEYS], 'E6 keys are the server list, exactly');
});

test('patch errors: per group; a valid patch has none', () => {
  assert.deepEqual(B.patchErrors({ phone: '+50497952893', hours: WEEK(), prep_default_min: 25 }), {});
  assert.deepEqual(B.patchErrors({ phone: '+50422345678' }), { phone: true });
  assert.deepEqual(B.patchErrors({ hours: { ...WEEK(), mon: { open: true, start: '22:00', end: '11:00' } } }), { hours: true });
  assert.deepEqual(B.patchErrors({ prep_default_min: 500 }), { prep_default_min: true });
});

test('the bar labels, in the drawn order', () => {
  assert.deepEqual(B.dirtyLabels1b({ phone: 'x', prep_default_min: 5, hours: {} }), ['horario', 'preparación', 'contacto']);
  assert.deepEqual(B.dirtyLabels1b({}), []);
});

test('G4: the save-error copy is chosen by the fields the save carried', () => {
  assert.deepEqual([...B.saveErrorCopy({ prep_default_min: 25 })], ['No se guardó el tiempo de preparación', 'Revisá el valor y volvé a intentar; si sigue igual, escribinos por WhatsApp.']);
  for (const p of [{ phone: 'x' }, { hours: {} }, { phone: 'x', prep_default_min: 25 }, { hours: {}, prep_default_min: 25 }, {}, null]) {
    assert.deepEqual([...B.saveErrorCopy(p)], ['No se guardaron los cambios', 'Revisá el valor y volvé a intentar; si sigue igual, escribinos por WhatsApp.'], JSON.stringify(p));
  }
});

test('T7: the detail lede by lifecycle; no address → no lede (never a guess)', () => {
  const loc = { address_line: 'Calle 1, local 2', address_reference: null, hub: null, zone_radius_km: 5 };
  assert.equal(B.ledeOf({ lifecycle: 'active', location: loc }), 'Calle 1, local 2');
  assert.equal(B.ledeOf({ lifecycle: 'inactive', location: loc }), 'Calle 1, local 2 · desactivada');
  assert.equal(B.ledeOf({ lifecycle: 'staged', location: loc }), 'Calle 1, local 2 · todavía no recibe pedidos');
  assert.equal(B.ledeOf({ lifecycle: 'draft', location: null }), 'Sherpa está configurando la ubicación · todavía no recibe pedidos');
  assert.equal(B.ledeOf({ lifecycle: 'active', location: { address_line: null } }), null);
  assert.equal(B.ledeOf({ lifecycle: 'active' }), null);
});

test('T6: «Copiar horario de» = the same brand\'s OTHER identity rows with VALID hours, by name, + the literal preset', () => {
  const row = (rid, name, hours) => ({ rid, brand_id: 'marca_s', profile: { location_name: name, phone: null, hours, prep_default_min: 20 } });
  const rows = [row('r_c', 'Centro', WEEK('10:00', '21:00')), row('r_a', 'Alameda', WEEK()), row('r_self', 'Esta', WEEK()), row('r_bad', 'Rota', { mon: { open: true } }), { rid: 'r_x', brand_id: 'marca_s' }];
  const s = B.copySources(rows, 'r_self');
  assert.deepEqual(s.map((x) => x.label), ['Alameda', 'Centro']);
  assert.deepEqual(s[1].hours.mon, { open: true, start: '10:00', end: '21:00' });
  assert.equal(B.PRESET_LABEL, 'Lun–Dom 11:00–22:00');
  assert.equal(B.validHours(B.PRESET_HOURS), true);
  assert.equal(OPS.hours7Errors(B.cleanHours(B.PRESET_HOURS)).length, 0);
});

test('editors: per capability on an identity row (all-or-none for real roles; a partial row is a SYNTHETIC fixture)', () => {
  assert.deepEqual(B.editorsOf({ caps: ['location.contact', 'location.hours', 'location.prep'] }), { phone: true, hours: true, prep_default_min: true });
  assert.deepEqual(B.editorsOf({ caps: ['availability.set'] }), { phone: false, hours: false, prep_default_min: false });
  assert.deepEqual(B.editorsOf({ caps: ['location.hours'] }), { phone: false, hours: true, prep_default_min: false }, 'SYNTHETIC partial caps');
});

// ══ commit (b) ════════════════════════════════════════════════════════════════════════════════════════════════════════════
const LOC = { address_line: 'Calle 1, local 2', address_reference: null, hub: { lat: 1, lng: 2 }, zone_radius_km: 5 };
const life = (lifecycle, readiness, extra = {}) => ({ rid: 'r_x', brand_id: 'marca_s', role: 'owner', name: 'Sucursal X', lifecycle, location: LOC,
  profile: { location_name: 'Sucursal X', phone: '+50497952893', hours: WEEK(), prep_default_min: 20 }, editable: { prep_default_min: 20 },
  readonly: { radius_km: 5 }, devices: 0, last_order_today: null, control: { state: 'inactive' }, ...(readiness ? { readiness } : {}), ...extra });

test('§2c orphan test: every server readiness code / gap maps to EXACTLY one S8 row or to the one S8c notice — no orphans either way', () => {
  const rowFor = (unmet, gaps) => B.readinessRows(life('staged', { unmet, ...(gaps ? { identity_gaps: gaps } : {}) }));
  const owners = new Map();
  for (const code of OPS.READINESS_CODES) {
    if (code === 'identity_invalid') continue;
    const r = rowFor([code]);
    const target = r.kind === 'blocked' ? 'NOTICE' : r.rows.filter((x) => x.cls !== 'ok').map((x) => x.id).join(',');
    assert.ok(target && !target.includes(','), `${code} → exactly one target (${target})`);
    owners.set(code, target);
  }
  for (const gap of OPS.IDENTITY_GAPS) {
    const r = rowFor(['identity_invalid'], [gap]);
    const target = r.kind === 'blocked' ? 'NOTICE' : r.rows.filter((x) => x.cls !== 'ok').map((x) => x.id).join(',');
    assert.ok(target && !target.includes(','), `gap ${gap} → exactly one target (${target})`);
    owners.set(`gap:${gap}`, target);
  }
  assert.deepEqual(Object.fromEntries(owners), {
    not_a_branch: 'NOTICE', brand_not_on: 'NOTICE', no_handheld_online: 'device', no_owner_or_manager: 'team', menu_not_published: 'menu',
    'gap:location': 'location', 'gap:zone': 'zone', 'gap:hours': 'hours', 'gap:prep': 'prep', 'gap:integrity': 'NOTICE',
  });
  const rowsUsed = new Set([...owners.values()].filter((t) => t !== 'NOTICE'));
  assert.deepEqual([...rowsUsed].sort(), B.READY_ROWS.map((r) => r.id).sort(), 'every drawn row has a source (no orphan row)');
  assert.equal(rowFor(['some_future_code']).kind, 'blocked', 'an unknown code fails closed to the notice');
  assert.equal(rowFor(['identity_invalid'], ['some_future_gap']).kind, 'blocked');
  assert.equal(rowFor(['identity_invalid']).kind, 'blocked', 'identity_invalid without gaps → notice');
});

test('S8 rows: met / unmet / Sherpa-pending states and the computable subs (B5); no sub without data', () => {
  let r = B.readinessRows(life('staged', { unmet: [] }));
  assert.equal(r.unmet, 0);
  assert.deepEqual(r.rows.map((x) => [x.state, x.sub]), [['Lista', 'Calle 1, local 2'], ['Lista', '5 km a la redonda · la define Sherpa'], ['Listo', 'Los 7 días definidos'],
    ['Listo', '20 min'], ['Listo', ''], ['Listo', ''], ['Listo', '']]);
  const h = WEEK(); delete h.sat; delete h.sun;
  r = B.readinessRows(life('staged', { unmet: ['identity_invalid', 'no_handheld_online'], identity_gaps: ['location', 'zone', 'hours'] }, { profile: { location_name: 'X', hours: h, prep_default_min: 20 } }));
  assert.deepEqual(r.rows.slice(0, 3).map((x) => [x.state, x.name, x.sub]), [['Pendiente', 'Ubicación · pendiente — Sherpa la configura', ''],
    ['Pendiente', 'Zona de entrega · pendiente — Sherpa la configura', ''], ['Falta', 'Horario de los 7 días', 'Definí sábado y domingo, aunque sea «Cerrado»']]);
  assert.deepEqual([r.rows[4].state, r.rows[4].sub], ['Falta', 'Vinculá un handheld desde el equipo y encendelo una vez']);
  assert.equal(B.readyCountText(r), '4 de 7 pendientes');
  r = B.readinessRows(life('staged', { unmet: ['no_owner_or_manager', 'menu_not_published'] }));
  assert.deepEqual(r.rows.slice(5).map((x) => [x.state, x.sub]), [['Falta', ''], ['Falta', '']], 'undrawn unmet subs are omitted');
  assert.equal(B.readinessRows(life('staged', null)).kind, 'unknown', 'G3: an omitted readiness is unknown (fail closed)');
});

test('B4: «Le falta: …» = the unmet row names (first letter lower-cased), « · », a final «.» — each code → exactly one name', () => {
  const r = B.readinessRows(life('staged', { unmet: ['identity_invalid', 'no_handheld_online'], identity_gaps: ['hours'] }));
  assert.equal(B.missingText(r), 'horario de los 7 días · al menos un equipo vinculado.');
  const all = B.readinessRows(life('staged', { unmet: ['identity_invalid', 'no_handheld_online', 'no_owner_or_manager', 'menu_not_published'], identity_gaps: ['location', 'zone', 'hours', 'prep'] }));
  assert.equal(B.missingText(all), 'ubicación definida por Sherpa · zona de entrega · horario de los 7 días · tiempo de preparación normal · al menos un equipo vinculado · alguien con acceso a la sucursal · menú de la marca publicado.');
});

test('S2 card model (B2 / B3): pills, subs, meta (no «Próximo»; drafts unnumbered), hints', () => {
  const now = Date.parse('2026-10-26T18:00:00Z');
  let m = B.cardModel(life('inactive', { unmet: [] }), now);
  assert.deepEqual([m.pill.label, m.sub], ['Desactivada', 'Calle 1, local 2 · desactivada']);
  assert.deepEqual(m.meta, [['Zona', '5 km'], ['Preparación', '20 min'], ['Equipos', '0'], ['Último pedido de hoy', 'Sin pedidos hoy']]);
  assert.deepEqual(m.hint, { kind: 'ok', bold: 'Lista para activar.', text: 'Horario, preparación y equipo en orden. Al activarla vuelve a recibir pedidos.' });
  m = B.cardModel(life('staged', { unmet: ['no_handheld_online'] }), now);
  assert.deepEqual([m.pill.label, m.sub, m.hint.kind, m.hint.text], ['Por activar', 'Calle 1, local 2', 'warn', 'al menos un equipo vinculado.']);
  m = B.cardModel(life('staged', null), now);
  assert.equal(m.hint, null, 'G3: no readiness → no hint');
  m = B.cardModel({ rid: 'r_d', brand_id: 'marca_s', lifecycle: 'draft', profile: { location_name: 'Nueva', phone: '+50433905521', hours: WEEK(), prep_default_min: 25 }, location: null, version: 'd.op.1.1' }, now);
  assert.deepEqual([m.name, m.pill.label, m.sub, m.hint.text], ['Nueva', 'Borrador', 'Sherpa está configurando la ubicación', B.DRAFT_HINT]);
  assert.deepEqual(m.meta, [['Zona', '—'], ['Preparación', '25 min'], ['Equipos', '—']], 'a draft has no numbering');
  m = B.cardModel(life('active', null, { legacy: true, control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, last_order_today: 641 }), now);
  assert.deepEqual([m.pill.label, m.hint, m.meta[3][1]], ['Abierta', null, '#641']);
});

test('§3.4 selection: W off is exactly 1a; W on adds the OWNED brands without an operational row (lifecycle-only)', async () => {
  const L = await import('./branch-logic.js');
  const op = { rid: 'r_a', brand_id: 'marca_a', role: 'owner', state: 'member', caps: ['location.prep'], name: 'A1', control: { state: 'open' } };
  const brands = [{ brand_id: 'marca_a', name: 'Marca A', caps: ['brand.locations'], drafts: [] }, { brand_id: 'marca_s', name: 'Marca S', caps: ['brand.locations'], drafts: [{ rid: 'r_d', lifecycle: 'draft' }] },
    { brand_id: 'marca_m', name: 'Marca M', caps: [], drafts: [] }];
  const off = { brands, branches: [op], membership_writes_enabled: false };
  assert.deepEqual(B.brandsOf1b(off), L.brandsOf(off));
  assert.deepEqual(B.resolveSelection1b(off, { brand_id: 'marca_s', scope: null }), L.resolveSelection(off, { brand_id: 'marca_s', scope: null }));
  const on = { ...off, membership_writes_enabled: true };
  assert.deepEqual(B.brandsOf1b(on).map((b) => [b.brand_id, !!b.lifecycleOnly]), [['marca_a', false], ['marca_s', true]], 'a brand the caller only manages is never added');
  assert.equal(B.resolveSelection1b(on, { brand_id: 'marca_s', scope: null }).lifecycleOnly, true, 'a stored lifecycle-only brand is honoured');
  assert.equal(B.resolveSelection1b(on, null).brand_id, 'marca_a', 'otherwise 1a\'s choice');
  const onlyLife = { ...on, branches: [] };
  assert.deepEqual([B.resolveSelection1b(onlyLife, null).brand_id, B.resolveSelection1b(onlyLife, null).lifecycleOnly], ['marca_a', true], 'no operational brand → the first owned brand by name (lifecycle-only)');
  assert.equal(B.resolveSelection1b({ ...onlyLife, membership_writes_enabled: false }, null), null, 'W off → «no administra ningún local» (1a)');
  assert.equal(B.brandCount(0), '0 sucursales'); assert.equal(B.brandCount(1), '1 sucursal');
});

test('S9: the name rule mirrors the server isText(…, 60); the hours chips have no «Definir después» (B6); op_id fits OP_ID_RE', () => {
  assert.equal(B.validName(B.cleanName('  Col. Nueva ')), true);
  for (const bad of ['', '   ', 'x'.repeat(61)]) assert.equal(B.validName(B.cleanName(bad)), false, JSON.stringify(bad));
  assert.equal(B.validName('x'.repeat(60)), true);
  const ch = B.newHoursChoices([{ rid: 'r_a', profile: { location_name: 'Centro', hours: WEEK() } }]);
  assert.deepEqual(ch.map((c) => c.label), ['Copiar de Centro', 'Lun–Dom 11:00–22:00']);
  assert.deepEqual(B.newHoursChoices([]).map((c) => c.label), ['Lun–Dom 11:00–22:00']);
  for (const c of ch) assert.equal(OPS.hours7Errors(B.cleanHours(c.hours)).length, 0, `${c.label} is a valid E6 hours`);
  for (let i = 0; i < 20; i++) assert.match(B.newOpId(), /^[A-Za-z0-9_-]{1,64}$/);
  assert.notEqual(B.newOpId(), B.newOpId());
});

// codex 1b r2 #2 — which E6 refusals END an intent. The replies come from the REAL server: the core itself for the refusals it
// makes before the gate, and the core's own STATUS / statusOf table (evaluated from its source; not exported) for the rest. Each is
// turned into the client's error by the REAL api.js readResponse — the classifier never sees a hand-built error.
const asClientError = async ({ status, body }) => {
  try { await readResponse({ ok: status < 400, status, json: async () => body }); } catch (e) { return e; }
  assert.fail(`status ${status} did not throw`);
};
const coreSrc = readFileSync(new URL('../xpizza-functions/portal/branch-lifecycle-core.js', import.meta.url), 'utf8');
const statusOf = new Function(`${/const STATUS = \{[\s\S]*?\};/.exec(coreSrc)[0]}\n${/const statusOf = .*;/.exec(coreSrc)[0]}\nreturn statusOf;`)();
test('r2 #2: every definitive E6 code reaches the client as a typed 4xx and ends the intent; outages and unknown codes do not', async () => {
  const E6 = { op_id: 'op_1', brand_id: 'marca_s', location_name: 'Norte', phone: '+50433905521', hours: WEEK(), prep_default_min: 20 };
  const pre = { forbidden_field: { ...E6, extra: 1 }, bad_request: { op_id: 'op_1' }, bad_brand: { ...E6, brand_id: '' }, bad_phone: { ...E6, phone: '22345678' } };
  for (const [code, body] of Object.entries(pre)) {
    const r = await CORE.createBranchDraftCore({}, { method: 'POST', body });
    assert.equal(r.body.error, code, `non-vacuity: the real core refuses ${code}`);
    assert.equal(B.e6Definitive(await asClientError(r)), true, code);
  }
  for (const code of B.E6_DEFINITIVE) assert.equal(B.e6Definitive(await asClientError({ status: statusOf(code), body: { error: code } })), true, `${code} (${statusOf(code)})`);
  for (const code of ['unavailable', 'writes_disabled', 'interrupted', 'lease_lost', 'some_future_code']) {
    assert.equal(B.e6Definitive(await asClientError({ status: statusOf(code), body: { error: code } })), false, `${code} (${statusOf(code)}) stays unresolved`);
  }
  for (const status of [500, 502, 504, 422, 429]) assert.equal(B.e6Definitive(await asClientError({ status, body: { error: 'name_taken' } })), false, `${status} + a known code stays unresolved`);
  assert.equal(B.e6Definitive(new TypeError('Failed to fetch')), false, 'a network failure');
  assert.equal(B.e6Definitive(null), false);
});
test('item 6: the name refusals carry the owner copy; the line stands only while the field holds the refused (trimmed) name', () => {
  assert.deepEqual({ ...B.NAME_ERR }, { name_taken: 'Ya hay una sucursal con ese nombre en esta marca.', bad_name: 'Escribí un nombre de hasta 60 caracteres.' });
  const err = { code: 'name_taken', name: 'Norte' };
  assert.equal(B.nameRefused(err, 'Norte'), true);
  assert.equal(B.nameRefused(err, '  Norte '), true, 'as sent: trimmed');
  assert.equal(B.nameRefused(err, 'Norte 2'), false);
  assert.equal(B.nameRefused(null, 'Norte'), false);
  assert.equal(B.nameRefused({ code: 'op_conflict', name: 'Norte' }, 'Norte'), false, 'only the two name codes');
  assert.ok(B.E6_DEFINITIVE.includes('name_taken') && B.E6_DEFINITIVE.includes('bad_name'), 'both are definitive');
});
