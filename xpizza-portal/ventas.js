// Stats S2 — the "Ventas" page: DOM plumbing only. Every decision (periods, wording, the view model,
// the CSV allowlist) lives in ventas-logic.js, which node can test; this file builds nodes from it.
//
// OWNER-ONLY, BY PROVENANCE. The page and its nav exist only after app.js announces a restaurant on
// `portal:restaurant` — and app.js announces only a rid from getMyRestaurants, which lists exactly the
// restaurants in the caller's OWNER index (staff and dispatchers get []). No announcement, no nav, and
// getSalesStats is never called. The server is the authority regardless: getSalesStats answers 403
// not_owner to anyone else, and that answer is a state this page renders, not a crash.
//
// Kept OUT of app.js on purpose: app.js is the menu editor's state spine (guarded by the AST wiring
// tests); this page shares nothing with it but the two shell events.
//
// CSP: no inline styles anywhere. Layout is classes; the only CSSOM writes are chart geometry (bar
// widths, heat-cell opacity) — values computed here that no class could hold.
import { token } from './auth.js';
import { getSalesStats, fetchSalesCsv } from './api.js';
import {
  PRESETS, COMPARES, ORDERS_CSV_MAX_DAYS, rangeFor, validateCustom, defaultCompare, granularityFor, todayHN,
  rangeLabel, daysBetween, viewModel, csvHeaderOk, joinCsvPages, csvFilename, ventasMessage,
} from './ventas-logic.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const svgEl = (tag, attrs) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  return e;
};
const icon = (d) => { const s = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }); s.append(svgEl('path', { d })); return s; };
// Copy note: a "(" right after a word inside a string is written \u0028 — the same character at runtime,
// but the wiring guard's call scanner (which reads source text) would otherwise take `diario (` for a call.
const DOWNLOAD = 'M12 4v11M7 10l5 5 5-5M5 20h14';

const S = {
  uid: undefined,     // the signed-in person; any change ends every Ventas world
  rid: null,          // set ONLY by portal:restaurant — the owner proof
  epoch: 0,           // bumped on auth / restaurant change: a late answer for an ended context is dropped
  gen: 0,             // bumped per stats request: only the newest answer paints
  view: 'menu',
  preset: '7d', custom: null, customDraft: { from: '', to: '' }, customErr: '',
  compare: null,      // null = the period's default (defaultCompare)
  metric: 'sales',
  loading: false, body: null, err: null, shown: null,
  csvBusy: null, note: '',
};

const today = () => todayHN(Date.now());
const currentRange = () => rangeFor(S.preset, today(), S.custom);
const compareFor = (r) => S.compare || defaultCompare(r);

// ── the gate: nav + view ────────────────────────────────────────────────────────────────────────
function setGate(owner) {
  $('navbiz').classList.toggle('hidden', !owner);
  $('navventas').classList.toggle('hidden', !owner);
  $('mnav').classList.toggle('show', owner);
  if (!owner) showView('menu');
}

function showView(view) {
  if (view === 'ventas' && !S.rid) return;                       // never without the owner proof
  S.view = view;
  const v = view === 'ventas';
  $('viewmenu').classList.toggle('hidden', v);
  $('viewventas').classList.toggle('hidden', !v);
  // the menu editor's review bar belongs to Productos (the mockup has none here); app.js's .show is untouched
  $('app').classList.toggle('vview', v);
  for (const [id, on] of [['navprod', !v], ['navventas', v], ['mnprod', !v], ['mnventas', v]]) {
    const n = $(id);
    n.classList.toggle('on', on);
    if (on) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current');
  }
  if (v) { buildPage(); load(); }
}

document.addEventListener('portal:auth', (e) => {
  // EVERY auth event closes the page. A signed-in owner is re-announced right after (portal:signed-in →
  // getMyRestaurants → portal:restaurant); anyone else never is.
  S.uid = e && e.detail ? e.detail.uid : null;
  S.rid = null; S.epoch += 1; S.gen += 1;
  S.body = null; S.err = null; S.shown = null; S.loading = false; S.csvBusy = null; S.note = '';
  setGate(false);
  $('viewventas').replaceChildren();
});

document.addEventListener('portal:restaurant', (e) => {
  const rid = e && e.detail ? e.detail.rid : null;
  if (!rid) return;
  S.rid = rid; S.epoch += 1;
  S.body = null; S.err = null; S.shown = null; S.csvBusy = null; S.note = '';
  setGate(true);
  if (S.view === 'ventas') { buildPage(); load(); }
});

