'use strict';
// Portal 1A Task 7 — THE VALIDATOR ON EVERY PUBLISH PATH + THE POINTER-FLIP CAS.
//
// Two claims, and the first one is what makes the second worth anything:
//
//   COMPLETENESS IS STRUCTURAL, NOT A CHECKLIST. "Every publish path validates" is only as good as
//   the list of paths, and a list is a thing that goes out of date silently. So the list is not
//   trusted: the pointer doc has exactly ONE writer (flipPointer), flipPointer has exactly TWO
//   callers (publishVersion, rollbackVersion), and both validate and both CAS. That is proved by
//   scanning the production tree here, so a sixth path added next year either goes through the
//   chokepoint or fails this file.
//
//   🔴 THE SCAN READS FILES, IT DOES NOT GREP THEM. catalog/publish-edited-handler.js contains a
//   literal NUL byte (a security sentinel, '\0invalid'). git calls the file binary and grep drops it
//   silently — so a completeness sweep run with grep enumerates four publish paths, misses the fifth,
//   and reports success. That is the specific way this task could have been "finished" while the
//   portal publish path went unwired. The scanner below reads bytes with readFileSync and ASSERTS
//   that it saw that file, because a completeness proof that can silently skip a file is not one.
//
// Run: node catalog/publish-paths.test.js
const assert = require('assert');
const { readFileSync, readdirSync, statSync } = require('fs');
const { join, relative } = require('path');
const { makeDb } = require('./firestore-fake');
const { buildCatalogV2 } = require('./form-menu-source');
const { EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
const { publishVersion, rollbackVersion, previewVersion, flipPointer, acquireLease, releaseLease, serverNow, snapshotOf } = require('./catalog-publish');
const { getRestaurantMenu } = require('./catalog-menu');
const { contentHash } = require('./content-hash');
const { sourceRefOf } = require('./source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildPublishInput, readExpectation } = require('../tools/publish-version');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('publish-paths: FAILED — exited without completing'); process.exitCode = 1; } });

const ROOT = join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'public', 'coverage', 'test']);
const isTest = (f) => /\.test\.(js|mjs)$/.test(f) || /\.guard\.test\.js$/.test(f);
function productionFiles(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) productionFiles(full, out);
    else if (/\.(js|mjs)$/.test(name) && !isTest(name)) out.push(full);
  }
  return out;
}
const stripComments = (src) => src.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');

const pointerOf = async (db, rid) => {
  const s = await db.collection('restaurants').doc(rid).collection('meta').doc('active_version').get();
  return s.exists ? ((s.data() || {}).version || null) : null;
};
const inputFor = (rid, over = {}) => {
  const v2 = buildCatalogV2(rid);
  return { items: v2.items, structure: v2.structure, extras: EXTRAS_BY_RESTAURANT[rid] || {}, extraRecords: v2.extras, source_sha: 't7', ...over };
};
const publishFresh = async (db, rid, over = {}) => publishVersion(db, rid, inputFor(rid, over),
  { expected: { activeVersionId: await pointerOf(db, rid) } });

