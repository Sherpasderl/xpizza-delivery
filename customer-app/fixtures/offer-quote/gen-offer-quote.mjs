// PLAN-capp-marketing-offers Slice A (advisor 11-14) — THE quoteOrder RESPONSES WITH (AND WITHOUT) AN OFFER, produced by 5f's REAL
// price path (feat/marketing-price-5f) for the capp's REAL cart (cart.json, from cart-of.mjs) — never hand-written. 5f's tree is not
// in this base, so this generator runs against an extracted tree of that commit:
//   git archive <sha> xpizza-functions | tar -x -C <dir>;  ln -s <this repo>/xpizza-functions/node_modules <dir>/xpizza-functions/node_modules
//   node customer-app/fixtures/offer-quote/gen-offer-quote.mjs <dir>/xpizza-functions <full sha>
// The composition is offer-wire.test.js quote(): offers by 3a's REAL writers (test/_marketing-price-seed), the envío ctx by the REAL
// delivery pricing (P.quoteDelivery), withOffer → issueQuote; the body is index.js quoteOrder's OWN response literal, cut from the
// pinned file and evaluated over those values (so a change to what the quote exposes changes this fixture).
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FN = process.argv[2], SHA = process.argv[3];
if (!FN || !/^[0-9a-f]{40}$/.test(SHA || '')) throw new Error('usage: gen-offer-quote.mjs <extracted xpizza-functions> <full commit sha>');
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'marketing-price-test-'.padEnd(48, 'x');
const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(FN, 'x.js'));
const blob = (rel) => { const b = readFileSync(join(FN, rel)); return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); };   // = git hash-object
const { world, NOW } = require('./test/_marketing-price-seed');
const OFW = require('./marketing/offer-wire');
const P = require('./delivery/delivery-pricing');
const DW = require('./delivery/delivery-wire');
const { issueQuote } = require('./quote-issue');
const { computeServerTotal } = require('./menu-pricing');
const { orderBreakdownCents } = require('./order-money');
const quiet = { warn() {}, log() {}, error() {} };

