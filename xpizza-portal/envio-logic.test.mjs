// «Envío» step 1 (PLAN-portal-envio-step1 r2 §5–§6) — envio-logic.js, the screen's decisions. Run:
//   node --test xpizza-portal/envio-logic.test.mjs
// Pure functions only. The UI ≡ server cross-test (F5) lives in envio-server-parity.test.mjs, against 5f's real validator.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  COPY, CAPS, okVersion, parseKm, parseFee, rowsFromBands, validate, removeRow, addRow, isDirty, saveBar, toBody, mapBands,
  confirmDiff, limitCallout, pickerEntries, filterEntries, defaultPick, loadedState, startAttempt, classifyPost, classifyRecovery,
} from './envio-logic.js';

const R = (km, fee) => ({ km, fee });
const errs = (rows) => validate(rows).rows.map((r) => [r.kmErr, r.feeErr]);

test('caps and copy are the mockup\'s and the server\'s (≤ 20 bands, ≤ 10 km, ≤ L 150, whole lempiras, .5 km)', () => {
  assert.deepStrictEqual(CAPS, { maxBands: 20, maxKm: 10, maxLempiras: 150 });
  assert.deepStrictEqual(COPY.err, {
    kmCap: 'Máximo 10 km. Más lejos no entregamos.', kmOrder: 'Cada tramo tiene que ir más lejos que el anterior.',
    kmEmpty: 'Falta la distancia.', feeDecimals: 'Lempiras enteros, sin centavos.', feeCap: 'Máximo L 150 por tramo.',
    feeEmpty: 'Falta la tarifa.', maxBands: 'Máximo 20 tramos.', kmStep: 'Usá medios kilómetros: 2, 2.5, 3…', lastRow: 'Dejá al menos un tramo.',
  });
});

test('parseKm(): digits with one «.» or «,»; trimmed; anything else is a format error', () => {
  assert.deepStrictEqual(parseKm('2.5'), { value: 2.5 });
  assert.deepStrictEqual(parseKm(' 2,5 '), { value: 2.5 });
  assert.deepStrictEqual(parseKm('10'), { value: 10 });
  assert.deepStrictEqual(parseKm(''), { empty: true });
  assert.deepStrictEqual(parseKm('   '), { empty: true });
  for (const bad of ['-3', '+3', '1e1', '2 5', '2.5.1', '2,5,1', 'abc', '.5', '5.', '0x10', 'Infinity', '٣']) assert.deepStrictEqual(parseKm(bad), { format: true }, bad);
  assert.deepStrictEqual(parseFee('40'), { value: 40 });
  assert.deepStrictEqual(parseFee(''), { empty: true });
  for (const bad of ['40.0', '40,5', '-1', '4 0', '1e2', 'L 40']) assert.deepStrictEqual(parseFee(bad), { format: true }, bad);
});

