// capp (advisor 2026-11-14) — provisionBrand(rid, { inputTransform }): a test may transform the REAL publish candidate before the REAL
// publish (e.g. a long dish name for a fixture), and the served envelope carries it; without the option the provision is unchanged
// (deterministic ETag). Run: node contract/capp/provision-brand-transform.test.mjs
import assert from 'node:assert';
import { provisionBrand } from './capture.mjs';

let n = 0; let FINISHED = false;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ provision-brand-transform: exited without completing (a hang)\n'); process.exitCode = 1; } });
const quiet = async (f) => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };

try {
  const base = await quiet(() => provisionBrand('la_musa'));
  const again = await quiet(() => provisionBrand('la_musa', {}));
  assert.strictEqual(again.etag, base.etag, 'no transform ⇒ the provision is unchanged (the same ETag)');
  ok('without inputTransform the provision is unchanged (deterministic ETag)');
  const LONG = 'Agua Purificada de Manantial de la Montaña en Botella Grande';
  let seen = null;
  const t = await quiet(() => provisionBrand('la_musa', { inputTransform: (input) => {
    seen = input;
    return { ...input, items: input.items.map((it) => (it.key === 'soft_04' ? { ...it, display: { ...it.display, name: LONG } } : it)) };
  } }));
  assert.ok(seen && seen.key_mode === 'id' && seen.items.some((it) => it.key === 'soft_04'), 'premise: the transform received the REAL publish candidate (id keys)');
  assert.ok(JSON.stringify(t.envelope.menu).includes(LONG), 'the transformed name is served (it went through the real publish)');
  assert.ok(!JSON.stringify(base.envelope.menu).includes(LONG), 'premise: the base never carries it');
  assert.notStrictEqual(t.etag, base.etag, 'the transformed catalog has its own ETag');
  ok('inputTransform rewrites the REAL publish candidate (la_musa soft_04); the served envelope carries the long name');
  // the real publish still validates a transformed candidate: x_pizza's keys derive from the name, so a bare rename is refused
  let refused = null;
  try { await quiet(() => provisionBrand('x_pizza', { inputTransform: (input) => ({ ...input, items: input.items.map((it) => (it.key === 'Carnivora' ? { ...it, display: { ...it.display, name: 'Otra' } } : it)) }) })); } catch (e) { refused = e; }
  assert.ok(refused && /publish_refused_invalid/.test(String(refused.message)), `a transform the publish forbids is refused by publishVersion itself (${refused && refused.message})`);
  ok('a transformed candidate still passes publishVersion\'s own validation (an invalid one is refused)');
  FINISHED = true;
  console.log(`provision-brand-transform: ${n}/${n} ok`);
} catch (e) {
  console.error(`  ✗ ${e.message}`);
  process.exitCode = 1;
}
