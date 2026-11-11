'use strict';
// S1a frozen keys (PLAN-portal-item-edit r6; D4c-grill/item-s1/S1a-DESIGN.md) — the wiring guard. Run: node frozenkeys-wiring.guard.test.js
//   1. The product-text switch ships OFF, and it is the one platform constant (no per-brand value).
//   2. The map is carried at every write / validate / read site the unit tests cannot reach (publish record, pre-publish,
//      pre-flip, the version reader, the portal publish, reset, the CLI) and judged by the switch at save, publish and assessment.
//   3. tools/frozenkeys-module-inverse.js returns each owned file to its BASE byte-for-byte; a byte inside a hunk, a duplicated
//      hunk and a byte outside every hunk are each caught; every owned file takes same-line edits only (all are pinned).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyFrozenKeysModule } = require('./tools/frozenkeys-module-inverse'); const peelS1c = require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule; const peelS1d = require('./tools/s1d-module-inverse').unapplyS1dModule;
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => peelS1c(f, peelS1d(f, require('./tools/pp-module-inverse').unapplyPpModule(f, require('./tools/s2-module-inverse').unapplyS2Module(f, require('./tools/s2core-module-inverse').unapplyS2coreModule(f, fs.readFileSync(path.join(__dirname, f), 'utf8'))))));   // F-1 (portal line, the newer layer — train asm4) is peeled first

// ── 1 ──
{
  assert.match(read('catalog/item-text-edit.js'), /\nconst ITEM_TEXT_EDIT = true;\n/, '🔴 item_text_edit ships ON (owner 2026-11-11: name editing; Codex HIGH GO, codex-ite-flip.txt)');
  assert.strictEqual(require('./catalog/item-text-edit').textEditCapabilities().enabled, true);
  assert.ok(!/'la_musa'|'x_pizza'|"la_musa"|"x_pizza"/.test(read('catalog/item-text-edit.js') + read('catalog/frozen-keys.js')), 'no brand literal in the switch or the map module');
  ok('item_text_edit ships ON, one platform constant; no brand literal in the S1a modules');
}

