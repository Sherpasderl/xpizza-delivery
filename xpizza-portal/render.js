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
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;   // textContent, always
  return n;
};

export function renderRail(railEl, groups, selectedId, onSelect) {
  railEl.replaceChildren();
  for (const g of groups) {
    const b = el('button', `railitem${g.category.id === selectedId ? ' on' : ''}`);
    b.type = 'button';
    const t = el('div', 'rtext');
    t.append(el('b', null, g.category.name));
    const c = el('div', 'rcount', String(g.items.length));
    b.append(t, c);
    b.addEventListener('click', () => onSelect(g.category.id));
    railEl.append(b);
  }
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
function priceCell(value, { editable, changed, onInput, surface, key }) {
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
  input.addEventListener('input', () => onInput(input.value));
  cell.append(input);
  return cell;
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
  detailEl.replaceChildren();
  if (!group) {
    const e = el('div', 'empty');
    e.append(el('b', null, 'Este local todavía no tiene menú'), el('span', null, 'Cuando lo configuremos aparecerá acá.'));
    detailEl.append(e);
    return;
  }
  const head = el('div', 'dhead');
  head.append(el('div', 'dtitle', group.category.name));
  detailEl.append(head);

  if (group.items.length === 0) {
    const e = el('div', 'empty');
    e.append(el('b', null, 'Esta sección está vacía'), el('span', null, 'Todavía no hay productos en esta sección.'));
    detailEl.append(e);
  }
  for (const it of group.items) {
    const row = el('div', 'irow');
    const info = el('div', 'iinfo');
    const d = (it && it.display) || {};
    info.append(el('div', 'nmed', typeof d.name === 'string' && d.name.trim() ? d.name : String(it.key || '')));
    if (typeof d.desc === 'string' && d.desc.trim()) info.append(el('div', 'idesc', d.desc));
    // Opening the drawer is a separate affordance from the inline field, so a merchant editing in the
    // row is never one stray click from a modal, and the row itself stays a non-interactive surface.
    if (editable && onOpen) {
      const open = el('button', 'btn ghost', 'Editar');
      open.type = 'button';
      open.setAttribute('aria-label', `Editar ${typeof d.name === 'string' ? d.name : it.key}`);
      open.addEventListener('click', () => onOpen(it.key));
      info.append(open);
    }
    row.append(info, priceCell(it && it.price, {
      editable, changed: changed('item', it.key), onInput: (v) => onPrice('item', it.key, v),
      surface: 'item', key: it.key,
    }));
    detailEl.append(row);
  }

  // Extras are priced lines on the same order, so a menu that showed only dishes would be showing a
  // merchant less than their customers can actually buy.
  const keys = Object.keys(extras || {});
  if (keys.length) {
    const h = el('div', 'dhead');
    h.append(el('div', 'dtitle', 'Opcionales'));
    detailEl.append(h);
    for (const k of keys.sort()) {
      const row = el('div', 'irow');
      const info = el('div', 'iinfo');
      info.append(el('div', 'nmed', k));
      row.append(info, priceCell(extras[k], {
        editable, changed: changed('extra', k), onInput: (v) => onPrice('extra', k, v),
        surface: 'extra', key: k,
      }));
      detailEl.append(row);
    }
  }
}
