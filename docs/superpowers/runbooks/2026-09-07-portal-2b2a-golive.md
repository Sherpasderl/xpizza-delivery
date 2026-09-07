# Runbook — Portal 2b-2a go-live (merchant portal: shell + auth + read-only menu)

**Owner-run. The branch is local-only and audited; nothing has been pushed or deployed.**

At the end of this, a merchant **owner** logs into a new Netlify site and sees their live menu, read-only.
This slice **writes nothing to the catalog**. The only new write anywhere is the ownership index, and
only the admin `seed-owner` tool can make it.

---

## 0. The two things that will bite, if anything does

Both are allowlists, both are invisible until they fail, and each fails in a way that looks like
something else. Do them in the order below and neither bites.

| Allowlist | Where | Symptom if missed |
|---|---|---|
| **CORS** — the portal's origin | `PORTAL_ORIGINS` in `xpizza-functions/index.js` (**code** → needs a functions redeploy) | Every menu load fails. The portal shows *"No pudimos cargar tu menú… probá de nuevo"* — it reads as an outage, not a config gap. |
| **API-key referrer** — the portal's domain | GCP Console → APIs & Services → Credentials → the browser key | Nobody can log in at all. The failure happens inside the Firebase SDK, before any of our code runs, so the screen says only *"No pudimos iniciar sesión"*. |

`http://localhost:*` is already on both, so local development works today. Only the **new Netlify
domain** has to be added, and it does not exist until step 3.

---

## 1. Merge and deploy the functions

```bash
cd xpizza-functions
PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm test          # expect EXIT 0
firebase deploy --only functions:getMyRestaurants,functions:getEditableCatalog
```

Both are **new** functions — nothing existing changes behaviour. The only edit to a shipped file is the
new `PORTAL_ORIGINS` constant; `ACCOUNT_ORIGINS` and every endpoint using it are untouched.

**Rollback:** delete the two functions. Nothing else read or wrote through them.

---

## 2. Grant yourself ownership (the backfill)

The ownership index did not exist before this slice, so it is empty — including for you.

```bash
cd xpizza-functions
node tools/seed-owner.js --uid=<your-firebase-uid>                    # LIST (read-only) — expect "(nothing)"
node tools/seed-owner.js --rid=<restaurant> --uid=<your-firebase-uid> # GRANT, once per restaurant
node tools/seed-owner.js --uid=<your-firebase-uid>                    # LIST again — expect both restaurants
```

Your uid is in Firebase Console → Authentication → Users.

**This is required, not optional.** Until it runs, the portal shows you *"Tu cuenta no administra ningún
local todavía"* — and, since 2b-1, publishing for a platform-factura brand fails closed with
`not_owner`. Both are correct; both look like bugs if you have forgotten this step.

The grant writes both directions of the index in one atomic update. It is idempotent — re-running is
safe — and `--revoke` clears exactly the same two paths.

---

## 3. Create the Netlify site (first link only)

Per this repo's deploy mechanics every folder is its own site, and **the repo links to a different site
by default**, so always pass an explicit `--site`.

```bash
cd xpizza-portal
netlify sites:create --name sherpa-portal          # note the site ID it prints
netlify link --id <SITE_ID>
netlify deploy --prod --dir . --site <SITE_ID>
```

Record the site ID where this repo already tracks deployments — the deployment tracker and the local
`netlify link` state — not in `netlify.toml`. The toml is committed and shared; a site ID pinned there
is a value that silently disagrees with reality the moment a site is recreated. After the first link,
git-CD handles later deploys.

---

## 4. Add the new domain to BOTH allowlists

Now that the domain exists:

**a. CORS** — in `xpizza-functions/index.js`:

```js
const PORTAL_ORIGINS = [
  /^http:\/\/localhost(:\d+)?$/,
  'https://<your-portal-domain>',        // ← add
];
```

```bash
firebase deploy --only functions:getMyRestaurants,functions:getEditableCatalog
```

**b. Referrer** — GCP Console → Credentials → the browser API key → *Website restrictions* → add
`https://<your-portal-domain>/*`. Additive; do not remove what is there.

---

## 5. Smoke

| Check | Expected |
|---|---|
| Open the portal signed out | The login gate. No menu frame flashes first. |
| Wrong password | *"Correo o contraseña incorrectos."* — the same sentence whether or not the address exists. |
| Sign in as the seeded owner | The shell, with the switcher naming your restaurants. |
| The menu | Your real categories and prices, **read-only** — no editable fields anywhere. |
| Prices | Match what a customer sees today. A price that is not a positive integer reads *"Sin precio"*, never *"L0"*. |
| Switcher | Exactly the restaurants you granted in step 2 — no more. |
| A customer account | `getMyRestaurants` → empty list; `getEditableCatalog` → 403. |
| A dispatcher account (not an owner) | 403 `not_owner`. Dispatchers can edit through internal tooling; the tenant-facing portal is owner-only. |
| A second merchant, config only | Renders identically with no code change — the brand-agnostic proof. |
| Reload | The session persists. |

**Stop and roll back if:** any editable field appears, a price differs from the customer-facing menu, or
the switcher lists a restaurant you did not grant.

---

## 6. What is NOT in this slice

Editing, publishing, and instant-86 are 2b-2b/c/d. The portal is read-only: there is no write path from
this UI to the catalog, and `catalog/portal-reads.js` is asserted to contain no write call of any kind.

### Known gap, recorded

The item key strategy is still hardcoded (`rid === 'la_musa' ? id : name`). Read-only 2b-2a is
unaffected — the read validates against the rid it authorized — but it must move to per-merchant config
**before** the write slices, and it is why a source document only validates under a restaurant whose
keying convention matches.
