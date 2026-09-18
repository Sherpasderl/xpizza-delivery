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

/* 🔴 THE EMULATOR GUARD — BEFORE firebase-admin IS EVEN REQUIRED, LET ALONE INITIALIZED.
   Every other emulator test in this directory initializes against a `demo-` project id, which the
   Admin SDK cannot route to production no matter how it is invoked. This one CANNOT do that: the CLI
   it spawns runs require-project, which refuses any project that is not .firebaserc's `xpizza-delivery`
   — so the harness has to name the real production project to exercise the real guard.
   That makes this file the one destructive harness in the repo that is pointed at a production project
   id. It publishes catalogs, deletes registry rows and deliberately corrupts a catalog document as
   fixtures. Under `npm run test:backfill-identities` that is all safe, because emulators:exec sets
   FIRESTORE_EMULATOR_HOST and every read and write goes to the emulator. Run directly —
   `node test/backfill-identities.emulator.test.js` — on a machine with usable production ADC, those
   same fixtures would execute against PRODUCTION.
   So the emulator is not assumed from the invocation. It is asserted here, first, and a missing host
   exits 2 having required nothing, constructed nothing and read nothing. This is the same hazard the
   CLI's own --project guard exists to prevent, one level up: the test harness for a guarded tool must
   not itself be runnable against prod by mis-invocation. */
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('\nREFUSED — FIRESTORE_EMULATOR_HOST is not set.\n');
  console.error('This harness publishes catalogs, deletes registry rows and corrupts a catalog document');
  console.error(`as fixtures, and it names the PRODUCTION project (it must, to exercise the CLI's own`);
  console.error('project guard). Without the emulator those writes would land in production.\n');
  console.error('Run it the documented way:');
  console.error('  PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:backfill-identities\n');
  console.error('nothing was read and nothing was written.\n');
  process.exit(2);
}

const admin = require('firebase-admin');
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { liveKeys } = require('../catalog/identity-backfill');
const { getRestaurantMenu } = require('../catalog/catalog-menu');
const { encodeKey, retireIdentity } = require('../catalog/identity-registry');

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
  // The child must reach the EMULATOR too — it is the process that actually writes identities.
  assert.ok(env.FIRESTORE_EMULATOR_HOST, '🔴 the spawned CLI would write to production — FIRESTORE_EMULATOR_HOST is not in its environment');
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
/* 🔴 THE REGISTRY AS THE DATABASE HOLDS IT — every key row, and the id row it is paired with.
   Counting rows proves a number; this proves the MAPPING, which is what the overlay will read. A key
   row whose id row is missing, or whose id row names a different object, is a broken identity that an
   aggregate count cannot see — and "38 rows exist" would happily pass over it. */
