// Portal «Marketing» «Ofertas», the non-drawing half — marketing-logic.js + the api.js raw calls, run against 3a's REAL offer cores at
// the PINNED ref (the asm10 offers pin 20000624d — the Ofertas lane's ONE pin, advisor 11-15; git-archived by ref-tree.mjs): every server reply below is the real core's,
// over production's transaction semantics, with membership by the REAL roster writer, menus by the REAL catalog mirror writer, the
// switches by the REAL config writer. No hand-built server reply.
// Run: node --test marketing-logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ML from './marketing-logic.js';
import { getMarketingRaw, offerSaveRaw, offerSetStateRaw, offerRepeatRaw } from './api.js';
import { refTree } from './ref-tree.mjs';

import { REF, BLOBS, DIR, git, rq, OM, C, CFG, NOW, DAY, OWNER, MGR, K1, K2, K3, backend, RID, read, form, authored, create, publish, one, isBrandId } from './marketing-harness.mjs';


// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test('the pin: the ref and each server file\'s blob are the ones this client was written against; the client\'s tables equal the server\'s', () => {
  assert.equal(git('rev-parse', `${REF}^{commit}`), REF, 'the pinned ref resolves');
  for (const [f, blob] of Object.entries(BLOBS)) assert.equal(git('rev-parse', `${REF}:xpizza-functions/marketing/${f}`), blob, `pinned blob ${f}`);
  assert.deepEqual([...ML.TYPES], [...OM.TYPES], 'TYPES (every type a stored record may carry)');
  assert.deepEqual([...ML.V1_TYPES], [...OM.V1_TYPES], 'V1_TYPES (a NEW offer: no «Envío gratis», owner 11-15)');
  assert.deepEqual([...ML.AUDIENCES], [...OM.AUDIENCES], 'AUDIENCES');
  assert.deepEqual(Object.keys(ML.MOVES).sort(), [...OM.STATES].sort(), 'one MOVES row per stored state');
  for (const s of OM.STATES) assert.deepEqual([...ML.MOVES[s]], [...C.MOVES[s]], `MOVES.${s}`);
  for (const k of ['name_max', 'branches_max', 'items_max', 'cats_max', 'free_per_order_max', 'pct_min', 'pct_max', 'pct_step']) assert.equal(ML.LIMITS[k], OM.LIMITS[k], `LIMITS.${k}`);
  assert.equal(ML.LIMITS.lempiras_max * 100, OM.LIMITS.cents_max, 'the lempira bound is the server\'s centavo bound');
});

test('money is WHOLE lempiras: decimals refused (never rounded), zero refused (no 0 sentinel), blank = none only where optional', () => {
  const p = (t, o) => ML.parseLempiras(t, o);
  for (const [t, cents] of [['150', 15000], ['L 150', 15000], ['L.150', 15000], ['1,500', 150000], ['1 500', 150000], ['100000', 10000000], [' 45 ', 4500]]) assert.deepEqual(p(t), { ok: true, cents }, `«${t}»`);
  for (const t of ['150.50', '150.5', '150.00', '0.5', 'L 99.99']) assert.deepEqual(p(t), { ok: false, error: 'whole_lempiras' }, `centavos refused: «${t}»`);
  assert.deepEqual(p('0'), { ok: false, error: 'positive' }, 'zero is refused: no money field has a 0 sentinel');
  assert.deepEqual(p('100001'), { ok: false, error: 'too_large' }, 'over L 100,000');
  for (const t of ['-5', 'abc', '1,50', '15o']) assert.deepEqual(p(t), { ok: false, error: 'not_a_number' }, `«${t}»`);
  assert.deepEqual(p(''), { ok: true, cents: null }, 'blank optional = none');
  assert.deepEqual(p('  ', { required: true }), { ok: false, error: 'required' }, 'blank required');
  assert.equal(ML.lempirasText(15000), '150');
  assert.equal(ML.lempirasText(undefined), '', 'absent = none');
});

test('«no maximum» / «no minimum» send the field ABSENT — the real core stores none — and the core refuses a 0 or centavos itself', async () => {
  const b = await backend();
  const pct = authored(form({ max: '' }));
  assert.deepEqual(pct.params, { pct: 20 }, 'pct with a blank maximum: no max_cents key at all');
  assert.deepEqual(ML.offerFromForm(form({ type: 'envio', min: '' })).errors, { type: 'type_not_supported' }, 'offers v1: the form never authors «Envío gratis»');
  assert.deepEqual(authored(form({ max: 'L 300' })).params, { pct: 20, max_cents: 30000 }, 'a maximum in whole lempiras → centavos');
  const saved = await create(b, form({ max: '' }));
  assert.equal('max_cents' in saved.params, false, 'the real core stored no maximum');
  assert.equal(b.fake.get(`marketing_brand/tb/offers/${saved.id}/params/max_cents`), null, 'nothing in the record either');
  for (const [params, why] of [[{ pct: 20, max_cents: 0 }, 'a 0 «no max»'], [{ pct: 20, max_cents: 15050 }, 'centavos']]) {
    const res = await offerSaveRaw({ rid: RID, expectedRev: 0, offer: { ...pct, params }, token: b.token });
    assert.deepEqual(ML.classifyWrite({ op: 'create' }, res), { outcome: 'refused', code: 'invalid', server: 'bad_request', status: 400, field: 'params', reason: 'bad_params' }, `the server refuses ${why}`);
  }
  assert.deepEqual(ML.offerFromForm(form({ max: '150.50' })).errors, { max: 'whole_lempiras' }, 'the form never sends centavos');
  assert.deepEqual(ML.offerFromForm(form({ max: '0' })).errors, { max: 'positive' }, 'the form never sends a 0');
  // offers v1 (owner 11-15): NO caps — the form sends no `caps` key; the server refuses ANY caps object (even an empty-looking one)
  assert.equal('caps' in authored(form()), false, 'no caps key on the wire');
  for (const caps of [{ redemptions: null, spend_cents: null, weekly: false }, { redemptions: 50, spend_cents: null, weekly: false }]) {
    const res = await offerSaveRaw({ rid: RID, expectedRev: 0, offer: { ...pct, caps }, token: b.token });
    assert.deepEqual(ML.classifyWrite({ op: 'create' }, res), { outcome: 'refused', code: 'invalid', server: 'bad_request', status: 400, field: 'caps', reason: 'caps_not_supported' }, `caps ${JSON.stringify(caps)}: refused`);
  }
});

