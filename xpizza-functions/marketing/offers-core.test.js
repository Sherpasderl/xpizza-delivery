'use strict';
// PLAN-3a-marketing-server r0 steps 1–2 — the portal «Marketing» offer endpoints, end to end over the REAL writers:
//   membership by the REAL roster writer (access/roster mutateRoster: bootstrap_owner / grant_manager), the live menus by the REAL
//   catalog mirror writer (catalog/mirror-rtdb makeRtdbMirror), the switches by the REAL config writer (marketing/config
//   writeMarketingConfig), every offer by the cores under test. The in-memory RTDB adds production's TRANSACTION semantics on top of
//   merchant/_fake-db: the SDK's uncached first run sees null (an `undefined` there aborts; any value commits only if the server is
//   null too, else the callback re-runs on the real node) — never laxer than production.
// Run: node marketing/offers-core.test.js
const assert = require('assert');
const { createFakeDb } = require('../merchant/_fake-db');
const R = require('../access/roster');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { makeRtdbMirrorReader } = require('../catalog/snapshot-fallback');
const CFG = require('./config');
const OM = require('./offer-model');
const C = require('./offers-core');
const { buildMenu } = require('../catalog/catalog-menu');

// a branch's ACTIVE catalog version as the REAL payload builder (catalog-menu buildMenu) reads it from Firestore-shaped snapshots —
// the shape getRestaurantMenu returns in production (items carry display.cat; structure.categories lists the ids)
const snap = (docs) => ({ empty: docs.length === 0, docs: docs.map((v, i) => ({ id: `d${i}`, data: () => v })) });
const versionMenu = (rows, cats) => buildMenu(snap(rows.map(([key, price, cat]) => ({ key, price, display: { price, cat, name: key } }))), snap([]),
  { exists: true, data: () => ({ categories: cats.map((id) => ({ id })), item_order: rows.map((r) => r[0]) }) }, 'test');

let n = 0; let FINISHED = false;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ offers-core: exited without completing (a hang)\n'); process.exitCode = 1; } });
// the mirror entries present (RTDB prunes empty parents; the in-memory fake keeps them — count leaves, never compare the parent)
const mirrored = (fake) => Object.entries(fake.get('marketing_live') || {}).flatMap(([rid, m]) => Object.keys(m || {}).map((id) => `${rid}/${id}`));
const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));

// production transaction semantics over the shared fake (see header)
function prodDb(fake) {
  return {
    ref(p = '') {
      const r = fake.ref(p);
      return { ...r, get: () => r.once(),
        async transaction(fn) {
          for (const pp of fake.failReads) if (String(p).startsWith(pp)) throw new Error(`injected failure: ${p}`);
          const cold = fn(null);
          if (cold === undefined) return { committed: false, snapshot: { val: () => null } };
          if (fake.get(p) === null) { fake.put(p, cold); return { committed: true, snapshot: { val: () => fake.get(p) } }; }
          return r.transaction(fn);
        } };
    },
  };
}

const NOW = Date.UTC(2026, 10, 16, 18);   // Mon 16 Nov 2026 12:00 HN
const DAY = 86400000;
const OWNER = 'ownerMk01', MGR = 'mgrMk0001', STRANGER = 'strngr001', OTHER_OWNER = 'ownerOt01';
const TOK = { [`t-${OWNER}`]: { uid: OWNER }, [`t-${MGR}`]: { uid: MGR }, [`t-${STRANGER}`]: { uid: STRANGER }, [`t-${OTHER_OWNER}`]: { uid: OTHER_OWNER },
  't-cust': { uid: OWNER, customer: true }, 't-hh': { uid: OWNER, handheld: true } };
const verifyIdToken = async (t) => { if (!TOK[t]) throw new Error('bad token'); return TOK[t]; };
const K1 = 'i_aaaaaaaaaaaa', K2 = 'i_bbbbbbbbbbbb', K3 = 'i_cccccccccccc';

