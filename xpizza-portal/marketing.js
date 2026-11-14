// Portal «Marketing» — «Ofertas», the DRAWING half (MOCKUP-portal-marketing v5, OWNER-APPROVED 11-14), slice O1: the page, the text
// tabs «Campañas» | «Crear campaña», the Campañas list (Ofertas), the honest empty state and the «Crear campaña» offer cards. The
// builder dialog (O2) and the detail / state moves (O3) follow. Every v5 block whose DATA the server does not have is ABSENT — never
// «—» or 0 — and named in SOURCE_GATE with its reason (advisor 11-14, rule 8); marketing.test.mjs enforces the list.
//
// NAV (advisor 11-14): shown only with marketing.read AND the last-known offers switch ON (session cache, default hidden: offers stay
// off in prod until the go-live gate, so no merchant finds an empty page). A background read after load refreshes the cache; a flip
// is applied on the NEXT navigation (shell requestNavRefresh), never under the user. A direct visit with the switch off draws the
// title + lede only (NOT-DRAWN state, logged in NOT_DRAWN).
// A MANAGER (marketing.read without marketing.edit) reads the same list; no «Crear campaña», no «Acciones» (the server refuses).
import { registerView, requestNavRefresh } from './shell.js';
import { token } from './auth.js';
import { getMyBranches, getMarketingRaw } from './api.js';
import { el, svg, button, topBlock, errBox, skeleton, OFFLINE } from './ops-dom.js';
import * as ML from './marketing-logic.js';

// ── what v5 draws that this build does NOT (advisor 11-14) ─────────────────────────────────────────────────────────────────────
export const SOURCE_GATE = Object.freeze([
  ['summary', 'the summary sentence + the three figures: pedidos · costo · vendido por L 1 — no per-offer results read yet — 5f, planned'],
  ['fresh', '«Actualizado hace N h» — it states the freshness of the results read, which does not exist yet'],
  ['period', 'the period pill «Últimos 30 días» — it only drives the results figures'],
  ['ventas', 'the «Ventas» column — no per-offer attributed sales'],
  ['tope', '«Pausada · tope» and every cap-pause banner — the server has no automatic cap pause: only paused_owner'],
  ['repeat-live', '«Repetir» on Activa / Pausada rows — the server repeats ENDED offers only — not_ended otherwise'],
  ['delete', '«Eliminar» on a draft / Programada — the server has no delete'],
  ['anuncios', 'the «Anuncios» section, the Anuncio hero and the eligibility line — the Anuncio stays dark — the ledger is unbuilt'],
  ['how-anuncios', 'the «Anuncios.» paragraph of «¿Cómo funcionan?» — the Anuncio stays dark'],
  ['sherpa-collections', '«Campañas de Sherpa» — no server for the collections yet'],
  ['empty-results', 'the empty state\'s «acá vas a ver cuánto vendiste… cuántos pedidos trajo…» — it promises results the page cannot show until the per-offer results read lands, 5f'],
]);
// states the server produces that v5 does not draw (advisor 11-14: render nothing until a frame is approved)
export const NOT_DRAWN = Object.freeze([
  ['switch-off', 'offers_enabled off: the nav is hidden; a direct visit draws the title + lede only'],
  ['live-drift', 'an offer whose price-path mirror disagrees, marketing-logic driftOf — wired, not rendered; design delta commissioned'],
]);

const LEDE = 'Ofertas y anuncios para vender más en la app.';
const LEDE_EMPTY = 'Ofertas y anuncios para vender más en la app. Vos elegís qué, cuándo y hasta cuánto.';
const ICONS = Object.freeze({
  'i-percent': ['M19 5 5 19', { tag: 'circle', cx: 6.5, cy: 6.5, r: 2.5 }, { tag: 'circle', cx: 17.5, cy: 17.5, r: 2.5 }],
  'i-coin': [{ tag: 'circle', cx: 12, cy: 12, r: 9 }, 'M9.5 7.5v9h5'],
  'i-gift': ['M20 12v9H4v-9M2 7h20v5H2zM12 21V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z'],
  'i-truck': ['M1 4h14v12H1zM15 9h5l3 3v4h-8z', { tag: 'circle', cx: 5.5, cy: 18.5, r: 1.8 }, { tag: 'circle', cx: 18.5, cy: 18.5, r: 1.8 }],
  'i-userplus': ['M15 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', { tag: 'circle', cx: 8, cy: 7, r: 4 }, 'M20 8v6M23 11h-6'],
});
const DOWN = 'M6 9l6 6 6-6', CHECK = 'M5 12l5 5L20 7';
const MEGAPHONE = 'M3 10v4h3l6 4V6L6 10H3zM15.5 9.5a3.6 3.6 0 0 1 0 5';   // v5's own nav icon (its two paths as one d)
const ico = (k) => svg(...ICONS[k]);

