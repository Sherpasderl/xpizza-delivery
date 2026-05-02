# X Pizza Delivery

Delivery operations platform for X Pizza Gastropub (San Pedro Sula, HN).

Built to replace Onfleet after the trial expired. Real production system handling the full pickup-to-delivery lifecycle — customer order intake, dispatcher assignment, driver navigation, push notifications, kitchen display sync, and delivery completion.

## Architecture

```
Customer order form (Netlify)
        ↓
Make.com scenario  ── writes to Google Sheet ─→  Kitchen Display (KDS)
        ↓                                                  ↑
Cloud Function: createOrder                                │
        ↓                                                  │
Firebase Realtime Database                                 │
        ↓                                                  │
Dispatcher console ── cancellation ─→ Cloud Function ──────┘
        ↓                                onOrderCancelled
Driver assigned
        ↓
Cloud Function: notifyDriverOnAssignment
        ↓ Web Push
Driver PWA (lock screen notification)
        ↓
Driver completes pickup → delivery
```

## Components

| Folder | What it is | Deployment |
|---|---|---|
| `xpizza-driver/` | Driver PWA — light theme for sunlight, slide-to-confirm actions, push notifications, GPS streaming | Netlify: `xpizzadriver.netlify.app` |
| `xpizza-dispatch/` | Dispatcher console — Onfleet-style sidebar, real-time order tracking, cancel/reassign actions | Netlify: `xpizzadispatch.netlify.app` |
| `xpizza-kitchen/` | Kitchen Display System — reads from Google Sheets, shows order cards in Nuevo/Preparación/Listo lanes, alerts on cancellations | Netlify: `xpizzakitchendisplay.netlify.app` |
| `xpizza-functions/` | Cloud Functions — `createOrder` (Make webhook), `notifyDriverOnAssignment` (push trigger), `onOrderCancelled` (KDS sync) | `firebase deploy --only functions` |
| `xpizza-reference/` | Schema docs, Firebase security rules, SDK source, test harness — not deployed but useful reference | n/a |
| `VERSION.md` | Changelog for everything | n/a |

## Stack

- **Frontend:** Vanilla HTML/JS/CSS (no build step). PWA manifests for installable apps.
- **Backend:** Firebase Realtime Database (data), Cloud Functions Gen 2 (event triggers + HTTPS), Web Push (driver notifications)
- **Integrations:** Make.com (order intake from form), UltraMsg (customer WhatsApp confirmations), Google Sheets (kitchen display backing store)
- **Hosting:** Netlify (apps), Firebase (functions)

## Local development

Most components are static HTML — no build, just open the files locally with a static server:

```bash
cd xpizza-driver/      # or xpizza-dispatch, xpizza-kitchen
python3 -m http.server 8000
# visit http://localhost:8000
```

For Cloud Functions:

```bash
cd xpizza-functions
npm install
firebase emulators:start --only functions    # local emulator
# or
npm run deploy                                 # deploy to production
```

## Deployment

**Frontends (auto-deploy):** Push to `main` triggers Netlify rebuilds for the connected sites. Each site is configured to deploy from a specific subfolder.

**Cloud Functions (manual):** Run `npm run deploy` from `xpizza-functions/`. Requires Firebase CLI authenticated to the `xpizza-delivery` project.

## Secrets

Never commit `.env` files. Required env vars for `xpizza-functions/.env`:

- `MAKE_SECRET` — bearer token Make.com uses to call `createOrder`
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` — Web Push keys for driver notifications
- `KDS_SHEET_ID` / `KDS_SHEET_NAME` — Google Sheet target for cancellation sync

See `xpizza-functions/.env.example` for the full template.

The `VAPID_PUBLIC_KEY` also has to be pasted into `xpizza-driver/index.html` (it's not a secret — public keys are safe in client code, but they need to match the private key on the server).

## See also

- `VERSION.md` — full changelog of releases
- `xpizza-functions/README.md` — deployment guide for Cloud Functions
- `xpizza-functions/PUSH_SETUP.md` — VAPID + push notification setup steps
- `xpizza-reference/SCHEMA.md` — Firebase RTDB data model
- `xpizza-reference/database.rules.json` — Firebase security rules
