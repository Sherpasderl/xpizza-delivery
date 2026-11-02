'use strict';
// Offline tests for tools/identity-usable-check.js — no network, no emulator. Each failure message starts with its cell label.
//   IUC-ROWS: usable / unusable / failing restaurants → the right booleans and counts; NO label, key or id printed; errors counted.
//   IUC-REAL-BUILDER: the REAL manifest builder over a fake Firestore behind the read-only facade — its readOnly transactions
//     pass (an empty catalog reads as no_active_version, never error); a non-readOnly transaction / batch is refused.
//   IUC-WRITE-REFUSED: after denyAllWrites, the write paths of Firestore, RTDB, Storage and Auth throw — through BOTH the
//     namespaced (admin.x()) and modular (getX()) accessors, on a never-connected app.
//   IUC-EGRESS: only Google API / Firebase hosts may be connected to.
//   IUC-CLI-REFUSED: a wrong project, an env-only project and an emulator configuration are refused before any client.
const assert = require('assert');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');
const T = require('./identity-usable-check');
const { makeDb } = require('../catalog/firestore-fake');

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
    const r = await T.checkIdentityUsable({ db: {}, verifier: {}, build: fake, listIds: async () => ['tb_usable', 'tb_unconfirmed', 'tb_broken', 'tb_weird', 'tb_throws', 'Bad Id!', SECRET[2]] });
    const by = Object.fromEntries(r.rows.map((x) => [x.rid, x]));
    assert.deepStrictEqual(by.tb_usable, { rid: 'tb_usable', ok: true, eligible: true, dish_rows: 2, extra_rows: 1, rows_with_cid: 3 }, 'IUC-ROWS: an eligible catalog → true + counts');
    assert.strictEqual(by.tb_unconfirmed.eligible, false, 'IUC-ROWS: a built but unconfirmed catalog → not eligible');
    assert.strictEqual(by.tb_broken.reason, 'content_integrity', 'IUC-ROWS: a known failure reason is printed');
    assert.strictEqual(by.tb_weird.reason, 'other', 'IUC-ROWS: an unknown reason prints as other');
    assert.strictEqual(by.tb_throws.reason, 'error', 'IUC-ROWS: a throwing build → error, never its message');
    assert.strictEqual(r.errored, 1, 'IUC-ROWS: errors are counted (the CLI exits 1 on any)');
    assert.strictEqual(r.skipped_ids, 2, 'IUC-ROWS: invalid registry ids are skipped (counted, never printed)');
    const out = T.render(r);
    const leaks = SECRET.filter((s) => out.includes(s)).concat(out.includes('Bad Id!') ? ['Bad Id!'] : []);
    assert.deepStrictEqual(leaks, [], `IUC-ROWS: the output carries no label / key / id (leaked ${leaks})`);
    assert.ok(/identity_eligible/.test(out) && /prices to match/.test(out) && !/dish_id resolves/.test(out), 'IUC-ROWS: the output states ELIGIBILITY and the request-side extra conditions, not a resolution guarantee');
    ok('rows: eligible / unconfirmed / broken / unknown reason / throwing → booleans + counts; errors counted; eligibility wording');
  }
  {
    const db = T.readOnlyFirestore(makeDb());
    const r = await T.checkIdentityUsable({ db, verifier: null, listIds: async () => ['tb_rest'] });   // the REAL buildIdentityManifest
    assert.strictEqual(r.rows[0].reason, 'no_active_version', `IUC-REAL-BUILDER: the real read path (readOnly transactions) runs behind the facade — an empty catalog is no_active_version, not ${r.rows[0].reason}`);
    assert.strictEqual(r.errored, 0, 'IUC-REAL-BUILDER: no error');
    assert.throws(() => db.runTransaction(async () => {}), /read-only/, 'IUC-REAL-BUILDER: a transaction WITHOUT readOnly is refused at the facade');
    assert.throws(() => db.batch(), /read-only/, 'IUC-REAL-BUILDER: a batch is refused at the facade');
    ok('real builder behind the read-only facade: readOnly transactions pass; a mutating transaction / batch is refused');
  }
  {
    const patched = T.denyAllWrites();
    assert.ok(patched.length >= 40, `IUC-WRITE-REFUSED: premise — write methods patched across services (${patched.length})`);
    const admin = require('firebase-admin');
    const { getFirestore } = require('firebase-admin/firestore');
    const { getDatabase } = require('firebase-admin/database');
    const { getStorage } = require('firebase-admin/storage');
    const { getAuth } = require('firebase-admin/auth');
    const app = admin.initializeApp({ projectId: 'tb-offline-never-connected', databaseURL: 'https://tb-offline-never-connected-default-rtdb.firebaseio.com', storageBucket: 'tb-offline.appspot.com' }, 'iuc-test');
    const fsN = app.firestore(), fsM = getFirestore(app), dbN = app.database(), dbM = getDatabase(app);
    const attempts = {
      'firestore(ns) doc.set': () => fsN.collection('tb').doc('x').set({ a: 1 }), 'firestore(mod) doc.update': () => fsM.doc('tb/x').update({ a: 1 }),
      'firestore doc.delete': () => fsM.doc('tb/x').delete(), 'firestore col.add': () => fsM.collection('tb').add({}),
      'firestore batch': () => fsN.batch(), 'firestore bulkWriter': () => fsM.bulkWriter(), 'firestore recursiveDelete': () => fsM.recursiveDelete(fsM.doc('tb/x')),
      'firestore runTransaction (no readOnly)': () => fsM.runTransaction(async () => {}),
      'rtdb(ns) set': () => dbN.ref('tb').set(1), 'rtdb(mod) update': () => dbM.ref('tb').update({ a: 1 }), 'rtdb remove': () => dbM.ref('tb').remove(),
      'rtdb push': () => dbM.ref('tb').push({ a: 1 }), 'rtdb transaction': () => dbM.ref('tb').transaction(() => 1), 'rtdb onDisconnect.set': () => dbM.ref('tb').onDisconnect().set(1),
      'storage(mod) file.save': () => getStorage(app).bucket().file('tb').save('x'), 'storage file.delete': () => getStorage(app).bucket().file('tb').delete(),
      'storage bucket.upload': () => getStorage(app).bucket().upload('/dev/null'),
      'auth(ns) createUser': () => app.auth().createUser({}), 'auth(mod) setCustomUserClaims': () => getAuth(app).setCustomUserClaims('u', {}), 'auth deleteUser': () => getAuth(app).deleteUser('u'),
    };
    for (const [k, fn] of Object.entries(attempts)) assert.throws(fn, /read-only/, `IUC-WRITE-REFUSED: ${k} must throw synchronously`);
    // the REAL SDK's readOnly transaction still runs under the class guards (the read path is not blocked)
    const ranRO = await fsM.runTransaction(async () => 'ran', { readOnly: true });
    assert.strictEqual(ranRO, 'ran', 'IUC-WRITE-REFUSED: a REAL readOnly transaction runs through the guarded SDK');
    await app.delete().catch(() => {});
    ok(`write refusal: ${Object.keys(attempts).length} write paths across Firestore / RTDB / Storage / Auth throw (namespaced + modular), before any network`);
  }
  {
    for (const h of ['firestore.googleapis.com', 'oauth2.googleapis.com', 'xpizza-delivery-default-rtdb.firebaseio.com', 's-usc1a-nss-2001.firebaseio.com', 'x.firebasedatabase.app'])
      assert.ok(T.googleHost(h), `IUC-EGRESS: ${h} is a Google host`);
    for (const h of ['example.com', 'googleapis.com.evil.example', '127.0.0.1', 'localhost', '', null])
      assert.ok(!T.googleHost(h), `IUC-EGRESS: ${h} is NOT allowed`);
    T.restrictEgress();
    assert.throws(() => net.connect({ host: 'example.com', port: 443 }), /egress refused/, 'IUC-EGRESS: a non-Google connect throws');
    assert.throws(() => net.connect(9, '127.0.0.1'), /egress refused/, 'IUC-EGRESS: a local / IP-literal connect throws');
    assert.throws(() => require('tls').connect({ host: 'example.com', port: 443 }), /egress refused/, 'IUC-EGRESS: a non-Google TLS connect throws');
    ok('egress: Google API / Firebase hosts only; others (incl. local and IP literals) refused');
  }
  {
    const cli = path.join(__dirname, 'identity-usable-check.js');
    const env = { ...process.env }; delete env.GOOGLE_CLOUD_PROJECT; delete env.GCLOUD_PROJECT;
    for (const k of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB']) delete env[k];
    const wrong = spawnSync(process.execPath, [cli, '--project', 'some-other-project'], { env, encoding: 'utf8' });
    assert.strictEqual(wrong.status, 2, `IUC-CLI-REFUSED: a wrong project exits 2 (got ${wrong.status})`);
    const none = spawnSync(process.execPath, [cli], { env: { ...env, GOOGLE_CLOUD_PROJECT: 'xpizza-delivery' }, encoding: 'utf8' });
    assert.strictEqual(none.status, 2, `IUC-CLI-REFUSED: an env-only project (no --project flag) exits 2 (got ${none.status})`);
    const emu = spawnSync(process.execPath, [cli, '--project', 'xpizza-delivery'], { env: { ...env, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, encoding: 'utf8' });
    assert.strictEqual(emu.status, 2, `IUC-CLI-REFUSED: an emulator configuration exits 2 (got ${emu.status})`);
    assert.ok(/emulator configuration/.test(emu.stderr), 'IUC-CLI-REFUSED: names the emulator refusal');
    ok('cli: wrong project, env-only project and emulator configuration are refused before any client');
  }
  console.log(`\nidentity-usable-check: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('TEST FAILED:', e && e.message); process.exit(1); });
