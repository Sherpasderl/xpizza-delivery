'use strict';
/* 1D D4-c2b §8 — the MERCHANT-LATENCY rows with the monitor running, under LATENCY-PROTOCOL v2 (A = monitor OFF, B = monitor ON,
   A/A = OFF/OFF; bars FIXED: p95 Δ ≤ +10 % AND ≤ +150 ms, paired median Δ ≤ 5 ms; A/A noise only grades adequacy).
     npm run measure:c2b-latency -- [--rows <a,b,…>]           (writes the report JSON to stdout; progress on stderr)
   Rows (§8):
     publish / rollback × {x_pizza (certified), la_musa (uncertified), synth400 (400-object, certified)} — the monitor on the SAME
       restaurant and the others, so every sample overlaps monitor reads;
     the five merchant operations × {other, same}: getMyRestaurants, getEditableCatalog, editCatalog (a change) + an UNCHANGED save,
       publishEdited, getSalesStats (JSON + the daily and orders CSV variants) — monitor against OTHER restaurants, and against the
       SAME restaurant (its precheck passes with the quiet window at 0, so every check overlaps right after the precheck).
   Each (row, condition) runs in its OWN child process (one index.js per process): identical seeded state restored before EVERY
   sample, 5 warm-ups, 50 samples, concurrency 1. Design (PREREG): K = 6 blocks; a block = one A/B pair + one A/A pair; the side
   that runs FIRST follows ABBA BAAB …, so each runs first in exactly 3 of 6; the A/B and A/A pairs swap order every block;
   block-major execution. The ON condition's monitor runs INSIDE the child (the benchmark process tree) at max pacing
   (100 reads/s) and stops when the child ends. LAT_SAMPLES / LAT_BLOCKS / LAT_WARM override the counts for the mechanics
   SELF-TEST only (its outputs are not data). */
require('./_emulator-required')('database', 'firestore');
const path = require('path');
const { execFileSync } = require('child_process');

const SAMPLES = process.env.LAT_SAMPLES ? Number(process.env.LAT_SAMPLES) : 50;
const BLOCKS = process.env.LAT_BLOCKS ? Number(process.env.LAT_BLOCKS) : 6;
const WARM = process.env.LAT_WARM ? Number(process.env.LAT_WARM) : 5;
const BARS = Object.freeze({ relMax: 0.10, absMaxMs: 150, medMaxMs: 5 });   // the plan's FIXED bars (§8), never widened
const OTHERS = ['synth_lat_o1', 'synth_lat_o2', 'synth_lat_o3'];
const ROWS = [
  ...['x_pizza', 'la_musa', 'synth400'].flatMap((c) => ['publish', 'rollback'].map((op) => ({ key: `${op}/${c}`, op, rid: c === 'synth400' ? 'synth_lat_400' : c, overlap: 'same+others' }))),
  ...['getMyRestaurants', 'getEditableCatalog', 'editCatalog', 'editCatalog_unchanged', 'publishEdited', 'getSalesStats_json', 'getSalesStats_csv_daily', 'getSalesStats_csv_orders']
    .flatMap((op) => ['other', 'same'].map((ov) => ({ key: `${op}/x_pizza/${ov}`, op, rid: 'x_pizza', overlap: ov }))),
];

/* TARGETED RESTORE (advisor ruling R1) — the per-operation restore sets, DECLARED from the discovery run (c2b-work/latency/discover:
   what ONE run of each operation writes in the restaurant's Firestore subtree). `fresh` = collections whose docs absent from the seed
   are deleted (recursively); `docs` = docs rewritten from the seed (or deleted if the seed has none). Read-only operations: none.
   Equivalence is PROVEN, not assumed: the full canonical subtree digest must equal the SEEDED digest at every child start, after
   every restore in the self-test (LAT_DIGEST_EVERY=1), and after every 10th sample's restore in the real run — any mismatch VOIDS
   the try (the child stops, the parent stops; no silent re-restore). */
const META = (d) => `meta/${d}`;
const RESTORE_SETS = Object.freeze({
  publish: { fresh: ['versions', 'identity_evidence'], docs: [META('active_version'), META('active_snapshot'), META('publish_lock')] },
  publishEdited: { fresh: ['versions', 'identity_evidence'], docs: [META('active_version'), META('active_snapshot'), META('publish_lock'), META('source')] },
  rollback: { fresh: ['identity_evidence'], docs: [META('active_version'), META('active_snapshot'), META('publish_lock')] },
  editCatalog: { fresh: [], docs: [META('source')] },
  editCatalog_unchanged: { fresh: [], docs: [META('source')] },
  getMyRestaurants: null, getEditableCatalog: null, getSalesStats_json: null, getSalesStats_csv_daily: null, getSalesStats_csv_orders: null,
});
const DIGEST_EVERY = process.env.LAT_DIGEST_EVERY ? Number(process.env.LAT_DIGEST_EVERY) : 10;

