// «Calificaciones» — the page body (its own nav entry since Nav B, calificaciones-view.js), EXACT to MOCKUP-portal-calificaciones-step2
// .html (owner-APPROVED 11-15 as drawn; Q1–Q5 as recommended; PLAN-portal-calificaciones-step2 r0.1). The scope row (the period = the
// last N CLOSED weeks + its range, the branch), the Overview (all-time figures per branch from public_stats + the per-star bars of the
// window's NAMED ratings), the named list (stars + comment filters, paging by «more», never automatic) and «Calificaciones anteriores»
// (the v1 anonymous comments, per branch only). getMerchantReviews (3a reviews v2) carries the Overview on its FIRST page.
// First paint = the final layout: pills, range, titles and sublines are real text; the data replaces the bones in one paint (rule 7).
// The branch list arrives in the background (getMyBranches, never awaited on first paint): the pill starts as the page's own branch.
import { fetchRatingComments, fetchMerchantReviews, getMyBranches } from './api.js';
import { el } from './ops-dom.js';   // every clickable is built by el() — the shape portal-wiring's pointer guard resolves
import { createCommentList, renderCommentRows, createReviewList, periodOf, starsLabel, ratedLabel, initialsOf, WEEKS, DEFAULT_WEEKS, CAL_COPY, calCopy } from './calificaciones-logic.js';

export { CAL_COPY, calCopy };
const NS = 'http://www.w3.org/2000/svg';
const ICONS = Object.freeze({
  refresh: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5', down: 'M6 9l6 6 6-6', check: 'M5 12l5 5L20 7',
  star: 'M12 2.5l2.9 6 6.6 1-4.8 4.6 1.1 6.6L12 17.6l-5.8 3.1 1.1-6.6L2.5 9.5l6.6-1z', person: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2',
});
const SK_WIDTHS = ['38ch', '52ch', null, '46ch', '33ch'];   // the mockup's five bones (the third: a commentless row)
const SK_V1 = ['40ch', '29ch', '48ch'];
const WEEKS_KEY = 'sherpa.portal.calif.weeks';   // Q1: the period choice, remembered per browser
const readWeeks = (w) => { try { const n = Number(w.localStorage.getItem(WEEKS_KEY)); return WEEKS.includes(n) ? n : DEFAULT_WEEKS; } catch (_) { return DEFAULT_WEEKS; } };
const saveWeeks = (w, n) => { try { w.localStorage.setItem(WEEKS_KEY, String(n)); } catch (_) { /* a blocked store: this visit only */ } };

let V = null;
function mount(el, ctx) {
  const doc = el.ownerDocument || globalThis.document;
  const win = doc.defaultView;
  const now = typeof ctx.now === 'function' ? ctx.now : () => Date.now();
  const v = { el, doc, win, ctx, now, weeks: readWeeks(win), scope: ctx.rid, branches: [{ rid: ctx.rid, name: ctx.scopeLabel || '' }],
    stars: [], comment: 'any', seq: 0, earlierRid: ctx.rid, menu: null };
  v.onDoc = (e) => onDocClick(v, e); v.onKey = (e) => { if (e.key === 'Escape' && v.menu) { closeMenu(v); } };
  document.addEventListener('click', v.onDoc); document.addEventListener('keydown', v.onKey);
  V = v;
  start(v);
  branchesOf(v);
}
function unmount() {
  const v = V; V = null;
  if (!v) return;
  document.removeEventListener('click', v.onDoc); document.removeEventListener('keydown', v.onKey);
  if (v.onResize && v.win) v.win.removeEventListener('resize', v.onResize);
}
export const calificacionesTab = Object.freeze({ id: 'calificaciones', label: 'Calificaciones', mount, unmount });

const mk = (v, tag, cls, text) => { const n = v.doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
function icon(v, d) {
  const s = v.doc.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  const p = v.doc.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p);
  return s;
}
function personIcon(v) {   // the mockup's #i-user: the shoulders + the head
  const s = icon(v, ICONS.person);
  const c = v.doc.createElementNS(NS, 'circle'); c.setAttribute('cx', '12'); c.setAttribute('cy', '7'); c.setAttribute('r', '4'); s.append(c);
  return s;
}
const rids = (v) => (v.scope === 'all' ? v.branches.map((b) => b.rid) : [v.scope]);
const nameOf = (v, rid) => (v.branches.find((b) => b.rid === rid) || { name: rid }).name || rid;
const filtered = (v) => v.stars.length > 0 || v.comment !== 'any';

