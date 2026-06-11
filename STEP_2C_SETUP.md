# Step 2c — Transistorsoft background GPS: setup runbook

Everything that doesn't need the license is **already prepped** (inert until the
plugin is installed). This is the runbook for when the key lands. See
SHERPA_DRIVER_PLAN.md (items 18–21) and ADR 0003.

## What's already done (in the repo / native project)
- **Endpoint accepts ISO timestamps** — `ingestDriverLocation` coerces `ts`
  (Transistorsoft sends ISO; curl sends epoch). `driver-ingest.coerceTs`, tested.
  **⚠️ Needs a redeploy** (`npm run deploy` in xpizza-functions) for the live
  endpoint to handle ISO — do this before the device test.
- **`xpizza-driver/native-location.js`** — Transistorsoft config + the
  start/stop wiring (mint token via `startDriverShift` → `ready()` → `start()`;
  `stop()` → `endDriverShift`). Posts to the **run.app** ingest URL with the
  token in the **`X-Driver-Token`** header, batched as `{ locations: [...] }`.
- **Driver app wired** (`index.html`): native clock-in → `startNativeTracking`
  (no watchPosition, no wake-lock); native clock-out → `stopNativeTracking`;
  `startGpsStream()` is a no-op on native (Transistorsoft is the sole source).
- **Manifest** (`android/app/src/main/AndroidManifest.xml`): added
  `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`.

## 0. License (the only hard blocker — you)
- Get the 3 written confirmations (one key = one app id; perpetual use after the
  update window; key only useful in an app integrating the plugin).
- Buy **STARTER ($399)**, register the key to **`hn.sherpa.driver`**, save the key.

## 1. Install the plugin (you run; in ~/Projects/sherpa-driver-app)
```
npm install @transistorsoft/capacitor-background-geolocation
```
Then the plugin's licensed-Gradle setup (per Transistorsoft's install docs):
- add the **license key** to `android/app/src/main/AndroidManifest.xml` as the
  `com.transistorsoft.locationmanager.license` meta-data (the plugin's docs give
  the exact snippet), and
- the Transistorsoft **maven repo** in `android/build.gradle` (the plugin's
  `cap sync` usually injects this; confirm).
```
rsync the driver folder → www/    # already current; re-run after any web edit
npx cap sync
```

## 2. Plugin access for a non-bundled app — RESOLVED (verify on device)
Verified against the plugin source: it registers via
`registerPlugin('BackgroundGeolocation')`, so its native methods are on
`window.Capacitor.Plugins.BackgroundGeolocation` — `getBgGeo()` uses that, no
bundler needed (same pattern as the working push-notifications integration). The
methods we use (ready/start/stop) are thin pass-throughs to native; the wrapper's
JS-only logic (onLocation/onHttp sugar, JWT-auth) is unused here. On-device,
just confirm `getBgGeo().ready(...)`/`.start()` resolve. If debug event listeners
are wanted: `BackgroundGeolocation.addListener('http'|'location', cb)` on the
bridge global, or drop the plugin's compiled `dist` JS into `www/` and import it.

## 3. Verify the POST shape
`native-location.js` uses `httpRootProperty: 'locations'` + a `locationTemplate`
to emit `{ locations: [ { ts(ISO), lat, lng, accuracy, heading, speed } ] }`.
After install, capture one real POST (Transistorsoft debug log or the function
log) and confirm it matches what `ingestDriverLocation` expects.

## 4. Build + the real-device matrix (you)
`JAVA_HOME=… npx cap run android`, then on actual low-end fleet hardware
(Xiaomi/Samsung/generic):
- [ ] Grant **"Allow all the time"** location + accept the foreground-service notice.
- [ ] **Backgrounded + force-killed** → pin keeps moving on dispatch through a full delivery.
- [ ] **Offline → reconnect** → queued points replay in order (endpoint drops stale).
- [ ] **>16h shift** (token TTL) → re-clock-in mints a fresh token cleanly.
- [ ] **OEM battery-killer allow-listing** — the per-vendor "don't kill" settings.
- [ ] Dispatcher sees a live, fresh pin the whole time.

## Notes
- Credential is **Candidate B** (opaque per-shift token, 16h TTL, **no refresh**) —
  it sidesteps the WebView-throttle-on-refresh trap entirely, so Candidate A's
  native-JWT-refresh machinery isn't needed for the pilot.
- FCM push (Step 2a) and Transistorsoft coexist — both native, independent.
- App Check / Play Integrity on the ingest endpoint is the pre-fleet-rollout gate
  (before scaling past the 3 pilot drivers), not a Step 2c item.
