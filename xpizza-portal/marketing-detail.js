// Portal «Marketing» › Ofertas O3 — the offer DETAIL (MOCKUP-portal-marketing v5 screens 5 / 5c) and its state moves: «Pausar» /
// «Reanudar», «Terminar oferta» (5b, always confirmed), «Repetir campaña» (an ENDED offer only — the server answers not_ended
// otherwise; the sheet is marketing-builder.js openRepeater). Every result block of v5 (the headline, the three
// figures, the chart, «Resultados», the Límites progress, the per-branch sales, the «not yet» reorder line, the end sheet's «Lleva»)
// is ABSENT — SOURCE_GATE in marketing.js (the 5f results read). The cap-pause strip is absent (no automatic pause exists); an
// OWNER pause shows v5's strip «Pausada por vos» + «Reanudar» (its date is not stored: absent). Every write's outcome from
// classifyWrite / settleWrite; refusals stay on the sheet as panels; successes are v5's toasts.
import { offerSetStateRaw, getMarketingRaw } from './api.js';
import { el, svg } from './ops-dom.js';
import * as ML from './marketing-logic.js';
import { focusKey, layered, trapTab } from './marketing-focus.js';
import * as OPS from './marketing-ops.js';

const BACK = 'M15 18l-6-6 6-6';
const PAUSE = [{ tag: 'rect', x: 6, y: 5, width: 4, height: 14, rx: 1 }, { tag: 'rect', x: 14, y: 5, width: 4, height: 14, rx: 1 }];
const DOT = (cx) => ({ tag: 'circle', cx, cy: 12, r: 1.6, fill: 'currentColor', stroke: 'none' });
const MORE = [DOT(5), DOT(12), DOT(19)], STOP = [{ tag: 'rect', x: 5, y: 5, width: 14, height: 14, rx: 2 }];
const HN = 6 * 3600000;
const MON3 = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const dm = (ms) => { const d = new Date(ms - HN); return `${d.getUTCDate()} ${MON3[d.getUTCMonth()]}`; };
const dmy = (ms) => { const d = new Date(ms - HN); return `${d.getUTCDate()} ${MON3[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
// a date span, the shared parts said once: «2 al 27 nov» / «28 nov al 6 dic» (meta) · «2 – 27 nov 2026» / «28 dic 2026 – 6 ene 2027» (setup)
function span(a, z, year) {
  const A = new Date(a - HN), Z = new Date(z - HN);
  const sameY = A.getUTCFullYear() === Z.getUTCFullYear(), sameM = sameY && A.getUTCMonth() === Z.getUTCMonth();
  if (!year) return sameM ? `${A.getUTCDate()} al ${dm(z)}` : `${dm(a)} al ${dm(z)}`;
  return `${sameM ? A.getUTCDate() : sameY ? dm(a) : dmy(a)} – ${dmy(z)}`;
}
const AUD_WORD = Object.freeze({ all: 'Todos', new: 'Nuevos', returning: 'Que vuelven' });
// the toasts v5 draws (the list's and the detail's moves)
export const DETAIL_TOAST = Object.freeze({ pause: 'Oferta pausada. Reanudala cuando querás.', resume: 'Oferta activa de nuevo', end: 'Oferta terminada. Los resultados quedan guardados.' });

// ── the pure words of the detail (tested) ─────────────────────────────────────────────────────────────────────────────────────
// the meta line: «● Activa · Oferta · Lun–Vie · 11:00–14:00 · del 2 al 27 nov» (v5 5) / «… · desde el 15 oct» (5c)
export function detailMeta(o) {
  const s = o.schedule || {};
  const dates = !Number.isSafeInteger(s.start) ? '' : Number.isSafeInteger(s.end) ? `del ${span(s.start, s.end, false)}` : `desde el ${dm(s.start)}`;
  return [ML.horario(s), dates].filter(Boolean).join(' · ');
}
// «Cómo está armada» (v5 «Ver más»): Descuento · Días y horas · Fechas · Clientes — the authored facts only
export function setup(o, ctx = {}) {
  const w = ML.builderText(ML.formFromOffer(o), { branches: ctx.branches || [], items: ctx.items || [] });
  const s = o.schedule || {};
  const fechas = !Number.isSafeInteger(s.start) ? 'Sin programar' : Number.isSafeInteger(s.end) ? span(s.start, s.end, true) : `Desde el ${dm(s.start)} · sin fecha de fin`;
  return [['Descuento', w.sumType], ['Días y horas', ML.horario(s) || '—'], ['Fechas', fechas], ['Clientes', AUD_WORD[o.audience] || 'Todos']];
}

// ── the view (marketing.js mounts it in place of the list) ───────────────────────────────────────────────────────────────────
// ctx: { offer, canEdit, token, rid, branches, toast(text), onBack(), onChanged(), onEdit(offer), onRepeat(offer), onClose() }
// opts.act ('pause' | 'resume' | 'end'): the LIST's row move — no page, only that move's sheet / its refusal over the list (v5
// s-home: «Pausar» / «Reanudar» in place, «Terminar» opens the same sheet); the host empties when it is done. «Repetir» is the
// builder's repeat sheet (marketing-builder.js openRepeater: it shares the portal calendar).

const D = { host: null, ctx: null, offer: null, only: false, more: false, menu: false, sheet: null, busy: false, err: null, gen: 0, fx: { levels: [], stack: [] } };
export function mountDetail(host, ctx, opts = {}) {
  D.gen += 1; D.fx = { levels: [], stack: [] };
  D.host = host; D.ctx = ctx; D.offer = ctx.offer; D.only = !!opts.act; D.more = false; D.menu = false; D.sheet = null; D.busy = false; D.err = null;
  if (opts.act === 'pause' || opts.act === 'resume') { move(opts.act); return; }   // busy first: an empty list-mode render would close the host
  if (opts.act === 'end') D.sheet = 'end';
  render();
}
export function unmountDetail() { D.gen += 1; if (D.host) D.host.replaceChildren(); D.host = null; D.ctx = null; D.offer = null; D.sheet = null; D.only = false; }
export const detailOpen = () => !!D.host;
// a fresh list read: the page follows the offer's new rev (never mid-write)
export function refreshDetail(o) { if (D.host && !D.only && !D.busy && o && D.offer && o.id === D.offer.id) { D.offer = o; render(); } }
document.addEventListener('keydown', (e) => {
  if (D.host && D.sheet && !D.host.isConnected) { D.sheet = null; D.err = null; return; }   // the page lost the host under the sheet: let go (Codex r2)
  if (e.key === 'Tab' && D.host && D.sheet) { trapTab(e, D.host.querySelector('.mk5r-modal')); return; }   // Codex r1 P2-7
  if (e.key === 'Escape' && D.host && D.sheet && !D.busy) closeSheet();
});
function closeSheet() { D.sheet = null; D.err = null; render(); }
document.addEventListener('click', (e) => {   // a click outside the ⋯ menu closes it
  if (!D.host || !D.menu) return;
  if (e.target && e.target.closest && e.target.closest('.mk5d-kebab')) return;
  D.menu = false; render();
});

function render() {
  if (!D.host) return;
  const fk = focusKey(D.host);
  paint();
  if (!D.host) return;
  // the page keeps focus across a redraw; the sheet takes it, and gives it back to what opened it (Codex r1 P2-7)
  layered(D.fx, D.host, fk, D.only ? (D.sheet ? ['page', 'sheet'] : ['page']) : ['page', ...(D.sheet ? ['sheet'] : [])], () => D.host.querySelector('.mk5r-modal') || D.host);
}
function paint() {
  const o = D.offer;
  if (D.only) {   // the list's row move: its refusal + its sheet only; nothing left ⇒ done
    const out = [];
    if (D.err && !D.sheet) out.push(errRow(true));
    if (D.sheet === 'end') out.push(endSheet(o));
    if (!out.length && !D.busy) { const c = D.ctx; unmountDetail(); c.onClose && c.onClose(); return; }
    D.host.replaceChildren(...out);
    return;
  }
  const st = ML.statusView(o);
  const out = [];
  const back = el('button', 'mk5d-back'); back.type = 'button'; back.append(svg(BACK), document.createTextNode('Marketing'));
  back.addEventListener('click', () => D.ctx.onBack());
  out.push(back);
  const head = el('div', 'mk5d-head');
  const l = el('div', 'mk5d-l');
  l.append(el('h1', null, o.name));
  const meta = el('div', 'mk5d-meta');
  const sp = el('span', 'mk5-st'); sp.append(el('i', `mk5-dot mk5-${st.key}`), document.createTextNode(st.word));
  if (o.status === 'paused_owner') { sp.append(el('span', 'mk5-why', '· vos')); sp.title = 'Pausada por vos'; }
  meta.append(sp, el('span', 'mk5d-sep', '·'), el('span', null, 'Oferta'));
  const ml = detailMeta(o); if (ml) meta.append(el('span', 'mk5d-sep', '·'), el('span', null, ml));
  l.append(meta);
  head.append(l);
  if (D.ctx.canEdit) head.append(actions(o));
  out.push(head);
  if (o.status === 'paused_owner' && D.ctx.canEdit && ML.actionsOf(o).includes('resume')) {   // v5 5c: «Pausada por vos …» + «Reanudar» (the date is not stored)
    const strip = el('div', 'mk5d-strip'); strip.setAttribute('role', 'status');
    strip.append(svg(...PAUSE));
    const tx = el('span', 'mk5d-stxt'); tx.append(el('b', null, 'Pausada por vos'));   // v5 «… el 9 nov»: the date is SOURCE_GATE paused-date
    const rb = el('button', 'mk5d-sbtn', 'Reanudar'); rb.type = 'button'; rb.disabled = D.busy || OPS.unsettled(o.id); rb.addEventListener('click', () => move('resume'));
    strip.append(tx, rb);
    out.push(strip);
  }
  if (D.err && !D.sheet) out.push(errRow(false));
  // «Ver más»: the sourced part only (v5's Resultados / Límites progress / per-branch sales are SOURCE-GATED)
  const more = el('div', 'mk5d-more');
  const mb = el('button', 'mk5d-morebtn'); mb.type = 'button'; mb.setAttribute('aria-expanded', D.more ? 'true' : 'false');
  mb.append(document.createTextNode('Más detalles'), el('span', 'mk5d-morelbl', D.more ? 'Ver menos' : 'Ver más'));
  mb.addEventListener('click', () => { D.more = !D.more; render(); });
  more.append(mb);
  if (D.more) {
    const body = el('div', 'mk5d-morebody');
    const sec = el('div', 'mk5d-sec'); sec.append(el('h3', null, 'Cómo está armada'));
    const kv = el('div', 'mk5d-kv');
    for (const [k, v] of setup(o, D.ctx)) { const r = el('div', 'mk5d-r'); r.append(el('span', null, k), el('b', null, v)); kv.append(r); }
    sec.append(kv); body.append(sec);
    more.append(body);
  }
  out.push(more);
  if (D.sheet === 'end') out.push(endSheet(o));
  D.host.replaceChildren(...out);
}

function actions(o) {
  const box = el('div', 'mk5d-acts');
  const acts = ML.actionsOf(o);
  if (ML.editable(o) !== 'none' && o.state !== 'draft') { const b = el('button', 'mk5d-btn', 'Editar'); b.type = 'button'; b.addEventListener('click', () => D.ctx.onEdit(o)); box.append(b); }
  if (o.status === 'live' && acts.includes('pause')) { const b = el('button', 'mk5d-btn', 'Pausar'); b.type = 'button'; b.disabled = D.busy || OPS.unsettled(o.id); b.addEventListener('click', () => move('pause')); box.append(b); }
  const menu = [];
  if (acts.includes('repeat')) menu.push(['repeat', 'Repetir campaña']);
  if (acts.includes('end')) menu.push(['end', 'Terminar oferta']);
  if (menu.length) {
    const k = el('div', 'mk5d-kebab');
    const t = el('button', 'mk5d-more1'); t.type = 'button'; t.setAttribute('aria-label', 'Más acciones'); t.setAttribute('aria-haspopup', 'menu'); t.setAttribute('aria-expanded', D.menu ? 'true' : 'false');
    t.append(svg(...MORE)); t.addEventListener('click', () => { D.menu = !D.menu; render(); });
    const m = el('div', `mk5-menu${D.menu ? ' mk5-open' : ''}`); m.setAttribute('role', 'menu');
    for (const [a, word] of menu) {
      const b = el('button', a === 'end' ? 'mk5-opt mk5-danger' : 'mk5-opt'); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.dataset.act = a;
      if (a === 'end') b.append(svg(...STOP));
      b.append(document.createTextNode(word));
      b.addEventListener('click', () => { D.menu = false; D.err = null; t.focus(); if (a === 'end') { D.sheet = 'end'; render(); } else D.ctx.onRepeat(o); });   // the sheet hands focus back to «Más acciones»
      m.append(b);
    }
    k.append(t, m); box.append(k);
  }
  return box;
}

function errRow(closable) {
  const e = el('div', 'mk5b-err'); e.setAttribute('role', 'alert'); e.append(el('span', null, D.err));
  if (closable) { const c = el('button', 'mk5d-errx', 'Cerrar'); c.type = 'button'; c.addEventListener('click', () => { D.err = null; render(); }); e.append(c); }
  return e;
}
function errWord(c) {
  if (c.outcome === 'unknown') return 'No sabemos si se guardó. Volvé a la lista antes de intentar de nuevo.';
  return 'No pudimos hacer el cambio. Volvé a la lista e intentá de nuevo.';
}
// pause / resume / end: ONE state move through settleWrite
export async function move(kind) {
  if (D.busy || OPS.unsettled(D.offer.id)) return;
  const o = D.offer, g = D.gen, ctx = D.ctx, rid = ctx.rid, token = ctx.token;
  const to = kind === 'pause' ? 'paused_owner' : kind === 'resume' ? 'active' : 'ended';
  D.busy = true; D.err = null; render();
  const a = { op: 'state', offerId: o.id, expectedRev: o.rev, to, from: o.state };
  const r = await ML.settleWrite(a, () => offerSetStateRaw({ rid, offerId: o.id, to, expectedRev: o.rev, token }), () => getMarketingRaw({ rid, token }))
    .catch(() => ({ outcome: 'unknown' }));
  if (!D.host || D.gen !== g) { if (ctx.onChanged) ctx.onChanged(); return; }   // bound to the view it started in
  D.busy = false;
  if (r.outcome !== 'saved') { D.err = errWord(r); if (r.outcome === 'unknown') { OPS.markUnsettled(o.id, o.rev + 1); if (ctx.onChanged) ctx.onChanged(); } render(); return; }   // unsettled until a read reconciles it (Codex r2)
  D.offer = r.offer || o;
  D.sheet = null;
  const c = D.ctx;
  c.toast(DETAIL_TOAST[kind]);
  render();
  c.onChanged && c.onChanged();
}

// 5b · «¿Terminar «…»?» — the safe default on the left; v5's «Lleva» row is results (gated); «Después» is a fact
function endSheet(o) {
  const scrim = el('div', 'mk5r-scrim');
  scrim.addEventListener('click', (e) => { if (e.target === scrim && !D.busy) closeSheet(); });
  const m = el('div', 'mk5r-modal'); m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'endT');
  const mh = el('div', 'mk5r-mh'); const mt = el('div', 'mk5r-mt', `¿Terminar «${o.name}»?`); mt.id = 'endT';
  mh.append(mt, el('div', 'mk5r-ms', 'La oferta deja de mostrarse ahora. Los resultados quedan guardados.'));
  const mb = el('div', 'mk5r-mb');
  const kv = el('div', 'mk5d-kv'); const r = el('div', 'mk5d-r'); r.append(el('span', null, 'Después'), el('b', null, 'Queda como «Terminada» y podés repetirla cuando querás')); kv.append(r);
  mb.append(kv);
  if (D.err) { const e = el('div', 'mk5b-err'); e.setAttribute('role', 'alert'); e.append(el('span', null, D.err)); mb.append(e); }
  const mf = el('div', 'mk5r-mf');
  const back = el('button', 'mk5r-back', 'Volver'); back.type = 'button'; back.disabled = D.busy; back.addEventListener('click', closeSheet);
  const ok = el('button', 'mk5r-ok', 'Terminar oferta'); ok.type = 'button'; ok.disabled = D.busy || OPS.unsettled(o.id); ok.addEventListener('click', () => move('end'));
  mf.append(back, ok);
  m.append(mh, mb, mf); scrim.append(m);
  return scrim;
}

export const _detailState = D;   // test-only