// ── the lists: a NEW named list for every scope / period / filter change (latest request wins: a stale answer is never painted);
// the earlier (v1) list per branch, independent of the period and the filters ──────────────────────────────────────────────────────
// keep: a LIST filter change — the Overview ignores the list filters (the approved notes), so it and the filters stay put; only the
// list area re-loads (no flash, no reflow above it)
function start(v, { keep = false } = {}) {
  const prev = v.named && v.named.st;
  v.keep = keep && prev && (prev.phase === 'ready' || prev.phase === 'empty') ? { overview: prev.overview } : (keep && v.keep ? v.keep : null);
  v.seq += 1; const seq = v.seq;
  const list = createReviewList({ rids: rids(v), fetchPage: ({ cursor }) => fetchMerchantReviews({ rids: rids(v), weeks: v.weeks, stars: v.stars, comment: v.comment, cursor, token: v.ctx.token }) });
  v.named = { list, st: null, seq };
  if (!v.earlier || v.earlier.rid !== v.earlierRid) startEarlier(v);
  paint(v);
  loadNamed(v, seq);
}
function startEarlier(v) {
  const rid = v.earlierRid;
  v.earlier = { rid, st: null, list: createCommentList({ rid, fetchPage: ({ cursor }) => fetchRatingComments({ rid, cursor, token: v.ctx.token }) }) };
  loadEarlier(v, v.earlier);
}
async function loadNamed(v, seq) {
  const st = await v.named.list.load();
  if (V !== v || v.named.seq !== seq) return;   // a newer scope / filter / period: this answer is dropped
  const firstPaint = !v.named.st || v.named.st.phase === 'error';
  v.named.st = st;
  if (firstPaint || !v.namedEl) paint(v); else appendNamed(v);
}
async function loadEarlier(v, e) {
  const st = await e.list.load();
  if (V !== v || v.earlier !== e) return;
  const first = !e.st || e.st.phase === 'error';
  e.st = st;
  if (first || !v.earlierEl) paint(v); else appendEarlier(v);
}
// the branches the owner reads stats for (getMyBranches, the page's own first) — in the background; the pill keeps its place
async function branchesOf(v) {
  let e1 = null;
  try { e1 = await getMyBranches({ token: v.ctx.token }); } catch (_) { return; }
  if (V !== v || !e1 || !Array.isArray(e1.branches)) return;
  const me = e1.branches.find((b) => b && b.rid === v.ctx.rid);
  if (!me) return;
  const list = e1.branches.filter((b) => b && b.brand_id === me.brand_id && b.state === 'member' && b.role === 'owner' && Array.isArray(b.caps) && b.caps.includes('stats.read'));
  if (!list.length) return;
  const own = list.find((b) => b.rid === v.ctx.rid);
  v.branches = [own, ...list.filter((b) => b.rid !== v.ctx.rid)].map((b) => ({ rid: b.rid, name: b.name || b.rid }));
  repaintScopeRow(v);   // the pill's label and box are unchanged (the page's own branch); only its menu gains the options
}

