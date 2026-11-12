// «Envío» step 1 (PLAN-portal-envio-step1 r2 §3–§6) — the Sherpa-admin delivery-fee screen's DECISIONS, free of DOM and SDK
// imports (same split as ventas-logic.js). envio.js does only the DOM plumbing; the map site draws.
//
// One platform-wide band table ({max_km, cents}, 1–20 bands, ≤ 10 km in .5 steps, strictly ascending, whole lempiras ≤ L 150).
// The rules here are the server's (5f's pricing-admin-core validator, with cents % 100 === 0): envio-server-parity.test.mjs
// proves UI-accepts ≡ server-accepts. Nothing here names a restaurant: every name and pin comes from getDeliveryPricing.
//
// Saving is a compare-and-set on policy_version. The outcome of a POST is SAVED only on a parsed 200 with expected + 1; every
// other post-send outcome is UNKNOWN until a FRESH GET decides it (classifyRecovery) — never a blind resend (money rule 17).

export const CAPS = Object.freeze({ maxBands: 20, maxKm: 10, maxLempiras: 150 });
const VERSION_LIMIT = 1e15;   // portal/ops-core.js's okVersion bound, which the writer imports

export const COPY = Object.freeze({
  err: Object.freeze({
    kmCap: 'Máximo 10 km. Más lejos no entregamos.',
    kmOrder: 'Cada tramo tiene que ir más lejos que el anterior.',
    kmEmpty: 'Falta la distancia.',
    feeDecimals: 'Lempiras enteros, sin centavos.',
    feeCap: 'Máximo L 150 por tramo.',
    feeEmpty: 'Falta la tarifa.',
    maxBands: 'Máximo 20 tramos.',
    kmStep: 'Usá medios kilómetros: 2, 2.5, 3…',
    lastRow: 'Dejá al menos un tramo.',
  }),
  dirty: 'Cambios sin guardar',
  malformedReplace: 'No pudimos leer las tarifas guardadas. Guardá una tabla nueva para reemplazarlas.',
  malformedRepair: 'No pudimos leer las tarifas guardadas. Escribinos.',
  noResults: 'Sin resultados',
  unnamedBranch: 'Sucursal sin nombre',
  unnamedRestaurant: 'Restaurante sin nombre',
});

const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
export const okVersion = (v) => Number.isSafeInteger(v) && v >= 0 && v < VERSION_LIMIT;
const okHub = (h) => plain(h) && Number.isFinite(h.lat) && Number.isFinite(h.lng) && Math.abs(h.lat) <= 90 && Math.abs(h.lng) <= 180;
const okBand = (b) => plain(b) && Object.keys(b).length === 2 && Number.isFinite(b.max_km) && Number.isSafeInteger(b.cents);
const sameBands = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((x, i) => plain(x) && plain(b[i]) && x.max_km === b[i].max_km && x.cents === b[i].cents);

// ── fields ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// km: ASCII digits with at most one «.» or «,» decimal part; fee: ASCII digits only (whole lempiras)
export function parseKm(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { empty: true };
  return /^\d+(?:[.,]\d+)?$/.test(s) ? { value: Number(s.replace(',', '.')) } : { format: true };
}
export function parseFee(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { empty: true };
  return /^\d+$/.test(s) ? { value: Number(s) } : { format: true };
}

function kmErrorOf(p, prevKm) {
  const E = COPY.err;
  if (p.empty || p.value === 0) return E.kmEmpty;
  if (p.format) return E.kmStep;
  if (p.value > CAPS.maxKm) return E.kmCap;
  if (!Number.isInteger(p.value * 2)) return E.kmStep;
  if (p.value <= prevKm) return E.kmOrder;
  return null;
}
function feeErrorOf(p) {
  const E = COPY.err;
  if (p.empty) return E.feeEmpty;
  if (p.format) return E.feeDecimals;
  if (p.value > CAPS.maxLempiras) return E.feeCap;
  return null;
}

