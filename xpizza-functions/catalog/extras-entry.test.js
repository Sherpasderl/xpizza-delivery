'use strict';
// S1 (per-dish extras; owner decision 11-11 «the frozen forms keep offering every extra until they retire») — the extras check is
// scoped to APP entries. Through the REAL pieces end to end (Codex S1 r1 P1: the mode is the reader's OBJECT, never a string): the real
// mode reader (createExtrasModeReader over a stored node: absent / off / shadow / enforce / a failed read) → modeFor → the real
// extrasCheck over the real built tables and the real eligibility document of a version that DENIES an extra on a dish.
//   a FORM request (no entry_mode / 'direct'): outcome 'skip' — no refusal — in every configuration, and the runtime mode is never read
//   an APP request: judged under the runtime mode (enforce → denied; a failed cold read → unavailable)
// Run: node catalog/extras-entry.test.js
const assert = require('assert');
const { modeFor } = require('./extras-entry');
const EI = require('./extras-intake');
const { buildEligibilityDoc } = require('./extras-eligibility-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { buildTablesFromDocs } = require('./catalog-transform');
const { attachTablesKeyMode } = require('../menu-pricing');
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

(async () => {
  const rid = 'la_musa';
  const src = buildSourceFromCode(rid);
  const dish = 'rice_02', denied = 'rice_white';
  src.structure.exposure.item_overrides[dish] = { ...(src.structure.exposure.item_overrides[dish] || {}), deny_extras: [denied] };
  const { built } = buildSourceCandidate(rid, src);
  const tables = { ...attachTablesKeyMode({ restaurantId: rid, ...buildTablesFromDocs(built.items.map((i) => ({ key: i.key, price: i.price })), built.extras.map((e) => ({ key: e.key, price: e.price }))) }, built.key_mode), versionId: 'v1' };
  const doc = buildEligibilityDoc({ items: built.items, extras: built.extras, structure: built.structure });
  const items = [{ id: dish, name: dish, qty: 1, price: 0, extras: [{ id: denied, qty: 1, price: 1 }] }];
  const check = (mode) => EI.extrasCheck({ mode, tables, items, rid, envelopeOf: (t) => ({ versionId: t.versionId }), readEligibility: async () => doc });
  const readerOf = (node) => EI.createExtrasModeReader({ read: async () => { if (node === 'THROW') throw new Error('down'); return node; } });

  for (const node of [undefined, 'off', 'shadow', 'enforce', 'THROW']) {
    await cell(`XE-FORM ${String(node)}: a form request skips the check (no refusal) and never reads the mode`, async (L) => {
      let reads = 0; const r = readerOf(node);
      for (const body of [{}, { entry_mode: 'direct' }, { entry_mode: 'APP' }]) {
        const mode = await modeFor(body, () => { reads += 1; return r.getMode(); });
        const out = await check(mode);
        assert.strictEqual(out.outcome, 'skip', `${L} ${JSON.stringify(body)}: outcome (${JSON.stringify(out)})`);
        assert.strictEqual(EI.refuses(out), false, `${L}: never a refusal`);
      }
      assert.strictEqual(reads, 0, `${L}: the runtime mode is not read for a form request`);
    });
  }
  await cell('XE-APP enforce: an app request with the denied extra is denied (and refused)', async (L) => {
    const out = await check(await modeFor({ entry_mode: 'app' }, () => readerOf('enforce').getMode()));
    assert.deepStrictEqual([out.outcome, out.mode, EI.refuses(out)], ['denied', 'enforce', true], `${L} (${JSON.stringify(out)})`);
  });
  await cell('XE-APP shadow: an app request is judged (would-refuse, not refused)', async (L) => {
    const out = await check(await modeFor({ entry_mode: 'app' }, () => readerOf('shadow').getMode()));
    assert.deepStrictEqual([out.outcome, out.mode, EI.refuses(out)], ['denied', 'shadow', false], `${L} (${JSON.stringify(out)})`);
  });
  await cell('XE-APP cold read failure: an app request is unavailable (today\'s rule)', async (L) => {
    const out = await check(await modeFor({ entry_mode: 'app' }, () => readerOf('THROW').getMode()));
    assert.strictEqual(out.outcome, 'unavailable', `${L} (${JSON.stringify(out)})`);
  });
  if (fails.length) { console.log(`extras-entry FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`extras-entry: OK (${n})`);
})();