// ── the menus (one open at a time; outside click / Escape closes) ────────────────────────────────────────────────────────────────
function closeMenu(v) { if (!v.menu) return; v.menu.menu.classList.remove('cf-show'); v.menu.btn.setAttribute('aria-expanded', 'false'); v.menu = null; }
function onDocClick(v, e) { if (v.menu && !v.menu.wrap.contains(e.target)) closeMenu(v); }
function pill(v, { label, on, role, aria, items, onPick, multi, disabled, open }) {
  const wrap = mk(v, 'div', 'cf-kebab');
  const b = el('button', `cf-pill${on ? ' cf-on' : ''}`); b.type = 'button';
  b.append(v.doc.createTextNode(label), icon(v, ICONS.down));
  if (disabled) { b.disabled = true; wrap.append(b); return wrap; }
  b.setAttribute('aria-haspopup', role === 'menu' ? 'menu' : 'listbox'); b.setAttribute('aria-expanded', 'false');
  const m = mk(v, 'div', 'cf-menu'); m.setAttribute('role', role); m.setAttribute('aria-label', aria);
  for (const it of items) {
    const o = el('button', 'cf-opt'); o.type = 'button';
    if (multi) {
      o.setAttribute('role', 'menuitemcheckbox'); o.setAttribute('aria-checked', String(!!it.selected));
      const cb = mk(v, 'span', it.selected ? 'cf-cb cf-chk' : 'cf-cb'); cb.append(icon(v, ICONS.check)); o.append(cb, v.doc.createTextNode(it.label));
    } else {
      o.setAttribute('role', 'option'); if (it.selected) o.setAttribute('aria-selected', 'true');
      o.append(v.doc.createTextNode(it.label)); if (it.range) o.append(mk(v, 'span', 'cf-mr', it.range));
      if (it.selected) o.append(mk(v, 'span', 'cf-dot'));   // the chosen option's dot (the mockup's ::after, as an element: colour sites stay plain classes)
    }
    o.addEventListener('click', (e) => { e.stopPropagation(); onPick(it.value, o); });
    m.append(o);
  }
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = v.menu && v.menu.btn === b;
    closeMenu(v);
    if (!open) { m.classList.add('cf-show'); b.setAttribute('aria-expanded', 'true'); v.menu = { wrap, btn: b, menu: m }; }
  });
  wrap.append(b, m);
  if (open) { m.classList.add('cf-show'); b.setAttribute('aria-expanded', 'true'); v.menu = { wrap, btn: b, menu: m }; }
  return wrap;
}

// ── the scope row: the period (closed weeks) + its explicit range + the branch ───────────────────────────────────────────────────
function scopeRow(v) {
  const row = mk(v, 'div', 'cf-filt'); row.setAttribute('role', 'group'); row.setAttribute('aria-label', calCopy('scopeGroup'));
  const p = periodOf(v.weeks, v.now());
  row.append(pill(v, { label: p.label, on: true, role: 'listbox', aria: calCopy('periodMenu'),
    items: WEEKS.map((w) => { const x = periodOf(w, v.now()); return { value: w, label: x.label, range: x.range, selected: w === v.weeks }; }),
    onPick: (w) => { closeMenu(v); if (w === v.weeks) return; v.weeks = w; saveWeeks(v.win, w); start(v); } }));
  const rl = mk(v, 'span', 'cf-vrl', p.range); row.append(rl);
  const all = v.scope === 'all';
  row.append(pill(v, { label: all ? calCopy('allBranches') : `${calCopy('branchPrefix')} ${nameOf(v, v.scope)}`, on: all, role: 'listbox', aria: calCopy('branchMenu'),
    items: [{ value: 'all', label: calCopy('allBranches'), selected: all }, ...v.branches.map((b) => ({ value: b.rid, label: b.name, selected: !all && b.rid === v.scope }))],
    onPick: (r) => { closeMenu(v); if (r === v.scope) return; v.scope = r; if (r !== 'all') v.earlierRid = r; start(v); } }));
  return row;
}
function repaintScopeRow(v) { if (v.scopeEl && v.scopeEl.isConnected) { const n = scopeRow(v); v.scopeEl.replaceWith(n); v.scopeEl = n; } }

