'use strict';
// PLAN-capp-native-shell §1.2 / §1.3 (BUILD-ORDER N3) — the native shell packager, run on THIS commit (HEAD):
//   1. the stamp is read back by the REAL sherpa-client readIdentity (the packaged shell is never inert) — native id, compat
//   2. it packages EXACTLY shell.html's files + the boot + the generated config + the vendored SDK + fonts/licence + its manifest
//   3. the CSP is the plan's text, every origin named, no wildcard; a STATIC scan finds every origin the packaged code names in
//      the matching directive (one documented exemption: capp-auth-firebase's web SDK default, overridden by the boot's loadSdk)
//   4. the SDK rewrite (exactly one import) and the generated runtime (flags dark unless named; no note)
//   5. refusals: no native id / no compat / no runtime / a tampered vendor file / an unknown flag ⇒ packaging FAILS
//   6. --verify: exact ⇒ []; one byte, an extra file, a missing file ⇒ named drift; pack refuses a non-empty --out
// Key values are never printed. Run: node platform/native/package-capp.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('./package-capp');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ROOT = path.join(__dirname, '..', '..');
const { JSDOM } = require(path.join(ROOT, 'xpizza-functions', 'node_modules', 'jsdom'));
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const show = (rel) => execFileSync('git', ['show', `${HEAD}:${rel}`], { cwd: ROOT, maxBuffer: 1 << 28 });
const SITES = JSON.parse(show('platform/sites.json')), COMPAT = JSON.parse(show('platform/compat.json'));
const DEP = SITES.deployments.find((d) => d.app === 'orders' && d.context === 'platform');
const LOCK = JSON.parse(show('platform/native/vendor/firebasejs.lock.json'));
const B = P.build({ sha: HEAD });
const txt = (rel) => B.files.get(rel).toString('utf8');

// 1. the stamp, through the real reader
{
  const mod = { exports: {} }; new Function('module', 'exports', txt('sherpa-client.js'))(mod, mod.exports);   // the PACKAGED module
  const SC = mod.exports;
  const doc = new JSDOM(txt(P.ENTRY)).window.document;
  const id = SC.readIdentity(doc);
  assert.ok(id, '🔴 the packaged shell is INERT (readIdentity === null)');
  assert.deepStrictEqual([id.app, id.deployment, id.context, id.compat, id.env], ['orders', DEP.native.deployment, 'platform', COMPAT.generations.orders, 'native']);
  assert.strictEqual(id.build, B.manifest.build); assert.match(id.build, /^[0-9a-f]{20}$/);
  assert.ok(sha256Of(txt('sherpa-client.js')) === sha256Of(show('customer-app/sherpa-client.js').toString('utf8')), 'the shared module is the committed copy');
  ok(`the packaged shell is stamped: readIdentity → orders / ${id.deployment} / platform, compat ${id.compat} (compat.json), env native, build = the content hash`);
}
function sha256Of(s) { return require('crypto').createHash('sha256').update(s).digest('hex'); }

