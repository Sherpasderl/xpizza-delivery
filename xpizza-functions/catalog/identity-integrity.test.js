'use strict';
// 1D D4-c2b — the PURE half of the identity integrity monitor (PLAN-D4c2b rev 14 §2–§6, §9): the classifier (every precedence step),
// the audit entry, the reducer (sticky findings, timers, deferrals, boundary, acknowledgement), staleness timelines, the summary
// emitter, scheduling, and the read budget + pacing. Evidence fixtures are built by c2a's OWN builders (identity-evidence.js), so the
// schemas checked here are exactly what the real writer emits. The real-writer emulator cells are in test/c2b-integrity.emulator.test.js.
const assert = require('assert');
const E = require('./identity-evidence');
const { H } = require('./evidence-encoding');
const { encodeKey } = require('./identity-registry');
const { idPath, keyPath } = require('./catalog-verifier');
const C = require('./identity-integrity');
const S = require('./identity-integrity-state');
const { createReadBudget } = require('./identity-integrity-monitor');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const RID = 'synth_unit';
const VID = 'v-1791000000000-abcdefabcdef';

// a consistent world: N dishes (+ M extras), stamped, registry live; evidence from c2a's builders
function world({ dishes = 3, extras = 1, gen = 7, version = VID } = {}) {
  const pairs = [];
  for (let i = 0; i < dishes; i += 1) pairs.push({ kind: 'dish', key: `Dish ${i}`, id: `ID_D${i}`, docId: `d${i}` });
  for (let i = 0; i < extras; i += 1) pairs.push({ kind: 'extra', key: `Extra ${i}`, id: `ID_E${i}`, docId: `e${i}` });
  const rows = {};
  for (const p of pairs) {
    rows[idPath(RID, p.kind, p.id)] = { legacy_key: p.key, status: 'live', kind: p.kind };
    rows[keyPath(RID, p.kind, p.key)] = { canonical_id: p.id, kind: p.kind };
  }
  return { pairs, rows, gen, version };
}
const snapOf = (pairs, kind) => ({ docs: pairs.filter((p) => p.kind === kind).map((p) => ({ id: p.docId, data: () => ({ key: p.key, display: { identity_id: p.id } }) })) });
function activation(w, { intent = 'publish', certified = true, generation = w.gen, version = w.version, pairs = w.pairs } = {}) {
  const record = { content_hash: 'h'.repeat(64), seq: 3, identity_revision: 1 };
  if (!certified) { const m = E.activationEvidenceDoc(null, { certified: false, versionId: version, generation, intent, record }); return { id: m.docId, data: { ...m.data, at: 'TS' } }; }
  const empty = { moves: [], mints: [], retires: [] };
  const b = E.buildActivationEvidence({ versionId: version, generation, intent, record,
    docs: { dish: snapOf(pairs, 'dish'), extra: snapOf(pairs, 'extra') },
    docIdByKey: { dish: new Map(pairs.filter((p) => p.kind === 'dish').map((p) => [p.key, p.docId])), extra: new Map(pairs.filter((p) => p.kind === 'extra').map((p) => [p.key, p.docId])) },
    minted: { dish: new Map(), extra: new Map() }, registry: { dish: new Map(), extra: new Map() }, fullIds: { dish: new Map(), extra: new Map() }, fullKeys: { dish: new Map(), extra: new Map() },
    judged: { stamps: [] }, relocated: new Set(), plans: intent === 'rollback' ? { dish: { source: 'reconcile', rec: { restores: [], retires: [], deletions: [] } }, extra: { source: 'reconcile', rec: { restores: [], retires: [], deletions: [] } } }
      : { dish: { source: 'derived', plan: empty }, extra: { source: 'derived', plan: empty } } });
  return { id: b.docId, data: { ...b.data, at: 'TS' } };
}
function certification(w, { rev = 1, generation = w.gen, version = w.version, pairs = w.pairs } = {}) {
  const objs = (k) => pairs.filter((p) => p.kind === k).map((p) => ({ id: p.docId, key: p.key, canonical_id: p.id }));
  const b = E.buildCertificationEvidence({ versionId: version, observedGeneration: generation, revisionAfter: rev, record: { content_hash: 'h' },
    objects: { dish: objs('dish'), extra: objs('extra') }, liveByKey: { dish: new Map(), extra: new Map() }, keyRowIdOf: new Map() });
  return { id: b.docId, data: { ...b.data, at: 'TS' } };
}
const obsOf = (w, over = {}) => ({ rid: RID, pointer: { version: w.version, generation: w.gen }, record: { exists: true, certified: true },
  activation: activation(w), certifications: [], objects: { count: w.pairs.length, pairs: w.pairs, unstamped: [] }, rows: w.rows, ...over });
const kinds = (r) => r.findings.map((f) => f.kind + (f.detail && f.detail.reason ? `{${f.detail.reason}}` : '')).sort();
const B = { G0: 1 };

