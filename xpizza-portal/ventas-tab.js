// «Ventas» — the tab, slice V1 (PLAN-portal-ventas-draw-r0; MOCKUP-portal-rendimiento-ventas-delta frames 0/1/2/3/3b/5/6/7/7b/8/9/10/12,
// owner-APPROVED 11-14; Nav B: the page IS «Ventas», the shipped lede kept — advisor Q-V1). DOM over rend-logic.js (the model) and
// rend-data.js (ONE call per load — «Todas» = the server-merged multi read; the session cache paints first with its OWN freshness,
// then a silent revalidate). ventas.js keeps its nav / auth / restaurant handling and hands the page here (its fold layer).
// V2 «Personalizado» (frame 4): Desde / Hasta on THE portal calendar (portal-calendar.js); the body untouched until a valid pair.
// ABSENT until its slice: «Ver más detalle» (V3).
import { el, svg } from './ops-dom.js';
import { getSalesStats, getSalesStatsMulti, getMyBranches } from './api.js';
import { todayHN, validateCustom, ventasMessage } from './ventas-logic.js';
import { calendarPopover } from './portal-calendar.js';
import * as RL from './rend-logic.js';
import * as RD from './rend-data.js';

const NS = 'http://www.w3.org/2000/svg';
const DOWN = 'M6 9l6 6 6-6', CHART = 'M4 19V5M4 19h16M8 15l4-5 3 3 5-6', CAL = 'M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z';
const WD3 = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'], MON3 = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const longDay = (d) => `${WD3[new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))).getUTCDay()]} ${+d.slice(8, 10)} ${MON3[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
const BOUNDS = 'Elegí las fechas · hasta dos años, hasta hoy';
const BAD = ventasMessage('BadRequest');   // the shipped line: [«Ese período no es válido», «Elegí otras fechas.»]
const BAD_LINE = `${BAD[0]} · ${String(BAD[1]).replace(/\.$/, '')}`;
const PRESETS = RL.REND_PRESETS;   // Hoy · 7 · 14 · 30 · Personalizado (Q2)
const API = { getSalesStats, getSalesStatsMulti };
const S = { host: null, ctx: null, gen: 0, preset: RL.REND_DEFAULT_PRESET, branch: 'all', branches: [], menu: null,
  status: 'loading', body: null, freshAt: null, dim: false, failed: null, cache: null, custom: { from: null, to: null }, cal: null, cerr: '' };
const now = () => (S.ctx && S.ctx.now ? S.ctx.now() : Date.now());
const today = () => todayHN(now());
// the requested range: a preset's, or a VALID custom pair (else null — nothing is requested)
function range() {
  if (S.preset !== 'custom') return RL.rendRangeFor(S.preset, today());
  const v = S.custom.from && S.custom.to ? validateCustom(S.custom.from, S.custom.to, today()) : null;
  return v && v.ok ? v.range : null;
}
const rids = () => (S.branch === 'all' ? S.branches.map((b) => b.rid) : [S.branch]);

// ctx: { uid, rid, name, token, now? } — the page's restaurant (the owner proof ventas.js holds)
export function mountVentasTab(host, ctx) {
  S.gen += 1; S.host = host; S.ctx = ctx; S.menu = null; S.dim = false; S.failed = null;
  if (!S.cache) { try { S.cache = RD.makeCache(sessionStorage); } catch (_) { S.cache = null; } }
  if (!S.branches.length || S.branches[0].rid !== ctx.rid && !S.branches.some((b) => b.rid === ctx.rid)) { S.branches = [{ rid: ctx.rid, name: ctx.name || '' }]; S.branch = 'all'; }
  render();
  branchesOf(S.gen).then(() => load());
}
export function unmountVentasTab() { S.gen += 1; S.host = null; S.menu = null; }
document.addEventListener('portal:auth', () => { S.gen += 1; S.branches = []; S.branch = 'all'; S.body = null; S.status = 'loading'; S.preset = RL.REND_DEFAULT_PRESET; });

