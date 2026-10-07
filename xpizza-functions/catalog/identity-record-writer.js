'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D4-c1 — THE IDENTITY-RECORD WRITERS (PLAN-D4c1 rev 7 §3). BACKGROUND ONLY.
//
//   • writeIdentityRecordOnMirror — a NEW identity-only RTDB trigger on catalog_snapshot/{rid}: establishes the record for
//     the version NAMED in the written mirror value (exactly that version, never a different active one). Its own
//     invocation/instances/timeout; NO platform retry. The existing D4-a writeCatalogContextOnMirror is byte-unchanged.
//   • reconcileIdentityRecords — every 30 min: per restaurant (round-robin from a persisted restaurant cursor) FIRST the
//     mirror's version and the active version (30 s deadline each), THEN retained versions paged (seq desc, tie versionId)
//     from a persisted cursor catalog_ctx_cursor/{rid}. ≤ 25 versions/page, concurrency 2, 60 s/restaurant, 240 s/run.
//
// 🔴 THE ONLY WRITES are: the §3a version-node transaction on catalog_ctx/{rid}/{versionId}, and the two exact-value CAS
// cursor transactions. Nothing here writes a price, a pointer, a version, catalog_snapshot or catalog_snapshot_ctx.
// Publish, rollback and bootstrap are NOT changed and NOT called.
//
// 🔴 BOUNDED, BOTH WAYS (the D4-a writer's discipline): the returned promise is settled by a timer race even if an
// operation never settles, AND `stop()` is checked before every further read/write and on every transaction retry (the
// callback aborts). Overlapping invocations are SAFE: the §3a transaction is idempotent and the cursors move only by CAS.
// ---------------------------------------------------------------------------
const { FieldPath } = require('firebase-admin/firestore');
const { canonicalJson } = require('./canonical-json');
const { activePointerRef, readPointerSnap } = require('./catalog-firestore');
const { sanitize } = require('./restaurant-registry');
const {
  IDENTITY_PATH, buildIdentityRecord, validateRecord, applyCandidate, isPathKey,
} = require('./identity-record');

const IDENTITY_TRIGGER_DEADLINE_MS = 45000;        // < the trigger's 60 s function timeout
const IDENTITY_TRIGGER_TIMEOUT_S = 60;
const IDENTITY_RECONCILE_INTERVAL = 'every 30 minutes';
const IDENTITY_RECONCILE_INTERVAL_MS = 30 * 60 * 1000;
const IDENTITY_RECONCILE_TIMEOUT_S = 300;           // function timeout, BELOW the interval
const IDENTITY_RUN_BUDGET_MS = 240000;               // per run, below the function timeout
const IDENTITY_RESTAURANT_BUDGET_MS = 60000;         // per restaurant
const IDENTITY_RUNG_DEADLINE_MS = 30000;             // the mirror's and the active version, each
const IDENTITY_PAGE_SIZE = 25;
const IDENTITY_PAGE_CONCURRENCY = 2;
const IDENTITY_LIST_DEADLINE_MS = 10000;
const VERSION_CURSOR_PATH = 'catalog_ctx_cursor';                 // {rid} → {generation, position}
const RESTAURANT_CURSOR_PATH = 'catalog_ctx_restaurant_cursor';   // → {generation, position}

const versionRefOf = (db, rid, versionId) => db.collection('restaurants').doc(rid).collection('versions').doc(versionId);
const nodeRefOf = (rtdb, rid, versionId) => rtdb.ref(`${IDENTITY_PATH}/${rid}/${versionId}`);
const rowsOf = (qs) => (qs && qs.docs ? qs.docs : []).map((d) => ({ id: d.id, data: d.data() }))
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

class Abandoned extends Error { constructor() { super('identity_record_abandoned'); this.abandoned = true; } }