test('validate(): each rule, its copy, first failing rule wins', () => {
  assert.deepStrictEqual(errs([R('3', '40'), R('6', '60'), R('10', '80')]), [[null, null], [null, null], [null, null]]);
  const E = COPY.err;
  assert.deepStrictEqual(errs([R('', '40')]), [[E.kmEmpty, null]]);
  assert.deepStrictEqual(errs([R('0', '40')]), [[E.kmEmpty, null]]);
  assert.deepStrictEqual(errs([R('0.0', '40')]), [[E.kmEmpty, null]]);
  assert.deepStrictEqual(errs([R('12', '40')]), [[E.kmCap, null]]);
  assert.deepStrictEqual(errs([R('12.3', '40')]), [[E.kmCap, null]], 'the cap before the step');
  assert.deepStrictEqual(errs([R('10.5', '40')]), [[E.kmCap, null]]);
  assert.deepStrictEqual(errs([R('2.3', '40')]), [[E.kmStep, null]]);
  assert.deepStrictEqual(errs([R('abc', '40')]), [[E.kmStep, null]]);
  assert.deepStrictEqual(errs([R('6', '40'), R('6', '50')]), [[null, null], [E.kmOrder, null]]);
  assert.deepStrictEqual(errs([R('6', '40'), R('3', '50')]), [[null, null], [E.kmOrder, null]]);
  // «previous VALID row»: an invalid middle row doesn't poison the order check
  assert.deepStrictEqual(errs([R('3', '40'), R('2.3', '50'), R('6', '60')]), [[null, null], [E.kmStep, null], [null, null]]);
  assert.deepStrictEqual(errs([R('3', '40'), R('12', '50'), R('6', '60')]), [[null, null], [E.kmCap, null], [null, null]], 'a refused 12 km sets no bar');
  assert.deepStrictEqual(errs([R('3', '40'), R('9.3', '50'), R('6', '60')]), [[null, null], [E.kmStep, null], [null, null]], 'a 9.3 sets no bar');
  assert.deepStrictEqual(errs([R('3', '')]), [[null, E.feeEmpty]]);
  assert.deepStrictEqual(errs([R('3', '40.5')]), [[null, E.feeDecimals]]);
  assert.deepStrictEqual(errs([R('3', '-1')]), [[null, E.feeDecimals]]);
  assert.deepStrictEqual(errs([R('3', '151')]), [[null, E.feeCap]]);
  assert.deepStrictEqual(errs([R('3', '150')]), [[null, null]]);
  assert.deepStrictEqual(errs([R('3', '0')]), [[null, null]], 'L 0 is allowed, as the server allows 0 cents');
  assert.deepStrictEqual(errs([R('0.5', '0'), R('9.5', '1'), R('10', '150')]), [[null, null], [null, null], [null, null]]);
});

test('validate(): table facts — valid, invalid count, bands, the limit (last VALID band), add cap at 20', () => {
  const v = validate([R('3', '40'), R('6', '60'), R('10', '80'), R('12', '100')]);
  assert.strictEqual(v.valid, false);
  assert.strictEqual(v.invalidCount, 1);
  assert.strictEqual(v.limitKm, 10);
  assert.strictEqual(v.allValid, false);
  assert.strictEqual(v.bands, null, 'no body while any row is invalid');
  const ok = validate([R('3', '40'), R('6,5', '60')]);
  assert.strictEqual(ok.valid, true);
  assert.deepStrictEqual(ok.bands, [{ max_km: 3, cents: 4000 }, { max_km: 6.5, cents: 6000 }]);
  assert.strictEqual(ok.limitKm, 6.5);
  const rows20 = Array.from({ length: 20 }, (_, i) => R(String((i + 1) / 2), '10'));
  assert.strictEqual(validate(rows20).canAdd, false);
  assert.strictEqual(validate(rows20).addNote, COPY.err.maxBands);
  assert.strictEqual(validate(rows20.slice(0, 19)).canAdd, true);
  assert.strictEqual(validate(rows20.slice(0, 19)).addNote, null);
  assert.strictEqual(validate([R('', '')]).limitKm, null);
});

test('rows: from stored bands (cents → whole lempiras), add one empty row, never remove the last', () => {
  assert.deepStrictEqual(rowsFromBands([{ max_km: 2.5, cents: 4000 }, { max_km: 10, cents: 15000 }]), [R('2.5', '40'), R('10', '150')]);
  assert.deepStrictEqual(rowsFromBands([]), [R('', '')], 'no policy yet: one empty row (G4a)');
  assert.deepStrictEqual(addRow([R('3', '40')]), [R('3', '40'), R('', '')]);
  assert.strictEqual(addRow(Array.from({ length: 20 }, () => R('1', '1'))), null);
  assert.deepStrictEqual(removeRow([R('3', '40'), R('6', '60')], 0), { rows: [R('6', '60')], note: null });
  assert.deepStrictEqual(removeRow([R('3', '40')], 0), { rows: [R('3', '40')], note: COPY.err.lastRow });
});

