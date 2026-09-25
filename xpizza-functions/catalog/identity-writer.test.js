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
const { applyIdentityPlan } = require('./identity-writer');
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
    report = applyIdentityPlan(tx, { db, rid: RID, kind: 'dish', plan, verified, existing: idMap, now: 't1' });
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
        await db.runTransaction(async (tx) => applyIdentityPlan(tx, { db, rid: RID, kind: 'dish', plan, verified: bad, existing: new Map() }));
      } catch (e) { threw = (e && e.message) || String(e); }
      assert.ok(threw && /identity_writer_unverified/.test(threw),
        `🔴 the writer ran on verdict ${JSON.stringify(bad)} — verification is bypassable: ${threw}`);
    }
    assert.strictEqual(db._docs.get(`${P}/ids/Z`), undefined, '🔴 a refused call wrote anyway');

    let noTx = null;
    try { applyIdentityPlan({}, { db, rid: RID, kind: 'dish', plan, verified: { ok: true, deletions: [], lands: [] } }); }
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
    const forged = { ok: true, lands: [{ id: 'Z', name: 'N', via: 'mint' }], releases: [],
      deletions: [{ name: 'N', encoded: encodeKey('N'), id: 'Z' }] };
    let threw = null;
    try {
      await db.runTransaction(async (tx) => applyIdentityPlan(tx, { db, rid: RID, kind: 'dish', plan, verified: forged, existing: new Map() }));
    } catch (e) { threw = (e && e.message) || String(e); }
    assert.ok(threw && /identity_writer_delete_lands/.test(threw),
      `🔴 a name both landed and deleted by one plan was written; the result depends on write order: ${threw}`);

    /* 🔴 AND THE SAME FOR A RESTORE, WHICH THE SWEEP SHOWED WAS UNCOVERED. reconcileOnRollback already
       excludes a re-landed name from its deletions, so a reconciliation-driven plan never exercises
       the writer's own check — a mutant removing `restores` from the landed set SURVIVED cell 8. The
       writer must not depend on its callers being careful: this forges the verdict the careful caller
       would never produce, which is the only way to reach the branch. */
    const restorePlan = { moves: [], mints: [], retires: [], restores: [{ id: 'R', name: 'N' }] };
    const forgedRestore = { ok: true, lands: [], releases: [],
      deletions: [{ name: 'N', encoded: encodeKey('N'), id: 'R' }] };
    let threwRestore = null;
    try {
      await db.runTransaction(async (tx) => applyIdentityPlan(tx, { db, rid: RID, kind: 'dish', plan: restorePlan, verified: forgedRestore, existing: new Map() }));
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
      report = applyIdentityPlan(tx, {
        db, rid: RID, kind: 'dish', now: 't1', existing: idMap,
        plan: { moves: [], mints: [], retires: plan.retires, restores: plan.restores },
        verified: { ok: true, lands: [], releases: [], deletions: plan.deletions },
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

    await db.runTransaction(async (tx) => applyIdentityPlan(tx, {
      db, rid: RID, kind: 'dish', now: 't1', existing: idMap,
      plan: { moves: [], mints: [], retires: plan.retires, restores: plan.restores },
      verified: { ok: true, lands: [], releases: [], deletions: plan.deletions },
    }));

    const key = db._docs.get(`${P2}/keys/${encodeKey('Margherita')}`);
    assert.ok(key, '🔴 the restored name has NO reverse row — it was deleted by the retirement that released it, and the restore that landed it lost the race');
    assert.strictEqual(key.canonical_id, 'X', '🔴 the reverse row names the RETIRED orphan rather than the restored id');
    assert.strictEqual(db._docs.get(`${P2}/ids/ORPHAN`).status, STATUS_RETIRED, 'and the orphan really is retired, not merely unlinked');
    ok('a name released by a retirement and landed by a restore in ONE plan is written, not deleted — the outcome does not depend on loop order');
  }

  FINISHED = true;
  console.log(`identity-writer: OK (${n})`);
})().catch((e) => { console.error('identity-writer FAILED:', (e && e.message) || e); process.exit(1); });
