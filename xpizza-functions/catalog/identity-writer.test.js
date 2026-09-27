'use strict';
/**
 * applyIdentityPlan — the atomic writer. Run: node catalog/identity-writer.test.js
 *
 * 🔴 EVERY CELL DRIVES THE WHOLE CHAIN: derivePlan → verifyPlan → applyIdentityPlan, against the
 * fake, inside one runTransaction. Driving the writer with a hand-built plan would test it against a
 * plan shape nothing produces; the composition is the thing that ships.
 *
 * 🔴 WHAT THE FAKE CANNOT SAY, and it is the half that matters most here. It does not model
 * read-after-write rejection, snapshot isolation, or conflict retry. So nothing below establishes that
 * the caller read these documents inside the transaction or before its first write. That is carried
 * by test/tx-read-after-write.emulator.test.js — which observed the real refusal — and by the flip's
 * own emulator cells. Said here so this file's green is not read as evidence about ordering.
 */
const assert = require('assert');
const { memFirestore } = require('./identity-fixture');
const { derivePlan } = require('./identity-derive');
const { verifyPlan } = require('./identity-plan');
const { readFileSync } = require('fs');
const { join } = require('path');
const { applyIdentityPlan } = require('./identity-writer');
/* 🔴 THE TEST USES THE SANCTIONED ISSUER RATHER THAN FORGING. Provenance means a hand-built object is
   refused before any other guard can be reached, so the cells that must reach a LATER guard build their
   adversarial verdict THROUGH issueVerdict — the same door verifyPlan and reconcileOnRollback use. That
   is not a bypass: it is how a future third issuer could get it wrong, which is exactly what those later
   guards exist for. A cell that forged instead would only ever prove the provenance check works. */
const { issueVerdict } = require('./identity-verdict');
const { reconcileOnRollback } = require('./identity-reconcile');
const { encodeKey, STATUS_LIVE, STATUS_RETIRED } = require('./identity-registry');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
/* 🔴 THE COMPLETION GUARD, and this file needed it: my first version split the cells across two
   IIFEs chained by a setTimeout, so a block that never ran would have exited 0 having printed
   nothing. That is the "exited without completing" failure the rest of the suite already guards. */
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('identity-writer: FAILED — exited without completing'); process.exitCode = 1; } });
const RID = 'x_pizza';
const P = `restaurants/${RID}/identity/dish`;
const idRow = (legacy_key, status, extra) => ({ legacy_key, status: status || STATUS_LIVE, created_at: 't0', kind: 'dish', ...(extra || {}) });

/* One helper for the whole chain, so a cell cannot accidentally skip the verifier — which is exactly
   the bypass the writer refuses at runtime. */
async function run({ ids = {}, keys = {}, candidateKeys = [], stamps = {}, retireIds = [], allocate = (k) => `NEW-${k}` }) {
  const db = memFirestore();
  const idMap = new Map(Object.entries(ids));
  const keyMap = new Map(Object.entries(keys).map(([nm, v]) => [encodeKey(nm), v]));
  for (const [id, row] of idMap) db._docs.set(`${P}/ids/${id}`, { ...row });
  for (const [enc, row] of keyMap) db._docs.set(`${P}/keys/${enc}`, { ...row });

  const plan = derivePlan({ candidateKeys: new Set(candidateKeys), stamps, ids: idMap, keys: keyMap, retireIds, allocate });
  const verified = verifyPlan(plan, { ids: idMap, keys: keyMap, complete: true });
  assert.strictEqual(verified.ok, true, `🔴 the derived plan was refused: ${verified.code} — ${verified.detail}`);

  let report = null;
  await db.runTransaction(async (tx) => {
    report = applyIdentityPlan(tx, { db, rid: RID, kind: 'dish', verified, existing: idMap, now: 't1' });
  });
  const id = (x) => db._docs.get(`${P}/ids/${x}`);
  const key = (nm) => db._docs.get(`${P}/keys/${encodeKey(nm)}`);
  return { db, plan, verified, report, id, key };
}

