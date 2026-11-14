// Portal «Marketing» — the «Anuncio» (paid weekly placement; «Patrocinado» in the app), the NON-DRAWING half, DARK (advisor 11-14).
// Pure: the weeks read, the server's eligibility rendered (never decided here), the booking list, every write's outcome. No DOM, no
// copy: every state is a KEY the screens will word behind the SHIP GATE (MOCKUP-portal-marketing v5 screens 4 / 4b / 6).
//
// NO MONEY IS COMPUTED HERE. The price is the server's `price_cents` as-is (Sherpa-set, platform_config/marketing; copied onto each
// booking AT booking). Hidden days are shown as a COUNT only («Días sin mostrar: N»): the pro-rata amount belongs to the restaurant
// ledger (PLAN-sherpa-ledger-and-payouts.md:16, r4.6 amendment 5), which serves no line yet — advisor ruling 11-14. There is no
// payment or charge call: a booking only reserves the week; the ledger posts it later.
// THE CAP (owner 11-14: ≤ 2 booked weeks in any rolling 4-week window per branch) is the SERVER's alone: a week it would refuse reads
// `capped`, a book over it is 409 cap_reached with the server's `next_week` hint (or null). Nothing here counts weeks.
//
// THE SERVER (3a feat/marketing-offers-3a @ dad98ad42 — anuncio-logic.test.mjs runs the REAL cores at that ref):
//   anuncio-core.js:5-7    getAnuncioWeeks GET ?rid= · anuncioBook POST { rid, week } · anuncioCancel POST { rid, booking_id }
//   anuncio-core.js:10,63  ONE slot per week, platform-wide: a week reads free | mine | taken | capped (taken wins over capped)
//   anuncio-core.js:85-89,121,135 a book over the cap ⇒ 409 { error: 'cap_reached', next_week } — the first bookable week the cap allows (other
//                          restaurants' slots NOT checked: booking it can still be week_taken), or null
//   anuncio-core.js:35     every call 409 anuncio_disabled while the switch is off (a cancel is allowed: it only releases)
//   anuncio-core.js:61-63  { price_cents, eligibility: { eligible, rating, rating_count, reasons }, weeks: [{ week, starts_at, cancel_until, state }] }
//   anuncio-core.js:72     the book body is rid + week ONLY — a price never comes from the client
//   anuncio-core.js:105-138 a 503 after the slot transaction releases this call's slot; if the release fails too, the slot stays
//                          written without its booking record (re-booking repairs it)
//   anuncio-model.js:34-43 eligibility reasons today: not_enough_ratings | rating_below | config_unavailable (the «not paused-heavy»
//                          term arrives with merit-5f as a NEW code — an unknown code renders «No disponible», never eligible)
//   offers-core.js:237     getMarketing's bookings: { id, week, status, price_cents, cancel_deadline, hidden_days }