// 2. exactly the shell's files
{
  const web = show('customer-app/shell.html').toString('utf8');
  const { scripts, sheets, assets } = P.shellFiles(web, (r) => show(`customer-app/${r}`).toString('utf8'));
  assert.strictEqual(P.ENTRY, 'index.html', 'Capacitor\'s entry'); assert.ok(!B.files.has('shell.html'), 'the shell is packaged AS index.html (one file)');
  const want = [...scripts, ...sheets, ...assets, 'capp-native-boot.js', 'capp-native-config.js', P.ENTRY, 'native-manifest.json',
    ...Object.keys(LOCK.files).map((f) => `vendor/firebasejs/${LOCK.version}/${f}`)].sort();
  assert.deepStrictEqual([...B.files.keys()].sort(), want);
  for (const k of B.files.keys()) assert.ok(!/\.test\.|fixtures\/|MOCKUP|netlify\.toml|node_modules/.test(k), `🔴 not runtime: ${k}`);
  assert.ok(!/capp-shell-ui\.js/.test(show('customer-app/index.html').toString('utf8')) && /<script src="capp-shell-ui\.js">/.test(txt(P.ENTRY)), 'the entry is the SHELL (it loads capp-shell-ui.js), never the web single-store index.html');
  assert.ok(assets.includes('fonts/OFL.txt') && assets.filter((a) => a.endsWith('.woff2')).length === 4, 'the four fonts and their licence');
  for (const f of [...scripts, ...sheets, ...assets, 'capp-native-boot.js']) assert.ok(B.files.get(f).equals(show(`customer-app/${f}`)), `${f} is byte-identical to the committed source`);
  const s = txt(P.ENTRY);
  assert.strictEqual(s.replace(/<!-- sherpa-stamp:begin -->[\s\S]*?<!-- sherpa-stamp:end -->\n/, '').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n/, '').replace('<script src="capp-native-config.js"></script>\n<script src="capp-native-boot.js"></script>\n', ''), web, 'the packaged shell = the web shell + ONLY the stamp, the CSP and the two boot scripts');
  assert.ok(s.indexOf('Content-Security-Policy') < s.indexOf('<script'), 'the CSP precedes every script');
  ok(`exactly ${want.length} files: shell.html's ${scripts.length} scripts + ${sheets.length} stylesheets + ${assets.length} font assets, the boot, the config, the 2 SDK files, the manifest — all byte-identical to the commit; www/index.html = the web shell.html + stamp + CSP + boot only`);
}

