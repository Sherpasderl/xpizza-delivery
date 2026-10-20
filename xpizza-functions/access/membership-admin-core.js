'use strict';
// PLAN-portal-membership r3 §7 — the owner-run ONE-TIME cutover, as a testable core (tools/membership-admin.js is the CLI).
//   census     READ-ONLY. Both legacy owner directions, every roster (legacy managers, brand_members, kitchen_staff,
//              dispatchers), brands + identity brand_id. REFUSES (non-zero) unless prod is the KNOWN shape: every owner
//              forward + reverse consistent, every owned rid a validated LEGACY singleton, zero managers, valid uids / rids.
//              A reverse-only entry never becomes an owner.
//   backfill   ADDITIVE: bootstrap_owner (CLI-only) for each census-verified (uid, legacy brand). New paths only. Idempotent.
//   reconcile  member_of vs the forward rosters: missing / stale / malformed; --apply repairs member_of ONLY (never a grant).
//   compare    for every census uid + controls: today's decisions + lists (access/legacy-readers.js, legacy paths) vs the new
//              resolver + adapters reading ONLY the new paths. Any difference → refuse.
// The write freeze (§7.5) is held by the operator: nothing else grants while the cutover runs.
const F1 = require('../brands/brand-model');
const { UID_RE, resolveAccess, myLocations } = require('./membership');
const { mutateRoster } = require('./roster');
const OLD = require('./legacy-readers');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const val = async (db, p) => (await db.ref(p).once('value')).val();

async function census(db) {
  const findings = [];
  const restaurants = (await val(db, 'restaurants')) || {};
  const reverse = (await val(db, 'owner_restaurants')) || {};
  const brands = (await val(db, 'brands')) || {};
  const bm = (await val(db, 'brand_members')) || {};
  const dispatchers = Object.keys((await val(db, 'dispatchers')) || {}).sort();
  const forward = [];   // [uid, rid]
  const kitchen = [];
  for (const rid of Object.keys(restaurants).sort()) {
    const r = isObj(restaurants[rid]) ? restaurants[rid] : {};
    for (const uid of Object.keys(isObj(r.owners) ? r.owners : {}).sort()) forward.push([uid, rid]);
    for (const uid of Object.keys(isObj(r.managers) ? r.managers : {}).sort()) findings.push({ code: 'legacy_manager_present', rid, uid });
    for (const uid of Object.keys(isObj(r.kitchen_staff) ? r.kitchen_staff : {}).sort()) kitchen.push([uid, rid]);
  }
  const rev = [];
  for (const uid of Object.keys(reverse).sort()) for (const rid of Object.keys(isObj(reverse[uid]) ? reverse[uid] : {}).sort()) if (reverse[uid][rid] === true) rev.push([uid, rid]);
  const key = ([u, r]) => `${u}\u0000${r}`;
  const fset = new Set(forward.map(key)); const rset = new Set(rev.map(key));
  for (const p of forward) if (!rset.has(key(p))) findings.push({ code: 'forward_only_owner', uid: p[0], rid: p[1] });
  for (const p of rev) if (!fset.has(key(p))) findings.push({ code: 'reverse_only_owner', uid: p[0], rid: p[1] });
  const owners = [];
  // OWNER DECISION 2026-10-19: ONE owner per brand (no co-owners) — a legacy location with several owners stops the cutover
  const perRid = {};
  for (const [uid, rid] of forward) (perRid[rid] = perRid[rid] || []).push(uid);
  for (const rid of Object.keys(perRid).sort()) if (perRid[rid].length > 1) findings.push({ code: 'multiple_owners', rid, uids: perRid[rid] });
  for (const [uid, rid] of forward) {
    if (!UID_RE.test(uid)) findings.push({ code: 'bad_uid', uid, rid });
    if (!F1.isBrandId(rid)) { findings.push({ code: 'bad_rid', uid, rid }); continue; }
    const rec = brands[rid];
    const idBrand = isObj(restaurants[rid]) && isObj(restaurants[rid].identity) ? restaurants[rid].identity.brand_id : undefined;
    const legacyOk = rec && F1.validateBrand(rid, rec).ok && rec.activation.state === 'legacy'
      && Object.keys(rec.locations).length === 1 && rec.locations[rid] === 'member' && (idBrand === undefined || idBrand === rid);
    if (!legacyOk) { findings.push({ code: 'not_validated_legacy_singleton', uid, rid }); continue; }
    if (rset.has(key([uid, rid]))) owners.push({ uid, rid });
  }
  for (const b of Object.keys(bm).sort()) {
    const m = isObj(bm[b]) && isObj(bm[b].managers) ? bm[b].managers : {};
    for (const rid of Object.keys(m)) for (const uid of Object.keys(isObj(m[rid]) ? m[rid] : {})) findings.push({ code: 'brand_member_manager_present', brand: b, rid, uid });
    const o = isObj(bm[b]) && isObj(bm[b].owners) ? bm[b].owners : {};
    for (const uid of Object.keys(o)) if (!owners.some((x) => x.uid === uid && x.rid === b)) findings.push({ code: 'unexpected_new_owner', brand: b, uid });
  }
  return { ok: findings.length === 0, findings, owners, dispatchers, kitchen: kitchen.map(([uid, rid]) => ({ uid, rid })) };
}

