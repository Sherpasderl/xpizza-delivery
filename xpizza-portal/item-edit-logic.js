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
  draftPhotos, ITEM_NAME_MAX, ITEM_DESC_MAX, extrasBaseline, dishDenyExtras,
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
  // OWNER 11-10: the photo field's upload stop in the EDIT drawer (its footer's «Cancelar» drops the whole edit)
  photoStop: 'Detener subida',
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
// `opts.extrasAuthoring`: the server's per-product extras switch (getEditableCatalog); absent ⇒ OFF — the checklist and «Sin
// extras» are shown but inert (STRUCTURE S1, ruling R5); the prices keep working as today (R1 / R4).
export function open(draft, key, reservedNames = null, opts = {}) {
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
    // STRUCTURE S1: the dish's typed exclusions (source.extras order) and «Sin extras» are part of the copy too
    denyExtras: dishDenyExtras(draft, key),
    extrasNone: d.extras_policy === 'none',
  };
  const reserved = Array.isArray(reservedNames) ? new Set(reservedNames.map(String)) : null;
  return { id: ++seq, draft, key, group: !!g, base, work: JSON.parse(JSON.stringify({ ...base, photo: base.photo === undefined ? null : base.photo })),
    photoTouched: false, upload: null, closed: false, reserved, same: null, serverError: null,
    extrasAuthoring: !!(opts && opts.extrasAuthoring === true) };
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
  // STRUCTURE S1 — the checklist (only the keys the PROSPECTIVE dish shows; a kept key outside it is preserved) and «Sin extras».
  // Inert while the server switch is off; the checklist is inert while «Sin extras» is on (A2).
  else if ((field === 'extraOn' || field === 'extraGroupOn') && s.extrasAuthoring && !w.extrasNone && value && typeof value === 'object') {
    const b = prospectBaseline(s);
    const shown = b ? b.groups.flatMap((g) => g.keys) : [];
    const keys = field === 'extraOn' ? (shown.includes(value.key) ? [value.key] : []) : ((b && b.groups.find((g) => g.cat === value.cat)) || { keys: [] }).keys;
    const deny = new Set(w.denyExtras);
    for (const k of keys) { if (value.on === false) deny.add(k); else deny.delete(k); }
    const order = (draftSource(s.draft).extras || []).map((x) => x && x.key);
    w.denyExtras = [...deny].sort((a, b2) => order.indexOf(a) - order.indexOf(b2));
  } else if (field === 'extrasNone' && s.extrasAuthoring) w.extrasNone = value === true;
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
  const was = new Set(b.denyExtras);
  if (w.denyExtras.length !== was.size || w.denyExtras.some((k) => !was.has(k))) out.push('denyExtras');
  if (w.extrasNone !== b.extrasNone) out.push('extrasNone');
  return out;
}

// STRUCTURE S1 (Codex S1 plan r1 #2): the checklist's universe is the dish AS THIS COPY WOULD SAVE IT — its section after the
// copy's move — recomputed on every read (the draft is mutable: no memo by object identity). null: the evaluator is absent.
const prospectBaseline = (s) => extrasBaseline(draftSource(s.draft), s.key, catChanged(s) ? { cat: s.work.cat, subcat: s.work.subcat } : null);
// «en N productos»: the dishes (not options) whose own baseline offers the group — every dish's exclusions and «Sin extras»
// set aside, legacy rules kept; one clone + one projection per read
function groupUsage(draft) {
  const E = globalThis.ExtrasEligibility;
  const src = JSON.parse(JSON.stringify(draftSource(draft)));
  const io = src.structure && src.structure.exposure && src.structure.exposure.item_overrides;
  if (io) for (const k of Object.keys(io)) { delete io[k].deny_extras; if (!Object.keys(io[k]).length) delete io[k]; }
  for (const r of src.items || []) if (r && r.display) delete r.display.extras_policy;
  const proj = E.projectEligibility(src);
  const used = new Map();
  for (const r of src.items || []) {
    if (!r || typeof r.key !== 'string' || !r.display || r.display.variantOf != null) continue;
    const cats = new Set(E.eligibleExtras(proj, r.key).map((k) => proj.extraCat[k]));
    for (const c of cats) used.set(c, (used.get(c) || 0) + 1);
  }
  return used;
}
// The «Opciones» extras cards (frame A / A2 / A3), from the copy.
function extrasCards(draft, s) {
  const w = s.work;
  const b = prospectBaseline(s);
  if (!b) return { authoring: s.extrasAuthoring, none: w.extrasNone, cards: [], gap: true, show: w.extrasNone };
  let used;
  try { used = groupUsage(draft); } catch (_) { return { authoring: s.extrasAuthoring, none: w.extrasNone, cards: [], gap: true, show: w.extrasNone }; }
  const deny = new Set(w.denyExtras);
  const byKey = new Map((draftSource(draft).extras || []).map((x) => [x && x.key, x]));
  const cards = b.groups.map((g) => {
    const rows = g.keys.map((k) => { const x = byKey.get(k); const nm = x && x.display && typeof x.display.name === 'string' && x.display.name.trim() ? x.display.name : k;
      return { key: k, name: nm, price: w.extraPrices[k], on: !deny.has(k) }; });
    return { cat: g.cat, rows, total: rows.length, active: rows.filter((r) => r.on).length, usedBy: used.get(g.cat) || 0, disabled: w.extrasNone || !s.extrasAuthoring };
  });
  // R6: «Sin extras» is offered when the dish has something to switch off, or is already off
  return { authoring: s.extrasAuthoring, none: w.extrasNone, cards, gap: false, show: cards.length > 0 || w.extrasNone };
}

