// Portal 2b-2a Task 6 — the read-only render.
//
// This is the first time a merchant sees their own menu through our software, and two rules outrank
// layout.
//
//   NOTHING MAY SILENTLY DISAPPEAR. A dish missing from item_order, or sitting in a category the
//   structure never declares, is still shown. Dropping it would tell a merchant they do not sell
//   something they do sell — and they would believe the screen over their memory. Every failure mode
//   here resolves toward showing MORE, never less.
//
//   THE ORDER IS THE MERCHANT'S. structure.categories and structure.item_order are content: they are
//   how the menu reads to a customer. Rendering in whatever order the JSON arrived in would quietly
//   reorder someone's menu in front of them.
//
// Everything from the server is written with textContent. Never innerHTML: a dish name is data, and the
// one place a menu editor must not execute its input is the screen that shows it back.

const UNCATEGORIZED = '__uncategorized__';

const nameOf = (cat) => {
  const n = cat && typeof cat.name === 'string' ? cat.name.trim() : '';
  return n || String((cat && cat.id) || '');   // a blank heading tells a merchant nothing
};

// The authoritative integer a customer pays, shown exactly as stored. No arithmetic, no rounding, no
// currency conversion — any transformation here is a lie about a price, which is the one thing this
// screen must never tell. A value that is not a positive integer is not a price we can vouch for, so it
// says so rather than rendering "L0" (free) or "LNaN".
export function priceLabel(price) {
  return (Number.isInteger(price) && price > 0) ? `L${price}` : 'Sin precio';
}

export function groupByCategory(source) {
  const items = (source && Array.isArray(source.items)) ? source.items : [];
  const structure = (source && source.structure) || {};
  const declared = Array.isArray(structure.categories) ? structure.categories : [];
  const order = Array.isArray(structure.item_order) ? structure.item_order : [];

  // item_order first, in its order; anything it forgets keeps its arrival order behind them. An
  // unlisted dish is a gap in the structure, not a reason to hide the dish.
  const rank = new Map(order.map((k, i) => [k, i]));
  const sorted = [...items].sort((a, b) => {
    const ra = rank.has(a && a.key) ? rank.get(a.key) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b && b.key) ? rank.get(b.key) : Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });

  const buckets = new Map(declared.map((c) => [String(c && c.id), []]));
  const orphans = [];
  for (const it of sorted) {
    const cat = it && it.display && it.display.cat;
    if (buckets.has(String(cat))) buckets.get(String(cat)).push(it);
    else orphans.push(it);   // undeclared category, or no display at all
  }

  const groups = declared.map((c) => ({ category: { id: String(c && c.id), name: nameOf(c) }, items: buckets.get(String(c && c.id)) || [] }));
  // Surfaced in a trailing bucket of its own rather than folded into a real category it does not belong
  // to — the merchant needs to SEE that something is mis-filed, not have it quietly tidied away.
  if (orphans.length) groups.push({ category: { id: UNCATEGORIZED, name: 'Sin categoría' }, items: orphans });
  return groups;
}

// ── DOM ────────────────────────────────────────────────────────────────────────────────────────
// SVG lives in its own namespace, so createElement would produce an inert HTMLUnknownElement that
// renders nothing. The chevron is the row's keyboard-reachable opener, so it has to actually draw.
const svgIcon = (d) => {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;   // textContent, always
  return n;
};

import { dragOn, dots } from './extras-view.js';   // STRUCTURE S4 (frame E): the ONE grip drag (S2's X4)

// ── STRUCTURE S4 — the addendum's PROPOSED lines (MOCKUP-portal-structure-S4-addendum H3): null ⇒ «⟦s4.key⟧» on screen until the owner
// approves them (structure-s4-ui's SHIP GATE stays red until then). Frame E's own strings are the approved base mockup's, literal.
export const S4_COPY = Object.freeze({
  emptyTitle: null, emptyBody: null, subcatNeedsDish: null, dropCat: null, dropTitle: null, dropSub: null, dropBody: null, nameTaken: null,
  sheetSubFirst: null, sheetSub: null, subName: null, subPh: null, products: null, firstLine: null, moveLine: null, needOne: null, createSub: null,
  subNameTaken: null, subCaps: null, menuNote: null, toastBack: null, unpromoteLine: null, barSub: null, barSubs: null, barOrder: null,
  mismatchBody: null, partialTitle: null, partialBody: null, partialLine: null, goSection: null, notAttachTitle: null, notAttachBody: null, notAttachLine: null,
  capsCats: null, unnamedLine: null, nameAll: null,
  rowSubcat: null, subAddedRow: null, rowCatSubcat: null, rowCatNew: null, promoteRow: null, rowCatEmpty: null, neverShown: null, afterRow: null,
});
export const s4Copy = (k, vars = null) => (typeof S4_COPY[k] === 'string' ? S4_COPY[k].replace(/\{(\w+)\}/g, (m, v) => (vars && Object.prototype.hasOwnProperty.call(vars, v) ? String(vars[v]) : m)) : `⟦s4.${k}⟧`);