(async () => {
  // ══ 1. THE CHOKEPOINT — read, never grepped ═══════════════════════════════════════════════════
  {
    const files = productionFiles();
    const nulFile = files.find((f) => relative(ROOT, f) === 'catalog/publish-edited-handler.js');
    assert.ok(nulFile, 'non-vacuity: the sweep must find the portal publish path at all');
    const nulBytes = readFileSync(nulFile);
    assert.ok(nulBytes.includes(0),
      'premise: this file really does carry a NUL byte — if that ever stops being true, so does the reason this scan reads instead of grepping');
    assert.ok(readFileSync(nulFile, 'utf8').includes('publishVersion'),
      '🔴 the scanner must SEE the NUL-bearing publish path; a grep-based sweep drops it silently and reports four of five paths wired');
    assert.ok(files.length > 40, `non-vacuity: the sweep must really walk the tree (found ${files.length})`);

    // (a) ONE WRITER of the pointer doc.
    const writers = [];
    for (const full of files) {
      const code = stripComments(readFileSync(full, 'utf8'));
      let i = code.indexOf("doc('active_version')");
      while (i !== -1) {
        const after = code.slice(i, i + 160);
        if (/\.(set|create|update|delete)\s*\(/.test(after)) writers.push(relative(ROOT, full));
        i = code.indexOf("doc('active_version')", i + 1);
      }
      // pointerRefOf is the same reference by another name — it must not escape its own module.
      if (/\bpointerRefOf\b/.test(code) && relative(ROOT, full) !== 'catalog/catalog-publish.js') {
        writers.push(`${relative(ROOT, full)} (via pointerRefOf)`);
      }
    }
    assert.deepStrictEqual(writers, [],
      `🔴 something other than flipPointer writes the active_version pointer: ${writers.join(', ')}`);

    // (b) TWO CALLERS of flipPointer, both inside catalog-publish.js.
    const pub = stripComments(readFileSync(join(ROOT, 'catalog', 'catalog-publish.js'), 'utf8'));
    const callers = [];
    for (const full of files) {
      const code = stripComments(readFileSync(full, 'utf8'));
      const rel = relative(ROOT, full);
      if (rel === 'catalog/catalog-publish.js') continue;
      if (/\bflipPointer\s*\(/.test(code)) callers.push(rel);
    }
    assert.deepStrictEqual(callers, [], `🔴 flipPointer is called outside its own module: ${callers.join(', ')}`);
    const flipCalls = (pub.match(/await flipPointer\(/g) || []).length;
    assert.strictEqual(flipCalls, 2, `exactly two flips — publish and rollback — found ${flipCalls}`);
    // ...and both of them validate the candidate first.
    for (const fn of ['publishVersion', 'rollbackVersion']) {
      const start = pub.indexOf(`async function ${fn}(`);
      const body = pub.slice(start, pub.indexOf('async function', start + 10));
      assert.ok(body.includes('assertCandidateValid(') || body.includes('verifyVersionStructure('),
        `${fn} must validate the candidate before it can reach the flip`);
      assert.ok(/flipPointer\([^)]*expected\)/.test(body), `${fn} must pass its CAS expectation to the flip`);
    }
    ok(`chokepoint: ${files.length} production files READ (incl. the NUL-bearing portal path) — one pointer writer, two flip callers, both validating and both CAS-bound`);
  }

  // ══ 2. AN INVALID CANDIDATE MOVES NO POINTER — on every path ══════════════════════════════════
  {
    const db = makeDb();
    const rid = 'x_pizza';
    const good = (await publishFresh(db, rid)).versionId;
    assert.strictEqual(await pointerOf(db, rid), good, 'premise: a good version is live');

    // (a) PRE-PUBLISH — and it is refused before a single doc is written, so the bad candidate never
    //     becomes a version anyone could later roll back to.
    const versionsBefore = (await db.collection('restaurants').doc(rid).collection('versions').get()).docs.length;
    const v2 = buildCatalogV2(rid);
    const invalid = {
      'a dish in a category the menu does not declare': { items: v2.items.map((i, x) => (x === 0 ? { ...i, display: { ...i.display, cat: 'ghost_cat' } } : i)) },
      'an option priced differently from what it shows': { extraRecords: v2.extras.map((e, x) => (x === 0 ? { ...e, display: { ...e.display, price: e.price + 1 } } : e)) },
      'a dish name carrying markup': { items: v2.items.map((i, x) => (x === 0 ? { ...i, display: { ...i.display, desc: '<img src=x onerror=alert(1)>' } } : i)) },
    };
    for (const [what, over] of Object.entries(invalid)) {
      await assert.rejects(() => publishFresh(db, rid, over), (e) => {
        assert.strictEqual(e.code, 'publish_refused_invalid', `${what}: got ${e.code} — ${e.message}`);
        return true;
      }, `🔴 ${what} was published`);
      assert.strictEqual(await pointerOf(db, rid), good, `${what}: the pointer moved`);
    }
    assert.strictEqual((await db.collection('restaurants').doc(rid).collection('versions').get()).docs.length, versionsBefore,
      '🔴 an invalid candidate was WRITTEN as a version — refused at the flip is not refused at the door');
    ok(`pre-publish: ${Object.keys(invalid).length} invalid candidates refused before any write; pointer and version set unchanged`);
  }

  // ══ 3. THE PRE-FLIP CHECK IS THE VALIDATOR, NOT ONLY THE READER ═══════════════════════════════
  {
    // A version can be internally CONSISTENT and still invalid: tamper a persisted category and
    // restamp the content hash to match, and the reader is perfectly happy — everything it checks
    // agrees with everything else. Only the validator knows the category was never declared.
    const db = makeDb();
    const rid = 'x_pizza';
    const good = (await publishFresh(db, rid)).versionId;
    const { versionId: candidate } = await publishFresh(db, rid);           // a second, clean version
    const vref = db.collection('restaurants').doc(rid).collection('versions').doc(candidate);
    const d = (await vref.collection('menu_items').get()).docs[0];
    await d.ref.set({ ...d.data(), display: { ...d.data().display, cat: 'ghost_cat' } });
    const served = await getRestaurantMenu(db, rid).catch(() => null);       // pointer is on `candidate` now
    assert.strictEqual(served, null, 'premise: the hash still guards it until we restamp');
    const rec = await vref.get();
    const items = (await vref.collection('menu_items').get()).docs.map((x) => x.data());
    const extras = (await vref.collection('extras').get()).docs.map((x) => x.data());
    const structure = (await vref.collection('meta').doc('menu_structure').get()).data();
    // Two maps, NOT one: x_pizza sells a "Pepperoni" pizza AND a "Pepperoni" extra, so a merged
    // key→record map silently resolves the option to the dish. (Caught here by the hash refusing to
    // match — which is the check doing its job on the test that was restamping it.)
    const byItem = new Map(items.map((x) => [x.key, x]));
    const byExtra = new Map(extras.map((x) => [x.key, x]));
    await rec.ref.set({
      ...rec.data(),
      content_hash: contentHash({
        rid, schema_version: 2,
        items: structure.item_order.map((k) => byItem.get(k)),
        extras: structure.extra_order.map((k) => byExtra.get(k)),
        structure,
      }),
    });
    await assert.doesNotReject(() => getRestaurantMenu(db, rid),
      'premise: the READER is satisfied — the version is internally consistent');
    const { verifyVersionStructure } = require('./catalog-publish');
    await assert.rejects(() => verifyVersionStructure(db, rid, candidate), (e) => {
      assert.strictEqual(e.code, 'publish_refused_invalid', `got ${e.code}: ${e.message}`);
      return true;
    }, '🔴 a readable-but-invalid persisted candidate passed the pre-flip gate');
    void good;
    ok('pre-flip: a version the reader accepts can still be an invalid menu — the validator catches it, which is why both checks exist');
  }

  // ══ 4. THE CUTOVER CLI — the real input builder, not a reconstruction ═════════════════════════
  {
    for (const rid of ['x_pizza', 'la_musa']) {
      const input = buildPublishInput(rid, { source_sha: 'cli' });
      assert.ok(Array.isArray(input.extraRecords) && input.extraRecords.length === Object.keys(EXTRAS_BY_RESTAURANT[rid]).length,
        `${rid}: the CLI must carry a display record for every priced extra`);
      const db = makeDb();
      const res = await publishVersion(db, rid, input, { expected: { activeVersionId: null } });
      assert.ok(res.versionId, `${rid}: the CLI's own input publishes`);
      const menu = await getRestaurantMenu(db, rid);
      assert.strictEqual(menu.extras.length, input.extraRecords.length, `${rid}: and reads back complete`);
    }
    // --from-store: a store that has DIVERGED from code is refused by the parity gate, inside the
    // builder, before anything is written.
    const drifted = JSON.parse(JSON.stringify(buildSourceFromCode('la_musa')));
    const target = drifted.items.find((i) => i.key === 'dimsum_01');
    target.price += 7; target.display.price = target.price;
    assert.throws(() => buildPublishInput('la_musa', { source: drifted }), /parity_mismatch/,
      '🔴 --from-store published a store that no longer matches code');
    // ...and an UNCHANGED store builds an input identical to the code path.
    const fromStore = buildPublishInput('la_musa', { source: buildSourceFromCode('la_musa'), source_sha: 'cli' });
    assert.deepStrictEqual(fromStore, buildPublishInput('la_musa', { source_sha: 'cli' }),
      '--from-store and the code path must produce the same input for an unchanged store');
    ok('cutover CLI: both brands publish off buildPublishInput() itself; a drifted store is refused inside the builder, before any write');
  }

  // ══ 5. THE CAS — a stale publish never overwrites a newer one ═════════════════════════════════
  {
    const db = makeDb();
    const rid = 'x_pizza';
    const v1 = (await publishFresh(db, rid)).versionId;

    // A decides to publish, validated against v1. B gets there first.
    const aExpects = { activeVersionId: v1 };
    const v2id = (await publishVersion(db, rid, inputFor(rid), { expected: { activeVersionId: v1 } })).versionId;
    assert.strictEqual(await pointerOf(db, rid), v2id, 'premise: B won the race');

    await assert.rejects(() => publishVersion(db, rid, inputFor(rid), { expected: aExpects }),
      /flip_cas_stale/, '🔴 a publish validated against a superseded version flipped anyway');
    assert.strictEqual(await pointerOf(db, rid), v2id,
      "🔴 the stale publish overwrote the newer one — the merchant who reviewed against it never saw the change they buried");

    // A FIRST publish is an expectation too: `null` means "nothing is published yet", and a pointer
    // that appeared since is just as much a race as any other.
    const fresh = makeDb();
    await publishVersion(fresh, rid, inputFor(rid), { expected: { activeVersionId: null } });
    await assert.rejects(() => publishVersion(fresh, rid, inputFor(rid), { expected: { activeVersionId: null } }),
      /flip_cas_stale/, '🔴 a "first publish" landed on a restaurant that already had one');

    // And the expectation cannot be omitted — with a default it would hold only by caller discipline.
    const lone = makeDb();
    const token = await acquireLease(lone, rid);
    const snap = snapshotOf(rid, 'v-x', 1, {}, {});
    await assert.rejects(() => flipPointer(lone, rid, token, 'v-x', snap), /flip_requires_expectation/,
      '🔴 the flip accepted a caller that stated nothing');
    await releaseLease(lone, rid, token);
    ok('CAS: a publish validated against a superseded version aborts and the newer one stands; a first publish is an expectation too; the flip refuses a caller that states nothing');
  }

  // ══ 6. THE DRAFT CAS — an edit that moved since the review cannot land ════════════════════════
  {
    const db = makeDb();
    const rid = 'la_musa';
    const src = buildSourceFromCode(rid);
    await sourceRefOf(db, rid).set(src);
    const rev0 = (await sourceRefOf(db, rid).get()).updateTime;
    const encode = require('./source-store').encodeUpdateTime;
    const v1 = (await publishVersion(db, rid, inputFor(rid), { expected: { activeVersionId: null, draftRevision: encode(rev0) } })).versionId;
    assert.strictEqual(await pointerOf(db, rid), v1, 'premise: a draft-derived publish lands when the draft has not moved');

    // The merchant edits the draft between the review and the flip.
    await sourceRefOf(db, rid).set({ ...src, schema_version: 2 });
    await assert.rejects(() => publishVersion(db, rid, inputFor(rid), { expected: { activeVersionId: v1, draftRevision: encode(rev0) } }),
      /flip_cas_draft_stale/, '🔴 a publish landed a draft that had already moved on');
    assert.strictEqual(await pointerOf(db, rid), v1, 'and the pointer did not move');

    // A code-built publish has no draft to be stale against and must not pretend otherwise — by KEY,
    // so "no draft" and "a draft I did not look at" cannot be the same statement.
    const v2id = (await publishVersion(db, rid, inputFor(rid), { expected: { activeVersionId: v1 } })).versionId;
    assert.strictEqual(await pointerOf(db, rid), v2id, 'a publish with no draftRevision key skips the draft CAS entirely');

    // 🔴 PRESENT-AND-NULL IS A STATEMENT, NOT A SHRUG. readExpectation reports `draftRevision: null`
    // when the draft does not exist — a real claim ("there was no draft when I built this"), and one
    // that must be FALSIFIED by a draft that does exist. A value-keyed check (`if (draftRevision)`)
    // reads null as "no opinion" and skips the comparison entirely, which is the presence-by-value
    // trap in the one place where skipping it means publishing against a draft nobody looked at.
    await assert.rejects(() => publishVersion(db, rid, inputFor(rid), { expected: { activeVersionId: v2id, draftRevision: null } }),
      /flip_cas_draft_stale/, '🔴 a publish claiming there was no draft landed on a restaurant that has one');
    assert.strictEqual(await pointerOf(db, rid), v2id, 'and the pointer did not move');
    // ...and the claim is honoured when it is TRUE: no draft, null expectation, publish lands.
    const noDraft = makeDb();
    await assert.doesNotReject(() => publishVersion(noDraft, rid, inputFor(rid), { expected: { activeVersionId: null, draftRevision: null } }),
      'a genuinely draft-less restaurant publishes under a null draft revision');
    ok('draft CAS: an edited draft aborts the publish; an ABSENT-draft claim is checked rather than skipped; a code-built publish carries no draft key at all');
  }

  // ══ 7. ROLLBACK — gated by the same validator, bound by the same CAS ══════════════════════════
  {
    const db = makeDb();
    const rid = 'x_pizza';
    const v1 = (await publishFresh(db, rid)).versionId;
    const v2id = (await publishFresh(db, rid)).versionId;
    assert.strictEqual(await pointerOf(db, rid), v2id);

    // A rollback decided against v2 cannot land once something else has moved the pointer.
    const v3 = (await publishFresh(db, rid)).versionId;
    await assert.rejects(() => rollbackVersion(db, rid, v1, { expected: { activeVersionId: v2id } }),
      /flip_cas_stale/, '🔴 a rollback buried a publish the operator never saw');
    assert.strictEqual(await pointerOf(db, rid), v3, 'the newer version stands');

    // A rollback TARGET that the strict reader/validator refuses is not a rollback target.
    const vref = db.collection('restaurants').doc(rid).collection('versions').doc(v1);
    const d = (await vref.collection('extras').get()).docs[0];
    await d.ref.set({ key: d.data().key, price: d.data().price });          // strip its display record
    await assert.rejects(() => rollbackVersion(db, rid, v1, { expected: { activeVersionId: v3 } }),
      (e) => { assert.ok(/catalog_missing_display|publish_refused_invalid/.test(e.code), `got ${e.code}`); return true; },
      '🔴 rolled back to a version the reader cannot serve');
    assert.strictEqual(await pointerOf(db, rid), v3, 'and the pointer did not move');

    // ...while a healthy target still rolls back.
    await assert.doesNotReject(() => rollbackVersion(db, rid, v2id, { expected: { activeVersionId: v3 } }));
    assert.strictEqual(await pointerOf(db, rid), v2id, 'a strict-reader-compatible target rolls back normally');
    ok('rollback: CAS-bound like a publish, and refuses a target the serving reader could not serve — while a healthy target still rolls back');
  }

  // ══ 8. PREVIEW MOVES NOTHING ══════════════════════════════════════════════════════════════════
  {
    // previewVersion is listed as a publish path, and the honest answer is that it is not one: it
    // holds no lease, writes nothing, and cannot reach flipPointer. Asserted rather than assumed,
    // because "it only reads" is the kind of claim that stops being true quietly.
    const db = makeDb();
    const rid = 'x_pizza';
    const v1 = (await publishFresh(db, rid)).versionId;
    const v2id = (await publishFresh(db, rid)).versionId;
    const before = new Map(db._raw);
    const p = await previewVersion(db, rid, v1);
    assert.strictEqual(p.identity.version_id, v1, 'preview reads the version it was asked for, not the active one');
    assert.strictEqual(await pointerOf(db, rid), v2id, 'and the pointer is untouched');
    assert.strictEqual(db._raw.size, before.size, 'preview wrote no document');
    for (const [k, v] of db._raw) assert.strictEqual(v.updateTime, before.get(k).updateTime, `preview touched ${k}`);
    ok('preview: reads a specific version, writes not one byte, and cannot reach the pointer at all');
  }

  FINISHED = true;
  console.log(`publish-paths: OK (${n})`);
})().catch((e) => { console.error('publish-paths FAILED:', (e && e.stack) || e); process.exit(1); });
