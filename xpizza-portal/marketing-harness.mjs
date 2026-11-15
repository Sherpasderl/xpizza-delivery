// The REAL server set-up the Ofertas tests share (marketing-logic.test.mjs, marketing.test.mjs): 3a's offer cores at the PINNED
// ref (git-archived by ref-tree.mjs), production's transaction semantics, membership by the REAL roster writer, menus by the REAL
// catalog mirror writer, the switches by the REAL config writer. `backend({ extra })` routes the page's other calls (the shell's
// getMyBranches …) to `extra(fn, body)` — never to a hand-built marketing reply.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ML from './marketing-logic.js';
import { getMarketingRaw, offerSaveRaw, offerSetStateRaw } from './api.js';
import { refTree } from './ref-tree.mjs';

// ── the pin ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const REF = 'c5bbce7400b01f2fe10eeb23b9f716f7718e89dc';   // 3a feat/capp-offers-3a: + the live-edit widening (4245a74bf, Codex-fixed d6997aff2) + idempotent op_id (advisor 11-14)
export const BLOBS = {   // `git rev-parse <REF>:xpizza-functions/marketing/<file>` — a moved ref must be re-read, never silently followed
  'offer-model.js': '1caffd20c193daa0dfdc34de15eaebd886e9abcb',
  'offers-core.js': '2a924ee23b0145630cf198af8bc8b048b0e2b1e9',
  'config.js': 'e038e717821142cd80d4e7fda8295b7fb8a26ce4',
  'functions.js': '5236ec67a7b78c6ee5be08082acdc174594c849c',
};
// backend({ ref }) runs another 3a ref's whole server set (the O2c flip waits for 3a's re-reviewed live-edit SHA — advisor 11-14).
export const DIR = dirname(fileURLToPath(import.meta.url));
export const git = (...a) => execFileSync('git', a, { cwd: DIR, encoding: 'utf8' }).trim();
export const rq = refTree(REF);
export const OM = rq('./marketing/offer-model');
export const C = rq('./marketing/offers-core');
export const CFG = rq('./marketing/config');
// one ref's whole server set (the cores AND the writers that seed them come from the SAME tree)
const LIBS = new Map();
function libs(ref) {
  if (!LIBS.has(ref)) {
    const q = ref === REF ? rq : refTree(ref);
    LIBS.set(ref, { C: q('./marketing/offers-core'), CFG: q('./marketing/config'), createFakeDb: q('./merchant/_fake-db').createFakeDb, R: q('./access/roster'),
      makeRtdbMirror: q('./catalog/mirror-rtdb').makeRtdbMirror, makeRtdbMirrorReader: q('./catalog/snapshot-fallback').makeRtdbMirrorReader, buildMenu: q('./catalog/catalog-menu').buildMenu });
  }
  return LIBS.get(ref);
}
export const { isBrandId } = rq('./brands/brand-model');

// ── the real backend (3a's offers-core.test.js set-up, the same real writers) ─────────────────────────────────────────────────
export const NOW = Date.UTC(2026, 10, 16, 18);   // Mon 16 Nov 2026 12:00 HN
export const DAY = 86400000;
export const OWNER = 'ownerMk01', MGR = 'mgrMk0001';
const TOK = { [`t-${OWNER}`]: { uid: OWNER }, [`t-${MGR}`]: { uid: MGR } };
export const K1 = 'i_aaaaaaaaaaaa', K2 = 'i_bbbbbbbbbbbb', K3 = 'i_cccccccccccc';
const snap = (docs) => ({ empty: docs.length === 0, docs: docs.map((v, i) => ({ id: `d${i}`, data: () => v })) });
const versionMenu = (buildMenu, rows, cats) => buildMenu(snap(rows.map(([key, price, cat]) => ({ key, price, display: { price, cat, name: key } }))), snap([]),
  { exists: true, data: () => ({ categories: cats.map((id) => ({ id })), item_order: rows.map((r) => r[0]) }) }, 'test');
