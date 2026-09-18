# Runbook — Portal 1D · D1 catalog identity persistence

**Status:** not deployed. Every step below is the owner's; the executor pushes nothing.
**Project pin:** every prod operation states `--project xpizza-delivery` explicitly. The ambient
gcloud default drifts, and a deploy to the wrong project is the failure this pin exists for.

## What D1 changes, in one line

Every live dish and extra gets a platform-minted, stable, name-independent id, persisted in a registry
and laid onto the served menu after the version read is hash-verified. **Nothing reads it.** Price, 86,
reward and factura are byte-identical with it present and with it absent, including on every failure
path — that is the whole claim, and the only claim.

## Before anything: running the emulator tests

🔴 **Set the JDK on PATH first.** Homebrew's openjdk lives at `/opt/homebrew/opt/openjdk/bin` and is
**not** on the default PATH, so `java -version` fails and `firebase emulators:exec` refuses to start
with *"Unable to locate a Java Runtime"*. That message reads exactly like a missing toolchain, and an
hour was burned on it here concluding the emulator could not run on this machine. It can; it just needs
the export.

```sh
cd xpizza-functions
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"

npm run test:public-menu          # the endpoint, end to end → OK (7)
npm run test:identity-registry    # first-assignment serialization on the REAL engine → OK (5)
npm run test:backfill-identities  # the deploy CLI, run as a subprocess → OK (9)
```

Both must be green before deploy. What each one covers:

| test | covers | does NOT cover |
|---|---|---|
| `test:public-menu` | the served endpoint against real Firestore, with D1's overlay step in the path | anything about identity — its "identity" fixtures are the RTDB **routing** config the isActive gate reads, unrelated to the catalog registry |
| `test:identity-registry` | concurrent `ensureIdentity` on one object against Firestore's own transaction engine: one id, one id row, one key row, retries genuinely forced | the no-op claim, which is node-side |
| `test:backfill-identities` | the deploy CLI itself, spawned as a subprocess exactly as you will type it: dry run writes nothing, `--apply` creates 24+14 with every key paired to its own id row, a re-run leaves every mapping identical, the guard refuses (no flag / wrong project) having read nothing, an unreadable catalog exits 1 writing nothing, a retired slug exits 1 leaving other identities intact, and the "verified" line is proven to disagree with the report when the database does. Refuses to run at all unless `FIRESTORE_EMULATOR_HOST` is set | the unkeyable-record branch, which the reader refuses before it can be reached (see below) |

`npm test` (no Java needed) carries the rest: 2245 checks, including the no-op matrix across both
brands and every forced failure path.

## Sequence

1. **Deploy functions** — `firebase deploy --only functions --project xpizza-delivery`.
   D1 is inert on arrival: the registry is empty, so the overlay resolves nothing and every served
   record goes out id-less. That is byte-identical to today's menu. Nothing is switched on by
   deploying; the backfill below is what starts minting.

