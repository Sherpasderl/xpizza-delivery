'use strict';
// Portal 1D · D1 — THE PROD BACKFILL CLI, RUN AS THE OWNER WILL RUN IT.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:backfill-identities
//
// 🔴 WHY A SUBPROCESS AND NOT A FUNCTION CALL. This tool is the instrument that writes identity into
// the live registry, and what needs proving is not backfillIdentities (covered in unit tests) but the
// CLI around it: that a run without --apply writes NOTHING, that the project guard refuses before it
// reads a byte, that a re-run preserves, and that the "verified" line the operator will trust is a
// real lookup rather than an echo of the tool's own report. None of that is reachable by requiring the
// module — argv parsing, exit codes, guard ordering and process lifetime only exist in a process. So
// every case below spawns `node tools/backfill-identities.js` exactly as a human would type it.
//
// Before this file the evidence for those behaviours was a transcript of a run in the author's
// session. A transcript is not a test: nobody else can execute it, and it cannot fail in CI.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const admin = require('firebase-admin');
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { liveKeys } = require('../catalog/identity-backfill');
const { getRestaurantMenu } = require('../catalog/catalog-menu');
const { encodeKey } = require('../catalog/identity-registry');

const PROJECT = 'xpizza-delivery';                    // must match .firebaserc or the guard refuses
admin.initializeApp({ projectId: PROJECT });          // FIRESTORE_EMULATOR_HOST set by emulators:exec
const db = admin.firestore();
const FUNCTIONS_DIR = path.join(__dirname, '..');
const CLI = path.join('tools', 'backfill-identities.js');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('backfill-identities(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

/* The CLI, spawned. The environment is built explicitly rather than inherited wholesale: emulators:exec
   exports GCLOUD_PROJECT, and leaving it in would mean the guard cases below were testing a
   flag-vs-environment DISAGREEMENT rather than the rule each one is named for. FIRESTORE_EMULATOR_HOST
   is kept — that is what routes every write to the emulator instead of production. */
function runCli(args, extraEnv = {}) {
  const env = { ...process.env, GCLOUD_PROJECT: '', GOOGLE_CLOUD_PROJECT: '', ...extraEnv };
  const r = spawnSync('node', [CLI, ...args], { cwd: FUNCTIONS_DIR, env, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const identityRows = async (rid) => {
  let count = 0;
  for (const kind of ['dish', 'extra']) {
    for (const leaf of ['keys', 'ids']) {
      count += (await db.collection('restaurants').doc(rid).collection('identity').doc(kind).collection(leaf).get()).docs.length;
    }
  }
  return count;
};
const clearRegistry = async (rid) => {
  for (const kind of ['dish', 'extra']) {
    for (const leaf of ['keys', 'ids']) {
      const snap = await db.collection('restaurants').doc(rid).collection('identity').doc(kind).collection(leaf).get();
      for (const d of snap.docs) await d.ref.delete();
    }
  }
};

(async () => {
  // A live catalog, published by the real publisher, then the registry emptied — publishVersion's own
  // preserve-on-write would otherwise leave nothing for the backfill to do.
  for (const rid of ['x_pizza', 'la_musa']) {
    const { input, expected } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'd1-cli' });
    await publishVersion(db, rid, input, { expected });
    await clearRegistry(rid);
    assert.strictEqual(await identityRows(rid), 0, `${rid}: premise — the registry starts empty`);
  }
  const KEYS = { x_pizza: liveKeys('x_pizza', await getRestaurantMenu(db, 'x_pizza')), la_musa: liveKeys('la_musa', await getRestaurantMenu(db, 'la_musa')) };

  // ── 1. 🔴 A DRY RUN WRITES NOTHING ────────────────────────────────────────────────────────────
  /* The one thing no static assertion can reach. The census test proves the strings "--apply" and
     "DRY RUN" appear in the file; only running it proves that omitting --apply leaves the database
     untouched. If this tool ever writes on a read-only invocation, an operator's "let me just check
     first" becomes a production write. */
  {
    const before = await identityRows('x_pizza');
    const r = runCli(['--rid=x_pizza', '--project', PROJECT]);
    assert.strictEqual(r.code, 0, `a dry run exits 0 — ${r.out}`);
    assert.ok(/DRY RUN — nothing was written/.test(r.out), `it says so: ${r.out}`);
    assert.ok(/24 live, 0 already registered, 24 to mint/.test(r.out), `and reports the work it would do: ${r.out}`);
    assert.strictEqual(await identityRows('x_pizza'), before,
      '🔴 a dry run must leave the registry byte-for-byte untouched');
    assert.strictEqual(before, 0, 'non-vacuity: …and there was a registry to write to, so "unchanged" is not "unwritable"');
    ok('a DRY RUN reports the work and writes zero rows');
  }

  // ── 2. --apply CREATES, AND THE DATABASE REALLY HOLDS IT ─────────────────────────────────────
  {
    const r = runCli(['--rid=x_pizza', '--project', PROJECT, '--apply']);
    assert.strictEqual(r.code, 0, `apply exits 0 — ${r.out}`);
    assert.ok(/dish: 24 total — 24 created, 0 preserved/.test(r.out), `24 dishes minted: ${r.out}`);
    assert.ok(/extra: 14 total — 14 created, 0 preserved/.test(r.out), `14 extras minted: ${r.out}`);
    // Asserted against the DATABASE, not against the tool's own words.
    assert.strictEqual(await identityRows('x_pizza'), (24 + 14) * 2,
      '🔴 the registry holds an id row and a key row for every live object');
    for (const k of KEYS.x_pizza.dish) {
      const snap = await db.collection('restaurants').doc('x_pizza').collection('identity').doc('dish').collection('keys').doc(encodeKey(k)).get();
      assert.ok(snap.exists && snap.data().canonical_id, `${k} resolves in the registry`);
    }
    ok('--apply creates 24 dishes + 14 extras and the database holds every one of them');
  }

  // ── 3. 🔴 THE "verified" LINE IS A REAL LOOKUP, NOT AN ECHO OF THE REPORT ─────────────────────
  /* The line an operator trusts most, so it gets the tightest pin available. The report's numbers come
     from what backfillIdentities believes it did; the verified line is a fresh read of the registry.
     To tell those apart, the database is changed BEHIND the tool's back — three key rows deleted with
     no backfill involved — and the tool re-run read-only. A tool echoing a cached or computed figure
     would still say 24 already registered. Only one that reads says 21.
     What this proves: the counts are sourced from the database. What it does not prove: that the
     post-apply verified line could ever disagree with the report, which is not constructible without
     mutating the tool — stated so the assertion is not read as more than it is. */
  {
    /* BOTH ROWS PER VICTIM, and that detail is the registry's reserved-id rule showing itself: delete
       only the key row and its id row is orphaned, so the re-apply below mints a FRESH id rather than
       restoring the old one — the retired id stays reserved, exactly as alias-non-reuse requires.
       Correct behaviour, but it would leave this test's store with 3 extra orphans and make the row
       counts downstream mean something different from what they say. So the probe removes the whole
       identity and the re-apply genuinely restores the count. */
    const victims = KEYS.x_pizza.dish.slice(0, 3);
    const dishCol = db.collection('restaurants').doc('x_pizza').collection('identity').doc('dish');
    for (const k of victims) {
      const keyRef = dishCol.collection('keys').doc(encodeKey(k));
      const held = await keyRef.get();
      assert.ok(held.exists, `premise — ${k} was registered before the probe deleted it`);
      await dishCol.collection('ids').doc(held.data().canonical_id).delete();
      await keyRef.delete();
    }
    const r = runCli(['--rid=x_pizza', '--project', PROJECT]);           // read-only
    assert.strictEqual(r.code, 0, `the probing dry run exits 0 — ${r.out}`);
    assert.ok(/dishes: 24 live, 21 already registered, 3 to mint/.test(r.out),
      `🔴 the counts must follow the DATABASE — three rows were deleted out of band, so a tool that reads says 21 and one that echoes says 24: ${r.out}`);

    // Restore by re-applying, and confirm the verified line matches an INDEPENDENT count of the store.
    const back = runCli(['--rid=x_pizza', '--project', PROJECT, '--apply']);
    assert.ok(/dish: 24 total — 3 created, 21 preserved/.test(back.out),
      `🔴 it mints only what was missing: ${back.out}`);
    const verified = /verified: (\d+)\/(\d+) dishes and (\d+)\/(\d+) extras/.exec(back.out);
    assert.ok(verified, `the verified line is present: ${back.out}`);
    const dishKeyRows = (await db.collection('restaurants').doc('x_pizza').collection('identity').doc('dish').collection('keys').get()).docs.length;
    assert.strictEqual(Number(verified[1]), dishKeyRows,
      '🔴 the verified count equals an independent count of the registry taken by this test');
    assert.strictEqual(Number(verified[1]), 24, '…and every live dish is accounted for');
    ok('the reported counts are read from the database — deleting rows out of band changes them, and "verified" matches an independent count');
  }

  // ── 4. A RE-RUN PRESERVES — IDEMPOTENCE AND RESUME, AT THE CLI ───────────────────────────────
  {
    const r = runCli(['--rid=x_pizza', '--project', PROJECT, '--apply']);
    assert.strictEqual(r.code, 0, `a re-run exits 0 — ${r.out}`);
    assert.ok(/dish: 24 total — 0 created, 24 preserved/.test(r.out), `🔴 a re-run mints nothing: ${r.out}`);
    assert.ok(/extra: 14 total — 0 created, 14 preserved/.test(r.out), `🔴 …for extras either: ${r.out}`);
    assert.strictEqual(await identityRows('x_pizza'), (24 + 14) * 2, 'and the row count is unchanged');
    ok('a re-run creates 0 and preserves 38 — safe to repeat, and the way an interrupted run resumes');
  }

  // ── 5. THE OTHER BRAND, WHICH GRANDFATHERS ITS SLUG ─────────────────────────────────────────
  {
    const r = runCli(['--rid=la_musa', '--project', PROJECT, '--apply']);
    assert.strictEqual(r.code, 0, `la_musa applies — ${r.out}`);
    assert.ok(/dish: 44 total — 44 created, 0 preserved/.test(r.out), `44 dishes: ${r.out}`);
    assert.ok(/extra: 14 total — 14 created, 0 preserved/.test(r.out), `14 extras: ${r.out}`);
    const slug = KEYS.la_musa.dish[0];
    const snap = await db.collection('restaurants').doc('la_musa').collection('identity').doc('dish').collection('keys').doc(encodeKey(slug)).get();
    assert.strictEqual(snap.data().canonical_id, slug, '🔴 la_musa grandfathers its slug through the CLI too');
    ok(`la_musa applies 44 + 14 and grandfathers its slug (${slug})`);
  }

  // ── 6. 🔴 THE PROJECT GUARD REFUSES BEFORE IT READS ANYTHING ─────────────────────────────────
  /* Three refusals, each for its own rule, and each asserted to have touched nothing. The row count is
     taken before and after: a guard that refuses AFTER connecting is not the guard the runbook
     describes, and "it printed REFUSED" does not by itself prove it read nothing. */
  {
    const before = await identityRows('x_pizza');
    const cases = {
      'no --project at all': { args: ['--rid=x_pizza'], env: {}, expect: /requires the project as an explicit flag/ },
      'a matching GOOGLE_CLOUD_PROJECT but no flag': { args: ['--rid=x_pizza'], env: { GOOGLE_CLOUD_PROJECT: PROJECT }, expect: /requires the project as an explicit flag/ },
      'a WRONG --project': { args: ['--rid=x_pizza', '--project', 'lamusa-social'], env: {}, expect: /refusing to run against lamusa-social/ },
    };
    for (const [label, c] of Object.entries(cases)) {
      const r = runCli(c.args, c.env);
      assert.strictEqual(r.code, 2, `🔴 ${label}: must exit 2 (the guard's code, distinct from a work failure) — got ${r.code}: ${r.out}`);
      assert.ok(c.expect.test(r.out), `${label}: refused for the stated reason — ${r.out}`);
      assert.ok(/nothing was read and nothing was written/.test(r.out), `${label}: says so`);
      assert.ok(!/live version/.test(r.out), `🔴 ${label}: it must not have reached the catalog read`);
    }
    assert.strictEqual(await identityRows('x_pizza'), before, '🔴 no refusal touched a row');
    ok(`${Object.keys(cases).length} guard refusals each exit 2 having read nothing — including a matching env var with no flag`);
  }

  // ── 7. AN UNREADABLE CATALOG STOPS THE RUN, WRITING NOTHING ─────────────────────────────────
  /* 🔴 AND AN HONEST NOTE ON WHAT THIS DOES *NOT* COVER. The CLI also handles
     identity_backfill_unkeyable — a live record that yields no legacy key. That branch cannot be
     reached through the real reader today: getRestaurantMenu validates every document and refuses a
     missing, empty or non-string key with catalog_bad_doc BEFORE liveKeys ever sees it (verified by
     corrupting a menu_items doc three ways — emptied, removed, and made a number — all of which came
     back catalog_bad_doc). So the unkeyable guard is defence-in-depth against a future reader shape
     change, which is precisely the change that broke this module once already, and it is tested at the
     unit level in identity-registry.test.js rather than here.
     What IS reachable is this: the reader refuses, and the CLI must stop without writing. */
    {
    const rid = 'x_pizza';
    await clearRegistry(rid);
    const vid = (await db.collection('restaurants').doc(rid).collection('meta').doc('active_version').get()).data().version;
    const col = db.collection('restaurants').doc(rid).collection('versions').doc(vid).collection('menu_items');
    const doc = (await col.get()).docs[0];
    const original = doc.data();
    await doc.ref.set({ ...original, key: '' });                    // the reader must refuse this

    const r = runCli(['--rid=' + rid, '--project', PROJECT, '--apply']);
    assert.strictEqual(r.code, 1, `🔴 an unreadable catalog exits 1 (a work failure, not a guard refusal) — got ${r.code}: ${r.out}`);
    assert.ok(/cannot read .*'?s live catalog|catalog_bad_doc/.test(r.out), `it names the read failure: ${r.out}`);
    assert.ok(/Nothing was written/.test(r.out), `and says nothing was written: ${r.out}`);
    assert.strictEqual(await identityRows(rid), 0,
      '🔴 …and nothing WAS written — a backfill over a partial menu is worse than none');

    await doc.ref.set(original);                                    // leave the store as we found it
    const after = runCli(['--rid=' + rid, '--project', PROJECT, '--apply']);
    assert.strictEqual(after.code, 0, `non-vacuity: with the catalog repaired the same command succeeds — ${after.out}`);
    assert.ok(/24 created/.test(after.out), '…and does the work it refused to do before');
    ok('an unreadable catalog exits 1 with zero rows written, and the same command succeeds once repaired');
  }

  FINISHED = true;
  console.log(`backfill-identities(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('BACKFILL CLI (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
