#!/usr/bin/env node
'use strict';
// ── PLAN-capp-native-shell §1.2 / §1.3 (BUILD-ORDER N3) + PLAN-capp-desktop-website r2 D-1 — the shell packager, WEB and NATIVE ──
//
//   node platform/native/package-capp.js --target web|native --env <environment> --sha <commit> --out <dir> [--flags signup,…]
//   … the same + --verify     (re-derive; any drift ⇒ exit 1)
//
// ONE builder, two targets (D-1): the SAME files, CSP, SDK and boot (capp-boot.js); they differ ONLY in the stamp's deployment id
// (web = the platform orders deployment itself, e.g. orders-app; native = its declared native id, orders-app-native) and
// runtime.mode ('web' | 'native'). The environment is the DEPLOYMENT ENVIRONMENT (sherpa-env: 'production' for live builds —
// heartbeats and version checks run only there; Netlify passes its CONTEXT for previews) and is never used to mean web vs native
// (D-1, Codex P1-1). The web target also writes a /version.json that matches its stamp (stamp-version.js's own shape).
//
// ONE SOURCE: every file comes from git AT THE NAMED COMMIT (never the working tree, never a hand-copied www/ — the driver
// app's stale-www lesson). It packages EXACTLY what customer-app/shell.html loads (its scripts, stylesheets, the fonts those
// reference + their licence), the bootstrap (capp-boot.js), a generated capp-runtime.js (the platform orders
// deployment's `runtime` block from platform/sites.json + the build's flags; absent flag ⇒ dark) and the vendored Firebase SDK
// (platform/native/vendor, hash-checked against its lock; ONE asserted rewrite: firebase-auth's absolute gstatic import of
// firebase-app → ./firebase-app.js). The web customer-app/shell.html is packaged AS www/index.html — the entry Capacitor loads
// (its CLI requires webDir/index.html; the start path stays Capacitor's default /index.html, appStartPath unset — Codex N1-N4 r1
// #1) — one file, so the stamp and the CSP sit on the page that actually boots. Into that packaged copy only (the web file is
// untouched) it injects:
//   • the native CSP <meta> (plan §1.2: every origin named, no wildcard, frame-src 'none'; Codex r1 #3: style-src has NO
//     'unsafe-inline' — the shell's one fixed <style> block is allowed by its sha256, and the inline style ATTRIBUTES the shell
//     renders by style-src-attr 'unsafe-inline' only),
//   • the boot <script>s after capp-shell-ui.js,
//   • the identity stamp — the web stamp's OWN metaBlock / injectBlock / computeBuild (platform/stamp-version.js): app orders,
//     deployment = the manifest's native id, context platform, app-build = the content hash of the packaged runtime files,
//     app-compat = platform/compat.json's orders generation, sherpa-env native.
// A missing or invalid stamp input FAILS packaging (exit 1) — a native build never ships inert (§1.3). It writes
// <out>/build-manifest.json: { sha, deployment, build, compat, flags, sdk, files: { path: sha256 } }.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const Stamp = require('../stamp-version');

const ROOT = path.join(__dirname, '..', '..');
const APP = 'customer-app';
const FLAGS = ['signup', 'intlPhone', 'guestCardOnly', 'schedulingLive'];
const BOOT = ['capp-runtime.js', 'capp-boot.js'];
const TARGETS = ['web', 'native'];
const ENTRY = 'index.html';   // the packaged web shell.html (Capacitor's entry)
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/, BUILD_RE = /^[A-Za-z0-9._-]{1,80}$/;   // sherpa-client.js readIdentity's own rules
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function gitShow(sha, rel, root = ROOT) { return execFileSync('git', ['show', `${sha}:${rel}`], { cwd: root, maxBuffer: 1 << 28 }); }

// the plan §1.2 CSP, from the runtime DATA (no host literal here beyond Google's fixed API hosts the plan names)
function cspFor(rt, styleHash) {
  if (!/^sha256-[A-Za-z0-9+/]+=*$/.test(String(styleHash || ''))) throw new Error('the shell <style> hash is required for the CSP');
  const rtdb = new URL(rt.availability_base).host;
  const d = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", 'https://maps.googleapis.com']],
    ["connect-src", ["'self'", rt.functions_base, rt.availability_base, `wss://${rtdb}`, 'https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com', 'https://maps.googleapis.com']],
    ["img-src", ["'self'", 'data:', 'https://maps.googleapis.com', 'https://storage.googleapis.com']],
    ["font-src", ["'self'"]],
    ["style-src", ["'self'", `'${styleHash}'`]],
    ["style-src-attr", ["'unsafe-inline'"]],
    ["frame-src", ["'none'"]],
  ];
  return d.map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

