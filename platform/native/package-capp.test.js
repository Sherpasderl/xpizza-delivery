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
const LOCK = JSON.parse(show('platform/native/vendor/sdk-lock.json'));
// F2: the dish-photo hosts as the PUBLISHERS' rules produce them (never the packager's own photoOrigins — a guard on two rebuilt
// sides hides a loss): each manifest brand's order-site base (public-photos assetBaseFor) + the public bucket (photos/ publicUrl)
const { assetBaseFor, buildPhotos } = require(path.join(ROOT, 'xpizza-functions/catalog/public-photos'));
const { publicUrl } = require(path.join(ROOT, 'xpizza-functions/photos/editable-photos'));
const PHOTO_RIDS = [...new Set(SITES.deployments.filter((d) => d.app === 'orders' && d.context !== 'platform').map((d) => d.context))];
const PHOTO_HOSTS = [...new Set([...PHOTO_RIDS.map((rid) => assetBaseFor(rid, SITES)).filter(Boolean).map((b) => new URL(b).origin), new URL(publicUrl('bucket', 'rid', 'pid', 'card')).origin])].sort();
// the APP-TRAIN obligation (below): with 3a's capp-guest server in THIS commit, every real build carries guestCardOnly — so the
// baseline builds here name it too (the packager refuses them otherwise); with the server absent, the baseline is flag-free
const GUEST = 'xpizza-functions/checkout-guest-gate.js';
const GUEST_PRESENT = (() => { try { show(GUEST); return true; } catch (_) { return false; } })();
const BASE_FLAGS = GUEST_PRESENT ? ['guestCardOnly'] : [], on = (fl) => Object.fromEntries(fl.map((f) => [f, true]));
const NAT = { target: 'native', env: 'production', flags: BASE_FLAGS }, WEB = { target: 'web', env: 'production', flags: BASE_FLAGS };
const B = P.build({ sha: HEAD, ...NAT });
const txt = (rel) => B.files.get(rel).toString('utf8');

// 1. the stamp, through the real reader
{
  const mod = { exports: {} }; new Function('module', 'exports', txt('sherpa-client.js'))(mod, mod.exports);   // the PACKAGED module
  const SC = mod.exports;
  const doc = new JSDOM(txt(P.ENTRY)).window.document;
  const id = SC.readIdentity(doc);
  assert.ok(id, '🔴 the packaged shell is INERT (readIdentity === null)');
  assert.deepStrictEqual([id.app, id.deployment, id.context, id.compat, id.env], ['orders', DEP.native.deployment, 'platform', COMPAT.generations.orders, 'production']);
  assert.strictEqual(id.build, B.manifest.build); assert.match(id.build, /^[0-9a-f]{20}$/);
  assert.ok(sha256Of(txt('sherpa-client.js')) === sha256Of(show('customer-app/sherpa-client.js').toString('utf8')), 'the shared module is the committed copy');
  ok(`the packaged shell is stamped: readIdentity → orders / ${id.deployment} / platform, compat ${id.compat} (compat.json), env production (the ENVIRONMENT — never the host mode), build = the content hash`);
}
function sha256Of(s) { return require('crypto').createHash('sha256').update(s).digest('hex'); }

