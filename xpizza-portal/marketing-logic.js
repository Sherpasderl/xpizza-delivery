// Portal «Marketing» — «Ofertas», the NON-DRAWING half (advisor 11-14; PLAN-portal-marketing-r1 §5 screens 1–3, drawn later from
// MOCKUP-portal-marketing v5 once the owner approves it). Pure: the offer FORM model for each type, mapped to the server's exact
// params, whole-lempira money, the read model, every write's outcome, and the live_drift state. No DOM, no copy: every state is a
// KEY the screens will word behind the SHIP GATE.
//
// THE SERVER (3a feat/marketing-offers-3a @ b62765981 — marketing-logic.test.mjs runs these against the REAL cores at that ref):
//   offer-model.js:10-21   TYPES pct | lps | bogo | envio | nuevos · AUDIENCES · STATES draft | active | paused_owner | ended · LIMITS
//   offer-model.js:39-90   paramsOf — every money field is whole lempiras (a positive multiple of 100 centavos); ABSENT = none,
//                          never a 0 sentinel. bogo: AUTHORED items XOR cats; a STORED category offer also carries its resolved items
//   offer-model.js:94-117  scheduleOf / capsOf — the window in MINUTES after HN midnight; the spend cap whole lempiras too
//   offer-model.js:146-160 liveEditProblem — on an active / paused offer only a cap RAISED and the end moved LATER
//   offer-model.js:228-234 statusOf — draft | scheduled | live | paused_owner | ended, derived at read time
//   offers-core.js:5-8     getMarketing GET ?rid= · marketingOfferSave · marketingOfferSetState · marketingOfferRepeat (POST, rid in BODY)
//   offers-core.js:31      a 503 { error: 'unavailable', retryable } — an outage, OR a failed unmirror / undo (offers-core.js:166-196,
//                          350): the record may or may not have moved ⇒ UNKNOWN until a fresh read decides, NEVER success
//   offers-core.js:243     live_drift — an active record its price-path mirror doesn't match (NOT applied), or a non-active one whose
//                          mirror is still there (STILL applied)
//   offers-core.js:319     MOVES — draft → active | ended · active → paused_owner | ended · paused_owner → active | ended
// The «Anuncio» (anuncio-core.js) stays DARK: no call, no state, no path here (the read's `bookings` is dropped).

export const TYPES = Object.freeze(['pct', 'lps', 'bogo', 'envio', 'nuevos']);
export const AUDIENCES = Object.freeze(['all', 'new', 'returning']);
export const LIMITS = Object.freeze({
  name_max: 40, branches_max: 10, items_max: 10, cats_max: 2, free_per_order_max: 3,
  pct_min: 5, pct_max: 50, pct_step: 5, lempiras_max: 100000, redemptions_max: 1e6,
});
export const MOVES = Object.freeze({ draft: Object.freeze(['active', 'ended']), active: Object.freeze(['paused_owner', 'ended']),
  paused_owner: Object.freeze(['active', 'ended']), ended: Object.freeze([]) });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const uniq = (a) => new Set(a).size === a.length;