test('the form agrees with the REAL validator: valid ⇔ the core\'s validateAuthored accepts it, and the offer is the core\'s normal form', () => {
  const cases = [
    form(), form({ pct: 50 }), form({ pct: 55 }), form({ pct: 4 }), form({ pct: 12 }), form({ max: '250' }),
    form({ type: 'lps', off: '50', min: '200' }), form({ type: 'lps', off: '200', min: '200' }), form({ type: 'lps', off: '250', min: '200' }), form({ type: 'lps', off: '', min: '200' }),
    form({ type: 'bogo', items: [K1], free_per_order: 1 }), form({ type: 'bogo', items: [K1, K1] }), form({ type: 'bogo', items: [] }), form({ type: 'bogo', items: [K1], free_per_order: 4 }),
    form({ type: 'bogo', items: Array.from({ length: 11 }, (_, i) => `i_${i}`) }), form({ type: 'bogo', by: 'cats', cats: ['pizzas'] }), form({ type: 'bogo', by: 'cats', cats: ['a', 'b', 'c'] }),
    form({ type: 'envio' }), form({ type: 'envio', min: '350' }), form({ type: 'nuevos', off: '75' }), form({ type: 'nuevos', nuevos_by: 'pct', pct: 15 }), form({ type: 'nuevos', nuevos_by: 'pct', pct: 7 }),
    form({ type: 'nuevos', off: '75', audience: 'all' }), form({ audience: 'returning' }), form({ audience: 'vip' }),
    form({ name: '' }), form({ name: 'x'.repeat(41) }), form({ name: '  Martes  ' }), form({ branches: [] }), form({ branches: ['tb_sur', RID] }),
    form({ start: null }), form({ end: null }), form({ end: NOW }), form({ days: [] }), form({ days: [7] }), form({ days: [6, 0, 3] }),
    form({ window: null }), form({ window: { from: 1260, to: 0 } }), form({ window: { from: 60, to: 60 } }), form({ window: { from: 0, to: 1440 } }),
  ];
  for (const f of cases) {
    const mine = ML.offerFromForm(f);
    const real = mine.ok ? OM.validateAuthored(mine.offer, { isRid: isBrandId }) : null;
    const label = JSON.stringify({ ...f, items: f.items.length > 3 ? `${f.items.length} items` : f.items });
    if (mine.ok) assert.deepEqual(real, { ok: true, value: mine.offer }, `the core accepts the form's offer verbatim: ${label}`);
    // a form the client refuses: the closest offer the core would see is refused too (the client is never STRICTER on a valid offer)
    else assert.equal(OM.validateAuthored(looseOffer(f), { isRid: isBrandId }).ok, false, `the client refused ⇒ the core refuses: ${label}`);
  }
});
// the offer a form would be WITHOUT the client's own checks — money parsed best-effort — so a client refusal is proven the core's too
function looseOffer(f) {
  const c = (t) => { const s = String(t ?? '').trim().replace(/^L\.?\s*/i, '').replace(/[, ]/g, ''); return s === '' ? null : Math.round(Number(s) * 100); };
  const params = { pct: { pct: f.pct, ...(c(f.max) !== null ? { max_cents: c(f.max) } : {}) }, lps: { off_cents: c(f.off), min_cents: c(f.min) },
    bogo: f.by === 'cats' ? { cats: f.cats, free_per_order: f.free_per_order } : { items: f.items, free_per_order: f.free_per_order },
    envio: c(f.min) !== null ? { min_cents: c(f.min) } : {}, nuevos: f.nuevos_by === 'pct' ? { pct: f.pct } : { off_cents: c(f.off) } }[f.type];
  return { name: f.name, type: f.type, params, audience: f.audience, branches: f.branches,
    schedule: { start: f.start, end: f.end, days: f.days, window: f.window } };   // v1: no caps
}

test('every V1 type round-trips through the REAL save + read: the form an offer reads back into re-authors exactly what was saved', async () => {
  const b = await backend();
  const forms = [form({ name: 'Pct' }), form({ name: 'Pct tope', max: '300' }), form({ name: 'Lps', type: 'lps', off: '50', min: '250' }),
    form({ name: 'Bogo', type: 'bogo', items: [K1, K3], free_per_order: 2, days: [5, 6], window: { from: 1260, to: 0 } }),
    form({ name: 'Nuevos L', type: 'nuevos', off: '75' }), form({ name: 'Nuevos pct', type: 'nuevos', nuevos_by: 'pct', pct: 15 })];   // every V1 type
  for (const f of forms) {
    const sent = authored(f);
    const saved = await create(b, f);
    const back = await one(b, saved.id);
    assert.equal(back.status, 'draft', `${f.name}: a new offer is a draft`);
    assert.deepEqual(authored(ML.formFromOffer(back)), sent, `${f.name}: read → form → offer is what was sent`);
  }
  const m = ML.readModel((await read(b)).body);
  assert.deepEqual([m.kind, m.offers.length, m.dropped], ['ok', forms.length, 0], 'the read lists them all');
  assert.ok(b.calls.filter((c) => c.fn === 'getMarketing').every((c) => c.method === 'GET' && c.query.rid === RID && c.body === undefined), 'the read: GET ?rid=');
  assert.ok(b.calls.filter((c) => c.fn === 'marketingOfferSave').every((c) => c.method === 'POST' && c.body.rid === RID && Object.keys(c.query).length === 0), 'writes: the rid in the BODY, nothing in the URL');
});

