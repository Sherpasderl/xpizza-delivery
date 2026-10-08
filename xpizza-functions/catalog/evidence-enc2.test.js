'use strict';
// 1D D4-c2a rev 14 §2E — ENC2, the schema-specific record encoding of the binding evidence. Run: node catalog/evidence-enc2.test.js
//   1  the §2E.7 golden vectors, byte for byte
//   2  the EXHAUSTIVE enumerator (§2E.8 (1)) — a FAILING test: both directions, exact per-box counts, every field varied, coverage
//      stated per type; and its sensitivity cells (an extra distinction, a constant field) proven to FAIL it
//   3  a seeded adversarial random corpus; domain-tag separation between types
//   4  class collapse: exactly §2's, nothing new
//   5  set semantics and the sort rule, against an independently written preimage
//   6  totality on hostile inputs (§2E.8 (2)) through T / R / K / LIST directly; 7 the same through the COMPLETE builders
//   8  the shared `final` byte-length function (§2E.8 (4)), escape-heavy
//   9  the two-layer source-shape guard (§2E.8 (3)): producer schemas per branch + a sensitivity mutation; digest-input schemas
//  10  the REAL writers (publish / bootstrap / republish / mint / rollback on the in-memory Firestore): their producer records and
//      digest inputs satisfy both layers, and final_digest = the recomputation from the committed version docs
/* The spies are installed BEFORE the writers are loaded: catalog-publish.js and identity-bootstrap.js destructure the builders at
   require time, so they bind these wrappers (which call the real builders unchanged and record their inputs). */
const E = require('./identity-evidence');
const TAP = { on: false, act: [], cert: [] };   // records only during cell 10 (the real writers), never on the hostile cells
{
  const realAct = E.buildActivationEvidence; const realCert = E.buildCertificationEvidence;
  E.buildActivationEvidence = (inp) => {
    if (TAP.on) TAP.act.push({ inp, digest: E.activationDigestInputs(inp), plans: { dish: E.planDigestInputs(inp.plans.dish), extra: E.planDigestInputs(inp.plans.extra) },
      stamps: (inp.judged && inp.judged.stamps || []).map((s) => ({ ...s })) });
    return realAct(inp);
  };
  E.buildCertificationEvidence = (inp) => {
    if (TAP.on) TAP.cert.push({ inp, digest: E.certificationDigestInputs(inp), objects: { dish: inp.objects.dish.map((o) => ({ ...o })), extra: inp.objects.extra.map((o) => ({ ...o })) } });
    return realCert(inp);
  };
}
const assert = require('assert');
const crypto = require('crypto');
const ENC2 = require('./evidence-encoding');
const { ENC, H, L, A, R, K, LIST, TUPLES, TUPLE_FIELDS, ID_ROW_FIELDS, KEY_ROW_FIELDS, DS2, planDigest, frameOf, FINAL_FRAME_BYTES } = ENC2;
const { derivePlan } = require('./identity-derive');
const { verifyPlan } = require('./identity-plan');
const { reconcileOnRollback } = require('./identity-reconcile');
const { judgeStampMap } = require('./identity-stampmap');
const { encodeKey } = require('./identity-registry');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('evidence-enc2: FAILED — exited without completing'); process.exitCode = 1; } });

