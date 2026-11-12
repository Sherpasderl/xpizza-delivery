// STRUCTURE S2 — the «Extras» page's DOM (PLAN-portal-structure-S2-ui r3 §2 items 2–3; MOCKUP-portal-structure-edit frame X). It draws
// extras-logic.js's model and calls back; it never writes the draft (the caller's guarded setters do). createElement + textContent only.
// Names are TEXT in S2-core (no rename control: S2b). Built from the approved classes: .railitem / .rtext / .rcount, .dhead / .dtitle /
// .dcount, .mk-xwarn > .mgshared, .irow.mk-xrow > .iinfo .nm (+ .tag), .price (.chg) > .cur + input, button.del.
import { dropIndexAt } from './extras-logic.js';
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const svg = (paths) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); } return s; };
const TRASH = ['M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6'];
const PLUS = ['M12 5v14M5 12h14'];
const WARN = ['M12 3l9 16H3z', 'M12 10v4', 'M12 17.5v.01'];
const fieldLine = (id, text) => { const p = el('div', 'ferr mk-ferr', text); p.id = id; p.setAttribute('role', 'alert'); return p; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const enProductos = (n) => `en ${plural(n, 'producto', 'productos')}`;

// rail + detail into their hosts; `on`: { select(group), move(group, ±1, from) / gripToggle / gripClose / drop(group, index) (X4), price(id, raw, input), remove(row), create(btn), and the inline «Agregar extra»
// row's addOpen() / addInput(field, value) → its check / addCommit() / addCancel() / addLeave() }; `canEdit`: the draft is editable now
export function renderExtrasPage(railHost, detailHost, model, on, { canEdit = true } = {}) {
  railHost.replaceChildren();
  // X4b (plan §2 item 8): each row is a .rrow — the select button and the grip are SIBLINGS (no button inside a button), plus the
  // revealed «Subir» / «Bajar» pair of the open row; X4: the grip drags (the lift + ONE green drop line)
  const open = model.open || null;
  model.rail.forEach((r, i) => {
    const rr = el('div', `rrow${open === r.group ? ' mk-open' : ''}`);
    const b = el('button', `railitem${r.group === model.selected ? ' on' : ''}`);
    b.type = 'button';
    b.dataset.group = r.group;
    if (open === r.group) b.classList.add('mk-xopen');
    const t = el('div', 'rtext');
    t.append(el('b', null, r.group), el('span', null, r.reach === null ? '' : enProductos(r.reach)));
    b.append(t, el('div', 'rcount', String(r.count)));
    b.addEventListener('click', () => on.select(r.group));
    rr.append(b);
    if (on.move) {
      const grip = el('button', 'rgrip'); grip.type = 'button'; grip.dataset.grip = r.group; grip.disabled = !canEdit;
      grip.setAttribute('aria-label', `Mover ${r.group}`); grip.setAttribute('aria-expanded', open === r.group ? 'true' : 'false');
      grip.title = 'Arrastrá para ordenar';
      if (open === r.group) grip.classList.add('mk-xopen');
      grip.append(dots());
      const drag = dragOn(grip, rr, r.group, railHost, on);
      grip.addEventListener('click', () => { if (!drag.consumed()) on.gripToggle(r.group); });
      grip.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); on.move(r.group, e.key === 'ArrowUp' ? -1 : 1, 'grip'); }
        else if (e.key === 'Escape' && open === r.group) { e.preventDefault(); e.stopPropagation(); on.gripClose(r.group); }
      });
      rr.append(grip);
      if (open === r.group) {
        const pair = el('div', 'mk-updown'); pair.setAttribute('role', 'group'); pair.setAttribute('aria-label', `Mover ${r.group}`);
        const up = el('button', 'btn', 'Subir'); up.type = 'button'; up.classList.add('ghost', 'sm', 'mk-ud'); up.dataset.k = `x4:up:${r.group}`; up.disabled = !canEdit; endState(up, i === 0);
        const dn = el('button', 'btn', 'Bajar'); dn.type = 'button'; dn.classList.add('ghost', 'sm', 'mk-ud'); dn.dataset.k = `x4:dn:${r.group}`; dn.disabled = !canEdit; endState(dn, i === model.rail.length - 1);
        up.addEventListener('click', () => on.move(r.group, -1, 'up'));
        dn.addEventListener('click', () => on.move(r.group, 1, 'down'));
        pair.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); on.gripClose(r.group); } });
        pair.append(up, dn); rr.append(pair);
      }
    }
    railHost.append(rr);
    if (model.railError && model.railError.group === r.group) railHost.append(fieldLine('x4-err', model.railError.text));
  });
  if (on.create) {   // X3: «Crear grupo» at the rail's foot (frame X)
    const add = el('button', 'railadd'); add.type = 'button'; add.disabled = !canEdit;
    add.append(svg(['M12 5v14M5 12h14']), document.createTextNode('Crear grupo'));
    add.addEventListener('click', () => on.create(add));
    railHost.append(add);
  }
  detailHost.replaceChildren();
  const d = model.detail;
  if (!d) return;   // no group yet: nothing drawn (no unapproved copy)
  const head = el('div', 'dhead');
  const countLine = `${plural(d.count, 'extra', 'extras')}${d.reach === null ? '' : ` · ${enProductos(d.reach)}`}`;
  head.append(el('div', 'dtitle', d.group), el('span', 'dcount', countLine));
  if (on.addOpen) {   // «Agregar extra» (frame X: .dright > .btn)
    const right = el('span', 'dright'); const addEx = el('button', 'btn'); addEx.type = 'button'; addEx.disabled = !canEdit;
    addEx.append(svg(PLUS), document.createTextNode('Agregar extra'));
    addEx.addEventListener('click', () => on.addOpen());
    right.append(addEx); head.append(right);
  }
  detailHost.append(head);
  if (d.shared) {
    const w = el('div', 'mk-xwarn'); const s = el('div', 'mgshared');
    s.append(svg(WARN), el('span', null, `Este grupo se usa en ${plural(d.reach, 'producto', 'productos')} — los cambios aplican a todos.`));
    w.append(s); detailHost.append(w);
  }
  const lastOne = d.rows.filter((x) => !x.removed).length === 1;   // the writer refuses a group's last extra (extras_group_empty)
  d.rows.forEach((r, i) => {
    const row = el('div', `irow mk-xrow${r.isNew ? ' mk-added' : ''}${r.removed ? ' mk-xgone' : ''}`);
    const info = el('div', 'iinfo'); const nm = el('div', 'nm');
    // a KEYLESS row (no key yet: never saved): the inline row's own name field (advisor 11-12). A row the save keyed stays «Nuevo»
    // until it is published, but its name is text — setExtraName writes keyless rows only (Codex S2 UI r1 P2-7)
    const keyless = !!r.id && typeof r.id.key !== 'string';
    let ni = null;
    if (keyless && !r.removed && on.name) {
      ni = el('input', 'mk-xname'); ni.type = 'text'; ni.value = r.name; ni.placeholder = 'Nombre del extra'; ni.setAttribute('aria-label', 'Nombre del extra');
      ni.disabled = !canEdit; ni.dataset.k = `xnm:${JSON.stringify(r.id)}`;
      ni.addEventListener('input', () => on.name(r.id, ni.value, ni));
      ni.addEventListener('blur', () => { if (ni.value !== ni.value.trim()) on.name(r.id, ni.value.trim(), ni); });
      nm.append(ni);
    } else nm.append(el('span', null, r.name));
    if (r.isNew) nm.append(el('span', 'tag new mk-ftag', 'Nuevo'));
    else if (r.removed) nm.append(el('span', 'tag mk-ftag', 'Se quita al publicar'));
    else if (r.priceChanged) nm.append(el('span', 'tag mk-ftag', 'Cambios sin publicar'));
    info.append(nm); row.append(info);
    if (r.removed) { row.append(el('div', 'price mk-xgone-p', `L ${r.price}`)); detailHost.append(row); return; }
    const price = el('div', `price${r.priceChanged ? ' chg' : ''}`);
    const held = typeof model.heldPrice === 'function' ? model.heldPrice(r.id, r.price) : null;   // P2-8: what was typed, kept
    const inp = el('input'); inp.type = 'text'; inp.inputMode = 'numeric'; inp.placeholder = 'Sin precio'; inp.value = held ? held.raw : String(r.price ?? '');
    inp.setAttribute('aria-label', `Precio de ${r.name}`); inp.disabled = !canEdit;
    inp.dataset.k = JSON.stringify(r.id);
    inp.addEventListener('input', () => on.price(r.id, inp.value, inp));
    price.append(el('span', 'cur', 'L'), inp);
    const del = el('button', 'del'); del.type = 'button'; del.setAttribute('aria-label', `Quitar ${r.name}`); del.append(svg(TRASH)); del.disabled = !canEdit || lastOne;
    if (lastOne) del.title = 'Un grupo necesita al menos un extra';   // plan §5.2: prevented, never refused at a press
    del.addEventListener('click', () => on.remove(r, del));
    row.append(price, del);
    detailHost.append(row);
    // a line under the row: the server's line FIX-EXTRA brought here (about the name: the name field, else the price), a held price's
    // line (the price field), or a «Nuevo» row left without a name (its name field). Codex S2 UI r1 P2-13: the field it is about names it
    // (aria-describedby, by the row's place: stable across a repaint and a P-6 adoption)
    const own = model.rowError && JSON.stringify(model.rowError.id) === JSON.stringify(r.id);
    const [line, field] = own ? [model.rowError.text, ni || inp]
      : held && held.line ? [held.line, inp]
        : (keyless && !String(r.name).trim() ? ['Escribí el nombre.', ni] : [null, null]);
    if (line) {
      const lid = `xrow-e-${i}`; const ln = fieldLine(lid, line); ln.classList.add('mk-xrowline'); detailHost.append(ln);
      if (field) field.setAttribute('aria-describedby', lid);
    }
  });
  if (model.adding) renderAddRow(detailHost, model.adding, on);
}

