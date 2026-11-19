// S7a-2 — THE DIRECTORY CONTRACT FAKE, produced by the REAL 5f directory (feat/capp-directory) — never hand-written.
// The directory server is not in this base yet, so this generator runs against an extracted tree of that commit:
//   git archive <sha> xpizza-functions | tar -x -C <dir>;  ln -s <this repo>/xpizza-functions/node_modules <dir>/xpizza-functions/node_modules
//   node customer-app/fixtures/s7a2/gen-directory.mjs <dir>/xpizza-functions <sha>
// Real pieces: handleDirectory + makeDirectoryDeps (activityWithSource → getIdentity, loadSchedule, the presentation and platform
// readers), createRestaurantRegistry().readNow, the identities seed_identity.js exports (assertIdentityShape), presentation
// written through tools/seed-presentation.js run(), all over a minimal in-memory RTDB (below: arrays read back as arrays, empty values dropped, as RTDB does). Fake dependencies:
// none (s7a2 alignment, advisor 11-17) — the pricing node is committed by the REAL writer and read through the REAL pricingView, below.
// Output: directory.json — each scenario's status, headers and raw body exactly as handleDirectory wrote them.
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FN = process.argv[2], SHA = process.argv[3];
if (!FN || !/^[0-9a-f]{40}$/.test(SHA || '')) throw new Error('usage: gen-directory.mjs <extracted xpizza-functions> <full commit sha>');
const require = createRequire(join(FN, 'x.js'));
const { handleDirectory } = require('./directory/directory.js');
const { makeDirectoryDeps } = require('./directory/directory-deps.js');
const { createRestaurantRegistry } = require('./catalog/restaurant-registry.js');
const { IDENTITIES, assertIdentityShape } = require('./seed_identity.js');
const SEED = require('./tools/seed-presentation.js');
const RC = require('./restaurant-config.js');
const blob = (rel) => { const b = readFileSync(join(FN, rel)); return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); };   // = git hash-object

// the fixture's declared deviations from the production seed: la_musa ships DARK (active:false) — listed here so the client
// sees two stores; the WhatsApp instance is a placeholder (never served: the allowlist drops it)
const idents = {
  x_pizza: { ...IDENTITIES.x_pizza, whatsapp_instance: 'inst_fixture' },
  la_musa: { ...IDENTITIES.la_musa, active: true },
};
for (const [rid, id] of Object.entries(idents)) assertIdentityShape(rid, id);
// DECLARED FAKE stores for the five_stores scenario only (C1b-P3, advisor 11-14: the desk «Para vos» paging past 4 needs a 5-store
// directory): La Musa's identity shape under neutral ids/names, asserted by the same shape check; written ONLY into that scenario's world
const EXTRA = ['tienda_c', 'tienda_d', 'tienda_e'];
const extraIdents = Object.fromEntries(EXTRA.map((rid, i) => [rid, { ...IDENTITIES.la_musa, name: `Tienda ${'CDE'[i]}`, active: true }]));
for (const [rid, id] of Object.entries(extraIdents)) assertIdentityShape(rid, id);
// x_pizza's «La casa recomienda»: CANONICAL dish ids of its published catalog (the S0 rig's real publish; see the test)
const { provisionBrand } = await import(new URL('../../../xpizza-functions/contract/capp/capture.mjs', import.meta.url));
const XP_MENU = (await provisionBrand('x_pizza')).envelope.menu;
// the prototype's x_pizza house list (P:1121), by name → the published dish ids
const XP_HOUSE = ['Pistaccio Mortadella', 'Prosciutto', 'Pancetta Vodka Sauce', 'Sweet Corn & Calabrian Chili'].map((n) => { const d = XP_MENU.dishes.find((x) => x.name === n); if (!d) throw new Error(`no x_pizza dish ${n}`); return d.dish_id; });
const ASSET = 'https://assets.sherpa.test';   // the harness serves this host from local files
const PRESENTATION = {
  x_pizza: { kicker: 'Pizzería', unit: ['pizza', 'pizzas'], cuisines: ['pizza', 'italiana'], logo_url: `${ASSET}/img/xp-logo.webp`, logo_wide: false,
    hero_url: `${ASSET}/img/xp-hero.jpg`, asset_base: `${ASSET}/xpizza-orders`, eta_delivery_min: [30, 45], eta_pickup_min: [15, 20],
    payments: ['online', 'cash'], pickup: true, order_id_prefix: 'XPZ', ...(XP_HOUSE.length ? { house: XP_HOUSE } : {}), meals: { ny: 'compartir' } },
  la_musa: { kicker: 'Gastropub', unit: ['plato', 'platos'], cuisines: ['asiatica', 'mariscos'], logo_url: `${ASSET}/img/lm-logo.png`, logo_wide: true,
    hero_url: `${ASSET}/img/lm-hero.jpg`, eta_delivery_min: [35, 50], eta_pickup_min: [20, 30], payments: ['online', 'cash'], pickup: true,
    order_id_prefix: 'LMS', meals: { dim_sum: 'compartir', starters: 'compartir' } },
};
const EXTRA_PRESENTATION = Object.fromEntries(EXTRA.map((rid, i) => [rid, { kicker: 'Restaurante', unit: ['plato', 'platos'], cuisines: ['cafe'], logo_url: `${ASSET}/img/lm-logo.png`, logo_wide: true,
  hero_url: `${ASSET}/img/lm-hero.jpg`, eta_delivery_min: [25, 40], eta_pickup_min: [15, 25], payments: ['online', 'cash'], pickup: true, order_id_prefix: `T${'CDE'[i]}X` }]));
