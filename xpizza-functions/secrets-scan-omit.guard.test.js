// CP2 release fix — Netlify SECRETS SCANNING vs the sites' PUBLIC client keys.
// Run: node xpizza-functions/secrets-scan-omit.guard.test.js
//
// Netlify runs secrets scanning only on a site with a build command. CP2 gave every git-CD site one (the stamp), and the
// smart detection then failed the builds on the AIza… values already committed in their JS: the Firebase web config and
// the Google Maps key, both public client keys (xpizzaorders deploy 6ac5aca5a59f2d0008ff8890: "AIza*** detected as a likely
// secret … account.js line 12"). Each site's netlify.toml therefore lists EXACTLY those values in
// [build.environment] SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES, and scanning stays ON for everything else.
//
// SCOPE = PER FOLDER (measured, not assumed): that log says "41 file(s) scanned". xpizza-orders has exactly 40 tracked
// files, +1 = the generated version.json; the repo has 1,156. So the scan covers the site's own base/publish folder, and a
// key that lives only in ANOTHER folder can never fail this site. Each list must therefore be exactly the AIza values
// present in that folder — no missing value (the build would fail) and nothing extra (a stale value would quietly widen
// the omission).
//
// Asserted, for every manifest deployment whose netlify.toml has a build command (the condition under which Netlify scans):
//   1. the omit list = exactly the set of AIza… values in the folder's tracked files (the toml itself excluded);
//   2. no toml anywhere turns scanning off or narrows it by path/key (SECRETS_SCAN_ENABLED, …_SMART_DETECTION_ENABLED,
//      SECRETS_SCAN_OMIT_PATHS, SECRETS_SCAN_OMIT_KEYS);
//   3. the one exception is listed with its reason and is re-checked to still hold.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCOPE = 'per-folder';   // see the header: measured from the deploy log
const KEY_RE = /AIza[0-9A-Za-z_-]{35}/g;
const ONE_KEY = /^AIza[0-9A-Za-z_-]{35}$/;
const SETTING = 'SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES';
// xpizza-portal is deployed by hand with `netlify deploy --build` (owner action, PLAN Q4). That CLI build runs on the
// owner's machine, where Netlify's scanner does not run — the r3 portal deploy went live with the Firebase key in the
// folder. Its netlify.toml is also under the portal SITE FREEZE (a non-JS byte change needs the AA review), so it is not
// edited in this config-only fix. If the portal ever moves to git CD, this exception must go (the test then fails until
// its toml lists the key).
const EXCEPTIONS = { 'xpizza-portal': 'manual `netlify deploy --build` (no Netlify-side scan); toml under the portal site freeze' };

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const tracked = (folder) => execFileSync('git', ['ls-files', '--', folder], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const keysIn = (files) => {
  const s = new Set();
  for (const f of files) for (const m of fs.readFileSync(path.join(ROOT, f), 'latin1').matchAll(KEY_RE)) s.add(m[0]);
  return [...s].sort();
};
// the [build] table's command, and the omit setting inside [build.environment] (the only places these keys are read)
function readToml(folder) {
  const p = path.join(ROOT, folder, 'netlify.toml');
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8');
  const tables = {}; let cur = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const h = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (h) { cur = h[1].trim(); tables[cur] = tables[cur] || {}; continue; }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"$/.exec(line);
    if (kv) (tables[cur] = tables[cur] || {})[kv[1]] = kv[2];
  }
  return { text, tables };
}
const mask = (k) => `${k.slice(0, 8)}…${k.slice(-4)}`;

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'platform/sites.json'), 'utf8'));
const folders = [...new Set(manifest.deployments.map((d) => d.folder))];
assert.strictEqual(SCOPE, 'per-folder');

// 1. each scanned site's omit list = exactly its folder's AIza values
let scanned = 0, withKeys = 0; const summary = [];
for (const folder of folders) {
  const t = readToml(folder);
  const command = t && t.tables.build && t.tables.build.command;
  if (!command) continue;                                   // no build command → Netlify does not scan this site
  scanned += 1;
  const present = keysIn(tracked(folder).filter((f) => f !== `${folder}/netlify.toml`));
  const env = t.tables['build.environment'] || {};
  const listed = env[SETTING] === undefined ? [] : env[SETTING].split(',').map((s) => s.trim()).filter(Boolean);
  if (EXCEPTIONS[folder]) {
    assert.ok(present.length > 0 && listed.length === 0, `${folder}: exception still describes reality (keys present, none listed) — else drop it`);
    summary.push(`${folder}: EXCEPTION (${EXCEPTIONS[folder]})`);
    continue;
  }
  assert.strictEqual(new Set(listed).size, listed.length, `${folder}: duplicate values in ${SETTING}`);
  for (const k of listed) assert.ok(ONE_KEY.test(k), `${folder}: ${mask(k)} is not an AIza… value — only public client keys may be omitted`);
  assert.deepStrictEqual([...listed].sort(), present, `${folder}: ${SETTING} must be EXACTLY the AIza values in the folder — present [${present.map(mask)}], listed [${listed.map(mask)}]`);
  if (present.length) withKeys += 1;
  summary.push(`${folder}: ${present.length ? present.map(mask).join(' + ') : 'no keys, no list'}`);
}
assert.ok(scanned >= 8 && withKeys >= 7, `non-vacuity: ${scanned} scanned sites, ${withKeys} with keys`);
ok(`every scanned site's ${SETTING} = exactly its folder's AIza values (${scanned} folders): ${summary.join('; ')}`);

// 2. scanning is never switched off or narrowed — in ANY toml in the repo
const tomls = execFileSync('git', ['ls-files', '*netlify.toml'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
for (const f of tomls) {
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const bad of ['SECRETS_SCAN_ENABLED', 'SECRETS_SCAN_SMART_DETECTION_ENABLED', 'SECRETS_SCAN_OMIT_PATHS', 'SECRETS_SCAN_OMIT_KEYS']) {
    assert.ok(!new RegExp(`\\b${bad}\\b`).test(text), `${f}: ${bad} would disable or narrow secrets scanning — real secrets must still fail a build`);
  }
}
ok(`no netlify.toml (${tomls.length}) disables scanning or omits by path/key`);

// 3. non-vacuity: the detector and the comparison catch a missing, an extra and a non-key value
{
  const planted = 'const k = "AIzaSy' + 'X'.repeat(33) + '";';
  assert.deepStrictEqual(planted.match(KEY_RE), ['AIzaSy' + 'X'.repeat(33)]);
  const present = ['AIzaSyA' + '1'.repeat(32), 'AIzaSyB' + '2'.repeat(32)];
  assert.throws(() => assert.deepStrictEqual([present[0]], present), 'a missing value is caught');
  assert.throws(() => assert.deepStrictEqual([...present, 'AIzaSyC' + '3'.repeat(32)].sort(), present), 'an extra value is caught');
  const t = readToml('xpizza-kitchen');
  assert.ok(t.tables['build.environment'] && t.tables['build.environment'][SETTING], 'the parser reads the real setting');
  ok('non-vacuity: a planted key is detected; a missing or extra value fails the comparison; the real setting is parsed');
}
console.log(`secrets-scan-omit: OK (${n})`);