// the restaurant's branches the owner reads sales for (getMyBranches), the page's own first; one only ⇒ no branch pill
async function branchesOf(g) {
  let e1 = null;
  try { e1 = await getMyBranches({ token: S.ctx.token }); } catch (_) { /* the page's own restaurant only */ }
  if (g !== S.gen || !e1 || !Array.isArray(e1.branches)) return;
  const me = e1.branches.find((b) => b && b.rid === S.ctx.rid);
  if (!me) return;
  const list = e1.branches.filter((b) => b && b.brand_id === me.brand_id && b.state === 'member' && b.role === 'owner' && Array.isArray(b.caps) && b.caps.includes('stats.read'));
  if (list.length) S.branches = list.map((b) => ({ rid: b.rid, name: b.name || b.rid }));
}

async function load() {
  if (!S.host) return;
  const g = S.gen;
  const r = range();
  if (!r) { render(); return; }   // «Personalizado» without a valid pair: nothing is requested, the body untouched
  if (S.body) S.dim = true; else S.status = 'loading';
  render();
  await RD.loadStats({ uid: S.ctx.uid, rids: rids(), range: r, compare: 'none', token: S.ctx.token, api: API, cache: S.cache, now, ui: {
    paint: ({ body, freshAt }) => { if (g !== S.gen) return; S.body = body; S.freshAt = freshAt; S.status = RL.statsState({ body }).state; S.failed = null; S.dim = false; S.range = r; render(); },
    stamp: ({ freshAt }) => { if (g !== S.gen) return; S.freshAt = freshAt; S.dim = false; S.range = r; render(); },
    fail: ({ error, hasBody }) => { if (g !== S.gen) return; S.dim = false; if (!hasBody) { S.body = null; S.status = RL.statsState({ error }).state; S.failed = S.branch; } render(); },
  } }).catch(() => { if (g === S.gen) { S.status = 'error'; S.body = null; S.dim = false; render(); } });
}
function pick(kind, v) {
  S.menu = null;
  if (kind === 'preset' && v === 'custom' && S.preset !== 'custom') { S.preset = 'custom'; S.custom = { from: null, to: null }; S.cerr = ''; S.cal = null; render(); return; }
  if (kind === 'preset' && v !== S.preset) { S.preset = v; S.cerr = ''; S.cal = null; S.gen += 1; load(); return; }
  if (kind === 'branch' && v !== S.branch) { S.branch = v; S.gen += 1; load(); return; }
  render();
}
document.addEventListener('click', (e) => {
  if (!S.host || (!S.menu && !S.cal)) return;
  if (e.target && e.target.closest && (e.target.closest('.vd-kebab') || e.target.closest('.vd-dp'))) return;
  S.menu = null; S.cal = null; render();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.host && (S.menu || S.cal)) { S.menu = null; S.cal = null; render(); } });
