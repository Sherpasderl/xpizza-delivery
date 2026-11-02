'use strict';
// Offline tests for tools/identity-usable-check.js — no network, no emulator. Each failure message starts with its cell label.
//   IUC-ROWS: usable / unusable / failing restaurants → the right booleans and counts, and NO label, key or id printed.
//   IUC-WRITE-REFUSED: after denyFirestoreWrites, every Firestore write path throws (a real Firestore client, never connected).
//   IUC-PROJECT-REFUSED: the CLI refuses a wrong project and a missing --project flag before touching any client.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkIdentityUsable, denyFirestoreWrites, render } = require('./identity-usable-check');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  {
    const SECRET = ['tb_SECRET_LABEL', 'tb_key_secret', 'c1:tb-secret-cid'];
    const fake = async ({ rid }) => {
      if (rid === 'tb_usable') return { ok: true, usableAsIdentity: true, node: { rows: [
        { kind: 'dish', key: SECRET[1], label: SECRET[0], cid: SECRET[2] }, { kind: 'dish', key: 'k2', label: 'L2', cid: 'c2' }, { kind: 'extra', key: 'e1', label: 'E1', cid: 'c3' }] } };
      if (rid === 'tb_unconfirmed') return { ok: true, usableAsIdentity: false, node: { rows: [{ kind: 'dish', key: 'k', label: SECRET[0], cid: null }] } };
      if (rid === 'tb_broken') return { ok: false, reason: 'content_integrity', detail: SECRET[0] };
      if (rid === 'tb_weird') return { ok: false, reason: SECRET[0] };
      throw new Error(SECRET[0]);
    };
    const r = await checkIdentityUsable({ db: {}, verifier: {}, build: fake, listIds: async () => ['tb_usable', 'tb_unconfirmed', 'tb_broken', 'tb_weird', 'tb_throws', 'Bad Id!', SECRET[2]] });
    const by = Object.fromEntries(r.rows.map((x) => [x.rid, x]));
    assert.deepStrictEqual(by.tb_usable, { rid: 'tb_usable', ok: true, usableAsIdentity: true, dish_rows: 2, extra_rows: 1, rows_with_cid: 3 }, 'IUC-ROWS: a usable catalog → true + counts');
    assert.strictEqual(by.tb_unconfirmed.usableAsIdentity, false, 'IUC-ROWS: a built but unconfirmed catalog → usableAsIdentity false');
    assert.strictEqual(by.tb_unconfirmed.rows_with_cid, 0, 'IUC-ROWS: no cid when not usable');
    assert.strictEqual(by.tb_broken.reason, 'content_integrity', 'IUC-ROWS: a known failure reason is printed');
    assert.strictEqual(by.tb_weird.reason, 'other', 'IUC-ROWS: an unknown reason prints as other');
    assert.strictEqual(by.tb_throws.reason, 'error', 'IUC-ROWS: a throwing build → error, never its message');
    assert.strictEqual(r.skipped_ids, 2, 'IUC-ROWS: invalid registry ids are skipped (counted, never printed)');
    const out = render(r);
    const leaks = SECRET.filter((s) => out.includes(s)).concat(out.includes('Bad Id!') ? ['Bad Id!'] : []);
    assert.deepStrictEqual(leaks, [], `IUC-ROWS: the output carries no label / key / id (leaked ${leaks})`);
    ok('rows: usable / unconfirmed / broken / unknown reason / throwing → booleans + counts; nothing else printed');
  }
  {
    const F = require('firebase-admin/firestore');
    const patched = denyFirestoreWrites(F);
    assert.ok(patched.length >= 20, `IUC-WRITE-REFUSED: premise — the write methods were patched (${patched.length})`);
    const db = new F.Firestore({ projectId: 'tb-offline-never-connected' });
    const doc = db.collection('tb').doc('x');
    const attempts = {
      'doc.set': () => doc.set({ a: 1 }), 'doc.update': () => doc.update({ a: 1 }), 'doc.delete': () => doc.delete(), 'doc.create': () => doc.create({ a: 1 }),
      'col.add': () => db.collection('tb').add({ a: 1 }), 'db.batch': () => db.batch(), 'db.runTransaction': () => db.runTransaction(async () => {}),
      'db.bulkWriter': () => db.bulkWriter(), 'db.recursiveDelete': () => db.recursiveDelete(doc),
    };
    for (const [k, fn] of Object.entries(attempts)) assert.throws(fn, /read-only/, `IUC-WRITE-REFUSED: ${k} must throw synchronously`);
    await db.terminate().catch(() => {});
    ok(`write refusal: ${Object.keys(attempts).length} Firestore write paths throw before any network`);
  }
  {
    const cli = path.join(__dirname, 'identity-usable-check.js');
    const env = { ...process.env }; delete env.GOOGLE_CLOUD_PROJECT; delete env.GCLOUD_PROJECT;
    const wrong = spawnSync(process.execPath, [cli, '--project', 'some-other-project'], { env, encoding: 'utf8' });
    assert.strictEqual(wrong.status, 2, `IUC-PROJECT-REFUSED: a wrong project exits 2 (got ${wrong.status})`);
    assert.ok(/REFUSED/.test(wrong.stderr), 'IUC-PROJECT-REFUSED: says REFUSED');
    const none = spawnSync(process.execPath, [cli], { env: { ...env, GOOGLE_CLOUD_PROJECT: 'xpizza-delivery' }, encoding: 'utf8' });
    assert.strictEqual(none.status, 2, `IUC-PROJECT-REFUSED: an env-only project (no --project flag) exits 2 (got ${none.status})`);
    ok('project guard: a wrong project and an env-only statement are both refused before any client');
  }
  console.log(`\nidentity-usable-check: OK (${n})`);
})().catch((e) => { console.error('TEST FAILED:', e && e.message); process.exit(1); });
