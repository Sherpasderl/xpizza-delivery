'use strict';
// DISH PHOTOS A2 step 10 — the photo publish through the REAL publishEditedCore (publishVersion stubbed, recording its input; the
// photos dependency faked). Brand: the code-seeded x_pizza source (owner + fiscal ack, as in category-rename-flow). Run:
// node photos/publish-wiring.test.js
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const { publishEditedCore } = require('../catalog/publish-edited-handler');
const { catalogDiff, issueEditToken, sha256 } = require('../catalog/catalog-edit');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs } = require('../catalog/source-store');
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const { buildCatalogV2 } = require('../catalog/form-menu-source');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('publish-wiring: FAILED — exited without completing'); process.exitCode = 1; } });
const RID = 'x_pizza', ACTIVE = 'v-active-1', T1 = '2026-10-31T11:00:00.000000Z';
const P1 = '1'.repeat(32);
const clone = (x) => JSON.parse(JSON.stringify(x));
const base = () => clone(buildSourceFromCode(RID));
const KEY = base().items[0].key;
const builtOf = (src) => { const i = sourceToBuildInputs(src); return { ...buildCatalogV2(RID, { formData: i.formData, priceTable: i.priceTable }), extras: i.extras }; };
const liveRead = async () => { const src = base(); const i = sourceToBuildInputs(src); return { built: builtOf(src), versionId: ACTIVE, extraRecords: buildCatalogV2(RID, { formData: i.formData, priceTable: i.priceTable }).extras }; };
const owner = async () => ({ ok: true, uid: 'tb_owner', role: 'owner', actor: 'tb@x.hn' });
// the token the SAVE would have issued for this draft (its diff includes the photo lines when maps are given)
function tokenFor(draft, { active = null, withPhotos = true } = {}) {
  const live = builtOf(base());
  const { inputs, built } = buildSourceCandidate(RID, draft);
  const d = { ...built, extras: inputs.extras };
  const diff = withPhotos ? catalogDiff({ ...live, photos: active }, { ...d, photos: draft.photos || null }) : catalogDiff(live, d);
  return issueEditToken({ rid: RID, baseActiveVersionId: ACTIVE, sourceUpdateTime: T1, sourceHash: sha256(draft), diff });
}
function run(draft, { photos, token, publishThrows = null } = {}) {
  const calls = { publish: [] };
  const deps = { db: {}, authorize: owner, readActiveBuilt: liveRead, readDraft: async () => ({ source: draft, updateTime: T1 }),
    publishVersion: async (_db, r, input, opts) => { calls.publish.push({ input, opts }); if (publishThrows) throw publishThrows; if (input.photos) await input.photos.commit({}, r, 'v-new-2'); return { versionId: 'v-new-2' }; },
    ...(photos ? { photos } : {}) };
  return publishEditedCore(deps, { restaurantId: RID, token: token || tokenFor(draft, { active: null }), fiscalAck: true }, {}).then((r) => ({ r, calls }));
}
function photosDep({ active = null, prepareThrows = null, readFails = false } = {}) {
  const calls = { prepare: [], commit: [], marked: [] };
  return { calls, dep: {
    readActive: async (rid, vid) => { assert.deepStrictEqual([rid, vid], [RID, ACTIVE]); if (readFails) throw new Error('down'); return active; },
    prepare: async (rid, map) => { calls.prepare.push(map); if (prepareThrows) throw prepareThrows; return map ? { doc: { schema: 1, entries: map }, pids: [P1], gens: {} } : null; },
    hook: (prep) => (prep ? { commit: async (db, rid, vid) => { calls.commit.push(vid); } } : null),
    markPublished: async (rid, pids) => { calls.marked.push(pids); },
  } };
}

