// REVIEW ONLY — the «Marketing › Ofertas» SBS backend (advisor 11-15): every call the Marketing page makes is answered by 3a's REAL
// cores at the Ofertas lane's ONE pin — read from the worktree's own marketing-harness.mjs REF (94e6b7ae9 at aed2c4a56), git-archived by
// its ref-tree.mjs — over production's transaction semantics (the harness's prodDb). The world is made by the REAL writers only: the
// roster writer (the owner), the catalog mirror writer (the published menus), the config writer (offers_enabled), and every offer by
// the REAL marketingOfferSave / SetState cores — seeded at EARLIER server times (deps.now) so the offers have real pasts. No
// hand-built record, no canned reply. Offers v1 (owner 11-15): no caps, no «Envío gratis» — the mockup's envío row and every cap are
// NOT seeded (the v1 writer refuses them); that diff is derived-from-owner-decision.
// Scenarios (a frame's leading `scn:` step):
//   populated  the mockup's s-home rows that v1 can author: «Almuerzo: 15 % en todo el menú» (Activa) · «2 por 1 en pizzas clásicas»
//              (Programada) · «L 50 de bienvenida» (Pausada por vos, 9 nov) · «Fin de semana: 10 % en pastas» (Terminada, 1 de 3) ·
//              «Cena: L 40 en pedidos desde L 300» (Borrador)
//   empty      no offers (the switch ON)
//   unknown    populated, and every brand transaction FAILS (an outage) — the next write is the real core's 503 ⇒ the page's UNKNOWN
//   cfm-*      «confirm every save» (MOCKUP v5b, owner 11-15): populated, and a PLAN for the page's marketingOfferSave calls, one step per
//              call — fail (the brand txn throws ⇒ the REAL core's 503, nothing written) · hold (the answer never comes: «Confirmando…»)
//              · pass (the real core) · judge-lost (the real core JUDGES it — 409 too_many_live, stored in the op_id claim — and that
//              reply is lost: the page sees a 503):
//              cfm-confirming [fail, hold] · cfm-saved [fail, pass] · cfm-refused [judge-lost, pass] · cfm-fallback [fail, fail]
//              cfm-refused (advisor 11-16, Codex #93 F2): only an OP-JUDGED refusal settles the one confirmation — a refusal given before the
//              claim check (offers_disabled) is UNKNOWN now — so Centro is filled to the live limit first (8 more live offers by the real
//              core) and the confirmation replays the stored too_many_live (v5b 3f draws an overlap; the lps card is not dish-level, so
//              it cannot overlap — the same callout + the builder's own word for the code)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OWNER = 'ownerShoot';
const BRAND = 'pv', BRAND_NAME = 'Pizzería Del Valle';
const ROWS = [['pv_centro', 'Centro'], ['pv_proceres', 'Los Próceres'], ['pv_trapiche', 'El Trapiche']];
const K1 = 'i_margarita00', K2 = 'i_hawaiana000', K3 = 'i_pepperoni00', K4 = 'i_refresco000';
const DAY = 86400000, HN = 6 * 3600000;
const hn = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) + HN;   // a wall-clock time in Honduras (UTC−6)
export const T0 = hn(2026, 11, 12, 12);   // Thu 12 Nov 2026, noon HN — the mockup's «today» (its period ends 12 nov)
const ALL_DAY = { open: true, start: '00:00', end: '23:59' };
const days = (d) => Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((k) => [k, d]));
const quiet = { warn() {}, log() {}, error() {} };

