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
import { PB_FOLD } from './photos-b-fold.mjs';
import { PP_FOLD } from './pp-fold.mjs';
import { S4_BASE, S4_FOLD } from './s4-fold.mjs';
import { UNSAVED_BASE, UNSAVED_FOLD } from './unsaved-fold.mjs';
import { S1_BASE, S1_FOLD } from './s1-fold.mjs';
import { S2_BASE, S2_FOLD } from './s2-fold.mjs';
import { HF_BASE, HF_FOLD } from './hotfix-1112-fold.mjs';
import { MINT_BASE, MINT_FOLD } from './mint-fold.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const BASE = '613f7e08';
// UNSAVED EDITS (MOCKUP-portal-item-edit-unsaved.html, owner-approved 2026-11-11) is the NEWEST layer of all: its named hunks are
// folded out at the lowest read, so every layer and pin below judges exactly what it judged before; the UNSAVED test pins the
// layer itself on the file on disk (an edit outside or inside one of its hunks fails).
// STRUCTURE S1 (PLAN-portal-structure-S1-ui r3) is the NEWEST layer above UNSAVED: its named hunks are folded out at the very
// lowest read, so UNSAVED and every older pin judge exactly what they judged before; the S1 test pins the layer itself on disk.
// STRUCTURE S2 (PLAN-portal-structure-S2-ui r3) is the NEWEST layer of all, above S1: folded out at the very lowest read, so S1,
// UNSAVED and every older pin judge exactly what they judged before; the S2 test pins the layer itself on disk.
const portalOnDisk = (f) => readFileSync(join(DIR, f), 'utf8');
function withoutS2(f, src) {
  let out = src;
  for (const [now, was] of S2_FOLD[f] || []) {
    assert.equal(out.split(now).length - 1, 1, `S2 hunk occurs exactly once in ${f}: ${now.trim().slice(0, 80)}`);
    out = out.replace(now, () => was);
  }
  return out;
}
const fileRead = (f) => withoutS2(f, portalOnDisk(f));
function withoutS1(f, src) {
  let out = src;
  for (const [now, was] of S1_FOLD[f] || []) {
    assert.equal(out.split(now).length - 1, 1, `S1 hunk occurs exactly once in ${f}: ${now.trim().slice(0, 80)}`);
    out = out.replace(now, () => was);
  }
  return out;
}
// train/portal-structure: main's LIVE HOTFIX 2026-11-12 (hotfix-1112-fold.mjs) and the S1c MINT panel (mint-fold.mjs, advisor 11-11) are the NEWEST layers, above
// UNSAVED: each is folded out at the very lowest read (they fold DISJOINT files — HOTFIX app.js, MINT review.js — so their order is
// immaterial), so every older pin judges exactly what it judged before; the HOTFIX and MINT cells pin each layer on disk.
// they sit BELOW S1/S2 here: their cells read main's bytes = the disk minus S2 and S1 (mainBytes); S1/S2's cells peel them too (legacy).
const mainBytes = (f) => withoutS1(f, withoutS2(f, portalOnDisk(f)));
function withoutHotfix(f, src) {
  let out = src;
  for (const [now, was] of HF_FOLD[f] || []) {
    assert.equal(out.split(now).length - 1, 1, `HOTFIX hunk occurs exactly once in ${f}: ${now.trim().slice(0, 80)}`);
    out = out.replace(now, () => was);
  }
  return out;
}
function withoutMint(f, src) {
  let out = src;
  for (const [now, was] of MINT_FOLD[f] || []) {
    assert.equal(out.split(now).length - 1, 1, `MINT hunk occurs exactly once in ${f}: ${now.trim().slice(0, 80)}`);
    out = out.replace(now, () => was);
  }
  return out;
}
const legacy = (f, src) => withoutMint(f, withoutHotfix(f, src));
const diskRead = (f) => legacy(f, mainBytes(f));
function withoutUnsaved(f, src) {
  let out = src;
  for (const [now, was] of UNSAVED_FOLD[f] || []) {
    assert.equal(out.split(now).length - 1, 1, `UNSAVED hunk occurs exactly once in ${f}: ${now.trim().slice(0, 80)}`);
    out = out.replace(now, () => was);
  }
  return out;
}
const rawRead = (f) => withoutUnsaved(f, diskRead(f));
// ── F-2 (owner-approved mockup ENrjdkJmw3mzy9PkFCy4D1, 2026-11-07): the NEWEST layer — app.js / review.js gain EXACTLY the hunks in
// pp-fold.mjs over PP_BASE (the «Marca» commit, which left both files as on main). `read` folds them out FIRST, so every registry and
// pin below keeps judging exactly what it judged before; the F-2 test pins the layer itself (an edit outside or inside a hunk fails).
const PP_BASE = '3d1ae27e';
function withoutPp(f, src) {
  let out = src;
  for (const [now, was] of PP_FOLD[f] || []) {
    assert.equal(out.split(now).length - 1, 1, `F-2 hunk occurs exactly once in ${f}: ${now.trim().slice(0, 80)}`);
    out = out.replace(now, () => was);
  }
  return out;
}
// S4 «Editar producto» (PLAN-portal-item-edit r6) is the NEWEST layer: read() folds its named hunks out first (then F-2's), so every
// pin below judges exactly what it judged before; readNow() is the file on disk, judged by the S4 test.
const readNow = rawRead;
function withoutS4(f, src) {
  let out = src;
  for (const [now, was] of S4_FOLD[f] || []) {
    assert.equal(out.split(now).length - 1, 1, `S4 hunk occurs exactly once in ${f}: ${now.trim().slice(0, 80)}`);
    out = out.replace(now, () => was);
  }
  return out;
}
const read = (f) => withoutPp(f, withoutS4(f, rawRead(f)));
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
// ── train-3 Codex follow-up (3a, fix/tb-team-css): a drawer FIELD state is `.invalid`, never the global `.err` message block (its
// display:none hid the whole field). EXACTLY these four app.js lines changed ('err' → 'invalid'); the pins below judge app.js with
// them folded back, so every other byte stays proven against its own base.
const FS_LINES = [
  ["    if (m) { f.classList.add('invalid'); f.append(mk('div', 'ferr', m)); }\n", "    if (m) { f.classList.add('err'); f.append(mk('div', 'ferr', m)); }\n"],
  ["  if (errFor('price')) { prf.classList.add('invalid'); prf.append(mk('div', 'ferr', errFor('price'))); }\n", "  if (errFor('price')) { prf.classList.add('err'); prf.append(mk('div', 'ferr', errFor('price'))); }\n"],
  ["  if (labelErr) { grp.classList.add('invalid'); grp.append(mk('div', 'ferr', labelErr)); }\n", "  if (labelErr) { grp.classList.add('err'); grp.append(mk('div', 'ferr', labelErr)); }\n"],
  ["      if (oErr) { row.classList.add('invalid'); gb.append(mk('div', 'ferr', oErr)); }\n", "      if (oErr) { row.classList.add('err'); gb.append(mk('div', 'ferr', oErr)); }\n"],
];
function withoutFs(src) {
  let out = src;
  for (const [now, was] of FS_LINES) {
    assert.equal(out.split(now).length - 1, 1, `field-state hunk occurs exactly once: ${now.trim().slice(0, 80)}`);
    out = out.replace(now, () => was);
  }
  return out;
}
// ── PLAN-portal-shell-no-shift (Codex r2 P1 + r3): app.js gains EXACTLY these named hunks — the catalog READ's own generation
// (readGeneration, captured and checked by loadMenu) and the portal:abandon listener that bumps ONLY it (writes always settle).
// Folded out FIRST (the newest layer), so every older pin below judges exactly what it judged before. Generated from the slice
// diff against its base 1e81a7f2 and pinned: an edit outside these hunks, or inside one, fails. Train asm3 (2e): main now carries
// DISH PHOTOS B + T1 + held-state over 1e81a7f2, so the pin runs THROUGH those older folds to T1_BASE (readSw below).
const SW_HUNKS = [
 [
  "// PLAN-portal-shell-no-shift (Codex r3): the catalog READ's own generation — shell.js's recovery (portal:abandon) cancels an\n// abandoned load and nothing else; a save / publish in flight always settles, reconciles and runs its authoritative reload.\nlet readGeneration = 0;\n",
  ""
 ],
 [
  "  const gen = opGeneration, rgen = readGeneration;\n",
  "  const gen = opGeneration;\n"
 ],
 [
  "    if (gen !== opGeneration || rgen !== readGeneration) return;\n",
  "    if (gen !== opGeneration) return;\n"
 ],
 [
  "  if (gen !== opGeneration || rgen !== readGeneration) return;        // a newer switch won; this response is for a tenant the merchant left\n",
  "  if (gen !== opGeneration) return;        // a newer switch won; this response is for a tenant the merchant left\n"
 ],
 [
  "\n// PLAN-portal-shell-no-shift (Codex r2 P1): shell.js presents its recovery box after a boot failure / the discovery deadline;\n// the editor's held catalog LOAD belongs to an abandoned world and must not repaint over it — reads only (Codex r3).\ndocument.addEventListener('portal:abandon', () => { readGeneration += 1; });\n",
  ""
 ],
 // shell-wait r7 (advisor ruling a): the reveal also waits for the catalog's first load — openEditor returns it
 [
  "// shell-wait r7 (R2): the load this event started, so openEditor can hand it to the shell's bounded reveal (it settles, never throws)\nlet lastMenuLoad = null;\ndocument.addEventListener('portal:restaurant', (e) => { lastMenuLoad = loadMenu(e.detail && e.detail.rid); });\n",
  "document.addEventListener('portal:restaurant', (e) => { loadMenu(e.detail && e.detail.rid); });\n"
 ],
 [
  "  lastMenuLoad = null;\n  document.dispatchEvent(new CustomEvent('portal:restaurant', { detail: { rid, sales } }));\n  return lastMenuLoad;   // shell-wait r7: the catalog's first load — the shell's reveal waits for it (bounded)\n",
  "  document.dispatchEvent(new CustomEvent('portal:restaurant', { detail: { rid, sales } }));\n"
 ]
];
function withoutSw(src) {
  let out = src;
  for (const [now, was] of SW_HUNKS) {
    assert.equal(out.split(now).length - 1, 1, `shell-wait hunk occurs exactly once: ${now.trim().slice(0, 80)}`);
    out = out.replace(now, () => was);
  }
  return out;
}
// train asm3 (2e): the shell-wait layer (newest) is folded out of app.js before every older fold below
const readSw = (f) => (f === 'app.js' ? withoutSw(read(f)) : read(f));
test('shell-wait (Codex r2 P1 + r3): app.js gains exactly the read-generation hunks + the portal:abandon listener; nothing else', () => {
  // train asm3: through the older folds (DISH PHOTOS B incl. held-state, then T1) to T1_BASE — the base every pin below agrees on
  const was = execFileSync('git', ['show', `${T1_BASE}:xpizza-portal/app.js`], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
  const through = (src) => withoutT1('app.js', withoutPb('app.js', withoutSw(src)));
  assert.notEqual(withoutSw(read('app.js')), read('app.js'), 'non-vacuity: the shell-wait fold changes something');
  assert.equal(through(read('app.js')), was, `app.js minus the shell-wait, DISH PHOTOS B and T1 hunks ≠ ${T1_BASE}`);
  assert.notEqual(through(read('app.js') + '\n// stray\n'), was, 'non-vacuity: a stray edit survives the fold');
  assert.equal(read('app.js').split("addEventListener('portal:abandon'").length - 1, 1, 'one listener');
  assert.ok(/addEventListener\('portal:abandon', \(\) => \{ readGeneration \+= 1; \}\)/.test(read('app.js')), 'it bumps ONLY the read generation (never invalidateReview: writes settle)');
});
// ── PLAN-public-menu-display T1 (portal-ui, owner-approved mockup «Cambiar nombre de sección» 2026-10-25): a section's display
// NAME. app.js / editor.js / review.js / render.js gain EXACTLY the hunks named in portalui-guards.t1-hunks.json — each [now,
// was] pair occurs once — and folding them back out gives the T1 base (5f's 7f72757f) byte-for-byte. Every older pin below
// then keeps judging the folded file against its own base, so nothing outside the named hunks can move unnoticed.
const T1_BASE = '7f72757f';
const T1_HUNKS = JSON.parse(readFileSync(join(DIR, 'portalui-guards.t1-hunks.json'), 'utf8'));
function withoutT1(f, src) {
  let out = src;
  for (const [now, was] of T1_HUNKS[f] || []) {
    assert.equal(out.split(now).length - 1, 1, `${f}: T1 hunk occurs exactly once: ${now.trim().slice(0, 80)}`);
    out = out.replace(now, () => was);
  }
  return out;
}
// ── S4 «Editar producto»: editor.js gains EXACTLY the hunks in s4-fold.mjs (the header line, pendingCount counting text
// changes, and the editItem block) — folding them out gives S4_BASE byte-for-byte.
test('S4 (item edit): editor.js gains exactly the named hunks — folding them out gives S4_BASE byte-for-byte', () => {
  for (const f of Object.keys(S4_FOLD)) {
    const was = execFileSync('git', ['show', `${S4_BASE}:xpizza-portal/${f}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.notEqual(withoutS4(f, readNow(f)), readNow(f), `non-vacuity: the ${f} fold changes something`);
    assert.equal(withoutS4(f, readNow(f)), was, `${f} minus the S4 hunks ≠ ${S4_BASE}`);
    assert.notEqual(withoutS4(f, readNow(f) + '\n// stray\n'), was, 'non-vacuity: a stray edit survives the fold');
  }
  const [inside] = S4_FOLD['editor.js'].find(([now]) => now.includes('export function editItem('));
  assert.throws(() => withoutS4('editor.js', readNow('editor.js').replace(inside, inside.replace('editItem(', 'editltem('))), 'an edit inside a hunk breaks it');
});

// ── DISH PHOTOS B (PLAN-dish-photos r2 §3): the slice's EXACT hunks in app.js / editor.js / review.js / render.js
// (photos-b-fold.mjs), cut against main PB_BASE (8a31e2a3, which carries T1). Folded out FIRST (it is the newest layer): what
// is left is PB_BASE byte-for-byte, so T1's own registry (portalui-guards.t1-hunks.json) and every pin below keep judging
// exactly what they judged before — a line both slices touch is ONE photos hunk whose `was` is T1's line.
const PB_BASE = '8a31e2a3';
function withoutPb(f, src) {
  let out = src;
  for (const [now, was] of PB_FOLD[f] || []) {
    assert.equal(out.split(now).length - 1, 1, `photos-B hunk occurs exactly once in ${f}: ${now.trim().slice(0, 80)}`);
    out = out.replace(now, () => was);
  }
  return out;
}
// train asm3 (2e): PP_BASE (3d1ae27e) predates two layers merged before F-2 in this train — shell-wait (SW_HUNKS) and the
// portal held-state slice, whose app.js hunks live in the DISH PHOTOS B registry (photos-b-fold.mjs; each names «held-state»).
// The F-2 pin folds both out of the F-2-folded app.js, so it still judges exactly PP_BASE.
const HS_APP = PB_FOLD['app.js'].filter(([now]) => now.includes('held-state'));
function withoutHs(src) {
  assert.equal(HS_APP.length, 3, 'the held-state slice registers exactly 3 app.js hunks');
  let out = src;
  for (const [now, was] of HS_APP) {
    assert.equal(out.split(now).length - 1, 1, `held-state hunk occurs exactly once: ${now.trim().slice(0, 80)}`);
    out = out.replace(now, () => was);
  }
  return out;
}
const newerThanPp = (f, src) => (f === 'app.js' ? withoutHs(withoutSw(src)) : src);
test('F-2: exactly the named hunks in app.js / review.js — folding them out gives PP_BASE byte-for-byte; an edit outside or inside one fails', () => {
  for (const f of ['app.js', 'review.js']) {
    assert.ok((PP_FOLD[f] || []).length > 0, `non-vacuity: ${f} has named hunks`);
    assert.notEqual(read(f), rawRead(f), `non-vacuity: the ${f} fold changes something`);
    const was = execFileSync('git', ['show', `${PP_BASE}:xpizza-portal/${f}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(newerThanPp(f, read(f)), was, `${f} minus the F-2 hunks (and the newer shell-wait / held-state layers) ≠ ${PP_BASE}`);
    assert.notEqual(newerThanPp(f, withoutPp(f, rawRead(f) + '\n// stray\n')), was, 'a stray edit survives the fold');
  }
  const [inside] = PP_FOLD['app.js'].find(([now]) => now.includes('platform_changes_pending'));
  assert.throws(() => withoutPp('app.js', rawRead('app.js').replace(inside, inside.replace('platform_changes_pending', 'platform_changes_pendinq'))));
});
test('DISH PHOTOS B: exactly the named hunks in the four frozen files — anything else, or an edit inside one, fails', () => {
  for (const f of ['app.js', 'editor.js', 'review.js', 'render.js']) {
    assert.ok((PB_FOLD[f] || []).length > 0, `non-vacuity: ${f} has named hunks`);
    assert.notEqual(withoutPb(f, readSw(f)), readSw(f), `non-vacuity: the ${f} fold changes something`);
    const was = execFileSync('git', ['show', `${PB_BASE}:xpizza-portal/${f}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(withoutPb(f, readSw(f)), was, `${f} minus the DISH PHOTOS B hunks ≠ ${PB_BASE}`);
  }
  // a stray edit outside the hunks survives the fold (and so fails the byte pins); an edit INSIDE one breaks its match
  const stray = read('render.js').replace('export function renderDetail(', 'export function renderDetail (');
  assert.notEqual(withoutT1('render.js', withoutPb('render.js', stray)), base('render.js'));
  const [inside] = PB_FOLD['editor.js'].find(([now]) => now.includes('setPhoto'));   // the hunk that DEFINES setPhoto
  assert.throws(() => withoutPb('editor.js', read('editor.js').replace(inside, inside.replace('setPhoto', 'setPhot0'))));
});
const appJs = () => withoutFs(withoutT1('app.js', withoutPb('app.js', withoutSw(read('app.js')))));
test('T1 (PLAN-public-menu-display): exactly the named hunks — folding them out gives the T1 base byte-for-byte', () => {
  for (const f of ['app.js', 'editor.js', 'review.js', 'render.js']) {
    const was = execFileSync('git', ['show', `${T1_BASE}:xpizza-portal/${f}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.ok((T1_HUNKS[f] || []).length > 0, `${f}: the fold is not empty`);
    assert.equal(withoutT1(f, withoutPb(f, readSw(f))), was, `${f} minus the T1 hunks ≠ ${T1_BASE}`);
    // non-vacuity: a stray extra edit survives the fold
    assert.notEqual(withoutT1(f, withoutPb(f, readSw(f) + '\n// stray\n')), was);
  }
  // the DRAFT side writes a section's NAME and nothing else: editor.js's only new property assignment is `cat.name = …`
  const writes = T1_HUNKS['editor.js'].flatMap(([now]) => [...now.matchAll(/\b\w+\.\w+\s*=[^=>]/g)].map((m) => m[0].replace(/\s*=.*$/, '')));
  assert.deepEqual(writes, ['cat.name'], `editor.js T1 writes: ${writes.join(', ')}`);
});
test('app.js field state (train-3 follow-up): exactly the four named lines; no field toggles the global .err block', () => {
  assert.ok(withoutFs(read('app.js')) !== read('app.js'), 'non-vacuity: the fold changes something');
  assert.ok(!/classList\.(add|toggle)\('err'/.test(read('app.js')), 'no app.js element is given the global .err class');
});

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
  assert.equal(withoutTd(appJs()), was, 'app.js minus the T-d hunks ≠ the pre-T-d app.js');
  // the publish path itself carries no T-d line: runPublish / settle / the attestation are byte-identical top-level statements
  const now = topLevel(appJs());
  for (const keep of ['async function runPublish() {', 'function syncUi() {', 'function showOutcome(outcome) {']) {
    assert.ok(now.some((x) => x.startsWith(keep)) && topLevel(was).some((x) => x.startsWith(keep) && now.includes(x)), `byte-identical: ${keep}`);
  }
  // non-vacuity: the fold really removes something, and a stray extra edit would survive it
  assert.ok(withoutTd(appJs()).length < appJs().length);
  assert.notEqual(withoutTd(appJs().replace('function syncUi() {', 'function syncUi() { ')), was);
});

test('app.js: exactly the four named §5.2 changes, every other top-level statement byte-identical', () => {
  const now = topLevel(withoutTd(appJs()));   // T-d's own hunks are judged by the test above
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
    assert.equal(withoutT1(f, withoutPb(f, readSw(f))), base(f), `${f} changed (beyond the named shell-wait, DISH PHOTOS B and T1 hunks)`);   // each layer's hunks are judged by its own test above
  }
});

// ── brand-agnostic ──
const LITERALS = [/x_pizza/i, /la_musa/i, /\bX\.? ?Pizza\b/i, /\bLa Musa\b/i, /15\.5074/, /-88\.0398/, /15\.50414/, /-88\.03848/, /97952893/, /93736607/];
const hits = (src) => LITERALS.reduce((n, re) => n + (src.match(new RegExp(re.source, `${re.flags.replace('g', '')}g`)) || []).length, 0);
const NEW_PORTAL = ['shell.js', 'branches-view.js', 'pausas.js', 'availability.js', 'branch-logic.js', 'ops-dom.js',
  'team.js', 'team-logic.js', 'invite-mail.js', 'pubreq.js', 'aceptar.js', 'equipos.js', 'branch-1b-logic.js'];   // + 1b   // + 3a's T-b / T-c / T-d modules (aceptar-boot.js holds the
  // Functions BASE URL — the GCP project id, exactly as api.js does — so it is not a zero-literal module)
const NEW_SERVER = ['portal/ops-core.js', 'portal/ops-functions.js', 'portal/location-name.js', 'portal/pause-reasons.js', 'portal/reset-list.js', 'lib/hn-date.js'];
const EXISTING = ['index.html', 'styles.css', 'app.js', 'api.js', 'boot.js', 'ventas.js', 'render.js', 'editor.js', 'review.js', 'portal-logic.js', 'ventas-logic.js'];

test('BRAND-AGNOSTIC: zero restaurant / brand literals in every new portal and ops module', () => {
  for (const f of NEW_PORTAL) assert.equal(hits(read(f)), 0, `${f} names a restaurant`);
  for (const f of NEW_SERVER) assert.equal(hits(readFn(f)), 0, `${f} names a restaurant`);
  // non-vacuity: the pattern set does catch the real ids
  assert.ok(hits("rid === 'x_pizza' || name === 'La Musa'") >= 2);
});

// PLAN-portal-fonts r1.1: index.html's Functions-origin PRECONNECT carries the GCP project id (`xpizza-delivery`), which the
// /X.?Pizza/ pattern counts — the same project-id case as api.js's BASE (not a brand choice). That one exact link is excluded.
const FN_PRECONNECT = /<link rel="preconnect" href="https:\/\/us-central1-xpizza-delivery\.cloudfunctions\.net" crossorigin>/g;
test('BRAND-AGNOSTIC: the pre-existing portal files gain no literal (counts frozen against the base)', () => {
  for (const f of EXISTING) { const now = f === 'index.html' ? read(f).replace(FN_PRECONNECT, '') : read(f); assert.ok(hits(now) <= hits(base(f)), `${f}: ${hits(base(f))} → ${hits(now)} brand literals`); }
  assert.ok(FN_PRECONNECT.test(read('index.html')), 'non-vacuity: the excluded link is the one index.html carries');
});

// ── slice 2 (PLAN-portal-ui-slice2-equipos r1.1 §5, codex plan r1 P2-4): app.js / ventas.js are BYTE-EQUAL to the approved stack
// tip the slice is built on. The historical 1a proofs above stay pinned to their own base (BASE).
// train/next-after-2920b705: slice 2 merges onto 6d0dd582 (… + T-d, which edits app.js's api import) — pinned to that train parent.
const SLICE2_BASE = '6d0dd582';
test('slice 2: app.js and ventas.js are byte-identical to the approved stack tip', () => {
  for (const f of ['app.js', 'ventas.js']) {
    const was = execFileSync('git', ['show', `${SLICE2_BASE}:xpizza-portal/${f}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(f === 'app.js' ? appJs() : read(f), was, `${f} changed since ${SLICE2_BASE}`);
  }
});

test('STRUCTURE S1: app.js / editor.js / item-edit-logic.js gain exactly the named hunks — folding them out gives S1_BASE byte-for-byte', () => {
  for (const f of Object.keys(S1_FOLD)) {
    const was = execFileSync('git', ['show', `${S1_BASE}:xpizza-portal/${f}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.notEqual(withoutS1(f, fileRead(f)), fileRead(f), `non-vacuity: the ${f} fold changes something`);
    assert.equal(legacy(f, withoutS1(f, fileRead(f))), was, `${f} minus the S1 hunks ≠ ${S1_BASE}`);
    assert.notEqual(legacy(f, withoutS1(f, fileRead(f) + '\n// stray\n')), was, 'non-vacuity: a stray edit survives the fold');
  }
  const inside = S1_FOLD['editor.js'].map(([now]) => now).find((t) => t.includes('export function extrasBaseline('));
  assert.ok(inside, 'premise: the baseline is one of the hunks');
  assert.throws(() => withoutS1('editor.js', fileRead('editor.js').replace(inside, inside.replace('legacy rules still applied', 'legacy rules still appliedX'))), 'an edit inside a hunk breaks it');
});

test('STRUCTURE S2: app.js / editor.js / item-edit-logic.js gain exactly the named hunks — folding them out gives S2_BASE byte-for-byte', () => {
  for (const f of Object.keys(S2_FOLD)) {
    const was = execFileSync('git', ['show', `${S2_BASE}:xpizza-portal/${f}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.notEqual(withoutS2(f, portalOnDisk(f)), portalOnDisk(f), `non-vacuity: the ${f} fold changes something`);
    assert.equal(legacy(f, withoutS2(f, portalOnDisk(f))), was, `${f} minus the S2 hunks ≠ ${S2_BASE}`);
    assert.notEqual(legacy(f, withoutS2(f, portalOnDisk(f) + '\n// stray\n')), was, 'non-vacuity: a stray edit survives the fold');
  }
  const inside = S2_FOLD['editor.js'].map(([now]) => now).find((t) => t.includes('export function composeDish('));
  assert.ok(inside, 'premise: the composition is one of the hunks');
  assert.throws(() => withoutS2('editor.js', portalOnDisk('editor.js').replace(inside, inside.replace('before any exposure op', 'before any exposure opX'))), 'an edit inside a hunk breaks it');
});

test('LIVE HOTFIX 11-12: app.js gains exactly the named hunk (the uploader\u2019s op_ id) — folding it out gives HF_BASE byte-for-byte', () => {
  for (const f of Object.keys(HF_FOLD)) {
    const was = execFileSync('git', ['show', `${HF_BASE}:xpizza-portal/${f}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.notEqual(withoutHotfix(f, mainBytes(f)), mainBytes(f), `non-vacuity: the ${f} fold changes something`);
    assert.equal(withoutHotfix(f, mainBytes(f)), was, `${f} minus the HOTFIX hunk ≠ ${HF_BASE}`);
    assert.notEqual(withoutHotfix(f, mainBytes(f) + '\n// stray\n'), was, 'non-vacuity: a stray edit survives the fold');
  }
});

test('S1c MINT panel: review.js gains exactly the named hunks — folding them out gives MINT_BASE byte-for-byte', () => {
  for (const f of Object.keys(MINT_FOLD)) {
    const was = execFileSync('git', ['show', `${MINT_BASE}:xpizza-portal/${f}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.notEqual(withoutMint(f, mainBytes(f)), mainBytes(f), `non-vacuity: the ${f} fold changes something`);
    assert.equal(withoutMint(f, mainBytes(f)), was, `${f} minus the MINT hunks ≠ ${MINT_BASE}`);
    assert.notEqual(withoutMint(f, mainBytes(f) + '\n// stray\n'), was, 'non-vacuity: a stray edit survives the fold');
  }
  const inside = MINT_FOLD['review.js'].map(([now]) => now).find((t) => t.includes('mint_unavailable:'));
  assert.ok(inside, 'premise: the panel is one of the hunks');
  assert.throws(() => withoutMint('review.js', mainBytes('review.js').replace(inside, inside.replace('momentáneo', 'momentaneo'))), 'an edit inside a hunk breaks it');
});

test('UNSAVED EDITS: app.js / item-edit-logic.js gain exactly the named hunks — folding them out gives UNSAVED_BASE byte-for-byte', () => {
  for (const f of Object.keys(UNSAVED_FOLD)) {
    const was = execFileSync('git', ['show', `${UNSAVED_BASE}:xpizza-portal/${f}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.notEqual(withoutUnsaved(f, diskRead(f)), diskRead(f), `non-vacuity: the ${f} fold changes something`);
    assert.equal(withoutUnsaved(f, diskRead(f)), was, `${f} minus the UNSAVED hunks ≠ ${UNSAVED_BASE}`);
    assert.notEqual(withoutUnsaved(f, diskRead(f) + '\n// stray\n'), was, 'non-vacuity: a stray edit survives the fold');
  }
  const inside = UNSAVED_FOLD['app.js'].map(([now]) => now).find((t) => t.includes('function requestClose('));
  assert.ok(inside, 'premise: the confirm is one of the hunks');
  assert.throws(() => withoutUnsaved('app.js', diskRead('app.js').replace(inside, inside.replace('Seguir editando', 'Seguir editandO'))), 'an edit inside a hunk breaks it');
});