test('isDirty() / saveBar(): equal numbers are clean («2,5» = 2.5); invalid → «Corregí N tramo(s)…»', () => {
  const loaded = [{ max_km: 2.5, cents: 4000 }];
  assert.strictEqual(isDirty([R('2,5', '40')], loaded), false);
  assert.strictEqual(isDirty([R('2.5', '41')], loaded), true);
  assert.strictEqual(isDirty([R('2.5', '40'), R('', '')], loaded), true);
  assert.strictEqual(isDirty([R('2.3', '40')], loaded), true);
  assert.deepStrictEqual(saveBar([R('2.5', '40')], loaded), { state: 'clean', text: null, canSave: false });
  assert.deepStrictEqual(saveBar([R('3', '40')], loaded), { state: 'dirty', text: 'Cambios sin guardar', canSave: true });
  assert.deepStrictEqual(saveBar([R('12', '40')], loaded), { state: 'invalid', text: 'Corregí 1 tramo para poder guardar', canSave: false });
  assert.deepStrictEqual(saveBar([R('12', '40'), R('', '')], loaded), { state: 'invalid', text: 'Corregí 2 tramos para poder guardar', canSave: false });
  assert.deepStrictEqual(saveBar([R('', '')], []), { state: 'invalid', text: 'Corregí 1 tramo para poder guardar', canSave: false }, 'G4a: Guardar disabled until valid');
});

test('toBody(): whole lempiras → cents, the loaded version as the CAS token; refuses an invalid table', () => {
  assert.deepStrictEqual(toBody([R('3', '40'), R('10', '150')], 7), { expected_policy_version: 7, bands: [{ max_km: 3, cents: 4000 }, { max_km: 10, cents: 15000 }] });
  assert.throws(() => toBody([R('12', '40')], 7), /invalid/);
  assert.throws(() => toBody([R('3', '40')], -1), /version/);
  assert.throws(() => toBody([R('3', '40')], 1e15), /version/);
  assert.strictEqual(okVersion(1e15 - 1), true);
  assert.strictEqual(okVersion(1.5), false);
});

test('mapBands(): valid bands drawn, a km over the cap drawn as refused, everything else not drawn', () => {
  assert.deepStrictEqual(mapBands([R('3', '40'), R('2.3', '50'), R('6', ''), R('10', '80'), R('12', '100'), R('abc', '1')]), [
    { km: 3, fee: 4000, ok: true }, { km: 10, fee: 8000, ok: true }, { km: 12, fee: 10000, ok: false },
  ]);
  assert.deepStrictEqual(mapBands([R('12', 'x')]), [{ km: 12, fee: 0, ok: false }], 'a refused ring needs no valid fee');
  assert.deepStrictEqual(mapBands([R('150', '1')]), [], 'beyond what the map can draw: nothing');
});

test('confirmDiff(): rows matched by km — Igual / Cambia / Nuevo / Quitado, in km order; the limit move', () => {
  const was = [{ max_km: 3, cents: 4000 }, { max_km: 6, cents: 5000 }];
  const now = [{ max_km: 3, cents: 4000 }, { max_km: 6, cents: 6000 }, { max_km: 10, cents: 8000 }];
  assert.deepStrictEqual(confirmDiff(was, now), {
    rows: [
      { km: 3, was: 4000, now: 4000, tag: 'Igual' }, { km: 6, was: 5000, now: 6000, tag: 'Cambia' }, { km: 10, was: null, now: 8000, tag: 'Nuevo' },
    ],
    limit: { from: 6, to: 10 },
  });
  const d = confirmDiff([{ max_km: 3, cents: 4000 }, { max_km: 8, cents: 7000 }], [{ max_km: 3, cents: 4000 }, { max_km: 5, cents: 5000 }]);
  assert.deepStrictEqual(d.rows.map((r) => [r.km, r.tag]), [[3, 'Igual'], [5, 'Nuevo'], [8, 'Quitado']]);
  assert.deepStrictEqual(d.limit, { from: 8, to: 5 });
  assert.strictEqual(confirmDiff(was, [{ max_km: 3, cents: 4000 }, { max_km: 6, cents: 9000 }]).limit, null, 'same limit: no callout');
  assert.deepStrictEqual(confirmDiff([], [{ max_km: 4, cents: 1000 }]).limit, { from: null, to: 4 });
});

