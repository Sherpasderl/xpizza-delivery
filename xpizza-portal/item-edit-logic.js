// S4 «Editar producto» — the drawer's WORKING COPY (PLAN-portal-item-edit r6 addendum S4; MOCKUP-portal-item-edit.html frames
// A–F, the approved target: every string here is the mockup's, verbatim). Pure and DOM-free, like editor.js.
//
// The drawer never writes the shared draft while the merchant types: open() snapshots the six fields (photo, name, description,
// category, subcategory, price — and a group's option prices), set() changes the COPY, view() derives everything the drawer
// shows from it, and save() hands the whole edit to editor.js editItem ONCE. cancel() drops the copy; earlier draft changes
// stay. A closed session (saved or cancelled) neither edits nor saves again — a double click writes once.
//
// A photo upload is bound to the session that started it (uploadBinding): a cancelled drawer, a replaced upload or a late
// answer never lands, in the draft or in a newer drawer. «Guardar» waits while an upload is in flight; a failed one is not a
// hold (the merchant may save the rest, then retry or remove it).
import {
  draftSource, choiceGroup, editItem, itemNameProblem, itemDescProblem, itemCategoryProblem, tidyItemName, parsePrice,
  draftPhotos, ITEM_NAME_MAX, ITEM_DESC_MAX,
} from './editor.js';

export const COPY = {
  name: { empty: 'Escribí un nombre', long: 'Hasta 60 letras', quote: 'Quitá las comillas y los signos < >',
    taken: 'Ya hay un producto con ese nombre', unavailable: 'Ese nombre no está disponible',
    option_long: 'El nombre completo de la opción supera 60 letras' },
  desc: { long: 'Hasta 200 letras' },
  cat: { section_empty: 'No podés dejar la sección vacía. Agregá otro producto primero.',
    subsection_empty: 'No podés dejar la subcategoría vacía. Agregá otro producto primero.' },
  save: { none: 'No hay cambios que guardar', fixName: 'Corregí el nombre para guardar', shortName: 'Acortá el nombre para guardar',
    otherCat: 'Elegí otra categoría para guardar',
    // advisor ruling 2026-11-08 (Q4): the three holds the mockup draws no title for
    fixDesc: 'Corregí la descripción para guardar', pickSubcat: 'Elegí una subcategoría', uploading: 'Esperá a que termine de subir la foto' },
  movedTo: (section) => `Al mover a ${section}:`,
  extraLost: (x) => `Deja de aceptar el extra ${x}`,
  extraGained: (x) => `Acepta el extra ${x}`,
  pickupOn: 'Queda solo para recoger', pickupOff: 'Vuelve a entregarse a domicilio',
  weekendOn: 'Pasa a venderse solo los fines de semana', weekendOff: 'Pasa a venderse todos los días',
  rewardsOff: 'Deja de canjearse con puntos', rewardsOn: 'Pasa a canjearse con puntos',
};

const chars = (s) => [...String(s)].length;
const cats = (draft) => { const st = draftSource(draft).structure; return st && Array.isArray(st.categories) ? st.categories : []; };
const catOf = (draft, id) => cats(draft).find((c) => c && String(c.id) === String(id)) || null;
const subcatsOf = (draft, id) => { const c = catOf(draft, id); return c && Array.isArray(c.subcats) && c.subcats.length ? c.subcats.map(String) : null; };
const rowOf = (draft, key) => (draftSource(draft).items || []).find((r) => r && r.key === key) || null;

let seq = 0;
// The drawer for an existing product, or null (an unknown key, an option, an unsaved addition).
export function open(draft, key) {
  const row = rowOf(draft, key);
  if (!row || !row.display || row.display.variantOf != null || 'ref' in row) return null;
  const d = row.display;
  const g = choiceGroup(draft, key);
  const photos = draftPhotos(draft);
  const base = {
    name: typeof d.name === 'string' ? d.name : '', desc: typeof d.desc === 'string' ? d.desc : '',
    cat: d.cat == null ? null : String(d.cat), subcat: typeof d.subcat === 'string' ? d.subcat : null,
    price: g ? null : (Number.isInteger(row.price) ? String(row.price) : ''),
    optionPrices: g ? Object.fromEntries(g.options.map((o) => [o.key, Number.isInteger(o.price) ? String(o.price) : ''])) : {},
    photo: Object.prototype.hasOwnProperty.call(photos, key) ? { ...photos[key] } : undefined,
  };
  return { id: ++seq, draft, key, group: !!g, base, work: JSON.parse(JSON.stringify({ ...base, photo: base.photo === undefined ? null : base.photo })),
    photoTouched: false, upload: null, closed: false };
}