// A deadline: `stop()` throws once expired; `remaining()` for nested budgets.
function makeDeadline(ms, now = Date.now) {
  const until = now() + ms;
  const stop = () => { if (now() >= until || stop.forced) throw new Abandoned(); };
  stop.stopped = () => stop.forced || now() >= until;
  stop.remaining = () => Math.max(0, until - now());
  stop.forced = false;
  return stop;
}
// 🔴 CHECKPOINT RESERVE (codex c1 build r2 B1): the WORK deadline sits `reserve` ms before the hard one. Reads, rungs,
// page fetches and writes stop at the work deadline; only the checkpoint CAS may spend the reserve. So a write that
// stalls until the work deadline can never leave the settled prefix unpersisted (the CAS still has its time, and the
// caller has not yet stopped). The reserve is at most half the budget, so a small budget still does work.
function workDeadline(stop, reserveMs) {
  const reserve = Math.max(0, Math.min(reserveMs, Math.floor(stop.remaining() / 2)));
  return { reserve, remaining: () => Math.max(0, stop.remaining() - reserve), stopped: () => stop.stopped() || stop.remaining() <= reserve };
}
function withTimer(promise, ms, onTimeout) {
  let timer = null;
  // onTimeout may return a value OR throw — a throw REJECTS the race (never an uncaught exception in a timer callback)
  return Promise.race([promise, new Promise((resolve, reject) => {
    timer = setTimeout(() => { try { resolve(onTimeout()); } catch (e) { reject(e); } }, ms);
  })]).finally(() => { if (timer) clearTimeout(timer); });
}

// ONE read-only Firestore transaction on the NAMED version (the D4-a readActiveSnapshot pattern, without the pointer):
// the record, its updateTime, items, extras and structure — one consistent state, validated BEFORE the RTDB transaction.
async function readVersionSnapshot(db, rid, versionId, stop = () => {}) {
  return db.runTransaction(async (tx) => {
    const vref = versionRefOf(db, rid, versionId);
    const recSnap = await tx.get(vref);
    stop();
    if (!recSnap.exists) return { missing: true };
    const [items, extras, structureSnap] = await Promise.all([
      tx.get(vref.collection('menu_items')), tx.get(vref.collection('extras')), tx.get(vref.collection('meta').doc('menu_structure')),
    ]);
    stop();
    return {
      rid, versionId, record: recSnap.data() || {}, updateTime: recSnap.updateTime,
      items: rowsOf(items), extras: rowsOf(extras), structure: structureSnap.exists ? (structureSnap.data() || null) : null,
    };
  }, { readOnly: true });
}

