'use strict';
// D4-c4 — the pause CLI's PURE core (tools/order-control-core.js; PLAN-D4c4 rev 13 §1/§0.3/§0.10). Run: node order-control-cli.test.js
// Parsing (strict, incl. the explicit-offset rule), the server clock (positive / negative / excessive skew — warned, values
// still corrected), the change plan (indefinite / --for / --until, the 60 s lead, same-state no-op, version conflict) and
// the transaction callback (null-first-safe, aborts without a write, full {paused, until} snapshots, the audit row).
// The §0.3 apply-time re-check (`checkAtApply`, a delayed apply) and its wiring in the CLI (estimate AT apply, before the transaction).
// The real CLI is driven end to end on the emulator by test/order-control-cli.emulator.test.js.
const assert = require('assert');
const C = require('./tools/order-control-core');
const S = require('./order-control-state');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const base = ['--project', 'xpizza-delivery', '--rid', 'r3_synthetic', '--reason', 'cocina llena', '--actor', 'Ana'];
const P = (...extra) => C.parseArgs([...base, ...extra]);

// ── parsing ──────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const a = P('--pause');
  assert.deepStrictEqual(a, { ok: true, op: 'pause', rid: 'r3_synthetic', forMs: null, untilMs: null, untilRaw: null, reason: 'cocina llena', actor: 'Ana', expectVersion: null, apply: false });
  assert.strictEqual(P('--resume', '--apply').apply, true);
  assert.strictEqual(P('--resume', '--apply').op, 'resume');
  assert.strictEqual(P('--pause', '--for', '30m').forMs, 30 * 60000);
  assert.strictEqual(P('--pause', '--for=2h').forMs, 2 * 3600000);
  assert.strictEqual(P('--pause', '--for', '168h').forMs, 168 * 3600000);
  assert.strictEqual(P('--pause', '--expect-version', '4').expectVersion, 4);
  assert.strictEqual(P('--pause', '--expect-version', '0').expectVersion, 0);
  ok('parse: --pause (indefinite) / --resume / --apply / --for 30m, --for=2h (and the 7-day max) / --expect-version');
}
for (const [args, why] of [
  [[...base], 'neither --pause nor --resume'], [[...base, '--pause', '--resume'], 'both'],
  [[...base, '--resume', '--for', '1h'], '--for with --resume'], [[...base, '--resume', '--until', '2030-01-01T00:00:00Z'], '--until with --resume'],
  [[...base, '--pause', '--for', '1h', '--until', '2030-01-01T00:00:00Z'], '--for and --until'],
  [[...base, '--pause', '--for', '0m'], 'zero duration'], [[...base, '--pause', '--for', '90'], 'no unit'], [[...base, '--pause', '--for', '1d'], 'days unit'],
  [[...base, '--pause', '--for', '-5m'], 'negative'], [[...base, '--pause', '--for', '1.5h'], 'fraction'], [[...base, '--pause', '--for', '169h'], 'over 7 days'],
  [[...base, '--pause', '--until', '2030-01-01T00:00:00'], 'until WITHOUT an offset (no timezone assumption)'],
  [[...base, '--pause', '--until', '2030-01-01 00:00:00Z'], 'until not ISO (space)'], [[...base, '--pause', '--until', '2030-01-01'], 'until date only'],
  [[...base, '--pause', '--until', '2030-13-45T25:00:00Z'], 'until invalid date'], [[...base, '--pause', '--until', '1735689600000'], 'until as a number'],
  [['--project', 'xpizza-delivery', '--rid', 'bad rid!', '--reason', 'r', '--actor', 'a', '--pause'], 'bad rid'],
  [['--project', 'xpizza-delivery', '--reason', 'r', '--actor', 'a', '--pause'], 'no rid'],
  [['--project', 'xpizza-delivery', '--rid', 'x', '--actor', 'a', '--pause'], 'no reason'], [['--project', 'xpizza-delivery', '--rid', 'x', '--reason', '  ', '--actor', 'a', '--pause'], 'blank reason'],
  [['--project', 'xpizza-delivery', '--rid', 'x', '--reason', 'r', '--pause'], 'no actor'],
  [[...base, '--pause', '--expect-version', '-1'], 'negative version'], [[...base, '--pause', '--expect-version', 'x'], 'non-numeric version'],
  [[...base, '--pause', '--force'], 'unknown flag'], [[...base, '--pause', '--pause'], 'a flag twice'], [[...base, '--pause', '--apply=yes'], 'a value on a flag'],
  [[...base, '--pause', '--for'], 'a value missing'], [['--project', 'xpizza-delivery', '--rid', '--pause', '--reason', 'r', '--actor', 'a'], 'a flag as the value'],
]) {
  const r = C.parseArgs(args);
  assert.strictEqual(r.ok, false, `refused: ${why}`);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
}
ok('parse REFUSES: neither/both modes, an end time with --resume, --for and --until together, zero / unit-less / day / negative / fractional / > 7 d durations, --until without an explicit offset, non-ISO or invalid dates, a bad or missing rid, a missing or blank reason / actor, bad versions, unknown flags, duplicates, a value on a flag, a missing value');
{
  for (const u of ['2030-01-01T00:00Z', '2030-01-01T00:00:00Z', '2030-01-01T00:00:00.123Z', '2030-01-01T00:00:00-06:00', '2030-01-01T00:00:00+05:30']) assert.strictEqual(P('--pause', '--until', u).ok, true, u);
  assert.strictEqual(P('--pause', '--until', '2030-01-01T00:00:00-06:00').untilMs, Date.parse('2030-01-01T06:00:00Z'));
  assert.strictEqual(P('--pause', '--until', '2030-01-01T00:00:00+05:30').untilMs, Date.parse('2029-12-31T18:30:00Z'));
  ok('parse --until: Z and ±HH:MM accepted (with or without seconds / ms); the offset is honoured exactly (-06:00 and +05:30)');
}

