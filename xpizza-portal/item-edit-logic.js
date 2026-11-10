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
  desc: { long: 'Hasta 200 letras', markup: 'Quitá los signos < >' },   // markup: advisor G1 (11-10; descriptions allow quotes)
  cat: { section_empty: 'No podés dejar la sección vacía. Agregá otro producto primero.',
    subsection_empty: 'No podés dejar la subcategoría vacía. Agregá otro producto primero.',
    // S2 contract C-1 (advisor 11-10): the review panel's own title, as the field line; only a race reaches it
    not_renderable: 'Esa sección no se muestra en tu página de pedidos' },
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
// `reservedNames`: what getEditableCatalog served for this restaurant (absent ⇒ the C5 check waits for the server).
export function open(draft, key, reservedNames = null) {
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
    // the extras-group price blocks shown under the fields (advisor Q2): their prices are part of the copy too
    extraPrices: Object.fromEntries((draftSource(draft).extras || []).filter((x) => x && typeof x.key === 'string')
      .map((x) => [x.key, Number.isInteger(x.price) ? String(x.price) : ''])),
  };
  const reserved = Array.isArray(reservedNames) ? new Set(reservedNames.map(String)) : null;
  return { id: ++seq, draft, key, group: !!g, base, work: JSON.parse(JSON.stringify({ ...base, photo: base.photo === undefined ? null : base.photo })),
    photoTouched: false, upload: null, closed: false, reserved, same: null, serverError: null };
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
  else if (field === 'extraPrice' && value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(w.extraPrices, value.key)) w.extraPrices[value.key] = String(value.raw ?? '');
  // «Mismo precio para todas» (advisor Q1): on → every option takes the cheapest usable price; off → each keeps its own
  else if (field === 'samePrice') {
    s.same = value === true;
    if (s.same) {
      const ps = Object.values(w.optionPrices).map(parsePrice).filter((p) => p !== null);
      if (ps.length) { const v = String(Math.min(...ps)); for (const k of Object.keys(w.optionPrices)) w.optionPrices[k] = v; }
    }
  }
  if (field === 'optionPrice') s.same = false;
  // the server's line (a review-time refusal) goes once the merchant changes what it is about: the name also owns the
  // derived option names; the section also owns its subsection
  const clears = { name: ['name', 'options'], desc: ['desc'], cat: ['cat', 'subcat'], subcat: ['subcat'] }[field] || [];
  if (s.serverError && clears.includes(s.serverError.field)) s.serverError = null;
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
  if (Object.keys(w.extraPrices).some((k) => w.extraPrices[k].trim() !== b.extraPrices[k])) out.push('extraPrices');
  return out;
}

// The extras groups a move changes — by THE ONE eligibility rule the server's review line uses (catalog/extras-eligibility.js,
// shipped byte-identical as xpizza-portal/extras-eligibility.js, a classic script: S2 §1.6, advisor G2). A group «accepts X»
// when the evaluator lets at least one of its members carry an extra of category X; the product's line is the UNION over the
// launcher and every option, each with its own overrides (S2 §1.3). → { lost, gained } (sorted), or null when the evaluator
// is not loaded (the move is then held — a consequence is never guessed).
function extrasChange(draft, s) {
  const E = globalThis;
  if (typeof E.projectEligibility !== 'function' || typeof E.eligibleSet !== 'function') return null;
  const src = draftSource(draft);
  const after = JSON.parse(JSON.stringify(src));
  const g = choiceGroup(draft, s.key);
  const members = [s.key, ...(g ? g.options.map((o) => o.key) : [])];
  for (const r of after.items || []) {
    if (!r || !members.includes(r.key) || !r.display) continue;
    r.display.cat = s.work.cat;
    if (s.work.subcat == null) delete r.display.subcat; else r.display.subcat = s.work.subcat;
  }
  try {
    const accepts = (proj) => {
      const out = new Set();
      for (const k of members) for (const x of E.eligibleSet(proj, k)) out.add(proj.extraCat[x]);
      return out;
    };
    const was = accepts(E.projectEligibility(src)), now = accepts(E.projectEligibility(after));
    return { lost: [...was].filter((c) => !now.has(c)).sort(), gained: [...now].filter((c) => !was.has(c)).sort() };
  } catch (_) { return null; }
}

