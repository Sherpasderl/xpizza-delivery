// PORTAL-UI 1a (PLAN-portal-ui-slice1-sucursales r5 §7, §9, §11 A3) — structural guards for the slice.
//   1. app.js differs from the slice base by EXACTLY the four §5.2 changes (three listener statements removed, openEditor +
//      editorCanLeave added); every other top-level statement is byte-identical (acorn, not regex).
//   2. ventas.js differs by EXACTLY one added line (the A3 `sales === false` early return), inside its portal:restaurant listener.
//   3. editor.js / review.js / render.js / auth.js / auth-errors.js / firebase.js / portal-logic.js / ventas-logic.js: zero diff.
//   4. BRAND-AGNOSTIC: no restaurant / brand literal in any NEW portal module or the ops server modules; the pre-existing portal
//      files may not gain one (their current counts are frozen against the base).
// Run: node --test xpizza-portal/portalui-guards.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as acorn from 'acorn';

const DIR = dirname(fileURLToPath(import.meta.url));
const BASE = '613f7e08';
const read = (f) => readFileSync(join(DIR, f), 'utf8');
const readFn = (f) => readFileSync(join(DIR, '..', 'xpizza-functions', f), 'utf8');
const base = (f) => execFileSync('git', ['show', `${BASE}:xpizza-portal/${f}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
const topLevel = (src) => acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' }).body.map((n) => src.slice(n.start, n.end));

test('app.js: exactly the four named §5.2 changes, every other top-level statement byte-identical', () => {
  const now = topLevel(read('app.js'));
  const was = topLevel(base('app.js'));
  const removed = was.filter((s) => !now.includes(s));
  const added = now.filter((s) => !was.includes(s));
  assert.deepEqual(removed, [
    "document.addEventListener('portal:signed-in', () => { loadRestaurants(); });",
    "$('switcher').addEventListener('click', (e) => { e.stopPropagation(); openSwitch(); });",
    "document.addEventListener('click', (e) => { if (!e.target.closest('.switchwrap')) openSwitch(false); });",
  ], 'removed: the signed-in → loadRestaurants line and the two switcher listeners (shell.js owns discovery + the switcher)');
  assert.equal(added.length, 2, `added: exactly two statements (${added.length})`);
  assert.ok(added[0].startsWith('export function openEditor(rid, { name = rid, sales } = {}) {'), 'openEditor');
  assert.ok(/state\.restaurants = \[\{ rid, name \}\];\s*state\.currentRid = rid;\s*document\.dispatchEvent\(new CustomEvent\('portal:restaurant', \{ detail: \{ rid, sales \} \}\)\);/.test(added[0]), 'openEditor sets the selection and dispatches the event once');
  assert.equal(added[1], 'export const editorCanLeave = () => portalCanReload(portalReloadFacts());', 'editorCanLeave reuses the self-update guard verbatim');
  // the loadMenu / listeners / publish path / self-update adapter are among the unchanged statements
  for (const keep of ['export async function loadMenu(rid) {', "document.addEventListener('portal:restaurant', (e) => { loadMenu(e.detail && e.detail.rid); });",
    "document.addEventListener('portal:auth', (e) => {", 'async function runPublish() {', 'function portalReloadFacts() {']) {
    assert.ok(now.some((s) => s.startsWith(keep)) && was.some((s) => s.startsWith(keep)), `unchanged: ${keep}`);
  }
});

test('ventas.js: exactly one added line — the A3 owner-only early return in its portal:restaurant listener', () => {
  const now = read('ventas.js').split('\n');
  const was = base('ventas.js').split('\n');
  assert.equal(now.length, was.length + 1);
  const i = now.findIndex((l, k) => l !== was[k]);
  assert.equal(now[i], '  if (e.detail.sales === false) return;   // PORTAL-UI 1a §11 A3: Ventas is owner-only in 1a — shell.js says so per page');
  assert.deepEqual([...now.slice(0, i), ...now.slice(i + 1)], was, 'nothing else changed');
  assert.equal(now[i - 1], '  if (!rid) return;');
  assert.ok(now[i - 3].startsWith("document.addEventListener('portal:restaurant'"), 'inside the portal:restaurant listener');
});

test('the editor, review, render, auth and logic modules are byte-identical to the base', () => {
  for (const f of ['editor.js', 'review.js', 'render.js', 'auth.js', 'auth-errors.js', 'firebase.js', 'portal-logic.js', 'ventas-logic.js', 'sherpa-client.js']) {
    assert.equal(read(f), base(f), `${f} changed`);
  }
});

// ── brand-agnostic ──
const LITERALS = [/x_pizza/i, /la_musa/i, /\bX\.? ?Pizza\b/i, /\bLa Musa\b/i, /15\.5074/, /-88\.0398/, /15\.50414/, /-88\.03848/, /97952893/, /93736607/];
const hits = (src) => LITERALS.reduce((n, re) => n + (src.match(new RegExp(re.source, `${re.flags.replace('g', '')}g`)) || []).length, 0);
const NEW_PORTAL = ['shell.js', 'branches-view.js', 'pausas.js', 'availability.js', 'branch-logic.js', 'ops-dom.js', 'equipos.js'];
const NEW_SERVER = ['portal/ops-core.js', 'portal/ops-functions.js', 'portal/location-name.js', 'portal/pause-reasons.js', 'portal/reset-list.js', 'lib/hn-date.js'];
const EXISTING = ['index.html', 'styles.css', 'app.js', 'api.js', 'boot.js', 'ventas.js', 'render.js', 'editor.js', 'review.js', 'portal-logic.js', 'ventas-logic.js'];

test('BRAND-AGNOSTIC: zero restaurant / brand literals in every new portal and ops module', () => {
  for (const f of NEW_PORTAL) assert.equal(hits(read(f)), 0, `${f} names a restaurant`);
  for (const f of NEW_SERVER) assert.equal(hits(readFn(f)), 0, `${f} names a restaurant`);
  // non-vacuity: the pattern set does catch the real ids
  assert.ok(hits("rid === 'x_pizza' || name === 'La Musa'") >= 2);
});

test('BRAND-AGNOSTIC: the pre-existing portal files gain no literal (counts frozen against the base)', () => {
  for (const f of EXISTING) assert.ok(hits(read(f)) <= hits(base(f)), `${f}: ${hits(base(f))} → ${hits(read(f))} brand literals`);
});

// ── slice 2 (PLAN-portal-ui-slice2-equipos r1.1 §5, codex plan r1 P2-4): app.js / ventas.js are BYTE-EQUAL to the approved stack
// tip the slice is built on. The historical 1a proofs above stay pinned to their own base (BASE).
const SLICE2_BASE = 'ea8d9727';
test('slice 2: app.js and ventas.js are byte-identical to the approved stack tip', () => {
  for (const f of ['app.js', 'ventas.js']) {
    const was = execFileSync('git', ['show', `${SLICE2_BASE}:xpizza-portal/${f}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(read(f), was, `${f} changed since ${SLICE2_BASE}`);
  }
});