// One field of the copy. A section change clears the subsection (moving INTO one with subsections asks for a choice: no preselect).
export function set(s, field, value) {
  if (!s || s.closed) return s;
  const w = s.work;
  if (field === 'name' || field === 'desc') w[field] = typeof value === 'string' ? value : '';
  else if (field === 'cat') { const v = value == null ? null : String(value); if (v !== w.cat) { w.cat = v; w.subcat = null; } }
  else if (field === 'subcat') w.subcat = value == null || value === '' ? null : String(value);
  else if (field === 'price') w.price = typeof value === 'string' ? value : String(value ?? '');
  else if (field === 'optionPrice' && value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(w.optionPrices, value.key)) w.optionPrices[value.key] = String(value.raw ?? '');
  else if (field === 'photo') { w.photo = value; s.photoTouched = true; s.upload = null; }
  return s;
}

const catChanged = (s) => s.work.cat !== s.base.cat || s.work.subcat !== s.base.subcat;
// The fields the merchant changed, in drawer order (the change marks).
function changed(s) {
  const w = s.work, b = s.base, out = [];
  if (s.photoTouched && JSON.stringify(w.photo) !== JSON.stringify(b.photo === undefined ? null : b.photo)) out.push('photo');
  if (tidyItemName(w.name) !== b.name) out.push('name');
  if (w.desc !== b.desc) out.push('desc');
  if (w.cat !== b.cat) out.push('cat');
  if (w.subcat !== b.subcat) out.push('subcat');
  if (!s.group && w.price.trim() !== b.price) out.push('price');
  if (s.group && Object.keys(w.optionPrices).some((k) => w.optionPrices[k].trim() !== b.optionPrices[k])) out.push('optionPrices');
  return out;
}

// What a move changes for this product, from the document's own section rules — the lines that apply, or null.
// Extras: the groups the old / new section exposes (an extras group exposed to the PRODUCT directly does not change); a menu
// that declares no exposure says nothing (never a guess). Rewards: an item listed by key keeps its eligibility.
function consequences(draft, s) {
  const w = s.work, b = s.base;
  if (w.cat === b.cat || w.cat == null) return null;
  const st = draftSource(draft).structure || {};
  const row = rowOf(draft, s.key);
  const lines = [];
  const noExtras = row && row.display && row.display.extras_policy === 'none';
  if (!noExtras && st.extras_by_category && typeof st.extras_by_category === 'object') {
    const direct = new Set(((st.extras_by_item || {})[s.key]) || []);
    const from = ((st.extras_by_category[b.cat]) || []).filter((x) => !direct.has(x));
    const to = ((st.extras_by_category[w.cat]) || []).filter((x) => !direct.has(x));
    for (const x of from) if (!to.includes(x)) lines.push(COPY.extraLost(x));
    for (const x of to) if (!from.includes(x)) lines.push(COPY.extraGained(x));
  }
  const flag = (f, on, off) => {
    if (!Array.isArray(st[f])) return;
    const a = st[f].map(String).includes(b.cat), c = st[f].map(String).includes(w.cat);
    if (a !== c) lines.push(c ? on : off);
  };
  flag('pickup_only_cats', COPY.pickupOn, COPY.pickupOff);
  flag('weekend_only_cats', COPY.weekendOn, COPY.weekendOff);
  if (!(Array.isArray(st.redeem_eligible_items) && st.redeem_eligible_items.includes(s.key))) flag('redeem_eligible_cats', COPY.rewardsOn, COPY.rewardsOff);
  if (!lines.length) return null;
  const c = catOf(draft, w.cat);
  return { title: COPY.movedTo(c && typeof c.name === 'string' && c.name.trim() ? c.name : String(w.cat)), lines };
}

// For the tests and the field: the section problem of a target, by the editor's rule.
export const categoryProblem = (draft, key, target) => itemCategoryProblem(draft, key, target);

