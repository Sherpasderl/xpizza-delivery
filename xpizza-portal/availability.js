// PORTAL-UI 1a — per-branch sold-out (agotados) in Productos, over getBranchAvailability / setBranchAvailability.
//   • «Agotados ahora» strip: one chip per in-scope branch with its sold-out count (an owner's tap selects that branch).
//   • EDITOR mode (the selected branch holds catalog.read_editor — today's owner path): the editor is untouched; this module
//     DECORATES its rendered rows (a MutationObserver on #detail) with the availability control, only for keys that branch
//     PUBLISHED (a draft-only / pending addition gets none). The row chevron keeps opening the edit drawer.
//   • READ-ONLY mode (no catalog.read_editor, e.g. a manager): this module renders the branch's published menu itself into
//     the editor's empty #rail / #detail (app.js never loads there), with a per-row toggle and the «Disponibilidad por
//     sucursal» drawer.
// Every write: optimistic, then setBranchAvailability (all-or-nothing on the server); a failure rolls back with a toast.
import { getBranchAvailability, setBranchAvailability } from './api.js';
import * as L from './branch-logic.js';
import { $, el, icon, button, toggle, pill, errBox, skeleton, OFFLINE } from './ops-dom.js';

export function mountAvailability(ctx) {
  const V = { menus: null, loading: false, err: null, writeErr: null, cat: null, drawerKey: null, pending: new Set(), loadedFor: null, observer: null };

  const scopeList = () => L.scopeBranches(ctx.sel).filter((b) => L.can(b, 'availability.set'));
  const editorMode = () => !!ctx.editorRid;
  const menusIn = () => (V.menus || []).filter((m) => scopeList().some((b) => b.rid === m.rid));
  const nameOf = (rid) => { const b = (ctx.sel ? ctx.sel.brand.branches : []).find((x) => x.rid === rid); return b ? b.name : rid; };

  async function load() {
    const list = scopeList();
    if (!list.length) return;
    const key = `${ctx.sel.brand_id}:${ctx.sel.scope}`;
    if (V.loading) { if (V.loadedFor !== key) V.again = true; return; }   // a refresh asked mid-flight runs right after it
    if (V.loadedFor === key) return;
    const gen = ctx.gen();
    V.loading = true; V.err = null;
    paint();
    try {
      const out = list.length > 1
        ? await getBranchAvailability({ brandId: ctx.sel.brand_id, token: ctx.token })
        : await getBranchAvailability({ rid: list[0].rid, token: ctx.token });
      if (!ctx.alive(gen)) return;
      V.menus = out.branches || [];
      V.loadedFor = key;
    } catch (e) {
      if (!ctx.alive(gen)) return;
      V.err = e;
    }
    V.loading = false;
    paint();
    if (V.again) { V.again = false; V.loadedFor = null; load(); }   // codex 1a r2: the queued refresh is never swallowed by the old response's stamp
  }
  const retry = () => { V.loadedFor = null; V.err = null; load(); };
  // codex 1a r1 P2-7: a settled publish moves this branch's published key set → re-read it (the editor repaints its rows;
  // the observer re-decorates them against the fresh set).
  document.addEventListener('portal:published', () => { if (ctx.sel) { V.loadedFor = null; load(); } });

  // ── the strip ──
  function paintStrip() {
    const strip = $('availstrip');
    const list = scopeList();
    if (!list.length || !V.menus) { strip.classList.add('hidden'); return; }
    strip.classList.remove('hidden');
    strip.replaceChildren(el('span', 'sl', 'Agotados ahora'));
    for (const b of list) {
      const n = L.soldOutCount(V.menus, b.rid);
      const failed = V.menus.some((m) => m.rid === b.rid && m.error);   // P2-6: a failed read is never shown as «0 agotados»
      const on = ctx.sel.scope === b.rid;
      const chip = el('button', `bchip opsbchip${on ? ' on' : ''}`);
      chip.type = 'button';
      chip.append(document.createTextNode(b.name), el('span', `n${n && !failed ? ' nout' : ''}`, failed ? '—' : String(n)));
      chip.setAttribute('aria-label', failed ? `${b.name}: no pudimos cargar sus agotados` : `${b.name}: ${n} agotados`);
      if (ctx.sel.owner && !ctx.sel.locked) chip.addEventListener('click', () => ctx.select({ brand_id: ctx.sel.brand_id, scope: on ? (ctx.sel.brand.branches.length > 1 ? 'all' : b.rid) : b.rid }));
      else chip.disabled = true;
      strip.append(chip);
    }
  }

  // ── writes ──
  function setLocal(rid, key, available) {
    const m = (V.menus || []).find((x) => x.rid === rid);
    if (!m) return;
    const out = new Set(m.unavailable || []);
    if (available) out.delete(key); else out.add(key);
    m.unavailable = [...out];
  }
  async function write(rids, key, available) {
    const id = `${key}::${rids.join(',')}`;
    if (V.pending.has(id) || !rids.length) return;
    const gen = ctx.gen();
    const before = rids.map((r) => [r, !((V.menus || []).find((m) => m.rid === r) || { unavailable: [] }).unavailable.includes(key)]);
    for (const r of rids) setLocal(r, key, available);
    V.writeErr = null;
    V.pending.add(id);
    ctx.setBusy(`avail-${id}`, true);
    paint();
    try {
      await setBranchAvailability({ rids, key, available, token: ctx.token });
      if (!ctx.alive(gen)) return;
    } catch (e) {
      if (!ctx.alive(gen)) return;
      for (const [r, was] of before) setLocal(r, key, was);
      V.writeErr = e && e.kind === 'Unavailable' ? [...OFFLINE] : ['No se guardó el cambio de disponibilidad', 'Volvé a intentar; si sigue igual, escribinos por WhatsApp.'];
    } finally {
      V.pending.delete(id);
      ctx.setBusy(`avail-${id}`, false);
    }
    paint();
  }

  // the per-row control: scope one → a toggle; 'all' → one pill per applicable branch
  function controlFor(row) {
    const sel = ctx.sel;
    if (sel.scope !== 'all') {
      const rid = sel.scope;
      if (!row.applicable.includes(rid)) return null;
      const on = !row.out.includes(rid);
      return toggle(on, `Disponible en ${nameOf(rid)}`, () => write([rid], row.key, !on));
    }
    const wrap = el('div', 'avail opsavail');
    for (const rid of scopeList().map((b) => b.rid).filter((r) => row.applicable.includes(r))) {
      const out = row.out.includes(rid);
      const p = el('button', `apill${out ? ' out' : ''}`);
      p.type = 'button';
      p.setAttribute('aria-pressed', out ? 'true' : 'false');
      p.setAttribute('aria-label', `${nameOf(rid)}: ${out ? 'agotado' : 'disponible'}`);
      p.append(el('i'), document.createTextNode(nameOf(rid)));
      p.addEventListener('click', () => write([rid], row.key, out));
      wrap.append(p);
    }
    return wrap.childNodes.length ? wrap : null;
  }

  // ── EDITOR mode: decorate app.js's rows (its DOM is otherwise untouched) ──
  function decorate() {
    const detail = $('detail');
    if (!detail || !V.menus) return;
    const { items } = L.availabilityUnion(menusIn(), scopeList().map((b) => b.rid));
    for (const cell of detail.querySelectorAll('.irow > [data-k^="item::"]')) {
      const key = cell.dataset.k.slice('item::'.length);
      const row = cell.parentNode;
      const prev = row.querySelector(':scope > .opsavailcell');
      const it = items.get(key);
      const sig = it ? `${ctx.sel.scope}|${it.out.join(',')}|${[...V.pending].filter((p) => p.startsWith(`${key}::`)).length}` : '';
      if (prev && prev.dataset.sig === sig) continue;
      if (prev) prev.remove();
      if (!it) continue;   // not published by this branch (a draft-only or pending addition): no control
      const holder = el('div', 'opsavailcell');
      holder.dataset.sig = sig;
      const c = controlFor(it);
      if (!c) continue;
      holder.append(c);
      cell.after(holder);
      if (it.out.length && it.out.length === it.applicable.length) {
        const nm = row.querySelector('.nm');
        if (nm && !nm.querySelector('.opsallout')) { const p = pill('paused', 'Agotado en todas'); p.classList.add('opsallout'); nm.append(p); }
      } else {
        const p = row.querySelector('.opsallout'); if (p) p.remove();
      }
    }
  }
  function observeEditor() {
    const MO = globalThis.MutationObserver;
    if (V.observer || typeof MO !== 'function') return;
    const detail = $('detail');
    if (!detail) return;
    V.observer = new MO(() => { V.observer.disconnect(); decorate(); V.observer.observe(detail, { childList: true, subtree: true }); });
    V.observer.observe(detail, { childList: true, subtree: true });
  }

  // ── READ-ONLY mode: the published menu, rendered here ──
  function paintReadOnly() {
    const rail = $('rail'), detail = $('detail');
    const sel = ctx.sel;
    $('menulock').classList.remove('hidden');
    const one = sel.scope !== 'all' ? sel.brand.branches.find((b) => b.rid === sel.scope) : null;
    $('menulede').textContent = `Lo que ve el cliente de ${one ? one.name : sel.brand.name}. Podés marcar agotados; los precios los edita el dueño.`;
    if (V.loading && !V.menus) { rail.replaceChildren(); detail.replaceChildren(skeleton()); return; }
    if (V.err) { rail.replaceChildren(); detail.replaceChildren(errBox(...(V.err.kind === 'NotAuthorized' ? ['No tenés acceso a este menú', 'Si esperabas verlo, pedile acceso al dueño.'] : OFFLINE), V.err.kind === 'NotAuthorized' ? null : () => { V.loadedFor = null; V.err = null; load(); })); return; }
    const menus = menusIn();
    const failed = menus.filter((m) => m.error);
    const unpublished = menus.filter((m) => m.published === false);
    const { items, categories } = L.availabilityUnion(menus, scopeList().map((b) => b.rid));
    if (!categories.length) {
      rail.replaceChildren();
      const msgs = [];
      if (unpublished.length) msgs.push(['Esta sucursal todavía no tiene un menú publicado', 'Cuando el dueño lo publique, vas a poder marcar agotados acá.']);
      if (failed.length) msgs.push([`No pudimos cargar el menú de ${failed.map((m) => nameOf(m.rid)).join(', ')}`, OFFLINE[1]]);
      if (!msgs.length) msgs.push(['Esta marca todavía no tiene menú', 'Cuando el dueño lo publique, vas a poder marcar agotados acá.']);
      const e = el('div', 'empty');
      e.append(el('b', null, msgs[0][0]), el('span', null, msgs[0][1]));
      detail.replaceChildren(e);
      return;
    }
    if (!V.cat || !categories.some((c) => c.id === V.cat)) V.cat = categories[0].id;
    rail.replaceChildren();
    for (const c of categories) {
      const warn = c.keys.some((k) => items.get(k).out.length > 0);
      const b = el('button', `railitem${c.id === V.cat ? ' on' : ''}`);
      b.type = 'button';
      const t = el('div', 'rtext'); t.append(el('b', null, c.name));
      b.append(t);
      if (warn) { const w = el('span', 'rwarn'); w.setAttribute('aria-label', 'Con agotados'); b.append(w); }
      b.append(el('div', 'rcount', String(c.keys.length)));
      b.addEventListener('click', () => { V.cat = c.id; paint(); });
      rail.append(b);
    }
    const cat = categories.find((c) => c.id === V.cat);
    const head = el('div', 'dhead');
    const right = el('div', 'dright opsdright');
    right.append(pill('off', 'Solo lectura'), pill('off', sel.scope === 'all' ? `Disponible por sucursal · ${scopeList().length}` : `Disponible en ${nameOf(sel.scope)}`));
    head.append(el('div', 'dtitle', cat.name), right);
    const frag = [head];
    if (failed.length) frag.push(errBox(`No pudimos cargar el menú de ${failed.map((m) => nameOf(m.rid)).join(', ')}`, OFFLINE[1]));
    for (const k of cat.keys) {
      const it = items.get(k);
      const row = el('div', 'irow');
      const th = el('div', 'thumb'); th.setAttribute('aria-hidden', 'true'); th.append(icon('photo'));
      const info = el('div', 'iinfo');
      const nm = el('div', 'nm', it.name);
      if (it.out.length && it.out.length === it.applicable.length) nm.append(pill('paused', 'Agotado en todas'));
      info.append(nm);
      if (it.description) info.append(el('div', 'idesc', it.description));
      row.append(th, info, el('div', 'price', L.priceText(it.price)));
      const c = controlFor(it);
      if (c) row.append(c);
      row.append(button('rowchev', null, () => openDrawer(k), { aria: `Disponibilidad de ${it.name} por sucursal`, iconName: 'chev' }));
      frag.push(row);
    }
    detail.replaceChildren(...frag);
  }

  // ── the drawer (read-only mode) ──
  const drawer = $('availdrawer');
  const dscrim = $('availscrim');
  function openDrawer(key) { V.drawerKey = key; paintDrawer(); drawer.classList.add('show'); dscrim.classList.remove('hidden'); }
  function closeDrawer() { V.drawerKey = null; drawer.classList.remove('show'); dscrim.classList.add('hidden'); drawer.replaceChildren(); }
  dscrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && V.drawerKey) closeDrawer(); });
  function paintDrawer() {
    if (!V.drawerKey) return;
    const { items, categories } = L.availabilityUnion(menusIn(), scopeList().map((b) => b.rid));
    const it = items.get(V.drawerKey);
    if (!it) { closeDrawer(); return; }
    const cat = categories.find((c) => c.keys.includes(it.key));
    const h = el('div', 'dwh');
    h.append(el('span', 'dwt', 'Disponibilidad por sucursal'), button('adwx', null, closeDrawer, { aria: 'Cerrar', iconName: 'close' }));
    const b = el('div', 'dwb');
    const t = el('div');
    t.append(el('div', 'nm', it.name), el('div', 'fnote', `${cat ? cat.name : ''} · ${L.priceText(it.price)}`));
    b.append(t);
    for (const rid of scopeList().map((x) => x.rid).filter((r) => it.applicable.includes(r))) {
      const out = it.out.includes(rid);
      const row = el('div', 'brow');
      const bt = el('div', 'bt');
      bt.append(el('b', null, nameOf(rid)), el('span', null, out ? 'Agotado' : 'Disponible'));
      row.append(bt, toggle(!out, `Disponible en ${nameOf(rid)}`, () => write([rid], it.key, out)));
      b.append(row);
    }
    const outIn = it.out.filter((r) => scopeList().some((x) => x.rid === r));
    if (outIn.length) { const w = el('div'); w.append(button('btn sm', 'Volver a disponible en todas', () => write(outIn, it.key, true))); b.append(w); }
    const resets = menusIn().filter((m) => it.applicable.includes(m.rid)).every((m) => m.resets_daily === true);
    b.append(el('span', 'fnote', resets ? 'Un agotado se quita solo mientras la sucursal está cerrada.' : 'Un agotado queda así hasta que lo marqués disponible.'));
    drawer.replaceChildren(h, b);
  }

  // codex 1a r1 P2-6: EDITOR mode shows a failed availability read too — the same boxes + copy as the read-only screen
  // (a whole-read failure with Reintentar; a branch whose menu / availability did not load, named) — under the strip.
  function editorLoadError() {
    if (V.err) return V.err.kind === 'NotAuthorized' ? errBox('No tenés acceso a este menú', 'Si esperabas verlo, pedile acceso al dueño.') : errBox(OFFLINE[0], OFFLINE[1], retry);
    const failed = menusIn().filter((m) => m.error);
    return failed.length ? errBox(`No pudimos cargar el menú de ${failed.map((m) => nameOf(m.rid)).join(', ')}`, OFFLINE[1], retry) : null;
  }
  function paint() {
    if (!ctx.sel) return;
    paintStrip();
    const strip = $('availstrip');
    if (editorMode()) {
      const box = editorLoadError();
      if (box) { if (strip.classList.contains('hidden')) { strip.replaceChildren(); strip.classList.remove('hidden'); } strip.append(box); }
    }
    if (V.writeErr && !strip.classList.contains('hidden')) strip.append(errBox(V.writeErr[0], V.writeErr[1]));
    if (editorMode()) { observeEditor(); decorate(); }
    else paintReadOnly();
    if (V.drawerKey) paintDrawer();
  }

  return {
    render() { if (!ctx.sel) return; paint(); load(); },
  };
}
