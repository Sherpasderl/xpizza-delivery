'use strict';
// 1D D4-c2a — the PURE half of the binding evidence (PLAN-D4c2a rev 9 §2–§5): the closed-class encoder, the bounded
// header projection, the builders, the size bounds (incl. the INSTALLED protobuf schema), the collision translation
// and totality. The real writers, the emulator commits and the no-state-change proofs are in
// test/c2a-evidence.emulator.test.js.
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const g = require('@google-cloud/firestore');
const { ENC, H, D, DS, CLS, CLASSES } = require('./evidence-encoding');
const E = require('./identity-evidence');
const { encodeKey } = require('./identity-registry');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const offline = new g.Firestore({ projectId: 'xpizza-delivery' });   // never connects: used only to BUILD refs/writes

try {
  // ── 1. every tag, every exceptional class, -0 / NaN, nesting, key order ─────────────────────────────────────────
  {
    const cases = [
      ['abc', '["s","abc"]'], ['', '["s",""]'], [undefined, '["u"]'], [null, '["n"]'], [true, '["b",1]'], [false, '["b",0]'],
      [0, '["i","0"]'], [42, '["i","42"]'], [-7, '["i","-7"]'], [Number.MAX_SAFE_INTEGER, `["i","${Number.MAX_SAFE_INTEGER}"]`],
      [-0, '["o","number"]'], [NaN, '["o","number"]'], [Infinity, '["o","number"]'], [-Infinity, '["o","number"]'], [1.5, '["o","number"]'],
      [Number.MAX_SAFE_INTEGER + 1, '["o","number"]'], [10n, '["o","number"]'],
      [g.Timestamp.fromMillis(1), '["o","timestamp"]'], [new g.GeoPoint(1, 2), '["o","geopoint"]'], [offline.doc('a/b'), '["o","reference"]'],
      [g.FieldValue.vector([1, 2]), '["o","vector"]'], [Buffer.from('x'), '["o","bytes"]'], [new Uint8Array(2), '["o","bytes"]'],
      [new Date(0), '["o","object"]'], [new Map([[1, 2]]), '["o","object"]'], [new Set([1]), '["o","object"]'], [new (class X {})(), '["o","object"]'],
      [() => 1, '["o","other"]'], [Symbol('s'), '["o","other"]'], [g.FieldValue.serverTimestamp(), '["o","object"]'],
      [[], '["a",[]]'], [[1, 'a', null], '["a",[["i","1"],["s","a"],["n"]]]'], [{}, '["m",[]]'],
      [{ b: 1, a: 'x' }, '["m",[["a",["s","x"]],["b",["i","1"]]]]'],
      [{ a: undefined }, '["m",[["a",["u"]]]]'],
      [Object.assign(Object.create(null), { z: 1 }), '["m",[["z",["i","1"]]]]'],
      [{ m: { n: [{ o: false }] } }, '["m",[["m",["m",[["n",["a",[["m",[["o",["b",0]]]]]]]]]]]]'],
    ];
    cases.forEach(([v, want], i) => assert.strictEqual(ENC(v), want, `ENC case #${i}`));
    // UTF-16 code-unit key order (not locale, not code-point): 'B' (0x42) < 'a' (0x61) < 'é' (0xE9) < '\uD83D…' (surrogate) < '\uFF21'
    assert.strictEqual(ENC({ '\uFF21': 1, '😀': 2, é: 3, a: 4, B: 5 }), '["m",[["B",["i","5"]],["a",["i","4"]],["é",["i","3"]],["😀",["i","2"]],["Ａ",["i","1"]]]]');
    // classes are a closed enum
    assert.deepStrictEqual([...CLASSES].sort(), ['bytes', 'geopoint', 'number', 'object', 'other', 'reference', 'timestamp', 'vector']);
  }
  ok('ENC: every exact tag (s/u/n/b/i), every exceptional class (number incl. -0/NaN/±Infinity/fractional/unsafe/bigint, timestamp, bytes, reference, vector, geopoint, object, other), arrays, plain + null-prototype maps, nesting, and UTF-16 key order');

  // ── 2. totality: getters that throw, Proxies, cycles, depth — never throws, collapses to ["o","other"] ───────────
  {
    const throwing = {}; Object.defineProperty(throwing, 'x', { enumerable: true, get() { throw new Error('boom'); } });
    const proxy = new Proxy({}, { ownKeys() { throw new Error('trap'); }, getPrototypeOf() { throw new Error('trap'); } });
    const cyc = { a: 1 }; cyc.self = cyc;
    let deep = 'leaf'; for (let i = 0; i < 200; i += 1) deep = { d: deep };
    for (const v of [throwing, proxy, cyc, deep, [cyc], { p: proxy }]) assert.doesNotThrow(() => ENC(v));
    assert.strictEqual(ENC(throwing), '["m",[["x",["o","other"]]]]');
    assert.strictEqual(ENC(proxy), '["o","other"]');
    assert.strictEqual(ENC(cyc), '["m",[["a",["i","1"]],["self",["o","other"]]]]', 'a cycle is classified at its FIRST revisit, not walked to the depth bound');
    assert.ok(ENC(deep).includes('["o","other"]'), 'beyond the depth bound the value is classified');
    for (const v of [throwing, proxy, cyc, deep, -0, NaN, undefined, Symbol('x')]) assert.doesNotThrow(() => CLS(v));
  }
  ok('totality: a throwing getter, a hostile Proxy, a cycle and a 200-deep value each ENCODE without throwing (collapsed to ["o","other"])');

  // ── 3. independent recomputation: a second, separately written encoder agrees on a random corpus ────────────────
  {
    const ref = (v) => {   // written from the plan text alone, structurally different (string building, explicit stack-free recursion)
      if (v === undefined) return '["u"]';
      if (v === null) return '["n"]';
      switch (typeof v) {
        case 'string': return `["s",${JSON.stringify(v)}]`;
        case 'boolean': return `["b",${v ? 1 : 0}]`;
        case 'number': return (Number.isSafeInteger(v) && !(v === 0 && 1 / v < 0)) ? `["i","${v}"]` : '["o","number"]';
        default: break;
      }
      if (Array.isArray(v)) return `["a",[${v.map(ref).join(',')}]]`;
      const ks = Object.keys(v).sort();
      return `["m",[${ks.map((k) => `[${JSON.stringify(k)},${ref(v[k])}]`).join(',')}]]`;
    };
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const gen = (depth) => {
      const r = rnd();
      if (depth > 3 || r < 0.35) {
        const leaves = [() => `k${Math.floor(rnd() * 1000)}`, () => Math.floor(rnd() * 1e6) - 5e5, () => rnd() < 0.5, () => null, () => undefined, () => rnd() * 3, () => -0, () => 'é😀\u0000"\\'];
        return leaves[Math.floor(rnd() * leaves.length)]();
      }
      if (r < 0.6) return Array.from({ length: Math.floor(rnd() * 4) }, () => gen(depth + 1));
      const o = {}; for (let i = 0; i < Math.floor(rnd() * 4); i += 1) o[`f${Math.floor(rnd() * 9)}`] = gen(depth + 1); return o;
    };
    for (let i = 0; i < 2000; i += 1) { const v = gen(0); assert.strictEqual(ENC(v), ref(v), `corpus #${i}: ${JSON.stringify(v)}`); }
  }
  ok('independent recomputation: a separately written reference encoder agrees with ENC on 2,000 random nested values (incl. -0, fractions, unicode, control chars)');

  // ── 4. H / D / DS / CLS ─────────────────────────────────────────────────────────────────────────────────────────
  {
    assert.strictEqual(H('abc'), crypto.createHash('sha256').update('abc').digest('base64url'));
    assert.strictEqual(H('abc').length, 43);
    assert.strictEqual(D({ a: 1 }), H('["m",[["a",["i","1"]]]]'));
    const a = [{ x: 1 }, { x: 2 }, 'z', null];
    assert.strictEqual(DS(a), DS(a.slice().reverse()), 'a set digest is independent of order');
    assert.notStrictEqual(DS(a), DS(a.slice(1)), 'and sensitive to membership');
    assert.strictEqual(DS([]), H('["a",[]]'));
    const want = [[5, 5], [0, 0], [undefined, 'o:absent'], [null, 'o:null'], ['7', 'o:string'], [true, 'o:boolean'], [-1, 'o:number'], [-0, 'o:number'],
      [1.5, 'o:number'], [NaN, 'o:number'], [Number.MAX_SAFE_INTEGER + 2, 'o:number'], [{}, 'o:object'], [[], 'o:object'], [g.Timestamp.now(), 'o:timestamp'],
      [offline.doc('a/b'), 'o:reference'], [Buffer.from('x'), 'o:bytes']];
    for (const [x, y] of want) assert.strictEqual(CLS(x), y, `CLS(${String(x)})`);
    for (const [x] of want) { const c = CLS(x); assert.ok(typeof c === 'number' || c.length <= 12, `CLS output bounded (${c})`); }
  }
  ok('H = base64url(sha256) (43 chars); D = H(ENC); DS is order-free and membership-sensitive; CLS keeps safe non-negative ints and records everything else as a ≤ 12-char "o:<class>"');

  // ── 5. builders: header projection, no undefined, field inventory, digests ─────────────────────────────────────
  const snap = (docs) => ({ docs: docs.map(([id, data]) => ({ id, data: () => data })) });
  const sample = (over = {}) => ({
    versionId: 'v-1791000000000-abcdefabcdef', generation: 7, intent: 'publish',
    record: { content_hash: 'h'.repeat(64), seq: 12, identity_revision: 2 },
    docs: { dish: snap([['d1', { key: 'Margherita', display: { identity_id: 'ID_MARG' } }], ['d2', { key: 'New Dish', display: {} }]]),
      extra: snap([['e1', { key: 'Queso', display: { identity_id: 'ID_QUESO' } }]]) },
    docIdByKey: { dish: new Map([['Margherita', 'd1'], ['New Dish', 'd2']]), extra: new Map([['Queso', 'e1']]) },
    minted: { dish: new Map([['New Dish', 'ID_NEW']]), extra: new Map() },
    registry: { dish: new Map([['Margherita', { keyRowId: 'ID_MARG' }], ['New Dish', { keyRowId: null }]]), extra: new Map([['Queso', { keyRowId: 'ID_QUESO' }]]) },
    fullIds: { dish: new Map([['ID_MARG', { legacy_key: 'Margherita', status: 'live', kind: 'dish', created_at: 1 }]]), extra: new Map([['ID_QUESO', { legacy_key: 'Queso', status: 'live' }]]) },
    fullKeys: { dish: new Map([[encodeKey('Margherita'), { canonical_id: 'ID_MARG', kind: 'dish', created_at: 5 }]]), extra: new Map() },
    judged: { stamps: [{ kind: 'dish', key: 'Margherita', claimedId: 'ID_MARG', verdict: { ok: true, code: 'verified' } },
      { kind: 'extra', key: 'Queso', claimedId: 'ID_QUESO', verdict: { ok: true, code: 'verified' } }] },
    relocated: new Set(),
    plans: { dish: { source: 'verify', plan: { moves: [], mints: [{ id: 'ID_NEW', name: 'New Dish' }], retires: [] }, verified: { lands: [{ id: 'ID_NEW', name: 'New Dish', via: 'mint' }], releases: [], deletions: [] } },
      extra: { source: 'derived', plan: { moves: [], mints: [], retires: [] } } },
    ...over,
  });
  const noUndefined = (v, at = '$') => {
    if (v === undefined) throw new Error(`undefined at ${at}`);
    if (v && typeof v === 'object' && !(v instanceof g.FieldValue)) for (const [k, x] of Object.entries(v)) noUndefined(x, `${at}.${k}`);
  };
  const ACTIVATION_FIELDS = ['v', 'certified', 'vid', 'generation', 'intent', 'ch', 'seq_c', 'rev_c', 'final_digest', 'final_count', 'stampmap_digest', 'stampmap_counts',
    'relocated_count', 'observed_digest', 'plan'];
  {
    const ev = E.buildActivationEvidence(sample());
    assert.deepStrictEqual(Object.keys(ev.data).sort(), ACTIVATION_FIELDS.slice().sort());
    noUndefined(ev.data);
    assert.strictEqual(ev.data.vid, H('v-1791000000000-abcdefabcdef'));
    assert.ok(!JSON.stringify(ev.data).includes('v-1791000000000-abcdefabcdef') && !JSON.stringify(ev.data).includes('h'.repeat(64)), 'no raw versionId or content_hash in the payload');
    assert.strictEqual(ev.data.generation, 7); assert.strictEqual(ev.data.seq_c, 12); assert.strictEqual(ev.data.rev_c, 2);
    assert.strictEqual(ev.data.ch, D('h'.repeat(64)));
    assert.strictEqual(ev.data.certified, true);
    assert.strictEqual(ev.docId, 'g00000000000000000007', 'generation-keyed id, no version in it (rev 11 §2)');
    // final = the stamps AND the mint write-back (d2 carries ID_NEW once committed)
    assert.strictEqual(ev.data.final_count, 3);
    assert.strictEqual(ev.data.final_digest, DS([{ k: 'dish', c: 'ID_MARG', n: 'Margherita', o: 'd1' }, { k: 'dish', c: 'ID_NEW', n: 'New Dish', o: 'd2' }, { k: 'extra', c: 'ID_QUESO', n: 'Queso', o: 'e1' }]));
    // …which is EXACTLY what c2b recomputes from the committed docs
    const committed = { dishDocs: snap([['d1', { key: 'Margherita', display: { identity_id: 'ID_MARG' } }], ['d2', { key: 'New Dish', display: { identity_id: 'ID_NEW' } }]]).docs,
      extraDocs: snap([['e1', { key: 'Queso', display: { identity_id: 'ID_QUESO' } }]]).docs };
    assert.deepStrictEqual(E.finalDigestOfVersion(committed), { final_digest: ev.data.final_digest, final_count: 3 });
    assert.deepStrictEqual(ev.data.stampmap_counts, { verified: 2 });
    assert.strictEqual(ev.data.relocated_count, 0);
    assert.deepStrictEqual(ev.data.plan.dish, { mints: 1, moves: 0, restores: 0, retires: 0, deletions: 0, verified: true, plan_digest: ev.data.plan.dish.plan_digest });
    assert.deepStrictEqual(ev.data.plan.extra, { mints: 0, moves: 0, restores: 0, retires: 0, deletions: 0, verified: false, plan_digest: D({ source: 'derived', moves: DS([]), mints: DS([]), retires: DS([]) }) });
    // observed_digest EXACTLY, built here from the plan's definition (§2): per candidate object {k, o, id_row at THAT object's id
    // (a mint: absent from the pre-write map), key_row at encodeKey(key), other_kind_id_row, sm_id_row at the KEY ROW's id}
    const MARG = { legacy_key: 'Margherita', status: 'live', kind: 'dish' };
    const QUESO = { legacy_key: 'Queso', status: 'live', kind: undefined };
    assert.strictEqual(ev.data.observed_digest, DS([
      { k: 'dish', o: 'd1', id_row: { addr: 'ID_MARG', data: MARG }, key_row: { addr: encodeKey('Margherita'), data: { canonical_id: 'ID_MARG', kind: 'dish' } },
        other_kind_id_row: { addr: 'ID_MARG', absent: true }, sm_id_row: { addr: 'ID_MARG', data: MARG } },
      { k: 'dish', o: 'd2', id_row: { addr: 'ID_NEW', absent: true }, key_row: { addr: encodeKey('New Dish'), absent: true },
        other_kind_id_row: { addr: 'ID_NEW', absent: true }, sm_id_row: { addr: { none: true }, absent: true } },
      { k: 'extra', o: 'e1', id_row: { addr: 'ID_QUESO', data: QUESO }, key_row: { addr: encodeKey('Queso'), absent: true },
        other_kind_id_row: { addr: 'ID_QUESO', absent: true }, sm_id_row: { addr: 'ID_QUESO', data: QUESO } },
    ]), 'observed_digest = the plan\'s definition, exactly');
    // B02: a DUPLICATE-key doc that is NOT the mint write-back target keeps its own (absent) stamp — exactly what commits
    const dup = sample(); dup.docs.dish = snap([['d1', { key: 'Margherita', display: { identity_id: 'ID_MARG' } }], ['d2', { key: 'New Dish', display: {} }], ['d3', { key: 'New Dish', display: {} }]]);
    const dupEv = E.buildActivationEvidence(dup);
    assert.strictEqual(dupEv.data.final_count, 3, 'only the write-back doc (d2) carries the mint; d3 stays unstamped');
    assert.strictEqual(dupEv.data.final_digest, ev.data.final_digest);
    // an observed-row change (not a timestamp) changes observed_digest; a timestamp/metadata change does not
    const s2 = sample(); s2.fullIds.dish.get('ID_MARG').created_at = 999;
    assert.strictEqual(E.buildActivationEvidence(s2).data.observed_digest, ev.data.observed_digest, 'metadata is NOT digested');
    const s3 = sample(); s3.fullIds.dish.get('ID_MARG').status = 'retired';
    assert.notStrictEqual(E.buildActivationEvidence(s3).data.observed_digest, ev.data.observed_digest, 'the judged fields ARE');
    const s4 = sample(); delete s4.fullIds.extra.get('ID_QUESO').kind;
    assert.strictEqual(E.buildActivationEvidence(s4).data.observed_digest, ev.data.observed_digest, 'an absent kind stays absent (["u"])');
  }
  ok('activation evidence: exactly the 15 payload fields (+ at) incl. certified:true, generation-keyed id g{G20}, never undefined; vid = H(versionId) and no raw versionId/content_hash; final includes the mint write-back and EQUALS c2b\'s recomputation from the committed docs; stamp verdict counts; a verified mint plan vs the EMPTY derived plan (verified:false); observed digests the judged fields, not metadata');

  // ── 6. rollback shapes: relocated refusals, missing key row ({none:true}), reconciliation plan ──────────────────
  {
    const rb = sample({ intent: 'rollback',
      registry: { dish: new Map([['Margherita', { keyRowId: null }], ['New Dish', { keyRowId: 'OTHER' }]]), extra: new Map([['Queso', { keyRowId: 'ID_QUESO' }]]) },
      judged: { stamps: [{ kind: 'dish', key: 'Margherita', claimedId: 'ID_MARG', verdict: { ok: false, code: 'stamp_unregistered' } },
        { kind: 'extra', key: 'Queso', claimedId: 'ID_QUESO', verdict: { ok: false, code: 'stamp_registry_disagrees' } }] },
      relocated: new Set(['stamp_unregistered', 'stamp_registry_disagrees']),
      minted: { dish: new Map(), extra: new Map() },
      plans: { dish: { source: 'reconcile', rec: { restores: [{ id: 'ID_MARG', name: 'Margherita' }], retires: [{ id: 'X', name: 'Old', why: 'residue' }], deletions: [{ name: 'Old', encoded: 'Old', id: 'X' }] } },
        extra: { source: 'reconcile', rec: { restores: [], retires: [], deletions: [] } } } });
    const ev = E.buildActivationEvidence(rb);
    assert.strictEqual(ev.data.intent, 'rollback');
    assert.strictEqual(ev.data.relocated_count, 2);
    assert.deepStrictEqual(ev.data.stampmap_counts, { stamp_unregistered: 1, stamp_registry_disagrees: 1 });
    assert.strictEqual(ev.data.stampmap_digest, DS([{ k: 'dish', o: 'd1', addr: { none: true }, code: 'stamp_unregistered', relocated: true },
      { k: 'extra', o: 'e1', addr: 'ID_QUESO', code: 'stamp_registry_disagrees', relocated: true }]));
    assert.deepStrictEqual({ ...ev.data.plan.dish, plan_digest: 0 }, { mints: 0, moves: 0, restores: 1, retires: 1, deletions: 1, verified: true, plan_digest: 0 });
    assert.strictEqual(ev.data.plan.extra.verified, true, 'a no-op reconciliation (captured before the :837 continue) is still a computed reconciliation');
    // an unrecognised verdict code is bucketed, so the counts map stays ≤ 9 keys
    const odd = sample({ judged: { stamps: [{ kind: 'dish', key: 'Margherita', verdict: { ok: false, code: 'something_new' } }] } });
    assert.deepStrictEqual(E.buildActivationEvidence(odd).data.stampmap_counts, { unrecognised: 1 });
    assert.ok(E.STAMP_CODES.length + 1 <= 12);
  }
  ok('rollback evidence: relocated refusals counted; a missing key row is addressed {none:true}; the reconciliation plan (restores/retires/deletions) is recorded verified:true incl. the no-op kind; unknown verdict codes bucket so the counts map stays ≤ 9 keys');

  // ── 7. totality of the BUILDERS on hostile/malformed inputs (owner rule 1) ─────────────────────────────────────
  {
    const junk = [undefined, null, 0, 'x', [], {}, { docs: 'no' }, { docs: [null, 1, { id: 1 }, { id: 'a', data: () => { throw new Error('x'); } }] }];
    let built = 0;
    for (const j of junk) {
      for (const field of ['record', 'docs', 'docIdByKey', 'minted', 'registry', 'fullIds', 'fullKeys', 'judged', 'relocated', 'plans']) {
        const inp = sample(); inp[field] = j;
        const ev = E.buildActivationEvidence(inp); noUndefined(ev.data); built += 1;
      }
      assert.doesNotThrow(() => E.buildCertificationEvidence({ versionId: j, observedGeneration: j, revisionAfter: j, record: j, objects: j, liveByKey: j, keyRowIdOf: j }));
    }
    for (const rec of [{ content_hash: 'x'.repeat(20000), seq: -1, identity_revision: 'two' }, { content_hash: { a: [1] }, seq: 1.5, identity_revision: null }, {}]) {
      const ev = E.buildActivationEvidence(sample({ record: rec }));
      assert.strictEqual(ev.data.ch.length, 43, 'ch is a digest whatever content_hash is (20,000 bytes / a map / absent)');
      assert.ok(typeof ev.data.seq_c === 'number' || /^o:/.test(ev.data.seq_c));
      assert.ok(typeof ev.data.rev_c === 'number' || /^o:/.test(ev.data.rev_c));
      noUndefined(ev.data);
    }
    assert.strictEqual(E.buildActivationEvidence(sample({ record: {} })).data.seq_c, 'o:absent');
    assert.strictEqual(E.buildActivationEvidence(sample({ record: { identity_revision: 'two' } })).data.rev_c, 'o:string');
    ok(`builders are TOTAL: ${built} activation builds over hostile inputs (null/scalars/wrong containers/throwing data()) and the certification builder never throw nor emit undefined; a 20,000-byte / map / absent content_hash and malformed seq/revision are recorded (digest / "o:<class>"), never refused`);
  }

  // ── 8. certification evidence ──────────────────────────────────────────────────────────────────────────────────
  {
    const c = E.buildCertificationEvidence({ versionId: 'v-9', observedGeneration: 4, revisionAfter: 1, record: { content_hash: 'abc' },
      objects: { dish: [{ id: 'd1', key: 'Margherita', canonical_id: 'ID_MARG' }], extra: [{ id: 'e1', key: 'Queso', canonical_id: 'ID_QUESO' }] },
      liveByKey: { dish: new Map([['Margherita', ['ID_MARG']]]), extra: new Map([['Queso', ['ID_QUESO']]]) },
      keyRowIdOf: new Map([['dish/Margherita', 'ID_MARG']]) });
    assert.deepStrictEqual(Object.keys(c.data).sort(), ['certified', 'ch', 'checks_count', 'checks_digest', 'final_count', 'final_digest', 'kind', 'observed_generation', 'rev_c', 'v', 'vid']);
    assert.strictEqual(c.data.certified, true);
    assert.strictEqual(c.data.kind, 'certify'); assert.strictEqual(c.data.rev_c, 1); assert.strictEqual(c.data.observed_generation, 4);
    assert.strictEqual(c.docId, 'c00000000000000000004_00000000000000000001', 'c{G20(observed_generation)}_{G20(rev)} (rev 11 §3)');
    assert.strictEqual(c.data.checks_digest, DS([{ k: 'dish', n: 'Margherita', claimants: ['ID_MARG'], key_row_canonical_id: 'ID_MARG' },
      { k: 'extra', n: 'Queso', claimants: ['ID_QUESO'], key_row_canonical_id: { absent: true } }]));
    assert.strictEqual(c.data.final_count, 2);
    const unsorted = E.buildCertificationEvidence({ versionId: 'v-9', observedGeneration: 4, revisionAfter: 1, record: {},
      objects: { dish: [{ id: 'd1', key: 'Margherita', canonical_id: 'ID_MARG' }] }, liveByKey: { dish: new Map([['Margherita', ['ZZ', 'AA', 'MM']]]) }, keyRowIdOf: new Map() });
    assert.strictEqual(unsorted.data.checks_digest, DS([{ k: 'dish', n: 'Margherita', claimants: ['AA', 'MM', 'ZZ'], key_row_canonical_id: { absent: true } }]), 'claimants are SORTED in the digest');
  }
  ok('certification evidence: header {v, kind:certify, vid, observed_generation, rev_c, ch}, final over the stamped objects, checks_digest over claimants + key rows (an absent key row tagged {absent:true})');

  // ── 9. the field inventory = the index exemptions = the firestore.indexes.json overrides ───────────────────────
  {
    const cert = ['v', 'kind', 'certified', 'vid', 'observed_generation', 'rev_c', 'ch', 'final_digest', 'final_count', 'checks_digest', 'checks_count'];
    const MINIMAL = ['v', 'certified', 'vid', 'generation', 'intent', 'ch', 'seq_c', 'rev_c'];
    const all = new Set([...ACTIVATION_FIELDS, ...cert, ...MINIMAL, 'at']);
    assert.deepStrictEqual([...all].sort(), [...E.EVIDENCE_FIELDS, E.INDEXED_FIELD].sort(), 'EVIDENCE_FIELDS ∪ {vid} = exactly the fields the builders emit');
    assert.ok(!E.EVIDENCE_FIELDS.includes('vid'), 'vid is the ONE indexed field (§2b)');
    const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firestore.indexes.json'), 'utf8'));
    const mine = file.fieldOverrides.filter((o) => o.collectionGroup === E.EVIDENCE_COL);
    assert.deepStrictEqual(mine, E.evidenceFieldOverrides(), 'firestore.indexes.json carries exactly the evidence overrides');
    assert.deepStrictEqual(mine.filter((o) => o.indexes.length), [{ collectionGroup: 'identity_evidence', fieldPath: 'vid', indexes: [{ order: 'ASCENDING', queryScope: 'COLLECTION' }] }], 'exactly ONE indexed field: vid, ascending, collection scope');
    assert.ok(mine.filter((o) => !o.indexes.length).length === E.EVIDENCE_FIELDS.length, 'every other field a full exemption');
    assert.deepStrictEqual(file.indexes, [], 'no composite index added');
  }
  ok(`index contract: EVIDENCE_FIELDS (${E.EVIDENCE_FIELDS.length} exempt) ∪ {vid} = exactly the fields the builders emit (full, certification, minimal); firestore.indexes.json carries exactly these overrides — every field exempt except vid, which keeps ONE ascending collection-scope index (one index entry per evidence doc, §2b)`);

  // ── 10. SIZE: Firestore storage-size arithmetic at maximum values, cases A (rid 40 B) and B (rid 1,500 B) ───────
  // Firestore rules: string = UTF-8 + 1; int / double / timestamp = 8; bool = 1; null = 1; field = name + 1 + value;
  // map = Σ fields + 32 (plan §2); doc = name + fields + 32; name = path bytes + 16.
  const sizeOf = (v) => {
    if (typeof v === 'string') return Buffer.byteLength(v, 'utf8') + 1;
    if (typeof v === 'number') return 8;
    if (typeof v === 'boolean' || v === null) return 1;
    if (v instanceof g.FieldValue) return 8;
    return Object.entries(v).reduce((s, [k, x]) => s + Buffer.byteLength(k) + 1 + sizeOf(x), 0) + 32;
  };
  const maxActivation = () => {
    const ev = E.buildActivationEvidence(sample({ generation: Number.MAX_SAFE_INTEGER, record: { content_hash: 'x'.repeat(20000), seq: 'bad', identity_revision: offline.doc('a/b') } }));
    // the counts map at its PLAN bound: twelve maximum-length verdict keys, each a max int
    const longest = 'stamp_id_claims_other_name';
    ev.data.stampmap_counts = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`${longest.slice(0, -2)}${String(i).padStart(2, '0')}`, Number.MAX_SAFE_INTEGER]));
    assert.strictEqual(Object.keys(ev.data.stampmap_counts).length, 12); assert.ok(Object.keys(ev.data.stampmap_counts).every((k) => k.length === longest.length));
    for (const k of ['final_count', 'relocated_count']) ev.data[k] = Number.MAX_SAFE_INTEGER;
    for (const kind of ['dish', 'extra']) for (const f of ['mints', 'moves', 'restores', 'retires', 'deletions']) ev.data.plan[kind][f] = Number.MAX_SAFE_INTEGER;
    ev.data.seq_c = 'o:reference'; ev.data.rev_c = 'o:timestamp';
    return ev;
  };
  {
    const ev = maxActivation();
    const fields = sizeOf(E.withAt(ev.data)) - 32;
    assert.ok(fields <= 1397, `activation fields ${fields} B ≤ 1,397 B (plan rev 12 §2)`);
    const docName = (rid) => Buffer.byteLength(`restaurants/${rid}/identity_evidence/${ev.docId}`) + 16;
    const A = fields + docName('r'.repeat(40)) + 32;
    const B = fields + docName('r'.repeat(1500)) + 32;
    assert.ok(A <= 1583 && B <= 3043, `doc A ${A} B ≤ 1,583 B; doc B ${B} B ≤ 3,043 B`);
    assert.strictEqual(ev.docId.length, 21, `activation id is a fixed 21 chars`);
    const ev1500 = E.buildActivationEvidence(sample({ versionId: 'v'.repeat(1500), generation: Number.MAX_SAFE_INTEGER }));
    assert.strictEqual(ev1500.docId.length, 21, 'a 1,500-byte versionId does not enter the id');
    const totalKeys = Object.keys(E.withAt(ev.data)).length + Object.keys(ev.data.stampmap_counts).length + 2 + 2 * 7;   // top-level (incl. at) + counts + plan kinds + per-kind
    assert.strictEqual(totalKeys, 44, '44 field/map entries at the bound');
    console.log(`     sizes: fields ${fields} B; doc A ${A} B; doc B ${B} B; id ${ev.docId.length} chars; 44 entries`);
  }
  ok('size at maximum values (20,000-byte content_hash → a 43-char digest, max ints, 12 max-length verdict keys, class strings, certified): fields ≤ 1,397 B; doc ≤ 1,583 B (A) / ≤ 3,043 B (B); 44 entries; fixed 21-char id even for a 1,500-byte versionId');

  // ── 11. REQUEST-SIZE Δ with the INSTALLED protobuf schema (plan §2 "Request bytes Δ") ──────────────────────────
  {
    /* The SAME descriptor the SDK's gRPC client loads (firestore_client.js: require('../../protos/v1.json')), through the
       installed protobufjs — i.e. the bytes the wire would carry, not an estimate. */
    const protobuf = require('protobufjs');
    const root = protobuf.Root.fromJSON(require(path.join(path.dirname(require.resolve('@google-cloud/firestore')), '..', 'protos', 'v1.json')));
    const CommitRequest = root.lookupType('google.firestore.v1.CommitRequest');
    const tenByte = (ev) => {   // the plan's conservative case: every integer a TEN-byte varint (-1), more than any real value costs
      const walk = (o) => { for (const k of Object.keys(o)) { if (typeof o[k] === 'number') o[k] = -1; else if (o[k] && typeof o[k] === 'object' && !(o[k] instanceof g.FieldValue)) walk(o[k]); } };
      walk(ev.data); return ev;
    };
    const minimal = () => tenByte(E.activationEvidenceDoc(null, { certified: false, versionId: 'v'.repeat(1500), generation: Number.MAX_SAFE_INTEGER, intent: 'rollback',
      record: { content_hash: 'x'.repeat(20000), seq: offline.doc('a/b'), identity_revision: g.Timestamp.now() } }));
    const deltaFor = (rid, make = () => tenByte(maxActivation())) => {
      const ev = make();
      const ref = offline.collection('restaurants').doc(rid).collection(E.EVIDENCE_COL).doc(ev.docId);
      const b = offline.batch(); b.create(ref, E.withAt(ev.data));
      const write = b._ops[0].op();                       // the SDK's own Write: name, fields, currentDocument.exists=false, REQUEST_TIME transform
      assert.deepStrictEqual(write.currentDocument, { exists: false });
      assert.deepStrictEqual(write.updateTransforms, [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }]);
      const base = { database: 'projects/xpizza-delivery/databases/(default)', transaction: Buffer.alloc(16, 1), writes: [] };
      const with1 = CommitRequest.encode(CommitRequest.fromObject({ ...base, writes: [write] })).finish().length;
      const without = CommitRequest.encode(CommitRequest.fromObject(base)).finish().length;
      return with1 - without;
    };
    const dA = deltaFor('r'.repeat(40)); const dB = deltaFor('r'.repeat(1500));
    assert.ok(dA <= 2048, `Δ(A) ${dA} B ≤ 2 KiB`); assert.ok(dB <= 8192, `Δ(B) ${dB} B ≤ 8 KiB`);
    const mA = deltaFor('r'.repeat(40), minimal); const mB = deltaFor('r'.repeat(1500), minimal);
    assert.ok(mA <= 1024, `minimal Δ(A) ${mA} B ≤ 1 KiB (§2a)`); assert.ok(mB <= 4096, `minimal Δ(B) ${mB} B ≤ 4 KiB (§2a)`);
    console.log(`     protobuf Δ (CommitRequest, installed schema, ten-byte varints): full A ${dA} B / B ${dB} B; minimal A ${mA} B / B ${mB} B`);
    ok(`request Δ serialized with the INSTALLED Firestore protobuf schema (the SDK's own Write incl. create precondition + REQUEST_TIME transform; maximum values, ten-byte varints): full A ${dA} B ≤ 2 KiB, B ${dB} B ≤ 8 KiB; §2a minimal A ${mA} B ≤ 1 KiB, B ${mB} B ≤ 4 KiB`);
  }

  // ── 12. collision translation: exactly ALREADY_EXISTS on an evidence path; everything else unchanged ──────────
  {
    const t = E.translateEvidenceCollision('flip_evidence_exists', 'r', 'v1');
    const hit = Object.assign(new Error('6 ALREADY_EXISTS: entity already exists: EntityRef[partitionRef=dev~p, path=/restaurants/r/identity_evidence/x__g1]'), { code: 6, details: 'entity already exists: EntityRef[partitionRef=dev~p, path=/restaurants/r/identity_evidence/x__g1]' });
    const prod = Object.assign(new Error('6 ALREADY_EXISTS: Document already exists: projects/p/databases/(default)/documents/restaurants/r/identity_evidence/x__g1'), { code: 6 });
    for (const e of [hit, prod]) {
      let got; try { t(e); } catch (x) { got = x; }
      assert.ok(/^flip_evidence_exists: r\/v1 — /.test(got.message) && got.cause === e, 'typed, with the original as cause');
    }
    const others = [Object.assign(new Error('6 ALREADY_EXISTS: …/restaurants/r/versions/v1'), { code: 6 }), Object.assign(new Error('10 ABORTED: …/identity_evidence/x'), { code: 10 }),
      new Error('flip_cas_stale: r'), Object.assign(new Error('x'), { code: 'already-exists', details: 'restaurants/r/ids_dish/x' })];
    for (const e of others) { let got; try { t(e); } catch (x) { got = x; } assert.strictEqual(got, e, `passed through unchanged: ${e.message}`); }
    assert.throws(() => t(undefined), (x) => x === undefined);
  }
  ok('collision translation: ALREADY_EXISTS on an identity_evidence path (emulator and production message shapes) → flip_evidence_exists with the cause kept; ALREADY_EXISTS elsewhere, ABORTED, and every other error re-thrown as the SAME object');

  // ── 13. rev 12 §2a: EVERY activation writes evidence — the minimal record for an uncertified one ───────────────
  {
    const m = E.activationEvidenceDoc(null, { certified: false, versionId: 'v-1791000000000-abcdefabcdef', generation: 3, intent: 'publish',
      record: { content_hash: 'h'.repeat(64), seq: 5 } });
    assert.strictEqual(m.docId, 'g00000000000000000003');
    assert.deepStrictEqual(Object.keys(m.data).sort(), ['certified', 'ch', 'generation', 'intent', 'rev_c', 'seq_c', 'v', 'vid']);
    assert.deepStrictEqual(m.data, { v: 1, certified: false, vid: H('v-1791000000000-abcdefabcdef'), generation: 3, intent: 'publish', ch: D('h'.repeat(64)), seq_c: 5, rev_c: 'o:absent' });
    noUndefined(m.data);
    assert.ok(sizeOf(E.withAt(m.data)) - 32 <= 260, 'minimal fields ≤ ~260 B (§2a)');
    const full = E.buildActivationEvidence(sample());
    assert.strictEqual(E.activationEvidenceDoc(full, { certified: true }), full, 'certified → the full record');
    assert.strictEqual(E.activationEvidenceDoc(null, { certified: true, versionId: 'v', generation: 1 }).data.certified, false, 'never null: a certified call with no built record still writes (minimal), so the sequence stays dense');
  }
  ok('rev 12 §2a: an UNCERTIFIED activation writes the MINIMAL record {v, certified:false, vid, generation, intent, ch, seq_c, rev_c} (+ at) at g{G20(gen)}, ≤ 260 B of fields; a certified one the full record');

  // ── 14. zero-padded ids: lexicographic order = numeric order ────────────────────────────────────────────────────
  {
    const gens = [0, 1, 2, 9, 10, 11, 99, 100, 101, 999999, 1000000, 2 ** 31, 2 ** 32 + 1, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER];
    for (let i = 0; i < 500; i += 1) gens.push(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
    const byNum = gens.slice().sort((a, b) => a - b).map(E.activationDocId);
    const byLex = gens.map(E.activationDocId).sort();
    assert.deepStrictEqual(byLex, byNum, 'activation ids');
    const pairs = gens.slice(0, 60).flatMap((o) => [0, 1, 7, 10, 123].map((r) => [o, r]));
    assert.deepStrictEqual(pairs.map(([o, r]) => E.certificationDocId(o, r)).sort(), pairs.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1]).map(([o, r]) => E.certificationDocId(o, r)), 'certification ids');
    assert.ok(gens.every((x) => E.activationDocId(x).length === 21) && E.certificationDocId(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).length === 42);
    // the §2b range prefix [c{G20(gen)}_, c{G20(gen)}_\uf8ff) contains exactly that generation's certifications
    const pre = `c${E.G20(10)}_`;
    assert.ok(E.certificationDocId(10, 3) >= pre && E.certificationDocId(10, 3) < `${pre}\uf8ff`);
    assert.ok(!(E.certificationDocId(100, 3) >= pre && E.certificationDocId(100, 3) < `${pre}\uf8ff`) && !(E.certificationDocId(1, 3) >= pre && E.certificationDocId(1, 3) < `${pre}\uf8ff`));
  }
  ok('zero-padded ids: for 515 generations (incl. 0, 9/10, 99/100, 2^31, 2^32+1, MAX_SAFE_INTEGER) lexicographic order = numeric order, for activation AND certification ids; fixed 21 / 42 chars; the c{G20(gen)}_ prefix range selects exactly that generation');

  console.log(`identity-evidence: OK (${n})`);
} catch (e) {
  console.error('identity-evidence FAILED:', e);
  process.exit(1);
}