if (process.argv[2] === '--child') { child(process.argv[3], process.argv[4]); return; }

const ST = require('./_latency-stats');
const argRows = (() => { const i = process.argv.indexOf('--rows'); return i > 0 ? process.argv[i + 1].split(',') : null; })();
const rows = argRows ? ROWS.filter((r) => argRows.includes(r.key)) : ROWS;
if (!rows.length) { console.error(`no rows; known: ${ROWS.map((r) => r.key).join(' ')}`); process.exit(2); }
const runChild = (rowKey, cond) => {
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.FORCE_COLOR;
  const t0 = Date.now();
  const out = execFileSync('node', [__filename, '--child', rowKey, cond], { encoding: 'utf8', env, maxBuffer: 1 << 27, timeout: 1800000 });
  const res = { ...JSON.parse(out.trim().split('\n').pop()), started_at: t0, ended_at: Date.now() };
  if (!res.digest || res.digest.mismatches !== 0 || res.digest.start_ok !== true) {
    // R1: a state mismatch VOIDS the try — stop now, report what was found; never re-restore and continue
    console.error(JSON.stringify({ VOID: 'state_digest_mismatch', row: rowKey, cond, digest: res.digest }));
    console.log(JSON.stringify({ void: true, reason: 'state_digest_mismatch', row: rowKey, cond, digest: res.digest }));
    process.exit(4);
  }
  return res;
};
if (process.env.LAT_DISCOVER) { for (const row of rows) console.log(JSON.stringify(runChild(row.key, 'off'))); process.exit(0); }
const xFirst = (k) => [true, false, false, true][k % 4];
const pairRun = (k, runX, runY) => { if (xFirst(k)) { const x = runX(); return { x, y: runY(), first: 'x' }; } const y = runY(); return { x: runX(), y, first: 'y' }; };
const childValid = (c, cond) => c.digest && c.digest.mismatches === 0 && c.digest.start_ok === true && c.errors === 0 && c.ms.length === SAMPLES && (cond === 'on' ? c.monitor.overlapped === SAMPLES && c.monitor.runs > 0 : c.monitor.runs === 0);
const r1 = (v) => +v.toFixed(1);

const raw = {};
for (let k = 0; k < BLOCKS; k++) {
  for (const row of rows) {
    const R = raw[row.key] || (raw[row.key] = { ab: [], aa: [] });
    const ab = () => { const p = pairRun(k, () => runChild(row.key, 'off'), () => runChild(row.key, 'on')); R.ab.push({ k, first: p.first === 'x' ? 'off' : 'on', off: p.x, on: p.y }); };
    const aa = () => { const p = pairRun(k, () => runChild(row.key, 'off'), () => runChild(row.key, 'off')); R.aa.push({ k, first: p.first === 'x' ? 'off1' : 'off2', off1: p.x, off2: p.y }); };
    if (k % 2 === 0) { ab(); aa(); } else { aa(); ab(); }
    console.error(JSON.stringify({ block: k, row: row.key, ab_first: R.ab[R.ab.length - 1].first, aa_first: R.aa[R.aa.length - 1].first }));
  }
}
const report = { design: { blocks: BLOCKS, warmups: WARM, samples: SAMPLES, concurrency: 1, bars: BARS, order: 'ABBA BAAB per row; A/B and A/A pairs swap order each block; block-major',
  A: 'monitor OFF', B: 'monitor ON (in-process, max pacing, quiet window 0)' }, rows: [] };