// ── the server clock ──────────────────────────────────────────────────────────────────────────────────────────────
assert.deepStrictEqual(C.serverClock(0, 1000), { serverNow: 1000, offsetMs: 0, skewWarning: false });
assert.deepStrictEqual(C.serverClock(250000, 1000), { serverNow: 251000, offsetMs: 250000, skewWarning: false });
assert.deepStrictEqual(C.serverClock(-250000, 1000000), { serverNow: 750000, offsetMs: -250000, skewWarning: false });
assert.deepStrictEqual(C.serverClock(300000, 0), { serverNow: 300000, offsetMs: 300000, skewWarning: false });
assert.deepStrictEqual(C.serverClock(300001, 0), { serverNow: 300001, offsetMs: 300001, skewWarning: true });
assert.deepStrictEqual(C.serverClock(-300001, 0), { serverNow: -300001, offsetMs: -300001, skewWarning: true });
assert.deepStrictEqual(C.serverClock(NaN, 5), { serverNow: 5, offsetMs: 0, skewWarning: false });
ok('server clock: serverNow = client + offset for positive and negative skew; |offset| > 5 min → a WARNING, the corrected value is STILL used (never a block); exactly 5 min → no warning; no offset → 0');

// ── the change plan ───────────────────────────────────────────────────────────────────────────────────────────────
const NOW = Date.parse('2030-01-01T00:00:00Z');
const node = (current, events) => ({ current, ...(events ? { events } : {}) });
{
  const p = C.planChange({ node: null, args: P('--pause'), serverNow: NOW });
  assert.deepStrictEqual(p, { ok: true, noop: false, expectedVersion: 0, from: { paused: false }, to: { paused: true } });
  assert.ok(!('until' in p.to), 'an indefinite pause has NO until key (never until:null — RTDB drops it)');
  const f = C.planChange({ node: null, args: P('--pause', '--for', '2h'), serverNow: NOW });
  assert.deepStrictEqual(f.to, { paused: true, until: NOW + 7200000 });
  const ff = C.planChange({ node: null, args: P('--pause', '--for', '2h'), serverNow: NOW + 300001 });   // skewed laptop: still the SERVER clock
  assert.strictEqual(ff.to.until, NOW + 300001 + 7200000);
  const u = C.planChange({ node: node({ paused: true, version: 3 }), args: P('--pause', '--until', '2030-01-01T00:01:01Z'), serverNow: NOW });
  assert.deepStrictEqual(u, { ok: true, noop: false, expectedVersion: 3, from: { paused: true }, to: { paused: true, until: NOW + 61000 } });
  const r = C.planChange({ node: node({ paused: true, until: NOW + 5, version: 7 }), args: P('--resume'), serverNow: NOW });
  assert.deepStrictEqual(r, { ok: true, noop: false, expectedVersion: 7, from: { paused: true, until: NOW + 5 }, to: { paused: false } });
  ok('plan: indefinite → {paused:true} with NO until; --for → serverNow + D (server-corrected, incl. under skew); --until > now + 60 s → that instant; resume → {paused:false}; the from-snapshot is the COMPLETE stored state; the version is the stored one');
}
{
  assert.strictEqual(C.planChange({ node: null, args: P('--pause', '--until', '2030-01-01T00:01:00Z'), serverNow: NOW }).ok, false, 'exactly 60 s → refused');
  assert.strictEqual(C.planChange({ node: null, args: P('--pause', '--until', '2029-12-31T23:59:00Z'), serverNow: NOW }).ok, false, 'past → refused');
  assert.strictEqual(C.planChange({ node: null, args: P('--pause', '--until', '2030-01-01T00:00:00Z'), serverNow: NOW }).ok, false, 'now → refused');
  ok('plan: --until at or before server-now + 60 s (exactly 60 s, now, the past) → REFUSED');
}
{
  assert.strictEqual(C.planChange({ node: null, args: P('--resume'), serverNow: NOW }).noop, true, 'resume of an absent node');
  assert.strictEqual(C.planChange({ node: node({ paused: false, version: 2 }), args: P('--resume'), serverNow: NOW }).noop, true);
  assert.strictEqual(C.planChange({ node: node({ paused: true, version: 2 }), args: P('--pause'), serverNow: NOW }).noop, true);
  assert.strictEqual(C.planChange({ node: node({ paused: true, until: NOW + 61000, version: 2 }), args: P('--pause', '--until', '2030-01-01T00:01:01Z'), serverNow: NOW }).noop, true, 'same until');
  assert.strictEqual(C.planChange({ node: node({ paused: true, until: NOW + 62000, version: 2 }), args: P('--pause', '--until', '2030-01-01T00:01:01Z'), serverNow: NOW }).noop, false, 'a NEW until is a real change');
  assert.strictEqual(C.planChange({ node: node({ paused: true, until: NOW + 61000, version: 2 }), args: P('--pause'), serverNow: NOW }).noop, false, 'timed → indefinite is a real change');
  assert.strictEqual(C.planChange({ node: node({ paused: true, until: NOW - 1, version: 2 }), args: P('--resume'), serverNow: NOW }).noop, false, 'an EXPIRED pause is still stored paused → resume records it');
  ok('plan: same state + same until → no-op (resume of absent / open, pause of paused); a new until, timed→indefinite and resuming an expired-but-stored pause are REAL changes');
}
{
  const c = C.planChange({ node: node({ paused: true, version: 5 }), args: P('--resume', '--expect-version', '4'), serverNow: NOW });
  assert.strictEqual(c.ok, false); assert.strictEqual(c.conflict, true); assert.match(c.error, /expected 4, stored 5/);
  assert.strictEqual(C.planChange({ node: node({ paused: true, version: 5 }), args: P('--resume', '--expect-version', '5'), serverNow: NOW }).ok, true);
  for (const v of [-1, 1.5, '3', null, {}]) {
    const m = C.planChange({ node: node({ paused: true, version: v }), args: P('--resume'), serverNow: NOW });
    if (v === null) assert.strictEqual(m.ok, true, 'null version = never written'); else assert.strictEqual(m.ok, false, `malformed version ${JSON.stringify(v)}`);
  }
  ok('plan: --expect-version ≠ stored → version CONFLICT (refused, nothing written); a malformed stored version → refused');
}

