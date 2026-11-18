// PORTAL-UI 1b (PLAN-portal-ui-slice1b-sucursales r4 §3, §5, §2e, §2f) — the PURE decisions behind the 1b branch screens:
// the write gate, the profile validation / normalisation (mirrors the O1b server exactly), the single-writer patch, the
// save-error copy (G4), the detail lede (T7) and the «Copiar horario de» sources (T6). No DOM, no fetch, no clock.
// Node-tested in branch-1b-logic.test.mjs. Brand-agnostic: every name and value comes from getMyBranches data.
import { DAYS, validPrep, brandsOf, resolveSelection, stateModel, kmText, lastOrderText } from './branch-logic.js';
// ENVÍO v3 §3b (5f r5 §5): what Sucursales shows as a branch's delivery reach — its EFFECTIVE app limit, `app_max_km`, served top-level
// on each getMyBranches row; null (no table, or a malformed stored limit: limit_invalid) or absent (an unreadable policy) → null, which
// kmText renders as today's «—». The identity radius is no longer what Sucursales shows. (Here, not in branch-logic.js: the 1a oracle
// composes that module byte-unchanged.)
export function appKm(b) { return b && Number.isFinite(b.app_max_km) ? b.app_max_km : null; }

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ── §3.0 the write gate ───────────────────────────────────────────────────────────────────────────────────────────────────
// W off → 1b renders nothing new and 1a is byte-identical; W on → the 1b controls render per capability.
export const writesOn = (e1) => !!(e1 && e1.membership_writes_enabled === true);

// ── §5 phone (R-WA) ───────────────────────────────────────────────────────────────────────────────────────────────────────
// The SAME literal as the server's portal/branch-phone.js HN_MOBILE (a guard test compares the two sources).
export const HN_MOBILE = /^\+504[3789]\d{7}$/;
// strip spaces - . ( ); 8 digits → +504; 504 + 8 digits → +; anything else is returned stripped (and fails validPhone)
export function normalizePhone(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).replace(/[\s\-.()]/g, '');
  if (/^\d{8}$/.test(s)) return `+504${s}`;
  if (/^504\d{8}$/.test(s)) return `+${s}`;
  return s;
}
export const validPhone = (s) => typeof s === 'string' && HN_MOBILE.test(s);
// display «+504 NNNN-NNNN» for a stored +504 number; anything else is shown exactly as stored (never silently rewritten)
export function phoneDisplay(s) {
  if (typeof s !== 'string') return '';
  const m = /^\+504(\d{4})(\d{4})$/.exec(s);
  return m ? `+504 ${m[1]}-${m[2]}` : s;
}
export const PHONE_PLACEHOLDER = '+504 ____-____';

