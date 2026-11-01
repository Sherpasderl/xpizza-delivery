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
assert.match(pkg.scripts.package, /^node \.\.\/platform\/native\/package-capp\.js --out www --sha$/); assert.match(pkg.scripts.verify, /--verify/);
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
console.log(`native-project: OK (${n})`);
