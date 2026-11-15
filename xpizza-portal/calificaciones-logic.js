// P-1 «Calificaciones» (PLAN-portal-p1-calificaciones-r0, advisor rulings 2026-11-13) — the pure half: the comment list's paging
// state and its rows. The server (getMerchantRatingComments) returns at most 20 live, non-empty comments per call, ANONYMOUS
// ({ comment, store } — no dates, dishes or identity, by design), newest fulfilment first; it scans a bounded number of index keys per
// call, so a page can come back EMPTY with a non-null cursor. `cursor: null` is the end.
//
// No cache: every visit builds a new list and re-reads, so an edited / withdrawn / deleted rating is right on the next visit.

export const FOLLOW_MAX = 3;   // calls one load may send while pages come back empty (a click never runs a long scan)

// ONE row = exactly { comment, stars }: an allowlist, so a field the server may add later can never reach the DOM by accident
export function commentRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const comment = typeof raw.comment === 'string' ? raw.comment.trim() : '';
  if (!comment) return null;
  const s = raw.store;
  return { comment, stars: Number.isInteger(s) && s >= 1 && s <= 5 ? s : null };
}

const wellFormed = (b) => !!b && typeof b === 'object' && b.ok === true && Array.isArray(b.comments) && (b.cursor === null || typeof b.cursor === 'string');

// fetchPage({ rid, cursor }) → the endpoint's body, or throws (api.js ApiError). → { load, state }; load() → the state:
//   { rows, more, phase }  phase: 'idle' | 'ready' | 'empty' | 'error' | 'denied' | 'signin'
// 'empty' only when nothing was found AND the history is exhausted; rows found so far stay on an error (a retry continues).
export function createCommentList({ rid, fetchPage }) {
  let rows = [];
  let cursor;              // undefined = page 1
  let done = false;
  let phase = 'idle';
  let restarted = false;   // a refused cursor restarts from page 1 ONCE per list
  let inflight = null;
  const state = () => ({ rows: rows.slice(), more: !done, phase });

  async function run() {
    for (let calls = 0; calls < FOLLOW_MAX && !done;) {
      let body;
      try {
        calls += 1;
        body = await fetchPage({ rid, cursor });
      } catch (e) {
        if (e && e.kind === 'BadRequest' && e.body && e.body.reason === 'bad_cursor' && cursor !== undefined && !restarted) {
          restarted = true; rows = []; cursor = undefined; calls = 0;
          continue;
        }
        phase = e && e.kind === 'NotAuthorized' ? 'denied' : e && e.kind === 'NotSignedIn' ? 'signin' : 'error';
        return;
      }
      if (!wellFormed(body)) { phase = 'error'; return; }
      const add = body.comments.map(commentRow).filter(Boolean);
      rows = rows.concat(add);
      cursor = body.cursor === null ? undefined : body.cursor;
      done = body.cursor === null;
      if (add.length) break;
    }
    phase = rows.length || !done ? 'ready' : 'empty';
  }

  async function load() {
    if (done && phase !== 'idle') return state();
    if (!inflight) inflight = run().finally(() => { inflight = null; });
    await inflight;
    return state();
  }
  return { load, state };
}

