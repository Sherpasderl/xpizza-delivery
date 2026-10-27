// S7a-2 — THE DIRECTORY CONTRACT FAKE, produced by the REAL 5f directory (feat/capp-directory) — never hand-written.
// The directory server is not in this base yet, so this generator runs against an extracted tree of that commit:
//   git archive <sha> xpizza-functions | tar -x -C <dir>;  ln -s <this repo>/xpizza-functions/node_modules <dir>/xpizza-functions/node_modules
//   node customer-app/fixtures/s7a2/gen-directory.mjs <dir>/xpizza-functions <sha>
// Real pieces: handleDirectory + makeDirectoryDeps (activityWithSource → getIdentity, loadSchedule, the presentation and platform
// readers), createRestaurantRegistry().readNow, the identities seed_identity.js exports (assertIdentityShape), presentation
// written through tools/seed-presentation.js run(), all over a minimal in-memory RTDB (below: arrays read back as arrays, empty values dropped, as RTDB does). The ONE fake dependency is
// pricingView: 5f wires the Sherpa delivery readers later (directory-deps.js), so its values are declared below.
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
const PLATFORM = { city_label: 'San Pedro Sula',
  cuisines: [['pizza', 'Pizza'], ['italiana', 'Italiana'], ['asiatica', 'Asiática'], ['mariscos', 'Mariscos'], ['cafe', 'Café'], ['desayuno', 'Desayuno']].map(([id, label]) => ({ id, label })),
  meals: { desayuno: 'Para el desayuno', compartir: 'Para compartir' }, social: { min_reorders: 50, min_ratings: 20 }, value: { median_up_to_cents: 20000 } };
// DECLARED FAKE (wired by 5f later): the Sherpa delivery readers' view — the prototype's bands' first amount, its launch promo
const PRICING = {
  x_pizza: { fee: { state: 'priced', from_cents: 4500 }, promo: { free_delivery: true, label: 'promoción de lanzamiento' }, coverage_km: 7 },
  la_musa: { fee: { state: 'priced', from_cents: 4500 }, promo: null, coverage_km: 9.66 },
};

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const drop = (v) => { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) { const a = v.map(drop).filter((x) => x !== null); return a.length ? a : null; }
  const o = {}; for (const [k, x] of Object.entries(v)) { const d = drop(x); if (d !== null && d !== undefined) o[k] = d; } return Object.keys(o).length ? o : null; };
async function world({ ids = ['x_pizza', 'la_musa'], inactive = [], presThrows = [], actThrows = [], registryFails = false, pricing = PRICING } = {}) {
  RC._cache.clear();
  const data = { platform_config: { customer_app: clone(PLATFORM) } };
  const db = { ref: (p) => ({
    once: async () => { const v = p.split('/').reduce((o, k) => (o == null ? undefined : o[k]), data); const c = v === undefined ? null : clone(v); return { val: () => c, exists: () => c !== null }; },
    set: async (v) => { const ks = p.split('/'); let o = data; for (const k of ks.slice(0, -1)) o = o[k] = o[k] || {}; const c = drop(clone(v)); if (c === null) delete o[ks.at(-1)]; else o[ks.at(-1)] = c; },
    update: async (w) => { for (const [k, v] of Object.entries(w)) await db.ref(`${p}/${k}`).set(v); } }) };
  for (const [rid, id] of Object.entries(idents)) await db.ref(`restaurants/${rid}/identity`).set({ ...id, active: inactive.includes(rid) ? false : id.active });
  await SEED.run(db, PRESENTATION, { apply: true, force: false }, () => {});
  const registry = createRestaurantRegistry({ listIds: async () => { if (registryFails) throw new Error('registry down'); return ids; } });
  const deps = makeDirectoryDeps({ rtdb: db, registry, pricingView: async (rid) => pricing[rid] || { fee: { state: 'none' }, promo: null, coverage_km: null } });
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

const out = { source: { commit: SHA, blobs: Object.fromEntries(['directory/directory.js', 'directory/directory-deps.js', 'directory/presentation-shape.js', 'directory/platform-config.js', 'schedule/schedule-only.js', 'schedule/load-schedule.js', 'tools/seed-presentation.js', 'seed_identity.js'].map((f) => [f, blob(f)])) },
  fake_pricing: PRICING, scenarios: {} };
const S = out.scenarios;
S.complete = await call(await world());
S.not_modified = await call(await world(), S.complete.headers.ETag);
S.partial_presentation = await call(await world({ presThrows: ['la_musa'] }));
S.partial_unavailable = await call(await world({ actThrows: ['la_musa'] }));
S.zero = await call(await world({ inactive: ['x_pizza', 'la_musa'] }));   // the registry keeps its floor on an empty read (plan r3 §3): zero = none active
S.unavailable_503 = await call(await world({ registryFails: true }));
S.tombstone = await call(await world({ inactive: ['la_musa'] }));
S.fee_none = await call(await world({ pricing: { ...PRICING, la_musa: { fee: { state: 'none' }, promo: null, coverage_km: 9.66 } } }));
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'directory.json'), JSON.stringify(out, null, 2) + '\n');
console.log(Object.entries(S).map(([k, v]) => `${k} ${v.status} ${v.body ? (v.body.complete === undefined ? '' : 'complete=' + v.body.complete) + ' n=' + (v.body.restaurants || []).length : ''}`).join('\n'));
