import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

test('bundled xpizza-delivery.js is byte-identical to the dispatch copy (reassign authority)', () => {
  const mobile = readFileSync(join(repo, 'xpizza-dispatch-mobile/xpizza-delivery.js'));
  const dispatch = readFileSync(join(repo, 'xpizza-dispatch/xpizza-delivery.js'));
  assert.equal(Buffer.compare(mobile, dispatch), 0, 'SDK drift — re-copy xpizza-dispatch/xpizza-delivery.js verbatim');
});

test('bundled dispatch-aging.js is byte-identical to the dispatch copy', () => {
  const mobile = readFileSync(join(repo, 'xpizza-dispatch-mobile/dispatch-aging.js'));
  const dispatch = readFileSync(join(repo, 'xpizza-dispatch/dispatch-aging.js'));
  assert.equal(Buffer.compare(mobile, dispatch), 0, 'aging module drift — re-copy verbatim');
});