const readMappings = async (rid, keys) => {
  const out = { dish: {}, extra: {} };
  for (const kind of ['dish', 'extra']) {
    const col = db.collection('restaurants').doc(rid).collection('identity').doc(kind);
    for (const k of keys[kind]) {
      const keySnap = await col.collection('keys').doc(encodeKey(k)).get();
      assert.ok(keySnap.exists, `🔴 ${rid}/${kind}: ${k} has no key row — it would serve id-less forever`);
      const id = (keySnap.data() || {}).canonical_id;
      assert.ok(typeof id === 'string' && id, `🔴 ${rid}/${kind}/${k}: the key row carries no canonical id`);
      const idSnap = await col.collection('ids').doc(id).get();
      assert.ok(idSnap.exists, `🔴 ${rid}/${kind}/${k}: the key row points at ${id}, which has no id row — a half identity`);
      assert.strictEqual((idSnap.data() || {}).legacy_key, k,
        `🔴 ${rid}/${kind}/${k}: the id row names a different object (${(idSnap.data() || {}).legacy_key}) — the mapping is crossed`);
      assert.strictEqual((idSnap.data() || {}).status, 'live', `${rid}/${kind}/${k}: and it is live`);
      out[kind][k] = id;
    }
  }
  return out;
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
    /* Asserted against the DATABASE, not against the tool's own words — and per OBJECT, both kinds,
       with the key row and its id row checked as a pair. The earlier version checked an aggregate row
       count plus the dish keys, which would have passed over a missing extra or a crossed mapping. */
    assert.strictEqual(await identityRows('x_pizza'), (24 + 14) * 2,
      '🔴 the registry holds an id row and a key row for every live object');
    const mapped = await readMappings('x_pizza', KEYS.x_pizza);
    assert.strictEqual(Object.keys(mapped.dish).length, 24, '🔴 all 24 dishes map, counted from the DB');
    assert.strictEqual(Object.keys(mapped.extra).length, 14, '🔴 all 14 extras map too — not just the dishes');
    assert.strictEqual(new Set([...Object.values(mapped.dish), ...Object.values(mapped.extra)]).size, 38,
      '🔴 …to 38 DISTINCT ids — two objects sharing an identity is the failure the registry exists to prevent');
    ok('--apply creates 24 dishes + 14 extras, every key paired with its own id row in the database');
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
    /* 🔴 THE MAPPINGS, NOT THE COUNT. A re-run that silently re-minted every id would keep the row
       count at 76 and still report whatever it liked; only comparing the actual key→id mapping before
       and after catches an identity that moved. That is the property preserve-on-write exists for —
       an object whose id changes between runs is an object that two orders describe differently. */
    const before = await readMappings('x_pizza', KEYS.x_pizza);
    const r = runCli(['--rid=x_pizza', '--project', PROJECT, '--apply']);
    assert.strictEqual(r.code, 0, `a re-run exits 0 — ${r.out}`);
    assert.ok(/dish: 24 total — 0 created, 24 preserved/.test(r.out), `🔴 a re-run mints nothing: ${r.out}`);
    assert.ok(/extra: 14 total — 0 created, 14 preserved/.test(r.out), `🔴 …for extras either: ${r.out}`);
    assert.strictEqual(await identityRows('x_pizza'), (24 + 14) * 2, 'and the row count is unchanged');
    const after = await readMappings('x_pizza', KEYS.x_pizza);
    assert.deepStrictEqual(after, before,
      '🔴 every key→id mapping is byte-identical across the re-run — not merely the same NUMBER of them');
    ok('a re-run creates 0, preserves 38, and leaves every key→id mapping unchanged');
  }

  // ── 5. THE OTHER BRAND, WHICH GRANDFATHERS ITS SLUG ─────────────────────────────────────────
  {
    const r = runCli(['--rid=la_musa', '--project', PROJECT, '--apply']);
    assert.strictEqual(r.code, 0, `la_musa applies — ${r.out}`);
    assert.ok(/dish: 44 total — 44 created, 0 preserved/.test(r.out), `44 dishes: ${r.out}`);
    assert.ok(/extra: 14 total — 14 created, 0 preserved/.test(r.out), `14 extras: ${r.out}`);
    /* Counted from the DATABASE, not read off the tool's output, and the slug pinned BY NAME rather
       than by whatever happens to be first in the key set — a dynamically-selected slug would still
       pass if the ordering changed underneath and the assertion quietly moved to a different dish. */
    const lm = await readMappings('la_musa', KEYS.la_musa);
    assert.strictEqual(Object.keys(lm.dish).length, 44, '🔴 44 dishes map, counted independently from the DB');
    assert.strictEqual(Object.keys(lm.extra).length, 14, '🔴 …and 14 extras');
    assert.strictEqual(lm.dish.dimsum_01, 'dimsum_01',
      '🔴 la_musa grandfathers its slug through the CLI — dimsum_01 is its own canonical id');
    for (const [k, id] of Object.entries(lm.dish)) {
      assert.strictEqual(id, k, `🔴 every la_musa dish is grandfathered, not just the pinned one (${k} → ${id})`);
    }
    ok('la_musa applies 44 + 14, every dish grandfathered, dimsum_01 pinned by name');
  }

  // ── 5b. 🔴 THE VERIFY LINE IS NOT AN ECHO — REPORT SAYS 44, THE REREAD SAYS 43 ───────────────
  /* I argued this could not be built black-box: after a non-faulty run the report and the verify line
     are necessarily equal, so separating them would need a race or a fault-injection seam in the
     production script. That was wrong, and the seam was already in the data model — the registry
     stores an identity as TWO rows, and they can be desynced from outside.
     Delete only the KEY row and leave the id row LIVE. ensureIdentity then finds no key row, proposes
     the grandfathered slug, finds that id row already present and belonging to this same object, and
     returns it as PRESERVED — without restoring the key row it never read. So the backfill honestly
     reports 44 dishes preserved while lookupByLegacyKeys, which resolves through key rows, can only
     find 43. Report 44, reread 43, deterministic, no prod change.
     Only works on the grandfathered brand: x_pizza proposes a random token, misses the retained id row
     entirely, and mints a fresh identity — self-healing, and no disagreement to observe. It must also
     run BEFORE the retirement case below, which takes dimsum_01 out of service. */
  {
    const rid = 'la_musa';
    const victim = KEYS.la_musa.dish[1];                 // not dimsum_01 — that one is retired later
    assert.notStrictEqual(victim, 'dimsum_01', 'premise — the victim is not the dish the retirement case uses');
    const col = db.collection('restaurants').doc(rid).collection('identity').doc('dish');
    const keyRef = col.collection('keys').doc(encodeKey(victim));
    const held = await keyRef.get();
    assert.ok(held.exists, `premise — ${victim} is registered before the reverse index is broken`);
    const id = (held.data() || {}).canonical_id;
    const idSnap = await col.collection('ids').doc(id).get();
    assert.strictEqual((idSnap.data() || {}).status, 'live',
      'premise — the id row stays LIVE; only the reverse index is lost, which is what makes the report disagree');

    await keyRef.delete();

    const r = runCli(['--rid=' + rid, '--project', PROJECT, '--apply']);
    assert.ok(/dish: 44 total — 0 created, 44 preserved/.test(r.out),
      `🔴 the REPORT claims all 44 dishes preserved: ${r.out}`);
    assert.ok(/verified: 43\/44 dishes/.test(r.out),
      `🔴 …and the REREAD says 43. A verify line echoing the report would have said 44/44 — this is the assertion that keeps it a real lookup: ${r.out}`);
    assert.ok(/INCOMPLETE/.test(r.out), `it reports the state as incomplete: ${r.out}`);
    assert.strictEqual(r.code, 1, `🔴 and exits 1 rather than claiming success — got ${r.code}: ${r.out}`);
    assert.ok(!/is fully registered/.test(r.out), '🔴 …never printing the success line');

    /* Repaired by hand, because the backfill cannot repair this one: every re-run takes the same
       preserve path and reports the same 44. That is why the tool's INCOMPLETE guidance ends with
       "if it stays incomplete, stop and report" — this is the state that reaches it. */
    await keyRef.set({ canonical_id: id, kind: 'dish', created_at: new Date().toISOString() });
    const back = runCli(['--rid=' + rid, '--project', PROJECT, '--apply']);
    assert.strictEqual(back.code, 0, `non-vacuity: once the reverse index is restored the same command succeeds — ${back.out}`);
    assert.ok(/verified: 44\/44 dishes/.test(back.out), '…and the verify line follows the database back up to 44');
    ok('the verify line disagrees with the report when the database disagrees — report 44 preserved, reread 43, INCOMPLETE, exit 1');
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

  // ── 8. A REGISTRY REFUSAL SURFACES AS A FAILURE, AND THE ROWS ALREADY WRITTEN SURVIVE ───────
  /* 🔴 WHY THIS IS HERE AND NOT A POST-APPLY ECHO TEST. The gate asked whether anything distinguishes
     the "verified N/N" line from an echo of the tool's own report. Nothing black-box can, and the
     reason is structural rather than a gap in effort: after any NON-FAULTY run the two values are
     necessarily equal — the report totals the keys it processed, the verify line counts the keys that
     resolve, and a successful backfill makes those the same number. To separate them the database
     would have to be short of what the report claims, which is producible only by racing the process
     mid-run or by mutating the tool. What IS proven, in case 3, is that the counts come from the
     database at all: three identities deleted out of band moved the reported numbers, through the same
     lookupByLegacyKeys call the verify line uses. Source ordering does the rest — the verify line reads
     `after`, computed by a fresh lookup after backfillIdentities returned, never from `report`.
     So instead of a test that cannot discriminate, here is a REACHABLE failure the CLI must handle:
     a retired grandfathered slug. The registry refuses to re-issue it (a retired id stays reserved
     forever), and what matters is that the tool reports that as a FAILURE rather than a tidy success,
     and that the rows it had already written are left alone — the runbook forbids deleting them. */
  {
    const rid = 'la_musa';
    const before = await readMappings(rid, KEYS.la_musa);
    const victim = 'dimsum_01';
    const gone = await retireIdentity(db, { rid, kind: 'dish', canonicalId: victim });
    assert.strictEqual(gone.retired, true, 'premise — the slug really was retired');
    /* Counted AFTER the retirement, because retireIdentity deletes the key row itself — that is its
       job. The claim being made below is that the failed RUN deletes nothing, not that the fixture
       that set the run up deletes nothing. */
    const rowsBeforeFailure = await identityRows(rid);

    const r = runCli(['--rid=' + rid, '--project', PROJECT, '--apply']);
    assert.strictEqual(r.code, 1,
      `🔴 a registry refusal must exit 1, not be reported as a successful backfill — got ${r.code}: ${r.out}`);
    assert.ok(/identity_slug_retired/.test(r.out), `it names the refusal: ${r.out}`);
    assert.ok(/must not be deleted/.test(r.out),
      `and tells the operator not to "clean up" the rows already written: ${r.out}`);
    assert.ok(!/is fully registered/.test(r.out), '🔴 …and never claims success');

    /* 🔴 NO ROLLBACK — AND THAT IS THE DESIGN, NOT A MISSING FEATURE. A tool that undid its writes on
       failure would be deleting registry rows, and a deleted id is one that can be handed to a
       different object later; the runbook forbids it in as many words. So a failed run is expected to
       LEAVE its correct rows in place and be re-runnable, and this asserts exactly that rather than
       treating the surviving rows as incidental. */
    const survivors = { dish: KEYS.la_musa.dish.filter((k) => k !== victim), extra: KEYS.la_musa.extra };
    const after = await readMappings(rid, survivors);
    for (const k of survivors.dish) {
      assert.strictEqual(after.dish[k], before.dish[k], `🔴 ${k} lost or changed its identity on a failed run`);
    }
    for (const k of survivors.extra) {
      assert.strictEqual(after.extra[k], before.extra[k], `🔴 extra ${k} lost or changed its identity`);
    }
    // …and the retired id itself is still reserved, not freed.
    assert.strictEqual(await identityRows(rid), rowsBeforeFailure,
      '🔴 the failed run deleted NOTHING — no rollback, by design');
    const idRow = await db.collection('restaurants').doc(rid).collection('identity').doc('dish').collection('ids').doc(victim).get();
    assert.strictEqual(idRow.exists, true, '🔴 the retired id row must survive — a freed id can be handed to a different object');
    assert.strictEqual((idRow.data() || {}).status, 'retired', '…still marked retired');
    ok(`a retired slug makes the CLI exit 1 naming identity_slug_retired, with all ${survivors.dish.length + survivors.extra.length} other identities intact and the reserved id still held`);
  }

  FINISHED = true;
  console.log(`backfill-identities(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('BACKFILL CLI (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
