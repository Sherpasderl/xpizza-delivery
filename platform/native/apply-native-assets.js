'use strict';
// PLAN-capp-dark-mode §4 (APPROVED) — the native resources every pre-JS frame needs, applied ONCE onto the projects `npx cap add`
// generates (the slot that waits for the owner bundle id). The sources live in customer-app-native/native-assets/; the edits are
// exact anchors on Capacitor 8.4.0's own template text (vendored + hashed in vendor/capacitor-templates/).
// ALL-OR-NOTHING (Codex dark r1 #3/#4): every destination is PREFLIGHTED before any byte is written — a file this step edits or
// replaces must be EXACTLY the template's bytes or this step's own applied bytes (anything else = drift ⇒ refused, nothing written);
// a file `cap add` does not create must be absent or already ours; every destination resolves (realpath) INSIDE the native project
// and is never a symlink. Idempotent: a second run finds every file already applied and rewrites the same bytes.
//   node platform/native/apply-native-assets.js            (after `npx cap add android` / `ios`, from the repo root)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..'), PROJ = path.join(ROOT, 'customer-app-native'), SRC = path.join(PROJ, 'native-assets');
const BRAND = path.join(SRC, 'brand'), TPL = path.join(__dirname, 'vendor', 'capacitor-templates', '8.4.0');
const fail = (m) => { const e = new Error(`apply-native-assets: ${m}`); e.code = 'refused'; throw e; };
const tpl = (f) => fs.readFileSync(path.join(TPL, f), 'utf8');
const once = (src, anchor, repl, what) => {
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
const validAppId = (appId) => { if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(appId)) fail(`appId ${appId}`); return appId; };
function mainActivity(appId) { return fs.readFileSync(path.join(SRC, 'android', 'java', 'MainActivity.java.tmpl'), 'utf8').replace('__PACKAGE__', validAppId(appId)); }
// what `cap add` writes: the template's MainActivity with ITS package (the only accepted original besides ours)
const generatedMainActivity = (appId) => tpl('android/MainActivity.java').replace('package com.getcapacitor.myapp;', `package ${validAppId(appId)};`);
// ── iOS: the bridge controller paints PageBackground; the launch screen is the approved mark (104 pt, centred, its own size —
// Codex dark r1 #1) over the SplashBackground colour (Celeste / Noche) ──
function patchStoryboard(xml) {
  return once(xml, 'customClass="CAPBridgeViewController" customModule="Capacitor"', 'customClass="ThemedBridgeViewController" customModule="App" customModuleProvider="target"', 'Main.storyboard bridge controller');
}
const hexRgb = (h) => [1, 3, 5].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3));
function patchLaunchScreen(xml) {
  const [r, g, b] = hexRgb(require('./brand-assets.js').COLORS.splash_background);
  let s = once(xml, 'contentMode="scaleAspectFill"', 'contentMode="center"', 'LaunchScreen image mode');
  s = once(s, '<color key="backgroundColor" systemColor="systemBackgroundColor"/>', '<color key="backgroundColor" name="SplashBackground"/>', 'LaunchScreen background');
  s = once(s, '<image name="Splash" width="1366" height="1366"/>', `<image name="Splash" width="104" height="104"/>
        <namedColor name="SplashBackground">
            <color red="${r}" green="${g}" blue="${b}" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>
        </namedColor>`, 'LaunchScreen resources');
  return s;
}
const MARKS = { light: ['splash-mark-light-104.png', 'splash-mark-light-208.png', 'splash-mark-light-312.png'], dark: ['splash-mark-dark-104.png', 'splash-mark-dark-208.png', 'splash-mark-dark-312.png'] };
function splashContents() {
  const img = (filename, scale, dark) => ({ idiom: 'universal', filename, scale, ...(dark ? { appearances: [{ appearance: 'luminosity', value: 'dark' }] } : {}) });
  return { images: [...MARKS.light.map((f, i) => img(f, `${i + 1}x`, false)), ...MARKS.dark.map((f, i) => img(f, `${i + 1}x`, true))], info: { version: 1, author: 'xcode' } };
}
const TEMPLATE_SPLASH_PNGS = ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'];

