// «Inicio» — the portal home (PLAN-portal-inicio-r0, APPROVED 11-13): «how is today going, and what needs me», EXACT to
// MOCKUP-portal-map.html v3 s-inicio / s-inicio-ok, with ONLY the sourced elements (rule 8):
//   • the greeting (no name: Q-I2) and «Resumen de hoy · {día}»;
//   • the branch pill: «Todas las sucursales» (the default with several branches; S2 merges its figures on the server) or one branch;
//   • Ventas / Pedidos / Ticket promedio for the pill's branch — getSalesStats today vs the same weekday last week, ONE read per
//     branch per session (cached-first, rule 7); a failed read keeps the three slots with «—» (no number invented, no reflow);
//   • «Para revisar»: a paused branch + «Reanudar» through the ONE pause control (pause-control.js); 1b «Todo en orden» otherwise;
//   • «Accesos rápidos»: «Editar producto». Crear oferta / Editar horario / Ayuda / the unpublished-menu, offer-cap and low-rating rows
//     WAIT for their sources (Marketing, hours editing, Q-I3, S3, S4) — absent, never a dead link or a «0».
// The shell owns routing and lands here first (registerHome; index.html loads this module — a page without it keeps today's landing).
import { registerHome } from './shell.js';
import { getSalesStats, getSalesStatsMulti } from './api.js';
import { pauseControl } from './pause-control.js';
import * as L from './branch-logic.js';
import { el, svg, ICON } from './ops-dom.js';
import { todayHN } from './ventas-logic.js';
import * as IL from './inicio-logic.js';

const FRESH_MS = 60 * 1000;   // a branch's figures are re-read silently after a minute (in place: the slots never move)
const OK_D = 'M5 12l5 5L20 7';   // the frame's check (i-check)
const DOWN_D = 'M6 9l6 6 6-6';   // the pill's chevron (i-down)
const MENU_D = 'M4 6h16M4 12h16M4 18h10';   // the menu row's icon (i-menu)
const S = { ctx: null, host: null, pc: null, rid: null, menu: false, err: null, cache: new Map(), gen: 0, shown: false };

const branches = () => (S.ctx ? L.scopeBranches(S.ctx.sel) : []);
const ALL = 'all';   // «Todas las sucursales» (ann 2: the default with several branches; S2 merges its figures on the server)
const MULTI_MAX = 20;   // the server's cap for one merged read (stats-api MULTI_MAX)
function pillRid() {
  const bs = branches();
  if (!bs.length) return null;
  if (bs.length === 1) return bs[0].rid;
  if (S.rid === ALL || (S.rid && bs.some((b) => b.rid === S.rid))) return S.rid;
  return ALL;
}
// the branches a figure read covers: one, or every branch in scope for «Todas» — ONLY when the member may read each of them
function statRids(scope) {
  const bs = branches();
  const pick = scope === ALL ? bs : bs.filter((b) => b.rid === scope);
  if (!pick.length || pick.some((b) => !L.can(b, 'stats.read')) || pick.length > MULTI_MAX) return null;
  return pick.map((b) => b.rid);
}

async function load(rid, { force = false } = {}) {
  const rids = statRids(rid);
  if (!rids) return;
  const hit = S.cache.get(rid);
  const now = Date.now();
  if (hit && (hit.state === 'loading' || (!force && now - hit.at < FRESH_MS))) return;
  S.cache.set(rid, { state: 'loading', figs: hit ? hit.figs : null, at: hit ? hit.at : 0 });
  const gen = ++S.gen;
  const today = todayHN(now);
  let figs;
  try {
    const assertLive = () => { if (!S.ctx.alive(S.ctx.gen())) throw Object.assign(new Error('obsolete'), { kind: 'obsolete' }); };
    const body = rid === ALL
      ? await getSalesStatsMulti({ rids, ...IL.statsQuery(today), token: S.ctx.token, assertLive })
      : await getSalesStats({ rid, ...IL.statsQuery(today), token: S.ctx.token, assertLive });
    figs = IL.figures(body, today);
  } catch (e) {
    if (e && e.kind === 'obsolete') return;
    figs = hit && hit.figs ? hit.figs : IL.NO_FIGURES;   // a failed refresh keeps what was shown; a first failure shows «—»
  }
  S.cache.set(rid, { state: 'ok', figs, at: now });
  if (gen === S.gen || S.rid === rid) render();
}

function pill() {
  const bs = branches();
  const sel = pillRid();
  const cur = sel === ALL ? { rid: ALL, name: 'Todas las sucursales' } : bs.find((b) => b.rid === sel);
  const filt = el('div', 'in-filt');
  if (bs.length <= 1) { filt.append(el('span', 'in-pill one', cur ? cur.name : '')); return filt; }
  const wrap = el('div', 'in-kebab');
  const btn = el('button', 'in-pill dd', cur ? cur.name : '');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', S.menu ? 'true' : 'false');
  btn.append(svg(DOWN_D));
  btn.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); S.menu = !S.menu; render(); });
  const menu = el('div', `in-menu${S.menu ? '' : ' hidden'}`);
  menu.setAttribute('role', 'listbox');
  for (const b of [{ rid: ALL, name: 'Todas las sucursales' }, ...bs]) {
    const o = el('button', 'in-opt', b.name);
    if (b.rid === (cur && cur.rid)) o.append(el('span', 'in-dot'));
    o.type = 'button'; o.setAttribute('role', 'option'); o.setAttribute('aria-selected', b.rid === (cur && cur.rid) ? 'true' : 'false');
    o.addEventListener('click', () => { S.rid = b.rid; S.menu = false; render(); load(b.rid); });
    menu.append(o);
  }
  wrap.append(btn, menu);
  filt.append(wrap);
  return filt;
}

