'use strict';
// PLAN-3a-capp-offers-read r0 Q1 — `offers` in the SERVED public menu, through the REAL buildPublicMenu over a catalog published by the
// real publisher (the dish-stats recipe); the offers by the REAL marketing cores (save → publish → the price path's marketing_live
// mirror), membership by the REAL roster writer, the switch by the REAL config writer, the catalog mirror by the REAL mirror writer.
// The RTDB double is the producer's (ratings/_rtdb-fake: production transactions). Run: node catalog/offers-serve.test.js
const assert = require('assert');
const crypto = require('crypto');
const { makeDb } = require('./firestore-fake');
const { publishVersion } = require('./catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('./source-store');
const { buildPublicMenu, REPRESENTATION_VERSION } = require('./public-menu');
const { getRestaurantMenu } = require('./catalog-menu');
const { makeRtdbMirror } = require('./mirror-rtdb');
const { makeRtdbMirrorReader } = require('./snapshot-fallback');
const { fakeDb } = require('../ratings/_rtdb-fake');
const R = require('../access/roster');
const CFG = require('../marketing/config');
const OM = require('../marketing/offer-model');
const C = require('../marketing/offers-core');
const OS = require('./offers-serve');
const SW = require('../marketing/switch-memo');

let n = 0; let FINISHED = false;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ offers-serve: exited without completing (a hang)\n'); process.exitCode = 1; } });
const quiet = async (f) => { const w = console.warn; console.warn = () => {}; try { return await f(); } finally { console.warn = w; } };
const RID = 'x_pizza';
const base = { known: new Set([RID]), isActive: async () => true };
const NOW = Date.UTC(2026, 10, 16, 18);   // Mon 16 Nov 2026 12:00 HN
const DAY = 86400000;
const OWNER = 'ownerOs01';
const verifyIdToken = async () => ({ uid: OWNER });
const req = (body) => ({ method: 'POST', body, get: (h) => (h === 'authorization' ? 'Bearer t' : undefined) });

async function world({ on = true, legacy = false } = {}) {
  const fs = makeDb();
  await sourceRefOf(fs, RID).set(canonicalize(buildSourceFromCode(RID)));
  const { input, expected } = buildPublishCandidate(RID, { activeVersionId: null }, { source_sha: 'offers-serve' });
  await publishVersion(fs, RID, input, { expected });
  const menu = await getRestaurantMenu(fs, RID);
  const db = fakeDb();
  // legacy: an UNENRICHED legacy singleton (as production's two restaurants are): brands/{rid} 'legacy', NO identity.brand_id
  const B = legacy ? RID : 'xb';
  db.set(`brands/${B}`, { name: 'XB', active: true, locations: { [RID]: 'member' }, activation: { state: legacy ? 'legacy' : 'on', since: 1 } });
  db.set(`restaurants/${RID}/identity`, legacy ? { name: 'X', active: true, version: 1 } : { brand_id: 'xb', name: 'X', active: true, version: 1 });
  assert.strictEqual((await R.mutateRoster({ db, now: () => 1 }, B, { kind: 'cli', operator: 'op' }, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'D', email: 'd@x.hn' } })).ok, true, 'premise: roster');
  await makeRtdbMirror(db)(RID, { version: 'v1', seq: 1, rid: RID, menu: Object.fromEntries(menu.items.map((it) => [it.key, it.price])), extras: {} });
  await db.ref('platform_config/pending_sweep_exit').set({ at: 1, by: 'test' });   // 5f's go-live gate (32a95e405): offers ON needs the owner's marker
  assert.strictEqual((await CFG.writeMarketingConfig(db, { expected: 0, config: { offers_enabled: on, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } }, actor: 'cli:op', now: 1 })).ok, true, 'premise: config');
  const deps = { db, verifyIdToken, now: () => NOW, readMirror: makeRtdbMirrorReader(db), readCategoryMenu: (rid) => getRestaurantMenu(fs, rid) };
  return { fs, db, deps, menu };
}
const offer = (o = {}) => ({ name: 'Oferta', type: 'pct', params: { pct: 10 }, audience: 'all', branches: [RID], schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [0, 1, 2, 3, 4, 5, 6] }, ...o });
async function live(deps, o) {
  const s = await C.marketingOfferSaveCore(deps, req({ rid: RID, expected_rev: 0, offer: offer(o) }));
  assert.strictEqual(s.status, 200, `premise: saved (${JSON.stringify(s.body)})`);
  const p = await C.marketingOfferSetStateCore(deps, req({ rid: RID, offer_id: s.body.offer.id, to: 'active', expected_rev: 1 }));
  assert.strictEqual(p.status, 200, `premise: published (${JSON.stringify(p.body)})`);
  return s.body.offer.id;
}
// the menu as the endpoint serves it, with the offers memo settled (the decoration never blocks: the first serve starts the read)
async function served(fs, db, { at = NOW, memo = new Map(), sw = {}, read } = {}) {
  const inflight = new Map();
  const o = { rtdb: db, memo, inflight, now: () => at, switchState: sw, ...(read ? { read } : {}) };   // sw: the switch memo (marketing/switch-memo), per instance
  const trigger = await quiet(() => buildPublicMenu(fs, RID, { ...base, offers: o }));   // the response that TRIGGERS the reads (Codex r2)
  await Promise.all([...inflight.values()]);
  const r = await quiet(() => buildPublicMenu(fs, RID, { ...base, offers: o }));
  r.trigger = trigger;
  return r;
}
const { canonicalJson } = require('./canonical-json');   // public-menu.js's own (line 31)
const etagOf = (rid, body) => `"${crypto.createHash('sha256').update(`${rid} ${REPRESENTATION_VERSION} ${canonicalJson(body)}`).digest('hex')}"`;
function canonical(v) { if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`; if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`; return JSON.stringify(v); }

