'use strict';
require('./_emulator-required')('firestore');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'c2a-evidence-secret-'.padEnd(48, 'x');   // the edit token is unsigned without it
/**
 * 1D D4-c2a — BINDING EVIDENCE FROM THE REAL WRITERS, on the Firestore emulator with the real SDK (PLAN-D4c2a rev 9
 * §2–§4, §6). Run: npm run test:c2a-evidence
 *
 * Every evidence document asserted here was written by the production code path — publishVersion / rollbackVersion
 * (flipPointer) / bootstrapIdentityStamps / publishEditedCore — inside its own transaction. Each one is checked against
 * an INDEPENDENT recomputation from what actually committed (finalDigestOfVersion over the version docs read back),
 * and its id/header against the pointer read back. The collision cells prove "nothing was committed" on the REAL
 * transaction (the in-memory fake cannot: it applies writes immediately).
 */
const assert = require('assert');
const admin = require('firebase-admin');
const { publishVersion, rollbackVersion, snapshotRefOf } = require('../catalog/catalog-publish');
const { publishEditedCore } = require('../catalog/publish-edited-handler');
const { editCatalogCore } = require('../catalog/edit-catalog-handler');
const { getRestaurantMenu } = require('../catalog/catalog-menu');
const { sourceToBuildInputs, encodeUpdateTime, sourceRefOf } = require('../catalog/source-store');
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { bootstrapIdentityStamps } = require('../catalog/identity-bootstrap');
const { idsColOf, keysColOf, encodeKey } = require('../catalog/identity-registry');
const E = require('../catalog/identity-evidence');
const { H } = require('../catalog/evidence-encoding');

const versionsColOf = (d, r) => d.collection('restaurants').doc(r).collection('versions');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('c2a-evidence: FAILED — exited without completing'); process.exitCode = 1; } });

if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza' });
const db = admin.firestore();
const STAMP = Date.now();

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────
const evidenceOf = async (rid) => (await db.collection('restaurants').doc(rid).collection(E.EVIDENCE_COL).get()).docs;
const evidenceCount = async (rid) => (await evidenceOf(rid)).length;
const readEvidence = async (rid, docId) => { const s = await E.evidenceRefOf(db, rid, docId).get(); return s.exists ? s.data() : null; };
async function recompute(rid, versionId) {
  const v = versionsColOf(db, rid).doc(versionId);
  const [i, x] = await Promise.all([v.collection('menu_items').get(), v.collection('extras').get()]);
  return E.finalDigestOfVersion({ dishDocs: i.docs, extraDocs: x.docs });
}
async function candidateFromSource(rid) {
  const src = (await sourceRefOf(db, rid).get()).data();
  const inputs = sourceToBuildInputs(src);
  const built = buildCatalogV2(rid, { formData: inputs.formData, priceTable: inputs.priceTable });
  return { items: built.items, structure: built.structure, extras: inputs.extras,
    extraRecords: (src.extras || []).map((e) => ({ key: e.key, price: e.price, display: e.display })) };
}
async function publish(rid, expectedActive, tag) {
  const snap = await sourceRefOf(db, rid).get();
  const r = await publishVersion(db, rid, { ...(await candidateFromSource(rid)), source_sha: tag },
    { expected: { activeVersionId: expectedActive, draftRevision: encodeUpdateTime(snap.updateTime) } });
  return r.versionId || r.version_id || r;
}
async function addDishToSource(rid, name) {
  const src = (await sourceRefOf(db, rid).get()).data();
  const first = (src.items || [])[0];
  const used = new Set((src.items || []).map((o) => String(o && o.display && o.display.id)));
  let uiId = 9000; while (used.has(String(uiId))) uiId += 1;
  const row = { ...first, key: name, name, display: { ...(first.display || {}), id: uiId, name } };
  delete row.display.identity_id;
  await sourceRefOf(db, rid).update({ items: (src.items || []).concat([row]),
    structure: { ...src.structure, item_order: (src.structure.item_order || []).concat([name]) } });
}
/* The activation evidence for the CURRENT pointer, checked against what committed: id = activationDocId(version,
   generation), vid = H(version), final_digest = an independent recomputation from the version docs read back. */
