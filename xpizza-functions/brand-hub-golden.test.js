'use strict';
// BRAND-AGNOSTIC SERVER X1 (PLAN-brand-agnostic-server r3 §C golden split) — OLD (b5820e51) vs NEW decision tables over every
// (rid, coords, status, task) case the stacking / ingest-geofence / assign-hub paths exercise, with the SEEDED identities:
//   (1) UNCHANGED-LIVE: every live x_pizza / la_musa case is byte-identical OLD vs NEW;
//   (2) AUTHORIZED CHANGES: every case that differs is in the named list below, with its exact OLD → NEW values — and every
//       named change actually occurs (no stale entry).
// OLD = the real base modules (git show b5820e51) loaded from a temp dir; the ingest decision is the base index.js's two
// lines (`current_hub_lat ?? RESTAURANT_LAT` + isHubResolvable) over the OLD isHubResolvable. Run: node brand-hub-golden.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const NEW = require('./driver-ingest');
const { resolveAssignHub, hubOf } = require('./assign-hub');
const { IDENTITIES } = require('./seed_identity');

const BASE = 'b5820e51';
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-hub-golden-'));
for (const f of ['driver-ingest.js', 'assign-hub.js']) {
  fs.writeFileSync(path.join(dir, f), execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8' }));
}
const OLD = require(path.join(dir, 'driver-ingest.js'));
const OLD_HUB = require(path.join(dir, 'assign-hub.js'));
fs.rmSync(dir, { recursive: true, force: true });

const HUBS = Object.fromEntries(Object.entries(IDENTITIES).map(([rid, id]) => [rid, hubOf({ ...id, whatsapp_instance: 'i' })]));
const XP = HUBS.x_pizza; const LM = HUBS.la_musa;
assert.ok(XP && LM, 'premise: both seeded identities resolve to a hub');
const J = (v) => JSON.stringify(v === undefined ? null : v);

const diffs = [];   // [table, case, OLD, NEW]
const cmp = (table, label, oldV, newV) => { if (J(oldV) !== J(newV)) diffs.push([table, label, J(oldV), J(newV)]); };

// ── stacking: resolvePickupHub over rid × coords ──
const RIDS = { x_pizza: 'x_pizza', la_musa: 'la_musa', null: null };
const COORDS = { XP: [XP.lat, XP.lng], LM: [LM.lat, LM.lng], absent: [undefined, undefined], other: [15.6, -88.1], strings: ['15.5', '-88'] };
for (const [rk, rid] of Object.entries(RIDS)) for (const [ck, [lat, lng]] of Object.entries(COORDS)) {
  const pk = { type: 'pickup', restaurant_id: rid, destination_lat: lat, destination_lng: lng };
  cmp('resolvePickupHub', `${rk}/${ck}`, OLD.resolvePickupHub(pk), NEW.resolvePickupHub(pk, HUBS));
}
cmp('resolvePickupHub', 'no task', OLD.resolvePickupHub(null), NEW.resolvePickupHub(null, HUBS));

// ── stacking: driverHasSameHubAccepted over accepted-order × new-order pickups (and task statuses) ──
const PK = { 'x_pizza/XP': ['x_pizza', XP], 'la_musa/LM': ['la_musa', LM], 'x_pizza/absent': ['x_pizza', null], 'null/absent': [null, null], 'null/XP': [null, XP], 'la_musa/XP': ['la_musa', XP] };
for (const [ak, [arid, ahub]] of Object.entries(PK)) for (const [nk, [nrid, nhub]] of Object.entries(PK)) for (const st of ['accepted', 'in_progress', 'assigned']) {
  const p = (oid, rid, hub, status) => ({ order_id: oid, type: 'pickup', status, assigned_driver_id: 'd1', restaurant_id: rid, destination_lat: hub ? hub.lat : undefined, destination_lng: hub ? hub.lng : undefined });
  const tasks = { o1_pickup: p('o1', arid, ahub, 'completed'), o1_delivery: { order_id: 'o1', type: 'delivery', status: st, assigned_driver_id: 'd1' }, o2_pickup: p('o2', nrid, nhub, 'assigned') };
  cmp('driverHasSameHubAccepted', `accepted ${ak} (${st}) + new ${nk}`, OLD.driverHasSameHubAccepted(tasks, 'd1', 'o2'), NEW.driverHasSameHubAccepted(tasks, 'd1', 'o2', HUBS));
}

// ── ingest geofence hub: OLD = base index.js (current_hub ?? RESTAURANT_LAT + isHubResolvable); NEW = ingestHubFor ──
const oldIngest = (d) => {
  const hubLat = d.current_hub_lat ?? OLD_HUB.X_PIZZA_HUB.lat; const hubLng = d.current_hub_lng ?? OLD_HUB.X_PIZZA_HUB.lng;
  const ver = d.current_hub_task_id == null || d.current_hub_task_id === d.current_task_id;
  return ver && OLD.isHubResolvable(d.current_restaurant_id, hubLat, hubLng) ? { hubLat, hubLng } : null;
};
const newIngest = (d) => { const rid = NEW.ingestHubRid(d); return NEW.ingestHubFor(d, rid == null ? {} : { [rid]: HUBS[rid] || null }); };
const SNAP = { 'x_pizza@XP': ['x_pizza', XP], 'la_musa@LM': ['la_musa', LM], 'la_musa@XP': ['la_musa', XP], 'x_pizza@absent': ['x_pizza', null], 'cleared': [null, null], 'null@XP': [null, XP] };
for (const [sk, [rid, hub]] of Object.entries(SNAP)) for (const task of [null, 't1']) for (const ver of ['live', 'stale', 'unversioned']) for (const ret of [undefined, 'x_pizza', 'la_musa']) {
  const d = { current_restaurant_id: rid, current_hub_lat: hub ? hub.lat : null, current_hub_lng: hub ? hub.lng : null, current_task_id: task,
    current_hub_task_id: ver === 'live' ? task : ver === 'stale' ? 'old' : null, return_restaurant_id: ret };
  cmp('ingestHub', `${sk} task=${task} ver=${ver} return=${ret}`, oldIngest(d), newIngest(d));
}

// ── auto-assign hub: OLD resolveAssignHub(order) vs NEW resolveAssignHub(db, order) over a seeded fake db ──
const fakeDb = { ref: (p) => ({ once: async () => ({ val: () => { const m = /^restaurants\/([^/]+)\/identity$/.exec(p); return m && IDENTITIES[m[1]] ? { ...IDENTITIES[m[1]], whatsapp_instance: 'i' } : null; } }) }) };
(async () => {
  const ORDERS = {
    'x_pizza stamped': { restaurant_id: 'x_pizza', hub_lat: XP.lat, hub_lng: XP.lng }, 'la_musa stamped': { restaurant_id: 'la_musa', hub_lat: LM.lat, hub_lng: LM.lng },
    'x_pizza unstamped': { restaurant_id: 'x_pizza' }, 'la_musa unstamped': { restaurant_id: 'la_musa' }, 'x_pizza malformed': { restaurant_id: 'x_pizza', hub_lat: 'oops' },
    'no rid unstamped': {}, 'null order': undefined,
  };
  for (const [k, o] of Object.entries(ORDERS)) {
    const nv = await resolveAssignHub(fakeDb, o);
    cmp('resolveAssignHub', k, OLD_HUB.resolveAssignHub(o), nv.unresolved ? { unresolved: nv.unresolved } : nv);
  }

  // ── (2) the AUTHORIZED changes — exact OLD → NEW, each named (PLAN r3 §C) ──
  const AUTH = {
    // x_pizza explicit-absent-coords pickup → no stack (§C: absent coords → null for EVERY brand)
    'resolvePickupHub|x_pizza/absent': [J(XP), 'null'],
    // malformed (string) pickup coords are absent coords → no stack (§C), for x_pizza and a null rid alike
    'resolvePickupHub|x_pizza/strings': [J(XP), 'null'],
    'resolvePickupHub|null/strings': [J(XP), 'null'],
    // a null-rid pickup → no stack (§C: a null rid → null; never maps to x_pizza)
    'resolvePickupHub|null/XP': [J(XP), 'null'],
    'resolvePickupHub|null/absent': [J(XP), 'null'],
    // a returning La Musa driver geofences at La Musa instead of X. Pizza (§A/§D: return_restaurant_id)
    'ingestHub|cleared task=null ver=live return=la_musa': [J({ hubLat: XP.lat, hubLng: XP.lng }), J({ hubLat: LM.lat, hubLng: LM.lng })],
    'ingestHub|cleared task=null ver=unversioned return=la_musa': [J({ hubLat: XP.lat, hubLng: XP.lng }), J({ hubLat: LM.lat, hubLng: LM.lng })],
    // a no-history driver (no return_restaurant_id) gets no geofence (§D: never x_pizza by default)
    'ingestHub|cleared task=null ver=live return=undefined': [J({ hubLat: XP.lat, hubLng: XP.lng }), 'null'],
    'ingestHub|cleared task=null ver=unversioned return=undefined': [J({ hubLat: XP.lat, hubLng: XP.lng }), 'null'],
    // a cleared snapshot WITH a task (in flight) / a null-rid snapshot never maps to x_pizza (§D: "Otherwise → null")
    ...Object.fromEntries(['live', 'unversioned'].flatMap((ver) => [undefined, 'x_pizza', 'la_musa'].flatMap((ret) => [
      [`ingestHub|cleared task=t1 ver=${ver} return=${ret}`, [J({ hubLat: XP.lat, hubLng: XP.lng }), 'null']],
      [`ingestHub|null@XP task=t1 ver=${ver} return=${ret}`, [J({ hubLat: XP.lat, hubLng: XP.lng }), 'null']],
      [`ingestHub|null@XP task=null ver=${ver} return=${ret}`, [J({ hubLat: XP.lat, hubLng: XP.lng }), ret === 'x_pizza' ? J({ hubLat: XP.lat, hubLng: XP.lng }) : ret === 'la_musa' ? J({ hubLat: LM.lat, hubLng: LM.lng }) : 'null']],
    ]))),
    // RULING (T6): a snapshot whose coords are ABSENT → no geofence for every brand (today `?? RESTAURANT_LAT` turns an
    // x_pizza one into the X. Pizza hub) — the same absent-coords → null rule as §C
    ...Object.fromEntries(['t1', null].flatMap((task) => ['live', 'unversioned'].flatMap((ver) => [undefined, 'x_pizza', 'la_musa'].map((ret) =>
      [`ingestHub|x_pizza@absent task=${task} ver=${ver} return=${ret}`, [J({ hubLat: XP.lat, hubLng: XP.lng }), 'null']])))),
    // an UNSTAMPED la_musa order ranks drivers from La Musa's hub (its identity) instead of X. Pizza's (r0 §2.2)
    'resolveAssignHub|la_musa unstamped': [J({ hubLat: XP.lat, hubLng: XP.lng }), J({ hubLat: LM.lat, hubLng: LM.lng })],
    // a hub-less order (no stamped hub, no restaurant identity) goes manual instead of the x_pizza hub (§E)
    'resolveAssignHub|no rid unstamped': [J({ hubLat: XP.lat, hubLng: XP.lng }), J({ unresolved: 'no_hub' })],
    'resolveAssignHub|null order': [J({ hubLat: XP.lat, hubLng: XP.lng }), J({ unresolved: 'no_hub' })],
  };
  // stale-version rows: OLD refuses (version) — NEW must refuse too, so they are NOT in AUTH. Same-hub pairs inherit the
  // resolvePickupHub changes: list them by rule, then require every diff to be authorized.
  // same-hub pairs inherit the resolvePickupHub changes: a pair involving a changed pickup may only LOSE a force-accept
  const pkChange = (k) => ['x_pizza/absent', 'null/absent', 'null/XP'].includes(k);   // (strings is not a same-hub row)
  const sameHubAuthorized = (label) => { const m = /^accepted (\S+) \(\S+\) \+ new (\S+)$/.exec(label); return !!m && (pkChange(m[1]) || pkChange(m[2])); };
  const unauthorized = []; const seen = new Set(); let inherited = 0;
  for (const [table, label, o, nv] of diffs) {
    const key = `${table}|${label}`;
    if (AUTH[key]) { assert.deepStrictEqual([o, nv], AUTH[key], `authorized change ${key} has the named OLD → NEW`); seen.add(key); continue; }
    if (table === 'driverHasSameHubAccepted' && sameHubAuthorized(label) && o === 'true' && nv === 'false') { inherited++; continue; }
    unauthorized.push(`${key}: ${o} → ${nv}`);
  }
  assert.deepStrictEqual(unauthorized, [], `(1) UNCHANGED-LIVE: every non-authorized case is byte-identical OLD vs NEW:\n  ${unauthorized.join('\n  ')}`);
  ok(`(1) unchanged-live: of ${diffs.length} differing cells every one is authorized (${seen.size} named + ${inherited} same-hub pairs that only lose a force-accept through a changed pickup); every other x_pizza / la_musa case byte-identical`);
  const stale = Object.keys(AUTH).filter((k) => !seen.has(k) && AUTH[k][0] !== AUTH[k][1]);
  assert.deepStrictEqual(stale, [], `(2) every named authorized change occurs: ${stale.join(', ')}`);
  ok(`(2) authorized changes (${seen.size} named cells): absent-coords / null-rid pickup → no stack; returning La Musa driver → La Musa; no-history / null-rid / absent-coords snapshot → no geofence; hub-less order → manual`);

  // the x_pizza returning driver (return_restaurant_id = x_pizza) is the byte-identical hinge of the returning path
  for (const ver of ['live', 'unversioned']) {
    const d = { current_restaurant_id: null, current_hub_lat: null, current_hub_lng: null, current_task_id: null, current_hub_task_id: ver === 'live' ? null : null, return_restaurant_id: 'x_pizza' };
    assert.deepStrictEqual(newIngest(d), oldIngest(d), 'an x_pizza returning driver geofences at X. Pizza exactly as before');
  }
  ok('hinge: an x_pizza returning driver (return_restaurant_id x_pizza) geofences at the X. Pizza hub exactly as before');
  console.log(`\nbrand-hub-golden: OK (${n})`);
})().catch((e) => { console.error('brand-hub-golden FAILED:', e); process.exit(1); });