(async () => {
  try {
    // ── 1. OFF: no key; the body and ETag are the undecorated ones (byte-identical) ──
    {
      const { fs, db, deps } = await world({ on: false });
      await C.marketingOfferSaveCore(deps, req({ rid: RID, expected_rev: 0, offer: offer() }));   // refused: offers off
      const off = await served(fs, db);
      const undecorated = await served(fs, db, { read: async () => { throw new Error('down'); } });   // the read failing: the pre-offers serve
      assert.ok(!('offers' in off.body), 'OFF: no offers key');
      assert.deepStrictEqual([off.body, off.etag], [undecorated.body, undecorated.etag], 'OFF: body + ETag byte-identical to the undecorated serve');
      assert.strictEqual(off.etag, etagOf(RID, off.body), 'premise: the ETag is over rid + representation + the canonical body (public-menu.js)');
      assert.strictEqual(REPRESENTATION_VERSION, '1d.4', 'offers add NO representation bump (Q-A): the base→head ETag move is dish-stats\' approved 1d.3 → 1d.4 (s2b-off-golden peels it)');
      ok('OFF: the key is absent and the body + ETag are byte-identical to the undecorated menu');
    }

    // ── 1a. the branch's brand, by THE writer's rule (brand-model brandIdOf — advisor 11-14: production's restaurants are unenriched legacy
    //        singletons): a legacy singleton with NO identity.brand_id publishes AND serves; the identity wins over a rid named like a brand ──
    {
      const { fs, db, deps } = await world({ legacy: true });
      await live(deps, { name: 'Legado' });
      assert.ok(db.get(`marketing_brand/${RID}/live/${RID}`), 'premise: the REAL writer mirrored under the legacy brand (= the rid)');
      const r = await served(fs, db);
      assert.strictEqual(r.body.offers && r.body.offers.length, 1, 'an unenriched legacy singleton (no identity.brand_id) SERVES its live offer');
      ok('a legacy singleton without identity.brand_id publishes AND serves (the reader resolves as the writer does)');
    }
    {
      const { fs, db, deps } = await world();
      await live(deps, { name: 'Diez' });
      db.set(`brands/${RID}`, { name: 'Señuelo', active: true, locations: { [RID]: 'member' }, activation: { state: 'legacy', since: 1 } });
      db.set(`marketing_brand/${RID}/live/${RID}/o_${'z'.repeat(12)}`, db.get(`marketing_brand/xb/live/${RID}/${Object.keys(db.get(`marketing_brand/xb/live/${RID}`))[0]}`));   // a decoy under a brand named like the rid
      db.set(`marketing_brand/xb/live/${RID}`, null);
      assert.ok(!('offers' in (await served(fs, db)).body), 'identity.brand_id WINS: the rid-named brand\'s decoy is never read');
      db.set(`restaurants/${RID}/identity/brand_id`, 'NOT A BRAND');
      assert.ok(!('offers' in (await served(fs, db)).body), 'a malformed identity.brand_id ⇒ nothing served (never a guess)');
      ok('identity.brand_id wins over a rid named like a brand; a malformed one ⇒ nothing served');
    }

    // ── 1b. the switch turned OFF (the REAL config writer) WHILE offers are live: the mirror is never served ──
    {
      const { fs, db, deps } = await world();
      await live(deps, { name: 'Diez' });
      assert.strictEqual((await served(fs, db)).body.offers.length, 1, 'premise: ON serves the live offer');
      assert.strictEqual((await CFG.writeMarketingConfig(db, { expected: 1, config: { offers_enabled: false, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } }, actor: 'cli:op', now: 2 })).ok, true, 'premise: the owner turned offers off');
      const off = await served(fs, db);
      const undecorated = await served(fs, db, { read: async () => { throw new Error('down'); } });
      assert.ok(!('offers' in off.body), 'OFF with live offers: no offers key');
      assert.deepStrictEqual([off.body, off.etag], [undecorated.body, undecorated.etag], 'OFF with live offers: body + ETag byte-identical to the undecorated serve');
      db.set('platform_config/marketing', 'garbage');
      assert.ok(!('offers' in (await served(fs, db)).body), 'a malformed config with live offers ⇒ off ⇒ no key');
      ok('the switch off while offers are live (or a malformed config) ⇒ the mirror is never served; byte-identical to the undecorated menu');
    }

    // ── 1c. the config READ fails while offers are live: never a guessed «on» ──
    {
      const { fs, db, deps } = await world();
      await live(deps, { name: 'Diez' });
      const down = { ...db, ref: (p) => (p === 'platform_config/marketing' ? { once: async () => { throw new Error('config down'); }, get: async () => { throw new Error('config down'); } } : db.ref(p)) };
      assert.strictEqual((await CFG.readMarketingConfig(down)).unavailable, true, 'premise: the config read fails ⇒ unavailable');
      assert.ok(!('offers' in (await served(fs, down)).body), 'a config outage with live offers: no offers key');
      ok('a config outage while offers are live ⇒ the key is absent (never a guessed «on»)');
    }

    // ── 1c2. the READ's OWN switch check (defense in depth behind the switch memo): the switch memo still says ON (fresh, < SWITCH_TTL),
    //         the owner has just turned offers OFF — or the config read fails — and the offers memo misses ⇒ its read serves nothing ──
    {
      const { fs, db, deps } = await world();
      await live(deps, { name: 'Diez' });
      const sw = {};
      assert.strictEqual((await served(fs, db, { sw })).body.offers.length, 1, 'premise: ON serves the live offer (the switch memo primed ON)');
      assert.strictEqual((await CFG.writeMarketingConfig(db, { expected: 1, config: { offers_enabled: false, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } }, actor: 'cli:op', now: 2 })).ok, true, 'premise: the REAL config writer turned offers OFF');
      assert.strictEqual(SW.switchOn('offers_enabled', { rtdb: db, now: () => NOW, switchState: sw }), true, 'premise: the switch memo still says ON (fresh)');
      assert.ok(!('offers' in (await served(fs, db, { sw })).body), 'switch memo ON, config OFF, offers memo miss: the read itself serves nothing');
      const down = { ...db, ref: (p) => (p === 'platform_config/marketing' ? { once: async () => { throw new Error('config down'); }, get: async () => { throw new Error('config down'); } } : db.ref(p)) };
      const sw2 = {};
      await CFG.writeMarketingConfig(db, { expected: 2, config: { offers_enabled: true, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } }, actor: 'cli:op', now: 3 });
      assert.strictEqual((await served(fs, db, { sw: sw2 })).body.offers.length, 1, 'premise: back ON, the switch memo primed ON');
      assert.ok(!('offers' in (await served(fs, down, { sw: sw2 })).body), 'switch memo ON, config read FAILS, offers memo miss: the read itself serves nothing');
      ok('the read\'s own switch check: a fresh-ON switch memo never serves past a config OFF or a config outage');
    }

    // ── 1d. Codex r1 P1-3: a WARM instance (its decoration memo still fresh and holding the offer). The owner turns offers OFF, or the
    //        switch read fails ⇒ the key is absent at the next switch read (≤ SWITCH_TTL), never after the memo's 6-min stale window ──
    {
      const { fs, db, deps } = await world();
      await live(deps, { name: 'Diez' });
      const memo = new Map(); const sw = {};
      assert.strictEqual((await served(fs, db, { memo, sw })).body.offers.length, 1, 'premise: a warm instance serves the offer');
      assert.strictEqual((await CFG.writeMarketingConfig(db, { expected: 1, config: { offers_enabled: false, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } }, actor: 'cli:op', now: 2 })).ok, true, 'premise: the owner turned offers off');
      const early = await served(fs, db, { memo, sw, at: NOW + SW.REFRESH_AT_MS - 1 });
      assert.strictEqual(early.trigger.body.offers.length, 1, 'the accepted bound: before the switch refreshes (< REFRESH_AT) the last ON stands');
      const t1 = NOW + SW.SWITCH_TTL_MS;
      assert.strictEqual(sw.rec.at, NOW, 'premise: no refresh started before REFRESH_AT — the ON read is from NOW, so at t1 it is exactly SWITCH_TTL old');
      const off = await served(fs, db, { memo, sw, at: t1 });
      assert.ok(!('offers' in off.trigger.body), 'WARM memo, the switch ON read EXPIRED (hard, at SWITCH_TTL) ⇒ the TRIGGERING response is already absent');
      assert.ok(memo.get(RID).ok && t1 - memo.get(RID).at < OS.OK_TTL_MS && memo.get(RID).raw.on === true, 'premise: the decoration memo is still FRESH and still holds «on»');
      assert.ok(!('offers' in off.body), 'WARM memo, offers turned OFF ⇒ absent at the next switch read (the memo notwithstanding)');
    }
    {
      const { fs, db, deps } = await world();
      await live(deps, { name: 'Diez' });
      const memo = new Map(); const sw = {};
      assert.strictEqual((await served(fs, db, { memo, sw })).body.offers.length, 1, 'premise: a warm instance serves the offer');
      const down = { ...db, ref: (p) => (p === 'platform_config/marketing' ? { once: async () => { throw new Error('config down'); }, get: async () => { throw new Error('config down'); } } : db.ref(p)) };
      const r = await served(fs, down, { memo, sw, at: NOW + SW.SWITCH_TTL_MS });
      assert.ok(!('offers' in r.trigger.body), 'WARM memo, the switch read EXPIRED ⇒ the TRIGGERING response is absent (never a stale «on» while refreshing)');
      assert.ok(!('offers' in r.body), 'WARM memo, the switch read FAILS ⇒ absent (fail-closed), never the stale «on»');
      ok('a WARM instance: offers turned OFF, or the switch read failing, ⇒ absent at the next switch read, whatever the decoration memo holds');
    }

    // ── 2. ON: exactly the all-audience live offers, in the public shape; ON moves the ETag by itself ──
    {
      const { fs, db, deps, menu } = await world();
      const before = await served(fs, db);
      assert.ok(!('offers' in before.body), 'premise: no live offer yet ⇒ no key');
      const k0 = menu.items[0].key;
      const otherCat = menu.items.find((it) => it.display.cat !== menu.items[0].display.cat).display.cat;   // a category without k0 (the overlap rule)
      await live(deps, { name: 'Diez por ciento', params: { pct: 10, max_cents: 15000 } });
      await live(deps, { name: 'Envío', type: 'envio', params: { min_cents: 30000 } });
      await live(deps, { name: '2x1', type: 'bogo', params: { items: [k0], free_per_order: 1 } });
      await live(deps, { name: 'Pizzas', type: 'bogo', params: { cats: [otherCat], free_per_order: 1 }, schedule: { start: NOW + 2 * DAY, days: [5, 6], window: { from: 1260, to: 0 } } });
      await live(deps, { name: 'Bienvenida', type: 'nuevos', audience: 'new', params: { off_cents: 5000 } });
      await live(deps, { name: 'Vuelve', type: 'pct', audience: 'returning', params: { pct: 15 } });
      const paused = await live(deps, { name: 'Pausada', type: 'lps', params: { off_cents: 5000, min_cents: 30000 } });
      assert.strictEqual((await C.marketingOfferSetStateCore(deps, req({ rid: RID, offer_id: paused, to: 'paused_owner', expected_rev: 2 }))).status, 200, 'premise: paused');
      const on = await served(fs, db);
      const sched = { start: NOW + DAY, end: NOW + 30 * DAY, days: [0, 1, 2, 3, 4, 5, 6] };
      assert.deepStrictEqual(on.body.offers, [
        { type: 'bogo', params: { items: [k0], free_per_order: 1 }, schedule: sched },
        { type: 'envio', params: { min_cents: 30000 }, schedule: sched },
        { type: 'pct', params: { pct: 10, max_cents: 15000 }, schedule: sched },
        { type: 'bogo', params: { cats: [otherCat], free_per_order: 1 }, schedule: { start: NOW + 2 * DAY, days: [5, 6], window: { from: 1260, to: 0 } } },
      ], 'served: the all-audience live offers only, public params (a category offer serves its cats), sorted by start then type');
      assert.ok(!JSON.stringify(on.body.offers).match(/Diez|Envío|2x1|Pizzas|"name"|"caps"|"rev"|brand_id|o_[a-z2-7]{12}/), 'never a name, caps, rev, brand or offer id');
      assert.notStrictEqual(on.etag, before.etag, 'ON: the body moves the ETag by itself (no representation bump)');
      assert.strictEqual(on.etag, etagOf(RID, on.body), 'the ETag is over the served body');
      ok('ON: exactly the all-audience live offers (not nuevos / returning / paused), public shape, no name / caps / ids; the ETag follows the body');
      // the directory flag (shape set by capp, advisor 11-14): the public AMOUNTS of the offers inside their window NOW
      const flagAt = async (t) => {   // the memo as a settled read at t; the switch by its REAL read at t
        const d = { rtdb: db, memo: new Map([[RID, { ok: true, raw: { on: true, live: db.get(`marketing_brand/xb/live/${RID}`) }, at: t }]]), inflight: new Map(), switchState: {}, now: () => t };
        OS.offerFlagOf(RID, d); await Promise.all([...d.inflight.values()]);
        return OS.offerFlagOf(RID, d);
      };
      assert.strictEqual((await flagAt(NOW)), null, 'before any start ⇒ no flag');
      const satNight = NOW + 5 * DAY + 10 * 3600000;          // Sat 21 Nov 22:00 HN: inside 21:00–00:00
      assert.ok(!JSON.stringify((await flagAt(satNight))).match(/name|items|cats|caps|schedule|days|start|window|max_cents|free_per_order|"rev"|brand|o_[a-z2-7]{12}/), 'no private field ever appears (no max_cents, items, schedule, name, id)');
      const tue = NOW + DAY;                                   // Tue 17 Nov 12:00 HN: the all-day offers are in window; the Fri/Sat 21:00–00:00 one is not
      assert.deepStrictEqual((await flagAt(tue)), { offers: [{ type: 'envio', min_cents: 30000 }, { type: 'pct', pct: 10 }, { type: 'bogo' }] },
        'the flag: envío carries its minimum (rule 10), pct its percent, bogo no amount; the out-of-window category offer is absent');
      assert.deepStrictEqual((await flagAt(satNight)).offers.filter((o) => o.type === 'bogo').length, 2, 'inside its window the category offer joins');
      assert.deepStrictEqual((await flagAt(NOW + 5 * DAY)).offers.filter((o) => o.type === 'bogo').length, 1, 'Saturday noon: outside 21:00–00:00 ⇒ absent');
      assert.strictEqual((await flagAt(NOW + 31 * DAY)), null, 'past their end (and outside the open-ended category offer\'s Fri/Sat window) ⇒ no flag at all');
      ok('offerFlagOf: { offers: [{ type, pct? , off_cents?, min_cents? }] } inside the window now; ended / out-of-window absent; no private field');
      const later = await served(fs, db, { at: NOW + 31 * DAY });
      assert.deepStrictEqual(later.body.offers.map((o) => o.type), ['bogo'], 'past their end ⇒ ended offers are not served (the open-ended category offer stays)');
      ok('an offer past its end is never served');
    }

    // ── 2b. the flag's cap: ≤ 10 entries ──
    {
      const live = {};
      for (let i = 0; i < 11; i++) {
        const v = OM.validateAuthored(offer({ params: { pct: 5 + 5 * (i % 10) }, schedule: { start: NOW - DAY, days: [0, 1, 2, 3, 4, 5, 6] } }), { isRid: () => true });
        live[`o_${'abcdefghijk'[i].repeat(12)}`] = OM.liveProjection({ ...v.value, rev: 2, state: 'active' }, 'xb');
      }
      assert.strictEqual(OS.flagOf({ on: true, live }, NOW).offers.length, OS.OFFERS_MAX, 'the flag holds at most 10 entries');
      assert.strictEqual(OS.flagOf({ on: false, live }, NOW), null, 'off ⇒ null');
      ok('the flag is capped at 10 entries; off ⇒ null');
    }

    // ── 3. a paused offer is never priced (advisor Q-C): the price path's mirror loses it at once, even while a memo still serves it ──
    {
      const { fs, db, deps } = await world();
      const id = await live(deps, { name: 'Diez' });
      const memo = new Map(); const sw = {};
      const first = await served(fs, db, { memo, sw });
      assert.strictEqual(first.body.offers.length, 1, 'premise: served');
      assert.strictEqual((await C.marketingOfferSetStateCore(deps, req({ rid: RID, offer_id: id, to: 'paused_owner', expected_rev: 2 }))).status, 200);
      { const e = db.get(`marketing_brand/xb/live/${RID}/${id}`) ?? null; assert.ok(e === null || e.removed === true, `paused ⇒ the PRICE PATH's mirror holds no priceable entry (absent or the pause's TOMBSTONE): never priced (${JSON.stringify(e)})`); }
      const within = await quiet(() => buildPublicMenu(fs, RID, { ...base, offers: { rtdb: db, memo, inflight: new Map(), switchState: sw, now: () => NOW + 5 * 1000 } }));   // inside the switch TTL (this cell is the DATA memo's staleness)
      assert.strictEqual(within.body.offers.length, 1, 'within the 60 s memo the menu may still show it — the accepted staleness (the quote refuses)');
      const after = await served(fs, db, { memo, sw, at: NOW + 61 * 1000 });
      assert.ok(!('offers' in after.body), 'past the memo the menu drops it');
      ok('a paused offer is never priced: the price path\'s mirror drops it at once; the menu follows within its memo (accepted staleness)');
    }

    // ── 4. never failing: an outage / timeout / config outage ⇒ the key is absent ──
    {
      const { fs, db } = await world();
      for (const [why, read] of [['an outage', async () => { throw new Error('down'); }], ['a timeout', () => new Promise(() => {})], ['a malformed read', async () => 'garbage']]) {
        const o = { rtdb: db, memo: new Map(), inflight: new Map(), switchState: {}, now: () => NOW, read, timeoutMs: 20 };
        await quiet(() => buildPublicMenu(fs, RID, { ...base, offers: o }));
        await Promise.all([...o.inflight.values()]);
        const r = await quiet(() => buildPublicMenu(fs, RID, { ...base, offers: o }));
        assert.ok(!('offers' in r.body), `${why} ⇒ no offers key (the menu is served)`);
      }
      db.set('platform_config/marketing', 'garbage');
      assert.ok(!('offers' in (await served(fs, db)).body), 'a malformed config ⇒ off ⇒ no key');
      ok('an outage, a timeout, a malformed read or config ⇒ the key is absent; the menu is always served');
    }

    // ── 5. the byte budget: the latest-starting offers drop first ──
    {
      const long = (i) => `legacy dish name ${String(i).padStart(2, '0')} `.padEnd(190, 'x');
      const live = {};
      for (let i = 0; i < 10; i++) {
        const v = OM.validateAuthored(offer({ type: 'bogo', params: { items: Array.from({ length: 10 }, (_, j) => long(i * 10 + j)), free_per_order: 1 }, schedule: { start: NOW + (i + 1) * DAY, days: [1] } }), { isRid: () => true });
        assert.ok(v.ok, 'premise: a valid offer');
        live[`o_${String.fromCharCode(97 + i).repeat(12)}`] = OM.liveProjection({ ...v.value, rev: 2, state: 'active' }, 'xb');
      }
      const sel = OS.selectOffers({ on: true, live }, NOW);
      assert.ok(sel.length < 10 && Buffer.byteLength(canonical(sel)) <= OS.OFFERS_BYTES, `the served field fits OFFERS_BYTES (${sel.length} kept)`);
      assert.deepStrictEqual(sel.map((o) => o.schedule.start), Array.from({ length: sel.length }, (_, i) => NOW + (i + 1) * DAY), 'the earliest-starting are kept; the latest drop first');
      ok(`the worst case is bounded: ${sel.length} of 10 maximal offers fit ${OS.OFFERS_BYTES} B, the latest-starting dropped`);
    }

    FINISHED = true;
    console.log(`offers-serve: ${n}/${n} ok`);
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    process.exitCode = 1;
  }
})();
