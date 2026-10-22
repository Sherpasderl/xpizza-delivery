// CUSTOMER APP S0-test — THE RIG MUST NOT SILENTLY RUN A WEAKER PAGE (form-harness.mjs inliner).
//
// The shared harness used to drop a local script it could not read, and to leave a type="module" / defer /
// otherwise-attributed local script neither inlined nor removed, so it never ran and every suite on top of
// that page kept passing. A shared renderer split into ES modules would have been tested as an empty page.
// Both cases now throw; `omit` (the explicit model of a browser 404) still works; both live forms still load
// with no jsdom error. The probe pages are copies of xpizza-orders in a git-ignored dir, each with ONE
// asserted edit.
import assert from 'node:assert';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync, unlinkSync, rmdirSync } from 'node:fs';
import { loadForm, closeAll, counter, settle } from './form-harness.mjs';

const { ok, count } = counter();
const ROOT = new URL('./', import.meta.url).pathname;
const PROBE = 'node_modules/.capp-harness-probe';

function probe(name, edit) {
  const dir = `${PROBE}/${name}`;
  mkdirSync(ROOT + dir, { recursive: true });
  for (const f of readdirSync(ROOT + 'xpizza-orders')) if (statSync(ROOT + 'xpizza-orders/' + f).isFile()) writeFileSync(`${ROOT}${dir}/${f}`, readFileSync(ROOT + 'xpizza-orders/' + f));
  edit(`${ROOT}${dir}`);
  return dir;
}
function replaceOnce(file, from, to) {
  const s = readFileSync(file, 'utf8');
  assert.strictEqual(s.split(from).length - 1, 1, `premise: ${JSON.stringify(from)} occurs once in the probe page`);
  writeFileSync(file, s.replace(from, to));
}

try {
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const w = loadForm(dir); await settle();
    assert.deepStrictEqual(w.__jsdomErrors, [], `${dir}: loads with no jsdom error`);
    assert.strictEqual(typeof w.createCart, 'function', `${dir}: non-vacuity — form-cart.js ran (window.createCart exists)`);
  }
  ok('both live forms load through the strict inliner with no jsdom error, every local module running');

  const mod = probe('module', (d) => replaceOnce(`${d}/index.html`, '<script src="form-cart.js"></script>', '<script type="module" src="form-cart.js"></script>'));
  assert.throws(() => loadForm(mod), /cannot inline.*type="module" src="form-cart\.js"/s);
  const def = probe('defer', (d) => replaceOnce(`${d}/index.html`, '<script src="form-cart.js"></script>', '<script defer src="form-cart.js"></script>'));
  assert.throws(() => loadForm(def), /cannot inline.*defer src="form-cart\.js"/s);
  const inl = probe('inline-module', (d) => replaceOnce(`${d}/index.html`, '<script src="form-cart.js"></script>', '<script src="form-cart.js"></script><script type="module">window.__inlineModuleRan = true; throw new Error("capp probe");</script>'));
  assert.throws(() => loadForm(inl), /module script\(s\), which jsdom never runs.*type="module"/s);
  ok('a type="module" or defer local script THROWS, naming the script; an INLINE module script throws too — none is silently left unrun');

  const gone = probe('missing', (d) => unlinkSync(`${d}/form-cart.js`));
  assert.throws(() => loadForm(gone), /local script "form-cart\.js" .* cannot be read/);
  const w = loadForm(gone, { omit: ['form-cart.js'] }); await settle();
  assert.strictEqual(typeof w.createCart, 'undefined', 'omit models the browser 404: the page runs without that module');
  ok('a missing local script THROWS unless the test omits it on purpose; omit still models a 404');
} finally {
  closeAll();
  rmSync(ROOT + PROBE, { recursive: true, force: true });
  try { rmdirSync(ROOT + 'node_modules'); } catch (_) {}
}
console.log(`\ncapp-s0-harness: ${count()} passed`);
