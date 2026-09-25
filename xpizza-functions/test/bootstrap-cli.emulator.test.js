'use strict';
require('./_emulator-required')('firestore');
/**
 * tools/bootstrap-identity.js — §10's cutover step, spawned for real.
 * Run: npm run test:bootstrap-cli
 *
 * 🔴 WHY A SPAWNED SUITE AND NOT A UNIT TEST OF THE PASS. The pass already has cells
 * (d4p1-bootstrap). What had no coverage is the thing an operator actually touches: a CLI that did not
 * exist until now, whose default mode decides whether a one-way door against a live menu opens by
 * accident. `--dry-run` being the default is a property of the ARGUMENT PARSING, and the only way to
 * test argument parsing is to run the arguments.
 *
 * 🔴 AND THE ASSERTION THAT MATTERS MOST IS THAT THE REHEARSAL MATCHES THE PERFORMANCE. A dry run that
 * prints a plausible plan and then applies something else is worse than no dry run, because it is the
 * artefact the operator decides on. So the dry-run output is captured, then `--apply` is run, and the
 * ids it actually wrote are compared against the ids the rehearsal named.
 *
 * 🔴 THE PROJECT NAMESPACE IS THE REAL ONE. The guard demands `--project xpizza-delivery` (it reads
 * .firebaserc), so this suite seeds into THAT project inside the emulator rather than the
 * `demo-xpizza` the runner defaults to — otherwise the CLI would look at a different project's data
 * and its "nothing to stamp" would be a fixture artefact rather than an answer.
 */
const assert = require('assert');
const admin = require('firebase-admin');
const { execFileSync } = require('child_process');
const { writeFileSync, mkdtempSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const { generateKeyPairSync } = require('crypto');
const { expectedProject } = require('../tools/require-project');
const { encodeKey } = require('../catalog/identity-registry');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('bootstrap-cli: FAILED — exited without completing'); process.exitCode = 1; } });

const PROJECT = expectedProject();
const app = admin.initializeApp({ projectId: PROJECT }, 'guarded');
const db = app.firestore();
const ROOT = join(__dirname, '..');
const RID = 'x_pizza';

/* A credential that PARSES and authenticates to nothing: generated here, for an account that has never
   existed. Without one the CLI dies in applicationDefault() before its own logic runs — which is how
   the exit-2 collision in backfill-identities hid for several slices. */
const saPath = join(mkdtempSync(join(tmpdir(), 'bootcli-')), 'sa.json');
{
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  writeFileSync(saPath, JSON.stringify({
    type: 'service_account', project_id: PROJECT, private_key_id: '0'.repeat(40), private_key: privateKey,
    client_email: `nobody@${PROJECT}.iam.gserviceaccount.com`, client_id: '0'.repeat(21),
    auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token',
  }));
}

