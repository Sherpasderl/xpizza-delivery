# customer-app-native: the Capacitor project of the Sherpa customer app

PLAN-capp-native-shell §1 (APPROVED) · BUILD-ORDER-capp-native-shell N4.

**One source.** The app is the SAME `customer-app/` code. `www/` is GENERATED from a named commit:

    npm run package -- <sha>     # node ../platform/native/package-capp.js --out www --sha <sha>
    npm run verify  -- <sha>     # any drift between www/ and that commit ⇒ exit 1

Nothing in `www/` is ever edited by hand or committed. The driver app's hand-copied `www/` shipped stale builds; this project
exists so that can't happen.

## OWNER-PENDING (nothing here is final until the owner confirms)

- **Bundle id / package name `hn.sherpa.app`.** Proposed (the driver app is `hn.sherpa.driver`). It can't change after the first
  store upload. `npx cap add ios` / `android` waits for it.
- **Display name «Sherpa».**
- **Signing, store listings, the icon and splash** (a mockup first): see BUILD-ORDER O1–O5.

## Not yet created (they need the owner bundle id + Xcode/CocoaPods/Gradle, in a slot)

- `ios/` and `android/` (`npx cap add ios`, `npx cap add android`). On creation, `native-assets/ios/PrivacyInfo.xcprivacy` is
  copied to `ios/App/App/` and added to the App target. That's the Apple privacy manifest for Preferences (UserDefaults, CA92.1).
  Its presence in the RELEASE archive is an N6 gate.

## Dark mode / launch frames at `cap add` (PLAN-capp-dark-mode §4, APPROVED)

Every frame before the JS runs is a native resource. Right after `npx cap add android` / `ios` (and `npx cap sync`, which installs
`@capacitor/status-bar`), from the repo root:

    CHROME=/path/to/chrome node platform/native/render-brand-assets.mjs   # the brand PNGs (Chrome slot) — apply refuses without them
    node platform/native/apply-native-assets.js

It writes (sources in `native-assets/`; patches anchored on Capacitor 8.4.0's own template text, vendored + hashed in
`platform/native/vendor/capacitor-templates/` — a drifted template is refused):

- Android: `colors.xml` / `bools.xml` (values + values-night: `page_bg` = capp.css `--page-bg`, `splash_bg` = Celeste / Noche, the
  bars' icon contrast); `styles.xml` (the DayNight activity theme's window = `page_bg`; the Android 12+ splash background + mark);
  the splash marks (`drawable-xxxhdpi` / `drawable-night-xxxhdpi`); `MainActivity.java` (the WebView painted with `page_bg` in
  onCreate / onConfigurationChanged / onResume).
- iOS: the `PageBackground` / `SplashBackground` colour assets (Any / Dark); `ThemedBridgeViewController.swift` (add it to the App
  target in Xcode) set as Main.storyboard's bridge controller; the launch screen = the 104 pt mark (1x/2x/3x, light + dark) centred
  over `SplashBackground`. All-or-nothing: every destination is checked (template or already-applied bytes, inside the project, no
  symlinks) before anything is written.

The status bar's icon style follows the theme from the shell (CappTheme.barStyle → StatusBar.setStyle); its background is never set.