test('limitCallout(): grows (approved copy, no zones clause), shrinks (advisor-approved mirror, 11-10), first policy', () => {
  assert.strictEqual(limitCallout({ from: 6, to: 10 }),
    'El límite de entrega pasa de 6 km a 10 km para todos los restaurantes. Las direcciones entre 6 y 10 km ya se pueden pedir desde que guardés.');
  assert.strictEqual(limitCallout({ from: 10, to: 6 }),
    'El límite de entrega pasa de 10 km a 6 km para todos los restaurantes. Las direcciones entre 6 y 10 km ya no se pueden pedir desde que guardés.');
  assert.strictEqual(limitCallout({ from: null, to: 4.5 }), 'El límite de entrega queda en 4.5 km para todos los restaurantes.');
  assert.strictEqual(limitCallout(null), null);
});

const BR = [
  { rid: 'r2', brand_id: 'b2', brand_name: 'Pizzería Centro', location_name: 'Norte', hub: { lat: 15.5, lng: -88 } },
  { rid: 'r1', brand_id: 'b1', brand_name: 'Ábaco', location_name: 'Única', hub: { lat: 15.51, lng: -88.01 } },
  { rid: 'r3', brand_id: 'b2', brand_name: 'Pizzería Centro', location_name: 'Sur', hub: null },
  { rid: 'r4', brand_id: 'b4', brand_name: 'Zeta', location_name: null, hub: { lat: 15.49, lng: -88.02 } },
  { rid: 'r5', brand_id: 'b5', brand_name: 'Mar', location_name: null, hub: null },
  { rid: 'r6', brand_id: 'b5', brand_name: 'Mar', location_name: 'Playa', hub: { lat: 15.4, lng: -88.1 } },
];

test('pickerEntries(): one line per BRANCH; «Marca» alone for one branch, «Marca · Sucursal» for more; es-sorted; initials', () => {
  const e = pickerEntries(BR);
  assert.deepStrictEqual(e.map((x) => x.label), ['Ábaco', 'Mar · Playa', 'Mar · Sucursal sin nombre', 'Pizzería Centro · Norte', 'Pizzería Centro · Sur', 'Zeta']);
  assert.deepStrictEqual(e.map((x) => x.sub), ['1 sucursal', '2 sucursales', '2 sucursales', '2 sucursales', '2 sucursales', '1 sucursal']);
  assert.deepStrictEqual(e.map((x) => x.initial), ['Á', 'M', 'M', 'P', 'P', 'Z']);
  assert.deepStrictEqual(e.find((x) => x.rid === 'r3').hub, null);
  assert.deepStrictEqual(e.map((x) => [x.name, x.loc]), [['Ábaco', null], ['Mar', 'Playa'], ['Mar', 'Sucursal sin nombre'], ['Pizzería Centro', 'Norte'], ['Pizzería Centro', 'Sur'], ['Zeta', null]],
    'the menu draws the branch part muted («Marca <span>· Sucursal</span>»)');
  assert.deepStrictEqual(pickerEntries([]), []);
  assert.deepStrictEqual(pickerEntries([{ bad: 1 }, null, { rid: '', brand_id: null, brand_name: 'X', location_name: null, hub: null }]), [], 'rows without a rid are skipped');
  // 5f 0021632f: a registered branch whose identity has no brand yet comes with brand_id / brand_name null — still listed
  // (every restaurant on the platform is pickable), as its own brand, never merged with another null-brand branch
  const loose = pickerEntries([
    { rid: 'r7', brand_id: null, brand_name: 'Solo', location_name: 'Centro', hub: null },
    { rid: 'r8', brand_id: null, brand_name: 'Solo', location_name: null, hub: null },
    { rid: 'r9', brand_id: 'b9', brand_name: null, location_name: null, hub: { lat: 1, lng: 2 } },
    { rid: 'r10', brand_id: 'b9', brand_name: '  ', location_name: 'Norte', hub: null },
  ]);
  assert.deepStrictEqual(loose.map((x) => [x.rid, x.label, x.sub, x.initial]), [
    ['r10', 'Restaurante sin nombre · Norte', '2 sucursales', 'R'], ['r9', 'Restaurante sin nombre · Sucursal sin nombre', '2 sucursales', 'R'],
    ['r7', 'Solo', '1 sucursal', 'S'], ['r8', 'Solo', '1 sucursal', 'S'],
  ]);
});