// ── Cursors: {generation, position}, moved ONLY by an exact-value CAS against what was observed ─────────────────────
const CURSOR_OP_DEADLINE_MS = 5000;   // every cursor read and every CAS, each
const normCursor = (c) => ({
  generation: c && Number.isSafeInteger(c.generation) && c.generation >= 0 ? c.generation : 0,
  position: c && c.position !== undefined && c.position !== null ? c.position : null,
});
// A promise raced against a deadline; the loser is never left unhandled.
function race(promise, ms, label) {
  let timer = null;
  const p = Promise.resolve(promise);
  p.catch(() => {});
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}_timeout`)), Math.max(0, ms)); })])
    .finally(() => { if (timer) clearTimeout(timer); });
}
// Bounded read. Throws `cursor_read_timeout` past the deadline.
async function readCursor(ref, { ms = CURSOR_OP_DEADLINE_MS } = {}) {
  const snap = await race(ref.get(), ms, 'cursor_read');
  return normCursor(snap && typeof snap.val === 'function' ? snap.val() : null);
}
// Commits `next` only if the stored cursor is EXACTLY `observed` (normalized). A slower run's partial checkpoint can
// therefore never overwrite a farther one in the same generation, and a stale pre-wraparound one never replaces the next.
// 🔴 THE FIRST CALLBACK MUST SEE THE SERVER VALUE: an RTDB transaction first runs its callback on the LOCAL cache (null when
// nothing is cached), and a refusing callback aborts on the spot — so ONE value listener is attached and its first event
// (the server's value) is awaited before the transaction. 🔴 BOUNDED, codex c1 build r1 B2: the listener's first event and
// the transaction each race the SAME deadline; the listener is detached in `finally` on success, failure, cancellation and
// timeout alike; and the transaction callback refuses (undefined) once the CAS is abandoned or its deadline / the caller's
// stop has passed — so a retry after abandonment can never commit. (A write the callback produced BEFORE the deadline may
// still be acknowledged later; it is the exact compare-and-set the caller asked for, against the value it observed.)
// → true only when this call committed.
async function casCursor(ref, observed, next, { ms = CURSOR_OP_DEADLINE_MS, now = Date.now, isStopped = () => false } = {}) {
  const want = canonicalJson(normCursor(observed));
  const until = now() + ms;
  let abandoned = false;
  const dead = () => abandoned || isStopped() || now() >= until;
  let first; let fail;
  const ready = new Promise((res, rej) => { first = res; fail = rej; });
  ready.catch(() => {});
  const onValue = () => first();
  const onCancel = (e) => fail(e || new Error('cursor_listen_cancelled'));
  try {
    ref.on('value', onValue, onCancel);   // inside the try: a throwing subscribe is a refusal (false), never a rejection
    await race(ready, until - now(), 'cursor_listen');
    if (dead()) return false;
    let matched = false;
    const tx = ref.transaction((cur) => {
      if (dead()) { matched = false; return undefined; }
      matched = canonicalJson(normCursor(cur)) === want;
      if (!matched) return undefined;
      const n = normCursor(next);
      return n.position === null ? { generation: n.generation } : n;
    }, undefined, false);
    const res = await race(tx, until - now(), 'cursor_cas');
    return !!(matched && res && res.committed);
  } catch (_) {
    return false;
  } finally {
    abandoned = true;
    ref.off('value', onValue);
  }
}

// ── The retained order: seq DESCENDING, ties by versionId DESCENDING ──────────────────────────────────────────────────
// Firestore sorts __name__ in the direction of the last sorted field, so (seq desc, __name__ desc) is served by the
// AUTOMATIC single-field index — no composite index, no deploy step (the opposite tie direction would need one).
// Malformed seq — explicit, CURSOR-SAFE disposition (codex c1 build r2 S2). The page query is
// 0 ≤ seq ≤ Number.MAX_SAFE_INTEGER, so every value it returns is a finite number that RTDB stores and JSON round-trips
// exactly — a page position can always be persisted:
//   · missing / non-numeric / negative / NaN / ±Infinity / unsafe integers (> 2^53−1): EXCLUDED by the query, never paged,
//     never a position;
//   · fractions within range (e.g. 3.5): paged in order; the one constructor refuses them (`seq_malformed`, settled), and
//     the position {seq: 3.5, versionId} is a finite double, so the cursor moves past them.
// Nothing is lost: the constructor refuses every excluded value too, so no record could exist for it; if one is ever the
// mirror's or the active version, the rung pass attempts it and reports the refusal. A row that is somehow not
// cursor-safe (unreachable under the query) ends the run with no checkpoint — fail closed, never a poisoned cursor.
//
// COVERAGE SEMANTICS (codex c1 build r2 S3) — keyset pagination over immutable keys (seq, versionId), per generation:
//   · every version present when a generation starts is visited AT LEAST ONCE in that generation (no offsets: a key
//     can be neither skipped nor shifted by inserts or deletes);
//   · a version inserted BEHIND the cursor (a smaller key, not yet reached) is visited in the CURRENT generation;
//     one inserted AHEAD of it (a larger key — new publishes have the highest seq) is visited in the NEXT generation
//     (and by the trigger, which records the named version at once);
//   · overlapping runs and unsettled-prefix retries visit some versions MORE THAN ONCE, by design; every write is the
//     idempotent §3a transaction, so a duplicate visit commits nothing.
const isCursorSeq = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const positionOf = (v) => ({ seq: v.seq, versionId: v.versionId });
async function versionPage(db, rid, position, limit) {
  let q = db.collection('restaurants').doc(rid).collection('versions')
    .where('seq', '>=', 0).where('seq', '<=', Number.MAX_SAFE_INTEGER)
    .orderBy('seq', 'desc').orderBy(FieldPath.documentId(), 'desc');
  if (position) q = q.startAfter(position.seq, position.versionId);
  const snap = await q.limit(limit).select('seq').get();
  return snap.docs.map((d) => ({ versionId: d.id, seq: (d.data() || {}).seq }));
}
// The pure order (used by tests to state expectations independently of Firestore).
function orderVersions(list) {
  return list.slice().sort((a, b) => (b.seq - a.seq) || (a.versionId < b.versionId ? 1 : a.versionId > b.versionId ? -1 : 0));
}

function createIdentityRecordWriter({
  db, rtdb, now = Date.now,
  log = (k, d) => { try { console.log(k, JSON.stringify(d)); } catch (_) {} },
  recordOpts = {}, applyOpts = {},
} = {}) {
  const stats = { reads: 0, transactions: 0, callbackCalls: 0, versionDocsFetched: 0 };

  // writeVersion(rid, versionId) → { rid, versionId, settled, committed, outcomes, ... }. NEVER rejects; bounded.
  function writeVersion(rid, versionId, { deadlineMs = IDENTITY_TRIGGER_DEADLINE_MS, source = 'direct' } = {}) {
    const stop = makeDeadline(deadlineMs, now);
    const report = (r) => { const out = { rid, versionId, source, ...r }; log('identity_record_write', out); return out; };
    const work = (async () => {
      await null;
      try {
        if (!isPathKey(rid) || !isPathKey(versionId)) return report({ settled: true, committed: false, outcomes: ['source_malformed'] });
        stop();
        stats.reads += 1;
        const snap = await readVersionSnapshot(db, rid, versionId, stop);
        if (snap.missing) return report({ settled: true, committed: false, outcomes: ['version_missing'] });
        const built = buildIdentityRecord(snap, recordOpts);
        if (!built.ok) return report({ settled: true, committed: false, outcomes: [built.reason], detail: built.detail || null });
        const self = validateRecord(built.digest, built.record, { rid, versionId });   // the writer's own self-check
        if (!self.ok) return report({ settled: true, committed: false, outcomes: ['self_check_failed'], detail: self.reason });
        const cand = { digest: built.digest, record: built.record, ck: built.ck };
        stop();
        let last = null; let aborted = false;
        stats.transactions += 1;
        const res = await nodeRefOf(rtdb, rid, versionId).transaction((current) => {
          stats.callbackCalls += 1;
          if (stop.stopped()) { aborted = true; last = null; return undefined; }   // abandonment on EVERY retry: commit nothing
          aborted = false;
          last = applyCandidate(current, cand, { rid, versionId }, applyOpts);
          return last.write ? last.next : undefined;
        }, undefined, false);
        // Outcomes are logged ONLY after the transaction settles, distinguishing committed changes from aborted attempts.
        const base = { digest: built.digest, ck: built.ck, bytes: built.bytes };
        if (aborted || !last) return report({ settled: false, committed: false, outcomes: ['aborted'], ...base });
        const committed = !!(last.write && res && res.committed);
        if (last.write && !committed) return report({ settled: false, committed: false, outcomes: ['aborted'], attempted: last.outcomes, ...base });
        return report({ settled: true, committed, outcomes: last.outcomes, ...base,
          unrecoverable: last.detail.unrecoverable, evicted: last.detail.evicted, nodeBytes: last.detail.bytes });
      } catch (e) {
        if (e && e.abandoned) return { rid, versionId, source, settled: false, committed: false, outcomes: ['timeout'], late: true };
        return report({ settled: true, committed: false, outcomes: ['read_failed'], error: String((e && e.message) || e).slice(0, 200) });
      }
    })();
    return withTimer(work, deadlineMs, () => { stop.forced = true; return report({ settled: false, committed: false, outcomes: ['timeout'], deadlineMs }); });
  }

  // The trigger: the version NAMED in the written mirror value. Deleted or malformed value → logged no-op.
  async function onMirrorWritten(rid, value, { deadlineMs = IDENTITY_TRIGGER_DEADLINE_MS } = {}) {
    try {
      if (value === null || value === undefined) { log('identity_record_trigger', { rid, outcome: 'deleted_noop' }); return { rid, outcomes: ['deleted_noop'] }; }
      if (typeof value !== 'object' || !isPathKey(value.version)) { log('identity_record_trigger', { rid, outcome: 'malformed_noop' }); return { rid, outcomes: ['malformed_noop'] }; }
      return await writeVersion(rid, value.version, { deadlineMs, source: 'trigger' });
    } catch (e) {
      log('identity_record_trigger', { rid, outcome: 'failed', error: String((e && e.message) || e).slice(0, 160) });
      return { rid, outcomes: ['failed'] };
    }
  }

  // ── default production readers (each injectable for tests) ─────────────────────────────────────────────────────────
  const readers = {
    mirrorVersionId: async (rid) => { const s = await rtdb.ref(`catalog_snapshot/${rid}/version`).get(); const v = s && s.val(); return isPathKey(v) ? v : null; },
    activeVersionId: async (rid) => readPointerSnap(await activePointerRef(db, rid).get(), rid).version,
    // ONE bounded Firestore page in the fixed order, from the persisted position (never a collection scan)
    versionPage: async (rid, position, limit) => {
      const page = await versionPage(db, rid, position, limit);
      stats.versionDocsFetched += page.length;
      return page;
    },
  };

  // One restaurant: rungs first, then bounded pages of retained versions from the cursor. Never rejects; bounded by `stop`.
  // Every read, rung, page fetch and write is clipped to the WORK deadline; the checkpoint CAS to the hard one (the reserve).
  async function reconcileRestaurant(rid, stop, opts) {
    const { pageSize = IDENTITY_PAGE_SIZE, concurrency = IDENTITY_PAGE_CONCURRENCY, rungDeadlineMs = IDENTITY_RUNG_DEADLINE_MS,
      cursorOpMs = CURSOR_OP_DEADLINE_MS, checkpointReserveMs = cursorOpMs, r = readers } = opts;
    const out = { rid, rungs: {}, versions: [], pages: 0, cursor: null };
    const work = workDeadline(stop, checkpointReserveMs);
    const clip = (ms) => Math.max(0, Math.min(ms, work.remaining()));
    const clipCheckpoint = (ms) => Math.max(0, Math.min(ms, stop.remaining()));
    const checkpoint = (observed, next) => casCursor(rtdb.ref(`${VERSION_CURSOR_PATH}/${rid}`), observed, next, { ms: clipCheckpoint(cursorOpMs), now, isStopped: () => stop.stopped() });
    const settledRead = (p, ms) => race(Promise.resolve().then(p), ms, 'rung_read').catch((e) => ({ error: String((e && e.message) || e).slice(0, 160) }));
    // (1) the mirror's version and the active version, each with its own deadline
    for (const [name, fn] of [['mirror', r.mirrorVersionId], ['active', r.activeVersionId]]) {
      if (work.stopped()) break;
      const ms = clip(rungDeadlineMs);
      const t0 = now();
      const vid = await settledRead(() => fn(rid), ms);
      if (vid && vid.error) { out.rungs[name] = { outcomes: ['rung_read_failed'], error: vid.error }; continue; }
      if (!vid) { out.rungs[name] = { outcomes: ['no_version'] }; continue; }
      if (Object.values(out.rungs).some((x) => x.versionId === vid)) { out.rungs[name] = { versionId: vid, outcomes: ['same_as_mirror'] }; continue; }
      const left = Math.min(ms - (now() - t0), work.remaining());
      if (left <= 0) { out.rungs[name] = { versionId: vid, outcomes: ['budget_exhausted'], settled: false }; continue; }
      const res = await writeVersion(rid, vid, { deadlineMs: left, source: `reconcile_${name}` });
      out.rungs[name] = { versionId: vid, outcomes: res.outcomes, settled: res.settled };
    }
    // (2) retained versions: ONE bounded page query per page, from the persisted cursor
    const cref = rtdb.ref(`${VERSION_CURSOR_PATH}/${rid}`);
    while (!work.stopped()) {
      let observed, fetched;
      try {
        observed = await readCursor(cref, { ms: clip(cursorOpMs) });
        fetched = await race(Promise.resolve(r.versionPage(rid, observed.position, pageSize + 1)), clip(IDENTITY_LIST_DEADLINE_MS), 'version_page');
      } catch (e) { out.listError = String((e && e.message) || e).slice(0, 160); break; }
      const rows = (Array.isArray(fetched) ? fetched : []).filter(Boolean);
      if (rows.length === 0) {   // nothing after the position → wraparound: the next generation starts from the top
        const ok = await checkpoint(observed, { generation: observed.generation + 1, position: null });
        out.cursor = { wrapped: true, cas: ok };
        break;
      }
      // the page and "last page" come from the RAW query rows (a skipped row must never end a generation early)
      const page = rows.slice(0, pageSize);
      const isLastPage = rows.length <= pageSize;
      if (!page.every((v) => isCursorSeq(v.seq))) { out.listError = 'seq_not_cursor_safe'; break; }   // unreachable under the query: fail closed
      out.pages += 1;
      const settled = new Array(page.length).fill(false);
      let next = 0;
      const worker = async () => {
        while (next < page.length && !work.stopped()) {
          const i = next++;
          if (!isPathKey(page[i].versionId)) {   // not addressable as an RTDB key: skipped, reported, settled
            settled[i] = true; out.versions.push({ versionId: String(page[i].versionId).slice(0, 80), outcomes: ['version_id_malformed'], settled: true }); continue;
          }
          const res = await writeVersion(rid, page[i].versionId, { deadlineMs: Math.max(1, work.remaining()), source: 'reconcile_retained' });
          settled[i] = res.settled === true;   // success OR a reported failure; a timeout/abort is UNSETTLED
          out.versions.push({ versionId: page[i].versionId, outcomes: res.outcomes, settled: res.settled });
        }
      };
      await Promise.allSettled(Array.from({ length: Math.min(concurrency, page.length) }, worker));
      // checkpoint ONLY the contiguous prefix of settled versions — inside the reserve, so it is persisted even when the
      // work deadline cut the page short
      let k = 0; while (k < page.length && settled[k]) k += 1;
      if (k === 0) { out.cursor = { advanced: false, reason: 'first_version_unsettled' }; break; }
      const nextCursor = k === page.length && isLastPage
        ? { generation: observed.generation + 1, position: null }
        : { generation: observed.generation, position: positionOf(page[k - 1]) };
      const ok = await checkpoint(observed, nextCursor);
      out.cursor = { advanced: ok, to: nextCursor, prefix: k, page: page.length };
      if (!ok) { log('identity_cursor_cas_lost', { rid, observed, attempted: nextCursor }); break; }
      if (k < page.length || nextCursor.position === null) break;
    }
    return out;
  }

  // The scheduled run: round-robin from the persisted restaurant cursor; run budget never starves later restaurants.
  // TOTAL BOUND = listing + restaurant-cursor read + run budget + final CAS (each bounded), below the function timeout.
  async function reconcile({
    listIds, runBudgetMs = IDENTITY_RUN_BUDGET_MS, restaurantBudgetMs = IDENTITY_RESTAURANT_BUDGET_MS,
    listDeadlineMs = IDENTITY_LIST_DEADLINE_MS, cursorOpMs = CURSOR_OP_DEADLINE_MS, ...opts
  } = {}) {
    let ids;
    try {
      ids = sanitize(await race(Promise.resolve().then(() => listIds()), listDeadlineMs, 'identity_reconcile_list')).slice().sort();
    } catch (e) {
      log('identity_reconcile', { ok: false, error: String((e && e.message) || e).slice(0, 160) });
      return { ok: false, results: [] };
    }
    const rref = rtdb.ref(RESTAURANT_CURSOR_PATH);
    let observed;
    try { observed = await readCursor(rref, { ms: cursorOpMs }); } catch (e) {
      log('identity_reconcile', { ok: false, error: 'restaurant_cursor_unreadable' });
      return { ok: false, results: [] };   // without the observed cursor no CAS is possible: do nothing rather than guess
    }
    const run = makeDeadline(runBudgetMs, now);
    const start = observed.position === null ? 0 : ids.findIndex((x) => x > observed.position);
    const order = start < 0 ? [] : ids.slice(start);
    const results = [];
    const settledRids = [];
    for (const rid of order) {
      if (run.stopped()) break;
      const budget = Math.min(restaurantBudgetMs, run.remaining());
      const stop = makeDeadline(budget, now);
      const res = await withTimer(reconcileRestaurant(rid, stop, { cursorOpMs, ...opts }).catch((e) => ({ rid, error: String((e && e.message) || e).slice(0, 160) })),
        budget + 50, () => { stop.forced = true; return { rid, timedOut: true }; });
      results.push(res);
      settledRids.push(rid);   // a restaurant whose bounded pass RETURNED is settled; its own cursor holds its progress
    }
    const reachedEnd = settledRids.length === order.length;
    const nextCursor = reachedEnd ? { generation: observed.generation + 1, position: null }
      : settledRids.length ? { generation: observed.generation, position: settledRids[settledRids.length - 1] } : null;
    const cas = nextCursor ? await casCursor(rref, observed, nextCursor, { ms: cursorOpMs, now }) : null;
    const counts = {};
    const oversize = {};   // §3b rollout check: per restaurant, every `oversize` refusal (expected: none)
    for (const r of results) {
      for (const v of [...Object.values(r.rungs || {}), ...(r.versions || [])]) {
        for (const o of v.outcomes || []) {
          counts[o] = (counts[o] || 0) + 1;
          if (o === 'oversize') oversize[r.rid] = (oversize[r.rid] || 0) + 1;
        }
      }
    }
    log('identity_reconcile', { ok: true, restaurants: ids.length, processed: settledRids.length, cursor: nextCursor, cas, counts, oversize });
    return { ok: true, results, processed: settledRids, cursor: nextCursor, cas, oversize };
  }

  return { writeVersion, onMirrorWritten, reconcile, reconcileRestaurant, readers, stats };
}

module.exports = {
  workDeadline, isCursorSeq,
  createIdentityRecordWriter, readVersionSnapshot, casCursor, readCursor, normCursor, orderVersions, versionPage, makeDeadline, race,
  CURSOR_OP_DEADLINE_MS, IDENTITY_LIST_DEADLINE_MS,
  IDENTITY_TRIGGER_DEADLINE_MS, IDENTITY_TRIGGER_TIMEOUT_S, IDENTITY_RECONCILE_INTERVAL, IDENTITY_RECONCILE_INTERVAL_MS,
  IDENTITY_RECONCILE_TIMEOUT_S, IDENTITY_RUN_BUDGET_MS, IDENTITY_RESTAURANT_BUDGET_MS, IDENTITY_RUNG_DEADLINE_MS,
  IDENTITY_PAGE_SIZE, IDENTITY_PAGE_CONCURRENCY, VERSION_CURSOR_PATH, RESTAURANT_CURSOR_PATH,
};
