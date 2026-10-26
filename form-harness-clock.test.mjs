// form-harness makeLogicalClock — the logical clock the order-form suites opt into (loadForm(dir, { clock })).
// Run: node form-harness-clock.test.mjs
//   1  timers: deadline order, ties by ARM order (a re-armed interval queues behind earlier timers), clear, nested
//      timers, microtasks drained between timers, a throwing timer reported (not fatal), 0-delay = a REAL macrotask
//   2  sleep(): concurrent sleeps OVERLAP; page timers fire exactly at their deadlines around them; no sleeper → time
//      stands still; sleepers wake in deadline order; a Date-polled loop ends after exactly its logical sleeps
//   3  IDLE (codex 2e-g2clock r1 P2-1): a long chain of NESTED 0-delay page timers completes before logical time moves
//   4  Date (codex r1 P2-2): Date() called → the string of logical NOW; new Date() / new Date(x); now / parse / UTC;
//      instanceof and .constructor; a subclass — each in its own realm (vm), never Node's own Date
//   5  the documented deadlock: a direct await on a page promise that awaits a logical timer stays pending (no
//      sleeper); racing it against sleep() settles it
import assert from 'node:assert';
import vm from 'node:vm';
import { makeLogicalClock } from './form-harness.mjs';

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const realm = () => ({ Date: vm.runInNewContext('Date') });
const turns = async (k) => { for (let i = 0; i < k; i++) await new Promise((r) => setTimeout(r, 0)); };

// ── 1. timers ──
{
  const start = 1_700_000_000_000; const c = makeLogicalClock(start); const win = realm(); const errs = []; c.install(win, errs);
  const log = [];
  win.setTimeout(() => log.push('b300'), 300); win.setTimeout(() => log.push('a170'), 170); win.setTimeout(() => log.push('tie1'), 300);
  const cancel = win.setTimeout(() => log.push('CANCELLED'), 100); win.clearTimeout(cancel);
  let k = 0; const iv = win.setInterval(() => { log.push('iv' + (++k)); if (k === 3) win.clearInterval(iv); }, 100);
  win.setTimeout(() => { log.push('chain'); Promise.resolve().then(() => log.push('micro')); win.setTimeout(() => log.push('nested+50'), 50); }, 200);
  win.setTimeout(() => { throw new Error('boom'); }, 10);
  await c.advance(169); assert.deepStrictEqual(log, ['iv1'], 'only what is due by 169');
  await c.advance(1); assert.deepStrictEqual(log, ['iv1', 'a170'], 'the 170 fires AT 170, not before');
  await c.advance(130);
  assert.deepStrictEqual(log, ['iv1', 'a170', 'chain', 'micro', 'iv2', 'nested+50', 'b300', 'tie1', 'iv3'],
    'deadline order; at a tie the earlier-ARMED timer first (chain armed at 0 beats iv2 re-armed at 100); microtasks between timers');
  assert.strictEqual(win.Date.now(), start + 300); assert.deepStrictEqual(errs, ['boom'], 'a throwing timer is reported, not fatal');
  await c.advance(1000); assert.strictEqual(log.filter((x) => x.startsWith('iv')).length, 3); assert.ok(!log.includes('CANCELLED'));
  let z = false; win.setTimeout(() => { z = true; }, 0); assert.strictEqual(z, false); await turns(2); assert.strictEqual(z, true, '0-delay = a real macrotask');
  ok('timers: deadline order, ties by arm order, clear, nested, microtasks between timers, a throw reported, 0-delay real');
}

// ── 2. sleep() ──
{
  const c = makeLogicalClock(0); const w = realm(); c.install(w, []);
  const fired = []; w.setTimeout(() => fired.push('page1500@' + w.Date.now()), 1500);
  await Promise.all(Array.from({ length: 16 }, () => c.sleep(240)));
  assert.strictEqual(c.elapsed(), 240, '16 concurrent 240 ms sleeps cost 240 logical ms, not 3840');
  assert.deepStrictEqual(fired, [], 'the 1500 ms page timer has NOT fired after 240 ms');
  await c.sleep(1500); assert.deepStrictEqual(fired, ['page1500@1500']); assert.strictEqual(c.elapsed(), 1740);
  const iv = []; w.setInterval(() => iv.push(c.elapsed()), 100);
  await turns(20); assert.deepStrictEqual(iv, [], 'no sleeper → logical time does not move');
  await c.sleep(250); assert.deepStrictEqual(iv, [1840, 1940]);
  const order = []; await Promise.all([c.sleep(50).then(() => order.push('a50')), c.sleep(30).then(() => order.push('b30'))]);
  assert.deepStrictEqual(order, ['b30', 'a50'], 'sleepers wake in deadline order');
  let spins = 0; const deadline = w.Date.now() + 90000;
  const poll = (async () => { while (w.Date.now() < deadline) { spins++; await new Promise((r) => w.setTimeout(r, 2500)); } })();
  await c.sleep(90000); await poll; assert.strictEqual(spins, 36, 'a Date-polled 90 s loop with 2.5 s sleeps ends after exactly 36');
  ok('sleep(): concurrent sleeps overlap; page timers fire at their deadlines; idle → no time; deadline-ordered wakes; Date-polled loop');
}

