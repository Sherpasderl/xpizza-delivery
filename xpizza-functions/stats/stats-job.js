'use strict';
// ---------------------------------------------------------------------------
// Merchant STATS — the rollup run (PLAN-stats rev 4 §S1.3). One code path for the nightly job, the
// targeted repair and the backfill:
//
//   1. compute each restaurant's TARGET business dates (+ any persisted pending_repair);
//   2. take each restaurant's LEASE (commit mode only), then stamp the run's source_read_started_at
//      from SERVER time;
//   3. read ONE bounded `orderByChild('created_at')` range — (earliest target day − READ_PAD, latest
//      target day end) — in NON-OVERLAPPING chunks, ONCE, under a record + byte budget that aborts the
//      run LOUDLY. Never a full scan, never a per-day re-read;
//   4. partition in memory by restaurant and service date, build summaries (stats-build);
//   5. publish per restaurant in coherent chunks (stats-store.publishChunk), persisting the remainder
//      as pending_repair so an interrupted repair resumes.
//
// READ-ONLY over /orders: the only RTDB call is a query `.once('value')`. stats-guard.test.js asserts
// no stats module writes RTDB, imports a payment/materialize module, or registers a trigger.
// DRY-RUN (commit:false) performs ZERO writes: no lease, no clock probe, no publication.
// ---------------------------------------------------------------------------
const { READ_PAD_MS, dayStartMs, dayEndMs, addDays, dateOf } = require('./stats-time');
const { buildDailies } = require('./stats-build');
const S = require('./stats-store');
const { rederive } = require('./stats-index');

const DEFAULT_BUDGET = Object.freeze({ maxRecords: 60000, maxBytes: 96 * 1024 * 1024, chunkSize: 2000 });
const NIGHTLY_DAYS = 7;

// The last N COMPLETE business dates before `nowMs`'s date (today is live, never stored by the nightly).
// Per-customer union of two index states (shard id → hmac → sorted dates).
function unionShards(a, b) {
  const out = {};
  for (const id of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const m = {};
    for (const src of [a[id] || {}, b[id] || {}]) for (const [k, list] of Object.entries(src)) m[k] = [...new Set([...(m[k] || []), ...list])].sort();
    out[id] = m;
  }
  return out;
}

function nightlyDates(nowMs, n = NIGHTLY_DAYS) {
  const today = dateOf(nowMs);
  const out = [];
  for (let i = n; i >= 1; i--) out.push(addDays(today, -i));
  return out;
}

/**
 * readOrdersBounded(rtdb, fromMs, toMs, budget) → { orders, stats }
 * `created_at` ∈ [fromMs, toMs), chunked with startAfter(lastValue, lastKey) so chunks never overlap and
 * never re-read. Exceeding the budget THROWS `stats_read_budget_exceeded` — partial data is never built.
 */
async function readOrdersBounded(rtdb, fromMs, toMs, budget = DEFAULT_BUDGET) {
  if (!(Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs)) throw new Error('stats_read_bad_range');
  const orders = [];
  let bytes = 0, chunks = 0, cursor = null;
  for (;;) {
    let q = rtdb.ref('orders').orderByChild('created_at');
    q = cursor ? q.startAfter(cursor.v, cursor.k) : q.startAt(fromMs);
    q = q.endBefore(toMs).limitToFirst(budget.chunkSize);
    const snap = await q.once('value');
    chunks += 1;
    let got = 0, last = null;
    snap.forEach((child) => {
      const v = child.val();
      got += 1;
      bytes += Buffer.byteLength(JSON.stringify(v) || '', 'utf8');
      if (v && typeof v === 'object') orders.push({ ...v, order_id: v.order_id || child.key });
      last = { v: v && v.created_at, k: child.key };
    });
    if (orders.length > budget.maxRecords || bytes > budget.maxBytes) {
      const e = new Error(`stats_read_budget_exceeded: ${orders.length} records / ${bytes} B over [${new Date(fromMs).toISOString()}, ${new Date(toMs).toISOString()}) (budget ${budget.maxRecords} / ${budget.maxBytes} B) — nothing built; narrow the range`);
      e.code = 'stats_read_budget_exceeded';
      throw e;
    }
    if (got < budget.chunkSize) break;
    cursor = last;
  }
  return { orders, stats: { records: orders.length, bytes, chunks, from: fromMs, to: toMs } };
}

