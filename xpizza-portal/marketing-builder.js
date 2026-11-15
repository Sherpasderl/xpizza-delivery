// Portal «Marketing» › Ofertas — the BUILDER dialog (MOCKUP-portal-marketing v5 3, owner-approved 11-14) and its review sheet (3b): a
// dialog over the Marketing page, the setting rows on the left (one open at a time), the phone preview on the right (a toggle at 390 px),
// «Revisar y programar» → «Revisá tu oferta» → «Programar oferta»; «Guardar borrador» saves a draft. Every word comes from
// marketing-logic builderText (v5's templates + PLAN-portal-marketing-O2-r0 rulings); every write's outcome from classifyWrite /
// classifyWrite (saved / refused key / unknown → the dialog closes and the LIST decides, r6.1). ABSENT per the O2 rulings: the hours phrase (Q1), the live clash
// chip + overlap note (Q2 — the server's 409 at «Programar» is the signal), the audience sub-lines (Q3), the pct / nuevos minimum,
// «Más pedido», the preview's ETA + fee, the terms sentence (Q6).
// The host (marketing.js) passes { branches, rid, brandName, token, onDone(kind) } and the shell's toast.
import { getEditableCatalogRaw, offerRepeatRaw, offerSaveRaw } from './api.js';
import { el, svg } from './ops-dom.js';
import { groupByCategory } from './render.js';
import * as ML from './marketing-logic.js';
import { focusKey, layered, trapTab, focusFirst } from './marketing-focus.js';