const run = (args) => {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'tools', 'bootstrap-identity.js'), ...args], {
      cwd: ROOT, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: saPath, GCLOUD_PROJECT: '', GOOGLE_CLOUD_PROJECT: '' },
    });
    return { code: 0, out };
  } catch (e) { return { code: e.status === undefined ? -1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` }; }
};

const versionsCol = () => db.collection('restaurants').doc(RID).collection('versions');
const srcRef = () => db.collection('restaurants').doc(RID).collection('meta').doc('source');

(async () => {
  /* A minimal but REAL active version: two dishes and one extra, a pointer naming it, and a source
     carrying the same objects with no stamps. That is the pre-cutover state the pass is written for. */
  const V = `v-boot-${Date.now()}`;
  const items = [{ key: 'Alpha', price: 100 }, { key: 'Beta', price: 200 }];
  const extras = [{ key: 'Cheese', price: 50 }];
  const vref = versionsCol().doc(V);
  await vref.set({ created_at: new Date().toISOString(), identity_activation: { status: 'activated' } });
  for (const [i, it] of items.entries()) await vref.collection('menu_items').doc(`i${i}`).set({ key: it.key, price: it.price, display: { id: i + 1, name: it.key, price: it.price } });
  for (const [i, ex] of extras.entries()) await vref.collection('extras').doc(`e${i}`).set({ key: ex.key, price: ex.price, display: { id: 90 + i, name: ex.key, price: ex.price } });
  await db.collection('restaurants').doc(RID).collection('meta').doc('active_version').set({ version: V, generation: 1 });
  await srcRef().set({ items, extras, structure: { schema_version: 2, item_order: ['Alpha', 'Beta'] } });

  /* 🔴 AND THE REGISTRY MUST ALREADY HOLD THE IDS — bootstrap MINTS NOTHING. It refuses
     `identity_bootstrap_unregistered` against an empty registry ("run the D1 backfill first"), which
     is correct and is the state the CLI's first dry run actually reported. So the fixture is the
     post-D1, pre-cutover world: keys registered, version unstamped, source bare. Discovered by
     running the tool rather than by reading it — the refusal was the tool working. */
  const SEEDED = { Alpha: 'ID-ALPHA-001', Beta: 'ID-BETA-0001', Cheese: 'ID-CHEESE-01' };
  for (const [kind, rows] of [['dish', items], ['extra', extras]]) {
    for (const o of rows) {
      const idCol = db.collection('restaurants').doc(RID).collection('identity').doc(kind).collection('ids');
      const keyCol = db.collection('restaurants').doc(RID).collection('identity').doc(kind).collection('keys');
      await idCol.doc(SEEDED[o.key]).set({ legacy_key: o.key, status: 'live', kind, created_at: new Date().toISOString() });
      await keyCol.doc(encodeKey(o.key)).set({ canonical_id: SEEDED[o.key], kind, created_at: new Date().toISOString() });
    }
  }

  const certified = async () => ((await vref.get()).data() || {}).identity_certified === true;
  const sourceIds = async () => {
    const s = (await srcRef().get()).data() || {};
    const out = {};
    for (const o of (s.items || []).concat(s.extras || [])) out[o.key] = (o.display || {}).identity_id || null;
    return out;
  };

  // ── 1. 🔴 --dry-run IS THE DEFAULT: RUNNING WITH NO FLAGS WRITES NOTHING ────────────────────
  {
    assert.strictEqual(await certified(), false, 'premise — the version starts uncertified');

    const dry = run(['--rid=' + RID, '--project', PROJECT]);
    assert.strictEqual(dry.code, 0, `🔴 the dry run failed: ${dry.out.slice(0, 1200)}`);
    assert.match(dry.out, /DRY RUN — nothing will be written/, '🔴 the default mode does not announce itself as a rehearsal — an operator who believes they are rehearsing and is applying is the failure this tool is shaped to prevent');
    assert.ok(!/THIS WRITES/.test(dry.out), 'and it does not claim to be applying');

    /* 🔴 THE DEFAULT IS THE WHOLE PROPERTY. A safe mode you have to remember to ask for is not a safe
       mode; for a one-way door the safe path must be the one you get by not thinking. */
    assert.strictEqual(await certified(), false,
      '🔴 A RUN WITH NO --apply CERTIFIED THE VERSION. The default is not a dry run, so the one-way door opens by accident.');
    assert.deepStrictEqual(await sourceIds(), { Alpha: null, Beta: null, Cheese: null },
      '🔴 a run with no --apply enriched the source — the merchant\'s draft was written by a rehearsal');
    /* 🔴 AND IT SAYS WHICH HALF IT COULD NOT REHEARSE. reconcileLegacyOrphans refuses an uncertified
       version — it compares the registry against the CERTIFIED set, which does not exist yet — so on a
       first dry run there is nothing honest to report about orphans. A dry run that silently covered
       one of two halves would be the worst artefact this tool could produce, because it is the thing
       the operator approves. Found by running it: the first version printed a perfect stamping plan and
       then exited 1 on that refusal. */
    assert.match(dry.out, /orphans: NOT REHEARSED/,
      '🔴 the dry run did not disclose that the ORPHAN half could not be rehearsed — an operator would approve a plan covering half the pass believing it covered all of it');
    assert.match(dry.out, /ORPHAN half was not rehearsed/, 'and it says so again where the operator is told what to do next');
    ok('running with no flags is a DRY RUN that announces itself, writes nothing, and DISCLOSES that the orphan half could not be rehearsed');
  }

  // ── 2. 🔴 THE REHEARSAL MATCHES THE PERFORMANCE ────────────────────────────────────────────
  {
    /* The dry-run output IS the artefact the operator decides on, so a plan that does not match what
       --apply writes is worse than no plan at all. Captured, then compared against reality. */
    const dry = run(['--rid=' + RID, '--project', PROJECT]);
    const planned = {};
    for (const line of dry.out.split('\n')) {
      const m = line.match(/^\s+(dish|extra)\s+(\S+)\s+(.+?)\s*$/);
      if (m) planned[m[3]] = m[2];
    }
    assert.deepStrictEqual(Object.keys(planned).sort(), ['Alpha', 'Beta', 'Cheese'],
      `🔴 the dry run did not name every object it would stamp: ${JSON.stringify(planned)}\n${dry.out.slice(0, 600)}`);
    assert.match(dry.out, new RegExp(`WOULD certify version ${V}`), '🔴 the dry run does not say which version it would certify');

    const applied = run(['--rid=' + RID, '--project', PROJECT, '--apply']);
    assert.strictEqual(applied.code, 0, `🔴 --apply failed: ${applied.out.slice(0, 400)}`);
    assert.match(applied.out, /THIS WRITES, IN PLACE, WITH NO UNDO/, 'and --apply says so before doing it');
    assert.strictEqual(await certified(), true, '🔴 --apply did not certify the version');

    const actual = await sourceIds();
    /* 🔴 AND AGAINST THE REGISTRY, NOT ONLY AGAINST ITSELF. planned === actual would be satisfied by a
       dry run and an apply that agreed on the WRONG ids. The registry is the authority bootstrap
       stamps from, so the stamps must be the ids it holds. */
    assert.deepStrictEqual(actual, SEEDED,
      `🔴 the stamps are not the ids the REGISTRY holds — the pass invented or mis-mapped them: ${JSON.stringify(actual)}`);
    assert.deepStrictEqual(actual, planned,
      `🔴 THE DRY RUN AND THE APPLY DISAGREE. The rehearsal is the artefact the operator approves; a plan that does not match what gets written is worse than no plan.\n  planned: ${JSON.stringify(planned)}\n  actual:  ${JSON.stringify(actual)}`);
    ok('the dry run names every object and version it would touch, and --apply writes EXACTLY those ids — the rehearsal matches the performance');
  }

  // ── 3. A SECOND --apply IS A NO-OP, NOT A REWRITE ──────────────────────────────────────────
  {
    /* The pass is idempotent by design — a re-run over a certified version would otherwise re-stamp
       from a registry that may have moved on, which is the opposite of what a migration is for. The
       CLI must say so rather than look like it did work. */
    const before = await sourceIds();
    const again = run(['--rid=' + RID, '--project', PROJECT, '--apply']);
    assert.strictEqual(again.code, 0, `🔴 the idempotent re-run failed: ${again.out.slice(0, 300)}`);
    assert.match(again.out, /ALREADY certified/, '🔴 a re-run does not report that it did nothing — an operator cannot tell a no-op from a second pass');
    assert.deepStrictEqual(await sourceIds(), before, '🔴 the re-run REWROTE the stamps');
    ok('a second --apply reports ALREADY certified and rewrites nothing — idempotent, and visibly so');
  }

  // ── 4. USAGE FAILS WITH 1, NOT 2 — EXIT 2 IS THE GUARD'S ALONE ─────────────────────────────
  {
    /* backfill-identities.js:64 exited 2 for a usage error, colliding with project_guard_refused, and
       that collision was invisible to its own suite because applicationDefault() threw first. This
       tool states the contract; this cell holds it. */
    const noRid = run(['--project', PROJECT]);
    assert.strictEqual(noRid.code, 1,
      `🔴 a usage error exited ${noRid.code} — exit 2 is reserved for the project guard, so a script cannot tell "wrong database" from "you forgot --rid"`);
    assert.match(noRid.out, /usage: node tools\/bootstrap-identity\.js/, 'and it prints usage');

    const wrongProject = run(['--rid=' + RID, '--project', 'lamusa-social']);
    assert.strictEqual(wrongProject.code, 2, `🔴 a WRONG project did not exit 2 (got ${wrongProject.code})`);
    assert.match(wrongProject.out, /project_guard_refused/, 'and the guard is what stopped it');
    assert.ok(!/Firestore|active version/i.test(wrongProject.out),
      `🔴 the wrong-project run reached the SDK or read data before refusing:\n${wrongProject.out.slice(0, 300)}`);
    ok('a usage error exits 1 and a wrong project exits 2 before any client exists — the two are distinguishable by a script');
  }

  FINISHED = true;
  console.log(`bootstrap-cli(emulator): OK (${n})`);
})().catch((e) => { console.error('BOOTSTRAP CLI (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
