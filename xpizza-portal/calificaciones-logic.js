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

// the rows, as the approved mockup draws a rating: N filled stars then empty ones («N de 5 estrellas»), the comment as TEXT
const SVG = 'http://www.w3.org/2000/svg';
export function renderCommentRows(doc, rows) {
  const frag = doc.createDocumentFragment();
  for (const r of rows) {
    const li = doc.createElement('li'); li.className = 'crow';
    if (r.stars !== null) {
      const st = doc.createElement('span'); st.className = 'stars';
      st.setAttribute('role', 'img'); st.setAttribute('aria-label', `${r.stars} de 5 estrellas`);
      for (let i = 1; i <= 5; i++) {
        const svg = doc.createElementNS(SVG, 'svg');
        if (i > r.stars) svg.setAttribute('class', 'e');
        svg.setAttribute('aria-hidden', 'true');
        const use = doc.createElementNS(SVG, 'use'); use.setAttribute('href', '#i-starf');
        svg.append(use); st.append(svg);
      }
      li.append(st);
    }
    const p = doc.createElement('p'); p.className = 'ctxt'; p.textContent = r.comment;
    li.append(p);
    frag.append(li);
  }
  return frag;
}