const X = 'M6 6l12 12M18 6L6 18', DOWN = 'M6 9l6 6 6-6', CHECK = 'M5 12l5 5L20 7', CAL = 'M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z';
const PREV = 'M15 18l-6-6 6-6', NEXT = 'M9 6l6 6-6 6', SPARK = 'M12 3v4M12 17v4M3 12h4M17 12h4', PLUS = 'M12 5v14M5 12h14', ARR = 'M5 12h14M13 6l6 6-6 6';
const ROW_ICON = Object.freeze({   // v5's 1.85-stroke line icons per row (monochrome on the card circle)
  br: ['M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6'], typ: null, prod: ['M4 7h16M4 12h16M4 17h10'], aud: ['M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21a8 8 0 0 1 16 0'],
  sch: [{ tag: 'circle', cx: 12, cy: 12, r: 9 }, 'M12 7v5l3 2'], caps: ['M4 20V10M10 20V4M16 20v-6M22 20H2'], name: ['M4 20h4L19 9l-4-4L4 16z'],
});
const SLOTS = Object.freeze([['Almuerzo', 660, 840], ['Tarde', 840, 1080], ['Cena', 1080, 1260], ['Noche', 1260, 0], ['Todo el día', null, null], ['Personalizado', 'custom', 'custom']]);
const DAY_CHIPS = [[1, 'Lun'], [2, 'Mar'], [3, 'Mié'], [4, 'Jue'], [5, 'Vie'], [6, 'Sáb'], [0, 'Dom']];
const AUD = Object.freeze([['all', 'Todos los clientes'], ['new', 'Clientes nuevos'], ['returning', 'Clientes que vuelven']]);   // Q3: titles only
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MON3 = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const WD3 = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const HN = 6 * 3600000, DAY = 86400000;
const hnDay0 = (ms) => { const d = new Date(ms - HN); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + HN; };   // 00:00 HN of ms's day
const ymd = (ms) => { const d = new Date(ms - HN); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; };
const longDate = (ms) => { const d = new Date(ms - HN); return `${WD3[d.getUTCDay()]} ${d.getUTCDate()} ${MON3[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
// v5's suggested values per type (the cards' «Ej.» lines)
const PV_NOTE = '(en la vista previa).';
const OR_REPEAT = '(o usá Repetir).';   // v5 3c's fine print ends «…creá una nueva (o usá Repetir).» — held apart for the call scanner   // v5's Nombre help ends «…de la oferta (en la vista previa).» — held apart so the call scanner never reads «oferta (» as a call
const SUGGEST = Object.freeze({ pct: { pct: 15, max: '100' }, lps: { off: '50', min: '300' }, bogo: { free_per_order: 1 }, envio: { min: '350' }, nuevos: { off: '50' } });
// the refusal keys the server answers on a save / publish, worded plainly (no v5 frame draws them: minimal, flagged to the advisor)
const REFUSAL_WORD = Object.freeze({
  overlap: (r) => `Se cruza con ${(r.with || []).map((n) => `«${n}»`).join(' y ') || 'otra oferta activa'} en esos días y horas. Un producto no puede llevar dos ofertas a la vez: cambiá el horario o los productos.`,
  too_many_live: () => 'Ya tenés el máximo de ofertas activas en una sucursal. Terminá una para programar esta.',
  stale: () => 'Esta oferta cambió mientras la editabas. Cerrá y abrila de nuevo.',
  unknown_dish: () => 'Un producto ya no está en el menú publicado de una sucursal. Quitalo y volvé a revisar.',
  menu_unavailable: () => 'No pudimos leer el menú de una sucursal. Probá de nuevo en un momento.',
  start_past: () => 'La fecha de inicio ya pasó. Elegí una fecha nueva en «Horario».',
  schedule: () => 'Por ahora no se puede cambiar el horario de una oferta activa. Guardá los topes o la fecha de fin, o terminá esta oferta y creá una nueva.',   // since 3a's widening: only a moved START (never sent by this UI)
  live_edit: () => 'Por ahora no se puede cambiar eso en una oferta activa. Terminá esta oferta y creá una nueva.',   // a locked field the server refused (the UI never sends one)
  off: () => 'Las ofertas no están disponibles en este momento.',
  not_ended: () => 'Solo se puede repetir una oferta terminada.',
  ended: () => 'Esta oferta ya terminó. Volvé a la lista para ver su estado.',
  not_programmed: () => 'No pudimos programar la oferta. Quedó como borrador: revisala y probá de nuevo.',   // Codex r4 P1-2 (new copy)
});

const now = () => (B.ctx && typeof B.ctx.now === 'function' ? B.ctx.now() : Date.now());
const B = { open: false, host: null, ctx: null, mode: 'new', offer: null, form: null, nameAuto: true, row: null, pvOpen: false, dp: null,
  review: false, busy: false, err: null, menu: null, layer: null, picking: false,
  gen: 0, blocked: false, opener: null, fx: { levels: [], stack: [] } };
// Codex r1 P1-4: every write is bound to the dialog OPENING it started in (B.gen moves on every open / close) and to the restaurant
// context it captured — a reply that comes back to another opening only refreshes the list (stale()), never the dialog on screen.
const stale = (ctx) => { if (ctx && ctx.onChanged) ctx.onChanged(); };
// ONE call, classified ONCE (r6.1): a thrown call is an UNKNOWN, never a stuck «busy»; there is no recovery read
const sendOnce = (attempt, send) => send().then((res) => ML.classifyWrite(attempt, res), () => ({ outcome: 'unknown' }));
// r6.1 (owner 11-15): an UNKNOWN outcome closes the dialog; the host goes to «Campañas», re-reads it and says so (ML.UNKNOWN_WORD)
function unknownOut(ctx) { closeBuilder(); if (ctx.onUnknown) ctx.onUnknown(); else stale(ctx); }
// r6.1 P2: a NEW op_id for every user submission (a click of «Programar oferta» / «Programar»), never stored, never resent
const newOpId = () => `op_${(globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`;
function opened(host, ctx) {   // the shared part of every opening
  B.gen += 1; B.fx = { levels: [], stack: [] };
  B.opener = typeof document !== 'undefined' ? document.activeElement : null;
  B.host = host; B.ctx = ctx; B.open = true; B.row = null; B.pvOpen = false; B.dp = null; B.review = false; B.busy = false; B.err = null; B.picking = false;
}

// ── open / close ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ctx: { branches: [{ rid, name, address }], brandName, token, toast(text), onDone() } · type: an offer type · offer: a draft to continue
export function openBuilder(host, ctx, { type = 'pct', offer = null } = {}) {
  opened(host, ctx);
  if (offer) { B.mode = 'draft'; B.offer = offer; B.form = ML.formFromOffer(offer); B.nameAuto = false; B.custom = isCustom(B.form.window); }
  else {
    B.mode = 'new'; B.offer = null;
    B.form = { ...ML.emptyForm(type), ...SUGGEST[type], branches: ctx.branches.map((b) => b.rid), start: hnDay0(now()), end: null, weekly: true };
    B.nameAuto = true;
  }
  B.layer = el('div', 'mk5b-layer');
  host.append(B.layer);
  render();
  loadMenu();
  const x = B.layer.querySelector('.mk5b-x'); if (x && x.focus) x.focus();
}
export function closeBuilder() {
  B.gen += 1;
  B.open = false; B.dp = null;
  if (B.layer) B.layer.remove();
  B.layer = null;
  const o = B.opener; B.opener = null;
  if (o && o.isConnected && typeof o.focus === 'function') o.focus();   // focus goes back to what opened the dialog
}
export const builderOpen = () => B.open;
// an account switch closes every dialog and drops every cached copy (Codex r3 P1-4)
let authUid;
document.addEventListener('portal:auth', (e) => {
  const uid = e && e.detail ? e.detail.uid : null;
  if (uid === authUid) return;
  authUid = uid;
  if (B.open) closeBuilder();
});
document.addEventListener('keydown', (e) => {
  if (B.open && e.key === 'Tab') { if (B.layer && B.layer.isConnected) trapTab(e, topDialog()); return; }
  if (!B.open || e.key !== 'Escape') return;
  if (B.dp) { B.dp = null; render(); return; }            // Esc closes the calendar first
  if (B.review) { B.review = false; render(); return; }   // then the review sheet
  closeBuilder();                                          // then the dialog
});

// the menu for the 2×1 products (the editable catalog of the first chosen branch: names, prices, categories, photos)
async function loadMenu() {
  if (B.form.type !== 'bogo') return;
  const rid = (B.form.branches[0]) || (B.ctx.branches[0] && B.ctx.branches[0].rid);
  B.menu = { state: 'loading', items: [], cats: [] };
  const g = B.gen;
  let res;
  try { res = await getEditableCatalogRaw({ rid, token: B.ctx.token }); } catch (_) { res = { transport: true }; }
  if (!B.open || B.gen !== g) return;
  if (!res || res.transport || res.status !== 200 || !res.body || !res.body.source) { B.menu = { state: 'error', items: [], cats: [] }; render(); return; }
  const groups = groupByCategory(res.body.source);
  const items = []; const cats = [];
  for (const g of groups) {
    cats.push({ id: g.category.id, name: g.category.name || g.category.id });
    for (const it of g.items) items.push({ key: it.key, name: (it.display && it.display.name) || it.key, price_cents: Number.isSafeInteger(it.price) && it.price > 0 ? it.price * 100 : null, cat: g.category.id, photo: null });   // whole lempiras (render.js priceLabel)
  }
  B.menu = { state: 'ready', items, cats };
  render();
}

// ── the effective form (the auto name rides along until the merchant types one) ──────────────────────────────────────────────
function words() {
  const t = ML.builderText(B.form, { branches: B.ctx.branches, items: B.menu ? B.menu.items : [] });
  if (B.nameAuto) B.form.name = t.autoName;
  return ML.builderText(B.form, { branches: B.ctx.branches, items: B.menu ? B.menu.items : [] });
}

// ── render ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const topDialog = () => { const d = B.layer ? B.layer.querySelectorAll('[role="dialog"]') : []; return d.length ? d[d.length - 1] : null; };
function render() {
  if (!B.layer) return;
  const fk = focusKey(B.layer);
  const w = words();
  const scrim = el('div', 'mk5b-scrim');
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeBuilder(); });
  const dlg = el('div', 'mk5b-dlg'); dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-labelledby', 'ofT');
  const hd = el('div', 'mk5b-hd');
  const edit = B.mode === 'edit';
  const ht = el('div'); const h2 = el('h2', null, edit ? 'Editar oferta activa' : B.mode === 'draft' ? 'Seguir editando' : 'Nueva oferta'); h2.id = 'ofT';
  ht.append(h2, el('p', 'mk5b-lede', edit ? EDIT_LEDE : 'Revisá cada fila. Todo viene con valores sugeridos.'));
  const x = el('button', 'mk5b-x'); x.type = 'button'; x.setAttribute('aria-label', 'Cerrar'); x.append(svg(X)); x.addEventListener('click', closeBuilder);
  hd.append(ht, x);
  const body = el('div', 'mk5b-body');
  if (B.mode !== 'repeat') body.append(edit ? editFormCol(w) : formCol(w), previewCol(w));
  dlg.append(hd, body);
  scrim.append(dlg);
  const kids = [scrim];
  if (B.mode === 'repeat') kids.splice(0, 1, repeatSheet(w));   // O3: the repeat sheet alone (its dates use this calendar)
  if (B.dp) kids.push(datePopover());
  if (B.review) kids.push(reviewSheet(w));
  B.layer.replaceChildren(...kids);
  layered(B.fx, B.layer, fk, ['main', ...(B.review ? ['review'] : []), ...(B.dp ? ['dp'] : [])], topDialog);   // Codex r1 P2-7
}

function formCol(w) {
  const f = el('div', 'mk5b-form');
  const typ = el('div', 'mk5b-type');
  const ti = el('span', 'mk5b-tico'); ti.append(svg(...ICONS_OF(w.icon)));
  const tt = el('span', 'mk5b-txt'); tt.append(el('span', 'mk5b-lbl', w.typeLabel), el('span', 'mk5b-val', 'Oferta'));
  typ.append(ti, tt);
  if (B.mode === 'new') { const chg = el('button', 'mk5b-chg', 'Cambiar tipo'); chg.type = 'button'; chg.addEventListener('click', () => { closeBuilder(); B.ctx.onChangeType && B.ctx.onChangeType(); }); typ.append(chg); }
  const rows = el('div', 'mk5b-rows');
  rows.append(row('br', 'Sucursales', w.branchText, branchesBody()));
  rows.append(row('typ', w.rowLabel, w.sumType, typeBody(), ICONS_OF(w.icon)));
  if (B.form.type === 'bogo') rows.append(row('prod', 'Productos', w.prodSummary, productsBody(w)));
  if (B.form.type !== 'nuevos') rows.append(row('aud', 'Clientes', (AUD.find(([k]) => k === B.form.audience) || AUD[0])[1].replace(' los clientes', ''), audienceBody()));
  rows.append(row('sch', 'Horario', w.sumSched, scheduleBody(w)));
  rows.append(row('caps', 'Límites', w.caps.summary, capsBody(w)));
  rows.append(row('name', 'Nombre', B.nameAuto ? `${w.name} · se armó solo` : w.name, nameBody()));
  f.append(typ, rows, foot(w));
  return f;
}
const ICONS_OF = (k) => ({ 'i-percent': ['M19 5 5 19', { tag: 'circle', cx: 6.5, cy: 6.5, r: 2.5 }, { tag: 'circle', cx: 17.5, cy: 17.5, r: 2.5 }],
  'i-coin': [{ tag: 'circle', cx: 12, cy: 12, r: 9 }, 'M9.5 7.5v9h5'],
  'i-gift': ['M20 12v9H4v-9M2 7h20v5H2zM12 21V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z'],
  'i-truck': ['M1 4h14v12H1zM15 9h5l3 3v4h-8z', { tag: 'circle', cx: 5.5, cy: 18.5, r: 1.8 }, { tag: 'circle', cx: 18.5, cy: 18.5, r: 1.8 }],
  'i-userplus': ['M15 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', { tag: 'circle', cx: 8, cy: 7, r: 4 }, 'M20 8v6M23 11h-6'] }[k] || [SPARK]);

function row(id, label, value, bodyNode, icon = null) {
  const open = B.row === id;
  const r = el('div', `mk5b-row${open ? ' mk5b-open' : ''}`); r.dataset.row = id;
  const h = el('button', 'mk5b-rowh'); h.type = 'button'; h.setAttribute('aria-expanded', open ? 'true' : 'false');
  const ic = el('span', 'mk5b-ico'); ic.append(svg(...(icon || ROW_ICON[id] || [SPARK])));
  const tx = el('span', 'mk5b-txt'); tx.append(el('span', 'mk5b-rlbl', label), el('span', 'mk5b-val', value));
  const ch = el('span', 'mk5b-chev'); ch.append(svg(DOWN));
  h.append(ic, tx, ch);
  h.addEventListener('click', () => { B.row = open ? null : id; B.dp = null; render(); });
  const b = el('div', 'mk5b-rbody'); if (bodyNode) b.append(...[].concat(bodyNode));
  r.append(h, b);
  return r;
}
const upd = (patch) => { Object.assign(B.form, patch); B.err = null; render(); };

function optRow(type, name, checked, onChange, sub = null) {
  const l = el('label', `mk5b-opt${checked ? ' mk5b-sel' : ''}`);
  const i = el('input'); i.type = type; i.checked = checked; i.addEventListener('change', onChange);
  const n = el('span', 'mk5b-oname', name); if (sub) n.append(el('span', 'mk5b-osub', sub));
  l.append(i, n);
  return l;
}
function branchesBody() {
  const out = B.ctx.branches.map((b) => optRow('checkbox', b.name, B.form.branches.includes(b.rid), () => {
    const on = B.form.branches.includes(b.rid);
    upd({ branches: on ? B.form.branches.filter((r) => r !== b.rid) : [...B.form.branches, b.rid] });
  }, b.address || null));   // Q1: the address only (the hours phrase is gated)
  out.push(el('p', 'mk5b-help', 'La oferta se muestra solo a clientes dentro de la zona de entrega de las sucursales elegidas.'));
  return out;
}
function numField(label, unitBefore, value, onInput, { unitAfter = null, aria = label, cfg = true } = {}) {
  const fld = el('div', 'mk5b-fld');
  fld.append(el('label', 'mk5b-flab', label));
  const box = el('label', cfg ? 'mk5b-cinp' : 'mk5b-inp');
  if (unitBefore) box.append(el('span', 'mk5b-unit', unitBefore));
  const inp = el('input', 'mk5b-num'); inp.value = value ?? ''; inp.inputMode = 'numeric'; inp.setAttribute('aria-label', aria);
  inp.addEventListener('change', () => onInput(inp.value));
  box.append(inp);
  if (unitAfter) box.append(el('span', 'mk5b-unit', unitAfter));
  fld.append(box);
  return fld;
}
function typeBody() {
  const t = B.form.type; const cfg = el('div', 'mk5b-cfg'); const two = el('div', 'mk5b-two');
  if (t === 'pct') {
    two.append(numField('Descuento', null, B.form.pct, (v) => upd({ pct: Number.parseInt(v, 10) || null }), { unitAfter: '%', aria: 'Porcentaje de descuento' }));
    two.append(numField('Descuento máximo por pedido', 'L', B.form.max, (v) => upd({ max: v })));
    cfg.append(two, el('p', 'mk5b-help', `Obligatorio. Protege tu margen en pedidos grandes: el cliente ve «${B.form.pct} % menos, hasta ${ML.parseLempiras(B.form.max).ok && ML.parseLempiras(B.form.max).cents ? ML.money(ML.parseLempiras(B.form.max).cents) : 'L —'}».`));
  } else if (t === 'lps') {
    two.append(numField('Descuento', 'L', B.form.off, (v) => upd({ off: v }), { aria: 'Descuento en lempiras' }), numField('Mínimo de compra', 'L', B.form.min, (v) => upd({ min: v })));
    cfg.append(two);
  } else if (t === 'bogo') {
    two.append(numField('Gratis por pedido', 'Hasta', B.form.free_per_order, (v) => upd({ free_per_order: Number.parseInt(v, 10) || null }), { unitAfter: 'gratis', aria: 'Productos gratis por pedido' }));
    cfg.append(two, el('p', 'mk5b-help', 'El producto gratis siempre es de igual o menor valor que el que paga el cliente. Si lleva más, paga los demás a precio normal.'));
  } else if (t === 'envio') {
    two.append(numField('Mínimo de compra', 'L', B.form.min, (v) => upd({ min: v })));
    cfg.append(two, el('p', 'mk5b-help', 'El cliente ve «Envío gratis» solo si su dirección está dentro de tu zona de entrega y su pedido llega al mínimo. Fuera de eso, la app no lo promete.'));
  } else if (t === 'nuevos') {
    two.append(numField('Descuento', 'L', B.form.off, (v) => upd({ off: v }), { aria: 'Descuento en lempiras' }));
    cfg.append(two, el('p', 'mk5b-help', 'Vale una vez por cliente, en su primer pedido con tu restaurante.'));
  }
  return cfg;
}
function productsBody(w) {
  const out = [];
  const seg = el('div', 'mk5b-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Elegir por producto o por categoría');
  for (const [by, word, lim] of [['items', 'Por producto', '· hasta 10'], ['cats', 'Por categoría', '· hasta 2']]) {
    const b = el('button', `mk5b-segb${B.form.by === by ? ' mk5b-segon' : ''}`, `${word} `); b.type = 'button'; b.append(el('small', null, lim));
    b.addEventListener('click', () => { B.picking = false; upd({ by }); });
    seg.append(b);
  }
  out.push(seg);
  const menu = B.menu || { state: 'loading', items: [], cats: [] };
  const chosen = B.form.by === 'cats' ? B.form.cats : B.form.items;
  const pool = B.form.by === 'cats' ? menu.cats.map((c) => ({ key: c.id, name: c.name })) : menu.items;
  const box = el('div', 'mk5b-items');
  for (const k of chosen) {
    const it = pool.find((p) => p.key === k) || { key: k, name: k };
    const chip = el('span', 'mk5b-item'); chip.dataset.item = k;
    if (B.form.by === 'items') { if (it.photo) { const im = el('img', 'mk5b-th'); im.alt = ''; im.src = it.photo; chip.append(im); } else chip.append(el('span', 'mk5b-th')); }
    chip.append(document.createTextNode(`${it.name} `));
    if (Number.isSafeInteger(it.price_cents)) chip.append(el('span', 'mk5b-pr', ML.money(it.price_cents)));
    const xb = el('button', 'mk5b-ix'); xb.type = 'button'; xb.setAttribute('aria-label', `Quitar ${it.name}`); xb.append(svg(X));
    xb.addEventListener('click', () => upd(B.form.by === 'cats' ? { cats: B.form.cats.filter((c) => c !== k) } : { items: B.form.items.filter((c) => c !== k) }));
    chip.append(xb);
    box.append(chip);
  }
  const max = B.form.by === 'cats' ? ML.LIMITS.cats_max : ML.LIMITS.items_max;
  if (chosen.length < max) {
    const add = el('button', 'mk5b-add'); add.type = 'button'; add.append(svg(PLUS), document.createTextNode(B.form.by === 'cats' ? 'Agregar categoría' : 'Agregar producto'));
    add.addEventListener('click', () => { B.picking = !B.picking; render(); });
    box.append(add);
  }
  out.push(box);
  out.push(el('p', 'mk5b-help', B.form.by === 'cats' ? `${chosen.length} de ${max} categorías.` : `${chosen.length} de ${max} productos.`));
  if (B.picking) {   // the picker (no v5 frame draws it: the drawn option-row idiom, flagged)
    if (menu.state === 'loading') out.push(el('p', 'mk5b-help', 'Cargando tu menú…'));
    else if (menu.state === 'error') out.push(el('p', 'mk5b-help', 'No pudimos cargar tu menú. Cerrá y volvé a intentarlo.'));
    else for (const p of pool.filter((x) => !chosen.includes(x.key))) {
      out.push(optRow('checkbox', p.name, false, () => { B.picking = false; upd(B.form.by === 'cats' ? { cats: [...B.form.cats, p.key] } : { items: [...B.form.items, p.key] }); },
        Number.isSafeInteger(p.price_cents) ? ML.money(p.price_cents) : null));
    }
  }
  void w;
  return out;
}
function audienceBody() {
  return AUD.map(([k, word]) => optRow('radio', word, B.form.audience === k, () => upd({ audience: k })));   // Q3: titles only
}
function scheduleBody(w) {
  const out = [el('p', 'mk5b-help', 'Hora de tu restaurante.')];
  const noEnd = B.form.end === null;
  const dates = el('div', `mk5b-dates${noEnd ? ' mk5b-noend' : ''}`);
  dates.append(dateField('Inicio', 'start', B.form.start), dateField('Fin', 'end', noEnd ? null : B.form.end, { disabled: noEnd }));
  out.push(dates);
  const av = el('div', 'mk5b-avail');
  const al = el('div', 'mk5b-albl'); al.append(el('b', null, 'Sin fecha de fin'), el('span', null, 'Queda activa hasta que la pausés o la termines'));
  const tog = el('button', `mk5b-tog${noEnd ? '' : ' mk5b-togoff'}`); tog.type = 'button'; tog.setAttribute('role', 'switch'); tog.setAttribute('aria-checked', noEnd ? 'true' : 'false'); tog.setAttribute('aria-label', 'Sin fecha de fin');
  tog.append(el('i', 'mk5b-knob'));
  tog.addEventListener('click', () => upd(noEnd ? { end: hnDay0(Math.max(B.form.start || now(), now())) + 7 * DAY - 1, weekly: false } : { end: null, weekly: true }));
  av.append(al, tog);
  out.push(av);
  out.push(...daysAndSlots());
  const sum = el('div', 'mk5b-sum'); sum.append(svg(CAL));
  const st = el('span'); st.append(el('b', null, w.schedSummary.strong), document.createTextNode(w.schedSummary.rest ? ` · ${w.schedSummary.rest}` : ''));
  sum.append(st); out.push(sum);
  return out;
}
function daysAndSlots() {
  const out = [];
  const df = el('div', 'mk5b-fld'); df.append(el('span', 'mk5b-flab', 'Días de la semana'));
  const dc = el('div', 'mk5b-chips');
  for (const [d, word] of DAY_CHIPS) {
    const on = B.form.days.includes(d);
    const c = el('button', `mk5b-chip${on ? ' mk5b-chon' : ''}`); c.type = 'button'; c.setAttribute('aria-pressed', on ? 'true' : 'false');
    const k = el('span', 'mk5b-chk'); k.append(svg(CHECK)); c.append(k, document.createTextNode(word));
    c.addEventListener('click', () => upd({ days: on ? B.form.days.filter((x) => x !== d) : [...B.form.days, d] }));
    dc.append(c);
  }
  df.append(dc); out.push(df);
  const sf = el('div', 'mk5b-fld'); sf.append(el('span', 'mk5b-flab', 'Franja horaria'));
  const sc = el('div', 'mk5b-chips');
  const win = B.form.window;
  const custom = B.custom === true;
  for (const [word, from, to] of SLOTS) {
    const on = from === 'custom' ? custom : !custom && (from === null ? win === null : !!win && win.from === from && win.to === to);
    const c = el('button', `mk5b-chip${on ? ' mk5b-chon' : ''}`); c.type = 'button';
    const k = el('span', 'mk5b-chk'); k.append(svg(CHECK)); c.append(k, document.createTextNode(word));
    if (Number.isInteger(from)) c.append(document.createTextNode(' '), el('small', null, `${hm(from)}–${hm(to)}`));
    c.addEventListener('click', () => {
      if (from === 'custom') { B.custom = true; upd({ window: win || { from: 1200, to: 1410 } }); return; }
      B.custom = false; upd({ window: from === null ? null : { from, to } });
    });
    sc.append(c);
  }
  sf.append(sc); out.push(sf);
  if (custom) {
    const cu = el('div', 'mk5b-custom');
    cu.append(timeField('Desde', win ? win.from : 1200, (m) => upd({ window: { from: m, to: (B.form.window || {}).to ?? 1410 } })), el('span', 'mk5b-dash', '–'),
      timeField('Hasta', win ? win.to : 1410, (m) => upd({ window: { from: (B.form.window || {}).from ?? 1200, to: m } })));
    out.push(cu);
  }
  return out;
}
// a stored window that is none of v5's named franjas reopens on «Personalizado»
const isCustom = (w) => !!w && !SLOTS.some(([, f, t]) => Number.isInteger(f) && f === w.from && t === w.to);
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
function timeField(label, minutes, onChange) {
  const fld = el('div', 'mk5b-fld');
  const l = el('label', 'mk5b-flab', label);
  const i = el('input', 'mk5b-time'); i.type = 'time'; i.value = hm(minutes);
  i.addEventListener('change', () => { const [a, b] = String(i.value).split(':').map((x) => Number.parseInt(x, 10)); if (Number.isInteger(a) && Number.isInteger(b)) onChange(a * 60 + b); });
  fld.append(l, i);
  return fld;
}
function capsBody(w) {
  const two = el('div', 'mk5b-two');
  two.append(numField('Tope de canjes', null, B.form.cap_redemptions, (v) => upd({ cap_redemptions: Number.parseInt(String(v).replace(/\D/g, ''), 10) || null }), { unitAfter: 'canjes', cfg: false }));
  two.append(numField(w.caps.spendLabel, 'L', B.form.cap_spend, (v) => upd({ cap_spend: v }), { cfg: false }));
  return [two, el('p', 'mk5b-help', w.caps.help)];
}
function nameBody() {
  const fld = el('div', 'mk5b-fld');
  const lr = el('div', 'mk5b-lrow'); const l = el('label', 'mk5b-flab', 'Nombre de la campaña'); l.htmlFor = 'oname';
  const cnt = el('span', 'mk5b-cnt', `${B.form.name.length}/${ML.LIMITS.name_max}`); lr.append(l, cnt);
  const i = el('input', 'mk5b-text'); i.type = 'text'; i.id = 'oname'; i.maxLength = ML.LIMITS.name_max; i.value = B.form.name;
  i.addEventListener('input', () => { B.nameAuto = false; B.form.name = i.value; cnt.textContent = `${i.value.length}/${ML.LIMITS.name_max}`; });
  i.addEventListener('change', () => render());
  fld.append(lr, i);
  return [fld, el('p', 'mk5b-help', `Lo ves vos en tu lista. Se arma solo con lo que elegís; si lo cambiás, queda el tuyo. El cliente ve el título de la oferta ${PV_NOTE}`)];
}
function foot(w) {
  const ft = el('div', 'mk5b-foot');
  const fine = el('p', 'mk5b-fine', `${w.cost.lead} `); if (w.cost.ceiling) fine.append(el('span', 'mk5b-nb', w.cost.ceiling));
  const go = el('button', 'mk5b-go', 'Revisar y programar'); go.type = 'button'; go.disabled = !!w.block || B.busy;
  go.addEventListener('click', () => { if (!w.block) { B.review = true; B.err = null; render(); } });
  ft.append(fine, go);
  if (w.block) ft.append(el('div', 'mk5b-block', w.block));
  const dr = el('button', 'mk5b-draft', 'Guardar borrador'); dr.type = 'button'; dr.disabled = B.busy;
  dr.addEventListener('click', () => saveDraft());
  ft.append(dr);
  return ft;
}

// ── the preview (the app's «Ofertas» card + the menu-row badge) ─────────────────────────────────────────────────────────────────
function previewCol(w) {
  const pv = el('aside', `mk5b-pv${B.pvOpen ? ' mk5b-pvopen' : ''}`); pv.setAttribute('aria-label', 'Vista previa');
  const tg = el('button', 'mk5b-pvtog'); tg.type = 'button'; tg.setAttribute('aria-expanded', B.pvOpen ? 'true' : 'false');
  tg.append(el('span', null, B.pvOpen ? 'Ocultar vista previa' : 'Ver vista previa'), svg(DOWN));
  tg.addEventListener('click', () => { B.pvOpen = !B.pvOpen; render(); });
  const wrap = el('div', 'mk5b-pvwrap');
  const phone = el('div', 'mk5b-phone'); phone.append(el('div', 'mk5b-notch'));
  const c1 = el('div', 'mk5b-card');
  const sec = el('div', 'mk5b-sec', 'Ofertas'); sec.append(el('span', null, 'cerca de vos'));
  const hd = el('div', 'mk5b-pvhd');
  const name = B.ctx.brandName || '';
  const av = el('div', 'mk5b-av', (name.trim()[0] || '·').toUpperCase());
  const hdt = el('div'); hdt.append(el('b', null, name), el('span', 'mk5b-pvmeta', w.branchShort));   // ETA + fee: no source (gated)
  hd.append(av, hdt);
  const bd = el('div', 'mk5b-pvbody');
  const cta = el('div', 'mk5b-pvcta', 'Ver menú'); cta.append(svg(ARR));
  bd.append(el('span', 'mk5b-pvchip', w.chip), el('div', 'mk5b-pvoff', w.title), el('div', 'mk5b-pvwhen', w.when), cta);
  c1.append(sec, hd, bd);
  phone.append(c1);
  const item = previewItem();
  if (item) {
    const c2 = el('div', 'mk5b-card');
    const r = el('div', 'mk5b-pvrow');
    const th = item.photo ? Object.assign(el('img', 'mk5b-pvth'), { alt: '', src: item.photo }) : el('div', 'mk5b-pvth');
    const inf = el('div', 'mk5b-inf');
    const nm = el('div', 'mk5b-nm'); nm.append(el('span', null, item.name), el('span', 'mk5b-pvchip', w.chip));
    inf.append(nm);
    if (Number.isSafeInteger(item.price_cents)) inf.append(el('div', 'mk5b-ipr', ML.money(item.price_cents)));
    r.append(th, inf);
    c2.append(el('div', 'mk5b-sec', 'En tu menú'), r);
    phone.append(c2);
  }
  wrap.append(el('div', 'mk5b-pvlab', 'Así la ve el cliente'), phone, el('div', 'mk5b-pvnote', 'Vista de ejemplo. Puede variar un poco en la app.'));
  pv.append(tg, wrap);
  return pv;
}
function previewItem() {   // the menu-row badge: the first chosen 2×1 product, else the menu's first dish (only when the menu is read)
  const items = B.menu && B.menu.state === 'ready' ? B.menu.items : [];
  if (B.form.type === 'bogo' && B.form.by === 'items' && B.form.items.length) return items.find((i) => i.key === B.form.items[0]) || null;
  return null;
}

// ── the calendar (v5 «the portal's standard date picker»: Sunday-first, Spanish, ‹ month ▾ year ▾ ›, today dotted, past inert) ──
function dateField(label, which, ms, { disabled = false } = {}) {
  const fld = el('div', `mk5b-fld${which === 'end' ? ' mk5b-endf' : ''}`);
  fld.append(el('span', 'mk5b-flab', label));
  const b = el('button', 'mk5b-dpbtn'); b.type = 'button'; b.disabled = disabled; b.dataset.dp = which;
  b.setAttribute('aria-haspopup', 'dialog'); b.setAttribute('aria-expanded', B.dp && B.dp.which === which ? 'true' : 'false');
  b.append(el('span', 'mk5b-dpv', ms ? longDate(ms) : '—'), svg(CAL));
  b.addEventListener('click', () => {
    if (B.dp && B.dp.which === which) { B.dp = null; render(); return; }
    const r = b.getBoundingClientRect ? b.getBoundingClientRect() : { left: 0, bottom: 0 };
    const [y, m] = ymd(ms || now());
    B.dp = { which, y, m, x: r.left, top: r.bottom + 6 };
    render();
  });
  fld.append(b);
  return fld;
}
function datePopover() {
  const dp = B.dp;
  const pop = el('div', 'mk5b-dpop'); pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', dp.which === 'start' ? 'Elegir la fecha de inicio' : 'Elegir la fecha de fin');
  pop.style.left = `${Math.max(16, dp.x)}px`; pop.style.top = `${dp.top}px`;
  const today = hnDay0(now());
  const min = dp.which === 'end' ? Math.max(today, B.form.start ? hnDay0(B.form.start) : today, B.mode === 'edit' && E.prev && E.prev.end !== null ? hnDay0(E.prev.end) : 0) : today;   // edit: Fin later only
  const hd = el('div', 'mk5b-dphd');
  const prev = el('button', 'mk5b-dpnav'); prev.type = 'button'; prev.setAttribute('aria-label', 'Mes anterior'); prev.append(svg(PREV));
  const [ty, tm] = ymd(min);
  prev.disabled = dp.y < ty || (dp.y === ty && dp.m <= tm);
  prev.addEventListener('click', () => { dp.m -= 1; if (dp.m < 0) { dp.m = 11; dp.y -= 1; } render(); });
  const next = el('button', 'mk5b-dpnav'); next.type = 'button'; next.setAttribute('aria-label', 'Mes siguiente'); next.append(svg(NEXT));
  next.addEventListener('click', () => { dp.m += 1; if (dp.m > 11) { dp.m = 0; dp.y += 1; } render(); });
  const sels = el('div', 'mk5b-dpsels');
  const mw = el('span', 'mk5b-dpselw'); const ms = el('select', 'mk5b-dpsel'); ms.setAttribute('aria-label', 'Mes');
  MONTHS.forEach((name, i) => { const o = el('option', null, name); o.value = String(i); if (i === dp.m) o.selected = true; ms.append(o); });
  ms.addEventListener('change', () => { dp.m = Number(ms.value); render(); });
  mw.append(ms, svg(DOWN));
  const yw = el('span', 'mk5b-dpselw'); const ys = el('select', 'mk5b-dpsel'); ys.setAttribute('aria-label', 'Año');
  for (const y of [ty, ty + 1]) { const o = el('option', null, String(y)); o.value = String(y); if (y === dp.y) o.selected = true; ys.append(o); }
  ys.addEventListener('change', () => { dp.y = Number(ys.value); render(); });
  yw.append(ys, svg(DOWN));
  sels.append(mw, yw);
  hd.append(prev, sels, next);
  const wk = el('div', 'mk5b-dpwk'); for (const d of ['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá']) wk.append(el('span', null, d));
  const grid = el('div', 'mk5b-dpgrid');
  const first = Date.UTC(dp.y, dp.m, 1) + HN;
  const lead = new Date(first - HN).getUTCDay();
  for (let i = 0; i < lead; i++) grid.append(el('span'));
  const sel = dp.which === 'start' ? B.form.start : B.form.end;
  for (let d = 1; d <= 31; d++) {
    const at = Date.UTC(dp.y, dp.m, d) + HN;
    if (ymd(at)[1] !== dp.m) break;
    const b = el('button', 'mk5b-dpd'); b.type = 'button';
    const isSel = sel && hnDay0(sel) === at;
    if (isSel) b.classList.add('mk5b-dsel');
    if (dp.which === 'end' && B.form.start && at > hnDay0(B.form.start) && sel && at < hnDay0(sel)) b.classList.add('mk5b-inr');
    b.disabled = at < min;
    if (b.classList.contains('mk5b-inr')) b.append(el('span', 'mk5b-band'));   // the soft band between Inicio and Fin (a real element)
    b.append(el('span', 'mk5b-ring'), el('span', 'mk5b-dnum', String(d)));
    if (at === today) b.append(el('i', 'mk5b-tdot'));
    b.setAttribute('aria-label', longDate(at));
    b.addEventListener('click', () => {
      if (dp.which === 'start') { const end = B.form.end !== null && B.form.end <= at ? at + DAY - 1 : B.form.end; B.dp = null; upd({ start: at, end }); }
      else { B.dp = null; upd({ end: at + DAY - 1 }); }   // «hasta el 30 nov» includes the 30th (end of that HN day)
    });
    grid.append(b);
  }
  pop.append(hd, wk, grid);
  return pop;
}

// ── the review sheet (3b) and the writes ────────────────────────────────────────────────────────────────────────────────────────
function reviewSheet(w) {
  const scrim = el('div', 'mk5r-scrim');
  const off = () => { B.review = false; render(); };
  scrim.addEventListener('click', (e) => { if (e.target === scrim && !B.busy) off(); });
  const m = el('div', 'mk5r-modal'); m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'revT');
  const mh = el('div', 'mk5r-mh'); const mt = el('div', 'mk5r-mt', 'Revisá tu oferta'); mt.id = 'revT';
  mh.append(mt, el('div', 'mk5r-ms', 'Así queda. Si algo no cuadra, volvé y cambialo.'));
  const mb = el('div', 'mk5r-mb');
  const rows = el('div', 'mk5r-rows');
  const add = (l, v) => { const r = el('div', 'mk5r-row'); r.append(el('span', 'mk5r-sl', l), el('span', 'mk5r-sv', v)); rows.append(r); };
  add('Oferta', `${w.typeLabel} · ${/^L \d/.test(w.sumType) ? w.sumType : `${w.sumType.charAt(0).toLowerCase()}${w.sumType.slice(1)}`}`);   // v5 lower-cases the first word — never the currency «L»
  if (B.form.type === 'bogo') add('Productos', w.prodSummary);
  add('Sucursales', /^Las \d+ sucursales$/.test(w.branchText) ? w.branchText.slice(0, -' sucursales'.length) : w.branchText);   // v5's review: «Las 3»
  if (B.form.type !== 'nuevos') add('Clientes', (AUD.find(([k]) => k === B.form.audience) || AUD[0])[1].replace(' los clientes', ''));
  add('Horario', w.sumSched);
  add('Límites', w.caps.summary);
  add('Nombre', w.name);
  const fine = el('p', 'mk5r-fine', `${w.cost.lead} `); if (w.cost.ceiling) fine.append(el('span', 'mk5b-nb', w.cost.ceiling));
  mb.append(rows, fine);
  if (B.err) { const e = el('div', 'mk5b-err'); e.setAttribute('role', 'alert'); e.append(el('span', null, B.err)); mb.append(e); }
  const mf = el('div', 'mk5r-mf');
  const back = el('button', 'mk5r-back', 'Volver'); back.type = 'button'; back.disabled = B.busy; back.addEventListener('click', off);
  const ok = el('button', 'mk5r-ok', 'Programar oferta'); ok.type = 'button'; ok.disabled = B.busy; ok.addEventListener('click', () => program());
  mf.append(back, ok);
  m.append(mh, mb, mf);
  scrim.append(m);
  return scrim;
}

const rid0 = () => B.form.branches[0];
function wordOf(c) {
  if (c.outcome === 'unknown') return ML.UNKNOWN_WORD;   // never shown in a dialog (unknownOut closes it) — the one string, kept whole
  const f = REFUSAL_WORD[c.reason] || REFUSAL_WORD[c.field] || REFUSAL_WORD[c.code];   // a bad_request carries its reason (start_past …)
  return f ? f(c) : 'No pudimos guardar la oferta. Revisá los datos e intentá de nuevo.';
}
// «start today» means NOW: a start earlier than a minute from now (today's 00:00, or a dialog left open) is sent as now + 1 min —
// the server refuses a past start (start_past)
function authoredNow() {
  const soon = Math.ceil((now() + 60000) / 60000) * 60000;
  if (Number.isSafeInteger(B.form.start) && B.form.start < soon) B.form.start = soon;
  return ML.offerFromForm(B.form);
}
// «Programar oferta» — ONE call (3a: save + program, all or nothing) under a NEW op_id per click (r6.1 P2). A definite answer is
// worded: a 200 (the RETURNED offer is the truth: its state and schedule), a 409 duplicate (the existing offer is shown), an explicit
// refusal (op_id_conflict included: its word; the next click mints a fresh id). Anything else is UNKNOWN: the list decides.
async function program() {
  if (B.busy) return;
  const g = B.gen, ctx = B.ctx, token = ctx.token;
  const r = authoredNow();
  if (!r.ok) { B.err = wordOf({ outcome: 'refused', code: 'invalid' }); render(); return; }
  const rid = rid0();
  B.busy = true; B.err = null; render();
  let s;
  if (B.offer) {   // a draft being continued: its id + rev are its identity — update AND program it in ONE CAS
    const o = B.offer;
    s = await sendOnce({ op: 'save', offerId: o.id, expectedRev: o.rev, program: true }, () => offerSaveRaw({ rid, offerId: o.id, expectedRev: o.rev, offer: r.offer, program: true, token }));
  } else {
    const opId = newOpId();
    s = await sendOnce({ op: 'create', opId }, () => offerSaveRaw({ rid, expectedRev: 0, offer: r.offer, opId, program: true, token }));
    if (s.outcome === 'saved' && s.offer.state !== 'active') s = { outcome: 'refused', code: 'not_programmed' };   // it resolved to a record that is not programmed
  }
  if (B.gen !== g) { stale(ctx); return; }
  B.busy = false;
  if (s.outcome === 'unknown') { unknownOut(ctx); return; }
  if (s.outcome === 'refused' && s.code === 'duplicate') { closeBuilder(); if (ctx.onDuplicate) ctx.onDuplicate(s.offer_id); return; }   // never an error: the existing offer
  if (s.outcome !== 'saved') { B.err = wordOf(s); render(); return; }
  closeBuilder();
  ctx.toast(programmedToast(s.offer));   // from the RETURNED offer
  ctx.onDone && ctx.onDone();
}
// «Guardar borrador» — a separate, harmless draft write (no op_id: a lost reply leaves at most a stray draft — advisor 11-14)
async function saveDraft() {
  if (B.busy) return;
  const g = B.gen, ctx = B.ctx, rid = rid0(), token = ctx.token;
  const r = authoredNow();
  if (!r.ok) { B.review = true; B.err = wordOf({ outcome: 'refused', code: 'invalid' }); render(); return; }
  B.busy = true; render();
  const o = B.offer;
  const s = o
    ? await sendOnce({ op: 'save', offerId: o.id, expectedRev: o.rev }, () => offerSaveRaw({ rid, offerId: o.id, expectedRev: o.rev, offer: r.offer, token }))
    : await sendOnce({ op: 'create' }, () => offerSaveRaw({ rid, expectedRev: 0, offer: r.offer, token }));
  if (B.gen !== g) { stale(ctx); return; }
  B.busy = false;
  if (s.outcome === 'unknown') { unknownOut(ctx); return; }
  if (s.outcome !== 'saved') { B.err = wordOf(s); B.review = true; render(); return; }
  closeBuilder();
  ctx.toast('Borrador guardado');
  ctx.onDone && ctx.onDone();
}
// v5's «Oferta programada. Empieza hoy a las 21:00.» — worded from the SAVED offer's own schedule (today / another day; a window or not)
export function programmedToast(o, at = now()) {
  const s = (o && o.schedule) || {};
  const day = Number.isSafeInteger(s.start) && hnDay0(s.start) > hnDay0(at) ? `el ${new Date(s.start - HN).getUTCDate()} ${MON3[new Date(s.start - HN).getUTCMonth()]}` : 'hoy';
  return s.window ? `Oferta programada. Empieza ${day} a las ${hm(s.window.from)}.` : `Oferta programada. Empieza ${day}.`;
}

export const _builderState = B;   // test-only

// ── O2c · «Editar oferta activa» (v5 3c): the same dialog over a running offer — locked rows vs the editable ones ─────────────────
// What may change is the SERVER's live-edit allowlist (3a offer-model liveEditProblem): a cap RAISED and the end moved LATER (or
// removed). Everything else is a locked row (the lock in place of the chevron, «fijo mientras está activa», not expandable). The
// day chips and the franja are EDITABLE as v5 draws them (advisor 11-14, ruling (a); 3a widened its allowlist to days + window at
// c5bbce740 — the weekly flag stays locked, so «Sin fecha de fin» keeps it). The usage counters wait for 5f.
const LOCK = [{ tag: 'rect', x: 5, y: 11, width: 14, height: 10, rx: 2 }, 'M8 11V7a4 4 0 0 1 8 0v4'];
const EDIT_LEDE = 'Mientras está activa podés subir los topes y cambiar el horario. Lo demás queda fijo, para que ningún cliente vea una oferta distinta de la que le prometimos.';
const E = { prev: null };
export function openEditor(host, ctx, offer) {
  opened(host, ctx); B.row = 'caps';
  B.mode = 'edit'; B.offer = offer; B.form = ML.formFromOffer(offer); B.nameAuto = false; B.menu = null; B.custom = isCustom(B.form.window);
  E.prev = ML.formFromOffer(offer);
  B.layer = el('div', 'mk5b-layer');
  host.append(B.layer);
  render();
  const x = B.layer.querySelector('.mk5b-x'); if (x && x.focus) x.focus();
}
// what the dialog itself blocks: only what stays forbidden after 3a's widening — a cap LOWERED, the end moved EARLIER (v5 3c).
// The days / franja are sent (3a allows them live); the weekly flag stays the offer's own; the server decides the rest.
function editProblem() {
  const a = ML.offerFromForm(E.prev), b = ML.offerFromForm(B.form);
  if (!a.ok || !b.ok) return 'invalid';
  const up = (x, y) => y === null || (x !== null && y >= x);
  if (!up(a.offer.caps.redemptions, b.offer.caps.redemptions) || !up(a.offer.caps.spend_cents, b.offer.caps.spend_cents)) return 'caps';
  const pe = a.offer.schedule.end, ne = b.offer.schedule.end;
  if (!(ne === null || (pe !== null && ne >= pe))) return 'end';
  return null;
}
function lockedRow(id, label, value, icon = null) {
  const r = el('div', 'mk5b-row mk5b-lock'); r.dataset.row = id;
  const h = el('div', 'mk5b-rowh mk5b-rowlock'); h.setAttribute('role', 'group'); h.setAttribute('aria-label', `${label}, fijo mientras está activa`);
  const ic = el('span', 'mk5b-ico mk5b-icolock'); ic.append(svg(...(icon || ROW_ICON[id] || [SPARK])));
  const tx = el('span', 'mk5b-txt'); tx.append(el('span', 'mk5b-rlbl mk5b-lbllock', label), el('span', 'mk5b-val', `${value} · fijo mientras está activa`));
  const ch = el('span', 'mk5b-chev'); ch.append(svg(...LOCK));
  h.append(ic, tx, ch);
  r.append(h);
  return r;
}
export function editFormCol(w) {
  const f = el('div', 'mk5b-form');
  const typ = el('div', 'mk5b-type');
  const ti = el('span', 'mk5b-tico'); ti.append(svg(...ICONS_OF(w.icon)));
  const started = Number.isSafeInteger(B.offer.schedule && B.offer.schedule.start) ? B.offer.schedule.start : null;
  const st = ML.statusView(B.offer);
  const since = started ? `${started <= now() ? 'desde' : 'empieza'} el ${new Date(started - HN).getUTCDate()} ${MON3[new Date(started - HN).getUTCMonth()]}` : '';
  const tt = el('span', 'mk5b-txt'); tt.append(el('span', 'mk5b-lbl', B.offer.name), el('span', 'mk5b-val', `Oferta ${st ? st.word.toLowerCase() : ''}${since ? ` · ${since}` : ''}`));
  typ.append(ti, tt);
  const rows = el('div', 'mk5b-rows');
  rows.append(lockedRow('br', 'Sucursales', w.branchText), lockedRow('typ', w.rowLabel, w.sumType, ICONS_OF(w.icon)));
  if (B.form.type === 'bogo') rows.append(lockedRow('prod', 'Productos', w.prodSummary));
  if (B.form.type !== 'nuevos') rows.append(lockedRow('aud', 'Clientes', (AUD.find(([k]) => k === B.form.audience) || AUD[0])[1].replace(' los clientes', '')));
  rows.append(row('caps', 'Límites', w.caps.summary, editCapsBody(w)));
  rows.append(row('sch', 'Horario', w.sumSched, editScheduleBody(w)));
  f.append(typ, rows, editFoot());
  return f;
}
function editCapsBody(w) {
  const two = el('div', 'mk5b-two');
  two.append(numField('Tope de canjes', null, B.form.cap_redemptions, (v) => upd({ cap_redemptions: Number.parseInt(String(v).replace(/\D/g, ''), 10) || null }), { unitAfter: 'canjes', cfg: false }));
  two.append(numField(w.caps.spendLabel, 'L', B.form.cap_spend, (v) => upd({ cap_spend: v }), { cfg: false }));
  const out = [el('p', 'mk5b-help', 'Solo se pueden subir.'), two];   // v5's counters («Hoy lleva N canjes y L X…»): the 5f usage read, gated
  if (editProblem() === 'caps') out.push(el('div', 'mk5b-block', 'Un tope solo puede subir: poné un valor mayor o igual al actual.'));   // v5: «a lower value is rejected inline (not drawn)»
  return out;
}
function editScheduleBody(w) {
  const out = [el('p', 'mk5b-help', 'Hora de tu restaurante.')];
  const noEnd = B.form.end === null;
  const dates = el('div', `mk5b-dates${noEnd ? ' mk5b-noend' : ''}`);
  const ro = el('div', 'mk5b-fld'); ro.append(el('span', 'mk5b-flab', 'Inicio'));
  const box = el('div', 'mk5b-ro');
  const s0 = B.form.start;
  box.append(el('span', 'mk5b-unit', s0 && s0 <= now() ? 'Empezó el' : 'Empieza el'), el('b', null, s0 ? `${new Date(s0 - HN).getUTCDate()} ${MON3[new Date(s0 - HN).getUTCMonth()]} ${new Date(s0 - HN).getUTCFullYear()}` : '—'));
  ro.append(box);
  dates.append(ro, dateField('Fin', 'end', noEnd ? null : B.form.end, { disabled: noEnd }));
  out.push(dates);
  const av = el('div', 'mk5b-avail');
  const al = el('div', 'mk5b-albl'); al.append(el('b', null, 'Sin fecha de fin'), el('span', null, 'Queda activa hasta que la pausés o la termines'));
  const tog = el('button', `mk5b-tog${noEnd ? '' : ' mk5b-togoff'}`); tog.type = 'button'; tog.setAttribute('role', 'switch'); tog.setAttribute('aria-checked', noEnd ? 'true' : 'false'); tog.setAttribute('aria-label', 'Sin fecha de fin');
  tog.append(el('i', 'mk5b-knob'));
  tog.addEventListener('click', () => upd({ end: noEnd ? E.prev.end : null, weekly: E.prev.weekly }));   // Codex r1 P2-5: the weekly flag is server-LOCKED on a live offer (until asm10) — the end alone moves
  if (noEnd && E.prev.end === null) tog.disabled = true;   // an offer that never had an end cannot be given one (an EARLIER end)
  av.append(al, tog);
  out.push(av);
  out.push(...daysAndSlots());   // editable, as v5 3c draws them (ruling (a))
  const sum = el('div', 'mk5b-sum'); sum.append(svg(CAL));
  const st = el('span'); st.append(el('b', null, w.schedSummary.strong), document.createTextNode(w.schedSummary.rest ? ` · ${w.schedSummary.rest}` : ''));
  sum.append(st); out.push(sum);
  return out;
}
function editFoot() {
  const ft = el('div', 'mk5b-foot');
  ft.append(el('p', 'mk5b-fine', `Para cambiar el descuento, los clientes o las sucursales, terminá esta oferta y creá una nueva ${OR_REPEAT}`),
    el('p', 'mk5b-fine', 'Los cambios aplican de inmediato en la app.'));
  const p = editProblem();
  const go = el('button', 'mk5b-go', 'Guardar cambios'); go.type = 'button'; go.disabled = !!p || B.busy;
  go.addEventListener('click', () => saveEdit());
  ft.append(go);
  if (B.err) { const e = el('div', 'mk5b-err'); e.setAttribute('role', 'alert'); e.append(el('span', null, B.err)); ft.append(e); }
  return ft;
}
async function saveEdit() {
  if (B.busy || editProblem()) return;
  const r = ML.offerFromForm(B.form);
  if (!r.ok) return;
  const g = B.gen, ctx = B.ctx, o = B.offer, rid = rid0(), token = ctx.token;
  B.busy = true; B.err = null; render();
  const s = await sendOnce({ op: 'save', offerId: o.id, expectedRev: o.rev }, () => offerSaveRaw({ rid, offerId: o.id, expectedRev: o.rev, offer: r.offer, token }));
  if (B.gen !== g) { stale(ctx); return; }
  B.busy = false;
  if (s.outcome === 'unknown') { unknownOut(ctx); return; }
  if (s.outcome !== 'saved') { B.err = wordOf(s); render(); return; }
  closeBuilder();
  ctx.toast('Cambios guardados');
  ctx.onDone && ctx.onDone();
}

// ── O3 · «Repetir «…»» (v5 repScrim): the same offer, days, hours and branches — only NEW dates. The writes: the server's repeat
// (a NEW draft, rev 1, dates cleared — offers-core marketingOfferRepeat, ENDED offers only) → save the chosen dates → publish. A copy
// that saved but did not publish stays in «Borradores» (the sheet says why).
export function openRepeater(host, ctx, offer) {
  opened(host, ctx);
  B.mode = 'repeat'; B.offer = offer; B.nameAuto = false; B.menu = null;
  const s = offer.schedule || {};
  const len = Number.isSafeInteger(s.start) && Number.isSafeInteger(s.end) ? hnDay0(s.end) - hnDay0(s.start) : 7 * DAY;   // the same length as before
  const start = hnDay0(now());
  B.form = { ...ML.formFromOffer(offer), start, end: start + len + DAY - 1 };
  B.custom = isCustom(B.form.window);
  B.layer = el('div', 'mk5b-layer');
  host.append(B.layer);
  render();
}
// the summary after the bold days · hours: «del 14 al 22 nov · clientes que vuelven · 10 % · hasta L 60 por pedido»
export function repeatRest(w, audience) {
  const aud = ((AUD.find(([k]) => k === audience) || AUD[0])[1]).toLowerCase();
  return [w.schedSummary.rest.replace(/\.$/, ''), aud, w.sumType].filter(Boolean).join(' · ');
}
function repeatSheet(w) {
  const scrim = el('div', 'mk5r-scrim');
  scrim.addEventListener('click', (e) => { if (e.target === scrim && !B.busy) closeBuilder(); });
  const m = el('div', 'mk5r-modal'); m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'repT');
  const mh = el('div', 'mk5r-mh'); const mt = el('div', 'mk5r-mt', `Repetir «${B.offer.name}»`); mt.id = 'repT';
  mh.append(mt, el('div', 'mk5r-ms', 'Misma oferta, mismos días y horas, mismas sucursales. Solo elegís las fechas nuevas.'));
  const mb = el('div', 'mk5r-mb');
  const dates = el('div', 'mk5b-dates');
  dates.append(dateField('Inicio', 'start', B.form.start, { disabled: B.busy }), dateField('Fin', 'end', B.form.end, { disabled: B.busy }));
  const sum = el('div', 'mk5b-sum'); sum.append(svg(...ROW_ICON.sch));
  const st = el('span'); st.append(el('b', null, w.schedSummary.strong), document.createTextNode(` · ${repeatRest(w, B.form.audience)}`));
  sum.append(st);
  mb.append(dates, sum);
  if (B.err) { const e = el('div', 'mk5b-err'); e.setAttribute('role', 'alert'); e.append(el('span', null, B.err)); mb.append(e); }
  const mf = el('div', 'mk5r-mf');
  const back = el('button', 'mk5r-back', 'Volver'); back.type = 'button'; back.disabled = B.busy; back.addEventListener('click', closeBuilder);
  const ok = el('button', 'mk5r-ok', 'Programar'); ok.type = 'button'; ok.disabled = B.busy || !(B.form.end > B.form.start); ok.addEventListener('click', () => repeatGo());
  mf.append(back, ok);
  m.append(mh, mb, mf); scrim.append(m);
  return scrim;
}
// «Programar» — ONE call (3a): copy + the new dates + program, under a NEW op_id per click (r6.1 P2); the toast reads the RETURNED
// offer (Codex r4 P2-5); 409 duplicate ⇒ the existing offer; anything not definite is UNKNOWN: the list decides
async function repeatGo() {
  if (B.busy) return;
  const g = B.gen, src = B.offer, ctx = B.ctx, rid = rid0(), token = ctx.token;
  const soon = Math.ceil((now() + 60000) / 60000) * 60000;
  const schedule = { start: Math.max(B.form.start, soon), ...(B.form.end !== null ? { end: B.form.end } : {}) };
  B.busy = true; B.err = null; render();
  const opId = newOpId();
  let r = await sendOnce({ op: 'repeat', opId, sourceId: src.id }, () => offerRepeatRaw({ rid, sourceId: src.id, opId, schedule, token }));
  if (B.gen !== g) { stale(ctx); return; }
  B.busy = false;
  if (r.outcome === 'unknown') { unknownOut(ctx); return; }
  if (r.outcome === 'refused' && r.code === 'duplicate') { closeBuilder(); if (ctx.onDuplicate) ctx.onDuplicate(r.offer_id); return; }
  if (r.outcome === 'saved' && r.offer.state !== 'active') r = { outcome: 'refused', code: 'not_programmed' };
  if (r.outcome !== 'saved') { B.err = wordOf(r); render(); stale(ctx); return; }
  closeBuilder();
  const st = r.offer.schedule && r.offer.schedule.start;
  ctx.toast(`Campaña programada para el ${longDate(st).replace(/ \d{4}$/, '')}`);   // v5 «… para el sáb 14 nov» — the RETURNED copy's start
  if (ctx.onDone) ctx.onDone();
}
