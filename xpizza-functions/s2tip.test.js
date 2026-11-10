'use strict';
// S2-srv-tip — the tip's money core and P-C, through the REAL modules (PLAN-capp-S2-r4 §3.1/§3.2/§3.5/§3.6/§4.1).
// Real carts (parity-carts.fixture) on the real catalog tables; envío contexts from the real quoteDelivery/deliveryFor; tokens
// from the real issuer and gate; acquisition against the in-memory RTDB model of pixelpay-hosted-charge.test.js.
// Run: node s2tip.test.js
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 's2tip-test-secret-0123456789abcdef';
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const TIP = require('./tip');
const PE = require('./payer-email');
const P = require('./delivery/delivery-pricing');
const DW = require('./delivery/delivery-wire');
const { computeServerNet } = require('./compute-server-net');
const { issueQuote } = require('./quote-issue');
const { verifyQuoteToken } = require('./quote-token');
const { gateConfirmedNet } = require('./token-gate');
const { chargeInputsFingerprint } = require('./catalog/charge-inputs');
const { classifyExistingOrder, computeIncomingFingerprint, computeCanonicalIncomingFingerprint } = require('./createorder-classify');
const { acquireHostedAttempt, classifyHostedAttempt } = require('./pixelpay-hosted-charge');
const { probeBoundReuse } = require('./catalog/bound-reuse');
const { orderFingerprint } = require('./pixelpay-charge');
const OE = require('./order-exists');
const { orderBreakdownCents } = require('./order-money');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');
const { CARTS } = require('./parity-carts.fixture');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const T = (rid) => ({ restaurantId: rid, menu: { ...MENU_BY_RESTAURANT[rid] }, extras: { ...EXTRAS_BY_RESTAURANT[rid] } });
const RID = 'x_pizza';
const ITEMS = CARTS[RID][0];
const TABLES = T(RID);
const SECRET = process.env.QUOTE_TOKEN_SECRET;
const NOW = 1_800_000_000_000;
const HUB = { lat: 14.1, lng: -87.2 };
const PIN = { lat: HUB.lat + 4 / 111.195, lng: HUB.lng, confirmed: true };   // 4 km
const pricing = (cents, extra = {}) => P.readPricing({ policy_version: 1, bands: [{ max_km: 2, cents: 3000 }, { max_km: 6, cents }], restaurants: { [RID]: { active: true, ...extra } } }, RID);
const ctxOf = (pr, mode = 'delivery', pin = PIN) => P.quoteDelivery({ pricing: pr, hub: HUB, mode, pin, customerUid: null }).ctx;