function figuresBlock(rid) {
  if (!statRids(rid)) return null;   // no source for this member on this scope: the block is absent
  const hit = S.cache.get(rid);
  const f = hit && hit.figs ? hit.figs : null;
  const box = el('div', 'in-figs');
  for (const [label, key] of [['Ventas', 'sales'], ['Pedidos', 'orders'], ['Ticket promedio', 'ticket']]) {
    const k = el('div', 'in-fig');
    k.append(el('div', 'in-fl', label));
    const v = f ? f[key] : null;
    const n = el('div', `in-fn${v ? '' : ' wait'}`, v ? v.value : ' ');   // waiting: the slot holds its height (no reflow)
    k.append(n);
    if (key !== 'ticket') k.append(el('div', 'in-fs', v && v.vs ? v.vs : ' '));
    box.append(k);
  }
  return box;
}

function reviewCol(rid) {
  const col = el('div');
  const rows = IL.reviewRows(branches(), rid === ALL ? null : rid);
  const sect = el('div', 'in-sect');
  sect.append(el('h2', null, 'Para revisar'));
  if (rows.length) sect.append(el('span', 'in-cnt', IL.pendLabel(rows.length)));
  col.append(sect);
  if (S.err) { S.err.classList.add('in-err'); col.append(S.err); }
  if (!rows.length) {
    const ok = el('div', 'in-ok');
    const ic = el('span', 'in-okico'); ic.append(svg(OK_D));
    const t = el('div');
    t.append(el('b', null, 'Todo en orden'), el('span', null, 'No hay nada pendiente en tus sucursales.'));
    ok.append(ic, t);
    col.append(ok);
    return col;
  }
  for (const r of rows) {
    const row = el('div', 'in-row');
    const ic = el('span', 'in-ico'); ic.append(r.kind === 'menu' ? svg(MENU_D) : svg(...ICON.pause));
    const rt = el('div', 'in-rt', r.text);
    if (r.when) { rt.append(document.createTextNode(' ')); rt.append(el('span', 'in-when', r.when)); }
    row.append(ic, rt);
    if (r.kind === 'menu') {
      const go = el('button', 'in-act', 'Revisar');
      go.type = 'button';
      go.addEventListener('click', () => S.ctx.goto('menu'));
      row.append(go);
    }
    if (r.resume) {
      const b = branches().find((x) => x.rid === r.rid);
      const go = el('button', 'in-act', 'Reanudar');
      go.type = 'button';
      go.disabled = !!(S.pc && S.pc.busy(r.rid));
      go.addEventListener('click', () => { if (b && S.pc) S.pc.resume(b); });
      row.append(go);
    }
    col.append(row);
  }
  return col;
}

function quickCol() {
  const col = el('div');
  const sect = el('div', 'in-sect'); sect.append(el('h2', null, 'Accesos rápidos'));
  const prod = el('button', 'in-quick', 'Editar producto');
  prod.type = 'button';
  prod.append(svg(...ICON.chev));
  prod.addEventListener('click', () => S.ctx.goto('menu'));
  col.append(sect, prod);
  return col;
}

function render() {
  if (!S.host || !S.ctx || !S.ctx.sel) return;
  const rid = pillRid();
  const page = el('div', 'inicio');
  const top = el('div', 'in-top');
  const head = el('div');
  head.append(el('h1', null, IL.greeting(Date.now())), el('p', 'in-lede', IL.dateLine(Date.now())));
  top.append(head);
  page.append(top, pill());
  const figs = figuresBlock(rid);
  if (figs) page.append(figs);
  const two = el('div', 'in-two');
  two.append(reviewCol(rid), quickCol());
  page.append(two);
  S.host.replaceChildren(page);
}

function show() {
  S.shown = true;
  render();
  const rid = pillRid();
  if (rid) load(rid);
}

function mountHome(host, ctx) {
  S.host = host; S.ctx = ctx;
  S.pc = pauseControl(ctx, { candidates: () => branches().filter((b) => L.can(b, 'location.pause')), repaint: () => render(),
    showError: (box) => { S.err = box; render(); }, clearError: () => { S.err = null; } });
  document.addEventListener('click', () => { if (S.menu) { S.menu = false; render(); } });
  document.addEventListener('keydown', (e) => { if (e && e.key === 'Escape' && S.menu) { S.menu = false; render(); } });
  return { render, show };
}
registerHome({ mount: mountHome });