async function setup({ switches = { offers_enabled: true, anuncio_enabled: false, collections_enabled: false } } = {}) {
  const fake = createFakeDb({
    brands: {
      tb: { name: 'Tercera', active: true, locations: { tb_centro: 'member', tb_sur: 'member', tb_norte: 'retired', tb_nuevo: 'staged' }, activation: { state: 'on', since: 1 } },
      zt: { name: 'Otra', active: true, locations: { zt_uno: 'member' }, activation: { state: 'on', since: 1 } },
    },
    restaurants: Object.fromEntries(['tb_centro', 'tb_sur', 'tb_norte', 'tb_nuevo', 'zt_uno'].map((rid) => [rid, { identity: { brand_id: rid.split('_')[0], name: rid, active: true, version: 1 } }])),
  });
  const db = prodDb(fake);
  const roster = async (b, actor, op) => assert.deepStrictEqual((await R.mutateRoster({ db: fake, now: () => 1 }, b, actor, op)).ok, true, `premise: roster ${op.type}`);
  await roster('tb', { kind: 'cli', operator: 'op' }, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'Dueña', email: 'd@tb.hn' } });
  await roster('tb', { kind: 'owner', uid: OWNER }, { type: 'grant_manager', uid: MGR, rids: ['tb_centro'] });
  await roster('zt', { kind: 'cli', operator: 'op' }, { type: 'bootstrap_owner', uid: OTHER_OWNER, profile: { name: 'Otro', email: 'o@ot.hn' } });
  const mirror = makeRtdbMirror(db);
  for (const rid of ['tb_centro', 'tb_sur']) await mirror(rid, { version: 'v1', seq: 1, rid, menu: { [K1]: 150, [K2]: 220, ...(rid === 'tb_centro' ? { [K3]: 90 } : {}) }, extras: {} });
  const w = await CFG.writeMarketingConfig(db, { expected: 0, config: { ...switches, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } }, actor: 'cli:op', now: 1 });
  assert.strictEqual(w.ok, true, 'premise: the config writer wrote the switches');
  // each branch's active version: pizzas = K1 + K2 (+ K3 on tb_centro is a drink); a test may add a dish later (CATALOG[rid].push)
  const CATALOG = { tb_centro: [[K1, 150, 'pizzas'], [K2, 220, 'pizzas'], [K3, 90, 'bebidas']], tb_sur: [[K1, 150, 'pizzas'], [K2, 220, 'pizzas']] };
  const CATS = { tb_centro: ['pizzas', 'bebidas', 'vacia'], tb_sur: ['pizzas'] };
  const readCategoryMenu = async (rid) => versionMenu(CATALOG[rid], CATS[rid]);
  const deps = { db, verifyIdToken, now: () => NOW, readMirror: makeRtdbMirrorReader(db), readCategoryMenu };
  return { fake, db, deps, CATALOG };
}
const req = (tok, body, method = 'POST', query) => ({ method, body, query, get: (h) => (h === 'authorization' && tok ? `Bearer ${tok}` : undefined) });
const get = (deps, tok, rid) => C.getMarketingCore(deps, req(tok, undefined, 'GET', { rid }));
const offer = (o = {}) => ({ name: '2 por 1 en clásicas', type: 'bogo', params: { items: [K1], free_per_order: 1 }, audience: 'all', branches: ['tb_centro'],
  schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [5, 6], window: { from: 1260, to: 0 } }, caps: { redemptions: 50, spend_cents: null, weekly: false }, ...o });
const save = (deps, tok, body) => C.marketingOfferSaveCore(deps, req(tok, { rid: 'tb_centro', expected_rev: 0, ...body }));
const move = (deps, tok, body) => C.marketingOfferSetStateCore(deps, req(tok, { rid: 'tb_centro', ...body }));
const created = async (deps, o) => { const r = await save(deps, `t-${OWNER}`, { offer: offer(o) }); assert.strictEqual(r.status, 200, `premise: created (${JSON.stringify(r.body)})`); return r.body.offer; };
const published = async (deps, o) => { const d = await created(deps, o); const r = await move(deps, `t-${OWNER}`, { offer_id: d.id, to: 'active', expected_rev: 1 }); assert.strictEqual(r.status, 200, `premise: published (${JSON.stringify(r.body)})`); return r.body.offer; };