// X4b at an end (advisor 2026-11-12, plan §2.8 «focus stays on the pressed button»): «Subir» at the top / «Bajar» at the bottom are
// aria-disabled — still focusable, so focus never jumps; they look exactly as disabled; a press goes to the ONE boundary rule
// (extras-logic moveGroupOrder → null), which writes nothing
function endState(btn, atEnd) { if (atEnd) { btn.setAttribute('aria-disabled', 'true'); btn.classList.add('mk-udend'); } }
// the grip's six dots (MOCKUP x4b)
function dots() {
  const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  for (const cx of [9, 15]) for (const cy of [6, 12, 18]) { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', '1.6'); s.append(c); }
  return s;
}
// X4 the drag on a grip: a mouse / pen drags after 4px of travel; a touch after a long press (450 ms, the phone's grip is always
// shown); the dragged group lifts (.mk-drag, the grip .mk-gripon), ONE .mk-dropline marks where it lands; the drop → on.drop(group,
// index among the others). A drag is not a click: the click that follows it is consumed.
function dragOn(grip, rr, g, railHost, on) {
  let st = null, eat = false;
  const mid = (n) => { const b = n.getBoundingClientRect(); return b.top + b.height / 2; };
  const others = () => [...railHost.querySelectorAll('.rrow')].filter((x) => x !== rr);
  const begin = () => { st.live = true; rr.querySelector('.railitem').classList.add('mk-drag'); grip.classList.add('mk-gripon'); };
  const end = (commit) => {
    if (!st) return;
    clearTimeout(st.timer);
    const s = st; st = null;
    const ln = railHost.querySelector('.mk-dropline'); if (ln) ln.remove();
    rr.querySelector('.railitem').classList.remove('mk-drag'); grip.classList.remove('mk-gripon');
    if (!s.live) return;
    eat = true; setTimeout(() => { eat = false; }, 0);
    if (commit && s.idx !== undefined) on.drop(g, s.idx);
  };
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || grip.disabled) return;
    st = { y0: e.clientY, live: false, touch: e.pointerType === 'touch', timer: null };
    if (st.touch) st.timer = setTimeout(() => { if (st) begin(); }, 450);
    if (typeof grip.setPointerCapture === 'function' && e.pointerId !== undefined) { try { grip.setPointerCapture(e.pointerId); } catch (_) { /* not capturable */ } }
  });
  grip.addEventListener('pointermove', (e) => {
    if (!st) return;
    if (!st.live) {
      if (st.touch) { if (Math.abs(e.clientY - st.y0) > 8) { clearTimeout(st.timer); st = null; } return; }   // a scroll, not a press
      if (Math.abs(e.clientY - st.y0) < 4) return;
      begin();
    }
    e.preventDefault();
    const os = others(); const idx = dropIndexAt(os.map(mid), e.clientY);
    let ln = railHost.querySelector('.mk-dropline');
    if (!ln) { ln = el('div', 'mk-dropline'); ln.setAttribute('aria-hidden', 'true'); ln.append(el('span', 'mk-dropdot')); }
    railHost.insertBefore(ln, idx < os.length ? os[idx] : railHost.querySelector('.railadd'));
    st.idx = idx;
  });
  grip.addEventListener('pointerup', () => end(true));
  grip.addEventListener('pointercancel', () => end(false));
  return { consumed: () => eat };
}