// key-order-free equality (a value from the server and the same value built here may list their keys differently)
const canon = (v) => (Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// ── money: WHOLE lempiras ─────────────────────────────────────────────────────────────────────────────────────────────────────
// What the merchant typed → { ok, cents } | { ok:false, error }. «150», «L 150», «1,500», «1 500» are lempiras. A decimal point is
// refused outright (`whole_lempiras` — «150.50» is never rounded, and «150.00» is asked again rather than guessed). Blank = none
// (cents null) when the field is optional, `required` otherwise. Zero is `positive`: no money field has a 0 sentinel.
export function parseLempiras(text, { required = false } = {}) {
  const s = typeof text === 'number' ? String(text) : typeof text === 'string' ? text.trim().replace(/^L\.?\s*/i, '') : null;
  if (s === null) return { ok: false, error: 'not_a_number' };
  if (s === '') return required ? { ok: false, error: 'required' } : { ok: true, cents: null };
  if (/[.]/.test(s)) return { ok: false, error: 'whole_lempiras' };
  if (!/^(\d+|\d{1,3}([, ]\d{3})+)$/.test(s)) return { ok: false, error: 'not_a_number' };
  const l = Number(s.replace(/[, ]/g, ''));
  if (!Number.isSafeInteger(l)) return { ok: false, error: 'too_large' };
  if (l < 1) return { ok: false, error: 'positive' };
  if (l > LIMITS.lempiras_max) return { ok: false, error: 'too_large' };
  return { ok: true, cents: l * 100 };
}
// centavos (a server value) → the lempira text the form shows; null / absent → '' (none)
export const lempirasText = (cents) => (isInt(cents, 100, LIMITS.lempiras_max * 100) && cents % 100 === 0 ? String(cents / 100) : '');

// ── the FORM ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// One flat form for every type; only the type's own fields are read. Money as the merchant's TEXT; everything else as values.
//   by: 'items' | 'cats' (bogo) · nuevos_by: 'off' | 'pct' · start / end: ms | null · days: [0..6] (0 = Sunday, HN)
//   window: { from, to } minutes | null · cap_redemptions: integer | null · cap_spend: text · weekly: boolean
export function emptyForm(type = 'pct') {
  return { name: '', type, pct: null, max: '', off: '', min: '', by: 'items', items: [], cats: [], free_per_order: 1, nuevos_by: 'off',
    audience: type === 'nuevos' ? 'new' : 'all', branches: [], start: null, end: null, days: [0, 1, 2, 3, 4, 5, 6], window: null,
    cap_redemptions: null, cap_spend: '', weekly: false };
}

const pctOk = (p) => isInt(p, LIMITS.pct_min, LIMITS.pct_max) && p % LIMITS.pct_step === 0;
const listOk = (l, max) => Array.isArray(l) && l.length >= 1 && l.length <= max && l.every((k) => typeof k === 'string' && k.length >= 1 && k.length <= 200) && uniq(l);

// the type's params, exactly as paramsOf accepts them (AUTHORED) → { params } | { errors }
function paramsOfForm(f) {
  const errors = {};
  const money = (key, required) => { const r = parseLempiras(f[key], { required }); if (!r.ok) errors[key] = r.error; return r.ok ? r.cents : null; };
  let params = null;
  if (f.type === 'pct') {
    if (!pctOk(f.pct)) errors.pct = 'bad_pct';
    const max = money('max', false);   // blank = no maximum: the key is ABSENT (never max_cents: 0)
    params = { pct: f.pct, ...(max !== null ? { max_cents: max } : {}) };
  } else if (f.type === 'lps') {
    const off = money('off', true), min = money('min', true);
    if (off !== null && min !== null && min < off) errors.min = 'min_below_off';
    params = { off_cents: off, min_cents: min };
  } else if (f.type === 'bogo') {
    if (!isInt(f.free_per_order, 1, LIMITS.free_per_order_max)) errors.free_per_order = 'bad_free_per_order';
    if (f.by === 'cats') { if (!listOk(f.cats, LIMITS.cats_max)) errors.cats = 'bad_cats'; params = { cats: [...(f.cats || [])], free_per_order: f.free_per_order }; }
    else { if (!listOk(f.items, LIMITS.items_max)) errors.items = 'bad_items'; params = { items: [...(f.items || [])], free_per_order: f.free_per_order }; }
  } else if (f.type === 'envio') {
    const min = money('min', false);   // blank = no minimum order: ABSENT
    params = min !== null ? { min_cents: min } : {};
  } else if (f.type === 'nuevos') {
    if (f.nuevos_by === 'pct') { if (!pctOk(f.pct)) errors.pct = 'bad_pct'; params = { pct: f.pct }; }
    else { const off = money('off', true); params = { off_cents: off }; }
  } else errors.type = 'bad_type';
  return Object.keys(errors).length ? { errors } : { params };
}

// The form → the AUTHORED offer marketingOfferSave takes (offers-core.js:273, offer-model.js:121) → { ok, offer } | { ok:false, errors }
export function offerFromForm(f) {
  const errors = {};
  const name = typeof f.name === 'string' ? f.name.trim() : '';
  if (!name || name.length > LIMITS.name_max || /[\u0000-\u001f\u007f]/.test(name)) errors.name = 'bad_name';
  const p = paramsOfForm(f);
  if (p.errors) Object.assign(errors, p.errors);
  const audience = f.type === 'nuevos' ? 'new' : f.audience;   // «Para clientes nuevos» is the type itself
  if (!AUDIENCES.includes(audience)) errors.audience = 'bad_audience';
  const b = f.branches;
  if (!Array.isArray(b) || b.length < 1 || b.length > LIMITS.branches_max || !b.every((r) => typeof r === 'string' && r) || !uniq(b)) errors.branches = 'bad_branches';
  const start = f.start ?? null, end = f.end ?? null;
  if (start !== null && !isInt(start, 0, 8.64e15)) errors.start = 'bad_start';
  if (end !== null && !(isInt(end, 0, 8.64e15) && (start === null || end > start))) errors.end = 'end_before_start';
  if (!Array.isArray(f.days) || !f.days.length || !f.days.every((d) => isInt(d, 0, 6)) || !uniq(f.days)) errors.days = 'bad_days';
  const w = f.window ?? null;
  if (w !== null && !(isObj(w) && isInt(w.from, 0, 1439) && isInt(w.to, 0, 1439) && w.from !== w.to)) errors.window = 'bad_window';
  const r = f.cap_redemptions ?? null;
  if (r !== null && !isInt(r, 1, LIMITS.redemptions_max)) errors.cap_redemptions = 'bad_cap';
  const spend = parseLempiras(f.cap_spend, { required: false });
  if (!spend.ok) errors.cap_spend = spend.error;
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, offer: {
    name, type: f.type, params: p.params, audience, branches: [...b].sort(),
    schedule: { start, end, days: [...f.days].sort((x, y) => x - y), window: w === null ? null : { from: w.from, to: w.to } },
    caps: { redemptions: r, spend_cents: spend.cents, weekly: f.weekly === true },
  } };
}