// ── 2 ──
{
  const MUST = [
    ['catalog/catalog-publish.js', '...(key_mode == null ? {} : { key_mode }), ...(frozen_keys == null ? {} : { frozen_keys }),', 1, 'FKW-RECORD the version record keeps the map'],
    ['catalog/catalog-publish.js', 'if (frozen_keys != null && frozenKeysProblem(frozen_keys)) throw new Error(`write_version_frozen_keys_invalid: ${rid}`);', 1, 'FKW-RECORD-SHAPE a malformed map is never written'],
    ['catalog/catalog-publish.js', 'key_mode: input && input.key_mode, frozen_keys: input && input.frozen_keys }), `${rid} (pre-publish)`', 1, 'FKW-PREPUBLISH'],
    ['catalog/catalog-publish.js', 'key_mode: served.keyMode, frozen_keys: served.frozenKeys }),', 1, 'FKW-PREFLIP the persisted version is judged by its own map (publish and rollback)'],
    ['catalog/catalog-menu.js', '...(record.frozen_keys == null ? {} : { frozenKeys: record.frozen_keys }) };', 1, 'FKW-VERSION-READ'],
    ['catalog/publish-edited-handler.js', '...(draftBuilt.frozen_keys == null ? {} : { frozen_keys: draftBuilt.frozen_keys }),', 1, 'FKW-PORTAL-PUBLISH'],
    ['catalog/publish-edited-handler.js', 'textEdit: textEditCapabilities().enabled,', 1, 'FKW-PUBLISH-SWITCH'],
    ['catalog/publish-edited-handler.js', 'AP.textCapProblems({ draft, live })[0]', 1, 'FKW-PUBLISH-CAPS'],
    ['catalog/publish-edited-handler.js', 'AP.resolveKeyMode(await addProduct.readKeyMode(rid), live.items, draft.frozen_keys);', 1, 'FKW-PUBLISH-MODE'],
    ['catalog/edit-catalog-handler.js', 'const fkOwn = FK.serverOwnedFrozenKeys(source, stored); if (!fkOwn.ok) return reply(409, { error: fkOwn.error });', 1, 'FKW-SAVE-OWNED'],
    ['catalog/edit-catalog-handler.js', 'FK.withFrozenKeys(withServerKeyMode(source, keyModeOwn.key_mode), fkOwn.frozen_keys)', 1, 'FKW-SAVE-KEEP'],
    ['catalog/edit-catalog-handler.js', 'const rec = FK.recordRenames({ draft: candidate, live, stored, textEdit });', 1, 'FKW-SAVE-RECORD'],
    ['catalog/edit-catalog-handler.js', 'AP.resolveKeyMode(await addProduct.readKeyMode(rid), live.items, candidate.frozen_keys);', 1, 'FKW-SAVE-MODE'],
    ['catalog/edit-catalog-handler.js', 'extrasAuthoring: extrasCapabilities().authoring, textEdit,', 1, 'FKW-SAVE-SWITCH'],
    ['catalog/draft-assess.js', 'textEdit: textEditCapabilities().enabled,', 1, 'FKW-ASSESS-SWITCH'],
    ['catalog/reset-draft.js', "if (keepFk) payload.frozen_keys = { ...storedFk, ...(projected.frozen_keys || {}) };", 1, 'FKW-RESET-UNION recorded renames are never dropped'],
    ['catalog/reset-draft.js', 'frozen_keys: preview.record && preview.record.frozen_keys }), deleted_ids: null,', 1, 'FKW-RESET-VALIDATE'],
    ['tools/publish-version.js', '...(built.frozen_keys == null ? {} : { frozen_keys: built.frozen_keys }) }, expected };', 1, 'FKW-CLI'],
  ];
  for (const [f, text, count, label] of MUST) assert.strictEqual(read(f).split(text).length - 1, count, `🔴 ${label}: ${f} must carry the map here (${count}×)`);
  ok(`${MUST.length} record / pre-publish / pre-flip / reader / publish / save / assess / reset / CLI carries are in place`);
}

// The inverse round-trip runs LAST: a mutant in an owned file breaks it, so every named pin above must get its turn first.
// ── 3 ──
const pinnedElsewhere = new Set();
for (const t of fs.readdirSync(path.join(__dirname, 'tools')).filter((x) => /-inverse\.js$/.test(x) && x !== 'frozenkeys-module-inverse.js')) {
  const txt = fs.readFileSync(path.join(__dirname, 'tools', t), 'utf8');
  for (const f of FILES) if (txt.includes(`"${f}"`) || txt.includes(`'${f}'`)) pinnedElsewhere.add(f);
}
assert.ok(pinnedElsewhere.has('catalog/source-store.js') && pinnedElsewhere.has('catalog/catalog-publish.js'), 'premise: the older layers are found');
for (const f of FILES) {
  const src = read(f);
  const b = execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
  assert.notStrictEqual(src, b, `non-vacuity: ${f} differs from ${BASE}`);
  assert.strictEqual(unapplyFrozenKeysModule(f, src), b, `🔴 ${f} minus the S1a frozen-keys hunks is not ${BASE}:${f}`);
  assert.strictEqual(src.split('\n').length, b.split('\n').length, `🔴 ${f}: same-line edits only`);
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = h.now.search(/[A-Za-z]/);
    assert.throws(() => unapplyFrozenKeysModule(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${f}: a byte INSIDE a hunk`);
    assert.throws(() => unapplyFrozenKeysModule(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(unapplyFrozenKeysModule(f, '\n' + src), b, `${f}: a byte OUTSIDE every hunk survives`);
}
assert.strictEqual(unapplyFrozenKeysModule('tb-unowned.js', 'x\n'), 'x\n', 'an unowned file passes through');
ok(`${FILES.length} files → ${BASE} byte-for-byte (${pinnedElsewhere.size} pinned by older layers), same-line only; inside / duplicate / outside caught (${HUNKS.length} hunks)`);

console.log(`\nfrozenkeys-wiring.guard: OK (${n})`);