// the inline new row (plan §2 item 3: the ONLY name input in S2-core): the committed row's shell (.irow.mk-xrow.mk-added) with X3's row
// copy — «Nombre del extra», «Precio», «Quitar …» and R6's two lines (extras-logic extraRowCheck). Enter commits a complete row, Escape
// or the trash drops it, focus leaving the row commits it when complete (§3.5)
function renderAddRow(host, a, on) {
  const row = el('div', 'irow mk-xrow mk-added mk-xnew');
  const info = el('div', 'iinfo'); const nm = el('div', 'nm');
  const ni = el('input', 'mk-xname'); ni.type = 'text'; ni.value = a.name; ni.placeholder = 'Nombre del extra'; ni.setAttribute('aria-label', 'Nombre del extra'); ni.dataset.k = 'xadd:n';
  nm.append(ni); info.append(nm);
  const price = el('div', 'price'); const pi = el('input'); pi.type = 'text'; pi.inputMode = 'numeric'; pi.placeholder = 'Sin precio'; pi.value = a.raw;
  pi.setAttribute('aria-label', 'Precio'); pi.dataset.k = 'xadd:p';
  price.append(el('span', 'cur', 'L'), pi);
  const del = el('button', 'del'); del.type = 'button'; del.append(svg(TRASH));
  row.append(info, price, del);
  const lines = el('div', 'mk-xnewlines');
  const paintLines = (c) => {
    lines.replaceChildren(); ni.removeAttribute('aria-describedby'); pi.removeAttribute('aria-describedby');
    del.setAttribute('aria-label', `Quitar ${ni.value.trim() || 'extra'}`);
    if (c.nameError) { lines.append(fieldLine('xadd-ne', c.nameError)); ni.setAttribute('aria-describedby', 'xadd-ne'); }
    if (c.priceError) { lines.append(fieldLine('xadd-pe', c.priceError)); pi.setAttribute('aria-describedby', 'xadd-pe'); }
    if (c.error) lines.append(fieldLine('xadd-err', c.error));
  };
  paintLines(a.check);
  ni.addEventListener('input', () => paintLines(on.addInput('name', ni.value)));
  pi.addEventListener('input', () => paintLines(on.addInput('raw', pi.value)));
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); on.addCommit(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); on.addCancel(); }
  };
  ni.addEventListener('keydown', onKey); pi.addEventListener('keydown', onKey);
  del.addEventListener('click', () => on.addCancel());
  row.addEventListener('focusout', () => setTimeout(() => { if (row.isConnected && !row.contains(document.activeElement)) on.addLeave(); }, 0));
  host.append(row, lines);
}