// ── the table ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// rows: [{ km: text, fee: text }] as typed. Each row's first failing rule wins; the order check compares with the previous row
// whose km is valid. limitKm = the last fully valid row's km (frame 2: «el último tramo válido»).
export function validate(rows) {
  let prevKm = 0, limitKm = null;
  const out = rows.map((r) => {
    const k = parseKm(r.km), f = parseFee(r.fee);
    const kmErr = kmErrorOf(k, prevKm), feeErr = feeErrorOf(f);
    if (!kmErr) prevKm = k.value;
    if (!kmErr && !feeErr) limitKm = k.value;
    return { kmErr, feeErr, km: kmErr ? null : k.value, cents: feeErr ? null : f.value * 100 };
  });
  const invalidCount = out.filter((r) => r.kmErr || r.feeErr).length;
  const valid = rows.length >= 1 && invalidCount === 0;
  const canAdd = rows.length < CAPS.maxBands;
  return {
    rows: out.map(({ kmErr, feeErr }) => ({ kmErr, feeErr })), invalidCount, valid, allValid: valid, limitKm, canAdd,
    addNote: canAdd ? null : COPY.err.maxBands,
    bands: valid ? out.map((r) => ({ max_km: r.km, cents: r.cents })) : null,
  };
}

export function rowsFromBands(bands) {
  if (!Array.isArray(bands) || bands.length === 0) return [{ km: '', fee: '' }];   // no policy yet (G4a): one empty row
  return bands.map((b) => ({ km: String(b.max_km), fee: String(b.cents / 100) }));
}
export function addRow(rows) {
  return rows.length >= CAPS.maxBands ? null : [...rows, { km: '', fee: '' }];
}
export function removeRow(rows, i) {
  if (rows.length <= 1) return { rows, note: COPY.err.lastRow };
  return { rows: rows.filter((_, j) => j !== i), note: null };
}

// equal numbers are clean: «2,5» against a stored 2.5 is not a change
export function isDirty(rows, loadedBands) {
  const loaded = Array.isArray(loadedBands) ? loadedBands : [];
  if (rows.length !== loaded.length) return true;
  return rows.some((r, i) => {
    const k = parseKm(r.km), f = parseFee(r.fee);
    return !('value' in k) || !('value' in f) || k.value !== loaded[i].max_km || f.value * 100 !== loaded[i].cents;
  });
}
export function saveBar(rows, loadedBands) {
  const v = validate(rows);
  if (v.invalidCount > 0) {
    const n = v.invalidCount;
    return { state: 'invalid', text: `Corregí ${n} ${n === 1 ? 'tramo' : 'tramos'} para poder guardar`, canSave: false };
  }
  if (!isDirty(rows, loadedBands)) return { state: 'clean', text: null, canSave: false };
  return { state: 'dirty', text: COPY.dirty, canSave: true };
}

// a stored / candidate band table → would the screen accept it as is (exact shape, and it round-trips through the rows unchanged)?
// envio-server-parity.test.mjs proves this equals the server's validateWrite over a generated domain.
export function acceptsBands(bands) {
  if (!Array.isArray(bands) || !bands.every((b) => okBand(b) && 'max_km' in b && 'cents' in b)) return false;
  const v = validate(rowsFromBands(bands));
  return v.valid && sameBands(v.bands, bands);
}

// ENVÍO v3: `limits` ([{ rid, km }], limitsFor) rides ONLY when one is pending — no limit touched ⇒ today's bands-only body, byte for byte
export function toBody(rows, expectedVersion, limits = []) {
  if (!okVersion(expectedVersion)) throw new Error('envio: bad version');
  const v = validate(rows);
  if (!v.valid) throw new Error('envio: invalid table');
  return { expected_policy_version: expectedVersion, bands: v.bands, ...(Array.isArray(limits) && limits.length ? { limits: limits.map((e) => ({ rid: e.rid, km: e.km })) } : {}) };
}

// what the map draws: every valid band, plus a km over the cap as a refused ring (≤ 100 km, the protocol's bound)
export function mapBands(rows) {
  const v = validate(rows), out = [];
  rows.forEach((r, i) => {
    const e = v.rows[i];
    if (!e.kmErr && !e.feeErr) { out.push({ km: parseKm(r.km).value, fee: parseFee(r.fee).value * 100, ok: true }); return; }
    const k = parseKm(r.km);
    if (e.kmErr === COPY.err.kmCap && k.value <= 100) out.push({ km: k.value, fee: e.feeErr ? 0 : parseFee(r.fee).value * 100, ok: false });
  });
  return out;
}