// `s4` (STRUCTURE S4, the server's `sections` switch; absent ⇒ today's rail exactly): { staged: [{id, name}] (the new sections, after
// the declared ones), isNew(id) (a section new in this draft: the F tag «Nueva»), box: null | { value, line } (the inline «Nueva categoría»
// box, frame E), max, onOpen(), onInput(v), onCreate(), onCancel() }. → { input, cnt, create } (the box's live nodes: the caller updates
// them in place while the merchant types — a rebuild under the caret would break a dead-key accent). `s4.reorder`: { move(id, ±1),
// drop(id, index among the others) } — each LIVE section gets S2's grip (drag; ↑ / ↓), a new one none (advisor ruling 4)
export function renderRail(railEl, groups, selectedId, onSelect, s4 = null) {
  railEl.replaceChildren();
  const isNew = s4 && typeof s4.isNew === 'function' ? s4.isNew : () => false;
  const item = (id, name, n, grip, staged = false) => {
    const b = el('button', `railitem${id === selectedId ? ' on' : ''}`);
    b.type = 'button';
    const t = el('div', 'rtext');
    const nm = el('b', null, name);
    if (s4 && isNew(id)) nm.append(el('span', 'tag new', 'Nueva'));
    t.append(nm);
    const c = el('div', 'rcount', String(n));
    b.append(t, c);
    b.addEventListener('click', () => onSelect(id));
    if (staged) b.dataset.staged = '1';   // a new section: the drop line's end anchor (they follow the declared ones)
    if (!grip) { railEl.append(b); return; }
    const rr = el('div', 'rrow'); rr.append(b);
    const gr = el('button', 'rgrip'); gr.type = 'button'; gr.dataset.grip = String(id);
    gr.setAttribute('aria-label', `Mover ${name}`); gr.title = 'Arrastrá para ordenar';
    gr.append(dots());
    dragOn(gr, rr, id, railEl, { drop: (x, idx) => s4.reorder.drop(x, idx) }, { tail: '[data-staged], .railadd, .mk-newcat' });
    gr.addEventListener('keydown', (e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); s4.reorder.move(id, e.key === 'ArrowUp' ? -1 : 1); } });
    rr.append(gr);
    railEl.append(rr);
  };
  const reorder = !!(s4 && s4.reorder);
  for (const g of groups) item(g.category.id, g.category.name, g.items.length, reorder && !isNew(g.category.id));
  if (!s4) return null;
  for (const c of Array.isArray(s4.staged) ? s4.staged : []) item(c.id, c.name, 0, false, true);
  if (!s4.box) {
    const a = el('button', 'railadd'); a.type = 'button';
    a.append(svgIcon('M12 5v14M5 12h14'), document.createTextNode('Nueva categoría'));
    a.addEventListener('click', () => s4.onOpen());
    railEl.append(a);
    return null;
  }
  const box = el('div', 'mk-newcat');
  const lr = el('div', 'mk-lrow');
  const lab = el('label', null, 'Nueva categoría'); lab.htmlFor = 'mk-newcat-in';
  const cnt = el('span', 'mk-cnt', `${[...s4.box.value].length}/${s4.max}`); cnt.setAttribute('aria-live', 'polite');
  lr.append(lab, cnt);
  const input = el('input', 'mgname-in'); input.type = 'text'; input.id = 'mk-newcat-in'; input.value = s4.box.value; input.placeholder = 'Nombre de la categoría';
  input.addEventListener('input', () => s4.onInput(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); s4.onCreate(); } else if (e.key === 'Escape') { e.preventDefault(); s4.onCancel(); } });
  box.append(lr, input);
  if (s4.box.line) {
    box.classList.add('mk-inv');
    // the line, and — when it names a way out (S4-F categories_unnamed) — that way, as the base's quiet link
    const text = typeof s4.box.line === 'string' ? s4.box.line : s4.box.line.text;
    const l = el('div', 'ferr mk-ferr', text); l.setAttribute('role', 'alert'); l.id = 'mk-newcat-e';
    if (typeof s4.box.line === 'object' && s4.box.line.link) {
      const a = el('button', 'mk-lnk', s4.box.line.link.label); a.type = 'button';
      a.addEventListener('click', () => s4.box.line.link.onClick());
      l.append(a);
    }
    input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', l.id);
    box.append(l);
  }
  const btns = el('div', 'mk-btns');
  const cancel = el('button', 'btn ghost sm', 'Cancelar'); cancel.type = 'button';
  cancel.addEventListener('click', () => s4.onCancel());
  const create = el('button', 'btn accent sm', 'Crear'); create.type = 'button'; create.disabled = !s4.box.value.trim();
  create.addEventListener('click', () => s4.onCreate());
  btns.append(cancel, create);
  box.append(btns);
  railEl.append(box);
  return { input, cnt, create };
}

