'use strict';
/**
 * PLAN-S5 §4.6 / §5 / §9 — the backend, on the RTDB emulator:  npm run test:s5-backend
 *   A. ready_at: the REAL sendOrderStatusNotifications trigger stamps order_tracking/{tok}/ready_at on →ready ONLY (server
 *      clock); a ready→preparing→ready recall overwrites it with the later ready; the other stamps are unchanged.
 *   B. prepStatsDaily's job (prep-stats.js runPrepStats) against REAL query semantics, through a recording proxy over the real
 *      refs (paths, every query call, once() timing, OUTSTANDING leaf reads, update() order) with fault injection:
 *      1 BC1 — a 3-page window (1,200 rows, new_at ties across the page boundary) → pages raw [500, 500, 201], all 1,200
 *        aggregated and published; the cap at the exact boundary: 19,960 rows publish, 19,961 rows → a full 40th page →
 *        abort, zero writes;
 *      2 the query contract: every page = orderByChild('new_at') + startAt + endAt + limitToFirst(500); only the two leaves per
 *        timeline candidate (none for a non-candidate) + the config + the BC3 drift reads; ≤ 10 outstanding leaf reads (and
 *        10 reached); ONE update(), issued after the last read;
 *      3 statistics end-to-end: odd/even median, the p80 rank; exclusions (an excluded order_id via the timeline KEY, an
 *        excluded phone, before epoch, unattributed, unlisted rid, < 1 min, > 3 h, a sanity violation);
 *      4 publication: an empty listed restaurant → 8 nulls + updated_at; an empty window; a stale bucket deleted; a write
 *        rejection → zero changes + prep_stats_aborted{write_rejected}; a read failure mid-paging → zero writes;
 *      5 a no_epoch restaurant skipped while others publish; config_invalid → zero writes;
 *      6 logs: prep_stats_run carries counts only; no phone digits in any log line; the BC3 drift log
 *        prep_eta_min_mismatch{rid} when the private and public prep_eta_min differ;
 *      7 MUTANTS of the query contract (each must be caught): endAt dropped, the limit dropped, orders/{id} read whole, a
 *        client-side filter of the whole node, exhaustion judged by a timestamp instead of the raw page length.
 * Brand-agnostic ids throughout (merch_a / merch_b / merch_c).
 */
const assert = require('assert');
(function requireEmulator() {
  const EE = require('../lib/emulator-endpoint');
  let why = null;
  try {
    if (!process.env[EE.OFFSET_VAR]) throw new Error(`${EE.OFFSET_VAR} is not set — the run's slot is unknown`);
    const v = EE.validateEmulatorEnv(process.env);
    if (v.endpoints.database === EE.NULL_ENDPOINT) throw new Error('the database is the NULL endpoint — this run did not start it');
  } catch (e) { why = String(e && e.message || e).replace(/^🔴 REFUSED — /, ''); }
  if (why) { console.error(`\n🛑 REFUSING TO RUN — not this run's local emulator (${why}). Run: npm run test:s5-backend\n`); process.exit(2); }
})();
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'test-secret';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const app = require('../index.js');
const whatsapp = require('../whatsapp');
const { getDatabase } = require('firebase-admin/database');
const PS = require('../prep-stats');
const db = getDatabase();
const WATCHDOG = setTimeout(() => { console.error('s5-backend: FAILED — watchdog'); process.exit(1); }, 900000);

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const MIN = 60000, DAY = 24 * 3600000;
const NOW = Date.UTC(2026, 9, 14, 10, 0, 0);   // 04:00 Tegucigalpa, the job's schedule
const LO = NOW - PS.PREP_STATS.LOOKBACK_MS, HI = NOW - PS.PREP_STATS.SETTLE_MS;
const at = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h + 6, mi);   // a Tegucigalpa wall-clock time → ms
const val = async (p) => (await db.ref(p).once('value')).val();