// 2. exactly the shell's files
{
  const web = show('customer-app/shell.html').toString('utf8');
  const { scripts, sheets, assets } = P.shellFiles(web, (r) => show(`customer-app/${r}`).toString('utf8'));
  assert.strictEqual(P.ENTRY, 'index.html', 'Capacitor\'s entry'); assert.ok(!B.files.has('shell.html'), 'the shell is packaged AS index.html (one file)');
  const want = [...scripts, ...sheets, ...assets, 'capp-boot.js', 'capp-runtime.js', P.ENTRY, 'build-manifest.json',
    ...Object.keys(LOCK.files).map((f) => `vendor/firebasejs/${LOCK.version}/${f}`)].sort();
  assert.deepStrictEqual([...B.files.keys()].sort(), want);
  for (const k of B.files.keys()) assert.ok(!/\.test\.|fixtures\/|MOCKUP|netlify\.toml|node_modules/.test(k), `🔴 not runtime: ${k}`);
  assert.ok(!/capp-shell-ui\.js/.test(show('customer-app/index.html').toString('utf8')) && /<script src="capp-shell-ui\.js">/.test(txt(P.ENTRY)), 'the entry is the SHELL (it loads capp-shell-ui.js), never the web single-store index.html');
  assert.ok(assets.includes('fonts/OFL.txt') && assets.filter((a) => a.endsWith('.woff2')).length === 4, 'the four fonts and their licence');
  for (const f of [...scripts, ...sheets, ...assets, 'capp-boot.js']) assert.ok(B.files.get(f).equals(show(`customer-app/${f}`)), `${f} is byte-identical to the committed source`);
  const s = txt(P.ENTRY);
  assert.strictEqual(s.replace(/<!-- sherpa-stamp:begin -->[\s\S]*?<!-- sherpa-stamp:end -->\n/, '').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n/, '').replace('<script src="capp-runtime.js"></script>\n<script src="capp-boot.js"></script>\n', ''), web, 'the packaged shell = the web shell + ONLY the stamp, the CSP and the two boot scripts');
  assert.ok(s.indexOf('Content-Security-Policy') < s.indexOf('<script'), 'the CSP precedes every script');
  ok(`exactly ${want.length} files: shell.html's ${scripts.length} scripts + ${sheets.length} stylesheets + ${assets.length} font assets, the boot, the config, the 2 SDK files, the manifest — all byte-identical to the commit; www/index.html = the web shell.html + stamp + CSP + boot only`);
}