// A server offer (getMarketing / a write's `offer`) → the form that edits it. A CATEGORY offer comes back with its RESOLVED dishes as
// params.items next to params.cats (offer-model.js:63-68): the form keeps the cats only — sending both back is bad_params
// (AUTHORED is items XOR cats) — and the resolved list rides separately for «Aplica a:» (appliesTo).
export function formFromOffer(o) {
  const f = emptyForm(o.type);
  const p = isObj(o.params) ? o.params : {};
  Object.assign(f, { name: o.name, audience: o.audience, branches: [...(o.branches || [])],
    start: o.schedule?.start ?? null, end: o.schedule?.end ?? null, days: [...(o.schedule?.days || [])], window: o.schedule?.window ? { ...o.schedule.window } : null,
    cap_redemptions: o.caps?.redemptions ?? null, cap_spend: lempirasText(o.caps?.spend_cents), weekly: o.caps?.weekly === true });
  if (o.type === 'pct') Object.assign(f, { pct: p.pct, max: lempirasText(p.max_cents) });
  if (o.type === 'lps') Object.assign(f, { off: lempirasText(p.off_cents), min: lempirasText(p.min_cents) });
  if (o.type === 'bogo') Object.assign(f, Array.isArray(p.cats) ? { by: 'cats', cats: [...p.cats], items: [] } : { by: 'items', items: [...(p.items || [])] }, { free_per_order: p.free_per_order });
  if (o.type === 'envio') f.min = lempirasText(p.min_cents);
  if (o.type === 'nuevos') Object.assign(f, 'pct' in p ? { nuevos_by: 'pct', pct: p.pct } : { nuevos_by: 'off', off: lempirasText(p.off_cents) });
  return f;
}
// the dishes a server offer covers, for «Aplica a: {lista}» — a category offer's list as the SERVER froze it (never resolved here)
export const appliesTo = (o) => (o && o.type === 'bogo' && isObj(o.params) && Array.isArray(o.params.items) ? [...o.params.items] : []);