async function backfill(db, owners, { operator, now = () => Date.now(), log = () => {} }) {
  const results = [];
  for (const { uid, rid } of owners) {
    const r = await mutateRoster({ db, now, log }, rid, { kind: 'cli', operator }, { type: 'bootstrap_owner', uid });
    results.push({ uid, rid, ...r });
  }
  return { ok: results.every((r) => r.ok), results };
}

function expectedIndex(bm) {
  const exp = {};
  for (const b of Object.keys(bm || {})) {
    const o = isObj(bm[b]) && isObj(bm[b].owners) ? bm[b].owners : {};
    for (const uid of Object.keys(o)) exp[`member_of/${uid}/brands/${b}`] = 'owner';
    const m = isObj(bm[b]) && isObj(bm[b].managers) ? bm[b].managers : {};
    for (const rid of Object.keys(m)) for (const uid of Object.keys(isObj(m[rid]) ? m[rid] : {})) exp[`member_of/${uid}/locations/${rid}`] = 'manager';
  }
  return exp;
}
async function reconcile(db, { apply = false } = {}) {
  const exp = expectedIndex((await val(db, 'brand_members')) || {});
  const idx = (await val(db, 'member_of')) || {};
  const have = {};
  const malformed = [];
  for (const uid of Object.keys(idx)) {
    const e = idx[uid];
    if (!isObj(e)) { malformed.push(`member_of/${uid}`); continue; }
    for (const kind of Object.keys(e)) {
      if (kind !== 'brands' && kind !== 'locations') { malformed.push(`member_of/${uid}/${kind}`); continue; }
      if (!isObj(e[kind])) { malformed.push(`member_of/${uid}/${kind}`); continue; }
      for (const id of Object.keys(e[kind])) have[`member_of/${uid}/${kind}/${id}`] = e[kind][id];
    }
  }
  const missing = Object.keys(exp).filter((p) => have[p] !== exp[p]).sort();
  const stale = Object.keys(have).filter((p) => !(p in exp)).sort();
  if (apply && (missing.length || stale.length || malformed.length)) {
    // codex build r1 P2-4: ONE non-overlapping replacement per affected uid — member_of/{uid} = the expected object (or null).
    // A descendant set next to an ancestor delete (malformed member_of/{uid} + an expected entry under it) is rejected by RTDB.
    const uidOf = (p) => p.split('/')[1];
    const affected = new Set([...missing, ...stale, ...malformed].map(uidOf));
    const u = {};
    for (const uid of affected) {
      const want = {};
      for (const p of Object.keys(exp)) {
        const [, pu, kind, id] = p.split('/');
        if (pu === uid) { want[kind] = want[kind] || {}; want[kind][id] = exp[p]; }
      }
      u[`member_of/${uid}`] = Object.keys(want).length ? want : null;
    }
    await db.ref().update(u);
  }
  return { ok: !missing.length && !stale.length && !malformed.length, missing, stale, malformed };
}

