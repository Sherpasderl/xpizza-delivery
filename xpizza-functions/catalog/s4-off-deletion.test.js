'use strict';
// Codex #231 P2 (S4 carry, round 2) — with SECTIONS OFF, a stored draft that DELETES staged_categories (published while sections were ON)
// must be refused like a normal save's deletion, at the save, the owner publish AND the manager request. The OFF branch of
// section-compare delegates to add-product's residual accounting, which skips structure fields the draft does not author, so the
// whole key's removal escaped comparison: 200 on all three with an empty review diff, and the published structure lost the staged
// category. The REAL editCatalogCore / publishEditedCore / requestPublishCore on the s2core harness (test/_s2core-harness.js); the ON
// phase is the REAL save that stores the staged category, whose source then IS the active version of the OFF world.
// Run: node catalog/s4-off-deletion.test.js
const assert = require('assert');
const S = { sections: true };
{ const p = require.resolve('./platform-structure'); const real = require(p); require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, structureCapabilities: () => ({ ...real.structureCapabilities(), sections: S.sections }) } }; }
const H = require('../test/_s2core-harness');
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const code = (r) => (r && r.status === 200 ? 200 : r && r.body && (r.body.error || r.body.code));
const quiet = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };
const LIVE = (() => { const s = buildSourceFromCode('x_pizza'); s.structure.categories.forEach((c) => { c.name = c.id === 'ny' ? 'NY' : 'Individual'; }); return s; })();
const STAGED = [{ id: 'postres', name: 'Postres', after: null }];

// the ON phase: the REAL save stores the staged category and the REAL owner publish accepts it → that source is what went live
async function publishedWithStaged() {
  S.sections = true;
  const w = H.world('x_pizza', { live: LIVE });
  const saved = await quiet(() => w.save((d) => { d.structure.staged_categories = clone(STAGED); }));
  assert.strictEqual(saved.status, 200, `premise: sections ON → the staged save is accepted (${JSON.stringify(saved.body)})`);
  const { token } = await w.tokenFor();
  const pub = await quiet(() => w.ownerPublish(token));
  assert.strictEqual(pub.status, 200, `premise: sections ON → the staged draft publishes (${JSON.stringify(pub.body)})`);
  const { source } = await w.draft();
  assert.deepStrictEqual(source.structure.staged_categories, STAGED, 'premise: the published source carries the staged category');
  return source;
}

(async () => {
  const active = await publishedWithStaged();
  await cell('S4-OFF-DELETE-STAGED (Codex #231 P2): sections OFF, active HAS staged_categories, a STORED draft without the key → the save, the owner publish and the manager request all refuse structure_changed; nothing publishes, no request is filed', async (L) => {
    S.sections = false;
    try {
      const w = H.world('x_pizza', { live: active });
      const d = clone(active); delete d.structure.staged_categories; await w.store(d);
      const saved = await quiet(() => w.save(() => {}));   // a no-op save of the stored draft
      const { token } = await w.tokenFor();               // the REAL token of what is stored
      const pub = await quiet(() => w.ownerPublish(token));
      const req = await quiet(() => w.request(token));
      assert.deepStrictEqual({ save: code(saved), publish: code(pub), request: code(req) }, { save: 'structure_changed', publish: 'structure_changed', request: 'structure_changed' },
        `🔴 S4-OFF-DELETE-STAGED: ${JSON.stringify({ save: saved.body, publish: pub.body, request: req.body })}`);
      assert.strictEqual(w.publishes.length, 0, `${L}: nothing published`);
      assert.strictEqual(await w.slot(), null, `${L}: no request filed`);
    } finally { S.sections = true; }
  });
  await cell('S4-OFF-STAGED-VALUE (unchanged path): sections OFF, a stored draft that CHANGES the staged value (key kept) → still refused structure_unexplained on all three (the delegation judges it; the P2 fix touches only the absent key)', async () => {
    S.sections = false;
    try {
      const w = H.world('x_pizza', { live: active });
      const d = clone(active); d.structure.staged_categories = [{ ...STAGED[0], name: 'Dulces' }]; await w.store(d);
      const saved = await quiet(() => w.save(() => {}));
      const { token } = await w.tokenFor();
      const pub = await quiet(() => w.ownerPublish(token));
      const req = await quiet(() => w.request(token));
      assert.deepStrictEqual({ save: code(saved), publish: code(pub), request: code(req) }, { save: 'structure_unexplained', publish: 'structure_unexplained', request: 'structure_unexplained' },
        `🔴 S4-OFF-STAGED-VALUE: ${JSON.stringify({ save: saved.body, publish: pub.body, request: req.body })}`);
    } finally { S.sections = true; }
  });
  await cell('S4-OFF-KEEP-STAGED (control): sections OFF, the draft keeps the active staged_categories unchanged → an ordinary edit still saves and publishes (the check refuses the change, not the key)', async (L) => {
    S.sections = false;
    try {
      const w = H.world('x_pizza', { live: active });
      const saved = await quiet(() => w.save(() => {}));
      assert.strictEqual(saved.status, 200, `${L}: ${JSON.stringify(saved.body)}`);
      const { token } = await w.tokenFor();
      const pub = await quiet(() => w.ownerPublish(token));
      assert.strictEqual(pub.status, 200, `${L}: ${JSON.stringify(pub.body)}`);
    } finally { S.sections = true; }
  });
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`s4-off-deletion: OK(${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
