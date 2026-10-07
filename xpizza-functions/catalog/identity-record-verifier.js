'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D4-c1 — THE IDENTITY-RECORD LOADER + THE SCHEDULED CHECK (PLAN-D4c1 rev 7 §4). OFF THE REQUEST PATH.
//
//   loadVersionNode — Firestore-INDEPENDENT: ONE RTDB get of catalog_ctx/{rid}/{versionId}, a 1,500 ms timeout, a size
//   cap (RTDB fetches the node first; the reader refuses a node above NODE_CAP_BYTES). Nothing is prewarmed or cached.
//
//   verifyIdentityRecords (every 30 min, own resources, round-robin restaurant cursor + its own per-restaurant version
//   cursor). For each restaurant: the version currently in catalog_snapshot/{rid} (the mirror rung's), the active
//   version, and retained versions (paged). It verifies a valid head + record exists, and that the record's
//   usableForWriting (intact ∧ complete ∧ attached against INDEPENDENTLY captured served prices — the actual mirror
//   value's version/seq/tables for the mirror rung; the live Firestore read's tables for the active version; NEVER
//   prices reconstructed from the record) AGREES with D4-a's intact ∧ complete ∧ attached projection computed from a
//   live Firestore read of the same version. NOT usableAsIdentity (which adds registry confirmation).
//   Logs `identity_record_check`, reporting unavailable / invalid / incomparable / genuinely-attached SEPARATELY; only
//   genuinely-attached observations whose revision + content match count toward the rollout gate.
//
// 🔴 READ-ONLY on catalog data: the ONLY writes are its own two cursor CASes.
// ---------------------------------------------------------------------------
const { readVersionDocs, getActiveVersionId } = require('./catalog-firestore');
const { buildTablesFromDocs } = require('./catalog-transform');
const { pricesExactlyEqual } = require('./context-source');
const { sanitize } = require('./restaurant-registry');
const {
  IDENTITY_PATH, NODE_CAP_BYTES, buildIdentityRecord, identityFromVersionNode, utf8Bytes, isPathKey,
} = require('./identity-record');
const {
  readVersionSnapshot, casCursor, readCursor, normCursor, versionPage, makeDeadline, race, workDeadline, boundedWork, isCursorSeq,
  IDENTITY_RUN_BUDGET_MS, IDENTITY_RESTAURANT_BUDGET_MS, IDENTITY_PAGE_SIZE, CURSOR_OP_DEADLINE_MS, IDENTITY_LIST_DEADLINE_MS,
} = require('./identity-record-writer');

const IDENTITY_LOAD_TIMEOUT_MS = 1500;
const IDENTITY_VERIFY_INTERVAL = 'every 30 minutes';
const IDENTITY_VERIFY_TIMEOUT_S = 300;
const IDENTITY_VERIFY_READ_DEADLINE_MS = 15000;
const VERIFY_VERSION_CURSOR_PATH = 'catalog_ctx_verify_cursor';
const VERIFY_RESTAURANT_CURSOR_PATH = 'catalog_ctx_verify_restaurant_cursor';
const CATEGORIES = Object.freeze(['unavailable', 'invalid', 'incomparable', 'attached_agree', 'attached_disagree', 'not_attached']);

function deadline(promise, ms, label) {
  let timer = null;
  return Promise.race([Promise.resolve(promise), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms); })])
    .finally(() => { if (timer) clearTimeout(timer); });
}

// ONE RTDB get, bounded, size-capped. → { node } | { error }
async function loadVersionNode(rtdb, rid, versionId, { timeoutMs = IDENTITY_LOAD_TIMEOUT_MS, nodeCap = NODE_CAP_BYTES } = {}) {
  if (!isPathKey(rid) || !isPathKey(versionId)) return { error: 'bad_key' };
  try {
    const p = rtdb.ref(`${IDENTITY_PATH}/${rid}/${versionId}`).get();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    const snap = await deadline(p, timeoutMs, 'identity_load');
    const node = snap && typeof snap.val === 'function' ? snap.val() : null;
    if (node !== null && utf8Bytes(node) > nodeCap) return { error: 'oversize' };
    return { node };
  } catch (e) {
    return { error: /timeout/.test(String(e && e.message)) ? 'timeout' : 'read_failed' };
  }
}