// the base version of a module (its relative requires re-pointed at the live tree)
const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's2tip-core-'));
function loadBase(rel) {
  const src = execFileSync('git', ['show', `276ed944:xpizza-functions/${rel}`], { cwd: __dirname, encoding: 'utf8' });
  const dir = path.dirname(path.join(__dirname, rel));
  const fixed = src.replace(/require\((['"])([^'"]+)\1\)/g, (m, q, spec) => `require(${JSON.stringify(spec.startsWith('.') ? path.join(dir, spec) : require.resolve(spec, { paths: [dir] }))})`);
  const f = path.join(TMP, rel.replace(/[/]/g, '__'));
  fs.writeFileSync(f, fixed);
  return require(f);
}

// the in-memory RTDB (pixelpay-hosted-charge.test.js), with an optional hook that mutates the record between the pre-read and
// the transaction's real read (the CAS race)
function makeDb(initial = {}, { beforeTx = null } = {}) {
  const root = JSON.parse(JSON.stringify(initial));
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const getAt = (p) => { if (!p) return root; let x = root; for (const k of p.split('/')) { if (x == null) return null; x = x[k]; } return x === undefined ? null : x; };
  const setAt = (p, val) => { const a = p.split('/'); let x = root; for (let i = 0; i < a.length - 1; i++) { if (x[a[i]] == null || typeof x[a[i]] !== 'object') x[a[i]] = {}; x = x[a[i]]; } const l = a[a.length - 1]; if (val === null) delete x[l]; else x[l] = val; };
  let writes = 0;
  const ref = (p = '') => ({
    async once() { return { val: () => clone(getAt(p)) }; },
    async get() { return { val: () => clone(getAt(p)), exists: () => getAt(p) != null }; },
    async transaction(fn) {
      if (beforeTx) { beforeTx(setAt, getAt); beforeTx = null; }
      fn(null);
      const cur = clone(getAt(p));
      const nx = fn(cur);
      if (nx === undefined) return { committed: false, snapshot: { val: () => cur } };
      if (JSON.stringify(nx) !== JSON.stringify(cur)) writes++;
      setAt(p, clone(nx));
      return { committed: true, snapshot: { val: () => clone(getAt(p)) } };
    },
    async update(patch) { writes++; if (!p) { for (const [k, v] of Object.entries(patch)) setAt(k, clone(v)); return; } setAt(p, Object.assign({}, getAt(p) || {}, clone(patch))); },
  });
  return { ref, getAt, writes: () => writes };
}
const seq = (...ids) => { let i = 0; return () => ids[i++]; };

(async () => {
  // ── 1. tip.js: normalization, the early refusal, the fingerprint component, the direct compare ──
  {
    assert.deepStrictEqual([TIP.normTip(undefined), TIP.normTip(0), TIP.normTip(1), TIP.normTip(200000)], [0, 0, 1, 200000]);
    for (const bad of [200001, -1, 1.5, '0', '100', null, true, NaN, Infinity, {}]) assert.ok(Number.isNaN(TIP.normTip(bad)), `${JSON.stringify(bad)} → NaN`);
    assert.strictEqual(TIP.TIP_MAX_CENTS, 200000, 'TIP_MAX = L 2,000 (Q7, owner 2026-10-25)');
    assert.deepStrictEqual([TIP.orderRefusal({}), TIP.orderRefusal({ tip_cents: 0 }), TIP.orderRefusal({ tip_cents: 500, payment_method: 'online' }), TIP.orderRefusal({ tip_cents: 0, redeem: { x: 1 } })], [null, null, null, null]);
    assert.deepStrictEqual(TIP.orderRefusal({ tip_cents: '500' }), { status: 400, error: 'tip_invalid' });
    assert.deepStrictEqual(TIP.orderRefusal({ tip_cents: 200001 }), { status: 400, error: 'tip_invalid' });
    assert.deepStrictEqual(TIP.orderRefusal({ tip_cents: 500, redeem: { x: 1 } }), { status: 409, error: 'tip_reward_unsupported' }, 'tip + reward → 409 tip_reward_unsupported');
    assert.deepStrictEqual([TIP.tipExtra(0), TIP.tipExtra(500), TIP.extraOf({}), TIP.extraOf({ tip_cents: 0 }), TIP.extraOf({ tip_cents: 700 })], ['', 'tp:500', '', '', 'tp:700']);
    assert.deepStrictEqual([TIP.tipBindingConflict({}, 0), TIP.tipBindingConflict({ tip_cents: 500 }, 500), TIP.tipBindingConflict(null, 500)], [null, null, null]);
    assert.deepStrictEqual([TIP.tipBindingConflict({}, 500), TIP.tipBindingConflict({ tip_cents: 500 }, 0), TIP.tipBindingConflict({ tip_cents: 500 }, 600)], [{ reason: 'tip' }, { reason: 'tip' }, { reason: 'tip' }]);
    ok('tip.js: absent / undefined / 0 = no tip; 1..200000 accepted; anything else 400 tip_invalid; tip + reward 409; tipExtra "" without a tip; the direct compare refuses any change, never no-tip vs no-tip');
  }

  // ── 1b. PLAN-capp-tip-step r6 D0 (Codex r6 P1): a POSITIVE tip needs a known payment method. Intake sanitizes an omitted / empty /
  //        unknown payment_method to '' (index.js validateOrderPayload); a tip on such an order would be neither kept by the
  //        driver's cuadre nor accrued by the ledger. Refused BEFORE anything is read or written; a no-tip order is unchanged. ──
  {
    for (const pm of [undefined, '', 'bitcoin', '  ', null, 7]) {
      const body = pm === undefined ? { tip_cents: 2000 } : { tip_cents: 2000, payment_method: pm };
      assert.deepStrictEqual(TIP.orderRefusal(body), { status: 400, error: 'tip_payment_method_invalid' }, `🔴 D0: tip 2000 with method ${JSON.stringify(pm)} ⇒ 400 tip_payment_method_invalid`);
      const noTip = pm === undefined ? {} : { payment_method: pm };
      assert.strictEqual(TIP.orderRefusal(noTip), null, `D0: no tip with method ${JSON.stringify(pm)} ⇒ unchanged (proceeds)`);
      assert.strictEqual(TIP.orderRefusal({ ...noTip, tip_cents: 0 }), null, `D0: tip 0 with method ${JSON.stringify(pm)} ⇒ unchanged`);
    }
    for (const pm of ['online', 'card_delivery', ' online ', 'card_delivery\u0000', '<online>']) {
      assert.strictEqual(TIP.orderRefusal({ tip_cents: 2000, payment_method: pm }), null, `🔴 D0: tip with method ${JSON.stringify(pm)} — the SAME normalization intake applies (sanitizeText + the allowlist) ⇒ accepted`);
    }
    // OWNER 11-09 (r7): the in-app tip is CARD-ONLY — cash + a positive tip ⇒ 400 tip_cash_unsupported (a cash customer tips in hand)
    for (const pm of ['cash', ' cash ', 'cash\u0000', '<cash>']) {
      assert.deepStrictEqual(TIP.orderRefusal({ tip_cents: 2000, payment_method: pm }), { status: 400, error: 'tip_cash_unsupported' }, `🔴 D0-cash: tip with method ${JSON.stringify(pm)} ⇒ 400 tip_cash_unsupported`);
      assert.strictEqual(TIP.orderRefusal({ payment_method: pm }), null, `D0-cash: cash WITHOUT a tip is unchanged (${JSON.stringify(pm)})`);
      assert.strictEqual(TIP.orderRefusal({ tip_cents: 0, payment_method: pm }), null, 'D0-cash: cash with tip 0 is unchanged');
    }
    assert.deepStrictEqual(TIP.orderRefusal({ tip_cents: 2000, redeem: { x: 1 } }), { status: 409, error: 'tip_reward_unsupported' }, 'D0: the reward refusal still answers first');
    // parity: the allowlist and the normalization are intake's own (index.js), read from source — never a drifting copy
    const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    const al = src.match(/const ALLOWED_PAYMENT_METHODS = (\[[^\]]*\]);/);
    assert.ok(al, 'premise: index.js ALLOWED_PAYMENT_METHODS');
    assert.deepStrictEqual(TIP.PAYMENT_METHODS, JSON.parse(al[1].replace(/'/g, '"')), '🔴 D0: tip.js PAYMENT_METHODS === index.js ALLOWED_PAYMENT_METHODS');
    const san = src.match(/function sanitizeText\(v, maxLen = 500\) \{([\s\S]*?)\n\}/);
    assert.ok(san && san[1].includes(".replace(/[<>]/g, '').replace(/[\\x00-\\x1f\\x7f]/g, ' ').trim()"), '🔴 D0 parity: intake\'s sanitizeText still strips <>, maps control chars to spaces and trims (tip.js mirrors it)');
    ok('D0: a positive tip needs a CARD method — omitted / empty / unknown ⇒ 400 tip_payment_method_invalid, cash ⇒ 400 tip_cash_unsupported (owner 11-09), before any write; no tip ⇒ unchanged; online / card_delivery (intake\'s normalization) accepted; parity with index.js');
  }

  // ── 2. the net includes the tip EXACTLY ONCE; no tip → byte-identical net + components ──
  const pr = pricing(5000);
  const ctx0 = ctxOf(pr);
  const ctxT = P.withTip(ctx0, 2000);
  {
    const base = loadBase('compute-server-net.js');
    const n0 = computeServerNet({ items: ITEMS, deliveryContext: ctx0, rid: RID, tables: TABLES });
    const nT = computeServerNet({ items: ITEMS, deliveryContext: ctxT, rid: RID, tables: TABLES });
    assert.deepStrictEqual(n0, base.computeServerNet({ items: ITEMS, deliveryContext: ctx0, rid: RID, tables: TABLES }), '🔴 a no-tip net (components included) is byte-identical to 276ed944');
    assert.deepStrictEqual(computeServerNet({ items: ITEMS, rid: RID, tables: TABLES }), base.computeServerNet({ items: ITEMS, rid: RID, tables: TABLES }), '🔴 a dark net is byte-identical');
    assert.strictEqual(nT.net_total_cents, n0.net_total_cents + 2000, 'the tip joins the net once');
    assert.deepStrictEqual(nT.components, { ...n0.components, tip_cents: 2000 }, 'components gain tip_cents only with a tip');
    assert.ok(!('tip_cents' in n0.components), 'no tip → no tip_cents component');
    const forged = { ...ctx0, tip_cents: 9999 };   // a request-shaped object is never money
    assert.strictEqual(computeServerNet({ items: ITEMS, deliveryContext: forged, rid: RID, tables: TABLES }).net_total_cents, n0.net_total_cents - 5000, 'a non-server ctx contributes neither envío nor tip');
    assert.strictEqual(ctx0.tip_cents, undefined, 'withTip never mutates the original ctx');
    ok('computeServerNet: net = food + envío + tip (once), components.tip_cents only when > 0; a no-tip and a dark net are byte-identical to the base; a forged ctx is ignored');
  }

  // ── 3. the token signs the tip (> 0 only); the gate binds it ──
  {
    const qT = issueQuote({ items: ITEMS, rid: RID, tables: TABLES, deliveryContext: ctxT, nowMs: NOW });
    const q0 = issueQuote({ items: ITEMS, rid: RID, tables: TABLES, deliveryContext: ctx0, nowMs: NOW });
    const pT = verifyQuoteToken(qT.quote_token, SECRET, NOW + 1).payload;
    const p0 = verifyQuoteToken(q0.quote_token, SECRET, NOW + 1).payload;
    assert.strictEqual(pT.delivery.tip_cents, 2000, 'the signed payload carries the tip');
    assert.ok(!JSON.stringify(p0).includes('tip_cents'), 'a no-tip payload has no tip field anywhere (byte-identical shape)');
    const baseIssue = loadBase('quote-issue.js');
    const b0 = verifyQuoteToken(baseIssue.issueQuote({ items: ITEMS, rid: RID, tables: TABLES, deliveryContext: ctx0, nowMs: NOW }).quote_token, SECRET, NOW + 1).payload;
    const norm = (p) => ({ ...p, quote_id: 'X' });
    assert.deepStrictEqual(norm(p0), norm(b0), '🔴 a no-tip payload equals the 276ed944 issuer\'s (bar the nonce)');
    const gate = (token, ctx) => gateConfirmedNet({ token, submittedCart: ITEMS, deliveryContext: ctx, rid: RID, tables: TABLES, secret: SECRET, nowMs: NOW + 1 });
    assert.deepStrictEqual([gate(qT.quote_token, ctxT).action, gate(qT.quote_token, ctxT).chargeNet], ['charge', qT.net_total_cents]);
    assert.deepStrictEqual([gate(q0.quote_token, ctx0).action, gate(b0 && baseIssue.issueQuote({ items: ITEMS, rid: RID, tables: TABLES, deliveryContext: ctx0, nowMs: NOW }).quote_token, ctx0).action], ['charge', 'charge'], 'a no-tip token — including one issued by the pre-S2 issuer — verifies against a no-tip charge');
    assert.strictEqual(gate(qT.quote_token, ctx0).reason, 'tip_mismatch', 'a tipped token never authorises an untipped charge');
    assert.strictEqual(gate(q0.quote_token, ctxT).reason, 'tip_mismatch', 'an untipped token never authorises a tipped charge (even though the net only rises)');
    // the SAME total, the split swapped: envío L50 + no tip (token) vs envío L30 + tip L20 (charge), same place
    const qA = issueQuote({ items: ITEMS, rid: RID, tables: TABLES, deliveryContext: ctxOf(pricing(5000)), nowMs: NOW });
    const ctxB = P.withTip(ctxOf(pricing(3000)), 2000);
    assert.strictEqual(computeServerNet({ items: ITEMS, deliveryContext: ctxB, rid: RID, tables: TABLES }).net_total_cents, qA.net_total_cents, 'premise: equal charged totals');
    assert.strictEqual(gate(qA.quote_token, ctxB).reason, 'tip_mismatch', 'a swapped tip/envío split with an equal total is refused by the signed binding');
    // the unsigned floor charges the recompute (tip included) up to the ceiling
    const fl = gateConfirmedNet({ expectedNetCents: qT.net_total_cents, submittedCart: ITEMS, deliveryContext: ctxT, rid: RID, tables: TABLES, secret: SECRET, nowMs: NOW });
    assert.deepStrictEqual([fl.action, fl.chargeNet], ['charge', qT.net_total_cents]);
    assert.strictEqual(gateConfirmedNet({ expectedNetCents: q0.net_total_cents, submittedCart: ITEMS, deliveryContext: ctxT, rid: RID, tables: TABLES, secret: SECRET, nowMs: NOW }).action, 'refuse_increase', 'a ceiling shown without the tip refuses the tipped charge');
    ok('token: the tip is signed only when > 0 (no-tip payload = the base issuer\'s); the gate binds it both ways — incl. a swapped tip/envío split with an equal total; pre-S2 tokens still verify; the unsigned floor counts it');
  }

  // ── 4. the order breakdown / totals / record fields / quote fields ──
  {
    const bd = orderBreakdownCents(340, RID);
    const DWb = loadBase('delivery/delivery-wire.js');
    assert.deepStrictEqual(DW.withDelivery({ ctx: ctx0 }, bd), DWb.withDelivery({ ctx: ctx0 }, bd), '🔴 a no-tip breakdown is byte-identical');
    const t = DW.withDelivery({ ctx: ctxT }, bd);
    assert.deepStrictEqual([t.total_cents, t.tip_cents, t.subtotal_cents, t.tax_cents], [bd.total_cents + 5000 + 2000, 2000, bd.subtotal_cents, bd.tax_cents], 'total + envío + tip; subtotal / tax stay the FOOD split');
    assert.strictEqual(DW.totalLempiras({ ctx: ctxT }, 340), 410, 'totalLempiras includes the tip (L410)');
    assert.strictEqual(DW.totalLempiras({ ctx: ctx0 }, 340), DWb.totalLempiras({ ctx: ctx0 }, 340));
    assert.deepStrictEqual(DW.orderFields(t).tip_cents, 2000);
    assert.deepStrictEqual(DW.orderFields(DW.withDelivery({ ctx: ctx0 }, bd)), DWb.orderFields(DWb.withDelivery({ ctx: ctx0 }, bd)), '🔴 no-tip pending-order fields byte-identical');
    assert.strictEqual(computeServerNet({ items: [{ name: 'x' }], deliveryContext: ctxT, rid: RID, tables: TABLES }).error !== undefined, true, 'an unpriceable cart still errors with a tip');
    // grandfathered (stored) economics keep the tip the checkout was issued with
    const stored = P.storedCtx({ delivery_snapshot: { mode: 'delivery', policy_version: 1, km: 4, band: 1 }, delivery_cents: 5000, promo_discount_cents: 0, tip_cents: 2000 });
    assert.strictEqual(computeServerNet({ items: ITEMS, deliveryContext: stored, rid: RID, tables: TABLES }).net_total_cents, computeServerNet({ items: ITEMS, deliveryContext: ctxT, rid: RID, tables: TABLES }).net_total_cents, 'a live checkout is re-priced at its STORED economics, tip included');
    ok('breakdown: total_cents + tip once, tip_cents on the record (cash spread + hosted orderFields), FOOD subtotal/tax; totalLempiras L410; stored economics keep the tip; every no-tip shape byte-identical');
  }

  // ── 5. deliveryFor / quoteDeliveryFor: the refusals, the app coverage, the public facts ──
  {
    const getIdentity = async () => ({ hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 3.5 });
    const df = (args) => DW.deliveryFor(null, { rid: RID, mode: 'delivery', pin: PIN, customerUid: null, getIdentity, pricingP: Promise.resolve({ pricing: pr }), ...args });
    assert.deepStrictEqual(await DW.deliveryFor(null, { rid: RID, mode: 'delivery', pin: PIN, getIdentity, pricingP: Promise.resolve({ pricing: null }), tip: 500 }), { refusal: 'tip_not_enabled', httpStatus: 409 }, 'dark + tip → 409 tip_not_enabled');
    assert.strictEqual(await DW.deliveryFor(null, { rid: RID, mode: 'delivery', pin: PIN, getIdentity, pricingP: Promise.resolve({ pricing: null }), tip: 0 }), null, 'dark + no tip → null (dark, unchanged)');
    assert.deepStrictEqual(await df({ mode: 'pickup', tip: 500 }), { refusal: 'tip_pickup', httpStatus: 400 }, 'order pickup + tip → 400 tip_pickup');
    assert.deepStrictEqual(await df({ tip: '5' }), { refusal: 'tip_invalid', httpStatus: 400 });
    assert.strictEqual(P.tipCentsOf((await df({ tip: 500 })).ctx), 500);
    assert.strictEqual((await df({ tip: 0 })).ctx.tip_cents, undefined);
    const req = { get: () => null };
    const q = (body, identity = getIdentity) => DW.quoteDeliveryFor(req, null, RID, body, { getIdentity: identity, pricingP: Promise.resolve({ pricing: pr }) });
    const dq = (body) => DW.quoteDeliveryFor(req, null, RID, body, { getIdentity, pricingP: Promise.resolve({ pricing: null }) });
    const body = (x = {}) => ({ mode: 'delivery', pin: PIN, ...x });
    assert.deepStrictEqual(await q(body({ tip_cents: 1.5 })), { refuse: { ok: false, error: 'tip_invalid' }, httpStatus: 400 });
    assert.deepStrictEqual(await q(body({ tip_cents: 500, redeem: {} })), { refuse: { ok: false, error: 'tip_reward_unsupported' }, httpStatus: 409 }, 'quote tip + reward → 409');
    assert.deepStrictEqual(await dq(body({ tip_cents: 500 })), { refuse: { ok: false, error: 'tip_not_enabled' }, httpStatus: 409 }, 'quote dark + tip → 409 tip_not_enabled');
    assert.deepStrictEqual(await q({ mode: 'pickup', tip_cents: 500 }), { refuse: { ok: false, error: 'tip_pickup' }, httpStatus: 400 }, 'quote pickup + tip → 400 tip_pickup');
    // app coverage: the pin is 4 km; bands reach 6 km; the restaurant's radius is 3.5 km
    const appOut = await q(body({ entry_mode: 'app' }));
    assert.strictEqual(appOut.refuse && appOut.refuse.error, 'outside_delivery_bands', 'APP: a pin between the radius and the last band is refused');
    const legacy = await q(body({}));
    assert.ok(legacy.ctx && legacy.ctx.delivery_cents === 5000, 'legacy (no entry_mode): unchanged — priced at the band');
    assert.deepStrictEqual(DW.quoteFields(legacy.ctx).delivery, { delivery_cents: 5000, promo_discount_cents: 0, policy_version: 1, mode: 'delivery', from_cents: 3000, max_km: 6 }, 'public facts: from_cents = the lowest band, max_km = the last band');
    const near = { lat: HUB.lat + 1 / 111.195, lng: HUB.lng, confirmed: true };
    const app = await q({ mode: 'delivery', pin: near, entry_mode: 'app' });
    assert.strictEqual(DW.quoteFields(app.ctx).delivery.max_km, 3.5, 'APP: max_km reports min(last band, radius)');
    const noRadius = await q({ mode: 'delivery', pin: near, entry_mode: 'app' }, async () => ({ hub_lat: HUB.lat, hub_lng: HUB.lng }));
    assert.strictEqual(DW.quoteFields(noRadius.ctx).delivery.max_km, 6, 'APP with no radius on the identity → the bands');
    const tq = await q(body({ tip_cents: 2000 }));
    assert.strictEqual(issueQuote({ items: ITEMS, rid: RID, tables: TABLES, deliveryContext: tq.ctx, nowMs: NOW }).net_total_cents, computeServerNet({ items: ITEMS, deliveryContext: ctxT, rid: RID, tables: TABLES }).net_total_cents, 'a tipped quote\'s net = food + envío + tip');
    assert.deepStrictEqual(DW.quoteFields(null), {}, 'dark quote: no delivery block');
    // codex r1 P2: an ACTIVE but INVALID config ({invalid:true}, no bands) refuses exactly as before S2 — byte-equal to the base,
    // for an absent and a zero tip, legacy and app (coverage is never read for it)
    const DWb = loadBase('delivery/delivery-wire.js');
    const bad = P.readPricing({ policy_version: 1, bands: [{ max_km: 'x', cents: 1 }], restaurants: { [RID]: { active: true } } }, RID);
    assert.deepStrictEqual(bad, { invalid: true }, 'premise: readPricing yields {invalid:true}');
    for (const extra of [{}, { tip_cents: 0 }, { entry_mode: 'app' }, { tip_cents: 0, entry_mode: 'app' }]) {
      const args = [req, null, RID, body(extra), { getIdentity, pricingP: Promise.resolve({ pricing: bad }) }];
      const now = await DW.quoteDeliveryFor(...args);
      assert.deepStrictEqual(now, await DWb.quoteDeliveryFor(...args), `invalid active pricing ${JSON.stringify(extra)}: byte-equal to the base refusal`);
      assert.deepStrictEqual(now, { refuse: { ok: false, error: 'delivery_pricing_invalid' }, httpStatus: 200 }, `invalid active pricing ${JSON.stringify(extra)} → 200 delivery_pricing_invalid`);
    }
    ok('deliveryFor / quoteDeliveryFor: tip_invalid 400, tip_reward_unsupported 409, tip_not_enabled 409 (dark), tip_pickup 400; the APP quote refuses beyond min(bands, radius) and reports it; legacy unchanged; public { from_cents, max_km }');
  }

  // ── 6. charge-inputs: absent ≡ undefined ≡ 0, each = the pre-S2 fingerprint ──
  {
    const base = loadBase('catalog/charge-inputs.js');
    const b = { order_id: 'O1', restaurant_id: RID, items: ITEMS, total: 340, payment_method: 'online', redeem: { reward_id: 'r1' } };
    const fp = chargeInputsFingerprint;
    const golden = base.chargeInputsFingerprint(b);
    assert.ok(golden, 'premise: the base fingerprints the body');
    assert.deepStrictEqual([fp(b), fp({ ...b, tip_cents: undefined }), fp({ ...b, tip_cents: 0 })], [golden, golden, golden], 'absent / undefined / 0 hash identically = the pre-S2 golden');
    assert.notStrictEqual(fp({ ...b, tip_cents: 1 }), golden, 'a tip changes the fingerprint');
    assert.strictEqual(base.chargeInputsFingerprint({ ...b, tip_cents: 0 }), null, 'premise: at the base an unclassified tip_cents field had NO fingerprint (bound reuse was skipped)');
    // PLAN-capp-tip-step r7 §1: the capp's tip_choice marker (a card redemption sends it with «Sin propina») is NON-charge — it never
    // nulls the fingerprint (which would drop charge_inputs_fp and bound reuse) and never changes it
    assert.deepStrictEqual([fp({ ...b, tip_choice: true }), fp({ ...b, tip_choice: true, tip_cents: 0 })], [golden, golden], '🔴 TIPCHOICE-FP: tip_choice is non-charge — the fingerprint is defined and unchanged');
    // a LIVE reward checkout bound at issuance without a tip, retried with tip_cents: 0, reuses through the real probe — the
    // prepare step is never reached (its failure would otherwise strand the retry)
    const bound = fp(b);
    const db = makeDb({
      orders: { O1: { restaurant_id: RID, customer_uid: 'u1', charge_inputs_fp: bound, redemption: { k: 1 }, payment_fingerprint: 'PF', active_attempt_id: 'A1' } },
      payment_attempts: { A1: { hosted_state: 'created', hosted_expires_at: NOW + 60000, hosted_checkout_url: 'https://pay/x', poll_token: 'T1' } },
      user_rewards: { u1: { [RID]: { reservations: { O1: { state: 'reserved', order_fingerprint: 'PF', canonical: { k: 1 }, attempt_id: 'A1' } } } } },
    });
    for (const tb of [b, { ...b, tip_cents: 0 }, { ...b, tip_cents: undefined }]) {
      const r = await probeBoundReuse(db, { orderId: 'O1', uid: 'u1', rid: RID, body: tb, now: NOW });
      assert.deepStrictEqual(r && [r.outcome, r.checkout_url], ['reuse', 'https://pay/x'], `bound reuse holds for ${JSON.stringify(tb.tip_cents)}`);
    }
    assert.strictEqual(await probeBoundReuse(db, { orderId: 'O1', uid: 'u1', rid: RID, body: { ...b, tip_cents: 1 }, now: NOW }), null, 'a changed tip never takes the bound-reuse path');
    ok('charge-inputs: tip_cents absent ≡ undefined ≡ 0 (= the pre-S2 golden), 1 differs; a live reward checkout retried with tip_cents:0 still reuses through the real probe (no fall-through into a failing prepare)');
  }

  // ── 7. the cash classifier + incoming fingerprints ──
  {
    const closed = (ps) => ps === 'confirmed';
    const live = { restaurant_id: RID, payment_method: 'cash', status: 'new', payment_fingerprint: 'FP' };
    const cls = (ex, tip, fp = 'FP') => classifyExistingOrder(ex, { paymentMethod: 'cash', restaurantMatches: true, incomingTip: tip }, fp, { isPaymentStatusClosed: closed });
    assert.deepStrictEqual(cls(live, 0), { action: '200' });
    assert.deepStrictEqual(cls({ ...live, tip_cents: 500 }, 500), { action: '200' }, 'same order + same tip → idempotent 200');
    assert.deepStrictEqual(cls(live, 500), { action: '409', reason: 'tip' }, 'a changed tip on a live cash order → 409 tip');
    assert.deepStrictEqual(cls({ ...live, tip_cents: 500 }, 500, null), { action: '200' }, 'a null recompute + the same tip → 200 (fail-open kept)');
    assert.deepStrictEqual(cls({ ...live, tip_cents: 500 }, 700, null), { action: '409', reason: 'tip' }, 'a null recompute (prepareRedemption failure) + a CHANGED tip → 409 tip, not 200');
    assert.deepStrictEqual(cls({ ...live, tip_cents: 500 }, 700, 'OTHER'), { action: '409', reason: 'tip' }, 'a changed tip answers tip before the fingerprint (precedence)');
    assert.deepStrictEqual(cls(live, 0, 'OTHER'), { action: '409', reason: 'cart' }, 'a fingerprint-only conflict (same tip) answers cart, as today');
    assert.deepStrictEqual(cls({ ...live, status: 'delivered', tip_cents: 500 }, 700), { action: '409', reason: 'closed' }, '`closed` precedes the tip — the terminal-safe self-heal is unchanged');
    assert.deepStrictEqual(OE.decideCashExistingRefusal('tip', live), { legacy: false, reason: 'tip' });
    assert.deepStrictEqual(OE.orderExistsBody('tip', 'O1').reason, 'tip', 'the closed enum serializes tip (not conflict)');
    const deps = { orderBreakdownCents, prepareRedemption: async () => ({ ok: false }), orderFingerprint, schedFingerprintExtra: () => 'S', db: null, tables: TABLES };
    const ctxA = { orderId: 'O1', restaurantId: RID, total: 340, itemsText: '1x Carnivora', items: ITEMS, redeem: null, customerUid: null, scheduledForRaw: null, orderType: 'delivery' };
    const golden = orderFingerprint('O1', orderBreakdownCents(340, RID).total_cents, '1x Carnivora', '');
    assert.deepStrictEqual([await computeIncomingFingerprint(ctxA, deps), await computeIncomingFingerprint({ ...ctxA, tipCents: 0 }, deps)], [golden, golden], 'absent / 0 tip → the frozen pre-S2 fingerprint');
    assert.strictEqual(await computeIncomingFingerprint({ ...ctxA, tipCents: 500 }, deps), orderFingerprint('O1', orderBreakdownCents(340, RID).total_cents, '1x Carnivora', 'tp:500'), 'tp:<n> joins the cash incoming fingerprint');
    const baseC = loadBase('createorder-classify.js');
    const sched = { ...ctxA, scheduledForRaw: 123 };
    assert.strictEqual(await computeIncomingFingerprint(sched, deps), await baseC.computeIncomingFingerprint(sched, deps), '🔴 a scheduled no-tip fingerprint equals the base');
    // the canonical branch, on a USABLE D4-a context (catalog/d4b-bindings.test.js contextFor) and its fixture cart
    const F = require('./test/d4b-legacy-fixtures');
    const { catalogSnapshot } = require('./catalog/generate-form-bundle');
    const snap = catalogSnapshot(RID);
    const context = { usableAsIdentity: true, objects: [
      ...snap.items.map((i, k) => ({ kind: 'dish', legacyKey: i.key, canonicalId: `CID-${RID}-D${String(k).padStart(3, '0')}`, label: i.display.name })),
      ...snap.extras.map((e, k) => ({ kind: 'extra', legacyKey: e.key, canonicalId: `CID-${RID}-E${String(k).padStart(3, '0')}`, label: e.display.name }))] };
    const cdeps = { ...deps, tables: F.tablesFor(RID), context };
    const ctxC = { ...ctxA, items: F.cartsFor(RID).plain };
    const cNow = await computeCanonicalIncomingFingerprint(ctxC, cdeps), cBase = await baseC.computeCanonicalIncomingFingerprint(ctxC, cdeps);
    assert.ok(cNow.ok, `premise: the canonical fingerprint is computable on a usable context (${JSON.stringify(cNow)})`);
    assert.deepStrictEqual(cNow, cBase, '🔴 the canonical no-tip fingerprint equals the base');
    const cTip = await computeCanonicalIncomingFingerprint({ ...ctxC, tipCents: 500 }, cdeps);
    assert.ok(cNow.ok && cTip.ok && cTip.fp !== cNow.fp, 'tp:<n> joins the canonical incoming fingerprint');
    ok('cash classifier: a changed tip → 409 tip even when the recompute is null; tip precedes the fingerprint, closed precedes the tip; tip serialized as itself; incoming fingerprints byte-identical without a tip, tp:<n> with one');
  }

  // ── 8. card acquisition: the tip compare at the pre-read, inside the CAS, post-commit, and in the classifier ──
  {
    const PEND = { order_id: 'O1', status: 'pending_payment', payment_status: 'pending', payment_method: 'online', total: 410, total_cents: 41000 };
    const acq = (db, rec, fp, tip, extra = {}) => acquireHostedAttempt(db, 'O1', rec, fp, NOW, [], seq('AT9'), () => 'TOK9', null, false, false, false, false, null, null, tip, extra.payer || false);
    // a stored pending order with NO payment_fingerprint (the install / recovery shape) and a stored tip
    const noFp = () => makeDb({ orders: { O1: { ...PEND, tip_cents: 2000 } } });
    let db = noFp();
    let r = await acq(db, PEND, 'FPX', 3000);
    assert.deepStrictEqual([r.outcome, r.reason, db.writes(), db.getAt('orders/O1').active_attempt_id], ['conflict', 'tip', 0, undefined], 'no fingerprint stored + a changed tip → refused at the pre-read: no install, nothing written');
    db = noFp();
    r = await acq(db, PEND, 'FPX', 2000);
    assert.deepStrictEqual([r.outcome, db.getAt('orders/O1').active_attempt_id], ['claimed', 'AT9'], 'the same tip → install proceeds as today');
    // the classifier read fails (the handler's clsG = null): acquisition alone still refuses the changed tip
    db = noFp();
    assert.strictEqual((await acq(db, PEND, 'FPX', 0)).reason, 'tip', 'a classifier-read failure is irrelevant: acquisition compares the tip itself');
    // the CAS race: the stored tip changes between the pre-read and the transaction
    db = makeDb({ orders: { O1: { ...PEND, tip_cents: 2000 } } }, { beforeTx: (setAt) => setAt('orders/O1/tip_cents', 9000) });
    r = await acq(db, PEND, 'FPX', 2000);
    assert.deepStrictEqual([r.outcome, r.reason, db.getAt('orders/O1').active_attempt_id, db.getAt('payment_attempts/AT9')], ['conflict', 'tip', undefined, null], 'CAS race: the record is held unchanged and the post-commit check refuses; no attempt');
    // a changed tip against a LIVE checkout → tip, never reuse; the same tip → reuse
    const liveDb = () => makeDb({ orders: { O1: { ...PEND, tip_cents: 2000, active_attempt_id: 'A1', payment_fingerprint: 'FPX' } }, payment_attempts: { A1: { hosted_state: 'created', hosted_expires_at: NOW + 60000, hosted_checkout_url: 'https://pay/1', poll_token: 'T1' } } });
    assert.deepStrictEqual(await acq(liveDb(), PEND, 'FPY', 3000), { outcome: 'conflict', reason: 'tip' }, 'changed tip + (therefore) changed fingerprint → tip (precedence)');
    assert.strictEqual((await acq(liveDb(), PEND, 'FPX', 2000)).outcome, 'reuse', 'the same tip → reuse');
    assert.deepStrictEqual(await acq(liveDb(), PEND, 'FPY', 2000), { outcome: 'conflict' }, 'a fingerprint-only conflict (same tip) → the neutral conflict, as today');
    assert.deepStrictEqual(OE.orderExistsBody('tip', 'O1'), { error: 'order_exists', reason: 'tip', detail: OE.ORDER_EXISTS_DETAIL, order_id: 'O1' });
    // parity: the read-only classifier agrees
    assert.deepStrictEqual(await classifyHostedAttempt(liveDb(), 'O1', 'FPY', NOW, null, null, 3000), { willIssueFreshUrl: false, outcome: 'conflict', reason: 'tip' }, 'classifier parity: a changed tip → conflict tip');
    assert.strictEqual((await classifyHostedAttempt(noFp(), 'O1', 'FPX', NOW, null, null, 3000)).reason, 'tip');
    assert.strictEqual((await classifyHostedAttempt(liveDb(), 'O1', 'FPX', NOW, null, null, 2000)).outcome, 'reuse');
    assert.strictEqual((await classifyHostedAttempt(liveDb(), 'O1', 'FPX', NOW)).reason, 'tip', 'an existing caller passing no tip (default 0) against a tipped record → tip');
    ok('acquisition: a changed tip is refused at the pre-read (no fingerprint stored: no install, nothing written), with the classifier failed, and across the CAS race (held, post-commit refusal, no attempt); same tip reuses / installs; fingerprint-only stays conflict; the classifier agrees');

    // ── 9. P-C at the acquire: a fresh issuance without a payer email; recovery untouched ──
    db = makeDb({});
    r = await acq(db, PEND, 'FPX', 0, { payer: true });
    assert.deepStrictEqual([r.outcome, r.reason, db.writes(), db.getAt('orders/O1')], ['conflict', 'payer_email_unconfigured', 0, null], 'fresh + no payer email → refused BEFORE the CAS: no order, no attempt');
    db = makeDb({ orders: { O1: { ...PEND, active_attempt_id: 'A0', payment_fingerprint: 'FPX' } }, payment_attempts: { A0: { hosted_state: 'expired' } } });
    r = await acq(db, PEND, 'FPX', 0, { payer: true });
    assert.deepStrictEqual([r.reason, db.getAt('orders/O1').active_attempt_id, db.getAt('payment_attempts/A0')], ['payer_email_unconfigured', 'A0', { hosted_state: 'expired' }], 'a rotate is refused too; the existing attempt is untouched');
    assert.strictEqual((await acq(liveDb(), PEND, 'FPX', 2000, { payer: true })).outcome, 'reuse', 'a LIVE checkout still reuses without a payer email (recovery untouched)');
  }
  {
    const env = (v) => ({ PIXELPAY_MERCHANT_EMAIL: v });
    assert.strictEqual(PE.payerEmail({ customer_email: ' a@b.co ' }, env(undefined)), 'a@b.co');
    assert.strictEqual(PE.payerEmail({}, env('m@x.com')), 'm@x.com');
    for (const v of [undefined, '', '  ', 'not-an-email', 'a@b']) assert.strictEqual(PE.payerEmail({}, env(v)), null, `env ${JSON.stringify(v)} → none`);
    assert.strictEqual(await PE.refusesFresh({ willIssueFreshUrl: true }, {}, env('')), true);
    for (const cls of [{ willIssueFreshUrl: false, outcome: 'reuse' }, { willIssueFreshUrl: false, outcome: 'in_progress' }, { willIssueFreshUrl: false, outcome: 'already_paid' }, { willIssueFreshUrl: false, outcome: 'closed' }]) {
      assert.strictEqual(await PE.refusesFresh(cls, {}, env('')), false, `pre-check never refuses a recovery ${JSON.stringify(cls)}`);
    }
    assert.strictEqual(await PE.refusesFresh({ willIssueFreshUrl: true }, { customer_email: 'c@d.hn' }, env('')), false, 'a valid customer email needs no fallback');
    // codex r1 P2: the handler's classification FAILED (null) → fresh-vs-recovery is established again BEFORE the reserve
    let calls = 0;
    const re = (v) => async () => { calls++; if (v instanceof Error) throw v; return v; };
    assert.strictEqual(await PE.refusesFresh(null, {}, env(''), re({ willIssueFreshUrl: true })), true, 'classify failed + re-check says FRESH → refused before the reserve');
    assert.strictEqual(await PE.refusesFresh(null, {}, env(''), re({ willIssueFreshUrl: false, outcome: 'reuse' })), false, 'classify failed + re-check proves a live checkout → recovery untouched');
    assert.strictEqual(await PE.refusesFresh(null, {}, env(''), re(new Error('read failed'))), true, 'classify failed twice (cannot be established) → treated as FRESH, refused');
    assert.strictEqual(await PE.refusesFresh(null, {}, env(''), re(null)), true, 'an empty re-check → treated as FRESH, refused');
    assert.strictEqual(await PE.refusesFresh(null, {}, env('')), true, 'no re-check available → treated as FRESH, refused');
    const before = calls;
    assert.strictEqual(await PE.refusesFresh(null, { customer_email: 'c@d.hn' }, env(''), re({ willIssueFreshUrl: true })), false);
    assert.strictEqual(calls, before, 'with a payer email the re-check is never made (no extra read)');
    const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    assert.ok(!/pedidos@lamusa\.hn/.test(src), 'the brand-literal fallback is gone from index.js');
    ok('P-C: payer email = a valid customer email, else the env ONLY; a fresh issuance without one is refused before the CAS (create and rotate), recovery (reuse) never; the pre-check skips reuse/in_progress/already_paid/closed; a FAILED classify is re-established before the reserve and refused unless a live checkout is proven; the brand literal is gone');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\ns2tip: ${n} passed`);
})().catch((e) => { console.error('s2tip FAILED:', e); process.exit(1); });
