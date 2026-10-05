'use strict';
// Portal 1D · D4-b — FORMAT-TAGGED BINDINGS (PLAN-D4b §A, §B, Tests; advisor Q1, Q2, Q4, Q5).
// Every canonical artifact below is built by the REAL functions in canonical mode and judged by the REAL readers
// (gateConfirmedNet, classifyExistingOrder, acquireHostedAttempt/classifyHostedAttempt, acquireOnlineAttempt,
// reserveRedemption). Canonical ids are DISTINCT from the legacy keys for BOTH restaurants — la_musa's slugs equal
// its canonical ids in production, which would let a canonical test silently exercise legacy behaviour.
const assert = require('assert');
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'd4b-bindings-secret';
const SECRET = process.env.QUOTE_TOKEN_SECRET;
const F = require('../test/d4b-legacy-fixtures');
const GOLDEN = require('./d4b-legacy-hashes.golden.json');
const CALLSEQ = require('./d4b-callseq.golden.json');
const CB = require('./canonical-binding');
const { createPricingResolver } = require('./pricing-tables');
const { signQuoteToken, normalizeCartForFingerprint, cartFingerprint } = require('../quote-token');
const { issueQuote } = require('../quote-issue');
const { gateConfirmedNet } = require('../token-gate');
const { computeRedemption, redemptionFingerprint } = require('../rewards-redeem');
const { classifyExistingOrder, computeIncomingFingerprint, computeCanonicalIncomingFingerprint } = require('../createorder-classify');
const { prepareRedemption } = require('../rewards-redeem-intake');
const { orderFingerprint } = require('../pixelpay-charge');
const { orderBreakdownCents } = require('../order-money');
const { computeServerTotal } = require('../menu-pricing');
const SCHED = require('../scheduled-orders');
const hosted = require('../pixelpay-hosted-charge');
const direct = require('../pixelpay-charge');
const reserve = require('../rewards-reserve');
const { REDEMPTION_CONFIG_VERSION } = require('../rewards-redeem-config');
const { createFakeRtdb } = require('../test/d4b-fake-rtdb');
const { scenarios: callseqScenarios } = require('../test/d4b-callseq');
const { catalogSnapshot } = require('./generate-form-bundle');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const NOW = F.NOW;

// A usable D4-a context per restaurant, canonical ids ≠ legacy keys, labels from the catalog.
function contextFor(rid) {
  const s = catalogSnapshot(rid);
  return { usableAsIdentity: true, objects: [
    ...s.items.map((i, k) => ({ kind: 'dish', legacyKey: i.key, canonicalId: `CID-${rid}-D${String(k).padStart(3, '0')}`, label: i.display.name })),
    ...s.extras.map((e, k) => ({ kind: 'extra', legacyKey: e.key, canonicalId: `CID-${rid}-E${String(k).padStart(3, '0')}`, label: e.display.name }))] };
}
// Tables carrying that context exactly as production does: through the REAL resolver's envelope.
async function tablesWithContext(rid, context = contextFor(rid)) {
  const t = F.tablesFor(rid);
  const res = createPricingResolver({ reader: { getTables: async () => ({ menu: t.menu, extras: t.extras, versionId: 'v1', seq: 1 }) }, alarm: () => {}, context: { resolve: () => context } });
  return res.getPricingTables(rid);
}
const canonicalToken = (payload) => signQuoteToken({ rid: payload.rid, customer_id: null, components: {}, redemption_ref: null, issued_at: NOW, expires_at: NOW + 600000, quote_id: 'q1', ...payload }, SECRET);