// What a move changes for this product — the lines that apply, or null. Extras: extrasChange (the shared rule); the gates:
// the document's own section lists. Rewards: an item listed by key keeps its eligibility.
function consequences(draft, s) {
  const w = s.work, b = s.base;
  if (w.cat === b.cat || w.cat == null) return null;
  const st = draftSource(draft).structure || {};
  const lines = [];
  const ex = extrasChange(draft, s);
  if (ex) { for (const x of ex.lost) lines.push(COPY.extraLost(x)); for (const x of ex.gained) lines.push(COPY.extraGained(x)); }
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

// Everything the drawer shows, derived from the copy. errors: { name, desc, cat, subcat, options, price } — the line under
// each field (options: frame F2's line under the Opciones block); a server refusal (setServerError) shows on its field until
// the merchant changes that field.
export function view(draft, s) {
  const w = s.work;
  const ch = changed(s);
  const errors = { name: null, desc: null, cat: null, subcat: null, options: null, price: null };
  const nameP = ch.includes('name') ? itemNameProblem(draft, s.key, w.name, s.reserved) : null;
  if (nameP === 'option_long') errors.options = COPY.name.option_long;
  else if (nameP) errors.name = COPY.name[nameP];
  const descP = ch.includes('desc') ? itemDescProblem(draft, s.key, w.desc) : null;
  if (descP) errors.desc = COPY.desc[descP] || null;
  const subcats = subcatsOf(draft, w.cat);
  const catP = catChanged(s) ? itemCategoryProblem(draft, s.key, { cat: w.cat, subcat: w.subcat }) : null;
  if (catP === 'section_empty' || catP === 'subsection_empty') errors.cat = COPY.cat[catP];
  // a move whose consequences cannot be computed (the shared evaluator absent) is held: nothing changes silently
  const moved = w.cat !== s.base.cat && w.cat != null;
  const consequenceGap = moved && extrasChange(draft, s) === null;
  if (ch.includes('price') && parsePrice(w.price) === null) errors.price = true;
  const badOption = s.group && Object.values(w.optionPrices).some((v) => parsePrice(v) === null);
  const badExtra = ch.includes('extraPrices') && Object.keys(w.extraPrices).some((k) => w.extraPrices[k].trim() !== s.base.extraPrices[k] && parsePrice(w.extraPrices[k]) === null);
  const se = s.serverError;
  if (se && !errors[se.field]) errors[se.field] = se.message;
  const g = s.group ? choiceGroup(draft, s.key) : null;
  const tidy = tidyItemName(w.name);
  const options = g ? g.options.map((o) => { const fullName = `${tidy} - ${o.display.choice}`; return { key: o.key, choice: o.display.choice, fullName, counter: `${chars(fullName)}/${ITEM_NAME_MAX}`, tooLong: chars(fullName) > ITEM_NAME_MAX, price: w.optionPrices[o.key] }; }) : null;
  const same = s.group ? (s.same === null ? new Set(Object.values(w.optionPrices).map((v) => v.trim())).size <= 1 : s.same) : null;
  const uploading = !!(s.upload && s.upload.state === 'busy');
  const seTitle = se ? ({ name: COPY.save.fixName, options: COPY.save.shortName, desc: COPY.save.fixDesc, cat: COPY.save.otherCat, subcat: COPY.save.pickSubcat }[se.field] || COPY.save.fixName) : null;
  let title = null;
  if (!ch.length) title = COPY.save.none;
  else if (uploading) title = COPY.save.uploading;
  else if (nameP === 'long' || nameP === 'option_long') title = COPY.save.shortName;
  else if (nameP) title = COPY.save.fixName;
  else if (descP) title = COPY.save.fixDesc;
  else if (errors.cat && !se) title = COPY.save.otherCat;
  else if (catP === 'subcat_required') title = COPY.save.pickSubcat;
  else if (se) title = seTitle;
  else if (consequenceGap) title = COPY.save.otherCat;
  const blocked = !ch.length || nameP || descP || catP || errors.price || badOption || badExtra || uploading || !!se || consequenceGap;
  return {
    fields: { name: w.name, desc: w.desc, cat: w.cat, subcat: w.subcat, price: w.price, extraPrices: { ...w.extraPrices } },
    counters: { name: `${chars(w.name)}/${ITEM_NAME_MAX}`, desc: `${chars(w.desc)}/${ITEM_DESC_MAX}` },
    subcats, errors, changed: ch, options, same, consequences: consequences(draft, s),
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
  if (ch.includes('extraPrices')) e.extraPrices = Object.fromEntries(Object.entries(w.extraPrices).filter(([k, v]) => v.trim() !== s.base.extraPrices[k]));
  if (!editItem(draft, s.key, e, { reserved: s.reserved })) return { ok: false, error: 'invalid' };
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

// A field-tagged refusal from the server (S2 contract §1.2 / §1.3: { error, key, field, option_key? }) → where its line goes in
// the drawer and what it says — the approved frame copy, nothing new. A derived option name's refusal sits on the Opciones
// block (frame F2). null: not a field refusal of an existing product's edit (the review's own panels answer it).
export function refusalLine(body) {
  if (!body || typeof body !== 'object' || typeof body.error !== 'string' || typeof body.key !== 'string') return null;
  const opt = typeof body.option_key === 'string' && body.option_key ? body.option_key : null;
  const T = {
    name_required: ['name', COPY.name.empty],
    name_too_long: ['name', COPY.name.long],
    option_name_too_long: ['options', COPY.name.option_long],
    desc_too_long: ['desc', COPY.desc.long],
    text_unsafe: body.field === 'desc' ? ['desc', COPY.desc.markup] : ['name', COPY.name.quote],
    name_taken: ['name', COPY.name.taken],
    name_previously_used: ['name', COPY.name.unavailable],
    rename_id_conflict: ['name', COPY.name.unavailable],
    reserved_key_conflict: ['name', COPY.name.unavailable],
    subcat_invalid: ['subcat', COPY.save.pickSubcat],
    section_emptied: ['cat', COPY.cat.section_empty],
    subsection_emptied: [body.field === 'cat' ? 'cat' : 'subcat', COPY.cat.subsection_empty],
    category_not_renderable: ['cat', COPY.cat.not_renderable],
  }[body.error];
  if (!T) return null;
  const field = opt && T[0] === 'name' ? 'options' : T[0];
  return { code: body.error, key: body.key, field, optionKey: opt, message: T[1], reread: body.error === 'category_not_renderable' };
}
// The drawer reopened by «Corregir»: the server's line on its field, until the merchant changes that field.
export function setServerError(s, line) {
  if (!s || s.closed || !line || line.key !== s.key) return s;
  s.serverError = { field: line.field, message: line.message };
  return s;
}
