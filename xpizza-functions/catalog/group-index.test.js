'use strict';
// 1D add-product B (rev 6, UNIFORM) — the group index, its baked fallback, the gate snapshot's groups, and the two
// platform switches. Run: node catalog/group-index.test.js
const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');
const { groupIndexFrom, bareLauncherKeys } = require('./group-index');
const { canonicalize, sourceToBuildInputs } = require('./source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const { createGateReader, staticGroupsFallback } = require('./menu-gates');
const { deriveFallbackGroups, RENDER_FALLBACK_GROUPS } = require('../tools/generate-renderer-contract');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (x) => JSON.parse(JSON.stringify(x));
const built = (rid, src = canonicalize(buildSourceFromCode(rid))) => {
  const i = sourceToBuildInputs(src);
  return buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable, extrasTable: i.extras });
};

(async () => {
  {
    const lm = groupIndexFrom(built('la_musa'));
    assert.strictEqual(lm.ok, true);
    assert.deepStrictEqual([...lm.launchers], ['noodle_01'], 'the Pad Thai launcher, by PRICING key');
    assert.deepStrictEqual([...lm.parentOf].sort(), [['noodle_01_camaron', 'noodle_01'], ['noodle_01_pollo', 'noodle_01'], ['noodle_01_sin', 'noodle_01']]);
    const xp = groupIndexFrom(built('x_pizza'));
    assert.deepStrictEqual([xp.ok, xp.launchers.size, xp.parentOf.size], [true, 0, 0], 'no groups → an empty, READABLE index');
    assert.deepStrictEqual(bareLauncherKeys(['noodle_01_pollo', 'noodle_01', 'noodle_01', 'dimsum_01'], lm), ['noodle_01'], 'bare launcher lines, deduplicated');
    ok('the real catalogs: la_musa’s Pad Thai is one launcher with three variant parents (by pricing key); x_pizza has none');
  }
  {
    const b = built('la_musa');
    const withVi = (vi) => { const c = clone(b); if (vi === undefined) delete c.structure.variant_items; else c.structure.variant_items = vi; return c; };
    // codex PB-1 r1 P1-2: a map that is ABSENT or EMPTY while items still declare variantOf is CONTRADICTORY → unreadable
    assert.strictEqual(groupIndexFrom(withVi(undefined)).ok, false, '🔴 map ABSENT while Pad Thai\'s choices still declare variantOf → unreadable (never "no launchers")');
    assert.strictEqual(groupIndexFrom(withVi({})).ok, false, '🔴 map {} while choices declare variantOf → unreadable');
    const noChoices = clone(b); delete noChoices.structure.variant_items;
    noChoices.items = noChoices.items.filter((it) => it.display.variantOf === undefined);
    assert.deepStrictEqual([groupIndexFrom(noChoices).ok, groupIndexFrom(noChoices).launchers.size], [true, 0], 'ABSENT with no item declaring variantOf = no groups');
    const vids = b.structure.variant_items.noodle_01.variantIds;
    assert.strictEqual(groupIndexFrom(withVi({ noodle_01: { label: 'L', variantIds: vids.slice(0, 2) } })).ok, false, '🔴 the reverse direction: a choice no entry lists → unreadable');
    assert.strictEqual(groupIndexFrom(withVi({ noodle_01: { label: 'L', variantIds: [...vids, vids[0]] } })).ok, false, '🔴 one choice listed twice → unreadable');
    for (const bad of [null, 'x', 7, []]) assert.strictEqual(groupIndexFrom(withVi(bad)).ok, false, `present but ${JSON.stringify(bad)} → unreadable`);
    assert.strictEqual(groupIndexFrom(withVi({ ghost: { label: 'L', variantIds: ['noodle_01_pollo'] } })).ok, false, 'a launcher id that resolves to no item');
    assert.strictEqual(groupIndexFrom(withVi({ noodle_01: { label: 'L', variantIds: ['nope'] } })).ok, false, 'a variant id that resolves to no item');
    assert.strictEqual(groupIndexFrom(withVi({ dimsum_01: { label: 'L', variantIds: ['noodle_01_pollo'] } })).ok, false, 'a variant listed by one launcher but pointing at another');
    assert.strictEqual(groupIndexFrom(withVi({ noodle_01: { label: 'L' } })).ok, false, 'no variantIds');
    assert.strictEqual(groupIndexFrom({ items: null, structure: {} }).ok, false);
    assert.strictEqual(groupIndexFrom(null).ok, false);
    ok('fail-closed, BOTH directions: absent/{} with declared choices, an unlisted choice, a doubly-listed one, or a map that cannot be read as written are UNREADABLE (never "no launchers"); absent with no choices = no groups');
  }
  {
    assert.strictEqual(readFileSync(join(__dirname, 'fallback-groups.generated.js'), 'utf8'), RENDER_FALLBACK_GROUPS(deriveFallbackGroups()),
      '🔴 the baked fallback groups do not match the code catalogs — regenerate with tools/generate-renderer-contract.js');
    const lm = staticGroupsFallback('la_musa');
    assert.deepStrictEqual([[...lm.launchers], lm.parentOf.get('noodle_01_sin')], [['noodle_01'], 'noodle_01']);
    assert.deepStrictEqual([staticGroupsFallback('x_pizza').launchers.size, staticGroupsFallback('nobody').launchers.size], [0, 0]);
    ok('the baked fallback groups are byte-identical to a fresh derivation from the code catalogs; an unknown brand has none');
  }
  {
    const lmBuilt = built('la_musa');
    const reader = (getMenu) => createGateReader({ getMenu, getVersionId: async () => 'v1', deadlineMs: 200 });
    const healthy = await reader(async () => lmBuilt).intakeGatesFor('la_musa');
    // (`fallback` is the pre-existing "weekend gate unauthored" flag — true for la_musa, which authors no weekend
    //  categories — so the paths are told apart by what they return, not by it.)
    assert.deepStrictEqual([...healthy.groups.launchers], ['noodle_01'], 'healthy: the groups of the SAME snapshot as `known`');
    assert.strictEqual(healthy.known.size, lmBuilt.items.length, 'healthy: `known` is this snapshot’s items');
    assert.ok(healthy.known.has('noodle_01') && healthy.known.has('noodle_01_pollo'));
    const failed = await reader(async () => { throw new Error('read down'); }).intakeGatesFor('la_musa');
    assert.deepStrictEqual([...failed.groups.launchers], ['noodle_01'], '🔴 read failure: the baked code groups — a code launcher is still bare');
    assert.deepStrictEqual([...failed.known].sort(), [...require('./menu-gates').staticKnownFallback('la_musa')].sort(), 'read failure: `known` is the code dishes');
    const broken = clone(lmBuilt); broken.structure.variant_items = { noodle_01: { label: 'P', variantIds: ['missing'] } };
    const unread = await reader(async () => broken).intakeGatesFor('la_musa');
    assert.strictEqual(unread.groups, null, '🔴 an unreadable map is reported as UNCLASSIFIABLE (null), never as no launchers');
    assert.deepStrictEqual([unread.fallback, unread.known.size, [...unread.weekend]], [healthy.fallback, healthy.known.size, [...healthy.weekend]],
      'and every OTHER gate is untouched — the dormant slice changes nothing until the render capability turns the rules on');
    ok('the gate snapshot: groups from the same version as `known`; the read-failure fallback carries the baked code groups; an unreadable map is null and changes no other gate');
  }
  {
    const pg = require('./platform-groups');
    assert.deepStrictEqual(pg.groupCapabilities(), { render: true, authoring: false }, 'PB-2 (§0b.3(b)/(c)): render is ON — both forms ship the picker; authoring stays OFF until the portal (§0b.3(e))');
    for (const bad of [{}, { render: 'yes' }, null, { render: 1 }]) {
      assert.throws(() => pg.parseRender(bad), /platform_groups_malformed/, `a malformed render artifact (${JSON.stringify(bad)}) is refused, never read as on`);
    }
    assert.deepStrictEqual([pg.parseRender({ render: true }), pg.parseRender({ render: false })], [true, false], 'a well-formed artifact is read as written');
    const { deriveRender, RENDER_PLATFORM } = require('../tools/generate-renderer-contract');
    assert.strictEqual(readFileSync(join(__dirname, 'platform-render.generated.js'), 'utf8'), RENDER_PLATFORM(deriveRender()),
      '🔴 the committed render capability does not match the shipped forms — regenerate with tools/generate-renderer-contract.js');
    assert.strictEqual(deriveRender(), true, 'both shipped forms carry the shared group picker → render is on');
    // STRICT: the exact tag in index.html (once) AND the declaration in the module beside it — each alone leaves it OFF
    {
      const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('fs');
      const os = require('os');
      const tmp = mkdtempSync(join(os.tmpdir(), 'render-marker-'));
      const root = join(tmp, 'a', 'b');
      mkdirSync(root, { recursive: true });
      const TAG = '<script src="form-group-picker.js"></script>';
      const MOD = 'const GROUP_PICKER_V1 = 1;\n';
      const lay = (form, { html, mod }) => {
        const d = join(tmp, form); mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'index.html'), html);
        if (mod === null) { try { rmSync(join(d, 'form-group-picker.js')); } catch (_) {} } else writeFileSync(join(d, 'form-group-picker.js'), mod);
      };
      const both = (spec) => { lay('xpizza-orders', spec); lay('la-musa-orders', { html: `<html>${TAG}</html>`, mod: MOD }); return deriveRender(root); };
      try {
        assert.strictEqual(both({ html: `<html>${TAG}</html>`, mod: MOD }), true, 'premise: tag + declared module → on');
        assert.strictEqual(both({ html: '<html></html>', mod: MOD }), false, 'a module nobody loads → off');
        assert.strictEqual(both({ html: `<html>${TAG}${TAG}</html>`, mod: MOD }), false, 'the tag twice → off (exactly one)');
        assert.strictEqual(both({ html: '<html><script src="form-group-picker.js" defer></script></html>', mod: MOD }), false, 'not the exact tag → off');
        assert.strictEqual(both({ html: `<html>${TAG}</html>`, mod: null }), false, 'a tag naming a file that is not there → off');
        assert.strictEqual(both({ html: `<html>${TAG}</html>`, mod: '// GROUP_PICKER_V1 someday\n' }), false, 'the marker only in a comment → off');
        assert.strictEqual(both({ html: `<!-- GROUP_PICKER_V1 --><html></html>`, mod: MOD }), false, 'the marker in the HTML alone → off');
        // codex PB-2 r1 P2-5 — its two exact substitutions, each alone: a COMMENTED-OUT tag; a module whose declaration is commented out
        assert.strictEqual(both({ html: `<html><!-- ${TAG} --></html>`, mod: MOD }), false, '🔴 the tag only inside an HTML comment → off');
        assert.strictEqual(both({ html: `<html>${TAG}</html>`, mod: '// const GROUP_PICKER_V1 = 1;\n' }), false, '🔴 the declaration only in a // comment → off');
        assert.strictEqual(both({ html: `<html>${TAG}</html>`, mod: '/*\nconst GROUP_PICKER_V1 = 1;\n*/\n' }), false, 'the declaration only in a block comment → off');
        assert.strictEqual(both({ html: `<html>${TAG}</html>`, mod: 'const s = "const GROUP_PICKER_V1 = 1;";\n' }), false, 'the declaration only inside a string → off');
        assert.strictEqual(both({ html: `<html><script>var t = '${TAG}';</script></html>`, mod: MOD }), false, 'the tag only inside an inline script\'s text → off');
        assert.strictEqual(both({ html: `<html><!-- ${TAG} -->${TAG}</html>`, mod: '// the picker\nconst GROUP_PICKER_V1 = 1;\n' }), true, 'premise kept: a real tag + a real declaration, beside comments → on');
      } finally { rmSync(tmp, { recursive: true, force: true }); }
    }
    const src = readFileSync(join(__dirname, 'platform-groups.js'), 'utf8');
    assert.ok(!/restaurant|rid\b|x_pizza|la_musa/i.test(src.replace(/\/\/.*$/gm, '')), 'no brand anywhere in the switch module');
    ok('the two PLATFORM switches: render ON (derived STRICTLY from the shipped forms — tag once + declared module, in ACTIVE markup and EXECUTABLE code; 11 near-misses each off, incl. codex\'s commented-out tag and declaration), authoring OFF; a malformed render artifact throws; no brand appears in the module');
  }
  console.log(`\ngroup-index: OK (${n})`);
})().catch((e) => { console.error('group-index FAILED:', e); process.exit(1); });