async function assertActivationEvidence(rid, intent) {
  const p = await getActivePointer(db, rid);
  const docId = E.activationDocId(p.generation);
  const ev = await readEvidence(rid, docId);
  assert.ok(ev, `🔴 no activation evidence at ${docId} for ${rid}@${p.generation}`);
  assert.strictEqual(ev.v, 1); assert.strictEqual(ev.certified, true); assert.strictEqual(ev.vid, H(p.version)); assert.strictEqual(ev.generation, p.generation);
  assert.strictEqual(ev.intent, intent);
  assert.ok(ev.at && typeof ev.at.toMillis === 'function', 'at is the server timestamp');
  const rc = await recompute(rid, p.version);
  assert.deepStrictEqual({ final_digest: ev.final_digest, final_count: ev.final_count }, rc,
    '🔴 final_digest does not equal the recomputation from the COMMITTED version docs — the evidence describes a version other than the one that went live');
  const rec = (await versionsColOf(db, rid).doc(p.version).get()).data() || {};
  assert.strictEqual(ev.seq_c, rec.seq); assert.strictEqual(ev.rev_c, rec.identity_revision === undefined ? 'o:absent' : rec.identity_revision);
  assert.deepStrictEqual(Object.keys(ev).sort(), ['at', 'certified', 'ch', 'final_count', 'final_digest', 'generation', 'intent', 'observed_digest', 'plan', 'relocated_count',
    'rev_c', 'seq_c', 'stampmap_counts', 'stampmap_digest', 'v', 'vid'].sort());
  return { ev, pointer: p, docId };
}
// Everything a refused activation must leave exactly as it was (plan §4).
async function stateOf(rid, versionIds = []) {
  const docs = async (col) => (await col.get()).docs.map((d) => [d.id, d.data()]).sort();
  const ptr = await db.collection('restaurants').doc(rid).collection('meta').doc('active_version').get();
  const out = {
    pointer: ptr.exists ? ptr.data() : null,
    snapshot: await (async () => { const s = await snapshotRefOf(db, rid).get(); return s.exists ? s.data() : null; })(),
    ids_dish: await docs(idsColOf(db, rid, 'dish')), ids_extra: await docs(idsColOf(db, rid, 'extra')),
    keys_dish: await docs(keysColOf(db, rid, 'dish')), keys_extra: await docs(keysColOf(db, rid, 'extra')),
    source: (await sourceRefOf(db, rid).get()).data() || null,
  };
  for (const v of versionIds) {
    const vref = versionsColOf(db, rid).doc(v);
    out[`version:${v}`] = { rec: ((await vref.get()).data() || null), items: await docs(vref.collection('menu_items')), extras: await docs(vref.collection('extras')) };
  }
  return JSON.parse(JSON.stringify(out));
}
const captureLogs = async (fn) => {
  const logs = []; const real = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try { await fn(); } finally { console.log = real; }
  return logs;
};
// Copy a whole version (record + subcollections) to another id — to stage a MAXIMUM-LENGTH (1,500-byte) version id.
async function copyVersion(rid, from, to, patchRecord = (r) => r, patchDoc = (d) => d) {
  const src = versionsColOf(db, rid).doc(from); const dst = versionsColOf(db, rid).doc(to);
  await dst.set({ ...patchRecord((await src.get()).data()), version: to });   // the record names itself (catalog-menu.js versionIdentity)
  for (const sub of ['menu_items', 'extras', 'meta']) {
    for (const d of (await src.collection(sub).get()).docs) await dst.collection(sub).doc(d.id).set(sub === 'meta' ? d.data() : patchDoc(d.data()));
  }
}

// A merchant with NO extras at all (no extra categories declared, exposed or attached) — and, being a synthetic
// restaurant id, no code-side price tables: see the disclosure in cell 12.
function zeroExtrasSource() {
  const t = JSON.parse(JSON.stringify(buildSourceFromCode('x_pizza')));
  t.extras = [];
  t.structure = { ...t.structure, extra_categories: [], extras_by_category: Object.fromEntries(Object.keys(t.structure.extras_by_category || {}).map((k) => [k, []])),
    exposure: { ...(t.structure.exposure || {}), category_allow: Object.fromEntries(Object.keys((t.structure.exposure || {}).category_allow || {}).map((k) => [k, []])), item_overrides: {} } };
  for (const it of t.items) { if (it.display) delete it.display.identity_id; }
  return t;
}

