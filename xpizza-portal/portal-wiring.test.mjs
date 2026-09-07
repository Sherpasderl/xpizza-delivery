// Portal 2b-2a — the wiring the browser would find and node would not.
// Run: node --test xpizza-portal/portal-wiring.test.mjs
//
// The portal's modules split along a testability line: anything that DECIDES something lives where node
// can import it, and the DOM files import the Firebase SDK from a CDN URL that node cannot load. That
// split has a cost — a function can be moved into the pure module, stop being reachable from the DOM
// module, and every node test still passes while the browser throws ReferenceError on the first click.
// That happened once here. These checks are the cheap way to notice it.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const JS = readdirSync(DIR).filter((f) => f.endsWith('.js'));
const codeOf = (f) => readFileSync(join(DIR, f), 'utf8')
  .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');

test('no module uses an HTML sink — every server string reaches the page via textContent', () => {
  // Comment-stripped: the file that explains WHY it avoids innerHTML must not trip its own guard. (The
  // first version of this check did exactly that.)
  for (const f of JS) {
    const c = codeOf(f);
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      assert.ok(!c.includes(sink), `${f} must not use ${sink} — a dish name is data, not markup`);
    }
  }
  // non-vacuity: the detector fires on planted code
  assert.ok('el.innerHTML = x;'.includes('innerHTML'), 'the detector can see a sink');
});

test('every function a module calls is one it defines or imports', () => {
  // The ReferenceError class. Node cannot import the DOM modules (CDN URLs), so nothing else would
  // catch a call to a function that moved out from under it.
  const GLOBALS = new Set(['fetch', 'setTimeout', 'clearTimeout', 'require', 'import', 'JSON', 'Object', 'Array',
    'String', 'Number', 'Boolean', 'Promise', 'Error', 'TypeError', 'Set', 'Map', 'Date', 'console',
    'document', 'window', 'localStorage', 'CustomEvent', 'encodeURIComponent', 'super', 'if', 'for',
    'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new',
    // keywords that precede a parenthesis and are not calls
    'async', 'else', 'do', 'try', 'yield', 'delete', 'void', 'in', 'of', 'instanceof']);
  for (const f of JS) {
    const c = codeOf(f);
    const defined = new Set([
      ...[...c.matchAll(/(?:function|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
      // Method / function DEFINITIONS: `name(args) {`. Discriminated from a CALL by the trailing brace —
      // `showEmpty(t, d);` ends in a semicolon, `constructor(a, b) {` opens a body. Matching on
      // line-start alone would have counted the call as a definition and defeated the whole check.
      ...[...c.matchAll(/(?:^|[\s;{])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)].map((m) => m[1]),
      ...[...c.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]),
      ...[...c.matchAll(/import\s*\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop())),
      ...[...c.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)].map((m) => m[1]),
      // Destructured bindings — both `const { a } = x` and `function f({ a, b } = {})`. An injected
      // dependency like `token` arrives this way, and counting it as undefined would flood the check
      // with false positives until someone deleted it.
      ...[...c.matchAll(/\{([^{}]*)\}\s*(?:=|\)|,)/g)].flatMap((m) => m[1].split(',').map((x) => x.trim().split(/[:=]/)[0].trim())),
      // plain parameters, so a helper's own arguments are not mistaken for missing globals
      ...[...c.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)].flatMap((m) => m[1].split(',').map((x) => x.trim().split(/[:=]/)[0].trim())),
    ].filter(Boolean));
    const called = new Set([...c.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
    for (const fn of called) {
      if (GLOBALS.has(fn) || defined.has(fn)) continue;
      assert.fail(`${f} calls ${fn}() but neither defines nor imports it — this is a ReferenceError in the browser`);
    }
  }
});

test('every module the portal ships is reachable from index.html', () => {
  const html = readFileSync(join(DIR, 'index.html'), 'utf8');
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    // BOTH import forms: `from './x.js'` AND the bare side-effect `import './x.js'`. Missing the
    // second made a whole subtree look unreachable the moment the shell's boot script started using it.
    for (const m of codeOf(f).matchAll(/(?:from\s+|import\s+)'\.\/([\w-]+\.js)'/g)) walk(m[1]);
  };
  for (const m of html.matchAll(/(?:from\s+|import\s+|src=")\.?\/?([\w-]+\.js)"?/g)) walk(m[1]);
  // the shell loads its boot script via <script src>, not an import
  for (const m of html.matchAll(/<script[^>]*src="\.\/([\w-]+\.js)"/g)) walk(m[1]);
  for (const f of JS) {
    assert.ok(seen.has(f), `${f} ships but nothing imports it — dead code on a money surface, or a missing wire`);
  }
});

test('the CSP allows exactly the hosts the code actually talks to', () => {
  // A CSP and the code it guards drift apart silently: change the functions base URL, or add an SDK
  // host, and the page keeps working locally (no CSP in dev) while every deployed request is blocked.
  // This ties them together. Verified once against a real sign-in — this keeps it true.
  const toml = readFileSync(join(DIR, 'netlify.toml'), 'utf8');
  const csp = /Content-Security-Policy = "([^"]+)"/.exec(toml);
  assert.ok(csp, 'netlify.toml must declare a CSP');
  const policy = csp[1];

  // every absolute host the modules fetch or import from must be allowed by SOME directive
  const hosts = new Set();
  for (const f of JS) for (const m of codeOf(f).matchAll(/https:\/\/([a-z0-9.-]+)/g)) hosts.add(m[1]);
  for (const h of hosts) {
    assert.ok(policy.includes(h), `the code talks to ${h} but the CSP does not allow it — every deployed request would be blocked`);
  }
  assert.ok(hosts.size >= 2, `non-vacuity: the scan must find real hosts (found ${hosts.size})`);

  // and the hardening that makes a strict policy worth having
  assert.ok(!/unsafe-inline|unsafe-eval/.test(policy), "no 'unsafe-inline' / 'unsafe-eval' — the shell has no inline script or style, so it does not need them");
  assert.ok(/frame-ancestors 'none'/.test(policy), 'frame-ancestors none — later slices edit prices from this page');
  assert.ok(/default-src 'none'/.test(policy), "default-src 'none' — allow-list, not deny-list");
  for (const d of ['base-uri', 'object-src', 'form-action']) assert.ok(policy.includes(d), `${d} must be closed`);
});

test('index.html carries no inline script or style — the premise of the strict CSP', () => {
  const html = readFileSync(join(DIR, 'index.html'), 'utf8');
  assert.ok(!/<style[\s>]/.test(html), 'styles are a file, so style-src needs no unsafe-inline');
  const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html);
  assert.ok(!inlineScript, 'scripts are files, so script-src needs no unsafe-inline');
});
