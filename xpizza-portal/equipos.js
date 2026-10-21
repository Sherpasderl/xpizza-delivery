// PORTAL-UI slice 2 (PLAN-portal-ui-slice2-equipos r1.1) — S5 «Equipos»: the linked handhelds of the page's selection, their
// last contact, «Cómo vincular un equipo» (pairing happens ON THE DEVICE), and «Desvincular». The list is fetched on every
// entry and on «Actualizar» (no live ticking: status is relative to the reply's fetched_at). A revoke goes through E7, which
// — owner ruling (b) — also pauses a 'handheld' branch left with no device; the server decides, the toast says what happened.
// Copy: the prototype's §6 + the owner-approved deltas E-D1–E-D16. Brand-agnostic: every name comes from the data.
import { getBranchDevices, revokeBranchDevice, setBranchPause } from './api.js';
import * as L from './branch-logic.js';
import { $, el, icon, button, pill, topBlock, errBox, skeleton, emptyState, OFFLINE } from './ops-dom.js';

const RETRY_DETAIL = 'Volvé a intentar; si sigue igual, escribinos por WhatsApp.';

export function mountEquipos(root, ctx) {
  const V = { data: null, loading: false, err: null, seq: 0, howto: null, only: null, modal: null, busy: false, panel: null };
  const scrim = $('devscrim');
  const modal = $('devmodal');

  const branchOf = (rid) => (ctx.sel ? ctx.sel.brand.branches.find((b) => b.rid === rid) : null);
  const nameOf = (rid) => { const b = branchOf(rid); return b ? b.name : rid; };
  const infoOf = (rid) => { const b = branchOf(rid); return { name: b ? b.name : rid, prep: b && b.editable ? b.editable.prep_default_min : null }; };
  const listable = () => L.scopeBranches(ctx.sel).filter((b) => L.can(b, 'device.list') && (!V.only || b.rid === V.only));
  const rows = () => {
    const rids = new Set(listable().map((b) => b.rid));
    return ((V.data && V.data.branches) || []).filter((b) => rids.has(b.rid));
  };

  async function load() {
    const list = listable();
    if (!list.length) { V.data = null; render(); return; }
    const seq = ++V.seq;
    const gen = ctx.gen();
    V.loading = true; V.err = null;
    render();
    try {
      const out = list.length > 1
        ? await getBranchDevices({ brandId: ctx.sel.brand_id, token: ctx.token })
        : await getBranchDevices({ rid: list[0].rid, token: ctx.token });
      if (seq !== V.seq || !ctx.alive(gen)) return;   // a newer fetch (or another session) owns the screen
      V.data = out;
    } catch (e) {
      if (seq !== V.seq || !ctx.alive(gen)) return;
      V.err = e;
    }
    V.loading = false;
    render();
  }

  // ── render ──
  function render() {
    if (!ctx.sel || root.classList.contains('hidden')) return;
    const { top } = topBlock('Equipos', 'Los handheld que reciben los pedidos. Cada equipo pertenece a una sola sucursal; una sucursal puede tener varios.',
      [button('btn', 'Cómo vincular un equipo', () => { V.howto = !howtoOpen(); render(); }, { iconName: 'info' })]);
    const frag = [top];
    if (V.panel) frag.push(V.panel);
    if (!V.data) {
      frag.push(V.err ? failBox(V.err) : skeleton());
      root.replaceChildren(...frag);
      return;
    }
    const branches = rows();
    for (const b of branches) {
      if (b.error || b.prep_ok) continue;
      const c = el('div', 'callout');
      c.append(icon('warn'));
      const t = el('div');
      t.append(el('b', null, `${nameOf(b.rid)} no puede vincular equipos todavía.`), document.createTextNode(' Falta su tiempo de preparación normal.'));
      c.append(t);
      const br = branchOf(b.rid);
      if (L.can(br, 'location.prep')) c.append(button('btn sm', 'Definirlo', () => ctx.goto('suc', { rid: b.rid })));
      frag.push(c);
    }
    if (howtoOpen()) frag.push(howto(branches));
    for (const b of branches) if (b.error) frag.push(errBox(`No pudimos cargar los equipos de ${nameOf(b.rid)}`, OFFLINE[1], load));
    // a failed REFRESH is said above the list it could not replace, with its retry (codex build r1 P2)
    if (V.err) frag.push(failBox(V.err));
    const devices = branches.filter((b) => !b.error).flatMap((b) => b.devices.map((d) => ({ ...d, rid: b.rid })))
      .sort((a, z) => (z.last_seen || 0) - (a.last_seen || 0));
    if (devices.length) frag.push(table(devices));
    else if (!branches.some((b) => b.error)) {
      const one = V.only || (ctx.sel.scope !== 'all' ? ctx.sel.scope : null);
      const wrap = el('div', 'eqtbl');
      wrap.append(listHead(0));                       // «Actualizar» + the fetch time stay reachable with no device
      frag.push(wrap, emptyState(`Ningún equipo vinculado${one ? ` en ${nameOf(one)}` : ''}`, 'Seguí los pasos de «Cómo vincular un equipo».'));
    }
    root.replaceChildren(...frag);
  }
  const failBox = (e) => (e.kind === 'NotAuthorized'
    ? errBox('No tenés acceso a estos equipos', 'Si esperabas verlos, pedile acceso al dueño.', load)
    : errBox(OFFLINE[0], OFFLINE[1], load));
  const howtoOpen = () => (V.howto === null ? !rows().some((b) => !b.error && b.devices.length) : V.howto);

  function howto(branches) {
    const grid = el('div', 'grid2 eqhow');
    const a = el('div', 'sec');
    a.append(el('h3', null, 'Cómo vincular un equipo'), el('p', 'help', 'Se hace en el equipo, no acá. El portal solo muestra los equipos vinculados y permite desvincularlos.'));
    const steps = el('ol', 'eqsteps');
    for (const s of [
      'Encendé el handheld y abrí la app de Sherpa.',
      'Ingresá con tu cuenta de dueño o de gerente de esa sucursal. Es una sola vez: el equipo queda vinculado y el personal nunca inicia sesión.',
      'Elegí la sucursal. Solo aparecen las tuyas, y solo las que ya tienen tiempo de preparación.',
      'Creá el PIN de 4 dígitos del gerente.',
      'Listo. El equipo aparece en esta lista y empieza a recibir pedidos de esa sucursal.',
    ]) steps.append(el('li', null, s));
    a.append(steps);
    const b = el('div', 'sec');
    b.append(el('h3', null, 'Antes de vincular'));
    const checks = L.pairChecks(branches, V.data && V.data.pairing_enabled, infoOf);
    if (checks.off) b.append(el('p', 'help', 'La vinculación de equipos todavía no está habilitada en Sherpa.'));
    for (const r of checks.rows) {
      const row = el('div', 'brow');
      const bt = el('div', 'bt');
      bt.append(el('b', null, r.name), el('span', null, r.sub));
      row.append(pill(r.ready ? 'open' : 'eqwarn', r.state), bt);
      b.append(row);
    }
    b.append(el('span', 'fnote', 'Un equipo vinculado a una sucursal se comporta como un restaurante de una sola sucursal: solo ve sus pedidos, su Ocupado, su Pausa y sus agotados.'));
    grid.append(a, b);
    return grid;
  }

  function listHead(n) {
    const head = el('div', 'dhead');
    const right = el('div', 'dright');
    right.append(el('span', 'eqat', `Actualizado ${L.hhmm(V.data.fetched_at)}`), pill('off', L.countText(n)), button('btn sm', 'Actualizar', load));
    head.append(el('div', 'dtitle', 'Equipos vinculados'), right);
    return head;
  }
  function table(devices) {
    const wrap = el('div', 'eqtbl');
    wrap.append(listHead(devices.length));
    const sc = el('div', 'eqsc');
    const t = el('table');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['Equipo', 'Sucursal', 'Último contacto', 'Estado', '']) hr.append(el('th', null, h));
    thead.append(hr);
    const tb = el('tbody');
    for (const d of devices) {
      const st = L.STATUS[L.onlineState(V.data.fetched_at, d.last_seen)];
      const tr = el('tr');
      const c1 = el('td');
      c1.append(el('b', null, L.deviceLabel(d)), el('span', 'eqsub', L.pairedText(d)));
      const c5 = el('td');
      if (L.can(branchOf(d.rid), 'device.revoke')) {
        const go = button('btn sm danger', 'Desvincular', () => openModal(d));
        go.disabled = V.busy;
        c5.append(go);
      }
      const c4 = el('td');
      c4.append(pill(st.cls, st.label));
      tr.append(c1, el('td', null, nameOf(d.rid)), el('td', null, L.lastSeenText(V.data.fetched_at, d.last_seen)), c4, c5);
      tb.append(tr);
    }
    t.append(thead, tb);
    sc.append(t);
    wrap.append(sc);
    return wrap;
  }

  // ── «Desvincular» ──
  function openModal(d) {
    const branch = rows().find((b) => b.rid === d.rid);
    V.modal = { rid: d.rid, uid: d.uid, label: L.deviceLabel(d), name: nameOf(d.rid), ...L.revokeFacts(branch, d.uid) };
    paintModal();
    scrim.classList.add('show');
  }
  function closeModal() { V.modal = null; scrim.classList.remove('show'); modal.replaceChildren(); }
  function paintModal() {
    const m = V.modal;
    if (!m) return;
    const mh = el('div', 'mh');
    const title = el('div', 'mt', `¿Desvincular «${m.label}»?`); title.id = 'devtitle';
    mh.append(title, el('div', 'ms', m.name));
    const mb = el('div', 'mb');
    mb.append(el('p', 'eqbody', `Desde ahora el equipo ya no puede hacer nuevas acciones en los pedidos de ${m.name}. Una acción que ya estaba en proceso puede completarse, y un aviso que ya estaba en camino puede llegarle en los próximos minutos. ${m.lastOne ? 'Los pedidos en curso no cambian.' : 'Los pedidos en curso no cambian: los siguen atendiendo los otros equipos de la sucursal.'} Para usarlo de nuevo hay que vincularlo otra vez desde el mismo equipo.`));
    if (m.pauses) {
      const c = el('div', 'eqcall');   // the modal is outside .ops, so the callout carries its own class
      c.append(icon('warn'));
      const t = el('div');
      t.append(el('b', null, 'Es el único equipo de esta sucursal.'), document.createTextNode(' Al desvincularlo, la sucursal se pausa para que ningún pedido quede sin atender.'));
      c.append(t);
      mb.append(c);
    }
    const mf = el('div', 'mf');
    const go = button('btn danger solid', m.pauses ? 'Desvincular y pausar sucursal' : 'Desvincular', () => doRevoke());
    go.disabled = V.busy;
    mf.append(button('btn ghost', 'Cancelar', closeModal), go);
    modal.replaceChildren(mh, mb, mf);
  }
  scrim.addEventListener('click', (e) => { if (e.target === scrim && !V.busy) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && V.modal && !V.busy) closeModal(); });

  // m: the modal's operation, or — «Reintentar» — the SAME retained operation (E7 is idempotent per rid + uid)
  async function doRevoke(m = V.modal) {
    if (!m || V.busy) return;
    const gen = ctx.gen();
    V.busy = true; V.panel = null;
    ctx.setBusy('dev-revoke', true);
    if (V.modal === m) paintModal(); else render();
    let out = null; let err = null;
    try {
      out = await revokeBranchDevice({ rid: m.rid, uid: m.uid, token: ctx.token });
    } catch (e) {
      err = e;
    }
    V.busy = false;                                   // released on EVERY settlement (1a r1 P1-1)
    ctx.setBusy('dev-revoke', false);
    if (!ctx.alive(gen)) { render(); return; }
    if (V.modal === m) closeModal();
    if (err) {
      if (err.status === 404) { load(); return; }     // it was no longer linked: the fresh list says so
      // the failed operation is kept: «Reintentar» re-sends it (a list refresh never drops this panel)
      const retry = () => doRevoke(m);
      V.panel = err.kind === 'Unavailable' ? errBox(OFFLINE[0], OFFLINE[1], retry) : errBox('No se pudo desvincular el equipo', RETRY_DETAIL, retry);
      render();
      return;
    }
    dropRow(m.rid, m.uid);
    if (out && out.paused === true) {
      ctx.patchBranch(m.rid, { control: { state: 'paused', paused_until: null, pause_reason: 'Otro', pause_since: Date.now() } });
      ctx.toast(`«${m.label}» desvinculado · ${m.name} pausada`);
    } else {
      ctx.toast(`«${m.label}» desvinculado`);
      // the SERVER's answer decides the recovery panel, whatever this (possibly stale) list predicted (codex build r1 P1)
      if (out && out.pause_error) V.panel = pausePanel(m);
    }
    load();   // reconcile with a fresh list — its new seq makes every fetch begun BEFORE this revoke obsolete (codex build r1 P2)
  }
  function dropRow(rid, uid) {
    const b = V.data && V.data.branches.find((x) => x.rid === rid);
    if (b && Array.isArray(b.devices)) b.devices = b.devices.filter((d) => d.uid !== uid);
    const br = branchOf(rid);
    if (br && Number.isInteger(br.devices)) ctx.patchBranch(rid, { devices: Math.max(0, br.devices - 1) });
    else render();
  }
  // E-D14: the revoke happened, the pause did not — said plainly, with the one action that fixes it (no silent state)
  function pausePanel(m) {
    const box = errBox(`Desvinculamos el equipo, pero no pudimos pausar ${m.name}.`, RETRY_DETAIL);
    const go = button('btn', 'Pausar sucursal', async () => {
      if (V.busy) return;
      const gen = ctx.gen();
      V.busy = true; go.disabled = true;
      ctx.setBusy('dev-pause', true);
      let out = null;
      try {
        out = await setBranchPause({ rid: m.rid, op: 'pause', reason: 'Otro', dur_min: null, token: ctx.token });
      } catch (_) {
        out = null;
      }
      V.busy = false;
      ctx.setBusy('dev-pause', false);
      if (!ctx.alive(gen)) { render(); return; }
      if (out && out.ok) {
        V.panel = null;
        if (out.control) ctx.patchBranch(m.rid, { control: out.control });
        ctx.toast(`${m.name} pausada`);
      } else go.disabled = false;
      render();
    });
    box.append(go);
    return box;
  }

  return {
    render,
    show(opts = {}) { V.only = opts.rid || null; V.panel = null; render(); load(); },   // every entry re-fetches (r1.1 §4)
  };
}