// D4-a's projection for a version, from a LIVE Firestore read (the D4-a builder over the D4-a persisted encoding),
// attached against the SAME independently served prices. → { comparable, intact, complete, attached, usable, digest, identityRevision }
async function d4aProjection(db, rid, versionId, served) {
  try {
    const snap = await readVersionSnapshot(db, rid, versionId);
    if (snap.missing) return { comparable: false, reason: 'version_missing' };
    const built = buildIdentityRecord(snap);
    if (!built.ok && built.reason !== 'content_integrity') return { comparable: false, reason: built.reason };
    if (!built.ok) return { comparable: true, intact: false, complete: false, attached: false, usable: false, digest: null, identityRevision: null };
    const ctx = built.context;
    const attached = !!served && served.rid === rid && served.versionId === versionId && served.seq === ctx.seq && pricesExactlyEqual(ctx.prices, served.prices);
    return { comparable: true, intact: true, complete: ctx.complete === true, attached, usable: ctx.complete === true && attached, digest: built.digest, identityRevision: built.record.identityRevision };
  } catch (e) {
    return { comparable: false, reason: 'read_failed', error: String((e && e.message) || e).slice(0, 160) };
  }
}

// Classify one rung check (pure): the categories are reported SEPARATELY.
function classify(r, d) {
  if (r.availability === 'unavailable') return 'unavailable';
  if (r.availability === 'invalid') return 'invalid';
  if (!d || !d.comparable) return 'incomparable';
  if (!r.attached || !d.attached) return 'not_attached';
  const agree = r.usableForWriting === d.usable && r.digest === d.digest && r.identityRevision === d.identityRevision;
  return agree ? 'attached_agree' : 'attached_disagree';
}