// the ONE confirm open on #xscrim (X2, the discard confirm, X2b) — its close, so an ended world (the auth boundary) can drop it
// with NO continuation and no refocus
let xscrimClose = null;
export function closeXConfirm() { const c = xscrimClose; xscrimClose = null; if (c) c(); }
// A small confirm on #xscrim (.modal.sm): X2 «¿Quitar …?» and the discard confirm. Tab stays inside; Escape and the backdrop take the
// cancel path; the cancel path returns focus to `returnTo`. `buttons`: [{ label, mods (classes on top of .btn), act: 'cancel' | 'go', focus }] in DOM order.
function openSmallConfirm(o) {
  const { title, sub = null, body = null, buttons, returnTo = null } = o;
  const scrim = document.getElementById('xscrim'), modal = scrim.querySelector('.modal');
  const mh = el('div', 'mh'); const t = el('div', 'mt', title); t.id = 'xcf-t'; mh.append(t); if (sub) mh.append(el('div', 'ms', sub));
  const parts = [mh];
  if (body) { const mb = el('div', 'mb'); const p = el('p', 'eqbody', body); p.id = 'xcf-d'; mb.append(p); parts.push(mb); }
  const mf = el('div', 'mf');
  parts.push(mf);
  const focusables = [];
  let first = null;
  const close = (refocus) => {
    xscrimClose = null;
    scrim.classList.remove('show'); modal.replaceChildren();
    document.removeEventListener('keydown', onKey, true); scrim.removeEventListener('click', onScrim);
    if (refocus && returnTo && returnTo.isConnected) returnTo.focus();
  };
  const cancel = () => { close(true); if (o.onCancel) o.onCancel(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return; }
    if (e.key !== 'Tab') return;
    const i = focusables.indexOf(document.activeElement);
    e.preventDefault();
    focusables[(i + (e.shiftKey ? focusables.length - 1 : 1)) % focusables.length].focus();
  };
  const onScrim = (e) => { if (e.target === scrim) cancel(); };
  for (const spec of buttons) {
    const btnEl = el('button', 'btn', spec.label); btnEl.type = 'button'; btnEl.classList.add(...spec.mods);
    btnEl.addEventListener('click', () => { if (spec.act === 'go') { close(false); o.onGo(); } else cancel(); });
    mf.append(btnEl); focusables.push(btnEl);
    if (spec.focus && !first) first = btnEl;
  }
  modal.replaceChildren(...parts);
  document.addEventListener('keydown', onKey, true); scrim.addEventListener('click', onScrim);
  xscrimClose = () => close(false);
  scrim.classList.add('show');
  (first || focusables[0]).focus();
}
// X2 — the remove confirm (frame X2: «Cancelar» focused / «Quitar» quiet red); focus returns to the trash on cancel
export function openRemoveConfirm({ title, sub, body, onConfirm, returnTo }) {
  openSmallConfirm({ title, sub, body, returnTo, onGo: onConfirm,
    buttons: [{ label: 'Cancelar', mods: ['ghost'], act: 'cancel', focus: true }, { label: 'Quitar', mods: ['ghost', 'mk-quiet-danger'], act: 'go' }] });
}
// the portal's discard confirm, reused (the drawer's title, buttons and order; its product sentence does not apply to a new group)
export function openDiscardConfirm({ onDiscard, onKeep, returnTo }) {
  openSmallConfirm({ title: '¿Descartar los cambios?', returnTo, onGo: onDiscard, onCancel: onKeep,
    buttons: [{ label: 'Descartar', mods: ['ghost', 'mk-quiet-danger'], act: 'go' }, { label: 'Seguir editando', mods: ['accent'], act: 'cancel', focus: true }] });
}