// the five offer cards (v5 tpl-ofertas, verbatim)
const CARDS = Object.freeze([
  { type: 'pct', tone: 'mint', cat: 'Descuento', title: 'Porcentaje en todo el menú', line: 'Ej.: 15 % en cada pedido, hasta L 100 de descuento.', ben: 'Aparecés en la sección Ofertas de la app' },
  { type: 'lps', tone: 'sky', cat: 'Lempiras', title: 'Lempiras de descuento con mínimo', line: 'Ej.: L 50 en pedidos desde L 300.', ben: 'Sube el ticket: el cliente completa el mínimo' },
  { type: 'bogo', tone: 'rose', cat: '2 × 1', title: 'Comprá 1 y llevate otro gratis', line: 'El cliente paga un producto y se lleva otro de igual o menor valor.', ben: 'Se muestra con una etiqueta en tu menú' },
  { type: 'envio', tone: 'teal', cat: 'Envío', title: 'Envío gratis', line: 'Solo donde el cliente de verdad lo recibe: en tu zona y con el mínimo de compra.', ben: 'Tu restaurante aparece con «Envío gratis»' },
  { type: 'nuevos', tone: 'lav', cat: 'Clientes nuevos', title: 'Para clientes nuevos', line: 'Un descuento solo en el primer pedido con tu restaurante.', ben: 'Solo la ven clientes que nunca te pidieron' },
]);
const MENU_WORD = Object.freeze({ view: 'Ver', pause: 'Pausar', resume: 'Reanudar', edit: 'Editar', end: 'Terminar', repeat: 'Repetir', continue: 'Seguir editando' });
const ESTADO_WORD = Object.freeze({ all: 'Todas', live: 'Activas', scheduled: 'Programadas', paused_owner: 'Pausadas', ended: 'Terminadas', draft: 'Borradores' });

// ── the switch, cached per session (advisor 11-14: cached-first, default hidden) ───────────────────────────────────────────────
const SW_KEY = (uid, brandId) => `sherpa.portal.mkt.${uid}|${brandId}`;
const swGet = (uid, brandId) => { try { return sessionStorage.getItem(SW_KEY(uid, brandId)) === '1'; } catch (_) { return false; } };
const swSet = (uid, brandId, on) => { try { sessionStorage.setItem(SW_KEY(uid, brandId), on ? '1' : '0'); } catch (_) { /* no storage: stays hidden */ } };

const S = {
  gen: 0, uid: null, sel: null, navSel: null, host: null, body: null,
  status: 'idle', tab: 'home', branches: [], reads: null, offers: [], off: false,
  filter: { rid: 'all', estado: 'all' }, howOpen: false, menu: null,
};
const can = (cap) => !!(S.sel && S.sel.caps.includes(cap));
function snap() {
  const g = { gen: S.gen, uid: S.uid, brandId: S.sel ? S.sel.brandId : null };
  g.alive = () => g.gen === S.gen && g.uid === S.uid && !!S.sel && g.brandId === S.sel.brandId;
  g.assertLive = () => { if (!g.alive()) throw Object.assign(new Error('obsolete'), { kind: 'obsolete' }); };
  return g;
}
document.addEventListener('portal:auth', (e) => {
  const uid = e && e.detail ? e.detail.uid : null;
  S.gen += 1;
  if (uid !== S.uid) { S.offers = []; S.reads = null; S.branches = []; S.status = 'idle'; S.menu = null; if (S.body) S.body.replaceChildren(); }
  S.uid = uid;
});