const PLATFORM = { city_label: 'San Pedro Sula',
  cuisines: [['pizza', 'Pizza'], ['italiana', 'Italiana'], ['asiatica', 'Asiática'], ['mariscos', 'Mariscos'], ['cafe', 'Café'], ['desayuno', 'Desayuno']].map(([id, label]) => ({ id, label })),
  meals: { desayuno: 'Para el desayuno', compartir: 'Para compartir' }, social: { min_reorders: 50, min_ratings: 20 }, value: { median_up_to_cents: 20000 } };
// THE PRICING READ (owner rule 10; s7a2 alignment, advisor 11-17): no fake. The node is committed by the REAL writer
// (delivery/pricing-admin-core.js setDeliveryPricingCore — the owner's «Envío» save) on the strict fake RTDB, and every world reads it through
// the REAL directory/pricing-view.js makePricingView (the quote's own delivery-wire.loadPricing read; directory-endpoint.js wires the same).
// Declared seeds: the prototype's bands (L 45 to 4 km, L 65 to 10 km) and x_pizza's branch limit 7 km.
const { fakeRtdb } = require('./test/_fake-rtdb-sdk.js');
const { setDeliveryPricingCore, PATH: PRICING_PATH } = require('./delivery/pricing-admin-core.js');
const { makePricingView } = require('./directory/pricing-view.js');
const PRICING_SAVE = { expected_policy_version: 0, bands: [{ max_km: 4, cents: 4500 }, { max_km: 10, cents: 6500 }], limits: [{ rid: 'x_pizza', km: 7 }] };
const PRICING_NODE = await (async () => {
  const db = fakeRtdb({ platform_admins: { gen_owner: true }, restaurants: Object.fromEntries(Object.entries({ ...idents, ...extraIdents }).map(([rid, id]) => [rid, { identity: id }])) }, { strict: true });
  const deps = { db, verifyIdToken: async (t) => { if (t !== 'tok_owner') throw new Error('bad token'); return { uid: 'gen_owner' }; }, timestamp: () => 1762800000000,
    readRegistry: async () => ({ ok: true, fresh: true, ids: ['x_pizza', 'la_musa', ...EXTRA] }) };
  const r = await setDeliveryPricingCore(deps, { get: (h) => (String(h).toLowerCase() === 'authorization' ? 'Bearer tok_owner' : null), body: PRICING_SAVE });
  if (r.status !== 200) throw new Error(`the pricing writer refused the seed: ${r.status} ${JSON.stringify(r.body)}`);
  return (await db.ref(PRICING_PATH).once('value')).val();
})();
// ⚠ COUNTERFACTUAL — the ONLY declared exceptions (advisor 11-17, fork A + ruling (a)). Free delivery is OFF by platform POLICY
// (delivery/pricing-admin-core.js:4-5, addendum A: «no per-restaurant map and no free delivery»; delivery-wire.js loadPricing forces it), so
// no real writer produces a free-delivery claim. The capp's claim UI is kept (enhance, don't rework) and exercised ONLY on:
//   promo_free_counterfactual — the real chain's output with ONE hand-set field: the view's promo.free_delivery = true;
//   complete_writer_raw       — its declared twin for RULE 10: the same field, and the view's promo arriving WITHOUT `basis` (an unmarked
//                               or cached directory) — the REAL directory promoOf then drops the marker itself.
// Both become generated if free delivery is ever re-enabled. Read only by the claim cells / the RULE 10 raw cell (capp-s7a2.test.mjs
// COUNTERFACTUAL guard names both).
const COUNTERFACTUAL = Object.freeze({
  promo_free_counterfactual: (p) => ({ ...p, free_delivery: true }),
  complete_writer_raw: (p) => { const { basis, ...rest } = p; return { ...rest, free_delivery: true }; },
});

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const drop = (v) => { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) { const a = v.map(drop).filter((x) => x !== null); return a.length ? a : null; }
  const o = {}; for (const [k, x] of Object.entries(v)) { const d = drop(x); if (d !== null && d !== undefined) o[k] = d; } return Object.keys(o).length ? o : null; };
