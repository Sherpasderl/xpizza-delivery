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
