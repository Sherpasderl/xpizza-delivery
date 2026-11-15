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
// the LIVE (priceable) mirror entries (RTDB prunes empty parents; the in-memory fake keeps them — count leaves, never compare the parent).
// A pause / end leaves a TOMBSTONE { removed, rev } (the P1-2 fence): never live, so never counted here — `tombs` lists them.
const liveRows = (fake) => Object.values(fake.get('marketing_brand') || {}).flatMap((b) => Object.entries((b && b.live) || {}));
const mirrored = (fake) => liveRows(fake).flatMap(([rid, m]) => Object.entries(m || {}).filter(([, e]) => !(e && e.removed === true)).map(([id]) => `${rid}/${id}`));
const tombs = (fake) => liveRows(fake).flatMap(([rid, m]) => Object.entries(m || {}).filter(([, e]) => e && e.removed === true).map(([id]) => `${rid}/${id}`));
const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));

// production transaction semantics over the shared fake (see header)
function prodDb(fake) {
  // STRICT (Codex program r1): RTDB never retains an empty object (a removed leaf prunes its empty parents) and a snapshot is IMMUTABLE
  // (every val() is a fresh copy — a caller mutating it never changes what the next reader sees)
  const prune = (p) => { const ks = String(p).split('/').filter(Boolean); for (let i = ks.length - 1; i > 0; i--) { const up = ks.slice(0, i).join('/'); const v = fake.get(up); if (v && typeof v === 'object' && !Object.keys(v).length) fake.put(up, null); else break; } };
  const snap = (v) => ({ val: () => (v === null || v === undefined ? null : JSON.parse(JSON.stringify(v))), exists: () => v !== null && v !== undefined });
  // a committed transaction value is stored as RTDB stores it: null leaves and the empty objects they leave are never kept
  const norm = (v) => { if (v === null || typeof v !== 'object' || Array.isArray(v)) return v; const o = {}; for (const [k, x] of Object.entries(v)) { const y = norm(x); if (y !== null && y !== undefined) o[k] = y; } return Object.keys(o).length ? o : null; };
  const store = (p) => { const v = norm(fake.get(p)); fake.put(p, v); if (v === null) prune(p); };
  return {
    ref(p = '') {
      const r = fake.ref(p);
      return { ...r,
        async once() { const s0 = await r.once(); return snap(s0.val()); },
        get() { return this.once(); },
        async set(v) { await r.set(v); if (v === null) prune(p); },
        async remove() { await r.remove(); prune(p); },
        async update(m) { await r.update(m); for (const [k, v] of Object.entries(m)) if (v === null) prune(`${p}/${k}`); },
        async transaction(fn) {
          for (const pp of fake.failReads) if (String(p).startsWith(pp)) throw new Error(`injected failure: ${p}`);
          const cold = fn(null);
          if (cold === undefined) return { committed: false, snapshot: snap(null) };
          if (fake.get(p) === null) { fake.put(p, cold); store(p); return { committed: true, snapshot: snap(fake.get(p)) }; }
          const out = await r.transaction(fn);
          if (out.committed) store(p);
          return { committed: out.committed, snapshot: snap(out.snapshot.val()) };
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
  schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [5, 6], window: { from: 1260, to: 0 } }, ...o });   // v1: no caps (owner 11-15: offers launch without spend caps)
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
      assert.deepStrictEqual([r.status, r.body], [200, { ok: true, switches: { offers_enabled: false, anuncio_enabled: false, collections_enabled: false }, offers: [], bookings: [] }], 'OFF: the read states three falses and no list');
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
      const before = clone(fake.get('marketing_brand'));
      const mixed = await save(deps, `t-${OWNER}`, { offer: offer({ branches: ['tb_centro', 'zt_uno'] }) });   // the foreign branch sorts LAST: every branch is checked, not only the first
      assert.deepStrictEqual([mixed.status, mixed.body.error], [403, 'not_authorized'], 'one branch of another brand ⇒ 403');
      const staged = await save(deps, `t-${OWNER}`, { offer: offer({ branches: ['tb_centro', 'tb_nuevo'] }) });
      assert.deepStrictEqual([staged.status, staged.body.error], [403, 'not_authorized'], 'a staged branch carries no marketing capability ⇒ 403');
      assert.deepStrictEqual(fake.get('marketing_brand'), before, 'refusals wrote nothing');
      ok('auth: guests / customer / handheld / stranger / other brand refused; manager reads only; retired read-only; every branch checked');
    }

    // ── 3. create → the draft record; validation ──
    {
      const { fake, deps } = await setup();
      const d = await created(deps);
      assert.ok(OM.OFFER_ID_RE.test(d.id), 'an opaque offer id');
      const rec = fake.get(`marketing_brand/tb/offers/${d.id}`);
      assert.deepStrictEqual(rec, { v: 1, rev: 1, name: '2 por 1 en clásicas', type: 'bogo', params: { items: [K1], free_per_order: 1 }, audience: 'all', branches: ['tb_centro'],
        schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [5, 6], window: { from: 1260, to: 0 } },
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
        // money (advisor 11-14): whole lempiras, positive; absent = none — never a 0 sentinel
        [{ type: 'pct', params: { pct: 10, max_cents: 0 } }, 'bad_params'],
        [{ type: 'pct', params: { pct: 10, max_cents: 5050 } }, 'bad_params'],
        [{ type: 'lps', params: { off_cents: 5050, min_cents: 30000 } }, 'bad_params'],
        [{ type: 'envio', params: { min_cents: 0 } }, 'bad_params'],
        [{ type: 'nuevos', params: { off_cents: 99 }, audience: 'new' }, 'bad_params'],
        // v1 caps (owner 11-15): ANY caps value but absent / null is refused — never stored, never half-enforced
        [{ caps: { weekly: false } }, 'caps_not_supported'],
        [{ caps: { redemptions: 50, spend_cents: null, weekly: false } }, 'caps_not_supported'],
        [{ caps: {} }, 'caps_not_supported'],
        [{ caps: 0 }, 'caps_not_supported'],
        [{ extra: 1 }, 'bad_shape'],
      ];
      for (const [o, reason] of bad) {
        const r = await save(deps, `t-${OWNER}`, { offer: offer(o) });
        assert.deepStrictEqual([r.status, r.body.reason], [400, reason], `validation: ${reason} (${JSON.stringify(o)})`);
      }
      { const z = await save(deps, `t-${OWNER}`, { offer: offer({ caps: null }) });
        assert.deepStrictEqual([z.status, z.body.offer && 'caps' in z.body.offer, 'caps' in (fake.get(`marketing_brand/tb/offers/${z.body.offer && z.body.offer.id}`) || {})], [200, false, false], `caps: null ⇒ accepted, nothing stored (${JSON.stringify(z.body)})`); }
      const both = await save(deps, `t-${OWNER}`, { offer: offer({ params: { cats: ['pizzas'], items: [K1], free_per_order: 1 } }) });
      assert.deepStrictEqual([both.status, both.body.reason], [400, 'bad_params'], 'the builder sends items OR cats, never both (items are the server\'s)');
      for (const [o, want] of [[{ type: 'pct', params: { pct: 10 } }, { pct: 10 }], [{ type: 'pct', params: { pct: 10, max_cents: null } }, { pct: 10 }], [{ type: 'pct', params: { pct: 10, max_cents: 15000 } }, { pct: 10, max_cents: 15000 }], [{ type: 'envio', params: {} }, {}]]) {
        const r = await save(deps, `t-${OWNER}`, { offer: offer(o) });
        assert.deepStrictEqual([r.status, r.body.offer && r.body.offer.params], [200, want], `money: ${JSON.stringify(o.params)} ⇒ stored ${JSON.stringify(want)} (absent = none)`);
      }
      ok('validation: dish on the live menu, pct 5..50 step 5, lps min ≥ off, nuevos ⇒ new, schedule, caps absent / null only (else caps_not_supported), exact keys, items xor cats; money in whole lempiras, absent = none, never 0');
    }

    // ── 3b. bogo by CATEGORY (advisor 11-14): resolved from each branch's active version at save AND publish, frozen in between ──
    {
      const { fake, deps, CATALOG } = await setup();
      const cat = (o = {}) => offer({ name: '2 por 1 en pizzas', params: { cats: ['pizzas'], free_per_order: 1 }, ...o });
      const r = await save(deps, `t-${OWNER}`, { offer: cat({ branches: ['tb_centro', 'tb_sur'] }) });
      assert.strictEqual(r.status, 200, `premise: saved (${JSON.stringify(r.body)})`);
      assert.deepStrictEqual(fake.get(`marketing_brand/tb/offers/${r.body.offer.id}/params`), { cats: ['pizzas'], items: [K1, K2].sort(), free_per_order: 1 }, 'saved: the category AND its resolved dishes (the union over the branches)');
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
      assert.deepStrictEqual(fake.get(`marketing_brand/tb/live/tb_sur/${r.body.offer.id}/params/items`), want, 'publish RE-RESOLVES: the new dish is in the mirror');
      CATALOG.tb_centro.push(['i_eeeeeeeeeeee', 200, 'pizzas']);   // a dish added AFTER publishing
      assert.deepStrictEqual(fake.get(`marketing_brand/tb/live/tb_centro/${r.body.offer.id}/params/items`), want, 'frozen: a dish added after publish is NOT covered');
      const re = await save(deps, `t-${OWNER}`, { offer_id: r.body.offer.id, expected_rev: 2, offer: cat({ branches: ['tb_centro', 'tb_sur'], schedule: { start: NOW + DAY, end: NOW + 40 * DAY, days: [5, 6], window: { from: 1260, to: 0 } } }) });
      assert.strictEqual(re.status, 200, `a re-save of the live category offer is allowed (${JSON.stringify(re.body)})`);
      assert.deepStrictEqual(fake.get(`marketing_brand/tb/live/tb_centro/${r.body.offer.id}/params/items`), [...want, 'i_eeeeeeeeeeee'].sort(), '…and covers the dish added since');
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
      const rec = fake.get(`marketing_brand/tb/offers/${d.id}`);
      for (const rid of ['tb_centro', 'tb_sur']) assert.deepStrictEqual(fake.get(`marketing_brand/tb/live/${rid}/${d.id}`), OM.liveProjection(rec, 'tb'), `the mirror of ${rid} is the record's projection`);
      assert.deepStrictEqual(Object.keys(fake.get(`marketing_brand/tb/live/tb_centro/${d.id}`)).sort(), ['audience', 'brand_id', 'name', 'params', 'rev', 'schedule', 'type'], 'the mirror carries no state, author, timestamps or caps');
      ok('publish: active, every branch mirrored with the exact projection');
      const stale = await move(deps, `t-${OWNER}`, { offer_id: d.id, to: 'paused_owner', expected_rev: 1 });
      assert.deepStrictEqual([stale.status, stale.body], [409, { error: 'superseded', current_rev: 2 }], 'a stale rev ⇒ superseded');
      const pa = await move(deps, `t-${OWNER}`, { offer_id: d.id, to: 'paused_owner', expected_rev: 2 });
      assert.strictEqual(pa.status, 200);
      assert.deepStrictEqual(mirrored(fake), [], 'paused ⇒ no mirror on any branch');
      const re = await move(deps, `t-${OWNER}`, { offer_id: d.id, to: 'active', expected_rev: 3 });
      assert.strictEqual(re.status, 200);
      assert.strictEqual(fake.get(`marketing_brand/tb/live/tb_sur/${d.id}/rev`), 4, 'resume ⇒ mirrored again at the new rev');
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

    // ── 4b. pause / end remove the price path's entry FIRST (advisor 11-14): a failed removal never leaves a paused offer priced ──
    {
      const { fake, deps } = await setup();
      const a = await published(deps, { branches: ['tb_centro', 'tb_sur'] });
      fake.failReads.add('marketing_brand/tb');   // the pre-CAS fence (ONE brand txn) fails — an outage, through every retry
      const r = await move(deps, `t-${OWNER}`, { offer_id: a.id, to: 'paused_owner', expected_rev: 2 });
      assert.strictEqual(r.status, 503, 'a failed removal ⇒ 503');
      const rec = fake.get(`marketing_brand/tb/offers/${a.id}`);
      assert.ok(!(rec.state !== 'active' && fake.get(`marketing_brand/tb/live/tb_sur/${a.id}`)), 'a failed unmirror never leaves a paused / ended offer live on the price path');
      assert.deepStrictEqual([rec.state, rec.rev], ['active', 2], 'the record is unchanged (still active — consistent with its mirror)');
      fake.failReads.clear();
      const ok2 = await move(deps, `t-${OWNER}`, { offer_id: a.id, to: 'ended', expected_rev: 2 });
      assert.deepStrictEqual([ok2.status, mirrored(fake)], [200, []], 'retried: ended, no mirror anywhere');
      ok('pause / end: the mirror goes first — a failed removal is a 503 with the record still active, never a paused offer still priced');
    }

    // ── 5. the live-edit allowlist (end later; v1 has no caps) ──
    {
      const { fake, deps } = await setup();
      const a = await published(deps);
      const edit = (o, rev) => save(deps, `t-${OWNER}`, { offer_id: a.id, expected_rev: rev, offer: offer(o) });
      for (const [o, field] of [[{ name: 'Otro nombre' }, 'name'],
        [{ schedule: { start: NOW + DAY, end: NOW + 20 * DAY, days: [5, 6], window: { from: 1260, to: 0 } } }, 'schedule'], [{ params: { items: [K2], free_per_order: 1 } }, 'params']]) {
        const r = await edit(o, 2);
        assert.deepStrictEqual([r.status, r.body.error, r.body.field], [409, 'live_edit_not_allowed', field], `live edit of ${field} refused`);
      }
      const capped = await edit({ caps: { redemptions: 80, spend_cents: null, weekly: false } }, 2);
      assert.deepStrictEqual([capped.status, capped.body.reason], [400, 'caps_not_supported'], 'a live edit carrying caps ⇒ 400 caps_not_supported');
      const up = await edit({ schedule: { start: NOW + DAY, end: null, days: [5, 6], window: { from: 1260, to: 0 } } }, 2);
      assert.deepStrictEqual([up.status, up.body.offer.rev, 'caps' in up.body.offer, up.body.offer.schedule.end], [200, 3, false, null], 'a caps-less live edit (no end) ⇒ allowed');
      assert.deepStrictEqual(fake.get(`marketing_brand/tb/live/tb_centro/${a.id}`), OM.liveProjection(fake.get(`marketing_brand/tb/offers/${a.id}`), 'tb'), 'the mirror follows the edit');
      ok('live edit: only a later end (caps refused); the mirror follows');
      // an OLD record that still HAS caps (stored before v1 dropped them): read, projected and edited caps-less — never refused, never carried
      const recPath = `marketing_brand/tb/offers/${a.id}`;
      await fake.ref(`${recPath}/caps`).set({ redemptions: 50, weekly: false });
      const pz = await move(deps, `t-${OWNER}`, { offer_id: a.id, to: 'paused_owner', expected_rev: 3 });
      const rs = await move(deps, `t-${OWNER}`, { offer_id: a.id, to: 'active', expected_rev: 4 });
      assert.deepStrictEqual([pz.status, rs.status, 'caps' in rs.body.offer], [200, 200, false], `an old capped record pauses / resumes; the view has no caps (${JSON.stringify([pz.body, rs.body])})`);
      assert.ok(!('caps' in (fake.get(`marketing_brand/tb/live/tb_centro/${a.id}`) || {})), 'the re-projected live node of an old capped record carries no caps');
      const old = await edit({ schedule: { start: NOW + DAY, end: null, days: [5, 6], window: { from: 1200, to: 0 } } }, 5);
      assert.deepStrictEqual([old.status, 'caps' in (fake.get(recPath) || {}), 'caps' in (fake.get(`marketing_brand/tb/live/tb_centro/${a.id}`) || {})], [200, false, false], `an old capped record edited caps-less ⇒ 200, caps dropped from the record and the mirror (${JSON.stringify(old.body)})`);
      ok('an old record with caps: pause / resume / caps-less live edit all work; caps leave the record and never reach the mirror');
    }

    // ── 5b. owner-approved v5 «Editar oferta activa»: days + window MAY change on a live offer (start stays locked, end later-only);
    //        the edit is re-judged for overlap inside the per-branch txn (the fenced mirror path) ──
    {
      const { fake, deps } = await setup();
      const a = await published(deps);   // K1, Fri + Sat 21:00–00:00
      const edit = (o, rev) => save(deps, `t-${OWNER}`, { offer_id: a.id, expected_rev: rev, offer: offer(o) });
      const sched = (o) => ({ schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [5, 6], window: { from: 1260, to: 0 }, ...o } });
      const d1 = await edit(sched({ days: [4, 5, 6] }), 2);
      assert.deepStrictEqual([d1.status, d1.body.offer && d1.body.offer.rev, d1.body.offer && d1.body.offer.schedule.days], [200, 3, [4, 5, 6]], `a live edit of the DAYS is saved (${JSON.stringify(d1.body)})`);
      const w1 = await edit(sched({ days: [4, 5, 6], window: { from: 1140, to: 1380 } }), 3);
      assert.deepStrictEqual([w1.status, w1.body.offer && w1.body.offer.schedule.window], [200, { from: 1140, to: 1380 }], 'a live edit of the WINDOW is saved');
      assert.deepStrictEqual(fake.get(`marketing_brand/tb/live/tb_centro/${a.id}`), OM.liveProjection(fake.get(`marketing_brand/tb/offers/${a.id}`), 'tb'), 'the mirror re-projects the edit (the fenced path)');
      const s1 = await edit(sched({ start: NOW + 2 * DAY, days: [4, 5, 6], window: { from: 1140, to: 1380 } }), 4);
      assert.deepStrictEqual([s1.status, s1.body.error, s1.body.field], [409, 'live_edit_not_allowed', 'schedule'], 'the START stays locked once live');
      ok('v5 live edit: days and window are editable (rev bumps, the mirror re-projects); the start stays locked');
      // an edit that CREATES an overlap is refused by the judgement — the record and the mirror unchanged
      const wed = await published(deps, { name: 'Miércoles noche', schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [3], window: { from: 1200, to: 1320 } }, params: { items: [K1], free_per_order: 2 } });
      const before = [fake.get(`marketing_brand/tb/offers/${a.id}`), fake.get(`marketing_brand/tb/live/tb_centro/${a.id}`)];
      const clash = await edit(sched({ days: [3, 4, 5, 6], window: { from: 1140, to: 1380 } }), 4);
      assert.deepStrictEqual([clash.status, clash.body.error, clash.body.with], [409, 'overlap', ['Miércoles noche']], `an edit adding Wednesday 19:00–23:00 clashes with «Miércoles noche» ⇒ overlap (${JSON.stringify(clash.body)})`);
      assert.deepStrictEqual([fake.get(`marketing_brand/tb/offers/${a.id}`).rev, fake.get(`marketing_brand/tb/offers/${a.id}`).schedule.days, fake.get(`marketing_brand/tb/live/tb_centro/${a.id}`)], [before[0].rev, before[0].schedule.days, before[1]], 'the record and the mirror are unchanged');
      assert.ok(wed.state === 'active', 'premise');
      ok('an edit that creates an overlap is refused (named), the record and the mirror unchanged');
    }
    // the RACE: a clashing offer publishes AFTER the edit's pre-check, BEFORE its mirror txn ⇒ the in-txn judgement (the authority) refuses
    // the edit and the record is put back — never two overlapping live offers
    {
      const { fake, db, deps } = await setup();
      const a = await published(deps);   // K1, Fri + Sat 21:00–00:00
      const wedDraft = await created(deps, { name: 'Miércoles noche', schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [3], window: { from: 1200, to: 1320 } }, params: { items: [K1], free_per_order: 2 } });
      let pub = null; let armed = true;
      const lateDb = { ref: (p) => { const r = db.ref(p);
        if (armed && p === 'marketing_brand/tb') return { ...r, transaction: async (fn) => { armed = false; pub = await move(deps, `t-${OWNER}`, { offer_id: wedDraft.id, to: 'active', expected_rev: 1 }); return r.transaction(fn); } };
        return r; } };
      const r = await save({ ...deps, db: lateDb }, `t-${OWNER}`, { offer_id: a.id, expected_rev: 2, offer: offer({ schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [3, 5, 6], window: { from: 1140, to: 1380 } } }) });
      assert.strictEqual(pub && pub.status, 200, 'premise: «Miércoles noche» published between the edit\'s pre-check and its mirror txn');
      assert.deepStrictEqual([r.status, r.body.error], [409, 'overlap'], `the in-txn judgement refuses the racing edit (${JSON.stringify(r.body)})`);
      assert.deepStrictEqual(fake.get(`marketing_brand/tb/offers/${a.id}`).schedule.days, [5, 6], 'the record is put back (the edit undone)');
      assert.deepStrictEqual(fake.get(`marketing_brand/tb/live/tb_centro/${a.id}`).schedule.days, [5, 6], 'its mirror keeps the pre-edit days: never two overlapping live offers');
      ok('a racing edit is refused INSIDE the per-branch txn (the authority) and undone — never two overlapping live offers');
    }

    // ── 5c. the fence's strict `>` (5f's review): a pause whose CAS LOSES to a concurrent activation at the SAME rev as its tombstone ⇒
    //        that activation's mirror overwrites the tombstone (it is live, as its record says) ──
    {
      const { fake, db, deps } = await setup();
      const a = await published(deps);   // rev 2, active
      let edited = null; let armed = true;
      const recPath = `marketing_brand/tb/offers/${a.id}`;
      const lateDb = { ref: (p) => { const r = db.ref(p);
        if (armed && p === 'marketing_brand/tb') return { ...r, transaction: async (fn) => { armed = false; edited = await save(deps, `t-${OWNER}`, { offer_id: a.id, expected_rev: 2, offer: offer({ schedule: { start: NOW + DAY, end: NOW + 40 * DAY, days: [5, 6], window: { from: 1260, to: 0 } } }) }); return r.transaction(fn); } };
        return r; } };
      // the pause tombstones at rev 3 (pre.rev + 1), then — before its CAS — a live edit takes rev 3 and mirrors its rev-3 projection
      const p = await move({ ...deps, db: lateDb }, `t-${OWNER}`, { offer_id: a.id, to: 'paused_owner', expected_rev: 2 });
      assert.strictEqual(edited && edited.status, 200, `premise: the concurrent edit took rev 3 (${JSON.stringify(edited && edited.body)})`);
      assert.deepStrictEqual([p.status, p.body.error], [409, 'superseded'], 'premise: the pause lost its CAS');
      const rec = fake.get(recPath); const e = fake.get(`marketing_brand/tb/live/tb_centro/${a.id}`);
      assert.deepStrictEqual([rec.state, rec.rev], ['active', 3], 'premise: the record is active at rev 3');
      assert.ok(e && e.removed !== true && e.rev === 3, `the SAME-rev activation overwrites the tombstone: live, as its record says (${JSON.stringify(e)})`);
      ok('the fence is strict: an activation at the tombstone\'s own rev (a lost pause CAS) overwrites it');
    }

    // ── 5d. Codex fence/live-edit r1 P1-2 (PLAN-3a-live-mirror-2phase r0): a refused MULTI-branch edit never loses an existing branch's
    //        offer — the old reservation holds until EVERY branch accepts (two-phase), so a refusal never re-acquires a slot ──
    {
      const { fake, db, deps } = await setup();
      const a = await published(deps, { branches: ['tb_centro', 'tb_sur'] });   // K1, Fri + Sat 21:00–00:00 in Centro AND Sur (rev 2)
      const before = { c: fake.get(`marketing_brand/tb/live/tb_centro/${a.id}`), s: fake.get(`marketing_brand/tb/live/tb_sur/${a.id}`) };
      const bDraft = await created(deps, { name: 'Viernes temprano', branches: ['tb_centro'], schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [5], window: { from: 1260, to: 1320 } } });
      const cDraft = await created(deps, { name: 'Miércoles Sur', branches: ['tb_sur'], schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [3], window: { from: 1200, to: 1320 } } });
      let pb = null; let pc = null; let armed = true;
      const lateDb = { ref: (p) => { const r = db.ref(p);
        if (armed && p === 'marketing_brand/tb') return { ...r, transaction: async (fn) => { armed = false;   // r3: B and C act in full BEFORE A's ONE txn
          pb = await move(deps, `t-${OWNER}`, { offer_id: bDraft.id, to: 'active', expected_rev: 1 });   // B: Friday 21–22 in Centro
          pc = await move(deps, `t-${OWNER}`, { offer_id: cDraft.id, to: 'active', expected_rev: 1 });   // C: Wednesday in Sur
          return r.transaction(fn); } };
        return r; } };
      const r = await save({ ...deps, db: lateDb }, `t-${OWNER}`, { offer_id: a.id, expected_rev: 2, offer: offer({ branches: ['tb_centro', 'tb_sur'], schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [3], window: { from: 1260, to: 0 } } }) });
      assert.deepStrictEqual([pb && pb.status, pb && pb.body.error], [409, 'overlap'], `B (Friday in Centro) is judged against A's OLD reservation, which still holds ⇒ overlap (${JSON.stringify(pb && pb.body)})`);
      assert.strictEqual(pc && pc.status, 200, 'premise: C (Wednesday in Sur) published before A reached Sur');
      assert.deepStrictEqual([r.status, r.body.error], [409, 'overlap'], `Sur refuses A's edit ⇒ 409 overlap — never a 503 (${JSON.stringify(r.body)})`);
      assert.deepStrictEqual({ c: fake.get(`marketing_brand/tb/live/tb_centro/${a.id}`), s: fake.get(`marketing_brand/tb/live/tb_sur/${a.id}`) }, before, 'a REFUSED brand txn wrote NOTHING: every branch holds A\'s old projection, byte for byte (r3: no undo, no transient projection)');
      const rec = fake.get(`marketing_brand/tb/offers/${a.id}`);
      assert.deepStrictEqual([rec.state, rec.schedule.days], ['active', [5, 6]], 'A is still active on Fri + Sat');
      for (const [rid, k] of [['tb_centro', 'c'], ['tb_sur', 's']]) {
        const e = fake.get(`marketing_brand/tb/live/${rid}/${a.id}`);
        assert.ok(e && e.removed !== true && e.pending !== true && e.next === undefined && JSON.stringify(e.schedule.days) === '[5,6]' && e.rev === rec.rev, `${rid}: A keeps its Fri + Sat projection, at the record's rev, nothing staged (${JSON.stringify(e)})`);
        assert.deepStrictEqual({ ...e, rev: before[k].rev }, before[k], `${rid}: the same projection as before the edit (only its rev follows the record)`);
      }
      ok('Codex P1-2: a refused multi-branch edit never loses a branch — A keeps Fri + Sat in Centro AND Sur (409, never 503); B is judged against the old reservation');
    }

    // ── 5e. Codex fence/live-edit r1 P1-1: a rollback never DELETES a fence — a stalled lower-rev resume can never resurrect a paused offer ──
    {
      const { fake, db, deps } = await setup();
      const a = await published(deps, { branches: ['tb_centro', 'tb_sur'] });   // rev 2
      assert.strictEqual((await move(deps, `t-${OWNER}`, { offer_id: a.id, to: 'paused_owner', expected_rev: 2 })).status, 200, 'premise: paused (rev 3)');
      const dDraft = await created(deps, { name: 'Competidor Sur', branches: ['tb_sur'] });   // the same dish + hours as A, in Sur
      let r6 = null; let armed = true;
      const stalled = { ref: (p) => { const r = db.ref(p);
        if (armed && p === 'marketing_brand/tb') return { ...r, transaction: async (fn) => { armed = false;
          // a STALE resume (expected_rev 3) STALLS before its ONE txn; meanwhile: another resume (rev 4) and pause (rev 5) complete, D publishes
          // in Sur, the rev-6 resume is refused in Sur (writing nothing)
          assert.strictEqual((await move(deps, `t-${OWNER}`, { offer_id: a.id, to: 'active', expected_rev: 3 })).status, 200, 'premise: the rev-4 resume');
          assert.strictEqual((await move(deps, `t-${OWNER}`, { offer_id: a.id, to: 'paused_owner', expected_rev: 4 })).status, 200, 'premise: the rev-5 pause');
          let dArmed = true;   // D publishes in Sur AFTER the rev-6 resume's pre-check, right before its Sur mirror txn (Codex's order)
          const r6Db = { ref: (q) => { const rr = db.ref(q);
            if (dArmed && q === 'marketing_brand/tb') return { ...rr, transaction: async (fn) => { dArmed = false; assert.strictEqual((await move(deps, `t-${OWNER}`, { offer_id: dDraft.id, to: 'active', expected_rev: 1 })).status, 200, 'premise: D live in Sur'); return rr.transaction(fn); } };
            return rr; } };
          r6 = await move({ ...deps, db: r6Db }, `t-${OWNER}`, { offer_id: a.id, to: 'active', expected_rev: 5 });
          return r.transaction(fn); } };
        return r; } };
      const stale = await move({ ...deps, db: stalled }, `t-${OWNER}`, { offer_id: a.id, to: 'active', expected_rev: 3 });   // the stale resume
      assert.deepStrictEqual([r6 && r6.status, r6 && r6.body.error], [409, 'overlap'], 'premise: the rev-6 resume is refused in Sur');
      assert.deepStrictEqual([stale.status, stale.body.error], [409, 'superseded'], `the stale resume is judged on the CURRENT record ⇒ superseded (${JSON.stringify(stale.body)})`);
      const rec = fake.get(`marketing_brand/tb/offers/${a.id}`);
      assert.deepStrictEqual([rec.state, rec.rev], ['paused_owner', 5], 'A stays paused at rev 5 (the refusal and the stale resume wrote nothing)');
      for (const rid of ['tb_centro', 'tb_sur']) {
        const e = fake.get(`marketing_brand/tb/live/${rid}/${a.id}`);
        assert.ok(e && e.removed === true && e.rev === 5, `${rid}: the pause's TOMBSTONE at rev 5 — never deleted, never a live projection (${JSON.stringify(e)})`);
        assert.strictEqual(require('../catalog/offers-serve').publicOffer(e, NOW + 2 * DAY), null, `${rid}: never served`);
      }
      ok('Codex P1-1 (r3): a refusal leaves the pause\'s tombstone on EVERY branch — a stalled stale resume never resurrects the paused offer');
    }

    // ── 5f. advisor (a): an edit never clashes with ITSELF ──
    {
      const { fake, deps } = await setup();
      const a = await published(deps);   // Fri + Sat 21:00–00:00
      const self = await save(deps, `t-${OWNER}`, { offer_id: a.id, expected_rev: 2, offer: offer({ schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [5, 6, 0], window: { from: 1200, to: 0 } } }) });
      assert.strictEqual(self.status, 200, `an edit overlapping its OWN previous days/hours is accepted (never judged against itself) (${JSON.stringify(self.body)})`);
      ok('advisor (a): an edit never clashes with itself (r2: no staging, so no crashed `next` can exist)');
    }

    // ── 5g. the brand txn FAILS (an outage, through every retry) during a resume ⇒ 503, and the pause's TOMBSTONES stay exactly as they were
    //        on every branch (never a half state, never an empty slot a stalled lower-rev activation could fill) ──
    {
      const { fake, db, deps } = await setup();
      const a = await published(deps, { branches: ['tb_centro', 'tb_sur'] });
      assert.strictEqual((await move(deps, `t-${OWNER}`, { offer_id: a.id, to: 'paused_owner', expected_rev: 2 })).status, 200, 'premise: paused (rev 3)');
      const outDb = { ref: (p) => { const r = db.ref(p); if (p === 'marketing_brand/tb') return { ...r, transaction: async () => { throw new Error('rtdb unavailable'); } }; return r; } };
      const res = await move({ ...deps, db: outDb }, `t-${OWNER}`, { offer_id: a.id, to: 'active', expected_rev: 3 });
      assert.strictEqual(res.status, 503, 'premise: the resume hit an outage on the brand txn');
      for (const rid of ['tb_centro', 'tb_sur']) {
        const e = fake.get(`marketing_brand/tb/live/${rid}/${a.id}`);
        assert.ok(e && e.removed === true && e.rev === 3, `${rid}: a failed brand txn leaves the pause's TOMBSTONE as it was — never a half state, never an empty slot (${JSON.stringify(e)})`);
      }
      ok('a failed brand txn (an outage) ⇒ 503 and no half state: the tombstones stay on every branch');
    }

    // ── 5h. the brand txn is rev-guarded: an OLDER edit's txn running after a NEWER edit's never overwrites the newer projection ──
    {
      const { fake, db, deps } = await setup();
      const a = await published(deps);   // rev 2
      let newer = null; let armed = true;
      const entryPath = `marketing_brand/tb/live/tb_centro/${a.id}`;
      const lateDb = { ref: (p) => { const r = db.ref(p);
        if (armed && p === 'marketing_brand/tb') return { ...r, transaction: async (fn) => { armed = false;   // the OLDER edit's brand txn is about to run
          newer = await save(deps, `t-${OWNER}`, { offer_id: a.id, expected_rev: 2, offer: offer({ schedule: { start: NOW + DAY, end: NOW + 40 * DAY, days: [5, 6], window: { from: 1260, to: 0 } } }) });
          return r.transaction(fn); } };
        return r; } };
      const older = await save({ ...deps, db: lateDb }, `t-${OWNER}`, { offer_id: a.id, expected_rev: 2, offer: offer({ schedule: { start: NOW + DAY, end: NOW + 35 * DAY, days: [5, 6], window: { from: 1260, to: 0 } } }) });
      assert.deepStrictEqual([older.status, older.body.error, newer && newer.status], [409, 'superseded', 200], `the newer edit wins; the older one's ONE txn sees rev 3 ⇒ superseded (${JSON.stringify([older.body, newer && newer.body])})`);
      const e = fake.get(entryPath); const rec = fake.get(`marketing_brand/tb/offers/${a.id}`);
      assert.deepStrictEqual([rec.rev, e.rev, e.schedule.end], [3, 3, NOW + 40 * DAY], `the older txn never overwrites the newer projection (live = the record's rev 3) (${JSON.stringify(e)})`);
      ok('the brand txn is rev-guarded: an older edit never overwrites a newer one\'s projection');
    }

    // ── 5i. the owner's pause stamps paused_at (server time) on the record; resume clears it; the portal's read exposes it
    //        (portal-ui «Pausada por vos el …») ──
    {
      const { fake, deps } = await setup();
      const a = await published(deps);
      const T = NOW + 3 * 3600 * 1000;
      assert.strictEqual((await move({ ...deps, now: () => T }, `t-${OWNER}`, { offer_id: a.id, to: 'paused_owner', expected_rev: 2 })).status, 200, 'premise: paused');
      assert.strictEqual(fake.get(`marketing_brand/tb/offers/${a.id}`).paused_at, T, 'the pause writes paused_at = the server time');
      const r1 = (await get({ ...deps, now: () => T + 1 }, `t-${OWNER}`, 'tb_centro')).body.offers.find((o) => o.id === a.id);
      assert.deepStrictEqual([r1.state, r1.paused_at], ['paused_owner', T], 'the read exposes paused_at while paused');
      assert.strictEqual((await move({ ...deps, now: () => T + 2 }, `t-${OWNER}`, { offer_id: a.id, to: 'active', expected_rev: 3 })).status, 200, 'premise: resumed');
      assert.strictEqual(fake.get(`marketing_brand/tb/offers/${a.id}`).paused_at, undefined, 'resume clears paused_at');
      const r2 = (await get({ ...deps, now: () => T + 3 }, `t-${OWNER}`, 'tb_centro')).body.offers.find((o) => o.id === a.id);
      assert.ok(!('paused_at' in r2), 'the read carries no paused_at once active');
      ok('the owner pause stamps paused_at (server time), resume clears it, the read exposes it while paused');
    }

    // ── 5j. create / repeat are IDEMPOTENT per (restaurant, client op_id) (advisor 11-14; portal-ui drops its content-matching findCreated) ──
    {
      const { fake, deps } = await setup();
      const OP = 'op_' + 'k'.repeat(20);
      const count = () => Object.keys(fake.get('marketing_brand/tb/offers') || {}).length;
      const n0 = count();
      const first = await save(deps, `t-${OWNER}`, { offer: offer(), op_id: OP });
      assert.strictEqual(first.status, 200, `premise: created (${JSON.stringify(first.body)})`);
      const retry = await save(deps, `t-${OWNER}`, { offer: offer(), op_id: OP });   // the reply was lost; the client retries
      assert.deepStrictEqual([retry.status, retry.body.offer.id, retry.body.offer.rev, retry.body.offer.state], [200, first.body.offer.id, 1, 'draft'], 'a lost reply then a retry ⇒ the SAME offer (its current rev and state)');
      assert.strictEqual(count(), n0 + 1, 'and one offer, never two');
      ok('create idempotent: a lost reply then a retry with the same op_id ⇒ the same offer, one offer');
      const OP2 = 'op_' + 'm'.repeat(20);
      const [c1, c2] = await Promise.all([save(deps, `t-${OWNER}`, { offer: offer({ name: 'Concurrente' }), op_id: OP2 }), save(deps, `t-${OWNER}`, { offer: offer({ name: 'Concurrente' }), op_id: OP2 })]);
      assert.deepStrictEqual([c1.status, c2.status, c1.body.offer.id === c2.body.offer.id], [200, 200, true], `two concurrent calls with one op_id ⇒ both answer the SAME offer (${JSON.stringify([c1.body, c2.body])})`);
      assert.strictEqual(count(), n0 + 2, 'one offer for the concurrent pair');
      const other = await save(deps, `t-${OWNER}`, { offer: offer({ name: 'Otra' }), op_id: 'op_' + 'p'.repeat(20) });
      assert.ok(other.status === 200 && other.body.offer.id !== first.body.offer.id && count() === n0 + 3, 'a DIFFERENT op_id ⇒ a new offer');
      assert.deepStrictEqual([(await save(deps, `t-${OWNER}`, { offer: offer(), op_id: 'bad op' })).status, (await save(deps, `t-${OWNER}`, { offer: offer(), op_id: 'bad op' })).body.field], [400, 'op_id'], 'a malformed op_id ⇒ 400');
      ok('concurrent calls with one op_id ⇒ one offer; a different op_id ⇒ a new offer; a malformed op_id ⇒ 400');
      // the op_id expires after 7 days: the same op_id then creates afresh
      const late = await save({ ...deps, now: () => NOW + 8 * DAY }, `t-${OWNER}`, { offer: offer({ schedule: { start: NOW + 9 * DAY, end: NOW + 30 * DAY, days: [5, 6], window: { from: 1260, to: 0 } } }), op_id: OP });
      assert.ok(late.status === 200 && late.body.offer.id !== first.body.offer.id, `an op_id older than 7 days no longer matches ⇒ a new offer (${JSON.stringify(late.body)})`);
      ok('an op_id expires after 7 days');
      // REPEAT is idempotent the same way
      const ended = await published(deps, { name: 'Para repetir' });
      assert.strictEqual((await move(deps, `t-${OWNER}`, { offer_id: ended.id, to: 'ended', expected_rev: 2 })).status, 200, 'premise: ended');
      const ROP = 'op_' + 'r'.repeat(20);
      const rep = (o = {}) => C.marketingOfferRepeatCore(deps, req(`t-${OWNER}`, { rid: 'tb_centro', offer_id: ended.id, op_id: ROP, ...o }));
      const r1 = await rep(); const before = count(); const r2 = await rep();
      assert.deepStrictEqual([r1.status, r2.status, r2.body.offer && r2.body.offer.id], [200, 200, r1.body.offer && r1.body.offer.id], 'repeat: a retry with the same op_id ⇒ the SAME new draft');
      assert.strictEqual(count(), before, 'and never a second draft');
      ok('repeat idempotent per op_id');
    }

    // ── 5k. Codex op_id r2 (P2 1–5) ──
    {
      const { fake, db, deps } = await setup();
      const OPX = 'op_' + 'x'.repeat(20), OPY = 'op_' + 'y'.repeat(20);
      // (1) the expired-claim cleanup never deletes a claim RENEWED meanwhile
      const x1 = await save({ ...deps, now: () => NOW - 8 * DAY }, `t-${OWNER}`, { offer: offer({ name: 'Viejo' }), op_id: OPX });   // X claimed 8 days ago (expired now)
      assert.strictEqual(x1.status, 200, 'premise: X claimed long ago');
      let renewed = null; let armed = true;
      const racing = { ref: (p) => { const r = db.ref(p);
        const renew = async () => { if (!armed) return; armed = false; renewed = await save(deps, `t-${OWNER}`, { offer: offer({ name: 'Renovado' }), op_id: OPX }); };   // X renewed right before the cleanup acts on it
        if (p === 'marketing_brand/tb') return { ...r, transaction: async (fn) => { await renew(); return r.transaction(fn); } };   // r3: the prune runs INSIDE Y's ONE txn
        return r; } };
      assert.strictEqual((await save({ ...deps, db: racing }, `t-${OWNER}`, { offer: offer({ name: 'Y' }), op_id: OPY })).status, 200, 'premise: a fresh claim Y triggers the expired-claim cleanup');
      assert.ok(renewed && renewed.status === 200 && renewed.body.offer.id !== x1.body.offer.id, 'premise: X was renewed (a new offer) during the cleanup');
      const again = await save(deps, `t-${OWNER}`, { offer: offer({ name: 'Renovado' }), op_id: OPX });
      assert.strictEqual(again.body.offer && again.body.offer.id, renewed.body.offer.id, 'the cleanup never deleted the RENEWED claim: a retry of X answers the renewed offer (never a 3rd)');
      ok('op_id (1): the expired-claim prune runs inside the brand txn — a claim renewed meanwhile is never deleted');
      // (2) one op_id is never reused across kinds (create ↔ repeat)
      const ended = await published(deps, { name: 'Terminar' });
      assert.strictEqual((await move(deps, `t-${OWNER}`, { offer_id: ended.id, to: 'ended', expected_rev: 2 })).status, 200, 'premise: ended');
      const cross = await C.marketingOfferRepeatCore(deps, req(`t-${OWNER}`, { rid: 'tb_centro', offer_id: ended.id, op_id: OPY }));
      assert.deepStrictEqual([cross.status, cross.body.error], [409, 'op_id_conflict'], 'an unexpired CREATE claim reused for a REPEAT ⇒ 409 op_id_conflict (never overwritten)');
      // (3) a repeat claim is bound to its SOURCE offer
      const ended2 = await published(deps, { name: 'Terminar 2', params: { items: [K2], free_per_order: 1 } });
      assert.strictEqual((await move(deps, `t-${OWNER}`, { offer_id: ended2.id, to: 'ended', expected_rev: 2 })).status, 200, 'premise: ended 2');
      const OPR = 'op_' + 's'.repeat(20);
      assert.strictEqual((await C.marketingOfferRepeatCore(deps, req(`t-${OWNER}`, { rid: 'tb_centro', offer_id: ended.id, op_id: OPR }))).status, 200, 'premise: repeated');
      const other = await C.marketingOfferRepeatCore(deps, req(`t-${OWNER}`, { rid: 'tb_centro', offer_id: ended2.id, op_id: OPR }));
      assert.deepStrictEqual([other.status, other.body.error], [409, 'op_id_conflict'], 'the same op_id for ANOTHER source ⇒ 409 op_id_conflict (the claim binds its source)');
      // (5) a non-string op_id ⇒ 400, before any claim
      for (const bad of [12345678901234567, ['op_' + 'q'.repeat(20)], { a: 1 }]) {
        assert.deepStrictEqual([(await save(deps, `t-${OWNER}`, { offer: offer(), op_id: bad })).body.field, (await C.marketingOfferRepeatCore(deps, req(`t-${OWNER}`, { rid: 'tb_centro', offer_id: ended.id, op_id: bad }))).body.field], ['op_id', 'op_id'], `a non-string op_id (${JSON.stringify(bad)}) ⇒ 400`);
      }
      const back = await save(deps, `t-${OWNER}`, { offer: offer({ name: 'Otro' }), op_id: OPR });
      assert.deepStrictEqual([back.status, back.body.error], [409, 'op_id_conflict'], 'an unexpired REPEAT claim reused for a CREATE ⇒ 409 op_id_conflict (never a replay of the repeat\'s draft)');
      ok('op_id (2)(3)(5): never reused across kinds; a repeat claim binds its source; a non-string op_id ⇒ 400');
      // (4) a successful repeat AT CAPACITY is replayed (the replay comes before the capacity check)
      const left = OM.LIMITS.offers_max - Object.keys(fake.get('marketing_brand/tb/offers') || {}).length;
      const capRep = 'op_' + 'c'.repeat(20);
      for (let i = 0; i < left - 1; i++) assert.strictEqual((await save(deps, `t-${OWNER}`, { offer: offer({ name: `Relleno ${i}` }) })).status, 200, 'premise: filling up');
      const lastOne = await C.marketingOfferRepeatCore(deps, req(`t-${OWNER}`, { rid: 'tb_centro', offer_id: ended.id, op_id: capRep }));
      assert.strictEqual(lastOne.status, 200, 'premise: the repeat took the LAST slot');
      const replay = await C.marketingOfferRepeatCore(deps, req(`t-${OWNER}`, { rid: 'tb_centro', offer_id: ended.id, op_id: capRep }));
      assert.deepStrictEqual([replay.status, replay.body.offer && replay.body.offer.id], [200, lastOne.body.offer.id], 'its retry at capacity REPLAYS the same draft (never 409 too_many_offers)');
      ok('op_id (4): a successful repeat at capacity replays (the replay precedes the capacity check)');
    }

    // ── 5l. the portal's single-call Ofertas (advisor 11-14): save / repeat with program: true create (or update) AND program in ONE operation
    //        under the op_id claim — all or nothing; the DUPLICATE backstop is judged inside the brand txn ──
    {
      const { fake, deps } = await setup();
      const pct = (o = {}) => offer({ name: 'Diez por ciento', type: 'pct', params: { pct: 10 }, ...o });
      const count = () => Object.keys(fake.get('marketing_brand/tb/offers') || {}).length;   // r3: a refused attempt is never a record
      const OPA = 'op_' + 'a'.repeat(20), OPB = 'op_' + 'b'.repeat(20), OPC = 'op_' + 'c'.repeat(20);
      const p1 = await save(deps, `t-${OWNER}`, { offer: pct(), op_id: OPA, program: true });
      assert.deepStrictEqual([p1.status, p1.body.offer && p1.body.offer.state], [200, 'active'], `program: true creates AND programs in one call (${JSON.stringify(p1.body)})`);
      assert.ok(fake.get(`marketing_brand/tb/live/tb_centro/${p1.body.offer.id}`) && fake.get(`marketing_brand/tb/live/tb_centro/${p1.body.offer.id}`).removed !== true, 'and its mirror is live');
      const n1 = count();
      const retry = await save(deps, `t-${OWNER}`, { offer: pct(), op_id: OPA, program: true });
      assert.deepStrictEqual([retry.status, retry.body.offer.id, retry.body.offer.state, count()], [200, p1.body.offer.id, 'active', n1], 'a retry with the SAME op_id ⇒ the same programmed offer');
      const reload = await save(deps, `t-${OWNER}`, { offer: pct(), op_id: OPB, program: true });   // the reply was lost, the page reloaded: a NEW op_id
      assert.deepStrictEqual([reload.status, reload.body.error, reload.body.offer_id], [409, 'duplicate', p1.body.offer.id], `a lost reply then a reload with a NEW op_id ⇒ 409 duplicate carrying the programmed offer's id (${JSON.stringify(reload.body)})`);
      assert.strictEqual(count(), n1, 'all or nothing: the refused create left no offer behind (only its terminal `refused` record, never counted)');
      ok('program: true creates + programs in one call; a same-op_id retry ⇒ the same offer; a reload with a new op_id ⇒ 409 duplicate, nothing left behind');
      // two tabs racing (two op_ids, the same offer) ⇒ ONE programmed — the backstop is judged inside the brand txn
      const tab = (op) => save(deps, `t-${OWNER}`, { offer: pct({ name: 'Doble pestaña', params: { pct: 20 } }), op_id: op, program: true });
      const [t1, t2] = await Promise.all([tab(OPC), tab('op_' + 'd'.repeat(20))]);
      assert.deepStrictEqual([t1.status, t2.status].sort(), [200, 409], `two racing tabs ⇒ exactly one programmed (${JSON.stringify([t1.body, t2.body])})`);
      const lost = t1.status === 409 ? t1 : t2; const won = t1.status === 200 ? t1 : t2;
      assert.deepStrictEqual([lost.body.error, lost.body.offer_id], ['duplicate', won.body.offer.id], 'the loser ⇒ 409 duplicate carrying the winner\'s id');
      const live20 = Object.values(fake.get('marketing_brand/tb/offers')).filter((r) => r.state === 'active' && r.params && r.params.pct === 20);
      assert.strictEqual(live20.length, 1, 'exactly one active «20 %» offer');
      ok('two racing tabs ⇒ one programmed, the other 409 duplicate (judged inside the brand txn)');
      // not a duplicate: other params, or another branch set ⇒ both programmed
      assert.strictEqual((await save(deps, `t-${OWNER}`, { offer: pct({ name: 'Quince', params: { pct: 15 } }), op_id: 'op_' + 'e'.repeat(20), program: true })).status, 200, 'other params ⇒ programmed');
      assert.strictEqual((await save(deps, `t-${OWNER}`, { offer: pct({ name: 'Diez Sur', branches: ['tb_centro', 'tb_sur'] }), op_id: 'op_' + 'f'.repeat(20), program: true })).status, 200, 'another branch set ⇒ programmed');
      ok('not a duplicate: other params or another branch set ⇒ programmed');
      // program: true on an EXISTING draft (by id + expected_rev)
      const d = await created(deps, { name: 'Borrador', type: 'pct', params: { pct: 25 } });
      const pd = await save(deps, `t-${OWNER}`, { offer_id: d.id, expected_rev: 1, offer: pct({ name: 'Borrador', params: { pct: 25 } }), program: true });
      assert.deepStrictEqual([pd.status, pd.body.offer && pd.body.offer.state, pd.body.offer && pd.body.offer.rev], [200, 'active', 2], 'program: true on an existing draft ⇒ updated AND programmed in one CAS');
      assert.strictEqual((await save(deps, `t-${OWNER}`, { offer: pct(), program: 'yes' })).body.field, 'program', 'a non-boolean program ⇒ 400');
      ok('program: true updates an existing draft and programs it in one write; a bad program flag ⇒ 400');
      // REPEAT with program: true + new dates ⇒ a programmed copy; again with a new op_id ⇒ 409 duplicate
      const src = await published(deps, { name: 'Repetible', type: 'pct', params: { pct: 30 } });
      assert.strictEqual((await move(deps, `t-${OWNER}`, { offer_id: src.id, to: 'ended', expected_rev: 2 })).status, 200, 'premise: ended');
      const rep = (op) => C.marketingOfferRepeatCore(deps, req(`t-${OWNER}`, { rid: 'tb_centro', source_id: src.id, op_id: op, program: true, schedule: { start: NOW + 2 * DAY, end: NOW + 20 * DAY } }));
      const r1 = await rep('op_' + 'g'.repeat(20));
      assert.deepStrictEqual([r1.status, r1.body.offer && r1.body.offer.state, r1.body.offer && r1.body.offer.schedule.start, r1.body.offer && r1.body.offer.repeated_from], [200, 'active', NOW + 2 * DAY, src.id], `repeat + program: copies + dates + programs in one call (${JSON.stringify(r1.body)})`);
      const r2 = await rep('op_' + 'h'.repeat(20));
      assert.deepStrictEqual([r2.status, r2.body.error, r2.body.offer_id], [409, 'duplicate', r1.body.offer.id], 'a second programmed repeat with a new op_id ⇒ 409 duplicate');
      // Codex op_id r3: an ARRAY offer_id / source_id never passes a coercing check (it would persist as an array and 409 every retry)
      const arr = [src.id];
      assert.deepStrictEqual([(await C.marketingOfferRepeatCore(deps, req(`t-${OWNER}`, { rid: 'tb_centro', source_id: arr, op_id: 'op_' + 'i'.repeat(20) }))).body.field, (await C.marketingOfferRepeatCore(deps, req(`t-${OWNER}`, { rid: 'tb_centro', offer_id: arr }))).body.field], ['source_id', 'source_id'], 'an array source ⇒ 400 before any claim');
      assert.strictEqual(fake.get(`marketing_brand/tb/ops/op_${'i'.repeat(20)}`) ?? null, null, 'no claim was written for it');
      assert.deepStrictEqual([(await save(deps, `t-${OWNER}`, { offer_id: arr, expected_rev: 1, offer: pct() })).body.field, (await move(deps, `t-${OWNER}`, { offer_id: arr, to: 'active', expected_rev: 1 })).body.field], ['offer_id', 'offer_id'], 'an array offer_id ⇒ 400 (save / set state)');
      ok('repeat + program: true copies, dates and programs in one call (source bound); a second one ⇒ 409 duplicate');
    }

    // ── 5m. Codex program r1 ──
    {
      const { fake, db, deps } = await setup();
      const pct = (o = {}) => offer({ name: 'Diez por ciento', type: 'pct', params: { pct: 10 }, ...o });
      const liveAt = (id) => { const e = fake.get(`marketing_brand/tb/live/tb_centro/${id}`); return e && e.removed !== true ? e.rev : null; };
      // P1-1 (r3: an outage on the ONE brand txn ⇒ a 503 and NOTHING written — no record, no claim, no mirror); the same-op retry creates it
      fake.failReads.add('marketing_brand/tb');
      const OP1 = 'op_' + 'j'.repeat(20);
      const before1 = clone(fake.get('marketing_brand/tb'));
      const first = await save(deps, `t-${OWNER}`, { offer: pct(), op_id: OP1, program: true });
      fake.failReads.clear();
      assert.strictEqual(first.status, 503, 'premise: the brand txn failed ⇒ 503');
      assert.deepStrictEqual(fake.get('marketing_brand/tb'), before1, 'an outage writes NOTHING: no record ahead of its mirror, no claim');
      const again = await save(deps, `t-${OWNER}`, { offer: pct(), op_id: OP1, program: true });
      assert.deepStrictEqual([again.status, again.body.offer && again.body.offer.state], [200, 'active'], 'the same-op retry programs it');
      const id1 = again.body.offer.id;
      assert.strictEqual(liveAt(id1), again.body.offer.rev, '…record and mirror at ONE rev, written together');
      assert.strictEqual(fake.get(`marketing_brand/tb/ops/${OP1}/offer_id`), id1, '…with its claim in the same write');
      ok('Codex P1-1 (r3): an outage ⇒ 503 with nothing written; the same-op retry writes record + mirror + claim together');
      // P1-2 (r3: a refused program is NEVER a record): ONLY the claim is written, carrying the refusal; its retry answers the same 409
      const OP2 = 'op_' + 'k'.repeat(20);
      const offersBefore = clone(fake.get('marketing_brand/tb/offers')); const liveBefore = clone(fake.get('marketing_brand/tb/live'));
      const dup = await save(deps, `t-${OWNER}`, { offer: pct(), op_id: OP2, program: true });
      assert.deepStrictEqual([dup.status, dup.body.error, dup.body.offer_id], [409, 'duplicate', id1], 'premise: a duplicate ⇒ 409');
      assert.deepStrictEqual([fake.get('marketing_brand/tb/offers'), fake.get('marketing_brand/tb/live')], [offersBefore, liveBefore], 'the refusal wrote NO record and NO mirror entry');
      const claim = fake.get(`marketing_brand/tb/ops/${OP2}`);
      assert.deepStrictEqual([claim && claim.kind, claim && claim.refused && claim.refused.error, claim && claim.refused && claim.refused.offer_id], ['create', 'duplicate', id1], 'only its CLAIM is written, carrying the refusal');
      const again2 = await save({ ...deps, now: () => NOW + 60000 }, `t-${OWNER}`, { offer: pct(), op_id: OP2, program: true });   // a minute later: a re-judge would re-stamp the claim
      assert.deepStrictEqual([again2.status, again2.body.error, again2.body.offer_id], [409, 'duplicate', id1], 'its same-op retry answers the SAME refusal (never recreates it)');
      assert.deepStrictEqual([fake.get('marketing_brand/tb/offers'), fake.get(`marketing_brand/tb/ops/${OP2}`)], [offersBefore, claim], 'and writes nothing');
      assert.ok(!(await get(deps, `t-${OWNER}`, 'tb_centro')).body.offers.some((o) => o.id === claim.offer_id), 'a refused attempt is never listed to the merchant');
      ok('Codex P1-2 (r3): a refused program writes only its claim (carrying the refusal); its retry answers the same 409; never a record');
      // the refusal's claim write fails (an outage) ⇒ 503, nothing written; the same-op retry re-judges and records the refusal
      const OP3 = 'op_' + 'l'.repeat(20);
      fake.failReads.add('marketing_brand/tb');
      const f1 = await save(deps, `t-${OWNER}`, { offer: pct(), op_id: OP3, program: true });
      fake.failReads.clear();
      assert.deepStrictEqual([f1.status, fake.get(`marketing_brand/tb/ops/${OP3}`) ?? null], [503, null], 'premise: the refusal write failed ⇒ 503, no claim');
      const f2 = await save(deps, `t-${OWNER}`, { offer: pct(), op_id: OP3, program: true });
      assert.deepStrictEqual([f2.status, f2.body.error, f2.body.offer_id], [409, 'duplicate', id1], 'the same-op retry re-judges and answers the refusal (never a 200 active with no mirror)');
      assert.strictEqual(fake.get(`marketing_brand/tb/ops/${OP3}/refused/error`), 'duplicate', '…and records it on the claim');
      ok('a failed refusal write ⇒ 503; the same-op retry re-judges and records the refusal');
      // P2-3: the replay runs BEFORE the publish validation; the start-in-future rule never applies to a LIVE edit (end later)
      const late = await save({ ...deps, now: () => NOW + 3 * DAY }, `t-${OWNER}`, { offer: pct(), op_id: OP1, program: true });
      assert.strictEqual(late.status, 200, 'a same-op retry after the start passed REPLAYS (never 400 start_past)');
      const liveEdit = await save({ ...deps, now: () => NOW + 3 * DAY }, `t-${OWNER}`, { offer_id: id1, expected_rev: again.body.offer.rev, offer: pct({ schedule: { start: NOW + DAY, end: NOW + 40 * DAY, days: [5, 6], window: { from: 1260, to: 0 } } }), program: true });
      assert.strictEqual(liveEdit.status, 200, `program on an ALREADY LIVE offer (an end-later edit after its start) is never refused start_past (${JSON.stringify(liveEdit.body)})`);
      ok('P2-3: replay precedes the publish validation; a live edit with program is never refused start_past');
      // P2-4: set-valued params are normalised (item order) and the DUPLICATE is judged first on every path — draft programming included
      const bogo = (items, o = {}) => offer({ name: 'Dos por uno', params: { items, free_per_order: 1 }, schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [1], window: { from: 600, to: 720 } }, ...o });
      const b1 = await save(deps, `t-${OWNER}`, { offer: bogo([K1, K2]), op_id: 'op_' + 'n'.repeat(20), program: true });
      assert.strictEqual(b1.status, 200, 'premise: programmed');
      const b2 = await save(deps, `t-${OWNER}`, { offer: bogo([K2, K1]), op_id: 'op_' + 'o'.repeat(20), program: true });
      assert.deepStrictEqual([b2.status, b2.body.error, b2.body.offer_id], [409, 'duplicate', b1.body.offer.id], 'the same items in ANOTHER order ⇒ a duplicate (set-valued params normalised), judged BEFORE the overlap rule');
      const draft = await created(deps, { name: 'Dos por uno', params: { items: [K2, K1], free_per_order: 1 }, schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [1], window: { from: 600, to: 720 } } });
      const pub = await move(deps, `t-${OWNER}`, { offer_id: draft.id, to: 'active', expected_rev: 1 });
      assert.deepStrictEqual([pub.status, pub.body.error, pub.body.offer_id], [409, 'duplicate', b1.body.offer.id], 'publishing a draft identical to a live offer ⇒ duplicate (first), not overlap');
      ok('P2-4: set-valued params normalised; the duplicate is judged first on every path (draft programming included)');
      // P2-5: the repeat's full schedule is validated through the shared model BEFORE any claim or write
      const src = await published(deps, { name: 'Fuente', type: 'pct', params: { pct: 40 } });
      assert.strictEqual((await move(deps, `t-${OWNER}`, { offer_id: src.id, to: 'ended', expected_rev: 2 })).status, 200, 'premise: ended');
      const OPS = 'op_' + 't'.repeat(20);
      const bad = await C.marketingOfferRepeatCore(deps, req(`t-${OWNER}`, { rid: 'tb_centro', source_id: src.id, op_id: OPS, program: true, schedule: { start: 9e15, end: 9.1e15 } }));
      assert.deepStrictEqual([bad.status, bad.body.field], [400, 'schedule'], 'a timestamp beyond the shared model\'s maximum ⇒ 400 schedule');
      assert.strictEqual(fake.get(`marketing_brand/tb/ops/${OPS}`) ?? null, null, 'and NO claim was written for it');
      ok('P2-5: the repeat\'s schedule is validated by the shared model before any claim or write');
    }

    // ── 5n. Codex brand-root r1 (3 × P2) ──
    {
      // P2-1: a «sin mínimo» envío is stored params-less (RTDB drops {}); an identical second one is STILL a duplicate
      const { deps } = await setup();
      const env = () => offer({ name: 'Envío gratis', type: 'envio', params: {} });
      const e1 = await save(deps, `t-${OWNER}`, { offer: env(), op_id: 'op_' + 'e'.repeat(20), program: true });
      assert.strictEqual(e1.status, 200, `premise: the first no-minimum envío is programmed (${JSON.stringify(e1.body)})`);
      const e2 = await save(deps, `t-${OWNER}`, { offer: env(), op_id: 'op_' + 'f'.repeat(20), program: true });
      assert.deepStrictEqual([e2.status, e2.body.error, e2.body.offer_id], [409, 'duplicate', e1.body.offer.id], `a second identical no-minimum envío ⇒ 409 duplicate (stored params-less ≡ {}) (${JSON.stringify(e2.body)})`);
      ok('Codex P2-1: two identical «sin mínimo» envíos are duplicates (params normalised through the stored rule on both sides)');
    }
    {
      // P2-2a: 120 refusals over 120 days — expired claims are pruned on EVERY committing txn, refusal-only ones included
      const { fake, deps } = await setup();
      const pctNoEnd = (t) => offer({ name: 'Diez siempre', type: 'pct', params: { pct: 10 }, schedule: { start: t + DAY, end: null, days: [5, 6], window: { from: 1260, to: 0 } } });
      assert.strictEqual((await save(deps, `t-${OWNER}`, { offer: pctNoEnd(NOW), program: true })).status, 200, 'premise: the live offer');
      for (let i = 1; i <= 120; i++) {
        const t = NOW + i * DAY;
        const r = await save({ ...deps, now: () => t }, `t-${OWNER}`, { offer: pctNoEnd(t), op_id: `op_day${String(i).padStart(3, '0')}_${'d'.repeat(12)}`, program: true });
        assert.deepStrictEqual([r.status, r.body.error], [409, 'duplicate'], `premise: day ${i} refused as a duplicate`);
      }
      const ops = Object.keys(fake.get('marketing_brand/tb/ops') || {});
      assert.ok(ops.length <= 8, `refusal claims older than 7 days are pruned by the refusal txns themselves: ${ops.length} left (never 120)`);
      ok('Codex P2-2a: 120 refusals over 120 days leave only the last 7 days of claims');
      // P2-2b: a burst (day 200: every earlier claim expired) — live claims per brand are capped; past the cap ⇒ 429 too_many_pending, NOTHING written
      const TB = NOW + 200 * DAY; const bdeps = { ...deps, now: () => TB };
      for (let i = 0; i < C.OPS_MAX; i++) {
        const r = await save(bdeps, `t-${OWNER}`, { offer: pctNoEnd(TB), op_id: `op_burst${String(i).padStart(4, '0')}_${'b'.repeat(10)}`, program: true });
        if (r.status !== 409) assert.fail(`premise: burst ${i} refused as a duplicate (${JSON.stringify(r.body)})`);
      }
      assert.strictEqual(Object.keys(fake.get('marketing_brand/tb/ops')).length, C.OPS_MAX, 'premise: the cap is reached');
      const before = clone(fake.get('marketing_brand/tb'));
      const over = await save(bdeps, `t-${OWNER}`, { offer: pctNoEnd(TB), op_id: 'op_burstover_' + 'z'.repeat(10), program: true });
      assert.deepStrictEqual([over.status, over.body.error], [429, 'too_many_pending'], `past the cap ⇒ 429 too_many_pending (${JSON.stringify(over.body)})`);
      assert.deepStrictEqual(fake.get('marketing_brand/tb'), before, 'and nothing written');
      const fresh = await save(bdeps, `t-${OWNER}`, { offer: offer({ name: 'Otra', type: 'pct', params: { pct: 25 }, schedule: { start: TB + DAY, end: TB + 30 * DAY, days: [5, 6], window: { from: 1260, to: 0 } } }), op_id: 'op_burstnew_' + 'y'.repeat(10) });
      assert.deepStrictEqual([fresh.status, fresh.body.error], [429, 'too_many_pending'], 'a NEW claimed create is refused too while the cap holds');
      ok('Codex P2-2b: a burst is capped at OPS_MAX live claims ⇒ 429 too_many_pending, nothing written');
    }
    {
      // P2-3: a lost reply, then the dish leaves the menu: the same-op retry REPLAYS (never 400 unknown_dish) — repeat AND create
      const { fake, db, deps } = await setup();
      const src = await published(deps, { name: 'Fuente K2', params: { items: [K2], free_per_order: 1 } });
      assert.strictEqual((await move(deps, `t-${OWNER}`, { offer_id: src.id, to: 'ended', expected_rev: 2 })).status, 200, 'premise: ended');
      const ROP = 'op_' + 'q'.repeat(20), COP = 'op_' + 'w'.repeat(20);
      const rep = () => C.marketingOfferRepeatCore(deps, req(`t-${OWNER}`, { rid: 'tb_centro', source_id: src.id, op_id: ROP, program: true, schedule: { start: NOW + 2 * DAY, end: NOW + 9 * DAY } }));
      const r1 = await rep();
      assert.strictEqual(r1.status, 200, `premise: repeat + program succeeded (${JSON.stringify(r1.body)})`);
      const c1 = await save(deps, `t-${OWNER}`, { offer: offer({ name: 'Crear K2', params: { items: [K2], free_per_order: 2 }, schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [1], window: null } }), op_id: COP });
      assert.strictEqual(c1.status, 200, 'premise: a claimed create succeeded');
      await makeRtdbMirror(db)('tb_centro', { version: 'v2', seq: 2, rid: 'tb_centro', menu: { [K1]: 150, [K3]: 90 }, extras: {} });   // K2 leaves the menu
      const gone = await save(deps, `t-${OWNER}`, { offer: offer({ name: 'Nuevo K2', params: { items: [K2], free_per_order: 3 } }) });
      assert.deepStrictEqual([gone.status, gone.body.reason], [400, 'unknown_dish'], 'premise: K2 is no longer on the menu');
      const r2 = await rep();
      assert.deepStrictEqual([r2.status, r2.body.offer && r2.body.offer.id], [200, r1.body.offer.id], `the repeat retry REPLAYS its committed offer (never 400 unknown_dish) (${JSON.stringify(r2.body)})`);
      const c2 = await save(deps, `t-${OWNER}`, { offer: offer({ name: 'Crear K2', params: { items: [K2], free_per_order: 2 }, schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [1], window: null } }), op_id: COP });
      assert.deepStrictEqual([c2.status, c2.body.offer && c2.body.offer.id], [200, c1.body.offer.id], `the create retry REPLAYS too (${JSON.stringify(c2.body)})`);
      // a NEW op_id has no claim to replay: the deferred failure answers (400 unknown_dish) and NOTHING is written (no claim, no record)
      const pre = clone(fake.get('marketing_brand/tb'));
      const nr = await C.marketingOfferRepeatCore(deps, req(`t-${OWNER}`, { rid: 'tb_centro', source_id: src.id, op_id: 'op_' + 'v'.repeat(20), program: true, schedule: { start: NOW + 2 * DAY, end: NOW + 9 * DAY } }));
      assert.deepStrictEqual([nr.status, nr.body.reason], [400, 'unknown_dish'], `a NEW-op repeat on a dish off the menu ⇒ the deferred 400 (${JSON.stringify(nr.body)})`);
      const nc = await save(deps, `t-${OWNER}`, { offer: offer({ name: 'Nuevo K2', params: { items: [K2], free_per_order: 3 } }), op_id: 'op_' + 'u'.repeat(20) });
      assert.deepStrictEqual([nc.status, nc.body.reason], [400, 'unknown_dish'], `a NEW-op create on a dish off the menu ⇒ the deferred 400 (${JSON.stringify(nc.body)})`);
      assert.deepStrictEqual(fake.get('marketing_brand/tb'), pre, 'the deferred failures wrote nothing');
      ok('Codex P2-3: a same-op retry replays before the dish preparation can fail (repeat and create)');
    }

    // ── 5o. portal-ui (advisor): an offer past its schedule END is not live — it never holds a branch slot, and a txn tidies it ──
    {
      const { fake, deps } = await setup();
      const ids = [];
      for (let i = 0; i < 10; i++) ids.push((await save(deps, `t-${OWNER}`, { offer: offer({ name: `Corta ${i}`, type: 'pct', params: { pct: 5 + 5 * i }, schedule: { start: NOW + DAY, end: NOW + 2 * DAY, days: [0, 1, 2, 3, 4, 5, 6], window: null } }), program: true })).body.offer.id);
      assert.strictEqual(ids.filter(Boolean).length, 10, 'premise: ten offers programmed, each ending NOW + 2 days');
      const T3 = NOW + 3 * DAY; const later = { ...deps, now: () => T3 };
      assert.ok(ids.every((id) => { const e = fake.get(`marketing_brand/tb/live/tb_centro/${id}`); return e && e.removed !== true; }), 'premise: no job ended them — their entries are still projections');
      const eleventh = await save(later, `t-${OWNER}`, { offer: offer({ name: 'Después', type: 'envio', params: {}, schedule: { start: T3 + DAY, end: T3 + 9 * DAY, days: [0, 1, 2, 3, 4, 5, 6], window: null } }), program: true });
      assert.strictEqual(eleventh.status, 200, `entries past their schedule end never count toward live_max (${JSON.stringify(eleventh.body)})`);
      assert.ok(ids.every((id) => fake.get(`marketing_brand/tb/live/tb_centro/${id}/removed`) === true), 'the brand txn tombstoned the expired entries it saw (the node stays tidy)');
      const listed = (await get(later, `t-${OWNER}`, 'tb_centro')).body.offers.filter((o) => ids.includes(o.id));
      assert.deepStrictEqual([listed.length, listed.every((o) => o.status === 'ended' && o.live_drift === undefined)], [10, true], 'the portal lists them «Terminada», never as drift');
      ok('portal-ui: an offer past its end never holds a live slot; any brand txn tombstones it; the read shows it ended, no drift');
    }
    {
      // the same for a REFUSAL-only txn (a claimed refusal writes; it tidies too) and for the duplicate judgement
      const { fake, deps } = await setup();
      const short = (o = {}) => offer({ name: 'Diez corta', type: 'pct', params: { pct: 10 }, schedule: { start: NOW + DAY, end: NOW + 2 * DAY, days: [5, 6], window: null }, ...o });
      const a = await save(deps, `t-${OWNER}`, { offer: short(), program: true });
      assert.strictEqual(a.status, 200, 'premise: programmed, ending NOW + 2 days');
      const T3 = NOW + 3 * DAY;
      const live = await save(deps, `t-${OWNER}`, { offer: offer({ name: 'Veinte', type: 'pct', params: { pct: 20 }, schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [5, 6], window: null } }), program: true });
      assert.strictEqual(live.status, 200, 'premise: a long-running competitor (written BEFORE the short one expires: no later successful write)');
      assert.ok((fake.get(`marketing_brand/tb/live/tb_centro/${a.body.offer.id}/removed`) ?? null) === null, 'premise: the short one is still a projection');
      const ref = await save({ ...deps, now: () => T3 }, `t-${OWNER}`, { offer: offer({ name: 'Veinte', type: 'pct', params: { pct: 20 }, schedule: { start: T3 + DAY, end: NOW + 30 * DAY, days: [5, 6], window: null } }), op_id: 'op_' + 'x'.repeat(16) + 'tidy', program: true });
      assert.deepStrictEqual([ref.status, ref.body.error, ref.body.offer_id], [409, 'duplicate', live.body.offer.id], 'premise: a claimed refusal (the live competitor, never the expired one)');
      assert.strictEqual(fake.get(`marketing_brand/tb/live/tb_centro/${a.body.offer.id}/removed`), true, 'a refusal-only txn tombstones the expired entry too');
      ok('the expired-entry tidy runs on a refusal-only txn too');
    }

    // ── 6. the overlap rule + MAX_LIVE ──
    {
      const { deps } = await setup();
      await published(deps);   // K1, Fri+Sat 21:00–00:00
      const sat = await created(deps, { name: 'Pizza sábado noche', schedule: { start: NOW + DAY, days: [6], window: { from: 1410, to: 60 } }, params: { items: [K1], free_per_order: 2 } });
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
      const k2sun = await created(deps, { name: 'Domingo K2', params: { items: [K2], free_per_order: 2 }, schedule: { start: NOW + 40 * DAY, days: [0], window: { from: 30, to: 120 } } });
      const wrap = await move(deps, `t-${OWNER}`, { offer_id: k2sun.id, to: 'active', expected_rev: 1 });
      assert.deepStrictEqual([wrap.status, wrap.body.error, wrap.body.with], [409, 'overlap', ['Sábado tarde K2']], 'Saturday 23:00–01:00 runs into SUNDAY: the week wraps');
      void k2sat;
      ok('overlap across the week boundary (Saturday night into Sunday)');
      for (let i = 0; i < 5; i++) await published(deps, { name: `Pct ${i}`, type: 'pct', params: { pct: 10 + 5 * i } });   // distinct params: never a duplicate
      const eleventh = await created(deps, { name: 'Once', type: 'envio', params: {} });   // no minimum = the field absent
      const t = await move(deps, `t-${OWNER}`, { offer_id: eleventh.id, to: 'active', expected_rev: 1 });
      assert.deepStrictEqual([t.status, t.body.error], [409, 'too_many_live'], 'the 11th live offer on a branch ⇒ too_many_live');
      ok('MAX_LIVE: 10 scheduled+live offers per branch');
    }

    // ── 6a. RTDB never stores an empty object: a «sin mínimo» envío (params {}) is stored params-less — it still reads back, lists and serves ──
    {
      const { fake, deps } = await setup();
      const e = await save(deps, `t-${OWNER}`, { offer: offer({ name: 'Envío gratis', type: 'envio', params: {} }), program: true });
      assert.strictEqual(e.status, 200, `premise: programmed (${JSON.stringify(e.body)})`);
      const id = e.body.offer.id;
      assert.strictEqual(fake.get(`marketing_brand/tb/offers/${id}`).params, undefined, 'premise: stored as RTDB stores it — no params node');
      const listed = (await get(deps, `t-${OWNER}`, 'tb_centro')).body.offers.find((o) => o.id === id);
      assert.deepStrictEqual([listed && listed.params, listed && listed.live_drift], [{}, undefined], 'the portal read lists it with params {} (never dropped as malformed, never drift)');
      const ended = await move(deps, `t-${OWNER}`, { offer_id: id, to: 'paused_owner', expected_rev: 1 });
      assert.strictEqual(ended.status, 200, `a params-less envío is never current_malformed on a later move (${JSON.stringify(ended.body)})`);
      assert.strictEqual((await move(deps, `t-${OWNER}`, { offer_id: id, to: 'active', expected_rev: 2 })).status, 200, 'and resumes');
      const served = require('../catalog/offers-serve').publicOffer(fake.get(`marketing_brand/tb/live/tb_centro/${id}`), NOW + 2 * DAY);
      assert.deepStrictEqual(served && [served.type, served.params], ['envio', {}], 'the public reader serves the stored entry (params {})');
      ok('a «sin mínimo» envío survives RTDB\'s empty-object drop: read back, listed, moved and served');
    }

    // ── 6b. the race (advisor 11-14, rule 5): two clashing publishes at once — the per-branch transaction lets exactly one through ──
    {
      const { fake, deps } = await setup();
      const a = await created(deps, { name: 'Carrera A' });
      const b = await created(deps, { name: 'Carrera B', params: { items: [K1], free_per_order: 2 }, schedule: { start: NOW + DAY, days: [6], window: { from: 1380, to: 60 } } });   // the same dish, other params: an overlap race
      const [ra, rb] = await Promise.all([a, b].map((d) => move(deps, `t-${OWNER}`, { offer_id: d.id, to: 'active', expected_rev: 1 })));
      const codes = [ra.status, rb.status].sort();
      assert.deepStrictEqual(codes, [200, 409], `exactly one of two simultaneous publishes wins (${JSON.stringify([ra.body, rb.body])})`);
      const [win, lose, loser] = ra.status === 200 ? [a, rb, b] : [b, ra, a];
      assert.deepStrictEqual([lose.body.error, lose.body.rid, lose.body.with, 'current_rev' in lose.body], ['overlap', 'tb_centro', [win.name], false], 'the loser: a typed overlap refusal naming the winner (its record untouched, so its rev is still the caller\'s)');
      assert.deepStrictEqual(mirrored(fake), [`tb_centro/${win.id}`], 'one mirror: the winner\'s');
      const back = fake.get(`marketing_brand/tb/offers/${loser.id}`);
      assert.deepStrictEqual([back.state, back.rev], ['draft', 1], 'the loser\'s record is never touched (r3: one txn, a refusal writes nothing)');
      ok('race: two clashing publishes at once ⇒ exactly one wins; the other refused (overlap), its record untouched, one mirror');
      // a live edit that would now clash (a later end) is judged the same way and writes nothing
      const c = await published(deps, { name: 'Diciembre K3', params: { items: [K3], free_per_order: 1 }, schedule: { start: NOW + DAY, end: NOW + 10 * DAY, days: [1], window: null } });
      await published(deps, { name: 'Enero K3', params: { items: [K3], free_per_order: 2 }, schedule: { start: NOW + 12 * DAY, end: NOW + 20 * DAY, days: [1], window: null } });
      const ext = await save(deps, `t-${OWNER}`, { offer_id: c.id, expected_rev: 2, offer: offer({ name: 'Diciembre K3', params: { items: [K3], free_per_order: 1 }, schedule: { start: NOW + DAY, end: NOW + 15 * DAY, days: [1], window: null } }) });
      assert.deepStrictEqual([ext.status, ext.body.error, ext.body.with], [409, 'overlap', ['Enero K3']], 'a later end that runs into another offer is refused');
      assert.strictEqual(fake.get(`marketing_brand/tb/live/tb_centro/${c.id}/schedule/end`), NOW + 10 * DAY, 'the edited offer keeps its OLD mirror');
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
      fake.put(`marketing_brand/tb/live/tb_centro/${a.id}`, null);
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
      assert.deepStrictEqual([rp.body.offer.state, rp.body.offer.repeated_from, rp.body.offer.schedule.start, rp.body.offer.schedule.end, rp.body.offer.params], ['draft', fin.id, null, null, { pct: 20 }], 'repeat: a draft, same set-up, dates cleared');
      ok('repeat: from an ended offer only, dates cleared');
      const { fake: f2, deps: d2 } = await setup();
      const old = await created(d2, { name: 'Vieja' });
      await move(d2, `t-${OWNER}`, { offer_id: old.id, to: 'ended', expected_rev: 1 });
      const d2later = { ...d2, now: () => NOW + 181 * DAY };
      await save(d2later, `t-${OWNER}`, { offer: offer({ name: 'Nueva', schedule: { start: NOW + 182 * DAY, days: [1] } }) });
      assert.strictEqual(f2.get(`marketing_brand/tb/offers/${old.id}`), null, 'Q4: an offer ended 181 days ago leaves with the next create');
      ok('prune: ended > 180 days removed by the next create');
    }

    // ── 8. the transaction under production semantics ──
    {
      const { fake, deps } = await setup();
      const d = await created(deps);
      fake.hooks.onTxn = async () => { fake.put(`marketing_brand/tb/offers/${d.id}/rev`, 7); };   // another editor commits between read and commit
      const r = await move(deps, `t-${OWNER}`, { offer_id: d.id, to: 'active', expected_rev: 1 });
      assert.deepStrictEqual([r.status, r.body.error], [409, 'superseded'], 'a concurrent commit ⇒ superseded, never a blind overwrite');
      assert.deepStrictEqual(mirrored(fake), [], 'nothing mirrored on a lost CAS');
      ok('CAS: a concurrent commit between read and write is superseded');
    }

    // ── Codex (5f price path) r1 P1-2: a LATE activation mirror never resurrects a paused offer — the TOMBSTONE fence ──
    {
      const { fake, db, deps } = await setup();
      const o = await published(deps);
      assert.strictEqual((await move(deps, `t-${OWNER}`, { offer_id: o.id, to: 'paused_owner', expected_rev: 2 })).status, 200, 'premise: paused (rev 3)');
      // Codex's interleaving under r3 (one txn per action): a resume STALLS before its txn; meanwhile another tab resumes (rev 4) and pauses
      // (rev 5) to the end; then the stalled resume's txn runs on the CURRENT record
      let other = null; let paused = null; let armed = true;
      const lateDb = { ref: (p) => { const r = db.ref(p);
        if (armed && p === 'marketing_brand/tb') return { ...r, transaction: async (fn) => { armed = false;
          other = await move(deps, `t-${OWNER}`, { offer_id: o.id, to: 'active', expected_rev: 3 });
          paused = await move(deps, `t-${OWNER}`, { offer_id: o.id, to: 'paused_owner', expected_rev: 4 }); return r.transaction(fn); } };
        return r; } };
      const resumed = await move({ ...deps, db: lateDb }, `t-${OWNER}`, { offer_id: o.id, to: 'active', expected_rev: 3 });
      assert.deepStrictEqual([other && other.status, paused && paused.status], [200, 200], `premise: the other tab's resume and pause both answer 200 (${JSON.stringify([other && other.body, paused && paused.body])})`);
      assert.deepStrictEqual([resumed.status, resumed.body.error], [409, 'superseded'], `the stalled resume is judged on the CURRENT record ⇒ superseded (${JSON.stringify(resumed.body)})`);
      const rec = fake.get(`marketing_brand/tb/offers/${o.id}`);
      assert.deepStrictEqual([rec.state, rec.rev], ['paused_owner', 5], 'premise: the record ends paused at rev 5');
      const entry = fake.get(`marketing_brand/tb/live/tb_centro/${o.id}`);
      assert.ok(entry === null || entry === undefined || entry.removed === true, `a LATE activation mirror never resurrects a paused offer (live: ${JSON.stringify(entry)})`);
      assert.strictEqual(require('../catalog/offers-serve').publicOffer(entry, NOW + 2 * DAY), null, 'the public read never serves it');
      ok('Codex P1-2 (r3): a stalled resume after another tab\'s resume + pause ⇒ superseded; the paused offer is never live again');
      // a GENUINE later resume (a higher rev) re-mirrors over the tombstone
      const again = await move(deps, `t-${OWNER}`, { offer_id: o.id, to: 'active', expected_rev: 5 });
      assert.strictEqual(again.status, 200, 'a genuine resume');
      const e2 = fake.get(`marketing_brand/tb/live/tb_centro/${o.id}`);
      assert.ok(e2 && e2.removed !== true && e2.rev === 6, `a higher rev re-mirrors over the tombstone (${JSON.stringify(e2)})`);
      ok('a genuine later resume (a higher rev) re-mirrors over the tombstone');
      // readers skip a tombstone: it never counts as live (overlap, MAX_LIVE)
      assert.strictEqual((await move(deps, `t-${OWNER}`, { offer_id: o.id, to: 'paused_owner', expected_rev: 6 })).status, 200, 'premise: paused again (a tombstone at rev 7)');
      assert.strictEqual(fake.get(`marketing_brand/tb/live/tb_centro/${o.id}`).removed, true, 'premise: the pause left a tombstone');
      const twin = await published(deps, { name: 'Otra 2x1 clásicas' });   // the SAME dish and schedule as the paused offer
      assert.strictEqual(twin.state, 'active', 'a tombstone never counts as live: an offer on the same dish publishes (no overlap)');
      // MAX_LIVE: ten paused offers leave ten tombstones on the branch — an eleventh offer still publishes (a tombstone never counts)
      {
        const { fake: f2, deps: d2 } = await setup();
        for (let i = 0; i < OM.LIMITS.live_max; i++) {
          const x = await published(d2, { name: `Pct ${i}`, type: 'pct', params: { pct: 10 } });
          assert.strictEqual((await move(d2, `t-${OWNER}`, { offer_id: x.id, to: 'paused_owner', expected_rev: 2 })).status, 200, 'premise: paused');
        }
        assert.strictEqual(tombs(f2).length, OM.LIMITS.live_max, `premise: ${OM.LIMITS.live_max} tombstones on the branch`);
        const eleventh = await move(d2, `t-${OWNER}`, { offer_id: (await created(d2, { name: 'Pct 11', type: 'pct', params: { pct: 10 } })).id, to: 'active', expected_rev: 1 });
        assert.strictEqual(eleventh.status, 200, `a tombstone never counts toward MAX_LIVE: the eleventh publishes (${JSON.stringify(eleventh.body)})`);
      }
      ok('readers skip a tombstone: it never clashes and never counts toward MAX_LIVE');
    }

    FINISHED = true;
    console.log(`offers-core: ${n}/${n} ok`);
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    process.exitCode = 1;
  }
})();
