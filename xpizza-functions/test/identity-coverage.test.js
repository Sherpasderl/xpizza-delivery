'use strict';
// PLAN-brand-agnostic-convergence §3-E — certification is VERIFIED by coverage against the catalog CAPTURED before the one-way
// step, not by a fixed row count. identity-usable-check gains `--capture <file>` (before step 4: per restaurant the active
// version, seq and one sha256 per object — no catalog text on disk) and `--against <file>` (step 7: every captured object is
// present WITH a canonical id, nothing missing or added, the version unchanged, identity eligible). Counts only on screen.
// The builder is injected in the shape buildIdentityManifest returns (one cell runs the real builder over the Firestore fake);
// the certified path through the real writers is an emulator cell. Each failure message starts with its cell label.
// Run: node test/identity-coverage.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../tools/identity-usable-check');
const { makeDb } = require('../catalog/firestore-fake');

const rows = (spec, withCid) => spec.map(([kind, key]) => ({ kind, key, label: key, category: null, cid: withCid ? `cid-${kind}-${key}` : null }));
const CAT = [['dish', 'tb_pizza'], ['dish', 'tb_pasta'], ['extra', 'tb_queso']];
const built = (spec, { usable, versionId = 'v1', seq = 3 } = {}) => ({ ok: true, node: { versionId, seq, rows: rows(spec, usable) }, usableAsIdentity: usable });
const builder = (byRid) => async ({ rid }) => (typeof byRid[rid] === 'function' ? byRid[rid]() : byRid[rid]);

let pass = 0; const fails = [];
async function cell(name, fn) { try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { fails.push(name); console.error(`  ✗ ${name}: ${String((e && e.message) || e).split('\n')[0]}`); } }