// the brand's member branches the caller may read marketing for (getMyBranches), in the server's order
async function branchesOf(g) {
  const e1 = await getMyBranches({ token, assertLive: g.assertLive });
  return (e1 && Array.isArray(e1.branches) ? e1.branches : [])
    .filter((b) => b && b.brand_id === g.brandId && b.state === 'member' && !b.degraded && Array.isArray(b.caps) && b.caps.includes('marketing.read'));
}
// ONE branch read → { kind } (readModel) | { kind: 'error' } (transport / non-200 / unreadable: the OFFLINE box)
async function readOne(rid) {
  let res;
  try { res = await getMarketingRaw({ rid, token }); } catch (_) { return { kind: 'error' }; }
  if (!res || res.transport || res.status !== 200) return { kind: 'error' };
  const m = ML.readModel(res.body);
  return m.kind === 'unreadable' ? { kind: 'error' } : m;
}

// the background revalidation of the cached switch: after the session opens (never awaited by a paint)
document.addEventListener('portal:ready', () => { revalidateSwitch().catch(() => {}); });
async function revalidateSwitch() {
  const sel = S.navSel;   // the shell's brand-level selection, as last handed to visible() (the item may be hidden: never mounted)
  if (!S.uid || !sel || !sel.caps.includes('marketing.read')) return;
  const g = { gen: S.gen, uid: S.uid, brandId: sel.brandId };
  g.alive = () => g.gen === S.gen && g.uid === S.uid && !!S.navSel && S.navSel.brandId === g.brandId;
  g.assertLive = () => { if (!g.alive()) throw Object.assign(new Error('obsolete'), { kind: 'obsolete' }); };
  const bs = await branchesOf(g);
  if (!g.alive() || !bs.length) return;
  const r = await readOne(bs[0].rid);
  if (!g.alive() || r.kind === 'error') return;
  const on = r.kind === 'ok';
  if (on !== swGet(S.uid, g.brandId)) { swSet(S.uid, g.brandId, on); requestNavRefresh(); }
}

async function load() {
  const g = snap();
  if (!S.reads) { S.status = 'loading'; render(); }
  try {
    const bs = await branchesOf(g);
    if (!g.alive()) return;
    S.branches = bs;
    const rids = S.filter.rid === 'all' ? bs.map((b) => b.rid) : bs.filter((b) => b.rid === S.filter.rid).map((b) => b.rid);
    const reads = await Promise.all(rids.map(readOne));
    if (!g.alive()) return;
    if (reads.some((r) => r.kind === 'error') || !reads.length) { S.status = 'error'; render(); return; }
    S.off = reads.some((r) => r.kind === 'off');
    swSet(S.uid, g.brandId, !S.off);
    S.reads = reads;
    S.offers = S.off ? [] : ML.unionOffers(reads.map((r) => r.offers));
    S.status = 'ready';
  } catch (err) {
    if (!g.alive() || (err && err.kind === 'obsolete')) return;
    S.status = 'error';
  }
  render();
}

// ── render ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function render() {
  if (!S.body) return;
  const empty = S.status === 'ready' && !S.off && S.offers.length === 0;
  const { top } = topBlock('Marketing', empty && S.tab === 'home' ? LEDE_EMPTY : LEDE, []);
  const out = [top];
  if (S.status === 'loading') out.push(skeleton());
  else if (S.status === 'error') out.push(errBox(OFFLINE[0], OFFLINE[1], () => load()));
  else if (S.status === 'ready' && !S.off) {
    out.push(tabs());
    if (S.tab === 'create' && can('marketing.edit')) out.push(createTab());
    else if (empty) out.push(emptyState());
    else out.push(...homeTab());
  }
  S.body.replaceChildren(...out);
}

function tabs() {
  const nav = el('nav', 'mk5-tabs'); nav.setAttribute('aria-label', 'Secciones de Marketing');
  const items = [['home', 'Campañas'], ...(can('marketing.edit') ? [['create', 'Crear campaña']] : [])];
  for (const [id, word] of items) {
    const on = S.tab === id;
    const b = button(`mk5-tab${on ? ' mk5-on' : ''}`, word, () => { if (S.tab !== id) { S.tab = id; S.menu = null; render(); } });
    if (on) b.setAttribute('aria-current', 'page');
    nav.append(b);
  }
  return nav;
}