// A price CELL. Read-only it is text; editable it is an input, and the two share the `.price` wrapper
// so the column stays aligned either way.
//
// The input carries the raw integer, never a formatted string: a value the merchant edits must be the
// value the server receives. `inputmode="numeric"` asks a phone for the number pad without restricting
// what can be typed — `type="number"` was avoided deliberately, because browsers silently normalise
// its value (accepting "1e3", localising separators), and a price the merchant did not type is exactly
// the failure this whole slice is built to prevent. editor.parsePrice is the only thing that decides
// what counts, and it refuses anything that is not plain digits.
function priceCell(value, { editable, locked = false, changed, onInput, surface, key }) {
  const cell = el('div', `price${changed ? ' chg' : ''}`);
  // The cell is addressable so the drawer and the row can stay in step without a repaint (a repaint
  // mid-edit would steal the caret). data-*, not an id: keys are merchant text and would not survive
  // as ids, and two surfaces can legitimately share a key.
  if (surface && key !== undefined) cell.dataset.k = `${surface}::${key}`;
  if (!editable) { cell.textContent = priceLabel(value); return cell; }
  cell.append(el('span', 'cur', 'L'));
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.setAttribute('aria-label', 'Precio');
  // A value we cannot vouch for shows as an EMPTY field with the same words the read-only view uses,
  // rather than "0" — which reads as free.
  input.value = (Number.isInteger(value) && value > 0) ? String(value) : '';
  input.placeholder = 'Sin precio';
  if (locked) input.disabled = true;
  else input.addEventListener('input', () => onInput(input.value));
  cell.append(input);
  return cell;
}

// 1D add-product B — the price of a product with a required choice, as the order page draws it (the uniform rule, §0c.3):
// "L {min}" when every option costs the same, "desde L {min}" otherwise. Text, never an input.
export function groupPriceLabel(min, max) {
  if (!(Number.isInteger(min) && min > 0)) return 'Sin precio';
  return min === max ? `L${min}` : `desde L${min}`;
}
// Portal mockup screen 2 (approved): the price ONCE on the product — "L 624 / todas las opciones" with the same price for
// every choice, "desde L 624 / precio por salsa" otherwise. Read-only; prices are edited in the product's drawer.
function groupPriceCell(grp, { changed, key }) {
  const cell = el('div', `price gp${changed ? ' chg' : ''}`);
  cell.dataset.k = `item::${key}`;
  // the caption follows the CALLER's `same` (every choice valid and equal); the price is the order page's rule over the
  // valid prices ("L {min}" when they agree, "desde L {min}" otherwise)
  const same = grp.same === true;
  const priced = Number.isInteger(grp.min) && grp.min > 0;
  cell.append(el('b', null, !priced ? 'Sin precio' : (grp.min === grp.max ? `L ${grp.min}` : `desde L ${grp.min}`)));
  const lbl = typeof grp.label === 'string' && grp.label.trim() ? grp.label.trim().toLocaleLowerCase('es') : 'opción';
  if (priced) cell.append(el('span', null, same ? 'todas las opciones' : `precio por ${lbl}`));
  return cell;
}
// The choices under their product (mockup screen 2): "{Salsa} · el cliente elige 1", then one line per choice — its name,
// RECOMENDADA where this brand draws it, and "mismo precio" or its own price. Not openers: the product row is the one way in.
function groupKids(grp) {
  const kids = el('div', 'kids');
  kids.setAttribute('role', 'list');
  const label = typeof grp.label === 'string' && grp.label.trim() ? grp.label.trim() : 'Elección';
  kids.setAttribute('aria-label', `Opciones de ${label}`);
  const head = el('div', 'kidhead', label);
  head.append(el('span', 'dot', '·'), document.createTextNode('el cliente elige 1'));
  kids.append(head);
  const same = grp.same === true;
  for (const o of grp.options) {
    const kid = el('div', 'kid');
    kid.setAttribute('role', 'listitem');
    const nm = el('span', 'knm', o.name);
    if (o.recommended && grp.badges) nm.append(el('span', 'rec', 'Recomendada'));
    const pr = same ? el('span', 'kprice same', 'mismo precio')
      : el('span', 'kprice diff', Number.isInteger(o.price) && o.price > 0 ? `L ${o.price}` : 'Sin precio');
    const sp = el('span', 'kidspacer'); sp.setAttribute('aria-hidden', 'true');
    kid.append(nm, pr, sp);
    kids.append(kid);
  }
  return kids;
}