test('a CATEGORY offer: «Aplica a» is the list the server froze; editing it sends the categories only (both would be bad_params)', async () => {
  const b = await backend();
  const d = await create(b, form({ name: 'Pizzas 2x1', type: 'bogo', by: 'cats', cats: ['pizzas'] }));
  assert.deepEqual(d.params, { cats: ['pizzas'], items: [K1, K2], free_per_order: 1 }, 'premise: the real core resolved the category');
  assert.deepEqual(ML.appliesTo(d), [K1, K2], '«Aplica a:» = the server\'s frozen list');
  const f = ML.formFromOffer(d);
  assert.deepEqual([f.by, f.cats, f.items], ['cats', ['pizzas'], []], 'the form edits the categories, not the resolved dishes');
  const edit = authored({ ...f, name: 'Pizzas 2x1 finde' });
  assert.deepEqual(edit.params, { cats: ['pizzas'], free_per_order: 1 }, 'the edit sends cats only');
  const res = await offerSaveRaw({ rid: RID, offerId: d.id, expectedRev: 1, offer: edit, token: b.token });
  assert.equal(ML.classifyWrite({ op: 'save', offerId: d.id, expectedRev: 1 }, res).outcome, 'saved', 'the real core takes the edit');
  const both = await offerSaveRaw({ rid: RID, offerId: d.id, expectedRev: 2, offer: { ...edit, params: d.params }, token: b.token });
  assert.equal(ML.classifyWrite({ op: 'save', offerId: d.id, expectedRev: 2 }, both).reason, 'bad_params', 'premise: sending the stored params back IS refused');
  assert.deepEqual(ML.appliesTo(await one(b, d.id)), [K1, K2], 'still the frozen list');
  assert.deepEqual(ML.appliesTo({ type: 'pct', params: { pct: 10 } }), [], 'a whole-order offer lists no dishes');
});

test('live edits: the client\'s answer is the REAL liveEditProblem\'s, and the real save refuses exactly that field', async () => {
  const b = await backend();
  const live = await publish(b, form({ name: 'Viva' }));
  assert.equal(ML.editable(live), 'schedule');
  assert.equal(ML.editable({ state: 'draft', status: 'draft' }), 'all');
  assert.equal(ML.editable({ state: 'ended', status: 'ended' }), 'none');
  assert.equal(ML.editable({ state: 'active', status: 'ended' }), 'none', 'ended by schedule: nothing to edit');
  const edits = { same: {}, name: { name: 'Otra' }, pct: { pct: 25 }, branches: { branches: [RID, 'tb_sur'] }, days: { days: [2, 3] }, window: { window: null },
    start: { start: NOW + 2 * DAY }, end_later: { end: NOW + 40 * DAY }, end_sooner: { end: NOW + 10 * DAY }, end_none: { end: null } };   // v1: no caps to edit
  let rev = live.rev;
  for (const [k, patch] of Object.entries(edits)) {
    const cur = await one(b, live.id);
    const next = authored({ ...ML.formFromOffer(cur), ...patch });
    const mine = ML.liveEditProblem(cur, next);
    const real = OM.liveEditProblem(OM.authoredOf({ ...cur, v: 1 }, { isRid: isBrandId }), next);
    assert.equal(mine, real, `${k}: the client's answer is the core's (${real})`);
    const res = await offerSaveRaw({ rid: RID, offerId: live.id, expectedRev: cur.rev, offer: next, token: b.token });
    const c = ML.classifyWrite({ op: 'save', offerId: live.id, expectedRev: cur.rev }, res);
    if (real === null) { assert.equal(c.outcome, 'saved', `${k}: allowed ⇒ saved`); rev = c.offer.rev; }
    else assert.deepEqual([c.outcome, c.code, c.field], ['refused', 'live_edit', real], `${k}: refused at that field`);
  }
  assert.ok(rev > live.rev, 'premise: the allowed edits landed');
});

test('states: publish / pause / resume / end / repeat through the real core; the actions each status offers are the server\'s moves', async () => {
  const b = await backend();
  const d = await create(b, form({ name: 'Ciclo' }));
  assert.deepEqual(ML.actionsOf(d), ['publish', 'end']);
  const move = async (o, to) => {
    const a = { op: 'state', offerId: o.id, expectedRev: o.rev, to };
    return ML.classifyWrite(a, await offerSetStateRaw({ rid: RID, offerId: o.id, to, expectedRev: o.rev, token: b.token }));
  };
  const pub = await move(d, 'active');
  assert.deepEqual([pub.outcome, pub.offer.state, pub.offer.status], ['saved', 'active', 'scheduled'], 'published, starts tomorrow');
  assert.deepEqual(ML.actionsOf(pub.offer), ['pause', 'end']);
  const pau = await move(pub.offer, 'paused_owner');
  assert.deepEqual([pau.outcome, pau.offer.status], ['saved', 'paused_owner']);
  assert.deepEqual(ML.actionsOf(pau.offer), ['resume', 'end']);
  const lv = b.fake.get(`marketing_brand/tb/live/${RID}/${d.id}`);   // 3a 94e6b7ae9: ONE brand root (marketing_brand/{brand}/live/{rid}/{offer}); removal leaves a TOMBSTONE { removed, rev }
  assert.ok(lv && lv.removed === true, 'paused: out of the price path (a tombstone at the mirror\'s real path)');
  const res = await move(pau.offer, 'active');
  assert.equal(res.outcome, 'saved', 'resumed');
  const end = await move(res.offer, 'ended');
  assert.deepEqual([end.outcome, end.offer.state], ['saved', 'ended']);
  assert.deepEqual(ML.actionsOf(end.offer), ['repeat']);
  const again = await move(end.offer, 'active');
  assert.deepEqual([again.outcome, again.code], ['refused', 'stale'], 'an ended offer cannot move (bad_transition)');
  const rep = ML.classifyWrite({ op: 'repeat' }, await offerRepeatRaw({ rid: RID, sourceId: d.id, token: b.token }));
  assert.deepEqual([rep.outcome, rep.offer.state, rep.offer.schedule.start ?? null], ['saved', 'draft', null], '«Repetir»: a new draft, dates cleared');
  assert.deepEqual(ML.actionsOf({ state: 'active', status: 'ended' }), ['end', 'repeat'], 'ended by schedule: end it or repeat it');
});