export async function backend(root) {
  const harness = readFileSync(path.join(root, 'xpizza-portal', 'marketing-harness.mjs'), 'utf8');
  const m = harness.match(/export const REF = '([0-9a-f]{40})'/);
  if (!m) throw new Error('premise: the worktree\'s marketing-harness.mjs pins a REF');
  const REF = m[1];
  const { refTree } = await import(pathToFileURL(path.join(root, 'xpizza-portal', 'ref-tree.mjs')).href);
  const q = refTree(REF);
  const C = q('./marketing/offers-core'), CFG = q('./marketing/config'), OPS = q('./portal/ops-core');
  const { createFakeDb } = q('./merchant/_fake-db');
  const R = q('./access/roster');
  const { makeRtdbMirror } = q('./catalog/mirror-rtdb');
  const { makeRtdbMirrorReader } = q('./catalog/snapshot-fallback');
  const { buildMenu } = q('./catalog/catalog-menu');
  void createRequire;

  const MENU = [[K1, 150, 'pizzas'], [K2, 220, 'pizzas'], [K3, 190, 'pizzas'], [K4, 35, 'bebidas']];
  const snap = (docs) => ({ empty: docs.length === 0, docs: docs.map((v, i) => ({ id: `d${i}`, data: () => v })) });
  const versionMenu = () => buildMenu(snap(MENU.map(([key, price, cat]) => ({ key, price, display: { price, cat, name: key } }))), snap([]),
    { exists: true, data: () => ({ categories: [{ id: 'pizzas' }, { id: 'bebidas' }], item_order: MENU.map((r) => r[0]) }) }, 'shoot');
  let fake = null, failTx = null, clockNow = T0, plan = null;
  const PLANS = { 'cfm-confirming': ['fail', 'hold'], 'cfm-saved': ['fail', 'pass'], 'cfm-refused': ['judge-lost', 'pass'], 'cfm-fallback': ['fail', 'fail'] };
  // production's transaction semantics (marketing-harness prodDb) + an OUTAGE switch on a path prefix (the `unknown` scenario)
  const prodDb = (f) => ({ ref(p = '') {
    const r = f.ref(p);
    return { ...r, get: () => r.once(), async transaction(fn) {
      if (failTx && String(p).startsWith(failTx)) throw new Error(`injected outage: ${p}`);
      const cold = fn(null);
      if (cold === undefined) return { committed: false, snapshot: { val: () => null } };
      if (f.get(p) === null) { f.put(p, cold); return { committed: true, snapshot: { val: () => f.get(p) } }; }
      return r.transaction(fn);
    } };
  } });
  const verifyIdToken = async () => ({ uid: OWNER });
  const http = (method, query, body) => ({ method, query: query || {}, body, get: (h) => (String(h).toLowerCase() === 'authorization' ? 'Bearer shoot' : undefined) });
  const deps = () => { const db = prodDb(fake); return { db, verifyIdToken, log: quiet, now: () => clockNow, readMirror: makeRtdbMirrorReader(db), readCategoryMenu: async () => versionMenu() }; };
  const CORES = { getMarketing: C.getMarketingCore, marketingOfferSave: C.marketingOfferSaveCore, marketingOfferSetState: C.marketingOfferSetStateCore, marketingOfferRepeat: C.marketingOfferRepeatCore };

  // a write by the REAL core, at server time `at` — a refusal is a broken premise, never a seeded record
  async function write(fn, body, at) {
    clockNow = at;
    const r = await CORES[fn](deps(), http('POST', {}, body));
    clockNow = T0;
    if (r.status !== 200) throw new Error(`premise: ${fn} ${JSON.stringify(body).slice(0, 120)} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.offer;
  }
  const offer = (o) => ({ audience: 'all', branches: ROWS.map((x) => x[0]), ...o });
  async function seedOffers() {
    const rid = 'pv_centro';
    // Activa — «Almuerzo: 15 % en todo el menú», Lun–Vie 11:00–14:00, del 2 al 27 nov (authored 30 oct, published at its start)
    const a = await write('marketingOfferSave', { rid, expected_rev: 0, offer: offer({ name: 'Almuerzo: 15 % en todo el menú', type: 'pct', params: { pct: 15, max_cents: 10000 },
      schedule: { start: hn(2026, 11, 2), end: hn(2026, 11, 27, 23, 59) + 59999, days: [1, 2, 3, 4, 5], window: { from: 660, to: 840 } } }) }, hn(2026, 10, 30, 10));
    await write('marketingOfferSetState', { rid, offer_id: a.id, to: 'active', expected_rev: a.rev }, hn(2026, 10, 30, 10, 5));
    // Programada — «2 por 1 en pizzas clásicas», Vie y Sáb 21:00–00:00, from Fri 13 nov
    const b = await write('marketingOfferSave', { rid, expected_rev: 0, offer: offer({ name: '2 por 1 en pizzas clásicas', type: 'bogo', params: { items: [K1, K2], free_per_order: 1 },
      schedule: { start: hn(2026, 11, 13), end: hn(2026, 11, 30, 23, 59) + 59999, days: [5, 6], window: { from: 1260, to: 0 } } }) }, hn(2026, 11, 11, 9));
    await write('marketingOfferSetState', { rid, offer_id: b.id, to: 'active', expected_rev: b.rev }, hn(2026, 11, 11, 9, 5));
    // Pausada por vos — «L 50 de bienvenida» (Clientes nuevos), every day, since 15 oct; paused by the owner on 9 nov
    const c = await write('marketingOfferSave', { rid, expected_rev: 0, offer: offer({ name: 'L 50 de bienvenida', type: 'nuevos', audience: 'new', params: { off_cents: 5000 },
      schedule: { start: hn(2026, 10, 15), end: null, days: [0, 1, 2, 3, 4, 5, 6], window: null } }) }, hn(2026, 10, 14, 9));
    const c1 = await write('marketingOfferSetState', { rid, offer_id: c.id, to: 'active', expected_rev: c.rev }, hn(2026, 10, 14, 9, 5));
    await write('marketingOfferSetState', { rid, offer_id: c.id, to: 'paused_owner', expected_rev: c1.rev }, hn(2026, 11, 9, 16));
    // Terminada — «Fin de semana: 10 % en pastas», 1 of 3 branches (Los Próceres), Sáb y Dom, ended 8 nov
    const rp = 'pv_proceres';
    const d = await write('marketingOfferSave', { rid: rp, expected_rev: 0, offer: offer({ name: 'Fin de semana: 10 % en pastas', type: 'pct', params: { pct: 10, max_cents: 10000 }, branches: [rp],
      schedule: { start: hn(2026, 10, 24), end: hn(2026, 11, 22, 23, 59) + 59999, days: [0, 6], window: null } }) }, hn(2026, 10, 23, 9));
    const d1 = await write('marketingOfferSetState', { rid: rp, offer_id: d.id, to: 'active', expected_rev: d.rev }, hn(2026, 10, 23, 9, 5));
    await write('marketingOfferSetState', { rid: rp, offer_id: d.id, to: 'ended', expected_rev: d1.rev }, hn(2026, 11, 8, 20));
    // Borrador at the 40-character name limit — the (iii) A proof: at 390 the name stays on ONE line (advisor 11-15, rule 16c)
    await write('marketingOfferSave', { rid, expected_rev: 0, offer: offer({ name: 'Combo noche: L 40 en pedidos desde L 300', type: 'lps', params: { off_cents: 4000, min_cents: 30000 },
      schedule: { start: null, end: null, days: [5, 6], window: { from: 1260, to: 0 } } }) }, hn(2026, 11, 10, 19));
    // Borrador — «Cena: L 40 en pedidos desde L 300», not scheduled
    await write('marketingOfferSave', { rid, expected_rev: 0, offer: offer({ name: 'Cena: L 40 en pedidos desde L 300', type: 'lps', params: { off_cents: 4000, min_cents: 30000 },
      schedule: { start: null, end: null, days: [0, 1, 2, 3, 4, 5, 6], window: { from: 1080, to: 1260 } } }) }, hn(2026, 11, 10, 18));
  }

  async function reset(scn) {
    failTx = null; clockNow = T0; plan = PLANS[scn] ? [...PLANS[scn]] : null;
    fake = createFakeDb({
      brands: { [BRAND]: { name: BRAND_NAME, active: true, locations: Object.fromEntries(ROWS.map(([rid]) => [rid, 'member'])), activation: { state: 'on', since: 1 } } },
      restaurants: Object.fromEntries(ROWS.map(([rid, name]) => [rid, { identity: { brand_id: BRAND, name, active: true, prep_default_min: 20, version: 1,
        hub_lat: 14.09, hub_lng: -87.2, delivery_radius_km: 4, phone: '+50497128830', hours: days(ALL_DAY) } }])),
    });
    const db = prodDb(fake);
    const o = await R.mutateRoster({ db: fake, now: () => 1 }, BRAND, { kind: 'cli', operator: 'shoot' }, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'Marcela Pineda', email: 'duena@pv.hn' } });
    if (!o || o.ok === false) throw new Error(`premise: the roster writer bootstrapped the owner (${JSON.stringify(o)})`);
    const mirror = makeRtdbMirror(db);
    for (const [rid] of ROWS) await mirror(rid, { version: 'v1', seq: 1, rid, menu: Object.fromEntries(MENU.map(([k, p]) => [k, p])), extras: {} });
    const cfg = await CFG.writeMarketingConfig(db, { expected: 0, actor: 'cli:shoot', now: 1,
      config: { offers_enabled: true, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } } });
    if (!cfg || cfg.ok !== true) throw new Error(`premise: the config writer turned offers ON (${JSON.stringify(cfg)})`);
    if (scn === 'populated' || scn === 'unknown' || plan) await seedOffers();
    if (scn === 'cfm-refused') {   // Centro to the live limit (live_max 10): it holds «Almuerzo» + «2 por 1» live; 8 more by the REAL core
      for (let i = 0; i < 8; i += 1) {
        const f = await write('marketingOfferSave', { rid: 'pv_centro', expected_rev: 0, offer: offer({ name: `Lleno ${i + 1}`, type: 'pct', params: { pct: 5 * (i + 1), max_cents: 10000 }, branches: ['pv_centro'],
          schedule: { start: hn(2026, 11, 1), end: null, days: [i % 7], window: null } }) }, hn(2026, 10, 31, 9, i));
        await write('marketingOfferSetState', { rid: 'pv_centro', offer_id: f.id, to: 'active', expected_rev: f.rev }, hn(2026, 10, 31, 10, i));
      }
    }
    if (scn === 'unknown') failTx = `marketing_brand/${BRAND}`;   // armed AFTER the seed: the page's reads pass, its next write is a 503
  }

  async function call({ fn, method, query, body }) {
    if (plan && fn === 'marketingOfferSave' && plan.length) {   // the cfm-* plan: one step per save call, then the real core
      const step = plan.shift();
      if (step === 'hold') await new Promise(() => {});
      if (step === 'judge-lost') {   // the real core judges it (and stores the judgement in the op_id claim); the reply never arrives
        const r = await CORES[fn](deps(), http(method, query, body));
        if (r.status !== 409 || r.body.error !== 'too_many_live') throw new Error(`premise: the first call is JUDGED too_many_live (${r.status} ${JSON.stringify(r.body)})`);
        return { status: 503, body: { error: 'unavailable', retryable: true } };
      }
      if (step === 'off') {
        const off = await CFG.writeMarketingConfig(prodDb(fake), { expected: 1, actor: 'cli:shoot', now: 2,
          config: { offers_enabled: false, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } } });
        if (!off || off.ok !== true) throw new Error(`premise: the config writer turned offers OFF (${JSON.stringify(off)})`);
      }
      failTx = step === 'fail' ? `marketing_brand/${BRAND}` : null;
      try { return await CORES[fn](deps(), http(method, query, body)); } finally { failTx = null; }
    }
    if (fn === 'getMyBranches') return OPS.getMyBranchesCore({ db: prodDb(fake), verifyIdToken, now: () => clockNow, log: quiet }, http(method, query));
    if (CORES[fn]) return CORES[fn](deps(), http(method, query, body));
    return null;   // a gap (logged by the fixture), never a canned answer
  }
  return { reset, call, clock: T0, brand: BRAND };
}
