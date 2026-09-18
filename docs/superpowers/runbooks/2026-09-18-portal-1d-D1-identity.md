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

npm run test:public-menu        # the endpoint, end to end → OK (7)
npm run test:identity-registry  # first-assignment serialization on the REAL engine → OK (5)
```

Both must be green before deploy. What each one covers:

| test | covers | does NOT cover |
|---|---|---|
| `test:public-menu` | the served endpoint against real Firestore, with D1's overlay step in the path | anything about identity — its "identity" fixtures are the RTDB **routing** config the isActive gate reads, unrelated to the catalog registry |
| `test:identity-registry` | concurrent `ensureIdentity` on one object against Firestore's own transaction engine: one id, one id row, one key row, retries genuinely forced | the no-op claim, which is node-side |

`npm test` (no Java needed) carries the rest: 2238 checks, including the no-op matrix across both
brands and every forced failure path.

## Sequence

1. **Deploy functions** — `firebase deploy --only functions --project xpizza-delivery`.
   D1 is inert on arrival: the registry is empty, so the overlay resolves nothing and every served
   record goes out id-less. That is byte-identical to today's menu. Nothing is switched on by
   deploying; the backfill below is what starts minting.

2. **Backfill, one brand at a time**, x_pizza first (fewer objects, and it is the minting path rather
   than the grandfathered one, so a surprise shows up on the smaller blast radius).
   The backfill is idempotent: a re-run preserves and mints nothing. It refuses loudly rather than
   registering part of a catalog — any record that yields no legacy key throws
   `identity_backfill_unkeyable` naming the kind, index and fields found. **If you see that, stop**:
   it means the catalog reader is emitting a shape the backfill cannot key, and a partial registration
   is exactly what the guard exists to prevent. Do not work around it.

   Expected first run: **x_pizza 24 dishes + 14 extras**, **la_musa 44 + 14**, all `created`.
   Expected re-run: the same totals, all `preserved`, zero `created`.

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

## What D1 deliberately does NOT do

Rewrite immutable version payloads, snapshots, mirrors or rollback to carry ids (served ids come from
the overlay instead); touch the delete/rename machinery; pair renames by id; or let any pricing, 86,
reward or factura selector read an id. All of that is D4/D5.

## Known gap, carried forward

`ensureIdentitiesForKeys` runs after the publish lease is released, bounded at 5s and abandoning
cleanly — but a publish that introduces a NEW object while the registry is slow leaves that object
unregistered until the next publish or a backfill re-run. It serves id-less in the meantime, which is
inert in D1. It stops being inert at D4.