// a day picked on the calendar: a valid pair loads; a pair past two years says the shipped line (no request)
function pickDate(which, d) {
  S.cal = null;
  if (which === 'from') { S.custom.from = d; if (S.custom.to && S.custom.to < d) S.custom.to = null; }
  else S.custom.to = d;
  S.cerr = '';
  if (S.custom.from && S.custom.to) {
    const v = validateCustom(S.custom.from, S.custom.to, today());
    if (!v.ok) { S.cerr = BAD_LINE; render(); return; }
    S.gen += 1; load(); return;
  }
  render();
}
function openCal(which) {
  if (S.cal && S.cal.which === which) { S.cal = null; render(); return; }
  const base = (which === 'to' && S.custom.from) || S.custom[which] || today();
  S.cal = { which, y: +base.slice(0, 4), m: +base.slice(5, 7) - 1, hover: null };
  S.menu = null; render();
}
function dateRange() {
  const t = today(), y = +t.slice(0, 4);
  const box = el('div', 'vd-prange');
  for (const [which, label] of [['from', 'Desde'], ['to', 'Hasta']]) {
    const fld = el('div', 'vd-fld'); fld.append(el('span', 'vd-flab', label));
    const dp = el('div', 'vd-dp');
    const v = S.custom[which];
    const b = el('button', 'vd-dpbtn'); b.type = 'button'; b.setAttribute('aria-haspopup', 'dialog'); b.setAttribute('aria-expanded', S.cal && S.cal.which === which ? 'true' : 'false');
    b.append(el('span', v ? 'vd-dpv' : 'vd-dpv vd-ph', v ? longDay(v) : 'Elegí una fecha'), svg(CAL));
    b.addEventListener('click', () => openCal(which));
    dp.append(b);
    if (S.cal && S.cal.which === which) {
      const c = S.cal;
      const min = which === 'to' && S.custom.from ? S.custom.from : `${y - 2}-01-01`;
      const st = { y: c.y, m: c.m, min, max: t, today: t, sel: v, from: S.custom.from, to: which === 'to' ? null : S.custom.to, hover: which === 'to' ? c.hover : null, years: [y - 2, y - 1, y] };
      dp.append(calendarPopover(st, {
        nav: (dir) => { c.m += dir; if (c.m < 0) { c.m = 11; c.y -= 1; } if (c.m > 11) { c.m = 0; c.y += 1; } render(); },
        month: (m) => { c.m = m; render(); }, year: (yy) => { c.y = yy; render(); },
        pick: (d) => pickDate(which, d), hover: which === 'to' ? (d) => { if (c.hover !== d) { c.hover = d; render(); } } : null,
      }, which === 'from' ? 'Elegir la fecha de inicio' : 'Elegir la fecha de fin'));
    }
    fld.append(dp); box.append(fld);
  }
  if (S.cerr) { const e = el('p', 'vd-cerr', S.cerr); e.setAttribute('role', 'alert'); box.append(e); }
  return box;
}

