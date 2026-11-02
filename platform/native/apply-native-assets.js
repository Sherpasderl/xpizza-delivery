'use strict';
// PLAN-capp-dark-mode §4 (APPROVED) — the native resources every pre-JS frame needs, applied ONCE onto the projects `npx cap add`
// generates (the slot that waits for the owner bundle id). The sources live in customer-app-native/native-assets/; the patches are
// exact anchors on Capacitor 8.4.0's own template text (vendored + hashed in vendor/capacitor-templates/) — a drifted template is
// REFUSED, never patched by guess. Idempotent: an already-applied file is left as it is.
//   node platform/native/apply-native-assets.js            (after `npx cap add android` / `ios`, from the repo root)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..'), PROJ = path.join(ROOT, 'customer-app-native'), SRC = path.join(PROJ, 'native-assets');
const BRAND = path.join(SRC, 'brand');
const fail = (m) => { const e = new Error(`apply-native-assets: ${m}`); e.code = 'refused'; throw e; };
const once = (src, anchor, repl, what) => {
  if (src.includes(repl)) return src;   // applied already
  const n = src.split(anchor).length - 1;
  if (n !== 1) fail(`${what}: the template anchor occurs ${n}× (expected once) — Capacitor's template changed; re-vendor and review`);
  return src.replace(anchor, repl);
};

// ── Android: the launch theme (Android 12+ splash: Celeste / Noche + the mark), the app theme (window = page_bg, DayNight kept,
// the bars' icons from values-night) ──
function patchStyles(xml) {
  let s = once(xml, '<resources>', '<resources xmlns:tools="http://schemas.android.com/tools">', 'styles.xml <resources>');
  s = once(s, `        <item name="android:background">@null</item>
    </style>`, `        <item name="android:background">@null</item>
        <item name="android:windowBackground">@color/page_bg</item>
        <item name="android:windowLightStatusBar">@bool/light_bars</item>
        <item name="android:windowLightNavigationBar" tools:targetApi="27">@bool/light_bars</item>
    </style>`, 'styles.xml AppTheme.NoActionBar');
  s = once(s, `        <item name="android:background">@drawable/splash</item>
    </style>`, `        <item name="android:background">@drawable/splash</item>
        <item name="windowSplashScreenBackground">@color/splash_bg</item>
        <item name="windowSplashScreenAnimatedIcon">@drawable/splash_icon</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
    </style>`, 'styles.xml AppTheme.NoActionBarLaunch');
  return s;
}
function mainActivity(appId) {
  if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(appId)) fail(`appId ${appId}`);
  return fs.readFileSync(path.join(SRC, 'android', 'java', 'MainActivity.java.tmpl'), 'utf8').replace('__PACKAGE__', appId);
}
// ── iOS: the bridge controller paints PageBackground; the launch image is the derived splash, light + dark appearances ──
function patchStoryboard(xml) {
  return once(xml, 'customClass="CAPBridgeViewController" customModule="Capacitor"', 'customClass="ThemedBridgeViewController" customModule="App" customModuleProvider="target"', 'Main.storyboard bridge controller');
}
const SPLASH_FILES = { light: ['splash-2732x2732-2.png', 'splash-2732x2732-1.png', 'splash-2732x2732.png'], dark: ['splash-dark-2732x2732-2.png', 'splash-dark-2732x2732-1.png', 'splash-dark-2732x2732.png'] };
function splashContents() {
  const img = (filename, scale, dark) => ({ idiom: 'universal', filename, scale, ...(dark ? { appearances: [{ appearance: 'luminosity', value: 'dark' }] } : {}) });
  return { images: [...SPLASH_FILES.light.map((f, i) => img(f, `${i + 1}x`, false)), ...SPLASH_FILES.dark.map((f, i) => img(f, `${i + 1}x`, true))], info: { version: 1, author: 'xcode' } };
}

// the plan: [target relative to the project, content (string | Buffer) | (current) => content]
function planFor({ appId, android, ios, png }) {
  const out = [];
  const need = (f) => { const p = path.join(BRAND, f); if (!fs.existsSync(p)) fail(`${f} missing — render the brand PNGs first (platform/native/render-brand-assets.mjs, the Chrome slot)`); return p; };
  if (android) {
    const res = 'android/app/src/main/res';
    for (const d of ['values', 'values-night']) for (const f of ['colors.xml', 'bools.xml']) out.push([`${res}/${d}/${f}`, fs.readFileSync(path.join(SRC, 'android', 'res', d, f))]);
    out.push([`${res}/values/styles.xml`, (cur) => patchStyles(cur)]);
    out.push([`${res}/drawable-xxxhdpi/splash_icon.png`, png ? fs.readFileSync(need('android-splash-icon-light-960.png')) : null]);
    out.push([`${res}/drawable-night-xxxhdpi/splash_icon.png`, png ? fs.readFileSync(need('android-splash-icon-dark-960.png')) : null]);
    out.push([`android/app/src/main/java/${appId.split('.').join('/')}/MainActivity.java`, mainActivity(appId)]);
  }
  if (ios) {
    const app = 'ios/App/App';
    out.push([`${app}/ThemedBridgeViewController.swift`, fs.readFileSync(path.join(SRC, 'ios', 'App', 'ThemedBridgeViewController.swift'))]);
    for (const c of ['PageBackground', 'SplashBackground']) out.push([`${app}/Assets.xcassets/${c}.colorset/Contents.json`, fs.readFileSync(path.join(SRC, 'ios', 'App', 'Assets.xcassets', `${c}.colorset`, 'Contents.json'))]);
    out.push([`${app}/Base.lproj/Main.storyboard`, (cur) => patchStoryboard(cur)]);
    out.push([`${app}/Assets.xcassets/Splash.imageset/Contents.json`, JSON.stringify(splashContents(), null, 2) + '\n']);
    for (const [k, files] of Object.entries(SPLASH_FILES)) for (const f of files) out.push([`${app}/Assets.xcassets/Splash.imageset/${f}`, png ? fs.readFileSync(need(k === 'light' ? 'splash-2732.png' : 'splash-dark-2732.png')) : null]);
  }
  return out.filter(([, c]) => c !== null);
}
function apply(dir, opts) {
  const done = [];
  for (const [rel, c] of planFor(opts)) {
    const p = path.join(dir, rel);
    const next = typeof c === 'function' ? c(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : fail(`${rel} absent — run \`npx cap add\` first`)) : c;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, next); done.push(rel);
  }
  return done;
}

module.exports = { patchStyles, patchStoryboard, mainActivity, splashContents, planFor, apply, SPLASH_FILES };

if (require.main === module) {
  const cfg = JSON.parse(fs.readFileSync(path.join(PROJ, 'capacitor.config.json'), 'utf8'));
  const android = fs.existsSync(path.join(PROJ, 'android')), ios = fs.existsSync(path.join(PROJ, 'ios'));
  if (!android && !ios) { console.error('apply-native-assets: neither android/ nor ios/ exists — run `npx cap add` first'); process.exit(1); }
  try { for (const f of apply(PROJ, { appId: cfg.appId, android, ios, png: true })) console.log(`  ✓ ${f}`); }
  catch (e) { console.error(e.message); process.exit(1); }
}