// 3. the CSP and the static origin scan
{
  const rt = DEP.runtime, rtdb = new URL(rt.availability_base).host;
  const web = show('customer-app/shell.html').toString('utf8'), blocks = [...web.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  assert.strictEqual(blocks.length, 1, 'premise: the web shell has one fixed <style> block');
  const HASH = `sha256-${require('crypto').createHash('sha256').update(blocks[0][1], 'utf8').digest('base64')}`;
  const PLAN = `default-src 'self'; script-src 'self' https://maps.googleapis.com; connect-src 'self' ${rt.functions_base} ${rt.availability_base} wss://${rtdb} https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://maps.googleapis.com; img-src 'self' data: https://maps.googleapis.com ${PHOTO_HOSTS.join(' ')}; font-src 'self'; style-src 'self' '${HASH}'; style-src-attr 'unsafe-inline'; frame-src 'none'`;
  assert.strictEqual(B.csp, PLAN, '🔴 the CSP differs from plan §1.2 (+ Codex r1 #3)');
  assert.ok(!B.csp.includes('*'), 'no wildcard'); assert.ok(txt(P.ENTRY).includes(`content="${PLAN}"`));
  const styleSrc = B.csp.split('; ').find((d) => d.startsWith('style-src '));
  assert.ok(!styleSrc.includes('unsafe-inline'), '🔴 style-src must not allow unsafe-inline (only style-src-attr does)'); assert.strictEqual(B.styleHash, HASH);
  assert.ok(txt(P.ENTRY).includes(`<style>${blocks[0][1]}</style>`), 'the hashed block is packaged byte-identical');
  const dir = Object.fromEntries(B.csp.split('; ').map((d) => { const [k, ...v] = d.split(' '); return [k, v]; }));
  const allowed = new Set([...dir['connect-src'], ...dir['script-src'], ...dir['img-src']].filter((x) => /^(https|wss):/.test(x)));
  // NAVIGATION targets, never fetched (so connect-src / img-src don't govern them): «Ayuda» opens wa.me in a new window (window.open,
  // noopener) and «Compartir seguimiento» only COPIES a tracker link — the tracker origins come from the manifest's track deployments
  const TRACK = JSON.parse(show('platform/sites.json').toString('utf8')).deployments.filter((d) => d.app === 'track').map((d) => `https://${d.netlify_site}.netlify.app`);
  // «Pedido recibido»: the packaged runtime carries each context's tracker from the manifest (one source), and the help number
  const rtj = JSON.parse(txt('capp-runtime.js').match(/Object\.freeze\((\{[\s\S]*\})\);/)[1]);
  assert.deepStrictEqual(rtj.track_bases, Object.fromEntries(JSON.parse(show('platform/sites.json').toString('utf8')).deployments.filter((d) => d.app === 'track').map((d) => [d.context, `https://${d.netlify_site}.netlify.app`])), '🔴 track_bases = the manifest\'s track deployments');
  assert.strictEqual(rtj.track_bases.x_pizza, 'https://xpizzatrack.netlify.app', 'x_pizza\'s tracker = the server\'s TRACKING_BASE (whatsapp.js)');
  assert.strictEqual(rtj.support_whatsapp, '+50497952893', 'the help number rides the runtime block');
  const EXEMPT = { 'capp-auth-firebase.js': ['https://www.gstatic.com'], 'capp-shell-ui.js': ['https://wa.me'], 'capp-runtime.js': TRACK };   // the WEB default SDK; the boot always passes loadSdk
  assert.match(txt('capp-boot.js'), /loadSdk: \(\) => Promise\.all\(\[importModule\(`\$\{sdk\}firebase-app\.js`\)/, 'premise of the exemption: the boot overrides the SDK loader');
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
  const cfg = txt('capp-runtime.js'); const sb = {}; new Function('self', cfg)(sb);
  const R = sb.CAPP_RUNTIME;
  assert.ok(Object.isFrozen(R) && !('note' in R)); assert.deepStrictEqual(R.flags, on(BASE_FLAGS)); assert.strictEqual(R.mode, 'native'); assert.strictEqual(R.sdk_base, `./vendor/firebasejs/${LOCK.version}/`);
  for (const k of Object.keys(DEP.runtime).filter((k) => k !== 'note' && k !== 'mode')) assert.ok(JSON.stringify(R[k]) === JSON.stringify(DEP.runtime[k]), `the runtime's ${k} is the manifest's`);
  const F = P.build({ sha: HEAD, ...NAT, flags: [...BASE_FLAGS, 'signup', 'intlPhone'] }); const sf = {}; new Function('self', F.files.get('capp-runtime.js').toString('utf8'))(sf);
  assert.deepStrictEqual(sf.CAPP_RUNTIME.flags, { ...on(BASE_FLAGS), signup: true, intlPhone: true }); assert.deepStrictEqual(F.manifest.flags, [...BASE_FLAGS, 'intlPhone', 'signup'].sort());
  { const R = P.build({ sha: HEAD, ...NAT, flags: [...BASE_FLAGS, 'ratings'] }); const sr = {}; new Function('self', R.files.get('capp-runtime.js').toString('utf8'))(sr);
    assert.deepStrictEqual(sr.CAPP_RUNTIME.flags, { ...on(BASE_FLAGS), ratings: true }, '🔴 C-2: the ratings flag can be shipped (it was refused as unknown)'); }
  { const R = P.build({ sha: HEAD, ...NAT, flags: [...BASE_FLAGS, 'sdkPay'] }); const sr = {}; new Function('self', R.files.get('capp-runtime.js').toString('utf8'))(sr);
    assert.deepStrictEqual(sr.CAPP_RUNTIME && sr.CAPP_RUNTIME.flags, { ...on(BASE_FLAGS), sdkPay: true }, '🔴 S2: the sdkPay flag can be shipped'); }
  assert.notStrictEqual(F.manifest.build, B.manifest.build, 'a different flag set is a different build');
  ok('firebase-auth\'s one gstatic import → ./firebase-app.js (firebase-app byte-identical); the runtime = the manifest block minus its note + sdk_base; flags dark unless named; a flag set changes the build id');
}

// 5. refusals
{
  const over = (edits) => (rel) => (rel in edits ? Buffer.from(typeof edits[rel] === 'string' ? edits[rel] : JSON.stringify(edits[rel])) : show(rel));
  const sitesWith = (mut) => { const c = JSON.parse(JSON.stringify(SITES)); mut(c.deployments.find((d) => d.app === 'orders' && d.context === 'platform')); return c; };
  const refuse = (opts, re) => assert.throws(() => P.build({ sha: HEAD, ...NAT, ...opts }), re);
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
  refuse({ flags: [...BASE_FLAGS, 'payments'] }, /unknown flag payments/);
  refuse({ sha: 'not-a-sha' }, /--sha must be a commit/);
  refuse({ env: undefined }, /--env is required .* never guessed/); refuse({ env: 'Prod uction' }, /--env is required/); refuse({ target: 'desktop' }, /--target must be one of web, native/);
  ok('refused: no native id / no runtime / any one runtime key missing / a malformed base / an incomplete firebase config / no compat generation (never an inert build), a second <style> block, a tampered vendored file, a remote script in shell.html, an unknown flag, a non-commit');
}

// 6. --verify and pack
{
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'capp-native-test-'));
  try {
    const m = P.pack({ sha: HEAD, ...NAT, out: path.join(out, 'www') });
    assert.deepStrictEqual(P.verify(path.join(out, 'www'), B), []); assert.strictEqual(m.build, B.manifest.build, 'deterministic: two builds of one commit agree');
    const f = path.join(out, 'www', 'capp-ui.js'); fs.appendFileSync(f, ' ');
    fs.writeFileSync(path.join(out, 'www', 'stray.js'), 'x'); fs.rmSync(path.join(out, 'www', 'capp.css'));
    assert.deepStrictEqual(P.verify(path.join(out, 'www'), B).sort(), ['differs capp-ui.js', 'extra stray.js', 'missing capp.css']);
    assert.throws(() => P.pack({ sha: HEAD, ...NAT, out: path.join(out, 'www') }), /not empty — refusing to mix builds/);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
  ok('pack writes the build (deterministic per commit); --verify names a changed byte, an extra file and a missing file; pack refuses a non-empty --out');
}
// 7. the LAUNCH path: Capacitor opens www/index.html — the packaged entry, its own scripts in its own order, reaches the shell
{
  const page = txt(P.ENTRY);
  const srcs = [...page.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepStrictEqual(srcs.slice(-3), ['capp-shell-ui.js', 'capp-runtime.js', 'capp-boot.js'], 'the boot runs last, after the config');
  for (const f of srcs) assert.ok(B.files.has(f), `index.html loads a packaged file: ${f}`);
  const dom = new JSDOM(page.replace(/<script src="[^"]+"><\/script>/g, '').replace(/<link [^>]+>/g, ''), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'capacitor://localhost/index.html' });
  const w = dom.window; let requests = 0;
  w.fetch = () => { requests++; return new Promise(() => {}); }; w.setInterval = () => 0;
  for (const f of srcs) w.eval(txt(f));
  assert.ok(w.CAPP_RUNTIME && w.CappBoot && w.CappBoot.instance, '🔴 the packaged entry did not boot the shell');
  assert.ok(w.document.querySelector('.tabbar'), 'the shell painted from www/index.html');
  w.close();
  ok('www/index.html (the entry Capacitor loads) runs its packaged scripts in order — the config, then the boot — and paints the shell');
}
// 8. D-1 — the WEB target: the SAME build as native except its stamp (deployment = the platform orders deployment itself),
//    runtime.mode 'web', and a /version.json matching the stamp (stamp-version.js's shape)
{
  const Wb = P.build({ sha: HEAD, ...WEB });
  const mod = { exports: {} }; new Function('module', 'exports', Wb.files.get('sherpa-client.js').toString('utf8'))(mod, mod.exports);
  const id = mod.exports.readIdentity(new JSDOM(Wb.files.get(P.ENTRY).toString('utf8')).window.document);
  assert.ok(id, '🔴 the web build is INERT');
  assert.deepStrictEqual([id.app, id.deployment, id.context, id.compat, id.env], ['orders', DEP.id, 'platform', COMPAT.generations.orders, 'production']);
  assert.notStrictEqual(DEP.id, DEP.native.deployment, 'premise: web and native are distinct deployments');
  const vj = JSON.parse(Wb.files.get('version.json').toString('utf8'));
  assert.deepStrictEqual(vj, { app: 'orders', deployment: DEP.id, build: id.build, compat: id.compat, commit: HEAD }, '🔴 /version.json must match the web stamp');
  assert.ok(!B.files.has('version.json'), 'the native build carries no version.json (it updates through the store)');
  const sb = {}; new Function('self', Wb.files.get('capp-runtime.js').toString('utf8'))(sb); assert.strictEqual(sb.CAPP_RUNTIME.mode, 'web');
  assert.strictEqual(Wb.csp, B.csp, 'ONE CSP for web and native');
  const differ = [...new Set([...Wb.files.keys(), ...B.files.keys()])].filter((k) => !(Wb.files.has(k) && B.files.has(k) && Wb.files.get(k).equals(B.files.get(k)))).sort();
  assert.deepStrictEqual(differ, ['_redirects', 'build-manifest.json', 'capp-runtime.js', P.ENTRY, 'version.json'].sort(), '🔴 web and native must differ ONLY in the stamp page (+ <base>), the runtime mode, the manifest, version.json and _redirects');
  // D-4a §6: deep links — <base href="/"> right after the charset, BEFORE every relative reference; a non-forced SPA rewrite; native has neither
  const wi = Wb.files.get(P.ENTRY).toString('utf8');
  assert.equal(wi.split('<base href="/">').length - 1, 1, 'web: exactly one <base>');
  assert.ok(wi.indexOf('<meta charset="utf-8">') < wi.indexOf('<base href="/">') && wi.indexOf('<base href="/">') < wi.indexOf('<meta http-equiv="Content-Security-Policy"'), '🔴 web: <base> right after the charset block (only the URL-free stamp metas between), before the CSP');
  const firstRel = wi.search(/(?:href|src)="(?!\/|https?:|data:)[^"]+"/);
  assert.ok(wi.indexOf('<base href="/">') > -1 && wi.indexOf('<base href="/">') < firstRel, '🔴 web: <base> precedes every relative reference');
  assert.equal(Wb.files.get('_redirects').toString('utf8'), '/* /index.html 200\n', 'the non-forced rewrite');
  assert.ok(!/<base /.test(B.files.get(P.ENTRY).toString('utf8')) && !B.files.has('_redirects'), 'native: no <base>, no _redirects');
  const strip = (b) => b.toString('utf8').replace(/<!-- sherpa-stamp:begin -->[\s\S]*?<!-- sherpa-stamp:end -->\n/, '').replace('<base href="/">\n', '');
  assert.strictEqual(strip(Wb.files.get(P.ENTRY)), strip(B.files.get(P.ENTRY)), 'the entry pages differ only inside the stamp block');
  const Pv = P.build({ sha: HEAD, target: 'web', env: 'deploy-preview', flags: BASE_FLAGS });
  const pid = mod.exports.readIdentity(new JSDOM(Pv.files.get(P.ENTRY).toString('utf8')).window.document);
  assert.strictEqual(pid.env, 'deploy-preview', 'a preview stamps its environment (heartbeats off by design)');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'capp-web-test-'));
  try { P.pack({ sha: HEAD, ...WEB, out: path.join(out, 'dist') }); assert.deepStrictEqual(P.verify(path.join(out, 'dist'), Wb), []);
    fs.writeFileSync(path.join(out, 'dist', 'version.json'), '{}'); assert.deepStrictEqual(P.verify(path.join(out, 'dist'), Wb), ['differs version.json']); }
  finally { fs.rmSync(out, { recursive: true, force: true }); }
  ok(`the WEB target: stamped orders / ${DEP.id} / production (readIdentity), /version.json = the stamp's build + compat, runtime.mode web, the SAME CSP; it differs from native ONLY in the stamp block, the mode, the manifest and version.json; a preview stamps its environment; --verify covers it`);
}
// APP-TRAIN OBLIGATION (advisor ruling 2026-11-01, enforced in CODE): 3a's capp-guest server (checkout-guest-gate.js) refuses every capp
// guest that is not card + email + a verified ticket — so a bundle that can serve capp guests without the client's guestCardOnly rules
// (card only, the email, the WhatsApp code) must never be built. The packager refuses it, web AND native; the release command carries it.
{
  const withGuest = (rel) => (rel === GUEST ? Buffer.from('// the capp-guest server is present\n') : show(rel));
  for (const t of [{ target: 'native', env: 'production' }, { target: 'web', env: 'production' }]) {   // NO flags: the refusal is the point
    assert.throws(() => P.build({ sha: HEAD, ...t, show: withGuest }), /guestCardOnly/, `🔴 ${t.target}: the guest server is present and guestCardOnly is NOT set ⇒ packaging must REFUSE`);
    const G = P.build({ sha: HEAD, ...t, show: withGuest, flags: ['guestCardOnly'] });
    assert.ok(G.files.has(P.ENTRY), `${t.target}: with guestCardOnly the build proceeds`);
  }
  const present = GUEST_PRESENT;
  const cmd = (fs.readFileSync(path.join(ROOT, 'customer-app/netlify.toml'), 'utf8').match(/command\s*=\s*"([^"]*package-capp[^"]*)"/) || [])[1] || '';
  assert.ok(cmd, 'premise: the web release command runs the packager');
  if (present) assert.ok(/--flags\s+\S*\bguestCardOnly\b/.test(cmd), `🔴 the guest server is in this tree: the web release command must pass --flags …guestCardOnly (${cmd})`);
  ok(`APP-TRAIN obligation: with 3a's capp-guest server present, the packager REFUSES a web or native build without guestCardOnly (and builds with it); the web release command is checked against this tree (guest server ${present ? 'PRESENT' : 'absent'})`);
}
// 8. F2 (advisor 11-08, LAUNCH GATE): every dish-photo host the public menu can serve is admitted by img-src, GENERATED — never
//    hand-listed. The hosts come from the publishers' own rules: catalog/public-photos.js assetBaseFor (each brand's order site, from
//    the manifest) and photos/ publicUrl (the public photos bucket). The SBS found the packaged CSP blocking every served photo.
{
  const B8 = P.build({ sha: HEAD, ...NAT });
  const img = (B8.csp.split('; ').find((d) => d.startsWith('img-src ')) || '').split(' ').slice(1);
  const rids = PHOTO_RIDS;
  assert.ok(rids.length >= 2, `premise: the manifest has brand order sites (${rids.join(', ')})`);
  const served = [];
  for (const rid of rids) {
    const base = assetBaseFor(rid, SITES);
    assert.ok(base, `premise: ${rid} has one order-site photo base`);
    // the publisher's own rule only ever emits URLs under that base (both record shapes: a relative img, has_photo)
    const ph = buildPhotos({ items: [{ key: 'k1', display: { id: 1, img: 'images/a.jpg' } }, { key: 'k2', display: { id: 2, has_photo: true } }] }, base);
    const urls = Object.values(ph).flatMap((p) => [p.card, p.hero]);
    assert.ok(urls.length > 0 && urls.every((u) => u.startsWith(base)), `premise: ${rid}'s photo URLs are under its base`);
    served.push(...urls.map((u) => new URL(u).origin));
  }
  served.push(new URL(publicUrl('bucket', rids[0], 'pid', 'card')).origin);   // portal-published photos: the public bucket
  const missing = [...new Set(served)].filter((o) => !img.includes(o));
  assert.deepStrictEqual(missing, [], `🔴 img-src does not admit the dish-photo host(s) the menu can serve: ${missing.join(', ')}`);
  ok(`img-src admits every dish-photo host the menu can serve, from the publishers' rules (${[...new Set(served)].length}: each brand's order site + the public bucket)`);
}
// 9. Codex r2 P2-2: a manifest origin must not change meaning inside the CSP <meta> attribute. `&colon;` decodes to ':' (another
//    origin admitted) and a `"` ends the attribute (every later source and directive dropped). Every network source is a strict
//    https/wss origin or the build refuses; the attribute is HTML-escaped; the PARSED <meta>.content is the CSP, exactly.
{
  const rt = DEP.runtime, HASH9 = 'sha256-AAAA';
  for (const bad of ['https://example.com&colon;443', 'https://example.com"oops', 'https://exa mple.com', 'https://example.com/path', 'http://example.com', 'https://example.com;script-src *', "https://example.com'", 'https://example.com<x']) {
    let threw = null; try { P.cspFor({ ...rt, functions_base: bad }, HASH9, []); } catch (e) { threw = e; }
    assert.ok(threw, `🔴 the CSP admitted a malformed runtime origin: ${JSON.stringify(bad)}`);
    threw = null; try { P.cspFor(rt, HASH9, [bad]); } catch (e) { threw = e; }
    assert.ok(threw, `🔴 the CSP admitted a malformed photo origin: ${JSON.stringify(bad)}`);
  }
  const B9 = P.build({ sha: HEAD, ...WEB }), page = B9.files.get(P.ENTRY).toString('utf8');
  const meta = new JSDOM(page).window.document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  assert.strictEqual(meta && meta.getAttribute('content'), B9.csp, '🔴 the parsed <meta> CSP is not the CSP the packager built');
  // the attribute is escaped on its own (the belt): a value with an entity, a quote and a tag reads back verbatim
  const hostile = `img-src https://a.example&colon;443 "x" <b>`;
  const back = new JSDOM(`<!doctype html><head>${P.cspMeta(hostile)}</head>`).window.document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  assert.strictEqual(back && back.getAttribute('content'), hostile, '🔴 the <meta> attribute is not HTML-escaped (an entity or a quote changes the CSP)');
  ok('the CSP refuses every malformed origin (entities, quotes, spaces, paths, http, separators) and the parsed <meta>.content is the built CSP');
}
console.log(`package-capp: OK (${n})`);
