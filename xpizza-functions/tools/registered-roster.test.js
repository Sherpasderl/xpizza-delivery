'use strict';
// PLAN-brand-agnostic-convergence §3-E / Codex ba-r3 #11: the identity cert tools (backfill-identities, bootstrap-identity) and
// the pointer recovery tool (rollback-version) take their roster from the REGISTERED restaurants — every document id of the
// `restaurants` collection, active or dark (La Musa starts dark) — through the platform's one registry reader, never a list in
// code. Fail closed: an unreadable registry, an absent rid or an unregistered rid refuses.
// Each failure message starts with its cell label. Run: node tools/registered-roster.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { registeredRestaurants, checkRegistered } = require('./registered-roster');

let pass = 0; const fails = [];
async function cell(name, fn) { try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { fails.push(name); console.error(`  ✗ ${String((e && e.message) || e).split('\n')[0]}`); } }
// the production reader is `db.collection('restaurants').listDocuments()` (catalog/restaurant-registry.js); this fake answers
// it as Firestore does — references only, including a document that exists only through its subcollections
const fakeDb = (ids, { fail = false } = {}) => ({ collection(name) {
  assert.strictEqual(name, 'restaurants', 'the roster is the restaurants collection');
  return { async listDocuments() { if (fail) throw new Error('UNAVAILABLE'); return ids.map((id) => ({ id })); } };
} });

(async () => {
  await cell('RR-REGISTERED-ROSTER', async () => {
    const L = 'RR-REGISTERED-ROSTER';
    const ids = await registeredRestaurants(fakeDb(['tb_dark', 'tb_live', 'Bad Id', '']));
    assert.deepStrictEqual(ids, ['tb_dark', 'tb_live'], `${L}: every well-formed registered id, sorted, malformed ids dropped (got ${JSON.stringify(ids)})`);
  });
  await cell('RR-DARK-RESTAURANT-ACCEPTED', async () => {
    const L = 'RR-DARK-RESTAURANT-ACCEPTED';
    const r = await checkRegistered(fakeDb(['tb_dark', 'tb_live']), 'tb_dark');
    assert.strictEqual(r.ok, true, `${L}: a registered restaurant that is not active is on the roster (certification works before activation) — got ${JSON.stringify(r)}`);
  });
  await cell('RR-UNREGISTERED-REFUSED', async () => {
    const L = 'RR-UNREGISTERED-REFUSED';
    const r = await checkRegistered(fakeDb(['tb_live']), 'tb_ghost');
    assert.ok(r.ok === false && r.reason === 'not_registered', `${L}: an unregistered rid is refused (got ${JSON.stringify(r)})`);
  });
  await cell('RR-ABSENT-RID-REFUSED', async () => {
    const L = 'RR-ABSENT-RID-REFUSED';
    for (const rid of [null, undefined, '']) {
      const r = await checkRegistered(fakeDb(['tb_live']), rid);
      assert.ok(r.ok === false && r.reason === 'no_rid', `${L}: ${JSON.stringify(rid)} is refused before any read (got ${JSON.stringify(r)})`);
    }
  });
  await cell('RR-REGISTRY-UNREADABLE-REFUSED', async () => {
    const L = 'RR-REGISTRY-UNREADABLE-REFUSED';
    const r = await checkRegistered(fakeDb(['tb_live'], { fail: true }), 'tb_live');
    assert.ok(r.ok === false && r.reason === 'registry_unreadable', `${L}: an unreadable registry refuses — never a fallback list (got ${JSON.stringify(r)})`);
  });

  // The three tools: no roster literal; the registered check runs before the tool's first catalog read, and refuses with exit 1
  // (exit 2 is the project guard's alone in these tools).
  for (const [tool, firstRead] of [
    ['backfill-identities.js', 'await getActivePointer(db, RID)'],
    ['bootstrap-identity.js', 'await readActiveVersion(db, RID)'],
    ['rollback-version.js', 'col.get()'],
  ]) {
    await cell(`RR-TOOL-USES-ROSTER-${tool}`, async () => {
      const L = `RR-TOOL-USES-ROSTER-${tool}`;
      const src = fs.readFileSync(path.join(__dirname, tool), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.ok(!/\bKNOWN\b/.test(src) && !/'x_pizza'|'la_musa'/.test(src), `${L}: no roster literal left in the tool`);
      assert.match(src, /require\('\.\/registered-roster'\)/, `${L}: the tool uses the registered roster`);
      const at = src.indexOf('await checkRegistered(db, RID)');
      assert.ok(at > 0, `${L}: it checks the rid against the registered roster`);
      const refusal = src.slice(at, at + 400);
      assert.match(refusal, /process\.exit\(1\)/, `${L}: an unregistered rid exits 1`);
      assert.ok(src.indexOf(firstRead) > at, `${L}: the check comes before the first catalog read`);
    });
  }

  // Spawned for real with a credential that RESOLVES (a key generated here for a service account that never existed) and both
  // data hosts on a dead port: a rid reaches the roster check, the registry cannot be read, and the tool must refuse with exit 1
  // BEFORE its first catalog read. No --apply anywhere; nothing can reach a real project.
  {
    const os = require('os'); const { execFileSync } = require('child_process');
    const { generateKeyPairSync } = require('crypto');
    const { expectedProject } = require('./require-project');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const saPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-sa-')), 'sa.json');
    fs.writeFileSync(saPath, JSON.stringify({ type: 'service_account', project_id: expectedProject(), private_key_id: '0'.repeat(40), private_key: privateKey,
      client_email: `nobody@${expectedProject()}.iam.gserviceaccount.com`, client_id: '0'.repeat(21),
      auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token' }));
    const spawnTool = (tool, args) => {
      try {
        const out = execFileSync(process.execPath, [path.join(__dirname, tool), ...args], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: saPath, FIRESTORE_EMULATOR_HOST: '127.0.0.1:1', FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:1', GOOGLE_CLOUD_PROJECT: '', GCLOUD_PROJECT: '' } });
        return { code: 0, out };
      } catch (e) { return { code: e.status === undefined ? -1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` }; }
    };
    for (const tool of ['backfill-identities.js', 'bootstrap-identity.js', 'rollback-version.js']) {
      await cell(`RR-SPAWN-REGISTRY-UNREADABLE-${tool}`, async () => {
        const L = `RR-SPAWN-REGISTRY-UNREADABLE-${tool}`;
        const r = spawnTool(tool, ['--rid=tb_any', '--project', expectedProject()]);
        assert.ok(!/project_guard_refused/.test(r.out), `${L}: premise — past the project guard`);
        assert.strictEqual(r.code, 1, `${L}: exit 1 (got ${r.code}) — ${r.out.replace(/\s+/g, ' ').slice(0, 220)}`);
        assert.match(r.out, /REFUSED — registry_unreadable/, `${L}: refused on the unreadable registry`);
      });
    }
  }

  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nregistered-roster: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.message); process.exit(1); });