(async () => {
  // ── 1. dark: the dependency with no photo data → the response and the publishVersion input are byte-identical ──
  {
    const a = await run(base());
    const p = photosDep();
    const b = await run(base(), { photos: p.dep });
    assert.strictEqual(a.r.status, 200, `premise ${JSON.stringify(a.r.body).slice(0, 200)}`);
    assert.strictEqual(JSON.stringify(b.r), JSON.stringify(a.r), 'PW-DARK-RESPONSE-IDENTICAL');
    assert.strictEqual(JSON.stringify(b.calls.publish[0].input), JSON.stringify(a.calls.publish[0].input), 'PW-DARK-INPUT-IDENTICAL (no photos key)');
    assert.deepStrictEqual(p.calls.marked, [], 'PW-DARK-NOTHING-MARKED');
    ok('dark: with the photos dependency and no photo data, the response and the publishVersion input are byte-identical');
  }
  // ── 2. a draft with photos: prepare → the hook in publishVersion's input (committed before the flip) → markPublished after ──
  {
    const draft = { ...base(), photos: { [KEY]: { state: 'pid', pid: P1 } } };
    const p = photosDep();
    const { r, calls } = await run(draft, { photos: p.dep });
    assert.strictEqual(r.status, 200, `PW-PUBLISH ${JSON.stringify(r.body).slice(0, 300)}`);
    assert.deepStrictEqual(p.calls.prepare, [draft.photos], 'PW-PREPARE-THE-DRAFT-MAP');
    assert.ok(calls.publish[0].input.photos && typeof calls.publish[0].input.photos.commit === 'function', 'PW-HOOK-PASSED-TO-PUBLISH-VERSION');
    assert.deepStrictEqual(p.calls.commit, ['v-new-2'], 'PW-HOOK-COMMITTED');
    assert.deepStrictEqual(p.calls.marked, [[P1]], 'PW-MARK-PUBLISHED-AFTER');
    assert.ok(r.body.diff.changed.some((l) => l.field === 'photo' && l.key === KEY), 'PW-DIFF-HAS-PHOTO-LINE');
    ok('photos: prepare(draft map) → the commit hook rides into publishVersion (run before the flip) → markPublished after; the diff carries the photo line');
  }
  // ── 3. a token issued WITHOUT the photo lines (pre-step-10 save) no longer matches → superseded, nothing published ──
  {
    const draft = { ...base(), photos: { [KEY]: { state: 'pid', pid: P1 } } };
    const { r, calls } = await run(draft, { photos: photosDep().dep, token: tokenFor(draft, { withPhotos: false }) });
    assert.deepStrictEqual([r.status, r.body.error], [409, 'edit_superseded'], 'PW-TOKEN-WITHOUT-PHOTO-LINES-SUPERSEDED');
    assert.strictEqual(calls.publish.length, 0, 'PW-SUPERSEDED-NOTHING-PUBLISHED');
    ok('a token whose diff lacks the photo lines → 409 edit_superseded, publishVersion never called');
  }
  // ── 4. refusals map to the frozen codes; the pointer never moves ──
  {
    const draft = { ...base(), photos: { [KEY]: { state: 'pid', pid: P1 } } };
    const e = (code) => Object.assign(new Error(`${code}: x`), { code });
    for (const [label, opts, status, code] of [
      ['prepare: deleting pid', { prepareThrows: e('photo_unavailable') }, 409, 'photo_unavailable'],
      ['prepare: copy failed', { prepareThrows: e('photo_publish_failed') }, 503, 'photo_publish_failed'],
      ['active map unreadable', { readFails: true }, 503, 'store_unavailable'],
    ]) {
      const { r, calls } = await run(draft, { photos: photosDep(opts).dep });
      assert.deepStrictEqual([r.status, r.body.error], [status, code], `PW-REFUSAL ${label}`);
      assert.strictEqual(calls.publish.length, 0, `PW-REFUSAL-NOTHING-PUBLISHED ${label}`);
    }
    const p = photosDep();
    const lost = await run(draft, { photos: p.dep, publishThrows: new Error('photo_unavailable: photo 111 became deleting') });
    assert.deepStrictEqual([lost.r.status, lost.r.body.error], [409, 'photo_unavailable'], 'PW-COMMIT-LOST-TO-SWEEPER');
    assert.deepStrictEqual(p.calls.marked, [], 'PW-COMMIT-LOST-NOTHING-MARKED');
    const pf = await run(draft, { photos: photosDep().dep, publishThrows: new Error('photo_publish_failed: x') });
    assert.deepStrictEqual([pf.r.status, pf.r.body.error, pf.r.body.retryable], [503, 'photo_publish_failed', true], 'PW-PUBLISH-FAILED-RETRYABLE');
    ok('prepare photo_unavailable → 409, photo_publish_failed → 503 retryable, an unreadable active map → 503; a commit lost to the sweeper → 409 photo_unavailable, nothing marked');
  }

  FINISHED = true;
  console.log(`publish-wiring: OK (${n})`);
})().catch((e) => { console.error('publish-wiring: FAILED —', e && e.stack || e); process.exit(1); });
