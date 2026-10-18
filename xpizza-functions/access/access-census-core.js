'use strict';
// PLATFORM F2 Q1 (PLAN-F2-query-rules §1.2) — the ACCESS CENSUS core: read-only, over an injected RTDB handle; paged by key so no
// query returns more than a page. A BLOCKING finding → exit 1; a read failure → exit 1 (fail closed); a bad mapping → exit 2.
//   (a) ownership       F1's checkMembership (brands/brand-model.js — valid ids, member|retired values, the legacy identity
//                       exception) over every brand and every restaurant identity; then every order's restaurant_id is a
//                       non-empty string and a location of a VALID brand (member ∪ retired)
//   (b) KDS parity      per kitchen deployment (platform/sites.json app 'kitchen', context = its pinned rid): TODAY's effective
//                       live / scheduled sets (the FROZEN pre-F2 filter, access/kds-filter-pre-f2.mjs) vs the PROPOSED exact-rid sets; a difference is
//                       blocking unless the reviewed mapping lists that order under visibility_exceptions
//   (c) kitchen roster  EVERY actual restaurants/*/kitchen_staff roster (orphan restaurants included) vs the reviewed mapping
//                       {uid: {rids, kind: human|terminal, deployment?}}: missing / extra membership and a global /kitchen uid
//                       absent from the mapping are blocking; the mapping itself is validated first (validateMapping — the
//                       SAME validator kitchen-roster runs before any write)
//   (d) attribution     primary ≠ legacy delivery attribution pairs, legacy-only orders — INFORMATIONAL (advisor: union accepted)
//   (e) task keys       every tasks/{tid} has tid === order_id + '_' + type, type ∈ {pickup, delivery} — blocking
//   (f) history size    per rid: count + bytes of its orders; per driver: count + bytes of each attribution set; daily counts
//                       of the last 14 days per rid
// No brand literal: the locations come from /brands, the KDS deployments from the manifest.
const { validateBrand, checkMembership } = require('../brands/brand-model');