function prodDb(fake) {   // production's transaction semantics (the SDK's uncached first run sees null)
  return { ref(p = '') {
    const r = fake.ref(p);
    return { ...r, get: () => r.once(), async transaction(fn) {
      for (const pp of fake.failReads) if (String(p).startsWith(pp)) throw new Error(`injected failure: ${p}`);
      const cold = fn(null);
      if (cold === undefined) return { committed: false, snapshot: { val: () => null } };
      if (fake.get(p) === null) { fake.put(p, cold); return { committed: true, snapshot: { val: () => fake.get(p) } }; }
      return r.transaction(fn);
    } };
  } };
}
export async function backend({ offers = true, extra = null, ref = REF } = {}) {
  const { C, CFG, createFakeDb, R, makeRtdbMirror, makeRtdbMirrorReader, buildMenu } = libs(ref);
  const fake = createFakeDb({
    brands: { tb: { name: 'Tercera', active: true, locations: { tb_centro: 'member', tb_sur: 'member' }, activation: { state: 'on', since: 1 } } },
    restaurants: Object.fromEntries(['tb_centro', 'tb_sur'].map((rid) => [rid, { identity: { brand_id: 'tb', name: rid, active: true, version: 1 } }])),
  });
  const db = prodDb(fake);
  const roster = async (actor, op) => assert.equal((await R.mutateRoster({ db: fake, now: () => 1 }, 'tb', actor, op)).ok, true, `premise: roster ${op.type}`);
  await roster({ kind: 'cli', operator: 'op' }, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'Dueña', email: 'd@tb.hn' } });
  await roster({ kind: 'owner', uid: OWNER }, { type: 'grant_manager', uid: MGR, rids: ['tb_centro'] });
  const mirror = makeRtdbMirror(db);
  for (const rid of ['tb_centro', 'tb_sur']) await mirror(rid, { version: 'v1', seq: 1, rid, menu: { [K1]: 150, [K2]: 220, ...(rid === 'tb_centro' ? { [K3]: 90 } : {}) }, extras: {} });
  const setSwitch = async (on, expected) => assert.equal((await CFG.writeMarketingConfig(db, { expected, actor: 'cli:op', now: 1,
    config: { offers_enabled: on, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } } })).ok, true, 'premise: the config writer');
  await setSwitch(offers, 0);
  const CATALOG = { tb_centro: [[K1, 150, 'pizzas'], [K2, 220, 'pizzas'], [K3, 90, 'bebidas']], tb_sur: [[K1, 150, 'pizzas'], [K2, 220, 'pizzas']] };
  const CATS = { tb_centro: ['pizzas', 'bebidas'], tb_sur: ['pizzas'] };
  const deps = { db, verifyIdToken: async (t) => { if (!TOK[t]) throw new Error('bad token'); return TOK[t]; }, now: () => NOW,
    readMirror: makeRtdbMirrorReader(db), readCategoryMenu: async (rid) => versionMenu(buildMenu, CATALOG[rid], CATS[rid]) };
  const CORES = { getMarketing: C.getMarketingCore, marketingOfferSave: C.marketingOfferSaveCore, marketingOfferSetState: C.marketingOfferSetStateCore, marketingOfferRepeat: C.marketingOfferRepeatCore };
  const calls = [];
  // net.down: nothing reaches the server · net.lose = ['fn', …]: the listed calls RUN in the real core, then their replies are lost —
  // strictly in order (only the head is armed; each one shot) ·
  // net.hold = { fn, until: Promise }: that call's reply waits for `until` (one shot) — a write still in flight while the page moves on
  // net.drop = ['fn', …]: the next such call NEVER reaches the server (in order) — an outcome the client can't tell from a lost reply
  const net = { down: false, lose: [], hold: null, drop: [] };
  globalThis.fetch = async (url, opts) => {   // the portal's request, unchanged, into the real core (functions.js handler: status + json)
    if (net.down) throw new TypeError('Failed to fetch');
    const u = new URL(String(url));
    const fn = u.pathname.split('/').pop();
    const body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined;
    const auth = opts && opts.headers && opts.headers.Authorization;
    calls.push({ fn, query: Object.fromEntries(u.searchParams), body, method: opts.method });
    if (net.drop[0] === fn) { net.drop.shift(); throw new TypeError('Failed to fetch'); }
    if (!CORES[fn]) { const x = extra ? await extra(fn, body) : null; if (x) return x; }
    let out;
    try { out = await CORES[fn](deps, { method: opts.method, query: Object.fromEntries(u.searchParams), body, get: (h) => (h === 'authorization' ? auth : undefined) }); }
    catch (_) { out = { status: 500, body: { error: 'error' } }; }
    if (net.hold && net.hold.fn === fn) { const h = net.hold; net.hold = null; await h.until; }
    if (net.lose[0] === fn) { net.lose.shift(); throw new TypeError('Failed to fetch'); }   // strictly in order: only the head is armed
    const text = JSON.stringify(out.body);
    return { status: out.status, ok: out.status >= 200 && out.status < 300, json: async () => JSON.parse(text) };
  };
  const token = async () => `t-${OWNER}`;
  return { fake, deps, calls, net, setSwitch, token };
}
export const RID = 'tb_centro';
export const read = async (b, rid = RID) => getMarketingRaw({ rid, token: b.token });
export const form = (o = {}) => ({ ...ML.emptyForm(o.type || 'pct'), name: 'Martes de pizza', pct: 20, branches: [RID], start: NOW + DAY, end: NOW + 30 * DAY, days: [2], window: { from: 1080, to: 1320 }, ...o });
export const authored = (f) => { const r = ML.offerFromForm(f); assert.equal(r.ok, true, `premise: the form is valid (${JSON.stringify(r.errors)})`); return r.offer; };
export async function create(b, f) {
  const offer = authored(f);
  const res = await offerSaveRaw({ rid: RID, expectedRev: 0, offer, token: b.token });
  const c = ML.classifyWrite({ op: 'create' }, res);
  assert.equal(c.outcome, 'saved', `premise: created (${JSON.stringify(res.body)})`);
  return c.offer;
}
export async function publish(b, f) {
  const d = await create(b, f);
  const res = await offerSetStateRaw({ rid: RID, offerId: d.id, to: 'active', expectedRev: 1, token: b.token });
  const c = ML.classifyWrite({ op: 'state', offerId: d.id, expectedRev: 1, to: 'active' }, res);
  assert.equal(c.outcome, 'saved', `premise: published (${JSON.stringify(res.body)})`);
  return c.offer;
}
export const one = async (b, id) => ML.readModel((await read(b)).body).offers.find((o) => o.id === id);
