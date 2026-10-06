'use strict';
// P-SELFUPDATE CP2 — STATIC LINT for the one request wrapper (advisor ruling Q7 condition 2):
//   (1) every CALL that names an identity-endpoint constant (createOrder / quoteOrder / chargeOnlineOrder /
//       quoteRedemption URLs) in client code goes through sherpaFetch — so a future call site cannot silently skip the
//       X-Client headers or the money latch;
//   (2) an identity-endpoint URL literal appears ONLY in a constant definition;
//   (3) every remaining bare fetch( in client code is either a sherpaFetch fallback or on an explicit allowlist of
//       NON-platform targets — a new platform call written as fetch( fails here;
//   (4) the order-form adapter copies are byte-identical to the canonical file, and each orders entrypoint loads it.
// Run: node pselfupdate-wrapper-lint.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITES = JSON.parse(fs.readFileSync(path.join(ROOT, 'platform/sites.json'), 'utf8'));
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('uncaughtException', (e) => { console.error('pselfupdate-wrapper-lint FAILED:', e); process.exit(1); });
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('pselfupdate-wrapper-lint FAILED: exited without completing'); process.exitCode = 1; } });

const IDENTITY_RE = /cloudfunctions\.net\/(createOrder|quoteOrder|chargeOnlineOrder|quoteRedemption)\b/;
const KEYWORDS = new Set(['if', 'while', 'for', 'switch', 'return', 'typeof', 'catch', 'function']);
// bare fetch( targets that are NOT platform functions, by file → the exact first-argument text
const NON_PLATFORM_FETCH = {
  'xpizza-orders/index.html': ['AVAIL_URL'],                 // RTDB REST read (public availability), not a function
  'la-musa-orders/index.html': ['AVAIL_URL'],
  'xpizza-dispatch-mobile/sw.js': ['e.request'],              // the service worker's own network-first pass-through
  'xpizza-catering/index.html': ["'/'"],                      // Netlify Forms submit to the site itself
};
const SHERPA_FALLBACK = /: fetch\(u, o\); \}$/;               // the fallback arm inside a local sherpaFetch definition

function clientFiles() {
  const out = [];
  for (const folder of [...new Set(SITES.deployments.map((d) => d.folder))]) {
    (function walk(rel) {
      for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        if (e.isDirectory()) walk(r);
        else if (/\.(html|js|mjs)$/.test(e.name) && !/\.test\.|\.copy\.test\./.test(e.name) && !['sherpa-client.js', 'order-self-update.js'].includes(e.name)) out.push(r);
      }
    })(folder);
  }
  return out;
}

