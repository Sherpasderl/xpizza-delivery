// H1b T2 — two clocks (codex P2-10): DISPLAY time = local wall + the RTDB server offset (countdowns only; unknown → null → "--"),
// and DURATIONS (Listo undo, PIN lockout) on a LOCAL timer whose elapsed = max(monotonic, wall) — never server-corrected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClock, makeTimer } from './clock.js';

const MIN = 60000;

test('display clock: unknown offset → null now / null countdowns; known offset → corrected', () => {
  let wall = 1_000_000;
  const c = makeClock({ wall: () => wall });
  assert.equal(c.now(), null);
  assert.equal(c.minutesLeft(wall + 10 * MIN), null);
  c.setOffset(7 * MIN);                              // the device is 7 min behind the server
  assert.equal(c.now(), wall + 7 * MIN);
  assert.equal(c.minutesLeft(wall + 7 * MIN + 12 * MIN), 12, 'Faltan 12 against server time');
  assert.equal(c.minutesLeft(wall + 7 * MIN - 3 * MIN), -3, 'the intentional Atrasado');
  assert.equal(c.minutesLeft(wall + 7 * MIN - 1000), 0, 'never -0');
  assert.equal(c.minutesLeft('x'), null);
});

test('display clock: an offset change notifies listeners (countdowns recompute); bad offsets are ignored', () => {
  const c = makeClock({ wall: () => 0 });
  const seen = [];
  const off = c.onChange((o) => seen.push(o));
  c.setOffset(1000); c.setOffset(1000); c.setOffset(-500); c.setOffset(NaN); c.setOffset('5');
  assert.deepEqual(seen, [1000, -500], 'only real changes, only finite numbers');
  off(); c.setOffset(9);
  assert.deepEqual(seen, [1000, -500], 'unsubscribed');
  c.setOffset(null);
  assert.equal(c.now(), null, 'offset lost → unknown again');
});

test('timer: 5 s of LOCAL time; a server offset change cannot touch it', () => {
  let mono = 0; let wall = 50_000;
  const clock = makeClock({ wall: () => wall });
  const t = makeTimer({ mono: () => mono, wall: () => wall });
  t.start(5000);
  clock.setOffset(10 * MIN);                         // irrelevant to durations
  mono += 3000; wall += 3000;
  assert.deepEqual([t.remaining(), t.expired()], [2000, false]);
  mono += 2000; wall += 2000;
  assert.deepEqual([t.remaining(), t.expired()], [0, true]);
});

test('timer: a suspended monotonic clock (wall +10 s, mono +0) → expired; a wall jump backwards is covered by mono', () => {
  let mono = 0; let wall = 0;
  const t = makeTimer({ mono: () => mono, wall: () => wall });
  t.start(5000);
  wall += 10000;
  assert.equal(t.expired(), true, 'backgrounded: mono stopped, wall advanced');
  const u = makeTimer({ mono: () => mono, wall: () => wall });
  u.start(5000);
  wall -= 3600000; mono += 5000;
  assert.equal(u.expired(), true, 'the user set the clock back an hour: mono still counts');
  const v = makeTimer({ mono: () => mono, wall: () => wall });
  v.start(5000); wall -= 10000;
  assert.equal(v.remaining(), 5000, 'never more than the duration, never negative elapsed');
});

test('timer: not started → not expired, remaining null; restart resets', () => {
  let mono = 0;
  const t = makeTimer({ mono: () => mono, wall: () => mono });
  assert.deepEqual([t.remaining(), t.expired()], [null, false]);
  t.start(1000); mono += 1500;
  assert.equal(t.expired(), true);
  t.start(1000);
  assert.equal(t.expired(), false);
});