// ── the Overview: two groups, two bases, each stating its own ───────────────────────────────────────────────────────────────────
function figuresOne(v, f) {
  const g = mk(v, 'div', 'ovg all');
  if (!f) { const k = mk(v, 'div', 'kfig'); k.append(mk(v, 'div', 'kl', calCopy('avg')), mk(v, 'p', 'ksay', calCopy('under10'))); g.append(k); }
  else for (const [l, val, cap] of [[calCopy('avg'), f.average.toFixed(1), calCopy('avgOf')], [calCopy('count'), String(f.count), calCopy('countTotal')]]) {
    const k = mk(v, 'div', 'kfig'); const n = mk(v, 'div', 'kn', val); n.append(mk(v, 'small', null, cap)); k.append(mk(v, 'div', 'kl', l), n); g.append(k);
  }
  g.append(mk(v, 'div', 'kbase', calCopy('allBase')));
  return g;
}
function figuresMany(v, byRid) {   // «Todas las sucursales»: one line per branch, never combined
  const g = mk(v, 'div', 'ovg all many');
  for (const b of v.branches) {
    const f = byRid && byRid[b.rid];
    const r = mk(v, 'div', 'cf-brow'); r.append(mk(v, 'span', 'cf-bn', b.name));
    if (f) { const n = mk(v, 'b', null, f.average.toFixed(1)); n.append(mk(v, 'small', null, calCopy('avgOf'))); r.append(n, mk(v, 'span', null, `${f.count} ${calCopy('countUnit')}`)); }
    else r.append(mk(v, 'span', 'cf-few', calCopy('few')));
    g.append(r);
  }
  g.append(mk(v, 'div', 'kbase', calCopy('allBaseMany')));
  return g;
}
function bars(v, ov, notLive) {
  const p = periodOf(v.weeks, v.now());
  const g = mk(v, 'div', 'ovg bars');
  const k = mk(v, 'div', 'kfig dist'); k.append(mk(v, 'div', 'kl', calCopy('byStars')));
  if (ov && ov.stars && !notLive) {
    g.dataset.mode = 'ok';
    const d = mk(v, 'div', 'dist'); d.setAttribute('role', 'img');
    const n = ov.starsN, b = [5, 4, 3, 2, 1].map((s) => ov.stars[s]);
    d.setAttribute('aria-label', `${b[0]} de 5 estrellas, ${b[1]} de 4, ${b[2]} de 3, ${b[3]} de 2, ${b[4]} de 1`);
    b.forEach((x, i) => {
      const s = 5 - i;
      const dl = mk(v, 'span', 'cf-dl', String(s)); dl.append(icon(v, ICONS.star));
      const dt = mk(v, 'span', 'dt'); const df = mk(v, 'span', `df${s >= 4 ? ' pos' : s <= 2 ? ' neg' : ''}`); df.style.width = `${Math.round((x / n) * 1000) / 10}%`; dt.append(df);
      d.append(dl, dt, mk(v, 'span', 'cf-dn', String(x)));
    });
    k.append(d); g.append(k, mk(v, 'div', 'kbase', `${n} ${calCopy('namedBase')} · ${p.low}`));
  } else {
    g.dataset.mode = 'floor';
    k.append(mk(v, 'p', 'ksay', calCopy(notLive ? 'notLiveBars' : 'floor'))); g.append(k, mk(v, 'div', 'kbase', `${calCopy('namedBaseNone')} · ${p.low}`));
  }
  return g;
}
function overview(v, ov, notLive) {
  const box = mk(v, 'div', 'kfigs surface ov');
  box.append(v.scope === 'all' ? figuresMany(v, ov && ov.publicByRid) : figuresOne(v, ov && ov.publicOne), bars(v, ov, notLive));
  return box;
}