test('refusals map to honest keys: overlap (with the clashing names), stale + current_rev, switched off, manager denied', async () => {
  const b = await backend();
  const bogo = (name) => form({ name, type: 'bogo', items: [K1], days: [5, 6], window: { from: 1260, to: 0 } });
  await publish(b, bogo('Primera'));
  const second = await create(b, { ...bogo('Segunda'), free_per_order: 2 });   // not identical (an identical one is a 409 duplicate, judged FIRST — 3a 94e6b7ae9)
  const ov = ML.classifyWrite({ op: 'state', offerId: second.id, expectedRev: 1, to: 'active' },
    await offerSetStateRaw({ rid: RID, offerId: second.id, to: 'active', expectedRev: 1, token: b.token }));
  assert.deepEqual([ov.outcome, ov.code, ov.with, ov.rid], ['refused', 'overlap', ['Primera'], RID], 'overlap: names the offer it clashes with');
  const stale = ML.classifyWrite({ op: 'save', offerId: second.id, expectedRev: 7 },
    await offerSaveRaw({ rid: RID, offerId: second.id, expectedRev: 7, offer: authored(bogo('Segunda b')), token: b.token }));
  assert.deepEqual([stale.outcome, stale.code, stale.current_rev], ['refused', 'stale', 1], 'superseded: stale, with the rev to reload at');
  const den = ML.classifyWrite({ op: 'create' }, await offerSaveRaw({ rid: RID, expectedRev: 0, offer: authored(form()), token: async () => `t-${MGR}` }));
  assert.deepEqual([den.outcome, den.code], ['refused', 'denied'], 'a manager cannot create (owner only)');
  const out = ML.classifyWrite({ op: 'create' }, await offerSaveRaw({ rid: RID, expectedRev: 0, offer: authored(form()), token: async () => 'nope' }));
  assert.deepEqual([out.outcome, out.code], ['refused', 'signed_out']);
  await b.setSwitch(false, 1);
  const off = ML.classifyWrite({ op: 'create' }, await offerSaveRaw({ rid: RID, expectedRev: 0, offer: authored(form()), token: b.token }));
  assert.deepEqual([off.outcome, off.code], ['refused', 'off'], 'switched off: offers_disabled');
  assert.deepEqual(ML.readModel((await read(b)).body), { kind: 'off' }, 'switched off: the read is OFF — no Ofertas path at all');
  assert.equal(ML.refusalOf(409, { error: 'something_new' }).code, 'other', 'an unknown code is `other`, its code kept');
});

test('a 503 is NEVER success: a failed brand transaction on pause is UNKNOWN — and the client classifies it no further (r6.1: the list decides)', async () => {
  const b = await backend();
  const live = await publish(b, form({ name: 'Firme' }));
  b.fake.failReads.add('marketing_brand/tb');   // 3a 94e6b7ae9: record + mirror + op claim are ONE brand transaction; it fails (an outage) ⇒ 503
  const attempt = { op: 'state', offerId: live.id, expectedRev: live.rev, to: 'paused_owner', from: 'active' };
  const raw = await offerSetStateRaw({ rid: RID, offerId: live.id, to: 'paused_owner', expectedRev: live.rev, token: b.token });
  assert.deepEqual([raw.status, raw.body.error], [503, 'unavailable'], 'premise: the real core answers 503');
  assert.deepEqual(ML.classifyWrite(attempt, raw), { outcome: 'unknown' }, 'the 503 is unknown — never saved');
  b.fake.failReads.clear();
  const still = await one(b, live.id);
  assert.deepEqual([still.state, still.rev], ['active', live.rev], 'premise (one txn): nothing was written');
  assert.deepEqual(ML.classifyWrite(attempt, { transport: true }), { outcome: 'unknown' }, 'a transport failure is unknown');
  assert.deepEqual(ML.classifyWrite(attempt, { status: 200, body: null, malformed: true }), { outcome: 'unknown' }, 'a malformed 200 is unknown');
  assert.deepEqual(ML.classifyWrite(attempt, { status: 500, body: { error: 'error' } }), { outcome: 'unknown' }, 'a 500 is unknown');
  const ok = ML.classifyWrite(attempt, await offerSetStateRaw({ rid: RID, offerId: live.id, to: 'paused_owner', expectedRev: live.rev, token: b.token }));
  assert.equal(ok.outcome, 'saved', 'healthy again: the same pause saves');
});