const PENCIL = 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z';
const LOCK = 'M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V7a4 4 0 0 1 8 0v4';
// PLAN-public-menu-display T1 (mockup R2) — the section title as a field: the typed value, a counter, «Escribí un nombre» when
// it is empty, Guardar (off while it is not a name) and Cancelar. Typing re-renders nothing: the counter, the message and
// Guardar are updated in place, so the caret stays where the merchant left it.
const SECTION_NAME_MAX = 40;
const NAME_PROBLEM = { empty: 'Escribí un nombre', long: `Hasta ${SECTION_NAME_MAX} letras`, markup: 'Quitá los signos < y >' };
// STRUCTURE S4: «Nueva categoría» judges a name by the same rule and words as a rename (T1, approved) — ONE copy
export { NAME_PROBLEM as SECTION_NAME_PROBLEM, SECTION_NAME_MAX };
function sectionNameField(head, rename) {
  head.classList.add('secedit');
  const field = el('label', 'secfield');
  field.append(el('span', 'secvh', 'Nombre de la sección'));
  const row = el('span', 'secrow');
  const input = document.createElement('input');
  input.className = 'secin';
  input.type = 'text';
  input.maxLength = SECTION_NAME_MAX;
  input.placeholder = 'Nombre de la sección';
  input.autocomplete = 'off';
  input.value = typeof rename.value === 'string' ? rename.value : '';
  const cnt = el('span', 'seccnt');
  row.append(input, cnt);
  const err = el('span', 'secerr');
  field.append(row, err);
  const act = el('span', 'secact');
  const save = el('button', 'btn accent', 'Guardar');
  save.type = 'button';
  const cancel = el('button', 'btn ghost', 'Cancelar');
  cancel.type = 'button';
  act.append(save, cancel);
  const sync = () => {
    const problem = typeof rename.problemOf === 'function' ? rename.problemOf(input.value) : null;
    cnt.textContent = `${input.value.length}/${SECTION_NAME_MAX}`;
    err.textContent = problem ? NAME_PROBLEM[problem] || NAME_PROBLEM.empty : '';
    err.hidden = !problem;
    save.disabled = !!problem;
  };
  input.addEventListener('input', () => { if (typeof rename.onInput === 'function') rename.onInput(input.value); sync(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !save.disabled) { e.preventDefault(); rename.onSave(input.value); }
    if (e.key === 'Escape') { e.preventDefault(); rename.onCancel(); }
  });
  save.addEventListener('click', () => rename.onSave(input.value));
  cancel.addEventListener('click', () => rename.onCancel());
  sync();
  head.append(field, act);
  if (rename.focus) setTimeout(() => { if (input.isConnected) { input.focus(); input.select(); } }, 0);
}

