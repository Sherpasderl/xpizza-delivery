// PORTAL-UI 1a — S1 «Sucursales» (owner list) and S2 «Detalle de sucursal» (owner from a card; a manager straight to theirs).
// The ONE editable field in 1a is the normal prep time (updateBranch, CAS on identity_version). Everything else is shown
// read-only: name, zone radius (exact), hours, WhatsApp, today's last order number. Copy = the prototype + r5 §2 deltas.
import { updateBranch, updateBranchProfile, setBranchActive, deleteBranchDraft, createBranchDraft } from './api.js';
import * as L from './branch-logic.js';
import * as B from './branch-1b-logic.js';
import { $, el, icon, svg, button, pill, topBlock, errBox, skeleton, emptyState, OFFLINE } from './ops-dom.js';

const SVGNS = 'http://www.w3.org/2000/svg';

export function mountBranches(root, ctx) {
  const V = { det: null, draft: null, saving: false, stale: null, err: null,
    p: null, locked: false, fieldErr: null, modal: null, nv: null, listErr: null };   // 1b (W on): the profile draft, the post-write lock (§3.5), a server field refusal
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
    if (V.listErr) root.append(errBox(V.listErr[0], V.listErr[1]));   // 1b only: a «Nueva sucursal» discarded when W turned off
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
        m('Radio', `${L.kmText(B.appKm(b))} km`),   // ENVÍO v3 §3b: the app's maximum distance
        m('Preparación', L.validPrep(b.editable && b.editable.prep_default_min) ? `${b.editable.prep_default_min} min` : 'Falta'),
        m('Equipos', String(Number.isInteger(b.devices) ? b.devices : 0)),
        m('Último pedido de hoy', L.lastOrderText(b.last_order_today)),
      );
      card.append(head, meta);
      if (L.prepMissing(b)) card.append(callout('Falta el tiempo de preparación normal.', ' Sin él no se puede vincular un equipo.'));
      card.addEventListener('click', () => { V.det = b.rid; V.draft = null; V.p = null; V.fieldErr = null; V.stale = null; V.err = null; V.listErr = null; render(); window.scrollTo && window.scrollTo(0, 0); });
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
    zona.append(mapFor(B.appKm(b)));
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
  // codex 1b r1 #4 (§3.1): Guardar needs EVERY editable value valid — a loaded landline / reversed hours that the draft did not fix
  // keeps it off, even when only another group is dirty. A null phone is «not set», not invalid (the editor shows it empty): the
  // server accepts a prep-only patch on it — planProfilePatch validates only the patched keys (branch-ops.js:116-130, phone :122)
  // and casIdentity writes the merge with no whole-identity check (branch-store.js:588-596). Blocking would deadlock a merchant
  // who never set a WhatsApp (advisor r2 #4).
  const editableErrors = (b) => {
    const ed = b.lifecycle === 'draft' ? { phone: true, hours: true, prep_default_min: true } : B.editorsOf(b);
    const cur = curOf(b);
    const e = {};
    if (ed.phone && typeof cur.phone === 'string' && !B.validPhone(cur.phone)) e.phone = true;
    if (ed.hours && !B.validHours(cur.hours)) e.hours = true;
    if (ed.prep_default_min && !L.validPrep(cur.prep)) e.prep_default_min = true;
    return e;
  };
  const lockedOf = () => V.saving || V.locked || !!V.stale;
  const nameOf = (b) => b.name || (b.profile && b.profile.location_name) || b.rid;

  function renderKeepingFocus(fn) {   // a re-render keeps the focused field (time inputs re-render on change)
    const a = document.activeElement;
    const fid = a && a.id ? a.id : null;
    fn();
    if (fid) { const n = $(fid); if (n && n !== document.activeElement && typeof n.focus === 'function') n.focus(); }
  }
  const lockSvg = () => icon('lock');
  function hintLock(text) { const h = el('span', 'hint'); h.append(lockSvg(), document.createTextNode(text)); return h; }
  function sec1b(title, hint) { const s = el('div', 'sec'); const h = el('h3', null, title); if (hint) h.append(hint); s.append(h); return s; }
  function pillFor(b) { const x = B.pillOf(b, Date.now()); return pill(x.cls, x.label); }   // Borrador / Por activar / Desactivada / 1a's live states

  function renderDetail1b(b) {
    const draft = b.lifecycle === 'draft';   // S10: a draft is listed only to its brand's owner; its editors ride on brand.locations
    const owner = draft || b.role === 'owner';
    const ed = draft ? { phone: true, hours: true, prep_default_min: true } : B.editorsOf(b);
    const locked = lockedOf();
    const cur = curOf(b);
    const patch = patchOf(b);
    const perr = B.patchErrors(patch);
    const frag = [];
    if (isOwner()) frag.push(button('crumb', 'Sucursales', () => { V.det = null; V.draft = null; V.p = null; V.fieldErr = null; setDirty(false); render(); }, { iconName: 'back' }));
    const acts = [];
    if (!draft && L.can(b, 'location.pause')) acts.push(button('btn', 'Pausar pedidos', () => ctx.goto('pausas')));   // §2f T1: 1a's button
    if (!draft && L.can(b, 'device.list')) acts.push(button('btn', `Equipos · ${Number.isInteger(b.devices) ? b.devices : 0}`, () => ctx.goto('equipos', { rid: b.rid })));
    const { top, h } = topBlock(nameOf(b), B.ledeOf(b), acts);
    const p = pillFor(b); p.classList.add('hpill');
    h.append(p);
    frag.push(top);
    if (V.stale) frag.push(errBox('Alguien más cambió esta sucursal.', 'Recargá para ver lo último.', () => { window.location.reload(); }));
    if (V.err) frag.push(errBox(V.err[0], V.err[1], V.errRetry ? () => { window.location.reload(); } : undefined));
    if (!draft && !L.validPrep(cur.prep)) { const c = callout('Falta el tiempo de preparación normal.', ' Sin él no se puede vincular un equipo.'); c.classList.add('dcallout'); frag.push(c); }   // 1a D2

    const grid = el('div', 'grid2');
    if (wantsChecklist(b)) grid.append(readySection(b));   // S8 / S8b / S8c / G3
    grid.append(datos1b(b, owner), draft ? zonaDraft1b() : zona1b(b), horario1b(b, owner, ed, cur, locked, perr));
    const col = el('div', 'dcol');
    col.append(prep1b(b, ed, cur, locked), contacto1b(b, ed, cur, locked, perr));
    if (!draft) col.append(numeracion1b(b));
    col.append(...lifecycleSections(b));
    grid.append(col);
    frag.push(grid);
    root.replaceChildren(...frag);
    paintBar1b(b);
  }

  function datos1b(b, owner) {
    const s = sec1b('Datos', owner ? null : hintLock('El nombre lo cambia el dueño'));
    const f = el('div', 'fld');
    f.append(el('span', 'lab', 'Nombre de la sucursal'), el('div', 'inval inro', nameOf(b)));
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
    if (b.lifecycle === 'draft') {   // S10 (owner v20 field note)
      s.append(roField('Dirección', 'Sherpa la está configurando'), el('span', 'fnote', 'La ubicación, la zona de entrega y la tarifa de envío las define Sherpa. Cuando estén listas, vas a poder activarla acá.'));
    }
    return s;
  }
  function zonaDraft1b() {
    const s = sec1b('Ubicación y zona de entrega', hintLock('Las define Sherpa'));
    const c = el('div', 'callout calloutquiet1b');
    const t = el('div'); t.append(el('b', null, 'Sherpa está configurando la ubicación.'), document.createTextNode(' Cuando esté lista, esta sucursal pasa a «Por activar» y acá vas a ver la dirección y la zona.'));
    c.append(icon('info'), t);
    s.append(c, el('span', 'fnote', 'Si la dirección que le pasaste a Sherpa cambió, escribinos.'));
    return s;
  }
  function zona1b(b) {
    const s = sec1b('Zona de entrega', hintLock('Definida por Sherpa'));
    const radius = B.appKm(b);   // ENVÍO v3 §3b: the app's maximum distance (zone_radius_km stays in the read model for the legacy forms)
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
    i.addEventListener('change', () => { const x = draftFor(b); if (x && B.validPhone(x.phone)) x.phoneRaw = B.phoneDisplay(x.phone); render(); });   // a valid number shows as «+504 NNNN-NNNN» (D-label)
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
    const perr = { ...editableErrors(b), ...B.patchErrors(patch) };
    const labels = B.dirtyLabels1b(patch);
    const dirty = labels.length > 0;
    const edNow = b.lifecycle === 'draft' ? (owned(b.brand_id) ? { phone: true, hours: true, prep_default_min: true } : {}) : B.editorsOf(b);
    const revoked = !W() || Object.keys(patch).some((k) => !edNow[k]);   // codex 1b r2 #1: a cap revoked under an unsaved edit
    setDirty(dirty);
    const invalid = !!(perr.hours || perr.phone || perr.prep_default_min);
    const txt = [document.createTextNode(`Cambios sin guardar en ${nameOf(b)} `)];
    if (perr.hours) txt.push(el('span', null, '· horario · corregí las horas marcadas en rojo para guardar'));
    if (perr.phone) txt.push(el('span', null, `${perr.hours ? ' ' : ''}· contacto · corregí el número marcado en rojo para guardar`));
    if (!invalid) txt.push(el('span', null, `· ${labels.join(', ')}`));
    $('sucbartxt').replaceChildren(...txt);
    const dot = $('sucbar').querySelector('.rb-dot'); if (dot) dot.classList.toggle('rbdoterr1b', invalid);
    $('sucsave').disabled = V.saving || V.locked || invalid || revoked;
    $('sucdiscard').disabled = V.saving;
  }

  async function save1b() {
    const rid = detRid();
    const b = findRow(rid);
    const d = b ? draftFor(b) : null;
    if (!b || !d || V.saving || V.locked) return;
    const patch = B.profilePatch(profileOf(b), d);
    if (!Object.keys(patch).length || Object.keys(B.patchErrors(patch)).length || Object.keys(editableErrors(b)).length) return;
    // codex 1b r1 #1: re-check the CURRENT eligibility right before sending (W, the row's caps, the draft's brand)
    const ed = b.lifecycle === 'draft' ? (owned(b.brand_id) ? { phone: true, hours: true, prep_default_min: true } : {}) : B.editorsOf(b);
    if (!W() || Object.keys(patch).some((k) => !ed[k])) { V.p = null; setDirty(false); V.err = [...B.saveErrorCopy(patch)]; render(); return; }
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
      ctx.toast(`${nameOf(b)} guardada`);
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

  // ══ PORTAL-UI 1b commit (b) — the lifecycle: S2 list + drafts, S7 / S8 / S8b / S8c, S9 Nueva, S10 drafts, s3-legacy ══════════
  const owned = (brandId) => B.ownsBrand(ctx.e1, brandId);
  const draftsHere = () => (ctx.sel && owned(ctx.sel.brand_id) ? B.draftsOf(ctx.e1, ctx.sel.brand_id) : []);
  const findRowAny = (rid) => branches().find((x) => x.rid === rid) || null;
  const findRow = (rid) => branches().find((x) => x.rid === rid) || (W() ? draftsHere().find((x) => x.rid === rid) : null) || null;
  const addTop = () => { const a = el('button', 'btn accent'); a.type = 'button'; a.id = 'suc1b-add'; a.append(svg('M12 5v14M5 12h14'), document.createTextNode('Agregar sucursal')); a.addEventListener('click', () => openNueva('suc1b-add')); return a; };
  const addCard = () => { const a = el('button', 'addcard1b'); a.type = 'button'; a.id = 'suc1b-addcard'; a.append(svg('M12 5v14M5 12h14'), document.createTextNode('Agregar otra sucursal')); a.addEventListener('click', () => openNueva('suc1b-addcard')); return a; };
  const LIST_LEDE = 'Cada sucursal tiene su horario, su tiempo de preparación y sus equipos. La ubicación, la zona de entrega y la tarifa de envío las define Sherpa. El menú y los precios son los mismos para toda la marca.';

  function renderList1b() {
    const sel = ctx.sel;
    const mine = owned(sel.brand_id);
    const rows = [...B.listOrder(branches()), ...draftsHere().slice().sort((a, z) => String(a.profile && a.profile.location_name).localeCompare(String(z.profile && z.profile.location_name), 'es'))];
    const acts = [];
    if (mine) acts.push(addTop());
    const { top } = topBlock('Sucursales', LIST_LEDE, acts);
    const frag = [top];
    if (V.listErr) frag.push(errBox(V.listErr[0], V.listErr[1]));
    if (V.err) frag.push(errBox(V.err[0], V.err[1], V.errRetry ? () => { window.location.reload(); } : undefined));
    if (rows.length) {
      const cards = el('div', 'cards');
      const now = Date.now();
      for (const b of rows) cards.append(card1b(b, now));
      frag.push(cards);
    } else {   // s2-empty (owner-approved copy)
      const e = el('div', 'empty1b');
      e.setAttribute('role', 'status');
      e.append(el('p', 'emptyline1b', `Todavía no hay sucursales en ${sel.brand.name}.`), el('p', 'emptynote1b', 'Agregá la primera. Sherpa configura la ubicación y la zona de entrega.'));
      frag.push(e);
    }
    if (mine && rows.length) frag.push(addCard());
    const q = el('div', 'legend1b');   // B1: the «Abierta / Ocupada / Pausada …» segment is dropped
    q.append(document.createTextNode('Estados: '), el('b', null, 'Desactivada'), document.createTextNode(' no recibe pedidos, la podés activar cuando querás · '),
      el('b', null, 'Por activar'), document.createTextNode(' ya tiene ubicación, falta completarla · '), el('b', null, 'Borrador'), document.createTextNode(' Sherpa está configurando la ubicación.'));
    frag.push(q);
    root.replaceChildren(...frag);
    setDirty(false);
  }
  function card1b(b, now) {
    const m = B.cardModel(b, now);
    const card = el('button', `card clk${m.draft ? ' carddraft1b' : ''}`);
    card.type = 'button';
    card.setAttribute('aria-label', `${m.name} · ${m.pill.label}`);
    const head = el('div', 'chead');
    head.append(el('div', 'ctitle', m.name), pill(m.pill.cls, m.pill.label));
    card.append(head);
    if (m.sub) card.append(el('div', 'csub1b', m.sub));
    const meta = el('div', 'cmeta');
    for (const [label, value] of m.meta) { const s = el('span', null, `${label} `); s.append(el('b', null, value)); meta.append(s); }
    card.append(meta);
    if (m.hint) card.append(hintCallout(m.hint));
    else if (!m.draft && L.prepMissing(b)) card.append(callout('Falta el tiempo de preparación normal.', ' Sin él no se puede vincular un equipo.'));   // 1a D2
    card.addEventListener('click', () => { V.det = b.rid; V.draft = null; V.p = null; V.fieldErr = null; V.stale = null; V.err = null; V.listErr = null; render(); window.scrollTo && window.scrollTo(0, 0); });
    return card;
  }
  function hintCallout(h) {
    const c = el('div', `callout${h.kind === 'ok' ? ' calloutok1b' : h.kind === 'quiet' ? ' calloutquiet1b' : ''}`);
    c.append(h.kind === 'ok' ? icon('check') : h.kind === 'quiet' ? icon('info') : icon('warn'));
    const t = el('div');
    if (h.bold) t.append(el('b', null, h.bold));
    if (h.text) t.append(document.createTextNode(h.bold ? ` ${h.text}` : h.text));
    c.append(t);
    return c;
  }

  // ── S8 / S8b / S8c / G3 (owner, staged or inactive, non-legacy) ──
  function readySection(b) {
    const locked = lockedOf();
    const r = B.readinessRows(b);
    const s = el('div', 'sec secwide1b');
    const h = el('h3', null, 'Antes de activar');
    if (r.kind === 'list') h.append(el('span', 'hint', B.readyCountText(r)));
    s.append(h);
    const act = button('btn accent', `Activar ${b.name}`, () => setActive(b, true));
    act.disabled = locked || !(r.kind === 'list' && r.unmet === 0);
    const row = el('div', 'actrow1b');
    if (r.kind === 'blocked') {   // S8c — the one blocking notice
      const c = el('div', 'callout calloutquiet1b'); c.setAttribute('role', 'status');
      c.append(icon('info'), el('div', null, 'Sherpa está terminando de configurar esta sucursal. Todavía no se puede activar.'));
      s.append(c);
      row.append(act, el('span', 'fnote', 'Se habilita cuando todo esté listo.'));
      s.append(row);
      return s;
    }
    s.append(el('p', 'help', `Para activar ${b.name} tiene que estar todo en orden. Lo que falta se resuelve acá o en el equipo; la ubicación y la zona de entrega las define Sherpa.`));
    if (r.kind === 'list') {
      const list = el('div', 'brows1b');
      for (const x of r.rows) {
        const br = el('div', `brow1b${x.cls === 'warn' ? ' browmiss1b' : x.cls === 'wait' ? ' browwait1b' : ''}`);
        br.append(pill(x.cls === 'ok' ? 'pillok1b' : x.cls === 'wait' ? 'pillwait1b' : 'pillwarn1b', x.state));
        const bt = el('div', 'bt1b');
        bt.append(el('b', null, x.name));
        if (x.sub) bt.append(el('span', null, x.sub));
        br.append(bt);
        list.append(br);
      }
      s.append(list);
      row.append(act, el('span', 'fnote', 'Se habilita cuando todo esté listo. Al activarla empieza a recibir pedidos.'));
    } else row.append(act, el('span', 'fnote', 'Se habilita cuando todo esté listo.'));   // G3: readiness unknown — fail closed
    s.append(row);
    return s;
  }
  function lifecycleSections(b) {   // the right column's last sections (S7 / s3-legacy / S8 Activar / S10)
    const out = [];
    const locked = lockedOf();
    if (b.lifecycle === 'draft') {
      const s = sec1b('Eliminar borrador');
      s.append(el('p', 'help', 'Solo mientras sea borrador. Se borra lo que escribiste y Sherpa no configura su ubicación. Podés crearla de nuevo cuando querás.'));
      const x = button('btn danger', 'Eliminar borrador', () => openModal('delete', b, 'suc1b-del')); x.id = 'suc1b-del'; x.disabled = locked;
      const d = el('div'); d.append(x); s.append(d);
      out.push(s);
      return out;
    }
    if (!owned(b.brand_id)) return out;
    if (b.lifecycle === 'active' && b.legacy === true) { out.push(el('span', 'fnote', 'Para desactivar esta sucursal, escribinos.')); return out; }   // G2
    if (b.legacy === true) return out;
    if (b.lifecycle === 'active') {
      const s = sec1b('Desactivar sucursal');
      s.append(el('p', 'help', 'Deja de recibir pedidos. Sus ventas, su historial y sus equipos se conservan. Es reversible: la activás de nuevo cuando querás.'));
      const x = button('btn danger', `Desactivar ${b.name}`, () => openModal('deactivate', b, 'suc1b-deact')); x.id = 'suc1b-deact'; x.disabled = locked;
      const d = el('div'); d.append(x); s.append(d);
      out.push(s);
    } else if (b.lifecycle === 'inactive' && B.canActivate(b)) {   // s3-inactive
      const s = sec1b('Activar sucursal');
      s.append(el('p', 'help', 'Empieza a recibir pedidos de nuevo. Los pedidos programados se vuelven a revisar automáticamente; algunos pueden necesitar atención del despacho.'));
      const x = button('btn accent', `Activar ${b.name}`, () => setActive(b, true)); x.disabled = locked;
      const d = el('div'); d.append(x); s.append(d);
      out.push(s);
    }
    return out;
  }
  const wantsChecklist = (b) => (b.lifecycle === 'staged' || b.lifecycle === 'inactive') && b.legacy !== true && owned(b.brand_id) && b.role === 'owner'
    && !(b.lifecycle === 'inactive' && B.canActivate(b));

  // ── the confirm modal (S7 Desactivar, S10 Eliminar borrador, S9 Nueva) — opening / Cancelar / Escape / backdrop send NOTHING ──
  const scrim = $('sucscrim');
  const modal = $('sucmodal');
  // codex 1b r1 #5: focus is kept across repaints (restored by element id), Tab is contained in the modal, and closing returns it
  // to the control that opened the modal (by its stable id — the list / detail may have been repainted meanwhile).
  function openModal(kind, b, invokerId) {
    if (V.saving || V.locked) return;
    V.modal = { kind, rid: b ? b.rid : null, invokerId: invokerId || null };
    paintModal();
    scrim.classList.add('show');
    const first = focusables()[0];
    if (first && first.focus) first.focus();
  }
  function closeModal({ discard = false } = {}) {
    const back = V.modal && V.modal.invokerId;
    // codex 1b r2 #2: an UNRESOLVED create survives Cancelar / Escape / backdrop — its frozen body and op_id stay pending, and
    // reopening «Nueva sucursal» shows it locked with the retry. Only a definitive answer (or W / ownership loss) ends it.
    if (!discard && V.nv && V.nv.payload && !V.nv.sending) V.nvPending = V.nv;
    if (discard) V.nvPending = null;
    V.modal = null; V.nv = null; V.nvGo = null;
    ctx.setDirty('suc-new', !!V.nvPending);
    scrim.classList.remove('show'); modal.replaceChildren();
    if (back) { const n = $(back); if (n && typeof n.focus === 'function') n.focus(); }
  }
  // codex 1b r2 #5: if the focused control comes back disabled (prep at the bound, «Crear» sending), focus moves to the nearest
  // enabled control: the opposite stepper button, else the first enabled control, else the modal's close (Cancelar).
  const OPPOSITE = Object.freeze({ 'nv1b-up': 'nv1b-down', 'nv1b-down': 'nv1b-up' });
  function repaintModal(fn) {
    const a = document.activeElement;
    const fid = a && a.id && modal.contains && modal.contains(a) ? a.id : null;
    fn();
    if (!fid) return;
    const usable = (n) => n && !n.disabled && typeof n.focus === 'function';
    const n = $(fid);
    const target = [n, OPPOSITE[fid] ? $(OPPOSITE[fid]) : null, focusables()[0], $('nv1b-cancel'), $('suc1b-mcancel')].find(usable);
    if (target) target.focus();
  }
  const focusables = () => Array.from(modal.querySelectorAll('input, button')).filter((n) => !n.disabled);
  if (scrim) scrim.addEventListener('click', (e) => { if (e.target === scrim && !(V.nv && V.nv.sending)) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (!V.modal) return;
    if (e.key === 'Escape' && !(V.nv && V.nv.sending)) { closeModal(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) { e.preventDefault(); return; }
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
  });
  // codex 1b r1 #1: any eligibility change from a fresh E1 (W, caps, ownership, the row itself) closes an open 1b modal; a filled
  // «Nueva sucursal» is discarded with G4's generic save copy. Called on every render (a fresh E1 always repaints the views).
  function modalEligible() {
    const m = V.modal;
    if (!m || !W()) return !m;
    if (m.kind === 'nueva') return !!(V.nv && ctx.sel && ctx.sel.brand_id === V.nv.brandId && owned(V.nv.brandId));
    const b = findRow(m.rid);
    if (!b || !owned(b.brand_id)) return false;
    if (m.kind === 'deactivate') return b.lifecycle === 'active' && b.legacy !== true;
    return b.lifecycle === 'draft';
  }
  function checkModal() {
    if (!V.modal && V.nvPending && (!W() || !ctx.sel || ctx.sel.brand_id !== V.nvPending.brandId || !owned(V.nvPending.brandId))) {
      V.nvPending = null; ctx.setDirty('suc-new', false); V.listErr = [...B.GENERIC_SAVE_ERR];   // a pending create can no longer be sent
    }
    if (!V.modal || modalEligible()) return;
    const dirty = V.modal.kind === 'nueva' && nvDirty(V.nv);
    const busy = V.nv && V.nv.sending;
    if (busy) return;   // a send in flight settles first; its own refusal path speaks
    closeModal({ discard: true });
    if (dirty) V.listErr = [...B.GENERIC_SAVE_ERR];   // shown above the list (W on or off) until the next navigation
  }
  function paintModal() {
    const m = V.modal;
    if (!m) return;
    if (m.kind === 'nueva') { paintNueva(); return; }
    const b = findRow(m.rid);
    if (!b) { closeModal(); return; }
    modal.classList.add('sm');
    const mh = el('div', 'mh');
    const mb = el('div', 'mb');
    const mf = el('div', 'mf');
    if (m.kind === 'deactivate') {   // S7 text-only (G1, E-a / E-g / E-h / E-j)
      const t = el('div', 'mt', `¿Desactivar ${b.name}?`); t.id = 'suctitle';
      mh.append(t, el('div', 'ms', 'Es reversible: la activás de nuevo cuando querás. Esto es lo que pasa:'));
      const cqs = el('div');
      for (const [bold, text] of [['Pedidos en curso', 'Se terminan de preparar y entregar con normalidad. El equipo y los repartidores los siguen viendo.'],
        ['Pedidos programados', 'Quedan en espera hasta que la actives; no pasan a otra sucursal.'],
        ['Equipos vinculados', 'Siguen vinculados, pero dejan de recibir pedidos nuevos.']]) {
        const cq = el('div', 'cq1b'); const tt = el('div', 'cqt1b'); tt.append(el('b', null, bold), el('span', null, text)); cq.append(tt); cqs.append(cq);
      }
      mb.append(cqs, el('p', 'cqfoot1b', 'Mientras esté desactivada no recibe pedidos. Sus ventas y su historial se conservan.'));
      const c = button('btn ghost', 'Cancelar', closeModal); c.id = 'suc1b-mcancel';
      const go = button('btn danger solid', `Desactivar ${b.name}`, () => setActive(b, false)); go.id = 'suc1b-mgo';
      mf.append(c, go);
    } else {   // S10 Eliminar borrador (D-d)
      const name = (b.profile && b.profile.location_name) || b.rid;
      const t = el('div', 'mt', `¿Eliminar el borrador «${name}»?`); t.id = 'suctitle';
      mh.append(t, el('div', 'ms', 'Todavía no tiene ubicación ni recibió pedidos.'));
      mb.append(el('p', 'mtext1b', 'Se borra lo que escribiste' + ' (nombre, WhatsApp, horario y preparación) y Sherpa deja de configurar su ubicación. No afecta a las demás sucursales. Podés crearla de nuevo cuando querás.'));
      const c = button('btn ghost', 'Cancelar', closeModal); c.id = 'suc1b-mcancel';
      const go = button('btn danger solid', 'Eliminar borrador', () => deleteDraft(b)); go.id = 'suc1b-mgo';
      mf.append(c, go);
    }
    repaintModal(() => modal.replaceChildren(mh, mb, mf));
  }

  // ── S9 «Nueva sucursal» (E6): one op_id per intent, reused on «Reintentar» ──
  function openNueva(invokerId) {
    if (V.saving || V.locked || !W() || !ctx.sel || !owned(ctx.sel.brand_id)) return;
    if (V.nvPending && V.nvPending.brandId === ctx.sel.brand_id) { V.nv = V.nvPending; V.nvPending = null; openModal('nueva', null, invokerId); return; }
    V.nvPending = null;
    // payload: null, or the EXACT body of an unresolved E6 (codex 1b r1 #2) — a retry re-sends it byte for byte under the same
    // op_id and the fields stay read-only; only a DEFINITIVE answer releases it (and a changed form is then a new intent / op_id)
    V.nv = { opId: B.newOpId(), brandId: ctx.sel.brand_id, name: '', phoneRaw: '', phone: '', choice: 0, prep: 20, err: null, nameErr: null, phoneErr: false, sending: false, payload: null };
    openModal('nueva', null, invokerId);
  }
  // codex 1b r1 #3: a filled form is unsaved work — it joins the shell's dirty set (canLeave / the guarded reload)
  const nvDirty = (m) => !!(m && (m.payload || m.name.trim() !== '' || m.phoneRaw.trim() !== '' || m.choice !== 0 || m.prep !== 20));
  const nvFrozen = (m) => !!(m && (m.sending || m.payload));
  function paintNueva() { repaintModal(paintNuevaNow); }
  function paintNuevaNow() {
    const m = V.nv;
    if (!m) return;
    const frozen = nvFrozen(m);
    const choices = B.newHoursChoices(branches());
    modal.classList.remove('sm');
    const mh = el('div', 'mh');
    const t = el('div', 'mt', 'Nueva sucursal'); t.id = 'suctitle';
    mh.append(t, el('div', 'ms', 'Vos ponés el nombre, el WhatsApp, el horario y la preparación. La ubicación y la zona de entrega las configura Sherpa.'));   // D-d
    const mb = el('div', 'mb');
    if (m.err) mb.append(errBox(m.err[0], m.err[1]));
    const fr = el('div', 'frow1b');
    const fn = el('div', 'fld');
    const ln = el('label', null, 'Nombre de la sucursal'); ln.htmlFor = 'nv1b-nombre';
    const iname = el('input'); iname.className = 'nvin1b'; iname.type = 'text'; iname.id = 'nv1b-nombre'; iname.placeholder = 'p. ej. Col. Los Andes'; iname.value = m.name; iname.disabled = frozen; iname.maxLength = B.NAME_MAX + 10;
    const refused = B.nameRefused(m.nameErr, m.name);
    iname.setAttribute('aria-invalid', refused ? 'true' : 'false');
    if (refused) iname.setAttribute('aria-describedby', 'nv1b-nombre-err');
    // the error comes and goes with the refused name; a full repaint only when it flips (focus is kept by repaintModal)
    iname.addEventListener('input', () => { if (nvFrozen(m)) { iname.value = m.name; return; } m.name = iname.value; if (B.nameRefused(m.nameErr, m.name) !== refused) paintNueva(); else paintNuevaGo(); });
    fn.append(ln, iname);
    if (refused) { const e = el('div', 'ferr1b'); e.id = 'nv1b-nombre-err'; e.append(icon('err'), el('span', null, B.NAME_ERR[m.nameErr.code])); fn.append(e); }
    const fp = el('div', 'fld');
    const lp = el('label', null, 'WhatsApp de la sucursal'); lp.htmlFor = 'nv1b-tel';
    const bad = m.phoneErr || (m.phoneRaw.trim() !== '' && !B.validPhone(m.phone) && m.phoneTouched);
    const itel = el('input'); itel.className = `tel1b${bad ? ' telbad1b' : ''}`; itel.type = 'tel'; itel.id = 'nv1b-tel'; itel.placeholder = B.PHONE_PLACEHOLDER; itel.value = m.phoneRaw; itel.disabled = frozen;
    itel.setAttribute('aria-invalid', bad ? 'true' : 'false');
    if (bad) itel.setAttribute('aria-describedby', 'nv1b-tel-err');
    itel.addEventListener('input', () => { if (nvFrozen(m)) { itel.value = m.phoneRaw; return; } m.phoneRaw = itel.value; m.phone = B.normalizePhone(itel.value); m.phoneErr = false; paintNuevaGo(); });
    itel.addEventListener('change', () => { if (nvFrozen(m)) return; m.phoneTouched = true; if (B.validPhone(m.phone)) m.phoneRaw = B.phoneDisplay(m.phone); paintNueva(); });
    fp.append(lp, itel);
    if (bad) { const e = el('div', 'ferr1b'); e.id = 'nv1b-tel-err'; e.append(icon('err'), el('span', null, PHONE_ERR)); fp.append(e); }
    fr.append(fn, fp);
    const fh = el('div', 'fld');
    const chips = el('div', 'chips1b');
    choices.forEach((c, i) => {
      const ch = button(`chip1b${i === m.choice ? ' chipon1b' : ''}`, c.label, () => { if (nvFrozen(m)) return; m.choice = i; paintNueva(); });
      ch.id = `nv1b-chip-${i}`;
      ch.setAttribute('aria-pressed', i === m.choice ? 'true' : 'false'); ch.disabled = frozen;
      chips.append(ch);
    });
    fh.append(el('span', 'lab', 'Horario'), chips, el('span', 'fnote', 'Lo ajustás después, día por día. Mismo día, sin pasar la medianoche.'));
    const fpr = el('div', 'fld');
    const step = el('div', 'step');
    const val = el('div', 'val', String(m.prep)); val.append(el('span', null, 'min')); val.setAttribute('aria-live', 'polite');
    const down = button('stepb', '−', () => { if (nvFrozen(m)) return; m.prep = L.stepPrep(m.prep, -1); paintNueva(); }, { aria: 'Menos 5 minutos' });
    const up = button('stepb', '+', () => { if (nvFrozen(m)) return; m.prep = L.stepPrep(m.prep, +1); paintNueva(); }, { aria: 'Más 5 minutos' });
    down.id = 'nv1b-down'; up.id = 'nv1b-up';
    down.disabled = frozen || m.prep <= L.PREP_MIN; up.disabled = frozen || m.prep >= L.PREP_MAX;
    step.append(down, val, up);
    fpr.append(el('span', 'lab', 'Tiempo de preparación normal'), step, el('span', 'fnote', 'Entre 5 y 120 min. Se puede cambiar después.'));
    const q = el('div', 'callout calloutquiet1b');
    const qt = el('div'); qt.append(document.createTextNode('Queda como '), el('b', null, 'borrador'), document.createTextNode(' hasta que Sherpa configure la ubicación y la zona de entrega. Después vas a poder activarla.'));
    q.append(icon('info'), qt);
    mb.append(fr, fh, fpr, q);
    const mf = el('div', 'mf');
    const go = button('btn accent', 'Crear sucursal', () => createDraft());
    go.id = 'nv1b-go';
    const cancel = button('btn ghost', 'Cancelar', () => { if (!m.sending) closeModal(); }); cancel.id = 'nv1b-cancel';
    mf.append(cancel, go);
    modal.replaceChildren(mh, mb, mf);
    V.nvGo = go;
    paintNuevaGo();
  }
  function paintNuevaGo() {
    const m = V.nv; const go = V.nvGo;
    if (!m || !go) return;
    ctx.setDirty('suc-new', nvDirty(m));
    go.disabled = m.sending || (!m.payload && (!B.validName(B.cleanName(m.name)) || !B.validPhone(m.phone) || B.nameRefused(m.nameErr, m.name)));
  }
  async function createDraft() {
    const m = V.nv;
    if (!m || m.sending || !ctx.sel) return;
    if (!modalEligible()) { checkModal(); render(); return; }   // codex 1b r1 #1: W / ownership re-checked at submit
    if (!m.payload) {   // a NEW intent: the body is fixed now (copied hours captured once) and every retry re-sends exactly it
      const name = B.cleanName(m.name);
      if (!B.validName(name) || !B.validPhone(m.phone) || B.nameRefused(m.nameErr, m.name)) return;
      const choices = B.newHoursChoices(branches());
      m.payload = { opId: m.opId, brandId: m.brandId, locationName: name, phone: m.phone, hours: B.cleanHours((choices[m.choice] || choices[0]).hours), prepDefaultMin: m.prep };
    }
    const gen = ctx.gen();
    m.sending = true; m.err = null;
    ctx.setBusy('suc-new', true);
    paintNueva();
    try {
      const out = await createBranchDraft({ ...m.payload, token: ctx.token });
      m.sending = false;
      ctx.setBusy('suc-new', false);
      if (!ctx.alive(gen)) return;
      closeModal({ discard: true });
      V.det = out && typeof out.rid === 'string' ? out.rid : null;   // S9b: the new draft opens (a replay: that branch, §3.3)
      V.p = null; V.draft = null; V.err = null;
      if (out && out.state === 'draft') ctx.toast('Borrador creado · Sherpa está configurando la ubicación');
      await reconcile(gen);
    } catch (e) {
      m.sending = false;
      ctx.setBusy('suc-new', false);
      if (!ctx.alive(gen) || V.nv !== m) return;
      const code = e && e.code;
      // codex 1b r2 #2: ONLY a 4xx carrying a known code is definitive; a 5xx, a network failure, a timeout, an unknown code (and
      // the server's interrupted / lease_lost, which say the op may still complete) leave the intent unresolved
      const unresolved = code !== 'writes_disabled' && !B.e6Definitive(e);
      if (code === 'writes_disabled') { closeModal({ discard: true }); V.err = [...B.GENERIC_SAVE_ERR]; await reconcile(gen, true); return; }
      if (unresolved) {   // the payload stays frozen: «Crear» re-sends it; focus goes to that retry (codex 1b r2 #5)
        m.err = e && e.kind === 'Unavailable' ? [...OFFLINE] : [...B.GENERIC_SAVE_ERR];
        paintNueva();
        const g = $('nv1b-go'); if (g && !g.disabled && typeof g.focus === 'function') g.focus();
        return;
      }
      else {   // DEFINITIVE: the intent is over — the form is editable again and the next «Crear» is a new intent with a new op_id
        const sent = m.payload;
        m.payload = null; m.opId = B.newOpId();
        if (code === 'bad_phone') m.phoneErr = true;
        else if (B.NAME_ERR[code]) m.nameErr = { code, name: sent.locationName };   // item 6: inline under the name (owner copy)
        else m.err = [...B.GENERIC_SAVE_ERR];   // op_conflict / … — never a silent second draft
      }
      paintNueva();
      if (B.NAME_ERR[code]) { const i = $('nv1b-nombre'); if (i && typeof i.focus === 'function') i.focus(); }   // item 6: to the field to fix
    }
  }

  // ── E8 / E10 ──
  async function setActive(b0, active) {
    if (V.saving || V.locked) return;   // B8: a double tap sends exactly one E8
    const b = findRow(b0.rid);   // codex 1b r1 #1: the CURRENT row (a fresh E1 may have changed it), W and ownership, at submit
    if (!W() || !b || !owned(b.brand_id) || b.legacy === true || !Number.isSafeInteger(b.version) || (active ? b.lifecycle === 'active' : b.lifecycle !== 'active')) { if (V.modal) closeModal(); render(); return; }
    const gen = ctx.gen();
    V.saving = true; V.err = null; V.errRetry = false;
    ctx.setBusy('suc-life', true);
    if (V.modal) closeModal();
    render();
    try {
      await setBranchActive({ rid: b.rid, expectedVersion: b.version, active, token: ctx.token });   // the reply (consequences, projection) is never read
      V.saving = false;
      ctx.setBusy('suc-life', false);
      if (!ctx.alive(gen)) { render(); return; }
      await reconcile(gen);
    } catch (e) { await lifecycleRefusal(e, gen); }
  }
  async function deleteDraft(b0) {
    if (V.saving || V.locked) return;
    const b = findRow(b0.rid);   // codex 1b r1 #1: the current draft row, W and ownership, at submit
    if (!W() || !b || b.lifecycle !== 'draft' || !owned(b.brand_id) || typeof b.version !== 'string') { if (V.modal) closeModal(); render(); return; }
    const gen = ctx.gen();
    V.saving = true; V.err = null; V.errRetry = false;
    ctx.setBusy('suc-life', true);
    closeModal();
    render();
    try {
      await deleteBranchDraft({ rid: b.rid, expectedVersion: b.version, token: ctx.token });
      V.saving = false;
      ctx.setBusy('suc-life', false);
      if (!ctx.alive(gen)) { render(); return; }
      V.det = null; V.p = null;   // back to the list (§3.4 case 4: the brand stays selected)
      await reconcile(gen);
    } catch (e) { await lifecycleRefusal(e, gen); }
  }
  async function lifecycleRefusal(e, gen) {
    V.saving = false;
    ctx.setBusy('suc-life', false);
    if (!ctx.alive(gen)) { render(); return; }
    const code = e && e.code;
    if (code === 'stale_branch') { V.stale = true; V.p = null; setDirty(false); render(); return; }
    if (e && e.kind === 'Unavailable' && code !== 'writes_disabled') { V.err = [...OFFLINE]; render(); return; }
    if (['not_ready', 'legacy_branch', 'not_a_branch', 'not_a_draft'].includes(code)) { await reconcile(gen); return; }   // E1 shows the truth
    V.err = [...B.GENERIC_SAVE_ERR];
    if (['writes_disabled', 'forbidden_field', 'not_authorized'].includes(code)) { await reconcile(gen, true); return; }
    render();
  }

  function render() {
    checkModal();
    if (!W() && V.p) { const pb = findRowAny(V.p.rid); const pp = pb ? B.profilePatch(profileOf(pb), V.p) : {}; V.p = null; if (Object.keys(pp).length) V.err = [...B.saveErrorCopy(pp)]; }
    if (!ctx.sel) { root.replaceChildren(skeleton()); return; }
    const rid = detRid();
    const b = rid ? findRow(rid) : null;
    if (isOwner() && !b) { setDirty(false); if (W()) renderKeepingFocus(renderList1b); else renderList(); return; }
    if (!b) { setDirty(false); root.replaceChildren(emptyState('Todavía no hay sucursales', 'Sherpa te ayuda a agregar la primera.')); return; }
    if (W()) { renderKeepingFocus(() => renderDetail1b(b)); return; }
    renderDetail(b);
  }

  return {
    render,
    show(opts = {}) { if (opts.rid) V.det = opts.rid; render(); },
  };
}