// r6.1 (owner 11-15, advisor; Codex r6 P1-1 / P1-2): the client never classifies an UNKNOWN — no recovery read, no inference
test('r6.1 no client recovery: classifyRecovery, settleWrite and authoredEqual are gone; an UNKNOWN stays unknown in classifyWrite', () => {
  for (const n of ['classifyRecovery', 'settleWrite', 'authoredEqual', 'findCreated']) assert.equal(typeof ML[n], 'undefined', `${n}: retired`);
  const a = { op: 'save', offerId: 'o1', expectedRev: 3 };
  for (const res of [{ transport: true }, { status: 500, body: { error: 'error' } }, { status: 503, body: { error: 'unavailable' } }, { status: 200, body: null, malformed: true }, { status: 200, body: { ok: true, offer: { id: 'o1', rev: 3 } } }])
    assert.deepEqual(ML.classifyWrite(a, res), { outcome: 'unknown' }, `${JSON.stringify(res).slice(0, 60)}: unknown, never saved / not landed`);
});
// Codex r6.1-build P1-2 / P2-1 (advisor 11-15): a 200 is definite only with a COMPLETE record; a refusal only from the allowlist
test('an incomplete 200 is UNKNOWN (never «Oferta programada»); only ALLOWLISTED 4xx are definite — 408, 429, 405, an unknown code are UNKNOWN', async () => {
  const b = await backend();
  const real = await publish(b, form({ name: 'Completa' }));
  assert.equal(ML.recordShapeOk(real), true, 'premise: the real core\'s record is complete');
  const ok = (offer) => ({ status: 200, body: { ok: true, offer } });
  const drop = (k) => { const o = { ...real }; delete o[k]; return o; };
  for (const [o, why] of [[{ rev: 1, state: 'active' }, 'no id / schedule (Codex\'s case)'], [drop('state'), 'no state'], [drop('schedule'), 'no schedule'], [drop('id'), 'no id'],
    [drop('branches'), 'no branches'], [{ ...real, params: {} }, 'pct without its pct'], [{ ...real, state: 'live' }, 'a state the server never stores']]) {
    assert.deepEqual(ML.classifyWrite({ op: 'create', opId: 'op_0123456789abcdef' }, ok(o)), { outcome: 'unknown' }, `create: ${why}`);
    assert.deepEqual(ML.classifyWrite({ op: 'save', offerId: real.id, expectedRev: real.rev - 1 }, ok(o)), { outcome: 'unknown' }, `save: ${why}`);
  }
  assert.equal(ML.classifyWrite({ op: 'create', opId: 'op_0123456789abcdef' }, ok(real)).outcome, 'saved', 'the complete record is definite');
  for (const [status, error] of [[408, 'request_timeout'], [429, 'too_many_pending'], [405, 'method_not_allowed'], [409, 'something_new'], [400, 'something_new'], [418, 'teapot'], [403, 'something_else']])
    assert.deepEqual(ML.classifyWrite({ op: 'create' }, { status, body: { error } }), { outcome: 'unknown' }, `${status} ${error}: UNKNOWN`);
  for (const [status, error] of [[400, 'bad_request'], [400, 'bad_rid'], [401, 'invalid_credentials'], [403, 'not_authorized'], [404, 'not_found'], [409, 'duplicate'], [409, 'superseded'], [409, 'op_id_conflict'], [409, 'type_not_supported'], [409, 'offers_disabled']])
    assert.equal(ML.classifyWrite({ op: 'create' }, { status, body: { error } }).outcome, 'refused', `${status} ${error}: definite`);
});
// SHIP-GATE (owner 11-15, confirm every save): the ONE fallback string — shown only when a save could not be confirmed (MOCKUP v5b 1c)
test('SHIP-GATE copy: an UNCONFIRMED outcome reads exactly «No pudimos confirmar el cambio. Revisá la oferta en la lista antes de volver a intentarlo.»; no old unknown string ships anywhere in xpizza-portal/', () => {
  assert.equal(ML.UNKNOWN_WORD, 'No pudimos confirmar el cambio. Revisá la oferta en la lista antes de volver a intentarlo.');
  const OLD = ['Revisá tu lista antes de intentar de nuevo', 'Volvé a la lista antes de intentar de nuevo', 'No sabemos si se guardó'];
  const files = readdirSync(DIR).filter((f) => /\.(js|html)$/.test(f) && !f.startsWith('__'));
  assert.ok(files.includes('marketing-builder.js') && files.includes('marketing-detail.js'), 'premise: the screens are scanned');
  for (const f of files) { const t = readFileSync(join(DIR, f), 'utf8'); for (const o of OLD) assert.ok(!t.includes(o), `${f}: the old unknown string «${o}» is gone`); }
});

// 3a 94e6b7ae9: the record and its mirror are written in ONE transaction, so drift «should never be set» (offers-core getMarketing) —
// the read still flags it. Re-derived (advisor 11-15): the lost / stranded mirror is planted directly, the only way it can exist now.
test('live_drift: an active offer missing from the price path is NOT applied; a draft still in it IS still applied (the read\'s flag)', async () => {
  const b = await backend();
  const live = await publish(b, form({ name: 'Deriva' }));
  b.fake.put(`marketing_brand/tb/live/${RID}/${live.id}`, { removed: true, rev: live.rev });   // the mirror lost (a tombstone at the record's rev)
  const o = await one(b, live.id);
  assert.deepEqual([o.state, o.live_drift, o.drift], ['active', true, 'not_applied'], 'active, out of the price path: NOT applied');
  const p = await create(b, form({ name: 'Quieta', pct: 30 }));
  const rec = b.fake.get(`marketing_brand/tb/offers/${p.id}`);
  b.fake.put(`marketing_brand/tb/live/${RID}/${p.id}`, OM.liveProjection(rec, 'tb'));   // the real projection, stranded under a draft
  const q = await one(b, p.id);
  assert.deepEqual([q.state, q.drift], ['draft', 'still_applied'], 'a draft still in the price path: STILL applied');
  assert.equal(ML.driftOf({ state: 'active' }), null, 'no flag, no drift');
});