function lint(files, read) {
  const problems = [];
  let identityCalls = 0;
  const bare = [];
  for (const f of files) {
    const src = read(f);
    const lines = src.split('\n');
    // identity constants defined in this file
    const names = new Set();
    lines.forEach((l, i) => {
      if (!IDENTITY_RE.test(l)) return;
      const m = l.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`]/);
      if (m) names.add(m[1]);
      else if (!/^\s*(\/\/|\*|\/\*)/.test(l)) problems.push(`${f}:${i + 1} identity URL literal outside a constant definition`);
    });
    for (const name of names) {
      const re = new RegExp(String.raw`([A-Za-z_$][\w$.]*)\s*\(\s*` + name + String.raw`\b`, 'g');
      let m;
      while ((m = re.exec(src))) {
        const callee = m[1].split('.').pop();
        if (KEYWORDS.has(callee)) continue;
        identityCalls += 1;
        if (m[1] !== 'sherpaFetch') problems.push(`${f}: ${m[1]}(${name} — an identity endpoint must be called through sherpaFetch`);
      }
    }
    // every bare fetch( (incl. window.fetch / globalThis.fetch), classified — on comment-stripped code (block comments
    // become blank lines so line numbers stay true; a `//` comment is stripped unless it is part of a URL)
    const code = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).split('\n').map((l) => l.replace(/(^|[^:'"`\w])\/\/.*$/, '$1'));
    code.forEach((l, i) => {
      const re = /(^|[^A-Za-z0-9_$])((?:window\.|globalThis\.|self\.)?fetch)\s*\(\s*([^,)]*)/g;
      let m;
      while ((m = re.exec(l))) {
        const arg = m[3].trim();
        if (SHERPA_FALLBACK.test(lines[i].trimEnd()) && arg === 'u') continue;
        bare.push(`${f}:${i + 1} ${m[2]}(${arg}`);
        if (!(NON_PLATFORM_FETCH[f] || []).includes(arg)) problems.push(`${f}:${i + 1} bare ${m[2]}(${arg} — a platform-function call must use sherpaFetch, anything else must be allowlisted here`);
      }
    });
  }
  return { problems, identityCalls, bare };
}

const files = clientFiles();
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const r = lint(files, read);
assert.deepStrictEqual(r.problems, [], `🔴 wrapper lint:\n  ${r.problems.join('\n  ')}`);
assert.ok(r.identityCalls >= 8, `non-vacuity: identity-endpoint calls were found (${r.identityCalls}) — 3 per form + quoteRedemption per account.js`);
ok(`${files.length} client files: all ${r.identityCalls} identity-endpoint calls go through sherpaFetch; no identity URL literal outside a constant`);
ok(`every remaining bare fetch( is allowlisted non-platform traffic: ${r.bare.map((b) => b.replace(/^[^ ]+ /, '')).join(' · ')}`);

// non-vacuity: the lint catches each shape it claims to
{
  const base = { 'xpizza-orders/index.html': read('xpizza-orders/index.html') };
  const mut = (from, to) => { const s = base['xpizza-orders/index.html']; assert.ok(s.includes(from), `probe anchor ${from}`); return lint(['xpizza-orders/index.html'], () => s.replace(from, to)).problems; };
  assert.ok(mut('await sherpaFetch(CREATEORDER_URL,{', 'await fetch(CREATEORDER_URL,{').length > 0, 'a createOrder send via fetch( is caught');
  assert.ok(mut('sherpaFetch(QUOTEORDER_URL, {', 'window.fetch(QUOTEORDER_URL, {').length > 0, 'a quote via window.fetch( is caught');
  assert.ok(mut("const PAYMENTSTATUS_URL", "fetch('https://us-central1-xpizza-delivery.cloudfunctions.net/chargeOnlineOrder');\nconst PAYMENTSTATUS_URL").length > 0, 'a literal identity URL call is caught');
  assert.ok(mut('sherpaFetch(`${PAYMENTSTATUS_URL}', 'fetch(`${PAYMENTSTATUS_URL}').length > 0, 'a non-identity platform call via bare fetch( is caught');
  const acct = read('xpizza-orders/account.js');
  assert.ok(lint(['xpizza-orders/account.js'], () => acct.replace('await sherpaFetch(QUOTE_URL,', 'await fetch(QUOTE_URL,')).problems.length > 0, 'quoteRedemption via fetch( is caught');
  ok('non-vacuity: createOrder via fetch(, quote via window.fetch(, a literal identity URL, a bare non-identity platform call and quoteRedemption via fetch( are each caught');
}

// the order-form adapter: canonical copies + loaded after the form script
{
  const canon = fs.readFileSync(path.join(ROOT, 'platform/client/order-self-update.js'));
  for (const d of SITES.deployments.filter((x) => x.app === 'orders')) {
    assert.ok(canon.equals(fs.readFileSync(path.join(ROOT, d.folder, 'order-self-update.js'))), `🔴 ${d.folder}/order-self-update.js drifted — npm run sync:client`);
    const html = read(`${d.folder}/index.html`);
    const at = html.indexOf('<script src="order-self-update.js"></script>');
    assert.ok(at > html.indexOf('function submitOrder('), `${d.folder}: the adapter loads AFTER the form script that defines its globals`);
    assert.strictEqual(html.split('<script src="order-self-update.js"></script>').length - 1, 1);
  }
  ok('order-self-update.js: byte-identical in both orders folders, loaded once, after the form script');
}

FINISHED = true;
console.log(`pselfupdate-wrapper-lint: OK (${n})`);
