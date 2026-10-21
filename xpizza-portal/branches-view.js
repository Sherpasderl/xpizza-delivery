// PORTAL-UI 1a — S1 «Sucursales» (owner list) and S2 «Detalle de sucursal» (owner from a card; a manager straight to theirs).
// The ONE editable field in 1a is the normal prep time (updateBranch, CAS on identity_version). Everything else is shown
// read-only: name, zone radius (exact), hours, WhatsApp, today's last order number. Copy = the prototype + r5 §2 deltas.
import { updateBranch } from './api.js';
import * as L from './branch-logic.js';
import { $, el, icon, button, pill, topBlock, errBox, skeleton, emptyState, OFFLINE } from './ops-dom.js';

const SVGNS = 'http://www.w3.org/2000/svg';

export function mountBranches(root, ctx) {
  const V = { det: null, draft: null, saving: false, stale: null, err: null };

  const branches = () => (ctx.sel ? ctx.sel.brand.branches : []);
  const isOwner = () => !!(ctx.sel && ctx.sel.owner);
  const detRid = () => {
    if (!isOwner()) return (ctx.sel && ctx.sel.scope !== 'all') ? ctx.sel.scope : (branches()[0] || {}).rid;
    return V.det;
  };

  function setDirty(on) {
    ctx.setDirty('suc', on);
    const bar = $('sucbar');
    bar.classList.toggle('show', on && !root.classList.contains('hidden'));
  }

  // ── S1 list ──
  function renderList() {
    const list = branches();
    const { top } = topBlock('Sucursales', 'Cada sucursal tiene su zona, su horario, su tiempo de preparación y sus equipos.');
    root.replaceChildren(top);
    if (!list.length) { root.append(emptyState('Todavía no hay sucursales', 'Sherpa te ayuda a agregar la primera.')); return; }
    const cards = el('div', 'cards');
    const now = Date.now();
    for (const b of list) {
      const st = L.stateModel(b, now);
      const card = el('button', 'card clk');
      card.type = 'button';
      card.setAttribute('aria-label', `${b.name} · ${st.label}`);
      const head = el('div', 'chead');
      head.append(el('div', 'ctitle', b.name), pill(st.pillCls, st.label));
      const meta = el('div', 'cmeta');
      const m = (label, value) => { const s = el('span', null, `${label} `); s.append(el('b', null, value)); return s; };
      meta.append(
        m('Radio', `${L.kmText(b.readonly && b.readonly.radius_km)} km`),
        m('Preparación', L.validPrep(b.editable && b.editable.prep_default_min) ? `${b.editable.prep_default_min} min` : 'Falta'),
        m('Equipos', String(Number.isInteger(b.devices) ? b.devices : 0)),
        m('Último pedido de hoy', L.lastOrderText(b.last_order_today)),
      );
      card.append(head, meta);
      if (L.prepMissing(b)) card.append(callout('Falta el tiempo de preparación normal.', ' Sin él no se puede vincular un equipo.'));
      card.addEventListener('click', () => { V.det = b.rid; V.draft = null; V.stale = null; V.err = null; render(); window.scrollTo && window.scrollTo(0, 0); });
      cards.append(card);
    }
    root.append(cards);
  }

  function callout(bold, rest) {
    const c = el('div', 'callout');
    c.append(icon('warn'));
    const t = el('div');
    t.append(el('b', null, bold), document.createTextNode(rest));
    c.append(t);
    return c;
  }
  const lockHint = (text) => { const h = el('span', 'hint'); h.append(icon('lock'), document.createTextNode(text)); return h; };
  const section = (title, hint) => { const s = el('div', 'sec'); const h = el('h3', null, title); if (hint) h.append(lockHint(hint)); s.append(h); return s; };
  const roField = (label, value, note) => {
    const f = el('div', 'fld');
    f.append(el('span', 'lab', label), el('div', 'inval inro', value));
    if (note) f.append(el('span', 'fnote', note));
    return f;
  };

  // ── S2 detail ──
  function renderDetail(b) {
    const now = Date.now();
    const st = L.stateModel(b, now);
    const frag = [];
    if (isOwner()) {
      const crumb = button('crumb', 'Sucursales', () => { if (V.draft && !confirmDiscard()) return; V.det = null; V.draft = null; setDirty(false); render(); }, { iconName: 'back' });
      frag.push(crumb);
    }
    const acts = [];
    if (L.can(b, 'location.pause')) acts.push(button('btn', 'Pausar pedidos', () => ctx.goto('pausas')));
    if (L.can(b, 'device.list')) acts.push(button('btn', `Equipos · ${Number.isInteger(b.devices) ? b.devices : 0}`, () => ctx.goto('equipos', { rid: b.rid })));   // slice 2
    const { top, h } = topBlock(b.name, null, acts);
    const p = pill(st.pillCls, st.label); p.classList.add('hpill');
    h.append(p);
    frag.push(top);
    if (V.stale) frag.push(errBox('Alguien más cambió esta sucursal.', 'Recargá para ver lo último.', () => { window.location.reload(); }));
    if (V.err) frag.push(errBox(V.err[0], V.err[1]));
    if (L.prepMissing(b)) { const c = callout('Falta el tiempo de preparación normal.', ' Sin él no se puede vincular un equipo.'); c.classList.add('dcallout'); frag.push(c); }

    const grid = el('div', 'grid2');
    // Datos
    const datos = section('Datos', 'Solo lectura');
    datos.append(roField('Nombre de la sucursal', b.name));
    // Zona de entrega (schematic; radius exact, read-only)
    const zona = section('Zona de entrega', 'Solo lectura');
    zona.append(mapFor(b.readonly && b.readonly.radius_km));
    // Horario
    const horario = section('Horario por día', 'Solo lectura');
    const hours = el('div', 'hoursro');
    for (const r of L.hoursRows(b.readonly && b.readonly.hours)) {
      const row = el('div', 'hrow');
      row.append(el('span', 'd', r.d));
      if (r.open) row.append(el('span', 'inval inro', r.from), el('span', 'inval inro', r.to));
      else row.append(el('span', 'inval inro inoff', 'Cerrado'));
      hours.append(row);
    }
    horario.append(hours, el('span', 'fnote', 'Fuera de horario no se aceptan pedidos para ya; los programados sí, si caen dentro del horario. Para cambiar el horario, escribinos.'));
    // right column: prep, contacto, numeración
    const col = el('div', 'dcol');
    const prep = section('Tiempo de preparación normal');
    prep.append(el('p', 'help', 'Cuántos minutos tarda un pedido normal en estar listo. Es la base del «listo en N min» que confirma el equipo al aceptar. Obligatorio para vincular un equipo.'));
    const editable = L.can(b, 'location.prep') && Number.isInteger(b.identity_version) && !V.stale;
    const cur = V.draft && Object.prototype.hasOwnProperty.call(V.draft, 'prep_default_min') ? V.draft.prep_default_min : (b.editable ? b.editable.prep_default_min : null);
    const step = el('div', 'step');
    const val = el('div', `val${L.validPrep(cur) ? '' : ' miss'}`, L.prepText(cur));
    if (L.validPrep(cur)) val.append(el('span', null, 'min'));
    val.setAttribute('aria-live', 'polite');
    const down = button('stepb', '−', () => change(b, -1), { aria: 'Menos 5 minutos' });
    const up = button('stepb', '+', () => change(b, +1), { aria: 'Más 5 minutos' });
    down.disabled = !editable || V.saving || (L.validPrep(cur) && cur <= L.PREP_MIN);
    up.disabled = !editable || V.saving || (L.validPrep(cur) && cur >= L.PREP_MAX);
    step.append(down, val, up);
    prep.append(step, el('span', 'fnote', 'Entre 5 y 120 min. El equipo ajusta pedido por pedido.'));
    const contacto = section('Contacto', 'Solo lectura');
    contacto.append(roField('WhatsApp de la sucursal', (b.readonly && b.readonly.phone) || '—', 'Para cambiarlo, escribinos.'));
    const num = section('Numeración de pedidos', 'Solo lectura');
    num.append(roField('Último pedido de hoy', L.lastOrderText(b.last_order_today)), el('span', 'fnote', 'Cada sucursal numera sus pedidos por separado. La numeración la lleva Sherpa.'));
    col.append(prep, contacto, num);
    grid.append(datos, zona, horario, col);
    frag.push(grid);
    root.replaceChildren(...frag);

    // the save bar
    const labels = L.dirtyLabels(b, V.draft);
    setDirty(labels.length > 0);
    $('sucbartxt').replaceChildren(document.createTextNode(`Cambios sin guardar en ${b.name} `), el('span', null, `· ${labels.join(', ')}`));
    $('sucsave').disabled = V.saving;
    $('sucdiscard').disabled = V.saving;
  }

  function mapFor(radius) {
    const wrap = el('div', 'map');
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 320 180');
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', `Mapa con el pin de la sucursal y su radio de entrega de ${L.kmText(radius)} km`);
    const g = (stroke, w, d) => { const e = document.createElementNS(SVGNS, 'path'); e.setAttribute('d', d); e.setAttribute('stroke', stroke); e.setAttribute('stroke-width', String(w)); e.setAttribute('fill', 'none'); return e; };
    s.append(g('#CFD6CC', 1, 'M0 40H320M0 95H320M0 140H320M50 0V180M120 0V180M200 0V180M265 0V180'), g('#B9C3B5', 2.5, 'M0 70 C80 60 140 80 320 65 M160 0 V180'));
    const r = Number.isFinite(radius) ? Math.max(14, Math.min(84, radius * 9)) : 0;   // display scale only — the value shown is exact
    if (r) { const c = document.createElementNS(SVGNS, 'circle'); c.setAttribute('cx', '160'); c.setAttribute('cy', '92'); c.setAttribute('r', String(r)); c.setAttribute('class', 'zone'); s.append(c); }
    const pin = document.createElementNS(SVGNS, 'path'); pin.setAttribute('d', 'M160 72 c-7 0-12 5-12 12 0 9 12 20 12 20s12-11 12-20c0-7-5-12-12-12z'); pin.setAttribute('class', 'pin');
    const dot = document.createElementNS(SVGNS, 'circle'); dot.setAttribute('cx', '160'); dot.setAttribute('cy', '84'); dot.setAttribute('r', '4'); dot.setAttribute('fill', '#fff');
    s.append(pin, dot);
    wrap.append(s, el('span', 'mz', `${L.kmText(radius)} km a la redonda`));
    return wrap;
  }

  function change(b, dir) {
    const cur = V.draft && Object.prototype.hasOwnProperty.call(V.draft, 'prep_default_min') ? V.draft.prep_default_min : (b.editable ? b.editable.prep_default_min : null);
    const next = L.stepPrep(cur, dir);
    V.draft = { prep_default_min: next, base_version: V.draft ? V.draft.base_version : b.identity_version };   // P2-3: the baseline rides with the draft
    if (b.editable && next === b.editable.prep_default_min) V.draft = null;
    render();
  }
  const confirmDiscard = () => true;   // the bar's Descartar is the explicit path; leaving the detail keeps nothing unsaved

  async function save() {
    const rid = detRid();
    const b = branches().find((x) => x.rid === rid);
    if (!b || !V.draft || V.saving) return;
    const gen = ctx.gen();
    V.saving = true; V.err = null;
    ctx.setBusy('suc-save', true);
    render();
    // codex 1a r1 P1-1: the request bookkeeping (saving / busy) is released on EVERY settlement — an obsolete one (an auth
    // change bumped the generation) only skips the UI updates, so a pending guarded reload is never blocked forever.
    // P2-3: the CAS baseline is the version the draft was STARTED on, never a later background refresh's.
    const sent = V.draft;
    try {
      const out = await updateBranch({ rid, expectedVersion: sent.base_version, patch: { prep_default_min: sent.prep_default_min }, token: ctx.token });
      V.saving = false;
      ctx.setBusy('suc-save', false);
      if (V.draft === sent) { V.draft = null; ctx.setDirty('suc', false); }   // written → nothing of it is unsaved any more
      if (!ctx.alive(gen)) { render(); return; }   // codex 1a r2: the bar / stepper reflect the released state
      ctx.patchBranch(rid, { identity_version: out.identity_version, editable: out.editable });
      ctx.toast(`${b.name} guardada`);
    } catch (e) {
      V.saving = false;
      ctx.setBusy('suc-save', false);
      if (!ctx.alive(gen)) { render(); return; }   // codex 1a r2 P1: the kept draft gets usable Guardar / Descartar again
      if (e && e.code === 'stale_branch') { V.stale = true; V.draft = null; setDirty(false); }
      else if (e && e.kind === 'Unavailable') V.err = [...OFFLINE];
      else V.err = ['No se guardó el tiempo de preparación', 'Revisá el valor y volvé a intentar; si sigue igual, escribinos por WhatsApp.'];
      render();
    }
  }
  $('sucsave').addEventListener('click', save);
  $('sucdiscard').addEventListener('click', () => { if (V.saving) return; V.draft = null; setDirty(false); render(); });

  function render() {
    if (!ctx.sel) { root.replaceChildren(skeleton()); return; }
    const rid = detRid();
    const b = rid ? branches().find((x) => x.rid === rid) : null;
    if (isOwner() && !b) { setDirty(false); renderList(); return; }
    if (!b) { setDirty(false); root.replaceChildren(emptyState('Todavía no hay sucursales', 'Sherpa te ayuda a agregar la primera.')); return; }
    renderDetail(b);
  }

  return {
    render,
    show(opts = {}) { if (opts.rid) V.det = opts.rid; render(); },
  };
}