test('the Anuncio stays DARK: only api.js calls its endpoints, no shipped module imports those calls, and the offers model drops the bookings', async () => {
  const src = readdirSync(DIR).filter((f) => /\.(js|html|mjs)$/.test(f) && !/\.test\.mjs$/.test(f));
  // compact projections (the first hit, or null) — a failing whole-file match would carry the file into the report
  const hit = (f, re) => (readFileSync(join(DIR, f), 'utf8').match(re) || [null])[0];
  for (const f of src) if (f !== 'api.js') assert.equal(hit(f, /rawCall\('(getAnuncioWeeks|anuncioBook|anuncioCancel)'|cloudfunctions\.net\/(getAnuncioWeeks|anuncioBook|anuncioCancel)/), null, `${f} calls no Anuncio endpoint (api.js only)`);
  for (const f of src) assert.equal(hit(f, /import\s*\{[^}]*\b(getAnuncioWeeksRaw|anuncioBookRaw|anuncioCancelRaw)\b[^}]*\}\s*from/), null, `${f}: no shipped module imports an Anuncio call`);
  const m = ML.readModel({ ok: true, switches: { offers_enabled: true, anuncio_enabled: true }, offers: [], bookings: [{ id: 'x' }] });
  assert.deepEqual(m, { kind: 'ok', offers: [], dropped: 0 }, 'no bookings in the model');
  assert.deepEqual(ML.readModel(null), { kind: 'unreadable' });
});

// ═══ O1 · the Campañas list (MOCKUP-portal-marketing v5 s-home, owner-approved 11-14) — from REAL server offers ══════════════════
test('O1 list: one row per offer — the dot status, «Horario» in plain words, the branch note when narrowed, the type icon; grouped as drawn', async () => {
  const b = await backend();
  const live = await publish(b, form({ name: 'Almuerzo: 15 % en todo el menú', pct: 15, start: NOW, end: null, days: [1, 2, 3, 4, 5], window: { from: 660, to: 840 } }));
  const sched = await publish(b, form({ name: '2 por 1 en pizzas clásicas', start: NOW + DAY, end: null, days: [5, 6], window: { from: 1260, to: 0 } }));
  const draft = await create(b, form({ name: 'Cena: L 40 en pedidos desde L 300', days: [0, 1, 2, 3, 4, 5, 6], window: null }));
  const one2 = await publish(b, form({ name: 'Fin de semana: 10 % en pastas', pct: 10, start: NOW, end: null, days: [0, 6], window: null, branches: [RID] }));
  const m = ML.readModel((await read(b)).body);
  const rows = ML.listRows(m.offers, { nBranches: 2, canEdit: true });
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.deepEqual(rows.map((r) => r.status.key), ['activa', 'activa', 'prog', 'borr'], 'grouped as drawn: Activa · Programada · Pausada · Terminada · Borrador');
  assert.deepEqual(by[live.name].status, { key: 'activa', word: 'Activa' });
  assert.equal(by[live.name].horario, 'Lun–Vie · 11:00–14:00', 'a weekday run + the window');
  assert.equal(by[sched.name].horario, 'Vie y Sáb · 21:00–00:00', 'two days; a window to midnight');
  assert.equal(by[one2.name].horario, 'Sáb y Dom · todo el día', 'Monday-first: «Sáb y Dom», no window = todo el día');
  assert.equal(by[draft.name].horario, null, 'a draft is «Sin programar» (the screen words null)');
  assert.equal(by[one2.name].branchNote, '1 de 2 sucursales', 'narrowed: «N de M sucursales»');
  assert.equal(by[live.name].branchNote, '1 de 2 sucursales');
  assert.equal(ML.listRows(m.offers, { nBranches: 1, canEdit: true }).find((r) => r.name === live.name).branchNote, null, 'all of the restaurant\'s branches: no note');
  assert.equal(by[live.name].icon, 'i-percent');
  assert.deepEqual(ML.horario({ days: [0, 1, 2, 3, 4, 5, 6], window: null }), 'Todos los días · todo el día');
  assert.deepEqual(ML.horario({ days: [1, 3, 5], window: { from: 1110, to: 1380 } }), 'Lun, Mié y Vie · 18:30–23:00', 'three apart: a list');
});

test('O1 list: the Acciones menu is the DRAWN menu intersected with what the server allows — never a move it refuses, never «Eliminar» (no delete)', async () => {
  const b = await backend();
  const live = await publish(b, form({ name: 'A', start: NOW }));
  const sched = await publish(b, form({ name: 'B', pct: 25 }));   // a different discount: an identical one is a 409 duplicate (3a e3c5f7366)
  const draft = await create(b, form({ name: 'C' }));
  const paused = ML.classifyWrite({ op: 'state', offerId: live.id, expectedRev: live.rev, to: 'paused_owner' },
    await offerSetStateRaw({ rid: RID, offerId: live.id, to: 'paused_owner', expectedRev: live.rev, token: b.token })).offer;
  const ended = ML.classifyWrite({ op: 'state', offerId: sched.id, expectedRev: sched.rev, to: 'ended' },
    await offerSetStateRaw({ rid: RID, offerId: sched.id, to: 'ended', expectedRev: sched.rev, token: b.token })).offer;
  const live2 = await publish(b, form({ name: 'D', start: NOW, days: [3] }));
  const menu = (o) => ML.rowMenu(o, true);
  assert.deepEqual(menu(live2), ['view', 'pause', 'edit', 'end'], 'Activa: Ver · Pausar · Editar · Terminar («Repetir» needs an ENDED offer: the server answers not_ended)');
  assert.deepEqual(menu(paused), ['view', 'resume', 'edit', 'end'], 'Pausada (by the owner): Ver · Reanudar · Editar · Terminar');
  assert.deepEqual(menu(ended), ['view', 'repeat'], 'Terminada: Ver · Repetir');
  assert.deepEqual(menu(draft), ['continue'], 'Borrador: «Seguir editando» («Eliminar»: no delete on the server)');
  assert.deepEqual(menu(await publish(b, form({ name: 'E', days: [4] }))), ['view', 'edit'], 'Programada: Ver · Editar, as drawn');
  assert.deepEqual(ML.rowMenu(live2, false), [], 'a manager reads the list; no actions');
  for (const o of [live2, paused, ended, draft]) for (const a of menu(o)) {
    const need = { pause: 'paused_owner', resume: 'active', end: 'ended' }[a];
    if (need) assert.ok(ML.MOVES[o.state].includes(need), `${o.name}: «${a}» is a server move from ${o.state}`);
    if (a === 'repeat') assert.equal(o.status, 'ended', 'repeat only from ended');
  }
});

