'use strict';
// Portal 2b-1 Task 3 — editCatalog: validated draft write, CAS, diff + token. NO publish.
// Run: node catalog/edit-catalog.test.js
//
// Two properties carry this handler, and both are about what it must NOT do.
//
//   IT MUST NOT CLOBBER. Two people editing the same menu is the ordinary case, not the exotic one. The
//   concurrency check therefore has to be a real server-side PRECONDITION, not a read-then-compare —
//   those look identical in every test except one: the test where the document changes BETWEEN the read
//   and the write. That test is below, and it is the only thing separating a genuine CAS from a race.
//
//   IT MUST NOT PUBLISH. editCatalog writes a draft; the live version is untouched. A handler that
//   moved the pointer would turn a "save" into a price change with no review at all.
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const { editCatalogCore } = require('./edit-catalog-handler');
const { validateDeletionClaim } = require('./identity-partition');
const { verifyEditToken, catalogDiff, sha256 } = require('./catalog-edit');
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('edit-catalog: FAILED — exited without completing'); process.exitCode = 1; } });

const RID = 'x_pizza';
const T0 = '2026-09-07T10:00:00.000000Z';
const T1 = '2026-09-07T11:00:00.000000Z';
const ACTIVE = 'v-active-1';

// ── A Firestore stub that models PRECONDITIONS faithfully. `update(data, {lastUpdateTime})` rejects
//    unless the doc's CURRENT updateTime matches — which is what makes the interleaving test below able
//    to tell a precondition apart from a read-then-compare.
function stubFirestore(sourceDoc, { onGetSource = null, activeVersionId = ACTIVE } = {}) {
  const state = { source: { data: sourceDoc, updateTime: T0 }, writes: [], reads: [], activeReads: 0 };
  const versionBuilt = buildSourceFromCode(RID);   // the live version == the seeded catalog
  const doc = (path) => ({
    get: async () => {
      state.reads.push(path);
      if (path === `restaurants/${RID}/meta/source`) {
        // FROZEN at read time, like a real DocumentSnapshot. A live getter here would keep returning
        // whatever the doc currently holds, which quietly makes "hash the snapshot" and "hash the
        // submitted source" the same value — and hides a real bug behind an unfaithful stub.
        const frozen = JSON.parse(JSON.stringify(state.source.data));
        const snap = { exists: true, data: () => frozen, updateTime: state.source.updateTime };
        if (onGetSource) onGetSource(state);          // lets a test simulate a CONCURRENT writer
        return snap;
      }
      if (path === `restaurants/${RID}/meta/active_version`) {
        return { exists: activeVersionId != null, data: () => ({ version: activeVersionId }) };
      }
      return { exists: false, data: () => ({}) };
    },
    set: async (data) => { state.writes.push({ path, op: 'set' }); state.source = { data, updateTime: T1 }; return { writeTime: T1 }; },
    update: async (data, precondition) => {
      state.writes.push({ path, op: 'update', precondition });
      if (!precondition || precondition.lastUpdateTime === undefined) {
        // A write with NO precondition is exactly the bug this stub exists to expose: it succeeds here
        // and silently overwrites whatever landed in between.
        state.source = { data, updateTime: T1 }; return { writeTime: T1 };
      }
      if (precondition.lastUpdateTime !== state.source.updateTime) {
        const e = new Error('FAILED_PRECONDITION: the document has been modified'); e.code = 9; throw e;
      }
      state.source = { data, updateTime: T1 };
      return { writeTime: T1 };
    },
  });
  return {
    state,
    // the LIVE published version, in the { built, versionId } shape the handler consumes
    readActiveBuilt: async () => {
      state.activeReads++;
      const inputs = require('./source-store').sourceToBuildInputs(versionBuilt);
      const built = require('./form-menu-source').buildCatalogV2(RID, { formData: inputs.formData, priceTable: inputs.priceTable });
      return { built: { ...built, extras: inputs.extras }, versionId: activeVersionId };
    },
    collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${d}/${c2}/${d2}`) }), get: async () => ({ exists: true, data: () => ({}) }) }) }),
  };
}

const allow = async () => ({ ok: true, uid: 'u_disp', role: 'dispatcher', actor: 'd@x.hn' });
const baseSource = () => JSON.parse(JSON.stringify(buildSourceFromCode(RID)));
// A price lives TWICE in the source: the authoritative `price`, and `display.price` mirrored from the
// form. 2a's validator requires them to agree, so any editor must set both — an API contract detail the
// UI in 2b-2 has to honour. Deliberately NOT normalised server-side: if a caller sends the two fields
// disagreeing, which one they meant is a guess, and guessing at a price is exactly what must not happen.
const withPrice = (delta) => {
  const s = baseSource();
  const it = s.items.find((i) => i.key === 'Margherita');
  it.price += delta; it.display.price = it.price;
  return s;
};

(async () => {
  // ── (1) THE HAPPY PATH — a draft is written, a diff and token come back, NOTHING is published ──
  {
    const db = stubFirestore(baseSource());
    const r = await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
      { restaurantId: RID, source: withPrice(30), baseSourceUpdateTime: T0 }, {});
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.strictEqual(r.body.updateTime, T1, 'the new draft updateTime comes back');
    const priced = r.body.diff.changed.filter((c) => c.field === 'price');
    assert.strictEqual(priced.length, 1, 'the diff shows exactly the one price the caller changed');
    assert.strictEqual(priced[0].key, 'Margherita', 'and names it');
    assert.ok(r.body.token, 'a token comes back');
    assert.strictEqual(verifyEditToken(r.body.token, {
      rid: RID, baseActiveVersionId: ACTIVE, sourceUpdateTime: r.body.updateTime,
      sourceHash: r.body.sourceHash, diff: r.body.diff,
    }).ok, true, 'and it verifies against the state actually returned');
    assert.strictEqual(db.state.writes.length, 1, 'exactly ONE write');
    assert.ok(db.state.writes[0].path.endsWith('/meta/source'), 'and it is the draft');
  }
  ok('a valid edit writes the draft and returns { updateTime, diff, token } — one write, to meta/source');

  // ── (2) IT MUST NEVER PUBLISH ────────────────────────────────────────────────────────────────
  {
    const db = stubFirestore(baseSource());
    await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
      { restaurantId: RID, source: withPrice(30), baseSourceUpdateTime: T0 }, {});
    for (const w of db.state.writes) {
      assert.ok(!/active_version|versions\//.test(w.path), `editCatalog must never write ${w.path} — a save is not a publish`);
    }
    // Non-vacuity for the assertion above: it DOES consult the live version (that is what the diff is
    // against) — so "never writes it" is a real restraint, not an artefact of never touching it at all.
    assert.strictEqual(db.state.activeReads, 1, 'it reads the live version exactly once, to diff against');
    ok('editCatalog never writes active_version or any version doc — it reads the pointer, it does not move it');
  }

  // ── (3) THE CAS. A read-then-compare passes every test but this one. ─────────────────────────
  {
    // A concurrent writer lands BETWEEN this handler's read of the draft and its write. A handler that
    // merely compared the value it read would see T0 == T0, decide "fresh", and overwrite that writer's
    // edit. Only a server-evaluated precondition rejects.
    const db = stubFirestore(baseSource(), {
      onGetSource: (state) => { state.source = { data: baseSource(), updateTime: T1 }; },   // someone else saves, now
    });
    const r = await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
      { restaurantId: RID, source: withPrice(30), baseSourceUpdateTime: T0 }, {});
    assert.strictEqual(r.status, 409, 'a write racing a concurrent save MUST be rejected');
    assert.strictEqual(r.body.error, 'stale_edit', 'as stale_edit');
    assert.strictEqual(db.state.source.updateTime, T1, "and the other writer's draft must still be there");
    assert.notDeepStrictEqual(db.state.source.data, withPrice(30), 'NOT overwritten by the losing edit');
    // the write was attempted, and it carried a precondition — that is what made it fail rather than clobber
    const w = db.state.writes.find((x) => x.path.endsWith('/meta/source'));
    assert.ok(w, 'the write was attempted');
    assert.ok(w.precondition && w.precondition.lastUpdateTime === T0, 'and it carried a lastUpdateTime precondition (not a bare write)');
  }
  ok('CAS: a concurrent save landing between read and write is rejected by the PRECONDITION, not clobbered');
  {
    // The simpler stale case: the caller's base is already behind before the request even starts.
    const db = stubFirestore(baseSource());
    db.state.source.updateTime = T1;
    const r = await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
      { restaurantId: RID, source: withPrice(30), baseSourceUpdateTime: T0 }, {});
    assert.strictEqual(r.status, 409, 'an already-stale base is rejected');
    assert.strictEqual(r.body.error, 'stale_edit', 'as stale_edit');
    assert.strictEqual(db.state.source.updateTime, T1, 'and nothing was written');
    // a MISSING base is not a licence to overwrite
    const db2 = stubFirestore(baseSource());
    const r2 = await editCatalogCore({ db: db2, authorize: allow, readActiveBuilt: db2.readActiveBuilt },
      { restaurantId: RID, source: withPrice(30) }, {});
    assert.strictEqual(r2.status, 400, 'omitting baseSourceUpdateTime is a bad request, never an unconditional write');
    assert.strictEqual(db2.state.writes.length, 0, 'and writes nothing');
    ok('a stale base and a MISSING base are both refused — neither becomes an unconditional overwrite');
  }

  // ── (4) VALIDATION runs BEFORE the write, and names the field ────────────────────────────────
  {
    const bad = [
      ['a non-positive price', (s) => { const i = s.items.find((x) => x.key === 'Margherita'); i.price = 0; i.display.price = 0; }, /price/i],
      ['a float price', (s) => { const i = s.items.find((x) => x.key === 'Margherita'); i.price = 12.5; i.display.price = 12.5; }, /price/i],
      // the mirror disagreeing IS itself a rejection — the contract, asserted
      ['display.price disagreeing with the authoritative price', (s) => { s.items.find((x) => x.key === 'Margherita').display.price = 1; }, /must be present and equal/i],   // 1A Task 2: the rule is now presence AND equality in one check
      ['a dangling category', (s) => { s.items.find((i) => i.key === 'Margherita').display.cat = 'ghost'; }, /categor/i],
      ['a duplicate key', (s) => { s.items.push({ ...s.items[0] }); }, /duplicate|item_order/i],
      ['a mis-keyed extra', (s) => { s.extras[0].key = 'not-the-name'; }, /extra|key/i],
      ['the wrong restaurant', (s) => { s.restaurant_id = 'la_musa'; }, /restaurant/i],
    ];
    for (const [label, mutate, re] of bad) {
      const db = stubFirestore(baseSource());
      const src = baseSource(); mutate(src);
      const r = await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
        { restaurantId: RID, source: src, baseSourceUpdateTime: T0 }, {});
      assert.strictEqual(r.status, 400, `${label} → 400`);
      assert.ok(re.test(r.body.detail || ''), `${label} → the message names the field (got: ${r.body.detail})`);
      assert.strictEqual(db.state.writes.length, 0, `${label} → NOTHING written (validation precedes the write)`);
    }
    // and a structurally absent source is refused too
    for (const src of [undefined, null, 'a string', 42, []]) {
      const db = stubFirestore(baseSource());
      const r = await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
        { restaurantId: RID, source: src, baseSourceUpdateTime: T0 }, {});
      assert.strictEqual(r.status, 400, `a ${typeof src} source → 400`);
      assert.strictEqual(r.body.error, 'bad_source', `a ${typeof src} source is refused as a SHAPE problem, not surfaced as a confusing validator message`);
      assert.strictEqual(db.state.writes.length, 0, 'and nothing written');
    }
    ok(`all ${bad.length} malformed drafts + 5 non-objects are refused with the field named, and NOTHING is written`);
  }

  // ── (5) AUTH is the first gate, and its refusal is passed through verbatim ───────────────────
  {
    for (const [label, res] of [
      ['unauthenticated', { ok: false, status: 401, error: 'missing_bearer_token' }],
      ['a customer token', { ok: false, status: 403, error: 'not_authorized' }],
      ['an auth outage', { ok: false, status: 503, error: 'authorization_unavailable' }],
    ]) {
      const db = stubFirestore(baseSource());
      const r = await editCatalogCore({ db, authorize: async () => res, readActiveBuilt: db.readActiveBuilt },
        { restaurantId: RID, source: withPrice(30), baseSourceUpdateTime: T0 }, {});
      assert.strictEqual(r.status, res.status, `${label} → ${res.status}`);
      assert.strictEqual(r.body.error, res.error, `${label} → the helper's own typed error, not a generic one`);
      assert.strictEqual(db.state.writes.length, 0, `${label} → nothing written`);
      assert.strictEqual(db.state.reads.length, 0, `${label} → and nothing even READ (auth is the first gate)`);
    }
    ok('auth runs before anything else: its status and error pass through, and no read or write happens');
  }

  // ── (6) THE TOKEN IS BOUND TO WHAT WAS RETURNED, not to what was asked for ───────────────────
  {
    const db = stubFirestore(baseSource());
    const r = await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
      { restaurantId: RID, source: withPrice(30), baseSourceUpdateTime: T0 }, {});
    const state = { rid: RID, baseActiveVersionId: ACTIVE, sourceUpdateTime: r.body.updateTime, sourceHash: r.body.sourceHash, diff: r.body.diff };
    assert.strictEqual(verifyEditToken(r.body.token, state).ok, true, 'baseline');
    // the token must be bound to the POST-write updateTime. Binding the pre-write one would let a
    // publish land against a draft that has since moved.
    assert.strictEqual(verifyEditToken(r.body.token, { ...state, sourceUpdateTime: T0 }).ok, false,
      'the token must NOT verify against the pre-write updateTime');
    // and to the content actually stored
    const stored = db.state.source.data;
    assert.strictEqual(stored.items.find((i) => i.key === 'Margherita').price, baseSource().items.find((i) => i.key === 'Margherita').price + 30,
      'the stored draft is the submitted one');
    // COMPUTED INDEPENDENTLY. Verifying the token against the hash the handler itself returned proves
    // only that the handler agrees with itself — any constant would pass. The hash must be OF the draft
    // that was stored, or `publishEdited` would re-hash the live draft and reject every honest publish.
    assert.strictEqual(r.body.sourceHash, sha256(withPrice(30)), 'sourceHash must be the hash of the submitted draft, computed independently');
    assert.notStrictEqual(r.body.sourceHash, sha256({}), 'non-vacuity: it is not a constant');
    assert.notStrictEqual(r.body.sourceHash, sha256(baseSource()), 'and not the hash of the PREVIOUS draft');
    assert.strictEqual(verifyEditToken(r.body.token, { ...state, diff: catalogDiff({ items: [], extras: {} }, { items: [], extras: {} }) }).ok, false,
      'nor against a different diff');
    ok('the token binds the POST-write updateTime and the returned diff — not the pre-write state');
  }

  // ── (8) THE WRAPPER. index.js cannot be imported here, so its plumbing is asserted structurally —
  //        the same discipline as the 2a gate-wiring guard. A handler that exists but is never exported,
  //        or is exported wired to the wrong verifier, is invisible to every test above.
  {
    const CODE = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8')
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');
    for (const [id, mod] of [['authorizeCatalogEdit', 'catalog/catalog-edit-auth'], ['editCatalogCore', 'catalog/edit-catalog-handler']]) {
      assert.ok(new RegExp(`\\{[^}]*\\b${id}\\b[^}]*\\}\\s*=\\s*require\\('\\./${mod.replace(/\//g, '\\/')}'\\)`).test(CODE),
        `index.js must import ${id} — a commented-out or renamed require is a runtime ReferenceError node --check cannot see`);
    }
    assert.ok(/exports\.editCatalog = onRequest\(/.test(CODE), 'editCatalog must actually be exported, or nothing can call it');
    assert.ok(/await editCatalogCore\(\{/.test(CODE), 'and it must delegate to the TESTED core rather than reimplementing the logic');
    // the auth wiring must be the real verifier + the real membership database, not a stub left behind
    // BOUNDED to this handler's own block. A file-wide search was enough when this was the only
    // handler wiring authorizeCatalogEdit; the portal slice added a second, correct occurrence, and
    // from that moment the check passed even with THIS handler mis-wired. Adding a second right answer
    // silently disabled the guard on the first.
    const blockOf = (name) => {
      const start = CODE.indexOf(`exports.${name} = onRequest(`);
      assert.ok(start > -1, `the ${name} wrapper must exist`);
      const next = CODE.indexOf('\nexports.', start + 1);
      return CODE.slice(start, next === -1 ? CODE.length : next);
    };
    const wrapper = blockOf('editCatalog');
    assert.ok(!/exports\./.test(wrapper.slice(20)), 'the block is bounded to one handler');
    assert.ok(/authorizeCatalogEdit\(\{ db: getDatabase\(\), verifyIdToken: \(t\) => getAuth\(\)\.verifyIdToken\(t\) \}, req, rid\)/.test(wrapper),
      'the wrapper must inject the REAL id-token verifier and the REAL membership db');
    // the diff must be against the ACTIVE PUBLISHED version, not against the store's own draft
    const body = CODE.slice(CODE.indexOf('async function readActiveBuiltForEdit'), CODE.indexOf('exports.editCatalog'));
    assert.ok(/getActiveVersionIdForEdit\(fs, rid\)/.test(body), 'the live build must resolve the ACTIVE version pointer');
    assert.ok(/no_active_version/.test(body), 'and fail closed when there is no active version — never silently diff against nothing');
    assert.ok(!/sourceRefOf|readSource/.test(body), 'it must NOT read the store as "live" — the diff is against what is SERVING');
    ok('the index.js wrapper is exported, delegates to the tested core, injects the real verifier, and diffs against the ACTIVE version');
  }

  // ── (9) THE CAS VALUE MUST SURVIVE A ROUND TRIP EXACTLY ─────────────────────────────────────
  // Firestore commit times carry NANOSECOND precision. An ISO-string round trip truncates them, so the
  // reconstructed precondition never equals the stored updateTime — and every conditional write fails,
  // meaning no edit is ever saveable. That was a real bug here, found only by the emulator e2e; this
  // pins it in the fast chain so it cannot come back unnoticed.
  {
    const { encodeUpdateTime } = require('./edit-catalog-handler');
    const ts = { seconds: 1789012345, nanoseconds: 123456789 };
    const enc = encodeUpdateTime(ts);
    assert.strictEqual(enc, '1789012345.123456789', 'the encoding keeps every nanosecond digit');
    assert.strictEqual(encodeUpdateTime({ seconds: 5, nanoseconds: 7 }), '5.000000007', 'and pads them, so ordering and equality are stable');
    assert.strictEqual(encodeUpdateTime({ seconds: 5, nanoseconds: 0 }), '5.000000000', 'including zero');
    // the lossy encoding this replaced: proof the distinction is real rather than theoretical
    assert.notStrictEqual(enc, new Date(ts.seconds * 1000).toISOString(), 'an ISO string is NOT equivalent — it cannot carry nanoseconds');
    // and index.js must reconstruct BOTH halves
    const CODE = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8')
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');
    assert.ok(/new FirestoreTimestamp\(Number\(sec\), Number\(nanos\)\)/.test(CODE),
      'index.js must rebuild the Timestamp from seconds AND nanoseconds');
    assert.ok(/toPrecondition: decodeUpdateTimeForEdit/.test(CODE), 'and inject that decoder into the handler');
    assert.ok(/updateTime: snap\.updateTime \? encodeUpdateTimeForEdit\(snap\.updateTime\)/.test(CODE),
      'and encode with the SAME codec it decodes with — two codecs would drift');
    ok('the CAS value round-trips losslessly (nanoseconds preserved) and index.js encodes/decodes with one codec');
  }

  // ── 1D D4-P1 — THE DELETION CLAIM IS SERVER-OWNED AND SURVIVES AN ORDINARY SAVE ─────────────
  /* 🔴 THE SAVE IS A REPLACEMENT, AND THAT IS WHAT MAKES THIS DANGEROUS. Every top-level field the
     stored doc has and the incoming source lacks is explicitly NULLED, so a save that does not
     re-send `deleted_ids` does not merely fail to persist it — it DELETES the merchant's standing
     deletion claim. And the obvious fix, echoing the claim back from the client on every save, hands
     the client the very binding that exists to stop a replay. So the server carries it forward. */
  {
    const db = stubFirestore(baseSource());
    db.state.source.data.deleted_ids = { ids: ['KEEPME1'], base_version: ACTIVE, base_generation: 0 };
    const r = await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
      { restaurantId: RID, source: withPrice(31), baseSourceUpdateTime: T0 }, {});
    assert.strictEqual(r.status, 200, `an ordinary save succeeds: ${JSON.stringify(r.body).slice(0, 160)}`);
    assert.deepStrictEqual(db.state.source.data.deleted_ids, { ids: ['KEEPME1'], base_version: ACTIVE, base_generation: 0 },
      '🔴 an ordinary content edit WIPED the standing deletion claim — the replacement write ate a field the client never sent');
    ok('an ordinary save that mentions no deletions preserves the standing claim — the replacement cannot eat it');
  }

  // ── A CLIENT-SUPPLIED BASE IS DISCARDED, NOT COMPARED ──────────────────────────────────────
  {
    const db = stubFirestore(baseSource());
    const src = withPrice(32);
    src.deleted_ids = { ids: ['DOOMED1'], base_version: 'CLIENT-LIES', base_generation: 99 };
    const r = await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
      { restaurantId: RID, source: src, baseSourceUpdateTime: T0, deleted_ids_loaded_base: { version: ACTIVE, generation: 0 } }, {});
    assert.strictEqual(r.status, 200, `the declaration is accepted: ${JSON.stringify(r.body).slice(0, 160)}`);
    assert.deepStrictEqual(db.state.source.data.deleted_ids, { ids: ['DOOMED1'], base_version: ACTIVE, base_generation: 0 },
      '🔴 a CLIENT-supplied base was stored — the binding must come from the live pointer, and a client value is discarded unread');
    ok('the merchant declares WHICH ids; the server writes the base from the live pointer and ignores the client\'s');
  }

  // ── 🔴 A STALE CLAIM IS NOT SILENTLY REBOUND BY AN UNRELATED EDIT ──────────────────────────
  {
    const db = stubFirestore(baseSource());
    const stale = { ids: ['OLD1'], base_version: 'v-superseded', base_generation: 0 };
    db.state.source.data.deleted_ids = { ...stale };
    const before = db.state.writes.filter((w) => w.op === 'update').length;

    const src = withPrice(33);
    src.deleted_ids = { ids: ['OLD1', 'NEW1'] };          // an unrelated, legitimate further deletion
    const r = await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
      { restaurantId: RID, source: src, baseSourceUpdateTime: T0, deleted_ids_loaded_base: { version: ACTIVE, generation: 0 } }, {});
    assert.strictEqual(r.status, 409, `the save is refused: ${JSON.stringify(r.body).slice(0, 160)}`);
    assert.strictEqual(r.body.error, 'deleted_ids_stale_baseline', 'and refused by name');
    assert.deepStrictEqual(r.body.existing_ids, ['OLD1'], 'the refusal reports what the editor must re-show');
    assert.deepStrictEqual(db.state.source.data.deleted_ids, stale, '🔴 the stored claim must be untouched by a refused save');
    assert.strictEqual(db.state.writes.filter((w) => w.op === 'update').length, before,
      '🔴 a refused save must not write at all — not the claim, and not the content edit riding with it');

    const r2 = await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
      { restaurantId: RID, source: src, baseSourceUpdateTime: T0, deleted_ids_reviewed: true, deleted_ids_loaded_base: { version: ACTIVE, generation: 0 } }, {});
    assert.strictEqual(r2.status, 200, `the acknowledged save lands: ${JSON.stringify(r2.body).slice(0, 160)}`);
    assert.deepStrictEqual(db.state.source.data.deleted_ids, { ids: ['OLD1', 'NEW1'], base_version: ACTIVE, base_generation: 0 },
      'the whole set is restamped at the live baseline, only after an explicit re-review');
    ok('a stale claim refuses a silent rebind and writes nothing; the same edit WITH the ack lands restamped');
  }

  // ── WITHDRAWING EVERY DELETION IS ALWAYS ALLOWED ───────────────────────────────────────────
  {
    const db = stubFirestore(baseSource());
    db.state.source.data.deleted_ids = { ids: ['OLD1'], base_version: 'v-superseded', base_generation: 0 };
    const src = withPrice(34);
    src.deleted_ids = { ids: [] };
    const r = await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
      { restaurantId: RID, source: src, baseSourceUpdateTime: T0 }, {});
    assert.strictEqual(r.status, 200, `withdrawing is accepted even from a stale claim: ${JSON.stringify(r.body).slice(0, 160)}`);
    /* null, not undefined: the handler's existing convention for a field the new source does not
       carry is to write null ("cleared"), and validateDeletionClaim reads null as "none declared". */
    assert.strictEqual(db.state.source.data.deleted_ids, null, 'and the claim is cleared rather than left standing');
    assert.deepStrictEqual(validateDeletionClaim(db.state.source.data.deleted_ids, { activeVersionId: ACTIVE, activeGeneration: 0 }),
      { ids: [], declared: false }, 'a cleared claim reads back as no deletion declared');
    ok('withdrawing every deletion is allowed even from a stale claim — the merchant is never trapped by their own editor');
  }

  // ── 🔴 THE LOADED-BASE GUARD: WHAT THE MERCHANT SAW, NOT MERELY WHAT IS LIVE ───────────────
  /* The server writes the base, but writing it from a fresh read ALONE leaves a false-accept: if an
     activation lands between the merchant loading their draft and saving it, the server stamps a
     baseline they never saw and publish then validates it cleanly. A transaction does not close that
     — atomicity ties the stamp to the write, not to what was reviewed. A claim-changing save must
     therefore carry the baseline the editor displayed, and is refused when it no longer matches. */
  {
    // (1) an activation lands between load and save → the claim-changing save is refused, nothing written.
    const db = stubFirestore(baseSource());
    const before = db.state.writes.filter((w) => w.op === 'update').length;
    const src = withPrice(35);
    src.deleted_ids = { ids: ['DOOMED2'] };
    const r = await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
      { restaurantId: RID, source: src, baseSourceUpdateTime: T0,
        deleted_ids_loaded_base: { version: 'v-the-merchant-saw', generation: 0 } }, {});
    assert.strictEqual(r.status, 409, `refused: ${JSON.stringify(r.body).slice(0, 160)}`);
    assert.strictEqual(r.body.error, 'deleted_ids_base_moved', 'and refused by name');
    assert.strictEqual(db.state.writes.filter((w) => w.op === 'update').length, before,
      '🔴 a refused claim-changing save must write nothing at all');

    // (2) SENSITIVITY: the same save with a MATCHING loaded base is accepted, stamped from the
    //     server's own read — so the refusal is about the baseline having moved, not about the field.
    const db2 = stubFirestore(baseSource());
    const r2 = await editCatalogCore({ db: db2, authorize: allow, readActiveBuilt: db2.readActiveBuilt },
      { restaurantId: RID, source: src, baseSourceUpdateTime: T0,
        deleted_ids_loaded_base: { version: ACTIVE, generation: 0 } }, {});
    assert.strictEqual(r2.status, 200, `accepted: ${JSON.stringify(r2.body).slice(0, 160)}`);
    assert.deepStrictEqual(db2.state.source.data.deleted_ids, { ids: ['DOOMED2'], base_version: ACTIVE, base_generation: 0 },
      'stamped from the SERVER read, with the client value used only as a guard');
    ok('a claim-changing save is refused when the baseline it was reviewed against has moved, and accepted when it matches');
  }

  {
    // (3) an ordinary content edit needs NO loaded base, even while a claim stands — ordinary editing
    //     stays frictionless, which is what keeps a guard like this from being removed later.
    const db = stubFirestore(baseSource());
    const standing = { ids: ['KEEP2'], base_version: ACTIVE, base_generation: 0 };
    db.state.source.data.deleted_ids = { ...standing };
    const r = await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
      { restaurantId: RID, source: withPrice(36), baseSourceUpdateTime: T0 }, {});
    assert.strictEqual(r.status, 200, `an ordinary edit still saves: ${JSON.stringify(r.body).slice(0, 160)}`);
    assert.deepStrictEqual(db.state.source.data.deleted_ids, standing, 'and the claim is preserved verbatim, not re-stamped');

    // (4) a claim-CHANGING save that omits the loaded base is refused rather than trusted.
    const src = withPrice(37);
    src.deleted_ids = { ids: ['KEEP2', 'NEW2'] };
    const r2 = await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
      { restaurantId: RID, source: src, baseSourceUpdateTime: T0 }, {});
    assert.strictEqual(r2.status, 409, `a claim-changing save with NO loaded base must be refused: ${JSON.stringify(r2.body).slice(0, 160)}`);
    assert.strictEqual(r2.body.error, 'deleted_ids_unbound', 'a claim-changing save without the loaded base is unbound');
    assert.deepStrictEqual(db.state.source.data.deleted_ids, standing, 'and nothing moved');
    ok('an ordinary edit needs no loaded base and preserves the claim; a claim-CHANGING save without one is refused');
  }

  {
    // (5) the loaded-base guard does NOT bypass the stale-existing rebind rule. Both must hold: the
    //     merchant reviewed against the live menu AND the standing claim is not being silently dragged
    //     forward. A matching loaded base satisfies the first and says nothing about the second.
    const db = stubFirestore(baseSource());
    const stale = { ids: ['OLD2'], base_version: 'v-superseded', base_generation: 0 };
    db.state.source.data.deleted_ids = { ...stale };
    const src = withPrice(38);
    src.deleted_ids = { ids: ['OLD2', 'NEW3'] };
    const r = await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
      { restaurantId: RID, source: src, baseSourceUpdateTime: T0,
        deleted_ids_loaded_base: { version: ACTIVE, generation: 0 } }, {});
    assert.strictEqual(r.status, 409, `still refused: ${JSON.stringify(r.body).slice(0, 160)}`);
    assert.strictEqual(r.body.error, 'deleted_ids_stale_baseline',
      '🔴 a matching loaded base let a STALE standing claim be rebound without the re-review ack');
    assert.deepStrictEqual(db.state.source.data.deleted_ids, stale, 'and the stale claim is untouched');
    ok('a matching loaded base does not bypass the rebind ack — the two guards answer different questions');
  }

  // ── 🔴 THE DOCUMENTED RECOVERY FROM A STALE CLAIM MUST ACTUALLY WORK ───────────────────────
  /* The portal path is: receive deleted_ids_stale_baseline, re-show the merchant existing_ids, resend
     the SAME ids with the acknowledgment. Those ids are identical to the stored ones by construction,
     so the echo test classified the recovery as "nothing changed" and preserved the OLD base — 200 to
     the merchant, claim still stale, publishing refused forever, and the only exit was withdrawing
     every deletion. The echo rule exists to keep ordinary editing frictionless; it had closed the one
     door out of the state it was meant to help with. */
  {
    const db = stubFirestore(baseSource());
    const stale = { ids: ['OLD3'], base_version: 'v-superseded', base_generation: 0 };
    db.state.source.data.deleted_ids = { ...stale };
    const src = withPrice(39);
    src.deleted_ids = { ids: ['OLD3'] };                       // the SAME ids, re-shown and re-confirmed

    // (b) without the ack it is still an echo: the old base stands, so the silent rebind stays closed.
    const noAck = await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
      { restaurantId: RID, source: src, baseSourceUpdateTime: T0 }, {});
    assert.strictEqual(noAck.status, 200, `an unacknowledged resend still saves: ${JSON.stringify(noAck.body).slice(0, 140)}`);
    assert.deepStrictEqual(db.state.source.data.deleted_ids, stale,
      '🔴 an UNACKNOWLEDGED resend of the same ids rebound the base — that is the silent rebind, through the echo path');

    // (c) with the ack but a STALE loaded base, the loaded-base guard still refuses.
    const wrongBase = await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
      { restaurantId: RID, source: src, baseSourceUpdateTime: db.state.source.updateTime, deleted_ids_reviewed: true,
        deleted_ids_loaded_base: { version: 'v-the-merchant-saw', generation: 0 } }, {});
    assert.strictEqual(wrongBase.body.error, 'deleted_ids_base_moved',
      `🔴 an acknowledged resend skipped the loaded-base guard: ${JSON.stringify(wrongBase.body).slice(0, 140)}`);
    assert.deepStrictEqual(db.state.source.data.deleted_ids, stale, 'and nothing moved');

    // (a) the real recovery: same ids, ack, matching loaded base → rebound at the LIVE pair.
    // Each save advances the stored revision, so the next one must be conditional on the CURRENT value.
    const ok2 = await editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt },
      { restaurantId: RID, source: src, baseSourceUpdateTime: db.state.source.updateTime, deleted_ids_reviewed: true,
        deleted_ids_loaded_base: { version: ACTIVE, generation: 0 } }, {});
    assert.strictEqual(ok2.status, 200, `the acknowledged recovery saves: ${JSON.stringify(ok2.body).slice(0, 140)}`);
    assert.deepStrictEqual(db.state.source.data.deleted_ids, { ids: ['OLD3'], base_version: ACTIVE, base_generation: 0 },
      '🔴 THE RECOVERY PATH DID NOT REBIND — the merchant re-reviewed the list and is still stuck with a stale claim');
    ok('the documented stale-claim recovery rebinds at the live pair; without the ack it stays an echo, and a stale loaded base still refuses');
  }

  console.log(`edit-catalog: OK (${n})`);
  FINISHED = true;
})().catch((e) => { console.error(e); process.exit(1); });
