'use strict';
// Portal 1D · D4-P1 Slice C — THE REAL SAVE → REAL PUBLISH ROUND TRIP, WITH A DELETION CLAIM.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:d4p1-roundtrip
//
// 🔴 WHY THE ROUND TRIP AND NOT TWO UNIT TESTS. The defect this exists for lived exactly BETWEEN the
// two handlers: the save issued its edit token over the incoming body while publish verified it
// against the draft it read back. Each handler was self-consistent and correct in isolation; what was
// wrong was that they hashed different things. So the only test that can see it is one that saves
// through the real save handler and then publishes through the real publish handler, against a real
// store — which is also the shape a merchant actually experiences.
const assert = require('assert');
// Fail-closed by design: the token is unsigned without it, so a test must supply one before requiring
// the modules that read it at load time.
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'd4p1-roundtrip-secret-'.padEnd(48, 'x');
const admin = require('firebase-admin');

admin.initializeApp({ projectId: 'demo-xpizza' });
const db = admin.firestore();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('d4p1-roundtrip(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

const { editCatalogCore } = require('../catalog/edit-catalog-handler');
const { publishEditedCore } = require('../catalog/publish-edited-handler');
const { publishVersion } = require('../catalog/catalog-publish');
const { sourceRefOf, canonicalize, encodeUpdateTime, readSource, sourceToBuildInputs } = require('../catalog/source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { getRestaurantMenu } = require('../catalog/catalog-menu');

const RID = 'x_pizza';
const owner = async () => ({ ok: true, uid: 'u_o', role: 'owner', actor: 'o@x.hn' });
/* The encoded revision is "<seconds>.<nanoseconds>" and must reconstruct to the EXACT Timestamp,
   nanoseconds included — a lossy round trip (via a Date, say) yields a precondition that can never
   match, so every conditional write fails and the save looks like an outage. This mirrors index.js's
   decodeUpdateTimeForEdit rather than inventing a second decoder. */
const toPrecondition = (v) => {
  if (typeof v !== 'string') return v;
  const [sec, nanos] = v.split('.');
  if (!/^\d+$/.test(sec || '') || !/^\d+$/.test(nanos || '')) return v;
  return new admin.firestore.Timestamp(Number(sec), Number(nanos));
};

const readDraft = async () => {
  const snap = await sourceRefOf(db, RID).get();
  return { source: snap.data(), updateTime: encodeUpdateTime(snap.updateTime) };
};
const readActiveBuilt = async () => {
  const menu = await getRestaurantMenu(db, RID);
  const inputs = sourceToBuildInputs({ items: menu.items.map((i) => ({ key: i.key, price: i.price, display: i.display })),
    extras: menu.extras.map((e) => ({ key: e.key, price: e.price, display: e.display })), structure: menu.structure });
  const built = buildCatalogV2(RID, { formData: inputs.formData, priceTable: inputs.priceTable });
  const live = await getActivePointer(db, RID);
  return { built: { ...built, extras: inputs.extras }, versionId: live.version };
};

const save = (source, extra = {}) => editCatalogCore({ db, authorize: owner, readActiveBuilt, toPrecondition },
  { restaurantId: RID, source, baseSourceUpdateTime: extra.base, ...extra.body }, {});
const publish = (token) => publishEditedCore({ db, authorize: owner, readActiveBuilt, readDraft, publishVersion, sourceSha: 'roundtrip' },
  { restaurantId: RID, token, fiscalAck: true }, {});

const currentSource = async () => (await sourceRefOf(db, RID).get()).data();
const currentRev = async () => encodeUpdateTime((await sourceRefOf(db, RID).get()).updateTime);
const bumpPrice = (src, delta) => {
  const s = JSON.parse(JSON.stringify(src));
  s.items[0].price += delta;
  if (s.items[0].display) s.items[0].display.price = s.items[0].price;
  return s;
};

(async () => {
  await sourceRefOf(db, RID).set(canonicalize(buildSourceFromCode(RID)));
  const { input } = require('../tools/publish-version').buildPublishCandidate(RID, { activeVersionId: null }, { source_sha: 'seed' });
  await publishVersion(db, RID, input, { expected: { activeVersionId: null } });

  /* 🔴 READ FRESH EACH TIME, not once up front. Every scenario below PUBLISHES, which advances the
     active version — so a loaded base captured at the start goes stale after the first one and the
     guard refuses, correctly. My first version of this suite hoisted it and read that refusal as a
     failure of the round trip rather than as the guard doing its job. */
  const loadedBase = async () => {
    const p = await getActivePointer(db, RID);
    return { version: p.version, generation: p.generation };
  };

  /* 🔴 EACH SCENARIO PUBLISHES AT MOST ONCE, AND ANY CLAIM IT NEEDS IS CREATED FRESH BEFORE IT.
     C validates the claim but does NOT consume it (consumption belongs with D's writer, which is the
     thing that actually retires the ids), so a claim SURVIVES a publish and goes stale at the next
     baseline. That is correct and expected for C. My first version of this suite chained the
     scenarios, so a claim left standing by one publish was legitimately stale by the next — and the
     cell read that as the round trip failing rather than as C-era semantics working. The property
     under test here is the TOKEN: what the save hashes must be what publish verifies. */
  const resetClaim = async () => { await sourceRefOf(db, RID).update({ deleted_ids: null }); };
  const saveOk = async (mutate, body = {}) => {
    const src = mutate(await currentSource());
    const base = await currentRev();
    const r = await save(src, { base, body });
    assert.strictEqual(r.status, 200, `save failed: ${JSON.stringify(r.body).slice(0, 200)}`);
    return r.body.token;
  };
  const publishOk = async (token, label) => {
    const p = await publish(token);
    assert.strictEqual(p.status, 200,
      `🔴 ${label}: SAVED BUT CANNOT PUBLISH (${p.body && p.body.error}) — the token hashes something other than what publish verifies, so this edit can never go live`);
  };

  {
    await resetClaim();
    await publishOk(await saveOk((s) => bumpPrice(s, 1)), 'no claim at all');
    ok('round trip: an edit with no deletion claim saves AND publishes');
  }
  {
    await resetClaim();
    const t = await saveOk((s) => { const x = bumpPrice(s, 1); x.deleted_ids = { ids: ['DOOM1'] }; return x; },
      { deleted_ids_loaded_base: await loadedBase() });
    await publishOk(t, 'a NEW claim');
    ok('round trip: a save that declares a NEW deletion claim saves AND publishes');
  }
  {
    /* The case that was broken outright: an ordinary edit made while a claim stands. Both saves happen
       before the publish, so the claim is still fresh — what is under test is the token, not staleness. */
    await resetClaim();
    await saveOk((s) => { const x = bumpPrice(s, 1); x.deleted_ids = { ids: ['DOOM2'] }; return x; },
      { deleted_ids_loaded_base: await loadedBase() });
    const t = await saveOk((s) => bumpPrice(s, 1));          // echoes the stored claim → preserved
    const stored = await currentSource();
    assert.deepStrictEqual(stored.deleted_ids.ids, ['DOOM2'], 'premise — the claim was preserved across the unrelated edit');
    await publishOk(t, 'an unrelated edit while a claim STANDS');
    ok('round trip: an ordinary edit made while a claim STANDS preserves it and still publishes');
  }
  {
    await resetClaim();
    await saveOk((s) => { const x = bumpPrice(s, 1); x.deleted_ids = { ids: ['DOOM3'] }; return x; },
      { deleted_ids_loaded_base: await loadedBase() });
    const t = await saveOk((s) => { const x = bumpPrice(s, 1); x.deleted_ids = { ids: [] }; return x; });
    assert.strictEqual((await currentSource()).deleted_ids, null, 'premise — the withdrawal cleared it');
    await publishOk(t, 'a WITHDRAWAL');
    ok('round trip: a withdrawal saves AND publishes');
  }
  {
    await resetClaim();                                       // stored deleted_ids is explicitly null
    await publishOk(await saveOk((s) => bumpPrice(s, 1)), 'a save after the claim was cleared');
    ok('round trip: a save against a stored deleted_ids:null saves AND publishes');
  }

  // 🔴 SENSITIVITY — the token still binds. An altered stored claim must NOT publish, or the fix has
  // simply stopped the token from checking anything.
  {
    const src = bumpPrice(await currentSource(), 1);
    src.deleted_ids = { ids: ['TAMPER1'] };
    const base = await currentRev();
    const r = await save(src, { base, body: { deleted_ids_loaded_base: await loadedBase() } });
    assert.strictEqual(r.status, 200, `the save succeeds: ${JSON.stringify(r.body).slice(0, 160)}`);

    // Someone edits the stored claim out from under the reviewed draft.
    const lb = await loadedBase();
    await sourceRefOf(db, RID).update({ deleted_ids: { ids: ['SOMETHING-ELSE'], base_version: lb.version, base_generation: lb.generation } });
    const p = await publish(r.body.token);
    assert.notStrictEqual(p.status, 200,
      '🔴 the token no longer binds the stored claim — a draft altered after review published anyway');
    assert.strictEqual(p.body.error, 'edit_superseded', 'and it reports as superseded');
    await sourceRefOf(db, RID).update({ deleted_ids: null });
    ok('sensitivity: a stored claim altered after review FAILS the token — it binds the draft publish actually reads');
  }

  FINISHED = true;
  console.log(`d4p1-roundtrip(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('D4P1 ROUNDTRIP (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
