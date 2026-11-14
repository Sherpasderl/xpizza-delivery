// PLAN-capp-marketing-offers r0 Q4 (advisor 11-14) — THE 409 offer_changed BODIES, produced by 5f's REAL price path (feat/marketing-price-5f)
// — never hand-written. 5f's tree is not in this base, so this generator runs against an extracted tree of that commit:
//   git archive <sha> | tar -x -C <dir>;  ln -s <this repo>/xpizza-functions/node_modules <dir>/xpizza-functions/node_modules
//   node customer-app/fixtures/offer-changed/gen-offer-changed.mjs <dir>/xpizza-functions <full sha>
// The three forms (PLAN-capp-marketing-offers §1.2):
//   GATE      (cash + card): 5f's offer-wire.test.js MW-CHANGED composition — offers by 3a's REAL writers (test/_marketing-price-seed),
//             quote = withOffer → issueQuote; the offer paused; placement = withOffer (placement) → foodBreakdown + DW.withDelivery →
//             applyConfirmedNetGate ⇒ { error:'offer_changed', net_total_cents, order_id }
//   CARD_CAP  : offer-usage.js afterGate after an ACCEPTED gate on an offer at its cap (offer-usage.test.js OU-GATE) ⇒ { error, order_id }
//   CASH_CAP  : index.js's inline cash cap hold — not callable on its own: its EXACT source literal is asserted at the pinned blob and the
//               body it writes recorded (the one form not executed here; 5f's emulator suite runs it live)
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FN = process.argv[2], SHA = process.argv[3];
if (!FN || !/^[0-9a-f]{40}$/.test(SHA || '')) throw new Error('usage: gen-offer-changed.mjs <extracted xpizza-functions> <full commit sha>');
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'marketing-price-test-'.padEnd(48, 'x');
const require = createRequire(join(FN, 'x.js'));
const blob = (rel) => { const b = readFileSync(join(FN, rel)); return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); };   // = git hash-object
const { world, NOW } = require('./test/_marketing-price-seed');
const OW = require('./marketing/offer-wire'), OP = require('./marketing/offer-price'), OU = require('./marketing/offer-usage'), CFG = require('./marketing/config');
const DW = require('./delivery/delivery-wire');
const { issueQuote } = require('./quote-issue');
const { applyConfirmedNetGate, gateInputFromRequest } = require('./token-gate');
const { computeServerTotal } = require('./menu-pricing');
const quiet = { warn() {}, log() {}, error() {} };
const ORDER = 'capp_ord_01';

// ── GATE (MW-CHANGED's composition, the cash site index.js:1151-1199) ──
const RID = 'x_pizza', MENU = { Pepperoni: 220, Hawaiana: 190, Refresco: 40 }, TABLES = { restaurantId: RID, menu: MENU, extras: {} };
const items = [{ name: 'Pepperoni', qty: 2, extras: [] }];
const foodL = computeServerTotal(items, RID, TABLES).total;
const w = await world({ rid: RID, brand: 'xp', menu: MENU });
const id = await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 } });
const tq = NOW + 3600000;
const dqo = await OW.withOffer({ db: w.db, rid: RID, items, tables: TABLES, baseTotalL: foodL, dq: { ctx: null, uid: 'cust1' }, reward: null, app: true, nowMs: tq, log: quiet });
const q = issueQuote({ items, reward: null, rid: RID, tables: TABLES, deliveryContext: dqo.ctx, offer: OW.offerOf(dqo), customerId: 'cust1', nowMs: tq });
if (!q.ok || !(q.components && q.components.offer_discount_cents > 0)) throw new Error('premise: the quote carries the offer');
await w.pause(id); OW._resetCaches();
const tp = tq + 60000;
const dq = await OW.withOffer({ db: w.db, rid: RID, items, tables: TABLES, baseTotalL: foodL, dq: null, reward: null, app: true, nowMs: tp, placement: true, log: quiet });
const recorded = DW.withDelivery(dq, OP.foodBreakdown(foodL, RID, OW.offerOf(dq)));
const gate = await applyConfirmedNetGate({ gateInput: gateInputFromRequest({ quote_token: q.quote_token, items }, { reward: null, rid: RID, tables: TABLES, secret: process.env.QUOTE_TOKEN_SECRET, enforce: true, nowMs: tp }),
  recordedTotalCents: recorded.total_cents, releaseHold: async () => {}, orderId: ORDER, log: quiet, ...DW.gateExtra(dq) });