// ── the COPY — every string the owner approved: step 1 (MOCKUP-portal-calificaciones-color, «verbatim from the approved page») and
// step 2 (MOCKUP-portal-calificaciones-step2, APPROVED as drawn 11-15 with its COPY FOR OWNER). No placeholder ships (the SHIP GATE).
export const CAL_COPY = Object.freeze({
  title: 'Lo que dicen tus clientes', avg: 'Calificación promedio', count: 'Calificaciones',
  avgOf: 'de 5', countTotal: 'en total', under10: 'Vas a ver tu promedio cuando tengas 10 calificaciones.',
  emptyTitle: 'Todavía no hay comentarios', emptyBody: 'Cuando tus clientes califiquen un pedido con un comentario, lo vas a ver acá.',
  errTitle: 'No pudimos cargar las calificaciones.', errBody: 'Revisá tu conexión y volvé a intentar.', retry: 'Reintentar',
  deniedTitle: 'Tu cuenta no puede ver las calificaciones de esta sucursal.', deniedBody: 'Pedile acceso a la persona dueña del restaurante.',
  more: 'Ver más comentarios anteriores', loading: 'Cargando…', end: 'No hay más comentarios anteriores.',
  readMore: 'Leer más', readLess: 'Leer menos', srLoading: 'Cargando calificaciones',
  // step 2
  moreNamed: 'Ver más calificaciones', endNamed: 'No hay más calificaciones.',
  earlierTitle: 'Calificaciones anteriores', earlierSub: 'Comentarios de antes de que las calificaciones llevaran nombre. Son anónimos y no tienen fecha.',
  byStars: 'Por estrellas', allBase: 'Todas las calificaciones · desde el inicio', allBaseMany: 'Todas las calificaciones · desde el inicio · por sucursal',
  floor: 'Todavía hay pocas calificaciones con nombre en este período. Vas a ver el detalle por estrellas cuando haya 10 o más.',
  notLiveBars: 'Cuando tus clientes califiquen con su nombre, vas a ver acá cuántas calificaciones hay por estrellas.',
  notLiveTitle: 'Todavía no hay calificaciones con nombre', notLiveBody: 'Cuando tus clientes califiquen con su nombre, vas a ver acá qué dijeron y cuándo.',
  filtEmptyTitle: 'No hay calificaciones con estos filtros.', filtEmptyBody: 'Probá con otras estrellas o quitá los filtros para ver todas.',
  clear: 'Quitar filtros', starsPill: 'Estrellas', commentPill: 'Comentarios', cmAll: 'Todas', cmWith: 'Con comentario', cmWithout: 'Sin comentario',
  allBranches: 'Todas las sucursales', branchPrefix: 'Sucursal', few: 'Menos de 10 calificaciones', countUnit: 'calificaciones',
  namedBase: 'calificaciones con nombre', namedBaseNone: 'Calificaciones con nombre', rated: 'Calificado el', edited: 'editada',
  scopeGroup: 'Período y sucursal', listGroup: 'Filtros de la lista', periodMenu: 'Período', branchMenu: 'Sucursal', earlierTabs: 'Sucursal de los comentarios anteriores',
});
export const calCopy = (k) => (typeof CAL_COPY[k] === 'string' ? CAL_COPY[k] : `⟦cal.${k}⟧`);