// quoteOrder's response literal (index.js), cut verbatim: from `return res.status(200).json({` after the quote's issueQuote to its `});`
const SRC = readFileSync(join(FN, 'index.js'), 'utf8');
const ANCHOR = 'customerId: dq.uid, nowMs: Date.now() });\n      return res.status(200).json(';
const at = SRC.indexOf(ANCHOR);
if (at < 0 || SRC.indexOf(ANCHOR, at + 1) >= 0) throw new Error('premise: ONE quoteOrder response literal at the pinned index.js');
const open = at + ANCHOR.length, close = SRC.indexOf('\n      });', open);
const LITERAL = SRC.slice(open, close + '\n      }'.length);
if (!/^\{\n\s+ok: true, total_cents: bd\.total_cents/.test(LITERAL) || !LITERAL.includes('OFW.offerOf(dqo)')) throw new Error('premise: the literal is the offer-aware response');
const respond = new Function('bd', 'issued', 'DW', 'OFW', 'dqo', 'require', `return (${LITERAL});`);   // `require` = the pinned tree's (the literal requires offer-price)

const CART = JSON.parse(readFileSync(join(HERE, 'cart.json'), 'utf8'));
const RID = 'x_pizza', TABLES = { restaurantId: RID, menu: CART.menu, extras: {} };
const items = CART.items, NAME = items[0].name;
const { total, error } = computeServerTotal(items, RID, TABLES);
if (error || total !== items.reduce((a, i) => a + i.subtotal, 0)) throw new Error(`premise: the server prices the capp cart as the cart does (${error}, ${total})`);
const PRICING = P.readPricing({ policy_version: 1, bands: [{ max_km: 10, cents: 6000 }], restaurants: { [RID]: { active: true, free_delivery: false } } }, RID);
const ctxOf = (mode) => P.quoteDelivery({ pricing: PRICING, hub: { lat: 14.1, lng: -87.2 }, mode, pin: { lat: 14.11, lng: -87.21, confirmed: true }, customerUid: 'cust1' }).ctx;

const LIVE = {};   // marketing_live/{rid} as 3a's REAL writers left it — the capp's menu `offers` are 3a's selectOffers over THIS (capp-ui.test)
async function quoted({ offer, mode = 'delivery', offers_enabled = true, live = null }) {
  OFW._resetCaches();
  const w = await world({ rid: RID, brand: 'xp', menu: CART.menu });
  if (offer) await w.publish(offer);
  if (!offers_enabled) await w.setOffers(false);   // the switch written OFF by the REAL config writer, over a live offer
  const nowMs = NOW + 3600000;
  if (live) LIVE[live] = { raw: w.fake.get(`marketing_live/${RID}`), now_ms: nowMs };
  const dqo = await OFW.withOffer({ db: w.db, rid: RID, items, tables: TABLES, baseTotalL: total, dq: { ctx: ctxOf(mode), uid: 'cust1' }, reward: null, app: true, nowMs, log: quiet });
  const issued = issueQuote({ items, reward: null, rid: RID, tables: TABLES, deliveryContext: dqo.ctx, offer: OFW.offerOf(dqo), customerId: 'cust1', nowMs });
  if (!issued.ok) throw new Error('premise: issued ' + JSON.stringify(issued));
  const resp = JSON.parse(JSON.stringify(respond(orderBreakdownCents(total, RID), issued, DW, OFW, dqo, require)));
  if (typeof resp.quote_token !== 'string') throw new Error('premise: a signed quote');
  resp.quote_token = '<quote_token>';   // signed per run; the capp never reads it for the totals
  return resp;
}

const S = {
  BOGO_DEL: await quoted({ offer: { type: 'bogo', params: { items: [NAME], free_per_order: 1 } }, live: 'BOGO' }),
  BOGO_PICK: await quoted({ offer: { type: 'bogo', params: { items: [NAME], free_per_order: 1 } }, mode: 'pickup' }),
  LPS_DEL: await quoted({ offer: { type: 'lps', params: { off_cents: 5000, min_cents: 60000 } } }),
  PCT_DEL: await quoted({ offer: { type: 'pct', params: { pct: 15 } } }),
  ENVIO_DEL: await quoted({ offer: { type: 'envio', params: { min_cents: 60000 } } }),
  ENVIO_UNDER_DEL: await quoted({ offer: { type: 'envio', params: { min_cents: 100000 } } }),
  UNDER_DEL: await quoted({ offer: { type: 'lps', params: { off_cents: 5000, min_cents: 100000 } }, live: 'LPS_UNDER' }),
  OFF_DEL: await quoted({ offer: { type: 'bogo', params: { items: [NAME], free_per_order: 1 } }, offers_enabled: false }),
};
// premises: each scenario is the state it is named for
const ok = (c, m) => { if (!c) throw new Error('premise: ' + m); };
ok(S.BOGO_DEL.offer && S.BOGO_DEL.offer.type === 'bogo' && S.BOGO_DEL.offer.discount_cents === items[0].subtotal * 100, 'BOGO_DEL: one Carnívora free');
ok(S.BOGO_DEL.net_total_cents === S.BOGO_DEL.total_cents + S.BOGO_DEL.delivery.delivery_cents - S.BOGO_DEL.offer.discount_cents, 'BOGO_DEL: net = food + envío − descuento');
ok(S.BOGO_PICK.offer && S.BOGO_PICK.offer.discount_cents > 0 && S.BOGO_PICK.delivery.mode === 'pickup', 'BOGO_PICK');
ok(S.LPS_DEL.offer && S.LPS_DEL.offer.type === 'lps' && S.LPS_DEL.offer.discount_cents === 5000, 'LPS_DEL');
ok(S.ENVIO_DEL.offer && S.ENVIO_DEL.offer.type === 'envio' && S.ENVIO_DEL.offer.discount_cents === 0 && S.ENVIO_DEL.delivery.promo_discount_cents === S.ENVIO_DEL.delivery.delivery_cents, 'ENVIO_DEL: the fee waived, no food discount');
ok(!('offer' in S.UNDER_DEL) && !('offer' in S.OFF_DEL) && !('offer' in S.ENVIO_UNDER_DEL), 'UNDER / OFF: no offer block');
ok(S.UNDER_DEL.offer_next && S.UNDER_DEL.offer_next.type === 'lps' && S.UNDER_DEL.offer_next.remaining_cents === 100000 - S.UNDER_DEL.total_cents, 'UNDER_DEL: offer_next names the lps and what is left');
ok(S.ENVIO_UNDER_DEL.offer_next && S.ENVIO_UNDER_DEL.offer_next.type === 'envio' && S.ENVIO_UNDER_DEL.offer_next.remaining_cents > 0, 'ENVIO_UNDER_DEL: offer_next for the envío');
ok(!('offer_next' in S.OFF_DEL) && !('offer_next' in S.BOGO_DEL), 'OFF / applied: no offer_next');
ok(S.PCT_DEL.offer && S.PCT_DEL.offer.pct === 15 && S.LPS_DEL.offer.min_cents === 60000, 'the label amounts ride the offer');
ok(!('name' in S.BOGO_DEL.offer), 'no merchant name');
ok(S.UNDER_DEL.net_total_cents === S.OFF_DEL.net_total_cents, 'UNDER = OFF economics');

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const out = {
  ref: 'feat/marketing-price-5f', sha: SHA,
  blobs: { 'index.js': blob('index.js'), 'marketing/offer-wire.js': blob('marketing/offer-wire.js'), 'marketing/offer-price.js': blob('marketing/offer-price.js'), 'delivery/delivery-wire.js': blob('delivery/delivery-wire.js') },
  literal_sha256: createHash('sha256').update(LITERAL).digest('hex'),
  cart_sha256: createHash('sha256').update(JSON.stringify(canon(CART))).digest('hex'),
  scenarios: S,
  live: LIVE,
  scenarios_sha256: createHash('sha256').update(JSON.stringify(canon(S))).digest('hex'),
  live_sha256: createHash('sha256').update(JSON.stringify(canon(LIVE))).digest('hex'),
};
writeFileSync(join(HERE, 'offer-quote.json'), JSON.stringify(out, null, 1) + '\n');
console.log('wrote offer-quote.json', Object.keys(S).join(' '));
