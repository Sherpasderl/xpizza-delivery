// «Marca» (NOTE-portal-marca-build, forks ruled 2026-11-02) — the brand fields' rules, mirrored from the server's validateBrandFields
// (3a, brand/brand-source.js) for INSTANT feedback only: the server is the authority and refuses on its own. Same sink rule as the
// platform-config `str()`: no `<`, `>` or control characters. Pure: no DOM, no network.
export const NAME_MIN = 2;
export const NAME_MAX = 40;
export const NOTE_MAX = 140;
export const KEYS = Object.freeze(['display_name', 'accent', 'logo', 'pickup_note']);
const BAD = /[<>\u0000-\u001f\u007f]/;

// one field → null (fine) or the server's `reason` code (BRIEF-3a-marca-server: too_short / too_long / blank / bad_chars / unknown_accent)
export function nameReason(v) {
  if (typeof v !== 'string' || v.trim() === '') return 'blank';
  const t = v.trim();
  if (BAD.test(t)) return 'bad_chars';
  if (t.length < NAME_MIN) return 'too_short';
  if (t.length > NAME_MAX) return 'too_long';
  return null;
}
export function noteReason(v) {
  if (typeof v !== 'string') return 'bad_chars';
  if (BAD.test(v)) return 'bad_chars';
  if (v.length > NOTE_MAX) return 'too_long';
  return null;
}
export const accentReason = (id, palette) => (Array.isArray(palette) && palette.some((p) => p && p.id === id) ? null : 'unknown_accent');

// the body the server receives: exactly the four keys, the name trimmed, the logo null until the logo pipeline (M2)
export function toFields(st) {
  return { display_name: String(st.display_name || '').trim(), accent: st.accent, logo: null, pickup_note: String(st.pickup_note || '') };
}
// the first failing field, in form order → { field, reason } | null
export function firstProblem(st, palette) {
  const n = nameReason(st.display_name); if (n) return { field: 'display_name', reason: n };
  const a = accentReason(st.accent, palette); if (a) return { field: 'accent', reason: a };
  const p = noteReason(st.pickup_note); if (p) return { field: 'pickup_note', reason: p };
  return null;
}

// what differs from the saved baseline, in the mockup's words («Cambios sin guardar: color, logo, nota.»)
const LABEL = { display_name: 'nombre', accent: 'color', pickup_note: 'nota' };
export function changed(st, base) {
  const out = [];
  if (String(st.display_name || '').trim() !== String(base.display_name || '').trim()) out.push('display_name');
  if (st.accent !== base.accent) out.push('accent');
  if (String(st.pickup_note || '') !== String(base.pickup_note || '')) out.push('pickup_note');
  return out;
}
export const changedLine = (keys) => `Cambios sin guardar: ${keys.map((k) => LABEL[k]).join(', ')}.`;

// field errors — Spanish copy (a proposal: the approved mockup draws no error state)
const ERR = {
  display_name: { blank: 'Escribí el nombre de tu marca.', too_short: 'Escribí al menos 2 caracteres.', too_long: 'Hasta 40 caracteres.', bad_chars: 'Sin los signos < ni >.' },
  accent: { unknown_accent: 'Elegí uno de los colores.' },
  pickup_note: { too_long: 'Hasta 140 caracteres.', bad_chars: 'Sin los signos < ni >.' },
};
export const errText = (field, reason) => (ERR[field] && ERR[field][reason]) || 'Revisá este dato.';

// the monogram: the brand's first letter, as the customer sees it with no logo
export function initial(name) {
  const c = Array.from(String(name || '').trim())[0];
  return c ? c.toLocaleUpperCase('es') : '';
}