test('filterEntries(): accent- and case-insensitive; current first with a check; 9 shown, then «y N más · escribí para filtrar»; «Sin resultados»', () => {
  const e = pickerEntries(BR);
  const f = filterEntries(e, '', 'r4');
  assert.deepStrictEqual(f.shown.map((x) => [x.rid, x.current]), [['r4', true], ['r1', false], ['r6', false], ['r5', false], ['r2', false], ['r3', false]]);
  assert.strictEqual(f.more, null);
  assert.strictEqual(f.empty, null);
  assert.deepStrictEqual(filterEntries(e, 'abaco', 'r4').shown.map((x) => x.rid), ['r1']);
  assert.deepStrictEqual(filterEntries(e, 'CENTRO sur', 'r4').shown.map((x) => x.rid), [], 'the query is one substring');
  assert.deepStrictEqual(filterEntries(e, 'centro · sur', 'r4').shown.map((x) => x.rid), ['r3']);
  assert.strictEqual(filterEntries(e, 'qqq', 'r4').empty, 'Sin resultados');
  const many = pickerEntries(Array.from({ length: 15 }, (_, i) => ({ rid: `r${i}`, brand_id: `b${i}`, brand_name: `Restaurante ${String(i).padStart(2, '0')}`, location_name: null, hub: null })));
  const m = filterEntries(many, '', 'r0');
  assert.strictEqual(m.shown.length, 9);
  assert.strictEqual(m.more, 'y 6 más · escribí para filtrar');
});

test('defaultPick(): the first entry (es order) WITH a pin; else the first; none → null', () => {
  assert.strictEqual(defaultPick(pickerEntries(BR)), 'r1');
  assert.strictEqual(defaultPick(pickerEntries([BR[2], BR[4]])), 'r5');
  assert.strictEqual(defaultPick([]), null);
});

test('loadedState(): policy / no policy / malformed with a valid version (replaceable) / with an invalid version (read-only)', () => {
  assert.deepStrictEqual(loadedState({ policy_version: 3, bands: [{ max_km: 3, cents: 4000 }], history: [], caps: {}, branches: BR }),
    { kind: 'policy', version: 3, bands: [{ max_km: 3, cents: 4000 }] });
  assert.deepStrictEqual(loadedState({ policy_version: 0, bands: [], history: [], caps: {} }), { kind: 'policy', version: 0, bands: [] });
  assert.deepStrictEqual(loadedState({ current_malformed: true, policy_version_raw: 4 }),
    { kind: 'malformed', version: 4, canSave: true, message: 'No pudimos leer las tarifas guardadas. Guardá una tabla nueva para reemplazarlas.' });
  for (const raw of [0, -1, 1.5, 1e15, '4', null]) {
    assert.deepStrictEqual(loadedState({ current_malformed: true, policy_version_raw: raw }),
      { kind: 'malformed', version: null, canSave: false, message: 'No pudimos leer las tarifas guardadas. Escribinos.' }, String(raw));
  }
  for (const bad of [null, {}, { policy_version: 3 }, { policy_version: 3, bands: 'x' }, { policy_version: -1, bands: [] }, { policy_version: 3, bands: [{ max_km: 3 }] }]) {
    assert.deepStrictEqual(loadedState(bad), { kind: 'unreadable' }, JSON.stringify(bad));
  }
});

const sent = [{ max_km: 3, cents: 4000 }, { max_km: 10, cents: 8000 }];
const A = () => startAttempt({ uid: 'u1', sessionGen: 4, expectedVersion: 7, bands: sent });