// ── live edits (offer-model.js:146-160) ───────────────────────────────────────────────────────────────────────────────────────
// What may change on THIS offer: a draft — anything; active / paused — only a cap raised and the end moved later; ended — nothing.
export function editable(o) {
  if (!o || o.state === 'ended' || o.status === 'ended') return 'none';
  return o.state === 'draft' ? 'all' : 'caps_and_end';
}
// prev (a server offer) vs next (an authored offer) → null | the field the server would refuse (the same answer as liveEditProblem)
export function liveEditProblem(prev, next) {
  for (const k of ['name', 'type', 'audience']) if (!same(prev[k], next[k])) return k;
  if (!same([...prev.branches].sort(), [...next.branches].sort())) return 'branches';
  const pk = (o) => (o.type === 'bogo' && Array.isArray(o.params.cats) ? { cats: o.params.cats, free_per_order: o.params.free_per_order } : o.params);
  if (!same(pk(prev), pk(next))) return 'params';
  const ps = prev.schedule, ns = next.schedule;
  if ((ps.start ?? null) !== (ns.start ?? null) || !same(ps.days, ns.days) || !same(ps.window ?? null, ns.window ?? null)) return 'schedule';
  const pe = ps.end ?? null, ne = ns.end ?? null;
  if (!(ne === null || (pe !== null && ne >= pe))) return 'schedule';
  const up = (a, b) => b === null || (a !== null && b >= a);
  const pc = prev.caps, nc = next.caps;
  if (pc.weekly !== nc.weekly || !up(pc.redemptions ?? null, nc.redemptions ?? null) || !up(pc.spend_cents ?? null, nc.spend_cents ?? null)) return 'caps';
  return null;
}

// ── the READ (getMarketing, offers-core.js:217-248) ─────────────────────────────────────────────────────────────────────────────
// → { kind: 'off' } (the switch is OFF: no Ofertas path at all) | { kind: 'ok', offers } | { kind: 'unreadable' }. `bookings` (the
// Anuncio) is dropped here on purpose: it stays dark.
export function readModel(body) {
  if (!isObj(body) || body.ok !== true || !isObj(body.switches) || !Array.isArray(body.offers)) return { kind: 'unreadable' };
  if (body.switches.offers_enabled !== true) return { kind: 'off' };
  const offers = body.offers.filter((o) => isObj(o) && typeof o.id === 'string' && isInt(o.rev, 1, 1e15) && TYPES.includes(o.type) && typeof o.status === 'string')
    .map((o) => ({ ...o, drift: driftOf(o) }));
  return { kind: 'ok', offers, dropped: body.offers.length - offers.length };
}
// live_drift, worded honestly: an ACTIVE record not in the price path is NOT being applied; a paused / ended / draft record still in
// it IS still being applied. Either heals on the offer's next write (offers-core.js:20, 349).
export function driftOf(o) {
  if (!o || o.live_drift !== true) return null;
  return o.state === 'active' ? 'not_applied' : 'still_applied';
}
// the moves a status offers: the server's MOVES from the STORED state, plus «Repetir» once the offer has ENDED (by state or schedule)
export function actionsOf(o) {
  const to = [...(MOVES[o.state] || [])].filter((t) => !(o.status === 'ended' && t !== 'ended'));
  const out = to.map((t) => (t === 'active' ? (o.state === 'draft' ? 'publish' : 'resume') : t === 'paused_owner' ? 'pause' : 'end'));
  if (o.status === 'ended') return o.state === 'ended' ? ['repeat'] : [...out, 'repeat'];
  return out;
}