test('O1 list: «Estado ▾» counts and filters; «Todas las sucursales» is the union of the branch reads (one row per offer, the newest rev)', async () => {
  const b = await backend();
  const both = await publish(b, form({ name: 'Ambas', start: NOW, branches: [RID, 'tb_sur'] }));
  const sur = await create(b, form({ name: 'Solo sur', branches: ['tb_sur'] }));
  const centro = await create(b, form({ name: 'Solo centro' }));
  const reads = [ML.readModel((await read(b)).body), ML.readModel((await read(b, 'tb_sur')).body)];
  const all = ML.unionOffers(reads.map((r) => r.offers));
  assert.deepEqual(all.map((o) => o.name).sort(), ['Ambas', 'Solo centro', 'Solo sur'], 'one row per offer across the branches');
  assert.equal(all.filter((o) => o.id === both.id).length, 1, 'the two-branch offer once');
  assert.deepEqual(ML.estadoCounts(all), { all: 3, live: 1, scheduled: 0, paused_owner: 0, ended: 0, draft: 2 });
  assert.deepEqual(ML.byEstado(all, 'draft').map((o) => o.name).sort(), ['Solo centro', 'Solo sur']);
  assert.deepEqual(ML.byEstado(all, 'all').length, 3);
  void sur; void centro;
});

// ═══ O2a · the builder's words (MOCKUP-portal-marketing v5 3 + PLAN-portal-marketing-O2-r0 rulings, advisor 11-14) ═══════════════════
const HN0 = (y, m, d) => Date.UTC(y, m - 1, d, 6);   // 00:00 HN of a calendar day
const BR3 = [{ rid: 'r_c', name: 'Centro' }, { rid: 'r_p', name: 'Los Próceres' }, { rid: 'r_t', name: 'El Trapiche' }];
const MENU3 = [{ key: 'i_m', name: 'Pizza Margarita', price_cents: 28000 }, { key: 'i_h', name: 'Pizza Hawaiana', price_cents: 29000 }, { key: 'i_v', name: 'Pizza Vegetariana', price_cents: 27000 }];
const bform = (o = {}) => ({ ...ML.emptyForm(o.type || 'bogo'), branches: BR3.map((b) => b.rid), start: HN0(2026, 11, 12), end: HN0(2026, 11, 30), days: [5, 6], window: { from: 1260, to: 0 }, ...o });
test('O2a words: each type\'s chip, title, auto name, Descuento row value and cost line — v5\'s templates, filled from the form (no money invented)', () => {
  const ctx = { branches: BR3, items: MENU3 };
  const bogo = ML.builderText(bform({ items: ['i_m', 'i_h', 'i_v'], free_per_order: 1 }), ctx);
  assert.deepEqual([bogo.chip, bogo.title, bogo.autoName, bogo.sumType, bogo.rowLabel, bogo.prodSummary], ['2 por 1', 'Comprá 1 y llevate otro gratis en 3 productos', '2 por 1 en 3 productos', 'Hasta 1 gratis por pedido', 'Descuento', '3 productos']);
  assert.deepEqual(bogo.cost, { lead: 'El descuento lo cubre tu restaurante. Sherpa no te cobra.', ceiling: 'Hasta L 290 por canje.' }, '2×1: the dearest chosen item × gratis por pedido (menu prices)');
  assert.equal(ML.builderText(bform({ items: ['i_m', 'i_h'], free_per_order: 2 }), ctx).cost.ceiling, 'Hasta L 580 por canje.');
  const pct = ML.builderText(bform({ type: 'pct', pct: 15, max: '100' }), ctx);
  assert.deepEqual([pct.chip, pct.title, pct.autoName, pct.sumType, pct.cost.ceiling], ['15 % menos', '15 % de descuento en todo el menú, hasta L 100', '15 % en todo el menú', '15 % · hasta L 100 por pedido', 'Hasta L 100 por canje.']);
  const lps = ML.builderText(bform({ type: 'lps', off: '50', min: '300' }), ctx);
  assert.deepEqual([lps.chip, lps.title, lps.autoName, lps.sumType, lps.cost.ceiling], ['L 50 menos', 'L 50 de descuento en pedidos desde L 300', 'L 50 en pedidos desde L 300', 'L 50 · mínimo L 300', 'Hasta L 50 por canje.']);
  const env = ML.builderText(bform({ type: 'envio', min: '350' }), ctx);
  assert.deepEqual([env.chip, env.title, env.autoName, env.sumType, env.rowLabel], ['Envío gratis', 'Envío gratis en pedidos desde L 350', 'Envío gratis desde L 350', 'Pedidos desde L 350', 'Envío']);
  assert.deepEqual(env.cost, { lead: 'El envío lo cubre tu restaurante. Sherpa no te cobra.', ceiling: 'Hasta el costo del envío por canje.' }, 'envío: v5\'s own phrase, no figure (Q5)');
  const nue = ML.builderText(bform({ type: 'nuevos', off: '50' }), ctx);
  assert.deepEqual([nue.chip, nue.title, nue.autoName, nue.sumType, nue.cost.ceiling], ['Bienvenida', 'L 50 de descuento en tu primer pedido', 'L 50 de bienvenida', 'L 50 · primer pedido', 'Hasta L 50 por canje.'], 'nuevos: no minimum (the server has none)');
  assert.equal(ML.builderText(bform({ type: 'pct', pct: 15, max: '1500' }), ctx).cost.ceiling, 'Hasta L 1,500 por canje.', 'money as v5 writes it: comma thousands');
});