// ── X3 «Crear grupo» + X3b (MOCKUP x4b) — the sheet's DOM, from extras-logic.js createGroupView. `on`: { name(v), row(i, patch),
// addRow(), removeRow(i), mode(m), cat(c), mark(key, on), markAll(cat), markNone(cat), cancel(), create() }. The caller re-renders
// on every change and restores focus by data-k.
export function renderCreateGroup(modal, v, on) {
  const mh = el('div', 'mh'); const t = el('div', 'mt', 'Crear grupo'); t.id = 'xcg-t';
  mh.append(t, el('div', 'ms', 'Un grupo de extras · después podés agregarlo a los productos que quieras'));
  const mb = el('div', 'mb mk-form');
  const ex = el('div', 'gexplain'); ex.append(el('b', null, 'Extras · opcionales.'), document.createTextNode(' El cliente marca los que quiera, cada uno una vez. Se cobra el precio de cada extra.'));
  mb.append(ex);
  // the name
  const fN = el('div', 'fld'); const lr = el('div', 'mk-lrow');
  const lab = el('label', null, 'Nombre del grupo'); lab.htmlFor = 'xcg-name';
  const cnt = el('span', 'mk-cnt', v.counter); cnt.setAttribute('aria-live', 'polite');
  lr.append(lab, cnt);
  const nm = el('input', 'mgname-in'); nm.id = 'xcg-name'; nm.type = 'text'; nm.value = v.name; nm.placeholder = 'Ej. Salsas, Ingredientes extra'; nm.dataset.k = 'xcg:name';
  nm.addEventListener('input', () => on.name(nm.value));
  fN.append(lr, nm);
  if (v.nameError) { fN.append(fieldLine('xcg-name-e', v.nameError)); nm.setAttribute('aria-describedby', 'xcg-name-e'); }
  mb.append(fN);
  // the extras
  const fX = el('div', 'fld'); const lx = el('div', 'mk-lrow'); lx.append(el('label', null, 'Extras'), el('span', 'mk-cnt', 'nombre y precio'));
  const grp = el('div', 'mk-mgroup');
  v.rows.forEach((r, i) => {
    const row = el('div', 'mopt');
    const n = el('input', 'moname'); n.type = 'text'; n.value = r.name; n.placeholder = 'Nombre del extra'; n.setAttribute('aria-label', 'Nombre del extra'); n.dataset.k = `xcg:n:${r.ref}`;
    n.addEventListener('input', () => on.row(i, { name: n.value }));
    const pr = el('span', 'mopr'); const pi = el('input'); pi.type = 'text'; pi.inputMode = 'numeric'; pi.value = r.raw; pi.setAttribute('aria-label', 'Precio'); pi.dataset.k = `xcg:p:${r.ref}`;
    pi.addEventListener('input', () => on.row(i, { raw: pi.value }));
    pr.append(el('span', 'mc', 'L'), pi);
    const rm = el('button', 'model'); rm.type = 'button'; rm.setAttribute('aria-label', `Quitar ${r.name || 'extra'}`); rm.append(svg(TRASH)); rm.disabled = v.rows.length === 1;
    rm.addEventListener('click', () => on.removeRow(i));
    row.append(n, pr, rm);
    grp.append(row);
    if (r.nameError) { const id = `xcg-ne-${i}`; grp.append(fieldLine(id, r.nameError)); n.setAttribute('aria-describedby', id); }
    if (r.priceError) { const id = `xcg-pe-${i}`; grp.append(fieldLine(id, r.priceError)); pi.setAttribute('aria-describedby', id); }
  });
  const add = el('button', 'mgadd'); add.type = 'button'; add.append(svg(PLUS), document.createTextNode('Agregar extra'));
  add.addEventListener('click', () => on.addRow());
  fX.append(lx, grp, add); mb.append(fX);
  // «Agregarlo a»
  const fA = el('div', 'fld'); fA.append(el('label', null, 'Agregarlo a'));
  const radios = el('div', 'mk-radio'); radios.setAttribute('role', 'radiogroup'); radios.setAttribute('aria-label', 'Agregarlo a');
  const radio = (mode, text, sub) => {
    const l = el('label'); const i = el('input'); i.type = 'radio'; i.name = 'xcg-to'; i.checked = v.mode === mode; i.dataset.k = `xcg:m:${mode}`;
    i.addEventListener('change', () => { if (i.checked) on.mode(mode); });
    // rule 16b (SBS 11-12, 390 px): the label and its grey line are ONE text block, so they wrap together under the radio (as two flex
    // items they split into two cramped columns)
    const tx = el('b', 'mk-rtext', text); if (sub) tx.append(document.createTextNode(' '), el('span', null, sub));
    l.append(i, tx);
    return l;
  };
  radios.append(radio('none', 'Todavía a ninguno', '· lo agregás desde cada producto'), radio('cat', 'A toda una categoría'));
  if (v.mode === 'cat') {
    const sel = el('select', 'mk-sel'); sel.setAttribute('aria-label', 'Categoría'); sel.dataset.k = 'xcg:cat';
    for (const o of v.categories) { const op = el('option', null, o.label); op.value = o.cat; op.disabled = o.disabled; op.selected = v.cat === o.cat; sel.append(op); }
    sel.addEventListener('change', () => on.cat(sel.value));
    radios.append(sel);
    if (v.catNote) radios.append(el('div', 'mk-catnote', v.catNote));
  }
  radios.append(radio('items', 'A productos que elija', v.mode === 'items' ? v.modeSub : '· marcás cuáles'));
  if (v.mode === 'items') {
    const pick = el('div', 'mk-pick'); pick.setAttribute('role', 'group'); pick.setAttribute('aria-label', 'Productos');
    for (const sec of v.sections) {
      const h = el('div', 'mk-subh'); h.append(el('span', 'mk-sn', sec.name), el('span', 'mk-n', sec.count));
      if (sec.link) {
        const ln = el('button', 'mk-lnk', sec.link); ln.type = 'button'; ln.setAttribute('aria-label', `${sec.link} en ${sec.name}`); ln.dataset.k = `xcg:lnk:${sec.cat}`;
        ln.addEventListener('click', () => (sec.link === 'Ninguno' ? on.markNone(sec.cat) : on.markAll(sec.cat)));
        h.append(ln);
      }
      pick.append(h);
      sec.rows.forEach((r, i) => {
        const l = el('label', `modopt${r.disabled ? ' mk-dis' : ''}`);
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = r.checked; cb.disabled = r.disabled; cb.dataset.k = `xcg:p:${r.key}`;
        const nmS = el('span', 'mognm', r.name);
        if (r.sub) nmS.append(el('span', 'mogsub', r.sub));
        if (r.disabled && r.reason) { const id = `xcg-why-${sec.cat}-${i}`; const w = el('span', 'mk-why', r.reason); w.id = id; nmS.append(w); cb.setAttribute('aria-describedby', id); }
        cb.addEventListener('change', () => on.mark(r.key, cb.checked));
        l.append(cb, nmS); pick.append(l);
      });
    }
    radios.append(pick);
  }
  fA.append(radios); mb.append(fA);
  if (v.formError) mb.append(fieldLine('xcg-err', v.formError));   // a writer refusal the form could not foresee (plan §5.2)
  const mf = el('div', 'mf');
  const cancel = el('button', 'btn ghost', 'Cancelar'); cancel.type = 'button'; cancel.addEventListener('click', () => on.cancel());
  const go = el('button', 'btn accent', 'Crear grupo'); go.type = 'button'; go.disabled = !v.canCreate; go.addEventListener('click', () => on.create());
  mf.append(cancel, go);
  modal.replaceChildren(mh, mb, mf);
  return { first: nm, cancel, go };
}