// ── §5 hours (R-HRS; mirrors branch-ops.js hours7Errors) ──────────────────────────────────────────────────────────────────
export const HOUR_KEYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
// one day → null (valid) | 'order' (open, both HH:MM, start ≥ end: the drawn S5 error) | 'shape' (anything else)
export function dayError(h) {
  if (!isObj(h) || typeof h.open !== 'boolean') return 'shape';
  if (Object.keys(h).some((k) => !['open', 'start', 'end'].includes(k))) return 'shape';
  if (!h.open) return has(h, 'start') || has(h, 'end') ? 'shape' : null;
  if (typeof h.start !== 'string' || typeof h.end !== 'string' || !HHMM.test(h.start) || !HHMM.test(h.end)) return 'shape';
  return h.start < h.end ? null : 'order';
}
export function validHours(hours) {
  if (!isObj(hours)) return false;
  if (Object.keys(hours).some((k) => !HOUR_KEYS.includes(k))) return false;
  return HOUR_KEYS.every((d) => dayError(hours[d]) === null);
}
// the editor's 7 rows, Monday first (1a's order): { key, d, state: 'open'|'closed'|'undef', from, to, err }
// err: null | 'order' (the drawn S5 message) | 'shape' (a malformed / incomplete time: red inputs). An undefined day is
// «Sin definir» (drawn), not an error row — it still keeps Guardar off (validHours).
export function hoursEditRows(hours) {
  return DAYS.map(([key, d]) => {
    const h = isObj(hours) ? hours[key] : null;
    if (isObj(h) && h.open === true) return { key, d, state: 'open', from: typeof h.start === 'string' ? h.start : '', to: typeof h.end === 'string' ? h.end : '', err: dayError(h) };
    if (isObj(h) && h.open === false) return { key, d, state: 'closed', from: '', to: '', err: dayError(h) };
    return { key, d, state: 'undef', from: '', to: '', err: null };
  });
}
// the times a day gets when switched open: its own loaded times, else the nearest earlier open day of the draft (Mon-first),
// else empty (the inputs show red until filled)
export function reopenTimes(draftHours, loadedHours, key) {
  const own = isObj(loadedHours) ? loadedHours[key] : null;
  if (isObj(own) && own.open === true && dayError(own) === null) return { start: own.start, end: own.end };
  const dayKeys = DAYS.map(([k]) => k);
  const i = dayKeys.indexOf(key);
  for (let j = 1; j < 7; j++) {
    const h = isObj(draftHours) ? draftHours[dayKeys[(i - j + 7) % 7]] : null;
    if (isObj(h) && h.open === true && dayError(h) === null) return { start: h.start, end: h.end };
  }
  return { start: '', end: '' };
}
// build EXACTLY the server shape: all 7 days, {open:false} or {open:true,start,end}; no other keys
export function cleanHours(hours) {
  const out = {};
  for (const k of HOUR_KEYS) {
    const h = isObj(hours) ? hours[k] : null;
    if (isObj(h) && h.open === true) out[k] = { open: true, start: h.start, end: h.end };
    else if (isObj(h) && h.open === false) out[k] = { open: false };
  }
  return out;
}
// one day edited: switch it closed / open (open takes reopenTimes), or set a time on an open day. Returns a NEW hours object.
export function editDay(hours, loadedHours, key, change) {
  const base = cleanHours(hours);
  const cur = base[key];
  if (change.open === false) base[key] = { open: false };
  else if (change.open === true) base[key] = { open: true, ...reopenTimes(base, loadedHours, key) };
  else if (isObj(cur) && cur.open === true) base[key] = { open: true, start: has(change, 'start') ? change.start : cur.start, end: has(change, 'end') ? change.end : cur.end };
  return base;
}
// typed «1130» / «11:30» / «9:00» → «HH:MM» when it is one; anything else is kept as typed (and fails validation)
export function normalizeTime(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  let m = /^(\d{1,2}):(\d{2})$/.exec(s) || /^(\d{2})(\d{2})$/.exec(s);
  if (!m && /^\d{3}$/.test(s)) m = [s, s.slice(0, 1), s.slice(1)];
  if (!m) return s;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

// ── T6 «Copiar horario de» (owner only; fills the draft, never a request) ─────────────────────────────────────────────────
export const PRESET_LABEL = 'Lun–Dom 11:00–22:00';
export const PRESET_HOURS = Object.freeze(Object.fromEntries(HOUR_KEYS.map((k) => [k, Object.freeze({ open: true, start: '11:00', end: '22:00' })])));
// siblings = the same brand's identity rows (no drafts), except this one, with VALID profile.hours, by location_name
export function copySources(rows, selfRid) {
  return (rows || [])
    .filter((b) => b && b.rid !== selfRid && isObj(b.profile) && validHours(b.profile.hours) && typeof b.profile.location_name === 'string')
    .map((b) => ({ rid: b.rid, label: b.profile.location_name, hours: cleanHours(b.profile.hours) }))
    .sort((a, z) => a.label.localeCompare(z.label, 'es'));
}

// ── the profile draft → ONE E7 patch (§3.3 single writer) ─────────────────────────────────────────────────────────────────
export const PATCH_KEYS = Object.freeze(['phone', 'hours', 'prep_default_min']);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// base = the row's profile as loaded; draft = { phone?, hours?, prep_default_min? }. Only the changed groups ride.
export function profilePatch(base, draft) {
  const p = {};
  if (!isObj(draft)) return p;
  const b = isObj(base) ? base : {};
  if (has(draft, 'phone') && draft.phone !== b.phone) p.phone = draft.phone;
  if (has(draft, 'hours') && !same(cleanHours(draft.hours), b.hours)) p.hours = cleanHours(draft.hours);
  if (has(draft, 'prep_default_min') && draft.prep_default_min !== b.prep_default_min) p.prep_default_min = draft.prep_default_min;
  return p;
}
// per group: is the drafted value valid? (Guardar stays off while any dirty group is invalid)
export function patchErrors(patch) {
  const e = {};
  if (has(patch, 'phone') && !validPhone(patch.phone)) e.phone = true;
  if (has(patch, 'hours') && !validHours(patch.hours)) e.hours = true;
  if (has(patch, 'prep_default_min') && !validPrep(patch.prep_default_min)) e.prep_default_min = true;
  return e;
}
// the «Cambios sin guardar» bar labels, in the drawn order
export function dirtyLabels1b(patch) {
  const out = [];
  if (has(patch, 'hours')) out.push('horario');
  if (has(patch, 'prep_default_min')) out.push('preparación');
  if (has(patch, 'phone')) out.push('contacto');
  return out;
}

// ── G4 save-error copy (owner 2026-10-26): chosen by the fields the failed save CARRIED, not by the error code ────────────
export const PREP_SAVE_ERR = Object.freeze(['No se guardó el tiempo de preparación', 'Revisá el valor y volvé a intentar; si sigue igual, escribinos por WhatsApp.']);
export const GENERIC_SAVE_ERR = Object.freeze(['No se guardaron los cambios', PREP_SAVE_ERR[1]]);
export function saveErrorCopy(patch) {
  const keys = isObj(patch) ? Object.keys(patch) : [];
  return keys.length === 1 && keys[0] === 'prep_default_min' ? PREP_SAVE_ERR : GENERIC_SAVE_ERR;
}

// ── T7 the detail lede ────────────────────────────────────────────────────────────────────────────────────────────────────
// active = the address; inactive = «{address} · desactivada»; staged = «{address} · todavía no recibe pedidos»;
// draft = «Sherpa está configurando la ubicación · todavía no recibe pedidos». No address → no lede (never a guess).
export function ledeOf(row) {
  if (!row) return null;
  if (row.lifecycle === 'draft') return 'Sherpa está configurando la ubicación · todavía no recibe pedidos';
  const a = isObj(row.location) && typeof row.location.address_line === 'string' && row.location.address_line.trim() ? row.location.address_line : null;
  if (!a) return null;
  if (row.lifecycle === 'inactive') return `${a} · desactivada`;
  if (row.lifecycle === 'staged') return `${a} · todavía no recibe pedidos`;
  return a;
}

// ── which 1b editors this caller has on an IDENTITY row (§3.2; drafts are authorized by the brand, commit b) ─────────────
const cap = (b, c) => !!(b && Array.isArray(b.caps) && b.caps.includes(c));
export function editorsOf(row) {
  return { phone: cap(row, 'location.contact'), hours: cap(row, 'location.hours'), prep_default_min: cap(row, 'location.prep') };
}

// ══ commit (b) — the lifecycle (PLAN r4 §3.2, §3.4, §2c, §2e, §2f B1–B8) ════════════════════════════════════════════════════

// ── §3.4 selection: W on, an OWNED brand with no operational row is selectable as a lifecycle-only brand ──────────────────
export const brandRec = (e1, brandId) => (e1 && Array.isArray(e1.brands) ? e1.brands.find((b) => b && b.brand_id === brandId) : null) || null;
export const ownsBrand = (e1, brandId) => { const r = brandRec(e1, brandId); return !!(r && Array.isArray(r.caps) && r.caps.includes('brand.locations')); };
export const draftsOf = (e1, brandId) => { const r = brandRec(e1, brandId); return r && Array.isArray(r.drafts) ? r.drafts.filter((d) => d && typeof d.rid === 'string') : []; };
const byName = (a, z) => String(a.name).localeCompare(String(z.name), 'es');
// 1a's operational brands + the owned brands without an operational row ({branches: [], lifecycleOnly: true}). W off → 1a.
export function brandsOf1b(e1) {
  const ops = brandsOf(e1);
  if (!writesOn(e1)) return ops;
  const seen = new Set(ops.map((b) => b.brand_id));
  const extra = (e1 && Array.isArray(e1.brands) ? e1.brands : [])
    .filter((b) => b && !seen.has(b.brand_id) && ownsBrand(e1, b.brand_id))
    .map((b) => ({ brand_id: b.brand_id, name: typeof b.name === 'string' && b.name ? b.name : b.brand_id, branches: [], lifecycleOnly: true }));
  return [...ops, ...extra].sort(byName);
}
// W off → exactly 1a's resolveSelection. W on: a stored lifecycle-only brand is honoured; with no operational brand at all the
// first owned brand is chosen (instead of «no administra ningún local»); otherwise 1a's choice.
export function resolveSelection1b(e1, stored) {
  if (!writesOn(e1)) return resolveSelection(e1, stored);
  const all = brandsOf1b(e1);
  const life = all.filter((b) => b.lifecycleOnly);
  const pick = (b) => ({ brand_id: b.brand_id, scope: null, locked: false, owner: true, brand: b, lifecycleOnly: true });
  const storedLife = stored && life.find((b) => b.brand_id === stored.brand_id);
  if (storedLife) return pick(storedLife);
  const ops = resolveSelection(e1, stored);
  if (ops) return ops;
  return life.length ? pick(life[0]) : null;
}
// the S2 list order (frame): live branches, then Desactivada, then Por activar — each by name (1a's order within a group)
const LIFE_RANK = Object.freeze({ active: 0, inactive: 1, staged: 2 });
export const listOrder = (rows) => (rows || []).map((r, i) => [r, i]).sort((a, z) => ((LIFE_RANK[a[0].lifecycle] ?? 0) - (LIFE_RANK[z[0].lifecycle] ?? 0)) || (a[1] - z[1])).map(([r]) => r);
export const brandCount = (n) => `${n} ${n === 1 ? 'sucursal' : 'sucursales'}`;

// ── S2 cards (B2, B3) ─────────────────────────────────────────────────────────────────────────────────────────────────────
const addrOf = (row) => (isObj(row.location) && typeof row.location.address_line === 'string' && row.location.address_line.trim() ? row.location.address_line : null);
export const DRAFT_HINT = 'Vas a poder activarla cuando Sherpa termine de configurar la ubicación y la zona de entrega.';
export const READY_HINT_INACTIVE = 'Horario, preparación y equipo en orden. Al activarla vuelve a recibir pedidos.';
export function pillOf(row, nowMs) {
  if (row.lifecycle === 'draft') return { cls: 'pilldraft1b', label: 'Borrador' };
  if (row.lifecycle === 'staged') return { cls: 'pillstaged1b', label: 'Por activar' };
  if (row.lifecycle === 'inactive') return { cls: 'pillinactive1b', label: 'Desactivada' };
  const st = stateModel(row, nowMs);
  return { cls: st.pillCls, label: st.label };
}
export function cardModel(row, nowMs) {
  const draft = row.lifecycle === 'draft';
  const prof = isObj(row.profile) ? row.profile : {};
  const a = addrOf(row);
  const sub = draft ? 'Sherpa está configurando la ubicación' : (a ? (row.lifecycle === 'inactive' ? `${a} · desactivada` : a) : '');
  const prep = draft ? prof.prep_default_min : (row.editable ? row.editable.prep_default_min : null);
  const km = appKm(row);   // ENVÍO v3 §3b: the app's maximum distance
  const meta = [
    ['Zona', draft || !Number.isFinite(km) ? '—' : `${kmText(km)} km`],
    ['Preparación', validPrep(prep) ? `${prep} min` : 'Falta'],
    ['Equipos', draft ? '—' : String(Number.isInteger(row.devices) ? row.devices : 0)],
  ];
  if (!draft) meta.push(['Último pedido de hoy', lastOrderText(row.last_order_today)]);   // B2 / 1a D12; drafts: no numbering
  let hint = null;
  if (draft) hint = { kind: 'quiet', text: DRAFT_HINT };
  else if ((row.lifecycle === 'staged' || row.lifecycle === 'inactive') && !row.legacy && isObj(row.readiness) && Array.isArray(row.readiness.unmet)) {
    const r = readinessRows(row);
    if (r.kind === 'list' && r.unmet === 0) hint = { kind: 'ok', bold: 'Lista para activar.', text: row.lifecycle === 'inactive' ? READY_HINT_INACTIVE : '' };
    else if (r.kind === 'list') hint = { kind: 'warn', bold: 'Le falta:', text: missingText(r) };
  }
  return { rid: row.rid, name: row.name || prof.location_name || row.rid, draft, pill: pillOf(row, nowMs), sub, meta, hint };
}

// ── S8 checklist ↔ readiness (§2c, B5) ────────────────────────────────────────────────────────────────────────────────────
// The ONE row per (code, gap); everything else (not_a_branch, brand_not_on, gap integrity, any unknown code) is the S8c notice.
export const READY_ROWS = Object.freeze([
  { id: 'location', gap: 'location', name: 'Ubicación definida por Sherpa', pending: 'Ubicación · pendiente — Sherpa la configura', ok: 'Lista' },
  { id: 'zone', gap: 'zone', name: 'Zona de entrega', pending: 'Zona de entrega · pendiente — Sherpa la configura', ok: 'Lista' },
  { id: 'hours', gap: 'hours', name: 'Horario de los 7 días', ok: 'Listo' },
  { id: 'prep', gap: 'prep', name: 'Tiempo de preparación normal', ok: 'Listo' },
  { id: 'device', code: 'no_handheld_online', name: 'Al menos un equipo vinculado', ok: 'Listo', unmetSub: 'Vinculá un handheld desde el equipo y encendelo una vez' },
  { id: 'team', code: 'no_owner_or_manager', name: 'Alguien con acceso a la sucursal', ok: 'Listo' },
  { id: 'menu', code: 'menu_not_published', name: 'Menú de la marca publicado', ok: 'Listo' },
]);
const ROW_GAPS = new Set(READY_ROWS.filter((r) => r.gap).map((r) => r.gap));
const ROW_CODES = new Set(READY_ROWS.filter((r) => r.code).map((r) => r.code));
const DAY_WORDS = Object.freeze({ mon: 'lunes', tue: 'martes', wed: 'miércoles', thu: 'jueves', fri: 'viernes', sat: 'sábado', sun: 'domingo' });
const joinY = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`);
// → { kind: 'list', rows: [{id, state, cls, rowCls, name, sub}], unmet } | { kind: 'blocked' } | { kind: 'unknown' } (G3)
export function readinessRows(row) {
  const rd = row && row.readiness;
  if (!isObj(rd) || !Array.isArray(rd.unmet)) return { kind: 'unknown' };
  const unmet = new Set(rd.unmet);
  const gaps = new Set(Array.isArray(rd.identity_gaps) ? rd.identity_gaps : []);
  for (const c of unmet) if (c !== 'identity_invalid' && !ROW_CODES.has(c)) return { kind: 'blocked' };   // not_a_branch, brand_not_on, unknown
  if (unmet.has('identity_invalid') && (!gaps.size || [...gaps].some((g) => !ROW_GAPS.has(g)))) return { kind: 'blocked' };   // integrity / unknown gap
  const prof = isObj(row.profile) ? row.profile : {};
  const a = addrOf(row);
  const km = isObj(row.location) && Number.isFinite(row.location.zone_radius_km) ? row.location.zone_radius_km : null;
  const rows = READY_ROWS.map((r) => {
    const miss = r.gap ? gaps.has(r.gap) : unmet.has(r.code);
    if (miss && r.pending) return { id: r.id, state: 'Pendiente', cls: 'wait', name: r.pending, sub: '' };   // S8b: Sherpa-owned
    if (miss) {
      let sub = r.unmetSub || '';
      if (r.id === 'hours') {
        const undef = DAYS.map(([k]) => k).filter((k) => !(isObj(prof.hours) && isObj(prof.hours[k]) && typeof prof.hours[k].open === 'boolean'));
        sub = undef.length ? `Definí ${joinY(undef.map((k) => DAY_WORDS[k]))}, aunque sea «Cerrado»` : '';
      }
      return { id: r.id, state: 'Falta', cls: 'warn', name: r.name, sub };
    }
    let sub = '';
    if (r.id === 'location') sub = a || '';
    if (r.id === 'zone') sub = Number.isFinite(km) ? `${kmText(km)} km a la redonda · la define Sherpa` : '';
    if (r.id === 'hours') sub = 'Los 7 días definidos';
    if (r.id === 'prep') sub = validPrep(prof.prep_default_min) ? `${prof.prep_default_min} min` : '';
    return { id: r.id, state: r.ok, cls: 'ok', name: r.name, sub };
  });
  return { kind: 'list', rows, unmet: rows.filter((r) => r.cls !== 'ok').length };
}
export const readyCountText = (r) => `${r.unmet} de ${r.rows.length} pendientes`;
// B4: «Le falta: …» = the unmet row names, first letter lower-cased (proper nouns keep their case), joined « · », + «.»
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
export function missingText(r) {
  return `${READY_ROWS.filter((x) => r.rows.some((y) => y.id === x.id && y.cls !== 'ok')).map((x) => lowerFirst(x.name)).join(' · ')}.`;
}
export const canActivate = (row) => { const r = readinessRows(row); return r.kind === 'list' && r.unmet === 0; };

// ── S9 «Nueva sucursal» (E6) ──────────────────────────────────────────────────────────────────────────────────────────────
// codex 1b r3 #2 — THE E6 OUTCOME ORACLE, audited from the server at 76f3a160 (every refusal the createBranchDraft path can return:
// portal/branch-lifecycle-core.js createBranchDraftCore + gateAndToken + brandOwner, portal/ops-core.js verifiedContext,
// branches/branch-store.js createDraft → draftInputs → runOp → acquire → STEPS.create_draft, branches/branch-ops.js draftErrors).
// 'definitive' = the intent is OVER: refused before the brand lock (nothing written), or refused through fail(), which releases the
// lock (a refusal is terminal) — the form is released and the next «Crear» is a new op_id. 'unresolved' = the op may still be
// running or may still complete: the same body is retried under the same op_id. A code not in this table is unresolved.
// branch-1b-logic.test.mjs extracts the server's codes from those functions and fails when one is added without a row here.
export const E6_OUTCOME = Object.freeze({
  // before the lock — nothing written
  forbidden_field: 'definitive', bad_request: 'definitive', bad_brand: 'definitive', bad_phone: 'definitive',   // core whole-body checks
  writes_disabled: 'definitive',   // the gate (503; the view closes «Nueva» on it by name — the write gate is off)
  missing_bearer_token: 'definitive', invalid_credentials: 'definitive', not_authorized: 'definitive',   // auth / brand.locations
  bad_draft: 'definitive', bad_name: 'definitive', bad_prep: 'definitive', bad_hours: 'definitive', bad_op_id: 'definitive',   // draftInputs
  not_a_branch: 'definitive',   // runOp without a brand id
  // after the lock, through fail() — the lock is released, terminal
  op_conflict: 'definitive', brand_not_found: 'definitive', brand_exists: 'definitive', name_taken: 'definitive', rid_conflict: 'definitive',
  rid_exhausted: 'definitive', op_lost: 'definitive', brand_invalid: 'definitive', draft_conflict: 'definitive',
  // the op may still be running or complete
  brand_busy: 'unresolved',   // acquire: another op — possibly OUR original E6 — holds the brand lease (live, or interrupted)
  lease_lost: 'unresolved',   // LOST: another call took this op over; it may still finish it
  unavailable: 'unresolved',  // an outage, a store throw, or a replay whose identity could not be read
});
export const E6_DEFINITIVE = Object.freeze(Object.keys(E6_OUTCOME).filter((c) => E6_OUTCOME[c] === 'definitive'));
// the 4xx kinds api.js types (400 / 401 / 403 / 404 / 409). An untyped 4xx is 'Failed' like a 5xx, so it stays unresolved — the safe
// side. writes_disabled (503) is handled by the view by name, never here.
const E6_4XX_KINDS = Object.freeze(['BadRequest', 'NotSignedIn', 'NotAuthorized', 'NotFound', 'Conflict']);
export const e6Definitive = (e) => !!e && E6_4XX_KINDS.includes(e.kind) && E6_OUTCOME[e.code] === 'definitive';
export const NAME_MAX = 60;
// item 6 (OWNER-APPROVED 2026-10-26, D-b inline under the name): the two E6 name refusals. bad_name is defensive — the client already
// sends only validName names. The error stands while the field still holds the refused name; «Crear» is off until the name changes.
export const NAME_ERR = Object.freeze({ name_taken: 'Ya hay una sucursal con ese nombre en esta marca.', bad_name: 'Escribí un nombre de hasta 60 caracteres.' });
// the server's isText(…, 60) on the TRIMMED name the client sends
export const cleanName = (raw) => String(raw === null || raw === undefined ? '' : raw).trim();
export const validName = (s) => typeof s === 'string' && s.length >= 1 && s.length <= NAME_MAX && s.trim() === s;
export const nameRefused = (nameErr, raw) => !!(nameErr && NAME_ERR[nameErr.code]) && cleanName(raw) === nameErr.name;
// the hours chips (B6: no «Definir después»): the siblings «Copiar de {name}» + the preset; the first is pre-selected
export function newHoursChoices(rows) {
  return [...copySources(rows, null).map((x) => ({ label: `Copiar de ${x.label}`, hours: x.hours })), { label: PRESET_LABEL, hours: PRESET_HOURS }];
}
// a fresh op_id per «Crear sucursal» INTENT (reused on retry). The server's OP_ID_RE is /^[A-Za-z0-9_-]{1,64}$/.
export function newOpId(rand) {
  const c = globalThis.crypto;
  if (typeof rand !== 'function' && c && typeof c.randomUUID === 'function') return c.randomUUID().replace(/-/g, '');
  const r = typeof rand === 'function' ? rand : Math.random;
  let s = '';
  for (let i = 0; i < 32; i++) s += '0123456789abcdef'[Math.floor(r() * 16) % 16];
  return s;
}