// a pill dropdown (the v5 .vpre.dd + .menu idiom): one open at a time, closed by a pick or a second click
function pill(id, label, options, onPick, { on = false } = {}) {
  const k = el('div', 'mk5-kebab');
  const b = button(`mk5-pill${on ? ' mk5-chosen' : ''}`, label, () => { S.menu = S.menu === id ? null : id; render(); });
  b.setAttribute('aria-haspopup', 'listbox'); b.setAttribute('aria-expanded', S.menu === id ? 'true' : 'false');
  b.append(svg(DOWN));
  k.append(b);
  const m = el('div', `mk5-menu mk5-list${S.menu === id ? ' mk5-open' : ''}`); m.setAttribute('role', 'listbox');
  for (const o of options) {
    const ob = button('mk5-opt', o.word, () => { S.menu = null; onPick(o.value); });
    ob.setAttribute('role', 'option'); ob.setAttribute('aria-selected', o.selected ? 'true' : 'false');
    if (o.count !== undefined) ob.append(el('span', 'mk5-count', String(o.count)));
    m.append(ob);
  }
  k.append(m);
  return k;
}

function homeTab() {
  const out = [];
  const bar = el('div', 'mk5-bar');
  const filt = el('div', 'mk5-filt'); filt.setAttribute('role', 'group'); filt.setAttribute('aria-label', 'Filtros');
  if (S.branches.length > 1) {
    const cur = S.filter.rid === 'all' ? null : S.branches.find((b) => b.rid === S.filter.rid);
    filt.append(pill('fbr', cur ? cur.name : 'Todas las sucursales',
      [{ value: 'all', word: 'Todas las sucursales', selected: !cur }, ...S.branches.map((b) => ({ value: b.rid, word: b.name, selected: !!cur && cur.rid === b.rid }))],
      (v) => { S.filter.rid = v; S.reads = null; load(); }, { on: !!cur }));
  }
  const counts = ML.estadoCounts(S.offers);
  filt.append(pill('fst', S.filter.estado === 'all' ? 'Estado' : ESTADO_WORD[S.filter.estado],
    ML.ESTADOS.map((e) => ({ value: e, word: ESTADO_WORD[e], count: counts[e], selected: S.filter.estado === e })),
    (v) => { S.filter.estado = v; render(); }, { on: S.filter.estado !== 'all' }));
  bar.append(filt);
  out.push(bar);
  const sect = el('div', 'mk5-sect'); sect.append(el('h2', null, 'Ofertas'));
  out.push(sect, list(ML.byEstado(S.offers, S.filter.estado)));
  return out;
}

function list(offers) {
  const wrap = el('div', 'mk5-list');
  const lh = el('div', 'mk5-lh');
  for (const h of ['', 'Campaña', 'Estado', 'Horario', '']) lh.append(el('span', null, h));
  wrap.append(lh);
  const rows = ML.listRows(offers, { nBranches: S.branches.length, canEdit: can('marketing.edit') });
  for (const r of rows) {
    const row = el('div', 'mk5-row'); row.dataset.offer = r.id;
    const ic = el('span', 'mk5-ico'); ic.append(ico(r.icon));
    const c1 = el('div', 'mk5-c1');
    c1.append(el('span', 'mk5-lnk', r.name));   // the detail (O3) makes this the link; until then the name is plain text
    if (r.branchNote) c1.append(el('span', 'mk5-br', r.branchNote));
    const c2 = el('div', 'mk5-c2');
    const st = el('span', 'mk5-st'); st.append(el('i', `mk5-dot mk5-${r.status.key}`), document.createTextNode(r.status.word));
    c2.append(st);
    const c3 = el('div', 'mk5-c3');
    if (r.horario) c3.textContent = r.horario; else c3.append(el('span', 'mk5-faint', 'Sin programar'));
    const c5 = el('div', 'mk5-c5 mk5-kebab');
    if (r.menu.length) {
      const mid = `rm-${r.id}`;
      const b = button('mk5-act', 'Acciones', () => { S.menu = S.menu === mid ? null : mid; render(); });
      b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', S.menu === mid ? 'true' : 'false');
      b.append(svg(DOWN));
      const m = el('div', `mk5-menu${S.menu === mid ? ' mk5-open' : ''}`); m.setAttribute('role', 'menu');
      for (const a of r.menu) {
        const ob = button(a === 'end' ? 'mk5-opt mk5-danger' : 'mk5-opt', MENU_WORD[a], () => { S.menu = null; render(); });   // O2 / O3 wire the moves
        ob.setAttribute('role', 'menuitem'); ob.dataset.act = a;
        m.append(ob);
      }
      c5.append(b, m);
    }
    row.append(ic, c1, c2, c3, c5);
    wrap.append(row);
  }
  return wrap;
}