// ── the confirm sheet ─────────────────────────────────────────────────────────────────────────────────────────────────
export function confirmDiff(wasBands, nowBands) {
  const was = new Map((wasBands || []).map((b) => [b.max_km, b.cents]));
  const now = new Map((nowBands || []).map((b) => [b.max_km, b.cents]));
  const kms = [...new Set([...was.keys(), ...now.keys()])].sort((a, b) => a - b);
  const rows = kms.map((km) => {
    const w = was.has(km) ? was.get(km) : null, n = now.has(km) ? now.get(km) : null;
    const tag = w === null ? 'Nuevo' : n === null ? 'Quitado' : w === n ? 'Igual' : 'Cambia';
    return { km, was: w, now: n, tag };
  });
  const last = (bs) => (bs && bs.length ? bs[bs.length - 1].max_km : null);
  const from = last(wasBands), to = last(nowBands);
  return { rows, limit: from === to ? null : { from, to } };
}
export function limitCallout(limit) {
  if (!limit) return null;
  const { from: a, to: b } = limit;
  if (a === null) return `El límite de entrega queda en ${b} km para todos los restaurantes.`;
  if (b > a) return `El límite de entrega pasa de ${a} km a ${b} km para todos los restaurantes. Las direcciones entre ${a} y ${b} km ya se pueden pedir desde que guardés.`;
  return `El límite de entrega pasa de ${a} km a ${b} km para todos los restaurantes. Las direcciones entre ${b} y ${a} km ya no se pueden pedir desde que guardés.`;
}

// ── the picker ────────────────────────────────────────────────────────────────────────────────────────────────────────
const norm = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const strOrNull = (x) => x === null || typeof x === 'string';
// getDeliveryPricing's `branches` (5f 0021632f): a registered branch whose identity has no brand yet carries brand_id /
// brand_name null — it is still listed (every restaurant is pickable), as its own one-branch brand
const okBranch = (b) => plain(b) && typeof b.rid === 'string' && b.rid !== '' && strOrNull(b.brand_id) && strOrNull(b.brand_name)
  && strOrNull(b.location_name) && (b.hub === null || okHub(b.hub));
const brandKey = (b) => (typeof b.brand_id === 'string' && b.brand_id ? `b:${b.brand_id}` : `r:${b.rid}`);

// one line per BRANCH (rings are measured from a branch's pin): «Marca» alone, «Marca · Sucursal» when the brand has more
export function pickerEntries(branches) {
  const rows = (Array.isArray(branches) ? branches : []).filter(okBranch);
  const per = new Map();
  for (const b of rows) per.set(brandKey(b), (per.get(brandKey(b)) || 0) + 1);
  return rows.map((b) => {
    const n = per.get(brandKey(b));
    const name = typeof b.brand_name === 'string' && b.brand_name.trim() ? b.brand_name.trim() : COPY.unnamedRestaurant;
    const loc = typeof b.location_name === 'string' && b.location_name.trim() ? b.location_name.trim() : COPY.unnamedBranch;
    return { rid: b.rid, label: n > 1 ? `${name} · ${loc}` : name, name, loc: n > 1 ? loc : null, sub: n === 1 ? '1 sucursal' : `${n} sucursales`,
      initial: name[0].toUpperCase(), hub: b.hub ? { lat: b.hub.lat, lng: b.hub.lng } : null };
  }).sort((a, b) => a.label.localeCompare(b.label, 'es', { sensitivity: 'base' }) || a.rid.localeCompare(b.rid));
}
export function filterEntries(entries, query, currentRid) {
  const q = norm(String(query || '').trim());
  const hits = entries.filter((e) => norm(e.label).includes(q));
  const ordered = [...hits.filter((e) => e.rid === currentRid), ...hits.filter((e) => e.rid !== currentRid)];
  const shown = ordered.slice(0, 9).map((e) => ({ ...e, current: e.rid === currentRid }));
  const rest = ordered.length - shown.length;
  return { shown, more: rest > 0 ? `y ${rest} más · escribí para filtrar` : null, empty: hits.length === 0 ? COPY.noResults : null };
}
export function defaultPick(entries) {
  const withPin = entries.find((e) => e.hub);
  return withPin ? withPin.rid : (entries[0] ? entries[0].rid : null);
}

