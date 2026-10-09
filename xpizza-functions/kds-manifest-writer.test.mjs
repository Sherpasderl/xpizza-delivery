// 1D add-product PHASE A §0b.3 — the KDS manifest writer, against the REAL RTDB emulator (never a fake).
//   node --test kds-manifest-writer.test.mjs
// Self-hosting: without FIREBASE_DATABASE_EMULATOR_HOST it re-runs itself under tools/emulator-run.js.
//
// 🔴 THE INTERLEAVING IS FORCED, ACROSS PROCESSES. Writer A (gen 11) runs in its own process and is held INSIDE
// its transaction callback, after reading, by a file barrier (the SDK calls the callback synchronously, so an
// async pause would not hold it). Writer B (gen 12), another process, commits while A is held. Then A is
// released. The newer manifest must survive, A must end as a retried-then-no-op, and another brand's manifest,
// its _meta and an unrelated key must come through byte-for-byte.
import assert from 'node:assert';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const NS = 'demo-xpizza';
const CELLS = []; const test = (name, fn) => CELLS.push([name, fn]);
let cells = 0; const ok = (l) => console.log(`  ✓ ${++cells} ${l}`);   // counted by tools/count-marks (node:test's own reporter is not)

if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  const r = spawnSync('node', [join(HERE, 'tools', 'emulator-run.js'), '--only', 'database', '--project', NS, 'node kds-manifest-writer.test.mjs'],
    { cwd: HERE, stdio: 'inherit', env });
  process.exit(r.status === null ? 1 : r.status);
}