// Everything the drawer shows, derived from the copy.
export function view(draft, s) {
  const w = s.work;
  const ch = changed(s);
  const errors = { name: null, desc: null, cat: null, price: null };
  const nameP = ch.includes('name') ? itemNameProblem(draft, s.key, w.name) : null;
  if (nameP) errors.name = COPY.name[nameP];
  const descP = ch.includes('desc') ? itemDescProblem(draft, s.key, w.desc) : null;
  if (descP) errors.desc = COPY.desc[descP] || null;
  const subcats = subcatsOf(draft, w.cat);
  const catP = catChanged(s) ? itemCategoryProblem(draft, s.key, { cat: w.cat, subcat: w.subcat }) : null;
  if (catP === 'section_empty' || catP === 'subsection_empty') errors.cat = COPY.cat[catP];
  if (ch.includes('price') && parsePrice(w.price) === null) errors.price = true;
  const badOption = s.group && Object.values(w.optionPrices).some((v) => parsePrice(v) === null);
  const g = s.group ? choiceGroup(draft, s.key) : null;
  const tidy = tidyItemName(w.name);
  const options = g ? g.options.map((o) => { const fullName = `${tidy} - ${o.display.choice}`; return { key: o.key, choice: o.display.choice, fullName, counter: `${chars(fullName)}/${ITEM_NAME_MAX}`, tooLong: chars(fullName) > ITEM_NAME_MAX }; }) : null;
  const uploading = !!(s.upload && s.upload.state === 'busy');
  let title = null;
  if (!ch.length) title = COPY.save.none;
  else if (uploading) title = COPY.save.uploading;
  else if (nameP === 'long' || nameP === 'option_long') title = COPY.save.shortName;
  else if (nameP) title = COPY.save.fixName;
  else if (descP) title = COPY.save.fixDesc;
  else if (errors.cat) title = COPY.save.otherCat;
  else if (catP === 'subcat_required') title = COPY.save.pickSubcat;
  const blocked = !ch.length || nameP || descP || catP || errors.price || badOption || uploading;
  return {
    fields: { name: w.name, desc: w.desc, cat: w.cat, subcat: w.subcat, price: w.price },
    counters: { name: `${chars(w.name)}/${ITEM_NAME_MAX}`, desc: `${chars(w.desc)}/${ITEM_DESC_MAX}` },
    subcats, errors, changed: ch, options, consequences: consequences(draft, s),
    photo: { entry: w.photo, uploading, failed: !!(s.upload && s.upload.state === 'failed') },
    save: { enabled: !blocked, title: blocked ? title : null },
  };
}

// «Guardar»: the whole edit, once. { ok: true } | { ok: false, error: 'closed' | 'stale' | 'invalid' }.
export function save(draft, s) {
  if (!s || s.closed) return { ok: false, error: 'closed' };
  if (draft !== s.draft) return { ok: false, error: 'stale' };
  if (!view(draft, s).save.enabled) return { ok: false, error: 'invalid' };
  const ch = changed(s), w = s.work, e = {};
  if (ch.includes('name')) e.name = w.name;
  if (ch.includes('desc')) e.desc = w.desc;
  if (ch.includes('cat') || ch.includes('subcat')) { e.cat = w.cat; e.subcat = w.subcat; }
  if (ch.includes('price')) e.price = w.price;
  if (ch.includes('optionPrices')) e.optionPrices = Object.fromEntries(Object.entries(w.optionPrices).filter(([k, v]) => v.trim() !== s.base.optionPrices[k]));
  if (ch.includes('photo')) e.photo = w.photo;
  if (!editItem(draft, s.key, e)) return { ok: false, error: 'invalid' };
  s.closed = true;
  return { ok: true };
}

// «Cancelar» / «Cerrar»: the copy goes; the draft keeps whatever it had before the drawer opened.
export function cancel(s) { if (s) { s.closed = true; s.upload = null; } return s; }

// An upload's link to THIS drawer session. Each call replaces the session's current upload ( «Cambiar» again ); only the
// current one, on an open session, may land — in the copy, never the draft.
export function uploadBinding(s) {
  const u = { state: 'idle' };
  if (s && !s.closed) s.upload = u;
  const live = () => !!s && !s.closed && s.upload === u;
  return {
    started() { if (live()) u.state = 'busy'; },
    failed() { if (live()) u.state = 'failed'; },
    apply(pid) {
      if (!live() || typeof pid !== 'string' || !pid) return false;
      s.work.photo = { state: 'pid', pid };
      s.photoTouched = true;
      u.state = 'done';
      return true;
    },
  };
}
