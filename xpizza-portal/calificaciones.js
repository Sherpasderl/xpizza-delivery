// P-1 «Calificaciones» — the «Rendimiento» tab's view, EXACT to MOCKUP-portal-calificaciones.html (advisor 11-13). One branch (the
// portal's restaurant), anonymous comments through getMerchantRatingComments only, paging by «more», never automatic. The figures follow
// the approved contract on the FIRST page: `stats` {rating_avg, rating_count} ⇒ two figures; null ⇒ the under-10 sentence; absent ⇒ no
// box. First paint = the final layout as quiet bars (the scope, the title and the anonymity line are real text), so nothing moves.
import { fetchRatingComments } from './api.js';
import { createCommentList, renderCommentRows, CAL_COPY, calCopy } from './calificaciones-logic.js';

export { CAL_COPY, calCopy };
const NS = 'http://www.w3.org/2000/svg';
const ICONS = Object.freeze({ building: 'M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6', refresh: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5' });
const SK_WIDTHS = ['38ch', '52ch', '27ch', '46ch', '33ch'];   // the mockup's five skeleton rows
// the published figures, re-checked: an average 1..5 and a count ≥ 10 (the producer's threshold), else not a figure
const statsOf = (b) => {
  if (!b || typeof b !== 'object' || !Object.prototype.hasOwnProperty.call(b, 'stats')) return undefined;
  const s = b.stats;
  if (s === null) return null;
  return s && typeof s.rating_avg === 'number' && s.rating_avg >= 1 && s.rating_avg <= 5 && Number.isInteger(s.rating_count) && s.rating_count >= 10
    ? { avg: s.rating_avg, count: s.rating_count } : undefined;
};

let V = null;
function mount(el, ctx) {
  const doc = el.ownerDocument || globalThis.document;
  const v = { el, doc, ctx, stats: undefined, shown: 0 };
  v.list = createCommentList({ rid: ctx.rid, fetchPage: async ({ rid, cursor }) => {
    const body = await fetchRatingComments({ rid, cursor, token: ctx.token });
    if (cursor === undefined) v.stats = statsOf(body);
    return body;
  } });
  V = v;
  paintLoading(v);
  load(v);
}
function unmount() { const v = V; V = null; if (v && v.onResize && v.doc.defaultView) v.doc.defaultView.removeEventListener('resize', v.onResize); }
export const calificacionesTab = Object.freeze({ id: 'calificaciones', label: 'Calificaciones', mount, unmount });

const mk = (v, tag, cls, text) => { const n = v.doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
function icon(v, d) {
  const s = v.doc.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  const p = v.doc.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); return s;
}
function scopeLine(v) { const s = mk(v, 'div', 'calif-scope'); s.append(icon(v, ICONS.building), mk(v, 'span', null, v.ctx.scopeLabel || '')); return s; }
function sect(v) {
  const s = mk(v, 'div', 'sect'); const d = mk(v, 'div');
  d.append(mk(v, 'h2', null, calCopy('title')), mk(v, 'div', 'subl', calCopy('anon'))); s.append(d); return s;
}
function figures(v) {
  if (v.stats === undefined) return null;
  const box = mk(v, 'div', v.stats === null ? 'kfigs surface say' : 'kfigs surface');
  if (v.stats === null) {
    const f = mk(v, 'div', 'kfig'); f.append(mk(v, 'div', 'kl', calCopy('avg')), mk(v, 'div', 'ksay', calCopy('under10'))); box.append(f); return box;
  }
  for (const [label, value, cap] of [[calCopy('avg'), v.stats.avg.toFixed(1), calCopy('avgOf')], [calCopy('count'), String(v.stats.count), calCopy('countTotal')]]) {
    const f = mk(v, 'div', 'kfig'); const n = mk(v, 'div', 'kn', value); n.append(mk(v, 'small', null, cap));
    f.append(mk(v, 'div', 'kl', label), n); box.append(f);
  }
  return box;
}
function root(v) { const r = mk(v, 'div', 'calif'); v.el.replaceChildren(r); return r; }

function paintLoading(v) {
  const r = root(v);
  const st = mk(v, 'div', 'calif-state'); st.setAttribute('aria-busy', 'true');
  const figs = mk(v, 'div', 'kfigs surface sk'); figs.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 2; i++) { const f = mk(v, 'div', 'kfig'); f.append(mk(v, 'span', 'skb l'), mk(v, 'span', 'skb n')); figs.append(f); }
  const list = mk(v, 'div', 'clist'); list.setAttribute('aria-hidden', 'true');
  for (const w of SK_WIDTHS) { const row = mk(v, 'div', 'skrow'); const t = mk(v, 'span', 'skb t'); t.style.width = w; row.append(mk(v, 'span', 'skb s'), t); list.append(row); }
  const pager = mk(v, 'div', 'pager'); pager.setAttribute('aria-hidden', 'true'); pager.append(mk(v, 'span', 'skb b'));
  const sr = mk(v, 'span', 'sr-only', calCopy('srLoading'));
  st.append(figs, sect(v), list, pager, sr);
  r.append(scopeLine(v), st);
}
function errorBox(v, onRetry) {
  const box = mk(v, 'div', 'cerr'); box.setAttribute('role', 'alert');
  box.append(mk(v, 'b', null, calCopy(onRetry ? 'errTitle' : 'deniedTitle')), mk(v, 'p', null, calCopy(onRetry ? 'errBody' : 'deniedBody')));
  if (onRetry) { const b = v.doc.createElement('button'); b.className = 'btn'; b.type = 'button'; b.append(icon(v, ICONS.refresh), v.doc.createTextNode(calCopy('retry'))); b.addEventListener('click', onRetry); box.append(b); }
  return box;
}

async function load(v) {
  const st = await v.list.load();
  if (V !== v) return;
  paint(v, st);
}
// the whole view for a settled state; once rows exist, a later page only APPENDS below and swaps the pager (nothing above moves)
function paint(v, st) {
  if (st.phase === 'denied') { const r = root(v); r.append(scopeLine(v), errorBox(v, null)); v.shown = 0; return; }
  const firstError = st.rows.length === 0 && (st.phase === 'error' || st.phase === 'signin');
  if (v.shown === 0 || firstError) {
    const r = root(v); r.append(scopeLine(v));
    const figs = figures(v); if (figs) r.append(figs);
    r.append(sect(v));
    if (firstError) { r.append(errorBox(v, () => { paintLoading(v); load(v); })); v.shown = 0; return; }
    if (st.phase === 'empty') { const e = mk(v, 'div', 'cempty'); e.append(mk(v, 'b', null, calCopy('emptyTitle')), mk(v, 'p', null, calCopy('emptyBody'))); r.append(e); return; }
    v.listEl = mk(v, 'div', 'clist'); r.append(v.listEl);
    v.pagerEl = mk(v, 'div', 'pager'); r.append(v.pagerEl);
  }
  v.listEl.append(renderCommentRows(v.doc, st.rows.slice(v.shown)));
  v.shown = st.rows.length;
  clampLater(v);
  pager(v, st);
}
function pager(v, st) {
  const p = v.pagerEl;
  if (st.phase === 'error' || st.phase === 'signin') { p.replaceChildren(errorBox(v, () => more(v))); return; }
  if (!st.more) { p.replaceChildren(mk(v, 'div', 'endl', calCopy('end'))); return; }
  const b = v.doc.createElement('button'); b.className = 'btn'; b.type = 'button'; b.textContent = calCopy('more');
  b.addEventListener('click', () => more(v, b));
  p.replaceChildren(b);
}
async function more(v, btn) {
  if (btn) { btn.disabled = true; btn.textContent = calCopy('loading'); }
  else { const b = mk(v, 'button', 'btn', calCopy('loading')); b.type = 'button'; b.disabled = true; v.pagerEl.replaceChildren(b); }
  await load(v);
}
// «Leer más» shows only where the text really overflows its three lines (after layout); resizing re-checks while the view is mounted
function clampCheck(v) {
  if (V !== v || !v.listEl) return;
  for (const row of v.listEl.querySelectorAll('.crow')) { const p = row.querySelector('.ctxt'); if (p && p.classList.contains('clamp')) row.classList.toggle('long', p.scrollHeight > p.clientHeight + 1); }
}
function clampLater(v) {
  const w = v.doc.defaultView;
  if (w && typeof w.requestAnimationFrame === 'function') w.requestAnimationFrame(() => clampCheck(v));
  if (w && !v.onResize && typeof w.addEventListener === 'function') { v.onResize = () => clampCheck(v); w.addEventListener('resize', v.onResize); }
}