// ── loading and saving ────────────────────────────────────────────────────────────────────────────────────────────────
// getDeliveryPricing's 200 → what the screen shows. A malformed node with a VALID version can be replaced by a save; with an
// invalid one the server refuses every write (current_malformed) — read-only, a server-side repair, never a save loop.
export function loadedState(body) {
  if (plain(body) && body.current_malformed === true) {
    const raw = body.policy_version_raw;
    return okVersion(raw) && raw >= 1
      ? { kind: 'malformed', version: raw, canSave: true, message: COPY.malformedReplace }
      : { kind: 'malformed', version: null, canSave: false, message: COPY.malformedRepair };
  }
  if (plain(body) && okVersion(body.policy_version) && Array.isArray(body.bands) && body.bands.every(okBand)) {
    return { kind: 'policy', version: body.policy_version, bands: body.bands.map((b) => ({ max_km: b.max_km, cents: b.cents })) };
  }
  return { kind: 'unreadable' };
}

const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };
// the immutable save attempt: what was sent, under which version, by whom, in which session
export function startAttempt({ uid, sessionGen, expectedVersion, bands, limits = [] }) {
  if (!okVersion(expectedVersion)) throw new Error('envio: bad version');
  // ENVÍO v3 (§1b): the FULL reviewed request is frozen — the bands AND the requested limits
  return deepFreeze({ uid, sessionGen, expectedVersion, sentBands: bands.map((b) => ({ max_km: b.max_km, cents: b.cents })),
    sentLimits: (Array.isArray(limits) ? limits : []).map((e) => ({ rid: e.rid, km: e.km })) });
}

// a POST's response → saved | unknown. Codex r1 F2 (the locked ruling): ONLY the clean success contract is final; every other
// answer — a 409, 400, 401 or 403 included — is UNKNOWN and is resolved by a FRESH GET before anything is discarded.
export function classifyPost(attempt, res) {
  if (!res || res.transport || res.status !== 200) return 'unknown';
  const b = res.body;
  return plain(b) && b.ok === true && b.policy_version === attempt.expectedVersion + 1 ? 'saved' : 'unknown';
}
// what a non-success POST CLAIMED — a hint read only after the fresh GET (classifyRecovery), never acted on by itself
export function postClaim(res) {
  if (!res || res.transport) return null;
  const b = res.body;
  if (res.status === 409 && plain(b) && (b.error === 'superseded' || b.error === 'current_malformed')) return b.error;
  return { 400: 'refused', 401: 'unauthenticated', 403: 'forbidden' }[res.status] || null;
}

// a FRESH GET after an UNKNOWN → saved | not_landed | refused | conflict | forbidden | unknown (compared with the SENT bands,
// never the draft). The POST's claim decides only once the GET proves nothing landed: a refusal is then final (released).
export function classifyRecovery(attempt, res, claim = null) {
  if (!res || res.transport) return 'unknown';
  if (res.status === 403) return 'forbidden';
  if (res.status !== 200 || !plain(res.body)) return 'unknown';
  const b = res.body;
  if (b.current_malformed === true) return 'conflict';
  if (!okVersion(b.policy_version) || !Array.isArray(b.bands)) return 'unknown';
  if (b.policy_version === attempt.expectedVersion + 1) return sameBands(b.bands, attempt.sentBands) && limitsLanded(attempt.sentLimits, b.branches) ? 'saved' : 'conflict';
  if (b.policy_version === attempt.expectedVersion) return claim === 'refused' ? 'refused' : 'not_landed';
  return 'conflict';
}