if (!gate.refuse || gate.refuse.status !== 409 || gate.refuse.body.error !== 'offer_changed' || !Number.isSafeInteger(gate.refuse.body.net_total_cents)) throw new Error('premise: the gate refuses offer_changed with the new net: ' + JSON.stringify(gate.refuse));
if (!(gate.refuse.body.net_total_cents > q.net_total_cents)) throw new Error('premise: the new net is HIGHER than the quoted one');

// ── CARD_CAP (OU-GATE's composition: an accepted gate, the offer at its cap) ──
const CRID = 'tb_centro', CMENU = { i_aaaaaaaaaaaa: 200 }, CT = { restaurantId: CRID, menu: CMENU, extras: {} };
const citems = [{ name: 'i_aaaaaaaaaaaa', qty: 2, extras: [] }];
const cw = await world({ rid: CRID, menu: CMENU });
const cid = await cw.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 }, caps: { redemptions: 1, spend_cents: null, weekly: false } });
const offer = OP.offerFor({ cfg: await CFG.readMarketingConfig(cw.db), live: cw.fake.get(`marketing_live/${CRID}`), nowMs: tq, items: citems, rid: CRID, tables: CT, baseTotalL: 400 });
if (!offer || offer.offer_id !== cid) throw new Error('premise: the REAL offer ctx');
cw.fake.put('orders/o_first/offer', OP.frozenOf(offer)); cw.fake.put(`orders/${ORDER}/offer`, OP.frozenOf(offer));
const accepted = { refuse: null, provenance: { quote_id: 'q' }, result: {} };
const first = await OU.afterGate({ db: cw.db, orderId: 'o_first', offer, salesCents: 35000, nowMs: tq, releaseHold: async () => {} }, accepted);
if (first !== accepted) throw new Error('premise: the first order holds the one redemption');
const capped = await OU.afterGate({ db: cw.db, orderId: ORDER, offer, salesCents: 35000, nowMs: tq, releaseHold: async () => {} }, accepted);
if (!capped.refuse || capped.refuse.status !== 409) throw new Error('premise: the cap refuses');

// ── CASH_CAP (index.js's inline literal, asserted verbatim at the pinned blob) ──
const CASH_LITERAL = "if (offerHeld && !offerHeld.ok) return res.status(409).json({ error: 'offer_changed', order_id: orderId });";
const src = readFileSync(join(FN, 'index.js'), 'utf8');
if (src.split(CASH_LITERAL).length !== 2) throw new Error('premise: the cash cap-hold literal occurs exactly once at this commit');

const out = { source: { commit: SHA, blobs: Object.fromEntries(['token-gate.js', 'quote-issue.js', 'marketing/offer-wire.js', 'marketing/offer-price.js', 'marketing/offer-usage.js', 'index.js', 'test/_marketing-price-seed.js'].map((f) => [f, blob(f)])), cash_literal: CASH_LITERAL },
  scenarios: {
    gate: { quoted_net_cents: q.net_total_cents, status: gate.refuse.status, body: gate.refuse.body },
    card_cap: { status: capped.refuse.status, body: capped.refuse.body },
    cash_cap: { status: 409, body: { error: 'offer_changed', order_id: ORDER } },
  } };
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
out.scenarios_sha256 = createHash('sha256').update(canon(out.scenarios)).digest('hex');
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'offer-changed.json'), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify(out.scenarios));