(async () => {
  for (const rid of F.RIDS) for (const o of contextFor(rid).objects) assert.notStrictEqual(o.canonicalId, o.legacyKey);

  // ── 1. STRUCTURAL GOLDEN: a canonical projection = the legacy structure with ONLY the keys substituted ──────
  for (const rid of F.RIDS) {
    const ctx = contextFor(rid), carts = F.cartsFor(rid), tables = F.tablesFor(rid);
    const legacyNorm = normalizeCartForFingerprint(carts.plain, rid);
    const c = CB.canonicalCartNorm(carts.plain, rid, ctx);
    assert.ok(c.ok);
    const strip = (norm) => JSON.stringify(norm.map((l) => ({ qty: l.qty, extras: l.extras.map((e) => ({ qty: e.qty })) })));
    assert.strictEqual(strip(c.norm), strip(legacyNorm), `${rid}: same lines, same quantities, same extras multiplicity — only keys differ`);
    const map = CB.identityMap(ctx);
    c.norm.forEach((l, i) => { assert.strictEqual(l.id, CB.ck('dish', map.dish.get(legacyNorm[i].id))); l.extras.forEach((e, j) => assert.strictEqual(e.id, CB.ck('extra', map.extra.get(legacyNorm[i].extras[j].id)))); });
    const red = computeRedemption({ redeem: F.redeemFor(rid), items: carts.plain, restaurantId: rid, tables });
    const cr = CB.canonicalReward(red, ctx);
    assert.ok(cr.ok);
    const legacyFields = Object.keys(red.canonical).sort();
    assert.deepStrictEqual(Object.keys(cr.reward.canonical).sort(), [...legacyFields, 'v'].sort(), `${rid}: canonical reward = legacy fields + v`);
    for (const k of legacyFields) if (!['free_item_key', 'items'].includes(k)) assert.deepStrictEqual(cr.reward.canonical[k], red.canonical[k], `${rid}: ${k} retained`);
    assert.strictEqual(cr.reward.freeItems.length, red.freeItems.length);
    for (const fi of cr.reward.freeItems) assert.ok(CB.parseCk(fi.item_id), 'freeItems[].item_id substituted');
    if (Array.isArray(cr.reward.canonical.items)) {
      const keys = cr.reward.canonical.items.map((x) => x.free_item_key);
      assert.deepStrictEqual(keys, [...keys].sort(), 'la_musa items re-sorted by ck with the legacy comparator');
    } else assert.ok(CB.parseCk(cr.reward.canonical.free_item_key), 'x_pizza free_item_key substituted');
  }
  ok('structural golden: every canonical projection is the legacy normalized structure with ONLY the identity keys substituted (lines, qty, extras multiplicity, reward fields retained + v:"c1"; la_musa items re-sorted by ck)');

  // ── 2. IDENTITY SENSITIVITY through the REAL verifier ─────────────────────────────────────────────────
  for (const rid of F.RIDS) {
    const tables = await tablesWithContext(rid);
    const ctx = contextFor(rid), carts = F.cartsFor(rid);
    const fpOf = (cart, reward = null, c = ctx) => { const r = CB.canonicalCartDigest(cart, reward, rid, c); assert.ok(r.ok, JSON.stringify(r)); return r.fp; };
    const base = fpOf(carts.plain);
    const tok = canonicalToken({ rid, cart_fingerprint: base, net_total_cents: computeServerTotal(carts.plain, rid, F.tablesFor(rid)).total * 100, fp_format: 'canonical' });
    const gate = (cart, reward = null, t = tables) => gateConfirmedNet({ token: tok, submittedCart: cart, reward, rid, tables: t, secret: SECRET, enforce: true, nowMs: NOW + 1 });
    const g0 = gate(carts.plain);
    assert.strictEqual(g0.reason, 'confirmed', `${rid}: the real verifier accepts the canonical token for its own cart (${g0.reason})`);
    // only a dish cid differs
    const swapDish = JSON.parse(JSON.stringify(ctx)); const d0 = swapDish.objects.find((o) => o.kind === 'dish' && o.legacyKey === normalizeCartForFingerprint(carts.plain, rid)[0].id); d0.canonicalId = 'CID-OTHER-DISH';
    assert.notStrictEqual(fpOf(carts.plain, null, swapDish), base, 'a dish cid alone changes the fingerprint');
    assert.strictEqual(gate(carts.plain, null, await tablesWithContext(rid, swapDish)).reason, 'cart_mismatch', 'and the real verifier refuses it');
    // only an extra cid differs
    const swapExtra = JSON.parse(JSON.stringify(ctx)); const e0 = swapExtra.objects.find((o) => o.kind === 'extra' && o.legacyKey === normalizeCartForFingerprint(carts.plain, rid)[0].extras[0].id); e0.canonicalId = 'CID-OTHER-EXTRA';
    assert.notStrictEqual(fpOf(carts.plain, null, swapExtra), base, 'an extra cid alone changes the fingerprint');
    // only the KIND differs (the same cid as a dish vs an extra)
    assert.notStrictEqual(cartFingerprint([{ id: CB.ck('dish', 'X'), qty: 1, extras: [] }], null, { v: 'c1' }), cartFingerprint([{ id: CB.ck('extra', 'X'), qty: 1, extras: [] }], null, { v: 'c1' }), 'kind alone changes the fingerprint');
    // the collision fixture: {A,1,[E]}×2 ≠ {A,2,[E]}
    assert.notStrictEqual(fpOf(carts.collisionTwo), fpOf(carts.collisionOne), 'two lines {A,1,[E]} ≠ one line {A,2,[E]}');
    // line order irrelevant
    assert.strictEqual(fpOf([...carts.plain].reverse()), base, 'line order is irrelevant');
    // a label change keeps the fingerprint
    const relabel = JSON.parse(JSON.stringify(ctx)); relabel.objects.forEach((o) => { o.label = `${o.label} (nuevo)`; });
    assert.strictEqual(fpOf(carts.plain, null, relabel), base, 'labels never enter a canonical fingerprint');
    // id / priced-object disagreement → refuse; an absent claim is not a refusal (Q4)
    const claimed = carts.plain.map((l, i) => (i === 0 ? { ...l, dish_id: 'CID-SOMETHING-ELSE' } : l));
    assert.strictEqual(gate(claimed).reason, 'cart_unverifiable', 'a dish_id claim that disagrees with the priced object refuses');
    const goodClaim = carts.plain.map((l, i) => (i === 0 ? { ...l, dish_id: CB.identityMap(ctx).dish.get(normalizeCartForFingerprint(carts.plain, rid)[0].id) } : l));
    assert.strictEqual(gate(goodClaim).reason, 'confirmed', 'an agreeing claim is accepted');
    // an unusable context → unverifiable → refuse (never null, never the legacy comparison)
    assert.strictEqual(gate(carts.plain, null, await tablesWithContext(rid, { ...ctx, usableAsIdentity: false })).reason, 'cart_unverifiable');
    assert.strictEqual(gate(carts.plain, null, F.tablesFor(rid)).reason, 'cart_unverifiable', 'tables with no envelope/context → unverifiable');
    // reward identity, each of the three fields: swapping the reward identity with equal qty, price and cost moves rf: and the quote
    const red = computeRedemption({ redeem: F.redeemFor(rid), items: carts.plain, restaurantId: rid, tables: F.tablesFor(rid) });
    const rf0 = CB.canonicalRedemptionFp(red, ctx).fp, q0 = fpOf(carts.plain, red);
    const moved = JSON.parse(JSON.stringify(ctx));
    for (const fi of red.freeItems) { const o = moved.objects.find((x) => x.legacyKey === fi.item_id && (x.kind === 'dish' || x.kind === 'extra')); o.canonicalId = `${o.canonicalId}-SWAPPED`; }
    assert.notStrictEqual(CB.canonicalRedemptionFp(red, moved).fp, rf0, 'a reward identity swap (equal qty/price/cost) changes rf:');
    assert.notStrictEqual(fpOf(carts.plain, red, moved), q0, '…and the quote fingerprint (freeItems[].item_id)');
    // reward cost/config change → different rf:
    assert.notStrictEqual(CB.canonicalRedemptionFp({ ...red, canonical: { ...red.canonical, config_version: red.canonical.config_version + 1 } }, ctx).fp, rf0);
    if (rid === 'x_pizza') assert.notStrictEqual(CB.canonicalRedemptionFp({ ...red, canonical: { ...red.canonical, cost: red.canonical.cost + 1 } }, ctx).fp, rf0);
    else assert.notStrictEqual(CB.canonicalRedemptionFp({ ...red, canonical: { ...red.canonical, items: red.canonical.items.map((x, i) => (i === 0 ? { ...x, cost: x.cost + 1 } : x)) } }, ctx).fp, rf0);
    // canonical ≠ legacy for the same cart (v:"c1" + substituted keys)
    assert.notStrictEqual(base, GOLDEN.values[rid].quote_plain);
  }
  // the three reward fields are each in the hash: canonical.free_item_key (x_pizza) / canonical.items[] (la_musa) via rf:, freeItems[].item_id (both) via the quote
  ok('identity sensitivity through the REAL verifier (both brands): dish-cid / extra-cid / kind-only changes, reward-identity swaps with equal qty·price·cost (rf: and quote), cost/config changes all move the fingerprint; the collision pair stays distinct; line order and labels do not; a disagreeing dish_id claim or an unusable context → cart_unverifiable');

  // ── 3. LEGACY SHADOW IDS + the writer × reader matrix ──────────────────────────────────────────────────
  for (const rid of F.RIDS) {
    const tables = await tablesWithContext(rid), carts = F.cartsFor(rid);
    const q = issueQuote({ items: carts.plain, reward: null, rid, tables, nowMs: NOW });           // a D4-b (legacy) artifact
    const shadow = carts.plain.map((l, i) => (i === 0 ? { ...l, dish_id: 'CID-DISAGREES' } : l));
    const g = gateConfirmedNet({ token: q.quote_token, submittedCart: shadow, reward: null, rid, tables, secret: SECRET, enforce: true, nowMs: NOW + 1 });
    assert.strictEqual(g.reason, 'confirmed', `${rid}: in the LEGACY branch a disagreeing dish_id is NOT a refusal (today)`);
    // writer × reader: legacy artifact (identical to the 717f97e golden) → legacy branch; canonical artifact → canonical branch
    const payload = JSON.parse(Buffer.from(q.quote_token.split('.')[0], 'base64url'));
    assert.strictEqual(payload.cart_fingerprint, GOLDEN.values[rid].quote_plain, 'the D4-b writer emits the pre-D4-b artifact byte-for-byte');
    assert.strictEqual(payload.fp_format, undefined, 'untagged');
  }
  ok('legacy branch: a disagreeing dish_id shadow claim is accepted exactly as today; writer × reader: the D4-b issuer emits the 717f97e artifact byte-for-byte (untagged) and the D4-b reader accepts it; synthetic canonical artifacts (cell 2) are accepted only by the canonical branch');

  // ── 4. FORMAT AUTHORITY: malformed tag; request tag ignored ─────────────────────────────────────────────
  {
    const rid = 'x_pizza', tables = await tablesWithContext(rid), carts = F.cartsFor(rid);
    for (const bad of ['Canonical', 'legacy', 1, null, true, {}]) {
      const t = canonicalToken({ rid, cart_fingerprint: GOLDEN.values[rid].quote_plain, net_total_cents: 100000, fp_format: bad });
      const g = gateConfirmedNet({ token: t, submittedCart: carts.plain, reward: null, rid, tables, secret: SECRET, enforce: true, nowMs: NOW + 1 });
      assert.strictEqual(g.reason, 'binding_format_invalid', `token fp_format=${JSON.stringify(bad)} → refused, never a fallback`);
      assert.deepStrictEqual(classifyExistingOrder({ restaurant_id: rid, payment_method: 'cash', status: 'new', payment_fingerprint: 'x', fp_format: bad }, { paymentMethod: 'cash', restaurantMatches: true }, 'x', {}), { action: '409', reason: 'binding_format_invalid' });
    }
    // a tag on the REQUEST is ignored: the cart lines and the body carry it, the signed payload does not
    const q = issueQuote({ items: carts.plain, reward: null, rid, tables, nowMs: NOW });
    const tagged = carts.plain.map((l) => ({ ...l, fp_format: 'canonical' }));
    const g = gateConfirmedNet({ token: q.quote_token, submittedCart: tagged, reward: null, rid, tables, secret: SECRET, enforce: true, nowMs: NOW + 1, fp_format: 'canonical' });
    assert.strictEqual(g.reason, 'confirmed', 'request-supplied tags are ignored — the payload is the authority');
  }
  ok('format authority: a malformed / unknown tag on the token or the stored order → binding_format_invalid (6 shapes); a tag supplied in the REQUEST is ignored');

  // ── 5. createOrder through the REAL classify path ────────────────────────────────────────────────────
  for (const rid of F.RIDS) {
    const carts = F.cartsFor(rid), ctx = contextFor(rid), tablesC = await tablesWithContext(rid);
    const total = computeServerTotal(carts.plain, rid, F.tablesFor(rid)).total;
    const db = createFakeRtdb({ config: { redemption_enabled: true } });
    const deps = { orderBreakdownCents, prepareRedemption, orderFingerprint, schedFingerprintExtra: SCHED.fingerprintExtra, db, tables: tablesC, eligible: null };
    // the capture's exact items_text, so the legacy recompute can be compared with the golden
    const ctxArgs = { orderId: F.ORDER_ID, restaurantId: rid, total, itemsText: `2x ${carts.plain[0].name} | 1x ${carts.plain[1].name}`, items: carts.plain, redeem: null, customerUid: F.UID, scheduledForRaw: undefined, orderType: 'delivery' };
    const canonNow = await computeCanonicalIncomingFingerprint(ctxArgs, { ...deps, context: ctx });
    assert.ok(canonNow.ok);
    const stored = { restaurant_id: rid, payment_method: 'cash', status: 'new', payment_fingerprint: canonNow.fp, fp_format: 'canonical' };
    const cls = (inc, canon) => classifyExistingOrder(stored, { paymentMethod: 'cash', restaurantMatches: true }, inc, { canonicalIncoming: canon });
    assert.deepStrictEqual(cls(null, canonNow), { action: '200' }, 'canonical same-order retry → 200');
    const unv = await computeCanonicalIncomingFingerprint(ctxArgs, { ...deps, context: { ...ctx, usableAsIdentity: false } });
    assert.strictEqual(unv.ok, false, 'never null');
    assert.deepStrictEqual(cls(null, unv), { action: '409', reason: 'cart_unverifiable' }, '🔴 canonical unverifiable → REFUSED (409), not the legacy fail-open 200');
    const other = await computeCanonicalIncomingFingerprint({ ...ctxArgs, items: carts.collisionOne }, { ...deps, context: ctx });
    assert.deepStrictEqual(cls(null, other), { action: '409', reason: 'cart' });
    // legacy: today's fail-open preserved (null incoming → 200), today's mismatch → 409 cart
    const legacy = { restaurant_id: rid, payment_method: 'cash', status: 'new', payment_fingerprint: GOLDEN.values[rid].order_fp_plain };
    assert.deepStrictEqual(classifyExistingOrder(legacy, { paymentMethod: 'cash', restaurantMatches: true }, null, {}), { action: '200' }, 'legacy null → 200 (fail-open preserved)');
    const legacyInc = await computeIncomingFingerprint(ctxArgs, { ...deps, tables: F.tablesFor(rid) });
    assert.strictEqual(legacyInc, GOLDEN.values[rid].order_fp_plain);
    assert.deepStrictEqual(classifyExistingOrder(legacy, { paymentMethod: 'cash', restaurantMatches: true }, legacyInc, {}), { action: '200' });
    // absent fingerprint ≠ absent tag: a canonical record with no fingerprint skips case 4, as today
    assert.deepStrictEqual(classifyExistingOrder({ ...stored, payment_fingerprint: undefined }, { paymentMethod: 'cash', restaurantMatches: true }, null, { canonicalIncoming: unv }), { action: '200' });
    // a canonical record never matches a legacy computation and vice versa
    assert.notStrictEqual(canonNow.fp, GOLDEN.values[rid].order_fp_plain);
  }
  ok('createOrder (real classify path, both brands): canonical same-order → 200; canonical UNVERIFIABLE → 409 cart_unverifiable (never the fail-open); canonical different cart → 409 cart; legacy null → 200 and legacy match → 200 exactly as today; an absent fingerprint skips case 4 in every format');

  // ── 6. PAYMENT SITES: format read from the same snapshot; advisory vs CAS; typed outcomes ─────────────────
  {
    const rid = 'x_pizza', ctx = contextFor(rid), carts = F.cartsFor(rid);
    const total = 1000;
    const canon = CB.canonicalOrderFingerprint({ orderId: 'o1', totalCents: total, items: carts.plain, redemption: null, rid, context: ctx });
    assert.ok(canon.ok);
    const thunk = () => canon, badThunk = () => ({ ok: false, reason: 'cart_unverifiable' });
    const LEG = 'a'.repeat(64);
    const ORDER = { restaurant_id: rid, total_cents: total, status: 'pending_payment' };
    const tagged = (fp, fmt = 'canonical') => ({ orders: { o1: { ...ORDER, payment_fingerprint: fp, fp_format: fmt } } });
    let calls = 0; const counting = () => { calls += 1; return canon; };
    // canonical record, canonical match → proceeds (install); thunk evaluated once (memoized across advisory + CAS)
    const r1 = await hosted.acquireHostedAttempt(createFakeRtdb(tagged(canon.fp)), 'o1', ORDER, LEG, NOW, [], () => 'att1', () => 't', counting);
    assert.strictEqual(r1.outcome, 'claimed'); assert.strictEqual(calls, 1, 'the canonical recompute ran once, memoized');
    // canonical record vs legacy-only caller (no thunk) → unverifiable conflict, never a legacy comparison
    assert.deepStrictEqual(await hosted.acquireHostedAttempt(createFakeRtdb(tagged(canon.fp)), 'o1', ORDER, canon.fp, NOW, [], () => 'a', () => 't'), { outcome: 'conflict', reason: 'cart_unverifiable' });
    assert.deepStrictEqual(await hosted.acquireHostedAttempt(createFakeRtdb(tagged(canon.fp)), 'o1', ORDER, LEG, NOW, [], () => 'a', () => 't', badThunk), { outcome: 'conflict', reason: 'cart_unverifiable' });
    assert.deepStrictEqual(await hosted.acquireHostedAttempt(createFakeRtdb(tagged('c'.repeat(64))), 'o1', ORDER, LEG, NOW, [], () => 'a', () => 't', thunk), { outcome: 'conflict' }, 'canonical mismatch → today\'s conflict shape');
    assert.deepStrictEqual(await hosted.acquireHostedAttempt(createFakeRtdb(tagged(canon.fp, 'weird')), 'o1', ORDER, LEG, NOW, [], () => 'a', () => 't', thunk), { outcome: 'conflict', reason: 'binding_format_invalid' });
    assert.deepStrictEqual(await hosted.classifyHostedAttempt(createFakeRtdb(tagged(canon.fp)), 'o1', LEG, NOW, thunk), { willIssueFreshUrl: true, bindingFormat: 'canonical' }, 'classify reports the canonical binding format (A.6)');
    assert.deepStrictEqual(await hosted.classifyHostedAttempt(createFakeRtdb(tagged('c'.repeat(64))), 'o1', LEG, NOW, thunk), { willIssueFreshUrl: false, outcome: 'conflict', bindingFormat: 'canonical' });
    assert.deepStrictEqual(await direct.acquireOnlineAttempt(createFakeRtdb(tagged(canon.fp)), 'o1', ORDER, LEG, () => 'd1', thunk), { outcome: 'acquired', attempt_id: 'd1' }, 'direct path: same contract (no production caller)');
    assert.deepStrictEqual(await direct.acquireOnlineAttempt(createFakeRtdb(tagged(canon.fp, 7)), 'o1', ORDER, LEG, () => 'd1', thunk), { outcome: 'conflict', reason: 'binding_format_invalid' });
    // the legacy record path never evaluates the thunk
    let touched = 0;
    await hosted.acquireHostedAttempt(createFakeRtdb({ orders: { o1: { ...ORDER, payment_fingerprint: LEG } } }), 'o1', ORDER, LEG, NOW, [], () => 'a', () => 't', () => { touched += 1; return canon; });
    assert.strictEqual(touched, 0, 'a legacy record never evaluates the canonical thunk');
    // a legacy no-fingerprint record: no comparison, and the recovery install fills TODAY's legacy value (A.4; call-sequence golden)
    // a CANONICAL record with no fingerprint is filled in ITS format — never with a legacy fingerprint — or refused before any write
    const dbF = createFakeRtdb({ orders: { o1: { ...ORDER, fp_format: 'canonical' } } });
    assert.strictEqual((await hosted.acquireHostedAttempt(dbF, 'o1', ORDER, LEG, NOW, [], () => 'a2', () => 't', thunk)).outcome, 'claimed');
    assert.strictEqual(dbF.dump().orders.o1.payment_fingerprint, canon.fp, 'filled with the CANONICAL fingerprint');
    const dbU = createFakeRtdb({ orders: { o1: { ...ORDER, fp_format: 'canonical' } } });
    assert.deepStrictEqual(await hosted.acquireHostedAttempt(dbU, 'o1', ORDER, LEG, NOW, [], () => 'a3', () => 't', badThunk), { outcome: 'conflict', reason: 'cart_unverifiable' });
    assert.strictEqual(dbU.dump().orders.o1.payment_fingerprint, undefined, 'uncomputable → refused with NOTHING written');
    assert.ok(!dbU.calls.some((c) => c.startsWith('transaction')), '…before any transaction');
    assert.deepStrictEqual(await hosted.acquireHostedAttempt(createFakeRtdb({ orders: { o1: { ...ORDER, fp_format: 'bad' } } }), 'o1', ORDER, LEG, NOW, [], () => 'a4', () => 't', thunk), { outcome: 'conflict', reason: 'binding_format_invalid' }, 'a malformed tag refuses even without a fingerprint');
  }
  ok('payment sites: the (format, fingerprint) pair is judged on the snapshot each site holds — canonical match proceeds (the recompute memoized: once across advisory + CAS), canonical mismatch → today\'s conflict shape, uncomputable → conflict/cart_unverifiable (never a legacy comparison), malformed tag → binding_format_invalid; classify reports bindingFormat; direct path identical; a legacy record never evaluates the thunk; an absent fingerprint is not compared — a legacy one is filled with today\'s value, a canonical one only in its own format or refused before any write');

  // ── 7. RESERVATION: mixed formats conflict both ways; Q2 carry on re-reserve ─────────────────────────────
  for (const rid of F.RIDS) {
    const ctx = contextFor(rid), carts = F.cartsFor(rid);
    const red = computeRedemption({ redeem: F.redeemFor(rid), items: carts.plain, restaurantId: rid, tables: F.tablesFor(rid) });
    const legacyOrderFp = GOLDEN.values[rid].order_fp_redemption;
    const canonOrder = CB.canonicalOrderFingerprint({ orderId: F.ORDER_ID, totalCents: 1000, items: carts.plain, redemption: red, rid, context: ctx });
    const selectedCanon = CB.selectedOrderBinding('canonical', canonOrder.fp);
    assert.ok(selectedCanon.startsWith('c1:'));
    const canonBind = CB.canonicalReservationBindingFp({ redemption: red, context: ctx, selectedOrderBinding: selectedCanon, configVersion: REDEMPTION_CONFIG_VERSION });
    const args = { uid: F.UID, rid, orderId: F.ORDER_ID, cost: red.cost, canonical: red.canonical, orderFingerprint: legacyOrderFp, configVersion: REDEMPTION_CONFIG_VERSION, now: NOW };
    const wallet = (rec) => createFakeRtdb({ user_rewards: { [F.UID]: { [rid]: { balance: 100000, reserved: rec ? red.cost : 0, ...(rec ? { reservations: { [F.ORDER_ID]: rec } } : {}) } } } });
    const canonRec = { state: 'reserved', cost: red.cost, fp: canonBind.fp, fp_format: 'canonical', canonical: canonBind.reward.canonical, order_fingerprint: selectedCanon, config_version: REDEMPTION_CONFIG_VERSION, created_at: NOW, updated_at: NOW, seq: 1 };
    // canonical record + this request selecting the canonical order binding → idempotent reuse
    const r1 = await reserve.reserveRedemption(wallet(canonRec), { ...args, canonicalBinding: () => canonBind });
    assert.deepStrictEqual(r1, { ok: true, action: 'reused', state: 'reserved' });
    // canonical record + a request whose order binding is LEGACY → the canonical computation over a legacy order value ≠ → conflict
    const legacySel = CB.canonicalReservationBindingFp({ redemption: red, context: ctx, selectedOrderBinding: legacyOrderFp, configVersion: REDEMPTION_CONFIG_VERSION });
    assert.deepStrictEqual(await reserve.reserveRedemption(wallet(canonRec), { ...args, canonicalBinding: () => legacySel }), { ok: false, reason: 'reservation_conflict' }, 'mixed formats (canonical record, legacy order) → reservation_conflict');
    // legacy record + a canonical-selected request: the legacy branch compares the legacy fp → the canonical value never matches it
    const fresh = wallet(null); await reserve.reserveRedemption(fresh, args);
    const legacyRec = fresh.dump().user_rewards[F.UID][rid].reservations[F.ORDER_ID];
    assert.deepStrictEqual(await reserve.reserveRedemption(wallet(legacyRec), { ...args, orderFingerprint: selectedCanon, canonicalBinding: () => canonBind }), { ok: false, reason: 'reservation_conflict' }, 'mixed formats (legacy record, canonical order) → reservation_conflict');
    assert.deepStrictEqual(await reserve.reserveRedemption(wallet(canonRec), { ...args, canonicalBinding: () => ({ ok: false }) }), { ok: false, reason: 'cart_unverifiable' });
    assert.deepStrictEqual(await reserve.reserveRedemption(wallet({ ...canonRec, fp_format: 'x' }), { ...args, canonicalBinding: () => canonBind }), { ok: false, reason: 'binding_format_invalid' });
    // Q2: re-reserving a RELEASED canonical record CARRIES the tag and writes the canonical fp
    const rel = wallet({ ...canonRec, state: 'released' });
    const rr = await reserve.reserveRedemption(rel, { ...args, now: NOW + 9, canonicalBinding: () => canonBind });
    assert.deepStrictEqual(rr, { ok: true, action: 're_reserved', state: 'reserved' });
    const after = rel.dump().user_rewards[F.UID][rid].reservations[F.ORDER_ID];
    assert.strictEqual(after.fp_format, 'canonical', '🔴 Q2: the tag is carried'); assert.strictEqual(after.fp, canonBind.fp, '…with the canonical fp');
    assert.strictEqual(after.order_fingerprint, selectedCanon, '…and its selected canonical order binding');
    assert.strictEqual(after.seq, 2);
  }
  ok('reservation (both brands): canonical record + canonical-selected order → reused; mixed formats in BOTH directions → reservation_conflict; uncomputable → cart_unverifiable; malformed tag → binding_format_invalid; Q2: re-reserving a released canonical record carries fp_format and the canonical fp/binding');

  // ── 8. CALL-SEQUENCE GOLDEN: every legacy payment/reservation path reads, transacts and writes exactly as 717f97e ──
  const cur = Object.fromEntries(await callseqScenarios({ hosted, direct, reserve, REDEMPTION_CONFIG_VERSION }));
  assert.strictEqual(Object.keys(CALLSEQ.scenarios).length, 13);
  for (const [k, want] of Object.entries(CALLSEQ.scenarios)) assert.deepStrictEqual(JSON.parse(JSON.stringify(cur[k])), want, `🔴 ${k}: the legacy read/transaction sequence, result or stored data changed`);
  assert.ok(CALLSEQ.scenarios['reserve.released_re_reserve'].data.user_rewards.u1.x_pizza.reservations.o1.fp_format === undefined, 'premise — a legacy re-reserve writes no tag');
  ok('call-sequence golden: 13 legacy scenarios (hosted acquire/classify, direct acquire, reserve fresh/reused/re-reserve/conflict) perform the SAME ordered reads, transactions and writes, return the same results and leave the same data as the 717f97e modules');

  // ── 9. REWARD DISPLAY (Q5): a canonical id never reaches a human ───────────────────────────────────────
  {
    const ctx = contextFor('x_pizza');
    const marg = ctx.objects.find((o) => o.kind === 'dish' && o.legacyKey === 'Margherita');
    assert.strictEqual(CB.displayLabel(CB.ck('dish', marg.canonicalId), ctx), marg.label);
    assert.strictEqual(CB.displayLabel(CB.ck('dish', 'NOPE'), ctx), null, 'unknown identity → null');
    assert.strictEqual(CB.displayLabel(CB.ck('dish', marg.canonicalId), { ...ctx, usableAsIdentity: false }), null, 'unusable context → null');
    assert.strictEqual(CB.displayLabel('Margherita', ctx), null, 'a non-ck value in the canonical branch renders null, never raw');
    const rows = CB.canonicalRewardRows([{ item_id: CB.ck('dish', marg.canonicalId), qty: 2 }, { item_id: CB.ck('dish', 'NOPE'), qty: 1 }], null, ctx);
    assert.deepStrictEqual(rows, [{ name: marg.label, qty: 2 }]);
    for (const r of rows) { assert.ok(!r.name.includes('["c1"')); assert.ok(!r.name.startsWith('CID-')); }
  }
  ok('reward display: the canonical branch renders the context label; an unknown identity, an unusable context or a non-ck value renders null — no ck string or canonical id ever appears');

  console.log(`d4b-bindings: OK (${n})`);
})().catch((e) => { console.error('d4b-bindings FAILED:', e); process.exit(1); });
