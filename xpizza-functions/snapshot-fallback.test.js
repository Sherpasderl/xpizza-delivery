'use strict';
// Phase 1d Stage 2b — the snapshotFor fallback ladder. Run: node snapshot-fallback.test.js
//
// In Stage 2c this code prices orders during a Firestore outage. The property under test throughout is
// that it NEVER serves a price it cannot vouch for: every path ends in tables of known provenance or
// a throw.
const assert = require('assert');
const { createSnapshotFallback, makeRtdbMirrorReader, DEFAULT_K } = require('./catalog/snapshot-fallback');
const { makeRtdbMirror } = require('./catalog/mirror-rtdb');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const M = (seq, over = {}) => ({ version: `v-${seq}`, seq, rid: 'x_pizza', menu: { A: 10 }, extras: { E: 2 }, at: 1, ...over });
const mk = (mirrorReader, opts = {}) => { const alarms = []; return { alarms, f: createSnapshotFallback({ mirrorReader, alarm: (k, d) => alarms.push([k, d]), ...opts }) }; };

(async () => {
  // ── RUNG 1: in-memory last-good, with NO RTDB read at all ─────────────────────────────────────
  {
    let reads = 0;
    const { f } = mk(async () => { reads++; return M(1); });
    f.recordGood('x_pizza', { versionId: 'v-9', seq: 9, menu: { A: 99 }, extras: { E: 9 } });
    const r = await f.snapshotFor('x_pizza');
    assert.strictEqual(r.source, 'last_good');
    assert.deepStrictEqual([r.menu, r.extras, r.seq], [{ A: 99 }, { E: 9 }, 9]);
    assert.strictEqual(reads, 0, 'rung 1 must do NO I/O — it is the warm-instance common case');
    ok('rung 1: in-memory last-good served with zero RTDB reads');
  }

  // ── RUNG 2: cold instance, mirror version-checked against the known active ordinal ─────────────
  for (const [activeSeq, mirrorSeq, expect] of [[5, 5, 'mirror'], [5, 4, 'mirror'], [5, 3, null], [5, 1, null]]) {
    const { f, alarms } = mk(async () => M(mirrorSeq));
    f.recordActive('x_pizza', `v-${activeSeq}`, activeSeq);
    if (expect) {
      const r = await f.snapshotFor('x_pizza');
      assert.strictEqual(r.source, 'mirror', `active=${activeSeq} mirror=${mirrorSeq} must serve`);
      assert.strictEqual(r.seq, mirrorSeq);
    } else {
      await assert.rejects(() => f.snapshotFor('x_pizza'), /snapshot_fallback_unavailable/, `active=${activeSeq} mirror=${mirrorSeq} must FAIL CLOSED`);
      assert.strictEqual(alarms[0][0], 'catalog_mirror_too_stale');
      assert.strictEqual(alarms[0][1].distance, activeSeq - mirrorSeq);
    }
  }
  ok(`rung 2: mirror served at distance 0 and ${DEFAULT_K} (K=${DEFAULT_K}); FAIL CLOSED at 2 and 4, with catalog_mirror_too_stale`);

  // ── ABSENT seq is fail-closed, NEVER distance-zero ─────────────────────────────────────────────
  for (const [label, bad] of [['no seq field', { version: 'v', rid: 'x_pizza', menu: { A: 1 }, extras: {} }],
                              ['seq null', M(1, { seq: null })], ['seq string', M(1, { seq: '1' })],
                              ['seq float', M(1, { seq: 1.5 })], ['seq undefined', M(1, { seq: undefined })]]) {
    const { f, alarms } = mk(async () => bad);
    f.recordActive('x_pizza', 'v-1', 1);
    await assert.rejects(() => f.snapshotFor('x_pizza'), /snapshot_fallback_unavailable/, `${label} must FAIL CLOSED`);
    assert.ok(alarms.some((a) => a[0] === 'catalog_mirror_unusable'), `${label} alarms unusable`);
  }
  ok('absent/malformed seq → FAIL CLOSED (never distance-zero — a pre-ordinal mirror must not read as fresh)');
  {
    // The specific trap: a mirror with NO seq while the active ordinal IS known. Distance-zero would
    // have served the stalest possible mirror as if it were current.
    const { f } = mk(async () => ({ version: 'v-old', rid: 'x_pizza', menu: { A: 1 }, extras: {} }));
    f.recordActive('x_pizza', 'v-50', 50);
    await assert.rejects(() => f.snapshotFor('x_pizza'), /snapshot_fallback_unavailable/);
    ok('the trap explicitly: seq-less mirror + known active seq 50 → refused, not treated as distance 0');
  }

  // ── COLD + Firestore never reachable: the mirror is the bounded disaster fallback, alarmed ─────
  {
    const { f, alarms } = mk(async () => M(3));
    const r = await f.snapshotFor('x_pizza');              // no recordActive → truly cold
    assert.strictEqual(r.source, 'mirror_cold');
    assert.deepStrictEqual([r.seq, r.menu], [3, { A: 10 }]);
    assert.strictEqual(alarms[0][0], 'catalog_served_from_mirror_cold', 'the one rung that serves without a second opinion must say so loudly');
    assert.strictEqual(alarms[0][1].seq, 3);
    ok('cold + no known active: mirror served as the bounded disaster fallback + catalog_served_from_mirror_cold');
  }

  // ── RUNG 3: fail closed on every remaining shape ───────────────────────────────────────────────
  for (const [label, reader] of [['mirror absent', async () => null], ['mirror undefined', async () => undefined],
                                 ['RTDB unreachable', async () => { throw new Error('rtdb down'); }],
                                 ['no reader injected', undefined]]) {
    const { f, alarms } = mk(reader);
    await assert.rejects(() => f.snapshotFor('x_pizza'), /snapshot_fallback_unavailable/, `${label} must FAIL CLOSED`);
    assert.strictEqual(alarms[alarms.length - 1][0], 'snapshot_fallback_unavailable');
  }
  ok('rung 3: mirror absent / unreachable / no reader → throws snapshot_fallback_unavailable (2c turns this into an order reject)');
  {
    // Bounded: a hung RTDB must not hang an order.
    const { f, alarms } = mk(() => new Promise(() => {}), { deadlineMs: 30 });
    const t0 = Date.now();
    await assert.rejects(() => f.snapshotFor('x_pizza'), /snapshot_fallback_unavailable/);
    assert.ok(Date.now() - t0 < 2000, `must time out, not hang (took ${Date.now() - t0}ms)`);
    assert.ok(alarms.some((a) => a[0] === 'catalog_mirror_read_failed'));
    ok('bounded: a hung mirror read times out and fails closed rather than hanging the order');
  }

  // ── 🔒 REAL-PROJECTION reader test: feed what makeRtdbMirror ACTUALLY writes into the reader ───
  //    A hand-built fake would miss a wrong projection — the exact class of bug that has now bitten
  //    the mirror WRITE and the backfill in this program.
  {
    const written = [];
    const fakeRtdb = { ref: (path) => ({ set: async (v) => { written.push({ path, value: v }); }, get: async () => ({ val: () => (written.find((w) => w.path === path) || {}).value || null }) }) };
    await makeRtdbMirror(fakeRtdb)('x_pizza', { version: 'v-real', seq: 4, rid: 'x_pizza', menu: { Margherita: 299 }, extras: { Mozzarella: 50 } });
    const reader = makeRtdbMirrorReader(fakeRtdb);
    const payload = await reader('x_pizza');
    assert.strictEqual(payload.seq, 4, 'the reader must see the ordinal the WRITER actually wrote');
    const { f } = mk(reader);
    f.recordActive('x_pizza', 'v-real', 5);                       // distance 1 → within K
    const r = await f.snapshotFor('x_pizza');
    assert.strictEqual(r.source, 'mirror');
    assert.deepStrictEqual([r.menu, r.extras, r.seq, r.versionId], [{ Margherita: 299 }, { Mozzarella: 50 }, 4, 'v-real'],
      'the ladder reads a REAL written payload end-to-end, not a hand-built stand-in');
    ok('REAL PROJECTION: makeRtdbMirror → RTDB → makeRtdbMirrorReader → ladder, end-to-end on the real shape');
  }

  // ── recordActive / recordGood semantics ────────────────────────────────────────────────────────
  {
    const { f } = mk(async () => M(1));
    f.recordActive('x_pizza', 'v-1', 'not-an-int');
    assert.strictEqual(f.state.lastKnownActive.has('x_pizza'), false, 'a non-integer ordinal is not recorded');
    f.recordGood('x_pizza', { versionId: 'v-2', seq: 2, menu: null, extras: {} });
    assert.strictEqual(f.state.lastGood.has('x_pizza'), false, 'an incomplete serve is not recorded as last-good');
    f.recordGood('x_pizza', { versionId: 'v-2', seq: 2, menu: { A: 1 }, extras: {} });
    assert.strictEqual(f.state.lastKnownActive.get('x_pizza').seq, 2, 'a good serve also teaches the active ordinal');
    ok('recorders: reject a non-integer ordinal and an incomplete serve; a good serve also teaches the ordinal');
  }
  console.log(`snapshot-fallback: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
