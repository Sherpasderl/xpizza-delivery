# X Pizza Estadísticas (Dashboard)

Read-only operational dashboard for X. Pizza delivery operations. Lives at
**xpizzadashboard.netlify.app**.

## Purpose

Two zones in one screen:

- **HOY (live, today-only)** — health-check during a shift. Auto-refreshes
  every few seconds. Shows: today's order counts, pipeline state, driver
  status, prep/delivery times, hourly volume.

- **REVISIÓN (date-range, comparative)** — performance review across any
  date range (today, yesterday, last 7d, last 30d, custom). Shows: KPIs
  with previous-period comparison, day-of-week × hour-of-day heatmap,
  driver leaderboard.

## Tech stack

- Static HTML + ES module JS (no framework)
- Hand-rolled SVG charts (matches dispatcher design language)
- Firebase Auth + Realtime Database via `xpizza-delivery.js` SDK
- PWA-installable (manifest + sw.js)

## Auth

Same Firebase Auth as dispatcher — dispatcher email/password works here.
Read access to `/orders` and `/drivers` is granted to any authenticated
user via existing Realtime Database rules. No new rules needed.

## Time handling

All time math is done in Honduras local time (UTC-6, no DST). The
`hondurasMidnight()` helper takes a Date and returns the timestamp of
that day's midnight in Honduras.

## Files

- `index.html` — entire UI + JS
- `xpizza-delivery.js` — SDK (synced from xpizza-dispatch)
- `manifest.json`, `sw.js`, `icon.svg` — PWA assets
- `netlify.toml` — deploy config

## Deploy

Auto-deploys from git push to `main`. Netlify site connected to
`Sherpasderl/xpizza-delivery` repo, base directory `xpizza-dashboard/`.

## Versioning

Visible in topbar and footer. Bump in two places per release:
- `<!-- X Pizza Dashboard - version: X.Y.Z -->` at top of index.html
- `const SYSTEM_VERSION = 'X.Y.Z';` in script block
