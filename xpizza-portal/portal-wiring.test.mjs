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

// ── Portal 2b-2b Task 3 — THE EDIT AFFORDANCES ARE ACTUALLY WIRED ────────────────────────────────
// The recurring failure class on this portal: a pure module is fully tested, every node test passes,
// and the DOM control that should call it was never connected. The 2b-2a switcher shipped exactly that
// way — display-only, with a working module behind it. Node cannot import the DOM files (CDN imports),
// so these are structural, and they are the only thing standing between "the module works" and "the
// button does something".
test('every edit affordance is wired to the draft, not merely rendered', () => {
  const app = codeOf('app.js');
  const render = codeOf('render.js');
  const html = readFileSync(join(DIR, 'index.html'), 'utf8');

  // the module is imported and its setters are actually called
  assert.ok(/from '\.\/editor\.js'/.test(app), 'app.js imports the edit state');
  for (const fn of ['setItemPrice', 'setExtraPrice', 'pendingCount', 'isPublishable', 'discard', 'draftSource']) {
    assert.ok(new RegExp(`\\b${fn}\\s*\\(`).test(app), `app.js must CALL ${fn} — importing it is not wiring it`);
  }

  // the review bar exists in the markup AND something toggles it AND its buttons have listeners
  for (const id of ['rbar', 'rbtxt', 'discard', 'review', 'drawer']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `index.html must contain #${id}`);
  }
  assert.ok(/\$\('rbar'\)\.classList\.toggle\('show'/.test(app), 'something must actually show/hide the review bar');
  assert.ok(/\$\('discard'\)\.addEventListener\('click'/.test(app), 'the discard button has a click listener');

  // NO INLINE HANDLERS. Under this CSP an onclick attribute is inert, so the control would look
  // enabled and do nothing — the exact shape of the bug this test exists for.
  assert.ok(!/\son[a-z]+=/.test(html), 'no inline event handler attributes in index.html');
  for (const f of JS) assert.ok(!/\.setAttribute\(\s*['"]on[a-z]+['"]/.test(codeOf(f)), `${f} must not set an inline handler attribute`);

  // the price inputs are wired in the RENDER, not just styled
  assert.ok(/addEventListener\('input'/.test(render), 'render.js attaches an input listener to the price field');
  assert.ok(/onPrice\(/.test(render), '...and routes it to the caller-supplied handler');
  assert.ok(/dataset\.k/.test(render) && /dataset\.k|data-k/.test(app),
    'price cells are addressable and app.js addresses them — otherwise the drawer and the row drift apart');

  // SCOPED, not file-wide. "setItemPrice appears in app.js" is satisfied by the row handler alone, so
  // a drawer that rendered an input and wrote nowhere would pass — the merchant types a price into a
  // modal, closes it, and the change was never made. Assert against the drawer's OWN body.
  const bodyOf = (src, name) => {
    const i = src.search(new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`));
    if (i === -1) return null;
    const open = src.indexOf('{', src.indexOf(')', i));
    let d = 0;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1);
    }
    return null;
  };
  // openDrawer became a thin entry point in Task 4 (the panel re-renders on every group toggle), so
  // the assertions follow the delegation rather than the name. Both are pinned: the entry point must
  // exist and must hand off, and the renderer must carry the actual wiring.
  const entry = bodyOf(app, 'openDrawer');
  assert.ok(entry, 'openDrawer must exist — it is the row/drawer pair Task 3 ships');
  assert.ok(/renderDrawer\(/.test(entry), 'openDrawer delegates to the renderer');
  const drawer = bodyOf(app, 'renderDrawer');
  assert.ok(drawer, 'renderDrawer must exist — it is where the drawer is actually built');
  assert.ok(drawer.length > 200, `non-vacuity: the drawer body was really extracted (${drawer && drawer.length})`);
  // and it must preserve the scroll position across those re-renders
  assert.ok(/scrollTop/.test(drawer), 'renderDrawer preserves .dwb scrollTop — a toggle must not snap the panel to the top');
  assert.ok(/addEventListener\('input'/.test(drawer), "the drawer's price field has an input listener");
  assert.ok(/setItemPrice\(/.test(drawer), '...that WRITES to the draft, not just to the field');
  assert.ok(/refreshBar\(/.test(drawer), '...and refreshes the bar, so the count follows a drawer edit');
  // Task 4 added option prices to the drawer, so setExtraPrice belongs here now. What must still be
  // absent is anything that writes a KEY or the structure.
  assert.ok(!/structure\s*[.[]|display\.name\s*=(?!=)|\.key\s*=(?!=)/.test(drawer),
    'the drawer edits prices and nothing else — no key, no name, no structure write');
});

test('no NON-PRICE mutator ships — the deferred 2b-2c affordances do not exist', () => {
  // Invariant #6. Renaming an item, adding or deleting one, and renaming an option all write the
  // pricing KEY, which is the per-merchant key-strategy work. They are not disabled here; they are
  // absent. A control that does not exist cannot be re-enabled by a stray line of CSS or a merged
  // branch that flips a flag.
  const app = codeOf('app.js');
  const render = codeOf('render.js');
  const editor = codeOf('editor.js');
  const html = readFileSync(join(DIR, 'index.html'), 'utf8');

  assert.ok(!/contenteditable/i.test(html + app + render), 'no contenteditable anywhere — that is how the mock edits names');
  for (const banned of ['addItem', 'delRow', 'addOption', 'addSection', 'addGroup', 'setGroupType', 'toggleAvail', 'setImg']) {
    assert.ok(!new RegExp(`\\b${banned}\\b`).test(app + render + editor),
      `${banned} is a 2b-2c/2b-2d mutator and must not exist in the shipped portal`);
  }
  // the edit state exposes price setters and nothing else that writes
  const exported = [...editor.matchAll(/export (?:function|const) ([A-Za-z_$][\w$]*)/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(exported, [
    'createDraft', 'discard', 'draftSource', 'groupUsage', 'invalidKeys', 'isPublishable',
    'optionGroups', 'parsePrice', 'pendingChanges', 'pendingCount', 'productsUsingGroup',
    'setExtraPrice', 'setItemPrice',
  ], 'the edit state exports exactly these');
  // The list growing is not the point — WHO WRITES is. Task 4's three additions derive option groups
  // from the extras and must only read, or "editing an option" could quietly restructure the document.
  // BALANCED extraction, not "slice to the next export". The naive version swallowed everything
  // between draftSource and the next `export` — including the NON-exported setPrice, which of course
  // assigns row.price — and reported the pure reader as a mutator. Unbounded slices pick up whatever
  // happens to follow them.
  const bodyIn = (name) => {
    const m = editor.match(new RegExp(`export (?:function|const) ${name}\\b`));
    if (!m) return '';
    const i = editor.indexOf(m[0]);
    const isFn = m[0].includes('function');
    if (isFn) {
      const pOpen = editor.indexOf('(', i);
      let pd = 0, pEnd = pOpen;
      for (; pEnd < editor.length; pEnd++) {
        if (editor[pEnd] === '(') pd++;
        else if (editor[pEnd] === ')' && --pd === 0) break;
      }
      const open = editor.indexOf('{', pEnd);
      let d = 0;
      for (let j = open; j < editor.length; j++) {
        if (editor[j] === '{') d++;
        else if (editor[j] === '}' && --d === 0) return editor.slice(i, j + 1);
      }
      return '';
    }
    let d = 0;
    for (let j = i; j < editor.length; j++) {
      const c = editor[j];
      if ('([{'.includes(c)) d++;
      else if (')]}'.includes(c)) d--;
      else if (c === ';' && d === 0) return editor.slice(i, j + 1);
    }
    return '';
  };
  for (const reader of ['optionGroups', 'groupUsage', 'productsUsingGroup', 'pendingChanges', 'invalidKeys', 'draftSource']) {
    const b = bodyIn(reader);
    assert.ok(b.length > 20 && b.includes(reader), `non-vacuity: ${reader}'s own body was extracted (${b.length} chars)`);
    // `=(?!=)` is load-bearing: without it `was.price === row.price` reads as an assignment and every
    // pure reader fails. A guard that cannot tell a comparison from a write flags reads as writes.
    assert.ok(!/\.price\s*=(?!=)|\.state\s*=(?!=)|\.orig\s*=(?!=)|splice\(/.test(b),
      `${reader} must READ the draft, never write it — a derivation that mutates is a hidden edit`);
  }

  // and the mock's demo-outcome selector must never ship (invariant #7)
  assert.ok(!/demoOut/.test(html + app + render + editor), 'no #demoOut — publish outcomes come from the server, not a picker');
});

// ── THE CLICKABLE-CURSOR / ELEMENT-CONTRACT GUARD ────────────────────────────────────────────────
// A recurring hazard in this slice, now five times over: the mock styles a class NAME for a different
// element than the portal renders, so the class looks covered while the contract is not.
//
//   .price      mock = the edit-input wrapper;      portal = read-only price text
//   .sinfo      mock styles `.switch .sinfo`;       portal also has `.sfoot .sinfo`
//   .nmed       mock = the contenteditable option name; portal used it for every name
//   .info.clk   mock = the row's info block;        portal renders `.iinfo` and adds `clk`
//
// Each was found by a person reading two files side by side. This turns one whole family of them into
// a test: if the portal attaches a click listener to an element, some rule must actually give that
// element a pointer cursor. A control that is clickable but does not look clickable is not a styling
// nit — on a page where the click opens a price editor, it is a control the merchant never finds.
test('every clickable element actually gets a pointer cursor', () => {
  const css = readFileSync(join(DIR, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const html = readFileSync(join(DIR, 'index.html'), 'utf8');

  // Every selector that sets cursor:pointer, reduced to its LAST compound (the element the rule
  // actually lands on), with pseudo-classes stripped so `:hover` variants still count.
  const pointerSelectors = [];
  for (const line of css.split('\n')) {
    const i = line.indexOf('{');
    if (i === -1 || !line.includes('}')) continue;
    const decls = line.slice(i + 1, line.lastIndexOf('}'));
    if (!/(^|;)\s*cursor\s*:\s*pointer/.test(decls)) continue;
    for (const part of line.slice(0, i).split(',')) {
      const bits = part.trim().split(/\s+/);
      // SINGLE COMPOUND ONLY. Reducing a descendant selector to its last part drops the ancestor it
      // requires, and that is not a small inaccuracy: the stylesheet's one tag-level pointer rule is
      // `.gtype button`, so taking the last compound made the guard believe EVERY <button> on the page
      // gets a pointer cursor. Six of the nine click targets were passing for that reason. A selector
      // whose ancestry cannot be verified from source does not count as coverage.
      if (bits.length !== 1) continue;
      const only = bits[0].replace(/::?[a-z-]+(\([^)]*\))?/g, '');
      if (only) pointerSelectors.push(only);
    }
  }
  assert.ok(pointerSelectors.length > 10, `non-vacuity: the stylesheet must define pointer cursors (${pointerSelectors.length})`);

  const bound = (name) => `(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`;
  const classesOf = (sel) => new Set([...sel.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));
  const tagOf = (sel) => (classesOf(sel).size ? null : (sel.match(/^([a-z]+)/) || [])[1] || null);

  const gaps = [];
  let checked = 0;
  for (const f of JS) {
    const src = codeOf(f);
    for (const m of src.matchAll(/([\w$]+(?:\([^)]*\))?)\.addEventListener\(\s*['"]click['"]/g)) {
      const expr = m[1];
      if (expr === 'document' || expr === 'window') continue;   // no cursor semantics on the page itself
      const cls = new Set();
      let tag = null;
      const byId = expr.match(/^\$\('([^']+)'\)$/);
      if (byId) {
        // resolved through the markup: $('id') is only meaningful together with index.html
        const seg = html.match(new RegExp(`<(\\w+)([^>]*\\bid="${byId[1]}"[^>]*)>`));
        if (seg) { tag = seg[1]; const c = seg[2].match(/class="([^"]*)"/); if (c) c[1].split(/\s+/).forEach((x) => x && cls.add(x)); }
      } else {
        // el(tag, 'cls') and el(tag, `cls${…}`) — the template form is how .railitem is built
        for (const g of src.matchAll(new RegExp(`${bound(expr)}\\s*=\\s*el\\(\\s*'(\\w+)'\\s*,\\s*(?:'([^']*)'|\`([^\`$]*))`, 'g'))) {
          tag = g[1]; (g[2] || g[3] || '').split(/\s+/).forEach((x) => x && cls.add(x));
        }
        for (const g of src.matchAll(new RegExp(`${bound(expr)}\\.className\\s*=\\s*'([^']*)'`, 'g'))) g[1].split(/\s+/).forEach((x) => x && cls.add(x));
        for (const g of src.matchAll(new RegExp(`${bound(expr)}\\.classList\\.add\\('([^']*)'\\)`, 'g'))) g[1].split(/\s+/).forEach((x) => x && cls.add(x));
        const c = src.match(new RegExp(`${bound(expr)}\\s*=\\s*document\\.createElement\\('(\\w+)'\\)`));
        if (c) tag = c[1];
      }
      // An element we cannot resolve is reported, not skipped: an unresolvable target is exactly where
      // a mismatch would hide, and a guard that quietly ignores what it cannot read proves nothing.
      assert.ok(cls.size > 0 || tag, `${f}: could not resolve what \`${expr}\` is — the guard must be taught this shape rather than skip it`);
      checked++;
      const covered = pointerSelectors.some((p) => {
        const pc = classesOf(p);
        return pc.size ? [...pc].every((c2) => cls.has(c2)) : tagOf(p) === tag;
      });
      if (!covered) gaps.push(`${f}: <${tag}${[...cls].map((c2) => `.${c2}`).join('')}> is clickable but no cursor:pointer rule reaches it`);
    }
  }
  assert.ok(checked >= 7, `non-vacuity: the scan must find the portal's click handlers (${checked})`);
  assert.deepStrictEqual(gaps, [], `clickable elements with no pointer cursor:\n  ${gaps.join('\n  ')}`);
});

test('the drawer is revealed by the class its own stylesheet defines', () => {
  // Sixth instance of the class-element-contract hazard, and the most expensive so far: `.drawer` parks
  // itself at translateX(102%) and `.drawer.show` brings it in, but app.js toggled `.hidden` — the app
  // SHELL's mechanism. Every structural check passed (the listeners were all correctly attached) while
  // the panel stayed permanently off-canvas. Wiring a control to a panel nobody can see is invisible to
  // any assertion about wiring.
  const css = readFileSync(join(DIR, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const app = codeOf('app.js');
  const html = readFileSync(join(DIR, 'index.html'), 'utf8');

  // what the stylesheet says reveals it
  assert.ok(/\.drawer\s*\{[^}]*transform\s*:\s*translateX/.test(css), 'premise: .drawer is parked off-canvas by a transform');
  assert.ok(/\.drawer\.show\s*\{[^}]*transform\s*:\s*none/.test(css), 'premise: .drawer.show is what brings it back');

  // ...and that the code uses THAT class, on the drawer
  assert.ok(/\$\('drawer'\)|\bd\b/.test(app), 'app.js addresses the drawer');
  assert.ok(/classList\.add\('show'\)/.test(app), "app.js reveals the drawer with .show, not with some other class");
  assert.ok(/classList\.remove\('show'\)/.test(app), '...and hides it by removing the same one');

  // the markup must not ship `hidden` on the drawer: display:none would beat the transform entirely,
  // so the panel would stay invisible no matter what .show did
  const tag = html.match(/<aside[^>]*id="drawer"[^>]*>/);
  assert.ok(tag, 'the drawer element exists in the markup');
  assert.ok(!/\bhidden\b/.test(tag[0]), 'the drawer must not carry .hidden — display:none would override the reveal transform');

  // the app shell still uses .hidden, which is correct for IT — the two mechanisms must not be confused
  assert.ok(/id="app"[^>]*class="[^"]*hidden|class="app hidden"/.test(html), 'the app shell keeps its own display:none mechanism');
});

test('the review flow is wired to the SERVER diff, and captures the ack set at token time', () => {
  const app = codeOf('app.js');
  const html = readFileSync(join(DIR, 'index.html'), 'utf8');

  for (const id of ['scrim', 'mbody', 'revSub', 'pubback', 'pubbtn']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `index.html must contain #${id}`);
  }
  assert.ok(/\$\('review'\)\.addEventListener\('click'/.test(app), '"Revisar y publicar" has a click listener');
  assert.ok(/\beditCatalog\(/.test(app), '...that calls editCatalog — the review is the server\'s answer, not a local guess');
  assert.ok(/renderReview\(/.test(app) && /reviewModel\(/.test(app), '...and renders from the server diff');

  // THE ACK SET IS CAPTURED FROM THE RESPONSE, at the moment the token was minted. Rebuilding it later
  // from the rendered rows — or from the local draft — would replay something the token is not bound to.
  assert.ok(/ackSetFrom\(\s*res/.test(app), 'the ack set comes from the editCatalog RESPONSE, not from the draft or the DOM');
  assert.ok(!/ackSet\s*=\s*\[\s*\]/.test(app), '...and is never re-initialised to an empty literal after capture');

  // the CAS baseline must move forward, or a second review of the same draft reports stale_edit
  assert.ok(/sourceUpdateTime\s*=\s*res/.test(app), 'the new updateTime becomes the next precondition');

  // the modal is revealed by ITS OWN class — the same contract mistake as the drawer
  const css = readFileSync(join(DIR, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/\.scrim\.show|\.scrim\s*\{[^}]*display\s*:\s*none/.test(css), 'premise: .scrim has a reveal/hide rule');
  // SCOPED TO THE SUCCESS PATH. A file-wide match is satisfied by the error branch alone — which also
  // opens the modal — so removing the open from the success path would pass. Assert the ORDER: the
  // render happens, and the modal opens after it.
  const okOpen = app.indexOf('renderReview(');
  const openAfterRender = app.indexOf("$('scrim').classList.add('show')", okOpen);
  assert.ok(okOpen > -1, 'the success path renders the review');
  assert.ok(openAfterRender > okOpen, 'and opens the modal AFTER rendering it — not only in the error branch');
  assert.ok(app.slice(okOpen, openAfterRender).indexOf('catch') === -1,
    '...with no catch between them, so the open really belongs to the success path');
  assert.ok(/\$\('scrim'\)\.classList\.remove\('show'\)/.test(app), '...and closes it by removing the same class');
  assert.ok(/\$\('pubback'\)\.addEventListener\('click'/.test(app), '"Volver a editar" is wired');
});

test('the attestation is gated on the server capability flag, and it gates the publish button', () => {
  const app = codeOf('app.js');
  // 🔴 THE BRAND LITERAL, in the one place it would be accidentally correct. `rid === 'x_pizza'` is
  // true for exactly the restaurant that is fiscal today, so it would pass every functional test and
  // be wrong the day a third merchant joins the platform factura — in a browser, where it cannot be
  // corrected without a redeploy.
  assert.ok(/usesPlatformFactura:\s*state\.usesPlatformFactura/.test(app),
    'the attestation is given the SERVER flag');
  assert.ok(!/rid\s*===\s*['"]x_pizza['"]|['"]x_pizza['"]\s*===/.test(app),
    'and app.js contains no x_pizza literal deciding anything');
  assert.ok(!/BRAND\.fiscal/.test(app), "nor the mock's hard-coded BRAND.fiscal");

  // the flag must come from the catalog response, not be invented client-side
  assert.ok(/state\.usesPlatformFactura\s*=\s*\(data && data\.usesPlatformFactura\) === true/.test(app),
    'the flag is read from getEditableCatalog, strictly === true');

  // the publish button is DERIVED from canPublish, in one place
  assert.ok(/function syncPublishButton\(\)/.test(app), 'one function owns the publish button state');
  assert.ok(/canPublish\(/.test(app), '...and it asks canPublish');
  assert.ok(/\$\('pubbtn'\)\.disabled\s*=/.test(app), '...and actually sets disabled');
  // ...and the acknowledgement it passes is a literal boolean
  assert.ok(/acknowledged\s*=\s*v === true/.test(app), 'the acknowledgement is stored as a literal true, never a truthy');
});

test('#pubbtn actually publishes — and the gate is re-checked at click time', () => {
  // THE DEAD-BUTTON RISK. Task 5 rendered this button, Task 6 gates it; a control that looks armed
  // and does nothing is the worst outcome on a publish screen, because the merchant believes their
  // prices changed. Guarded explicitly so it cannot slip between tasks again.
  const app = codeOf('app.js');
  assert.ok(/\$\('pubbtn'\)\.addEventListener\('click'/.test(app), '#pubbtn has a click listener');
  assert.ok(/\bpublishEdited\(/.test(app), '...that calls publishEdited');
  assert.ok(/publishPayload\(/.test(app), '...with the payload built by the tested pure function');

  // scoped to the handler: "publishEdited appears in app.js" would be satisfied by an import alone
  const i = app.indexOf("$('pubbtn').addEventListener('click'");
  const handler = app.slice(i, i + 2200);
  assert.ok(/publishEdited\(/.test(handler), 'the CALL is inside the click handler, not merely imported');
  assert.ok(/canPublish\(/.test(handler),
    'the gate is re-checked at click time — `disabled` is a UI state that devtools can clear, and this button changes a tax document');
  assert.ok(/btn\.disabled = true/.test(handler), 'and the button locks during the request, so one reviewed set publishes once');

  // the payload must not be assembled at the call site — that is what publishPayload is for
  assert.ok(!/acknowledgedChanges\s*:/.test(handler), 'acknowledgedChanges is not rebuilt at the call site');
  assert.ok(!/fiscalAck\s*:/.test(handler), '...nor fiscalAck — both come from publishPayload');
});