// The extras groups a move changes — by THE ONE eligibility rule the server's review line uses (catalog/extras-eligibility.js,
// shipped byte-identical as xpizza-portal/extras-eligibility.js by tools/sync-client.js, a classic script that defines the
// ExtrasEligibility global: S2 §1.6, advisor G2). A group «accepts X»
// when the evaluator lets at least one of its members carry an extra of category X; the product's line is the UNION over the
// launcher and every option, each with its own overrides (S2 §1.3). → { lost, gained } (sorted), or null when the evaluator
// is not loaded (the move is then held — a consequence is never guessed).
function extrasChange(draft, s) {
  const E = globalThis.ExtrasEligibility;
  if (!E || typeof E.projectEligibility !== 'function' || typeof E.eligibleSet !== 'function') return null;
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
  // contract C-2 (Codex S4P2 r1 P2-4): emptying a subsection is Subcategoría's fault when the product stays in its section,
  // Categoría's when it moves to another (the target may not even show Subcategoría)
  const sameSection = w.cat === s.base.cat;
  if (catP === 'section_empty' || (catP === 'subsection_empty' && !sameSection)) errors.cat = COPY.cat[catP];
  else if (catP === 'subsection_empty') errors.subcat = COPY.cat.subsection_empty;
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
  // a photo on its way IS the merchant's change: the upload's hold is said even when nothing else changed
  if (uploading) title = COPY.save.uploading;
  else if (!ch.length) title = COPY.save.none;
  else if (nameP === 'long' || nameP === 'option_long') title = COPY.save.shortName;
  else if (nameP) title = COPY.save.fixName;
  else if (descP) title = COPY.save.fixDesc;
  else if (errors.cat && !se) title = COPY.save.otherCat;
  else if (catP === 'subcat_required' || (errors.subcat && !se)) title = COPY.save.pickSubcat;
  else if (se) title = seTitle;
  else if (consequenceGap) title = COPY.save.otherCat;
  const extras = extrasCards(draft, s);
  const extrasGap = (ch.includes('denyExtras') || ch.includes('extrasNone')) && extras.gap;
  if (!title && extrasGap) title = COPY.save.none;
  const blocked = !ch.length || nameP || descP || catP || errors.price || badOption || badExtra || uploading || !!se || consequenceGap || extrasGap;
  return {
    fields: { name: w.name, desc: w.desc, cat: w.cat, subcat: w.subcat, price: w.price, extraPrices: { ...w.extraPrices } },
    counters: { name: `${chars(w.name)}/${ITEM_NAME_MAX}`, desc: `${chars(w.desc)}/${ITEM_DESC_MAX}` },
    // a refused move shows its line, not what it would have changed (mockup D2)
    subcats, errors, changed: ch, options, same, consequences: errors.cat || errors.subcat ? null : consequences(draft, s),
    photo: { entry: w.photo, uploading, failed: !!(s.upload && s.upload.state === 'failed') },
    extras,
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
  // STRUCTURE S1 (Codex S1 plan r1 #1): serialized explicitly — the FULL final list (kept keys outside the baseline included),
  // and «Sin extras» as the server's field; absent = untouched
  if (ch.includes('denyExtras')) e.denyExtras = w.denyExtras.slice();
  if (ch.includes('extrasNone')) e.extrasPolicy = w.extrasNone ? 'none' : null;
  if (!editItem(draft, s.key, e, { reserved: s.reserved, extrasAuthoring: s.extrasAuthoring })) return { ok: false, error: 'invalid' };
  s.closed = true;
  return { ok: true };
}

// «Cancelar» / «Cerrar»: the copy goes; the draft keeps whatever it had before the drawer opened.
export function cancel(s) { if (s) { s.closed = true; s.upload = null; } return s; }

// Unsaved work in the copy (the unsaved-edits addendum): any changed field, a photo in the copy, or an upload on its way — the
// same facts view() reports as «Guardar»'s reasons. A closed copy (or none) is never dirty.
export function isDirty(s) {
  if (!s || s.closed) return false;
  return changed(s).length > 0 || !!(s.upload && s.upload.state === 'busy');
}

// «Detener subida» (Codex S4P2 r1 P2-3): the copy forgets the stopped upload — «Guardar» is no longer held by it; every other edit
// stays. The upload's own late answer can no longer land (its binding is no longer the session's).
export function stopUpload(s) { if (s && !s.closed) s.upload = null; return s; }

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