// B «Agregar grupo de extras» (plan r3 §2 item 6; MOCKUP frame B) — the sheet on the review modal's .modal/.mh/.mb/.mf: one .optrow per
// EXISTING group (checkbox, the name with its extras joined «·» under it, «en N productos»); the dish's own checked + inert with «Ya está en
// este producto»; «¿No está el grupo? Crealo en Extras»; «Cancelar» / «Agregar N grupo(s)» (off at 0). `v`: { dish, rows: [{ group,
// extras, reach, have, checked }] }; `on`: { toggle(group, on), cancel(), add(), create() }. Returns the first control to focus.
export function renderAttachSheet(modal, v, on) {
  const mh = el('div', 'mh'); const t = el('div', 'mt', 'Agregar grupo de extras'); t.id = 'xat-t';
  mh.append(t, el('div', 'ms', `Para ${v.dish} · elegí los grupos que ya tenés`));
  const mb = el('div', 'mb mscroll mk-form'); const list = el('div');
  list.append(el('div', 'attach-note', 'Grupos de extras existentes'));
  let first = null;
  for (const r of v.rows) {
    const row = el('label', `optrow${r.have ? ' have' : ''}${r.checked && !r.have ? ' sel' : ''}`);
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = r.have || r.checked; cb.disabled = r.have; cb.dataset.k = `xat:${r.group}`;
    cb.addEventListener('change', () => on.toggle(r.group, cb.checked));
    const nm = el('span', 'ogname', r.group); const og = el('span', 'ogsub');
    // rule 16b: the extras line wraps between extras, never inside a name (the « ·» stays at the end of its part)
    if (r.have) og.textContent = 'Ya está en este producto';
    else { const parts = r.extras.split(' · '); parts.forEach((p, i) => { if (i) og.append(document.createTextNode(' ')); og.append(el('span', 'mk-seg', i < parts.length - 1 ? `${p} ·` : p)); }); }
    nm.append(og);
    row.append(cb, nm, el('span', 'mk-ogn', r.reach === null ? '' : `${enProductos(r.reach)}${r.section ? ` · ${r.section}` : ''}`));
    list.append(row);
    if (!r.have && !first) first = cb;
  }
  const none = el('p', 'mk-nogroup', '¿No está el grupo?');
  const crear = el('button', 'mk-lnk', 'Crealo en Extras'); crear.type = 'button'; crear.dataset.k = 'xat:crear';
  crear.addEventListener('click', () => on.create());
  none.append(crear);
  mb.append(list, none);
  const mf = el('div', 'mf');
  const n = v.rows.filter((r) => r.checked && !r.have).length;
  const cancel = el('button', 'btn ghost', 'Cancelar'); cancel.type = 'button'; cancel.dataset.k = 'xat:cancel';
  cancel.addEventListener('click', () => on.cancel());
  // advisor 11-12: at 0 the button is off and reads «Agregar grupos» — never «Agregar 0 grupos»
  const add = el('button', 'btn accent', n === 0 ? 'Agregar grupos' : `Agregar ${n} ${n === 1 ? 'grupo' : 'grupos'}`); add.type = 'button'; add.disabled = n === 0; add.dataset.k = 'xat:add';
  add.addEventListener('click', () => on.add());
  mf.append(cancel, add);
  modal.replaceChildren(mh, mb, mf);
  return { first: first || crear };
}

