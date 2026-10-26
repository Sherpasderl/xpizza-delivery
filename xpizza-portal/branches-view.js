// PORTAL-UI 1a — S1 «Sucursales» (owner list) and S2 «Detalle de sucursal» (owner from a card; a manager straight to theirs).
// The ONE editable field in 1a is the normal prep time (updateBranch, CAS on identity_version). Everything else is shown
// read-only: name, zone radius (exact), hours, WhatsApp, today's last order number. Copy = the prototype + r5 §2 deltas.
import { updateBranch, updateBranchProfile } from './api.js';
import * as L from './branch-logic.js';
import * as B from './branch-1b-logic.js';
import { $, el, icon, button, pill, topBlock, errBox, skeleton, emptyState, OFFLINE } from './ops-dom.js';

const SVGNS = 'http://www.w3.org/2000/svg';

export function mountBranches(root, ctx) {
  const V = { det: null, draft: null, saving: false, stale: null, err: null,
    p: null, locked: false, fieldErr: null };   // 1b (W on): the profile draft, the post-write lock (§3.5), a server field refusal
  const W = () => B.writesOn(ctx.e1);

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
      card.addEventListener('click', () => { V.det = b.rid; V.draft = null; V.p = null; V.fieldErr = null; V.stale = null; V.err = null; render(); window.scrollTo && window.scrollTo(0, 0); });
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
    if (W()) { await save1b(); return; }   // 1b: ONE E7 per save (§3.3); W off → exactly 1a below
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
  $('sucdiscard').addEventListener('click', () => { if (V.saving) return; V.draft = null; V.p = null; V.fieldErr = null; setDirty(false); render(); });

  // ══ PORTAL-UI 1b (W on) — the v2 detail (S3–S5, S11; PLAN r4 §2b–§2f) ══════════════════════════════════════════════════════
  // Build target = v2 + the 2026-10-25 / 2026-10-26 deltas, with the §2f truth reconciliation (1a's D-strings win). The profile
  // edits ride ONE E7 (single writer); the token is E1's `version`, echoed opaque; after a write E1 is re-read (§3.5).
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const profileOf = (b) => (isObj(b.profile) ? b.profile : {});
  const draftFor = (b) => (V.p && V.p.rid === b.rid ? V.p : null);
  const startDraft = (b) => { if (!draftFor(b)) V.p = { rid: b.rid, base: b.version }; return V.p; };   // the CAS baseline = the version the draft STARTED on
  const curOf = (b) => {
    const pr = profileOf(b), d = draftFor(b);
    return { phone: has(d, 'phone') ? d.phone : pr.phone, hours: has(d, 'hours') ? d.hours : pr.hours, prep: has(d, 'prep_default_min') ? d.prep_default_min : pr.prep_default_min };
  };
  const patchOf = (b) => { const d = draftFor(b); return d ? B.profilePatch(profileOf(b), d) : {}; };
  const lockedOf = () => V.saving || V.locked || !!V.stale;

  function renderKeepingFocus(fn) {   // a re-render keeps the focused field (time inputs re-render on change)
    const a = document.activeElement;
    const fid = a && a.id ? a.id : null;
    fn();
    if (fid) { const n = $(fid); if (n && n !== document.activeElement && typeof n.focus === 'function') n.focus(); }
  }
  const lockSvg = () => icon('lock');
  function hintLock(text) { const h = el('span', 'hint'); h.append(lockSvg(), document.createTextNode(text)); return h; }
  function sec1b(title, hint) { const s = el('div', 'sec'); const h = el('h3', null, title); if (hint) h.append(hint); s.append(h); return s; }
  function pillFor(b) {
    if (b.lifecycle === 'staged') return pill('pillstaged1b', 'Por activar');
    if (b.lifecycle === 'inactive') return pill('pillinactive1b', 'Desactivada');
    const st = L.stateModel(b, Date.now());
    return pill(st.pillCls, st.label);
  }

  function renderDetail1b(b) {
    const owner = b.role === 'owner';
    const ed = B.editorsOf(b);
    const locked = lockedOf();
    const cur = curOf(b);
    const patch = patchOf(b);
    const perr = B.patchErrors(patch);
    const frag = [];
    if (isOwner()) frag.push(button('crumb', 'Sucursales', () => { V.det = null; V.draft = null; V.p = null; V.fieldErr = null; setDirty(false); render(); }, { iconName: 'back' }));
    const acts = [];
    if (L.can(b, 'location.pause')) acts.push(button('btn', 'Pausar pedidos', () => ctx.goto('pausas')));   // §2f T1: 1a's button
    if (L.can(b, 'device.list')) acts.push(button('btn', `Equipos · ${Number.isInteger(b.devices) ? b.devices : 0}`, () => ctx.goto('equipos', { rid: b.rid })));
    const { top, h } = topBlock(b.name, B.ledeOf(b), acts);
    const p = pillFor(b); p.classList.add('hpill');
    h.append(p);
    frag.push(top);
    if (V.stale) frag.push(errBox('Alguien más cambió esta sucursal.', 'Recargá para ver lo último.', () => { window.location.reload(); }));
    if (V.err) frag.push(errBox(V.err[0], V.err[1], V.errRetry ? () => { window.location.reload(); } : undefined));
    if (!L.validPrep(cur.prep)) { const c = callout('Falta el tiempo de preparación normal.', ' Sin él no se puede vincular un equipo.'); c.classList.add('dcallout'); frag.push(c); }   // 1a D2

    const grid = el('div', 'grid2');
    grid.append(datos1b(b, owner), zona1b(b), horario1b(b, owner, ed, cur, locked, perr));
    const col = el('div', 'dcol');
    col.append(prep1b(b, ed, cur, locked), contacto1b(b, ed, cur, locked, perr), numeracion1b(b));
    grid.append(col);
    frag.push(grid);
    root.replaceChildren(...frag);
    paintBar1b(b);
  }

  function datos1b(b, owner) {
    const s = sec1b('Datos', owner ? null : hintLock('El nombre lo cambia el dueño'));
    const f = el('div', 'fld');
    f.append(el('span', 'lab', 'Nombre de la sucursal'), el('div', 'inval inro', b.name));
    if (owner) f.append(el('span', 'fnote', 'Para cambiar el nombre, escribinos.'));   // D-a
    s.append(f);
    const loc = isObj(b.location) ? b.location : null;
    if (loc && typeof loc.address_line === 'string') {
      s.append(roField('Dirección', loc.address_line), roField('Referencia para repartidores', typeof loc.address_reference === 'string' && loc.address_reference ? loc.address_reference : '—'));
      const n = el('span', 'fnote');
      const l = el('span', 'lock1b'); l.append(lockSvg(), document.createTextNode('Definida por Sherpa.'));
      n.append(l, document.createTextNode(' Para cambiar la ubicación, escribinos.'));
      s.append(n);
    }
    return s;
  }
  function zona1b(b) {
    const s = sec1b('Zona de entrega', hintLock('Definida por Sherpa'));
    const radius = isObj(b.location) && Number.isFinite(b.location.zone_radius_km) ? b.location.zone_radius_km : (b.readonly && b.readonly.radius_km);
    const m = mapFor(radius);
    const svgEl = m.querySelector('svg'); if (svgEl) svgEl.setAttribute('aria-label', 'Mapa con el pin de la sucursal y su zona de entrega, solo lectura');
    const badge = el('span', 'sherpa1b'); badge.append(lockSvg(), document.createTextNode('Solo lectura'));
    m.append(badge);
    const n = el('span', 'fnote');
    n.append(document.createTextNode('Ubicación, zona de entrega y tarifa de envío: '), el('b', null, 'definidas por Sherpa'), document.createTextNode('.'));   // §2f T4
    s.append(m, n);
    return s;
  }
  const HOURS_NOTE = 'Fuera de horario la sucursal no recibe pedidos para ahora. Los pedidos programados sí se aceptan si caen dentro del horario. Los 7 días tienen que estar definidos, aunque sea «Cerrado».';   // E-b′
  function horario1b(b, owner, ed, cur, locked, perr) {
    if (!ed.hours) {   // a role without location.hours: 1a's read-only rows
      const s = section('Horario por día', 'Solo lectura');
      const hours = el('div', 'hoursro');
      for (const r of L.hoursRows(cur.hours)) {
        const row = el('div', 'hrow');
        row.append(el('span', 'd', r.d));
        if (r.open) row.append(el('span', 'inval inro', r.from), el('span', 'inval inro', r.to));
        else row.append(el('span', 'inval inro inoff', 'Cerrado'));
        hours.append(row);
      }
      s.append(hours, el('span', 'fnote', HOURS_NOTE));
      return s;
    }
    const hint = el('span', 'hint', 'Mismo día · sin pasar la medianoche');
    const s = sec1b('Horario por día', hint);
    const wrap = el('div', 'hours1b');
    const loaded = profileOf(b).hours;
    for (const r of B.hoursEditRows(cur.hours)) {
      const row = el('div', 'hrow1b');
      row.append(el('span', 'hday1b', r.d));
      if (r.state === 'open') {
        for (const [side, val, aria] of [['start', r.from, `${r.d}, abre`], ['end', r.to, `${r.d}, cierra`]]) {
          const i = el('input');
          i.className = `htime1b${r.err ? ' htimebad1b' : ''}`; i.type = 'text'; i.inputMode = 'numeric'; i.id = `h1b-${r.key}-${side}`; i.value = val; i.disabled = locked;
          i.setAttribute('aria-label', aria);
          if (r.err) i.setAttribute('aria-invalid', 'true');
          i.addEventListener('change', () => { const d = startDraft(b); d.hours = B.editDay(curOf(b).hours, loaded, r.key, { [side]: B.normalizeTime(i.value) }); V.fieldErr = null; render(); });
          row.append(i);
        }
      } else if (r.state === 'closed') row.append(el('span', 'hoff1b', 'Cerrado'));
      else row.append(el('span', 'hoff1b hmiss1b', 'Sin definir'));
      const on = r.state === 'open';
      const t = el('button', `tog${on ? '' : ' off'}`);
      t.type = 'button'; t.disabled = locked;
      t.setAttribute('aria-label', `Abre el ${r.d}`);
      t.setAttribute('aria-pressed', on ? 'true' : 'false');
      t.append(el('i'));
      t.addEventListener('click', () => { const d = startDraft(b); d.hours = B.editDay(curOf(b).hours, loaded, r.key, { open: !on }); V.fieldErr = null; render(); });
      row.append(t);
      if (r.err === 'order') {
        const e = el('div', 'herr1b'); e.append(icon('err'), el('span', null, 'La hora de cierre tiene que ser después de la de apertura, el mismo día.'));
        row.append(e);
      }
      wrap.append(row);
    }
    s.append(wrap);
    if (owner) {   // §2f T6: fills the draft only; Guardar still required; never a request
      const srcs = [...B.copySources(ctx.sel ? ctx.sel.brand.branches : [], b.rid).map((x) => ({ label: x.label, hours: x.hours, q: false })), { label: B.PRESET_LABEL, hours: B.PRESET_HOURS, q: true }];
      const f = el('div', 'fld');
      const chips = el('div', 'chips1b');
      for (const c of srcs) {
        const ch = button(`chip1b${c.q ? ' chipq1b' : ''}`, c.label, () => { const d = startDraft(b); d.hours = B.cleanHours(c.hours); V.fieldErr = null; render(); });
        ch.disabled = locked;
        chips.append(ch);
      }
      f.append(el('span', 'lab', 'Copiar horario de'), chips);
      s.append(f);
    }
    s.append(el('span', 'fnote', HOURS_NOTE));
    return s;
  }
  function prep1b(b, ed, cur, locked) {
    const s = section('Tiempo de preparación normal');
    s.append(el('p', 'help', 'Cuántos minutos tarda un pedido normal en estar listo. Es la base del «listo en N min» que confirma el equipo al aceptar. Obligatorio para vincular un equipo.'));   // 1a D3
    const step = el('div', 'step');
    const val = el('div', `val${L.validPrep(cur.prep) ? '' : ' miss'}`, L.prepText(L.validPrep(cur.prep) ? cur.prep : null));
    if (L.validPrep(cur.prep)) val.append(el('span', null, 'min'));
    val.setAttribute('aria-live', 'polite');
    const go = (dir) => { const d = startDraft(b); d.prep_default_min = L.stepPrep(L.validPrep(curOf(b).prep) ? curOf(b).prep : null, dir); V.fieldErr = null; render(); };
    const down = button('stepb', '−', () => go(-1), { aria: 'Menos 5 minutos' });
    const up = button('stepb', '+', () => go(+1), { aria: 'Más 5 minutos' });
    down.disabled = !ed.prep_default_min || locked || (L.validPrep(cur.prep) && cur.prep <= L.PREP_MIN);
    up.disabled = !ed.prep_default_min || locked || (L.validPrep(cur.prep) && cur.prep >= L.PREP_MAX);
    step.append(down, val, up);
    s.append(step, el('span', 'fnote', 'Entre 5 y 120 min. El equipo ajusta pedido por pedido.'));   // 1a D3
    return s;
  }
  const PHONE_NOTE = 'Desde este número el equipo llama o escribe al cliente mientras el pedido está activo. Lo pueden cambiar el dueño y el gerente.';
  const PHONE_ERR = 'Escribí un número de celular de Honduras con WhatsApp, de 8 dígitos.';   // D-b
  function contacto1b(b, ed, cur, locked, perr) {
    if (!ed.phone) {
      const s = section('Contacto', 'Solo lectura');
      s.append(roField('WhatsApp de la sucursal', B.phoneDisplay(cur.phone) || '—', 'Para cambiarlo, escribinos.'));
      return s;
    }
    const s = sec1b('Contacto');
    const d = draftFor(b);
    // invalid = a drafted invalid number, a LOADED invalid string (never silently rewritten, §3.1), or the server's bad_phone
    const bad = !!(perr.phone || (!has(d, 'phone') && typeof cur.phone === 'string' && !B.validPhone(cur.phone)) || (V.fieldErr && V.fieldErr.phone));
    const f = el('div', 'fld');
    const lab = el('label', null, 'WhatsApp de la sucursal'); lab.htmlFor = 'f1b-tel';
    const i = el('input');
    i.className = `tel1b${bad ? ' telbad1b' : ''}`; i.type = 'tel'; i.id = 'f1b-tel'; i.autocomplete = 'off'; i.placeholder = B.PHONE_PLACEHOLDER; i.disabled = locked;
    i.value = d && typeof d.phoneRaw === 'string' ? d.phoneRaw : B.phoneDisplay(cur.phone);
    i.setAttribute('aria-invalid', bad ? 'true' : 'false');
    i.setAttribute('aria-describedby', bad ? 'f1b-tel-err f1b-tel-note' : 'f1b-tel-note');
    i.addEventListener('input', () => { const x = startDraft(b); x.phoneRaw = i.value; x.phone = B.normalizePhone(i.value); V.fieldErr = null; paintBar1b(b); });
    i.addEventListener('change', () => { render(); });
    f.append(lab, i);
    if (bad) { const e = el('div', 'ferr1b'); e.id = 'f1b-tel-err'; e.append(icon('err'), el('span', null, PHONE_ERR)); f.append(e); }
    const n = el('span', 'fnote', PHONE_NOTE); n.id = 'f1b-tel-note';
    f.append(n);
    s.append(f);
    return s;
  }
  function numeracion1b(b) {   // §2f T3: 1a D12, verbatim
    const s = section('Numeración de pedidos', 'Solo lectura');
    s.append(roField('Último pedido de hoy', L.lastOrderText(b.last_order_today)), el('span', 'fnote', 'Cada sucursal numera sus pedidos por separado. La numeración la lleva Sherpa.'));
    return s;
  }

  // the «Cambios sin guardar» bar (S6 + D-c): labels, or the drawn fix-it line per invalid group; Guardar off while invalid
  function paintBar1b(b) {
    const patch = patchOf(b);
    const perr = B.patchErrors(patch);
    const labels = B.dirtyLabels1b(patch);
    const dirty = labels.length > 0;
    setDirty(dirty);
    const invalid = !!(perr.hours || perr.phone || perr.prep_default_min);
    const txt = [document.createTextNode(`Cambios sin guardar en ${b.name} `)];
    if (perr.hours) txt.push(el('span', null, '· horario · corregí las horas marcadas en rojo para guardar'));
    if (perr.phone) txt.push(el('span', null, `${perr.hours ? ' ' : ''}· contacto · corregí el número marcado en rojo para guardar`));
    if (!invalid) txt.push(el('span', null, `· ${labels.join(', ')}`));
    $('sucbartxt').replaceChildren(...txt);
    const dot = $('sucbar').querySelector('.rb-dot'); if (dot) dot.classList.toggle('rbdoterr1b', invalid);
    $('sucsave').disabled = V.saving || V.locked || invalid;
    $('sucdiscard').disabled = V.saving;
  }

  async function save1b() {
    const rid = detRid();
    const b = branches().find((x) => x.rid === rid);
    const d = b ? draftFor(b) : null;
    if (!b || !d || V.saving || V.locked) return;
    const patch = B.profilePatch(profileOf(b), d);
    if (!Object.keys(patch).length || Object.keys(B.patchErrors(patch)).length) return;
    const gen = ctx.gen();
    V.saving = true; V.err = null; V.errRetry = false; V.fieldErr = null;
    ctx.setBusy('suc-save', true);
    render();
    const sent = d;
    try {
      const out = await updateBranchProfile({ rid, expectedVersion: sent.base, patch, token: ctx.token });
      V.saving = false;
      ctx.setBusy('suc-save', false);
      if (V.p === sent) { V.p = null; ctx.setDirty('suc', false); }
      if (!ctx.alive(gen)) { render(); return; }
      if (out && out.noop === true) { render(); return; }   // nothing written: no toast, the token is unchanged
      ctx.toast(`${b.name} guardada`);
      await reconcile(gen);
    } catch (e) {
      V.saving = false;
      ctx.setBusy('suc-save', false);
      if (!ctx.alive(gen)) { render(); return; }
      const code = e && e.code;
      if (code === 'stale_branch') { V.stale = true; V.p = null; setDirty(false); render(); return; }   // the body is never read for values
      if (e && e.kind === 'Unavailable' && code !== 'writes_disabled') { V.err = [...OFFLINE]; render(); return; }
      if (code === 'bad_phone') { V.fieldErr = { phone: true }; render(); return; }
      if (code === 'bad_prep') { V.err = [...B.PREP_SAVE_ERR]; render(); return; }
      V.err = [...B.saveErrorCopy(patch)];
      if (code === 'writes_disabled') { V.p = null; setDirty(false); await reconcile(gen, true); return; }   // never retried as E2
      if (['forbidden_field', 'not_authorized', 'not_a_branch', 'not_a_draft'].includes(code)) { await reconcile(gen, true); return; }
      render();
    }
  }
  // §3.5: after a write (or a refusal that says the screen is out of date) E1 is re-read; every 1b control stays locked until
  // the refresh is APPLIED. A failed refresh keeps them locked behind 1a's OFFLINE box (Reintentar = reload).
  async function reconcile(gen, keepErr = false) {
    V.locked = true;
    render();
    const r = await ctx.refresh();
    if (!ctx.alive(gen) || r === 'obsolete' || r === 'reload') return;
    if (r === 'applied') { V.locked = false; if (!keepErr) V.err = null; render(); return; }
    V.err = [...OFFLINE]; V.errRetry = true;
    render();
  }

  function render() {
    if (!ctx.sel) { root.replaceChildren(skeleton()); return; }
    const rid = detRid();
    const b = rid ? branches().find((x) => x.rid === rid) : null;
    if (isOwner() && !b) { setDirty(false); renderList(); return; }
    if (!b) { setDirty(false); root.replaceChildren(emptyState('Todavía no hay sucursales', 'Sherpa te ayuda a agregar la primera.')); return; }
    if (W()) { renderKeepingFocus(() => renderDetail1b(b)); return; }
    renderDetail(b);
  }

  return {
    render,
    show(opts = {}) { if (opts.rid) V.det = opts.rid; render(); },
  };
}