// ── 3. IDLE: a long nested 0-delay chain completes before logical time moves (codex r1 P2-1) ──
{
  for (const depth of [12, 200]) {
    const c = makeLogicalClock(0); const w = realm(); c.install(w, []);
    const seen = [];
    const hop = (i) => { seen.push(i); if (i + 1 < depth) w.setTimeout(() => hop(i + 1), 0); };
    w.setTimeout(() => hop(0), 0);
    w.setTimeout(() => seen.push('L100'), 100);
    await c.sleep(200);
    assert.deepStrictEqual(seen, [...Array.from({ length: depth }, (_, i) => i), 'L100'], `🔴 the logical 100 ms timer fired inside a ${depth}-deep 0-delay chain`);
  }
  // the same through advance()
  const c = makeLogicalClock(0); const w = realm(); c.install(w, []); const seen = [];
  const hop = (i) => { seen.push(i); if (i < 11) w.setTimeout(() => hop(i + 1), 0); };
  w.setTimeout(() => hop(0), 0); w.setTimeout(() => seen.push('L100'), 100);
  await c.advance(200); assert.strictEqual(seen.indexOf('L100'), 12, 'advance() also waits out the 0-delay chain');
  // a clearTimeout on a pending 0-delay timer releases it (no false "never idle")
  const c2 = makeLogicalClock(0); const w2 = realm(); c2.install(w2, []); const id = w2.setTimeout(() => {}, 0); w2.clearTimeout(id);
  await c2.sleep(10); assert.strictEqual(c2.elapsed(), 10);
  ok('idle: nested 0-delay chains of 12 and 200 complete before a logical 100 ms timer (sleep and advance); a cleared 0-delay releases');
}

// ── 4. Date on logical time, in its own realm (codex r1 P2-2) ──
{
  const start = Date.UTC(2026, 9, 25, 18, 0, 0); const c = makeLogicalClock(start); const w = realm(); const RealDate = w.Date; c.install(w, []);
  const D = w.Date;
  assert.strictEqual(typeof D(), 'string', 'Date() called returns a STRING');
  assert.strictEqual(D(), new RealDate(start).toString(), 'Date() is the string of logical NOW');
  assert.strictEqual(D(0), new RealDate(start).toString(), 'Date(x) called ignores its argument (spec)');
  assert.strictEqual(new D().getTime(), start, 'new Date() = logical NOW'); assert.strictEqual(new D(5).getTime(), 5);
  assert.strictEqual(new D(2026, 0, 2).getTime(), new RealDate(2026, 0, 2).getTime(), 'new Date(y, m, d) is the real constructor');
  assert.strictEqual(new D('2026-10-25T00:00:00Z').getTime(), RealDate.parse('2026-10-25T00:00:00Z'));
  assert.strictEqual(D.now(), start); assert.strictEqual(D.parse('2026-01-01T00:00:00Z'), RealDate.parse('2026-01-01T00:00:00Z'));
  assert.strictEqual(D.UTC(2026, 0, 1), RealDate.UTC(2026, 0, 1));
  const d = new D(); assert.ok(d instanceof D, 'instanceof the window Date'); assert.ok(d instanceof RealDate);
  assert.strictEqual(d.constructor, D, '.constructor is the window Date'); assert.strictEqual(Object.prototype.toString.call(d), '[object Date]');
  assert.strictEqual(D.name, 'Date'); assert.strictEqual(D.length, 7);
  class Stamp extends D { label() { return 'S' + this.getTime(); } }
  const s = new Stamp(); assert.ok(s instanceof Stamp && s instanceof D); assert.strictEqual(s.label(), 'S' + start, 'a subclass gets logical NOW');
  await c.sleep(1000); assert.strictEqual(new D().getTime(), start + 1000); assert.strictEqual(D(), new RealDate(start + 1000).toString(), 'Date() moves with the clock');
  assert.strictEqual(Date.prototype.constructor, Date, 'Node\'s own Date is untouched (the realm was the window\'s)');
  ok('Date: callable → string of logical NOW (args ignored), constructor forms, now / parse / UTC, instanceof, .constructor, a subclass, moves with the clock; Node\'s Date untouched');
}

// ── 5. the documented deadlock property and its remedy ──
{
  const c = makeLogicalClock(0); const w = realm(); c.install(w, []);
  let state = 'pending'; const page = (async () => { await new Promise((r) => w.setTimeout(r, 1500)); state = 'settled'; })();
  await turns(30);
  assert.deepStrictEqual([state, c.pending(), c.sleeping()], ['pending', 1, 0], 'a direct await: no sleeper, one logical timer armed → it stays pending (the documented property)');
  await Promise.race([page, c.sleep(2000)]); assert.strictEqual(state, 'settled'); assert.strictEqual(c.elapsed(), 1500, 'raced against sleep(): settles AT its timer');
  ok('the deadlock property is real and diagnosable (pending 1, sleeping 0); racing against sleep() settles it at its deadline');
}

console.log(`\nform-harness-clock: OK (${n})`);