const admin = require('firebase-admin');
const { writeKdsManifest, nextMenus } = require('./catalog/kds-manifest');
const { catalogSnapshot } = require('./catalog/generate-form-bundle');
admin.initializeApp({ databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${NS}`, projectId: NS });
const rtdb = admin.database();

const items = (prefix, n) => Array.from({ length: n }, (_, i) => ({ key: `${prefix} ${i}`, display: { name: `${prefix} ${i}`, cat: 'ny' } }));
const rows = (prefix, n) => items(prefix, n).map((it) => ({ key: it.key, label: it.display.name, category: 'ny' }));
const SEED = {
  x_pizza: rows('Old', 2),
  la_musa: [{ key: 'dimsum_01', label: 'Dumplings', category: 'dim_sum' }],
  unrelated_key: { keep: 'me', n: 1 },
  _meta: { x_pizza: { source_generation: 10, version_id: 'v10', written_at: 1 }, la_musa: { source_generation: 5, version_id: 'lv5', written_at: 2 } },
};
const reset = () => rtdb.ref('menus').set(JSON.parse(JSON.stringify(SEED)));
const read = async () => (await rtdb.ref('menus').once('value')).val();

function worker(args) {
  const file = join(args.barrier, `${args.name}.json`);
  writeFileSync(file, JSON.stringify({ ns: NS, now: 1000 + args.generation, ...args }));
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  const p = spawn('node', [join(HERE, 'test', '_kds-writer-worker.js'), file], { cwd: HERE, env });
  let out = ''; let err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  return new Promise((resolve) => p.on('exit', (code) => resolve({ code, out: (() => { try { return JSON.parse(out.trim().split('\n').pop()); } catch (_) { return { raw: out, err }; } })() })));
}
const waitFor = async (file, ms = 20000) => {
  const t0 = Date.now();
  while (!existsSync(file)) { if (Date.now() - t0 > ms) throw new Error(`barrier: ${file} never appeared`); await new Promise((r) => setTimeout(r, 20)); }
};

test('FORCED INTERLEAVING: A (gen 11) held after its read while B (gen 12) commits → B survives, A retried-then-no-op, others byte-identical', async () => {
  await reset();
  const barrier = mkdtempSync(join(tmpdir(), 'kdsw-'));
  try {
    const A = worker({ name: 'A', barrier, hold: true, rid: 'x_pizza', generation: 11, versionId: 'v11', catalog: { items: items('A', 3) } });
    await waitFor(join(barrier, 'A.inside'));                    // A has READ (gen 10) and is held inside its transaction
    const B = await worker({ name: 'B', barrier, hold: false, rid: 'x_pizza', generation: 12, versionId: 'v12', catalog: { items: items('B', 4) } });
    assert.strictEqual(B.code, 0, JSON.stringify(B.out));
    assert.deepStrictEqual(B.out.result, { written: true, reason: 'written', attempts: 1 });
    writeFileSync(join(barrier, 'A.release'), '1');
    const a = await A;
    assert.strictEqual(a.code, 0, JSON.stringify(a.out));
    assert.deepStrictEqual(a.out.result, { written: false, reason: 'older_generation', attempts: 1 }, 'A ends as a no-op');
    assert.strictEqual(a.out.saw[0], 10, 'A\'s first invocation read gen 10 (before B)');
    assert.ok(a.out.saw.length >= 2 && a.out.saw.at(-1) === 12, `A was RE-RUN by the server and then saw gen 12 → aborted (saw ${JSON.stringify(a.out.saw)})`);
    const after = await read();
    assert.deepStrictEqual(after.x_pizza, rows('B', 4), 'the NEWER manifest survives');
    assert.deepStrictEqual(after._meta.x_pizza, { source_generation: 12, version_id: 'v12', written_at: 1012 });
    assert.deepStrictEqual(after.la_musa, SEED.la_musa, 'another brand\'s manifest preserved');
    assert.deepStrictEqual(after._meta.la_musa, SEED._meta.la_musa, 'another brand\'s _meta preserved');
    assert.deepStrictEqual(after.unrelated_key, SEED.unrelated_key, 'an unrelated key preserved');
  } finally { rmSync(barrier, { recursive: true, force: true }); }
  ok('FORCED INTERLEAVING: A (gen 11) held after its read while B (gen 12) commits → B survives, A retried-then-no-op, others byte-identical');
});

test('the reverse order commits both: A (gen 11) then B (gen 12), each written', async () => {
  await reset();
  assert.deepStrictEqual(await writeKdsManifest(rtdb, 'x_pizza', { catalog: { items: items('A', 1) }, generation: 11, versionId: 'v11', now: () => 5 }), { written: true, reason: 'written', attempts: 1 });
  assert.deepStrictEqual(await writeKdsManifest(rtdb, 'x_pizza', { catalog: { items: items('B', 1) }, generation: 12, versionId: 'v12', now: () => 6 }), { written: true, reason: 'written', attempts: 1 });
  const m = await read();
  assert.deepStrictEqual([m.x_pizza, m._meta.x_pizza.source_generation], [rows('B', 1), 12]);
  ok('the reverse order commits both: A (gen 11) then B (gen 12), each written');
});

test('an OLDER generation is a no-op (a delayed retry cannot regress the list); an EQUAL one rewrites', async () => {
  await reset();
  const before = await read();
  assert.deepStrictEqual(await writeKdsManifest(rtdb, 'x_pizza', { catalog: { items: items('Stale', 1) }, generation: 9, versionId: 'v9' }), { written: false, reason: 'older_generation', attempts: 1 });
  assert.deepStrictEqual(await read(), before, 'nothing changed — not even written_at');
  assert.strictEqual((await writeKdsManifest(rtdb, 'x_pizza', { catalog: { items: items('Same', 1) }, generation: 10, versionId: 'v10b', now: () => 7 })).written, true);
  assert.deepStrictEqual((await read()).x_pizza, rows('Same', 1));
  ok('an OLDER generation is a no-op (a delayed retry cannot regress the list); an EQUAL one rewrites');
});

test('a brand with no _meta yet (first write) and an empty /menus are written', async () => {
  await rtdb.ref('menus').remove();
  assert.strictEqual((await writeKdsManifest(rtdb, 'r3_synthetic', { catalog: { items: items('T', 2) }, generation: 1, versionId: 'r1', now: () => 3 })).written, true);
  const m = await read();
  assert.deepStrictEqual(m, { r3_synthetic: rows('T', 2), _meta: { r3_synthetic: { source_generation: 1, version_id: 'r1', written_at: 3 } } });
  ok('a brand with no _meta yet (first write) and an empty /menus are written');
});

test('GOLDEN: no additions → the catalog-derived /menus/{rid} equals today\'s committed code-derived manifest, byte for byte', async () => {
  await rtdb.ref('menus').remove();
  for (const rid of ['x_pizza', 'la_musa']) {
    await writeKdsManifest(rtdb, rid, { catalog: catalogSnapshot(rid), generation: 1, versionId: `g_${rid}` });
    const committed = JSON.parse(readFileSync(join(HERE, '..', 'menus', `${rid}.json`), 'utf8'));
    assert.deepStrictEqual((await read())[rid], committed, `${rid}: identical rows, order and shape`);
  }
  ok("GOLDEN: no additions → the catalog-derived /menus/{rid} equals today\'s committed code-derived manifest, byte for byte");
});

test('bad inputs are refused before any write; nextMenus is the pure decision', async () => {
  await assert.rejects(writeKdsManifest(rtdb, 'x_pizza', { catalog: { items: [] }, generation: -1, versionId: 'v' }), /bad_generation/);
  await assert.rejects(writeKdsManifest(rtdb, 'x_pizza', { catalog: { items: [] }, generation: 1.5, versionId: 'v' }), /bad_generation/);
  await assert.rejects(writeKdsManifest(rtdb, 'x_pizza', { catalog: { items: [] }, generation: 1, versionId: '' }), /bad_version/);
  await assert.rejects(writeKdsManifest(rtdb, 'x_pizza', { catalog: { items: [{ key: 'x', display: { name: '', cat: 'ny' } }] }, generation: 99, versionId: 'v' }), /missing name/);
  assert.strictEqual(nextMenus({ _meta: { r: { source_generation: 5 } } }, 'r', [], { source_generation: 4 }), undefined);
  assert.deepStrictEqual(nextMenus(null, 'r', [1], { source_generation: 0 }), { r: [1], _meta: { r: { source_generation: 0 } } });
  ok('bad inputs are refused before any write; nextMenus is the pure decision');
});

// Sequential cells (not node:test: its reporter reroutes console output past tools/count-marks, so the ✓ marks
// would go uncounted). `node --test kds-manifest-writer.test.mjs` still works — exit 0 is a pass.
(async () => {
  try {
    for (const [name, fn] of CELLS) { try { await fn(); } catch (e) { console.error(`✗ ${name}\n`, e); process.exitCode = 1; break; } }
  } finally { await admin.app().delete(); }
  if (!process.exitCode) console.log(`\nkds-manifest-writer: OK (${cells})`);
})();