const PAGE = 200;
const TASK_TYPES = new Set(['pickup', 'delivery']);
const isId = (v) => typeof v === 'string' && v.length > 0;
const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
// an RTDB path COMPONENT (key): non-empty, ≤ 768 bytes, none of . # $ [ ] / and no control character
// eslint-disable-next-line no-control-regex
const isKey = (v) => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v, 'utf8') <= 768 && !/[.#$[\]/\u0000-\u001f\u007f]/.test(v);

async function pageKeys(rtdb, path, pageSize, fn) {
  let last = null;
  for (;;) {
    let q = rtdb.ref(path).orderByKey();
    if (last !== null) q = q.startAfter(last);
    const snap = await q.limitToFirst(pageSize).once('value');
    const rows = []; snap.forEach((c) => { rows.push([c.key, c.val()]); });
    for (const [k, v] of rows) { await fn(k, v); last = k; }
    if (rows.length < pageSize) return;
  }
}
const val = async (rtdb, p) => (await rtdb.ref(p).once('value')).val();

// THE mapping validator — run by the census AND by kitchen-roster BEFORE any write (codex Q1 r1 P1-2). kitchenDeployments: Map
// deployment id → its pinned context rid.
function validateMapping(m, locations, kitchenDeployments) {
  const errs = [];
  if (!m || typeof m !== 'object' || !m.kitchen || typeof m.kitchen !== 'object' || Array.isArray(m.kitchen)) return ['mapping: missing "kitchen" object'];
  for (const [uid, e] of Object.entries(m.kitchen)) {
    if (!isKey(uid)) { errs.push(`mapping: uid ${JSON.stringify(uid)} is not a valid RTDB key`); continue; }
    if (!e || !Array.isArray(e.rids) || !e.rids.length) { errs.push(`mapping: ${uid}.rids must be a non-empty list`); continue; }
    if (!e.rids.every(isKey)) { errs.push(`mapping: ${uid}.rids contains an invalid RTDB key`); continue; }
    if (new Set(e.rids).size !== e.rids.length) errs.push(`mapping: ${uid}.rids has duplicates`);
    if (!['human', 'terminal'].includes(e.kind)) errs.push(`mapping: ${uid}.kind must be human | terminal`);
    for (const r of e.rids) if (!locations.has(r)) errs.push(`mapping: ${uid} names ${r}, which is not a location of a valid brand`);
    if (e.kind === 'terminal' && e.rids.length !== 1) errs.push(`mapping: terminal ${uid} must map to exactly ONE location (got ${e.rids.length})`);
    if (e.deployment !== undefined) {
      if (!kitchenDeployments.has(e.deployment)) errs.push(`mapping: ${uid}.deployment ${e.deployment} is not a kitchen deployment in the manifest`);
      else if (!e.rids.includes(kitchenDeployments.get(e.deployment))) errs.push(`mapping: ${uid}.deployment ${e.deployment} pins ${kitchenDeployments.get(e.deployment)}, which is not one of its rids`);
    }
  }
  if (m.visibility_exceptions !== undefined && (typeof m.visibility_exceptions !== 'object' || m.visibility_exceptions === null || Array.isArray(m.visibility_exceptions))) errs.push('mapping: visibility_exceptions must be {orderId: reason}');
  return errs;
}

// the locations of VALID brands (F1 validateBrand) and every restaurant's identity + roster, orphans included
async function readWorld(rtdb, pageSize) {
  const brands = (await val(rtdb, 'brands')) || {};
  const locations = new Set();
  for (const [b, rec] of Object.entries(brands)) if (validateBrand(b, rec).ok) for (const rid of Object.keys(rec.locations)) locations.add(rid);
  const identities = {}; const rosters = new Map();   // rid → [uid…]
  await pageKeys(rtdb, 'restaurants', pageSize, async (rid, r) => {
    if (r && r.identity !== undefined) identities[rid] = r.identity;
    const ks = r && r.kitchen_staff && typeof r.kitchen_staff === 'object' ? Object.keys(r.kitchen_staff) : [];
    if (ks.length) rosters.set(rid, ks);
  });
  return { brands, locations, identities, rosters };
}

// --sections (RUNBOOK-F2-Q3): the sections whose findings GATE the exit code; the others are still reported, as not_gating.
// a = ownership / membership / KDS deployment location · b = KDS parity · c = kitchen roster (needs a mapping) · e = task keys.
const SECTIONS = new Set(['a', 'b', 'c', 'e']);
async function runAccessCensus({ rtdb, mapping, sites, filters, nowMs, pageSize = PAGE, sections = null }) {
  if (sections !== null && (!Array.isArray(sections) || !sections.length || sections.some((x) => !SECTIONS.has(x)))) return { code: 2, report: { usage_errors: [`--sections must be a non-empty subset of ${[...SECTIONS].join(',')}`] } };
  const gates = (x) => sections === null || sections.includes(x);
  const wantRoster = sections === null || sections.includes('c');
  if (wantRoster && (mapping === undefined || mapping === null)) return { code: 2, report: { usage_errors: ['section c (kitchen roster) needs --mapping'] } };
  const found = []; const info = {};
  const blocking = { push: (sec, f) => found.push({ sec, f }) };
  const { brands, locations, identities, rosters } = await readWorld(rtdb, pageSize);
  const kitchenDeps = new Map((sites.deployments || []).filter((d) => d.app === 'kitchen').map((d) => [d.id, d.context]));
  const mapErrs = mapping === undefined || mapping === null ? [] : validateMapping(mapping, locations, kitchenDeps);
  if (mapErrs.length) return { code: 2, report: { mapping_errors: mapErrs } };
  // (a) F1 membership contract (brand validity, member|retired, identity.brand_id incl. the legacy exception)
  for (const f of checkMembership(brands, identities)) blocking.push('a', `membership:${f.code}:${f.brandId || ''}:${f.rid || ''}`);
  for (const [dep, rid] of kitchenDeps) if (!locations.has(rid)) blocking.push('a', `kds_deployment_unknown_location:${dep}:${rid}`);
  // ── one paged pass over /orders: (a) order ownership, (b) parity, (d) attribution, (f) history ──
  const exceptions = (mapping && mapping.visibility_exceptions) || {};
  const parity = []; const perRid = {}; const perDriver = {}; const daily = {};
  let primaryNeLegacy = 0; let legacyOnly = 0; let orders = 0;
  const DAY = 86400000; const since = nowMs - 14 * DAY;
  const exact = (o, rid) => o && o.restaurant_id === rid;
  await pageKeys(rtdb, 'orders', pageSize, async (oid, o) => {
    orders += 1;
    const rid = o && o.restaurant_id;
    if (!isId(rid)) blocking.push('a', `order_location_absent:${oid}`);
    else if (!locations.has(rid)) blocking.push('a', `order_location_unknown:${oid}:${rid}`);
    const one = { [oid]: o };
    for (const [dep, kr] of kitchenDeps) {
      const todayLive = oid in filters.filterLiveOrders(one, kr); const todaySched = oid in filters.filterScheduledOrders(one, kr);
      const newLive = exact(o, kr) && !filters.NON_LIVE_ORDER_STATUSES.has(o.status);
      const newSched = exact(o, kr) && filters.SCHEDULED_ORDER_STATUSES.has(o.status);
      if ((todayLive !== newLive || todaySched !== newSched) && !Object.prototype.hasOwnProperty.call(exceptions, oid)) parity.push(`${dep}:${oid} (today live=${todayLive} sched=${todaySched}; proposed live=${newLive} sched=${newSched})`);
    }
    if (o) {
      const p = o.delivered_by_driver_uid; const l = o.delivered_by_uid;
      if (isId(p) && isId(l) && p !== l) primaryNeLegacy += 1;
      if (!isId(p) && isId(l)) legacyOnly += 1;
      const b = bytes(o);
      if (isId(rid)) { const r = (perRid[rid] = perRid[rid] || { count: 0, bytes: 0 }); r.count += 1; r.bytes += b; }
      for (const [field, uid] of [['primary', p], ['legacy', l]]) if (isId(uid)) {
        const d = (perDriver[uid] = perDriver[uid] || { primary: { count: 0, bytes: 0 }, legacy: { count: 0, bytes: 0 } });
        d[field].count += 1; d[field].bytes += b;
      }
      const at = Number(o.created_at);
      if (isId(rid) && Number.isFinite(at) && at >= since) {
        const day = new Date(at).toISOString().slice(0, 10);
        daily[rid] = daily[rid] || {}; daily[rid][day] = (daily[rid][day] || 0) + 1;
      }
    }
  });
  for (const p of parity) blocking.push('b', `kds_parity:${p}`);
  // (e) task keys
  let tasks = 0;
  await pageKeys(rtdb, 'tasks', pageSize, async (tid, t) => {
    tasks += 1;
    if (!t || !isId(t.order_id) || !TASK_TYPES.has(t.type) || tid !== `${t.order_id}_${t.type}`) blocking.push('e', `task_key_noncanonical:${tid}`);
  });
  // (c) roster — structured (rid, uid) pairs over EVERY actual roster
  const globalKitchen = Object.keys((await val(rtdb, 'kitchen')) || {});
  const haveMapping = mapping !== undefined && mapping !== null;
  const mapped = haveMapping ? mapping.kitchen : {};
  const has = (rid, uid) => (rosters.get(rid) || []).includes(uid);
  for (const [uid, e] of Object.entries(mapped)) for (const r of e.rids) if (!has(r, uid)) blocking.push('c', `roster_missing:${uid}@${r}`);
  for (const [rid, uids] of rosters) for (const uid of uids) if (!(mapped[uid] && mapped[uid].rids.includes(rid))) blocking.push('c', `roster_extra:${uid}@${rid}${locations.has(rid) ? '' : ' (orphan restaurant)'}`);
  for (const uid of globalKitchen) if (!mapped[uid]) blocking.push('c', `kitchen_unmapped:${uid}`);
  info.attribution = { primary_ne_legacy: primaryNeLegacy, legacy_only: legacyOnly };
  info.history = { per_rid: perRid, per_driver: perDriver, daily_last_14d: daily };
  info.scanned = { orders, tasks, locations: locations.size, restaurants_with_roster: rosters.size, kitchen_deployments: kitchenDeps.size, kitchen_uids: globalKitchen.length };
  const roster = (f) => f.sec === 'c' && !haveMapping;   // no mapping → the roster cannot be judged → omitted (c is then not selected)
  const gating = found.filter((f) => !roster(f) && gates(f.sec)).map((f) => f.f);
  const report = { blocking: gating, info };
  if (sections !== null) { report.sections = sections; report.not_gating = found.filter((f) => !roster(f) && !gates(f.sec)).map((f) => f.f); }
  return { code: gating.length ? 1 : 0, report };
}

module.exports = { runAccessCensus, validateMapping, readWorld, pageKeys, isKey };