(async () => {
  try {
    // ── 1. OFF: every switch stated, nothing written, nothing read past the config ──
    {
      const { fake, deps } = await setup({ switches: { offers_enabled: false, anuncio_enabled: false, collections_enabled: false } });
      const before = clone(fake.get(''));
      const r = await get(deps, `t-${OWNER}`, 'tb_centro');
      assert.deepStrictEqual([r.status, r.body], [200, { ok: true, switches: { offers_enabled: false, anuncio_enabled: false, collections_enabled: false }, offers: [] }], 'OFF: the read states three falses and no list');
      const s = await save(deps, `t-${OWNER}`, { offer: offer() });
      assert.deepStrictEqual([s.status, s.body.error], [409, 'offers_disabled'], 'OFF: a save is refused offers_disabled');
      assert.deepStrictEqual(fake.get(''), before, 'OFF: nothing written');
      ok('OFF: switches stated false, the save refused, nothing written');
      fake.put('platform_config/marketing', { policy_version: 2, offers_enabled: 'yes', anuncio_enabled: true, collections_enabled: true, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } });
      assert.deepStrictEqual((await get(deps, `t-${OWNER}`, 'tb_centro')).body.switches, { offers_enabled: false, anuncio_enabled: false, collections_enabled: false }, 'a MALFORMED config enables nothing');
      fake.failReads.add('platform_config');
      assert.deepStrictEqual((await get(deps, `t-${OWNER}`, 'tb_centro')).body.switches, { offers_enabled: false, anuncio_enabled: false, collections_enabled: false }, 'an UNREADABLE config states OFF');
      assert.deepStrictEqual((await save(deps, `t-${OWNER}`, { offer: offer() })).status, 503, 'an unreadable config: a write is 503, never on');
      ok('a malformed config enables nothing; an unreadable one states OFF and writes 503');
    }

    // ── 2. authorization ──
    {
      const { fake, deps } = await setup();
      for (const [tok, code] of [[undefined, 401], ['nope', 401], ['t-cust', 403], ['t-hh', 403], [`t-${STRANGER}`, 403], [`t-${OTHER_OWNER}`, 403]]) {
        assert.strictEqual((await get(deps, tok, 'tb_centro')).status, code, `read ${tok} ⇒ ${code}`);
        assert.strictEqual((await save(deps, tok, { offer: offer() })).status, code, `save ${tok} ⇒ ${code}`);
      }
      assert.strictEqual((await get(deps, `t-${MGR}`, 'tb_centro')).status, 200, 'a manager READS their branch');
      const m = await save(deps, `t-${MGR}`, { offer: offer() });
      assert.deepStrictEqual([m.status, m.body.error], [403, 'not_authorized'], 'a manager can NOT edit (Q1: owner only)');
      assert.strictEqual((await get(deps, `t-${MGR}`, 'tb_sur')).status, 403, 'a manager reads only their own branch');
      assert.strictEqual((await get(deps, `t-${OWNER}`, 'tb_norte')).status, 200, 'a retired branch: the owner reads the history');
      const ret = await save(deps, `t-${OWNER}`, { rid: 'tb_norte', offer: offer({ branches: ['tb_norte'] }) });
      assert.strictEqual(ret.status, 403, 'a retired branch: no edit');
      const before = clone(fake.get('marketing_offers'));
      const mixed = await save(deps, `t-${OWNER}`, { offer: offer({ branches: ['tb_centro', 'zt_uno'] }) });   // the foreign branch sorts LAST: every branch is checked, not only the first
      assert.deepStrictEqual([mixed.status, mixed.body.error], [403, 'not_authorized'], 'one branch of another brand ⇒ 403');
      const staged = await save(deps, `t-${OWNER}`, { offer: offer({ branches: ['tb_centro', 'tb_nuevo'] }) });
      assert.deepStrictEqual([staged.status, staged.body.error], [403, 'not_authorized'], 'a staged branch carries no marketing capability ⇒ 403');
      assert.deepStrictEqual(fake.get('marketing_offers'), before, 'refusals wrote nothing');
      ok('auth: guests / customer / handheld / stranger / other brand refused; manager reads only; retired read-only; every branch checked');
    }

    // ── 3. create → the draft record; validation ──
    {
      const { fake, deps } = await setup();
      const d = await created(deps);
      assert.ok(OM.OFFER_ID_RE.test(d.id), 'an opaque offer id');
      const rec = fake.get(`marketing_offers/tb/${d.id}`);
      assert.deepStrictEqual(rec, { v: 1, rev: 1, name: '2 por 1 en clásicas', type: 'bogo', params: { items: [K1], free_per_order: 1 }, audience: 'all', branches: ['tb_centro'],
        schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [5, 6], window: { from: 1260, to: 0 } }, caps: { redemptions: 50, weekly: false },
        state: 'draft', created_by: OWNER, created_at: NOW, updated_at: NOW }, 'the stored draft: exact keys, nulls absent, no price copy');
      assert.deepStrictEqual(mirrored(fake), [], 'a draft has no live mirror');
      assert.deepStrictEqual([d.status, d.state, d.rev], ['draft', 'draft', 1]);
      ok('create: the exact draft record, no mirror');
      const bad = [
        [{ params: { items: ['i_zzzzzzzzzzzz'], free_per_order: 1 } }, 'unknown_dish'],
        [{ type: 'pct', params: { pct: 55 } }, 'bad_params'],
        [{ type: 'pct', params: { pct: 12 } }, 'bad_params'],
        [{ type: 'lps', params: { off_cents: 5000, min_cents: 4000 } }, 'bad_params'],
        [{ type: 'nuevos', params: { off_cents: 5000 }, audience: 'all' }, 'nuevos_is_new'],
        [{ name: '   ' }, 'bad_name'],
        [{ schedule: { start: NOW + DAY, end: NOW, days: [1] } }, 'bad_schedule'],
        [{ schedule: { start: NOW + DAY, days: [1], window: { from: 600, to: 600 } } }, 'bad_schedule'],
        [{ caps: { redemptions: 0, weekly: false } }, 'bad_caps'],
        [{ extra: 1 }, 'bad_shape'],
      ];
      for (const [o, reason] of bad) {
        const r = await save(deps, `t-${OWNER}`, { offer: offer(o) });
        assert.deepStrictEqual([r.status, r.body.reason], [400, reason], `validation: ${reason} (${JSON.stringify(o)})`);
      }
      const both = await save(deps, `t-${OWNER}`, { offer: offer({ params: { cats: ['pizzas'], items: [K1], free_per_order: 1 } }) });
      assert.deepStrictEqual([both.status, both.body.reason], [400, 'bad_params'], 'the builder sends items OR cats, never both (items are the server\'s)');
      ok('validation: dish on the live menu, pct 5..50 step 5, lps min ≥ off, nuevos ⇒ new, schedule, caps, exact keys, items xor cats');
    }

    // ── 3b. bogo by CATEGORY (advisor 11-14): resolved from each branch's active version at save AND publish, frozen in between ──
    {
      const { fake, deps, CATALOG } = await setup();
      const cat = (o = {}) => offer({ name: '2 por 1 en pizzas', params: { cats: ['pizzas'], free_per_order: 1 }, ...o });
      const r = await save(deps, `t-${OWNER}`, { offer: cat({ branches: ['tb_centro', 'tb_sur'] }) });
      assert.strictEqual(r.status, 200, `premise: saved (${JSON.stringify(r.body)})`);
      assert.deepStrictEqual(fake.get(`marketing_offers/tb/${r.body.offer.id}/params`), { cats: ['pizzas'], items: [K1, K2].sort(), free_per_order: 1 }, 'saved: the category AND its resolved dishes (the union over the branches)');
      assert.deepStrictEqual(r.body.offer.params.items, [K1, K2].sort(), 'the review shows the resolved product list («Aplica a: …»)');
      ok('category save: dishes resolved from the active versions, stored with the category');
      for (const [cats, reason, rid] of [[['nada'], 'unknown_category', 'tb_centro'], [['vacia'], 'empty_category', 'tb_centro'], [['bebidas'], 'unknown_category', 'tb_sur']]) {
        const x = await save(deps, `t-${OWNER}`, { offer: cat({ params: { cats, free_per_order: 1 }, branches: ['tb_centro', 'tb_sur'] }) });
        assert.deepStrictEqual([x.status, x.body.reason, x.body.rid], [400, reason, rid], `${cats}: ${reason} on ${rid}`);
      }
      ok('an unknown or empty category on ANY branch is refused, naming the branch');
      CATALOG.tb_centro.push(['i_dddddddddddd', 180, 'pizzas']);   // a dish added BEFORE publishing
      const p = await move(deps, `t-${OWNER}`, { offer_id: r.body.offer.id, to: 'active', expected_rev: 1 });
      assert.strictEqual(p.status, 200);
      const want = [K1, K2, 'i_dddddddddddd'].sort();
      assert.deepStrictEqual(fake.get(`marketing_live/tb_sur/${r.body.offer.id}/params/items`), want, 'publish RE-RESOLVES: the new dish is in the mirror');
      CATALOG.tb_centro.push(['i_eeeeeeeeeeee', 200, 'pizzas']);   // a dish added AFTER publishing
      assert.deepStrictEqual(fake.get(`marketing_live/tb_centro/${r.body.offer.id}/params/items`), want, 'frozen: a dish added after publish is NOT covered');
      const re = await save(deps, `t-${OWNER}`, { offer_id: r.body.offer.id, expected_rev: 2, offer: cat({ branches: ['tb_centro', 'tb_sur'], caps: { redemptions: 60, spend_cents: null, weekly: false } }) });
      assert.strictEqual(re.status, 200, `a re-save of the live category offer is allowed (${JSON.stringify(re.body)})`);
      assert.deepStrictEqual(fake.get(`marketing_live/tb_centro/${r.body.offer.id}/params/items`), [...want, 'i_eeeeeeeeeeee'].sort(), '…and covers the dish added since');
      ok('publish re-resolves; frozen between; a re-save of the live offer picks up a dish added since');
      const dish = await created(deps, { name: 'Solo K1' });
      const clash = await move(deps, `t-${OWNER}`, { offer_id: dish.id, to: 'active', expected_rev: 1 });
      assert.deepStrictEqual([clash.status, clash.body.error, clash.body.with], [409, 'overlap', ['2 por 1 en pizzas']], 'a dish offer on a dish the category covers clashes by its resolved items');
      ok('the overlap rule sees a category offer through its resolved dishes');
    }

    // ── 4. publish → the live mirror; pause / resume / end; CAS ──
    {
      const { fake, deps } = await setup();
      const d = await created(deps, { branches: ['tb_centro', 'tb_sur'] });
      const p = await move(deps, `t-${OWNER}`, { offer_id: d.id, to: 'active', expected_rev: 1 });
      assert.deepStrictEqual([p.status, p.body.offer.state, p.body.offer.status, p.body.offer.rev], [200, 'active', 'scheduled', 2], 'publish ⇒ active, shown «scheduled» before its start');
      const rec = fake.get(`marketing_offers/tb/${d.id}`);
      for (const rid of ['tb_centro', 'tb_sur']) assert.deepStrictEqual(fake.get(`marketing_live/${rid}/${d.id}`), OM.liveProjection(rec, 'tb'), `the mirror of ${rid} is the record's projection`);
      assert.deepStrictEqual(Object.keys(fake.get(`marketing_live/tb_centro/${d.id}`)).sort(), ['audience', 'brand_id', 'caps', 'name', 'params', 'rev', 'schedule', 'type'], 'the mirror carries no state, author or timestamps');
      ok('publish: active, every branch mirrored with the exact projection');
      const stale = await move(deps, `t-${OWNER}`, { offer_id: d.id, to: 'paused_owner', expected_rev: 1 });
      assert.deepStrictEqual([stale.status, stale.body], [409, { error: 'superseded', current_rev: 2 }], 'a stale rev ⇒ superseded');
      const pa = await move(deps, `t-${OWNER}`, { offer_id: d.id, to: 'paused_owner', expected_rev: 2 });
      assert.strictEqual(pa.status, 200);
      assert.deepStrictEqual(mirrored(fake), [], 'paused ⇒ no mirror on any branch');
      const re = await move(deps, `t-${OWNER}`, { offer_id: d.id, to: 'active', expected_rev: 3 });
      assert.strictEqual(re.status, 200);
      assert.strictEqual(fake.get(`marketing_live/tb_sur/${d.id}/rev`), 4, 'resume ⇒ mirrored again at the new rev');
      const en = await move(deps, `t-${OWNER}`, { offer_id: d.id, to: 'ended', expected_rev: 4 });
      assert.deepStrictEqual([en.status, en.body.offer.ended_reason], [200, 'owner']);
      assert.deepStrictEqual(mirrored(fake), [], 'ended ⇒ no mirror');
      const again = await move(deps, `t-${OWNER}`, { offer_id: d.id, to: 'active', expected_rev: 5 });
      assert.deepStrictEqual([again.status, again.body.error], [409, 'bad_transition'], 'an ended offer never comes back');
      ok('pause / resume / end move the mirror; stale rev superseded; ended is final');
      const ghost = await move(deps, `t-${OWNER}`, { offer_id: 'o_aaaaaaaaaaaa', to: 'ended', expected_rev: 1 });
      assert.deepStrictEqual([ghost.status, ghost.body.error], [404, 'not_found'], 'an unknown offer ⇒ 404');
      const past = await created(deps, { schedule: { start: NOW - DAY, days: [1] } });
      const pp = await move(deps, `t-${OWNER}`, { offer_id: past.id, to: 'active', expected_rev: 1 });
      assert.deepStrictEqual([pp.status, pp.body.reason], [400, 'start_past'], 'a draft whose start has passed is not published');
      const nos = await created(deps, { schedule: { days: [1] } });
      assert.deepStrictEqual((await move(deps, `t-${OWNER}`, { offer_id: nos.id, to: 'active', expected_rev: 1 })).body.reason, 'start_required', 'a draft may lack a start; publishing needs one');
      ok('publish needs a future start; unknown offer 404');
    }

    // ── 5. the live-edit allowlist (caps up, end later) ──
    {
      const { fake, deps } = await setup();
      const a = await published(deps);
      const edit = (o, rev) => save(deps, `t-${OWNER}`, { offer_id: a.id, expected_rev: rev, offer: offer(o) });
      for (const [o, field] of [[{ name: 'Otro nombre' }, 'name'], [{ caps: { redemptions: 40, spend_cents: null, weekly: false } }, 'caps'], [{ caps: { redemptions: 50, spend_cents: 1000, weekly: false } }, 'caps'],
        [{ schedule: { start: NOW + DAY, end: NOW + 20 * DAY, days: [5, 6], window: { from: 1260, to: 0 } } }, 'schedule'], [{ params: { items: [K2], free_per_order: 1 } }, 'params']]) {
        const r = await edit(o, 2);
        assert.deepStrictEqual([r.status, r.body.error, r.body.field], [409, 'live_edit_not_allowed', field], `live edit of ${field} refused`);
      }
      const up = await edit({ caps: { redemptions: 80, spend_cents: null, weekly: false }, schedule: { start: NOW + DAY, end: null, days: [5, 6], window: { from: 1260, to: 0 } } }, 2);
      assert.deepStrictEqual([up.status, up.body.offer.rev, up.body.offer.caps.redemptions, up.body.offer.schedule.end], [200, 3, 80, null], 'caps up + no end ⇒ allowed');
      assert.deepStrictEqual(fake.get(`marketing_live/tb_centro/${a.id}`), OM.liveProjection(fake.get(`marketing_offers/tb/${a.id}`), 'tb'), 'the mirror follows the edit');
      ok('live edit: only a raised cap and a later end; the mirror follows');
    }

    // ── 6. the overlap rule + MAX_LIVE ──
    {
      const { deps } = await setup();
      await published(deps);   // K1, Fri+Sat 21:00–00:00
      const sat = await created(deps, { name: 'Pizza sábado noche', schedule: { start: NOW + DAY, days: [6], window: { from: 1410, to: 60 } } });
      const r = await move(deps, `t-${OWNER}`, { offer_id: sat.id, to: 'active', expected_rev: 1 });
      assert.deepStrictEqual([r.status, r.body.error, r.body.with], [409, 'overlap', ['2 por 1 en clásicas']], 'the same dish on overlapping hours ⇒ overlap, named');
      const sun = await created(deps, { name: 'Domingo madrugada', schedule: { start: NOW + DAY, days: [0], window: { from: 0, to: 120 } } });
      assert.strictEqual((await move(deps, `t-${OWNER}`, { offer_id: sun.id, to: 'active', expected_rev: 1 })).status, 200, 'Sat 21:00–00:00 ends AT midnight: Sunday 00:00 does not clash');
      const other = await created(deps, { name: 'Otro plato', params: { items: [K2], free_per_order: 1 } });
      assert.strictEqual((await move(deps, `t-${OWNER}`, { offer_id: other.id, to: 'active', expected_rev: 1 })).status, 200, 'another dish never clashes');
      const later = await created(deps, { name: 'Diciembre', schedule: { start: NOW + 31 * DAY, days: [5, 6], window: { from: 1260, to: 0 } } });
      assert.strictEqual((await move(deps, `t-${OWNER}`, { offer_id: later.id, to: 'active', expected_rev: 1 })).status, 200, 'dates that do not meet never clash');
      ok('overlap: same dish × overlapping hours refused with names; midnight edge, other dishes and later dates pass');
      const k2sat = await published(deps, { name: 'Sábado tarde K2', params: { items: [K2], free_per_order: 1 }, schedule: { start: NOW + 40 * DAY, days: [6], window: { from: 1380, to: 60 } } });
      const k2sun = await created(deps, { name: 'Domingo K2', params: { items: [K2], free_per_order: 1 }, schedule: { start: NOW + 40 * DAY, days: [0], window: { from: 30, to: 120 } } });
      const wrap = await move(deps, `t-${OWNER}`, { offer_id: k2sun.id, to: 'active', expected_rev: 1 });
      assert.deepStrictEqual([wrap.status, wrap.body.error, wrap.body.with], [409, 'overlap', ['Sábado tarde K2']], 'Saturday 23:00–01:00 runs into SUNDAY: the week wraps');
      void k2sat;
      ok('overlap across the week boundary (Saturday night into Sunday)');
      for (let i = 0; i < 5; i++) await published(deps, { name: `Pct ${i}`, type: 'pct', params: { pct: 10 } });
      const eleventh = await created(deps, { name: 'Once', type: 'envio', params: { min_cents: 0 } });
      const t = await move(deps, `t-${OWNER}`, { offer_id: eleventh.id, to: 'active', expected_rev: 1 });
      assert.deepStrictEqual([t.status, t.body.error], [409, 'too_many_live'], 'the 11th live offer on a branch ⇒ too_many_live');
      ok('MAX_LIVE: 10 scheduled+live offers per branch');
    }

    // ── 6b. the race (advisor 11-14, rule 5): two clashing publishes at once — the per-branch transaction lets exactly one through ──
    {
      const { fake, deps } = await setup();
      const a = await created(deps, { name: 'Carrera A' });
      const b = await created(deps, { name: 'Carrera B', schedule: { start: NOW + DAY, days: [6], window: { from: 1380, to: 60 } } });
      const [ra, rb] = await Promise.all([a, b].map((d) => move(deps, `t-${OWNER}`, { offer_id: d.id, to: 'active', expected_rev: 1 })));
      const codes = [ra.status, rb.status].sort();
      assert.deepStrictEqual(codes, [200, 409], `exactly one of two simultaneous publishes wins (${JSON.stringify([ra.body, rb.body])})`);
      const [win, lose, loser] = ra.status === 200 ? [a, rb, b] : [b, ra, a];
      assert.deepStrictEqual([lose.body.error, lose.body.rid, lose.body.with, lose.body.current_rev], ['overlap', 'tb_centro', [win.name], 3], 'the loser: a typed overlap refusal naming the winner, with its record\'s current rev');
      assert.deepStrictEqual(mirrored(fake), [`tb_centro/${win.id}`], 'one mirror: the winner\'s');
      const back = fake.get(`marketing_offers/tb/${loser.id}`);
      assert.deepStrictEqual([back.state, back.rev], ['draft', 3], 'the loser\'s record is put back to draft (a second CAS)');
      ok('race: two clashing publishes at once ⇒ exactly one wins; the other refused (overlap), its record back to draft, one mirror');
      // a live edit that would now clash (a later end) is judged the same way and undone
      const c = await published(deps, { name: 'Diciembre K3', params: { items: [K3], free_per_order: 1 }, schedule: { start: NOW + DAY, end: NOW + 10 * DAY, days: [1], window: null } });
      await published(deps, { name: 'Enero K3', params: { items: [K3], free_per_order: 1 }, schedule: { start: NOW + 12 * DAY, end: NOW + 20 * DAY, days: [1], window: null } });
      const ext = await save(deps, `t-${OWNER}`, { offer_id: c.id, expected_rev: 2, offer: offer({ name: 'Diciembre K3', params: { items: [K3], free_per_order: 1 }, schedule: { start: NOW + DAY, end: NOW + 15 * DAY, days: [1], window: null } }) });
      assert.deepStrictEqual([ext.status, ext.body.error, ext.body.with], [409, 'overlap', ['Enero K3']], 'a later end that runs into another offer is refused');
      assert.strictEqual(fake.get(`marketing_live/tb_centro/${c.id}/schedule/end`), NOW + 10 * DAY, 'the edited offer keeps its OLD mirror');
      ok('a live edit whose later end would clash is refused; the old mirror stays');
    }

    // ── 7. the read: this branch's offers, statuses, drift; repeat; the 180-day prune ──
    {
      const { fake, deps } = await setup();
      const a = await published(deps, { branches: ['tb_centro', 'tb_sur'] });
      const sur = await published(deps, { name: 'Solo Sur', type: 'pct', params: { pct: 15 }, branches: ['tb_sur'] });
      const r = await get(deps, `t-${OWNER}`, 'tb_centro');
      assert.deepStrictEqual(r.body.offers.map((o) => o.id), [a.id], 'the read lists only offers touching this branch');
      assert.deepStrictEqual(r.body.switches, { offers_enabled: true, anuncio_enabled: false, collections_enabled: false });
      assert.ok(!('created_by' in r.body.offers[0]), 'no author uid in the read');
      fake.put(`marketing_live/tb_centro/${a.id}`, null);
      assert.strictEqual((await get(deps, `t-${OWNER}`, 'tb_centro')).body.offers[0].live_drift, true, 'a missing mirror is reported as live_drift');
      const heal = await move(deps, `t-${OWNER}`, { offer_id: a.id, to: 'paused_owner', expected_rev: 2 });
      assert.strictEqual(heal.status, 200);
      assert.strictEqual((await get(deps, `t-${OWNER}`, 'tb_centro')).body.offers[0].live_drift, undefined, 'the next state write heals it');
      void sur;
      ok('read: per-branch list, no author, drift reported and healed');
      const deps2 = { ...deps, now: () => NOW + 31 * DAY };
      const ended = (await get(deps2, `t-${OWNER}`, 'tb_centro')).body.offers[0];
      assert.strictEqual(ended.status, 'paused_owner', 'premise: paused stays paused past its end (no job)');
      const rp0 = await C.marketingOfferRepeatCore(deps2, req(`t-${OWNER}`, { rid: 'tb_centro', offer_id: a.id }));
      assert.deepStrictEqual([rp0.status, rp0.body.error], [409, 'not_ended'], 'repeat needs an ended offer');
      const fin = await published(deps, { name: 'Corta', type: 'pct', params: { pct: 20 }, schedule: { start: NOW + DAY, end: NOW + 2 * DAY, days: [0, 1, 2, 3, 4, 5, 6] } });
      const rp = await C.marketingOfferRepeatCore(deps2, req(`t-${OWNER}`, { rid: 'tb_centro', offer_id: fin.id }));
      assert.strictEqual(rp.status, 200, 'an offer ended BY ITS SCHEDULE repeats');
      assert.deepStrictEqual([rp.body.offer.state, rp.body.offer.repeated_from, rp.body.offer.schedule.start, rp.body.offer.schedule.end, rp.body.offer.params], ['draft', fin.id, null, null, { pct: 20, max_cents: 0 }], 'repeat: a draft, same set-up, dates cleared');
      ok('repeat: from an ended offer only, dates cleared');
      const { fake: f2, deps: d2 } = await setup();
      const old = await created(d2, { name: 'Vieja' });
      await move(d2, `t-${OWNER}`, { offer_id: old.id, to: 'ended', expected_rev: 1 });
      const d2later = { ...d2, now: () => NOW + 181 * DAY };
      await save(d2later, `t-${OWNER}`, { offer: offer({ name: 'Nueva', schedule: { start: NOW + 182 * DAY, days: [1] } }) });
      assert.strictEqual(f2.get(`marketing_offers/tb/${old.id}`), null, 'Q4: an offer ended 181 days ago leaves with the next create');
      ok('prune: ended > 180 days removed by the next create');
    }

    // ── 8. the transaction under production semantics ──
    {
      const { fake, deps } = await setup();
      const d = await created(deps);
      fake.hooks.onTxn = async () => { fake.put(`marketing_offers/tb/${d.id}/rev`, 7); };   // another editor commits between read and commit
      const r = await move(deps, `t-${OWNER}`, { offer_id: d.id, to: 'active', expected_rev: 1 });
      assert.deepStrictEqual([r.status, r.body.error], [409, 'superseded'], 'a concurrent commit ⇒ superseded, never a blind overwrite');
      assert.deepStrictEqual(mirrored(fake), [], 'nothing mirrored on a lost CAS');
      ok('CAS: a concurrent commit between read and write is superseded');
    }

    FINISHED = true;
    console.log(`offers-core: ${n}/${n} ok`);
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    process.exitCode = 1;
  }
})();