// codex build r1 P2-6: the ACTUAL operation results, old vs new. Every core runs through the OLD front door
// (legacy-readers.authorizeCatalogEditLegacy, reading the legacy paths) and through the NEW one (catalog-edit-auth.js, reading
// only the new paths) with dependencies that THROW past each gate — so the outcome is exactly the gate's decision: a refusal
// (status + error) or 'passed_gate'. The fiscal publish decision is the handler's own fiscalPublishGate (publishEditedCore itself is
// not invoked: it statically reaches the catalog registry writers — tools/registry-writers.test — and its auth / publish-cap gate
// is the same authorizer + can() table exercised above). Device pair / revoke /
// list share one gate (H1 authorizeManager): the old and the new are both invoked.
const SENTINEL = 'membership-compare-sentinel';
const boom = () => { const e = new Error(SENTINEL); e.sentinel = true; throw e; };
async function outcome(fn) {
  try {
    const r = await fn();
    return r && typeof r.status === 'number' ? { status: r.status, error: (r.body && r.body.error) || null } : r;
  } catch (e) { return e && e.sentinel ? 'passed_gate' : { threw: String((e && e.message) || e).slice(0, 80) }; }
}
async function operationResults(db, uid, rid, authorizeFn) {
  const { getEditableCatalogCore } = require('../catalog/portal-reads');
  const { resetDraftToLiveCore } = require('../catalog/reset-draft');
  const { editCatalogCore } = require('../catalog/edit-catalog-handler');
  const { fiscalPublishGate } = require('../catalog/publish-edited-handler');
  const { getSalesStatsCore } = require('../stats/stats-api');
  const get = (h) => (h.toLowerCase() === 'authorization' ? 'Bearer cmp' : undefined);
  const req = { method: 'GET', query: { restaurantId: rid }, get };
  const authorize = (r) => authorizeFn({ db, verifyIdToken: async () => ({ uid }) }, req, r);
  const fsBoom = { collection: boom, doc: boom };
  const out = {
    getEditableCatalog: await outcome(() => getEditableCatalogCore({ db: {}, fsdb: fsBoom, authorize, readActiveVersionId: boom, readActiveBuilt: boom, _sourceRefOf: boom }, req)),
    resetDraftToLive: await outcome(() => resetDraftToLiveCore({ db: fsBoom, authorize, readActiveVersionId: boom, previewVersion: boom }, { restaurantId: rid }, req)),
    editCatalog: await outcome(() => editCatalogCore({ db: fsBoom, authorize, readActiveBuilt: boom }, { restaurantId: rid, source: 'cmp' }, req)),
    salesStats: await outcome(() => getSalesStatsCore({ authorize, getKeyer: boom }, req)),
  };
  const a = await authorize(rid);
  out.fiscalPublish_noAck = a && a.ok ? fiscalPublishGate(rid, a, {}) : 'unauthorized';
  out.fiscalPublish_ack = a && a.ok ? fiscalPublishGate(rid, a, { fiscalAck: true }) : 'unauthorized';
  return out;
}
async function compare(db, { uids, rids, newReaders }) {
  const { authorizeCatalogEdit } = require('../catalog/catalog-edit-auth');
  const { authorizeManager } = require('../merchant/merchant-scope');
  const { resolveBrand } = require('../merchant/merchant-brand');
  const diffs = [];
  for (const uid of uids) {
    for (const rid of rids) {
      const was = await operationResults(db, uid, rid, OLD.authorizeCatalogEditLegacy);
      const now = await operationResults(db, uid, rid, authorizeCatalogEdit);
      for (const op of Object.keys(was)) if (JSON.stringify(was[op]) !== JSON.stringify(now[op])) diffs.push({ uid, rid, op, old: was[op], new: now[op] });
      const wasDev = await OLD.authorizeManager(db, uid, rid);
      const nowDev = (await authorizeManager(db, { uid, token: {} }, rid, { resolveBrand })).ok === true;
      if (wasDev !== nowDev) diffs.push({ uid, rid, op: 'device.pair|revoke|list', old: wasDev, new: nowDev });
    }
    const oldList = await OLD.myRestaurants(db, uid);
    const newList = await newReaders.myRestaurants(uid);
    if (JSON.stringify(oldList) !== JSON.stringify(newList)) diffs.push({ uid, op: 'getMyRestaurants', old: oldList, new: newList });
    const oldLocs = await OLD.myLocations(db, uid);
    const newLocs = await newReaders.merchantMyLocations(uid);
    if (JSON.stringify(oldLocs) !== JSON.stringify(newLocs)) diffs.push({ uid, op: 'merchantMyLocations', old: oldLocs, new: newLocs });
  }
  return { ok: diffs.length === 0, diffs };
}

// The snapshot-shaped fixture the rules-emulator comparison runs on (test/membership-cutover-rules.emulator.test.js):
// the census population only — uids, rids, brand records and identity brand_ids. No order, no customer data.
async function rulesFixture(db) {
  const c = await census(db);
  const brands = (await val(db, 'brands')) || {};
  const rids = [...new Set([...c.owners.map((o) => o.rid), ...c.kitchen.map((k) => k.rid)])].sort();
  const identities = {};
  for (const rid of rids) identities[rid] = { brand_id: await val(db, `restaurants/${rid}/identity/brand_id`) };
  return { census_ok: c.ok, owners: c.owners, dispatchers: c.dispatchers, kitchen: c.kitchen,
    kitchen_global: Object.keys((await val(db, 'kitchen')) || {}).sort(),
    brands: Object.fromEntries(rids.filter((r) => brands[r]).map((r) => [r, brands[r]])), identities };
}