async function world({ ids = ['x_pizza', 'la_musa'], inactive = [], presThrows = [], actThrows = [], registryFails = false, pricingNode = PRICING_NODE, cf = null, extra = false } = {}) {
  RC._cache.clear();
  const data = { platform_config: { customer_app: clone(PLATFORM), ...(pricingNode ? { delivery_pricing: clone(pricingNode) } : {}) } };
  const read = async (p) => { const v = p.split('/').reduce((o, k) => (o == null ? undefined : o[k]), data); const c = v === undefined ? null : clone(v); return { val: () => c, exists: () => c !== null }; };
  const db = { ref: (p) => ({
    get: () => read(p),   // the order path's read (delivery-wire loadPricing)
    once: async () => { const v = p.split('/').reduce((o, k) => (o == null ? undefined : o[k]), data); const c = v === undefined ? null : clone(v); return { val: () => c, exists: () => c !== null }; },
    set: async (v) => { const ks = p.split('/'); let o = data; for (const k of ks.slice(0, -1)) o = o[k] = o[k] || {}; const c = drop(clone(v)); if (c === null) delete o[ks.at(-1)]; else o[ks.at(-1)] = c; },
    update: async (w) => { for (const [k, v] of Object.entries(w)) await db.ref(`${p}/${k}`).set(v); } }) };
  for (const [rid, id] of Object.entries(extra ? { ...idents, ...extraIdents } : idents)) await db.ref(`restaurants/${rid}/identity`).set({ ...id, active: inactive.includes(rid) ? false : id.active });
  await SEED.run(db, extra ? { ...PRESENTATION, ...EXTRA_PRESENTATION } : PRESENTATION, { apply: true, force: false }, () => {});
  const registry = createRestaurantRegistry({ listIds: async () => { if (registryFails) throw new Error('registry down'); return ids; } });
  const view = makePricingView({ rtdb: db });
  const pricingView = cf ? async (rid, idn) => { const v = await view(rid, idn); return v && v.promo ? { ...v, promo: COUNTERFACTUAL[cf](v.promo) } : v; } : view;
  const deps = makeDirectoryDeps({ rtdb: db, registry, pricingView });
  const wrap = (k) => async (rid) => { if ((k === 'p' ? presThrows : actThrows).includes(rid)) throw new Error('read failed'); return deps[k === 'p' ? 'readPresentation' : 'activity'](rid); };
  return { ...deps, readPresentation: wrap('p'), activity: wrap('a') };
}
async function call(deps, inm) {
  const r = { status: null, headers: {}, body: null };
  const res = { status(c) { r.status = c; return res; }, set(k, v) { r.headers[k] = v; return res; }, end(b) { r.body = b === undefined ? null : JSON.parse(b); return res; },
    json() { throw new Error('res.json'); } };
  await handleDirectory({ method: 'GET', get: (h) => (h.toLowerCase() === 'if-none-match' ? inm : undefined) }, res, deps);
  return r;
}

const out = { source: { commit: SHA, blobs: Object.fromEntries(['directory/directory.js', 'directory/directory-deps.js', 'directory/presentation-shape.js', 'directory/platform-config.js', 'schedule/schedule-only.js', 'schedule/load-schedule.js', 'tools/seed-presentation.js', 'seed_identity.js', 'directory/pricing-view.js', 'delivery/pricing-admin-core.js', 'delivery/delivery-wire.js', 'delivery/delivery-pricing.js'].map((f) => [f, blob(f)])) },
  pricing_save: PRICING_SAVE, fake_extra_stores: { identities: extraIdents, presentation: EXTRA_PRESENTATION }, scenarios: {} };
const S = out.scenarios;
S.complete = await call(await world());
S.not_modified = await call(await world(), S.complete.headers.ETag);
S.partial_presentation = await call(await world({ presThrows: ['la_musa'] }));
S.partial_unavailable = await call(await world({ actThrows: ['la_musa'] }));
S.zero = await call(await world({ inactive: ['x_pizza', 'la_musa'] }));   // the registry keeps its floor on an empty read (plan r3 §3): zero = none active
S.unavailable_503 = await call(await world({ registryFails: true }));
S.tombstone = await call(await world({ inactive: ['la_musa'] }));
S.five_stores = await call(await world({ ids: ['x_pizza', 'la_musa', ...EXTRA], extra: true }));   // C1b-P3: the desk «Para vos» past 4
S.fee_none = await call(await world({ pricingNode: null }));   // no «Envío» saved yet: the real view is dark for every store (fee none, no promo)
// the two COUNTERFACTUAL scenarios (above): the claim UI's input, and RULE 10's unmarked twin (zero claims)
S.promo_free_counterfactual = await call(await world({ cf: 'promo_free_counterfactual' }));
S.complete_writer_raw = await call(await world({ cf: 'complete_writer_raw' }));
// the CONTENT pin (Codex s7a2 r1 #10): sha-256 over the canonical JSON (sorted keys) of every scenario — a hand edit fails the test
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
out.scenarios_sha256 = createHash('sha256').update(canon(out.scenarios)).digest('hex');
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'directory.json'), JSON.stringify(out, null, 2) + '\n');
console.log(Object.entries(S).map(([k, v]) => `${k} ${v.status} ${v.body ? (v.body.complete === undefined ? '' : 'complete=' + v.body.complete) + ' n=' + (v.body.restaurants || []).length : ''}`).join('\n'));