for (const row of rows) {
  const R = raw[row.key];
  const abBlocks = R.ab.map((b) => ({ x: b.off.ms, y: b.on.ms }));
  const aaBlocks = R.aa.map((b) => ({ x: b.off1.ms, y: b.off2.ms }));
  const pooled = ST.pooledP95Delta(abBlocks); const paired = ST.pairedMedianDelta(abBlocks); const noise = ST.aaNoiseMax(aaBlocks);
  const sum = (xs, f) => xs.reduce((a, c) => a + f(c), 0);
  const att = { off: sum(R.ab, (b) => b.off.attempts), on: sum(R.ab, (b) => b.on.attempts) };
  const err = { off: sum(R.ab, (b) => b.off.errors), on: sum(R.ab, (b) => b.on.errors) };
  const valid = R.ab.every((b) => childValid(b.off, 'off') && childValid(b.on, 'on')) && R.aa.every((b) => childValid(b.off1, 'off') && childValid(b.off2, 'off'));
  const v = ST.verdictV2({ pooled, paired, noise, invariants: { attempts_equal: att.off === att.on, errors_equal: err.off === err.on }, valid, bars: BARS });
  report.rows.push({ row: row.key, overlap: row.overlap, off_p95: r1(pooled.x_p95), on_p95: r1(pooled.y_p95), p95_delta_ms: r1(pooled.delta_ms), p95_delta_pct: r1(pooled.delta_rel * 100),
    paired_median_delta_ms: r1(paired), paired_median_ci95: ST.bootstrapCI(abBlocks).map(r1), block_median_deltas: ST.blockMedianDeltas(abBlocks).map(r1),
    aa_noise_p95_pct: r1(noise.noise_p95 * 100), aa_noise_median_ms: r1(noise.noise_med),
    attempts: att, errors: err, monitor: { runs: sum(R.ab, (b) => b.on.monitor.runs), reads: sum(R.ab, (b) => b.on.monitor.reads), checked: sum(R.ab, (b) => b.on.monitor.checked) },
    ab_first: R.ab.map((b) => b.first), aa_first: R.aa.map((b) => b.first), valid, verdict: v.verdict, cost: v.cost, quality: v.quality, values: v.values });
  console.error(JSON.stringify(report.rows[report.rows.length - 1]));
}
report.raw = raw;
console.log(JSON.stringify(report));
process.exit(0);