(async () => {
  // ── 1. golden vectors (§2E.7) ───────────────────────────────────────────────────────────────────────────────────
  {
    const G = {
      final: [{ k: 'dish', c: 'ID_MARG', n: 'Margherita', o: 'd1' }, '["dish","ID_MARG","Margherita","d1"]'],
      stampmap: [{ k: 'dish', o: 'd1', addr: { none: true }, code: 'stamp_unregistered', relocated: true }, '["dish","d1",null,"stamp_unregistered",["b",1]]'],
      observed: [{ k: 'extra', o: 'e1', id_row: { addr: 'ID_QUESO', data: { legacy_key: 'Queso', status: 'live' } }, key_row: { addr: 'UXVlc28', absent: true },
        other_kind_id_row: { addr: { none: true }, absent: true }, sm_id_row: { addr: 'ID_QUESO', data: 7 } },
      '["extra","e1",["ID_QUESO",1,"Queso","live",["u"]],["UXVlc28",0],[null,0],["ID_QUESO",2,["i","7"]]]'],
      check: [{ k: 'dish', n: 'Margherita', claimants: ['AA', 'ZZ'], key_row_canonical_id: { absent: true } }, '["dish","Margherita",["AA","ZZ"],null]'],
      move: [{ id: 'ID1', from: 'Old', to: 'New' }, '["ID1","Old","New"]'],
      mint: [{ id: 'ID2', name: 'Fresh "Dish" \\ é😀' }, '["ID2","Fresh \\"Dish\\" \\\\ é😀"]'],
      retire: [{ id: 'ID3', name: 'Gone', why: 'residue' }, '["ID3","Gone","residue"]'],
      restore: [{ id: 'ID4', name: 'Back', was: 'retired', resurrects: true }, '["ID4","Back","retired",["b",1]]'],
      deletion: [{ name: 'Gone', encoded: 'R29uZQ', id: 'ID3' }, '["Gone","R29uZQ","ID3"]'],
      land: [{ id: 'ID2', name: 'Fresh', via: 'mint' }, '["ID2","Fresh","mint"]'],
      release: [{ id: 'ID1', name: 'Old', via: 'move' }, '["ID1","Old","move"]'],
    };
    for (const [t, [rec, want]] of Object.entries(G)) assert.strictEqual(TUPLES[t](rec), want, `golden tuple ${t}`);
    assert.deepStrictEqual(Object.keys(G).sort(), Object.keys(TUPLES).sort(), 'every type has a golden tuple');
    assert.strictEqual(DS2('final', [G.final[0], { k: 'dish', c: 'ID_B', n: 'B', o: 'd2' }]), '_0YZQjMWKvZyDXZhY-mEiBKXIVzL6qpk0YUmCgeFe8Y');
    assert.strictEqual(DS2('final', []), 'WalVGcRR-lopqBydTbUBo8D7Z1mXY4Hq0WHMyE8sWIQ');
    assert.strictEqual(planDigest('derived', [DS2('move', []), DS2('mint', []), DS2('retire', [])]), 'L_MTI5ZkTsrspaoJzAvCPQjPtZjx7bkoB7hjXCa4DK8');
    assert.strictEqual(planDigest('none', []), 'Ufjq3Tm46htv5EWl-j7jikgM9bysLYuwi7SxnzqTzZM');
    // …and through the builder's own plan section
    assert.strictEqual(E.planSection({ source: 'derived', plan: { moves: [], mints: [], retires: [] } }).plan_digest, 'L_MTI5ZkTsrspaoJzAvCPQjPtZjx7bkoB7hjXCa4DK8');
    assert.strictEqual(E.planSection(undefined).plan_digest, 'Ufjq3Tm46htv5EWl-j7jikgM9bysLYuwi7SxnzqTzZM');
    assert.strictEqual(E.EVIDENCE_V, 1, 'v stays 1 for this amendment (§2E.6, §2E.8 (5))');
    // the reconcile and verify plan digests, EXACTLY, built here by hand from §2E.2 (fixed sub-digest order per source)
    const sha = (txt) => crypto.createHash('sha256').update(Buffer.from(txt, 'utf8')).digest('base64url');
    const set = (type, tuples) => sha(`c2a/${type}/1\n${tuples.slice().sort().join('\n')}`);
    const planOf = (source, subs) => sha(`c2a/plan/1\n[${[source, ...subs].map((x) => JSON.stringify(x)).join(',')}]`);
    const rc = { restores: [{ id: 'ID4', name: 'Back', was: 'retired', resurrects: true }], retires: [{ id: 'ID3', name: 'Gone', why: 'residue' }, { id: 'ID5', name: 'Old', why: 'superseded' }],
      deletions: [{ name: 'Gone', encoded: 'R29uZQ', id: 'ID3' }] };
    assert.strictEqual(E.planSection({ source: 'reconcile', rec: rc }).plan_digest, planOf('reconcile', [set('restore', ['["ID4","Back","retired",["b",1]]']),
      set('retire', ['["ID3","Gone","residue"]', '["ID5","Old","superseded"]']), set('deletion', ['["Gone","R29uZQ","ID3"]'])]), 'reconcile plan_digest: restore, retire, deletion');
    const pl = { moves: [{ id: 'ID1', from: 'Old', to: 'New' }], mints: [{ id: 'ID2', name: 'Fresh' }], retires: [{ id: 'ID6', name: 'Drop' }] };
    const vf = { lands: [{ id: 'ID2', name: 'Fresh', via: 'mint' }, { id: 'ID1', name: 'New', via: 'move' }], releases: [{ id: 'ID1', name: 'Old', via: 'move' }], deletions: [{ name: 'Old', encoded: 'T2xk', id: 'ID1' }] };
    assert.strictEqual(E.planSection({ source: 'verify', plan: pl, verified: vf }).plan_digest, planOf('verify', [set('move', ['["ID1","Old","New"]']), set('mint', ['["ID2","Fresh"]']),
      set('retire', ['["ID6","Drop",["u"]]']), set('land', ['["ID2","Fresh","mint"]', '["ID1","New","move"]']), set('release', ['["ID1","Old","move"]']), set('deletion', ['["Old","T2xk","ID1"]'])]),
    'verify plan_digest: move, mint, retire (a derive-retire: why → ["u"]), land, release, deletion');
    assert.strictEqual(E.planSection({ source: 'derived', plan: pl }).plan_digest, planOf('derived', [set('move', ['["ID1","Old","New"]']), set('mint', ['["ID2","Fresh"]']), set('retire', ['["ID6","Drop",["u"]]'])]),
      'derived plan_digest: move, mint, retire');
    // a capture whose holder is FALSY (null / 0 / false / '') is no capture — recorded 'none', verified:false, exactly as the builder always has
    const NONE_SECTION = E.planSection(undefined);
    for (const f of [null, 0, false, '']) {
      for (const cap of [{ source: 'verify', plan: f, verified: f }, { source: 'verify', plan: pl, verified: f }, { source: 'derived', plan: f }, { source: 'reconcile', rec: f }]) {
        assert.deepStrictEqual(E.planSection(cap), NONE_SECTION, `a falsy capture (${JSON.stringify(cap)}) is 'none'`);
      }
    }
  }
  ok('§2E.7 golden vectors reproduced byte for byte: 11 tuples, DS2(final) of {2} and {}, plan_digest(derived, empty) and (none), incl. through planSection; the reconcile / verify / derived plan digests EXACTLY, built by hand in the fixed sub-digest order; a falsy capture holder is \'none\'; v = 1');

  // ── 2. the EXHAUSTIVE enumerator (§2E.8 (1)) ──────────────────────────────────────────────────────────────────────
  /* The CANONICAL value of a record = what the grammar is ALLOWED to identify, written from the plan's declared semantics and not
     from the encoder: §2's leaf class collapse (unsafe/fractional/-0/NaN numbers → number; missing ≡ undefined), the normalisation
     boundary (an address that is not a non-empty string → none; a row's presence by `absent === true`, then non-null object data
     → its declared projection, else the leaf; a check key row {absent:true} → absent; non-array claimants → the empty list). */
  const MISSING = Symbol('missing');   // the property is omitted from the record
  const V = ['', '"', '\\', ',', ']', '[', '\n', 'null', '["u"]', '\ud800', 'é😀', 'a,b', undefined, MISSING, null, true, false, 0, 1.5, NaN, -0];
  const S = ['', '"', 'null', undefined, null, NaN];
  const canonLeaf = (v) => {
    if (v === undefined || v === MISSING) return 'u';
    if (v === null) return 'n';
    if (typeof v === 'string') return `s${JSON.stringify(v)}`;
    if (typeof v === 'boolean') return `b${v}`;
    if (typeof v === 'number') return Number.isSafeInteger(v) && !Object.is(v, -0) ? `i${v}` : 'num';
    throw new Error(`canonLeaf: no model for ${String(v)}`);
  };
  const canonAddr = (a) => (typeof a === 'string' && a.length > 0 ? `s${JSON.stringify(a)}` : 'none');
  const NONE = { none: true };
  const ADDR_V = [...V, NONE]; const ADDR_S = ['x', NONE, ''];
  const own = (o, k) => (o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
  const canonRow = (F) => (row) => {
    const addr = canonAddr(own(row, 'addr'));
    if (own(row, 'absent') === true) return `${addr}|0`;
    const data = own(row, 'data');
    if (data !== null && typeof data === 'object') return `${addr}|1|${F.map((f) => canonLeaf(data[f])).join('|')}`;
    return `${addr}|2|${canonLeaf(data)}`;
  };
  const rowSet = (F) => {
    const rows = [];
    for (const addr of ADDR_V) rows.push({ addr, absent: true });                                     // absent, every address
    rows.push({ addr: 'x', absent: true, data: { [F[0]]: 'q' } });                                       // absent wins over data
    for (const d of V) rows.push(d === MISSING ? { addr: 'x' } : { addr: 'x', data: d });               // presence 2, every leaf
    rows.push({ addr: 'x', absent: 1, data: 5 }, { addr: 'x', absent: false, data: 5 });                // only absent === true is absent
    for (let i = 0; i < F.length; i += 1) for (const v of V) {                                          // presence 1, each projected field
      const d = {}; F.forEach((f, j) => { const x = j === i ? v : (j % 2 ? 'a' : undefined); if (x !== MISSING) d[f] = x; }); rows.push({ addr: 'x', data: d });
    }
    for (const addr of ADDR_V) rows.push({ addr, data: Object.fromEntries(F.map((f) => [f, 'a'])) });  // presence 1, every address
    // non-plain object data is projected through its fields (rowAt's normalisation), so it is presence 1 with its own field values
    rows.push({ addr: 'x', data: [] }, { addr: 'x', data: [1, 2] }, { addr: 'x', data: new Date(0) }, { addr: 'x', data: Object.assign(Object.create(null), { [F[0]]: 'a' }) },
      { addr: 'x', data: Object.assign(new (class Row {})(), { [F[0]]: 'a' }) });
    return rows;
  };
  const ROW_S = (F) => [{ addr: NONE, absent: true }, { addr: 'a', data: Object.fromEntries(F.map((f) => [f, 'a'])) }];
  const CLAIM_V = [[], ...V.filter((v) => v !== MISSING).map((v) => [v]), ...S.flatMap((a) => S.map((b) => [a, b])), 'x', undefined, null, { 0: 'a', length: 1 }];
  const canonClaims = (c) => (Array.isArray(c) ? `[${c.map(canonLeaf).join('|')}]` : '[]');
  const K_V = [...V, { absent: true }, { absent: true, extra: 1 }];
  const canonK = (kr) => (kr !== null && typeof kr === 'object' && kr.absent === true ? 'absent' : canonLeaf(kr));
  const leafF = (name) => ({ name, full: V, sub: S, canon: canonLeaf });
  const rowF = (name, F) => ({ name, full: rowSet(F), sub: ROW_S(F), canon: canonRow(F) });
  const SPECS = {
    final: TUPLE_FIELDS.final.map(leafF), move: TUPLE_FIELDS.move.map(leafF), mint: TUPLE_FIELDS.mint.map(leafF), retire: TUPLE_FIELDS.retire.map(leafF),
    restore: TUPLE_FIELDS.restore.map(leafF), deletion: TUPLE_FIELDS.deletion.map(leafF), land: TUPLE_FIELDS.land.map(leafF), release: TUPLE_FIELDS.release.map(leafF),
    stampmap: [leafF('k'), leafF('o'), { name: 'addr', full: ADDR_V, sub: ADDR_S, canon: canonAddr }, leafF('code'), leafF('relocated')],
    observed: [leafF('k'), leafF('o'), rowF('id_row', ID_ROW_FIELDS), rowF('key_row', KEY_ROW_FIELDS), rowF('other_kind_id_row', ID_ROW_FIELDS), rowF('sm_id_row', ID_ROW_FIELDS)],
    check: [leafF('k'), leafF('n'), { name: 'claimants', full: CLAIM_V, sub: [[], ['a'], 'x'], canon: canonClaims }, { name: 'key_row_canonical_id', full: K_V, sub: [{ absent: true }, 'a', undefined], canon: canonK }],
  };
  for (const [t, spec] of Object.entries(SPECS)) assert.deepStrictEqual(spec.map((f) => f.name), TUPLE_FIELDS[t], `the enumerator varies EVERY field of ${t}`);
  const FULL_LIMIT = 250000;
  const classes = (vals, canon) => new Set(vals.map(canon)).size;
  /* Enumerate one type. Returns its boxes; throws (the test fails, non-zero exit) on ANY violation in EITHER direction, or on a
     distinct count ≠ the product of the per-field class counts. `encode` is injectable only for the sensitivity cells. */
  function enumerate(type, spec, encode = TUPLES[type]) {
    const encToCanon = new Map(); const canonToEnc = new Map();
    const full = spec.reduce((p, f) => p * f.full.length, 1) <= FULL_LIMIT;
    const boxes = full ? [spec.map((f) => f.full)] : spec.map((_, i) => spec.map((f, j) => (j === i ? f.full : f.sub)));
    const report = []; let violations = 0; let first = null;
    for (const sets of boxes) {
      const boxEnc = new Set(); const boxCanon = new Set();
      const idx = new Array(sets.length).fill(0); let count = 0;
      for (;;) {
        const rec = {}; const parts = [];
        for (let i = 0; i < sets.length; i += 1) { const v = sets[i][idx[i]]; if (v !== MISSING) rec[spec[i].name] = v; parts.push(spec[i].canon(v)); }
        const canon = parts.join('¦'); const enc = encode(rec);
        const ce = encToCanon.get(enc); const ec = canonToEnc.get(canon);
        if ((ce !== undefined && ce !== canon) || (ec !== undefined && ec !== enc)) { violations += 1; if (!first) first = { enc, canon, was: ce !== undefined && ce !== canon ? ce : ec }; }
        encToCanon.set(enc, canon); canonToEnc.set(canon, enc); boxEnc.add(enc); boxCanon.add(canon); count += 1;
        let k = 0; while (k < sets.length && ++idx[k] === sets[k].length) { idx[k] = 0; k += 1; }
        if (k === sets.length) break;
      }
      const expected = sets.reduce((p, vals, i) => p * classes(vals, spec[i].canon), 1);
      report.push({ count, expected, enc: boxEnc.size, canon: boxCanon.size });
      if (boxEnc.size !== expected || boxCanon.size !== expected) violations += 1;
    }
    return { full, report, violations, first, encToCanon };
  }
  {
    let total = 0;
    for (const [type, spec] of Object.entries(SPECS)) {
      const r = enumerate(type, spec);
      if (r.violations) assert.fail(`🔴 ENC2 enumerator: ${type} — ${r.violations} violation(s); first ${JSON.stringify(r.first)}; boxes ${JSON.stringify(r.report)}`);
      const coverage = r.full
        ? `FULL cartesian product, ${spec.length} fields × {${spec.map((f) => f.full.length).join(',')}} values`
        : `PER-FIELD boxes: each field over its FULL set {${spec.map((f) => f.full.length).join(',')}} × the others over the declared covering subset {${spec.map((f) => f.sub.length).join(',')}}`;
      console.log(`     ${type.padEnd(8)} ${coverage}; per box combinations → distinct encodings = distinct canonicals = expected: ${r.report.map((b) => `${b.count}→${b.enc}`).join(', ')}`);
      total += r.report.reduce((s, b) => s + b.count, 0);
    }
    // SENSITIVITY: the enumerator FAILS when the encoder introduces an extra distinction, or ignores a field
    const nanDistinct = (rec) => TUPLES.final(Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, Number.isNaN(v) ? '§NaN' : v])));
    assert.ok(enumerate('final', SPECS.final, nanDistinct).violations > 0, '🔴 the enumerator did not notice 1.5 and NaN encoded DIFFERENTLY');
    assert.ok(enumerate('final', SPECS.final, (rec) => TUPLES.final({ ...rec, o: 'K' })).violations > 0, '🔴 the enumerator did not notice a field made CONSTANT');
    assert.ok(enumerate('observed', SPECS.observed, (rec) => TUPLES.observed({ ...rec, sm_id_row: { addr: 'K', absent: true } })).violations > 0, '🔴 …nor a constant observed row');
    assert.ok(enumerate('check', SPECS.check, (rec) => TUPLES.check({ ...rec, k: 'dish' })).violations > 0, '🔴 …nor a constant check k');
    assert.ok(enumerate('stampmap', SPECS.stampmap, (rec) => TUPLES.stampmap({ ...rec, relocated: false })).violations > 0, '🔴 …nor a constant relocated');
    /* (A merged presence DIGIT is not an injectivity loss — R's three forms already differ in arity — so the enumerator rightly
       passes it; the digit's exact value is pinned by the §2E.7 observed golden (cell 1), which a digit mutant fails.) */
    ok(`EXHAUSTIVE enumerator, both directions (encoding → one canonical, canonical → one encoding), exact distinct count per box = the product of the per-field class counts (V: ${V.length} adversarial values / ${classes(V, canonLeaf)} classes), every field of all 11 types varied incl. relocated, the four observed rows with their presence digits, and check k: ${total.toLocaleString('en-US')} records, 0 violations; SENSITIVITY: 1.5≠NaN, a constant field (final o / an observed row / check k / relocated) each FAIL it`);
  }

  // ── 3. seeded adversarial random corpus; domain-tag separation ───────────────────────────────────────────────────
  {
    let seed = 4242; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const ADV = ['', '"', '\\', ',', ']', '[', '\n', '\r\n', '\u0000', '\u001f', 'a,b', '"]', '["s"', 'null', '["u"]', '[null,0]', '\ud800', '\udc00', 'a\ud800b', 'é', '😀', '﻿', ' ', 'x'.repeat(1125), 'ID_1', '0', '1'];
    const leaf = () => { if (rnd() < 0.75) return ADV[Math.floor(rnd() * ADV.length)] + (rnd() < 0.3 ? String(Math.floor(rnd() * 3)) : ''); return [undefined, MISSING, null, true, false, 0, 1, -0, 1.5, NaN, Infinity, 2 ** 60][Math.floor(rnd() * 12)]; };
    const pick = (f) => {
      if (f.name === 'addr') return rnd() < 0.2 ? NONE : leaf();
      if (f.full === V) return leaf();
      return f.full[Math.floor(rnd() * f.full.length)];
    };
    const canonLeafR = (v) => (typeof v === 'number' && !Number.isSafeInteger(v) ? 'num' : canonLeaf(v));
    let checked = 0;
    for (const [type, spec] of Object.entries(SPECS)) {
      const encToCanon = new Map(); const canonToEnc = new Map();
      for (let i = 0; i < 20000; i += 1) {
        const rec = {}; const parts = [];
        for (const f of spec) { const v = pick(f); if (v !== MISSING) rec[f.name] = v; parts.push(f.full === V ? canonLeafR(v) : f.canon(v)); }
        const canon = parts.join('¦'); const enc = TUPLES[type](rec);
        assert.ok(!enc.includes('\n'), `🔴 a ${type} tuple contains U+000A: ${enc}`);
        assert.ok(encToCanon.get(enc) === undefined || encToCanon.get(enc) === canon, `🔴 random ${type}: one encoding, two canonicals: ${enc}`);
        assert.ok(canonToEnc.get(canon) === undefined || canonToEnc.get(canon) === enc, `🔴 random ${type}: one canonical, two encodings: ${canon}`);
        encToCanon.set(enc, canon); canonToEnc.set(canon, enc); checked += 1;
      }
    }
    // the tag line separates the types: the SAME tuple text under two types never shares a preimage (so not a digest, up to sha256)
    const same = { id: 'A', name: 'B', via: 'C' };
    assert.strictEqual(TUPLES.land(same), TUPLES.release(same), 'premise: land and release share a tuple shape');
    assert.notStrictEqual(DS2('land', [same]), DS2('release', [same]));
    const types = Object.keys(TUPLES); const tags = new Set(types.map(frameOf));
    assert.strictEqual(tags.size, types.length, 'one distinct tag line per type');
    for (const t of types) assert.strictEqual(DS2(t, []), H(`c2a/${t}/1\n`), `${t}: the empty set is exactly its tag line`);
    assert.strictEqual(new Set(types.map((t) => DS2(t, []))).size, types.length, 'the 11 empty sets are 11 distinct preimages');
    ok(`seeded random corpus: ${checked.toLocaleString('en-US')} records over 11 types (quotes, backslashes, commas, brackets, CR/LF, NUL/U+001F, null-lookalikes, lone surrogates, BOM, 1,125-char strings, ±Infinity, 2^60) — 0 violations in either direction, no tuple contains U+000A; the domain tag separates types with identical tuple text, and each empty set is exactly its own tag line`);
  }

  // ── 4. class collapse: exactly §2's ───────────────────────────────────────────────────────────────────────────────
  {
    const g = require('@google-cloud/firestore');
    const offline = new g.Firestore({ projectId: 'xpizza-delivery' });
    const HOSTILE_ADDR = [{}, [], ['x'], new Date(0), 7, Symbol('a'), () => 1];
    const collapses = [[1.5, NaN, -0, Infinity, 2 ** 60, 10n], [g.Timestamp.fromMillis(1), g.Timestamp.fromMillis(2)], [Buffer.from('a'), new Uint8Array(3)],
      [offline.doc('a/b'), offline.doc('c/d')], [g.FieldValue.vector([1]), g.FieldValue.vector([2])], [new g.GeoPoint(1, 2), new g.GeoPoint(3, 4)],
      [new Date(0), new Map(), new (class X {})()], [() => 1, Symbol('s')]];
    for (const grp of collapses) assert.strictEqual(new Set(grp.map(L)).size, 1, `${L(grp[0])}: one class`);
    assert.strictEqual(new Set(collapses.map((grp) => L(grp[0]))).size, collapses.length, 'the classes stay distinct from each other');
    const distinct = ['', 'a', 'A', 'null', '["u"]', undefined, null, true, false, 0, 1, -1, Number.MAX_SAFE_INTEGER, [], {}, ['a'], { a: 1 }];
    assert.strictEqual(new Set(distinct.map(L)).size, distinct.length, 'strings, absence, null, booleans, safe ints, lists and maps never collapse');
    assert.strictEqual(L({}), ENC({})); assert.strictEqual(L(7), ENC(7)); assert.strictEqual(L('s'), '"s"');
    assert.strictEqual(L('\ud800'), '"\\ud800"', 'a lone surrogate is escaped (well-formed JSON.stringify)');
    assert.strictEqual(JSON.parse(L('a\ud800b')), 'a\ud800b');
    // the one identification ENC2 adds is the address domain closure, which the builder already makes
    for (const a of ['', null, undefined, 0, NONE, {}, ['x']]) assert.strictEqual(A(a), 'null', `address ${String(a)} → none`);
    assert.strictEqual(A('x'), '"x"');
    // …so the builder's own normalisation (isStr(a) ? a : {none:true}) and A's closure agree on EVERY address: A is idempotent over it
    for (const a of [...V, ...HOSTILE_ADDR, NONE]) assert.strictEqual(A(typeof a === 'string' && a.length > 0 ? a : NONE), A(a), `A ∘ normalise = A at ${String(a)}`);
  }
  ok('class collapse is exactly §2\'s: number (fractional/NaN/-0/±Infinity/unsafe/bigint), timestamp, bytes, reference, vector, geopoint, object, other each collapse and stay mutually distinct; strings (incl. lone surrogates, escaped), absence, null, booleans, safe ints, lists and maps never collapse; an address that is not a non-empty string is none');

  // ── 5. set semantics + the sort rule, against an independently written preimage ─────────────────────────────────
  {
    const list = [{ k: 'dish', c: 'Z', n: '😀', o: 'd1' }, { k: 'dish', c: 'Z', n: 'Ａ', o: 'd1' }, { k: 'dish', c: 'A', n: 'a', o: 'd2' }, { k: 'dish', c: 'A', n: 'a', o: 'd2' }];
    const tuples = list.map((e) => `[${[e.k, e.c, e.n, e.o].map((s) => JSON.stringify(s)).join(',')}]`);
    const byCodeUnit = tuples.slice().sort((a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i += 1) { const d = a.charCodeAt(i) - b.charCodeAt(i); if (d) return d; } return a.length - b.length; });
    const want = crypto.createHash('sha256').update(Buffer.from(`c2a/final/1\n${byCodeUnit.join('\n')}`, 'utf8')).digest('base64url');
    assert.strictEqual(DS2('final', list), want, 'DS2 = sha256 of the tag line + the tuples in UTF-16 code-unit order, newline-joined');
    assert.ok(byCodeUnit.indexOf(tuples[0]) < byCodeUnit.indexOf(tuples[1]), 'premise: the surrogate pair sorts BEFORE U+FF21 by code unit (UTF-8 bytes would disagree)');
    assert.strictEqual(DS2('final', list.slice().reverse()), DS2('final', list), 'order-free');
    assert.notStrictEqual(DS2('final', list.slice(1)), DS2('final', list), 'a multiset: a duplicate counts');
    assert.notStrictEqual(DS2('final', [list[2]]), DS2('final', []), 'non-empty ≠ empty');
    for (const bad of [undefined, null, 'x', { length: 2 }, 7]) assert.strictEqual(DS2('final', bad), DS2('final', []), 'a non-list is the empty set (the builders only pass arrays)');
  }
  ok('DS2 = sha256(tag line + tuples sorted by UTF-16 code units, joined by \\n), checked against an independently written preimage where code-unit and UTF-8 order disagree; order-free, a multiset, empty distinct from non-empty');

  // ── 6–7. totality on hostile inputs (§2E.8 (2)) ────────────────────────────────────────────────────────────────────
  const OTHER = '["o","other"]';
  const thrower = (keys) => { const o = {}; for (const k of keys) Object.defineProperty(o, k, { enumerable: true, get() { throw new Error(`boom ${k}`); } }); return o; };
  const trap = () => new Proxy({}, { get() { throw new Error('trap'); }, has() { throw new Error('trap'); }, ownKeys() { throw new Error('trap'); }, getPrototypeOf() { throw new Error('trap'); } });
  const revoked = () => { const r = Proxy.revocable([], {}); r.revoke(); return r.proxy; };
  const cyc = () => { const c = { legacy_key: 'a' }; c.self = c; c.status = c; return c; };
  const HOSTILE = [undefined, null, 0, 'x', [], {}, new Date(0), new Map(), [1, 2], cyc(), trap(), revoked(), thrower(['absent', 'addr', 'data', 'none']),
    thrower(['k', 'c', 'n', 'o', 'id', 'name', 'why', 'was', 'resurrects', 'encoded', 'from', 'to', 'via', 'code', 'relocated', 'id_row', 'key_row', 'other_kind_id_row', 'sm_id_row', 'claimants', 'key_row_canonical_id', 'legacy_key', 'status', 'kind', 'canonical_id']),
    Object.create(null), Symbol('s'), () => 1];
  {
    let calls = 0;
    for (const h of HOSTILE) {
      for (const t of Object.keys(TUPLES)) { assert.doesNotThrow(() => TUPLES[t](h), `T.${t}`); assert.doesNotThrow(() => DS2(t, [h, h])); assert.doesNotThrow(() => DS2(t, h)); calls += 3; }
      for (const F of [ID_ROW_FIELDS, KEY_ROW_FIELDS]) { assert.doesNotThrow(() => R(h, F)); assert.doesNotThrow(() => R({ addr: 'x', data: h }, F)); assert.doesNotThrow(() => R({ addr: h, absent: h, data: h }, F)); calls += 3; }
      assert.doesNotThrow(() => K(h)); assert.doesNotThrow(() => K({ absent: h })); assert.doesNotThrow(() => LIST(h)); assert.doesNotThrow(() => LIST([h, h])); assert.doesNotThrow(() => L(h)); assert.doesNotThrow(() => A(h)); calls += 6;
      assert.doesNotThrow(() => planDigest(h, [h])); calls += 1;
    }
    // a throwing getter collapses THAT field only
    assert.strictEqual(TUPLES.final(Object.defineProperty({ k: 'dish', c: 'C', n: 'N' }, 'o', { enumerable: true, get() { throw new Error('x'); } })), `["dish","C","N",${OTHER}]`);
    assert.strictEqual(R(thrower(['absent']), ID_ROW_FIELDS), '[null,2,["u"]]', 'a throwing `absent` is not absent (addr none, data missing)');
    assert.strictEqual(R(thrower(['absent', 'data']), ID_ROW_FIELDS), `[null,2,${OTHER}]`, 'a throwing `data` collapses alone');
    assert.strictEqual(R(Object.defineProperty({ absent: true }, 'addr', { enumerable: true, get() { throw new Error('x'); } }), ID_ROW_FIELDS), '[null,0]', 'a throwing address reads as none');
    assert.strictEqual(R({ addr: 'x', data: thrower(['status']) }, ID_ROW_FIELDS), `["x",1,["u"],${OTHER},["u"]]`, 'a throwing projected field collapses alone');
    assert.strictEqual(R({ addr: 'x', data: trap() }, KEY_ROW_FIELDS), `["x",1,${OTHER},${OTHER}]`, 'a proxy is object data, its trapped fields collapse');
    assert.strictEqual(R({ addr: 'x', data: new Date(0) }, KEY_ROW_FIELDS), R({ addr: 'x', data: {} }, KEY_ROW_FIELDS), 'a Date projects exactly as today (no fields) — and no further');
    assert.strictEqual(K(thrower(['absent'])), L(thrower(['absent'])), 'a throwing `absent` is not the absent marker');
    assert.strictEqual(LIST(revoked()), '[]'); assert.strictEqual(LIST(['a', thrower([])]), '["a",["m",[]]]');
    assert.strictEqual(TUPLES.mint(revoked()), `[${OTHER},${OTHER}]`, 'a revoked record: every field collapses');
    assert.strictEqual(TUPLES.observed({ k: 'dish', o: 'd', id_row: cyc(), key_row: { addr: 'k', data: cyc() }, other_kind_id_row: null, sm_id_row: 5 }),
      `["dish","d",[null,2,["u"]],["k",1,["u"],["u"]],[null,2,["u"]],[null,2,["u"]]]`, 'cyclic rows: encoded through the projection, never walked');
    ok(`T / R / K / LIST / L / A / planDigest never throw on ${HOSTILE.length} hostile inputs (${calls} calls: throwing getters incl. on absent/addr/data/none, trapping and REVOKED proxies, arrays, Dates, Maps, null-prototype, cyclic data, symbols, functions); a throwing getter or trap collapses exactly THAT field to ["o","other"]`);
  }
  {
    const snap = (docs) => ({ docs: docs.map(([id, data]) => ({ id, data: () => data })) });
    const base = () => ({
      versionId: 'v-1', generation: 3, intent: 'publish', record: { content_hash: 'h', seq: 3, identity_revision: 1 },
      docs: { dish: snap([['d1', { key: 'Margherita', display: { identity_id: 'ID_MARG' } }]]), extra: snap([]) },
      docIdByKey: { dish: new Map([['Margherita', 'd1']]), extra: new Map() }, minted: { dish: new Map(), extra: new Map() },
      registry: { dish: new Map([['Margherita', { keyRowId: 'ID_MARG' }]]), extra: new Map() },
      fullIds: { dish: new Map([['ID_MARG', { legacy_key: 'Margherita', status: 'live', kind: 'dish' }]]), extra: new Map() },
      fullKeys: { dish: new Map([[encodeKey('Margherita'), { canonical_id: 'ID_MARG', kind: 'dish' }]]), extra: new Map() },
      judged: { stamps: [{ kind: 'dish', key: 'Margherita', claimedId: 'ID_MARG', verdict: { ok: true, code: 'verified' } }] }, relocated: new Set(),
      plans: { dish: { source: 'derived', plan: { moves: [], mints: [], retires: [] } }, extra: { source: 'derived', plan: { moves: [], mints: [], retires: [] } } },
    });
    const good = E.buildActivationEvidence(base());
    let built = 0;
    const setters = [
      (i, h) => { i.fullIds.dish.set('ID_MARG', h); }, (i, h) => { i.fullKeys.dish.set(encodeKey('Margherita'), h); }, (i, h) => { i.registry.dish.set('Margherita', h); },
      (i, h) => { i.judged.stamps[0] = h; }, (i, h) => { i.judged.stamps[0].verdict = h; }, (i, h) => { i.judged = h; }, (i, h) => { i.relocated = h; },
      (i, h) => { i.docs.dish = h; }, (i, h) => { i.docs.dish = { docs: [h] }; }, (i, h) => { i.docs.dish = snap([['d1', h]]); }, (i, h) => { i.docs.dish = snap([['d1', { key: 'Margherita', display: h }]]); },
      (i, h) => { i.minted.dish = h; }, (i, h) => { i.docIdByKey = h; }, (i, h) => { i.plans.dish = h; }, (i, h) => { i.plans.dish = { source: 'verify', plan: h, verified: h }; },
      (i, h) => { i.plans.dish = { source: 'reconcile', rec: { restores: [h], retires: h, deletions: [h, h] } }; }, (i, h) => { i.plans.extra = { source: 'derived', plan: { moves: [h], mints: [h], retires: [h] } }; },
      (i, h) => { i.record = h; },
    ];
    for (const h of HOSTILE) for (const set of setters) { const inp = base(); set(inp, h); const ev = E.buildActivationEvidence(inp); assert.strictEqual(ev.data.v, 1); assert.strictEqual(ev.data.final_digest.length, 43); built += 1; }
    for (const h of HOSTILE) { assert.doesNotThrow(() => E.buildActivationEvidence(h)); assert.doesNotThrow(() => E.planSection(h)); built += 2; }
    // a hostile row is RECORDED: the digest moves, nothing is refused
    { const inp = base(); inp.fullIds.dish.set('ID_MARG', thrower(['status'])); assert.notStrictEqual(E.buildActivationEvidence(inp).data.observed_digest, good.data.observed_digest); }
    const cbase = () => ({ versionId: 'v-1', observedGeneration: 2, revisionAfter: 1, record: { content_hash: 'h' }, objects: { dish: [{ id: 'd1', key: 'Margherita', canonical_id: 'ID_MARG' }], extra: [] },
      liveByKey: { dish: new Map([['Margherita', ['ID_MARG']]]), extra: new Map() }, keyRowIdOf: new Map([['dish/Margherita', 'ID_MARG']]) });
    const csetters = [(i, h) => { i.objects.dish[0] = h; }, (i, h) => { i.objects = h; }, (i, h) => { i.liveByKey.dish.set('Margherita', h); }, (i, h) => { i.liveByKey.dish.set('Margherita', [h, 'A', h]); },
      (i, h) => { i.keyRowIdOf.set('dish/Margherita', h); }, (i, h) => { i.keyRowIdOf = h; }, (i, h) => { i.record = h; }, (i, h) => { i.objects.dish[0] = { id: h, key: 'Margherita', canonical_id: 'ID_MARG' }; }];
    for (const h of HOSTILE) for (const set of csetters) { const inp = cbase(); set(inp, h); const ev = E.buildCertificationEvidence(inp); assert.strictEqual(ev.data.checks_digest.length, 43); built += 1; }
    for (const h of HOSTILE) { assert.doesNotThrow(() => E.buildCertificationEvidence(h)); assert.doesNotThrow(() => E.activationEvidenceDoc(null, { record: h })); assert.doesNotThrow(() => E.finalDigestOfVersion({ dishDocs: h, extraDocs: [h] })); built += 3; }
    ok(`the COMPLETE builders are total on the same hostile inputs: ${built} activation / certification / minimal / recompute builds with a hostile value planted at each of ${setters.length + csetters.length} input positions (registry rows, key rows, stamp verdicts, docs and their data()/display, plans and their lists, claimants, key rows, records) — none throws; a hostile row is RECORDED (the digest moves), never refused`);
  }

  // ── 8. the shared `final` byte-length function (§2E.8 (4)), escape-heavy ────────────────────────────────────────
  {
    const heavy = ['"', '\\', '\u0000\u0001\u001f', '\n\r\t\b\f', '\ud800', '\udfff', 'a\ud800b', 'é😀', '  ', 'x'.repeat(1125), '"\\'.repeat(400), '\u0007'.repeat(300)];
    const lists = [[], [{ k: 'dish', c: 'ID', n: 'N', o: 'd' }]];
    for (const s of heavy) lists.push([{ k: 'dish', c: `ID_${s}`, n: s, o: 'd1' }, { k: 'extra', c: 'ID_X', n: `${s}${s}`, o: s }]);
    lists.push(heavy.map((s, i) => ({ k: i % 2 ? 'dish' : 'extra', c: `I${i}`, n: s, o: `o${i}` })));
    for (const list of lists) {
      const payload = frameOf('final') + list.map(TUPLES.final).sort().join('\n');
      assert.strictEqual(E.finalPayloadBytes(list), Buffer.byteLength(payload, 'utf8'), `finalPayloadBytes = the preimage's UTF-8 length (${list.length} entries)`);
      assert.strictEqual(H(payload), DS2('final', list), 'and that preimage IS the one hashed');
      assert.strictEqual(E.finalPayloadBytes(list), E.FINAL_FRAME_BYTES + list.reduce((s, e) => s + E.finalTupleBytes(e), 0) + Math.max(0, list.length - 1), 'framing once + tuple bytes + (n−1) separators');
    }
    assert.strictEqual(FINAL_FRAME_BYTES, 12); assert.strictEqual(E.FINAL_FRAME_BYTES, FINAL_FRAME_BYTES);
    assert.strictEqual(E.finalTupleBytes({ k: 'dish', c: 'A', n: '"', o: 'd' }), Buffer.byteLength('["dish","A","\\"","d"]'));
    assert.strictEqual(E.finalTupleBytes({ k: 'dish', c: 'A', n: '\u0001', o: 'd' }), 25, 'a control character costs its 6-byte \\u escape');
    assert.strictEqual(E.finalTupleBytes({ k: 'dish', c: 'A', n: '\ud800', o: 'd' }), 25, 'a lone surrogate costs its 6-byte \\u escape, not 3 UTF-8 bytes');
    assert.strictEqual(E.finalTupleBytes({ k: 'dish', c: 'A', n: '😀', o: 'd' }), 23, 'a surrogate pair is 4 raw UTF-8 bytes');
    const long = { k: 'dish', c: 'ID', n: 'k'.repeat(1125), o: 'd' }; assert.strictEqual(E.finalTupleBytes(long), 1125 + 20, '["dish","ID","…","d"] = 20 bytes of framing around the key');
  }
  ok('finalTupleBytes / finalPayloadBytes / FINAL_FRAME_BYTES (exported next to finalDigestOfVersion for c2b\'s budget) equal the UTF-8 length of the exact hashed preimage — framing once + tuples + (n−1) separators — on escape-heavy lists (quotes, backslashes, C0 controls, CR/LF/TAB, lone surrogates, U+2028/9, 1,125-char keys)');

  // ── 9. the two-layer source-shape guard (§2E.8 (3)) ─────────────────────────────────────────────────────────────
  /* (a) PRODUCER schemas: the exact key set every record a producer the builder consumes emits, per producer branch.
     (b) DIGEST-INPUT schemas: the exact key set of every record handed to an ENC2 tuple (TUPLE_FIELDS; retire has the declared
         derive variant without `why`, encoded ["u"]). A field added upstream fails (a) instead of silently falling out of the digest. */
  const PRODUCER = {
    'judgeStampMap.stamps': [['claimedId', 'key', 'kind', 'verdict']],
    'derivePlan.moves': [['from', 'id', 'to']], 'derivePlan.mints': [['id', 'name']], 'derivePlan.retires': [['id', 'name']],
    'verifyPlan.lands': [['id', 'name', 'via']], 'verifyPlan.releases': [['id', 'name', 'via']], 'verifyPlan.deletions': [['encoded', 'id', 'name']],
    'reconcile.restores': [['id', 'name', 'resurrects', 'was']], 'reconcile.retires': [['id', 'name', 'why']], 'reconcile.deletions': [['encoded', 'id', 'name']],
    'bootstrap.objects': [['canonical_id', 'data', 'id', 'key']],
  };
  const DIGEST_INPUT = Object.fromEntries(Object.entries(TUPLE_FIELDS).map(([t, f]) => [t, [f.slice().sort()]]));
  DIGEST_INPUT.retire.push(['id', 'name']);   // the derive-retire variant: `why` absent → ["u"]
  const shapeViolations = (schemaVariants, records) => records.filter((r) => !schemaVariants.some((s) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(s)));
  const assertShape = (label, variants, records, { min = 1 } = {}) => {
    assert.ok(records.length >= min, `premise: ${label} has records to check`);
    const bad = shapeViolations(variants, records);
    assert.strictEqual(bad.length, 0, `🔴 source-shape guard: ${label} emitted ${JSON.stringify(Object.keys(bad[0] || {}).sort())}, declared ${JSON.stringify(variants)} — a field changed upstream; update the ENC2 tuple (and BUMP v, §2E.8 (5)) or the projection`);
  };
  const reg = (rows) => {   // a whole-registry pair (ids, keys) from {id: [legacy_key, status]}
    const ids = new Map(); const keys = new Map();
    for (const [id, [lk, status]] of Object.entries(rows)) { ids.set(id, { legacy_key: lk, status, kind: 'dish' }); if (status === 'live') keys.set(encodeKey(lk), { canonical_id: id, kind: 'dish' }); }
    return { ids, keys };
  };
  {
    const seen = {};
    const take = (label, list) => { (seen[label] = seen[label] || []).push(...list); };
    // judgeStampMap — verified, unregistered, disagrees, retired, claims-other-name, not-in-candidate branches
    const live = (k) => ({ legacy_key: k, status: 'live', kind: 'dish' });
    const judged = judgeStampMap({ stamps: { dish: { a: 'A', b: 'B', c: 'C', d: 'D', e: 'E', z: 'Z' } }, candidateKeys: { dish: ['a', 'b', 'c', 'd', 'e'] },
      registry: { dish: { a: { keyRowId: 'A', idRow: live('a') }, b: { keyRowId: null, idRow: null }, c: { keyRowId: 'OTHER', idRow: live('c') }, d: { keyRowId: 'D', idRow: { ...live('d'), status: 'retired' } }, e: { keyRowId: 'E', idRow: live('elsewhere') } } },
      baseline: { version: 'v1', generation: 1 }, live: { version: 'v1', generation: 1 } });
    assert.ok(new Set(judged.stamps.map((s) => s.verdict.code)).size >= 5, 'premise: the stamp-map fixture covers its verdict branches');
    take('judgeStampMap.stamps', judged.stamps);
    // derivePlan — move, mint, retire branches
    const r1 = reg({ A: ['Old', 'live'], R: ['Gone', 'live'] });
    const d1 = derivePlan({ candidateKeys: new Set(['New', 'Fresh']), stamps: { New: 'A' }, ids: r1.ids, keys: r1.keys, retireIds: ['R'], allocate: (k) => `M_${k}` });
    assert.ok(d1.moves.length && d1.mints.length && d1.retires.length, 'premise: derivePlan fixture yields a move, a mint and a retire');
    take('derivePlan.moves', d1.moves); take('derivePlan.mints', d1.mints); take('derivePlan.retires', d1.retires);
    // verifyPlan — lands/releases via move, mint, retire; deletions
    const v1 = verifyPlan(d1, { ids: r1.ids, keys: r1.keys, complete: true });
    assert.ok(v1.ok, `premise: verifyPlan permits the fixture (${v1.code || ''} ${v1.detail || ''})`);
    assert.deepStrictEqual(new Set([...v1.lands, ...v1.releases].map((x) => x.via)), new Set(['move', 'mint', 'retire']), 'premise: every via branch');
    assert.ok(v1.deletions.length, 'premise: a deletion');
    take('verifyPlan.lands', v1.lands); take('verifyPlan.releases', v1.releases); take('verifyPlan.deletions', v1.deletions);
    // reconcileOnRollback — restore (fresh / resurrect / from another name), retire (superseded / residue / unknown), deletions
    const r2 = reg({ A: ['Back', 'retired'], B: ['Elsewhere', 'live'], S: ['Sup', 'live'], X: ['Residue', 'live'] });
    const rec = reconcileOnRollback({ targetStamps: { Back: 'A', Moved: 'B', Brand: 'N' }, ids: r2.ids, keys: r2.keys, activeStamps: { Sup: 'S' } });
    assert.ok(!rec.refusals || !rec.refusals.length, `premise: the reconciliation fixture lands (${JSON.stringify(rec.refusals)})`);
    assert.ok(rec.restores.some((x) => x.resurrects) && rec.restores.some((x) => !x.resurrects) && rec.restores.some((x) => x.was === 'absent'), 'premise: restore branches');
    assert.deepStrictEqual(new Set(rec.retires.map((x) => x.why)), new Set(['superseded', 'residue']), 'premise: both classified retire branches');
    const recU = reconcileOnRollback({ targetStamps: {}, ids: r2.ids, keys: r2.keys });
    assert.ok(recU.retires.every((x) => x.why === 'unknown') && recU.retires.length, 'premise: the unclassified branch');
    assert.ok(rec.deletions.length, 'premise: a deletion');
    take('reconcile.restores', rec.restores); take('reconcile.retires', [...rec.retires, ...recU.retires]); take('reconcile.deletions', [...rec.deletions, ...recU.deletions]);
    for (const [label, variants] of Object.entries(PRODUCER)) if (label !== 'bootstrap.objects') assertShape(label, variants, seen[label]);
    // layer (b) on the same producer records, routed exactly as planSection routes them
    for (const [type, list] of [['move', d1.moves], ['mint', d1.mints], ['retire', d1.retires], ['land', v1.lands], ['release', v1.releases], ['deletion', v1.deletions],
      ['restore', rec.restores], ['retire', rec.retires], ['deletion', rec.deletions]]) assertShape(`digest input ${type}`, DIGEST_INPUT[type], list);
    const viaSection = E.planDigestInputs({ source: 'verify', plan: d1, verified: v1 });
    assert.deepStrictEqual(viaSection.lists.map((l) => l.type), ['move', 'mint', 'retire', 'land', 'release', 'deletion'], 'the §2E.2 sub-digest order');
    for (const { type, list } of viaSection.lists) assertShape(`planDigestInputs ${type}`, DIGEST_INPUT[type], list);
    // SENSITIVITY: a field added to a covered producer record fails layer (a)
    for (const label of ['judgeStampMap.stamps', 'derivePlan.retires', 'reconcile.retires', 'verifyPlan.lands']) {
      const mutated = seen[label].map((r, i) => (i === 0 ? { ...r, added_upstream: 1 } : r));
      assert.throws(() => assertShape(label, PRODUCER[label], mutated), /source-shape guard/, `🔴 an added field on ${label} was not caught`);
    }
    assert.throws(() => assertShape('digest input retire', DIGEST_INPUT.retire, [{ id: 'a', name: 'b', why: 'c', extra: 1 }]), /source-shape guard/);
    ok(`source-shape guard, layer (a): the REAL producers on fixtures covering each branch emit exactly their declared keys — judgeStampMap ${seen['judgeStampMap.stamps'].length} stamps over ${new Set(judged.stamps.map((s) => s.verdict.code)).size} verdict codes; derivePlan move/mint/retire; verifyPlan lands+releases via move/mint/retire and deletions; reconcileOnRollback restores (fresh/resurrect/renamed), retires (superseded/residue/unknown), deletions; layer (b): every record routed into a tuple carries exactly TUPLE_FIELDS (retire: both declared variants); SENSITIVITY: an added field fails both layers`);
  }

  // ── 10. the REAL writers on the in-memory Firestore: both layers on what the call sites actually pass ────────────
  {
    const { makeDb } = require('./firestore-fake');
    const { publishVersion, rollbackVersion } = require('./catalog-publish');
    const { bootstrapIdentityStamps } = require('./identity-bootstrap');
    const { sourceRefOf, canonicalize, sourceToBuildInputs, encodeUpdateTime } = require('./source-store');
    const { buildSourceFromCode } = require('../tools/seed-source-store');
    const { buildCatalogV2 } = require('./form-menu-source');
    const { getActivePointer } = require('./catalog-firestore');
    const db = makeDb(); const rid = 'x_pizza';
    TAP.on = true;
    await sourceRefOf(db, rid).set(canonicalize(buildSourceFromCode(rid)));
    const publish = async (expectedActive, tag) => {
      const snap = await sourceRefOf(db, rid).get(); const src = snap.data(); const inputs = sourceToBuildInputs(src);
      const built = buildCatalogV2(rid, { formData: inputs.formData, priceTable: inputs.priceTable });
      const r = await publishVersion(db, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: (src.extras || []).map((e) => ({ key: e.key, price: e.price, display: e.display })), source_sha: tag },
        { expected: { activeVersionId: expectedActive, draftRevision: encodeUpdateTime(snap.updateTime) } });
      return r.versionId;
    };
    const addDish = async (name) => {
      const src = (await sourceRefOf(db, rid).get()).data(); const first = src.items[0];
      const used = new Set(src.items.map((o) => String(o && o.display && o.display.id))); let uiId = 9000; while (used.has(String(uiId))) uiId += 1;
      const row = { ...first, key: name, name, display: { ...(first.display || {}), id: uiId, name } }; delete row.display.identity_id;
      await sourceRefOf(db, rid).set({ ...src, items: src.items.concat([row]), structure: { ...src.structure, item_order: (src.structure.item_order || []).concat([name]) } });
    };
    const v1 = await publish(null, 'enc2-seed');
    await bootstrapIdentityStamps(db, rid, { attempt: 'enc2' });
    const v2 = await publish(v1, 'enc2-republish');
    await addDish('Zz Enc2 Mint');
    const v3 = await publish(v2, 'enc2-mint');
    await addDish('Zz Enc2 Forward');
    const v4 = await publish(v3, 'enc2-forward');
    await rollbackVersion(db, rid, v2, { expected: { activeVersionId: v4 } });
    assert.strictEqual((await getActivePointer(db, rid)).version, v2, 'premise: the rollback landed');
    const sources = TAP.act.flatMap((a) => [a.plans.dish.source, a.plans.extra.source]);
    assert.ok(TAP.cert.length === 1 && TAP.act.length === 4, `premise: 1 certification + 4 certified activations tapped (got ${TAP.cert.length} / ${TAP.act.length})`);
    for (const s of ['derived', 'verify', 'reconcile']) assert.ok(sources.includes(s), `premise: the real call sites captured a ${s} plan`);
    // layer (a) on the real call sites' producer records
    assertShape('bootstrap.objects (real)', PRODUCER['bootstrap.objects'], [...TAP.cert[0].objects.dish, ...TAP.cert[0].objects.extra]);
    assertShape('judgeStampMap.stamps (real)', PRODUCER['judgeStampMap.stamps'], TAP.act.flatMap((a) => a.stamps));
    const route = { 'verify:move': 'derivePlan.moves', 'verify:mint': 'derivePlan.mints', 'verify:retire': 'derivePlan.retires', 'derived:move': 'derivePlan.moves', 'derived:mint': 'derivePlan.mints',
      'derived:retire': 'derivePlan.retires', 'verify:land': 'verifyPlan.lands', 'verify:release': 'verifyPlan.releases', 'verify:deletion': 'verifyPlan.deletions',
      'reconcile:restore': 'reconcile.restores', 'reconcile:retire': 'reconcile.retires', 'reconcile:deletion': 'reconcile.deletions' };
    let planRecords = 0;
    for (const a of TAP.act) for (const p of [a.plans.dish, a.plans.extra]) for (const { type, list } of p.lists) {
      if (list.length) { assertShape(`${route[`${p.source}:${type}`]} (real)`, PRODUCER[route[`${p.source}:${type}`]], list); assertShape(`digest input ${type} (real)`, DIGEST_INPUT[type], list); planRecords += list.length; }
    }
    assert.ok(planRecords >= 2, 'premise: the real plans carried records (the mint, the rollback reconciliation)');
    // layer (b) on every record the real builders encoded
    let records = 0;
    for (const a of TAP.act) for (const t of ['final', 'stampmap', 'observed']) { assertShape(`digest input ${t} (real)`, DIGEST_INPUT[t], a.digest[t]); records += a.digest[t].length; }
    for (const t of ['final', 'checks']) { assertShape(`digest input ${t} (real)`, DIGEST_INPUT[t === 'checks' ? 'check' : t], TAP.cert[0].digest[t]); records += TAP.cert[0].digest[t].length; }
    // the recomputation cross-check (§2E.7 (5)) on what committed
    for (const vid of [v2, v3]) {
      const v = db.collection('restaurants').doc(rid).collection('versions').doc(vid);
      const [i, x] = await Promise.all([v.collection('menu_items').get(), v.collection('extras').get()]);
      const ev = TAP.act.find((a) => a.inp.versionId === vid);
      assert.strictEqual(E.finalDigestOfVersion({ dishDocs: i.docs, extraDocs: x.docs }).final_digest, DS2('final', ev.digest.final), `${vid}: final_digest = recomputation from the committed docs`);
    }
    ok(`the REAL writers (publish → bootstrap → republish → mint → forward → rollback, in-memory Firestore): bootstrap's objects, ${TAP.act.flatMap((a) => a.stamps).length} judgeStampMap stamps and ${planRecords} plan records from the derived/verify/reconcile call sites satisfy their producer schemas, and all ${records.toLocaleString('en-US')} records the builders encoded satisfy the digest-input schemas; final_digest = the recomputation from the committed docs`);
  }

  FINISHED = true;
  console.log(`evidence-enc2: OK (${n})`);
})().catch((e) => { console.error('evidence-enc2 FAILED:', e); process.exit(1); });