(async () => {
  // ── 1. A RENAME REWRITES BOTH PLANES AND PRESERVES THE ROW'S OTHER FIELDS ──────────────────
  {
    const r = await run({
      ids: { X: idRow('Margherita') }, keys: { Margherita: { canonical_id: 'X' } },
      candidateKeys: ['Margarita'], stamps: { Margarita: 'X' },
    });
    assert.strictEqual(r.id('X').legacy_key, 'Margarita', '🔴 the id row still claims the OLD name');
    assert.strictEqual(r.id('X').status, STATUS_LIVE, 'and it is still live');
    /* 🔴 tx.set IS A FULL REPLACE. A bare object here destroys created_at — the same mechanism that
       once dropped `generation` from the pointer write and silently reset the fence to zero. */
    assert.strictEqual(r.id('X').created_at, 't0', '🔴 the move DESTROYED created_at — tx.set is a full replace and the row was not spread');
    /* 🔴 EXISTENCE FIRST, THEN THE VALUE. Dereferencing straight into `.canonical_id` made a mutant
       that writes no reverse row die on a TypeError — "a crash, not a decision", and the message a
       reader gets is about undefined rather than about a name that resolves to nothing. */
    assert.ok(r.key('Margarita'), '🔴 the new reverse row is missing — the name resolves to nothing');
    assert.strictEqual(r.key('Margarita').canonical_id, 'X', '🔴 the new reverse row names the wrong id');
    assert.strictEqual(r.key('Margherita'), undefined, '🔴 the OLD reverse row survived — two names now resolve to one id');
    assert.strictEqual(r.id('X').created_at !== 't1', true, 'sensitivity: created_at is the ORIGINAL, not the write stamp');
    ok('a rename rewrites both planes in one transaction, preserves the id row\'s other fields, and removes the old reverse row');
  }

  // ── 2. A RETIREMENT KEEPS THE ID ROW — A FREED ID IS ALIAS REUSE ───────────────────────────
  {
  const r = await run({
    ids: { Y: idRow('Romana') }, keys: { Romana: { canonical_id: 'Y' } },
    candidateKeys: [], retireIds: ['Y'],
  });
  /* 🔴 THE ID ROW MUST REMAIN. Deleting it FREES the id, and a freed id handed to a new object makes
     every old record — an order snapshot, a factura line, a support ticket — resolve to a dish nobody
     meant. The reservation is permanent and is the whole reason retirement is not deletion. */
  assert.ok(r.id('Y'), '🔴 the retirement DELETED the id row — the id is freed and alias reuse is now possible');
  assert.strictEqual(r.id('Y').status, STATUS_RETIRED, '…and it is marked retired rather than left live');
  assert.strictEqual(r.id('Y').created_at, 't0', 'the row keeps its other fields');
  assert.strictEqual(r.key('Romana'), undefined, '🔴 the reverse row survived a retirement — the name still resolves to a retired id');
  ok('a retirement marks the id row RETIRED and keeps it, and removes only the reverse row');
  }

  // ── 3. A SWAP DELETES NOTHING, AND THE WRITER RE-ESTABLISHES THAT RATHER THAN TRUSTING IT ──
  {
  const s = await run({
    ids: { A: idRow('One'), B: idRow('Two') },
    keys: { One: { canonical_id: 'A' }, Two: { canonical_id: 'B' } },
    candidateKeys: ['One', 'Two'], stamps: { Two: 'A', One: 'B' },
  });
  assert.strictEqual(s.report.deleted, 0, `🔴 a swap deleted rows it is about to re-create: ${JSON.stringify(s.report)}`);
  assert.ok(s.key('One') && s.key('Two'), '🔴 a swap left a name resolving to nothing');
  assert.strictEqual(s.key('One').canonical_id, 'B', '🔴 after the swap One does not resolve to B');
  assert.strictEqual(s.key('Two').canonical_id, 'A', '🔴 after the swap Two does not resolve to A');
  assert.strictEqual(s.id('A').legacy_key, 'Two', 'and the id rows agree');
  assert.strictEqual(s.id('B').legacy_key, 'One', '…both of them');
  ok('a two-object name swap rewrites four rows, deletes none, and both planes agree afterwards');

  }

  // ── 4. AN ORDINARY REPUBLISH WRITES NOTHING AT ALL ─────────────────────────────────────────
  {
  const rp = await run({
    ids: { X: idRow('Margherita') }, keys: { Margherita: { canonical_id: 'X' } },
    candidateKeys: ['Margherita'], stamps: { Margherita: 'X' },
  });
  assert.deepStrictEqual(rp.report, { writes: 0, moved: 0, minted: 0, retired: 0, restored: 0, deleted: 0 },
    `🔴 an ordinary republish wrote to the registry: ${JSON.stringify(rp.report)} — identity is preserved by doing NOTHING, and rewriting every row on every publish is a cost nobody asked for`);
  assert.strictEqual(rp.id('X').created_at, 't0', 'and the row is untouched');
  ok('republishing the same objects performs ZERO registry writes');
  }

  // ── 5. THE WRITER REFUSES TO RUN WITHOUT THE VERIFIER'S PERMITTING VERDICT ─────────────────
  {
    /* 🔴 NO "WRITE IT ANYWAY" DOOR. A writer that accepted a bare plan would let one caller skip
       verification and still reach the writes — a guard that exists, passes its cells, and protects
       nothing because a path goes around it. That is the exact shape D-4 was deferred to avoid. */
    const db = memFirestore();
    const plan = { moves: [], mints: [{ id: 'Z', name: 'N' }], retires: [] };
    for (const bad of [undefined, null, { ok: false, code: 'plan_mint_id_exists' }, { ok: true }, { ok: true, deletions: 'no' }]) {
      let threw = null;
      try {
        await db.runTransaction(async (tx) => applyIdentityPlan(tx, { db, rid: RID, kind: 'dish', verified: bad, existing: new Map() }));
      } catch (e) { threw = (e && e.message) || String(e); }
      assert.ok(threw && /identity_writer_unverified/.test(threw),
        `🔴 the writer ran on verdict ${JSON.stringify(bad)} — verification is bypassable: ${threw}`);
    }
    assert.strictEqual(db._docs.get(`${P}/ids/Z`), undefined, '🔴 a refused call wrote anyway');

    let noTx = null;
    try { applyIdentityPlan({}, { db, rid: RID, kind: 'dish', verified: issueVerdict({ ok: true, deletions: [], lands: [] }, { plan, judged: ['moves', 'mints', 'retires'] }) }); }
    catch (e) { noTx = (e && e.message) || String(e); }
    assert.ok(noTx && /identity_writer_no_transaction/.test(noTx), '🔴 it wrote outside a transaction');
    ok('the writer refuses a missing, refusing or malformed verdict and refuses to write outside a transaction — verification cannot be skipped');
  }

  // ── 6. A NAME BOTH DELETED AND LANDED IS REFUSED, NOT RESOLVED BY WRITE ORDER ──────────────
  {
    /* verifyPlan already excludes a re-landed name from its deletions — that is what makes cell 3's
       swap delete nothing. This re-establishes it AT THE WRITER, because if it ever stopped being
       true the outcome would depend on the order of the loops: Firestore applies a transaction's
       writes in order and the last one wins, so the key row would be silently present or silently
       absent according to nothing anyone chose. */
    const db = memFirestore();
    const plan = { moves: [], mints: [{ id: 'Z', name: 'N' }], retires: [] };
    const forged = issueVerdict({ ok: true, lands: [{ id: 'Z', name: 'N', via: 'mint' }], releases: [],
      deletions: [{ name: 'N', encoded: encodeKey('N'), id: 'Z' }] }, { plan, judged: ['moves', 'mints', 'retires'] });
    let threw = null;
    try {
      await db.runTransaction(async (tx) => applyIdentityPlan(tx, { db, rid: RID, kind: 'dish', verified: forged, existing: new Map() }));
    } catch (e) { threw = (e && e.message) || String(e); }
    assert.ok(threw && /identity_writer_delete_lands/.test(threw),
      `🔴 a name both landed and deleted by one plan was written; the result depends on write order: ${threw}`);

    /* 🔴 AND THE SAME FOR A RESTORE, WHICH THE SWEEP SHOWED WAS UNCOVERED. reconcileOnRollback already
       excludes a re-landed name from its deletions, so a reconciliation-driven plan never exercises
       the writer's own check — a mutant removing `restores` from the landed set SURVIVED cell 8. The
       writer must not depend on its callers being careful: this forges the verdict the careful caller
       would never produce, which is the only way to reach the branch. */
    const restorePlan = { moves: [], mints: [], retires: [], restores: [{ id: 'R', name: 'N' }] };
    const forgedRestore = issueVerdict({ ok: true, lands: [], releases: [],
      deletions: [{ name: 'N', encoded: encodeKey('N'), id: 'R' }] }, { plan: restorePlan, judged: ['retires', 'restores'] });
    let threwRestore = null;
    try {
      await db.runTransaction(async (tx) => applyIdentityPlan(tx, { db, rid: RID, kind: 'dish', verified: forgedRestore, existing: new Map() }));
    } catch (e) { threwRestore = (e && e.message) || String(e); }
    assert.ok(threwRestore && /identity_writer_delete_lands/.test(threwRestore),
      `🔴 a name both RESTORED and deleted by one plan was written; whether the reverse row survives depends on which loop runs last: ${threwRestore}`);
    ok('a name both landed and deleted by one plan is refused at the writer — for mints AND for restores, not settled by which loop runs last');
  }

  // ── 7. THE ROLLBACK PATH: RESURRECT A RETIRED ID, BOTH PLANES, IN ONE TRANSACTION ──────────
  {
    /* 🔴 DRIVEN THROUGH reconcileOnRollback, NOT A HAND-BUILT PLAN. A restore plan written by hand
       would test the writer against a shape nothing produces; the composition is what ships. This is
       the headline case of the whole slice: a rollback to a version published BEFORE a deletion. */
    const db = memFirestore();
    const P2 = `restaurants/${RID}/identity/dish`;
    db._docs.set(`${P2}/ids/X`, { legacy_key: 'Margherita', status: STATUS_RETIRED, created_at: 't0', kind: 'dish', retired_at: 't0' });

    const idMap = new Map([['X', { legacy_key: 'Margherita', status: STATUS_RETIRED, created_at: 't0', kind: 'dish', retired_at: 't0' }]]);
    const keyMap = new Map();
    const plan = reconcileOnRollback({ targetStamps: { Margherita: 'X' }, activeStamps: {}, ids: idMap, keys: keyMap });
    assert.deepStrictEqual(plan.refusals, [], 'premise — the reconciliation permits this');
    assert.strictEqual(plan.restores[0].resurrects, true, 'premise — and knows it is a resurrection');

    let report = null;
    await db.runTransaction(async (tx) => {
      /* reconcileOnRollback's OWN verdict, as production passes it — not a pair assembled here. */
      report = applyIdentityPlan(tx, {
        db, rid: RID, kind: 'dish', now: 't1', existing: idMap, verified: plan.verdict,
      });
    });

    const id = db._docs.get(`${P2}/ids/X`);
    assert.strictEqual(id.status, STATUS_LIVE, '🔴 the resurrected id is not LIVE — the object the rollback restores still cannot be resolved');
    assert.strictEqual(id.legacy_key, 'Margherita', 'and it claims the target\'s name');
    assert.strictEqual(id.created_at, 't0', '🔴 the restore DESTROYED created_at — tx.set is a full replace and the row was not spread');
    /* 🔴 THE RETIREMENT IS NOT ERASED. `retired_at` stays alongside `restored_at`: the row keeps the
       history of having been round the loop, which is what tells a later reader this id was deleted
       and brought back rather than never touched. */
    assert.strictEqual(id.retired_at, 't0', '🔴 the row forgot it had ever been retired');
    assert.strictEqual(id.restored_at, 't1', 'and it records when it came back');

    const key = db._docs.get(`${P2}/keys/${encodeKey('Margherita')}`);
    assert.ok(key && key.canonical_id === 'X', '🔴 the reverse row was not restored — the name still resolves to nothing');
    assert.strictEqual(report.restored, 1, 'the report counts the restore');
    assert.strictEqual(report.deleted, 0, 'and deletes nothing: the only name involved is the one being landed');
    ok('a rollback across a deletion RESURRECTS the id in both planes, preserves created_at, and keeps the retirement in its history');
  }

  // ── 8. A RESTORED NAME IS NEVER ALSO DELETED ───────────────────────────────────────────────
  {
    /* The swap rule, on the rollback path. X comes back to Margherita while a residue orphan holding
       that same name is retired — so the name is released AND landed by one plan. If the writer took
       the release at face value, whether the key row survives would depend on which loop runs last. */
    const db = memFirestore();
    const P2 = `restaurants/${RID}/identity/dish`;
    const ids = {
      X: { legacy_key: 'Margherita', status: STATUS_RETIRED, created_at: 't0', kind: 'dish' },
      ORPHAN: { legacy_key: 'Margherita', status: STATUS_LIVE, created_at: 't0', kind: 'dish' },
    };
    for (const [k, v] of Object.entries(ids)) db._docs.set(`${P2}/ids/${k}`, { ...v });
    db._docs.set(`${P2}/keys/${encodeKey('Margherita')}`, { canonical_id: 'ORPHAN', kind: 'dish' });

    const idMap = new Map(Object.entries(ids));
    const keyMap = new Map([[encodeKey('Margherita'), { canonical_id: 'ORPHAN', kind: 'dish' }]]);
    const plan = reconcileOnRollback({ targetStamps: { Margherita: 'X' }, activeStamps: {}, ids: idMap, keys: keyMap });
    assert.deepStrictEqual(plan.retires.map((r) => r.id), ['ORPHAN'], 'premise — the residue orphan is retired, releasing the name');
    assert.deepStrictEqual(plan.deletions, [], 'premise — and the reconciliation already knows not to delete a name it re-lands');

    /* 🔴 THE VERDICT IS THE RECONCILIATION'S OWN, exactly as the production rollback path now passes
       it. This cell used to assemble `plan:` and `verified:` by hand here, mirroring a call site that
       was itself fabricating a verdict — so the cell reproduced the defect's shape instead of catching
       it. Driving `plan.verdict` means the cell exercises what catalog-publish.js actually does. */
    await db.runTransaction(async (tx) => applyIdentityPlan(tx, {
      db, rid: RID, kind: 'dish', now: 't1', existing: idMap, verified: plan.verdict,
    }));

    const key = db._docs.get(`${P2}/keys/${encodeKey('Margherita')}`);
    assert.ok(key, '🔴 the restored name has NO reverse row — it was deleted by the retirement that released it, and the restore that landed it lost the race');
    assert.strictEqual(key.canonical_id, 'X', '🔴 the reverse row names the RETIRED orphan rather than the restored id');
    assert.strictEqual(db._docs.get(`${P2}/ids/ORPHAN`).status, STATUS_RETIRED, 'and the orphan really is retired, not merely unlinked');
    ok('a name released by a retirement and landed by a restore in ONE plan is written, not deleted — the outcome does not depend on loop order');
  }

  // ── 🔴 THE BINDING: A VERDICT AUTHORISES ONLY THE PLAN IT CARRIES ──────────────────────────
  {
    /* THE DEFECT CODEX FOUND, AS A CELL. The writer took `plan` and `verified` as SEPARATE arguments and
       checked only the verdict's shape, so a GENUINELY VERIFIED plan's verdict authorised writing a
       DIFFERENT, unverified plan. Codex's reproduction: an empty plan's real verdict, passed beside a
       retirement nobody judged, and the writer created the retired row.
       It is now inexpressible — the plan is READ FROM the verdict. This cell keeps it that way by
       passing BOTH: a real verdict for an EMPTY plan, and a stray `plan` naming a retirement. If anyone
       reintroduces a `plan` parameter, or lets a passed plan take precedence, this goes red. */
    const db = memFirestore();
    db._docs.set(`${P}/ids/OTHER`, { legacy_key: 'Other', status: STATUS_LIVE, created_at: 't0', kind: 'dish' });
    const idMap = new Map([['OTHER', { legacy_key: 'Other', status: STATUS_LIVE, created_at: 't0', kind: 'dish' }]]);
    const keyMap = new Map([[encodeKey('Other'), { canonical_id: 'OTHER', kind: 'dish' }]]);

    const emptyPlan = { moves: [], mints: [], retires: [] };
    const realVerdict = verifyPlan(emptyPlan, { ids: idMap, keys: keyMap, complete: true });
    assert.strictEqual(realVerdict.ok, true, 'premise — the EMPTY plan is genuinely verified, not forged');
    assert.deepStrictEqual(realVerdict.plan, emptyPlan, 'premise — and the verdict carries the plan it judged');

    await db.runTransaction(async (tx) => applyIdentityPlan(tx, {
      db, rid: RID, kind: 'dish', now: 't1', existing: idMap, verified: realVerdict,
      plan: { moves: [], mints: [], retires: [{ id: 'OTHER', name: 'Other' }] },   // ← unjudged, must be ignored
    }));
    assert.strictEqual(db._docs.get(`${P}/ids/OTHER`).status, STATUS_LIVE,
      '🔴 AN UNVERIFIED RETIREMENT RODE IN ON A VERIFIED EMPTY PLAN\'S VERDICT. The verdict authorises only the plan it carries; a separate plan argument must have no effect at all.');
    assert.ok(!db._docs.get(`${P}/ids/OTHER`).retired_at, 'and no retirement stamp was written either');
    ok('a permitting verdict authorises ONLY the plan it carries — a plan passed alongside it is ignored, so a verified verdict cannot launder an unjudged operation');
  }

  // ── A VERDICT WITH NO PLAN IS REFUSED, which is what the old hand-assembled literal was ────
  {
    /* The production rollback path used to pass `{ ok: true, lands: [], releases: [], deletions }` —
       permitting, correctly shaped, and carrying NO plan. That exact object must now be refused, or the
       fix would be a convention rather than a guard. */
    const db = memFirestore();
    const legacyLiteral = { ok: true, lands: [], releases: [], deletions: [] };
    let threw = null;
    try {
      await db.runTransaction(async (tx) => applyIdentityPlan(tx, {
        db, rid: RID, kind: 'dish', existing: new Map(), verified: legacyLiteral,
      }));
    } catch (e) { threw = (e && e.message) || String(e); }
    assert.ok(threw && /identity_writer_verdict_not_issued/.test(threw),
      `🔴 THE OLD ROLLBACK LITERAL WAS ACCEPTED. This is the exact object catalog-publish.js used to build by hand, and it must be refused by PROVENANCE — a correctly-shaped object is not a verification: ${threw}`);
    /* 🔴 AND ADDING A PLAN MUST NOT HELP, which is how the first fix was defeated: the refusal then in
       place only caught this literal because it had no `plan`, so supplying one reopened the door and
       wrote a retired row. A shape check can always be satisfied by supplying the next field. */
    let withPlan = null;
    try {
      await db.runTransaction(async (tx) => applyIdentityPlan(tx, {
        db, rid: RID, kind: 'dish', existing: new Map(),
        verified: { ok: true, lands: [], releases: [], deletions: [], judged: ['moves', 'mints', 'retires'],
          plan: { moves: [], mints: [], retires: [{ id: 'FORGED', name: 'Any' }] } },
      }));
    } catch (e) { withPlan = (e && e.message) || String(e); }
    assert.ok(withPlan && /identity_writer_verdict_not_issued/.test(withPlan),
      `🔴 a hand-built verdict CARRYING A PLAN was accepted — shape was mistaken for provenance again: ${withPlan}`);
    assert.strictEqual(db._docs.get(`${P}/ids/FORGED`), undefined, '🔴 and it wrote the forged retirement');
    threw = withPlan;
    /* 🔴 `identity_writer_verdict_carries_no_plan` IS NOW UNREACHABLE FROM OUTSIDE, and the premise is
       written down rather than the guard quietly kept: `issueVerdict` SNAPSHOTS the plan and always
       produces moves/mints/retires arrays, so no issued verdict can lack one — and an unissued verdict
       is refused earlier by provenance. The guard stays as defence-in-depth against a FUTURE third
       issuer that builds a verdict differently; it is not dead code, it is unreachable-by-construction
       today, which is a different claim and the one worth recording. */

    /* …and every partial shape is refused too, by provenance rather than by inspecting the plan. */
    for (const bad of [{}, { moves: [] }, { moves: [], mints: [] }, { moves: 'x', mints: [], retires: [] }]) {
      let t2 = null;
      try {
        await db.runTransaction(async (tx) => applyIdentityPlan(tx, {
          db, rid: RID, kind: 'dish', existing: new Map(), verified: { ok: true, lands: [], releases: [], deletions: [], plan: bad },
        }));
      } catch (e) { t2 = (e && e.message) || String(e); }
      assert.ok(t2 && /identity_writer_verdict_not_issued/.test(t2),
        `🔴 the writer accepted a hand-built verdict whose plan is ${JSON.stringify(bad)}: ${t2}`);
    }
    ok('the old hand-assembled literal is refused by PROVENANCE, with or without a plan attached — shape is not verification, and supplying the next field does not help');
  }

  // ── 11. 🔴 MUTATING THE PLAN AFTER IT WAS JUDGED CHANGES NOTHING ────────────────────────────
  {
    /* THE SECOND HOLE, REPRODUCED AND THEN CLOSED. Binding the writer to `verified.plan` was not enough
       while the verdict carried the CALLER'S OBJECT: verify an empty plan, get a genuine permitting
       verdict, then push a mint onto the plan and hand the same verdict over — the mint was written. A
       reference is not a snapshot. The verdict now carries a frozen copy taken at issue. */
    const db = memFirestore();
    const plan = { moves: [], mints: [], retires: [] };
    const verified = verifyPlan(plan, { ids: new Map(), keys: new Map(), complete: true });
    assert.strictEqual(verified.ok, true, 'premise — the EMPTY plan is genuinely verified');

    plan.mints.push({ id: 'SNEAK', name: 'Later' });          // ← AFTER the verdict was issued
    plan.retires.push({ id: 'SNEAK2', name: 'Later2' });
    let report = null;
    await db.runTransaction(async (tx) => {
      report = applyIdentityPlan(tx, { db, rid: RID, kind: 'dish', now: 't1', existing: new Map(), verified });
    });
    assert.strictEqual(report.writes, 0,
      `🔴 A PLAN MUTATED AFTER VERIFICATION WAS WRITTEN — ${report.writes} write(s). The verdict must describe what was judged, not what the caller made of the plan afterwards.`);
    assert.strictEqual(db._docs.get(`${P}/ids/SNEAK`), undefined, '🔴 the post-hoc mint landed');
    assert.strictEqual(db._docs.get(`${P}/ids/SNEAK2`), undefined, '🔴 the post-hoc retirement landed');

    /* AND THE CARRIED PLAN IS ACTUALLY FROZEN, not merely copied — a copy whose arrays can be pushed to
       is the same hole one level in. */
    assert.ok(Object.isFrozen(verified.plan) && Object.isFrozen(verified.plan.mints) && Object.isFrozen(verified.plan.retires),
      '🔴 the verdict\'s plan or its arrays are not frozen');
    assert.throws(() => verified.plan.mints.push({ id: 'X', name: 'Y' }), /object is not extensible|read only|frozen/i,
      '🔴 the carried plan\'s arrays can still be pushed to');
    ok('a plan mutated after its verdict was issued writes nothing, and the verdict\'s own copy is frozen against being pushed to');
  }

  // ── 12. 🔴 A VERDICT MAY ONLY AUTHORISE THE KINDS IT JUDGED ─────────────────────────────────
  {
    /* THE THIRD HOLE, AND IT NEEDED NO FORGERY AT ALL. verifyPlan does not model `restores`; a
       restores-only plan came back from the REAL verifier with ok:true and empty lands/releases — a
       truthful answer about the operations it can see — and this writer executed the restore. The
       verifier's SILENCE about an operation was being read as permission for it.
       `judged` makes that limitation a refusal instead of a comment. */
    const db = memFirestore();
    const restoresOnly = { moves: [], mints: [], retires: [], restores: [{ id: 'RES', name: 'Ghost' }] };
    const real = verifyPlan(restoresOnly, { ids: new Map(), keys: new Map(), complete: true });
    assert.strictEqual(real.ok, true,
      'premise — the REAL verifier still permits this, because it cannot see restores at all; that is the honest answer and the reason the writer must not treat it as authorisation');

    let threw = null;
    try {
      await db.runTransaction(async (tx) => applyIdentityPlan(tx, {
        db, rid: RID, kind: 'dish', now: 't1', existing: new Map(), verified: real,
      }));
    } catch (e) { threw = (e && e.message) || String(e); }
    assert.ok(threw && /identity_writer_kind_unjudged/.test(threw),
      `🔴 A RESTORE WAS EXECUTED UNDER A VERDICT THAT NEVER LOOKED AT RESTORES: ${threw}`);
    assert.strictEqual(db._docs.get(`${P}/ids/RES`), undefined, '🔴 and the restore wrote both rows');

    /* 🔴 THE PERMITTING CONTROL, because a writer that refused every restore would satisfy the above and
       break the rollback path. reconcileOnRollback DOES judge restores, and its verdict must work. */
    const db2 = memFirestore();
    const P2 = `restaurants/${RID}/identity/dish`;
    db2._docs.set(`${P2}/ids/X`, { legacy_key: 'Margherita', status: STATUS_RETIRED, created_at: 't0', kind: 'dish', retired_at: 't0' });
    const idMap = new Map([['X', { legacy_key: 'Margherita', status: STATUS_RETIRED, created_at: 't0', kind: 'dish', retired_at: 't0' }]]);
    const rec = reconcileOnRollback({ targetStamps: { Margherita: 'X' }, activeStamps: {}, ids: idMap, keys: new Map() });
    assert.deepStrictEqual(rec.refusals, [], 'premise — the reconciliation permits');
    assert.ok(rec.verdict.judged.includes('restores'), 'premise — and its verdict CLAIMS restores');
    await db2.runTransaction(async (tx) => applyIdentityPlan(tx, {
      db: db2, rid: RID, kind: 'dish', now: 't1', existing: idMap, verified: rec.verdict,
    }));
    assert.strictEqual(db2._docs.get(`${P2}/ids/X`).status, STATUS_LIVE,
      '🔴 the kind check refuses restores even under the verdict that judges them — the rollback path is broken');
    ok('a restore under verifyPlan\'s verdict is refused by name because that verifier never judged restores, while the same restore under the reconciliation\'s verdict is written');
  }

  // ── 13. 🔴 THE VERDICT'S EXECUTABLE SURFACE, ENUMERATED FROM THE WRITER ITSELF ───────────────
  {
    /* THE FOURTH HOLE AND WHY THIS CELL IS SHAPED LIKE THIS. `issueVerdict` snapshotted `plan` and froze
       the issued object SHALLOWLY, so `verdict.deletions` came through the spread BY REFERENCE. A caller
       took a genuine verdict for an EMPTY plan, pushed one entry onto `deletions`, and the writer DELETED
       AN UNRELATED KEY ROW — the operation with no cheap recovery, authorised by nothing.
       Both of us missed it the same way: the fix said "freeze the plan", so the checking looked at
       `plan`. A surface verified from the FIX'S DESCRIPTION is not verified. So this cell does not check
       a list of names — it PARSES THE WRITER and derives every field of the verdict the writer actually
       consumes, which is why a fifth executable field fails here until it is snapshotted. Same reason
       the CLI refusal census is derived rather than typed: a hand-kept list sat at 8 while 10 tools
       connected. Structure, not text: acorn, not a regex. */
    const acorn = require('acorn');
    const src = readFileSync(join(__dirname, 'identity-writer.js'), 'utf8');
    const ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script' });

    /* Every `verified.X`, and every `plan.Y` — `plan` is the local alias the writer assigns from
       `verified.plan`, so its members are part of the same surface. */
    const onVerified = new Set();
    const onPlan = new Set();
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      /* 🔴 `computed === false` MATTERS, and leaving it out gave me a phantom field. `plan[kind]` is a
         computed MemberExpression whose property is ALSO an Identifier, so without this check the loop
         VARIABLE's name was recorded as if it were a field — the set came back containing `plan.kind`,
         which does not exist. Harmless there because the value is undefined and skipped, but an
         enumeration that invents members is one that can also miss them, and this cell's whole purpose
         is that the list is not guesswork. The dynamic `plan[kind]` access is covered because the write
         loops read plan.moves/mints/retires/restores literally as well. */
      if (node.type === 'MemberExpression' && node.computed === false && node.object && node.object.type === 'Identifier'
          && node.property && node.property.type === 'Identifier') {
        if (node.object.name === 'verified') onVerified.add(node.property.name);
        if (node.object.name === 'plan') onPlan.add(node.property.name);
      }
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object' && v.type) walk(v);
      }
    }(ast));

    /* 🔴 NON-VACUITY FIRST. A parse that found nothing would make every assertion below pass while
       measuring nothing — the exact shape this programme keeps catching. */
    assert.ok(onVerified.size >= 3, `🔴 the parse found only ${onVerified.size} field(s) on \`verified\` — it is not reading the writer`);
    assert.ok(onVerified.has('deletions'), '🔴 the parse missed `verified.deletions`, which is the field the fourth hole was in');
    assert.ok(onPlan.size >= 3, `🔴 the parse found only ${onPlan.size} field(s) on \`plan\``);
    for (const kind of ['moves', 'mints', 'retires', 'restores']) {
      assert.ok(onPlan.has(kind), `🔴 the parse missed \`plan.${kind}\` — the writer executes it, so the surface is under-enumerated`);
    }

    /* A genuine verdict whose every array is NON-EMPTY, so freezing is tested on populated arrays —
       `Object.isFrozen([])` is true of an empty literal for reasons that prove nothing. */
    const source = {
      ok: true, code: 'plan_verified', detail: '',
      lands: [{ id: 'A', name: 'N', via: 'mint' }], releases: [{ id: 'B', name: 'M' }],
      deletions: [{ name: 'M', encoded: encodeKey('M'), id: 'B' }],
    };
    const srcPlan = { moves: [{ id: 'A', from: 'N0', to: 'N' }], mints: [{ id: 'C', name: 'P' }],
      retires: [{ id: 'D', name: 'Q' }], restores: [{ id: 'E', name: 'R' }] };
    const v = issueVerdict(source, { plan: srcPlan, judged: ['moves', 'mints', 'retires', 'restores'] });

    for (const field of onVerified) {
      const val = v[field];
      if (val === null || typeof val !== 'object') continue;         // ok / code are primitives
      assert.ok(Object.isFrozen(val),
        `🔴 \`verified.${field}\` IS NOT FROZEN — the writer consumes it, so a caller can still change what gets executed after the verdict was issued`);
      if (Array.isArray(val)) {
        assert.throws(() => val.push({}), /not extensible|read only|frozen/i,
          `🔴 \`verified.${field}\` can still be PUSHED TO — this is exactly how an unjudged key deletion reached the writer`);
      }
    }
    for (const field of onPlan) {
      const val = v.plan[field];
      if (val === null || typeof val !== 'object') continue;
      assert.ok(Object.isFrozen(val), `🔴 \`verified.plan.${field}\` is not frozen`);
      if (Array.isArray(val)) assert.throws(() => val.push({}), /not extensible|read only|frozen/i, `🔴 \`verified.plan.${field}\` can still be pushed to`);
    }

    /* 🔴 AND DETACHED, NOT MERELY FROZEN. A frozen view of the caller's array would still change under
       them; the issued verdict must be immune to anything done to what it was built from. */
    source.deletions.push({ name: 'Z', encoded: encodeKey('Z'), id: 'ZZ' });
    srcPlan.mints.push({ id: 'ZZZ', name: 'Later' });
    assert.strictEqual(v.deletions.length, 1, '🔴 pushing onto the SOURCE deletions changed the issued verdict — it holds the caller\'s array, not a copy');
    assert.strictEqual(v.plan.mints.length, 1, '🔴 pushing onto the SOURCE plan changed the issued verdict');
    source.deletions.pop(); srcPlan.mints.pop();

    /* 🔴 AND AN UNSNAPSHOTTABLE TYPE REFUSES rather than being shared by reference — a Map or a class
       instance on a verdict would reintroduce the hole wearing a type nobody enumerated. */
    assert.throws(() => issueVerdict({ ok: true, deletions: [], weird: new Map() }, { plan: srcPlan, judged: ['mints'] }),
      /identity_verdict_unsnapshottable/, '🔴 a non-plain value was accepted onto a verdict and would be shared with the caller');

    ok(`every field of the verdict the writer consumes (${[...onVerified].sort().join(', ')} · plan.{${[...onPlan].sort().join(', ')}}) is frozen and detached — derived from the writer's own source, so a new executable field fails here until it is snapshotted`);
  }

  FINISHED = true;
  console.log(`identity-writer: OK (${n})`);
})().catch((e) => { console.error('identity-writer FAILED:', (e && e.message) || e); process.exit(1); });