(async () => {
  // before the cut-over: the dark restaurant is uncertified — the capture records it anyway (that is the point)
  const capture = await T.captureCatalog({ db: {}, verifier: {}, listIds: async () => ['tb_dark', 'Bad Id!'], build: builder({ tb_dark: built(CAT, { usable: false }) }), now: () => 0 });

  await cell('COV-CAPTURE-SHAPE', async () => {
    const L = 'COV-CAPTURE-SHAPE';
    const c = capture.restaurants.tb_dark;
    assert.ok(c && c.versionId === 'v1' && c.seq === 3, `${L}: version and seq recorded (got ${JSON.stringify(c)})`);
    assert.strictEqual(c.objects.length, 3, `${L}: one entry per catalog object`);
    assert.ok(c.objects.every((h) => /^[0-9a-f]{64}$/.test(h)), `${L}: each entry is a sha256`);
    assert.ok(!JSON.stringify(capture).includes('tb_pizza'), `${L}: no catalog text on disk`);
    assert.deepStrictEqual(Object.keys(capture.restaurants), ['tb_dark'], `${L}: registered, well-formed restaurants only`);
  });

  const against = (cur, cap = capture) => T.checkAgainstCapture({ db: {}, verifier: {}, capture: cap, build: builder(cur) });
  const row = (r) => r.rows[0];

  await cell('COV-PASS-AFTER-CERT', async () => {
    const L = 'COV-PASS-AFTER-CERT';
    const r = row(await against({ tb_dark: built(CAT, { usable: true }) }));
    assert.ok(r.pass === true && r.covered === 3 && r.total === 3 && r.missing === 0 && r.added === 0 && r.version_unchanged === true, `${L}: every captured object now has an id (got ${JSON.stringify(r)})`);
  });
  await cell('COV-FAIL-NOT-CERTIFIED', async () => {
    const L = 'COV-FAIL-NOT-CERTIFIED';
    const r = row(await against({ tb_dark: built(CAT, { usable: false }) }));
    assert.ok(r.pass === false && r.covered === 0 && r.eligible === false, `${L}: no ids → FAIL (got ${JSON.stringify(r)})`);
  });
  await cell('COV-FAIL-INELIGIBLE-EVEN-WITH-IDS', async () => {
    const L = 'COV-FAIL-INELIGIBLE-EVEN-WITH-IDS';
    const b = built(CAT, { usable: true }); b.usableAsIdentity = false;   // ids present but the judgement says not usable
    const r = row(await against({ tb_dark: b }));
    assert.ok(r.pass === false && r.eligible === false, `${L}: eligibility is required on its own, not inferred from the ids (got ${JSON.stringify(r)})`);
  });
  await cell('COV-FAIL-OBJECT-MISSING', async () => {
    const L = 'COV-FAIL-OBJECT-MISSING';
    const r = row(await against({ tb_dark: built(CAT.slice(0, 2), { usable: true }) }));
    assert.ok(r.pass === false && r.missing === 1 && r.covered === 2, `${L}: a captured object that vanished → FAIL (got ${JSON.stringify(r)})`);
  });
  await cell('COV-FAIL-OBJECT-ADDED', async () => {
    const L = 'COV-FAIL-OBJECT-ADDED';
    const r = row(await against({ tb_dark: built([...CAT, ['dish', 'tb_nuevo']], { usable: true }) }));
    assert.ok(r.pass === false && r.added === 1 && r.covered === 3, `${L}: an object not in the capture → FAIL (got ${JSON.stringify(r)})`);
  });
  await cell('COV-FAIL-VERSION-MOVED', async () => {
    const L = 'COV-FAIL-VERSION-MOVED';
    const r = row(await against({ tb_dark: built(CAT, { usable: true, versionId: 'v2' }) }));
    assert.ok(r.pass === false && r.version_unchanged === false, `${L}: the pointer moved underneath → FAIL (got ${JSON.stringify(r)})`);
  });
  await cell('COV-FAIL-BUILD-NOT-OK', async () => {
    const L = 'COV-FAIL-BUILD-NOT-OK';
    const r1 = row(await against({ tb_dark: { ok: false, reason: 'content_integrity' } }));
    const r2 = row(await against({ tb_dark: () => { throw new Error('boom'); } }));
    assert.ok(r1.pass === false && r1.reason === 'content_integrity', `${L}: a refused build → FAIL with its reason (got ${JSON.stringify(r1)})`);
    assert.ok(r2.pass === false && r2.reason === 'error', `${L}: a thrown build → FAIL 'error' (got ${JSON.stringify(r2)})`);
  });
  await cell('COV-CAPTURE-INVALID-REFUSED', async () => {
    const L = 'COV-CAPTURE-INVALID-REFUSED';
    for (const bad of [null, {}, { kind: 'identity-coverage-capture', v: 1, restaurants: { tb_dark: { versionId: 'v1', seq: 3, objects: ['nothex'] } } },
      { kind: 'identity-coverage-capture', v: 1, restaurants: {} },
      { kind: 'identity-coverage-capture', v: 1, restaurants: { tb_dark: { versionId: 'v1', seq: 3, objects: ['a'.repeat(64), 'a'.repeat(64)] } } }]) {
      await assert.rejects(against({ tb_dark: built(CAT, { usable: true }) }, bad), /capture_invalid/, `${L}: ${JSON.stringify(bad)} is refused`);
    }
  });
  await cell('COV-CAPTURE-REFUSES-A-FAILED-BUILD', async () => {
    const L = 'COV-CAPTURE-REFUSES-A-FAILED-BUILD';
    const c = await T.captureCatalog({ db: {}, verifier: {}, listIds: async () => ['tb_dark'], build: builder({ tb_dark: { ok: false, reason: 'no_active_version' } }), now: () => 0 });
    assert.ok(c.failed.length === 1 && !c.restaurants.tb_dark, `${L}: a restaurant whose catalog cannot be built is reported failed, never captured empty (got ${JSON.stringify(c)})`);
  });
  await cell('COV-REAL-BUILDER-NO-CATALOG', async () => {
    const L = 'COV-REAL-BUILDER-NO-CATALOG';
    const db = T.readOnlyFirestore(makeDb());
    const c = await T.captureCatalog({ db, verifier: null, listIds: async () => ['tb_rest'], now: () => 0 });   // the REAL buildIdentityManifest
    assert.deepStrictEqual(c.failed, [{ rid: 'tb_rest', reason: 'no_active_version' }], `${L}: the real builder's refusal reaches the capture (got ${JSON.stringify(c.failed)})`);
  });
  await cell('COV-RENDER-COUNTS-ONLY', async () => {
    const L = 'COV-RENDER-COUNTS-ONLY';
    const out = T.renderCoverage(await against({ tb_dark: built(CAT, { usable: true }) }));
    assert.match(out, /tb_dark\s+true\s+true\s+true\s+3\/3\s+0\s+0/, `${L}: one row: pass eligible version_unchanged covered/total missing added (got ${out})`);
    assert.ok(!/tb_pizza|cid-/.test(out), `${L}: no catalog text or ids printed`);
  });
  await cell('COV-CLI-ARGS', async () => {
    const L = 'COV-CLI-ARGS';
    assert.deepStrictEqual(T.parseCliArgs(['--project', 'p']), { mode: 'check' }, `${L}: no mode flag → the existing check`);
    assert.deepStrictEqual(T.parseCliArgs(['--project', 'p', '--capture', 'a.json']), { mode: 'capture', file: 'a.json' }, `${L}: --capture <file>`);
    assert.deepStrictEqual(T.parseCliArgs(['--project=p', '--against', 'a.json']), { mode: 'against', file: 'a.json' }, `${L}: --against <file>`);
    for (const bad of [['--capture=a.json'], ['--capture'], ['--capture', '--against'], ['--capture', 'a', '--against', 'b'], ['--rid', 'x'], ['--capture', 'a', '--capture', 'b']]) {
      assert.ok(T.parseCliArgs(['--project', 'p', ...bad]).refused, `${L}: ${JSON.stringify(bad)} is refused`);
    }
  });
  await cell('COV-CAPTURE-FILE-WRITE-ONCE', async () => {
    const L = 'COV-CAPTURE-FILE-WRITE-ONCE';
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cov-')), 'cap.json');
    T.writeCapture(f, capture);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), capture, `${L}: the capture round-trips`);
    assert.throws(() => T.writeCapture(f, capture), /EEXIST/, `${L}: an existing capture is never overwritten (it is the pre-cut-over evidence)`);
  });

  // The CLI settles its mode and file BEFORE any client. Spawned with --project but a NONEXISTENT credential and no emulator
  // variables (the tool refuses those): even a mis-wired run cannot read anything — it would stop at the credential instead.
  await cell('COV-CLI-REFUSES-BEFORE-CLIENT', async () => {
    const L = 'COV-CLI-REFUSES-BEFORE-CLIENT';
    const { spawnSync } = require('child_process');
    const cli = path.join(__dirname, '..', 'tools', 'identity-usable-check.js');
    const env = { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/never' }; delete env.GOOGLE_CLOUD_PROJECT; delete env.GCLOUD_PROJECT;
    for (const k of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB']) delete env[k];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-cli-'));
    const existing = path.join(dir, 'exists.json'); fs.writeFileSync(existing, '{}');
    const junk = path.join(dir, 'junk.json'); fs.writeFileSync(junk, JSON.stringify({ kind: 'identity-coverage-capture', v: 1, restaurants: {} }));
    for (const [args, re] of [
      [['--capture=x.json'], /--capture= is not accepted/],
      [['--rid', 'tb_x'], /unrecognised argument/],
      [['--capture', existing], /already exists/],
      [['--against', path.join(dir, 'absent.json')], /cannot be read/],
      [['--against', junk], /not a valid identity coverage capture/],
    ]) {
      const r = spawnSync(process.execPath, [cli, '--project', 'xpizza-delivery', ...args], { env, encoding: 'utf8', timeout: 30000 });
      assert.strictEqual(r.status, 2, `${L}: ${JSON.stringify(args)} exits 2 (got ${r.status}) ${String(r.stderr).replace(/\s+/g, ' ').slice(0, 160)}`);
      assert.match(r.stderr, re, `${L}: ${JSON.stringify(args)} names its cause`);
      assert.ok(!/credential|stage=init/i.test(`${r.stdout}${r.stderr}`), `${L}: ${JSON.stringify(args)} stopped BEFORE any client`);
    }
    assert.strictEqual(fs.readFileSync(existing, 'utf8'), '{}', `${L}: the existing capture is untouched`);
  });

  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nidentity-coverage: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.message); process.exit(1); });