2. **Backfill, one brand at a time** — `xpizza-functions/tools/backfill-identities.js`.
   x_pizza first: fewer objects, and it is the minting path rather than the grandfathered one, so a
   surprise shows up on the smaller blast radius.

   Needs ADC (`gcloud auth application-default login`) or a service-account key in
   `GOOGLE_APPLICATION_CREDENTIALS`. No Java, no emulator — this talks to production.

   **Dry run first. It reads only and writes nothing:**

   ```sh
   cd xpizza-functions
   node tools/backfill-identities.js --rid=x_pizza --project xpizza-delivery
   ```

   ```
   project: xpizza-delivery  (stated explicitly and matched against .firebaserc)
   x_pizza: live version v-… (seq N) — 24 dishes, 14 extras
     dishes: 24 live, 0 already registered, 24 to mint
     extras: 14 live, 0 already registered, 14 to mint

   DRY RUN — nothing was written. Re-run with --apply to register the identities above.
   ```

   **Then apply:**

   ```sh
   node tools/backfill-identities.js --rid=x_pizza --project xpizza-delivery --apply
   ```

   ```
   applied to x_pizza:
     dish: 24 total — 24 created, 0 preserved
     extra: 14 total — 14 created, 0 preserved
     verified: 24/24 dishes and 14/14 extras resolve in the registry

   done — x_pizza is fully registered.
   ```

   Then the same two commands with `--rid=la_musa`, expecting **44 dishes + 14 extras**.

   The counts above are what a first run prints. **A re-run is safe and prints `0 created, N
   preserved`** — that is the idempotence, and it is also how you resume if a run is interrupted.

   `--project` is mandatory **as a flag** and is checked against `.firebaserc`. A mismatch, or no
   flag at all, refuses with exit code 2 before dotenv loads, before any credential is resolved and
   before any byte is read. An exported `GOOGLE_CLOUD_PROJECT` does **not** substitute for it, even
   when it names the right project: the pin exists so the operator consciously states the target, and
   an environment variable can be inherited, stale, or set by a `.env` file nobody reading the command
   line would see. (Other tools in `tools/` still accept the environment form their own runbooks
   document — this requirement is opted into by this tool.) `--apply` is never the default.

   🔴 **The key set comes from the LIVE catalog** (`getRestaurantMenu`), not from the code tables.
   Two things in the repo look like "the menu" and only one of them is live; they agree only until a
   merchant edits through the portal, after which a code-keyed backfill would mint ids for objects
   nobody sells while the real ones serve id-less. The tool reads the live version through the same
   reader the serving path uses, and a test asserts it never reaches for the code tables.

   **If it prints `identity_backfill_unkeyable`, STOP.** (Note: with today's reader this should be
   unreachable — `getRestaurantMenu` refuses a bad key with `catalog_bad_doc` first, and that path
   exits 1 writing nothing. The guard is defence-in-depth against a future reader shape change, which
   is the change that broke this module once already. If you ever see it, that is what happened.) It names the kind, the index and the fields it
   actually found, e.g. `dish[2] yields no legacy key — fields were {sku,price}`. It means the live
   catalog holds a record shape the backfill cannot key. Nothing was written. Do not work around it —
   a partial registration leaves objects permanently id-less with no signal, which is the failure this
   guard exists to make loud. Report the named record.

   **If it exits with `INCOMPLETE`**, re-run it: it mints only what is missing. Registry rows already
   written are correct and must never be deleted — the tool does not roll back on failure, by design,
   and a failed run is meant to be re-runnable.

   **If it stays INCOMPLETE across re-runs, stop and report — do not keep re-running.** There is one
   known state the backfill cannot repair by itself: an identity is stored as two rows (`ids/<id>` and
   `keys/<encoded legacy key>`), and if the KEY row is lost while the id row survives as `live`, then
   on La Musa the backfill proposes the same grandfathered slug, finds that id row already belongs to
   this object, and reports it **preserved** — without rewriting the missing key row. Every run then
   reports "44 preserved" while the verification resolves 43, forever. This cannot arise from normal
   operation (both rows are written in one transaction) and needs a deliberate or partial out-of-band
   deletion, but if you meet it, the repair is to restore the key row pointing at the existing id — not
   to delete the id row and re-mint, which would spend a reserved identity.

3. **Verify the serve is unchanged.** Fetch `/menu/x_pizza` and `/menu/la_musa`. Dishes and extras now
   carry `dish_id` / `extra_id`; nothing else about the body moved. The browser strips them at both
   boundaries, so no id reaches a cart, an order payload, the redemption canonical or the quote
   fingerprint.

4. **Watch for `public_menu_identity_absent`.** A diagnostic, never a decision — no caller branches on
   it and no response changes shape. It means the registry read failed or timed out and the menu was
   served id-less, which is the correct inert fallback. Frequent occurrences mean the registry is slow,
   not that customers are affected.

## Rollback