// The new readers, as the deployed endpoints run them (cores, not re-implementations).
function makeNewReaders(db) {
  const { getMyRestaurantsCore } = require('../catalog/portal-reads');
  const D = require('../merchant/merchant-devices');
  class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
  const dbGet = { ref: (p) => { const r = db.ref(p); return { get: () => r.once('value'), once: (e) => r.once(e) }; } };
  return {
    async myRestaurants(uid) {
      const r = await getMyRestaurantsCore({ db: dbGet, verifyIdToken: async () => ({ uid }) },
        { method: 'GET', get: (h) => (h.toLowerCase() === 'authorization' ? 'Bearer t' : undefined) });
      return r.status === 200 ? r.body : { error: r.status };
    },
    async merchantMyLocations(uid) {
      try { return await D.myLocations({ db, HttpsError }, { uid, token: {} }, {}); } catch (e) { return { error: e.code }; }
    },
  };
}

async function runMembershipAdmin({ db, op, args = [], apply, operator, now = () => Date.now(), log = console.log, writeFile = null }) {
  if (op === 'census') {
    const c = await census(db);
    log(JSON.stringify({ ok: c.ok, owners: c.owners, findings: c.findings }, null, 2));
    return c.ok ? 0 : 3;
  }
  if (op === 'backfill') {
    const c = await census(db);
    if (!c.ok) { log(JSON.stringify({ refused: 'census_not_clean', findings: c.findings })); return 3; }
    if (!apply) { log(JSON.stringify({ dry_run: true, would_bootstrap: c.owners })); return 0; }
    const r = await backfill(db, c.owners, { operator, now, log: (k) => log(k) });
    log(JSON.stringify(r)); return r.ok ? 0 : 4;
  }
  if (op === 'reconcile') {
    const r = await reconcile(db, { apply });
    log(JSON.stringify(r));
    if (!apply) return r.ok ? 0 : 5;                    // --check: BLOCKING unless clean
    const again = await reconcile(db);                  // after a repair, re-verify
    log(JSON.stringify({ after_repair: again }));
    return again.ok ? 0 : 5;
  }
  if (op === 'compare') {
    const c = await census(db);
    if (!c.ok) { log(JSON.stringify({ refused: 'census_not_clean', findings: c.findings })); return 3; }   // codex build r1 P2-5
    const bm = (await val(db, 'brand_members')) || {};
    const managerUids = [];
    for (const b of Object.keys(bm)) { const m = isObj(bm[b]) && isObj(bm[b].managers) ? bm[b].managers : {}; for (const rid of Object.keys(m)) managerUids.push(...Object.keys(isObj(m[rid]) ? m[rid] : {})); }
    const uids = [...new Set([...c.owners.map((o) => o.uid), ...c.dispatchers, ...c.kitchen.map((k) => k.uid), ...managerUids, 'cmpNobody01'])].sort();
    const rids = [...new Set([...c.owners.map((o) => o.rid), ...c.kitchen.map((k) => k.rid), ...Object.keys(bm)])].sort();
    const r = await compare(db, { uids, rids, newReaders: makeNewReaders(db) });
    log(JSON.stringify({ ok: r.ok, compared: { uids: uids.length, rids }, diffs: r.diffs }, null, 2));
    return r.ok ? 0 : 6;
  }
  if (op === 'rules-fixture') {   // → stdout / the CLI writes it to the path given; consumed by test:membership-cutover-rules
    const fx = await rulesFixture(db);
    if (!fx.census_ok) { log(JSON.stringify({ refused: 'census_not_clean' })); return 3; }
    if (typeof writeFile === 'function' && args[0]) writeFile(args[0], `${JSON.stringify(fx, null, 1)}\n`); else log(JSON.stringify(fx));
    return 0;
  }
  if (op === 'transfer-owner') {   // OWNER DECISION 2026-10-19: owner transfer is a PLATFORM CLI operation only
    const [brandId, uid] = args || [];
    if (!apply) { log(JSON.stringify({ dry_run: true, would_transfer: { brandId, to: uid } })); return 0; }
    const r = await mutateRoster({ db, now, log: (k) => log(k) }, brandId, { kind: 'cli', operator }, { type: 'transfer_owner', uid });
    log(JSON.stringify(r)); return r.ok ? 0 : 4;
  }
  log('usage: membership-admin --project <id> census | backfill [--apply] | reconcile [--apply] | compare | rules-fixture <out.json> | transfer-owner <brandId> <uid> [--apply]');
  return 2;
}

module.exports = { census, backfill, reconcile, compare, operationResults, rulesFixture, expectedIndex, makeNewReaders, runMembershipAdmin };