test('O2a words: Sucursales, Horario (days, franja, dates), the preview\'s «when» — the drawn phrasings; offers v1 has no Límites (owner 11-15)', () => {
  const ctx = { branches: BR3, items: MENU3 };
  const t = ML.builderText(bform({ items: ['i_m'] }), ctx);
  assert.deepEqual([t.branchText, t.branchShort], ['Las 3 sucursales', '3 sucursales']);
  assert.deepEqual([ML.builderText(bform({ branches: ['r_c'] }), ctx).branchText, ML.builderText(bform({ branches: ['r_c'] }), ctx).branchShort], ['Solo Centro', 'Centro']);
  assert.equal(ML.builderText(bform({ branches: ['r_c', 'r_t'] }), ctx).branchText, '2 de 3 sucursales: Centro y El Trapiche');
  assert.equal(ML.builderText(bform({ branches: [] }), ctx).branchText, 'Elegí al menos una sucursal');
  assert.deepEqual([t.daysText, t.slotText, t.when, t.sumSched], ['Vie y Sáb', '21:00–00:00', 'Vie y Sáb, 21:00–00:00 · hasta el 30 nov', 'Vie y Sáb · 21:00–00:00 · del 12 nov al 30 nov']);   // as v5 RENDERS it (its script's fmt overwrites the static «del 12 al 30 nov» on load)
  assert.deepEqual(t.schedSummary, { strong: 'Vie y Sáb · 21:00–00:00', rest: 'del 12 nov al 30 nov.' });
  const days = (d) => ML.builderText(bform({ days: d }), ctx).daysText;
  assert.deepEqual([days([0, 1, 2, 3, 4, 5, 6]), days([1, 2, 3, 4, 5]), days([0, 6]), days([1, 3, 5]), days([])], ['Todos los días', 'Lun a Vie', 'Sáb y Dom', 'Lun, Mié, Vie', 'Elegí al menos un día']);
  const open = ML.builderText(bform({ end: null, window: null, days: [0, 1, 2, 3, 4, 5, 6] }), ctx);
  assert.deepEqual([open.slotText, open.when, open.schedSummary.rest, open.sumSched], ['todo el día', 'Todos los días, todo el día', 'desde el 12 nov, sin fecha de fin.', 'Todos los días · todo el día · desde el 12 nov, sin fecha de fin']);
  // offers v1 (owner 11-15): no caps — the words carry no «Límites», «tope» or «canjes» at all
  for (const o of [{}, { end: null }, { type: 'pct', pct: 15, max: '100' }]) {
    const w = ML.builderText(bform(o), ctx);
    assert.equal('caps' in w, false, 'no caps words');
    assert.ok(!/Límites|[Tt]ope|canjes/.test(JSON.stringify(w)), `no cap copy: ${JSON.stringify(o)}`);
  }
});

test('O2a: the one-line block reason under «Revisar y programar» — the first missing piece, as v5 words it; a valid form has none', () => {
  const ctx = { branches: BR3, items: MENU3 };
  const block = (o) => ML.builderText(bform(o), ctx).block;
  assert.equal(block({ items: ['i_m'] }), null, 'a valid 2×1');
  assert.equal(block({ items: ['i_m'], days: [] }), 'Para revisar, elegí al menos un día.');
  assert.equal(block({ items: [] }), 'Para revisar, agregá al menos un producto.');
  assert.equal(block({ items: ['i_m'], branches: [] }), 'Para revisar, elegí al menos una sucursal.');
  assert.equal(block({ type: 'pct', pct: 15, max: '' }), 'Para revisar, poné el descuento máximo por pedido.', 'pct requires its maximum here (v2 item 3; stricter than the server)');
});

test('3a\'s idempotent create / repeat (REF): the SAME op_id twice ⇒ the SAME offer, one record; a malformed op_id ⇒ 400', async () => {
  const b = await backend();
  const f = form({ name: 'Una vez' });
  const op = 'op_0123456789abcdef';
  const one = await offerSaveRaw({ rid: RID, expectedRev: 0, offer: authored(f), opId: op, token: b.token });
  const two = await offerSaveRaw({ rid: RID, expectedRev: 0, offer: authored(f), opId: op, token: b.token });
  assert.equal(one.status, 200); assert.equal(two.status, 200);
  assert.equal(two.body.offer.id, one.body.offer.id, 'the retry answers the SAME offer');
  assert.equal(Object.values(b.fake.get('marketing_brand/tb/offers')).filter((r) => r.name === 'Una vez').length, 1, 'ONE record');
  assert.equal(ML.classifyWrite({ op: 'create', opId: op }, two).outcome, 'saved', 'an op_id reply is our record');
  const bad = await offerSaveRaw({ rid: RID, expectedRev: 0, offer: authored(f), opId: 'short', token: b.token });
  assert.equal(bad.status, 400, 'a malformed op_id is refused');
  const src = await publish(b, form({ name: 'Origen', start: NOW }));
  await offerSetStateRaw({ rid: RID, offerId: src.id, to: 'ended', expectedRev: src.rev, token: b.token });
  const rop = 'op_fedcba9876543210';
  const r1 = await offerRepeatRaw({ rid: RID, sourceId: src.id, opId: rop, token: b.token });
  const r2 = await offerRepeatRaw({ rid: RID, sourceId: src.id, opId: rop, token: b.token });
  assert.equal(r2.body.offer.id, r1.body.offer.id, 'a repeat retry answers the SAME copy');
  assert.equal(Object.values(b.fake.get('marketing_brand/tb/offers')).filter((r) => r.repeated_from === src.id).length, 1, 'ONE copy');
});