try {
  // ── 1. schemas: c2a's own builders validate; every structural defect is malformed ─────────────────────────────────
  {
    const w = world();
    const full = activation(w); const min = activation(w, { certified: false }); const cert = certification(w, { rev: 2 });
    assert.deepStrictEqual(C.activationSchema(full.id, full.data), { ok: true, certified: true });
    assert.deepStrictEqual(C.activationSchema(min.id, min.data), { ok: true, certified: false });
    assert.deepStrictEqual(C.certificationSchema(cert.id, cert.data), { ok: true });
    const bad = (d, why) => assert.strictEqual(C.activationSchema(full.id, d).why, why, `${why}`);
    bad({ ...full.data, v: 2 }, 'version');
    bad({ ...full.data, certified: 'yes' }, 'certified_flag');
    bad({ ...full.data, extra_field: 1 }, 'fields');
    bad((({ observed_digest, ...r }) => r)(full.data), 'fields');
    bad({ ...full.data, vid: 'short' }, 'header');
    bad({ ...full.data, generation: 'o:string' }, 'header');
    bad({ ...full.data, intent: 'other' }, 'intent');
    bad({ ...full.data, final_digest: 'x' }, 'body');
    bad({ ...full.data, plan: { dish: full.data.plan.dish } }, 'body');
    bad((({ at, ...r }) => r)(full.data), 'fields');
    assert.strictEqual(C.activationSchema('g00000000000000000099', full.data).why, 'doc_id', 'the doc id must be g{G20(generation)}');
    assert.strictEqual(C.activationSchema(min.id, { ...min.data, final_digest: full.data.final_digest }).why, 'fields', 'a minimal record carries no binding fields');
    assert.strictEqual(C.certificationSchema(cert.id, { ...cert.data, kind: 'other' }).why, 'header');
    assert.strictEqual(C.certificationSchema(cert.id, { ...cert.data, rev_c: 'o:absent' }).why, 'header', 'a certification revision is an integer');
    assert.strictEqual(C.certificationSchema('c00000000000000000007_00000000000000000009', cert.data).why, 'doc_id');
    for (const junk of [null, 1, 'x', [], {}]) { assert.strictEqual(C.activationSchema(undefined, junk).ok, false); assert.strictEqual(C.certificationSchema(undefined, junk).ok, false); }
  }
  ok('§2.1 schemas: c2a\'s own full / minimal / certification records validate; version, flag, extra/missing field, header, intent, body, plan shape, `at`, doc-id and minimal-with-binding-fields defects are each malformed');

  // ── 2. precedence, step by step ──────────────────────────────────────────────────────────────────────────────────
  {
    const w = world();
    // clean binding through the activation
    let r = C.classifyActive(obsOf(w), B);
    assert.deepStrictEqual([r.state, kinds(r), r.coverage], ['ok', [], true]);
    // version record missing → active_version_missing, nothing else judged
    r = C.classifyActive(obsOf(w, { record: { exists: false, certified: false } }), B);
    assert.deepStrictEqual([r.state, kinds(r)], ['violation', ['active_version_missing']]);
    // malformed activation → evidence_malformed; no binding judgement, registry still judged (a swapped key row)
    const rowsBad = { ...w.rows, [keyPath(RID, 'dish', 'Dish 0')]: { canonical_id: 'OTHER', kind: 'dish' } };
    r = C.classifyActive(obsOf(w, { activation: { ...activation(w), data: { ...activation(w).data, v: 9 } }, rows: rowsBad }), B);
    assert.deepStrictEqual([r.state, kinds(r)], ['violation', ['evidence_malformed', 'registry_disagrees']]);
    // activation for ANOTHER version → evidence_mismatch
    r = C.classifyActive(obsOf(w, { activation: activation(w, { version: 'v-other' }) }), B);
    assert.deepStrictEqual(kinds(r), ['evidence_mismatch']);
    // absent activation: below G0 → pre_boundary state, no finding; at/above → unattested{generation_gap}; unknown → {boundary_unknown}
    r = C.classifyActive(obsOf(w, { activation: null, origin: { kind: 'none' } }), { G0: 8 });
    assert.deepStrictEqual([r.state, kinds(r)], ['pre_boundary', []]);
    r = C.classifyActive(obsOf(w, { activation: null, origin: { kind: 'none' } }), { G0: 7 });
    assert.deepStrictEqual([r.state, kinds(r)], ['uncertified', ['unattested{generation_gap}']]);
    r = C.classifyActive(obsOf(w, { activation: null, origin: { kind: 'none' } }), null);
    assert.deepStrictEqual(kinds(r), ['unattested{boundary_unknown}']);
    // a pre-boundary version certified by bootstrap at this generation binds through the certification
    r = C.classifyActive(obsOf(w, { activation: null, certifications: [certification(w)] }), { G0: 8 });
    assert.deepStrictEqual([r.state, kinds(r)], ['ok', []]);
    // certification NEWER than the activation in one generation: the greatest rev_c wins, before any count/digest check
    const shrunk = w.pairs.slice(0, 2);
    const later = certification(w, { rev: 5, pairs: shrunk }); const earlier = certification(w, { rev: 2 });
    r = C.classifyActive(obsOf(w, { certifications: [later, earlier], objects: { count: 2, pairs: shrunk, unstamped: [] } }), B);
    assert.deepStrictEqual([r.state, kinds(r)], ['ok', []], 'the rev 5 certification (2 objects) is the effective record, not the activation (4)');
    r = C.classifyActive(obsOf(w, { certifications: [later, earlier] }), B);
    assert.deepStrictEqual(kinds(r), ['coverage_broken', 'stamps_changed'], 'judged against the rev 5 record');
    // a malformed / mismatched certification → finding, no binding judgement
    r = C.classifyActive(obsOf(w, { certifications: [{ ...earlier, data: { ...earlier.data, checks_count: -1 } }] }), B);
    assert.deepStrictEqual(kinds(r), ['evidence_malformed']);
    r = C.classifyActive(obsOf(w, { certifications: [certification(w, { generation: 6 })] }), B);
    assert.deepStrictEqual(kinds(r), ['evidence_mismatch'], 'a well-formed certification of ANOTHER generation → mismatch (association, not structure)');
    r = C.classifyActive(obsOf(w, { certifications: [certification(w, { version: 'v-other' })] }), B);
    assert.deepStrictEqual(kinds(r), ['evidence_mismatch']);
    // NO effective record: a version certified before (origin exists) now uncertified → decertified; else uncertified
    const minimal = activation(w, { certified: false });
    r = C.classifyActive(obsOf(w, { activation: minimal, record: { exists: true, certified: false }, origin: { kind: 'publish' } }), B);
    assert.deepStrictEqual([r.state, kinds(r)], ['violation', ['decertified']]);
    r = C.classifyActive(obsOf(w, { activation: minimal, record: { exists: true, certified: false }, origin: { kind: 'none' } }), B);
    assert.deepStrictEqual([r.state, kinds(r)], ['uncertified', []]);
    // an effective record but the version record no longer certified → decertified
    r = C.classifyActive(obsOf(w, { record: { exists: true, certified: false } }), B);
    assert.deepStrictEqual(kinds(r), ['decertified']);
  }
  ok('§2 precedence: version missing; malformed / mismatched activation (registry still judged); absent activation pre_boundary / generation_gap / boundary_unknown; a pre-boundary version bound by its certification; the greatest-rev_c certification is effective BEFORE count/digest; malformed / foreign certifications; decertified with and without an effective record; uncertified without an origin');

  // ── 3. coverage, digest, registry, budgets ───────────────────────────────────────────────────────────────────────
  {
    const w = world();
    const cov = (objects) => kinds(C.classifyActive(obsOf(w, { objects }), B));
    assert.deepStrictEqual(cov({ count: 5, pairs: w.pairs, unstamped: [{ kind: 'dish', docId: 'd9' }] }), ['coverage_broken'], 'an unstamped object');
    const dup = w.pairs.map((p, i) => (i === 1 ? { ...p, id: w.pairs[0].id } : p));
    assert.ok(cov({ count: 4, pairs: dup, unstamped: [] }).includes('coverage_broken'), 'a duplicated id within a kind');
    assert.ok(cov({ count: 3, pairs: w.pairs.slice(1), unstamped: [] }).includes('coverage_broken'), 'a missing object (count ≠ final_count)');
    // a PLANTED SWAP: two dishes exchange ids → the digest changes AND the registry disagrees
    const swap = w.pairs.map((p) => (p.docId === 'd0' ? { ...p, id: 'ID_D1' } : (p.docId === 'd1' ? { ...p, id: 'ID_D0' } : p)));
    assert.deepStrictEqual(cov({ count: 4, pairs: swap, unstamped: [] }), ['registry_disagrees', 'stamps_changed']);
    // registry key-row swap only → registry_disagrees; missing key row only → degraded pair, no finding
    let r = C.classifyActive(obsOf(w, { rows: { ...w.rows, [keyPath(RID, 'dish', 'Dish 1')]: { canonical_id: 'ID_D2', kind: 'dish' } } }), B);
    assert.deepStrictEqual(kinds(r), ['registry_disagrees']);
    const noKey = { ...w.rows }; delete noKey[keyPath(RID, 'dish', 'Dish 2')];
    r = C.classifyActive(obsOf(w, { rows: noKey }), B);
    assert.deepStrictEqual([r.state, kinds(r), r.degradedPairs], ['ok', [], [C.pairKey(w.pairs[2])]]);
    // over the pair/encoding budget → unavailable{oversized_values}: NEVER a violation, not coverage
    const big = world({ dishes: 1, extras: 0 }); const huge = 'x'.repeat(5 * 1024 * 1024);
    big.pairs[0].key = huge;
    r = C.classifyActive(obsOf(big, { activation: activation(world({ dishes: 1, extras: 0 })) }), B);
    assert.deepStrictEqual([r.state, r.reason, r.findings, r.coverage], ['unavailable', 'oversized_values', [], false]);
    // escape-heavy values are budgeted at their ENCODED size (c2a's ENC2 length, ×6 for control characters)
    const esc = [{ kind: 'dish', key: '\u0001'.repeat(1024 * 1024), id: 'I', docId: 'd' }];
    const b = C.pairBudget(esc);
    assert.ok(b.encoded > 6 * 1024 * 1024 && b.raw < 1.1 * 1024 * 1024, 'a control character costs its 6-byte \\u escape in the encoded budget');
    assert.strictEqual(b.encoded, E.FINAL_FRAME_BYTES + E.finalTupleBytes({ k: 'dish', c: 'I', n: esc[0].key, o: 'd' }), 'counted ONLY through c2a\'s exported length function');
    // the recomputation is c2a's finalDigestOfVersion over the retained pairs
    assert.strictEqual(C.recomputeFinal(w.pairs).final_digest, activation(w).data.final_digest);
    assert.strictEqual(C.MAX_OBJECTS, 400); assert.strictEqual(C.MAX_CERTIFICATIONS, 8);
  }
  ok('§2.4–5 coverage (unstamped / duplicate id / missing object), a planted id SWAP (stamps_changed + registry_disagrees), a registry key-row swap, a missing key row = degraded pair only, the 4 MiB / 24 MiB budgets → unavailable{oversized_values} (never a violation), escape-heavy values counted through c2a\'s ENC2 length function, recomputation = c2a\'s finalDigestOfVersion');

  // ── 4. CHECK B: one generation of the dense audit ─────────────────────────────────────────────────────────────────
  {
    const w = world();
    const k = (r) => r.findings.map((f) => f.kind + (f.detail && f.detail.reason ? `{${f.detail.reason}}` : ''));
    assert.deepStrictEqual(k(C.classifyAuditEntry({ g: 3, doc: null }, { G0: 5 })), [], 'absent below G0 = pre-boundary');
    assert.deepStrictEqual(k(C.classifyAuditEntry({ g: 5, doc: null }, { G0: 5 })), ['unattested{generation_gap}']);
    assert.deepStrictEqual(k(C.classifyAuditEntry({ g: 5, doc: null }, null)), ['unattested{boundary_unknown}']);
    const pub = activation(w, { generation: 5 });
    assert.deepStrictEqual(k(C.classifyAuditEntry({ g: 5, doc: pub }, B)), []);
    assert.deepStrictEqual(k(C.classifyAuditEntry({ g: 5, doc: { ...pub, data: { ...pub.data, ch: 1 } } }, B)), ['evidence_malformed']);
    assert.deepStrictEqual(k(C.classifyAuditEntry({ g: 6, doc: pub }, B)), ['evidence_malformed'], 'evidence of another generation at this id');
    const rb = activation(w, { generation: 9, intent: 'rollback' });
    assert.deepStrictEqual(k(C.classifyAuditEntry({ g: 9, doc: rb, origin: { kind: 'publish', id: pub.id, data: pub.data } }, B)), [], 'rollback target unaltered (origin = certified publish)');
    const altered = activation(w, { generation: 9, intent: 'rollback', pairs: w.pairs.slice(1) });
    assert.deepStrictEqual(k(C.classifyAuditEntry({ g: 9, doc: altered, origin: { kind: 'publish', id: pub.id, data: pub.data } }, B)), ['rollback_target_altered']);
    const cert = certification(w, { generation: 4 });
    assert.deepStrictEqual(k(C.classifyAuditEntry({ g: 9, doc: rb, origin: { kind: 'certify', id: cert.id, data: cert.data } }, B)), [], 'certification origin');
    assert.deepStrictEqual(k(C.classifyAuditEntry({ g: 9, doc: rb, origin: { kind: 'none' } }, B)), ['history_unknown']);
    assert.deepStrictEqual(k(C.classifyAuditEntry({ g: 9, doc: rb, origin: { kind: 'publish', id: pub.id, data: { ...pub.data, intent: 'rollback' } } }, B)), ['evidence_malformed'], 'a rollback is never an origin');
    const minRb = activation(w, { generation: 9, intent: 'rollback', certified: false });
    assert.deepStrictEqual(k(C.classifyAuditEntry({ g: 9, doc: minRb }, B)), [], 'an uncertified rollback carries no binding to check');
    assert.strictEqual(C.CLASS_OF.unattested, 'gap'); assert.strictEqual(C.CLASS_OF.history_unknown, 'gap'); assert.strictEqual(C.CLASS_OF.rollback_target_altered, 'violation');
  }
  ok('§3 audit: absent below G0 / ≥ G0 / unknown boundary; valid; malformed; another generation\'s evidence; certified rollback vs its binding origin (publish or certification) unaltered / altered; no origin → history_unknown; a rollback never an origin; an uncertified rollback carries no binding');

  // ── 5. reducer: sticky findings, acknowledgement, stale results ──────────────────────────────────────────────────
  {
    const t = (min) => S.fromMs(1_800_000_000_000 + min * 60000);
    const viol = C.finding('stamps_changed', 'g7', { generation: 7 });
    const res = (findings, extra = {}) => ({ state: findings.length ? 'violation' : 'ok', findings, degradedPairs: [], coverage: true, ...extra });
    let { node } = S.applyActive(null, res([viol]), { obs_t: t(0), generation: 7 });
    const id1 = Object.keys(node.findings)[0];
    assert.deepStrictEqual([node.summary.open_violations, node.findings[id1].condition], [1, 'present']);
    ({ node } = S.applyActive(node, res([]), { obs_t: t(15), generation: 7 }));
    assert.deepStrictEqual([node.summary.open_violations, node.findings[id1].condition, node.findings[id1].cleared_obs_t], [1, 'cleared', t(15)], 'repaired → condition cleared, STILL OPEN and counted');
    const stale = S.applyActive(node, res([viol]), { obs_t: t(10), generation: 7 });
    assert.strictEqual(stale.applied, false, 'an older observation is discarded');
    ({ node } = S.applyActive(node, res([viol]), { obs_t: t(30), generation: 8 }));
    assert.deepStrictEqual([Object.keys(node.findings).length, node.findings[id1].condition], [1, 'present'], 'the same open finding: condition present again, no duplicate');
    const a = S.ack(node, id1, { at: 1, by: 'owner', note: 'checked' }); node = a.node;
    assert.deepStrictEqual([a.ok, node.summary.open_violations, node.findings[id1].status], [true, 0, 'acknowledged']);
    assert.strictEqual(S.ack(node, id1, { at: 2, by: 'o', note: '' }).ok, false, 'acknowledging twice refused');
    assert.strictEqual(S.ack(node, 'nope', { at: 2, by: 'o', note: '' }).reason, 'no_such_finding');
    ({ node } = S.applyActive(node, res([viol]), { obs_t: t(45), generation: 8 }));
    const ids = Object.keys(node.findings);
    assert.deepStrictEqual([ids.length, node.summary.open_violations], [2, 1], 'reappearance after acknowledgement → a NEW finding');
    assert.notStrictEqual(ids.find((x) => x !== id1), id1);
    // an unavailable result is not coverage: findings untouched, active_ok unchanged
    const before = node.coverage.active_ok_obs_t;
    ({ node } = S.applyActive(node, { state: 'unavailable', reason: 'oversized_values', findings: [], degradedPairs: [], coverage: false }, { obs_t: t(60), generation: 8 }));
    assert.deepStrictEqual([node.coverage.active_ok_obs_t, node.active.state, node.summary.open_violations], [before, 'unavailable', 1]);
    // the audit page: applied only if contiguous; findings scoped audit are never cleared by the active check
    node.audited_through = 4;
    assert.strictEqual(S.applyAuditPage(node, { start: 6, end: 8, findings: [], obs_t: t(61), current: 8 }).applied, false, 'a non-contiguous page is discarded whole');
    const gap = C.finding('unattested', 'g5', { generation: 5, reason: 'generation_gap' });
    ({ node } = S.applyAuditPage(node, { start: 5, end: 8, findings: [gap], obs_t: t(62), current: 8 }));
    assert.deepStrictEqual([node.audited_through, node.summary.open_gaps, node.coverage.audit_ok_obs_t], [8, 1, t(62)]);
    ({ node } = S.applyActive(node, res([]), { obs_t: t(75), generation: 8 }));
    const gf = Object.values(node.findings).find((f) => f.kind === 'unattested');
    assert.deepStrictEqual([gf.condition, node.summary.open_gaps], ['present', 1], 'an audit finding is historical: the active check does not clear it');
  }
  ok('§4 reducer: a finding stays OPEN when its condition clears (counted until acknowledged), an older active result is discarded, the same open finding is updated (no duplicate), acknowledgement closes it and recomputes the summary, a reappearance after acknowledgement opens a NEW finding; unavailable = no coverage; audit pages only when contiguous; audit findings are historical');

  // ── 6. degraded timers: 2 h → sticky finding; repair clears the condition; reappearance → a NEW timer and finding ─────
  {
    const t = (min) => S.fromMs(1_800_000_000_000 + min * 60000);
    const res = (pairs) => ({ state: 'ok', findings: [], degradedPairs: pairs, coverage: true });
    let { node } = S.applyActive(null, res(['P']), { obs_t: t(0), generation: 1 });
    assert.deepStrictEqual(node.timers, { P: t(0) });
    ({ node } = S.applyActive(node, res(['P']), { obs_t: t(120), generation: 1 }));
    assert.strictEqual(node.summary.open_degraded, 0, 'exactly 2 h is not > 2 h');
    ({ node } = S.applyActive(node, res(['P']), { obs_t: t(121), generation: 1 }));
    assert.strictEqual(node.summary.open_degraded, 1, '> 2 h → a sticky degraded finding');
    ({ node } = S.applyActive(node, res([]), { obs_t: t(135), generation: 1 }));
    const f1 = Object.values(node.findings)[0];
    assert.deepStrictEqual([node.timers, f1.condition, node.summary.open_degraded], [{}, 'cleared', 1], 'repaired / removed → timer closed, finding cleared but OPEN');
    ({ node } = S.applyActive(node, res(['P']), { obs_t: t(150), generation: 1 }));
    assert.deepStrictEqual(node.timers, { P: t(150) }, 'reappears → a NEW timer');
    ({ node } = S.applyActive(node, res(['P']), { obs_t: t(271), generation: 1 }));
    assert.deepStrictEqual([Object.keys(node.findings).length, node.summary.open_degraded], [2, 2], '… and after 2 h a NEW finding');
  }
  ok('§4 degraded pairs: a timer opens on first sight; > 2 h (not exactly 2 h) opens a sticky degraded finding; repaired → timer closed + condition cleared (still open); reappearance → a new timer and, after 2 h, a new finding');

  // ── 7. deferrals, backoff, scheduling ────────────────────────────────────────────────────────────────────────────
  {
    const t = (min) => S.fromMs(1_800_000_000_000 + min * 60000);
    let node = S.deferActive(null, { obs_t: t(0), runId: 'r1' });
    node = S.deferActive(node, { obs_t: t(1), runId: 'r1' });
    assert.deepStrictEqual([node.coverage.active_streak, node.coverage.first_active_deferral_obs_t, node.coverage.failures], [1, t(0), undefined], 'a duplicate run does not double count; never a failure');
    node = S.deferActive(node, { obs_t: t(15), runId: 'r2' });
    assert.deepStrictEqual([node.coverage.active_streak, node.coverage.last_active_obs_t, node.coverage.retry_after], [2, t(15), undefined]);
    const now0 = 1_800_000_000_000;
    let f = S.deferFailure(null, { nowMs: now0, reason: 'x' });
    assert.deepStrictEqual([f.coverage.failures, f.coverage.retry_after - now0], [1, 30 * S.MIN]);
    f = S.deferFailure(f, { nowMs: now0, reason: 'x' }); assert.strictEqual(f.coverage.retry_after - now0, 60 * S.MIN);
    f = S.deferFailure(f, { nowMs: now0, reason: 'x' }); assert.strictEqual(f.coverage.retry_after - now0, 120 * S.MIN);
    f = S.deferFailure(f, { nowMs: now0, reason: 'x' }); assert.strictEqual(f.coverage.retry_after - now0, 120 * S.MIN, 'capped at 2 h');
    ({ node: f } = S.applyActive(f, { state: 'ok', findings: [], degradedPairs: [], coverage: true }, { obs_t: t(1), generation: 1 }));
    assert.deepStrictEqual([f.coverage.failures, f.coverage.retry_after], [0, undefined], 'a completed check resets the backoff');
    const views = [{ rid: 'b', coverage: { active_ok_obs_t: t(5) } }, { rid: 'a', coverage: { active_ok_obs_t: t(9) } }, { rid: 'c', coverage: {} },
      { rid: 'd', coverage: { active_ok_obs_t: t(1), retry_after: now0 + 1 } }];
    assert.deepStrictEqual(S.scheduleOrder(views, now0), ['c', 'b', 'a'], 'never checked first, then oldest active_ok; retry_after in the future skipped');
  }
  ok('§4 deferrals: merchant_active counts once per run id, never a failure / backoff; a failed / budget deferral backs off 30 → 60 → 120 → 120 min (min(15 min × 2^failures, 2 h)); a completed check resets it; scheduling = oldest coverage first, backed-off skipped');

  // ── 8. staleness timelines (§6) and the summary / heartbeat emitter ──────────────────────────────────────────────
  {
    const base = 1_800_000_000_000; const t = (min) => S.fromMs(base + min * 60000); const at = (min) => base + min * 60000;
    const st = (cov, min) => S.staleOf({ coverage: cov }, at(min));
    // activity deferrals alone: NO generic coverage-gap stale and no stale at 45, 105 or exactly 120 min elapsed; > 120 → merchant_active
    const streak = { first_enumerated_at: t(0), first_active_deferral_obs_t: t(0) };
    for (const m of [45, 105, 120]) assert.deepStrictEqual(st(streak, m), { stale: 0, reasons: [] }, `${m} min`);
    assert.deepStrictEqual(st(streak, 121), { stale: 1, reasons: ['merchant_active'] });
    // initially missing coverage timestamps: stale once first enumeration is > 45 min old
    assert.deepStrictEqual(st({ first_enumerated_at: t(0) }, 45).stale, 0);
    assert.deepStrictEqual(st({ first_enumerated_at: t(0) }, 46), { stale: 1, reasons: ['coverage_gap'] });
    assert.deepStrictEqual(st({ first_enumerated_at: t(0), active_ok_obs_t: t(40), audit_ok_obs_t: t(40) }, 85).stale, 0);
    assert.deepStrictEqual(st({ first_enumerated_at: t(0), active_ok_obs_t: t(40), audit_ok_obs_t: t(30) }, 76).reasons, ['coverage_gap'], 'either check');
    const ok0 = { first_enumerated_at: t(0), active_ok_obs_t: t(10), audit_ok_obs_t: t(10) };
    assert.deepStrictEqual(st({ ...ok0, backlog: 41 }, 11).reasons, ['backlog']);
    assert.deepStrictEqual(st({ ...ok0, backlog: 40 }, 11).stale, 0);
    assert.deepStrictEqual(st({ ...ok0, backlog: 3, backlog_since_ms: at(-111) }, 10).reasons, ['backlog_age'], 'backlog age > 2 h');
    assert.deepStrictEqual(st({ ...ok0, findings_count: 2001 }, 11).reasons, ['state_growth']);
    assert.deepStrictEqual(st({ ...ok0, node_bytes: 1024 * 1024 + 1 }, 11).reasons, ['state_growth']);
    const line = S.summaryLine('rid1', { coverage: ok0, summary: { open_violations: 2, open_gaps: 1, open_degraded: 0 } }, at(11));
    assert.deepStrictEqual(line, { event: 'identity_integrity_state', rid: 'rid1', open_violations: 2, open_gaps: 1, open_degraded: 0, stale: 0 });
    assert.deepStrictEqual(S.summaryLine('rid2', { coverage: {}, summary: null }, at(0)), { event: 'identity_integrity_state', rid: 'rid2', open_violations: 0, open_gaps: 0, open_degraded: 0, stale: 0 }, 'a never-processed restaurant still emits');
    assert.deepStrictEqual(S.heartbeatLine({ enumerated: 3, covered: 2 }), { event: 'identity_integrity_heartbeat', enumerated: 3, covered: 2 });
  }
  ok('§6 stale: activity deferrals alone never stale at 45 / 105 / exactly 120 min, stale{merchant_active} only past 120; missing timestamps stale after 45 min from first enumeration; either check older than 45 min; backlog > 40 / age > 2 h; state growth (findings > 2,000, node > 1 MiB); the summary line for processed and never-processed restaurants; the heartbeat line');

  // ── 9. boundary (§1), growth (§9), obs_t ─────────────────────────────────────────────────────────────────────────
  {
    const t = (min) => S.fromMs(1_800_000_000_000 + min * 60000);
    // boundary unknown: findings for every generation; a later rollout boundary relabels < G0 as pre_boundary, keeps ≥ G0
    let node = null;
    node = S.applyAuditPage({ audited_through: 0 }, { start: 1, end: 3, findings: [1, 2, 3].map((g) => C.finding('unattested', `g${g}`, { generation: g, reason: 'boundary_unknown' })), obs_t: t(0), current: 3 }).node;
    const r = S.setBoundary(node, { G0: 3, source: 'rollout_record' });
    const reasons = Object.values(r.node.findings).map((f) => [f.detail.generation, f.detail.reason]).sort();
    assert.deepStrictEqual(reasons, [[1, 'pre_boundary'], [2, 'pre_boundary'], [3, 'boundary_unknown']], 'relabelled, never deleted or downgraded');
    assert.strictEqual(Object.keys(r.node.findings).length, 3);
    assert.strictEqual(S.setBoundary(r.node, { G0: 1, source: 'onboarded' }).written, false, 'WRITE-ONCE');
    // delayed monitor deploy: boundary 100 (c2a deployed at 99), the monitor first runs at 105 → audits 100…105
    const d = S.setBoundary(null, { G0: 100, source: 'rollout_record' }).node;
    assert.strictEqual(d.audited_through, 99, 'audited_through initialised to G0 − 1');
    assert.strictEqual(S.applyAuditPage(d, { start: 100, end: 105, findings: [], obs_t: t(1), current: 105 }).node.audited_through, 105);
    // growth: the recorded size includes itself
    const sized = S.withSize({ findings: { a: { kind: 'x' } }, coverage: {} });
    assert.strictEqual(sized.coverage.node_bytes, Buffer.byteLength(JSON.stringify(sized)));
    // obs_t keeps full precision and orders lexicographically
    const a = S.obsT({ seconds: 1791000000, nanoseconds: 5 }); const b2 = S.obsT({ seconds: 1791000000, nanoseconds: 6 });
    assert.ok(a < b2 && a.endsWith('.000000005') && S.isObs(a));
    assert.throws(() => S.obsT({ seconds: -1, nanoseconds: 0 }));
  }
  ok('§1 boundary: WRITE-ONCE; boundary_unknown findings for g < G0 relabelled pre_boundary (kept), ≥ G0 keep their kind; delayed deploy (c2a at 99 → G0 100, first run at 105) audits 100…105 from audited_through = G0 − 1; §9 node_bytes = the serialized size; obs_t full precision, lexicographic');

  // ── 10. the read budget + pacing (§5) ────────────────────────────────────────────────────────────────────────────
  (async () => {
    // ── 11 (first, async): the quiet-period PRECHECK on fake snapshots — each signal ALONE, server time = the readTime ──
    {
      const { precheck } = require('./identity-integrity-monitor');
      const READ = 1_800_000_000_000;
      const ts = (ms) => ({ toMillis: () => ms, seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 });
      const fakeDb = (docs, calls) => {
        const ref = (p) => ({ path: p, collection: (c) => ({ doc: (d) => ref(`${p}/${c}/${d}`) }) });
        return { collection: (c) => ({ doc: (d) => ref(`${c}/${d}`) }),
          runTransaction: async (fn, opts) => { calls.push(opts); return fn({ getAll: async (...refs) => refs.map((r) => {
            const d = docs[r.path]; return { exists: !!d, data: () => (d ? d.data : undefined), updateTime: d ? ts(d.ut) : undefined, readTime: ts(READ) }; }) }); } };
      };
      const lockP = 'restaurants/r/meta/publish_lock'; const srcP = 'restaurants/r/meta/source'; const ptrP = 'restaurants/r/meta/active_version';
      const MIN = 60000; const old = READ - 60 * MIN; const recent = READ - 5 * MIN;
      const quiet = { [srcP]: { data: {}, ut: old }, [ptrP]: { data: { version: 'v', at: ts(old) }, ut: old } };
      const budget = createReadBudget({ perSecond: 100, now: () => 0, sleep: async () => {} });
      const run = async (docs) => { const calls = []; const r = await precheck(fakeDb(docs, calls), 'r', budget); return { ...r, calls }; };
      let r = await run(quiet);
      assert.deepStrictEqual([r.active, r.why, r.calls], [false, { lease: false, draft: false, pointer: false }, [{ readOnly: true }]], 'quiet; ONE read-only transaction');
      assert.strictEqual(r.obs_t, S.obsT(ts(READ)), 'server time = the snapshot readTime');
      r = await run({ ...quiet, [lockP]: { data: { owner_token: 't', expires_at: ts(READ + 30000) }, ut: old } });
      assert.deepStrictEqual([r.active, r.why], [true, { lease: true, draft: false, pointer: false }], 'a LIVE lease alone');
      r = await run({ ...quiet, [lockP]: { data: { owner_token: 't', expires_at: ts(READ - 1) }, ut: old } });
      assert.strictEqual(r.active, false, 'an EXPIRED lease is free');
      r = await run({ ...quiet, [lockP]: { data: { expires_at: ts(READ + 30000) }, ut: old } });
      assert.strictEqual(r.active, false, 'a lease without an owner token is free');
      r = await run({ ...quiet, [srcP]: { data: {}, ut: recent } });
      assert.deepStrictEqual([r.active, r.why], [true, { lease: false, draft: true, pointer: false }], 'a draft edited < 10 min ago alone');
      r = await run({ ...quiet, [srcP]: { data: {}, ut: READ - 10 * MIN } });
      assert.strictEqual(r.active, false, 'exactly 10 min ago is not < 10 min');
      r = await run({ ...quiet, [ptrP]: { data: { version: 'v', at: ts(recent) }, ut: old } });
      assert.deepStrictEqual([r.active, r.why], [true, { lease: false, draft: false, pointer: true }], 'the pointer\'s `at` moved < 10 min ago alone');
      r = await run({ ...quiet, [ptrP]: { data: { version: 'v', at: ts(old) }, ut: recent } });
      assert.strictEqual(r.active, true, 'or its document updateTime');
      const calls = []; r = await precheck(fakeDb({ ...quiet, [srcP]: { data: {}, ut: recent } }, calls), 'r', budget, 0);
      assert.strictEqual(r.active, false, 'the window is a parameter (0 = disabled)');
    }
    ok('§4 quiet-period precheck (fake snapshots): ONE read-only getAll; server time = the snapshot readTime; a live lease, a draft edited < 10 min ago, and a pointer moved < 10 min ago (its `at` or its updateTime) EACH alone defer; an expired / ownerless lease and exactly 10 min do not');

    let clock = 0;
    const b = createReadBudget({ cap: 300, perSecond: 100, now: () => clock, sleep: async (ms) => { clock += ms; } });
    for (let i = 0; i < 12; i += 1) { b.reserve(25, 'objects'); await b.pace(25); }
    assert.throws(() => b.reserve(1, 'x'), (e) => e.budgetDeferral === true && /budget_deferred_x/.test(e.message), 'the run cap refuses BEFORE the read is issued');
    // ≤ 100 reads in EVERY 1 s window (a sliding window: no initial burst)
    for (const [t0] of b.log) {
      const inWindow = b.log.filter(([t]) => t >= t0 && t < t0 + 1000).reduce((s, [, k]) => s + k, 0);
      assert.ok(inWindow <= 100, `${inWindow} reads in the 1 s window from ${t0}`);
    }
    assert.ok(clock >= 2000, `300 reads take ≥ 2 s of (virtual) time at ≤ 100 per 1 s window (${clock} ms)`);
    ok(`§5 read budget: reserved before issue against the run cap (BudgetDeferral at the boundary); pacing ≤ 100 reads in every 1 s window (300 reads → ${clock} ms)`);
    console.log(`identity-integrity: OK (${n})`);
  })().catch((e) => { console.error('identity-integrity FAILED:', e); process.exit(1); });
} catch (e) {
  console.error('identity-integrity FAILED:', e);
  process.exit(1);
}