// THE CAP's copy — OWNER-APPROVED 11-14 verbatim (PLAN-portal-marketing-r1 §8); the drawing half shows it, nothing here decides it.
// {fecha} is the server's next_week, worded by the screen (the week's start). Every other Anuncio string stays a ⟦key⟧ (SHIP GATE).
export const CAP_COPY = Object.freeze({
  capRule: 'Para que todos los restaurantes tengan su turno, podés tener hasta 2 semanas en cualquier período de 4.',
  capped: 'Fuera de tu límite',
  capReached: 'Ya tenés 2 semanas en este período de 4.',
  capNext: (fecha) => `Podés reservar desde la semana del ${fecha}, si sigue libre.`,
  capNone: 'Vas a poder reservar más adelante, cuando se abran nuevas semanas o si cancelás una de las tuyas.',
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const WEEK_RE = /^W\d{4}-\d{2}-\d{2}$/;
const BOOKING_ID_RE = /^b_[a-z2-7]{12}$/;

// ── eligibility: the SERVER's verdict, rendered ───────────────────────────────────────────────────────────────────────────────
// → { state: 'eligible' | 'not_eligible' | 'unavailable', reasons, rating, rating_count }. Eligible ONLY when the server says
// eligible === true with no reason at all. A reason this portal doesn't know — or a Sherpa-side config gap — is the neutral
// 'unavailable' («No disponible»), never 'eligible' and never a guessed reason.
export const KNOWN_REASONS = Object.freeze(['not_enough_ratings', 'rating_below']);
export function eligibilityView(e) {
  const nums = { rating: isObj(e) && typeof e.rating === 'number' ? e.rating : null, rating_count: isObj(e) && isInt(e.rating_count, 0, 1e9) ? e.rating_count : null };
  if (!isObj(e) || !Array.isArray(e.reasons) || typeof e.eligible !== 'boolean') return { state: 'unavailable', reasons: [], ...nums };
  if (e.reasons.some((r) => !KNOWN_REASONS.includes(r))) return { state: 'unavailable', reasons: [], ...nums };
  if (e.eligible === true) return e.reasons.length === 0 ? { state: 'eligible', reasons: [], ...nums } : { state: 'unavailable', reasons: [], ...nums };
  return e.reasons.length ? { state: 'not_eligible', reasons: [...e.reasons], ...nums } : { state: 'unavailable', reasons: [], ...nums };
}

// ── the weeks read ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// res (api.js rawCall) → { kind: 'off' } | { kind: 'denied' } | { kind: 'unknown' } | { kind: 'unreadable' } |
// { kind: 'ok', price_cents, eligibility, weeks: [{ week, starts_at, cancel_until, state, bookable }] }.
// A week is bookable ONLY when it is free AND the server's eligibility says eligible; `mine` (already this branch's), `taken` and
// `capped` (the server's cap) never are — one slot per week. The state is the server's verbatim; an unknown one is 'unknown'.
export function weeksModel(res) {
  if (!res || res.transport || res.malformed) return { kind: 'unknown' };
  const b = isObj(res.body) ? res.body : {};
  if (res.status === 409 && b.error === 'anuncio_disabled') return { kind: 'off' };
  if (res.status === 401 || res.status === 403) return { kind: 'denied' };
  if (res.status !== 200) return { kind: 'unknown' };
  if (b.ok !== true || !isInt(b.price_cents, 100, 10_000_000) || !Array.isArray(b.weeks)) return { kind: 'unreadable' };
  const eligibility = eligibilityView(b.eligibility);
  const weeks = b.weeks.filter((w) => isObj(w) && WEEK_RE.test(String(w.week))).map((w) => {
    const state = ['free', 'mine', 'taken', 'capped'].includes(w.state) ? w.state : 'unknown';
    return { week: w.week, starts_at: w.starts_at, cancel_until: w.cancel_until, state, bookable: state === 'free' && eligibility.state === 'eligible' };
  });
  return { kind: 'ok', price_cents: b.price_cents, eligibility, weeks };
}

// ── the bookings (getMarketing's `bookings`) ──────────────────────────────────────────────────────────────────────────────────
// → [{ id, week, status, price_cents, cancel_deadline, hidden_count, cancellable }] — the price as the server stored it, the hidden
// days as a COUNT. No refund, no net, no amount derived from either.
export function bookingsView(body, nowMs) {
  if (!isObj(body) || body.ok !== true || !isObj(body.switches) || !Array.isArray(body.bookings)) return null;
  return body.bookings.filter((x) => isObj(x) && BOOKING_ID_RE.test(String(x.id)) && WEEK_RE.test(String(x.week))).map((x) => ({
    id: x.id, week: x.week, status: x.status, price_cents: isInt(x.price_cents, 100, 10_000_000) ? x.price_cents : null,
    cancel_deadline: x.cancel_deadline, hidden_count: Array.isArray(x.hidden_days) ? x.hidden_days.length : 0,
    cancellable: x.status === 'reserved' && isInt(x.cancel_deadline, 0, 8.64e15) && nowMs <= x.cancel_deadline,
  }));
}

// ── writes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// saved | refused { code, … } | unknown (503 / 500 / transport / malformed 200 — may have landed; a fresh read decides). Never a
// success the server did not state.
const CODES = Object.freeze({
  anuncio_disabled: 'off', week_taken: 'week_taken', already_booked: 'already_booked', not_eligible: 'not_eligible',
  too_many_bookings: 'too_many_bookings', cap_reached: 'cap_reached', branch_not_live: 'branch_not_live', slot_malformed: 'unreadable', current_malformed: 'unreadable',
  past_deadline: 'past_deadline', already_cancelled: 'already_cancelled', not_found: 'gone', bad_rid: 'invalid', bad_request: 'invalid',
  not_authorized: 'denied', missing_bearer_token: 'signed_out', invalid_credentials: 'signed_out',
});
export function refusalOf(status, b) {
  const out = { code: CODES[b.error] || 'other', server: b.error, status };
  if (b.error === 'bad_request' && b.reason === 'not_bookable') out.code = 'not_bookable';
  for (const k of ['field', 'reason', 'booking_id']) if (b[k] !== undefined) out[k] = b[k];
  if (b.error === 'cap_reached') out.next_week = typeof b.next_week === 'string' && WEEK_RE.test(b.next_week) ? b.next_week : null;   // the server's hint, shape-checked
  if (b.error === 'not_eligible') out.eligibility = eligibilityView({ eligible: false, reasons: b.reasons, rating: null, rating_count: null }).state;
  return out;
}
const refusal = (res) => (res.status >= 400 && res.status < 500 && isObj(res.body) && typeof res.body.error === 'string' ? { outcome: 'refused', ...refusalOf(res.status, res.body) } : null);

// attempt { week }
export function classifyBook(attempt, res) {
  if (!res || res.transport || res.malformed) return { outcome: 'unknown' };
  if (res.status === 200) {
    const k = isObj(res.body) ? res.body.booking : null;
    return res.body.ok === true && isObj(k) && BOOKING_ID_RE.test(String(k.id)) && k.week === attempt.week && k.state === 'reserved' ? { outcome: 'saved', booking: k } : { outcome: 'unknown' };
  }
  return refusal(res) || { outcome: 'unknown' };
}
// attempt { bookingId }
export function classifyCancel(attempt, res) {
  if (!res || res.transport || res.malformed) return { outcome: 'unknown' };
  if (res.status === 200) return isObj(res.body) && res.body.ok === true && res.body.booking_id === attempt.bookingId && res.body.state === 'cancelled' ? { outcome: 'saved' } : { outcome: 'unknown' };
  return refusal(res) || { outcome: 'unknown' };
}

// After an UNKNOWN booking: the booking list first (a reserved booking for that week ⇒ saved), then the week's slot: `mine` with no
// booking is a half-made reservation (`incomplete` — booking the week again completes it), `free` or `capped` (the slot is free) ⇒
// not_landed, `taken` ⇒ conflict (another restaurant got it).
export function classifyBookRecovery(attempt, weeksRes, marketingBody, nowMs) {
  const list = bookingsView(marketingBody, nowMs);
  if (list && list.some((x) => x.week === attempt.week && x.status !== 'cancelled')) return { outcome: 'saved' };
  const m = weeksModel(weeksRes);
  if (m.kind !== 'ok' || !list) return { outcome: 'unknown' };
  const w = m.weeks.find((x) => x.week === attempt.week);
  if (!w) return { outcome: 'unknown' };
  return { outcome: { mine: 'incomplete', free: 'not_landed', capped: 'not_landed', taken: 'conflict' }[w.state] || 'unknown' };
}
export function classifyCancelRecovery(attempt, marketingBody, nowMs) {
  const list = bookingsView(marketingBody, nowMs);
  if (!list) return { outcome: 'unknown' };
  const k = list.find((x) => x.id === attempt.bookingId);
  if (!k) return { outcome: 'conflict' };
  return { outcome: k.status === 'cancelled' ? 'saved' : 'not_landed' };
}

// ONE write, settled — an UNKNOWN re-reads ONCE (calls injected: api.js anuncioBookRaw / anuncioCancelRaw, getAnuncioWeeksRaw,
// getMarketingRaw). A failed re-read stays unknown.
const ok200 = (r) => r && !r.transport && r.status === 200;
export async function settleBook(attempt, send, rereadWeeks, rereadMarketing, nowMs) {
  const first = classifyBook(attempt, await send());
  if (first.outcome !== 'unknown') return first;
  let w, g;
  try { [w, g] = await Promise.all([rereadWeeks(), rereadMarketing()]); } catch (_) { return { outcome: 'unknown' }; }
  if (!ok200(g)) return { outcome: 'unknown' };
  return classifyBookRecovery(attempt, w, g.body, nowMs);
}
export async function settleCancel(attempt, send, rereadMarketing, nowMs) {
  const first = classifyCancel(attempt, await send());
  if (first.outcome !== 'unknown') return first;
  let g;
  try { g = await rereadMarketing(); } catch (_) { return { outcome: 'unknown' }; }
  if (!ok200(g)) return { outcome: 'unknown' };
  return classifyCancelRecovery(attempt, g.body, nowMs);
}
