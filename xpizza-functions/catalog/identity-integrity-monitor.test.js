'use strict';
// 1D D4-c2b — the MONITOR's read pipeline and run phases on FAKE Firestore / RTDB handles (no emulator). Codex build r1:
//   P1-1  the §5 pair budgets are enforced WHILE READING: past them, reading stops and nothing more is retained (no registry read);
//         within them, the registry is judged batch by batch and its rows released — the verdict EQUALS the all-rows judgement
//   P2-6  a malformed stamp ('bad/id') never becomes a registry path: classified registry_disagrees, never a thrown check
//   P1-2  ONE run deadline: a STALLED enumeration record and stalled commits are abandoned at their phase deadlines; every read is
//         counted (readCap 0 → ZERO reads); the summaries' reads are reserved up front (restaurant work cannot consume them)
// Run: node catalog/identity-integrity-monitor.test.js
const assert = require('assert');
const { FieldPath } = require('firebase-admin/firestore');
const M = require('./identity-integrity-monitor');
const C = require('./identity-integrity');
const { readSetOf } = require('./catalog-verifier');
const { activationDocId, G20 } = require('./identity-evidence');
const { H } = require('./evidence-encoding');

let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('identity-integrity-monitor FAILED: exited without completing (a promise never settled)'); process.exitCode = 1; } });
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ID = FieldPath.documentId();
const READ = { seconds: 1_800_000_000, nanoseconds: 0, toMillis: () => 1_800_000_000_000 };

/* a FAKE Firestore over a { path: data } map — only what observeActive uses: runTransaction(fn, opts); collection/doc/doc(path);
   tx.get(doc | query | count query), tx.getAll(...refs, { fieldMask }); where(field|ID, op, v) / orderBy / limit / select / startAfter / count */
function fakeFirestore(store, calls) {
  const snap = (path) => ({ exists: Object.prototype.hasOwnProperty.call(store, path), id: path.split('/').pop(), data: () => store[path], readTime: READ, updateTime: READ });
  const docRef = (path) => ({ path, id: path.split('/').pop(), collection: (c) => colRef(`${path}/${c}`) });
  const query = (col, q) => ({
    where: (f, op, v) => query(col, { ...q, where: [...(q.where || []), [f, op, v]] }),
    orderBy: () => query(col, q), limit: (k) => query(col, { ...q, limit: k }), select: () => query(col, q),
    startAfter: (id) => query(col, { ...q, after: id }), count: () => ({ ...query(col, q), isCount: true }),
    _run() {
      let ids = Object.keys(store).filter((p) => p.startsWith(`${col}/`) && !p.slice(col.length + 1).includes('/')).map((p) => p.slice(col.length + 1)).sort();
      for (const [f, op, v] of q.where || []) {
        const val = (id) => (f === ID ? id : (store[`${col}/${id}`] || {})[f]);
        ids = ids.filter((id) => (op === '==' ? val(id) === v : op === '>=' ? val(id) >= v : val(id) < v));
      }
      if (q.after) ids = ids.filter((id) => id > q.after);
      if (q.limit) ids = ids.slice(0, q.limit);
      return ids.map((id) => snap(`${col}/${id}`));
    },
    _isQuery: true,
  });
  const colRef = (path) => ({ path, doc: (d) => docRef(`${path}/${d}`), ...query(path, {}) });
  return {
    collection: (c) => colRef(c), doc: (p) => {
      if (typeof p !== 'string' || p.split('/').length % 2 !== 0 || p.split('/').some((x) => !x)) throw new Error(`fake doc(): invalid document path ${p}`);
      return docRef(p);
    },
    runTransaction: async (fn, opts) => {
      calls.tx.push(opts);
      return fn({
        get: async (r) => {
          if (r && r._isQuery) { const docs = r._run(); calls.reads += r.isCount ? 1 : docs.length; return r.isCount ? { data: () => ({ count: docs.length }) } : { docs, readTime: READ }; }
          calls.reads += 1; return snap(r.path);
        },
        getAll: async (...args) => {
          const refs = args.filter((a) => a && a.path);
          calls.getAll.push(refs.map((r) => r.path)); calls.reads += refs.length; return refs.map((r) => snap(r.path));
        },
      });
    },
  };
}