// the files the web shell.html loads, in order — scripts and stylesheets — plus the font files (and licence) the CSS names
function shellFiles(shellHtml, readText) {
  const scripts = [...shellHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const sheets = [...shellHtml.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  for (const f of [...scripts, ...sheets]) if (!/^[a-z0-9-]+\.(js|css)$/.test(f)) throw new Error(`shell.html loads a non-local or nested file: ${f}`);
  const assets = new Set();
  for (const css of sheets) for (const m of readText(css).matchAll(/url\(([^)]+)\)/g)) {
    const u = m[1].replace(/^["']|["']$/g, '');
    if (/^(data:|https?:)/.test(u)) throw new Error(`${css} references a non-local asset: ${u}`);
    assets.add(u);
  }
  if ([...assets].some((a) => a.startsWith('fonts/'))) assets.add('fonts/OFL.txt');   // the fonts' licence travels with them
  return { scripts, sheets, assets: [...assets].sort() };
}

// `show(rel)` → Buffer reads a file AT the commit (default: git show); tests overlay edits on it, never on the repo
function build({ sha, flags = [], root = ROOT, show, target = 'native', env } = {}) {
  if (!TARGETS.includes(target)) throw new Error(`--target must be one of ${TARGETS.join(', ')}`);
  if (typeof env !== 'string' || !ID_RE.test(env)) throw new Error('--env is required (the deployment environment, e.g. production) — never guessed');
  if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('--sha must be a commit');
  const full = execFileSync('git', ['rev-parse', '--verify', `${sha}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  for (const f of flags) if (!FLAGS.includes(f)) throw new Error(`unknown flag ${f} (known: ${FLAGS.join(', ')})`);
  const S = typeof show === 'function' ? show : (rel) => gitShow(full, rel, root), T = (rel) => S(rel).toString('utf8');
  const sites = JSON.parse(T('platform/sites.json')), compat = JSON.parse(T('platform/compat.json'));
  const dep = sites.deployments.find((d) => d.app === 'orders' && d.context === 'platform');
  if (!dep || !dep.native || !ID_RE.test(String(dep.native.deployment || ''))) throw new Error('the manifest declares no native deployment id — refusing to ship an inert build');
  if (!dep.runtime) throw new Error('the manifest carries no app runtime block');
  // Codex r1 #2: the COMPLETE manifest — every runtime key, by type — through the functions' own validator (one source) before
  // anything is written; a missing or malformed functions_base / menu_endpoint / availability_base / intake_key / maps_key /
  // firebase fails packaging
  const errs = require('../../xpizza-functions/platform-manifest').validateManifest(sites);
  if (errs.length) throw new Error(`the manifest at ${full.slice(0, 12)} is invalid — ${errs.join('; ')}`);
  const gen = compat.generations && compat.generations[dep.app];
  if (!Number.isInteger(gen) || gen < 1) throw new Error('no compat generation for the orders app — refusing to ship an inert build');
  const lock = JSON.parse(T('platform/native/vendor/firebasejs.lock.json'));

  const files = new Map();   // packaged path → Buffer
  const readText = (rel) => T(`${APP}/${rel}`);
  const shell = readText('shell.html');
  const { scripts, sheets, assets } = shellFiles(shell, readText);
  for (const f of [...scripts, ...sheets, ...assets, 'capp-boot.js']) files.set(f, S(`${APP}/${f}`));

  // the vendored SDK: hash-checked, ONE asserted rewrite
  const sdkDir = `vendor/firebasejs/${lock.version}/`;
  for (const [f, h] of Object.entries(lock.files)) {
    let b = S(`platform/native/vendor/firebasejs/${lock.version}/${f}`);
    if (sha256(b) !== h) throw new Error(`vendored ${f} does not match its lock`);
    if (f === 'firebase-auth.js') {
      const anchor = `from"${lock.source}firebase-app.js"`, s = b.toString('utf8');
      if (s.split(anchor).length !== 2) throw new Error('the firebase-auth import anchor must occur exactly once');
      b = Buffer.from(s.replace(anchor, 'from"./firebase-app.js"'), 'utf8');
    }
    files.set(sdkDir + f, b);
  }

  // the runtime: the manifest block (minus its note) + the build's flags; the SDK base
  const { note: _note, ...rt } = dep.runtime;
  const runtime = { mode: target, ...rt, sdk_base: `./${sdkDir}`, flags: Object.fromEntries(flags.map((f) => [f, true])) };
  files.set('capp-runtime.js', Buffer.from(`// GENERATED by platform/native/package-capp.js at ${full} — never edit; the source is platform/sites.json (runtime)\nself.CAPP_RUNTIME = Object.freeze(${JSON.stringify(runtime)});\n`, 'utf8'));

  // the packaged shell.html: CSP first in <head>, the boot after the shell, then the identity stamp over the content hash
  let html = shell;
  const lastScript = '<script src="capp-shell-ui.js"></script>';
  if (html.split(lastScript).length !== 2) throw new Error('shell.html must load capp-shell-ui.js exactly once');
  html = html.replace(lastScript, `${lastScript}\n${BOOT.map((b) => `<script src="${b}"></script>`).join('\n')}`);
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  if (styles.length !== 1) throw new Error('shell.html must carry exactly one <style> block (its hash is in the CSP)');
  const styleHash = `sha256-${crypto.createHash('sha256').update(styles[0][1], 'utf8').digest('base64')}`;
  const csp = cspFor(rt, styleHash);
  const cspTag = `<meta http-equiv="Content-Security-Policy" content="${csp}">\n`;
  // D-4a §6 (web only): the site serves the shell at nested paths (/r/{rid}/plato/{id}), so every relative reference resolves from
  // the ROOT — <base> right after the charset, BEFORE every relative URL; native (capacitor://localhost/index.html) gets none
  const baseTag = target === 'web' ? '<base href="/">\n' : '';
  const cs = html.match(/<meta charset="utf-8">\n/);
  if (!cs) throw new Error('shell.html has no charset <meta>');
  html = html.slice(0, cs.index + cs[0].length) + baseTag + cspTag + html.slice(cs.index + cs[0].length);
  files.set(ENTRY, Buffer.from(html, 'utf8'));
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'capp-native-'));
  try {
    writeTree(tmp, files);
    const buildId = Stamp.computeBuild(tmp, [ENTRY]);
    const d = { app: dep.app, id: target === 'native' ? dep.native.deployment : dep.id, context: dep.context };
    if (!ID_RE.test(d.app) || !ID_RE.test(d.context) || !BUILD_RE.test(buildId)) throw new Error('stamp inputs invalid — refusing to ship an inert build');
    files.set(ENTRY, Buffer.from(Stamp.injectBlock(html, Stamp.metaBlock(d, buildId, gen, env)), 'utf8'));
    // the web deployment's /version.json — stamp-version.js's exact shape, the SAME build + compat as the stamp (sherpa-client
    // compares them); generated metadata is excluded from computeBuild, so writing it never moves the build id
    // D-4a §6: deep links serve the shell (non-forced: real files are served first)
    if (target === 'web') files.set('_redirects', Buffer.from('/* /index.html 200\n', 'utf8'));
    if (target === 'web') files.set('version.json', Buffer.from(`${JSON.stringify({ app: d.app, deployment: d.id, build: buildId, compat: gen, commit: full.slice(0, 64) })}\n`, 'utf8'));
    const manifest = { sha: full, target, env, deployment: d.id, build: buildId, compat: gen, flags: [...flags].sort(), sdk: lock.version,
      files: Object.fromEntries([...files.keys()].sort().map((k) => [k, sha256(files.get(k))])) };
    files.set('build-manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'));
    return { files, manifest, csp, styleHash };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function writeTree(out, files) {
  for (const [rel, b] of files) { const p = path.join(out, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); }
}
function listTree(dir, rel = '', acc = []) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) listTree(dir, r, acc); else acc.push(r); }
  return acc;
}
// → [] when <out> is EXACTLY the build, else the drift list
function verify(out, built) {
  const drift = [];
  const have = fs.existsSync(out) ? listTree(out).sort() : [];
  const want = [...built.files.keys()].sort();
  for (const r of want) if (!have.includes(r)) drift.push(`missing ${r}`); else if (!fs.readFileSync(path.join(out, r)).equals(built.files.get(r))) drift.push(`differs ${r}`);
  for (const r of have) if (!built.files.has(r)) drift.push(`extra ${r}`);
  return drift;
}
function pack({ sha, out, flags = [], root = ROOT, target, env } = {}) {
  if (!out) throw new Error('--out is required');
  const built = build({ sha, flags, root, target, env });
  if (fs.existsSync(out)) { const extra = listTree(out); if (extra.length) throw new Error(`--out ${out} is not empty — refusing to mix builds`); }
  writeTree(out, built.files);
  return built.manifest;
}

if (require.main === module) {
  const a = process.argv.slice(2), arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  try {
    const opts = { sha: arg('--sha'), out: arg('--out'), target: arg('--target'), env: arg('--env'), flags: (arg('--flags') || '').split(',').filter(Boolean) };
    if (!opts.target) throw new Error('--target web|native is required');
    if (a.includes('--verify')) {
      const drift = verify(opts.out, build(opts));
      if (drift.length) { console.error(`package-capp --verify: DRIFT\n  ${drift.join('\n  ')}`); process.exit(1); }
      console.log(`package-capp --verify: ${opts.out} is exactly the build of ${opts.sha}`);
    } else { const m = pack(opts); console.log(`package-capp: ${m.target} ${m.deployment} (${m.env}) build ${m.build} compat ${m.compat} sdk ${m.sdk} flags [${m.flags}] → ${opts.out} (${Object.keys(m.files).length} files)`); }
  } catch (e) { console.error(`package-capp: FAILED — ${e.message}`); process.exit(1); }
}
module.exports = { build, pack, verify, cspFor, shellFiles, FLAGS, ENTRY, TARGETS };
