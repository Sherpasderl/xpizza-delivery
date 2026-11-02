'use strict';
// PLAN-capp-native-shell §1.2 (BUILD-ORDER N4 partial) — the Capacitor project is configured for ONE source and carries the
// Apple privacy manifest Preferences needs. Static only (no `cap add`, no Xcode). Run: node platform/native/native-project.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ROOT = path.join(__dirname, '..', '..'), P = path.join(ROOT, 'customer-app-native');
const cfg = JSON.parse(fs.readFileSync(path.join(P, 'capacitor.config.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(P, 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(P, 'README.md'), 'utf8');

assert.deepStrictEqual(Object.keys(cfg).sort(), ['appId', 'appName', 'webDir']);
assert.strictEqual(cfg.webDir, 'www'); assert.match(cfg.appId, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/);
assert.ok(readme.includes('## OWNER-PENDING') && readme.includes(`\`${cfg.appId}\``), '🔴 the bundle id must stay marked OWNER-PENDING until the owner confirms');
assert.ok(!(cfg.server && 'appStartPath' in cfg.server), 'the start path is Capacitor\'s default /index.html — the packaged shell (appStartPath would APPEND a path)');
assert.strictEqual(require('./package-capp').ENTRY, 'index.html', 'the packager writes the entry Capacitor starts at');
ok(`capacitor.config: webDir www, appId ${cfg.appId} (OWNER-PENDING in the README), no extra keys; the start = the default /index.html = the packaged shell`);

const ign = fs.readFileSync(path.join(P, '.gitignore'), 'utf8').split('\n');
assert.ok(ign.includes('www/'), '🔴 www/ must never be committed (it is generated)');
assert.match(pkg.scripts.package, /^node \.\.\/platform\/native\/package-capp\.js --target native --env production --out www --sha$/); assert.match(pkg.scripts.verify, /--target native --env production .*--verify/);
const sites = JSON.parse(fs.readFileSync(path.join(ROOT, 'platform', 'sites.json'), 'utf8'));
assert.ok(!sites.deployments.some((d) => d.folder === 'customer-app-native'), 'not a Netlify site folder');
ok('www/ is gitignored and only ever written by the packager (npm run package / verify); the project is not a deployed site');

const deps = pkg.dependencies, CORE = ['@capacitor/core', '@capacitor/cli', '@capacitor/ios', '@capacitor/android'];
for (const [k, v] of Object.entries(deps)) assert.match(v, /^\d+\.\d+\.\d+$/, `${k} is pinned EXACTLY (no range)`);
assert.ok(CORE.every((k) => deps[k] === deps['@capacitor/core']), 'core / cli / ios / android on one version');
assert.ok(deps['@capacitor/preferences'] && deps['@capacitor/preferences'].split('.')[0] === deps['@capacitor/core'].split('.')[0], 'Preferences on the same major');
ok(`Capacitor ${deps['@capacitor/core']} (core/cli/ios/android, exact) + Preferences ${deps['@capacitor/preferences']}`);

const pi = fs.readFileSync(path.join(P, 'native-assets', 'ios', 'PrivacyInfo.xcprivacy'), 'utf8');
assert.match(pi, /<key>NSPrivacyAccessedAPIType<\/key>\s*<string>NSPrivacyAccessedAPICategoryUserDefaults<\/string>\s*<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>\s*<string>CA92\.1<\/string>\s*<\/array>/);
assert.match(pi, /<key>NSPrivacyTracking<\/key>\s*<false\/>/);
ok('the Apple privacy manifest declares UserDefaults with reason CA92.1 (Preferences), no tracking');
// ── PLAN-capp-dark-mode §4: the native resources for every pre-JS frame (applied at `cap add` by apply-native-assets.js) ──
const crypto = require('crypto'), os = require('os');
const A = require('./apply-native-assets.js');
const VT = path.join(__dirname, 'vendor', 'capacitor-templates'), TL = JSON.parse(fs.readFileSync(path.join(__dirname, 'vendor', 'capacitor-templates.lock.json'), 'utf8'));
assert.strictEqual(TL.version, deps['@capacitor/cli'], '🔴 the vendored templates are the pinned Capacitor CLI\'s');
for (const [f, m] of Object.entries(TL.files)) assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(path.join(VT, TL.version, f))).digest('hex'), m.sha256, `🔴 ${f} drifted from the lock (vendored, never edited)`);
const T = (f) => fs.readFileSync(path.join(VT, TL.version, f), 'utf8');
ok(`the Capacitor ${TL.version} template files the apply step patches are vendored byte-for-byte (sha256 lock, ${Object.keys(TL.files).length} files)`);

const NA = path.join(P, 'native-assets'), CSS = fs.readFileSync(path.join(ROOT, 'customer-app', 'capp.css'), 'utf8');
const pageBg = { light: (CSS.match(/:root\{--page-bg:(#[0-9A-F]{6})\}/) || [])[1], dark: (CSS.match(/:root\[data-theme="dark"\]\{--page-bg:(#[0-9A-F]{6})\}/) || [])[1] };
assert.ok(pageBg.light && pageBg.dark, 'premise: capp.css --page-bg, light + dark');
const BA = require('./brand-assets.js');
const colorOf = (d, name) => (fs.readFileSync(path.join(NA, 'android', 'res', d, 'colors.xml'), 'utf8').match(new RegExp(`<color name="${name}">(#[0-9A-F]{6})</color>`)) || [])[1];
assert.deepStrictEqual([colorOf('values', 'page_bg'), colorOf('values-night', 'page_bg')], [pageBg.light, pageBg.dark], '🔴 Android page_bg = capp.css --page-bg (values / values-night)');
assert.deepStrictEqual([colorOf('values', 'splash_bg'), colorOf('values-night', 'splash_bg')], [BA.COLORS.splash_background, BA.COLORS.splash_background_night], '🔴 Android splash = Celeste / Noche (the approved table, brand-assets)');
const boolOf = (d) => (fs.readFileSync(path.join(NA, 'android', 'res', d, 'bools.xml'), 'utf8').match(/<bool name="light_bars">(true|false)<\/bool>/) || [])[1];
assert.deepStrictEqual([boolOf('values'), boolOf('values-night')], ['true', 'false'], '🔴 the bars\' icons: dark on light, light on dark (values-night)');
ok('Android colours: page_bg = capp.css --page-bg and splash_bg = Celeste / Noche, each with its values-night pair; light_bars true / false');

const st = A.patchStyles(T('android/styles.xml'));
const styleOf = (name) => (st.match(new RegExp(`<style name="${name.replace(/\./g, '\\.')}" parent="([^"]+)">([\\s\\S]*?)</style>`)) || []);
const [, appParent, appBody] = styleOf('AppTheme.NoActionBar'), [, launchParent, launchBody] = styleOf('AppTheme.NoActionBarLaunch');
assert.strictEqual(appParent, 'Theme.AppCompat.DayNight.NoActionBar', '🔴 the activity theme stays DayNight (the WebView reads prefers-color-scheme from it)');
for (const it of ['<item name="android:windowBackground">@color/page_bg</item>', '<item name="android:windowLightStatusBar">@bool/light_bars</item>', '<item name="android:windowLightNavigationBar" tools:targetApi="27">@bool/light_bars</item>'])
  assert.ok(appBody.includes(it), `🔴 AppTheme.NoActionBar: ${it}`);
assert.strictEqual(launchParent, 'Theme.SplashScreen');
for (const it of ['<item name="windowSplashScreenBackground">@color/splash_bg</item>', '<item name="windowSplashScreenAnimatedIcon">@drawable/splash_icon</item>', '<item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>'])
  assert.ok(launchBody.includes(it), `🔴 the Android 12+ launch theme: ${it}`);
assert.ok(!/forceDark|ForceDark/.test(st), 'no algorithmic darkening (we declare color-scheme)');
assert.strictEqual(A.patchStyles(st), st, 'idempotent');
assert.throws(() => A.patchStyles(T('android/styles.xml').replace('<item name="android:background">@null</item>', '')), /anchor occurs 0×/, '🔴 a drifted template is REFUSED, never patched by guess');
assert.ok(/android:configChanges="[^"]*\buiMode\b/.test(T('android/AndroidManifest.xml')), '🔴 the template keeps uiMode in configChanges (a theme switch reaches onConfigurationChanged)');
ok('styles.xml (the real 8.4.0 template, patched): DayNight kept, window = page_bg, the bars from values-night, the 12+ splash Celeste / Noche + the mark; idempotent; a drifted template refused; the manifest keeps uiMode');

const ma = A.mainActivity(cfg.appId);
assert.ok(ma.startsWith(`package ${cfg.appId};`) && /class MainActivity extends BridgeActivity/.test(ma));
const bodyOf = (m) => (ma.match(new RegExp(`public void ${m}\\([^)]*\\) \\{([\\s\\S]*?)\\n    \\}`)) || [])[1] || '';
for (const m of ['onCreate', 'onConfigurationChanged', 'onResume']) { const b = bodyOf(m); assert.ok(/super\.\w+\(/.test(b) && b.indexOf('paintWebView();') > b.indexOf('super.'), `🔴 MainActivity.${m}: super first, then the WebView painted`); }
assert.ok(/getBridge\(\)\.getWebView\(\)\.setBackgroundColor\(ContextCompat\.getColor\(this, R\.color\.page_bg\)\)/.test(ma), '🔴 the WebView gets the THEME\'s page colour (R.color.page_bg, through values-night)');
assert.throws(() => A.mainActivity('Bad Id'), /appId/);
ok('MainActivity (the bundle id\'s package): the WebView painted with R.color.page_bg in onCreate, onConfigurationChanged and onResume — after super');

const csOf = (c) => JSON.parse(fs.readFileSync(path.join(NA, 'ios', 'App', 'Assets.xcassets', `${c}.colorset`, 'Contents.json'), 'utf8')).colors;
const hex = (e) => '#' + ['red', 'green', 'blue'].map((k) => e.color.components[k].slice(2)).join('').toUpperCase();
for (const [c, want] of [['PageBackground', pageBg], ['SplashBackground', { light: BA.COLORS.splash_background, dark: BA.COLORS.splash_background_night }]]) {
  const cs = csOf(c), any = cs.find((e) => !e.appearances), dark = cs.find((e) => e.appearances && e.appearances.some((a) => a.appearance === 'luminosity' && a.value === 'dark'));
  assert.deepStrictEqual([cs.length, hex(any), hex(dark)], [2, want.light, want.dark], `🔴 iOS ${c}: Any / Dark`);
}
const sw = fs.readFileSync(path.join(NA, 'ios', 'App', 'ThemedBridgeViewController.swift'), 'utf8');
assert.ok(/class ThemedBridgeViewController: CAPBridgeViewController/.test(sw) && /UIColor\(named: "PageBackground"\)/.test(sw) && /webView\?\.backgroundColor = bg/.test(sw) && /view\.backgroundColor = bg/.test(sw), '🔴 the iOS bridge controller paints PageBackground on the view + web view');
const sb = A.patchStoryboard(T('ios/Main.storyboard'));
assert.ok(sb.includes('customClass="ThemedBridgeViewController" customModule="App" customModuleProvider="target"') && !sb.includes('customClass="CAPBridgeViewController"'), '🔴 Main.storyboard uses the themed controller');
const sc = A.splashContents();
assert.deepStrictEqual([sc.images.filter((i) => !i.appearances).length, sc.images.filter((i) => i.appearances).length], [3, 3], 'the launch image: light + dark, 1x/2x/3x');
ok('iOS: PageBackground (= --page-bg) and SplashBackground (Celeste / Noche) Any/Dark; the themed bridge controller set in Main.storyboard; the launch image light + dark');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capp-native-'));
try {
  const put = (rel, src) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, src); };
  assert.throws(() => A.apply(tmp, { appId: cfg.appId, android: true, ios: false, png: false }), /absent — run `npx cap add` first/, '🔴 nothing is applied onto a project that does not exist');
  put('android/app/src/main/res/values/styles.xml', T('android/styles.xml')); put('ios/App/App/Base.lproj/Main.storyboard', T('ios/Main.storyboard'));
  const done = A.apply(tmp, { appId: cfg.appId, android: true, ios: true, png: false });
  assert.ok(done.includes(`android/app/src/main/java/${cfg.appId.split('.').join('/')}/MainActivity.java`) && done.includes('ios/App/App/ThemedBridgeViewController.swift'));
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'android/app/src/main/res/values/styles.xml'), 'utf8'), st, 'the applied styles = the patch of the real template');
  const again = A.apply(tmp, { appId: cfg.appId, android: true, ios: true, png: false });
  assert.deepStrictEqual(again, done, 'a second run rewrites the same set (idempotent)');
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'android/app/src/main/res/values/styles.xml'), 'utf8'), st, 'and the same bytes');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
assert.strictEqual(deps['@capacitor/status-bar'] && deps['@capacitor/status-bar'].split('.')[0], deps['@capacitor/core'].split('.')[0], '🔴 @capacitor/status-bar on the core\'s major (style only — §4)');
ok('apply() onto a scratch copy of the REAL template layout: refused before `cap add`, then every resource written, idempotent; @capacitor/status-bar pinned on the core major');
console.log(`native-project: OK (${n})`);