// ── render ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function render() {
  if (!S.host) return;
  const name = (S.ctx && S.ctx.name) || (document.getElementById('shopname') && document.getElementById('shopname').textContent) || '';
  const top = el('div', 'top');
  const t = el('div'); const h1 = el('h1', null, 'Ventas'); h1.id = 'vtitle';
  t.append(h1, el('p', 'lede', `Cómo se está vendiendo ${name && name !== '—' ? name : 'tu local'} en el período que elijas.`));   // the shipped lede (Q-V1)
  top.append(t);
  const out = [top, filters()];
  if (S.preset === 'custom') out.push(dateRange());
  const body = el('div', `vd-body${S.dim ? ' vd-dim' : ''}`);
  const st = S.status;
  body.append(figures(st));
  if (st === 'loading') body.append(chartCard(null, true), products(null));
  else if (st === 'ok') body.append(chartCard(S.body, false), products(S.body));
  else if (st === 'empty') body.append(emptyCard());
  else body.append(errCard());
  out.push(body);
  S.host.replaceChildren(...out);
  const svgEl = S.host.querySelector('.vd-chart');
  if (svgEl) drawChart(svgEl, st === 'loading' ? null : RL.chartModel(S.body, { range: S.range || range(), nowMs: now() }));   // the body's OWN range (a dimmed body keeps it)
}
function pill(id, label, on, options, chosen, onPick) {
  const k = el('div', 'vd-kebab');
  const b = el('button', `vd-pill vd-dd${on ? ' vd-on' : ''}`); b.type = 'button';
  b.setAttribute('aria-haspopup', 'listbox'); b.setAttribute('aria-expanded', S.menu === id ? 'true' : 'false');
  b.append(el('span', null, label), svg(DOWN));
  b.addEventListener('click', () => { S.menu = S.menu === id ? null : id; render(); });
  const m = el('div', `vd-menu${S.menu === id ? ' vd-show' : ''}`); m.setAttribute('role', 'listbox');
  for (const [v, word] of options) {
    const o = el('button', 'vd-opt'); o.type = 'button'; o.setAttribute('role', 'option'); o.setAttribute('aria-selected', v === chosen ? 'true' : 'false'); o.dataset.v = v;
    o.append(el('span', null, word)); if (v === chosen) o.append(el('i', 'vd-seldot'));   // a real element (no colour on a pseudo-element)
    o.addEventListener('click', () => onPick(v));
    m.append(o);
  }
  k.append(b, m);
  return k;
}
function filters() {
  const f = el('div', 'vd-filt'); f.setAttribute('role', 'group'); f.setAttribute('aria-label', 'Filtros');
  f.append(pill('per', RL.pillWords(S.preset, range(), today()), true, PRESETS, S.preset, (v) => pick('preset', v)));   // a period is always chosen: filled
  if (S.branches.length > 1) {
    const opts = [['all', 'Todas las sucursales'], ...S.branches.map((b) => [b.rid, b.name])];
    const cur = opts.find(([v]) => v === S.branch) || opts[0];
    f.append(pill('br', cur[1], S.branch !== 'all', opts, S.branch, (v) => pick('branch', v)));
  }
  f.append(el('span', 'vd-rl', range() ? RL.rangeWords(range()) : BOUNDS));
  return f;
}
function figures(st) {
  const box = el('div', 'vd-figs');
  const rows = st === 'loading' ? [['Ventas', null], ['Pedidos', null], ['Ticket promedio', null]] : RL.figures(S.body, st);
  for (const [label, value] of rows) {
    const f = el('div', 'vd-fig'); const n = el('div', 'vd-kn');
    if (value === null) n.append(el('span', 'vd-sk vd-skn')); else n.textContent = value;
    f.append(el('div', 'vd-kl', label), n); box.append(f);
  }
  return box;
}
function chartCard(body, loading) {
  const m = loading ? null : RL.chartModel(body, { range: S.range || range(), nowMs: now() });
  const c = el('div', 'vd-card');
  const hd = el('div', 'vd-cardhead'); const d = el('div');
  d.append(el('h2', 'vd-h2', loading ? RL.chartModel({}, { range: range() || S.range, nowMs: now() }).title : m.title));
  const fr = el('div', 'vd-fresh');
  if (loading) fr.append(el('span', 'vd-sk vd-skfresh')); else fr.textContent = RL.freshWords(body, { fetchedAt: S.freshAt || now(), nowMs: now() }) || '';
  d.append(fr); hd.append(d); c.append(hd);
  const wrap = el('div', 'vd-chartwrap');
  const s = document.createElementNS(NS, 'svg'); s.setAttribute('class', 'vd-chart'); s.setAttribute('role', 'img');
  s.setAttribute('aria-label', `${m ? m.title : 'Ventas'}, ${RL.rangeWords(S.range || range())}`);
  wrap.append(s, el('div', 'vd-tip'));
  c.append(wrap, el('div', 'vd-xl'));
  const note = !loading && body ? RL.missingNote(body.missing_days) : '';
  if (note) { const n = el('div', 'vd-note'); n.append(el('span', 'vd-notemk'), el('span', null, note)); c.append(n); }
  return c;
}
function products(body) {
  const out = el('div', 'vd-prods');
  const sect = el('div', 'vd-sect'); sect.append(el('h2', null, 'Productos más vendidos')); out.append(sect);
  const h = el('div', 'vd-row vd-rowh'); h.append(el('span', null, 'Producto'), el('span', 'vd-hnum vd-hnump', RL.TOP_QTY_LABEL), el('span', 'vd-hnum', 'Ventas')); out.append(h);
  if (!body) {
    for (let i = 0; i < 5; i++) {   // reserved heights: nothing moves when the body lands
      const r = el('div', 'vd-row'); const n = el('div', 'vd-n'); const sk = el('span', 'vd-sk'); sk.style.width = `${150 + ((i * 37) % 70)}px`;
      n.append(sk, el('div', 'vd-track'));
      const p = el('span', 'vd-num vd-nump'); p.append(el('span', 'vd-sk vd-skq'));
      const v = el('span', 'vd-num vd-numv'); v.append(el('span', 'vd-sk vd-skv'));
      r.append(n, p, v); out.append(r);
    }
    return out;
  }
  const rows = RL.topProducts(body);
  if (!rows.length) { out.append(el('p', 'vd-none', 'Sin productos en este período.')); return out; }   // the shipped copy
  for (const x of rows) {
    const r = el('div', 'vd-row'); const n = el('div', 'vd-n', x.name);
    const tr = el('div', 'vd-track'); const fl = el('div', 'vd-fill'); fl.style.width = `${x.width}%`; tr.append(fl); n.append(tr);
    r.append(n, el('span', 'vd-num vd-nump', x.qty), el('span', 'vd-num vd-numv', x.sales)); out.append(r);
  }
  return out;
}
function emptyCard() {
  const c = el('div', 'vd-ok'); const i = el('span', 'vd-rico'); i.append(svg(CHART));
  const t = el('div'); t.append(el('b', null, 'Sin ventas en este período'), el('span', null, 'Probá con otro período.'));   // the shipped copy
  c.append(i, t); return c;
}
function errCard() {
  const c = el('div', 'vd-ok vd-err'); c.setAttribute('role', 'alert');
  c.append(el('b', null, 'No pudimos cargar las ventas'), el('span', null, 'Es un problema nuestro, no tuyo. Probá de nuevo en un momento.'));
  const all = S.branch === 'all' && S.branches.length > 1;
  if (all) c.append(el('span', null, 'Como una de tus sucursales no respondió, no mostramos un total parcial de «Todas las sucursales».'));
  const acts = el('div', 'vd-acts');
  const re = el('button', 'btn', 'Reintentar'); re.type = 'button'; re.addEventListener('click', () => { S.gen += 1; load(); });
  acts.append(re);
  if (all) { const l = el('button', 'vd-lnk', 'Ver una sucursal'); l.type = 'button'; l.addEventListener('click', (e) => { e.stopPropagation(); S.menu = 'br'; render(); }); acts.append(l); }
  c.append(acts);
  return c;
}