// ── the named list: section, filters, rows, pager ─────────────────────────────────────────────────────────────────────────────
function listSect(v) {
  const s = mk(v, 'div', 'sect'); const d = mk(v, 'div');
  d.append(mk(v, 'h2', null, calCopy('title')), mk(v, 'div', 'subl', periodOf(v.weeks, v.now()).from)); s.append(d); return s;
}
function filters(v, disabled) {
  const row = mk(v, 'div', 'cf-filt cf-sub');
  if (disabled) row.setAttribute('aria-hidden', 'true'); else { row.setAttribute('role', 'group'); row.setAttribute('aria-label', calCopy('listGroup')); }
  row.append(pill(v, { label: starsLabel(v.stars), on: v.stars.length > 0, role: 'menu', aria: calCopy('starsPill'), multi: true, disabled,
    open: !disabled && v.reopen === 'stars',   // a multi-select: the menu stays open across picks (the mockup)
    items: [5, 4, 3, 2, 1].map((s) => ({ value: s, label: starsLabel([s]), selected: v.stars.includes(s) })),
    onPick: (s) => { v.stars = v.stars.includes(s) ? v.stars.filter((x) => x !== s) : [...v.stars, s]; v.reopen = 'stars'; start(v, { keep: true }); } }));
  const cmWord = { any: calCopy('commentPill'), with: calCopy('cmWith'), without: calCopy('cmWithout') };
  row.append(pill(v, { label: cmWord[v.comment], on: v.comment !== 'any', role: 'listbox', aria: calCopy('commentPill'), disabled,
    items: [['any', 'cmAll'], ['with', 'cmWith'], ['without', 'cmWithout']].map(([value, k]) => ({ value, label: calCopy(k), selected: v.comment === value })),
    onPick: (c) => { closeMenu(v); if (c === v.comment) return; v.comment = c; start(v, { keep: true }); } }));
  if (!disabled && filtered(v)) { const q = el('button', 'qact', calCopy('clear')); q.type = 'button'; q.addEventListener('click', () => clearFilters(v)); row.append(q); }
  return row;
}
function clearFilters(v) { v.stars = []; v.comment = 'any'; start(v, { keep: true }); }
function starsEl(v, n) {
  const st = mk(v, 'span', 'stars'); st.setAttribute('role', 'img'); st.setAttribute('aria-label', `${n} de 5 estrellas`);
  for (let i = 1; i <= 5; i += 1) { const s = icon(v, ICONS.star); if (i > n) s.setAttribute('class', 'e'); st.append(s); }
  return st;
}
function namedRow(v, r) {
  const row = mk(v, 'div', 'crow');
  const av = mk(v, 'span', r.customer ? `cav ${r.tone === null ? 'anon' : `t${r.tone}`}` : 'cav anon'); av.setAttribute('aria-hidden', 'true');
  if (r.customer) av.textContent = initialsOf(r.customer); else av.append(personIcon(v));
  const body = mk(v, 'div', 'cbody'); const hd = mk(v, 'div', 'chd');
  hd.append(mk(v, 'b', r.customer ? 'cname' : 'cname anon', r.customer || 'Cliente')); body.append(hd, starsEl(v, r.stars));
  if (r.comment) {
    const p = mk(v, 'p', 'ctxt clamp', r.comment);
    const more = el('button', 'qact cmore', calCopy('readMore')); more.type = 'button'; more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', () => { const open = p.classList.contains('clamp'); p.classList.toggle('clamp', !open); more.textContent = calCopy(open ? 'readLess' : 'readMore'); more.setAttribute('aria-expanded', String(open)); });
    body.append(p, more);
  }
  const meta = mk(v, 'div', 'cf-meta', ratedLabel(r.ratedOn, v.now()));
  if (r.edited) { meta.append(v.doc.createTextNode(' ')); meta.append(mk(v, 'span', 'cf-ed', `· ${calCopy('edited')}`)); }
  body.append(meta); row.append(av, body);
  return row;
}
function errorBox(v, onRetry, denied) {
  const box = mk(v, 'div', 'cerr'); box.setAttribute('role', 'alert');
  box.append(mk(v, 'b', null, calCopy(denied ? 'deniedTitle' : 'errTitle')), mk(v, 'p', null, calCopy(denied ? 'deniedBody' : 'errBody')));
  if (onRetry) { const b = el('button', 'btn'); b.type = 'button'; b.append(icon(v, ICONS.refresh), v.doc.createTextNode(calCopy('retry'))); b.addEventListener('click', onRetry); box.append(b); }
  return box;
}
function namedPager(v) {
  const p = v.namedPagerEl; const st = v.named.st;
  if (st.phase === 'error' || st.phase === 'signin') { p.replaceChildren(errorBox(v, () => moreNamed(v))); return; }
  if (!st.more) { p.replaceChildren(mk(v, 'div', 'endl', calCopy('endNamed'))); return; }
  const b = el('button', 'btn', calCopy('moreNamed')); b.type = 'button'; b.addEventListener('click', () => moreNamed(v, b)); p.replaceChildren(b);
}
function moreNamed(v, btn) {
  const b = btn || el('button', 'btn'); b.disabled = true; b.textContent = calCopy('loading'); if (!btn) v.namedPagerEl.replaceChildren(b);
  loadNamed(v, v.named.seq);
}
function appendNamed(v) { const st = v.named.st; v.namedEl.append(...st.rows.slice(v.namedShown).map((r) => namedRow(v, r))); v.namedShown = st.rows.length; namedPager(v); clampLater(v); }