// X2b — REVIEW-DELETIONS (frame X2b; plan §5.2): «El menú publicado cambió» · «Antes de seguir, confirmá lo que se quita:» · one .brow per id
// («Quitado» · the extra · its group; an id no row carries: «Un extra que ya no está en el menú») · «Cancelar» / «Confirmar y seguir» (focused).
// `line`: a line under the list (the re-read failed: «Confirmar y seguir» stays off). The small modal of X2 (#xscrim).
export function openDeletionsReview({ rows, line = null, onGo, onCancel, returnTo = null }) {
  const scrim = document.getElementById('xscrim'), modal = scrim.querySelector('.modal');
  const mh = el('div', 'mh'); const t = el('div', 'mt', 'El menú publicado cambió'); t.id = 'xcf-t'; mh.append(t);
  const mb = el('div', 'mb'); const p = el('p', 'eqbody', 'Antes de seguir, confirmá lo que se quita:'); p.id = 'xcf-d';
  const list = el('div', 'mk-dels');
  for (const r of rows) {
    const row = el('div', `brow rem${r.gone ? ' gone' : ''}`);
    row.append(el('span', 'bchip rem', 'Quitado'), el('span', 'bnm', r.name));
    if (r.group) row.append(el('span', 'bsec', r.group));
    list.append(row);
  }
  mb.append(p, list);
  if (line) mb.append(fieldLine('xcf-line', line));
  const mf = el('div', 'mf');
  const cancelBtn = el('button', 'btn', 'Cancelar'); cancelBtn.type = 'button'; cancelBtn.classList.add('ghost');
  const goBtn = el('button', 'btn', 'Confirmar y seguir'); goBtn.type = 'button'; goBtn.classList.add('accent'); goBtn.disabled = !!line;
  mf.append(cancelBtn, goBtn);
  modal.replaceChildren(mh, mb, mf);
  const focusables = () => [cancelBtn, goBtn].filter((b) => !b.disabled);
  const close = () => { xscrimClose = null; scrim.classList.remove('show'); modal.replaceChildren(); document.removeEventListener('keydown', onKey, true); scrim.removeEventListener('click', onScrim); };
  const cancel = () => { close(); if (returnTo && returnTo.isConnected) returnTo.focus(); onCancel(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables(); const i = f.indexOf(document.activeElement);
    e.preventDefault(); f[(i + (e.shiftKey ? f.length - 1 : 1) + f.length) % f.length].focus();
  };
  const onScrim = (e) => { if (e.target === scrim) cancel(); };
  cancelBtn.addEventListener('click', cancel);
  goBtn.addEventListener('click', () => { close(); onGo(); });
  document.addEventListener('keydown', onKey, true); scrim.addEventListener('click', onScrim);
  xscrimClose = close;
  scrim.classList.add('show');
  (goBtn.disabled ? cancelBtn : goBtn).focus();
}