// ── the recording proxy over the REAL refs ──
function spyDb(opts = {}) {
  const log = { queries: [], reads: [], updates: [], seq: 0, outstanding: 0, maxOutstanding: 0, lastReadSeq: 0 };
  const isLeaf = (p) => /^(orders|restaurants)\//.test(p);
  const wrapQ = (q, entry) => {
    const out = Object.create(null);
    for (const m of ['orderByChild', 'orderByKey', 'orderByValue', 'startAt', 'startAfter', 'endAt', 'endBefore', 'equalTo', 'limitToFirst', 'limitToLast']) {
      out[m] = (...a) => wrapQ(q[m](...a), { ...entry, calls: entry.calls.concat([[m, ...a]]) });
    }
    out.once = async (ev) => {
      const rec = { ...entry, seq: ++log.seq };
      if (entry.calls.length) log.queries.push(rec); else log.reads.push(rec);
      if (opts.failRead && opts.failRead(rec, log)) throw new Error('injected read failure: ' + entry.path);
      const leaf = isLeaf(entry.path) && !entry.calls.length;
      if (leaf) { log.outstanding += 1; log.maxOutstanding = Math.max(log.maxOutstanding, log.outstanding); }
      try { await new Promise((r) => setImmediate(r)); return await q.once(ev); }
      finally { if (leaf) log.outstanding -= 1; log.lastReadSeq = log.seq; }
    };
    out.update = async (u) => { log.updates.push({ seq: ++log.seq, afterLastRead: log.seq > log.lastReadSeq, keys: Object.keys(u) }); if (opts.failWrite) throw new Error('injected write rejection'); return q.update(u); };
    return out;
  };
  return { ref: (p) => wrapQ(db.ref(p), { path: p || '/', calls: [] }), log };
}
// The emulator loads firebase.json's rules only for the project's default namespace; the Admin SDK here talks to index.js's
// namespace. Load the CANONICAL rules there, so the .indexOn the job relies on is the one the query runs against — and any
// "unspecified index" warning from the SDK (a query served by downloading the node) fails the run.
let indexWarnings = 0;
for (const m of ['log', 'warn', 'error']) { const orig = console[m].bind(console); console[m] = (...a) => { if (a.some((x) => typeof x === 'string' && x.includes('Using an unspecified index'))) indexWarnings += 1; orig(...a); }; }
async function loadCanonicalRules() {
  const ns = new URL(db.app.options.databaseURL).hostname.split('.')[0];
  const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
  const res = await fetch(`http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}/.settings/rules.json?ns=${ns}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
  assert.ok(res.ok, `premise: the canonical rules load into ${ns} (${res.status})`);
}
const capLog = () => { const lines = []; const rec = (lvl) => (...a) => lines.push([lvl, a.join(' ')]); return { lines, log: rec('log'), warn: rec('warn'), error: rec('error') }; };

// ── fixtures ──
const CFG = (o = {}) => ({ active_restaurants: ['merch_a', 'merch_b'], epoch_start_ms: { merch_a: 1, merch_b: 1 }, excluded_phones: {}, excluded_orders: {}, ...o });
async function seed({ cfg = CFG(), rows = [], extra = {} } = {}) {
  await db.ref('/').set(null);
  const u = { ready_time_config: JSON.parse(JSON.stringify(cfg)) };   // an absent field stays absent (never undefined into RTDB)
  for (const r of rows) {
    u[`order_timelines/${r.key}`] = r.t;
    if (r.rid !== undefined || r.phone !== undefined) u[`orders/${r.key}`] = { ...(r.rid !== undefined ? { restaurant_id: r.rid } : {}), ...(r.phone !== undefined ? { customer_phone: r.phone } : {}), status: 'delivered', items_text: 'x'.repeat(200) };
  }
  Object.assign(u, extra);
  // chunk the big fixtures (one update per 4,000 paths)
  const keys = Object.keys(u);
  for (let i = 0; i < keys.length; i += 4000) { const part = {}; for (const k of keys.slice(i, i + 4000)) part[k] = u[k]; await db.ref('/').update(part); }
}
// n eligible rows for merch_a, new_at spread over the window, PAIRS sharing a new_at (ties cross the 500 boundary: rows 499/500)
function bulk(count, { rid = 'merch_a', prepMin = 18 } = {}) {
  const span = (HI - LO) - 2 * 3600000;
  return Array.from({ length: count }, (_, i) => {
    const pair = Math.floor(i / 2) + (i >= 500 ? 0 : 0);
    const newAt = LO + 3600000 + Math.floor(pair * (span / Math.ceil(count / 2)));
    return { key: `T${String(i).padStart(6, '0')}`, rid, phone: '50499990000', t: { new_at: newAt, preparing_at: newAt + MIN, ready_at: newAt + prepMin * MIN } };
  });
}
const published = async (rid) => val(`restaurants/${rid}/public/prep_stats`);
const sumN = (st) => Object.entries(st || {}).filter(([k]) => k !== 'updated_at').reduce((a, [, b]) => a + (b ? b.n : 0), 0);

// the query-contract checker (also run against every mutant)
function contractViolations(log, { candidates }) {
  const v = [];
  const tl = log.queries.filter((q) => q.path === 'order_timelines');
  for (const q of tl) {
    const names = q.calls.map((c) => c[0]);
    if (names[0] !== 'orderByChild' || q.calls[0][1] !== 'new_at') v.push('not ordered by new_at');
    if (!names.includes('startAt')) v.push('no startAt');
    if (!names.includes('endAt')) v.push('no endAt');
    const lim = q.calls.find((c) => c[0] === 'limitToFirst');
    if (!lim || lim[1] !== 500) v.push('no limitToFirst(500)');
  }
  for (const r of log.reads) {
    if (r.path === 'ready_time_config') continue;
    if (/^orders\/[^/]+\/(restaurant_id|customer_phone)$/.test(r.path)) { if (candidates && !candidates.has(r.path.split('/')[1])) v.push(`leaf read for a non-candidate ${r.path}`); continue; }
    if (/^restaurants\/[^/]+\/(public\/)?prep_eta_min$/.test(r.path)) continue;
    v.push(`unbounded / foreign read ${r.path}`);
  }
  if (log.maxOutstanding > 10) v.push(`outstanding ${log.maxOutstanding} > 10`);
  if (log.updates.length > 1) v.push('more than one update()');
  if (log.updates.some((u) => !u.afterLastRead)) v.push('update() before the last read');
  return v;
}

// ── a mutant of prep-stats.js, compiled in memory beside the real one ──
function mutant(edit) {
  const file = path.join(__dirname, '..', 'prep-stats.js');
  const src = fs.readFileSync(file, 'utf8'); const out = edit(src);
  const strip = require('../tools/strip-comments');
  assert.notStrictEqual(strip(out), strip(src), 'premise: the mutant edit changes CODE (not just a comment)');
  const m = new Module(file + '#mutant', module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(out, file); return m.exports;
}

(async () => {
  // ═══ A. ready_at ═══
  {
    whatsapp.sendMessage = async () => ({ id: 'MSG' });
    await db.ref('/').set(null);
    await db.ref('config/whatsapp_enabled').set(false);
    await db.ref('orders/RA1').set({ order_type: 'delivery', restaurant_id: 'merch_a', tracking_token: 'TokReady12345', status: 'new', customer_phone: '99990000' });
    await db.ref('order_tracking/TokReady12345').set({ status: 'new', created_at: 1 });
    const ev = (b, a) => ({ data: { before: { val: () => b }, after: { val: () => a } }, params: { orderId: 'RA1' } });
    const step = async (b, a) => { await db.ref('orders/RA1/status').set(a); await app.sendOrderStatusNotifications.run(ev(b, a)); return val('order_tracking/TokReady12345'); };
    let t = await step('new', 'preparing');
    assert.ok(!('ready_at' in t), 'preparing → no ready_at');
    const t0 = Date.now();
    t = await step('preparing', 'ready');
    assert.ok(Number.isFinite(t.ready_at) && t.ready_at >= t0 - 5000 && t.status === 'ready', '→ready stamps ready_at (server clock)');
    const first = t.ready_at;
    assert.ok(!('picked_up_at' in t) && !('delivered_at' in t) && !('cancelled_at' in t), 'no other stamp on ready');
    await new Promise((r) => setTimeout(r, 25));
    t = await step('ready', 'preparing'); assert.strictEqual(t.ready_at, first, 'a recall to preparing leaves ready_at');
    t = await step('preparing', 'ready'); assert.ok(t.ready_at > first, 'the second ready overwrites: the LATEST ready');
    const second = t.ready_at;
    t = await step('ready', 'out_for_delivery'); assert.ok(Number.isFinite(t.picked_up_at) && t.ready_at === second, 'pickup stamps picked_up_at; ready_at kept');
    t = await step('out_for_delivery', 'delivered'); assert.ok(Number.isFinite(t.delivered_at) && t.ready_at === second, 'delivered as today');
    ok('ready_at: stamped on →ready only (server clock), never on preparing / out_for_delivery / delivered; a ready→preparing→ready recall keeps then overwrites it with the LATER ready; picked_up_at / delivered_at as today');
  }

  // ═══ A-ON. ready_at with the TRACKER FIXES flag ON (restack onto S5): the status mirror is skipped (the recompute publishes the
  // tracker), and sendOrderStatusNotifications stamps the SAME leaf with the SAME semantics ═══
  {
    const flag = require('../tracking/flag');
    await db.ref('/').set(null);
    await db.ref('config/whatsapp_enabled').set(false);
    await db.ref('config/tracker_fixes_enabled').set(true); flag._resetForTest();
    await db.ref('orders/RA2').set({ order_type: 'delivery', restaurant_id: 'merch_a', tracking_token: 'TokReadyOn123', status: 'new', customer_phone: '99990000' });
    await db.ref('order_tracking/TokReadyOn123').set({ status: 'new', created_at: 1 });
    const ev = (b, a) => ({ data: { before: { val: () => b }, after: { val: () => a } }, params: { orderId: 'RA2' } });
    const step = async (b, a) => { await db.ref('orders/RA2/status').set(a); await app.sendOrderStatusNotifications.run(ev(b, a)); return val('order_tracking/TokReadyOn123'); };
    let t = await step('new', 'preparing');
    assert.ok(!('ready_at' in t), 'ON: preparing → no ready_at');
    const t0 = Date.now();
    t = await step('preparing', 'ready');
    assert.ok(Number.isFinite(t.ready_at) && t.ready_at >= t0 - 5000, 'ON: →ready stamps ready_at (server clock)');
    assert.strictEqual(t.status, 'new', 'ON: the status mirror is NOT written here (the recompute publishes status)');
    const first = t.ready_at;
    await new Promise((r) => setTimeout(r, 25));
    t = await step('ready', 'preparing'); assert.strictEqual(t.ready_at, first, 'ON: a recall to preparing leaves ready_at');
    t = await step('preparing', 'ready'); assert.ok(t.ready_at > first, 'ON: the second ready overwrites: the LATEST ready');
    const second = t.ready_at;
    t = await step('ready', 'out_for_delivery'); assert.strictEqual(t.ready_at, second, 'ON: ready_at kept through pickup');
    t = await step('out_for_delivery', 'delivered'); assert.strictEqual(t.ready_at, second, 'ON: ready_at kept at delivered');
    await db.ref('config/tracker_fixes_enabled').set(null); flag._resetForTest();
    ok('ready_at with the tracker flag ON: the same leaf, server clock, →ready only, recall keeps then the LATER ready overwrites, kept through pickup / delivered (the status mirror is the recompute\'s, not written here)');
  }

  await loadCanonicalRules();
  indexWarnings = 0;
  // ═══ B1. BC1 paging ═══
  let threePageLog;
  {
    const rows = bulk(1200);
    assert.strictEqual(rows[499].t.new_at, rows[498].t.new_at, 'premise: a tie at the page boundary (498/499)');
    await seed({ rows });
    const S = spyDb(); const L = capLog();
    const r = await PS.runPrepStats({ db: S, nowMs: NOW, log: L });
    assert.strictEqual(r.aborted, null, JSON.stringify(r));
    const pages = S.log.queries.filter((q) => q.path === 'order_timelines');
    assert.strictEqual(pages.length, 3, 'three pages');
    assert.strictEqual(r.rows, 1200, 'all 1,200 distinct rows (the overlap row dropped, ties kept)');
    const st = await published('merch_a');
    assert.strictEqual(sumN(st), 1200, 'all 1,200 aggregated and published');
    assert.deepStrictEqual(pages[1].calls.find((c) => c[0] === 'startAt').length, 3, 'the next page starts at (new_at, key)');
    threePageLog = S.log;
    ok('BC1: a 3-page window (1,200 rows, new_at ties across the page boundary) → 3 limitToFirst(500) pages, paged by (new_at, key), the overlap row dropped → all 1,200 aggregated and published');
  }
  for (const [count, expectAbort] of [[19960, false], [19961, true]]) {
    await seed({ rows: bulk(count) });
    const S = spyDb(); const L = capLog();
    const r = await PS.runPrepStats({ db: S, nowMs: NOW, log: L });
    const pages = S.log.queries.filter((q) => q.path === 'order_timelines').length;
    assert.strictEqual(pages, 40, `${count}: 40 pages`);
    if (expectAbort) {
      assert.strictEqual(r.aborted, 'cap_unproven', `${count}: a FULL 40th page → abort`);
      assert.strictEqual(S.log.updates.length, 0, 'zero writes'); assert.strictEqual(await published('merch_a'), null, 'nothing published');
      assert.ok(L.lines.some(([, l]) => l.startsWith('prep_stats_aborted') && l.includes('cap_unproven')), 'the abort log');
    } else {
      assert.strictEqual(r.aborted, null, `${count}: the 40th page is short → exhausted`); assert.strictEqual(sumN(await published('merch_a')), count, 'all published');
    }
  }
  ok('BC1 cap at the exact boundary: 19,960 rows → the 40th page is short (raw 499) → published in full; 19,961 rows → a FULL 40th page → prep_stats_aborted{cap_unproven}, zero writes');

  // ═══ B2. the query contract (on the 3-page run) ═══
  {
    const cand = new Set(bulk(1200).map((r) => r.key));
    assert.deepStrictEqual(contractViolations(threePageLog, { candidates: cand }), []);
    const leafReads = threePageLog.reads.filter((r) => r.path.startsWith('orders/'));
    assert.strictEqual(leafReads.length, 2400, 'exactly two leaves per candidate');
    assert.strictEqual(threePageLog.maxOutstanding, 10, 'the pool reaches (and never exceeds) 10 outstanding leaf reads');
    assert.strictEqual(threePageLog.updates.length, 1); assert.ok(threePageLog.updates[0].afterLastRead, 'one update(), after the last read');
    ok('the query contract: every page orderByChild(new_at)+startAt+endAt+limitToFirst(500); exactly 2 leaves per candidate + config + drift reads, nothing else; outstanding leaf reads max = 10; ONE update() after the last read');
  }

  // ═══ B3. statistics + exclusions end-to-end ═══
  {
    const D = at(2026, 9, 13, 19, 0);   // Tue 19:00 → weekday_dinner
    const W = at(2026, 9, 11, 12, 0);   // Sun 12:00 → weekend_lunch
    const rows = [];
    const mk = (key, newAt, prepMin, o = {}) => rows.push({ key, rid: 'merch_a', phone: '50411112222', t: { new_at: newAt, ready_at: newAt + prepMin * MIN, ...(o.t || {}) }, ...o });
    [10, 12, 14, 30, 16].forEach((m, i) => mk(`D${i}`, D + i * MIN, m));             // odd n=5 → sorted 10,12,14,16,30 → median 14, p80 = s[3] = 16
    [20, 22, 24, 26].forEach((m, i) => mk(`W${i}`, W + i * MIN, m));                 // even n=4 → median 23, p80 = s[ceil(3.2)-1] = s[3] = 26
    mk('XORD', D + 9 * MIN, 99); mk('XPH', D + 10 * MIN, 99, { phone: '+504 9999-8888' });
    mk('PRE', D + 11 * MIN, 99, { rid: 'merch_b' });                                  // before merch_b's epoch
    rows.push({ key: 'UNATTR', phone: '50411112222', t: { new_at: D + 12 * MIN, ready_at: D + 30 * MIN } });   // no restaurant_id
    mk('UNLIST', D + 13 * MIN, 99, { rid: 'merch_z' });
    mk('FAST', D + 14 * MIN, 0.5); mk('SLOW', D + 15 * MIN, 181);
    mk('INSANE', D + 16 * MIN, 20, { t: { preparing_at: D + 16 * MIN + 30 * MIN } });  // preparing > ready
    await seed({ rows, cfg: CFG({ epoch_start_ms: { merch_a: 1, merch_b: D + 60 * MIN }, excluded_orders: { XORD: true }, excluded_phones: { 50499998888: true } }) });
    const S = spyDb(); const r = await PS.runPrepStats({ db: S, nowMs: NOW, log: capLog() });
    assert.strictEqual(r.aborted, null);
    const st = await published('merch_a');
    assert.deepStrictEqual(st.weekday_dinner, { median_min: 14, p80_min: 16, n: 5 }, 'odd n + the exclusions');
    assert.deepStrictEqual(st.weekend_lunch, { median_min: 23, p80_min: 26, n: 4 }, 'even n (mean of the middles) + p80 nearest rank');
    assert.strictEqual(sumN(await published('merch_b')), 0, 'the before-epoch row does not count');
    const leafKeys = new Set(S.log.reads.filter((x) => x.path.startsWith('orders/')).map((x) => x.path.split('/')[1]));
    for (const k of ['FAST', 'SLOW', 'INSANE']) assert.ok(!leafKeys.has(k), `${k}: a non-candidate costs no leaf read`);
    ok('statistics: odd n median 14 / p80 16, even n median 23 (mean of the middles) / p80 26; excluded: order_id via the timeline KEY, a phone (normalized), before epoch, unattributed, unlisted rid; < 1 min, > 3 h and a sanity violation are not even attributed');
  }

  // ═══ B4. publication ═══
  {
    const D = at(2026, 9, 13, 19, 0);
    const rows = Array.from({ length: 8 }, (_, i) => ({ key: `P${i}`, rid: 'merch_a', phone: '1', t: { new_at: D + i * MIN, ready_at: D + (i + 15) * MIN } }));
    const stale = { weekend_late: { median_min: 40, p80_min: 50, n: 9 }, updated_at: 5 };
    await seed({ rows, extra: { 'restaurants/merch_a/public/prep_stats': stale, 'restaurants/merch_b/public/prep_stats': stale } });
    await PS.runPrepStats({ db: spyDb(), nowMs: NOW, log: capLog() });
    const a = await published('merch_a'), b = await published('merch_b');
    assert.ok(a.weekday_dinner && a.weekday_dinner.n === 8 && !('weekend_late' in a) && a.updated_at === NOW, 'the stale bucket deleted; the new one written');
    assert.deepStrictEqual(b, { updated_at: NOW }, 'an empty listed restaurant → every bucket null, only updated_at');
    await seed({ rows: [] });
    await PS.runPrepStats({ db: spyDb(), nowMs: NOW, log: capLog() });
    assert.deepStrictEqual([await published('merch_a'), await published('merch_b')], [{ updated_at: NOW }, { updated_at: NOW }], 'an empty window');
    // a write rejection → zero changes
    await seed({ rows, extra: { 'restaurants/merch_a/public/prep_stats': stale } });
    const L = capLog(); const r = await PS.runPrepStats({ db: spyDb({ failWrite: true }), nowMs: NOW, log: L });
    assert.strictEqual(r.aborted, 'write_rejected'); assert.deepStrictEqual(await published('merch_a'), stale, 'nothing changed');
    assert.ok(L.lines.some(([lvl, l]) => lvl === 'warn' && l.startsWith('prep_stats_aborted') && l.includes('write_rejected')));
    // a read failure mid-paging → zero writes
    await seed({ rows: bulk(1200), extra: { 'restaurants/merch_a/public/prep_stats': stale } });
    const S2 = spyDb({ failRead: (rec, log) => rec.path === 'order_timelines' && log.queries.filter((q) => q.path === 'order_timelines').length === 2 });
    const r2 = await PS.runPrepStats({ db: S2, nowMs: NOW, log: capLog() });
    assert.strictEqual(r2.aborted, 'read_failed'); assert.strictEqual(S2.log.updates.length, 0); assert.deepStrictEqual(await published('merch_a'), stale);
    ok('publication: a stale bucket deleted, an empty listed restaurant → only updated_at, an empty window → the same for every listed restaurant; a write rejection → zero changes + prep_stats_aborted{write_rejected}; a page-2 read failure → zero writes');
  }

  // ═══ B5. no_epoch / config_invalid ═══
  {
    const D = at(2026, 9, 13, 19, 0);
    const rows = [{ key: 'E1', rid: 'merch_a', phone: '1', t: { new_at: D, ready_at: D + 20 * MIN } }, { key: 'E2', rid: 'merch_c', phone: '1', t: { new_at: D, ready_at: D + 20 * MIN } }];
    await seed({ rows, cfg: CFG({ active_restaurants: ['merch_a', 'merch_c'], epoch_start_ms: { merch_a: 1 } }) });
    const L = capLog(); const r = await PS.runPrepStats({ db: spyDb(), nowMs: NOW, log: L });
    assert.deepStrictEqual([r.published, r.skipped], [['merch_a'], ['merch_c']]);
    assert.ok(await published('merch_a') && (await published('merch_c')) === null, 'merch_a published; merch_c untouched (no write, no delete)');
    assert.ok(L.lines.some(([, l]) => l.startsWith('prep_stats_skipped') && l.includes('merch_c') && l.includes('no_epoch')));
    for (const bad of [undefined, [], 'merch_a', [3], ['']]) {
      await seed({ rows, cfg: CFG({ active_restaurants: bad }) });
      const S = spyDb(); const L2 = capLog(); const rr = await PS.runPrepStats({ db: S, nowMs: NOW, log: L2 });
      assert.strictEqual(rr.aborted, 'config_invalid', JSON.stringify(bad)); assert.strictEqual(S.log.updates.length, 0);
      assert.strictEqual(S.log.queries.length, 0, 'no timeline query either');
    }
    ok('a no_epoch restaurant is skipped (log, no write, no delete) while others publish; active_restaurants absent / empty / not an array / non-string → config_invalid, zero queries, zero writes');
  }

  // ═══ B6. logs ═══
  {
    const D = at(2026, 9, 13, 19, 0);
    const rows = Array.from({ length: 12 }, (_, i) => ({ key: `L${i}`, rid: i % 2 ? 'merch_a' : 'merch_b', phone: '50499990000', t: { new_at: D + i * MIN, ready_at: D + (i + 20) * MIN } }));
    await seed({ rows, extra: { 'restaurants/merch_a/prep_eta_min': 25, 'restaurants/merch_a/public/prep_eta_min': 25, 'restaurants/merch_b/prep_eta_min': 20, 'restaurants/merch_b/public/prep_eta_min': 25 } });
    const L = capLog(); await PS.runPrepStats({ db: spyDb(), nowMs: NOW, log: L });
    for (const [, l] of L.lines) assert.ok(!l.includes('50499990000') && !l.includes('99990000'), `🔴 a phone in a log line: ${l}`);
    const run = L.lines.find(([, l]) => l.startsWith('prep_stats_run'));
    assert.ok(run); const j = JSON.parse(run[1].slice('prep_stats_run '.length));
    assert.deepStrictEqual(Object.keys(j).sort(), ['bytes_approx', 'duration_ms', 'leaf_reads', 'pages', 'published', 'rows', 'skipped']);
    assert.ok(j.bytes_approx > 0 && j.pages === 1 && j.rows === 12 && j.leaf_reads === 24 + 4);
    const mism = L.lines.filter(([, l]) => l.startsWith('prep_eta_min_mismatch'));
    assert.deepStrictEqual(mism.map(([, l]) => l), ['prep_eta_min_mismatch {"rid":"merch_b"}'], 'BC3: the drift log for merch_b only');
    ok('logs: prep_stats_run{pages, rows, leaf_reads, bytes_approx, duration_ms, published, skipped} — counts only; no phone in any line; BC3 drift: prep_eta_min_mismatch{merch_b} (private 20 ≠ public 25), none for merch_a');
  }

  assert.strictEqual(indexWarnings, 0, '🔴 a query ran without the order_timelines .indexOn new_at (served by downloading the node)');
  ok('every window query ran on the canonical rules\' .indexOn new_at (zero "unspecified index" warnings across B1–B6)');

  // ═══ B7. query-contract mutants ═══
  {
    const rows = bulk(1200); const cand = new Set(rows.map((r) => r.key));
    const MUTANTS = {
      'endAt dropped': (s) => s.replace('.endAt(hi).limitToFirst(PREP_STATS.PAGE);', '.limitToFirst(PREP_STATS.PAGE);'),
      'limit dropped': (s) => s.replace('.endAt(hi).limitToFirst(PREP_STATS.PAGE)', '.endAt(hi)'),
      'orders/{id} read whole': (s) => s.replace("reads.push(() => read(db.ref(`orders/${key}/restaurant_id`)));", "reads.push(() => read(db.ref(`orders/${key}`)).then((x) => ({ val: () => (x.val() || {}).restaurant_id })));"),
      'client-side filter': (s) => s.replace("const snap = await read(q);", "const all = await read(db.ref('order_timelines')); const kept = []; all.forEach((c) => { const t = c.val(); if (t && t.new_at >= lo && t.new_at <= hi) kept.push(c); }); const snap = { forEach: (f) => kept.slice(0, 1e9).forEach(f) };"),
      'exhaustion by timestamp': (s) => s.replace('if (rawLen < PREP_STATS.PAGE) { exhausted = true; break; }', 'if (!rawLen || page[rawLen - 1][1].new_at >= hi) { exhausted = true; break; }'),
    };
    const killed = [];
    for (const [name, edit] of Object.entries(MUTANTS)) {
      const M = mutant(edit);
      await seed({ rows });
      const S = spyDb(); let r; let threw = null;
      try { r = await M.runPrepStats({ db: S, nowMs: NOW, log: capLog() }); } catch (e) { threw = e; }
      const v = contractViolations(S.log, { candidates: cand });
      const st = await published('merch_a');
      const caught = !!threw || v.length > 0 || !r || r.aborted || sumN(st) !== 1200;
      assert.ok(caught, `🔴 mutant survived: ${name}`);
      killed.push(`${name} (${threw ? 'threw' : v[0] || (r && r.aborted) || 'count'})`);
    }
    ok(`query-contract mutants all caught: ${killed.join('; ')}`);
  }

  clearTimeout(WATCHDOG);
  console.log(`\ns5-backend.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('s5-backend.emulator FAILED:', e && e.stack || e); process.exit(1); });
