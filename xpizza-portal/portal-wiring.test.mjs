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
import { stateViolations, writerFunctions } from './wiring-ast.mjs';

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
    'async', 'else', 'do', 'try', 'yield', 'delete', 'void', 'in', 'of', 'instanceof', 'WeakSet']);
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
  // 🔴 #7-B — and it must key off the DRAFT, not the pending count. editCatalog persists the draft and
  // getEditableCatalog returns it, so a reloaded saved draft has a pending count of 0 while real
  // unpublished work sits on the server. A bar keyed to the count hides the merchant's own saved edits
  // behind a screen with no way back to them.
  const barToggle = app.match(/\$\('rbar'\)\.classList\.toggle\('show',\s*([^)]+)\)/);
  assert.ok(barToggle, 'something must actually show/hide the review bar');
  assert.match(barToggle[1], /state\.draft/, 'the review bar is reachable whenever a DRAFT exists');
  assert.doesNotMatch(barToggle[1], /pendingCount/, '🔴 never keyed to the pending count — that is the #7 dead end');
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
    'canEditDraft', 'commit', 'commitTo', 'createDraft', 'discard', 'draftSource', 'groupUsage', 'invalidKeys', 'isPublishable',
    'optionGroups', 'parsePrice', 'pendingChanges', 'pendingCount', 'productsUsingGroup',
    'setExtraPrice', 'setItemPrice',
  ], 'the edit state exports exactly these');
  // commit and discard are OPPOSITE operations on the same draft, and confusing them reverted a
  // published price. Both must exist, and the publish path must use commit.
  assert.ok(/export function commit\(/.test(editor) && /export function discard\(/.test(editor), 'both baseline operations exist');

  // 🔴 THE STATE BOUNDARY. Every user-editing mutator asks canEditDraft before touching anything, so a
  // retained or detached listener is refused at the state rather than at the DOM — where removing a
  // node does not remove its listeners and neither inert nor disabled stops a programmatic dispatch.
  assert.ok(/export const canEditDraft/.test(editor), 'the predicate exists and is shared');
  const setPriceBody = editor.slice(editor.indexOf('function setPrice('), editor.indexOf('function setPrice(') + 900);
  assert.ok(/if \(!canEditDraft\(draft\)\) return draft;/.test(setPriceBody), 'setPrice refuses when the draft is not owned for editing');
  const discardBody = editor.slice(editor.indexOf('export function discard('), editor.indexOf('export function discard(') + 400);
  assert.ok(/if \(!canEditDraft\(draft\)\) return draft;/.test(discardBody), '...and so does discard');
  // commit/commitTo must NOT be guarded — they run DURING a publish, when the lock is held by
  // definition, and guarding them would stop the publish recording what it published.
  const commitBody = editor.slice(editor.indexOf('export function commitTo('), editor.indexOf('export function commitTo(') + 300);
  assert.ok(!/canEditDraft/.test(commitBody), 'the baseline move is not an edit and is not guarded');
  // and app.js supplies the predicate from real ownership
  assert.ok(/canEdit: \(\) => editLockHolder === null/.test(app), 'app.js binds it to who owns the draft');
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
      // `const NAME = $('id')` — a captured reference. app.js holds these for buttons a panel render
      // detaches, since getElementById cannot find a detached node afterwards.
      let idExpr = expr;
      const alias = src.match(new RegExp(`const ${bound(expr)}\\s*=\\s*\\$\\('([^']+)'\\)`));
      if (alias) idExpr = `$('${alias[1]}')`;
      const byId = idExpr.match(/^\$\('([^']+)'\)$/);
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
  // `const diff = res && res.diff` then ackSetFrom(diff): still the RESPONSE, named once because the
  // review record is now minted in a single call rather than assembled field by field.
  assert.ok(/const diff = res && res\.diff/.test(app) && /ackSetFrom\(\s*diff\s*\)/.test(app),
    'the ack set comes from the editCatalog RESPONSE, not from the draft or the DOM');
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
  // ONE derivation, and it reads OWNERSHIP rather than being told. Every owned UI bit — the spinner,
  // the disabled state, the drawer's inertness — is answered from publisher.busy and editLockHolder,
  // so a stale continuation calling it paints the present rather than its own past.
  assert.ok(/function syncUi\(\)/.test(app), 'one function derives the owned UI');
  const ui = app.slice(app.indexOf('function syncUi'), app.indexOf('function syncUi') + 900);
  assert.ok(/publisher\.busy/.test(ui), 'the spinner is derived from whether a request is on the wire');
  assert.ok(/editLockHolder !== null/.test(ui), 'and the drawer\'s inertness from who owns the draft');
  assert.ok(/canPublish\(/.test(ui), '...and the publish gate from the attestation');
  assert.ok(/PUBBTN\.disabled\s*=/.test(ui), '...and it actually sets disabled');
  // 🔴 NO `finally` MAY CLEAR AN OWNED BIT — that is owning something that outlives your operation
  assert.ok(!/finally \{[^}]*dataset\.busy/.test(app), 'no finally clears the busy indicator');
  assert.ok(!/finally \{[^}]*setDrawerInert/.test(app), '...nor the drawer inertness');
  // ...and the acknowledgement it passes is a literal boolean
  assert.ok(/acknowledged\s*=\s*v === true/.test(app), 'the acknowledgement is stored as a literal true, never a truthy');
});

test('#pubbtn actually publishes, through a real in-flight lock', () => {
  // THE DEAD-BUTTON RISK plus THE DOUBLE-PUBLISH RACE. Task 5 rendered this button, Task 6 gates and
  // sends. A control that looks armed and does nothing is the worst outcome on a publish screen; a
  // control that sends twice is worse still on a fiscal one.
  const app = codeOf('app.js');
  assert.ok(/PUBBTN\.addEventListener\('click'/.test(app), '#pubbtn has a click listener, bound to the captured reference');

  // The click handler delegates to runPublish, so the assertions follow the delegation rather than
  // the name — the same correction the drawer needed when openDrawer became an entry point.
  assert.ok(/PUBBTN\.addEventListener\('click', runPublish\)/.test(app), 'the click handler IS the publish attempt');
  const i = app.indexOf('async function runPublish()');
  assert.ok(i > -1, 'runPublish exists as a named function, callable without a DOM lookup');
  const handler = app.slice(i, i + 1800);
  assert.ok(/publisher\.run\(/.test(handler), 'runPublish runs the publisher — the send is reached, not merely imported');
  // it must survive #pubbtn being DETACHED: a conflict panel replaces the footer, and RETRY re-enters
  // BOTH null-guards, specifically. A bare /if \(btn\)/ is satisfied by the `finally` clause alone,
  // so the entry path could still throw on a detached node and pass.
  // The button is no longer poked directly on either side: runPublish calls syncUi, which derives it.
  assert.ok(/syncUi\(\)/.test(handler), 'runPublish renders from ownership rather than setting the button itself');
  assert.ok(!/btn\.dataset\.busy\s*=/.test(handler), '...and never sets the spinner by hand');

  // the publisher is constructed with the REAL client, so the lock sits in front of the real send
  assert.ok(/createPublisher\(\s*\{\s*publish:[^}]*publishEdited\(/.test(app),
    'createPublisher is wired to publishEdited');

  // 🔴 THE GUARD IS NOT `disabled`. That is a UI state: devtools clears it, a dispatched click never
  // consults it. The lock must live in the publisher, taken before the await.
  assert.ok(!/if\s*\(\s*btn\.disabled\s*\)/.test(handler), 'the handler does not treat `disabled` as the guard');
  const review = codeOf('review.js');
  assert.ok(/let inFlight = false;/.test(review), 'the lock is a closure value in review.js');
  const runBody = review.slice(review.indexOf('async run(review)'));
  const lockAt = runBody.indexOf('inFlight = true');
  const awaitAt = runBody.indexOf('await publish(');
  assert.ok(lockAt > -1 && awaitAt > -1, 'both the lock and the send are present');
  assert.ok(lockAt < awaitAt, 'the lock is taken BEFORE the await — otherwise there is a window between deciding and sending');
  assert.ok(/if \(inFlight\) return/.test(runBody), '...and re-checked on entry');

  // TWO FLAGS, two jobs. `inFlight` says a request is on the wire and is released in `finally` —
  // the wire really is free once it settles, however it settled. `spent` says this reviewed set's
  // TOKEN is used and is set only on success. Collapsing them into one boolean was the T6 regression:
  // reset() then released a live request, re-opening the double-publish window.
  assert.ok(/let inFlight = false/.test(review), 'the overlap lock is a single global flag — one request on the wire at a time');
  assert.ok(/const spentTokens = new Set\(\)/.test(review),
    'and spent-ness is PER TOKEN — a shared boolean locked a NEW review out when an older publish settled');
  assert.ok(/finally \{\s*inFlight = false;/.test(runBody), 'the wire is freed in finally, whichever way the request settled');
  assert.strictEqual((runBody.match(/inFlight = false/g) || []).length, 1, 'and in exactly one place');
  assert.ok(/spentTokens\.add\(/.test(runBody), 'a SUCCESS marks THAT set published');
  assert.strictEqual((runBody.match(/spentTokens\.add\(/g) || []).length, 1, '...only on the success path, so a failure can be retried');
  assert.ok(/spentTokens\.has\(review\.editToken\)/.test(runBody), 'and a spent set is refused by its own token');
  // 🔴 NO RESET PATH AT ALL. A new review carries a new token and is free by construction, so there is
  // nothing to un-set — which removes the hazard of a release firing at the wrong moment.
  assert.ok(!/\breset\s*\(\s*\)\s*\{/.test(review), 'the publisher exposes no reset — the safest lock is one with no release path');
  assert.ok(!/publisher\.reset\(/.test(app), '...and nothing calls one');
  // No latch to reset: a newly minted review carries a NEW token, and the per-token set answers
  // "has this set published?" without anything having to be cleared.
  assert.ok(/editToken: res && res\.token/.test(app), 'a newly minted review takes the server\'s new token');

  // the payload must not be assembled at the call site — that is what publishPayload is for
  assert.ok(!/acknowledgedChanges\s*:/.test(handler), 'acknowledgedChanges is not rebuilt at the call site');
  assert.ok(!/fiscalAck\s*:/.test(handler), '...nor fiscalAck');
});

test('every publish state is wired — and edit_superseded re-reviews rather than retrying', () => {
  const app = codeOf('app.js');
  assert.ok(/showOutcome\(outcomeFor\(e, 'publish'\)\)/.test(app), 'a thrown publish error is routed to a designed panel, marked as a publish');
  assert.ok(/showOutcome\(outcomeFor\(e, 'edit'\)\)/.test(app), '...and an editCatalog failure is marked as an edit');
  // 🔴 RETRY must redo the operation that FAILED, not always the publish
  const soIdx2 = app.indexOf('function showOutcome');
  const retryBranch = app.slice(app.indexOf('PUBLISH_ACTIONS.RETRY', soIdx2), app.indexOf('PUBLISH_ACTIONS.RETRY', soIdx2) + 420);
  assert.ok(/outcome\.op === 'edit'/.test(retryBranch), 'RETRY branches on which operation failed');
  assert.ok(/openReviewFlow\(\)/.test(retryBranch), '...re-saving when the save failed');
  assert.ok(/renderOutcome\(/.test(app) && /renderReceipt\(/.test(app), 'both the panels and the receipt are rendered');

  // every action id the state machine can emit must be HANDLED here — an unhandled one is a button
  // that does nothing, on the screen a merchant reaches only after something already went wrong.
  const handler = app.slice(app.indexOf('function showOutcome'));
  for (const a of ['RELOAD', 'REREVIEW', 'BACK']) {
    assert.ok(new RegExp(`PUBLISH_ACTIONS\\.${a}`).test(handler), `${a} is handled`);
  }
  // 🔴 RETRY MUST NOT LOOK THE BUTTON UP. showOutcome replaces #revFoot's children to render the
  // panel, which DETACHES #pubbtn — getElementById does not find a detached node, so
  // `$('pubbtn').click()` was null.click() and RETRY threw instead of resending. The previous
  // assertion matched that exact string and passed: it proved the line was written, not that it ran.
  // the RETRY branch lives in showOutcome's action dispatch, not in runPublish
  const soIdx = app.indexOf('function showOutcome');
  assert.ok(soIdx > -1, 'showOutcome exists');
  const showBody = app.slice(soIdx, soIdx + 2000);
  const retryIdx = showBody.indexOf('PUBLISH_ACTIONS.RETRY');
  // An EXPLICIT branch, not a fall-through labelled by a comment: codeOf strips comments, so a
  // comment-only marker would make this assertion depend on prose rather than on code.
  assert.ok(retryIdx > -1, 'RETRY is an explicit branch in the action dispatch');
  const retryBody = showBody.slice(retryIdx);
  assert.ok(/runPublish\(\)/.test(retryBody), 'RETRY calls runPublish directly');
  assert.ok(!/\$\('pubbtn'\)/.test(retryBody),
    'and never looks up #pubbtn — the panel render detached it, so any lookup there is null');
  // 🔴 AND NEITHER DOES THE RESTORE. `replaceChildren(pubback, null)` does not throw: it STRINGIFIES
  // null into a text node, so the footer renders "Volver a editarnull" and the publish button is gone
  // for good. Verified in a browser. Every re-attach must use the captured reference.
  const restore = app.slice(app.indexOf('function restorePublishFooter'), app.indexOf('function restorePublishFooter') + 300);
  assert.ok(/replaceChildren\(PUBBACK, PUBBTN\)/.test(restore), 'the footer is restored from captured references');
  assert.ok(!/\$\('pubbtn'\)|\$\('pubback'\)/.test(restore), '...and never re-looks them up');
  // EXACTLY ONE lookup — the capture itself, which necessarily happens while the button is attached.
  // Every later use goes through the reference. "Zero lookups" would be wrong: the reference has to
  // come from somewhere.
  assert.strictEqual((app.match(/\$\('pubbtn'\)/g) || []).length, 1, 'exactly one lookup of #pubbtn in app.js');
  assert.ok(/const PUBBTN = \$\('pubbtn'\);/.test(app), '...and it is the capture, taken once at load');
  assert.ok(/restorePublishFooter\(\)/.test(retryBody), '...and puts the publish footer back first, so the merchant sees the normal UI');

  // 🔴 REREVIEW must go through the review flow (which calls editCatalog), NOT re-publish
  const rer = handler.slice(handler.indexOf('PUBLISH_ACTIONS.REREVIEW'));
  const nextBranch = rer.indexOf('PUBLISH_ACTIONS.BACK');
  const body = rer.slice(0, nextBranch === -1 ? 400 : nextBranch);
  assert.ok(/openReviewFlow\(\)/.test(body), 'edit_superseded re-opens the review, which re-calls editCatalog for a fresh token');
  assert.ok(!/publisher\.run|publishEdited/.test(body), '...and never re-sends the publish with the stale token');

  // the receipt reads the CAPTURED review, because the draft is discarded on success
  assert.ok(/const captured = state\.review/.test(app), 'the review is captured before the draft is thrown away');
  assert.ok(/receiptFor\(out\.res, captured\)/.test(app), '...and the receipt is built from it');
  const successIdx = app.indexOf('renderReceipt(');
  const commitIdx = app.indexOf('commitTo(state.draft', successIdx);
  assert.ok(commitIdx > successIdx, 'the receipt renders BEFORE the baseline moves');
  // 🔴 COMMIT, NOT DISCARD. They are opposite operations, and discard() here reset the editor to the
  // PRE-EDIT prices: it showed 299 after publishing 310, and the next unrelated edit carried 299 back
  // into the diff and silently reverted the price that had just gone live.
  const successPath = app.slice(successIdx, successIdx + 900);
  // 🔴 commitTo(SUBMITTED), not commit(live draft): if the merchant kept editing after opening the
  // review, what went live is what was REVIEWED, and the later edit must stay pending.
  assert.ok(/if \(captured && captured\.submitted\) commitTo\(state\.draft, captured\.submitted\)/.test(successPath),
    'the baseline becomes the SUBMITTED snapshot');
  // FAIL CLOSED: no fallback to the live draft, which would silently mark later edits as published
  assert.ok(!/commitTo\([^)]*\|\|/.test(successPath), 'and a missing snapshot leaves the baseline alone rather than guessing');
  assert.ok(!/\bcommit\(state\.draft\)/.test(successPath), '...not the live draft');
  assert.ok(!/discard\(state\.draft\)/.test(successPath), '...and never the pre-edit prices');
  // discard still exists — it is what the "Descartar" button legitimately does
  assert.ok(/\$\('discard'\)\.addEventListener/.test(app) && /discard\(state\.draft\)/.test(app),
    'discard remains wired to the Descartar button, where reverting IS the intent');

  // in-flight is visible, not just disabled
  // both halves, and the SET specifically: `delete btn.dataset.busy` matches a bare /dataset\.busy/,
  // so a file-wide check passes with the flag never set. Publishing is the one action where a merchant
  // who sees nothing happen presses again.
  // Set and unset by the SAME read, in one expression — so there is no state to forget to clear.
  assert.ok(/if \(waiting\) PUBBTN\.dataset\.busy = '1'; else delete PUBBTN\.dataset\.busy;/.test(app),
    'the spinner is derived in one expression, set and unset by the same read');
  // and `waiting` is world-relative: a request still on the wire for a world the merchant LEFT is not
  // something this world is waiting on.
  assert.ok(/const waiting = publisher\.busy && state\.publishGen === opGeneration;/.test(app),
    'the spinner asks whether THIS world is waiting, not whether anything is in flight');
});

test('no server error on the write path escapes the designed panels', () => {
  // codex #1, structurally. The behavioural half lives in review.test.mjs (every code, plus shapes
  // that are not codes, yields a panel). This half asserts the WRITE PATH routes into it: both calls
  // that can fail — editCatalog and publishEdited — hand their error to outcomeFor rather than to a
  // bespoke message box, an alert, or nothing.
  const app = codeOf('app.js');
  const catches = [...app.matchAll(/\}\s*catch\s*\(e\)\s*\{([\s\S]{0,400}?)\n\s{0,6}\}/g)].map((m) => m[1]);
  assert.ok(catches.length >= 3, `non-vacuity: the scan must find the catch blocks (${catches.length})`);

  // the two WRITE catches must route to the panels; the READ catches legitimately use showEmpty,
  // which is the 2b-2a surface for "your menu could not be loaded".
  const writeCatches = catches.filter((c) => /outcomeFor|showEmpty/.test(c));
  assert.ok(writeCatches.length >= 3, 'every catch resolves to a designed surface');
  const routed = catches.filter((c) => /showOutcome\(outcomeFor\(e, '(edit|publish)'\)\)/.test(c));
  assert.strictEqual(routed.length, 2, 'BOTH write calls — editCatalog and publishEdited — route to the panels');

  // and nothing anywhere reaches for an undesigned sink
  for (const f of JS) {
    const c = codeOf(f);
    assert.ok(!/\balert\s*\(/.test(c), `${f} must not use alert() — the mock does, for its Historial stub`);
    assert.ok(!/\bconfirm\s*\(/.test(c), `${f} must not use confirm() — a browser dialog is not a designed state`);
    assert.ok(!/\btoast\s*\(/.test(c), `${f} has no toast fallback — every state is a panel`);
  }
});

test('the mobile breakpoint covers the surfaces this slice added', () => {
  // Verified STATICALLY, and the reason is worth recording: the automation harness pins the layout
  // viewport at 1440 regardless of window size, so a real narrow-viewport render could not be forced
  // from here. Desktop light and dark WERE verified in a real browser; mobile layout is the one thing
  // in this smoke that rests on reading the rules rather than seeing them, and it is the owner's
  // device check at deploy.
  const css = readFileSync(join(DIR, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // EVERY 920px block, not the first. The stylesheet has several — one is a 56-character one-liner
  // (`@media(max-width:920px){.rbar{left:0}}`) that a first-match scan lands on and then fails its own
  // non-vacuity floor on. Same "the first occurrence is not the one you want" trap as the mutation
  // harnesses in Tasks 4 and 7.
  const blocks = [];
  const re = /@media\s*\(\s*max-width\s*:\s*920px\s*\)/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let d = 0, end = m.index;
    for (let j = css.indexOf('{', m.index); j < css.length; j++) {
      if (css[j] === '{') d++;
      else if (css[j] === '}' && --d === 0) { end = j; break; }
    }
    blocks.push(css.slice(m.index, end + 1));
  }
  assert.ok(blocks.length >= 1, 'the mobile breakpoint exists');
  const block = blocks.join('\n');
  assert.ok(block.length > 200, `non-vacuity: the blocks were extracted (${blocks.length} blocks, ${block.length} chars)`);

  // the two surfaces THIS slice added that are position-fixed and would otherwise sit off a narrow
  // screen: the review bar is offset by the sidebar width, and the drawer is a fixed-width panel.
  assert.ok(/\.rbar\s*\{[^}]*left\s*:\s*0/.test(block),
    'the review bar goes full-width on mobile — it is offset by the sidebar on desktop and would hang off otherwise');
  assert.ok(/max-width\s*:\s*93vw/.test(css),
    'the drawer is capped at 93vw, so it can never be wider than the screen');
  // and the shell itself reflows
  assert.ok(/\.app\s*\{/.test(block), 'the app shell reflows at the breakpoint');
});

test('an auth change invalidates the review, its acknowledgement and the latch', () => {
  // 🔴 FISCAL MISATTRIBUTION. An acknowledgement is a person's signature. Owner A ticks Autorizo,
  // signs out, owner B signs in on the same browser — without this, A's tick publishes under B's
  // token and the server records B as the SAR acknowledger.
  const app = codeOf('app.js');
  const boot = codeOf('boot.js');
  assert.ok(/portal:auth/.test(boot), 'boot.js emits an auth-change event');
  assert.ok(/uid: user \? user\.uid : null/.test(boot), '...carrying who is now signed in, or nobody');
  assert.ok(/document\.addEventListener\('portal:auth'/.test(app), 'app.js listens for it');

  const h = app.slice(app.indexOf("document.addEventListener('portal:auth'"));
  assert.ok(/invalidateReview\(\)/.test(h), 'and invalidates the review on every transition');
  const inv = app.slice(app.indexOf('function invalidateReview'), app.indexOf('function invalidateReview') + 420);
  assert.ok(/state\.review = null/.test(inv), 'the review — and with it the acknowledgement — is dropped');
  assert.ok(!/publisher\.reset\(\)/.test(inv), 'no reset call survives — the per-token design removed the need for one');
  assert.ok(/classList\.remove\('show'\)/.test(inv), 'and the open modal is closed');
  assert.ok(/state\.draft = null/.test(h), 'a different person does not inherit unpublished edits they never made');
});

test('a tenant switch cannot paint the previous restaurant’s data or fiscal flag', () => {
  // Codex reproduced la_musa selected while x_pizza's source AND usesPlatformFactura were on screen.
  // The server binding stops the bad WRITE; what this fixes is the merchant READING the wrong
  // tenant's fiscal context — and attesting against it.
  const app = codeOf('app.js');
  // ONE generation for every async operation, not a load-only one: the same staleness afflicts
  // editCatalog and publishEdited, and three separate counters would drift.
  assert.ok(/let opGeneration = 0/.test(app), 'a single operation generation exists');
  assert.ok(/const bumpGeneration =/.test(app), '...with one place that advances it');
  // Anchored on the DEFINITION, not the first mention: `invalidateReview` appears as a CALL inside
  // loadMenu long before it is defined, and a first-match slice lands there and finds nothing.
  // Each operation ends the previous world before taking its own generation. loadMenu does it THROUGH
  // invalidateReview (which bumps and also clears tenant-bound state), so the chain is asserted rather
  // than the literal call — and invalidateReview's own bump is asserted separately below.
  const endsWorld = { 'function invalidateReview': /bumpGeneration\(\)/, 'export async function loadMenu': /invalidateReview\(\)/, 'async function openReviewFlow': /bumpGeneration\(\)/ };
  for (const [decl, pattern] of Object.entries(endsWorld)) {
    const at = app.indexOf(decl);
    assert.ok(at > -1, `${decl} exists`);
    const b = app.slice(at, at + 700);
    assert.ok(pattern.test(b), `${decl} ends the previous world before starting a new one`);
  }
  // ORDER: the world must end BEFORE the generation is captured, or the bump invalidates the very
  // operation that just started. It did exactly that, and only an executable test showed it.
  const lmAt = app.indexOf('export async function loadMenu');
  const lmHead = app.slice(lmAt, lmAt + 700);
  assert.ok(lmHead.indexOf('invalidateReview()') < lmHead.indexOf('const gen = opGeneration'),
    'loadMenu ends the previous world BEFORE capturing its own generation');
  assert.ok((app.match(/gen !== opGeneration/g) || []).length >= 5,
    'every async settle re-checks it — success AND failure paths, on all three operations');
  const lm = app.slice(app.indexOf('export async function loadMenu'), app.indexOf('export async function loadMenu') + 1600);
  assert.ok(/const gen = opGeneration/.test(lm), 'each load captures the generation at launch');
  assert.ok((lm.match(/gen !== opGeneration/g) || []).length >= 2,
    'and BOTH the success and failure paths drop a stale response — an error from the tenant you left must not paint either');
  assert.ok(/invalidateReview\(\)/.test(lm), 'tenant-bound state is cleared immediately on switch, not after the load returns');
  assert.ok(/state\.usesPlatformFactura = false/.test(lm), '...including the fiscal capability, which must never carry across tenants');
  // the guard has to come BEFORE the draft is built from the response
  assert.ok(lm.indexOf('gen !== loadGeneration') < lm.indexOf('createDraft('), 'the stale check precedes painting');
});

test('the drawer cannot overlay the fiscal attestation', () => {
  // .drawer is z-index 26; the review scrim is 20. An open drawer therefore sits OVER the seal, and a
  // merchant could edit the underlying draft while signing for a snapshot taken before that edit.
  const css = readFileSync(join(DIR, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const z = (sel) => { const m = css.match(new RegExp(`\\${sel}\\s*\\{[^}]*z-index\\s*:\\s*(\\d+)`)); return m ? Number(m[1]) : null; };
  assert.ok(z('.drawer') > z('.scrim'), `premise: the drawer (${z('.drawer')}) really does stack above the review scrim (${z('.scrim')})`);
  const app = codeOf('app.js');
  assert.ok(/function closeDrawer\(\)/.test(app), 'closing the drawer is its own operation');
  const open = app.slice(app.indexOf('async function openReviewFlow'), app.indexOf('async function openReviewFlow') + 2600);
  assert.ok(/closeDrawer\(\)/.test(open), 'and the review closes it before opening');
});

// ── THE SHARED-STATE WRITER CENSUS ───────────────────────────────────────────────────────────────
// Six rounds of review each found one more surface that could write shared state from a stale world,
// and each was fixed where it was found. This is the check that ends that: a frozen census of EVERY
// writer in app.js, with a ruling for each. Add a writer, move one, delete one, and this fails until
// the new count is entered and its ruling stated.
//
// It cannot see whether a ruling is TRUE — that is what the executable tests do. What it guarantees is
// that no writer is ever added without one, which is the failure mode that actually kept recurring.
test('🔴 every shared-state writer in app.js is enumerated and ruled on', () => {
  const app = codeOf('app.js');

  // How each field is protected. Exactly three answers are acceptable:
  //   'canEdit'  — writes the DRAFT, refused by the state boundary in editor.js when it is not owned
  //   'bound'    — writes non-draft shared state from a callback, wrapped in reviewBound (captures the
  //                review identity AND the generation, refuses if either moved)
  //   'guarded'  — writes from an async settle path that re-checks the generation before mutating
  //   'view'     — writes state that is purely presentational; a stale write repaints, it cannot
  //                mis-price, mis-sign or mis-publish anything
  //   'ender'    — the code that ENDS a world (auth change, tenant switch, invalidation). It writes
  //                unconditionally on purpose; guarding it would be guarding the guard.
  const CENSUS = {
    'state.draft':               [3, 'canEdit', 'created on load, cleared by the auth ender AND at the start of a tenant switch; every MUTATION goes through editor.js'],
    'state.review':              [5, 'guarded', '🔴 DOWN FROM 9. The record is now minted in one call and is IMMUTABLE afterwards — the four writes that assembled it field by field (rid, attestation, acknowledged twice) are gone, and `acknowledged` is an accessor with no setter, so it cannot be written at all. What remains are whole-record assignments on generation-checked paths: one mint and four clears.'],
    'state.publishGen':          [2, 'guarded', 'set only on genuine admission inside runPublish, cleared by the ender'],
    'state.reviewLock':          [8, 'guarded', 'ticket bookkeeping; every write pairs with a take/release on a generation-checked path — the 7th releases a ticket acquired by a publish that was then refused, the 8th is endWrite handing back a ticket whose request settled into a world that had ended'],
    'state.currentRid':          [3, 'ender',   'the tenant switch and the auth handler — the two things that end a world'],
    'state.groups':              [3, 'guarded', 'the rendered menu, written only after the generation check on both settle paths'],
    'state.usesPlatformFactura': [2, 'guarded', '🔴 the fiscal capability — load path, behind the generation check'],
    'state.sourceUpdateTime':    [3, 'guarded', '🔴 the CAS baseline — load path and the save settle path, both generation-checked, plus the tenant-switch clear that stops one tenant\u2019s baseline being used to write another\u2019s document'],
    'state.uid':                 [1, 'ender',   'the auth handler itself — the identity change that ENDS the previous world'],
    'state.extras':              [1, 'guarded', 'the flat extras list, written by the load path behind the generation check'],
    'state.selectedCat':         [3, 'view',    'which category the rail highlights — a stale write repaints, it cannot mis-price'],
    'state.openGroups':          [3, 'view',    'which option groups are expanded in the drawer — one assignment plus the add/delete of the toggle; presentational only'],
    'state.drawerKey':           [3, 'view',    'which dish the drawer shows; the fields inside it are canEdit-guarded'],
    'state.restaurants':         [1, 'guarded', 'the switcher list, written by loadRestaurants behind its generation check'],
    'editLockHolder':            [4, 'guarded', 'the declaration, take, release, and the ender — which no longer clears it unconditionally: a ticket with a request on the wire is not the ender\u2019s to reclaim'],
    'writeSeq':                  [2, 'guarded', 'the monotonic source of request ids — declared once, incremented once, never reused, which is what makes a request id an identity rather than a label'],
    'pendingWrite':              [3, 'guarded', '🔴 SERVER-WRITE ADMISSION. The declaration, beginWrite and endWrite — set when a request is genuinely ADMITTED and cleared when THAT request settles, keyed on a per-request id rather than the reusable ticket, so a refused duplicate can neither claim nor surrender ownership of the wire'],
    'state.draftRid':            [2, 'guarded', '🔴 WHICH TENANT THE DRAFT IS. Written on the load settle path behind the generation check and cleared at the start of a switch; it is what the write path names, so a review can never carry one tenant\u2019s rid with another\u2019s source'],
    'state.menuLoading':         [3, 'guarded', 'loading represented explicitly rather than inferred from a null draft: set at the start of a switch, cleared on BOTH settle paths behind the generation check, and read by review admission'],
    'opGeneration':              [2, 'ender',   'the declaration and the += inside bumpGeneration — the only two, and bumping IS how a world ends'],
  };

  // Assignment, compound assignment, and mutating-method calls on the field itself.
  const writesOf = (target) => {
    const t = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 🔴 PREFIX increment included. It was not, and `++writeSeq` therefore counted as no writer at all
    // — the field census silently reporting one writer for a variable with two. Found by ruling a new
    // variable and having the count disagree, which is the census doing its job on itself.
    const re = new RegExp(`(?:^|[^\\w.])${t}(?:\\.\\w+)*\\s*(?:=[^=]|\\+=|-=|\\|\\|=|\\?\\?=|\\+\\+|--)|(?:\\+\\+|--)\\s*${t}\\b|(?:^|[^\\w.])${t}\\.(?:push|pop|splice|add|delete|clear|set|sort|shift|unshift)\\(|(?:let|const|var)\\s+${t}\\b`, 'g');
    return (app.match(re) || []).length;
  };

  // 1. Every censused field still has exactly the number of writers it was ruled on with.
  for (const [field, [count, ruling, why]] of Object.entries(CENSUS)) {
    assert.ok(['canEdit', 'bound', 'guarded', 'view', 'ender'].includes(ruling), `${field}: '${ruling}' is not a ruling`);
    assert.ok(why && why.length > 20, `${field} has a ruling but no reason — the reason is the point`);
    assert.strictEqual(writesOf(field), count,
      `🔴 the number of writers of ${field} changed (${writesOf(field)}, censused ${count}). ` +
      'Enter the new count and confirm the new writer is canEdit-guarded, reviewBound, generation-checked, or view-only.');
  }

  // 2. And no WRITTEN field of `state` exists that the census has never heard of. This is the half
  //    that catches a NEW surface, which is the one that kept getting missed.
  //
  //    Derived from every `state.<field>` in the file rather than from the declaration, because the
  //    declaration lists five fields and the object carries fourteen — the rest are attached where
  //    they are first needed. A parser trusting the literal would have vouched for nine fields it
  //    never looked at, which is the exact shape of every miss this census exists to prevent.
  const fields = [...new Set([...app.matchAll(/\bstate\.(\w+)/g)].map((m) => `state.${m[1]}`))];
  assert.ok(fields.length > 10, `sanity: the parser found the fields (${fields.length})`);
  for (const f of fields) {
    if (writesOf(f) === 0) continue;                 // read-only: nothing to rule on
    assert.ok(f in CENSUS, `🔴 ${f} is WRITTEN shared state with no ruling — add it to the census`);
  }

  // 3. Non-vacuity: the counter must actually be able to see a writer it is not looking at.
  assert.ok(writesOf('state.draft') > 0 && writesOf('state.nonexistent') === 0, 'the counter discriminates');
});

test('🔴 the acknowledgement cannot be written at all — it is an accessor with no setter', () => {
  // This guard used to count the RAW WRITES of state.review.acknowledged and check their shape. There
  // are now none to count: the field is a getter over a closure variable, and the only way in is a
  // function the minting call hands to exactly one bound callback.
  //
  // What is asserted here is therefore the construction, not the spelling — and the executable test in
  // app-loads proves the runtime behaviour, which is what actually protects the tax document.
  const app = codeOf('app.js');
  assert.strictEqual([...app.matchAll(/state\.review\.acknowledged\s*=(?!=)/g)].length, 0,
    '🔴 nothing writes the acknowledgement directly — if this fires, the lock has been routed around');
  assert.match(app, /Object\.defineProperty\(review, 'acknowledged', \{ get: \(\) => acknowledged/,
    '🔴 it is defined as a GETTER with no setter, so every form of assignment throws in strict mode');
  assert.match(app, /configurable: false/, '...and non-configurable, so it cannot be redefined or deleted');
  assert.match(app, /acknowledged = v === true/, 'the one writer stores a literal true, never a truthy');
  // the setter re-verifies provenance itself rather than trusting its caller to be bound
  const ack = app.slice(app.indexOf('const acknowledge = (v)'));
  assert.match(ack.slice(0, 300), /gen !== opGeneration/, 'and re-checks the generation at the moment of the write');
  assert.match(ack.slice(0, 300), /state\.review !== review/, '...and that this is still the open review');
  assert.match(app, /renderAttestation\([^\n]*bound\(/, 'the callback that holds it is still bound');
});

// ── THE LISTENER CENSUS ──────────────────────────────────────────────────────────────────────────
// The field census below counts WRITERS OF A FIELD. That is a genuine second layer, but it cannot
// close this class, for two reasons it is worth being explicit about:
//
//   • it is bypassable. Object.assign(state.review, {acknowledged: true}) adds a writer of the
//     acknowledgement and changes no count. So do state['review'], an alias, a destructure, and ||=.
//   • a count says nothing about WHERE. A writer moved out from behind its guard leaves the count
//     identical.
//
// So the real check is here, at the listener: every callback app.js hands to something that will
// hold it is enumerated, and each one either goes through bound() or carries an explicit ruling that
// names exactly which writes it is allowed to perform. A new write-listener fails the build until it
// is bound or ruled, which is what makes this a closure rather than another round of patches.

const maskLiterals = (src) => {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], c2 = src[i + 1];
    if (c === '/' && c2 === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && c2 === '*') { out += '  '; i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      out += c; i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      out += src[i] === undefined ? '' : c; i++; continue;
    }
    out += c; i++;
  }
  return out;
};
const spanFrom = (masked, open) => {
  let d = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') d++;
    else if (masked[i] === ')') { d--; if (d === 0) return i; }
  }
  return -1;
};

// Named entry points that write. Matched as BARE REFERENCES, not just calls: a callback handed over as
// `onPrice` writes exactly as much as one that calls it, and passing the identifier is precisely how
// the inline price cells stayed unbound while every call-shaped check looked clean.
const WRITERS = ['setItemPrice', 'setExtraPrice', 'discard', 'commit', 'commitTo', 'onPrice',
                 'loadMenu', 'loadRestaurants', 'openReviewFlow', 'runPublish', 'closeReview',
                 'invalidateReview', 'switchTo', 'bumpGeneration', 'takeEditLock', 'releaseEditLock',
                 'openDrawer', 'closeDrawer', 'toggle',
                 // 🔴 Added because the tree said so, not because anyone noticed. endWrite,
                 // repaintFromDraft and showOutcome all write state — endWrite and showOutcome by
                 // calling releaseEditLock and openReviewFlow — and a hand-maintained list had simply
                 // never caught up. That is the drift the cross-check below exists to end.
                 'endWrite', 'repaintFromDraft', 'showOutcome'];
function writesIn(code) {
  const m = maskLiterals(code);
  const found = new Set();
  for (const fn of WRITERS) if (new RegExp(`\\b${fn}\\b`).test(m)) found.add(fn);
  for (const g of m.matchAll(/\bstate\s*\.\s*(\w+)(?:\s*\.\s*\w+)*\s*(?:\+\+|--|(?:\+|-|\*|\/|\|\||&&|\?\?)?=(?!=))/g)) found.add(`state.${g[1]}`);
  if (/\bstate\s*\[/.test(m)) found.add('state[computed]');                                   // bracket write
  if (/Object\s*\.\s*assign\s*\(\s*(state|draft|\w*[Dd]raft)/.test(m)) found.add('Object.assign');
  for (const g of m.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*state\b(?!\s*\.)/g)) found.add(`alias:${g[1]}`);
  if (/\b(?:const|let|var)\s+\{[^}]*\}\s*=\s*state\b/.test(m)) found.add('destructure:state');
  if (/\beditLockHolder\s*=(?!=)/.test(m)) found.add('editLockHolder');
  if (/\bopGeneration\s*(?:\+\+|--|(?:\+|-)?=(?!=))/.test(m)) found.add('opGeneration');
  return found;
}
function registrations(src) {
  const m = maskLiterals(src);
  const out = [];
  // 🔴 STRUCTURAL depth, not indentation. Column 0 is a formatting fact and says nothing about scope:
  // a registration nested inside a function can be written flush-left and a module-level one indented,
  // and either way the reader — and the guard — would be told the wrong thing.
  const d = depths(m);
  const at = (i) => ({ brace: d.brace[i], line: src.slice(0, i).split('\n').length });
  for (const g of m.matchAll(/\.addEventListener\s*\(/g)) {
    const open = g.index + g[0].length - 1, end = spanFrom(m, open);
    const recv = (src.slice(0, g.index).match(/([A-Za-z_$][\w$]*|\$\(\s*'[^']*'\s*\))\s*$/) || [, '?'])[1].replace(/\s+/g, '');
    const raw = src.slice(open + 1, end);
    const ev = (raw.match(/^\s*'([^']+)'/) || [, '?'])[1];
    const head = raw.match(/^\s*'[^']+'\s*,/);
    out.push({ key: `${recv}::${ev}`, handler: raw.replace(/^\s*'[^']+'\s*,/, ''), start: open + 1 + (head ? head[0].length : 0), ...at(g.index) });
  }
  for (const g of m.matchAll(/\brender(Rail|Detail|Attestation|Outcome)\s*\(/g)) {
    const open = g.index + g[0].length - 1, end = spanFrom(m, open);
    out.push({ key: `render${g[1]}::callback`, handler: src.slice(open + 1, end), start: open + 1, ...at(g.index) });
  }
  return out;
}

// ruling: 'bound'       — a per-render callback that writes; MUST go through bound()
//         'singleton'   — registered once at module load on a node that is never re-created, so there
//                         is only ever one and it always belongs to the current world. Protected by
//                         canEdit and admission control instead. Enforced: must sit at column 0.
//         'view'        — writes only presentational state; a stale one repaints, it cannot mis-price
//         'revalidated' — re-checks its target against CURRENT state and refuses a stale one
//         'ender'       — the code that ends a world; it writes unconditionally on purpose
const LISTENERS = {
  "item::click":                  ['revalidated', ['switchTo'], 'switchTo re-checks the rid against the CURRENT state.restaurants and refuses one the merchant does not own; re-selecting the current tenant is a no-op. Binding the tenant switcher to the world it was rendered in would refuse the one action whose whole purpose is to leave that world.'],
  "close::click":                 ['view', ['state.drawerKey'], 'closes the drawer; presentational only'],
  "input::input":                 ['bound', [], 'the item price field'],
  "main::click":                  ['view', ['toggle'], 'expands an option group'],
  "chev::click":                  ['view', ['toggle'], 'expands an option group'],
  "pi::input":                    ['bound', [], 'the option price field'],
  "document::portal:signed-in":   ['singleton', ['loadRestaurants'], 'boot'],
  "document::portal:restaurant":  ['singleton', ['loadMenu'], 'the tenant switch, dispatched by switchTo which has already revalidated'],
  "$('switcher')::click":         ['view', [], 'opens the tenant menu'],
  "document::click":              ['view', [], 'closes the tenant menu on an outside click'],
  "$('discard')::click":          ['singleton', ['discard', 'closeDrawer', 'repaintFromDraft'], 'throws away local edits — a DRAFT write, refused by the canEdit boundary whenever an operation owns the draft'],
  "$('review')::click":           ['singleton', ['openReviewFlow'], 'admission-controlled: it acquires the edit lock or returns'],
  "$('pubback')::click":          ['singleton', ['closeReview'], 'closing is refused while this world has a publish in flight'],
  "PUBBTN::click":                ['singleton', ['runPublish'], 'admission-controlled, and validates a current review before acquiring'],
  "document::portal:auth":        ['ender', ['invalidateReview', 'repaintFromDraft', 'state.draft', 'state.groups', 'state.currentRid', 'state.uid'], 'the identity change that ENDS a world; it clears, then repaints what follows'],
  "renderRail::callback":         ['view', ['state.selectedCat'], 'which category the rail highlights'],
  "renderDetail::callback":       ['bound', ['openDrawer'], 'the inline price cells. onPrice is bound AT THE CALL SITE — the function itself belongs to no world — and is deliberately NOT listed here, so the lexical check requires it to sit inside the wrapper. openDrawer is listed: it writes only which dish the drawer shows.'],
  "renderAttestation::callback":  ['bound', [], '🔴 the acknowledgement — nothing here is allowed outside the wrapper'],
  "renderOutcome::callback":      ['bound', [], 'the recovery controls — real transitions, not messages, and every one of them inside the wrapper'],
};

test('🔴 every listener that writes is bound, or ruled — and nothing else is registered', () => {
  const src = readFileSync(join(DIR, 'app.js'), 'utf8');
  const regs = registrations(src);
  assert.ok(regs.length >= 15, `sanity: the scanner found the registrations (${regs.length})`);

  const seen = new Set();
  for (const r of regs) {
    const rule = LISTENERS[r.key];
    assert.ok(rule, `🔴 app.js:${r.line} registers ${r.key} with no ruling. Bind it with bound(), or add it to LISTENERS naming exactly which writes it may perform.`);
    seen.add(r.key);
    const [ruling, allow, why] = rule;
    assert.ok(why && why.length > 3, `${r.key}: a ruling with no reason`);

    if (ruling === 'bound') {
      assert.match(r.handler, /\bbound\s*\(/,
        `🔴 app.js:${r.line} — ${r.key} is ruled 'bound' but does not go through bound(). A retained copy of it writes into whatever world is current when it fires.`);
      continue;
    }
    // Everything else must stay inside the writes its ruling declared.
    for (const w of writesIn(r.handler)) {
      assert.ok(allow.includes(w),
        `🔴 app.js:${r.line} — ${r.key} is ruled '${ruling}' but now writes ${w}, which its ruling does not allow. Bind it, or re-rule it deliberately.`);
    }
    if (ruling === 'singleton') {
      assert.strictEqual(r.brace, 0,
        `🔴 app.js:${r.line} — ${r.key} is ruled 'singleton' (registered once, on a node that is never re-created) but it sits at brace depth ${r.brace}, i.e. inside a function body, so it is registered once PER CALL. It needs bound().`);
    }
  }
  for (const key of Object.keys(LISTENERS)) assert.ok(seen.has(key), `${key} is ruled but no longer registered — remove the dead ruling`);
});

test('🔴 the write detector sees what the field census cannot', () => {
  // The field census counts `state.<field> =` occurrences. Each fixture below adds a writer of the
  // acknowledgement — the most dangerous field in the portal — without changing that count. If the
  // detector cannot see these, the listener census inherits the same blind spot and closes nothing.
  const BYPASSES = [
    ['Object.assign(state.review, { acknowledged: true });', 'Object.assign'],
    ["state['review'].acknowledged = true;",                 'state[computed]'],
    ['const s = state; s.review.acknowledged = true;',        'alias:s'],
    ['const { review } = state; review.acknowledged = true;', 'destructure:state'],
    ['state.review.acknowledged ||= true;',                   'state.review'],
    ['state.publishGen++;',                                   'state.publishGen'],
    ['state.review.acknowledged = true;',                     'state.review'],
    ['onPrice',                                               'onPrice'],          // a bare handoff
    ['setExtraPrice(d, k, v)',                                'setExtraPrice'],
    ['editLockHolder = null;',                                'editLockHolder'],
  ];
  for (const [code, expected] of BYPASSES) {
    assert.ok(writesIn(code).has(expected), `🔴 the detector missed: ${code}`);
  }
  // ...and does NOT fire on writes that are only mentioned, which is how a comment-blind guard
  // manufactures a false pass. Three separate guards in this slice failed exactly this way.
  assert.strictEqual(writesIn('// state.review = null;').size, 0, 'a comment is not a write');
  assert.strictEqual(writesIn("log('state.review = null');").size, 0, 'a string is not a write');
  assert.strictEqual(writesIn('const x = state.review.acknowledged;').size, 0, 'a READ is not a write');
});

// ── LEXICAL ENFORCEMENT ──────────────────────────────────────────────────────────────────────────
// The listener census above asks whether `bound(` APPEARS in a registration. That is not the same
// question as whether the WRITER IS INSIDE IT, and the difference is a real hole: bind a no-op, leave
// the write next to it, and the text still contains `bound(`.
//
// These three checks close it structurally. They work on a masked copy of the source — strings and
// comments blanked, structure preserved — and the first thing asserted is that the masking is sound,
// because every claim below rests on it.

// Depth of nesting at each index, computed once. Structural, not textual: this is what makes "inside
// the wrapper" and "at module scope" answerable rather than guessed at from indentation.
function depths(masked) {
  const paren = new Int32Array(masked.length);
  const brace = new Int32Array(masked.length);
  let p = 0, b = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') p++; else if (c === '{') b++;
    paren[i] = p; brace[i] = b;
    if (c === ')') p--; else if (c === '}') b--;
  }
  return { paren, brace, endParen: p, endBrace: b };
}
// Every [start,end) span covered by a bound( ... ) argument list.
function boundSpans(masked) {
  const spans = [];
  for (const g of masked.matchAll(/\bbound\s*\(/g)) {
    const open = g.index + g[0].length - 1;
    const end = spanFrom(masked, open);
    if (end > open) spans.push([open, end]);
  }
  return spans;
}
// Where a protected write happens, not merely whether one does.
function writePositions(masked) {
  const out = [];
  const add = (re, name) => { for (const g of masked.matchAll(re)) out.push({ pos: g.index, token: name || g[0].trim() }); };
  // `onPrice:` as an object KEY is a handoff site, not a write — and `bound(onPrice)` sits right
  // beside it, so counting the key would report the wrapper's own argument as being outside itself.
  for (const fn of WRITERS) {
    for (const g of masked.matchAll(new RegExp(`\\b${fn}\\b(?!\\s*:)`, 'g'))) out.push({ pos: g.index, token: fn });
  }
  add(/\bstate\s*\.\s*\w+(?:\s*\.\s*\w+)*\s*(?:\+\+|--|(?:\+|-|\*|\/|\|\||&&|\?\?)?=(?!=))/g, 'state-write');
  add(/\bstate\s*\[/g, 'state[computed]');
  add(/Object\s*\.\s*assign\s*\(\s*(?:state|draft)/g, 'Object.assign');
  add(/\beditLockHolder\s*=(?!=)/g, 'editLockHolder');
  add(/\bpendingWrite\s*=(?!=)/g, 'pendingWrite');
  return out;
}

test('🔴 the masking is sound — every structural claim below depends on it', () => {
  const masked = maskLiterals(readFileSync(join(DIR, 'app.js'), 'utf8'));
  const d = depths(masked);
  // If a quote, comment or brace were mis-tokenised, the depths would not return to zero. This is the
  // cheapest possible proof that the scanner is reading the file the way JavaScript does.
  assert.strictEqual(d.endParen, 0, 'parentheses balance across the masked file');
  assert.strictEqual(d.endBrace, 0, 'braces balance across the masked file');
  // ...and it really did blank the literals, rather than getting lucky on a file with none.
  assert.ok(!/Cargando tu men/.test(masked), 'string CONTENTS are masked');
  assert.ok(/showEmpty\('/.test(masked), 'while the code around them is not');
});

test('🔴 no writer sits outside the wrapper that is supposed to contain it', () => {
  // The check the registration-text version could not make. For every listener ruled 'bound', every
  // protected write in its handler must be lexically INSIDE a bound( ... ) span — so binding a no-op
  // and leaving the write beside it fails, which is precisely how this guard would otherwise be
  // satisfied without protecting anything.
  const src = readFileSync(join(DIR, 'app.js'), 'utf8');
  const masked = maskLiterals(src);
  const spans = boundSpans(masked);
  assert.ok(spans.length >= 4, `sanity: the scanner found the wrappers (${spans.length})`);
  const inside = (pos) => spans.some(([a, b]) => pos > a && pos < b);

  let checked = 0;
  for (const r of registrations(src)) {
    const rule = LISTENERS[r.key];
    if (!rule || rule[0] !== 'bound') continue;
    const start = r.start;
    for (const w of writePositions(masked.slice(start, start + r.handler.length))) {
      const abs = start + w.pos;
      assert.ok(inside(abs) || rule[1].includes(w.token),
        `🔴 ${r.key} is ruled 'bound', but its write of ${w.token} at app.js:${src.slice(0, abs).split('\n').length} is OUTSIDE the bound() wrapper and its ruling does not name it. A wrapper the writer is not inside protects nothing.`);
      checked++;
    }
  }
  assert.ok(checked >= 4, `sanity: writes were actually located and checked (${checked})`);
});


// ── THE RESTRICTED GRAMMAR: DENY BY DEFAULT ──────────────────────────────────────────────────────
// Every guard before this one asked "does the source contain a known-bad shape?" — Object.assign, a
// bracket write, an alias, ||=. That is a blocklist, and a blocklist is a list of the bypasses someone
// has already thought of. Each round produced one more.
//
// This inverts it. Every syntactic context in which `state` (or a binding aliased from it) appears is
// classified, and the classification must be one of a short list of shapes proven safe. Anything the
// classifier cannot place — a new operator, a new method, a new way of reaching the object — is
// REJECTED because it was not proven safe, not because it was recognised as dangerous.
//
// The practical consequence: `&&=`, `??=`, `.at()`, a spread-assign, or whatever the next syntax form
// turns out to be, fails without anyone having to anticipate it.

// Redundant parentheses around a bare identifier are removed, repeatedly and length-preservingly, so
// (r).x, ((r)).x and r.x all reduce to the one shape the classifier understands. Parenthesisation is
// otherwise an unbounded family of spellings for the same write.
function unparen(m) {
  let prev;
  do { prev = m; m = m.replace(/\(\s*([A-Za-z_$][\w$]*)\s*\)/g, (t, id) => ' '.repeat(t.length - id.length - 1) + id + ' '); } while (m !== prev);
  return m;
}
const ASSIGN_OP = /^(?:\+\+|--|(?:\+|-|\*|\/|%|\*\*|\|\||&&|\?\?|&|\||\^|<<|>>|>>>)?=(?![=>]))/;
const KEYWORDS = new Set(['if', 'while', 'for', 'switch', 'return', 'typeof', 'await', 'new', 'delete', 'void', 'of', 'in']);

function classifyAt(m, i, root) {
  let j = i + root.length;
  const chain = [root];
  for (;;) {
    let k = j; while (m[k] === ' ' || m[k] === '\n') k++;
    if (m[k] !== '.') break;
    k++; while (m[k] === ' ' || m[k] === '\n') k++;
    const g = /^[A-Za-z_$][\w$]*/.exec(m.slice(k));
    if (!g) break;
    chain.push(g[0]); j = k + g[0].length;
  }
  let k = j; while (m[k] === ' ' || m[k] === '\n') k++;
  const rest = m.slice(k);
  const before = m.slice(Math.max(0, i - 80), i);
  if (/\b(?:const|let|var)\s*[{[][^}\]]*[}\]]\s*=\s*$/.test(before)) return { kind: 'destructure', chain };
  if (rest.startsWith('[')) return { kind: 'computed', chain, index: rest.slice(1, rest.indexOf(']')) };
  if (ASSIGN_OP.test(rest)) return { kind: 'write', chain, op: ASSIGN_OP.exec(rest)[0], pos: i };
  if (rest.startsWith('(') && chain.length > 1) return { kind: 'method', chain, pos: i };
  const decl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before);
  if (decl && /^[;,)\n]/.test(rest)) return { kind: 'alias', chain, name: decl[1] };
  const call = /([A-Za-z_$][\w$.]*)\s*\(\s*$/.exec(before);
  if (call && !KEYWORDS.has(call[1])) return { kind: 'arg', chain, callee: call[1], pos: i };
  return { kind: 'read', chain, pos: i };
}
const occurrencesOf = (m, root, from = 0, to = Infinity) =>
  [...m.matchAll(new RegExp(`(?<![\\w$.])${root}(?![\\w$])`, 'g'))].map((g) => g.index).filter((i) => i >= from && i <= to);

// 🔴 AN ALIAS IS SCOPED, and checking it by name across the whole file is wrong in both directions.
// `r` is a state alias in syncUi and an ordinary lambda parameter in three other places; `draft`,
// `held` and `captured` collide the same way. A name-global check reports those as writes through an
// alias (they are not) and would equally miss a real one hidden behind a shadowing declaration.
//
// The alias's scope is the innermost block containing its declaration, derived from the brace depths
// rather than from indentation or proximity.
function blockAround(m, i) {
  const d = depths(m);
  const level = d.brace[i];
  let start = 0;
  for (let k = i; k >= 0; k--) if (m[k] === '{' && d.brace[k] === level) { start = k; break; }
  let end = m.length - 1;
  for (let k = i; k < m.length; k++) if (m[k] === '}' && d.brace[k] === level) { end = k; break; }
  return [start, end];
}

// ── THE ALLOWLIST. Every entry is a shape someone deliberately ruled safe. ──
// Calls that may receive `state` or a state property. Each is either a pure reader or one of the
// editor's guarded setters, which enforce the canEdit boundary themselves.
const ALLOWED_CONSUMERS = new Set([
  'setItemPrice', 'setExtraPrice', 'discard', 'commit', 'commitTo',      // guarded setters (canEdit)
  'draftSource', 'pendingChanges', 'pendingCount', 'isPublishable',      // pure readers of the draft
  'optionGroups', 'groupUsage', 'canEditDraft', 'createDraft',
  'reviewModel', 'attestationModel', 'publisher.run', 'pickRid', 'canPublish',   // pure readers of the review
  'releaseEditLock', 'loadMenu',                                         // take an id / a rid, not the object
]);
// Method calls on a state property, enumerated by FULL CHAIN rather than by method name — so a
// mutating method is permitted on exactly the collection it was ruled for and nowhere else.
const ALLOWED_METHOD_CHAINS = new Set([
  'state.restaurants.find', 'state.restaurants.some',
  'state.groups.find', 'state.groups.some',
  'state.openGroups.has',
  'state.openGroups.add', 'state.openGroups.delete',   // the group toggle; counted by the field census
]);

function grammarViolations(src) {
  const m = unparen(maskLiterals(src));
  const bad = [];
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  const aliases = [];

  const check = (root, isAlias, from = 0, to = Infinity) => {
    for (const i of occurrencesOf(m, root, from, to)) {
      // The alias's own declaration site reads as `name =`, which is a binding, not a write through
      // the binding. Skipping it is the difference between checking the alias and checking the
      // statement that creates it.
      if (isAlias && /\b(?:const|let|var)\s+$/.test(m.slice(Math.max(0, i - 12), i))) continue;
      const c = classifyAt(m, i, root);
      const at = `app.js:${lineOf(i)}`;
      const shown = c.chain.join('.');
      switch (c.kind) {
        case 'read': break;                                        // ALLOWED
        case 'alias': {
          if (isAlias) { bad.push(`${at}: ${shown} is aliased again as \`${c.name}\` — one hop is the limit`); break; }
          const [bs, be] = blockAround(m, i);
          // A second binding of the same name inside the alias's own scope would make "which `r` is
          // this?" unanswerable without real name resolution. Rejected rather than guessed at.
          //
          // Only unambiguous BINDINGS count: a declaration, or a parameter list proven to be one by
          // the `=>` that follows it. `f(x, captured)` is an argument and binds nothing — reading it
          // as a parameter is how this check first reported a shadow that did not exist.
          const scope = m.slice(bs, be);
          const decls = (scope.match(new RegExp(`\\b(?:const|let|var)\\s+${c.name}\\b`, 'g')) || []).length;
          const params = new RegExp(`\\(\\s*${c.name}\\s*(?:,[^)]*)?\\)\\s*=>`).test(scope);
          if (decls > 1 || params) bad.push(`${at}: \`${c.name}\` is bound more than once inside the scope where it aliases ${shown} — give the alias its own name`);
          aliases.push({ name: c.name, from: bs, to: be });         // ALLOWED, and its uses get checked too
          break;
        }
        case 'arg':
          if (!ALLOWED_CONSUMERS.has(c.callee)) bad.push(`${at}: ${shown} is passed to \`${c.callee}(\`, which is not a ruled consumer of state`);
          break;
        case 'method':
          if (isAlias || !ALLOWED_METHOD_CHAINS.has(shown)) bad.push(`${at}: \`${shown}(\` is not a ruled method on state`);
          break;
        case 'computed':
          // An array index is a read. A computed PROPERTY NAME is how a write hides from every guard
          // that counts `state.<field>`, so it is never allowed.
          if (isAlias || c.chain.length < 2 || !/^\s*\d+\s*$/.test(c.index)) bad.push(`${at}: \`${shown}[${c.index}]\` — computed access to a state property is not a ruled shape`);
          break;
        case 'destructure':
          bad.push(`${at}: \`${shown}\` is destructured — the binding escapes every check that names the field`);
          break;
        case 'write':
          if (isAlias) { bad.push(`${at}: written through the alias \`${root}\` — write through state.<field> directly`); break; }
          // ONLY a plain `=`, and only onto a named property. Compound assignment is not on the list —
          // which is what makes ||=, &&=, ??= and every future one fail without being enumerated.
          if (c.op !== '=') bad.push(`${at}: \`${shown} ${c.op}\` — only plain assignment to a state property is a ruled shape`);
          else if (c.chain.length < 2) { if (!/export\s+const\s+state\s*=/.test(src.slice(Math.max(0, i - 40), i + 20))) bad.push(`${at}: \`state\` itself is assigned`); }
          else if (c.chain.length > 3) bad.push(`${at}: \`${shown} =\` reaches deeper than a state field and its property`);
          break;
        default: bad.push(`${at}: \`${shown}\` could not be classified, so it is not proven safe`);
      }
    }
  };
  check('state', false);
  for (const a of aliases) check(a.name, true, a.from, a.to);
  return bad;
}



// ── THE AST GUARD ────────────────────────────────────────────────────────────────────────────────
// A text scanner cannot be deny-by-default. To reject the unrecognised it must first recognise
// everything, so "a context I could not parse" necessarily falls through to safe — and three separate
// bypasses got in exactly there, each a syntax form the previous version had not been told about.
//
// wiring-ast.mjs reads app.js as a syntax tree with real lexical binding resolution, classifies every
// reference to `state` (and to anything aliased from it) by its position in the tree, and ends its
// switch in a REJECT. There is no fall-through to safe, so there is no next syntax form.

test('🔴 every reference to `state` in app.js reduces to a proven-safe shape', () => {
  const bad = stateViolations(readFileSync(join(DIR, 'app.js'), 'utf8'));
  assert.deepStrictEqual(bad, [], `🔴 app.js reaches state in ways the analysis cannot prove safe:\n  ${bad.join('\n  ')}`);
});

test('🔴 the AST guard rejects constructs nobody told it about', () => {
  const mod = (body) => `import { setItemPrice, draftSource } from './editor.js';\nexport const state = { review: null, groups: [], publishGen: 0 };\nfunction f(obj) {\n  ${body}\n}\n`;   // the imports make a RESOLVED consumer available, so a local of the same name shadows it
  const REJECTED = [
    // ── the whole-gate reproduction: a reference parked in a container, reached by computed key ──
    ['const box = { r: state.review }; box["r"].acknowledged = true;',   'escapes into a container'],
    ['const box = [state.review]; box[0].acknowledged = true;',          'escapes its scope'],
    // ── the three that defeated the regex, kept as regression fixtures ──
    ['Object.assign(state.review, { acknowledged: true });',             'not a ruled consumer'],
    ['const r = state.review; Object.assign(r, { a: 1 });',              'not a ruled consumer'],
    ['const r = state.review; (r).acknowledged ||= true;',               'through the alias'],
    // ── complete assignment targets, including destructuring ──
    ['({ acknowledged: state.review.acknowledged } = obj);',             'state'],
    ['[state.publishGen] = [1];',                                        'state'],
    ['const { review } = state; review.acknowledged = true;',            'destructured'],
    ['const [g] = state.groups; g.x = 1;',                               'destructured'],
    ['({ ...state.review } = obj);',                                     'state'],
    // ── prefix AND postfix updates ──
    ['state.publishGen++;',                                              'only plain assignment'],
    ['++state.publishGen;',                                              'only plain assignment'],
    ['state.publishGen--;',                                              'only plain assignment'],
    // ── every compound operator, named and unnamed ──
    ['state.review.acknowledged ||= true;',                              'only plain assignment'],
    ['state.review.acknowledged &&= true;',                              'only plain assignment'],
    ['state.review.acknowledged ??= true;',                              'only plain assignment'],
    ['state.publishGen += 1;',                                           'only plain assignment'],
    ['state.publishGen >>>= 1;',                                         'only plain assignment'],
    // ── computed member chains ──
    ['state["review"].acknowledged = true;',                             'computed access'],
    ['const k = "review"; state[k].acknowledged = true;',                'computed access'],
    ['state.groups[0].price = 1;',                                       'computed access'],
    // ── template interpolation, plain and tagged ──
    ['const s = `${state.review.acknowledged = true}`; void s;',         'stand alone as a statement'],
    ['const s = tag`${state.review}`; void s;',                          'not a ruled context'],   // a TAGGED template hands the value to the tag
    // ── every call argument, not just the first; and the comma operator ──
    ['sneak(1, 2, state.review);',                                       'not a ruled consumer'],
    ['sneak((0, state.review));',                                        'not a ruled consumer'],
    ['(state.review.acknowledged = true, 0);',                           'stand alone as a statement'],
    ['sneak(true ? state.review : null);',                               'not a ruled consumer'],
    ['sneak(state.review ?? null);',                                     'not a ruled consumer'],
    ['sneak(obj || state.review);',                                      'not a ruled consumer'],
    // ── accessors and returned-reference escapes ──
    ['return state.review;',                                             'escapes its scope'],
    ['const get = () => state.review; get().acknowledged = true;',       'escapes its scope'],
    ['const o = { get r() { return state.review; } }; void o;',          'escapes its scope'],
    ['Object.defineProperty(state, "review", { value: 1 });',            'not a ruled consumer'],
    ['const p = new Proxy(state, {}); p.review = 1;',                    'not a ruled consumer'],
    // ── reference escapes into containers and calls ──
    ['sneak({ ...state.review });',                                      'escapes its scope'],
    ['const arr = [state.review]; void arr;',                            'escapes its scope'],
    ['state.groups.push(1);',                                            'not a ruled method'],
    ['state.groups.sort();',                                             'not a ruled method'],
    // ── depth, second-hop aliases, and the root itself ──
    ['state.review.a.b.c = 1;',                                          'reaches deeper'],
    ['const r = state.review; const r2 = r; r2.acknowledged = 1;',       'through the alias'],
    ['const s2 = state; s2.review = null;',                              'through the alias'],
  ];
  for (const [body, expect] of REJECTED) {
    const bad = stateViolations(mod(body), 'fixture');
    assert.ok(bad.length > 0, `🔴 the AST guard ADMITTED: ${body}`);
    assert.ok(bad.some((b) => b.includes(expect)), `wrong reason for "${body}": ${bad.join(' | ')}`);
  }

  // ...and it accepts the shapes the portal is actually written in, or it would be useless.
  for (const ok of [
    'state.review = null;',
    'state.review.acknowledged = true;',
    'const r = state.review; if (r && r.editToken) return r.editToken;',
    'setItemPrice(state.review, 1, 2);',
    'const g = state.groups.find((x) => x.id === 1); void g;',
    'if (state.review) return 1;',
    'const n = `${state.publishGen}`; void n;',
    'const c = state.groups[0].id; void c;',
    'state.groups = state.groups || [];',
  ]) assert.deepStrictEqual(stateViolations(mod(ok), 'fixture'), [], `the guard rejected legitimate code: ${ok}`);
});

test('🔴 the hand-written writer list matches what the tree actually says', () => {
  // WRITERS drives the listener census. It was maintained by hand, so it described the code only for
  // as long as nobody renamed a function or added one — and "does this write?" is an effect, not a
  // name. The tree computes the answer transitively; the list must contain it.
  const computed = writerFunctions(readFileSync(join(DIR, 'app.js'), 'utf8')).names;
  assert.ok(computed.size >= 8, `sanity: the analysis found the writers (${computed.size})`);
  const missing = [...computed].filter((n) => !WRITERS.includes(n));
  assert.deepStrictEqual(missing, [],
    `🔴 these functions write state (directly or by calling something that does) but are not in WRITERS, so a listener could call one and the census would not notice: ${missing.join(', ')}`);
});

test('🔴 the parser is test-only — nothing it needs can reach the browser', () => {
  // The portal has no build step: index.html loads plain ES modules from this directory, so a
  // dependency is only safe while nothing served can reach it. acorn exists for the guards above and
  // must stay on that side of the line.
  const html = readFileSync(join(DIR, 'index.html'), 'utf8');
  assert.ok(!/node_modules|acorn|wiring-ast/.test(html), 'index.html references nothing from the test harness');
  for (const f of JS) {
    const c = codeOf(f);
    assert.ok(!/from\s+'acorn|require\(\s*'acorn|node_modules/.test(c), `${f} must not import the parser — it is not served`);
    assert.ok(!/wiring-ast/.test(c), `${f} must not import the guard harness`);
  }
  // and the manifest exists only to carry devDependencies
  const pkg = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8'));
  assert.deepStrictEqual(pkg.dependencies, undefined, '🔴 the portal has no RUNTIME dependencies, and must not acquire one');
});

test('🔴 the view modules cannot reach state — which is what licenses handing them references', () => {
  // renderRail, renderDetail and the rest are on the AST guard's consumer allowlist, meaning a live
  // state reference may be passed to them. That is only sound because they cannot write through it:
  // these files do not reference `state` at all, and never import it. Asserted, not assumed — the
  // allowlist entry is worth exactly as much as this check.
  for (const f of ['render.js', 'review.js', 'portal-logic.js']) {
    const c = codeOf(f);
    assert.ok(!/\bstate\b/.test(c), `🔴 ${f} now references \`state\` — it is a view module and the AST guard trusts it not to`);
    assert.ok(!/from\s+'\.\/app\.js'/.test(c), `${f} must not import the app module`);
  }
});

test('🔴 the analyser closes the soundness holes it was shown', () => {
  // Each of these is a bounded, real hole — not adversarial exotica. Every one was ADMITTED before the
  // fix, which is the only reason to keep them as fixtures.
  const mod = (body) => `import { setItemPrice, draftSource } from './editor.js';\nexport const state = { review: null, groups: [], publishGen: 0 };\nfunction f(obj) {\n  ${body}\n}\n`;   // the imports make a RESOLVED consumer available, so a local of the same name shadows it
  const HOLES = [
    // value-flow: taint followed only member chains while classification followed conditionals and
    // logicals, so a reference bound through one of them stopped being tracked at the binding
    ['const r = obj ? state.review : obj; r.acknowledged = true;',        'through the alias'],
    ['const r = obj || state.review; r.acknowledged = true;',             'through the alias'],
    ['const r = (0, state.review); r.acknowledged = true;',               'through the alias'],
    ['const r = state?.review; r.acknowledged = true;',                   'through the alias'],
    // element references handed out by iteration and by reference-returning methods
    ['for (const g of state.groups) { g.price = 1; }',                    'through the alias'],
    ['const g = state.groups.find((x) => x); g.price = 1;',               'through the alias'],
    ['const g = state.groups.at(0); g.price = 1;',                        'through the alias'],
    // delete
    ['delete state.review;',                                             'may not be deleted'],
    ['const r = state.review; delete r.acknowledged;',                    'may not be deleted'],
    // a consumer authorised by NAME rather than by resolved binding
    ['const setItemPrice = (x) => { x.acknowledged = true; }; setItemPrice(state.review);', 'not the module-level'],
    ['const draftSource = obj; draftSource(state.review);',               'not the module-level'],
    // real scopes: var hoists out of its block, a catch param binds, a named function expression
    // binds its own name
    ['{ var r = state.review; } r.acknowledged = true;',                  'through the alias'],
    ['try { obj(); } catch (state) { state.review = 1; }',                'no violation'],
  ];
  for (const [body, expect] of HOLES) {
    const bad = stateViolations(mod(body), 'fx');
    if (expect === 'no violation') {
      assert.deepStrictEqual(bad, [], `a shadowing binding is NOT the module state: ${body}`);
      continue;
    }
    assert.ok(bad.length > 0, `🔴 still ADMITTED: ${body}`);
    assert.ok(bad.some((b) => b.includes(expect)), `wrong reason for "${body}": ${bad.join(' | ')}`);
  }
  // and the analyses converge rather than silently truncating
  assert.doesNotThrow(() => stateViolations(readFileSync(join(DIR, 'app.js'), 'utf8')), 'taint reaches a fixed point');
  assert.doesNotThrow(() => writerFunctions(readFileSync(join(DIR, 'app.js'), 'utf8')), 'the writer set reaches a fixed point');
});

test('🔴 a shadowing consumer cannot inherit the allowlist, however it is declared', () => {
  // Defence in depth now — the fiscal evidence is runtime-frozen, so this no longer stands between a
  // forger and the tax document. It is fixed because it was a real, named hole: the check accepted any
  // binding of kind 'function', so a function DECLARED INSIDE another function inherited a ruling
  // written for the module-level import of the same name.
  const mod = (body) => `import { setItemPrice } from './editor.js';\nexport const state = { review: null };\nfunction f(obj) {\n  ${body}\n}\n`;
  for (const shadow of [
    'function setItemPrice(x) { x.acknowledged = true; } setItemPrice(state.review);',   // declaration
    'const setItemPrice = (x) => { x.acknowledged = true; }; setItemPrice(state.review);', // const
    'let setItemPrice = obj; setItemPrice(state.review);',                                 // let
    'var setItemPrice = obj; setItemPrice(state.review);',                                 // var, hoisted
  ]) {
    const bad = stateViolations(mod(shadow), 'fx');
    assert.ok(bad.some((b) => b.includes('not the module-level setItemPrice')),
      `🔴 a shadowing consumer was authorised: ${shadow} -> ${bad.join(' | ') || '(no violation)'}`);
  }
  // ...and the genuine module-level import is still authorised, or nothing would pass.
  assert.deepStrictEqual(stateViolations(mod('setItemPrice(state.review, 1, 2);'), 'fx'), [],
    'the real imported setter is still a ruled consumer');
});

test('🔴 the evidence has ONE home — nothing renders from the pre-mint locals', () => {
  // mintReview clones and freezes what it is given, so the locals it was built from are still live,
  // mutable copies of the same evidence. Reading from them behaves identically today, which is exactly
  // why only a structural check can hold the line: the point is that no second copy is in use, so a
  // later edit to one of those locals cannot make the screen and the record disagree.
  const app = codeOf('app.js');
  assert.match(app, /renderReview\(\$\('mbody'\), reviewModel\(state\.review\.diff\)\)/,
    '🔴 the review renders from the MINTED diff');
  assert.match(app, /renderAttestation\(attBox, state\.review\.attestation,/,
    '🔴 the attestation renders from the MINTED attestation, not the local it was computed into');
  // and the frozen copy is what the record holds, rather than the caller's object
  assert.match(app, /value: frozenCopy\(fields\[k\]\)/, 'every field is stored as a frozen copy');
  assert.match(app, /return Object\.freeze\(copy\)/, '...and the freeze is applied to the COPY, all the way down');
});