// ── «Calificaciones anteriores»: the v1 anonymous comments, per branch only (a branch switch under «Todas») ──────────────────────
function earlierBlock(v, out) {
  const s = mk(v, 'div', 'sect earlier'); const d = mk(v, 'div'); d.append(mk(v, 'h2', null, calCopy('earlierTitle')), mk(v, 'div', 'subl', calCopy('earlierSub'))); s.append(d); out.push(s);
  if (v.scope === 'all' && v.branches.length > 1) {
    const seg = mk(v, 'div', 'cf-seg'); seg.setAttribute('role', 'tablist'); seg.setAttribute('aria-label', calCopy('earlierTabs'));
    for (const b of v.branches) {
      const t = el('button', 'cf-tab', b.name); t.type = 'button'; if (b.rid === v.earlierRid) t.classList.add('cf-sel'); t.setAttribute('role', 'tab'); t.setAttribute('aria-selected', String(b.rid === v.earlierRid));
      t.addEventListener('click', () => { if (v.earlierRid === b.rid) return; v.earlierRid = b.rid; startEarlier(v); paint(v); });
      seg.append(t);
    }
    out.push(seg);
  }
  const e = v.earlier, st = e && e.st;
  if (!st) { const l = mk(v, 'div', 'clist'); l.setAttribute('aria-hidden', 'true'); for (const w of SK_V1) { const r = mk(v, 'div', 'skrow v1'); const k = mk(v, 'div', 'skl'); const a = mk(v, 'span', 'skb a'); a.style.marginTop = '0'; const t = mk(v, 'span', 'skb t'); t.style.width = w; k.append(a, t); r.append(k); l.append(r); } out.push(l); v.earlierEl = null; return; }
  if (st.phase === 'denied' || ((st.phase === 'error' || st.phase === 'signin') && !st.rows.length)) {
    // both calls failed ⇒ ONE «Reintentar» (in the named area) reloads both; else the earlier section's own box retries it alone
    const namedFailed = v.named.st && (v.named.st.phase === 'error' || v.named.st.phase === 'signin') && !v.named.st.rows.length;
    out.push(errorBox(v, namedFailed || st.phase === 'denied' ? null : () => { startEarlier(v); paint(v); }, st.phase === 'denied')); v.earlierEl = null; return;
  }
  if (st.phase === 'empty') { const c = mk(v, 'div', 'cempty tight'); c.append(mk(v, 'b', null, calCopy('emptyTitle')), mk(v, 'p', null, calCopy('emptyBody'))); out.push(c); v.earlierEl = null; return; }
  v.earlierEl = mk(v, 'div', 'clist'); v.earlierEl.append(renderCommentRows(v.doc, st.rows)); v.earlierShown = st.rows.length; out.push(v.earlierEl);
  v.earlierPagerEl = mk(v, 'div', 'pager'); out.push(v.earlierPagerEl); earlierPager(v);
}
function earlierPager(v) {
  const st = v.earlier.st, p = v.earlierPagerEl;
  if (st.phase === 'error' || st.phase === 'signin') { p.replaceChildren(errorBox(v, () => moreEarlier(v))); return; }
  if (!st.more) { p.replaceChildren(mk(v, 'div', 'endl', calCopy('end'))); return; }
  const b = el('button', 'btn', calCopy('more')); b.type = 'button'; b.addEventListener('click', () => moreEarlier(v, b)); p.replaceChildren(b);
}
function moreEarlier(v, btn) {
  const b = btn || el('button', 'btn'); b.disabled = true; b.textContent = calCopy('loading'); if (!btn) v.earlierPagerEl.replaceChildren(b);
  loadEarlier(v, v.earlier);
}
function appendEarlier(v) { const st = v.earlier.st; v.earlierEl.append(renderCommentRows(v.doc, st.rows.slice(v.earlierShown))); v.earlierShown = st.rows.length; earlierPager(v); clampLater(v); }