// ── the chart (the mockup's drawChart, from the model; its geometry only — every value is the server's) ──────────────────────
function line(cls, x1, y1, x2, y2) { const n = document.createElementNS(NS, 'line'); n.setAttribute('class', cls); n.setAttribute('x1', x1); n.setAttribute('y1', y1); n.setAttribute('x2', x2); n.setAttribute('y2', y2); return n; }
function drawChart(s, m) {
  const W = Math.max(300, Math.round(s.clientWidth || 640)), H = Math.round(s.clientHeight || 240);
  s.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const kids = [];
  const ticks = m ? m.ticks : [0, 1, 2, 3, 4];
  const ymax = m ? m.ymaxCents : 4;
  const lab = m ? `L ${(ymax / 100).toLocaleString('en-US')}` : '';
  const L = m ? Math.round(14 + lab.length * 6.4) : 20, R = W < 480 ? 8 : 12, T = 14, B = 18;
  const n = m ? m.buckets.length : 7;
  const x = (i) => L + ((i + 0.5) * (W - L - R)) / n;
  const y = (v) => T + (H - T - B) * (1 - v / ymax);
  for (const v of ticks) {
    kids.push(line('vd-gl', L, y(v), W - R, y(v)));
    if (m) { const t = document.createElementNS(NS, 'text'); t.setAttribute('class', 'vd-yl'); t.setAttribute('x', L - 8); t.setAttribute('y', y(v) + 4); t.setAttribute('text-anchor', 'end'); t.textContent = `L ${(v / 100).toLocaleString('en-US')}`; kids.push(t); }
  }
  kids.push(line('vd-axis', L, y(0), W - R, y(0)));
  const xl = S.host.querySelector('.vd-xl');
  if (!m) { s.replaceChildren(...kids); if (xl) xl.replaceChildren(); return; }
  const cross = line('vd-cross', 0, T, 0, y(0)); kids.push(cross);
  const path = (d, cls) => { const p = document.createElementNS(NS, 'path'); p.setAttribute('class', cls); p.setAttribute('d', d); return p; };
  let seg = '', prev = null;
  m.buckets.forEach((p, i) => {
    const px = x(i).toFixed(1), py = p.cents === null ? null : y(p.cents).toFixed(1);
    if (p.k === 'ok') { seg += `${seg ? ' L' : 'M'}${px} ${py}`; prev = { i, p }; }
    else if (p.k === 'partial') {
      if (prev) kids.push(path(`M${x(prev.i).toFixed(1)} ${y(prev.p.cents).toFixed(1)} L${px} ${py}`, 'vd-line vd-dash'));
      if (seg) { kids.push(path(seg, 'vd-line')); seg = ''; }
      prev = { i, p };
    } else { if (seg) { kids.push(path(seg, 'vd-line')); seg = ''; } prev = null; }
  });
  if (seg) kids.push(path(seg, 'vd-line'));
  const dots = (W - L - R) / n >= 16;
  m.buckets.forEach((p, i) => {
    const c = document.createElementNS(NS, 'circle');
    if (p.k === 'ok' && dots) { c.setAttribute('class', 'vd-dot'); c.setAttribute('r', '4'); c.setAttribute('cx', x(i)); c.setAttribute('cy', y(p.cents)); kids.push(c); }
    else if (p.k === 'partial') { c.setAttribute('class', 'vd-dot vd-ring'); c.setAttribute('r', '5'); c.setAttribute('cx', x(i)); c.setAttribute('cy', y(p.cents)); kids.push(c); }
    else if (p.k === 'missing') { c.setAttribute('class', 'vd-miss'); c.setAttribute('r', '4'); c.setAttribute('cx', x(i)); c.setAttribute('cy', y(0)); kids.push(c); }
  });
  m.buckets.forEach((p, i) => {
    if (p.k === 'future') return;
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', x(i) - (W - L - R) / n / 2); r.setAttribute('y', 0); r.setAttribute('width', (W - L - R) / n); r.setAttribute('height', H);
    r.setAttribute('class', 'vd-hit'); r.dataset.i = String(i); kids.push(r);
  });
  s.replaceChildren(...kids);
  if (xl) {
    xl.classList.toggle('vd-sparse', m.sparse);
    const shown = RL.shownLabels(n, W < 480 ? 5 : 8);
    xl.replaceChildren(...m.buckets.map((p, i) => el('span', p.k === 'missing' ? 'vd-xmiss' : p.k === 'future' ? 'vd-xfut' : null, shown.has(i) ? p.label : '')));
  }
  const tip = S.host.querySelector('.vd-tip');
  s.onmousemove = (e) => {
    const r = e.target && e.target.closest ? e.target.closest('.vd-hit') : null;
    if (!r || !tip) return;
    const i = +r.dataset.i, p = m.buckets[i];
    const bb = s.getBoundingClientRect(), wrap = s.parentNode.getBoundingClientRect();
    tip.style.left = `${bb.left + (x(i) / W) * bb.width - wrap.left}px`;
    tip.style.top = `${bb.top + (y(p.k === 'missing' ? 0 : p.cents) / H) * bb.height - wrap.top}px`;
    tip.replaceChildren(el('b', null, p.tip.strong), document.createTextNode(p.tip.rest));
    tip.classList.add('vd-tipshow');
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.classList.add('vd-crosson');
  };
  s.onmouseleave = () => { if (tip) tip.classList.remove('vd-tipshow'); cross.classList.remove('vd-crosson'); };
}
export const _ventasTabState = S;   // test-only
export const _render = () => render();   // test-only