// the plan — every step names the bytes it may find there before it runs:
//   { rel, edit: (cur) => next, accept: [original bytes] }   an edit of a generated file (cur must be an accepted original or ours)
//   { rel, put: content }                                     a file cap add does not create (absent, or already ours)
//   { rel, remove: true }                                     a template file the new set replaces (absent, or any bytes)
function planFor({ appId, android, ios, png }) {
  const out = [], need = (f) => { const p = path.join(BRAND, f); if (!fs.existsSync(p)) fail(`${f} missing — render the brand PNGs first (platform/native/render-brand-assets.mjs, the Chrome slot)`); return fs.readFileSync(p); };
  if (android) {
    const res = 'android/app/src/main/res';
    for (const d of ['values', 'values-night']) for (const f of ['colors.xml', 'bools.xml']) out.push({ rel: `${res}/${d}/${f}`, put: fs.readFileSync(path.join(SRC, 'android', 'res', d, f)) });
    out.push({ rel: `${res}/values/styles.xml`, edit: patchStyles, accept: [tpl('android/styles.xml')] });
    if (png) out.push({ rel: `${res}/drawable-xxxhdpi/splash_icon.png`, put: need('android-splash-icon-light-960.png') }, { rel: `${res}/drawable-night-xxxhdpi/splash_icon.png`, put: need('android-splash-icon-dark-960.png') });
    out.push({ rel: `android/app/src/main/java/${validAppId(appId).split('.').join('/')}/MainActivity.java`, edit: () => mainActivity(appId), accept: [generatedMainActivity(appId)] });
  }
  if (ios) {
    const app = 'ios/App/App';
    out.push({ rel: `${app}/ThemedBridgeViewController.swift`, put: fs.readFileSync(path.join(SRC, 'ios', 'App', 'ThemedBridgeViewController.swift')) });
    for (const c of ['PageBackground', 'SplashBackground']) out.push({ rel: `${app}/Assets.xcassets/${c}.colorset/Contents.json`, put: fs.readFileSync(path.join(SRC, 'ios', 'App', 'Assets.xcassets', `${c}.colorset`, 'Contents.json')) });
    out.push({ rel: `${app}/Base.lproj/Main.storyboard`, edit: patchStoryboard, accept: [tpl('ios/Main.storyboard')] });
    for (const f of TEMPLATE_SPLASH_PNGS) out.push({ rel: `${app}/Assets.xcassets/Splash.imageset/${f}`, remove: true });
    out.push({ rel: `${app}/Base.lproj/LaunchScreen.storyboard`, edit: patchLaunchScreen, accept: [tpl('ios/LaunchScreen.storyboard')] });
    out.push({ rel: `${app}/Assets.xcassets/Splash.imageset/Contents.json`, edit: () => JSON.stringify(splashContents(), null, 2) + '\n', accept: [tpl('ios/Splash.imageset.Contents.json')] });
    if (png) for (const f of [...MARKS.light, ...MARKS.dark]) out.push({ rel: `${app}/Assets.xcassets/Splash.imageset/${f}`, put: need(f.replace(/\.png$/, '.png')) });
  }
  return out;
}
const same = (a, b) => Buffer.compare(Buffer.isBuffer(a) ? a : Buffer.from(a), Buffer.isBuffer(b) ? b : Buffer.from(b)) === 0;
// the destination stays INSIDE the project: its nearest existing ancestor's real path is under the project's real path, and an
// existing destination is never a symlink (Codex dark r1 #4)
function contained(dir, p) {
  const root = fs.realpathSync(dir);
  let a = p; while (!fs.existsSync(a)) a = path.dirname(a);
  const real = fs.realpathSync(a);
  if (real !== root && !real.startsWith(root + path.sep)) fail(`${path.relative(dir, p)} resolves outside the native project (${real})`);
  if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) fail(`${path.relative(dir, p)} is a symlink`);
}
function apply(dir, opts) {
  const steps = planFor(opts), writes = [];
  for (const st of steps) {   // PREFLIGHT — nothing is written until every step is known safe
    const p = path.join(dir, st.rel); contained(dir, p);
    const cur = fs.existsSync(p) ? fs.readFileSync(p) : null;
    if (st.remove) { if (cur !== null) writes.push({ st, p, del: true }); continue; }
    if (st.edit) {
      if (cur === null) fail(`${st.rel} absent — run \`npx cap add\` first`);
      const orig = st.accept.find((a) => same(cur, a));
      const next = orig !== undefined ? st.edit(orig) : st.accept.map((a) => st.edit(a)).find((applied) => same(cur, applied));
      if (next === undefined) fail(`${st.rel}: neither Capacitor's template nor this step's applied version (drift) — review it by hand`);
      writes.push({ st, p, next }); continue;
    }
    if (cur !== null && !same(cur, st.put)) fail(`${st.rel} exists with other content — review it by hand`);
    writes.push({ st, p, next: st.put });
  }
  for (const w of writes) { if (w.del) fs.rmSync(w.p); else { fs.mkdirSync(path.dirname(w.p), { recursive: true }); fs.writeFileSync(w.p, w.next); } }
  return writes.map((w) => (w.del ? `- ${w.st.rel}` : w.st.rel));
}

module.exports = { patchStyles, patchStoryboard, patchLaunchScreen, mainActivity, generatedMainActivity, splashContents, planFor, apply, MARKS };

if (require.main === module) {
  const cfg = JSON.parse(fs.readFileSync(path.join(PROJ, 'capacitor.config.json'), 'utf8'));
  const android = fs.existsSync(path.join(PROJ, 'android')), ios = fs.existsSync(path.join(PROJ, 'ios'));
  if (!android && !ios) { console.error('apply-native-assets: neither android/ nor ios/ exists — run `npx cap add` first'); process.exit(1); }
  try { for (const f of apply(PROJ, { appId: cfg.appId, android, ios, png: true })) console.log(`  ✓ ${f}`); }
  catch (e) { console.error(e.message); process.exit(1); }
}
