'use strict';
// PLAN-guest-checkout-server §3.3 (S3c) — the platform legal CLI: validation, dry run by default, one validated write, and the
// written node is exactly what the signup surfaces read (signup-core legalFor('_platform')). In-memory RTDB; no credential.
// Run: node tools/platform-legal.test.js
const assert = require('assert');
const L = require('./platform-legal');
const S = require('../signup-core');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
function fakeDb() {
  const tree = {};
  const get = (p) => p.split('/').reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => { const ks = p.split('/'); let o = tree; for (const k of ks.slice(0, -1)) o = o[k] = o[k] || {}; o[ks[ks.length - 1]] = JSON.parse(JSON.stringify(v)); };
  const snap = (v) => ({ exists: () => v != null, val: () => (v == null ? null : JSON.parse(JSON.stringify(v))) });
  let writes = 0;
  return { tree, get, writes: () => writes, ref: (p) => ({ get: async () => snap(get(p)), once: async () => snap(get(p)),
    transaction: async (fn) => { const nx = fn(get(p) ?? null); if (nx === undefined) return { committed: false }; writes += 1; set(p, nx); return { committed: true, snapshot: snap(get(p)) }; } }) };
}
const GOOD = { terms_url: 'https://sherpa.hn/terminos', privacy_url: 'https://sherpa.hn/privacidad', terms_version: '2026-11', privacy_version: '2026-11', promos_copy_version: '2026-11' };

(async () => {
  assert.deepStrictEqual(L.validate(GOOD), { ok: true, value: GOOD });
  for (const [why, bad] of [['http', { ...GOOD, terms_url: 'http://sherpa.hn/t' }], ['not a URL', { ...GOOD, privacy_url: 'sherpa' }], ['empty version', { ...GOOD, terms_version: '' }],
    ['spaces', { ...GOOD, promos_copy_version: 'v 1' }], ['missing', { ...GOOD, privacy_version: undefined }], ['extra field', { ...GOOD, extra: 'x' }]])
    assert.strictEqual(L.validate(bad).ok, false, why);
  ok('validate: two exact https URLs + three bounded version strings, nothing else');

  const db = fakeDb();
  let r = await L.setLegal({ rtdb: db, input: GOOD });
  assert.ok(r.dryRun); assert.strictEqual(r.changes.length, 5); assert.strictEqual(db.writes(), 0, 'DRY RUN by default: nothing written');
  assert.strictEqual((await L.setLegal({ rtdb: db, input: { ...GOOD, terms_url: 'nope' }, apply: true })).ok, false); assert.strictEqual(db.writes(), 0, 'a refused input writes nothing');
  r = await L.setLegal({ rtdb: db, input: GOOD, apply: true });
  assert.ok(r.ok); assert.strictEqual(db.writes(), 1); assert.deepStrictEqual(db.get('platform_config/legal'), GOOD);
  assert.ok((await L.setLegal({ rtdb: db, input: GOOD, apply: true })).unchanged); assert.strictEqual(db.writes(), 1, 'unchanged ⇒ no write');
  r = await L.setLegal({ rtdb: db, input: { ...GOOD, terms_version: '2027-01' } });
  assert.deepStrictEqual(r.changes, [{ field: 'terms_version', from: '2026-11', to: '2027-01' }], 'the dry run names exactly what changes');
  ok('setLegal: dry run by default (the field diff), --apply writes ONE validated node, unchanged ⇒ no write, a refused input never writes');

  // the written node is exactly what the platform signup reads
  assert.deepStrictEqual(await S.legalFor(db, S.PLATFORM_SCOPE), GOOD);
  const cfg = await S.signupConfig(db, S.PLATFORM_SCOPE, {});
  assert.deepStrictEqual([cfg.legal_ready, cfg.terms_url, cfg.privacy_url], [true, GOOD.terms_url, GOOD.privacy_url]);
  assert.strictEqual(await S.legalFor(fakeDb(), S.PLATFORM_SCOPE), null, 'absent ⇒ legal_unconfigured (fail-closed)');
  ok('the written platform_config/legal is exactly what signup-core legalFor / signupConfig read for the platform scope; absent ⇒ fail-closed');

  console.log(`\nplatform-legal: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
