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

  // INLINE style ATTRIBUTES count too, and this is not tidiness. style-src without 'unsafe-inline'
  // blocks `style="…"` exactly as it blocks a <style> block — so an inline attribute does not merely
  // offend the policy, it SILENTLY STOPS APPLYING once the policy ships. Two of them survived the first
  // CSP verification for precisely that reason: the page looked right because the elements were styled
  // adequately without them.
  const inlineAttrs = [...html.matchAll(/\sstyle=/g)];
  assert.strictEqual(inlineAttrs.length, 0,
    `${inlineAttrs.length} inline style attribute(s) — under this CSP they are inert, so the element is not styled the way the markup claims`);
  // non-vacuity: the detector fires on a planted attribute
  assert.strictEqual([...'<b style="x">'.matchAll(/\sstyle=/g)].length, 1, 'the detector can see an inline style attribute');
  // ...and does not fire on the words that merely contain it
  assert.strictEqual([...'<link rel="stylesheet"> data-style="x"'.matchAll(/\sstyle=/g)].length, 0, 'and does not false-positive on stylesheet or data-style');
});

// ── Portal 2b-2b Task 1 — THE BOLD-EDITORIAL SKIN ────────────────────────────────────────────────
// The re-skin is not decoration here: this portal is about to grow a WRITE path, and the visual
// language is how a merchant tells a saved draft from a published price. The identity has to actually
// land, and the one it replaces has to actually leave — a half-swapped palette reads as a rendering
// bug, which is the worst thing a page that charges customers money can look like.
//
// Asserted from styles.css rather than from a rendered page because node cannot load the DOM modules
// (they import the Firebase SDK from a CDN URL). Same reason the rest of this file works the way it does.
test('styles.css carries the Bold-Editorial identity, and the sapphire one is gone', () => {
  const css = readFileSync(join(DIR, 'styles.css'), 'utf8');

  // The identity tokens. --disp is the display face: Bold Editorial is a TYPE direction before it is a
  // colour one, so a palette swap that left the body face everywhere would not be this design.
  for (const [tok, why] of [
    ['--ink:#0A0A0B', 'near-black ink, not the old blue-grey'],
    ['--green:#0E9F5B', 'the luminous green that replaces sapphire as the accent'],
    ['--disp:', 'the display type scale — Bold Editorial is a type direction, not just a palette'],
  ]) {
    assert.ok(css.replace(/\s+/g, '').includes(tok.replace(/\s+/g, '')), `styles.css must define ${tok} — ${why}`);
  }

  // The OLD identity must be gone, not merely overridden further down. A leftover sapphire still wins
  // wherever it is defined last, and the failure is a page that is green in some components and blue in
  // others — which reads as breakage rather than as a design.
  for (const dead of ['#5B8DEF', '#2D5FD0', '#4577DC', '#244FB0']) {
    assert.ok(!css.toUpperCase().includes(dead), `sapphire ${dead} must be gone from styles.css, not overridden`);
  }

  // LIGHT IS THE DEFAULT now — the old skin was dark-default, so this is an inversion, not an edit.
  // Bare :root must carry the light palette; both dark selectors must exist, or the three theme states
  // (explicit light / explicit dark / system) do not all resolve.
  const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')) + 1);
  assert.ok(/--ink:\s*#0A0A0B/i.test(rootBlock), 'bare :root must carry the LIGHT palette — light is the default in Bold Editorial');
  assert.ok(/:root\[data-theme="dark"\]/.test(css), 'an explicit dark override must exist so the toggle wins');
  assert.ok(/prefers-color-scheme:\s*dark/.test(css), '...and a system-preference dark block, for the default "system" state');
  assert.ok(/:root:not\(\[data-theme="light"\]\)/.test(css), '...guarded, so an explicit light choice still beats the system preference');

  // non-vacuity: the detectors fire on planted content, so a green pass is about the file, not the regex
  assert.ok('--ink:#0A0A0B;'.replace(/\s+/g, '').includes('--ink:#0A0A0B'), 'the token detector can see a token');
  assert.ok('#5B8DEF'.toUpperCase().includes('#5B8DEF'), 'the dead-colour detector can see a dead colour');
});

// Every class the SHIPPED DOM applies must have a rule. A re-skin ports the stylesheet of a mock, and
// a mock only draws the surfaces it depicts — this one has no login screen and no restaurant switcher,
// so its CSS styles neither. Porting it verbatim silently unstyles whatever the mock left out, and the
// page still renders, which is what makes it easy to ship.
//
// `.hidden` is why this is a wiring test and not a taste one: index.html and app.js use it to show ONE
// of the gate and the app shell. Lose the rule and both render at once.
//
// Written as a sweep because the hand-written version of this list missed five classes — `.multi` (the
// switcher chevron, applied via classList.toggle, which the first extraction regex did not match) and
// `.irow`/`.iinfo`/`.idesc`/`.cv`, the menu rows that are the portal's main content.
test('every class the shipped DOM applies is styled — a re-skin cannot silently drop a surface', () => {
  // Comments STRIPPED. The comment above the carried block names `.switch.multi .chev` to explain why
  // it is carried — and an unstripped scan matched that prose and reported the class as styled after the
  // rule itself was deleted. A guard that reads its own documentation as evidence proves nothing.
  const css = readFileSync(join(DIR, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const html = readFileSync(join(DIR, 'index.html'), 'utf8');
  const js = JS.map(codeOf).join('\n');

  const used = new Set();
  for (const m of html.matchAll(/class="([^"]*)"/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
  for (const m of js.matchAll(/className\s*=\s*['"]([^'"]*)['"]/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
  // add / toggle / remove — toggle is how `.multi` is applied
  for (const m of js.matchAll(/classList\.(?:add|toggle|remove)\(([^)]*)\)/g)) {
    for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) used.add(s[1]);
  }
  // el(tag, cls, text) — render.js's helper, and the DOMINANT idiom here: 17 of the portal's rows and
  // labels get their class this way, never through className or classList. Missing it is what let a
  // removal of .irow/.iinfo/.idesc — the menu rows, the portal's main content — pass this test.
  for (const m of js.matchAll(/\bel\(\s*['"][a-z0-9]+['"]\s*,\s*['"]([^'"]+)['"]/g)) {
    m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
  }
  assert.ok(used.size >= 30, `non-vacuity: the scan must find the portal's classes (found ${used.size})`);

  // NON-VACUITY PER IDIOM. A floor on the total is not enough: the markup alone clears 30, so an
  // extractor that silently stopped understanding one of the JS idioms would still pass. Pin one
  // representative of each of the three, so losing a path fails here instead of going quiet.
  for (const [cls, idiom] of [['gate', 'class="…" in index.html'], ['multi', "classList.toggle(…)"], ['irow', "el(tag, 'cls')"]]) {
    assert.ok(used.has(cls), `the extractor must still see classes applied via ${idiom} (missing .${cls})`);
  }

  const unstyled = [...used].filter((c) => !new RegExp(`\\.${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z0-9_-])`).test(css)).sort();
  assert.deepStrictEqual(unstyled, [],
    `these classes are applied by the DOM but styled nowhere — a ported stylesheet dropped them: ${unstyled.join(', ')}`);

  // the specific rule whose loss is FUNCTIONAL, pinned by name so it cannot quietly go again
  assert.ok(/\.hidden\s*\{[^}]*display\s*:\s*none/.test(css),
    '.hidden must still collapse the element — without it the login gate and the app shell render together');

  // non-vacuity: the detector fires on a class that really is absent
  assert.ok(!new RegExp('\\.no-such-class-anywhere(?![a-zA-Z0-9_-])').test(css), 'the detector reports an absent class as absent');
});

// The class-level check above is necessary and NOT sufficient. A re-skin can keep a class NAME while
// dropping the declarations the markup depends on — which is exactly what happened here, because the
// mock styles some of these names for a DIFFERENT element than the portal renders: `.price` is the
// edit-input wrapper there and read-only price text here; `.sinfo` is styled under `.switch`, not
// under the account footer's `.sfoot`. Both classes "existed" while the portal's behaviour was gone.
//
// So this pins the DECLARATIONS, per selector. Each entry is a functional property — one whose loss
// changes layout or legibility, not one that is taste.
test('functional declarations the read-only portal depends on survive a re-skin', () => {
  const css = readFileSync(join(DIR, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  // selector → declarations that must reach it, with the failure each one prevents
  const CONTRACT = [
    ['.price', 'font-variant-numeric', 'tabular figures — prices in a column must align digit-for-digit'],
    ['.price', 'white-space', 'no-wrap — "Sin precio" must not break across lines mid-row'],
    ['.price', 'color', 'the read-only price is ink, not the wrapper default'],
    ['.sfoot .sinfo', 'min-width', 'min-width:0 — without it a flex child refuses to shrink and cannot ellipsize'],
    ['.sfoot .sinfo', 'flex', 'the account block takes the free space between avatar and logout'],
    ['.sfoot .sinfo b', 'text-overflow', 'ellipsis — a long merchant email otherwise overruns the logout button'],
    ['.sfoot .sinfo b', 'overflow', 'hidden, or text-overflow has nothing to clip'],
    ['.switch .chev', 'opacity', 'the base state the carried `.switch.multi .chev{opacity:1}` overrides — without it the chevron shows for single-restaurant accounts'],
    ['.empty b', 'display', 'block — the empty-state heading and its body otherwise run together on one line'],
  ];

  // A declaration counts as reaching a selector only when THAT selector carries it. A property on a
  // different selector that happens to match some other element is not the same rule.
  const declaredOn = (sel, prop) => {
    for (const line of css.split('\n')) {
      const i = line.indexOf('{');
      if (i === -1 || !line.includes('}')) continue;
      const selectors = line.slice(0, i).split(',').map((s) => s.trim());
      if (!selectors.includes(sel)) continue;
      const decls = line.slice(i + 1, line.lastIndexOf('}'));
      if (new RegExp(`(^|;)\\s*${prop}\\s*:`).test(decls)) return true;
    }
    return false;
  };

  for (const [sel, prop, why] of CONTRACT) {
    assert.ok(declaredOn(sel, prop),
      `${sel} lost its ${prop} declaration — ${why}. The class may still exist; the behaviour does not.`);
  }

  // non-vacuity, both directions: the matcher finds a property that IS there and misses one that is not
  assert.ok(declaredOn('.price', 'font-weight'), 'the matcher can see a declaration that is present');
  assert.ok(!declaredOn('.price', 'border-collapse'), 'the matcher does not report an absent declaration as present');
  assert.ok(!declaredOn('.no-such-selector', 'color'), '...nor find declarations on a selector that does not exist');
  // and it must not credit a DIFFERENT selector that merely contains this one as a substring
  assert.ok(!declaredOn('.sinfo', 'text-overflow'), '`.sinfo` alone is not `.sfoot .sinfo b` — selectors match exactly, not by substring');
});
