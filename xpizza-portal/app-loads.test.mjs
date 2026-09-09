// Portal 2b-2b — DOES app.js ACTUALLY LOAD? Run: node --test xpizza-portal/app-loads.test.mjs
//
// 🔴🔴 This test exists because app.js shipped with a load-time ReferenceError and every single one of
// the 102 other tests passed.
//
// The bug: a top-level `PUBBTN.addEventListener(...)` written EIGHT LINES ABOVE `const PUBBTN = …`.
// `const` sits in the temporal dead zone until its own declaration, so module evaluation threw
// "Cannot access 'PUBBTN' before initialization" and aborted — taking the publish listener, the
// captures, and every later top-level statement with it. The portal was dead on every page load.
//
// Nothing caught it because node never EXECUTES app.js: the other suites read it as TEXT through
// codeOf() and match patterns. A structural guard can prove a line is written; it cannot prove the
// module runs. Grepping for `const PUBBTN` passes on the broken order just as happily as on the fixed
// one — the ONLY thing that distinguishes them is evaluation.
//
// That is the third runtime-only defect in this slice (the detached button, the stringified-null
// footer, and this), and the first that was fatal to the whole page.
//
// app.js cannot be imported directly: it pulls in auth.js → firebase.js → a CDN URL node cannot fetch.
// So the source is rewritten to import a local stub for that ONE module and nothing else, written
// beside the originals so every other relative import resolves to the real file. What executes here is
// the real app.js logic.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));

// Only the ids app.js touches while evaluating, plus the ones its handlers reach for.
const IDS = ['switcher', 'switchmenu', 'discard', 'review', 'pubback', 'pubbtn', 'scrim', 'mbody',
  'revSub', 'revFoot', 'revTitle', 'drawer', 'rail', 'detail', 'rbar', 'rbtxt', 'shopname', 'shopsub',
  'whoami', 'avatar', 'logout', 'detailempty'];

function installDom() {
  const mk = (tag, id) => {
    const n = {
      tag, id, children: [], attrs: {}, listeners: {}, _class: '', dataset: {}, style: {},
      disabled: false, title: '', value: '', checked: false, textContent: '',
      get className() { return n._class; },
      set className(v) { n._class = v; },
      classList: {
        add: (c) => { n._class = `${n._class} ${c}`.trim(); },
        remove: (c) => { n._class = n._class.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        toggle: (c, on) => { if (on) n.classList.add(c); else n.classList.remove(c); },
        contains: (c) => n._class.split(/\s+/).includes(c),
      },
      append: (...cs) => n.children.push(...cs),
      replaceChildren: (...cs) => { n.children = [...cs]; },
      setAttribute: (k, v) => { n.attrs[k] = v; },
      removeAttribute: (k) => { delete n.attrs[k]; },
      addEventListener: (ev, fn) => { (n.listeners[ev] = n.listeners[ev] || []).push(fn); },
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
      focus: () => {},
    };
    return n;
  };
  const byId = new Map(IDS.map((id) => [id, mk('div', id)]));
  globalThis.document = {
    _byId: byId,
    getElementById: (id) => byId.get(id) || null,
    createElement: (t) => mk(t, null),
    createElementNS: (_ns, t) => mk(t, null),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    documentElement: mk('html', null),
  };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
  globalThis.CSS = { escape: (s) => String(s) };
  return byId;
}

// Rewrite ONLY the CDN-bound import; everything else resolves to the real module.
async function loadAppModule(sourceTransform = (s) => s) {
  const stub = join(DIR, '__auth-stub.test.mjs');
  const tmp = join(DIR, `__app-under-test.${Date.now()}.mjs`);
  writeFileSync(stub, 'export const token = async () => "TK-test";\nexport const login = async () => {};\nexport const logout = async () => {};\nexport const authErrorMessage = () => "";\n');
  const src = sourceTransform(readFileSync(join(DIR, 'app.js'), 'utf8'))
    .replace(/from '\.\/auth\.js'/g, "from './__auth-stub.test.mjs'");
  writeFileSync(tmp, src);
  try {
    return await import(`${pathToFileURL(tmp).href}?t=${Date.now()}`);
  } finally {
    try { unlinkSync(tmp); } catch (_) { /* best effort */ }
    try { unlinkSync(stub); } catch (_) { /* best effort */ }
  }
}

test('🔴 app.js EVALUATES — no load-time ReferenceError', async () => {
  installDom();
  let mod, threw = null;
  try { mod = await loadAppModule(); } catch (e) { threw = e; }
  assert.strictEqual(threw, null,
    `app.js threw during module evaluation, which kills the whole portal on every page load: ${threw && threw.message}`);
  assert.ok(mod, 'the module produced exports');
  assert.strictEqual(typeof mod.loadMenu, 'function', 'and its exports are reachable, so evaluation ran to the end');
});

test('🔴 the publish listener is REGISTERED, not merely written', async () => {
  const byId = installDom();
  await loadAppModule();
  const pubbtn = byId.get('pubbtn');
  assert.ok(pubbtn.listeners.click && pubbtn.listeners.click.length === 1,
    '#pubbtn has exactly one click listener — the whole publish path hangs off it');
  // and the other top-level wiring that a mid-module throw would have taken with it
  for (const id of ['review', 'discard', 'pubback', 'switcher']) {
    assert.ok(byId.get(id).listeners.click && byId.get(id).listeners.click.length >= 1,
      `#${id} is wired — a module that aborted partway would leave this empty`);
  }
});

test('the test itself FAILS on the ordering that shipped', async () => {
  // The point of an executable check. Reintroduce the exact defect — move the captures BELOW their
  // top-level use — and require this harness to notice. A guard that greps for `const PUBBTN` passes
  // on both orderings; only evaluation tells them apart.
  installDom();
  const broken = (src) => {
    const decl = "const PUBBTN = $('pubbtn');\nconst PUBBACK = $('pubback');\n";
    assert.ok(src.includes(decl), 'the captures are where this test expects them');
    return src.replace(decl, '') + `\n${decl}`;   // declared after every use, as it shipped
  };
  let threw = null;
  try { await loadAppModule(broken); } catch (e) { threw = e; }
  assert.ok(threw, 'the broken ordering must throw');
  assert.ok(/before initialization|is not defined/.test(threw.message),
    `...with a temporal-dead-zone error, got: ${threw.message}`);
});

test('every capture is declared before every top-level use', async () => {
  // The general form, checked on the real file rather than on a rewritten copy: for each captured
  // const, no TOP-LEVEL statement above it may reference it. Indented lines are function bodies,
  // which only run after evaluation completes.
  // Comments STRIPPED. The comment explaining this very hazard names PUBBTN, and an unstripped scan
  // matched that prose and reported the fixed file as broken. A guard that reads its own
  // documentation as evidence proves nothing — third time in this slice.
  const lines = readFileSync(join(DIR, 'app.js'), 'utf8').split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, ''));
  const decls = new Map();
  lines.forEach((l, i) => {
    const m = l.match(/^const ([A-Z][A-Z0-9_]*) =/);
    if (m) decls.set(m[1], i);
  });
  assert.ok(decls.size >= 2, `non-vacuity: the scan must find the captures (${[...decls.keys()]})`);
  for (const [name, declLine] of decls) {
    lines.forEach((l, i) => {
      if (i >= declLine) return;
      if (!l || /^\s/.test(l)) return;                     // indented → inside a function body
      assert.ok(!new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(l),
        `${name} is used at top level on line ${i + 1} but declared on line ${declLine + 1} — a temporal-dead-zone throw at module load`);
    });
  }
});