const navprod = $('navprod');
const navventas = $('navventas');
const mnprod = $('mnprod');
const mnventas = $('mnventas');
navprod.addEventListener('click', () => showView('menu'));
navventas.addEventListener('click', () => showView('ventas'));
mnprod.addEventListener('click', () => showView('menu'));
mnventas.addEventListener('click', () => showView('ventas'));

// ── data ────────────────────────────────────────────────────────────────────────────────────────
async function load() {
  const range = currentRange();
  const gen = ++S.gen;
  if (!S.rid || !range) { S.loading = false; S.body = null; S.err = null; paintBody(); return; }
  const rid = S.rid, compare = compareFor(range);
  S.loading = true; S.err = null; paintBody();
  let body = null, err = null;
  try {
    body = await getSalesStats({ rid, from: range.from, to: range.to, granularity: granularityFor(range), compare, token });
  } catch (e2) { err = e2; }
  if (gen !== S.gen || rid !== S.rid) return;                    // a newer request or context won
  S.loading = false; S.body = body; S.err = err;
  S.shown = body ? { range, compare } : null;
  paintBody();
}

// Fetch → verify the header against the allowlist → save. The orders CSV comes in pages; they are
// joined into ONE file (header once). A file whose header is not EXACTLY the reviewed columns is not
// saved: the server's allowlist changed, and nothing unreviewed reaches a merchant's disk.
async function exportCsv(kind) {
  const range = currentRange();
  if (!S.rid || !range || S.csvBusy) return;
  if (kind === 'orders' && daysBetween(range.from, range.to) + 1 > ORDERS_CSV_MAX_DAYS) {
    S.note = `El detalle de pedidos se descarga de hasta ${ORDERS_CSV_MAX_DAYS} días por vez. Elegí un período más corto.`;
    paintHeader();
    return;
  }
  const epoch = S.epoch, rid = S.rid;
  S.csvBusy = kind; S.note = ''; paintHeader();
  let note = '';
  try {
    const pages = [];
    let cursor, name = null;
    for (let page = 0; ; page++) {
      if (page >= 200) throw Object.assign(new Error('too_many_pages'), { kind: 'Unavailable' });
      const r = await fetchSalesCsv({ rid, from: range.from, to: range.to, kind, cursor, token });
      if (!csvHeaderOk(kind, r.text)) throw Object.assign(new Error('csv_header'), { kind: 'CsvHeader' });
      pages.push(r.text);
      name = name || r.filename;
      if (kind !== 'orders' || !r.nextCursor) break;
      cursor = r.nextCursor;
    }
    if (epoch !== S.epoch) return;                               // signed out / switched restaurant mid-download
    save(kind === 'orders' ? joinCsvPages(pages) : pages[0], name || csvFilename(kind, rid, range));
  } catch (e2) {
    if (epoch !== S.epoch) return;
    note = e2 && e2.kind === 'CsvHeader'
      ? 'No pudimos preparar el archivo. Avisanos y lo revisamos.'
      : ventasMessage(e2 && e2.kind, e2 && e2.code).join('. ');
  } finally {
    if (epoch === S.epoch) { S.csvBusy = null; S.note = note; paintHeader(); }
  }
}