// ── the transaction callback ──────────────────────────────────────────────────────────────────────────────────────
const TS = { '.sv': 'timestamp' };
const cb = (o) => C.txnCallback({ expectedVersion: 0, to: { paused: true }, opId: 'op1', actor: 'Ana', principal: 'ana@example.com', reason: 'cocina llena', timestamp: TS, ...o });
{
  const out = cb()(null);
  assert.deepStrictEqual(out, {
    current: { paused: true, since: TS, by: 'Ana', principal: 'ana@example.com', reason: 'cocina llena', version: 1, op_id: 'op1' },
    events: { op1: { from: { paused: false }, to: { paused: true }, at: TS, by: 'Ana', principal: 'ana@example.com', reason: 'cocina llena', version: 1 } },
  });
  assert.ok(!('until' in out.current) && !('until' in out.events.op1.to), 'indefinite: no until key anywhere');
  assert.ok(!('actor_uid' in out.current), 'principal replaces actor_uid (§0.10)');
  ok('txn on an absent node: current {paused, since: SERVER timestamp, by, principal, reason, version 1, op_id} + ONE audit event with complete from/to snapshots — atomic');
}
{
  const prev = { current: { paused: true, until: 99, since: 1, by: 'B', principal: 'b@x', reason: 'r', version: 4, op_id: 'op0' }, events: { op0: { x: 1 } } };
  const out = cb({ expectedVersion: 4, to: { paused: false }, opId: 'op5' })(prev);
  assert.deepStrictEqual(out.current, { paused: false, since: TS, by: 'Ana', principal: 'ana@example.com', reason: 'cocina llena', version: 5, op_id: 'op5' });
  assert.deepStrictEqual(out.events.op0, { x: 1 }, 'earlier events preserved');
  assert.deepStrictEqual(out.events.op5.from, { paused: true, until: 99 });
  assert.deepStrictEqual(out.events.op5.to, { paused: false });
  const t = cb({ expectedVersion: 4, to: { paused: true, until: 1234 }, opId: 'op6' })(prev);
  assert.deepStrictEqual(t.current.until, 1234); assert.deepStrictEqual(t.events.op6.to, { paused: true, until: 1234 });
  ok('txn on an existing node: version increments, every earlier event is kept, from/to are full {paused, until} snapshots, a timed pause stores until in current and the event');
}
{
  const prev = { current: { paused: true, version: 4, op_id: 'opX' } };
  assert.strictEqual(cb({ expectedVersion: 3, to: { paused: false } })(prev), undefined, 'version mismatch → ABORT (undefined = no write)');
  assert.strictEqual(cb({ expectedVersion: 4, to: { paused: true } })(prev), undefined, 'same state → ABORT');
  assert.strictEqual(cb({ expectedVersion: 4, to: { paused: false } })(null), null, 'NULL-FIRST: the optimistic null call for an existing node returns null (rejected by the server, re-run with the real value) — never a fabricated node');
  assert.strictEqual(cb({ expectedVersion: 0, to: { paused: false } })(null), null, 'resume of an absent node → null (no node created)');
  const fx = cb(); const a = fx(null); const b = fx(null);
  assert.deepStrictEqual(a, b, 'side-effect free: the same input → the same output (op_id / principal decided before the transaction)');
  ok('txn: a version mismatch or the same state ABORTS with no write; null-first-safe; side-effect free (deterministic on re-runs)');
}