/**
 * runStatsRollup(deps, opts)
 *   deps: { rtdb, fsdb, listRestaurants: async () => [rid], keyer, log? }
 *   opts: { nowMs, mode: 'nightly'|'range', from?, to?, restaurants?: [rid], commit: bool, budget?, limits?, strictLease? }
 * Returns a report. In commit mode, publishes; in dry-run, writes nothing.
 */
async function runStatsRollup(deps, opts) {
  const { rtdb, fsdb, listRestaurants, keyer } = deps;
  const log = deps.log || ((k, d) => console.log(k, JSON.stringify(d)));
  const { nowMs, mode, commit = false, budget = DEFAULT_BUDGET, limits = S.LIMITS, strictLease = false } = opts;
  if (typeof keyer !== 'function') throw new Error('stats_job_needs_keyer');   // the secret failed closed upstream

  let baseDates;
  if (mode === 'nightly') baseDates = nightlyDates(nowMs);
  else if (mode === 'range') {
    if (!opts.from || !opts.to || opts.to < opts.from) throw new Error('stats_job_bad_range');
    dayStartMs(opts.from); dayStartMs(opts.to);   // validates
    baseDates = [];
    for (let d = opts.from; d <= opts.to; d = addDays(d, 1)) baseDates.push(d);
  } else throw new Error(`stats_job_bad_mode: ${mode}`);
  if (baseDates.some((d) => d >= dateOf(nowMs))) throw new Error('stats_job_target_includes_today: today is live-only, never stored');

  const registry = await listRestaurants();
  const wanted = opts.restaurants ? opts.restaurants.filter((r) => registry.includes(r)) : registry;
  if (opts.restaurants && wanted.length !== opts.restaurants.length) throw new Error(`stats_job_unknown_restaurant: ${opts.restaurants.filter((r) => !registry.includes(r)).join(',')}`);

  const report = { mode, commit, restaurants: {}, read: null };
  const targets = new Map();   // rid → sorted dates
  const leases = new Map();
  try {
    for (const rid of wanted) {
      if (commit) {
        try { leases.set(rid, await (deps._acquireLease || S.acquireLease)(fsdb, rid)); }
        catch (e) {
          if (strictLease || e.code !== 'stats_locked') throw e;
          log('stats_rollup_skipped_locked', { rid });          // another run holds it; tomorrow re-settles
          report.restaurants[rid] = { skipped: 'locked' };
          continue;
        }
      }
      /* 🔴 THE REPAIR METADATA IS READ *UNDER* THE LEASE (codex build r1 #3). Read before it, another run
         could publish a chunk (recording its remainder in pending_repair) and release between this read
         and our acquisition — and this run would decide its targets without that remainder. Under the
         lease, no other run can publish for this restaurant until we release, so what we read is what
         we publish against. (publishChunk also UNIONS pending_repair, so even a stale decision cannot
         erase a remainder.) */
      const set = new Set(baseDates);
      const meta = await S.readMeta(fsdb, rid);
      if (meta && Array.isArray(meta.pending_repair)) for (const d of meta.pending_repair) if (d < dateOf(nowMs)) set.add(d);   // RESUME
      targets.set(rid, [...set].sort());
    }
    if (!targets.size) return report;

    const all = [...new Set([].concat(...targets.values()))].sort();
    // Server time, taken AFTER every lease is held and BEFORE the read: anything published from a read
    // that began later is newer than this run, and the freshness check will refuse this run against it.
    const readStartedAt = commit ? await S.serverNow(fsdb, [...targets.keys()][0]) : nowMs;
    const fromMs = dayStartMs(all[0]) - READ_PAD_MS;
    const toMs = dayEndMs(all[all.length - 1]);
    const { orders, stats } = await readOrdersBounded(rtdb, fromMs, toMs, budget);
    report.read = stats;

    const built = buildDailies(orders, { keyer, restaurants: new Set(targets.keys()), dates: new Set(all) });
    report.skipped_no_time = built.skippedNoTime;
    const failures = [];
    for (const [rid, dates] of targets) {
     try {
      const summaries = built.get(rid) || new Map();
      const rr = { dates: dates.length, from: dates[0], to: dates[dates.length - 1], sale_orders: 0, sale_cents: 0, epochs: [], measures: [] };
      for (const d of dates) { const s = summaries.get(d); rr.sale_orders += s.sale.orders; rr.sale_cents += s.sale.cents; }
      // Chunks sized by COUNT and BYTES against the supported volume. The index bound is the union of the
      // current and the final index (every intermediate state lies within it).
      const current = await S.readShards(fsdb, rid);
      const finalIdx = rederive(current, dates, S.contributionsOf(summaries, dates));
      // 🔴 A PER-CUSTOMER DATE UNION (codex build r1 #5). An intermediate publication can hold a
      // customer's NEW dates (from chunks already published) beside OLD dates still awaiting removal, so
      // the bound is the union of each customer's current and final lists — not an object spread, which
      // kept only the final list and under-counted exactly that customer.
      const unionIdx = unionShards(current, finalIdx);
      const dailyBytesOf = (d) => S.protoWriteBytes(S.dailyRef(fsdb, rid, d).path, { ...summaries.get(d), date: d, gen: 0, computed_at: null });
      const parts = S.planChunks(dates, dailyBytesOf, S.shardsBytes(fsdb, rid, unionIdx), limits);
      rr.chunks = parts.length;
      if (!commit) {
        // Dry-run MEASURES each publication against the index AS IT WILL BE when that chunk lands: the
        // simulated index advances chunk by chunk, exactly as successive commits would advance it.
        let sim = current;
        for (const p of parts) {
          sim = rederive(sim, p, S.contributionsOf(summaries, p));
          rr.measures.push(S.preflight(S.publicationWrites(fsdb, rid, { summaries, dates: p, shards: sim, metaData: { epoch: 0, pending_repair: dates.slice(dates.indexOf(p[p.length - 1]) + 1) } }), limits));
        }
      } else {
        for (let i = 0; i < parts.length; i++) {
          const pendingAfter = [].concat(...parts.slice(i + 1));
          const r = await S.publishChunk(fsdb, rid, { summaries, dates: parts[i], token: leases.get(rid), readStartedAt, pendingAfter, limits });
          rr.epochs.push(r.epoch); rr.measures.push(r.measure);
        }
      }
      report.restaurants[rid] = rr;
      log('stats_rollup_restaurant', { rid, ...rr, measures: rr.measures.map((m) => ({ writes: m.writes, commit_bytes: m.commit_bytes, max_doc_bytes: m.max_doc_bytes, max_index_entries: m.max_index_entries })) });
     } catch (e) {
      // One restaurant's refusal (stale read, lost lease, over-volume) must not starve the others —
      // but it is never swallowed: the run FAILS at the end, naming every restaurant that did not publish.
      failures.push({ rid, code: e.code || 'error', message: String(e.message || e).slice(0, 300) });
      report.restaurants[rid] = { ...(report.restaurants[rid] || {}), error: e.code || 'error' };
      log('stats_rollup_restaurant_failed', failures[failures.length - 1]);
     }
    }
    if (failures.length) {
      const e = new Error(`stats_rollup_failed: ${failures.map((f) => `${f.rid}:${f.code}`).join(', ')}`);
      e.code = 'stats_rollup_failed'; e.report = report; e.failures = failures;
      throw e;
    }
    return report;
  } finally {
    for (const [rid, token] of leases) { try { await S.releaseLease(fsdb, rid, token); } catch (e) { log('stats_lease_release_failed', { rid, error: String(e.message || e).slice(0, 120) }); } }
  }
}

module.exports = { runStatsRollup, readOrdersBounded, nightlyDates, unionShards, DEFAULT_BUDGET, NIGHTLY_DAYS };
