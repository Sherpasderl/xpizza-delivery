'use strict';
// Portal 1D · D4-c1 — the PURE identity-record core (catalog/identity-record.js) + the writer's transaction plumbing.
// PLAN-D4c1 rev 7 §2/§3a/§3b/§4/§5 and codex c1 r7 S1 (the revision-9 head). Expected values come from the plan and
// the catalog snapshot (D4-a's own fixture recipe), never from the code under test.
const assert = require('assert');
const crypto = require('crypto');
const R = require('./identity-record');
const { createIdentityRecordWriter, casCursor, readCursor, CURSOR_OP_DEADLINE_MS } = require('./identity-record-writer');
const { createIdentityVerifier } = require('./identity-record-verifier');
const { buildContext } = require('./catalog-context');
const { contentHash } = require('./content-hash');
const { catalogSnapshot } = require('./generate-form-bundle');
const { canonicalJson } = require('./canonical-json');
const { compareCK } = require('./context-fk');

let n = 0; let lastCell = '(none)';
const ok = (l) => { console.log(`  ✓ ${++n} ${l}`); lastCell = `${n} ${l.slice(0, 80)}`; };
let __finished = false;
// Every case ENDS. An await of code under test that could stall goes through within(): past its deadline the case
// FAILS (named) instead of hanging; its timer is cleared on settle, so it never holds the process open. The suite
// watchdog backstops anything not wrapped and names the last completed cell. At the end no timer may remain active,
// so a passing run exits on its own (no process.exit on success).
const within = (p, ms, label) => {
  let t = null;
  return Promise.race([Promise.resolve(p), new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`🔴 test deadline: ${label} did not settle within ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(t));
};
const SUITE_DEADLINE_MS = 60000;
const watchdog = setTimeout(() => { console.error(`🔴 identity-record: HUNG — not finished within ${SUITE_DEADLINE_MS} ms; last completed cell: ${lastCell}`); process.exit(1); }, SUITE_DEADLINE_MS);
process.on('exit', (code) => { if (code === 0 && !__finished) { console.error('🔴 identity-record: exited before finishing'); process.exit(1); } });
const clone = (x) => JSON.parse(JSON.stringify(x));
const WHERE = { rid: 'x_pizza', versionId: 'v-test' };

// D4-a's raw-payload recipe (catalog-context.test.js): a version as Firestore holds it, content_hash pinned.
function rawFor(rid, { certified, revision, stamp = null, seq = 7, versionId = 'v-test', dropExtras = false, asRid = rid, t = { seconds: 1700000000, nanoseconds: 5 } } = {}) {
  const snap = clone(catalogSnapshot(rid));
  if (dropExtras) { snap.extras = []; snap.structure.extra_order = []; }
  if (stamp) {
    snap.items.forEach((it, i) => { const id = stamp('dish', it, i); if (id !== undefined) it.display.identity_id = id; });
    snap.extras.forEach((ex, i) => { const id = stamp('extra', ex, i); if (id !== undefined) ex.display.identity_id = id; });
  }
  const order = (recs, ord) => ord.map((k) => recs.find((r) => r.key === k));
  const hash = contentHash({ rid: asRid, schema_version: 2, items: order(snap.items, snap.structure.item_order), extras: order(snap.extras, snap.structure.extra_order || []), structure: snap.structure });
  const docs = (recs) => recs.map((r, i) => ({ id: `d${String(i).padStart(3, '0')}`, data: { key: r.key, price: r.price, display: r.display } }));
  const record = { version: versionId, seq, schema_version: 2, content_hash: hash };
  if (certified !== undefined) record.identity_certified = certified;
  if (revision !== undefined) record.identity_revision = revision;
  return { rid: asRid, versionId, record, updateTime: t, items: docs(snap.items), extras: docs(snap.extras), structure: snap.structure };
}
const allStamped = (kind, rec, i) => `${kind === 'dish' ? 'D' : 'E'}${String(i).padStart(9, '0')}`;
const otherStamps = (kind, rec, i) => `${kind === 'dish' ? 'Q' : 'R'}${String(i).padStart(9, '0')}`;
const cand = (raw) => { const b = R.buildIdentityRecord(raw); assert.ok(b.ok, b.reason); return { digest: b.digest, record: b.record, ck: b.ck, built: b }; };
const ck = (revision, seconds, nanoseconds = 0) => ({ revision, updateTime: { seconds, nanoseconds } });
const apply = (cur, c) => R.applyCandidate(cur, c, WHERE);
// commit through apply: returns the next node (or the same when nothing is written)
const step = (cur, c) => { const r = apply(cur, c); return { node: r.write ? r.next : cur, r }; };
const tablesOf = (rid) => { const s = catalogSnapshot(rid); return { menu: Object.fromEntries(s.items.map((i) => [i.key, i.price])), extras: Object.fromEntries(s.extras.map((e) => [e.key, e.price])) }; };

(async () => {
  // ── §2 THE RECORD ────────────────────────────────────────────────────────────────────────────────────
  {
    const raw = rawFor('x_pizza', { certified: true, revision: 1, stamp: allStamped });
    const b = R.buildIdentityRecord(raw);
    assert.ok(b.ok);
    assert.deepStrictEqual(Object.keys(b.record).sort(), ['canonical', 'certified', 'content_hash', 'digest', 'identityRevision', 'rid', 'seq', 'v', 'versionId']);
    assert.deepStrictEqual([b.record.v, b.record.rid, b.record.versionId, b.record.seq, b.record.identityRevision, b.record.certified], [1, 'x_pizza', 'v-test', 7, 1, true]);
    // the canonical string IS D4-a's persisted payload
    const { persistedNode, recordSubset } = require('./context-writer');
    assert.strictEqual(b.record.canonical, persistedNode({ ...raw, fk: null }).payload);
    assert.deepStrictEqual(JSON.parse(b.record.canonical).record, recordSubset(raw.record), 'only the D4-a record-field allowlist enters');
    // the digest preimage is EXACTLY the plan's eight fields (independent recomputation)
    const pre = canonicalJson({ v: 1, rid: 'x_pizza', versionId: 'v-test', identityRevision: 1, certified: true, content_hash: raw.record.content_hash, seq: 7, canonical: b.record.canonical });
    assert.strictEqual(b.digest, crypto.createHash('sha256').update(pre, 'utf8').digest('hex'));
    // sensitivity: each preimage field moves the digest; activation metadata / timestamps never enter
    for (const f of ['rid', 'versionId', 'identityRevision', 'certified', 'content_hash', 'seq', 'canonical', 'v']) {
      const r2 = { ...b.record, [f]: f === 'certified' ? false : (typeof b.record[f] === 'number' ? b.record[f] + 1 : `${b.record[f]}x`) };
      assert.notStrictEqual(R.digestOf(r2), b.digest, `${f} is in the preimage`);
    }
    assert.strictEqual(R.digestOf({ ...b.record, digest: 'f'.repeat(64) }), b.digest, 'the digest field itself is not in the preimage');
    const withActivation = clone(raw); withActivation.record.identity_activation = { at: 123 }; withActivation.record.activated_at = 99;
    assert.strictEqual(R.buildIdentityRecord(withActivation).digest, b.digest, 'activation metadata never enters (D4-a allowlist)');
    const laterTime = clone(raw); laterTime.updateTime = { seconds: 1800000000, nanoseconds: 0 };
    assert.strictEqual(R.buildIdentityRecord(laterTime).digest, b.digest, 'the update time is the CK, not content');
    // one constructor: same inputs → byte-identical
    assert.strictEqual(canonicalJson(R.buildIdentityRecord(clone(raw)).record), canonicalJson(b.record));
    // certified: absent → false; malformed → refused; other refusals explicit
    assert.strictEqual(R.buildIdentityRecord(rawFor('x_pizza', {})).record.certified, false, 'absent identity_certified → certified:false');
    assert.strictEqual(R.buildIdentityRecord(rawFor('x_pizza', { certified: false })).record.certified, false);
    for (const [mut, reason] of [
      [(r) => { r.record.identity_certified = 'yes'; }, 'certified_malformed'],
      [(r) => { r.record.seq = 'x'; }, 'seq_malformed'],
      [(r) => { delete r.record.content_hash; }, 'no_content_hash'],
      [(r) => { r.updateTime = { seconds: 1, nanoseconds: 1e9 }; }, 'record_time_unrepresentable'],
      [(r) => { r.items[0].data.price += 1; }, 'content_integrity'],
      [(r) => { r.versionId = 'a/b'; }, 'source_malformed'],
    ]) { const r = clone(raw); mut(r); assert.strictEqual(R.buildIdentityRecord(r).reason, reason); }
    assert.strictEqual(R.buildIdentityRecord(raw, { recordBound: 100 }).reason, 'oversize', 'a record above the bound is refused');
  }
  ok('§2 record: exact field set; canonical = D4-a persisted payload over the D4-a allowlist; digest = sha256 over EXACTLY the 8 preimage fields (each moves it; digest/activation/time do not); certified absent→false, malformed→refused; every refusal explicit; one constructor → identical bytes');

  // ── CK: D4-a wire form, malformed never normalized ────────────────────────────────────────────────────
  {
    assert.ok(R.isValidCK(ck(0, 0, 0)) && R.isValidCK(ck(3, 1700000000, 999999999)));
    for (const bad of [null, {}, { revision: 1 }, { revision: -1, updateTime: { seconds: 0, nanoseconds: 0 } }, { revision: 1, updateTime: { seconds: 0, nanoseconds: 1e9 } },
      { revision: 1, updateTime: { seconds: '1', nanoseconds: 0 } }, { revision: 1.5, updateTime: { seconds: 0, nanoseconds: 0 } },
      { revision: 1, updateTime: { seconds: 0, nanoseconds: 0 }, extra: 1 }, { revision: 1, updateTime: { _seconds: 0, _nanoseconds: 0 } }]) {
      assert.ok(!R.isValidCK(bad), JSON.stringify(bad));
    }
    assert.strictEqual(compareCK({ revision: 'x' }, ck(0, 0)), 0, 'premise — compareCK alone would read a malformed CK as the minimum');
  }
  ok('CK: exactly D4-a\'s {revision, updateTime:{seconds, nanoseconds}}; 9 malformed shapes are refused (compareCK alone would silently order them as the minimum)');

  // ── §4 THE ONE VALIDATION SEQUENCE ────────────────────────────────────────────────────────────────────
  {
    const c = cand(rawFor('x_pizza', { certified: true, revision: 1, stamp: allStamped }));
    assert.ok(R.validateRecord(c.digest, c.record, WHERE).ok);
    const cases = [
      ['schema', (r) => { r.extra = 1; }], ['schema_version', (r) => { r.v = 2; }], ['certified_malformed', (r) => { r.certified = 'true'; }],
      ['key_mismatch', (r) => { r.digest = 'a'.repeat(64); }], ['metadata_mismatch', (r) => { r.rid = 'la_musa'; }],
      ['digest_mismatch', (r) => { r.seq = 8; }], ['digest_mismatch', (r) => { r.canonical = r.canonical.replace('"price":', '"price" :'); }],
    ];
    for (const [reason, mut] of cases) { const r = clone(c.record); mut(r); assert.strictEqual(R.validateRecord(c.digest, r, WHERE).reason, reason, reason); }
    // a self-consistent digest over a canonical string that DISAGREES with the metadata → decoded_disagrees
    const lie = clone(c.record); lie.seq = 8; lie.digest = R.digestOf(lie);
    assert.strictEqual(R.validateRecord(lie.digest, lie, WHERE).reason, 'decoded_disagrees', 'metadata vs decoded record');
    const lie2 = clone(c.record); lie2.certified = false; lie2.digest = R.digestOf(lie2);
    assert.strictEqual(R.validateRecord(lie2.digest, lie2, WHERE).reason, 'decoded_disagrees', 'certification vs decoded record');
    const undec = clone(c.record); undec.canonical = '{not json'; undec.digest = R.digestOf(undec);
    assert.strictEqual(R.validateRecord(undec.digest, undec, WHERE).reason, 'decode');
    // order: schema is checked before the digest (a schema-broken record never reaches the hash)
    const both = clone(c.record); both.extra = 1; both.seq = 99;
    assert.strictEqual(R.validateRecord(c.digest, both, WHERE).reason, 'schema');
  }
  ok('§4 one validation sequence: schema → outer key/metadata → recomputed digest → decode → decoded-record agreement — each failure named (incl. a self-consistent digest over disagreeing metadata/certification), checked in that order');

  // ── §3a THE TRANSACTION ───────────────────────────────────────────────────────────────────────────────
  const base = rawFor('x_pizza', { revision: 0, t: { seconds: 100, nanoseconds: 0 } });
  const A = cand(base);                                                                           // rev 0, t100
  const A2 = cand({ ...clone(base), updateTime: { seconds: 200, nanoseconds: 0 } });               // same digest, newer CK
  const B = cand(rawFor('x_pizza', { certified: true, revision: 1, stamp: allStamped, t: { seconds: 150, nanoseconds: 0 } }));   // rev 1
  const Bconf = cand(rawFor('x_pizza', { certified: true, revision: 1, stamp: otherStamps, t: { seconds: 150, nanoseconds: 0 } })); // rev 1, SAME CK as B, different digest
  assert.notStrictEqual(A.digest, B.digest); assert.strictEqual(A.digest, A2.digest); assert.strictEqual(compareCK(B.ck, Bconf.ck), 0);
  {
    let { node, r } = step(null, A);
    assert.deepStrictEqual([r.write, r.outcomes.sort()], [true, ['head_advanced', 'inserted']]);
    assert.deepStrictEqual(node.head, { digest: A.digest, ck: A.ck });
    assert.deepStrictEqual(node.seen, { [A.digest]: A.ck });
    // RTDB retries: the callback is first called with null, then with the stored value — a pure function of (current, cand)
    assert.strictEqual(canonicalJson(apply(null, A).next), canonicalJson(apply(null, A).next));
    // idempotent: same candidate → no write
    const again = apply(node, A);
    assert.deepStrictEqual([again.write, again.outcomes.sort()], [false, ['exists', 'head_unchanged']]);
    // same digest at a NEWER CK (activation metadata only) → exists, seen + head advance
    ({ node, r } = step(node, A2));
    assert.deepStrictEqual(r.outcomes.sort(), ['exists', 'head_advanced']);
    assert.deepStrictEqual([node.head.ck, node.seen[A.digest]], [A2.ck, A2.ck]);
    // a new digest at a greater CK → inserted + head_advanced (revision 0 → 1)
    ({ node, r } = step(node, B));
    assert.deepStrictEqual(r.outcomes.sort(), ['head_advanced', 'inserted']);
    assert.strictEqual(node.head.digest, B.digest);
    // reversed arrival: an OLDER candidate inserts its historical record, never moves head backward
    let rev = step(null, B).node;
    ({ node: rev, r } = step(rev, A));
    assert.deepStrictEqual(r.outcomes.sort(), ['head_unchanged', 'inserted']);
    assert.strictEqual(rev.head.digest, B.digest);
    // EQUAL CK + DIFFERENT digest → ck_conflict, head unchanged; a greater CK recovers
    let cf = step(null, B).node;
    ({ node: cf, r } = step(cf, Bconf));
    assert.ok(r.outcomes.includes('ck_conflict') && r.outcomes.includes('inserted'), r.outcomes);
    assert.strictEqual(cf.head.digest, B.digest);
    const Bfinal = cand(rawFor('x_pizza', { certified: true, revision: 1, stamp: otherStamps, t: { seconds: 151, nanoseconds: 0 } }));
    ({ node: cf, r } = step(cf, Bfinal));
    assert.ok(r.outcomes.includes('head_advanced')); assert.strictEqual(cf.head.digest, Bfinal.digest);
    assert.ok(!apply(cf, Bconf).write, 'a re-delivered conflicting capture is a no-op once settled');
    for (const nd of [node, rev, cf]) assert.deepStrictEqual(R.nodeInvariantProblems(nd, WHERE), []);
  }
  ok('§3a: insert / exists / seen+head advance on a newer CK for the same digest / new digest at a greater CK / reversed arrival (historical insert, head never backward) / equal-CK-different-digest → ck_conflict, recovered by a greater CK; RTDB retry-safe (pure); invariants hold on every result');

  // ── CORRUPT RECORDS: restore ONLY from an exact source; otherwise unrecoverable, never substituted ────────
  {
    let node = step(step(null, A).node, B).node;
    const corruptA = clone(node); corruptA.records[A.digest].canonical += ' ';
    let r = apply(corruptA, A);   // exact matching source
    assert.ok(r.write && r.outcomes.includes('restored'), r.outcomes);
    assert.strictEqual(canonicalJson(r.next.records[A.digest]), canonicalJson(A.record));
    const corruptB = clone(node); corruptB.records[B.digest].seq = 99;
    r = apply(corruptB, A);       // a DIFFERENT digest's source
    assert.ok(r.outcomes.includes('unrecoverable_record') && !r.outcomes.includes('restored'), r.outcomes);
    assert.strictEqual(r.next.records[B.digest].seq, 99, '🔴 never substitute another digest\'s payload');
    assert.ok(r.outcomes.includes('head_invalid'), 'the head named the corrupt record → head_invalid, reconstructed from VALID seen');
    assert.strictEqual(r.next.head.digest, A.digest);
    assert.deepStrictEqual(R.nodeInvariantProblems(r.next, WHERE), []);
    node = r.next;
    r = apply(node, B);   // B arrives again: restores its own record and re-advances
    assert.ok(r.outcomes.includes('restored') && r.outcomes.includes('head_advanced'), r.outcomes);
  }
  ok('corrupt records: restored ONLY from an exact matching source (same digest); a corrupt record of another digest is reported unrecoverable and never substituted; a head naming it → head_invalid, rebuilt from validated seen; its own source later restores it');

  // ── codex r7 S1: a revision-1 record with a structurally VALID revision-9 head ───────────────────────────
  {
    const n1 = step(null, B).node;                                    // revision-1 record, seen = B.ck
    const forged = clone(n1); forged.head = { digest: B.digest, ck: ck(9, 999, 0) };   // shape-valid, revision disagrees
    assert.ok(R.isValidCK(forged.head.ck), 'premise — the forged head CK is structurally valid');
    const r = apply(forged, B);
    assert.ok(r.outcomes.includes('head_invalid'), r.outcomes);
    assert.deepStrictEqual(r.next.head, { digest: B.digest, ck: B.ck }, 'the revision-9 CK is DISCARDED as ordering evidence (head reconstructed from seen)');
    assert.deepStrictEqual(r.next.seen[B.digest], B.ck, 'never promoted into seen');
    const again = apply(r.next, B);
    assert.deepStrictEqual([again.write, again.outcomes.sort()], [false, ['exists', 'head_unchanged']], 'the same invocation again changes nothing (stability)');
    // and a forged head over a NEWER valid candidate: the candidate wins only by its own CK
    const forged2 = clone(forged);
    const r2 = apply(forged2, A);   // A (rev 0) is older than B's real CK
    assert.strictEqual(r2.next.head.digest, B.digest, 'head = greatest VALID seen, not the forged CK');
  }
  // ── codex build r1 B1: inserting / restoring a digest must NOT legitimize the head that named it ─────────────────
  {
    const fabricated = ck(1, 2000000000, 0);   // a future CK nothing ever validated
    const Bc = cand(rawFor('x_pizza', { certified: true, revision: 1, stamp: allStamped, t: { seconds: 1700000000, nanoseconds: 5 } }));
    const Bn = cand(rawFor('x_pizza', { certified: true, revision: 1, stamp: otherStamps, t: { seconds: 1700000100, nanoseconds: 0 } }));   // legit, later, BELOW the fabricated time
    const histA = step(null, A).node;
    for (const [label, mkNode] of [
      ['dangling head (record MISSING) — the candidate inserts that digest', () => { const x = clone(histA); x.head = { digest: Bc.digest, ck: fabricated }; return x; }],
      ['head naming a CORRUPT record — the candidate restores it from the exact source', () => { const x = clone(histA); x.records[Bc.digest] = { ...clone(Bc.record), seq: 99 }; x.seen[Bc.digest] = fabricated; x.head = { digest: Bc.digest, ck: fabricated }; return x; }],
    ]) {
      const r = apply(mkNode(), Bc);
      assert.ok(r.outcomes.includes('head_invalid') && !r.outcomes.includes('head_repaired'), `${label}: ${r.outcomes}`);
      assert.deepStrictEqual(r.next.head, { digest: Bc.digest, ck: Bc.ck }, `${label}: the fabricated CK is discarded; head = the candidate's own CK`);
      assert.deepStrictEqual(r.next.seen[Bc.digest], Bc.ck, `${label}: 🔴 the fabricated CK is NOT promoted into seen`);
      assert.deepStrictEqual(R.nodeInvariantProblems(r.next, WHERE), []);
      assert.strictEqual(apply(r.next, Bc).write, false, `${label}: second invocation is a no-op`);
      const later = apply(r.next, Bn);   // legitimate content BELOW the fabricated time still advances
      assert.ok(later.outcomes.includes('head_advanced') && later.next.head.digest === Bn.digest, `${label}: a later real CK advances head`);
    }
  }
  ok('codex build r1 B1: a head naming a MISSING record (inserted now) or a CORRUPT one (restored now from the exact source) is validated against the PRE-insertion records → head_invalid; its fabricated CK is discarded (head and seen = the candidate\'s own CK); stable; a later legitimate CK below the fabricated time still advances');

  ok('codex r7 S1: a revision-1 record under a structurally valid revision-9 head → head_invalid; the CK is discarded (never promoted into seen), head rebuilt from seen; repeating the same invocation is a no-op');

  // ── seen invariants (i)–(iv) ─────────────────────────────────────────────────────────────────────────
  {
    const n0 = step(step(null, A).node, B).node;
    // (i) revision mismatch → malformed → reset, then raised by the candidate
    let x = clone(n0); x.seen[A.digest] = ck(5, 1, 0);
    let r = apply(x, A);
    assert.ok(r.outcomes.includes('seen_repaired'));
    assert.deepStrictEqual(r.next.seen[A.digest], A.ck);
    // (ii) absent seen → reset to {rev, epoch 0} (no candidate for it)
    x = clone(n0); delete x.seen[A.digest];
    r = apply(x, B);
    assert.ok(r.outcomes.includes('seen_repaired'));
    assert.deepStrictEqual(r.next.seen[A.digest], { revision: 0, updateTime: { seconds: 0, nanoseconds: 0 } });
    // (iii) an orphan seen is deleted in the same transaction; an orphan under the candidate's own digest is not evidence
    x = clone(n0); x.seen['e'.repeat(64)] = ck(0, 5, 0);
    r = apply(x, B);
    assert.ok(!r.next.seen['e'.repeat(64)] && r.outcomes.includes('orphan_seen_removed'));
    const C = cand(rawFor('x_pizza', { certified: true, revision: 1, stamp: otherStamps, t: { seconds: 140, nanoseconds: 0 } }));   // older than B, different content
    assert.notStrictEqual(C.digest, B.digest);
    x = clone(n0); x.seen[C.digest] = ck(1, 9999, 0);   // an orphan claiming a huge CK for C's digest
    r = apply(x, C);
    assert.deepStrictEqual(r.next.seen[C.digest], C.ck, 'an orphan seen under the candidate\'s digest is discarded, not inherited');
    assert.strictEqual(r.next.head.digest, B.digest, '…so it cannot sit above head');
    // (iv) head.ck > seen → seen raised; a valid record's seen > head.ck → head moves to the greatest (ties: greatest digest)
    x = clone(n0); x.seen[B.digest] = ck(1, 120, 0);
    r = apply(x, A);
    assert.ok(r.outcomes.includes('head_repaired')); assert.deepStrictEqual(r.next.seen[B.digest], B.ck);
    x = clone(n0); x.head = { digest: A.digest, ck: A.ck };
    r = apply(x, A);
    assert.ok(r.outcomes.includes('head_repaired')); assert.strictEqual(r.next.head.digest, B.digest);
    for (const res of [r]) assert.deepStrictEqual(R.nodeInvariantProblems(res.next, WHERE), []);
    // (v) stability over the final result
    assert.strictEqual(apply(r.next, A).write, false);
  }
  ok('seen invariants: (i) revision mismatch → reset + raise; (ii) absent → reset to {rev, epoch 0}; (iii) orphans removed (an orphan under the candidate\'s digest is never inherited); (iv) head.ck > seen → seen raised, seen > head → head moves; (v) stable');

  // ── §3b EVICTION + byte cap ──────────────────────────────────────────────────────────────────────────
  {
    let node = null;
    const cs = [];
    for (let i = 0; i < 20; i++) {   // 20 restamps: distinct digests, increasing CKs
      const c = cand(rawFor('x_pizza', { certified: true, revision: 1, stamp: (k, r, j) => `${k === 'dish' ? 'D' : 'E'}${String(i * 1000 + j).padStart(9, '0')}`, t: { seconds: 1000 + i, nanoseconds: 0 } }));
      cs.push(c);
      const r = apply(node, c);
      node = r.write ? r.next : node;
      assert.ok(Object.keys(node.records).length <= R.MAX_RECORDS && Object.keys(node.seen).length <= R.MAX_RECORDS);
      if (i >= 8) assert.ok(r.outcomes.includes('evicted') && r.detail.evicted[0] === cs[i - 8].digest, `the OLDEST seen is evicted (${i})`);
    }
    assert.strictEqual(node.head.digest, cs[19].digest);
    assert.deepStrictEqual(Object.keys(node.records).sort(), cs.slice(12).map((c) => c.digest).sort(), 'the newest 8 remain');
    assert.deepStrictEqual(R.nodeInvariantProblems(node, WHERE), []);
    // an OLD candidate arriving into a full node is inserted then evicted (head protected) — and that is stable
    const r = apply(node, cs[0]);
    assert.ok(!r.write && r.outcomes.includes('evicted'), 'inserting the oldest into a full node changes nothing');
    // the head is protected: whatever old candidates arrive into the full node, the head record is never the victim
    for (const old of cs.slice(0, 12)) { const rr = apply(node, old); assert.ok(!rr.detail.evicted.includes(node.head.digest)); }
    // node byte cap: nothing is written above it
    const capped = R.applyCandidate(null, cs[0], WHERE, { nodeCap: 1000 });
    assert.deepStrictEqual([capped.write, capped.outcomes.includes('oversize')], [false, true]);
  }
  // TIES (equal CKs — ck_conflict captures): the head is never the eviction victim, and a reconstructed head takes the
  // lexicographically GREATEST digest among equal seen CKs
  {
    const same = [];
    for (let i = 0; i < 9; i++) same.push(cand(rawFor('x_pizza', { certified: true, revision: 1, stamp: (k, r, j) => `${k === 'dish' ? 'T' : 'U'}${String(i * 100 + j).padStart(9, '0')}`, t: { seconds: 777, nanoseconds: 0 } })));
    same.sort((a, b) => (a.digest < b.digest ? -1 : 1));
    let node = null;
    for (const c of same) { const r = apply(node, c); node = r.write ? r.next : node; }
    assert.strictEqual(node.head.digest, same[0].digest, 'premise — the first arrival (the SMALLEST digest) holds head; the rest were ck_conflicts');
    assert.ok(node.records[same[0].digest], '🔴 the head survives eviction even when its digest sorts first among equal CKs');
    assert.ok(!node.records[same[1].digest], 'the smallest NON-head digest is the victim');
    // reconstruction among equal CKs → the greatest digest
    const broken = clone(node); broken.head = { digest: 'f'.repeat(64), ck: ck(1, 777, 0) };
    const rr = apply(broken, same[0]);
    const greatest = Object.keys(broken.records).sort().pop();
    assert.ok(rr.outcomes.includes('head_invalid'));
    assert.strictEqual(rr.next.head.digest, greatest, 'ties: the lexicographically GREATEST digest');
    assert.deepStrictEqual(R.nodeInvariantProblems(rr.next, WHERE), []);
  }
  ok('§3b: 20 repeated restamps stay bounded at 8 records / 8 seen; each 9th drops the non-head record with the OLDEST seen (and its seen) in the same result; head protected; an old candidate into a full node is stable; above the node cap nothing is written (oversize)');

  // ── FUZZ: random arrivals + random corruption → invariants (i)–(iv) after EVERY step, and stability ───────
  {
    let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pool = [];
    for (let i = 0; i < 12; i++) {
      const rev = Math.floor(rnd() * 3);
      pool.push(cand(rawFor('x_pizza', { certified: rev > 0, revision: rev, stamp: rev > 0 ? (k, r, j) => `${k === 'dish' ? 'D' : 'E'}${String(i * 100 + j).padStart(9, '0')}` : null, t: { seconds: 500 + Math.floor(rnd() * 20), nanoseconds: Math.floor(rnd() * 3) } })));
    }
    let checks = 0;
    for (let trial = 0; trial < 60; trial++) {
      let node = null; let maxApplied = null;
      let corrupted = false;
      for (let s = 0; s < 25; s++) {
        if (node && rnd() < 0.15) {   // inject corruption
          corrupted = true;
          node = clone(node);
          const keys = Object.keys(node.records || {});
          const k = keys[Math.floor(rnd() * keys.length)];
          const kind = Math.floor(rnd() * 5);
          if (kind === 0 && k) node.records[k].seq += 1;
          if (kind === 1 && k) delete node.seen[k];
          if (kind === 2) node.head = { digest: 'f'.repeat(64), ck: ck(9, 9, 9) };
          if (kind === 3) node.seen['b'.repeat(64)] = ck(0, 1, 1);
          if (kind === 4 && k) node.seen[k] = { revision: 'x' };
        }
        const c = pool[Math.floor(rnd() * pool.length)];
        const r = apply(node, c);
        if (r.outcomes.includes('oversize')) continue;
        node = r.write ? r.next : node;
        if (!maxApplied || compareCK(c.ck, maxApplied.ck) > 0) maxApplied = c;
        const probs = R.nodeInvariantProblems(node, WHERE).filter((p) => !p.startsWith('too_many'));
        assert.deepStrictEqual(probs, [], `trial ${trial} step ${s}: ${probs}`);
        assert.strictEqual(apply(node, c).write, false, `trial ${trial} step ${s}: a second invocation over the result is a no-op`);
        if (!corrupted) assert.strictEqual(compareCK(node.head.ck, maxApplied.ck), 0, 'without corruption, head is at the greatest applied CK');
        checks += 1;
      }
    }
    assert.ok(checks > 1000, `non-vacuity: ${checks} checked steps`);
  }
  ok('fuzz: 60 trials × 25 random arrivals with 15% random corruption (bad record, dropped/malformed seen, forged head, orphans) — invariants (i)–(iv) hold after EVERY step, every result is stable, and without corruption head = the greatest applied CK');

  // ── §4 THE READER ────────────────────────────────────────────────────────────────────────────────────
  {
    const certified = cand(rawFor('x_pizza', { certified: true, revision: 1, stamp: allStamped }));
    const node = step(null, certified).node;
    const served = { rid: 'x_pizza', versionId: 'v-test', seq: 7, prices: tablesOf('x_pizza') };
    const r = R.identityFromVersionNode(node, served, WHERE);
    assert.deepStrictEqual([r.availability, r.certified, r.intact, r.complete, r.attached, r.usableForWriting], ['available', true, true, true, true, true]);
    // missing → unavailable (never certified:false)
    assert.strictEqual(R.identityFromVersionNode(null, served, WHERE).availability, 'unavailable');
    const noHead = clone(node); delete noHead.head;
    assert.deepStrictEqual([R.identityFromVersionNode(noHead, served, WHERE).availability, R.identityFromVersionNode(noHead, served, WHERE).reason], ['unavailable', 'no_head']);
    const noRec = clone(node); noRec.head.digest = 'c'.repeat(64);
    assert.deepStrictEqual([R.identityFromVersionNode(noRec, served, WHERE).availability, R.identityFromVersionNode(noRec, served, WHERE).certified], ['unavailable', undefined]);
    // explicit certified:false → valid UNCERTIFIED (available, not usable)
    const unc = step(null, cand(rawFor('x_pizza', { certified: false }))).node;
    const ru = R.identityFromVersionNode(unc, served, WHERE);
    assert.deepStrictEqual([ru.availability, ru.certified, ru.complete, ru.attached, ru.usableForWriting], ['available', false, false, true, false]);
    // invalid: malformed certification / disagreement / malformed head CK / bad digest — and NO fallback to an older record
    const two = step(step(null, A).node, certified).node;
    for (const [label, mut] of [
      ['malformed certification', (x) => { x.records[x.head.digest].certified = 'yes'; }],
      ['bad digest', (x) => { x.records[x.head.digest].seq = 8; }],
      ['malformed head CK', (x) => { x.head.ck = { revision: 1 }; }],
      ['head revision mismatch', (x) => { x.head.ck = ck(4, 1, 1); }],
      ['metadata disagreement', (x) => { const rec = x.records[x.head.digest]; rec.versionId = 'other'; }],
    ]) {
      const x = clone(two); mut(x);
      const res = R.identityFromVersionNode(x, served, WHERE);
      assert.strictEqual(res.availability, 'invalid', label);
      assert.ok(!res.usableForWriting && res.digest !== A.digest, `${label}: never falls back to the older record`);
    }
    // attachment: wrong version / seq / prices → not attached (independently served, never the record's)
    for (const s of [{ ...served, versionId: 'v-other' }, { ...served, seq: 8 }, { ...served, prices: { ...served.prices, menu: { ...served.prices.menu, [Object.keys(served.prices.menu)[0]]: 1 } } }, { ...served, rid: 'la_musa' }]) {
      const res = R.identityFromVersionNode(node, s, WHERE);
      assert.deepStrictEqual([res.availability, res.attached, res.usableForWriting], ['available', false, false]);
    }
    // decoder limits: bytes and records per node
    assert.strictEqual(R.identityFromVersionNode(node, served, WHERE, { nodeCap: 1000 }).reason, 'node_oversize');
    const many = clone(node); for (let i = 0; i < 9; i++) many.records[String(i).repeat(64).slice(0, 64)] = { x: i };
    assert.strictEqual(R.identityFromVersionNode(many, served, WHERE).reason, 'too_many_records');
  }
  ok('§4 reader: missing node/head/record → unavailable (never certified:false); explicit certified:false → valid uncertified; malformed certification / bad digest / malformed head CK / revision or metadata disagreement → invalid with NO fallback to an older record; wrong version/seq/prices/rid → not attached; byte and record-count limits refuse');

  // ── §5 ZERO-KIND COMPLETENESS ────────────────────────────────────────────────────────────────────────
  {
    // the two real catalogs: complete exactly as before (both have extras)
    for (const rid of ['x_pizza', 'la_musa']) {
      const ctx = buildContext(rawFor(rid, { certified: true, stamp: allStamped }));
      assert.strictEqual(ctx.complete, true, `${rid} complete (unchanged)`);
      const before = ctx.certified && ctx.coverage.dish.state === 'full' && ctx.coverage.extra.state === 'full' && ctx.ids.wellFormed && ctx.ids.unique && ctx.labels.state === 'complete';
      assert.strictEqual(ctx.complete, before, `${rid}: the old predicate gives the same answer`);
      const unc = buildContext(rawFor(rid, { certified: false, stamp: allStamped }));
      assert.strictEqual(unc.complete, false);
    }
    // a third synthetic restaurant: certified, ZERO extras → complete; uncertified → not; coverage reporting unchanged ('none')
    const z = buildContext(rawFor('x_pizza', { certified: true, stamp: allStamped, dropExtras: true, asRid: 'synthetic_zero' }));
    assert.strictEqual(z.contentIntegrity.state, 'intact', 'premise — the zero-extras payload is intact');
    assert.deepStrictEqual(z.coverage.extra, { state: 'none', covered: 0, total: 0 }, 'coverageOf reporting unchanged');
    assert.strictEqual(z.complete, true, 'a valid, certified zero-extras restaurant is complete');
    const zu = buildContext(rawFor('x_pizza', { certified: false, stamp: allStamped, dropExtras: true, asRid: 'synthetic_zero' }));
    assert.strictEqual(zu.complete, false, 'uncertified stays incomplete');
    const zp = buildContext(rawFor('x_pizza', { certified: true, stamp: (k, r, i) => (i === 0 ? undefined : allStamped(k, r, i)), dropExtras: true, asRid: 'synthetic_zero' }));
    assert.strictEqual(zp.complete, false, 'a PARTIAL dish kind stays incomplete');
    // an empty DISH catalog stays rejected (the builder refuses it)
    const noDish = rawFor('x_pizza', { certified: true, stamp: allStamped }); noDish.items = [];
    assert.strictEqual(buildContext(noDish).built, false, 'an empty dish catalog is refused');
    // through the record + reader: the certified zero-extras record is usable when attached
    const zr = R.buildIdentityRecord(rawFor('x_pizza', { certified: true, revision: 1, stamp: allStamped, dropExtras: true, asRid: 'synthetic_zero' }));
    assert.ok(zr.ok && zr.context.complete === true);
  }
  ok('§5 zero-kind: x_pizza/la_musa complete exactly as under the old predicate; a certified zero-extras synthetic restaurant becomes complete (coverage still reported "none"); uncertified, partial dishes and an empty dish catalog stay incomplete/refused');

  // ── WRITER PLUMBING (fake transaction): retry, abandonment, log-after-settle ─────────────────────────
  {
    const raw = rawFor('x_pizza', { certified: true, revision: 1, stamp: allStamped });
    const fakeDb = { collection: () => fakeDb, doc: () => fakeDb, runTransaction: async () => clone(raw) };
    const store = {};
    const logs = [];
    let calls = [];
    const fakeRtdb = (behaviour) => ({ ref: (p) => ({
      transaction: async (fn) => {
        calls = [];
        // RTDB: first the local cache (null), then the server value (retry)
        let v = fn(null); calls.push(v === undefined ? 'abort' : 'write');
        if (behaviour === 'expire-between') await new Promise((r) => setTimeout(r, 30));
        if (v !== undefined && store[p] !== undefined) { v = fn(clone(store[p])); calls.push(v === undefined ? 'abort' : 'write'); }
        if (v === undefined) return { committed: false };
        store[p] = clone(v); return { committed: true };
      },
    }) });
    const w = createIdentityRecordWriter({ db: fakeDb, rtdb: fakeRtdb('normal'), log: (k, d) => logs.push({ k, d }) });
    const r1 = await within(w.writeVersion('x_pizza', 'v-test'), 2000, 'writeVersion r1');
    assert.deepStrictEqual([r1.committed, r1.settled], [true, true]);
    assert.strictEqual(logs.filter((l) => l.k === 'identity_record_write').length, 1, 'ONE log line, after the transaction settled');
    const r2 = await within(w.writeVersion('x_pizza', 'v-test'), 2000, 'writeVersion r2');
    assert.deepStrictEqual([r2.committed, calls], [false, ['write', 'abort']], 'retry with the stored value → no-op');
    // abandonment: the deadline expires between the callback's first call and the retry → aborted, nothing committed
    delete store['catalog_ctx/x_pizza/v-test'];
    store['catalog_ctx/x_pizza/v-test'] = clone(step(null, cand(rawFor('x_pizza', { revision: 0 }))).node);
    const before = canonicalJson(store['catalog_ctx/x_pizza/v-test']);
    const w2 = createIdentityRecordWriter({ db: fakeDb, rtdb: fakeRtdb('expire-between'), log: () => {} });
    const r3 = await within(w2.writeVersion('x_pizza', 'v-test', { deadlineMs: 15 }), 1000, 'abandoned writeVersion');
    assert.ok(['aborted', 'timeout'].includes(r3.outcomes[0]) && r3.committed === false, JSON.stringify(r3));
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(canonicalJson(store['catalog_ctx/x_pizza/v-test']), before, '🔴 an abandoned write commits nothing');
  }
  ok('writer plumbing: RTDB\'s null-first call then the stored value (retry) → a no-op is detected; ONE outcome log line per write, after settlement; a deadline expiring between callback calls aborts the transaction and commits nothing');

  // ── codex build r1 B2: cursor operations are BOUNDED, and the listener never outlives the call ──────────────────
  {
    const never = () => new Promise(() => {});
    // an instrumented ref: counts live listeners, captures the transaction callback, configurable stalls
    const mkRef = ({ fireOn = true, cancel = false, txStall = false, value = { generation: 3 } } = {}) => {
      const st = { listeners: 0, txFn: null, onCalls: 0, offCalls: 0 };
      return { st, ref: {
        on: (ev, cb, onCancel) => { st.listeners += 1; st.onCalls += 1; if (cancel) setTimeout(() => onCancel(new Error('permission')), 5); else if (fireOn) setTimeout(() => cb({ val: () => value }), 5); return cb; },
        off: () => { st.listeners -= 1; st.offCalls += 1; },
        get: () => (txStall === 'get' ? never() : Promise.resolve({ val: () => value })),
        transaction: (fn) => { st.txFn = fn; if (txStall) return never(); const v = fn(value); return Promise.resolve({ committed: v !== undefined }); },
      } };
    };
    const ms = 60;
    const timed = async (p) => { const t0 = Date.now(); const v = await within(p, ms + 1000, 'casCursor'); return [v, Date.now() - t0]; };
    // success
    let x = mkRef();
    let [v] = await timed(casCursor(x.ref, { generation: 3 }, { generation: 4 }, { ms }));
    assert.deepStrictEqual([v, x.st.listeners, x.st.onCalls, x.st.offCalls], [true, 0, 1, 1], 'success: committed, ONE listener attached and detached');
    // mismatch (a farther cursor): refused, detached
    x = mkRef({ value: { generation: 3, position: 'zz' } });
    [v] = await timed(casCursor(x.ref, { generation: 3 }, { generation: 4 }, { ms }));
    assert.deepStrictEqual([v, x.st.listeners], [false, 0]);
    // stalled INITIALIZATION (the listener's first event never comes): bounded, detached, no transaction attempted
    x = mkRef({ fireOn: false });
    let el; [v, el] = await timed(casCursor(x.ref, { generation: 3 }, { generation: 4 }, { ms }));
    assert.deepStrictEqual([v, x.st.listeners, x.st.txFn], [false, 0, null], 'stalled init → false, listener detached');
    assert.ok(el < ms + 200, `bounded (${el} ms)`);
    // cancellation (listener cancelled by the server)
    x = mkRef({ cancel: true });
    [v] = await timed(casCursor(x.ref, { generation: 3 }, { generation: 4 }, { ms }));
    assert.deepStrictEqual([v, x.st.listeners], [false, 0], 'cancelled → false, detached');
    // stalled TRANSACTION: bounded, detached, and a LATE retry of the callback (after abandonment) refuses to write
    x = mkRef({ txStall: true });
    [v, el] = await timed(casCursor(x.ref, { generation: 3 }, { generation: 4 }, { ms }));
    assert.deepStrictEqual([v, x.st.listeners], [false, 0], 'stalled transaction → false, detached');
    assert.ok(el < ms + 200, `bounded (${el} ms)`);
    assert.strictEqual(x.st.txFn({ generation: 3 }), undefined, '🔴 late recovery: a retry after abandonment commits nothing');
    // a caller's stop that fires mid-CAS also aborts retries
    let stopped = false;
    x = mkRef({ txStall: true });
    const p = casCursor(x.ref, { generation: 3 }, { generation: 4 }, { ms: 400, isStopped: () => stopped });
    await new Promise((r) => setTimeout(r, 30));
    stopped = true;
    assert.strictEqual(x.st.txFn({ generation: 3 }), undefined, 'the caller\'s stop aborts a retry immediately');
    assert.deepStrictEqual([await within(p, 1500, 'stopped casCursor'), x.st.listeners], [false, 0], 'the stopped CAS itself ends (bounded) and detaches');
    // a subscribe that THROWS: refused (false), never a rejection, and no transaction attempted
    x = mkRef();
    x.ref.on = () => { throw new Error('bad path'); };
    assert.strictEqual(await within(casCursor(x.ref, { generation: 3 }, { generation: 4 }, { ms }), ms + 1000, 'casCursor (throwing on)'), false, 'a throwing subscribe → false');
    assert.strictEqual(x.st.txFn, null);
    // stalled read
    x = mkRef({ txStall: 'get' });
    await assert.rejects(within(readCursor(x.ref, { ms }), ms + 1000, 'readCursor'), /cursor_read_timeout/);
    assert.ok(CURSOR_OP_DEADLINE_MS === 5000);
  }
  ok('codex build r1 B2 — cursor primitives: ONE listener per CAS, detached on success / mismatch / stalled init / cancellation / stalled transaction (counts return to 0); every stall bounded by the deadline; a late transaction retry after abandonment (or after the caller\'s stop) refuses to write; a stalled cursor read times out');

  // ── both schedules' TOTAL bounds with every dependency hung, and no listener left behind ────────────────────────
  {
    const never = () => new Promise(() => {});
    const live = { n: 0 };
    const hungRef = () => ({ get: never, on: (e, cb) => { live.n += 1; return cb; }, off: () => { live.n -= 1; }, transaction: never });
    const hungRtdb = { ref: hungRef };
    const hungDb = { collection: () => hungDb, doc: () => hungDb, where: () => hungDb, orderBy: () => hungDb, startAfter: () => hungDb, limit: () => hungDb, select: () => hungDb, get: never, runTransaction: never };
    const B = { listDeadlineMs: 80, cursorOpMs: 60, runBudgetMs: 300, restaurantBudgetMs: 150 };
    const bound = B.listDeadlineMs + B.cursorOpMs + B.runBudgetMs + 50 + B.cursorOpMs + 250;   // + timer slack
    // (a) a hung listing
    let t0 = Date.now();
    let res = await within(createIdentityRecordWriter({ db: hungDb, rtdb: hungRtdb, log: () => {} }).reconcile({ listIds: never, ...B }), bound, 'reconcile (hung listing)');
    assert.ok(!res.ok && Date.now() - t0 < B.listDeadlineMs + 250, 'writer: a hung listing is bounded');
    res = await within(createIdentityVerifier({ db: hungDb, rtdb: hungRtdb, log: () => {} }).verify({ listIds: never, ...B }), bound, 'verify (hung listing)');
    assert.ok(!res.ok, 'verifier: a hung listing is bounded');
    // (b) a hung restaurant cursor: nothing processed, bounded
    t0 = Date.now();
    res = await within(createIdentityRecordWriter({ db: hungDb, rtdb: hungRtdb, log: () => {} }).reconcile({ listIds: async () => ['r1', 'r2'], ...B }), bound, 'reconcile (hung cursor read)');
    assert.ok(!res.ok && Date.now() - t0 < B.listDeadlineMs + B.cursorOpMs + 250, 'writer: a hung restaurant-cursor read is bounded');
    // (c) everything after the cursor read hung (a readable cursor, hung reads/writes/CAS): the whole run is bounded
    const okCursorRtdb = { ref: (path) => (/restaurant_cursor$/.test(path) ? { get: async () => ({ val: () => null }), on: (e, cb) => { live.n += 1; setTimeout(() => cb({ val: () => null }), 1); return cb; }, off: () => { live.n -= 1; }, transaction: never } : hungRef()) };
    for (const [name, run] of [
      ['reconcile', () => createIdentityRecordWriter({ db: hungDb, rtdb: okCursorRtdb, log: () => {} }).reconcile({ listIds: async () => ['r1', 'r2', 'r3'], ...B })],
      ['verify', () => createIdentityVerifier({ db: hungDb, rtdb: okCursorRtdb, log: () => {} }).verify({ listIds: async () => ['r1', 'r2', 'r3'], ...B })],
    ]) {
      t0 = Date.now();
      const out = await within(run(), bound, name);
      const el = Date.now() - t0;
      assert.ok(out.ok && el < bound, `${name}: total ${el} ms < bound ${bound} ms with every dependency hung`);
      await new Promise((r) => setTimeout(r, 300));   // let every bounded inner operation settle
      assert.strictEqual(live.n, 0, `${name}: 🔴 no RTDB listener left attached (${live.n})`);
    }
  }
  // ── codex build r3 S1: NO WORK STARTS past the work deadline — zero budget starts no I/O at all, and an await that
  //    crosses the work deadline starts nothing after it (both schedules; a deterministic clock moved by the fakes) ──────
  {
    const { makeDeadline } = require('./identity-record-writer');
    const mk = ({ cross = null, mirrorVid = null, activeVid = null } = {}) => {
      const clock = { t: 0 };
      const now = () => clock.t;
      const io = { cursorGet: 0, cursorTx: 0, cursorOn: 0, nodeGet: 0, db: 0, mirror: 0, active: 0, served: 0, page: 0 };
      // `cross` names the read whose completion moves the clock PAST the work deadline (hard 100 ms, reserve 50 ms)
      const done = (name, v) => Promise.resolve().then(() => { if (cross === name) clock.t = 60; return v; });
      const rtdb = { ref: (path) => (/cursor/.test(path)
        ? { get: () => { io.cursorGet += 1; return done('cursor', { val: () => null }); }, on: () => { io.cursorOn += 1; }, off: () => {}, transaction: () => { io.cursorTx += 1; return Promise.resolve({ committed: false }); } }
        : { get: () => { io.nodeGet += 1; return Promise.resolve({ val: () => null }); }, transaction: () => { io.db += 1; return Promise.resolve({ committed: false }); } }) };
      const db = { runTransaction: () => { io.db += 1; return new Promise(() => {}); }, collection: () => { io.db += 1; throw new Error('unexpected Firestore read'); } };
      const wr = {
        mirrorVersionId: () => { io.mirror += 1; return done('mirror', mirrorVid); },
        activeVersionId: () => { io.active += 1; return done('active', activeVid); },
        versionPage: () => { io.page += 1; return Promise.resolve([]); },
      };
      const vr = {
        mirrorValue: () => { io.mirror += 1; return done('mirror', mirrorVid ? { version: mirrorVid, seq: 1, menu: {}, extras: {} } : null); },
        activeVersionId: () => { io.active += 1; return done('active', activeVid); },
        activeServed: () => { io.served += 1; return Promise.resolve({ rid: 'r1', versionId: activeVid, seq: 1, prices: { menu: {}, extras: {} } }); },
        versionPage: () => { io.page += 1; return Promise.resolve([]); },
      };
      return { clock, now, io, w: createIdentityRecordWriter({ db, rtdb, now, log: () => {} }), v: createIdentityVerifier({ db, rtdb, now, log: () => {} }), wr, vr };
    };
    const untouched = (io, label) => assert.deepStrictEqual(io, { cursorGet: 0, cursorTx: 0, cursorOn: 0, nodeGet: 0, db: 0, mirror: 0, active: 0, served: 0, page: 0 }, `${label}: 🔴 no I/O started`);
    // (a) ZERO budget: nothing is started at all
    {
      let x = mk();
      const wo = await within(x.w.reconcileRestaurant('r1', makeDeadline(0, x.now), { r: x.wr, cursorOpMs: 50 }), 1000, 'writer zero budget');
      untouched(x.io, 'writer, zero budget');
      assert.deepStrictEqual([wo.rungs.mirror.outcomes, wo.rungs.active.outcomes, wo.versions, wo.stopped], [['budget_exhausted'], ['budget_exhausted'], [], 'cursor_read_work_deadline']);
      x = mk();
      const vo = await within(x.v.verifyRestaurant('r1', makeDeadline(0, x.now), { r: x.vr, cursorOpMs: 50 }), 1000, 'verifier zero budget');
      untouched(x.io, 'verifier, zero budget');
      assert.deepStrictEqual([vo.rungs.map((g) => g.reason), vo.retainedStopped], [['budget_exhausted', 'budget_exhausted'], 'cursor_read_work_deadline']);
    }
    // (b) the CURSOR read crosses the work deadline → no page fetch starts, and no checkpoint (nothing settled: unchanged)
    {
      let x = mk({ cross: 'cursor' });
      const wo = await within(x.w.reconcileRestaurant('r1', makeDeadline(100, x.now), { r: x.wr, cursorOpMs: 50 }), 1000, 'writer cursor crossing');
      assert.deepStrictEqual([x.io.cursorGet, x.io.page, x.io.cursorTx, x.io.cursorOn, wo.stopped, wo.cursor], [1, 0, 0, 0, 'version_page_work_deadline', null], `writer: 🔴 no page fetch after the crossing read ${JSON.stringify(x.io)}`);
      x = mk({ cross: 'cursor' });
      const vo = await within(x.v.verifyRestaurant('r1', makeDeadline(100, x.now), { r: x.vr, cursorOpMs: 50 }), 1000, 'verifier cursor crossing');
      assert.deepStrictEqual([x.io.cursorGet, x.io.page, x.io.cursorTx, vo.retainedStopped, vo.cursor], [1, 0, 0, 'version_page_work_deadline', null], `verifier: 🔴 no page fetch after the crossing read ${JSON.stringify(x.io)}`);
    }
    // (c) a RUNG read crosses it → no write / load and no later read starts
    {
      let x = mk({ cross: 'mirror', mirrorVid: 'v1', activeVid: 'v2' });
      const wo = await within(x.w.reconcileRestaurant('r1', makeDeadline(100, x.now), { r: x.wr, cursorOpMs: 50 }), 1000, 'writer rung crossing');
      assert.deepStrictEqual([x.io.mirror, x.io.db, x.io.active, x.io.cursorGet, x.io.page], [1, 0, 0, 0, 0], `writer: 🔴 nothing after the crossing rung read ${JSON.stringify(x.io)}`);
      assert.deepStrictEqual(wo.rungs.mirror.outcomes, ['budget_exhausted']);
      x = mk({ cross: 'mirror', mirrorVid: 'v1', activeVid: 'v2' });
      await within(x.v.verifyRestaurant('r1', makeDeadline(100, x.now), { r: x.vr, cursorOpMs: 50 }), 1000, 'verifier mirror crossing');
      assert.deepStrictEqual([x.io.mirror, x.io.nodeGet, x.io.db, x.io.active, x.io.cursorGet, x.io.page], [1, 0, 0, 0, 0, 0], `verifier: 🔴 nothing after the crossing mirror read ${JSON.stringify(x.io)}`);
      x = mk({ cross: 'active', activeVid: 'v2' });
      const vo = await within(x.v.verifyRestaurant('r1', makeDeadline(100, x.now), { r: x.vr, cursorOpMs: 50 }), 1000, 'verifier active crossing');
      assert.deepStrictEqual([x.io.active, x.io.served, x.io.nodeGet, x.io.cursorGet, x.io.page], [1, 0, 0, 0, 0], `verifier: 🔴 activeServed is not started after the crossing read ${JSON.stringify(x.io)}`);
      assert.strictEqual(vo.rungs.find((g) => g.rung === 'active').reason, 'budget_exhausted');
    }
    // non-vacuity: with budget left, the same fakes DO perform the reads (the counters see I/O)
    {
      const x = mk({ activeVid: 'v2' });
      await within(x.v.verifyRestaurant('r1', makeDeadline(100, x.now), { r: x.vr, cursorOpMs: 50 }), 1000, 'verifier with budget');
      assert.ok(x.io.mirror === 1 && x.io.active === 1 && x.io.served === 1 && x.io.cursorGet === 1 && x.io.page === 1, JSON.stringify(x.io));
    }
  }
  ok('codex build r3 S1 — no work starts past the work deadline (both schedules): with zero budget no read, write, load or cursor operation is started at all; a cursor read that crosses the work deadline starts no page fetch (and no checkpoint — nothing settled); a rung read that crosses it starts no write / load and no later read; the verifier never starts activeServed after a crossing read; with budget left the same fakes do see every read');

  // rung checks are CLIPPED to the caller's remaining budget (load and D4-a projection), not only to their own deadlines
  {
    const never = () => new Promise(() => {});
    const certified = cand(rawFor('x_pizza', { certified: true, revision: 1, stamp: allStamped }));
    const node = step(null, certified).node;
    const served = { rid: 'x_pizza', versionId: 'v-test', seq: 7, prices: tablesOf('x_pizza') };
    const stop = (ms) => { const until = Date.now() + ms; return { remaining: () => Math.max(0, until - Date.now()), stopped: () => Date.now() >= until }; };
    const hungLoad = createIdentityVerifier({ db: { runTransaction: never }, rtdb: { ref: () => ({ get: never }) }, log: () => {} });
    let t0 = Date.now();
    let r = await within(hungLoad.checkRung('x_pizza', 'mirror', served, stop(80)), 2000, 'checkRung (hung load)');
    assert.ok(Date.now() - t0 < 300 && r.category === 'unavailable', `a hung load is clipped to the remaining 80 ms (${Date.now() - t0} ms, ${r.reason})`);
    const hungD4a = createIdentityVerifier({ db: { collection: () => ({ doc: () => ({ collection: () => ({}) }) }), runTransaction: never }, rtdb: { ref: () => ({ get: async () => ({ val: () => node }) }) }, log: () => {} });
    t0 = Date.now();
    r = await within(hungD4a.checkRung('x_pizza', 'active', served, stop(80)), 2000, 'checkRung (hung D4-a)');
    assert.ok(Date.now() - t0 < 300 && r.category === 'incomparable', `a hung D4-a projection is clipped to the remaining budget (${Date.now() - t0} ms, ${r.category})`);
    r = await within(hungD4a.checkRung('x_pizza', 'active', served, stop(0)), 2000, 'checkRung (no budget)');
    assert.strictEqual(r.reason, 'budget_exhausted', 'no budget → no load at all');
  }
  ok('verifier rung checks are clipped to the caller\'s remaining budget: a hung load and a hung D4-a projection each return within it; with no budget left nothing is started');

  ok('both schedules\' TOTAL bounds: a hung listing, a hung restaurant-cursor read, and a run where every read / write / cursor op hangs all finish within listing + cursor read + run budget + final CAS; afterwards no RTDB listener remains attached');

  clearTimeout(watchdog);
  // nothing the cases started may outlive them: no timer still active → the process exits on its own
  const lingering = process.getActiveResourcesInfo().filter((k) => k === 'Timeout');
  assert.deepStrictEqual(lingering, [], `🔴 timers still active after the last case: ${lingering.length}`);
  ok('every case ended: no timer remains active after the last case (the passing suite exits on its own)');

  __finished = true;
  console.log(`identity-record: OK (${n})`);
})().catch((e) => {
  // failure path only: report, then exit non-zero even if a regressed bound left a timer running
  console.error('identity-record FAILED:', e, '\nactive resources:', process.getActiveResourcesInfo());
  process.exit(1);
});