function offerCards() {
  const sect = el('div', 'mk5-osect');
  sect.append(el('h2', null, 'Creá tu propia oferta'),
    el('p', 'mk5-olede', 'Elegí un tipo. Todo viene con valores sugeridos que podés cambiar, y el descuento lo cubre tu restaurante.'));
  const grid = el('div', 'mk5-ogrid');
  for (const c of CARDS) {
    const t = c.tone;
    const card = el('div', `mk5-card mk5-bg-${t}`); card.setAttribute('role', 'button'); card.tabIndex = 0; card.dataset.otype = c.type; card.dataset.tone = t;
    const i = el('span', `mk5-cico mk5-vv-${t}`); i.append(ico(ML.TYPE_ICON[c.type]));
    const ben = el('div', `mk5-ben mk5-ink-${t}`); ben.append(svg(CHECK), el('span', null, c.ben));
    card.append(el('i', `mk5-glow mk5-vv-${t}`), i, el('div', `mk5-ccat mk5-ink-${t}`, c.cat), el('h3', null, c.title), el('p', 'mk5-cline', c.line), ben, el('span', `mk5-cbtn mk5-vv-${t}`, 'Comenzar'));
    grid.append(card);
  }
  sect.append(grid);
  return sect;
}

function createTab() {
  const v = el('div', 'mk5-v5');
  v.append(offerCards());
  const how = button('mk5-how', '¿Cómo funcionan?', () => { S.howOpen = !S.howOpen; render(); });
  how.setAttribute('aria-expanded', S.howOpen ? 'true' : 'false');
  v.append(how);
  if (S.howOpen) {
    const box = el('div', 'mk5-howbox');
    const p = el('p', 'mk5-howp');
    p.append(el('b', null, 'Ofertas.'), document.createTextNode(' Un descuento que cubre tu restaurante. Aparece en la sección «Ofertas» de la app y con una etiqueta en tu menú, solo en los días y horas que elijás. Sherpa no te cobra.'));
    box.append(p);
    v.append(box);
  }
  return v;
}

function emptyState() {
  const v = el('div', 'mk5-v5');
  const e = el('div', 'mk5-empty');
  e.append(el('h2', null, 'Todavía no tenés campañas'));
  if (can('marketing.edit')) e.append(el('p', null, 'Empezá por acá:'));   // the results sentence before it: SOURCE_GATE empty-results
  v.append(e);
  if (can('marketing.edit')) v.append(offerCards());
  return v;
}

document.addEventListener('click', (e) => {   // a click outside an open pill / Acciones menu closes it
  if (!S.menu || !S.body || !S.body.isConnected) return;
  if (e.target && e.target.closest && e.target.closest('.mk5-kebab')) return;
  S.menu = null; render();
});

registerView({
  id: 'marketing',
  group: 'Negocio',
  label: 'Marketing',
  icon: MEGAPHONE,
  visible: (sel) => { S.navSel = sel; return !!sel && sel.caps.includes('marketing.read') && !!sel.uid && swGet(sel.uid, sel.brandId); },
  mount(host, sel) {
    S.sel = sel;
    S.host = host;
    const wrap = el('div', 'mktv');
    S.body = el('div');
    wrap.append(S.body);
    host.replaceChildren(wrap);
    S.status = 'idle'; S.reads = null; S.offers = []; S.tab = 'home'; S.menu = null; S.howOpen = false; S.filter = { rid: 'all', estado: 'all' };
    render();
    load();
  },
  unmount() {
    S.gen += 1;
    if (S.body) S.body.replaceChildren();
    S.host = null; S.body = null; S.reads = null; S.offers = []; S.menu = null;
  },
  canLeave: () => true,
});

export const _mktState = S;   // test-only view of the module state (never read by the page)