// ── one (row, condition) in its own process ──────────────────────────────────────────────────────────────────────
async function child(rowKey, cond) {
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
  process.env.EDIT_TOKEN_SECRET = 'c2b-latency-secret-'.padEnd(48, 'x');
  process.env.STATS_HMAC_SECRET = process.env.STATS_HMAC_SECRET || 'c2b-latency-stats-'.padEnd(48, 'x');
  const origLog = console.log; console.log = () => {}; console.warn = () => {}; console.error = () => {};
  const row = ROWS.find((r) => r.key === rowKey);
  require('../index.js');
  const admin = require('firebase-admin');
  const db = admin.firestore(); const rtdb = admin.database();
  const { fixture, synthSource } = require('./_c2b-fixture');
  const F = fixture({ db, rtdb });
  const { createIdentityIntegrityMonitor } = require('../catalog/identity-integrity-monitor');
  const { getActivePointer } = require('../catalog/catalog-firestore');
  const { sourceRefOf, encodeUpdateTime } = require('../catalog/source-store');
  const UID = 'lat_owner';

  // ── seed ONCE per emulator (idempotent: a marker doc), then capture each target's seeded state ────────────────────
  const marker = db.doc('c2b_latency/seeded');
  let seededNow = false;
  if (!(await marker.get()).exists) {
    await F.seed('x_pizza'); const xv1 = await F.publish('x_pizza', 'lat-x1');
    await require('../catalog/identity-backfill').backfillIdentities(db, 'x_pizza', await require('../catalog/catalog-menu').getRestaurantMenu(db, 'x_pizza'), { captured: await getActivePointer(db, 'x_pizza') });
    await F.bootstrap('x_pizza'); await F.publish('x_pizza', 'lat-x2');
    await F.seed('la_musa'); const lv1 = await F.publish('la_musa', 'lat-l1'); await F.publish('la_musa', 'lat-l2');
    await F.merchant('synth_lat_400', { dishes: 400 }); await F.publish('synth_lat_400', 'lat-s2');
    for (const o of OTHERS) { await F.merchant(o); await F.publish(o, `lat-${o}`); }
    for (const rid of ['x_pizza', 'la_musa', 'synth_lat_400', ...OTHERS]) {
      await rtdb.ref(`owner_restaurants/${UID}/${rid}`).set(true);
      await rtdb.ref(`restaurants/${rid}/owners/${UID}`).set(true);
      await rtdb.ref(`restaurants/${rid}/identity/name`).set(rid);
    }
    await marker.set({ xv1, lv1, at: new Date() });
    seededNow = true;
  }
  const seeded = (await marker.get()).data();
  const capture = async (rid) => {
    const out = [];
    const walk = async (ref) => { const s = await ref.get(); if (s.exists) out.push([ref.path, s.data()]); for (const c of await ref.listCollections()) for (const d of await c.listDocuments()) await walk(d); };
    await walk(db.collection('restaurants').doc(rid)); return out;
  };
  // the seeded state of the target, captured once per child (Timestamps kept as Timestamps)
  const snap = await capture(row.rid);
  // FULL subtree state, canonicalised: every doc's path + data (Timestamps as [s, ns], refs as their path, keys sorted)
  const canon = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (typeof v.toMillis === 'function' && 'nanoseconds' in v) return JSON.stringify(['ts', v.seconds, v.nanoseconds]);
    if (typeof v.path === 'string' && typeof v.firestore === 'object') return JSON.stringify(['ref', v.path]);
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  };
  const fullState = async () => new Map((await capture(row.rid)).map(([p, d]) => [p, canon(d)]));
  const digestOf = (m) => require('crypto').createHash('sha256').update([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, d]) => `${p}\u0000${d}`).join('\n')).digest('hex');
  // the SEEDED digest per restaurant is recorded ONCE (right after seeding) outside the subtree; every child must START from it
  const digestDoc = db.doc(`c2b_latency/digest_${row.rid}`);
  const startDigest = digestOf(new Map(snap.map(([p, d]) => [p, canon(d)])));
  if (seededNow || !(await digestDoc.get()).exists) {
    for (const rid of ['x_pizza', 'la_musa', 'synth_lat_400', ...OTHERS]) {
      const d = digestOf(new Map((await capture(rid)).map(([p, x]) => [p, canon(x)])));
      if (!(await db.doc(`c2b_latency/digest_${rid}`).get()).exists) await db.doc(`c2b_latency/digest_${rid}`).set({ digest: d });
    }
  }
  const SEEDED_DIGEST = (await digestDoc.get()).data().digest;
  const digest = { start_ok: startDigest === SEEDED_DIGEST, checked: 0, mismatches: 0, first_mismatch: null };
  const seedByPath = new Map(snap);
  const RS = RESTORE_SETS[row.op];
  const root = db.collection('restaurants').doc(row.rid);
  const restore = async () => {
    if (!RS) return;   // read-only: nothing to restore (the digest checks prove it)
    for (const c of RS.fresh) {
      for (const d of await root.collection(c).listDocuments()) if (!seedByPath.has(d.path)) await db.recursiveDelete(d);
    }
    for (const rel of RS.docs) {
      const ref = root.collection(rel.split('/')[0]).doc(rel.split('/')[1]);
      if (seedByPath.has(ref.path)) await ref.set(seedByPath.get(ref.path)); else await ref.delete();
    }
  };
  const verify = async (label) => {
    digest.checked += 1;
    const now = digestOf(await fullState());
    if (now !== SEEDED_DIGEST) { digest.mismatches += 1; if (!digest.first_mismatch) digest.first_mismatch = label; }
  };

  // ── the monitor (B): a tight loop inside THIS process, max pacing, quiet window 0 ───────────────────────────────────
  const targets = row.overlap === 'other' ? OTHERS : (row.overlap === 'same' ? [row.rid] : [row.rid, ...OTHERS]);
  const mon = { runs: 0, reads: 0, checked: 0, windows: [], current: null }; let stop = false; let loop = null;
  if (cond === 'on') {
    const m = createIdentityIntegrityMonitor({ db, rtdb, log: () => {} });
    loop = (async () => {
      while (!stop) {
        const t0 = Date.now(); mon.current = t0;
        try { const r = await m.run({ listIds: async () => targets, quietMs: 0 }); mon.reads += r.reads || 0; mon.checked += (r.results || []).filter((x) => x.outcome === 'checked').length; } catch (_) { /* a monitor failure never fails a merchant sample */ }
        mon.windows.push([t0, Date.now()]); mon.current = null; mon.runs += 1;
      }
    })();
    await new Promise((r) => setTimeout(r, 200));   // the loop is reading before the first sample
  }

  // ── the operation ──────────────────────────────────────────────────────────────────────────────────────────────
  const verifyIdToken = async () => ({ uid: UID, email: 'lat@x.hn' });
  const { getMyRestaurantsCore, getEditableCatalogCore } = require('../catalog/portal-reads');
  const { authorizeCatalogEdit } = require('../catalog/catalog-edit-auth');
  const { getSalesStatsCore, makeLiveCache } = require('../stats/stats-api');
  const { statsKeyer } = require('../stats/keyer');
  const reqOf = (method, query = {}, body = {}) => ({ method, query, body, get: (h) => (h.toLowerCase() === 'authorization' ? 'Bearer lat' : undefined) });
  const authorize = (rid, req) => authorizeCatalogEdit({ db: rtdb, verifyIdToken }, req || reqOf('GET'), rid);
  // rollback target: the OLDEST retained version that is not the active one (seeded: v1 behind the active v2)
  const rbTarget = row.op === 'rollback' ? await (async () => { const act = (await getActivePointer(db, row.rid)).version;
    return (await F.versionsColOf(row.rid).orderBy('seq').get()).docs.map((d) => d.id).find((v) => v !== act); })() : null;
  void seeded;
  const liveCache = makeLiveCache ? makeLiveCache() : null;
  const today = new Date().toISOString().slice(0, 10);
  const ops = {
    publish: async () => { const r = await F.publish(row.rid, 'lat'); return !!r; },
    rollback: async () => { await F.rollback(row.rid, rbTarget); return true; },
    getMyRestaurants: async () => (await getMyRestaurantsCore({ db: rtdb, verifyIdToken }, reqOf('GET'))).status === 200,
    getEditableCatalog: async () => (await getEditableCatalogCore({ db: rtdb, fsdb: db, authorize: (rid) => authorize(rid), readActiveVersionId: async (fsdb, rid) => (await getActivePointer(fsdb, rid)).version }, reqOf('GET', { restaurantId: row.rid }))).status === 200,
    editCatalog: async () => saveOnly((s) => { s.items[0].price += 1; if (s.items[0].display) s.items[0].display.price = s.items[0].price; return s; }),
    editCatalog_unchanged: async () => saveOnly((s) => s),
    publishEdited: null,   // timed below: the save is setup, the publish is the sample
    getSalesStats_json: async () => (await getSalesStatsCore({ authorize, fsdb: db, rtdb, getKeyer: statsKeyer, nowMs: Date.now(), liveCache }, reqOf('GET', { restaurantId: row.rid, from: today, to: today, granularity: 'day', compare: 'none' }))).status === 200,
    getSalesStats_csv_daily: async () => (await getSalesStatsCore({ authorize, fsdb: db, rtdb, getKeyer: statsKeyer, nowMs: Date.now(), liveCache }, reqOf('GET', { restaurantId: row.rid, from: today, to: today, format: 'csv', kind: 'daily' }))).status === 200,
    getSalesStats_csv_orders: async () => (await getSalesStatsCore({ authorize, fsdb: db, rtdb, getKeyer: statsKeyer, nowMs: Date.now(), liveCache }, reqOf('GET', { restaurantId: row.rid, from: today, to: today, format: 'csv', kind: 'orders' }))).status === 200,
  };
  const { editCatalogCore } = require('../catalog/edit-catalog-handler');
  const { publishEditedCore } = require('../catalog/publish-edited-handler');
  const { getRestaurantMenu } = require('../catalog/catalog-menu');
  const { sourceToBuildInputs } = require('../catalog/source-store');
  const { buildCatalogV2 } = require('../catalog/form-menu-source');
  const { publishVersion } = require('../catalog/catalog-publish');
  const owner = async () => ({ ok: true, uid: UID, role: 'owner', actor: 'lat@x.hn' });
  const readActiveBuilt = async () => {
    const menu = await getRestaurantMenu(db, row.rid);
    const inputs = sourceToBuildInputs({ items: menu.items.map((i) => ({ key: i.key, price: i.price, display: i.display })), extras: menu.extras.map((e) => ({ key: e.key, price: e.price, display: e.display })), structure: menu.structure });
    const built = buildCatalogV2(row.rid, { formData: inputs.formData, priceTable: inputs.priceTable });
    return { built: { ...built, extras: inputs.extras }, versionId: (await getActivePointer(db, row.rid)).version };
  };
  const toPrecondition = (v) => { if (typeof v !== 'string') return v; const [s, ns] = v.split('.'); return new admin.firestore.Timestamp(Number(s), Number(ns)); };
  async function saveOnly(mutate) {
    const snapS = await sourceRefOf(db, row.rid).get();
    const r = await editCatalogCore({ db, authorize: owner, readActiveBuilt, toPrecondition }, { restaurantId: row.rid, source: mutate(JSON.parse(JSON.stringify(snapS.data()))), baseSourceUpdateTime: encodeUpdateTime(snapS.updateTime) }, {});
    return r.status === 200 ? r : false;
  }

  // ── DISCOVERY (self-test only): what does ONE run of this operation write? ─────────────────────────────────────────
  if (process.env.LAT_DISCOVER) {
    let fn = ops[row.op];
    if (row.op === 'publishEdited') {
      await saveOnly((x) => { x.items[0].price += 1; if (x.items[0].display) x.items[0].display.price = x.items[0].price; return x; });
      const mid = await fullState();
      const saved = await saveOnly((x) => x);   // re-issue a token on the saved draft
      const readDraft = async () => { const sn = await sourceRefOf(db, row.rid).get(); return { source: sn.data(), updateTime: encodeUpdateTime(sn.updateTime) }; };
      fn = async () => (await publishEditedCore({ db, authorize: owner, readActiveBuilt, readDraft, publishVersion, sourceSha: 'lat' }, { restaurantId: row.rid, token: saved && saved.body.token, fiscalAck: true }, {})).status === 200;
      void mid;
    }
    const before = await fullState(); const okRun = await fn(); const after = await fullState();
    const pat = (p) => p.replace(`restaurants/${row.rid}/`, '').replace(/versions\/[^/]+/, 'versions/*').replace(/identity_evidence\/[^/]+/, 'identity_evidence/*')
      .replace(/(ids|keys)\/[^/]+/, '$1/*').replace(/(menu_items|extras)\/[^/]+/, '$1/*');
    const group = (ps) => { const g = {}; for (const p of ps) g[pat(p)] = (g[pat(p)] || 0) + 1; return g; };
    const added = [...after.keys()].filter((p) => !before.has(p)); const removed = [...before.keys()].filter((p) => !after.has(p));
    const changed = [...after.keys()].filter((p) => before.has(p) && before.get(p) !== after.get(p));
    stop = true; if (loop) await loop;
    console.log = origLog;
    origLog(JSON.stringify({ row: rowKey, ok: okRun, added: group(added), removed: group(removed), changed: group(changed) }));
    process.exit(0);
  }

  // ── samples ────────────────────────────────────────────────────────────────────────────────────────────────────
  const ms = []; let attempts = 0; let errors = 0; let overlapped = 0; const statuses = {};
  if (digest.start_ok) for (let i = 0; i < WARM + SAMPLES; i += 1) {
    if (i > 0) {
      await restore();
      if ((i - WARM) % DIGEST_EVERY === 0 || DIGEST_EVERY === 1) { await verify(`before sample ${i}`); if (digest.mismatches) break; }
    }
    let fn = ops[row.op];
    if (row.op === 'publishEdited') {
      const saved = await saveOnly((s) => { s.items[0].price += 1; if (s.items[0].display) s.items[0].display.price = s.items[0].price; return s; });
      const readDraft = async () => { const sn = await sourceRefOf(db, row.rid).get(); return { source: sn.data(), updateTime: encodeUpdateTime(sn.updateTime) }; };
      fn = async () => (await publishEditedCore({ db, authorize: owner, readActiveBuilt, readDraft, publishVersion, sourceSha: 'lat' }, { restaurantId: row.rid, token: saved && saved.body.token, fiscalAck: true }, {})).status === 200;
    }
    const t0 = Date.now(); const h0 = process.hrtime.bigint();
    let okRes = false;
    try { okRes = !!(await fn()); } catch (_) { okRes = false; }
    const dt = Number(process.hrtime.bigint() - h0) / 1e6; const t1 = Date.now();
    if (i < WARM) continue;
    attempts += 1; if (!okRes) errors += 1; statuses[okRes ? 'ok' : 'error'] = (statuses[okRes ? 'ok' : 'error'] || 0) + 1;
    ms.push(dt);
    // overlapped iff a monitor run's interval intersects the sample (a completed run, or the run still in progress)
    if (cond === 'on' && (mon.windows.some(([a, b]) => a <= t1 && b >= t0) || (mon.current !== null && mon.current <= t1))) overlapped += 1;
  }
  stop = true; if (loop) await loop;
  // leave the seeded state behind for the next child (and prove it)
  await restore(); if (digest.start_ok && !digest.mismatches) await verify('child end');
  console.log = origLog;
  origLog(JSON.stringify({ row: rowKey, cond, ms, attempts, errors, statuses, digest, monitor: { runs: mon.runs, reads: mon.reads, checked: mon.checked, overlapped } }));
  process.exit(0);
}
