// The capp tests' VIRTUAL clock (PLAN-capp-virtual-clock r0, advisor 11-13): deterministic order, exact virtual waits, a drain that
// stops only when quiet — and FAILS (never hangs) on a self-re-arming instant loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from './test-clock.mjs';

test('VC1 timers run in (due, arming) order — same-due timers FIFO; clearTimeout removes one; time moves only by tick', async () => {
  const c = createClock(1000), seen = [];
  c.setTimeout(() => seen.push('b30'), 30); c.setTimeout(() => seen.push('a10'), 10); const x = c.setTimeout(() => seen.push('gone'), 10);
  c.setTimeout(() => seen.push('c30'), 30); c.clearTimeout(x);
  await c.drain();
  assert.deepEqual(seen, [], '🔴 VC1: draining never advances time');
  assert.equal(c.now(), 1000);
  await c.flush(29);
  assert.deepEqual(seen, ['a10'], '🔴 VC1: only what is due by +29');
  await c.flush(1);
  assert.deepEqual(seen, ['a10', 'b30', 'c30'], '🔴 VC1: same due ⇒ arming order');
  assert.equal(c.now(), 1030, '🔴 VC1: now() is the virtual time');
});

test('VC2 a timer\'s promise chain settles BEFORE the next timer fires (each firing is drained)', async () => {
  const c = createClock(0), seen = [];
  c.setTimeout(() => { Promise.resolve().then(() => Promise.resolve()).then(() => seen.push('chain-of-10')); seen.push('t10'); }, 10);
  c.setTimeout(() => seen.push('t20'), 20);
  await c.flush(20);
  assert.deepEqual(seen, ['t10', 'chain-of-10', 't20'], '🔴 VC2: the 10 ms timer\'s microtasks land before the 20 ms timer');
});

test('VC3 intervals re-arm at their period; clearInterval stops them; a timer armed DURING a tick fires within it if due', async () => {
  const c = createClock(0); let n = 0;
  const h = c.setInterval(() => { n++; if (n === 2) c.setTimeout(() => { n += 100; }, 5); }, 10);
  await c.flush(25);
  assert.equal(n, 102, '🔴 VC3: two interval firings (10, 20) + the 5 ms timer armed at 20 fired at 25');
  c.clearInterval(h); await c.flush(50);
  assert.equal(n, 102, '🔴 VC3: cleared ⇒ no more firings');
});

test('VC4 drain FAILS on a timer that re-arms itself at the same instant (a loop is a failure, never a hang)', async () => {
  const c = createClock(0);
  const loop = () => c.setTimeout(loop, 0); loop();
  await assert.rejects(c.drain(), /not quiet after/, '🔴 VC4: bounded');
});

test('VC5 drain waits for WebCrypto digests in flight (the threadpool is outside any clock; 64 MB so it outlasts the microtask turns)', async () => {
  const c = createClock(0); let done = false;
  c.setTimeout(() => { globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(64 << 20)).then(() => { done = true; }); }, 0);
  await c.drain();
  assert.equal(done, true, '🔴 VC5: the digest landed before drain returned');
});

test('VC6 jump(t) moves the virtual time FORWARD only (a wall-clock jump): the timers it passed fire at the next drain, in order', async () => {
  const c = createClock(0), seen = [];
  c.setTimeout(() => seen.push('a'), 100); c.setTimeout(() => seen.push('b'), 50);
  c.jump(200);
  assert.deepEqual(seen, [], 'a jump fires nothing by itself');
  await c.drain();
  assert.deepEqual(seen, ['b', 'a'], '🔴 VC6: the passed timers fire at the next drain, in due order');
  assert.throws(() => c.jump(150), /forward/, '🔴 VC6: never backwards');
});