function createIdentityVerifier({ db, rtdb, now = Date.now, log = (k, d) => { try { console.log(k, JSON.stringify(d)); } catch (_) {} } } = {}) {
  const stats = { versionDocsFetched: 0 };
  const readers = {
    mirrorValue: async (rid) => { const s = await rtdb.ref(`catalog_snapshot/${rid}`).get(); return s && s.val(); },
    activeServed: async (rid, versionId) => {
      const { itemDocs, extraDocs, seq } = await readVersionDocs(db, rid, versionId);   // the live pricing read (completeness-checked)
      const { menu, extras } = buildTablesFromDocs(itemDocs, extraDocs);
      return { rid, versionId, seq, prices: { menu, extras } };
    },
    activeVersionId: async (rid) => getActiveVersionId(db, rid),
    versionPage: async (rid, position, limit) => { const p = await versionPage(db, rid, position, limit); stats.versionDocsFetched += p.length; return p; },
  };
  const noStop = { remaining: () => Infinity, stopped: () => false };

  // One rung check, CLIPPED to the caller's remaining budget (the load, the D4-a projection — each bounded by both).
  async function checkRung(rid, rung, served, stop = noStop) {
    const versionId = served.versionId;
    const where = { rid, versionId };
    const loadMs = Math.min(IDENTITY_LOAD_TIMEOUT_MS, stop.remaining());
    if (!(loadMs > 0)) return { rung, versionId, category: 'unavailable', reason: 'budget_exhausted' };
    const loaded = await loadVersionNode(rtdb, rid, versionId, { timeoutMs: loadMs });
    if (loaded.error) return { rung, versionId, category: loaded.error === 'oversize' ? 'invalid' : 'unavailable', reason: `load_${loaded.error}` };
    const r = identityFromVersionNode(loaded.node, served, where);
    let d = null;
    if (r.availability === 'available') {
      const ms = Math.min(IDENTITY_VERIFY_READ_DEADLINE_MS, stop.remaining());
      d = ms > 0 ? await race(d4aProjection(db, rid, versionId, served), ms, 'd4a').catch(() => ({ comparable: false, reason: 'timeout' }))
        : { comparable: false, reason: 'budget_exhausted' };
    }
    return {
      rung, versionId, category: classify(r, d), reason: r.reason || (d && !d.comparable ? d.reason : null),
      record: { availability: r.availability, certified: r.certified, complete: r.complete, attached: r.attached, usableForWriting: r.usableForWriting, digest: r.digest || null },
      d4a: d && d.comparable ? { complete: d.complete, attached: d.attached, usable: d.usable, digest: d.digest } : null,
    };
  }

  // Every read, rung check, page fetch and load is clipped to the WORK deadline; only the checkpoint CAS spends the reserve
  // (codex c1 build r2 B1 — the settled prefix is persisted even when a load stalls to the work deadline).
  async function verifyRestaurant(rid, stop, { r = readers, pageSize = IDENTITY_PAGE_SIZE, cursorOpMs = CURSOR_OP_DEADLINE_MS, checkpointReserveMs = cursorOpMs } = {}) {
    const out = { rid, rungs: [], retained: {}, cursor: null };
    const work = workDeadline(stop, checkpointReserveMs);
    const clip = (ms) => Math.max(0, Math.min(ms, work.remaining()));
    // every read is a THUNK started only before the work deadline (codex c1 build r3 S1) — never an already-started promise
    const bounded = (thunk) => boundedWork(work, thunk, IDENTITY_VERIFY_READ_DEADLINE_MS, 'verify_read');
    const why = (e, fallback) => (e && e.workDeadline ? 'budget_exhausted' : fallback);
    // mirror rung: the ACTUAL catalog_snapshot value's version/seq/tables
    try {
      const m = await bounded(() => r.mirrorValue(rid));
      if (!m || !isPathKey(m.version)) out.rungs.push({ rung: 'mirror', category: 'incomparable', reason: 'no_mirror' });
      else if (!m.menu || typeof m.menu !== 'object' || !m.extras || typeof m.extras !== 'object') {
        out.rungs.push({ rung: 'mirror', versionId: m.version, category: 'incomparable', reason: 'mirror_tables_missing' });
      } else out.rungs.push(await checkRung(rid, 'mirror', { rid, versionId: m.version, seq: m.seq, prices: { menu: m.menu, extras: m.extras } }, work));
    } catch (e) { out.rungs.push({ rung: 'mirror', category: 'incomparable', reason: why(e, 'mirror_read_failed') }); }
    // active rung: the live Firestore read's tables
    try {
      const vid = await bounded(() => r.activeVersionId(rid));
      if (!vid) out.rungs.push({ rung: 'active', category: 'incomparable', reason: 'no_active_version' });
      else out.rungs.push(await checkRung(rid, 'active', await bounded(() => r.activeServed(rid, vid)), work));
    } catch (e) { out.rungs.push({ rung: 'active', category: 'incomparable', reason: why(e, 'active_read_failed') }); }
    // retained versions: ONE bounded page per run, from this verifier's own cursor (no served prices → attachment N/A)
    const cref = rtdb.ref(`${VERIFY_VERSION_CURSOR_PATH}/${rid}`);
    {   // the cursor read's gate is the work-deadline check
      try {
        const observed = await boundedWork(work, () => readCursor(cref, { ms: clip(cursorOpMs) }), cursorOpMs, 'cursor_read');
        // the page and "last page" come from the RAW query rows (a skipped row must never end a generation early)
        const rows = (await boundedWork(work, () => r.versionPage(rid, observed.position, pageSize + 1), IDENTITY_LIST_DEADLINE_MS, 'version_page')).filter(Boolean);
        const page = rows.slice(0, pageSize);
        if (!page.every((v) => isCursorSeq(v.seq))) throw new Error('seq_not_cursor_safe');   // unreachable under the query: fail closed
        let k = 0;
        for (const v of page) {
          if (!isPathKey(v.versionId)) { out.retained.version_id_malformed = (out.retained.version_id_malformed || 0) + 1; k += 1; continue; }
          const ms = Math.min(IDENTITY_LOAD_TIMEOUT_MS, work.remaining());
          if (!(ms > 0)) break;
          const loaded = await loadVersionNode(rtdb, rid, v.versionId, { timeoutMs: ms });
          if (loaded.error === 'timeout' && work.stopped()) break;
          const res = loaded.error ? { availability: loaded.error === 'oversize' ? 'invalid' : 'unavailable' } : identityFromVersionNode(loaded.node, null, { rid, versionId: v.versionId });
          out.retained[res.availability] = (out.retained[res.availability] || 0) + 1;
          k += 1;
        }
        const next = page.length === 0 || (k === page.length && rows.length <= pageSize)
          ? { generation: observed.generation + 1, position: null }
          : k > 0 ? { generation: observed.generation, position: { seq: page[k - 1].seq, versionId: page[k - 1].versionId } } : null;
        // the checkpoint spends the reserve: clipped to the HARD deadline, stopped only by the hard stop
        if (next) out.cursor = { to: next, prefix: k, page: page.length, cas: await casCursor(cref, observed, next, { ms: Math.max(0, Math.min(cursorOpMs, stop.remaining())), now, isStopped: () => stop.stopped() }) };
      } catch (e) {
        if (e && e.workDeadline) out.retainedStopped = e.message;   // the work deadline passed between operations: nothing more starts
        else out.retainedError = String((e && e.message) || e).slice(0, 160);
      }
    }
    const counts = {};
    for (const x of out.rungs) counts[x.category] = (counts[x.category] || 0) + 1;
    log('identity_record_check', { rid, counts, rungs: out.rungs, retained: out.retained });
    return out;
  }

  // TOTAL BOUND = listing + restaurant-cursor read + run budget + final CAS (each bounded), below the function timeout.
  async function verify({ listIds, runBudgetMs = IDENTITY_RUN_BUDGET_MS, restaurantBudgetMs = IDENTITY_RESTAURANT_BUDGET_MS,
    listDeadlineMs = IDENTITY_LIST_DEADLINE_MS, cursorOpMs = CURSOR_OP_DEADLINE_MS, ...opts } = {}) {
    let ids;
    try { ids = sanitize(await race(Promise.resolve().then(() => listIds()), listDeadlineMs, 'identity_verify_list')).slice().sort(); } catch (e) {
      log('identity_record_check_run', { ok: false, error: String((e && e.message) || e).slice(0, 160) });
      return { ok: false, results: [] };
    }
    const rref = rtdb.ref(VERIFY_RESTAURANT_CURSOR_PATH);
    let observed;
    try { observed = await readCursor(rref, { ms: cursorOpMs }); } catch (_) {
      log('identity_record_check_run', { ok: false, error: 'restaurant_cursor_unreadable' });
      return { ok: false, results: [] };
    }
    const run = makeDeadline(runBudgetMs, now);
    const start = observed.position === null ? 0 : ids.findIndex((x) => x > observed.position);
    const order = start < 0 ? [] : ids.slice(start);
    const results = []; const done = [];
    for (const rid of order) {
      if (run.stopped()) break;
      const budget = Math.min(restaurantBudgetMs, run.remaining());
      const stop = makeDeadline(budget, now);
      results.push(await race(verifyRestaurant(rid, stop, { cursorOpMs, ...opts }), budget + 50, 'verify_restaurant')
        .catch((e) => { stop.forced = true; return { rid, error: String((e && e.message) || e).slice(0, 160) }; }));
      done.push(rid);
    }
    const nextCursor = done.length === order.length ? { generation: observed.generation + 1, position: null }
      : done.length ? { generation: observed.generation, position: done[done.length - 1] } : null;
    const cas = nextCursor ? await casCursor(rref, observed, nextCursor, { ms: cursorOpMs, now }) : null;
    const totals = {};
    for (const r of results) for (const x of r.rungs || []) totals[`${x.rung}:${x.category}`] = (totals[`${x.rung}:${x.category}`] || 0) + 1;
    log('identity_record_check_run', { ok: true, restaurants: ids.length, checked: done.length, totals, cursor: nextCursor, cas });
    return { ok: true, results, checked: done, cursor: nextCursor, cas, totals };
  }

  return { verify, verifyRestaurant, checkRung, readers, stats };
}

module.exports = {
  createIdentityVerifier, loadVersionNode, d4aProjection, classify, CATEGORIES,
  IDENTITY_LOAD_TIMEOUT_MS, IDENTITY_VERIFY_INTERVAL, IDENTITY_VERIFY_TIMEOUT_S,
  VERIFY_VERSION_CURSOR_PATH, VERIFY_RESTAURANT_CURSOR_PATH,
};