// ── ENVÍO v3: each restaurant's maximum distance (PLAN-portal-envio-v3-ui r5 §1; 5f r2–r4 names verbatim) ─────────────────────────
// A RESTAURANT = the rows sharing a brand_id (a row without one is its own). Only rows with limit_editable !== false are its branches
// (an identity-less registered row is read-only and never sent, §1e). Its stored maximum = the SMALLEST of its branches' max_km (null =
// no own limit: the table top) — never a wider reach than a branch has (Q2); ANY branch with limit_invalid (§1c) ⇒ the restaurant shows «—»
// (stored null, invalid) and stays editable: a save from it fans out to ALL its branches (the repair).
export const LIMIT_COPY = Object.freeze({
  empty: 'Falta la distancia máxima.',
  under: 'Mínimo 0.5 km.',
  above: (top) => `Máximo ${top} km: hasta donde llega la tabla.`,
});
export function restaurantsOf(branches) {
  const rows = (Array.isArray(branches) ? branches : []).filter(okBranch);
  const by = new Map();
  for (const b of rows) { const k = brandKey(b); if (!by.has(k)) by.set(k, []); by.get(k).push(b); }
  return [...by.entries()].map(([key, bs]) => {
    const edit = bs.filter((b) => b.limit_editable !== false);
    const invalid = edit.some((b) => b.limit_invalid === true);
    const nums = edit.filter((b) => b.limit_invalid !== true && Number.isFinite(b.max_km)).map((b) => b.max_km);
    const name = typeof bs[0].brand_name === 'string' && bs[0].brand_name.trim() ? bs[0].brand_name.trim() : COPY.unnamedRestaurant;
    return { key, name, rids: edit.map((b) => b.rid), n: bs.length, editable: edit.length > 0, invalid,
      stored: invalid ? null : (nums.length ? Math.min(...nums) : null),
      branches: edit.map((b) => ({ rid: b.rid, max_km: b.limit_invalid === true || !Number.isFinite(b.max_km) ? null : b.max_km, invalid: b.limit_invalid === true })) };
  }).sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }) || a.key.localeCompare(b.key));
}
// min(stored, the CURRENT table top as edited); no stored value → the top; no table → nothing asserted
export function effectiveKm(stored, top) {
  if (!Number.isFinite(top)) return null;
  return Number.isFinite(stored) ? Math.min(stored, top) : top;
}
// the field's line (copy table), or null: empty · under 0.5 · above the table's top · off-step (step 1's own line)
export function limitProblem(text, top) {
  const p = parseKm(text);
  if (p.empty) return LIMIT_COPY.empty;
  if (p.format) return COPY.err.kmStep;
  if (p.value < 0.5) return LIMIT_COPY.under;
  if (Number.isFinite(top) && p.value > top) return LIMIT_COPY.above(top);
  if (Math.round(p.value * 2) !== p.value * 2) return COPY.err.kmStep;
  return null;
}
export function snapHalf(text) {
  const p = parseKm(text);
  return 'value' in p ? Math.round(p.value * 2) / 2 : null;
}
// the pending mutation set, PER BRANCH (Codex r2 P2-6): { rid → km } for every branch of an edited restaurant whose new value differs from
// its loaded max_km (an invalid branch always — the repair). An edit with a line (limitProblem) is no request.
export function pendingLimits(restaurants, edits, top) {
  const out = {};
  for (const r of Array.isArray(restaurants) ? restaurants : []) {
    if (!edits || !Object.prototype.hasOwnProperty.call(edits, r.key) || !r.editable) continue;
    const text = edits[r.key];
    if (limitProblem(text, top)) continue;
    const km = snapHalf(text);
    for (const b of r.branches) if (b.invalid || b.max_km !== km) out[b.rid] = km;
  }
  return out;
}
// the request entries: one { rid, km } per pending branch (never km: null — no clear control)
export function limitsFor(pending) {
  return Object.keys(pending || {}).sort().map((rid) => ({ rid, km: pending[rid] }));
}
// recovery (§1b r4/r5): every REQUESTED { rid, km } landed (that row's stored max_km === km); a requested row MISSING from the re-read is
// unresolved ⇒ not landed; rows the request did not name are not judged
function limitsLanded(sent, branches) {
  if (!Array.isArray(sent) || !sent.length) return true;
  const rows = Array.isArray(branches) ? branches : [];
  return sent.every((e) => { const r = rows.find((b) => plain(b) && b.rid === e.rid); return !!r && r.limit_invalid !== true && r.max_km === e.km; });
}