// 3. the CSP and the static origin scan
{
  const rt = DEP.runtime, rtdb = new URL(rt.availability_base).host;
  const web = show('customer-app/shell.html').toString('utf8'), blocks = [...web.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  assert.strictEqual(blocks.length, 1, 'premise: the web shell has one fixed <style> block');
  const HASH = `sha256-${require('crypto').createHash('sha256').update(blocks[0][1], 'utf8').digest('base64')}`;
  const PLAN = `default-src 'self'; script-src 'self' https://maps.googleapis.com; connect-src 'self' ${rt.functions_base} ${rt.availability_base} wss://${rtdb} https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://maps.googleapis.com; img-src 'self' data: https://maps.googleapis.com https://storage.googleapis.com; font-src 'self'; style-src 'self' '${HASH}'; style-src-attr 'unsafe-inline'; frame-src 'none'`;
  assert.strictEqual(B.csp, PLAN, '🔴 the CSP differs from plan §1.2 (+ Codex r1 #3)');
  assert.ok(!B.csp.includes('*'), 'no wildcard'); assert.ok(txt(P.ENTRY).includes(`content="${PLAN}"`));
  const styleSrc = B.csp.split('; ').find((d) => d.startsWith('style-src '));
  assert.ok(!styleSrc.includes('unsafe-inline'), '🔴 style-src must not allow unsafe-inline (only style-src-attr does)'); assert.strictEqual(B.styleHash, HASH);
  assert.ok(txt(P.ENTRY).includes(`<style>${blocks[0][1]}</style>`), 'the hashed block is packaged byte-identical');
  const dir = Object.fromEntries(B.csp.split('; ').map((d) => { const [k, ...v] = d.split(' '); return [k, v]; }));
  const allowed = new Set([...dir['connect-src'], ...dir['script-src'], ...dir['img-src']].filter((x) => /^(https|wss):/.test(x)));
  const EXEMPT = { 'capp-auth-firebase.js': ['https://www.gstatic.com'] };   // the WEB default SDK; the boot always passes loadSdk
  assert.match(txt('capp-native-boot.js'), /loadSdk: \(\) => Promise\.all\(\[importModule\(`\$\{sdk\}firebase-app\.js`\)/, 'premise of the exemption: the boot overrides the SDK loader');
  const misses = [];
  for (const [f, b] of B.files) {
    if (f.startsWith('vendor/') || !/\.(js|css|html)$/.test(f)) continue;
    for (const m of b.toString('utf8').matchAll(/\b(https|wss):\/\/[a-z0-9.-]+\.[a-z]{2,}/gi)) {
      const o = m[0]; if (allowed.has(o) || (EXEMPT[f] || []).includes(o)) continue; misses.push(`${f}: ${o}`);
    }
  }
  assert.deepStrictEqual(misses, [], '🔴 the packaged code names an origin the CSP does not allow');
  ok('the CSP is plan §1.2 (every origin named, no wildcard, frame-src none) with style-src = self + the shell <style>\'s sha256 — NO unsafe-inline — and style-src-attr unsafe-inline for the attributes; first in <head>; every origin the packaged code names is allowed (one documented exemption)');
}

// 4. the SDK rewrite and the generated runtime
{
  const auth = txt(`vendor/firebasejs/${LOCK.version}/firebase-auth.js`);
  assert.strictEqual(auth.split('from"./firebase-app.js"').length - 1, 1, 'the one import rewritten'); assert.ok(!auth.includes(`from"${LOCK.source}`), '🔴 a gstatic import left in the bundle');
  assert.ok(B.files.get(`vendor/firebasejs/${LOCK.version}/firebase-app.js`).equals(show(`platform/native/vendor/firebasejs/${LOCK.version}/firebase-app.js`)));
  const cfg = txt('capp-native-config.js'); const sb = {}; new Function('self', cfg)(sb);
  const R = sb.CAPP_NATIVE_RUNTIME;
  assert.ok(Object.isFrozen(R) && !('note' in R)); assert.deepStrictEqual(R.flags, {}); assert.strictEqual(R.sdk_base, `./vendor/firebasejs/${LOCK.version}/`);
  for (const k of Object.keys(DEP.runtime).filter((k) => k !== 'note')) assert.ok(JSON.stringify(R[k]) === JSON.stringify(DEP.runtime[k]), `the runtime's ${k} is the manifest's`);
  const F = P.build({ sha: HEAD, flags: ['signup', 'intlPhone'] }); const sf = {}; new Function('self', F.files.get('capp-native-config.js').toString('utf8'))(sf);
  assert.deepStrictEqual(sf.CAPP_NATIVE_RUNTIME.flags, { signup: true, intlPhone: true }); assert.deepStrictEqual(F.manifest.flags, ['intlPhone', 'signup']);
  assert.notStrictEqual(F.manifest.build, B.manifest.build, 'a different flag set is a different build');
  ok('firebase-auth\'s one gstatic import → ./firebase-app.js (firebase-app byte-identical); the runtime = the manifest block minus its note + sdk_base; flags dark unless named; a flag set changes the build id');
}

// 5. refusals
{
  const over = (edits) => (rel) => (rel in edits ? Buffer.from(typeof edits[rel] === 'string' ? edits[rel] : JSON.stringify(edits[rel])) : show(rel));
  const sitesWith = (mut) => { const c = JSON.parse(JSON.stringify(SITES)); mut(c.deployments.find((d) => d.app === 'orders' && d.context === 'platform')); return c; };
  const refuse = (opts, re) => assert.throws(() => P.build({ sha: HEAD, ...opts }), re);
  refuse({ show: over({ 'platform/sites.json': sitesWith((d) => { delete d.native; }) }) }, /no native deployment id — refusing to ship an inert build/);
  refuse({ show: over({ 'platform/sites.json': sitesWith((d) => { delete d.runtime; }) }) }, /no app runtime block/);
  for (const k of ['functions_base', 'menu_endpoint', 'availability_base', 'intake_key', 'maps_key', 'firebase', 'note'])
    refuse({ show: over({ 'platform/sites.json': sitesWith((d) => { delete d.runtime[k]; }) }) }, /is invalid — .*runtime must be exactly/);
  refuse({ show: over({ 'platform/sites.json': sitesWith((d) => { d.runtime.functions_base = 'http://x.test'; }) }) }, /is invalid — .*functions_base must be an exact https origin/);
  refuse({ show: over({ 'platform/sites.json': sitesWith((d) => { d.runtime.firebase = { apiKey: 'k' }; }) }) }, /is invalid — .*runtime\.firebase must be exactly/);
  refuse({ show: over({ 'customer-app/shell.html': show('customer-app/shell.html').toString('utf8').replace('</head>', '<style>x{}</style></head>') }) }, /exactly one <style> block/);
  refuse({ show: over({ 'platform/compat.json': { schema: 1, generations: {} } }) }, /no compat generation .* inert/);
  refuse({ show: over({ [`platform/native/vendor/firebasejs/${LOCK.version}/firebase-app.js`]: 'tampered' }) }, /does not match its lock/);
  refuse({ show: over({ 'customer-app/shell.html': show('customer-app/shell.html').toString('utf8').replace('<script src="capp-ui.js"></script>', '<script src="https://cdn.example/x.js"></script>') }) }, /non-local or nested file/);
  refuse({ flags: ['payments'] }, /unknown flag payments/);
  refuse({ sha: 'not-a-sha' }, /--sha must be a commit/);
  ok('refused: no native id / no runtime / any one runtime key missing / a malformed base / an incomplete firebase config / no compat generation (never an inert build), a second <style> block, a tampered vendored file, a remote script in shell.html, an unknown flag, a non-commit');
}

// 6. --verify and pack
{
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'capp-native-test-'));
  try {
    const m = P.pack({ sha: HEAD, out: path.join(out, 'www') });
    assert.deepStrictEqual(P.verify(path.join(out, 'www'), B), []); assert.strictEqual(m.build, B.manifest.build, 'deterministic: two builds of one commit agree');
    const f = path.join(out, 'www', 'capp-ui.js'); fs.appendFileSync(f, ' ');
    fs.writeFileSync(path.join(out, 'www', 'stray.js'), 'x'); fs.rmSync(path.join(out, 'www', 'capp.css'));
    assert.deepStrictEqual(P.verify(path.join(out, 'www'), B).sort(), ['differs capp-ui.js', 'extra stray.js', 'missing capp.css']);
    assert.throws(() => P.pack({ sha: HEAD, out: path.join(out, 'www') }), /not empty — refusing to mix builds/);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
  ok('pack writes the build (deterministic per commit); --verify names a changed byte, an extra file and a missing file; pack refuses a non-empty --out');
}
// 7. the LAUNCH path: Capacitor opens www/index.html — the packaged entry, its own scripts in its own order, reaches the shell
{
  const page = txt(P.ENTRY);
  const srcs = [...page.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepStrictEqual(srcs.slice(-3), ['capp-shell-ui.js', 'capp-native-config.js', 'capp-native-boot.js'], 'the boot runs last, after the config');
  for (const f of srcs) assert.ok(B.files.has(f), `index.html loads a packaged file: ${f}`);
  const dom = new JSDOM(page.replace(/<script src="[^"]+"><\/script>/g, '').replace(/<link [^>]+>/g, ''), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'capacitor://localhost/index.html' });
  const w = dom.window; let requests = 0;
  w.fetch = () => { requests++; return new Promise(() => {}); }; w.setInterval = () => 0;
  for (const f of srcs) w.eval(txt(f));
  assert.ok(w.CAPP_NATIVE_RUNTIME && w.CappNativeBoot && w.CappNativeBoot.instance, '🔴 the packaged entry did not boot the shell');
  assert.ok(w.document.querySelector('.tabbar'), 'the shell painted from www/index.html');
  w.close();
  ok('www/index.html (the entry Capacitor loads) runs its packaged scripts in order — the config, then the boot — and paints the shell');
}
console.log(`package-capp: OK (${n})`);
