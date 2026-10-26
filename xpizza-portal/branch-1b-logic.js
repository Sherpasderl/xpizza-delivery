// PORTAL-UI 1b (PLAN-portal-ui-slice1b-sucursales r4 §3, §5, §2e, §2f) — the PURE decisions behind the 1b branch screens:
// the write gate, the profile validation / normalisation (mirrors the O1b server exactly), the single-writer patch, the
// save-error copy (G4), the detail lede (T7) and the «Copiar horario de» sources (T6). No DOM, no fetch, no clock.
// Node-tested in branch-1b-logic.test.mjs. Brand-agnostic: every name and value comes from getMyBranches data.
import { DAYS, validPrep } from './branch-logic.js';

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
  const order = DAYS.map(([k]) => k);
  const i = order.indexOf(key);
  for (let j = 1; j < 7; j++) {
    const h = isObj(draftHours) ? draftHours[order[(i - j + 7) % 7]] : null;
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