// `opts` is how the read-only 2b-2a render becomes the 2b-2b editor without forking the file. Absent,
// every call behaves exactly as it did before — which is what keeps the read-only paths green.
//
// DELIBERATELY ABSENT: any affordance that writes a pricing KEY. No name field, no contenteditable, no
// add or delete control, no category move. Those are 2b-2c and need the per-merchant key strategy
// first; there is no disabled button for them here, because a control that does not exist cannot be
// re-enabled by a stray line of CSS.
export function renderDetail(detailEl, group, extras, opts = {}) {
  const editable = opts.editable === true;
  const changed = opts.changed || (() => false);
  const onPrice = opts.onPrice || (() => {});
  const onOpen = opts.onOpen || null;
  // 1D add-product A — which rows are NEW (a NUEVO tag) and whether this section can take a new product (only one the
  // brand's order page draws). Both are the caller's answers; the renderer only draws them.
  const isAddition = opts.isAddition || (() => false);
  // 1D add-product B — a NEW product with a required choice: {label, min, max} from the caller, or null. Its row shows the
  // group as a chip and its price as the order page will (read-only: it is the group's, edited in the drawer).
  const groupOf = typeof opts.groupOf === 'function' ? opts.groupOf : () => null;
  // DISH PHOTOS B — the caller builds the row's thumb (+ its tag) from the photo state, or answers null (uploads off and no
  // photo: today's placeholder, exactly). The camera opens the drawer with the picker; render.js only places what it gets.
  const photoOf = typeof opts.photoOf === 'function' ? opts.photoOf : () => null;
  // S4 «Editar producto» (mockup frame B) — the row's unpublished-text tag, «Nombre sin publicar» / «Cambios sin publicar», or null
  const textTagOf = typeof opts.textTagOf === 'function' ? opts.textTagOf : () => null;
  const onPhoto = typeof opts.onPhoto === 'function' ? opts.onPhoto : (id) => onOpen && onOpen(id);
  // «Quitar del menú» (MOCKUP-portal-remove-product frame R3) — a dish pending removal: { onUndo } from the caller, or null
  const pendingOf = typeof opts.pendingOf === 'function' ? opts.pendingOf : () => null;
  const onAdd = editable && typeof opts.onAdd === 'function' && group && opts.canAdd && opts.canAdd(group.category.id) ? opts.onAdd : null;
  // PLAN-public-menu-display T1 — a section's NAME (owner-approved mockup R1–R3b). All three are the caller's answers:
  //   rename   null (no control) | {mode: 'idle' | 'blocked' | 'edit', value, problem, onStart, onInput, onSave, onCancel}
  //   notice   the slim line under the header that says why a control is off (a rename travels alone), or null
  //   locked   prices and «Agregar producto» are off while a name change waits to be published
  const rename = editable && opts.rename && typeof opts.rename === 'object' ? opts.rename : null;
  // STRUCTURE S4 (absent ⇒ today's header and empty state): { isNew (the F tag after the title), subcat: null | { disabled, title,
  // onClick } («Nueva subcategoría», quiet, before «Agregar producto»), empty: null | { title, body, dropLabel, onDrop } (a new section's page),
  // subheads: null | [names] (frame E: the list grouped under one head per subsection, in its order — «{sub}» · its count),
  // onMore: null | (id, button) (frame E2: a row's «Más acciones», before its chevron — existing dishes only, moreFor(it)),
  // headLine: null | text (S4-F: a refusal that names this section, under its header — the base's refusal line),
  // subs: null | { move(sub, ±1), drop(sub, idx), rename: { editing, value, line, onStart(sub), onInput(v), onSave(), onCancel() } }
  // (frame E: a head's grip and pencil), items: null | { move(id, ±1), drop(id, idx) } (frame E: a dish row's grip — S2's drag) }
  const s4 = editable && opts.s4 && typeof opts.s4 === 'object' ? opts.s4 : null;
  const locked = editable && opts.locked === true;
  const rid = (it) => (it && typeof it.key === 'string' ? it.key : (it && typeof it.ref === 'string' ? it.ref : ''));
  detailEl.replaceChildren();
  if (!group) {
    const e = el('div', 'empty');
    e.append(el('b', null, 'Este local todavía no tiene menú'), el('span', null, 'Cuando lo configuremos aparecerá acá.'));
    detailEl.append(e);
    return;
  }
  const head = el('div', 'dhead');
  if (rename && rename.mode === 'edit') sectionNameField(head, rename);
  else {
    head.append(el('div', 'dtitle', group.category.name));
    if (rename) {
      const b = el('button', 'secren');
      b.type = 'button';
      b.append(svgIcon(PENCIL), document.createTextNode('Cambiar nombre'));
      if (rename.mode === 'blocked') b.disabled = true;
      else b.addEventListener('click', () => rename.onStart());
      head.append(b);
    }
    if (s4 && s4.isNew) head.append(el('span', 'tag new mk-htag', 'Nueva'));
  }
  if ((onAdd || (s4 && s4.subcat)) && !(rename && rename.mode === 'edit')) {
    const right = el('span', 'dright');
    if (s4 && s4.subcat) {
      const sb = el('button', 'btn ghost', ''); sb.type = 'button';
      sb.append(svgIcon('M12 5v14M5 12h14'), document.createTextNode('Nueva subcategoría'));
      if (s4.subcat.disabled) { sb.disabled = true; if (s4.subcat.title) sb.title = s4.subcat.title; } else sb.addEventListener('click', () => s4.subcat.onClick());
      right.append(sb);
    }
    if (onAdd) {
      const add = el('button', 'btn', '');
      add.type = 'button';
      add.append(svgIcon('M12 5v14M5 12h14'), document.createTextNode('Agregar producto'));
      if (locked) add.disabled = true;
      else add.addEventListener('click', () => onAdd(group.category.id));
      right.append(add);
    }
    head.append(right);
  }
  detailEl.append(head);
  if (s4 && typeof s4.headLine === 'string' && s4.headLine) { const hl = el('div', 'ferr mk-ferr mk-headline', s4.headLine); hl.setAttribute('role', 'alert'); detailEl.append(hl); }
  if (editable && typeof opts.notice === 'string' && opts.notice) {
    const n = el('div', 'secnote');
    n.append(svgIcon(LOCK), el('span', null, opts.notice));
    detailEl.append(n);
  }

  if (group.items.length === 0 && s4 && s4.empty) {
    // S4-C: a new section's page — what it is waiting for, and its quiet «Quitar categoría»
    const e = el('div', 'empty mk-empty');
    e.append(el('b', null, s4.empty.title), el('span', null, s4.empty.body));
    const acts = el('div', 'mk-emptyacts');
    const drop = el('button', 'btn ptext mk-quiet-danger', s4.empty.dropLabel); drop.type = 'button';
    drop.addEventListener('click', () => s4.empty.onDrop(drop));
    acts.append(drop);
    e.append(acts);
    detailEl.append(e);
  } else if (group.items.length === 0) {
    const e = el('div', 'empty');
    e.append(el('b', null, 'Esta sección está vacía'), el('span', null, 'Todavía no hay productos en esta sección.'));
    detailEl.append(e);
  }
  const subheads = s4 && Array.isArray(s4.subheads) && s4.subheads.length ? s4.subheads : null;
  // frame E: a subsection head — its grip (drag among the heads; ↑ / ↓), its name and pencil (renamed in place), its count
  const subHead = (sub, n) => {
    const h = el('div', 'mk-subh'); h.dataset.sub = sub;
    const sx = s4 && s4.subs ? s4.subs : null;
    const ren = sx && sx.rename && sx.rename.editing === sub ? sx.rename : null;
    if (sx) {
      const g = el('button', 'mk-grip'); g.type = 'button'; g.dataset.grip = `sub:${sub}`;
      g.setAttribute('aria-label', `Mover ${sub}`); g.title = 'Arrastrá para ordenar'; g.append(dots());
      dragOn(g, h, sub, detailEl, { drop: (x, idx) => sx.drop(x, idx) }, { row: '.mk-subh', lift: null, tail: '.addrow' });
      g.addEventListener('keydown', (e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); sx.move(sub, e.key === 'ArrowUp' ? -1 : 1); } });
      h.append(g);
    }
    if (ren) {
      const inp = el('input', 'mk-subin'); inp.type = 'text'; inp.value = ren.value; inp.setAttribute('aria-label', `Nombre de ${sub}`);
      inp.addEventListener('input', () => ren.onInput(inp.value));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ren.onSave(); } else if (e.key === 'Escape') { e.preventDefault(); ren.onCancel(); } });
      h.append(inp);
    } else {
      h.append(el('span', 'mk-sn', sub));
      if (sx && sx.rename) {
        // base E's .dpen look, its own class (no colour crossing)
        const pen = el('button', 'mk-subpen'); pen.type = 'button'; pen.setAttribute('aria-label', `Cambiar nombre de ${sub}`); pen.append(svgIcon(PENCIL));
        pen.addEventListener('click', () => sx.rename.onStart(sub));
        h.append(pen);
      }
    }
    h.append(el('span', 'mk-n', String(n)));
    if (ren && ren.line) { const l = el('div', 'ferr mk-ferr mk-subline', ren.line); l.setAttribute('role', 'alert'); return [h, l]; }
    return [h];
  };
  const subOf = (it) => (it && it.display && typeof it.display.subcat === 'string' ? it.display.subcat : null);
  const subRank = (it) => { const i = subheads ? subheads.indexOf(subOf(it)) : -1; return i === -1 ? -1 : i; };
  const listed = subheads ? [...group.items].sort((a, b) => subRank(a) - subRank(b)) : group.items;
  let curSub;
  for (const it of listed) {
    if (subheads && subOf(it) !== curSub && subRank(it) !== -1) {
      curSub = subOf(it);
      detailEl.append(...subHead(curSub, group.items.filter((x) => subOf(x) === curSub).length));
    }
    const pend = editable ? pendingOf(it) : null;
    const row = el('div', pend ? 'irow mk-pend' : 'irow');
    const info = el('div', 'iinfo');
    const d = (it && it.display) || {};
    // `.nm` carries the name typography (display face, 750, 16px); `.nmed` is the mock's
    // CONTENTEDITABLE option-name affordance and carries only a focus ring. Using .nmed here left the
    // name in the body font AND dressed unwritable text as editable — the wrong class in both senses.
    const nmEl = el('div', 'nm', typeof d.name === 'string' && d.name.trim() ? d.name : (it.key ? String(it.key) : 'Nuevo producto'));
    if (isAddition(it)) nmEl.append(el('span', 'newtag', 'Nuevo'));
    const ttag = pend ? null : textTagOf(it);
    if (pend) { nmEl.classList.add('mk-pendtxt'); nmEl.append(el('span', 'tag mk-sand', 'Se quita al publicar')); }
    if (ttag) nmEl.append(el('span', 'tag mk-ftag', ttag));
    info.append(nmEl);
    if (typeof d.desc === 'string' && d.desc.trim()) info.append(el('div', pend ? 'idesc mk-pendtxt' : 'idesc', d.desc));
    if (pend && typeof pend.error === 'string' && pend.error) info.append(el('div', 'ferr mk-ferr', pend.error));   // a refused «Deshacer» (Codex HIGH r1 P2)
    const grp = groupOf(it);
    if (grp) {
      const chips = el('div', 'ochips');
      const chip = el('span', 'ochip req');
      const n = Array.isArray(grp.options) ? grp.options.length : 0;
      chip.append(svgIcon('M9 6l6 6-6 6'), document.createTextNode(`Elección: ${typeof grp.label === 'string' && grp.label.trim() ? grp.label.trim() : 'Elección'} · ${n} ${n === 1 ? 'opción' : 'opciones'}`));
      chips.append(chip);
      info.append(chips);
    }
    // Opening the drawer is a separate affordance from the inline field, so a merchant editing in the
    // row is never one stray click from a modal, and the row itself stays a non-interactive surface.
    const label = typeof d.name === 'string' && d.name.trim() ? d.name : (it.key ? String(it.key) : 'Nuevo producto');
    const id = rid(it);
    const cells = [];
    if (pend) {
      // R3: greyed in place — the thumb stays (no opener), no info click, no chevron; «Deshacer» takes the chevron's place
      const ph = photoOf(it, { name: label, open: () => {}, upload: () => {}, pending: pend.photo || null });   // the snapshot's photo (Codex HIGH r1 P3)
      const thumb = ph && ph.thumb ? ph.thumb : el('div', 'thumb');
      thumb.setAttribute('inert', ''); thumb.tabIndex = -1;
      cells.push(thumb);
      const undo = el('button', 'mk-lnk mk-undo', 'Deshacer');
      undo.type = 'button';
      undo.dataset.k = id;
      undo.setAttribute('aria-label', `Deshacer: ${label} vuelve al menú`);
      undo.addEventListener('click', () => pend.onUndo());
      cells.push(undo);
    } else if (editable && onOpen) {
      // The mock's own three openers, rather than an invented control: a neutral 50x50 placeholder, the
      // info block itself, and a chevron. The placeholder stays EMPTY — the mock puts a camera there,
      // but images are deferred in this slice and a camera would advertise an upload that does nothing.
      // DISH PHOTOS B — the caller's photo view for this row, or null (uploads off and no photo: today's placeholder, exactly)
      const ph = photoOf(it, { name: label, open: () => onOpen(id), upload: () => onPhoto(id) });
      if (ph && ph.thumb) {
        if (ttag) ph.thumb.classList.add('mk-chg');   // S4 (B): the changed product's thumb takes the green change mark
        cells.push(ph.thumb);
        if (ph.tag) nmEl.append(ph.tag);
      } else {
        const thumb = el('div', 'thumb');
        thumb.title = 'Editar producto';
        thumb.addEventListener('click', () => onOpen(id));
        cells.push(thumb);
      }
      info.classList.add('clk');
      info.addEventListener('click', () => onOpen(id));
      // A real <button>, not the mock's <span>: this is the row's only keyboard-reachable way into the
      // editor, and a merchant who cannot use a mouse still has to be able to change a price.
      if (s4 && typeof s4.onMore === 'function' && (typeof s4.moreFor !== 'function' || s4.moreFor(it))) {
        const mo = el('button', 'mk-more'); mo.type = 'button';
        mo.setAttribute('aria-label', `Más acciones: ${label}`); mo.setAttribute('aria-haspopup', 'menu'); mo.setAttribute('aria-expanded', 'false');
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
        for (const cy of [5, 12, 19]) { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', '12'); c.setAttribute('cy', String(cy)); c.setAttribute('r', '2'); svg.append(c); }
        mo.append(svg);
        mo.addEventListener('click', () => s4.onMore(id, mo));
        cells.push(mo);
      }
      const chev = el('button', 'rowchev');
      chev.type = 'button';
      if (s4 && s4.items && (typeof s4.moreFor !== 'function' || s4.moreFor(it))) row.dataset.rowgrip = '1';
      chev.setAttribute('aria-label', `Editar ${label}`);
      chev.append(svgIcon('M9 6l6 6-6 6'));
      chev.addEventListener('click', () => onOpen(id));
      cells.push(chev);
    }
    const pcell = grp ? groupPriceCell(grp, { changed: changed('item', id) || !!grp.changed, key: id }) : priceCell(it && it.price, {
      editable, locked: locked || !!pend, changed: pend ? false : changed('item', id), onInput: (v) => onPrice('item', id, v),
      surface: 'item', key: id,
    });
    row.append(...cells.slice(0, 1), info, pcell, ...cells.slice(1));
    let unitEl = row;
    if (grp && Array.isArray(grp.options) && grp.options.length) {
      // ONE product row with its choices nested beneath (mockup screen 2): the pair is one unit in the list
      const unit = el('div', 'grow');
      unit.append(row, groupKids(grp));
      detailEl.append(unit); unitEl = unit;
    } else detailEl.append(row);
    // frame E: the dish's grip, first in its row — the unit drags among the section's dishes (S2's drag; ↑ / ↓)
    if (row.dataset.rowgrip) {
      delete row.dataset.rowgrip;
      unitEl.dataset.row = id;
      const g = el('button', 'mk-rgrip'); g.type = 'button'; g.dataset.grip = `row:${id}`;
      g.setAttribute('aria-label', `Mover ${label}`); g.title = 'Arrastrá para ordenar'; g.append(dots());
      dragOn(g, unitEl, id, detailEl, { drop: (x, idx) => s4.items.drop(x, idx) }, { row: '[data-row]', lift: null, tail: '.addrow' });
      g.addEventListener('keydown', (e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); s4.items.move(id, e.key === 'ArrowUp' ? -1 : 1); } });
      row.prepend(g);
    }
  }
  if (onAdd) {
    const addRow = el('div', 'addrow');
    addRow.setAttribute('role', 'button');
    addRow.append(svgIcon('M12 5v14M5 12h14'), document.createTextNode('Agregar producto'));
    if (locked) { addRow.classList.add('off'); addRow.setAttribute('aria-disabled', 'true'); }
    else {
      addRow.tabIndex = 0;
      addRow.addEventListener('click', () => onAdd(group.category.id));
      addRow.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAdd(group.category.id); } });
    }
    detailEl.append(addRow);
  }

  // Extras are priced lines on the same order, so a menu that showed only dishes would be showing a
  // merchant less than their customers can actually buy.
  // `extras` is the source's extras ARRAY, not a {key: price} map. It has to be: an id-keyed merchant's
  // extra key is a slug (`rice_white`), so rendering the key showed a la_musa owner "rice_white" where
  // their customers read "Arroz Blanco". x_pizza hid it entirely — that brand keys extras BY NAME, so
  // key and name are the same string there and the bug was invisible on half the fleet.
  const rows = Array.isArray(extras) ? extras.filter((e) => e && typeof e.key === 'string') : [];
  if (rows.length) {
    const h = el('div', 'dhead');
    h.append(el('div', 'dtitle', 'Opcionales'));
    detailEl.append(h);
    for (const ex of rows) {
      const k = ex.key;
      const row = el('div', 'irow');
      const info = el('div', 'iinfo');
      const nm = (ex.display && typeof ex.display.name === 'string' && ex.display.name.trim()) ? ex.display.name : k;
      info.append(el('div', 'nm', nm));
      row.append(info, priceCell(ex.price, {
        editable, locked, changed: changed('extra', k), onInput: (v) => onPrice('extra', k, v),
        surface: 'extra', key: k,
      }));
      // Item rows give up width to a leading thumb and a trailing chevron; option rows have neither,
      // so without this their price cells sat wider and the column did not line up. An INERT spacer,
      // not an empty chevron: the row is not clickable and must not look as though it is.
      if (editable) { const sp = el('div', 'rowspacer'); sp.setAttribute('aria-hidden', 'true'); row.append(sp); }
      detailEl.append(row);
    }
  }
}