// a certified-looking 400-object restaurant: pointer → version v (generation 3); objects with keys of `keyBytes`
function restaurant({ rid = 'r', objects = 400, keyBytes = 8, badStamp = false, registry = true } = {}) {
  const store = {}; const root = `restaurants/${rid}`;
  store[`${root}/meta/active_version`] = { version: 'v', generation: 3 };
  store[`${root}/versions/v`] = { identity_certified: true };
  store[`${root}/identity_evidence/${activationDocId(3)}`] = { v: 1, intent: 'publish', certified: false, vid: H('v'), generation: 3 };
  const pairs = [];
  for (let i = 0; i < objects; i += 1) {
    const kind = i % 4 === 3 ? 'extra' : 'dish'; const sub = kind === 'dish' ? 'menu_items' : 'extras';
    const key = `${String(i).padStart(4, '0')}${'k'.repeat(Math.max(0, keyBytes - 4))}`;
    const id = badStamp && i === 5 ? 'bad/id' : `id${i}`;
    store[`${root}/versions/v/${sub}/d${String(i).padStart(4, '0')}`] = { key, display: { identity_id: id } };
    pairs.push({ kind, key, id });
  }
  if (registry) {
    for (const [i, p] of pairs.entries()) {
      if (p.id === 'bad/id') continue;
      const [idP, , keyP] = [`${root}/identity/${p.kind}/ids/${p.id}`, null, readSetOf(rid, [{ kind: p.kind, canonicalId: p.id, legacyKey: p.key }]).find((x) => x.includes('/keys/'))];
      store[idP] = { legacy_key: p.key, status: 'live', kind: p.kind };
      if (i % 50 !== 7) store[keyP] = { canonical_id: i % 50 === 9 ? 'someone_else' : p.id, kind: p.kind };   // a missing key row (degraded) + a disagreeing one
    }
  }
  return { store, pairs };
}
const freeBudget = () => M.createReadBudget({ cap: 1e9, perSecond: 1e9, now: () => 0, sleep: async () => {} });
// a hang is a FAILURE, never a stalled suite (a mutant that drops a deadline must fail fast)
const within = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: did not settle within ${ms} ms (a deadline was not enforced)`)), ms))]);
setTimeout(() => { console.error('identity-integrity-monitor FAILED: the suite did not finish within 60 s'); process.exit(1); }, 60000).unref();

(async () => {
  // ── 1. P1-1: past the pair budget, reading STOPS — nothing beyond it retained, the registry never read ────────────────
  {
    const { store } = restaurant({ keyBytes: 20000 });   // 400 × ~20 KB keys ≈ 8 MB raw ≫ the 4 MiB raw budget
    const calls = { tx: [], getAll: [], reads: 0 };
    const obs = await M.observeActive(fakeFirestore(store, calls), 'r', freeBudget());
    assert.strictEqual(obs.objects.oversized_values, true, 'the budget stopped the read');
    assert.deepStrictEqual([obs.objects.pairs.length, obs.objects.unstamped.length, obs.rows, obs.registry], [0, 0, undefined, undefined], 'NOTHING retained past the budget; no registry state');
    const registryReads = calls.getAll.filter((ps) => ps.some((p) => p.includes('/identity/'))).length;
    assert.strictEqual(registryReads, 0, 'the registry is NEVER read once the budget is exceeded');
    const objectReads = calls.reads - 1 - 2 - 0 - 2;   // pointer, record + activation, counts
    assert.ok(objectReads < 400 * 0.75, `reading stopped early (${objectReads} object docs of 400 read)`);
    const r = C.classifyActive(obs, { G0: 1 });
    assert.deepStrictEqual([r.state, r.reason, r.coverage, r.findings], ['unavailable', 'oversized_values', false, []], 'unavailable{oversized_values} — never a violation');
    ok(`P1-1: 400 objects × ~20 KB keys — the pair budget stops the read at the first pair past it (${objectReads} object docs read, 0 retained), the registry is never read, → unavailable{oversized_values}`);
  }

  // ── 2. P1-1: within the budget, the registry is judged PER BATCH and released; the verdict EQUALS the all-rows judgement ──
  {
    const { store } = restaurant({ keyBytes: 8 });
    const calls = { tx: [], getAll: [], reads: 0 };
    const obs = await M.observeActive(fakeFirestore(store, calls), 'r', freeBudget());
    assert.strictEqual(obs.rows, undefined, 'no registry rows retained');
    assert.ok(obs.registry && Array.isArray(obs.registry.degraded) && Array.isArray(obs.registry.disagree), 'only the verdicts are kept');
    const regBatches = calls.getAll.filter((ps) => ps.some((p) => p.includes('/identity/')));
    assert.ok(regBatches.length > 0 && regBatches.every((ps) => ps.length <= M.REGISTRY_BATCH), `every registry getAll ≤ ${M.REGISTRY_BATCH} masked docs`);
    // the SAME verdict as judging every pair against ALL rows (the pre-fix path)
    const allRows = {}; for (const p of readSetOf('r', obs.objects.pairs.map((x) => ({ kind: x.kind, canonicalId: x.id, legacyKey: x.key })))) if (store[p]) allRows[p] = store[p];
    const viaAll = C.judgeRegistry({ ...obs, rows: allRows });
    const viaBatches = C.registryFindings(3, obs.registry);
    assert.deepStrictEqual(viaBatches, viaAll, 'batch-by-batch verdict === the all-rows verdict');
    assert.ok(viaAll.degradedPairs.length === 8 && viaAll.findings[0].kind === 'registry_disagrees' && viaAll.findings[0].detail.pairs === 8, 'premise: the fixture has degraded and disagreeing pairs');
    ok(`P1-1: within the budget the registry is read in ${regBatches.length} masked getAll batches of ≤ ${M.REGISTRY_BATCH}, judged and released — the verdict equals the all-rows judgement (8 degraded, 8 disagreeing)`);
  }

  // ── 3. P2-6: a malformed stamp never becomes a path; it is a registry_disagrees violation, not a thrown check ──────────
  {
    const { store } = restaurant({ keyBytes: 8, badStamp: true });
    const calls = { tx: [], getAll: [], reads: 0 };
    const obs = await M.observeActive(fakeFirestore(store, calls), 'r', freeBudget());   // the fake doc() THROWS on 'bad/id' paths, as Firestore does
    assert.ok(calls.getAll.flat().every((p) => !p.includes('bad/id') && !p.includes('/ids/bad')), 'no registry path built from the malformed stamp');
    const reg = C.registryFindings(3, obs.registry);
    const f = reg.findings.find((x) => x.kind === 'registry_disagrees');
    assert.ok(f && f.class === 'violation' && f.detail.invalid_stamps === 1, `registry_disagrees with invalid_stamps 1: ${JSON.stringify(f && f.detail)}`);
    const key = (n) => 'k'.repeat(n);
    assert.deepStrictEqual([C.addressable({ id: 'bad/id', key: 'a' }), C.addressable({ id: '__x__', key: 'a' }), C.addressable({ id: 'dimsum_01', key: 'a' })], [false, false, true]);
    assert.deepStrictEqual([C.addressable({ id: 'x', key: key(1125) }), C.addressable({ id: 'x', key: key(1126) })], [true, false], 'a legacy key > 1,125 bytes has no valid key-row id (base64url > 1,500 bytes)');
    ok('P2-6: a stamp "bad/id" is never turned into a registry path (doc() would reject it or address another document) — the check completes and classifies it registry_disagrees (violation, invalid_stamps 1)');
  }

  // ── 4. P1-2: readCap 0 → ZERO reads (not even the enumeration) ─────────────────────────────────────────────────────
  const fakeRtdb = ({ stallTx = false } = {}, calls) => {
    const ref = (p) => ({ path: p, child: (k) => ref(`${p}/${k}`),
      get: async () => { calls.rtdbGets += 1; return { val: () => null }; },
      transaction: (fn) => { calls.rtdbTx += 1; if (stallTx) return new Promise(() => {}); return Promise.resolve({ committed: true, snapshot: { val: () => fn(null) } }); } });
    return { ref };
  };
  {
    const calls = { rtdbGets: 0, rtdbTx: 0, list: 0, db: 0 };
    const db = { runTransaction: async () => { calls.db += 1; throw new Error('unused'); }, collection: () => { calls.db += 1; throw new Error('unused'); } };
    const m = M.createIdentityIntegrityMonitor({ db, rtdb: fakeRtdb({}, calls), log: () => {} });
    const out = await m.run({ listIds: async () => { calls.list += 1; return ['rid_a', 'rid_b']; }, readCap: 0 });
    assert.deepStrictEqual([out.ok, out.reads, calls.list, calls.rtdbGets, calls.rtdbTx, calls.db], [false, 0, 0, 0, 0, 0], `readCap 0 → zero reads: ${JSON.stringify(calls)}`);
    ok('P1-2: readCap 0 → ZERO reads — the enumeration itself is reserved before it is issued (no listing, no RTDB get, no transaction, no Firestore call)');
  }

  // ── 5. P1-2: the summaries' reads are reserved UP FRONT — a cap that only covers enumeration + summaries does no restaurant work ──
  {
    const calls = { rtdbGets: 0, rtdbTx: 0, list: 0, db: 0 };
    const db = { runTransaction: async () => { calls.db += 1; throw new Error('down'); }, collection: () => ({ doc: () => ({ collection: () => ({}) }) }) };
    const lines = [];
    const m = M.createIdentityIntegrityMonitor({ db, rtdb: fakeRtdb({}, calls), log: (k) => lines.push(k) });
    const ids = ['rid_a', 'rid_b', 'rid_c'];
    const out = await m.run({ listIds: async () => ids, readCap: ids.length + 2 * ids.length });   // enumeration (N) + summaries (2N), nothing else
    assert.deepStrictEqual([out.ok, out.results.length, out.lines.length, calls.rtdbGets, calls.rtdbTx, calls.db], [true, 0, 3, 6, 0, 0],
      `only the reserved summary reads happen: ${JSON.stringify(calls)}`);
    assert.ok(!lines.includes('identity_integrity_heartbeat'), 'no heartbeat (the run could not enumerate coverage)');
    assert.ok(out.reads <= ids.length + 2 * ids.length, 'every read within the cap');
    ok('P1-2: the summaries\' 2 reads per restaurant are RESERVED UP FRONT — with a cap covering only enumeration + summaries, no view / record / check runs, the 3 summary lines are still read (6 gets), no heartbeat');
  }

  // ── 6. P1-2: a STALLED first-enumeration record (and stalled commits) cannot hold the run: abandoned at the phase deadline ──
  {
    const calls = { rtdbGets: 0, rtdbTx: 0, list: 0, db: 0 };
    const db = { runTransaction: async () => { calls.db += 1; throw new Error('down'); }, collection: () => ({ doc: () => ({ collection: () => ({}) }) }) };
    const m = M.createIdentityIntegrityMonitor({ db, rtdb: fakeRtdb({ stallTx: true }, calls), log: () => {} });
    const t0 = Date.now();
    const out = await within(m.run({ listIds: async () => ['rid_a', 'rid_b'], runBudgetMs: 600, restaurantMs: 200, summaryReserveMs: 400, readOpMs: 50 }), 8000, 'stalled-transaction run');
    const ms = Date.now() - t0;
    assert.ok(out.ok && out.lines.length === 2, 'the run completed and emitted EVERY summary line');
    assert.ok(calls.rtdbTx >= 2, `premise: the enumeration records were issued and stalled (${calls.rtdbTx} transactions pending forever)`);
    assert.ok(ms < 600 + 400 + 2 * 1200, `bounded by the ONE run deadline (+ the per-check race margin): ${ms} ms`);
    // EVERY read accounted: enumeration 1 + (N−1), summaries 2N reserved up front, views 2N, first-enumeration records N, and per
    // check its commit (1) + its precheck (3). The first check's stalled commit spends the work budget, so the second is not reached:
    // N = 2 → 2 + 4 + 4 + 2 + (1 + 3) = 16
    assert.deepStrictEqual(out.results.map((r) => r.outcome).sort(), ['failed', 'not_reached'], JSON.stringify(out.results));
    assert.strictEqual(out.reads, 16, `the run's read accounting (${out.reads})`);
    ok(`P1-2: every RTDB transaction STALLS forever — the first-enumeration records are abandoned at the work deadline, each check's commit at its restaurant deadline, and the run still emits both summary lines within its deadline (${ms} ms)`);
  }

  // ── 7. P1-2: the SUMMARY phase has its own deadline inside the run: stalled gets cannot stretch it past the reserve ──────────
  {
    const calls = { rtdbGets: 0, rtdbTx: 0 };
    const ref = (p) => ({ path: p, child: (k) => ref(`${p}/${k}`), get: () => { calls.rtdbGets += 1; return new Promise(() => {}); }, transaction: () => { calls.rtdbTx += 1; return new Promise(() => {}); } });
    const db = { runTransaction: async () => { throw new Error('down'); }, collection: () => ({ doc: () => ({ collection: () => ({}) }) }) };
    const m = M.createIdentityIntegrityMonitor({ db, rtdb: { ref }, log: () => {} });
    const ids = ['rid_a', 'rid_b', 'rid_c', 'rid_d', 'rid_e', 'rid_f'];
    const t0 = Date.now();
    const out = await within(m.run({ listIds: async () => ids, runBudgetMs: 100, summaryReserveMs: 150, readOpMs: 100, restaurantMs: 50 }), 8000, 'stalled-get run');
    const ms = Date.now() - t0;
    assert.ok(out.ok && out.lines.length === ids.length && out.lines.every((l) => l.stale === 1), 'a line for EVERY restaurant (unreadable → stale)');
    assert.ok(ms < 450, `the summaries stopped at their reserve, not after ${ids.length} sequential timeouts (${ms} ms; unbounded ≥ ${ids.length * 100} ms)`);
    ok(`P1-2: every RTDB get STALLS — the views end at the work deadline and the summaries at their own reserve inside the run (${ms} ms for ${ids.length} restaurants, all lines emitted stale), never one timeout per restaurant`);
  }

  FINISHED = true;
  console.log(`identity-integrity-monitor: OK (${n})`);
})().catch((e) => { console.error('identity-integrity-monitor FAILED:', e); process.exit(1); });