There is nothing to roll back in the serving path: ids are additive and nothing reads them. If the
overlay misbehaves, redeploy the prior functions revision — the registry can be left exactly where it
is. **Do not delete registry rows.** Retired ids stay reserved permanently by design; a freed id handed
to a new object would make old records resolve to something nobody meant, and that is unrepairable
after the fact.

## Named proposal, deferred to D4: `ensureIdentity` self-heals a missing key row

**Status: proposed, not built, not gated.** Recorded here so it is a decision someone takes rather
than a gap someone rediscovers.

`ensureIdentity` currently returns `{ created: false }` when it proposes a grandfathered slug and
finds that id row already belongs to the same object — **without rewriting the `keys/` row it did not
find**. That is what makes the persistent-`INCOMPLETE` state above unrepairable by re-running: the
backfill reports the object preserved on every pass while the reverse index stays short.

The proposal is one line in that branch: when the key row was absent and the id row is live and
belongs to this legacy key, write the key row back before returning preserved. It is idempotent, it
cannot mint, and it turns a manual repair into a re-run.

**Why it is not in D1.** The state needs a deliberate or partial out-of-band deletion to reach — both
rows are written in one transaction — and `identity-registry.js` is inside the money-gated no-op
surface. Changing it would reopen that approval for a repair no production path needs yet. At D4 the
id becomes authoritative, the registry stops being shadow, and a self-healing reverse index is worth
its own gate round. Take it there, with its own test and its own money-gate — not as a quiet edit.

## What D1 deliberately does NOT do

Rewrite immutable version payloads, snapshots, mirrors or rollback to carry ids (served ids come from
the overlay instead); touch the delete/rename machinery; pair renames by id; or let any pricing, 86,
reward or factura selector read an id. All of that is D4/D5.

## Known gap, carried forward

`ensureIdentitiesForKeys` runs after the publish lease is released, bounded at 5s. What that bound
guarantees depends on *where* the registry stalls, and the difference is worth stating precisely
because the obvious phrasing — "nothing lands after the timeout" — is true of one case and not the
other.

**A stalled read → nothing lands.** The transaction callback is still running, so it re-checks the
deadline after its reads and before its first write and aborts; Firestore commits nothing. Measured
through the real publisher: **0 rows when the publish returns at 5007ms, 0 after the registry
recovers.**

**A stalled commit → at most one transaction's rows land, late.** By then the callback has returned and
the commit is with the server. There is no callback left to re-check and no client-side way to cancel a
submitted commit, so this case cannot be made to land nothing. Measured: **0 rows at the deadline, 2
rows (one object's id row and key row) once the commit completes** — against 76 for an unbounded run.

So the guarantee is **bounded abandonment plus idempotent correctness**, not literal zero:

- nothing further is *started* once the deadline fires — verified by transaction count, not inferred;
- at most the one already-committing transaction lands;
- what it lands is the **correct canonical id** — identical to what an ordinary preserve would have
  written. Never wrong, only late. (On la_musa this is checkable independently: the late row carries
  the grandfathered slug.)
- the next publish or backfill calls `ensureIdentity` for that object, **finds the row and preserves
  it** (`created: false`) — no double-mint, no divergence. Measured: the reconciling backfill creates
  the 37 objects the deadline abandoned and preserves exactly the 1 that landed late.

🔴 **Never delete registry rows to "clean up" a late lander.** A late row is correct; deleting it is
not. Retired ids stay reserved permanently, and a registry that deletes rows to tidy a timeout is one
that can hand a reused id to a different object later. Leave it; the next backfill reconciles around
it.

Nothing in D1 reads the id, and at D4 the registry — not any publish's report — is the source of truth,
so a late-but-correct row is harmless in both phases.

What remains: a publish that introduces a NEW object while the registry is slow leaves that object
unregistered until the next publish or a backfill re-run. It serves id-less in the meantime, which is
inert in D1. It stops being inert at D4.