// ── a round trip through the shared interpretation ─────────────────────────────────────────────────────────────────
{
  const w1 = cb()(null);
  assert.strictEqual(S.effectiveState(w1.current, NOW).state, 'paused');
  const w2 = cb({ expectedVersion: 1, to: { paused: true, until: NOW + 1000 }, opId: 'op2' })(w1);
  assert.strictEqual(S.effectiveState(w2.current, NOW + 999).state, 'paused');
  assert.strictEqual(S.effectiveState(w2.current, NOW + 1000).state, 'open');
  const w3 = cb({ expectedVersion: 2, to: { paused: false }, opId: 'op3' })(w2);
  assert.strictEqual(S.effectiveState(w3.current, NOW).state, 'open');
  assert.deepStrictEqual(Object.keys(w3.events), ['op1', 'op2', 'op3']);
  ok('what the CLI writes reads back through the SHARED module: indefinite → PAUSED; timed → PAUSED until, OPEN at until; resume → OPEN; three audit rows');
}
{
  // §0.3 delayed apply: the end time is re-checked against server-now AT apply
  const timed = C.planChange({ node: null, args: P('--pause', '--until', '2030-01-01T00:01:01Z'), serverNow: NOW });
  const until = timed.to.until;
  assert.strictEqual(C.checkAtApply(timed, until).ok, false, 'until == server-now at apply → REFUSED');
  assert.match(C.checkAtApply(timed, until).error, /already passed/);
  assert.strictEqual(C.checkAtApply(timed, until + 1).ok, false, 'until in the past at apply → REFUSED');
  assert.strictEqual(C.checkAtApply(timed, until - 1).ok, true, 'server-now = until − 1 at apply → applies');
  assert.strictEqual(C.checkAtApply(timed, NaN).ok, false, 'no usable server-time estimate → a timed change is REFUSED (fail closed)');
  const fr = C.planChange({ node: null, args: P('--pause', '--for', '30m'), serverNow: NOW });
  assert.strictEqual(C.checkAtApply(fr, fr.to.until).ok, false, '--for whose end has arrived by apply → REFUSED');
  assert.strictEqual(C.checkAtApply(fr, fr.to.until - 1).ok, true);
  const ind = C.planChange({ node: null, args: P('--pause'), serverNow: NOW });
  const res = C.planChange({ node: node({ paused: true, until: NOW + 5, version: 7 }), args: P('--resume'), serverNow: NOW });
  for (const at of [NOW, NOW + 7 * 24 * 3600000, Number.MAX_SAFE_INTEGER, NaN]) {
    assert.deepStrictEqual(C.checkAtApply(ind, at), { ok: true }, 'an indefinite pause is never refused at apply');
    assert.deepStrictEqual(C.checkAtApply(res, at), { ok: true }, 'a resume is never refused at apply');
  }
  ok('delayed apply (§0.3): until == server-now at apply → REFUSED, until − 1 → applies, a passed --for / --until → REFUSED, no estimate → REFUSED; an indefinite pause and a resume are NEVER refused');
}
{
  // wiring: the CLI calls the check with a server-time estimate taken AT apply (a fresh Date.now(), not the read-time
  // serverNow), refuses + exits on it, and all of that happens BEFORE the transaction
  const src = require('fs').readFileSync(require('path').join(__dirname, 'tools', 'order-control.js'), 'utf8');
  const at = src.indexOf('const atApply = C.serverClock(clock.offsetMs, Date.now()).serverNow;');
  const call = src.indexOf('const late = C.checkAtApply(plan, atApply);');
  const refuse = src.indexOf("if (!late.ok) { console.error(`order-control: REFUSED — ${late.error}`); process.exit(1); }");
  const txn = src.indexOf('nodeRef.transaction(');
  assert.ok(at > 0 && call > at && refuse > call && txn > refuse, `order: estimate ${at} < check ${call} < refuse ${refuse} < transaction ${txn}`);
  assert.strictEqual(src.split('C.checkAtApply(').length - 1, 1, 'exactly one apply-time check');
  assert.strictEqual(src.split('nodeRef.transaction(').length - 1, 1, 'exactly one transaction');
  assert.ok(src.indexOf('const plan = C.planChange(') < at, 'the plan is made before the apply-time estimate');
  ok('wiring: the CLI takes a fresh server-time estimate AT apply, calls checkAtApply with it and exits on a refusal, all BEFORE the one transaction');
}
{
  assert.match(C.describeUntil(Date.parse('2030-01-01T06:00:00Z')), /^2030-01-01T06:00:00\.000Z \(UTC\) = /);
  assert.match(C.describeUntil(null), /indefinida/);
  assert.match(C.describeState({ paused: true }, NOW), /^PAUSED \(no end time\)$/);
  assert.match(C.describeState({ paused: true, until: NOW + 5 }, NOW), /^PAUSED \(until 2030/);
  assert.strictEqual(C.describeState(null, NOW), 'OPEN');
  assert.strictEqual(C.describeState({ paused: 'x' }, NOW), 'UNKNOWN');
  ok('describe: the end time in UTC and ISO with an offset; the state names');
}

console.log(`\norder-control-cli: OK (${n})`);