function save(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = el('a', 'hidden');
  a.href = url; a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ── page skeleton (header + period row stay; the body repaints) ─────────────────────────────────
let refs = null;

function buildPage() {
  const main = $('viewventas');
  const head = el('div', 'vhead');
  const titles = el('div');
  const h1 = el('h1', null, 'Ventas');
  h1.id = 'vtitle';
  const lede = el('p', 'lede');
  titles.append(h1, lede);
  const acts = el('div', 'vacts');
  const daily = el('button', 'btn');
  daily.type = 'button';
  daily.append(icon(DOWNLOAD), el('span', null, 'Resumen diario \u0028CSV)'));
  daily.addEventListener('click', () => exportCsv('daily'));
  const orders = el('button', 'btn accent');
  orders.type = 'button';
  orders.append(icon(DOWNLOAD), el('span', null, 'Pedidos \u0028CSV)'));
  orders.addEventListener('click', () => exportCsv('orders'));
  acts.append(daily, orders);
  head.append(titles, acts);
  const note = el('p', 'vcsvnote hidden');
  note.setAttribute('role', 'status');

  const period = el('div', 'vperiod');
  const presets = el('div', 'vpresets');
  presets.setAttribute('role', 'group');
  presets.setAttribute('aria-label', 'Período');
  const presetBtns = {};
  for (const [key, label] of PRESETS) {
    const pb = el('button', 'vpre', label);
    pb.type = 'button';
    pb.addEventListener('click', () => pickPreset(key));
    presetBtns[key] = pb;
    presets.append(pb);
  }
  const right = el('div', 'vrange');
  const rl = el('span', 'vrl');
  const custom = el('div', 'vcustom hidden');
  const from = el('input', 'vdate'), to = el('input', 'vdate');
  for (const [inp, lab, k] of [[from, 'Desde', 'from'], [to, 'Hasta', 'to']]) {
    inp.type = 'date';
    inp.setAttribute('aria-label', lab);
    inp.addEventListener('change', () => { S.customDraft[k] = inp.value; applyCustom(); });
  }
  const cerr = el('span', 'vcerr');
  custom.append(from, to, cerr);
  const sl = el('label', 'vsr', 'Comparar con');
  sl.setAttribute('for', 'vcmp');
  const sel = el('select', 'vsel');
  sel.id = 'vcmp';
  for (const [v, label] of COMPARES) { const o = el('option', null, label); o.value = v; sel.append(o); }
  sel.addEventListener('change', () => { S.compare = sel.value; load(); });
  right.append(rl, custom, sl, sel);
  period.append(presets, right);

  const body = el('div');
  main.replaceChildren(head, note, period, body);
  refs = { lede, daily, orders, note, presetBtns, rl, custom, from, to, cerr, sel, body };
  paintHeader();
}

function pickPreset(key) {
  S.preset = key; S.compare = null; S.customErr = '';
  if (key !== 'custom') S.custom = null;
  load();
}

function applyCustom() {
  const { from, to } = S.customDraft;
  if (!from || !to) { S.customErr = ''; paintHeader(); return; }
  const v = validateCustom(from, to, today());
  S.customErr = v.ok ? '' : v.error;
  S.custom = v.ok ? v.range : null;
  load();
}

function paintHeader() {
  if (!refs) return;
  const range = currentRange();
  const name = ($('shopname') && $('shopname').textContent) || '';
  refs.lede.textContent = `Cómo se está vendiendo ${name && name !== '—' ? name : 'tu local'} en el período que elijas.`;
  for (const [key, b] of Object.entries(refs.presetBtns)) {
    b.classList.toggle('vpon', key === S.preset);
    b.setAttribute('aria-pressed', key === S.preset ? 'true' : 'false');
  }
  const isCustom = S.preset === 'custom';
  refs.rl.textContent = rangeLabel(range);
  refs.custom.classList.toggle('hidden', !isCustom);
  if (isCustom) {
    const t = today();
    refs.from.max = t; refs.to.max = t;
    refs.from.value = S.customDraft.from; refs.to.value = S.customDraft.to;
    refs.cerr.textContent = S.customErr;
  }
  refs.sel.value = range ? compareFor(range) : (S.compare || 'previous');
  refs.daily.disabled = !!S.csvBusy || !range;
  refs.orders.disabled = !!S.csvBusy || !range;
  refs.note.textContent = S.csvBusy ? 'Preparando el archivo…' : S.note;
  refs.note.classList.toggle('hidden', !(S.csvBusy || S.note));
  refs.note.classList.toggle('verr', !S.csvBusy && !!S.note);
}

// ── body ────────────────────────────────────────────────────────────────────────────────────────
function emptyBox(title, detail) {
  const e = el('div', 'empty');
  e.append(el('b', null, title), el('span', null, detail));
  return e;
}

function paintBody() {
  if (!refs) return;
  paintHeader();
  const body = refs.body;
  const range = currentRange();
  if (!range) { body.replaceChildren(emptyBox('Elegí las fechas', 'Desde y hasta, en un período de hasta dos años.')); return; }
  if (S.loading) { body.replaceChildren(emptyBox('Cargando ventas…', 'Un momento.')); return; }
  if (S.err) { const [t, d] = ventasMessage(S.err.kind, S.err.code); body.replaceChildren(emptyBox(t, d)); return; }
  if (!S.body || !S.shown) { body.replaceChildren(); return; }
  const vm = viewModel(S.body, { range: S.shown.range, compare: S.shown.compare, metric: S.metric, nowMs: Date.now() });
  const parts = [kpiRow(vm)];
  if (vm.empty) parts.push(emptyBox('Sin ventas en este período', 'Probá con otro período.'));
  else parts.push(trendCard(vm), mixGrid(vm), heatSection(vm), tailGrid(vm));
  parts.push(footnote(vm));
  body.replaceChildren(...parts);
}

function kpiRow(vm) {
  const row = el('div', 'vkpis');
  for (const k of vm.kpis) {
    const cell = el('div', 'vkpi');
    cell.append(el('div', 'vklabel', k.label), el('div', 'vkval', k.value));
    if (k.showDelta) {
      const foot = el('div', 'vkfoot');
      const pill = el('span', 'vdl');
      pill.classList.add(k.up ? 'vup' : k.down ? 'vdn' : 'vflat');
      if (k.up) pill.append(icon('M12 19V5M6 11l6-6 6 6'));
      if (k.down) pill.append(icon('M12 5v14M6 13l6 6 6-6'));
      pill.append(document.createTextNode(k.text));
      foot.append(pill, el('span', 'vvs', k.vs));
      cell.append(foot);
    }
    row.append(cell);
  }
  return row;
}

function trendCard(vm) {
  const card = el('section', 'vcard');
  const head = el('div', 'vcardhead');
  const tabs = el('div', 'tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Métrica del gráfico');
  for (const [m, label] of [['sales', 'Ventas'], ['orders', 'Pedidos']]) {
    const tb = el('button', 'tab', label);
    tb.type = 'button';
    tb.setAttribute('role', 'tab');
    tb.setAttribute('aria-selected', S.metric === m ? 'true' : 'false');
    tb.classList.toggle('on', S.metric === m);
    tb.addEventListener('click', () => { if (S.metric === m) return; S.metric = m; paintBody(); focusTab(m); });
    tb.dataset.metric = m;
    tabs.append(tb);
  }
  const legend = el('div', 'vlegend');
  const lc = el('span', 'vlg');
  lc.append(el('span', 'vlgcur'), document.createTextNode('Período actual'));
  legend.append(lc);
  if (vm.showCompare) {
    const lp = el('span', 'vlg');
    lp.append(el('span', 'vlgcmp'), document.createTextNode('Comparación'));
    legend.append(lp);
  }
  head.append(tabs, legend);

  const chart = svgEl('svg', { class: 'vchart', viewBox: '0 0 1000 260', preserveAspectRatio: 'none', role: 'img', 'aria-label': vm.chart.aria });
  for (const y of [65, 130, 195]) chart.append(svgEl('line', { class: 'vgl', x1: '0', y1: String(y), x2: '1000', y2: String(y) }));
  chart.append(svgEl('line', { class: 'vaxis', x1: '0', y1: '259', x2: '1000', y2: '259' }));
  if (vm.showCompare) chart.append(svgEl('polyline', { class: 'vlcmp', points: vm.chart.prev }));
  chart.append(svgEl('polyline', { class: 'vlcur', points: vm.chart.cur }));
  const xl = el('div', 'vxl');
  for (const t of vm.chart.xLabels) xl.append(el('span', null, t));
  card.append(head, chart, xl);
  return card;
}

function focusTab(m) {
  const tabs = refs && refs.body.querySelectorAll ? refs.body.querySelectorAll('.tab') : [];
  for (const t of tabs) if (t.dataset && t.dataset.metric === m && typeof t.focus === 'function') t.focus();
}

function bar(width, extra) {
  const track = el('div', extra ? `vtrack ${extra}` : 'vtrack');
  const fill = el('div', 'vfill');
  fill.style.width = `${width}%`;                                 // chart geometry (CSSOM, CSP-safe)
  track.append(fill);
  return track;
}

function section(title) {
  const s = el('section', 'vsec');
  s.append(el('h2', 'vh2', title));
  return s;
}
// the three short blocks under the heatmap: same section, a tighter heading gap (mockup 14px, not 16px)
function sectionTight(title) {
  const s = el('section', 'vsec');
  s.append(el('h2', 'vh2 vh2s', title));
  return s;
}

function mixGrid(vm) {
  const grid = el('div', 'vgrid2');

  const top = section('Productos más vendidos');
  const list = el('div', 'vitems');
  if (!vm.topItems.length) list.append(el('span', 'vsub', 'Sin productos en este período.'));
  for (const it of vm.topItems) {
    const row = el('div');
    const line = el('div', 'virow');
    const meta = el('span', 'vimeta');
    meta.append(document.createTextNode(`${it.qty} · `), el('strong', null, it.amount));
    line.append(el('span', 'viname', it.name), meta);
    row.append(line, bar(it.width));
    list.append(row);
  }
  top.append(list);

  const col = el('div', 'vcol');
  const types = section('Entrega y recogida');
  const split = el('div', 'vsplit');
  split.setAttribute('aria-hidden', 'true');
  const [dl, pk] = vm.typeSplit;
  const s1 = el('div', 'vs1'), s2 = el('div', 'vs2');
  s1.style.width = `${dl.share}%`;                                // chart geometry
  s2.style.width = `${pk.share}%`;
  split.append(s1, s2);
  const two = el('div', 'v2col');
  for (const t of vm.typeSplit) {
    const c = el('div');
    c.append(el('div', 'vsub', t.label), el('div', 'vbig', `${t.share}% · ${t.amount}`));
    two.append(c);
  }
  types.append(split, two);

  const pays = section('Forma de pago');
  const pl = el('div', 'vpays');
  for (const p of vm.payments) {
    const r = el('div', 'vpay');
    r.append(el('span', 'vplabel', p.label), bar(p.width, 'vgrow'), el('span', 'vpval', p.value));
    pl.append(r);
  }
  pays.append(pl);
  col.append(types, pays);
  grid.append(top, col);
  return grid;
}

function heatSection(vm) {
  const s = el('section', 'vsec');
  s.classList.add('vmb');
  const head = el('div', 'vheathead');
  head.append(el('h2', 'vh2 vh20', 'Horas de más pedidos'), el('span', 'vnote', vm.peakNote));
  const scroll = el('div', 'vscroll');
  const table = el('table', 'vtable');
  table.append(el('caption', 'vsr', 'Pedidos por día de la semana y hora'));
  const thead = el('thead'), hr = el('tr');
  const corner = el('th', 'vthd');
  corner.setAttribute('scope', 'col');
  corner.append(el('span', 'vsr', 'Día'));
  hr.append(corner);
  for (const h of vm.hours) { const th = el('th', 'vth', String(h)); th.setAttribute('scope', 'col'); hr.append(th); }
  thead.append(hr);
  const tbody = el('tbody');
  for (const row of vm.heat) {
    const tr = el('tr');
    const th = el('th', 'vthr', row.day);
    th.setAttribute('scope', 'row');
    tr.append(th);
    for (const c of row.cells) {
      const td = el('td', 'vhc');
      td.style.opacity = c.alpha.toFixed(2);                      // chart geometry: the cell's intensity
      td.append(el('span', 'vsr', c.label));
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  scroll.append(table);
  s.append(head, scroll);
  return s;
}

function tailGrid(vm) {
  const grid = el('div', 'vgrid3');

  const cust = sectionTight('Clientes');
  const two = el('div', 'v2col vgap14');
  for (const c of vm.customers) {
    const d = el('div');
    d.append(el('div', 'vklabel', c.label), el('div', 'vcnum', c.value), el('div', 'vcsub', c.share));
    two.append(d);
  }
  cust.append(two);

  const canc = sectionTight('Cancelaciones');
  const rows = el('div', 'vrows');
  for (const r of vm.cancellations.rows) {
    const line = el('div', 'vrow');
    const k = el('span', 'vrk', r.label), v = el('span', 'vrv', r.value);
    if (r.warn) { k.classList.add('vwarn'); v.classList.add('vwarn'); }
    line.append(k, v);
    rows.append(line);
  }
  canc.append(el('div', 'vcrate', vm.cancellations.rate), rows);

  const times = sectionTight('Tiempos');
  const tl = el('div', 'vtimes');
  for (const t of vm.times.rows) {
    const line = el('div', 'vtrow');
    const val = el('span', 'vtval');
    val.append(el('strong', null, t.value));
    if (t.typical) val.append(document.createTextNode(' '), el('span', 'vmuted', `· ${t.typical}`));
    line.append(el('span', 'vmuted', t.label), val);
    tl.append(line);
  }
  if (vm.times.coverage) tl.append(el('div', 'vcov', vm.times.coverage));
  times.append(tl);

  grid.append(cust, canc, times);
  return grid;
}

function footnote(vm) {
  let t = 'Una venta se cuenta cuando el pedido se registra \u0028efectivo o tarjeta al entregar) o cuando el pago en línea se confirma, en el día en que se sirve. Los últimos 7 días se recalculan cada noche.';
  if (vm.updated) t += ` Actualizado: ${vm.updated}.`;
  if (vm.missing) t += ` Aún sin calcular: ${vm.missing}.`;
  return el('p', 'vfoot', t);
}
