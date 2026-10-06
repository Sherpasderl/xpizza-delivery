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
const normCursor = (c) => ({
  generation: c && Number.isSafeInteger(c.generation) && c.generation >= 0 ? c.generation : 0,
  position: c && c.position !== undefined && c.position !== null ? c.position : null,
});
async function readCursor(ref) {
  const snap = await ref.get();
  return normCursor(snap && typeof snap.val === 'function' ? snap.val() : null);
}
// Commits `next` only if the stored cursor is EXACTLY `observed` (normalized). A slower run's partial checkpoint can
// therefore never overwrite a farther one in the same generation, and a stale pre-wraparound one never replaces the next.
// 🔴 THE FIRST CALLBACK MUST SEE THE SERVER VALUE. An RTDB transaction first runs its callback on the LOCAL cache — null
// when nothing is cached — and a callback that returns undefined aborts on the spot, never seeing the server's value. A
// CAS that refuses on mismatch would therefore refuse EVERY non-null cursor (measured: the version cursor never advanced
// past its first checkpoint). A live value listener keeps the cache current for the duration, so the comparison is made
// against what the server holds — exact, with no speculative write.
async function casCursor(ref, observed, next) {
  const want = canonicalJson(normCursor(observed));
  const listener = ref.on('value', () => {}, () => {});
  try {
    await ref.once('value');
    let matched = false;
    const res = await ref.transaction((cur) => {
      matched = canonicalJson(normCursor(cur)) === want;
      if (!matched) return undefined;
      const n = normCursor(next);
      return n.position === null ? { generation: n.generation } : n;
    }, undefined, false);
    return !!(matched && res && res.committed);
  } finally {
    ref.off('value', listener);
  }
}

// Retained versions in the fixed order: seq DESCENDING, ties by versionId ascending. A version without an integer seq
// sorts last (seq −1); its key stays deterministic.
const seqOf = (v) => (Number.isSafeInteger(v.seq) ? v.seq : -1);
function orderVersions(list) {
  return list.slice().sort((a, b) => (seqOf(b) - seqOf(a)) || (a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0));
}
const positionOf = (v) => ({ seq: seqOf(v), versionId: v.versionId });
// Is version v strictly AFTER position p in the fixed order?
const after = (v, p) => !p || seqOf(v) < p.seq || (seqOf(v) === p.seq && v.versionId > p.versionId);