// the EARLIER (v1) rows, as step 2 draws them (MOCKUP-portal-calificaciones-step2 note 8, owner 11-15): the approved step-1 row — N filled
// (yellow) stars then outlined ones («N de 5 estrellas», approved), the comment as TEXT clamped to three lines and the row's own expander
// (shown by CSS only when the text overflows). NO name, NO date, NO disc: it can never be read as a named row.
const SVG = 'http://www.w3.org/2000/svg';
const STAR = 'M12 2.5l2.9 6 6.6 1-4.8 4.6 1.1 6.6L12 17.6l-5.8 3.1 1.1-6.6L2.5 9.5l6.6-1z';
export function renderCommentRows(doc, rows) {
  const frag = doc.createDocumentFragment();
  for (const r of rows) {
    const row = doc.createElement('div'); row.className = 'crow v1';
    if (r.stars !== null) {
      const st = doc.createElement('span'); st.className = 'stars';
      st.setAttribute('role', 'img'); st.setAttribute('aria-label', `${r.stars} de 5 estrellas`);
      for (let i = 1; i <= 5; i++) {
        const svg = doc.createElementNS(SVG, 'svg');
        if (i > r.stars) svg.setAttribute('class', 'e');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
        const path = doc.createElementNS(SVG, 'path'); path.setAttribute('d', STAR);
        svg.append(path); st.append(svg);
      }
      row.append(st);
    }
    const p = doc.createElement('p'); p.className = 'ctxt clamp'; p.textContent = r.comment;
    const more = doc.createElement('button'); more.type = 'button'; more.className = 'qact cmore';
    more.setAttribute('aria-expanded', 'false'); more.textContent = calCopy('readMore');
    more.addEventListener('click', () => {
      const open = p.classList.contains('clamp');
      p.classList.toggle('clamp', !open);
      more.textContent = calCopy(open ? 'readLess' : 'readMore'); more.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    row.append(p, more);
    frag.append(row);
  }
  return frag;
}

// ═══ step 2 · the NAMED reviews (3a reviews v2 @ 4adde46e4, getMerchantReviews) ═══════════════════════════════════════════════════
// THE period model is the server's (ratings/review-window.js): the last N CLOSED HN weeks (Mon–Sun; a week closes 7 days after its
// Sunday ends). A synced copy — the period labels must paint before any data (rule 7) — held to it by a parity cell at the pin.
const HN_OFFSET_MS = 6 * 3600e3, DAY_MS = 86400e3, WEEK_MS = 7 * DAY_MS;
export const WEEKS = Object.freeze([1, 4, 13]);
export const DEFAULT_WEEKS = 4;   // Q1 (owner 11-15): «Últimas 4 semanas»
export function hnMonday(t) {
  const dayStart = Math.floor((t - HN_OFFSET_MS) / DAY_MS) * DAY_MS;
  const dow = (new Date(dayStart).getUTCDay() + 6) % 7;
  return dayStart - dow * DAY_MS + HN_OFFSET_MS;
}
export function windowOf(weeks, now) { const closedEnd = hnMonday(now) - WEEK_MS; return { start: closedEnd - weeks * WEEK_MS, closedEnd }; }
const MON3 = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTH = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const hnParts = (t) => { const d = new Date(t - HN_OFFSET_MS); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() }; };
const PERIOD = Object.freeze({ 1: ['La semana pasada', 'la semana pasada'], 4: ['Últimas 4 semanas', 'últimas 4 semanas'], 13: ['Últimas 13 semanas', 'últimas 13 semanas'] });
// → { weeks, start, closedEnd, label «Últimas 4 semanas», low «últimas 4 semanas», range «5 oct – 1 nov», from «Del 5 de octubre a hoy, …» }
// range: day + 3-letter month, en dash; the month once when both ends share it; the year only when the range crosses one (approved copy)
export function periodOf(weeks, now) {
  const w = windowOf(weeks, now);
  const a = hnParts(w.start), b = hnParts(w.closedEnd - DAY_MS), today = hnParts(now);
  const range = a.y !== b.y ? `${a.d} ${MON3[a.m]} ${a.y} – ${b.d} ${MON3[b.m]} ${b.y}`
    : a.m === b.m ? `${a.d} – ${b.d} ${MON3[b.m]}` : `${a.d} ${MON3[a.m]} – ${b.d} ${MON3[b.m]}`;
  const since = `${a.d} de ${MONTH[a.m]}${a.y !== today.y ? ` de ${a.y}` : ''}`;
  return { weeks, ...w, label: PERIOD[weeks][0], low: PERIOD[weeks][1], range, from: `Del ${since} a hoy, las más recientes primero.` };
}
// the stars filter's pill text: «Estrellas» (none), «1 estrella», «5 estrellas», «1 y 2 estrellas», «1, 2 y 3 estrellas»
export function starsLabel(set) {
  const xs = [...new Set(set || [])].filter((x) => Number.isInteger(x) && x >= 1 && x <= 5).sort((p, q) => p - q);
  if (!xs.length) return CAL_COPY.starsPill;
  const unit = xs.length === 1 && xs[0] === 1 ? 'estrella' : 'estrellas';
  return xs.length === 1 ? `${xs[0]} ${unit}` : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]} ${unit}`;
}
// «Calificado el 11 nov» (+ the year when it is not this one) from rated_on, an HN date 'YYYY-MM-DD'
export function ratedLabel(ratedOn, now) {
  const [y, m, d] = ratedOn.split('-').map(Number);
  return `${CAL_COPY.rated} ${d} ${MON3[m - 1]}${y !== hnParts(now).y ? ` ${y}` : ''}`;
}
export const initialsOf = (name) => name.split(/\s+/).map((w) => w.replace(/[^\p{L}]/gu, '')).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// ONE named row = an allowlist: { rid, stars, comment|null, ratedOn, edited, customer|null, tone|null } — dishes / total / kind are
// served but never drawn (the approved mockup), so they never reach the view. A row the screen cannot draw honestly is dropped.
export function reviewRow(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.rid !== 'string' || !raw.rid) return null;
  if (!Number.isInteger(raw.stars) || raw.stars < 1 || raw.stars > 5 || typeof raw.rated_on !== 'string' || !DATE_RE.test(raw.rated_on)) return null;
  const comment = typeof raw.comment === 'string' && raw.comment.trim() ? raw.comment.trim() : null;
  const customer = typeof raw.customer === 'string' && raw.customer.trim() && raw.customer.length <= 60 ? raw.customer.trim() : null;
  const tone = customer && Number.isInteger(raw.tone) && raw.tone >= 0 && raw.tone <= 4 ? raw.tone : null;
  return { rid: raw.rid, stars: raw.stars, comment, ratedOn: raw.rated_on, edited: raw.edited === true, customer, tone };
}
const figure = (p) => (p && typeof p === 'object' && Number.isInteger(p.count) && p.count >= 10 && typeof p.average === 'number' && p.average >= 1 && p.average <= 5
  ? { count: p.count, average: p.average } : null);
// the FIRST page's Overview, re-checked → { publicOne, publicByRid, stars, starsN, stale } | null (a malformed one ⇒ null: the honest
// states, never a guessed number). stars are served only with stars_n = their sum (≥ 10) and only when fresh.
export function overviewOf(o, rids) {
  if (!o || typeof o !== 'object' || (o.overview_state !== 'fresh' && o.overview_state !== 'stale')) return null;
  const many = rids.length > 1;
  const publicByRid = many ? Object.fromEntries(rids.map((r) => [r, figure(o.public_by_rid && o.public_by_rid[r])])) : null;
  let stars = null, starsN = null;
  if (o.overview_state === 'fresh' && o.stars && typeof o.stars === 'object' && Number.isInteger(o.stars_n) && o.stars_n >= 10) {
    const k = [1, 2, 3, 4, 5].map((i) => o.stars[i]);
    if (k.every((x) => Number.isInteger(x) && x >= 0) && k.reduce((p, q) => p + q, 0) === o.stars_n) { stars = Object.fromEntries(k.map((x, i) => [i + 1, x])); starsN = o.stars_n; }
  }
  return { publicOne: many ? null : figure(o.public), publicByRid, stars, starsN, stale: o.overview_state === 'stale' };
}
// the named list: page 1 carries the Overview (kept — a cursor page's overview is null and never clears it); paging by «more», a refused
// cursor restarts from page 1 ONCE, empty pages are followed at most FOLLOW_MAX calls per load (the server's own bounded scan).
// fetchPage({ cursor }) → the body, or throws (api.js ApiError) → { load, state }; state: { rows, more, phase, overview }
export function createReviewList({ rids, fetchPage }) {
  let rows = [], cursor, done = false, phase = 'idle', restarted = false, inflight = null, overview = null, first = true;
  const state = () => ({ rows: rows.slice(), more: !done, phase, overview });
  const okBody = (b) => !!b && typeof b === 'object' && b.ok === true && Array.isArray(b.reviews) && (b.cursor === null || typeof b.cursor === 'string');
  async function run() {
    for (let calls = 0; calls < FOLLOW_MAX && !done;) {
      let body;
      try { calls += 1; body = await fetchPage({ cursor }); } catch (e) {
        if (e && e.kind === 'BadRequest' && e.body && e.body.reason === 'bad_cursor' && cursor !== undefined && !restarted) {
          restarted = true; rows = []; cursor = undefined; calls = 0; first = true; continue;
        }
        phase = e && e.kind === 'NotAuthorized' ? 'denied' : e && e.kind === 'NotSignedIn' ? 'signin' : 'error';
        return;
      }
      if (!okBody(body)) { phase = 'error'; return; }
      if (first) { overview = overviewOf(body.overview, rids); first = false; }
      const add = body.reviews.map(reviewRow).filter(Boolean);
      rows = rows.concat(add);
      cursor = body.cursor === null ? undefined : body.cursor;
      done = body.cursor === null;
      if (add.length) break;
    }
    phase = rows.length || !done ? 'ready' : 'empty';
  }
  async function load() {
    if (done && phase !== 'idle') return state();
    if (!inflight) inflight = run().finally(() => { inflight = null; });
    await inflight;
    return state();
  }
  return { load, state };
}