// ── every WRITE's outcome ─────────────────────────────────────────────────────────────────────────────────────────────────────
// res: { status, body } | { status: 200, body: null, malformed: true } | { transport: true } (api.js rawCall).
//   saved   — a clean 200 whose offer is the one we wrote (the rev moved by exactly one; for a state move, the state we asked for)
//   refused — a 4xx with the server's own code: NOTHING landed; { code, field?, reason?, with?, current_rev? } for the screen
//   unknown — 503 / 500 / transport / a malformed 200: it MAY have landed (a failed unmirror or undo) ⇒ a fresh read decides
//             (classifyRecovery). Never shown as success.
// attempt: { op: 'create'|'save'|'state'|'repeat', offerId?, expectedRev?, to? }
export function classifyWrite(attempt, res) {
  if (!res || res.transport || res.malformed) return { outcome: 'unknown' };
  const b = isObj(res.body) ? res.body : {};
  if (res.status === 200) {
    const o = b.offer;
    if (b.ok !== true || !isObj(o) || !isInt(o.rev, 1, 1e15)) return { outcome: 'unknown' };
    if (attempt.op === 'create' || attempt.op === 'repeat') return o.rev === 1 && o.state === 'draft' ? { outcome: 'saved', offer: o } : { outcome: 'unknown' };
    if (o.id !== attempt.offerId || o.rev !== attempt.expectedRev + 1) return { outcome: 'unknown' };
    if (attempt.op === 'state' && o.state !== attempt.to) return { outcome: 'unknown' };
    return { outcome: 'saved', offer: o };
  }
  if (res.status >= 400 && res.status < 500 && typeof b.error === 'string') return { outcome: 'refused', ...refusalOf(res.status, b) };
  return { outcome: 'unknown' };
}
// the server's code → the KEY a screen words. Codes verbatim (offers-core.js); anything unrecognised is `other` with the code kept.
const CODES = Object.freeze({
  bad_request: 'invalid', bad_rid: 'invalid', offers_disabled: 'off', superseded: 'stale', current_malformed: 'unreadable', not_found: 'gone',
  overlap: 'overlap', too_many_live: 'too_many_live', too_many_offers: 'too_many_offers', live_edit_not_allowed: 'live_edit',
  ended: 'ended', bad_transition: 'stale', not_ended: 'not_ended', branch_not_live: 'branch_not_live', menu_unavailable: 'menu_unavailable',
  category_too_large: 'category_too_large', not_authorized: 'denied', missing_bearer_token: 'signed_out', invalid_credentials: 'signed_out',
});
export function refusalOf(status, b) {
  const out = { code: CODES[b.error] || 'other', server: b.error, status };
  for (const k of ['field', 'reason', 'rid', 'current_rev']) if (b[k] !== undefined) out[k] = b[k];
  if (Array.isArray(b.with)) out.with = b.with.filter((n) => typeof n === 'string');
  return out;
}

// After an UNKNOWN: the FRESH read decides → saved | not_landed | conflict | unknown. attempt (as above) plus, for a save, `sent` (the
// authored offer) and `prev` (the server offer the edit started from); for a state move, `from` (the stored state it started from).
// A create / repeat has no id to look for: the list itself is the truth (`reread`).
export function classifyRecovery(attempt, readBody) {
  const m = readModel(readBody);
  if (m.kind !== 'ok') return { outcome: 'unknown' };
  if (attempt.op === 'create' || attempt.op === 'repeat') return { outcome: 'reread' };
  const o = m.offers.find((x) => x.id === attempt.offerId);
  if (!o) return { outcome: 'conflict' };
  if (o.rev === attempt.expectedRev) return { outcome: 'not_landed', offer: o };
  if (attempt.op === 'state') {
    if (o.state === attempt.to) return { outcome: 'saved', offer: o };
    return o.state === attempt.from ? { outcome: 'not_landed', offer: o } : { outcome: 'conflict', offer: o };   // moved, then put back
  }
  const authored = (x) => ({ name: x.name, type: x.type, params: pk(x), audience: x.audience, branches: [...x.branches].sort(), schedule: sched(x.schedule), caps: caps(x.caps) });
  if (same(authored(o), authored(attempt.sent))) return { outcome: 'saved', offer: o };
  if (attempt.prev && same(authored(o), authored(attempt.prev))) return { outcome: 'not_landed', offer: o };   // landed, then undone
  return { outcome: 'conflict', offer: o };
}
const pk = (o) => (o.type === 'bogo' && Array.isArray(o.params.cats) ? { cats: o.params.cats, free_per_order: o.params.free_per_order } : o.params);
const sched = (s) => ({ start: s.start ?? null, end: s.end ?? null, days: s.days, window: s.window ?? null });
const caps = (c) => ({ redemptions: c.redemptions ?? null, spend_cents: c.spend_cents ?? null, weekly: c.weekly });

// ONE write, settled: send → classifyWrite; an UNKNOWN re-reads ONCE (getMarketing) and classifyRecovery decides. Calls injected
// (api.js offerSaveRaw / offerSetStateRaw / offerRepeatRaw, getMarketingRaw) so this stays DOM-free. A read that fails too stays
// `unknown` — the screen says it could not confirm, never that it saved.
export async function settleWrite(attempt, send, reread) {
  const first = classifyWrite(attempt, await send());
  if (first.outcome !== 'unknown') return first;
  let r;
  try { r = await reread(); } catch (_) { return { outcome: 'unknown' }; }
  if (!r || r.transport || r.status !== 200) return { outcome: 'unknown' };
  return classifyRecovery(attempt, r.body);
}