test('startAttempt(): an immutable snapshot (later draft edits can\'t reach it)', () => {
  const src = [{ max_km: 3, cents: 4000 }];
  const a = startAttempt({ uid: 'u1', sessionGen: 4, expectedVersion: 7, bands: src });
  src[0].cents = 1; src.push({ max_km: 5, cents: 1 });
  assert.deepStrictEqual(a, { uid: 'u1', sessionGen: 4, expectedVersion: 7, sentBands: [{ max_km: 3, cents: 4000 }] });
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.sentBands) && Object.isFrozen(a.sentBands[0]));
  assert.throws(() => startAttempt({ uid: 'u1', sessionGen: 4, expectedVersion: 1e15, bands: src }), /version/);
});

test('classifyPost(): SAVED only on a parsed 200 with ok and expected+1; 409s, 400, 401, 403 are definite; ALL else UNKNOWN', () => {
  const a = A();
  assert.strictEqual(classifyPost(a, { status: 200, body: { ok: true, policy_version: 8 } }), 'saved');
  assert.strictEqual(classifyPost(a, { status: 200, body: { ok: true, policy_version: 9 } }), 'unknown');
  assert.strictEqual(classifyPost(a, { status: 200, body: { ok: true, policy_version: 7 } }), 'unknown');
  assert.strictEqual(classifyPost(a, { status: 200, body: { policy_version: 8 } }), 'unknown');
  assert.strictEqual(classifyPost(a, { status: 200, body: null }), 'unknown', 'malformed 200');
  assert.strictEqual(classifyPost(a, { status: 200, malformed: true }), 'unknown');
  assert.strictEqual(classifyPost(a, { status: 409, body: { error: 'superseded', current_version: 9 } }), 'superseded');
  assert.strictEqual(classifyPost(a, { status: 409, body: { error: 'current_malformed' } }), 'current_malformed');
  assert.strictEqual(classifyPost(a, { status: 409, body: { error: 'other' } }), 'unknown');
  assert.strictEqual(classifyPost(a, { status: 400, body: { error: 'bad_request', field: 'bands' } }), 'refused');
  assert.strictEqual(classifyPost(a, { status: 401, body: { error: 'unauthenticated' } }), 'unauthenticated');
  assert.strictEqual(classifyPost(a, { status: 403, body: { error: 'not_authorized' } }), 'forbidden');
  for (const r of [{ status: 503, body: { error: 'unavailable', retryable: true } }, { status: 500, body: null }, { status: 502 }, { transport: true }, { status: 0 }, null]) {
    assert.strictEqual(classifyPost(a, r), 'unknown', JSON.stringify(r));
  }
});

test('classifyRecovery(): a FRESH GET decides — expected+1 with the SENT bands = saved; unchanged = not landed; else conflict; a failed GET stays unknown', () => {
  const a = A();
  const get = (body) => ({ status: 200, body: { history: [], caps: {}, ...body } });
  assert.strictEqual(classifyRecovery(a, get({ policy_version: 8, bands: sent })), 'saved');
  assert.strictEqual(classifyRecovery(a, get({ policy_version: 8, bands: [{ max_km: 3, cents: 4000 }] })), 'conflict', 'another table at expected+1');
  assert.strictEqual(classifyRecovery(a, get({ policy_version: 7, bands: [] })), 'not_landed');
  assert.strictEqual(classifyRecovery(a, get({ policy_version: 9, bands: sent })), 'conflict');
  assert.strictEqual(classifyRecovery(a, get({ policy_version: 6, bands: [] })), 'conflict', 'a version that went BACK is not «not landed»');
  assert.strictEqual(classifyRecovery(a, get({ policy_version: 0, bands: [] })), 'conflict');
  assert.strictEqual(classifyRecovery(a, get({ current_malformed: true, policy_version_raw: 8 })), 'conflict');
  assert.strictEqual(classifyRecovery(a, { status: 403, body: { error: 'not_authorized' } }), 'forbidden');
  for (const r of [{ status: 503, body: {} }, { transport: true }, { status: 200, body: null }, { status: 200, malformed: true }, null]) {
    assert.strictEqual(classifyRecovery(a, r), 'unknown', JSON.stringify(r));
  }
});