function createIdentityRecordWriter({
  db, rtdb, now = Date.now,
  log = (k, d) => { try { console.log(k, JSON.stringify(d)); } catch (_) {} },
  recordOpts = {}, applyOpts = {},
} = {}) {
  const stats = { reads: 0, transactions: 0, callbackCalls: 0 };

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
    listVersions: async (rid) => (await db.collection('restaurants').doc(rid).collection('versions').select('seq').get()).docs
      .map((d) => ({ versionId: d.id, seq: (d.data() || {}).seq })),
  };

  // One restaurant: rungs first, then pages of retained versions from the cursor. Never rejects; bounded by `stop`.
  async function reconcileRestaurant(rid, stop, opts) {
    const { pageSize = IDENTITY_PAGE_SIZE, concurrency = IDENTITY_PAGE_CONCURRENCY, rungDeadlineMs = IDENTITY_RUNG_DEADLINE_MS, r = readers } = opts;
    const out = { rid, rungs: {}, versions: [], pages: 0, cursor: null };
    const settledRead = (p, ms) => withTimer(Promise.resolve().then(p).catch((e) => ({ error: String((e && e.message) || e).slice(0, 160) })), ms, () => ({ error: 'deadline' }));
    // (1) the mirror's version and the active version, each with its own deadline
    for (const [name, fn] of [['mirror', r.mirrorVersionId], ['active', r.activeVersionId]]) {
      if (stop.stopped()) break;
      const ms = Math.min(rungDeadlineMs, stop.remaining());
      const t0 = now();
      const vid = await settledRead(() => fn(rid), ms);
      if (vid && vid.error) { out.rungs[name] = { outcomes: ['rung_read_failed'], error: vid.error }; continue; }
      if (!vid) { out.rungs[name] = { outcomes: ['no_version'] }; continue; }
      if (Object.values(out.rungs).some((x) => x.versionId === vid)) { out.rungs[name] = { versionId: vid, outcomes: ['same_as_mirror'] }; continue; }
      const res = await writeVersion(rid, vid, { deadlineMs: Math.max(1, Math.min(ms - (now() - t0), stop.remaining())), source: `reconcile_${name}` });
      out.rungs[name] = { versionId: vid, outcomes: res.outcomes, settled: res.settled };
    }
    // (2) retained versions, paged from the persisted cursor
    const cref = rtdb.ref(`${VERSION_CURSOR_PATH}/${rid}`);
    while (!stop.stopped()) {
      let observed, list;
      try {
        observed = await withTimer(readCursor(cref), stop.remaining(), () => { throw new Abandoned(); });
        list = await withTimer(Promise.resolve(r.listVersions(rid)), Math.min(IDENTITY_LIST_DEADLINE_MS, stop.remaining()), () => { throw new Error('list_deadline'); });
      } catch (e) { out.listError = String((e && e.message) || e).slice(0, 160); break; }
      const ordered = orderVersions((Array.isArray(list) ? list : []).filter((v) => v && isPathKey(v.versionId)));
      const rest = ordered.filter((v) => after(v, observed.position));
      if (rest.length === 0) {   // past the end → wraparound: the next generation starts from the top
        const ok = await casCursor(cref, observed, { generation: observed.generation + 1, position: null });
        out.cursor = { wrapped: true, cas: ok };
        break;
      }
      const page = rest.slice(0, pageSize);
      const isLastPage = rest.length <= pageSize;
      out.pages += 1;
      const settled = new Array(page.length).fill(false);
      let next = 0;
      const worker = async () => {
        while (next < page.length && !stop.stopped()) {
          const i = next++;
          const res = await writeVersion(rid, page[i].versionId, { deadlineMs: Math.max(1, stop.remaining()), source: 'reconcile_retained' });
          settled[i] = res.settled === true;   // success OR a reported failure; a timeout/abort is UNSETTLED
          out.versions.push({ versionId: page[i].versionId, outcomes: res.outcomes, settled: res.settled });
        }
      };
      await Promise.allSettled(Array.from({ length: Math.min(concurrency, page.length) }, worker));
      // checkpoint ONLY the contiguous prefix of settled versions
      let k = 0; while (k < page.length && settled[k]) k += 1;
      if (k === 0) { out.cursor = { advanced: false, reason: 'first_version_unsettled' }; break; }
      const nextCursor = k === page.length && isLastPage
        ? { generation: observed.generation + 1, position: null }
        : { generation: observed.generation, position: positionOf(page[k - 1]) };
      const ok = await casCursor(cref, observed, nextCursor);
      out.cursor = { advanced: ok, to: nextCursor, prefix: k, page: page.length };
      if (!ok) { log('identity_cursor_cas_lost', { rid, observed, attempted: nextCursor }); break; }
      if (k < page.length || nextCursor.position === null) break;
    }
    return out;
  }

  // The scheduled run: round-robin from the persisted restaurant cursor; run budget never starves later restaurants.
  async function reconcile({
    listIds, runBudgetMs = IDENTITY_RUN_BUDGET_MS, restaurantBudgetMs = IDENTITY_RESTAURANT_BUDGET_MS, ...opts
  } = {}) {
    const run = makeDeadline(runBudgetMs, now);
    let ids;
    try {
      const p = Promise.resolve(listIds()); p.catch(() => {});
      ids = sanitize(await withTimer(p, IDENTITY_LIST_DEADLINE_MS, () => { throw new Error('identity_reconcile_list_timeout'); })).slice().sort();
    } catch (e) {
      log('identity_reconcile', { ok: false, error: String((e && e.message) || e).slice(0, 160) });
      return { ok: false, results: [] };
    }
    const rref = rtdb.ref(RESTAURANT_CURSOR_PATH);
    let observed;
    try { observed = await readCursor(rref); } catch (_) { observed = normCursor(null); }
    const start = observed.position === null ? 0 : ids.findIndex((x) => x > observed.position);
    const order = start < 0 ? [] : ids.slice(start);
    const results = [];
    const settledRids = [];
    for (const rid of order) {
      if (run.stopped()) break;
      const stop = makeDeadline(Math.min(restaurantBudgetMs, run.remaining()), now);
      const res = await withTimer(reconcileRestaurant(rid, stop, opts).catch((e) => ({ rid, error: String((e && e.message) || e).slice(0, 160) })),
        Math.min(restaurantBudgetMs, run.remaining()) + 50, () => { stop.forced = true; return { rid, timedOut: true }; });
      results.push(res);
      settledRids.push(rid);   // a restaurant whose bounded pass RETURNED is settled; its own cursor holds its progress
    }
    const reachedEnd = settledRids.length === order.length;
    const nextCursor = reachedEnd ? { generation: observed.generation + 1, position: null }
      : settledRids.length ? { generation: observed.generation, position: settledRids[settledRids.length - 1] } : null;
    let cas = null;
    if (nextCursor) cas = await casCursor(rref, observed, nextCursor).catch(() => false);
    const counts = {};
    for (const r of results) {
      for (const v of [...Object.values(r.rungs || {}), ...(r.versions || [])]) for (const o of v.outcomes || []) counts[o] = (counts[o] || 0) + 1;
    }
    log('identity_reconcile', { ok: true, restaurants: ids.length, processed: settledRids.length, cursor: nextCursor, cas, counts });
    return { ok: true, results, processed: settledRids, cursor: nextCursor, cas };
  }

  return { writeVersion, onMirrorWritten, reconcile, reconcileRestaurant, readers, stats };
}

module.exports = {
  createIdentityRecordWriter, readVersionSnapshot, casCursor, readCursor, normCursor, orderVersions, makeDeadline,
  IDENTITY_TRIGGER_DEADLINE_MS, IDENTITY_TRIGGER_TIMEOUT_S, IDENTITY_RECONCILE_INTERVAL, IDENTITY_RECONCILE_INTERVAL_MS,
  IDENTITY_RECONCILE_TIMEOUT_S, IDENTITY_RUN_BUDGET_MS, IDENTITY_RESTAURANT_BUDGET_MS, IDENTITY_RUNG_DEADLINE_MS,
  IDENTITY_PAGE_SIZE, IDENTITY_PAGE_CONCURRENCY, VERSION_CURSOR_PATH, RESTAURANT_CURSOR_PATH,
};
