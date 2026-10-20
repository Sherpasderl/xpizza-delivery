// PORTAL-UI 1a (PLAN-portal-ui-slice1-sucursales r5 §7, §9, §11 A3) — structural guards for the slice.
//   0. (3a, T-d) app.js's publish-request hunks are named and folded out first — see the T-d test.
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

// ── PLAN-portal-team-invites T-d (3a): app.js gains EXACTLY these named hunks over the pre-T-d file (portal-ui ea8d9727). Folding
// them back out must give that file byte-for-byte — so the owner's publish path (review → fiscal ack → publishEdited) and
// everything else is provably untouched, and the §5.2 guard below keeps judging portal-ui's own changes on the folded file.
const TD_BASE = 'ea8d9727';
const TD_LINES = [
  // [the line as it is now, what it was before T-d] — each must occur EXACTLY once
  ["import { apiFetch, editCatalog, publishEdited, resetDraftToLive, requestPublish } from './api.js';\n", "import { apiFetch, editCatalog, publishEdited, resetDraftToLive } from './api.js';\n"],
  ["  applyPublishRequestFacts(null);             // T-d — per-load server facts, fail closed (today's path) until they arrive\n", ''],
  ['  applyPublishRequestFacts(data);           // T-d — behind the same generation check\n', ''],
  ['  applyPublishRequestFacts(fresh);          // T-d — a publish retires the owner\'s banner / badge (the request is no longer fresh)\n', ''],
  ['  // T-d (mockup v8 D2): who publishes, said where the merchant decides — text only\n', ''],
  ["  if (state.publishViaRequest) { const note = document.createElement('span'); note.textContent = ' · el dueño confirma y publica con la autorización fiscal'; $('rbtxt').append(note); }\n", ''],
  ['  if (state.publishViaRequest) return sendToOwnerFlow();   // T-d: this caller sends; the owner\'s path below is untouched\n', ''],
];
// the two whole new functions, each from its header comment to its closing brace
const TD_BLOCKS = [
  [/\/\/ PLAN-portal-team-invites T-d — the two per-load facts[\s\S]*?\nfunction applyPublishRequestFacts\(data\) \{[\s\S]*?\n\}\n/, 'applyPublishRequestFacts'],
  [/\/\/ ── PLAN-portal-team-invites T-d — «Enviar al dueño para publicar» [\s\S]*?\nasync function sendToOwnerFlow\(\) \{[\s\S]*?\n\}\n/, 'sendToOwnerFlow'],
];
function withoutTd(src) {
  let out = src;
  for (const [now, was] of TD_LINES) {
    assert.equal(out.split(now).length - 1, 1, `T-d hunk occurs exactly once: ${now.trim().slice(0, 80)}`);
    out = out.replace(now, () => was);
  }
  for (const [re, name] of TD_BLOCKS) {
    const m = out.match(new RegExp(re.source, 'g'));
    assert.equal(m && m.length, 1, `T-d block ${name} occurs exactly once`);
    out = out.replace(re, '');
  }
  return out;
}

test('app.js T-d (3a): exactly the named hunks — folding them out gives the pre-T-d file byte-for-byte; the owner path is untouched', () => {
  const was = execFileSync('git', ['show', `${TD_BASE}:xpizza-portal/app.js`], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(withoutTd(read('app.js')), was, 'app.js minus the T-d hunks ≠ the pre-T-d app.js');
  // the publish path itself carries no T-d line: runPublish / settle / the attestation are byte-identical top-level statements
  const now = topLevel(read('app.js'));
  for (const keep of ['async function runPublish() {', 'function syncUi() {', 'function showOutcome(outcome) {']) {
    assert.ok(now.some((x) => x.startsWith(keep)) && topLevel(was).some((x) => x.startsWith(keep) && now.includes(x)), `byte-identical: ${keep}`);
  }
  // non-vacuity: the fold really removes something, and a stray extra edit would survive it
  assert.ok(withoutTd(read('app.js')).length < read('app.js').length);
  assert.notEqual(withoutTd(read('app.js').replace('function syncUi() {', 'function syncUi() { ')), was);
});

test('app.js: exactly the four named §5.2 changes, every other top-level statement byte-identical', () => {
  const now = topLevel(withoutTd(read('app.js')));   // T-d's own hunks are judged by the test above
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
const NEW_PORTAL = ['shell.js', 'branches-view.js', 'pausas.js', 'availability.js', 'branch-logic.js', 'ops-dom.js',
  'team.js', 'team-logic.js', 'invite-mail.js', 'pubreq.js', 'aceptar.js'];   // + 3a's T-b / T-c / T-d modules (aceptar-boot.js holds the
  // Functions BASE URL — the GCP project id, exactly as api.js does — so it is not a zero-literal module)
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
