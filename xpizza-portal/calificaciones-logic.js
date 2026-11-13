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

// ── the COPY (MOCKUP-portal-calificaciones.html): the strings the owner already approved are literal; every other one is a PLACEHOLDER
// (null ⇒ «⟦cal.key⟧» on screen) until the owner approves the mockup's copy — the view test's SHIP GATE stays red until then
export const CAL_COPY = Object.freeze({
  title: 'Lo que dicen tus clientes', avg: 'Calificación promedio', count: 'Calificaciones',   // approved (map v3 + Q4)
  anon: null, avgOf: null, countTotal: null, under10: null,
  emptyTitle: null, emptyBody: null, errTitle: null, errBody: null, retry: null, deniedTitle: null, deniedBody: null,
  more: null, loading: null, end: null, readMore: null, readLess: null, srLoading: null,
});
export const calCopy = (k) => (typeof CAL_COPY[k] === 'string' ? CAL_COPY[k] : `⟦cal.${k}⟧`);

// the rows, as the mockup draws a rating: N filled stars then outlined ones («N de 5 estrellas», approved), the comment as TEXT clamped
// to three lines, and the row's own expander (shown by CSS only when the text overflows)
const SVG = 'http://www.w3.org/2000/svg';
const STAR = 'M12 2.5l2.9 6 6.6 1-4.8 4.6 1.1 6.6L12 17.6l-5.8 3.1 1.1-6.6L2.5 9.5l6.6-1z';
export function renderCommentRows(doc, rows) {
  const frag = doc.createDocumentFragment();
  for (const r of rows) {
    const row = doc.createElement('div'); row.className = 'crow';
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