(async () => {
  const RID = 'x_pizza';
  await sourceRefOf(db, RID).set(buildSourceFromCode(RID));

  // ── 1. an UNCERTIFIED activation records EXACTLY the §2a minimal doc; the post-flip pass runs as today ─────────
  let seedVersion;
  {
    const logs = await captureLogs(async () => { seedVersion = await publish(RID, null, 'c2a-seed'); });
    const p = await getActivePointer(db, RID);
    const docs = await evidenceOf(RID);
    assert.deepStrictEqual(docs.map((d) => d.id), [E.activationDocId(p.generation)], 'exactly one evidence doc, at g{G20(gen)}');
    const m = docs[0].data();
    const rec = (await versionsColOf(db, RID).doc(seedVersion).get()).data() || {};
    assert.deepStrictEqual(Object.keys(m).sort(), ['at', 'certified', 'ch', 'generation', 'intent', 'rev_c', 'seq_c', 'v', 'vid']);
    assert.strictEqual(m.certified, false); assert.strictEqual(m.vid, H(seedVersion)); assert.strictEqual(m.generation, p.generation);
    assert.strictEqual(m.intent, 'publish'); assert.strictEqual(m.seq_c, rec.seq); assert.strictEqual(m.ch, require('../catalog/evidence-encoding').D(rec.content_hash));
    assert.ok(logs.some((l) => l.includes('identity_postflip_pass')), 'the uncertified post-flip identity pass still runs (catalog-publish.js:1552-1580)');
    ok(`an UNCERTIFIED publish records EXACTLY the §2a minimal doc at ${docs[0].id} {v, certified:false, vid, generation ${m.generation}, intent, ch, seq_c, rev_c ${m.rev_c}, at}; the post-flip identity pass still runs`);
  }

  // ── 2. BOOTSTRAP CERTIFICATION writes certification evidence, matching what it stamped ──────────────────────────
  {
    const before = await getActivePointer(db, RID);
    const rep = await bootstrapIdentityStamps(db, RID);
    assert.strictEqual(rep.stamped, true, 'premise — bootstrap stamped');
    const rec = (await versionsColOf(db, RID).doc(seedVersion).get()).data();
    const docId = E.certificationDocId(before.generation, rec.identity_revision);
    const ev = await readEvidence(RID, docId);
    assert.ok(ev, `🔴 no certification evidence at ${docId}`);
    assert.strictEqual(ev.kind, 'certify'); assert.strictEqual(ev.certified, true); assert.strictEqual(ev.vid, H(seedVersion));
    assert.strictEqual(ev.observed_generation, before.generation); assert.strictEqual(ev.rev_c, rec.identity_revision);
    const rc = await recompute(RID, seedVersion);
    assert.deepStrictEqual({ final_digest: ev.final_digest, final_count: ev.final_count }, rc, '🔴 certification final_digest ≠ recomputation from the stamped docs');
    assert.strictEqual(ev.checks_count, rep.dishes + rep.extras, 'one check per stamped object');
    assert.strictEqual(await evidenceCount(RID), 2, 'the seed minimal doc + this certification');
    ok(`bootstrap certification records evidence at ${docId}: kind certify, observed_generation ${before.generation}, final_digest = recomputation from the stamped docs (${ev.final_count} objects), ${ev.checks_count} checks`);
  }

  // ── 3. a certified UNCHANGED republish: both kinds are the EMPTY derived plan, verified:false ───────────────────
  let base;
  {
    base = await publish(RID, seedVersion, 'c2a-base');
    const { ev } = await assertActivationEvidence(RID, 'publish');
    // captured BEFORE the :865 continue; the §2E.7 frozen golden vector for plan_digest(derived, empty) — ENC2 (rev 14)
    const EMPTY_DERIVED = 'L_MTI5ZkTsrspaoJzAvCPQjPtZjx7bkoB7hjXCa4DK8';
    for (const k of ['dish', 'extra']) {
      assert.deepStrictEqual(ev.plan[k], { mints: 0, moves: 0, restores: 0, retires: 0, deletions: 0, verified: false, plan_digest: EMPTY_DERIVED },
        `${k}: an unchanged republish skips verifyPlan — recorded as the EMPTY DERIVED plan (its exact digest), never implying the verifier ran`);
    }
    assert.strictEqual(ev.stampmap_counts.verified, ev.final_count, 'every stamp verified');
    assert.strictEqual(ev.relocated_count, 0);
    ok(`a certified UNCHANGED republish records evidence: both kinds = the EMPTY derived plan (verified:false, counts 0), ${ev.stampmap_counts.verified} stamps verified, final = recomputation`);
  }

  // ── 4. a certified publish WITH A MINT: the mint write-back is in final, the dish plan verified:true ───────────
  let minted;
  {
    await addDishToSource(RID, `Zz C2a Mint ${STAMP}`);
    minted = await publish(RID, base, 'c2a-mint');
    const { ev } = await assertActivationEvidence(RID, 'publish');
    assert.strictEqual(ev.plan.dish.mints, 1); assert.strictEqual(ev.plan.dish.verified, true);
    assert.strictEqual(ev.plan.extra.verified, false, 'the unchanged kind beside a mint skips verifyPlan');
    assert.strictEqual(ev.plan.extra.plan_digest, 'L_MTI5ZkTsrspaoJzAvCPQjPtZjx7bkoB7hjXCa4DK8', 'the empty DERIVED plan, exactly (§2E.7 golden, ENC2)');
    assert.notStrictEqual(ev.plan.dish.plan_digest, ev.plan.extra.plan_digest);
    const items = (await versionsColOf(db, RID).doc(minted).collection('menu_items').get()).docs.map((d) => d.data());
    assert.ok(items.some((d) => d.key === `Zz C2a Mint ${STAMP}` && d.display && d.display.identity_id), 'premise — the version carries the minted stamp');
    ok('a certified publish WITH A MINT records evidence: dish plan mints 1 verified:true, extra = empty derived plan (verified:false); final includes the minted write-back (= recomputation)');
  }

  // ── 5. a ROLLBACK across a deletion: registry moved, relocated refusals, missing key row ({none:true}) ──────────
  {
    const target = minted;
    const tItems = (await versionsColOf(db, RID).doc(target).collection('menu_items').get()).docs.map((d) => d.data());
    const victim = tItems.find((d) => d.display && d.display.identity_id && !String(d.key).startsWith('Zz'));
    await addDishToSource(RID, `Zz C2a Forward ${STAMP}`);
    const moved = await publish(RID, target, 'c2a-forward');
    await idsColOf(db, RID, 'dish').doc(victim.display.identity_id).update({ status: 'retired', retired_at: new Date().toISOString() });
    await keysColOf(db, RID, 'dish').doc(encodeKey(victim.key)).delete();
    await rollbackVersion(db, RID, target, { expected: { activeVersionId: moved } });
    const { ev } = await assertActivationEvidence(RID, 'rollback');
    assert.ok(ev.relocated_count >= 1, 'the relocated refusal is counted');
    assert.ok((ev.stampmap_counts.stamp_unregistered || 0) >= 1, 'the missing key row is the stamp_unregistered verdict ({none:true} address)');
    assert.strictEqual(ev.plan.dish.verified, true); assert.ok(ev.plan.dish.restores >= 1, 'the restore is counted');
    assert.strictEqual(ev.plan.extra.verified, true, 'a no-op reconciliation is still a computed reconciliation (captured before the :837 continue)');
    ok(`a ROLLBACK across a deletion records evidence: intent rollback, relocated ${ev.relocated_count} (stamp_unregistered ${ev.stampmap_counts.stamp_unregistered}), dish restores ${ev.plan.dish.restores} retires ${ev.plan.dish.retires} verified:true, extra no-op verified:true`);
  }

  // ── 6. a rollback where the key row DISAGREES (names another id): recorded if it lands, nothing if refused ─────
  {
    const cur = await getActivePointer(db, RID);
    await addDishToSource(RID, `Zz C2a Fwd2 ${STAMP}`);
    const moved = await publish(RID, cur.version, 'c2a-fwd2');
    const tItems = (await versionsColOf(db, RID).doc(cur.version).collection('menu_items').get()).docs.map((d) => d.data());
    const [a, b] = tItems.filter((d) => d.display && d.display.identity_id && !String(d.key).startsWith('Zz')).slice(0, 2);
    const before = await evidenceCount(RID);
    await keysColOf(db, RID, 'dish').doc(encodeKey(a.key)).update({ canonical_id: b.display.identity_id });
    let refused = null;
    try { await rollbackVersion(db, RID, cur.version, { expected: { activeVersionId: moved } }); } catch (e) { refused = e.message; }
    if (refused) {
      assert.strictEqual(await evidenceCount(RID), before, '🔴 a refused rollback committed evidence');
      assert.strictEqual((await getActivePointer(db, RID)).version, moved);
      ok(`a DISAGREEMENT rollback is refused by the existing reconciliation (${refused.split(':')[0]}) and commits NO evidence`);
    } else {
      const { ev } = await assertActivationEvidence(RID, 'rollback');
      assert.ok((ev.stampmap_counts.stamp_registry_disagrees || 0) >= 1 && ev.relocated_count >= 1);
      ok(`a DISAGREEMENT rollback lands and records stamp_registry_disagrees ${ev.stampmap_counts.stamp_registry_disagrees} (relocated)`);
    }
    await keysColOf(db, RID, 'dish').doc(encodeKey(a.key)).update({ canonical_id: a.display.identity_id });   // restore coherence for later cells
  }

  // ── 7. COLLISION on a rollback: typed error, NOTHING committed (real transaction) ───────────────────────────────
  {
    const cur = await getActivePointer(db, RID);
    await addDishToSource(RID, `Zz C2a Fwd3 ${STAMP}`);
    const moved = await publish(RID, cur.version, 'c2a-fwd3');
    const p = await getActivePointer(db, RID);
    const planted = E.activationDocId(p.generation + 1);
    await E.evidenceRefOf(db, RID, planted).create({ planted: true });
    const before = await stateOf(RID, [cur.version, moved]);
    const evBefore = await evidenceCount(RID);
    let err = null;
    const logs = await captureLogs(async () => { try { await rollbackVersion(db, RID, cur.version, { expected: { activeVersionId: moved } }); } catch (e) { err = e; } });
    assert.ok(err && /^flip_evidence_exists: /.test(err.message), `typed refusal, got ${err && err.message}`);
    assert.strictEqual(err.cause && err.cause.code, 6, 'the Firestore ALREADY_EXISTS is kept as the cause');
    assert.deepStrictEqual(await stateOf(RID, [cur.version, moved]), before, '🔴 the refused rollback changed pointer / snapshot / registry / source / version stamps');
    assert.strictEqual(await evidenceCount(RID), evBefore);
    assert.deepStrictEqual(await readEvidence(RID, planted), { planted: true }, 'the colliding doc is untouched');
    assert.ok(!logs.some((l) => l.includes('identity_postflip_pass')), 'no post-flip pass');
    await E.evidenceRefOf(db, RID, planted).delete();
    ok('a COLLISION on the rollback evidence id → flip_evidence_exists (cause: ALREADY_EXISTS); pointer, snapshot, registry, source and version stamps UNCHANGED; no post-flip pass');
  }

  // ── 8. COLLISION through the PORTAL HANDLER (save → publishEditedCore): generic failure mapping, nothing committed ─
  {
    const cur = await getActivePointer(db, RID);
    const owner = async () => ({ ok: true, uid: 'u_o', role: 'owner', actor: 'o@x.hn' });
    const toPrecondition = (v) => { if (typeof v !== 'string') return v; const [sec, nanos] = v.split('.'); return new admin.firestore.Timestamp(Number(sec), Number(nanos)); };
    const readDraft = async () => { const snap = await sourceRefOf(db, RID).get(); return { source: snap.data(), updateTime: encodeUpdateTime(snap.updateTime) }; };
    const readActiveBuilt = async () => {
      const menu = await getRestaurantMenu(db, RID);
      const inputs = sourceToBuildInputs({ items: menu.items.map((i) => ({ key: i.key, price: i.price, display: i.display })),
        extras: menu.extras.map((e) => ({ key: e.key, price: e.price, display: e.display })), structure: menu.structure });
      const built = buildCatalogV2(RID, { formData: inputs.formData, priceTable: inputs.priceTable });
      return { built: { ...built, extras: inputs.extras }, versionId: (await getActivePointer(db, RID)).version };
    };
    // the merchant's real save: a one-unit price edit, through editCatalogCore, which issues the edit token
    const srcSnap = await sourceRefOf(db, RID).get();
    const edited = JSON.parse(JSON.stringify(srcSnap.data())); edited.items[0].price += 1; if (edited.items[0].display) edited.items[0].display.price = edited.items[0].price;
    const saved = await editCatalogCore({ db, authorize: owner, readActiveBuilt, toPrecondition },
      { restaurantId: RID, source: edited, baseSourceUpdateTime: encodeUpdateTime(srcSnap.updateTime) }, {});
    assert.strictEqual(saved.status, 200, `premise — the save succeeded: ${JSON.stringify(saved.body).slice(0, 200)}`);
    /* Stage: a document already sits at the id this publish's activation will take — g{G20(current generation + 1)}. Ids are
       generation-keyed (rev 11 §2), so the collision is staged before the publish, with no instrumentation of the writer. */
    const plantedId = E.activationDocId(cur.generation + 1);
    await E.evidenceRefOf(db, RID, plantedId).create({ planted: true });
    const mirrorCalls = [];
    const before = await stateOf(RID, [cur.version]);
    let reply = null;
    const logs = await captureLogs(async () => {
      reply = await publishEditedCore({ db, authorize: owner, readActiveBuilt, readDraft, publishVersion,
        mirror: async () => { mirrorCalls.push(1); }, alarm: async () => {}, sourceSha: 'c2a-collide' },
      { restaurantId: RID, token: saved.body.token, fiscalAck: true }, {});
    });
    assert.deepStrictEqual(await readEvidence(RID, plantedId), { planted: true }, 'the colliding doc is untouched');
    assert.strictEqual(reply.status, 500, `generic failure mapping (publish-edited-handler.js:197), got ${JSON.stringify(reply).slice(0, 300)}`);
    assert.strictEqual(reply.body.error, 'publish_failed'); assert.ok(/^flip_evidence_exists: /.test(reply.body.detail), reply.body.detail);
    assert.deepStrictEqual(await stateOf(RID, [cur.version]), before, '🔴 the refused publish changed pointer / snapshot / registry / source / the live version');
    assert.strictEqual(mirrorCalls.length, 0, 'no mirror write');
    assert.ok(!logs.some((l) => l.includes('identity_postflip_pass')), 'no post-flip pass');
    await E.evidenceRefOf(db, RID, plantedId).delete();
    // and the same edit, re-saved, publishes normally once the id is free — the refusal was the collision alone
    const s2 = await sourceRefOf(db, RID).get();
    const saved2 = await editCatalogCore({ db, authorize: owner, readActiveBuilt, toPrecondition },
      { restaurantId: RID, source: s2.data(), baseSourceUpdateTime: encodeUpdateTime(s2.updateTime) }, {});
    const ok2 = await publishEditedCore({ db, authorize: owner, readActiveBuilt, readDraft, publishVersion, sourceSha: 'c2a-after' },
      { restaurantId: RID, token: saved2.body.token, fiscalAck: true }, {});
    assert.strictEqual(ok2.status, 200, `after the collision the publish succeeds: ${JSON.stringify(ok2.body).slice(0, 200)}`);
    await assertActivationEvidence(RID, 'publish');
    ok('a COLLISION through the portal (save → publishEditedCore) → the existing generic 500 publish_failed (detail flip_evidence_exists); pointer, snapshot, registry, source and the live version UNCHANGED; no mirror write; no post-flip pass; the next publish succeeds and records evidence');
  }

  // ── 9. MAXIMUM-LENGTH (1,500-byte) version id: rollback (activation) AND certification succeed ─────────────────
  {
    const cur = await getActivePointer(db, RID);
    const LONG = `v-${'L'.repeat(1498)}`;
    assert.strictEqual(Buffer.byteLength(LONG), 1500);
    await copyVersion(RID, cur.version, LONG);
    await rollbackVersion(db, RID, LONG, { expected: { activeVersionId: cur.version } });
    const { docId } = await assertActivationEvidence(RID, 'rollback');
    assert.strictEqual(docId.length, 21, `fixed 21-char id for a 1,500-byte version id`);
    // certification: an UNCERTIFIED copy under another 1,500-byte id, activated by rollback, then bootstrapped
    const LONG2 = `w-${'U'.repeat(1498)}`;
    const strip = (d) => { const c = JSON.parse(JSON.stringify(d)); if (c.display) delete c.display.identity_id; return c; };
    await copyVersion(RID, seedVersion, LONG2, (r) => { const c = { ...r }; delete c.identity_certified; delete c.identity_revision; return c; }, strip);
    const p2 = await getActivePointer(db, RID);
    await rollbackVersion(db, RID, LONG2, { expected: { activeVersionId: p2.version } });
    const pre = await getActivePointer(db, RID);
    const rep = await bootstrapIdentityStamps(db, RID);
    assert.strictEqual(rep.stamped, true, 'premise — the long-id version was certified');
    const rec = (await versionsColOf(db, RID).doc(LONG2).get()).data();
    const cid = E.certificationDocId(pre.generation, rec.identity_revision);
    const cev = await readEvidence(RID, cid);
    assert.ok(cev && cev.vid === H(LONG2) && cid.length === 42, 'certification evidence for the 1,500-byte id; the id is the fixed 42 chars');
    ok(`MAXIMUM-LENGTH (1,500-byte) version ids: a certified rollback and a bootstrap certification both succeed and record evidence under bounded ids (${docId.length} / ${cid.length} chars)`);
  }

  // ── 10. the MAX-SIZE evidence document COMMITS on the real emulator (serialization; case B: a 1,500-byte rid) ──
  {
    const ridB = 'r'.repeat(1500);
    const ev = E.buildActivationEvidence({ versionId: 'v'.repeat(1500), generation: Number.MAX_SAFE_INTEGER, intent: 'rollback',
      record: { content_hash: 'x'.repeat(20000), seq: 'bad', identity_revision: null }, docs: {}, plans: {} });
    ev.data.stampmap_counts = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`stamp_id_claims_other_na${String(i).padStart(2, '0')}`, Number.MAX_SAFE_INTEGER]));
    await db.runTransaction(async (tx) => { tx.create(E.evidenceRefOf(db, ridB, ev.docId), E.withAt(ev.data)); });
    const back = await readEvidence(ridB, ev.docId);
    assert.strictEqual(back.ch, ev.data.ch); assert.strictEqual(Object.keys(back.stampmap_counts).length, 12);
    ok('the MAXIMUM-SIZE activation evidence (1,500-byte rid + versionId, 20,000-byte content_hash, 12 max verdict keys, max ints) COMMITS through a real transaction and reads back');
  }

  // ── 11. a THIRD synthetic restaurant (brand-agnostic) with ZERO extras: certify + publish + mint ────────────────
  {
    const R3 = `synth_${STAMP % 100000}`;
    const third = zeroExtrasSource();
    await sourceRefOf(db, R3).set(third);
    let v1;
    try { v1 = await publish(R3, null, 'c2a-r3-seed'); } catch (e) { throw new Error(`premise — a third restaurant must publish like any other: ${e.message}`); }
    assert.strictEqual(await evidenceCount(R3), 1, 'uncertified → the minimal doc');
    assert.strictEqual((await evidenceOf(R3))[0].data().certified, false);
    await bootstrapIdentityStamps(db, R3);
    assert.strictEqual(await evidenceCount(R3), 2, '+ certification evidence');
    const v2 = await publish(R3, v1, 'c2a-r3-base');
    await addDishToSource(R3, `Zz R3 Mint ${STAMP}`);
    await publish(R3, v2, 'c2a-r3-mint');
    const { ev } = await assertActivationEvidence(R3, 'publish');
    assert.strictEqual(ev.plan.dish.mints, 1);
    assert.deepStrictEqual({ ...ev.plan.extra, plan_digest: 0 }, { mints: 0, moves: 0, restores: 0, retires: 0, deletions: 0, verified: false, plan_digest: 0 }, 'zero extras: the extra kind is the empty derived plan');
    assert.strictEqual(await evidenceCount(R3), 4, 'one per activation (dense) + the certification');
    ok(`a THIRD synthetic restaurant (${R3}, ZERO extras): the minimal record while uncertified, then certification + two certified publishes (incl. a mint) record evidence = recomputation; the empty extra kind is the empty derived plan`);
  }

  // ── 12. COLLISION on certification: certify_evidence_exists, the version stays UNcertified ───────────────────
  {
    const R4 = `synth_c_${STAMP % 100000}`;
    /* zero extras: bootstrap refuses `bootstrap_unpriced_extra` for a synthetic rid WITH extras — a PRE-EXISTING
       brand-coupling outside c2a (reported in the hand-back), not something this cell is about. */
    await sourceRefOf(db, R4).set(zeroExtrasSource());
    const v = await publish(R4, null, 'c2a-r4');
    const p = await getActivePointer(db, R4);
    const planted = E.certificationDocId(p.generation, 1);
    await E.evidenceRefOf(db, R4, planted).create({ planted: true });
    const before = await stateOf(R4, [v]);
    let err = null;
    try { await bootstrapIdentityStamps(db, R4); } catch (e) { err = e; }
    assert.ok(err && /^certify_evidence_exists: /.test(err.message), `typed refusal, got ${err && err.message}`);
    assert.deepStrictEqual(await stateOf(R4, [v]), before, '🔴 the refused certification changed the version, registry or source');
    assert.notStrictEqual(((await versionsColOf(db, R4).doc(v).get()).data() || {}).identity_certified, true, 'not certified');
    ok('a COLLISION on the certification evidence id → certify_evidence_exists; the version stays UNcertified with no stamps, registry and source UNCHANGED');
  }

  // ── 13. COLLISION on the UNCERTIFIED path (La Musa-shaped: an uncertified merchant's working publish) ───────────
  {
    const R5 = `synth_u_${STAMP % 100000}`;
    await sourceRefOf(db, R5).set(zeroExtrasSource());
    const v1 = await publish(R5, null, 'c2a-r5');                                   // g1 minimal
    const p = await getActivePointer(db, R5);
    const planted = E.activationDocId(p.generation + 1);
    await E.evidenceRefOf(db, R5, planted).create({ planted: true });
    const before = await stateOf(R5, [v1]);
    let err = null;
    const logs = await captureLogs(async () => { try { await publish(R5, v1, 'c2a-r5-2'); } catch (e) { err = e; } });
    assert.ok(err && /^flip_evidence_exists: /.test(err.message), `typed refusal, got ${err && err.message}`);
    assert.deepStrictEqual(await stateOf(R5, [v1]), before, '🔴 the refused UNCERTIFIED publish changed pointer / snapshot / registry / source');
    assert.ok(!logs.some((l) => l.includes('identity_postflip_pass')), 'no post-flip pass after a refused flip');
    await E.evidenceRefOf(db, R5, planted).delete();
    const logs2 = await captureLogs(async () => { await publish(R5, v1, 'c2a-r5-3'); });
    const ev = await readEvidence(R5, planted);
    assert.ok(ev && ev.certified === false && ev.generation === p.generation + 1, 'once free, the uncertified publish lands and writes its minimal record');
    assert.ok(logs2.some((l) => l.includes('identity_postflip_pass')), 'and its post-flip identity pass runs as today');
    ok('a COLLISION on the UNCERTIFIED path → flip_evidence_exists; pointer, snapshot, registry and source UNCHANGED; no post-flip pass; once free, the publish lands with its minimal record and the post-flip pass runs as today');
  }

  FINISHED = true;
  console.log(`c2a-evidence: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('c2a-evidence FAILED:', e); process.exit(1); });