// ── the whole page for the current state ──────────────────────────────────────────────────────────────────────────────────────
function listBones(v, out) {
  const l = mk(v, 'div', 'clist'); l.setAttribute('aria-hidden', 'true');
  for (const w of SK_WIDTHS) { const r = mk(v, 'div', 'skrow'); const kk = mk(v, 'div', 'skl'); kk.append(mk(v, 'span', 'skb s'), mk(v, 'span', 'skb a')); if (w) { const t = mk(v, 'span', 'skb t'); t.style.width = w; kk.append(t); } kk.append(mk(v, 'span', 'skb m')); r.append(mk(v, 'span', 'skb c'), kk); l.append(r); }
  const pg = mk(v, 'div', 'pager'); pg.setAttribute('aria-hidden', 'true'); pg.append(mk(v, 'span', 'skb b'));
  out.push(l, pg);
}
function bones(v, out) {
  const ov = mk(v, 'div', 'kfigs surface ov sk'); ov.setAttribute('aria-hidden', 'true');
  const a = mk(v, 'div', 'ovg all'); for (let i = 0; i < 2; i += 1) { const k = mk(v, 'div', 'kfig'); k.append(mk(v, 'span', 'skb l'), mk(v, 'span', 'skb n')); a.append(k); } a.append(mk(v, 'span', 'skb base'));
  const b = mk(v, 'div', 'ovg bars'); const k = mk(v, 'div', 'kfig dist'); k.append(mk(v, 'span', 'skb l'), mk(v, 'span', 'skb d')); b.append(k, mk(v, 'span', 'skb base bb'));
  ov.append(a, b); out.push(ov, listSect(v), filters(v, true));
  listBones(v, out);
}
function paint(v) {
  closeMenu(v);
  const r = mk(v, 'div', 'calif');
  const out = [];
  v.scopeEl = scopeRow(v); out.push(v.scopeEl);
  const st = v.named.st;
  v.namedEl = null;
  if (!st && v.keep) {   // a list filter changed: the Overview + filters as they were, the list's own bones
    out.push(overview(v, v.keep.overview, false), listSect(v), filters(v, false)); listBones(v, out);
    r.setAttribute('aria-busy', 'true'); out.push(mk(v, 'span', 'sr-only', calCopy('srLoading')));
  } else if (!st) { bones(v, out); r.setAttribute('aria-busy', 'true'); out.push(mk(v, 'span', 'sr-only', calCopy('srLoading'))); }
  else if (st.phase === 'denied') out.push(errorBox(v, null, true));
  else if ((st.phase === 'error' || st.phase === 'signin') && !st.rows.length) {
    out.push(errorBox(v, () => { if (v.earlier && v.earlier.st && v.earlier.st.phase !== 'ready' && v.earlier.st.phase !== 'empty') startEarlier(v); start(v); }));
  } else {
    const notLive = st.phase === 'empty' && !filtered(v);   // Q3: «not live yet» and «no named rating yet» share ONE honest copy
    out.push(overview(v, st.overview, notLive), listSect(v));
    if (notLive) { const c = mk(v, 'div', 'cempty'); c.append(mk(v, 'b', null, calCopy('notLiveTitle')), mk(v, 'p', null, calCopy('notLiveBody'))); out.push(c); }
    else {
      out.push(filters(v, false));
      if (st.phase === 'empty') {
        const c = mk(v, 'div', 'cempty tight'); c.append(mk(v, 'b', null, calCopy('filtEmptyTitle')), mk(v, 'p', null, calCopy('filtEmptyBody')));
        const q = el('button', 'btn', calCopy('clear')); q.type = 'button'; q.addEventListener('click', () => clearFilters(v)); c.append(q); out.push(c);
      } else {
        v.namedEl = mk(v, 'div', 'clist'); v.namedEl.append(...st.rows.map((x) => namedRow(v, x))); v.namedShown = st.rows.length; out.push(v.namedEl);
        v.namedPagerEl = mk(v, 'div', 'pager'); out.push(v.namedPagerEl); namedPager(v);
      }
    }
  }
  if (!st || st.phase !== 'denied') earlierBlock(v, out);
  r.append(...out);
  v.el.replaceChildren(r);
  if (st) v.reopen = null;
  clampLater(v);
}
// «Leer más» only where the text really overflows its three lines (after layout); resizing re-checks while mounted
function clampCheck(v) {
  if (V !== v) return;
  for (const row of v.el.querySelectorAll('.crow')) { const p = row.querySelector('.ctxt'); if (p && p.classList.contains('clamp')) row.classList.toggle('long', p.scrollHeight > p.clientHeight + 1); }
}
function clampLater(v) {
  const w = v.win;
  if (w && typeof w.requestAnimationFrame === 'function') w.requestAnimationFrame(() => clampCheck(v));
  if (w && !v.onResize && typeof w.addEventListener === 'function') { v.onResize = () => clampCheck(v); w.addEventListener('resize', v.onResize); }
}
export const _califState = () => V;   // test-only
