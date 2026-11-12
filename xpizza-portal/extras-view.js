// STRUCTURE S2 — the «Extras» page's DOM (PLAN-portal-structure-S2-ui r3 §2 items 2–3; MOCKUP-portal-structure-edit frame X). It draws
// extras-logic.js's model and calls back; it never writes the draft (the caller's guarded setters do). createElement + textContent only.
// Names are TEXT in S2-core (no rename control: S2b). Built from the approved classes: .railitem / .rtext / .rcount, .dhead / .dtitle /
// .dcount, .mk-xwarn > .mgshared, .irow.mk-xrow > .iinfo .nm (+ .tag), .price (.chg) > .cur + input, button.del.
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const svg = (paths) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); } return s; };
const TRASH = ['M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6'];
const WARN = ['M12 3l9 16H3z', 'M12 10v4', 'M12 17.5v.01'];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const enProductos = (n) => `en ${plural(n, 'producto', 'productos')}`;

// rail + detail into their hosts; `on`: { select(group), price(id, raw, input), remove(row) }; `canEdit`: the draft is editable now
export function renderExtrasPage(railHost, detailHost, model, on, { canEdit = true } = {}) {
  railHost.replaceChildren();
  for (const r of model.rail) {
    const b = el('button', `railitem${r.group === model.selected ? ' on' : ''}`);
    b.type = 'button';
    b.dataset.group = r.group;
    const t = el('div', 'rtext');
    t.append(el('b', null, r.group), el('span', null, r.reach === null ? '' : enProductos(r.reach)));
    b.append(t, el('div', 'rcount', String(r.count)));
    b.addEventListener('click', () => on.select(r.group));
    railHost.append(b);
  }
  detailHost.replaceChildren();
  const d = model.detail;
  if (!d) return;   // no group yet: nothing drawn (no unapproved copy)
  const head = el('div', 'dhead');
  const countLine = `${plural(d.count, 'extra', 'extras')}${d.reach === null ? '' : ` · ${enProductos(d.reach)}`}`;
  head.append(el('div', 'dtitle', d.group), el('span', 'dcount', countLine));
  detailHost.append(head);
  if (d.shared) {
    const w = el('div', 'mk-xwarn'); const s = el('div', 'mgshared');
    s.append(svg(WARN), el('span', null, `Este grupo se usa en ${plural(d.reach, 'producto', 'productos')} — los cambios aplican a todos.`));
    w.append(s); detailHost.append(w);
  }
  const lastOne = d.rows.filter((x) => !x.removed).length === 1;   // the writer refuses a group's last extra (extras_group_empty)
  for (const r of d.rows) {
    const row = el('div', `irow mk-xrow${r.isNew ? ' mk-added' : ''}${r.removed ? ' mk-xgone' : ''}`);
    const info = el('div', 'iinfo'); const nm = el('div', 'nm');
    nm.append(el('span', null, r.name));
    if (r.isNew) nm.append(el('span', 'tag new mk-ftag', 'Nuevo'));
    else if (r.removed) nm.append(el('span', 'tag mk-ftag', 'Se quita al publicar'));
    else if (r.priceChanged) nm.append(el('span', 'tag mk-ftag', 'Cambios sin publicar'));
    info.append(nm); row.append(info);
    if (r.removed) { row.append(el('div', 'price mk-xgone-p', `L ${r.price}`)); detailHost.append(row); continue; }
    const price = el('div', `price${r.priceChanged ? ' chg' : ''}`);
    const inp = el('input'); inp.type = 'text'; inp.inputMode = 'numeric'; inp.placeholder = 'Sin precio'; inp.value = String(r.price ?? '');
    inp.setAttribute('aria-label', `Precio de ${r.name}`); inp.disabled = !canEdit;
    inp.dataset.k = JSON.stringify(r.id);
    inp.addEventListener('input', () => on.price(r.id, inp.value, inp));
    price.append(el('span', 'cur', 'L'), inp);
    const del = el('button', 'del'); del.type = 'button'; del.setAttribute('aria-label', `Quitar ${r.name}`); del.append(svg(TRASH)); del.disabled = !canEdit || lastOne;
    if (lastOne) del.title = 'Un grupo necesita al menos un extra';   // plan §5.2: prevented, never refused at a press
    del.addEventListener('click', () => on.remove(r, del));
    row.append(price, del);
    detailHost.append(row);
  }
}

// X2 — the remove confirm (frame X2: .modal.sm, «Cancelar» focused / «Quitar» quiet red). Tab stays inside; Escape, «Cancelar» and the
// scrim cancel; focus returns to the trash on cancel. `onConfirm()` writes (the caller's guarded mutator) and closes.
export function openRemoveConfirm({ title, sub, body, onConfirm, returnTo }) {
  const scrim = document.getElementById('xscrim'), modal = scrim.querySelector('.modal');
  const mh = el('div', 'mh'); const t = el('div', 'mt', title); t.id = 'xcf-t'; mh.append(t, el('div', 'ms', sub));
  const mb = el('div', 'mb'); const p = el('p', 'eqbody', body); p.id = 'xcf-d'; mb.append(p);
  const mf = el('div', 'mf');
  const cancel = el('button', 'btn ghost', 'Cancelar'); cancel.type = 'button';
  const go = el('button', 'btn ghost mk-quiet-danger', 'Quitar'); go.type = 'button';
  mf.append(cancel, go);
  modal.replaceChildren(mh, mb, mf);
  const close = (refocus) => {
    scrim.classList.remove('show'); modal.replaceChildren();
    document.removeEventListener('keydown', onKey, true); scrim.removeEventListener('click', onScrim);
    if (refocus && returnTo && returnTo.isConnected) returnTo.focus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (e.key !== 'Tab') return;
    const f = [cancel, go]; const i = f.indexOf(document.activeElement);
    e.preventDefault();
    f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
  };
  const onScrim = (e) => { if (e.target === scrim) close(true); };
  cancel.addEventListener('click', () => close(true));
  go.addEventListener('click', () => { close(false); onConfirm(); });
  document.addEventListener('keydown', onKey, true); scrim.addEventListener('click', onScrim);
  scrim.classList.add('show');
  cancel.focus();
}
