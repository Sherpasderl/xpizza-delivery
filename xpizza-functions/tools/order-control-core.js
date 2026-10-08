'use strict';
// D4-c4 — the PURE core of the owner's pause CLI (tools/order-control.js; PLAN-D4c4 rev 13 §1/§0.1/§0.3/§0.10).
// Argument parsing, the end-time rules, the server-clock estimate, the change plan and the RTDB transaction callback.
// No I/O: the CLI wires these to the database, so every rule here is unit-tested (order-control-cli.test.js) and the
// emulator suite (test/order-control-cli.emulator.test.js) drives the real CLI end to end.
const S = require('../order-control-state');

const MIN_LEAD_MS = 60 * 1000;            // --until must be more than 60 s after server-now (§0.3)
const SKEW_WARN_MS = 5 * 60 * 1000;       // |serverTimeOffset| above this → a WARNING, never a block (§0.3, codex r13 NIT 1)
const MAX_FOR_MS = 7 * 24 * 60 * 60 * 1000;   // a typo guard on --for (an indefinite pause is `--pause` with no end time)
const RID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// ISO-8601 with an EXPLICIT offset (Z or ±HH:MM) — the platform assumes no timezone (§1)
const UNTIL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

const USAGE = 'usage: order-control.js --project <id> --rid <rid> (--pause [--for <N>m|<N>h | --until <ISO-8601 with offset>] | --resume) --reason "…" --actor "<name>" [--expect-version <N>] [--apply]';

function parseArgs(argv) {
  const a = { apply: false };
  const VALUE = new Set(['--project', '--rid', '--for', '--until', '--reason', '--actor', '--expect-version']);
  const FLAG = new Set(['--pause', '--resume', '--apply']);
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    let k = argv[i]; let v;
    if (k.startsWith('--') && k.includes('=')) { v = k.slice(k.indexOf('=') + 1); k = k.slice(0, k.indexOf('=')); }
    if (seen.has(k)) return { ok: false, error: `${k} given twice` };
    seen.add(k);
    if (FLAG.has(k)) { if (v !== undefined) return { ok: false, error: `${k} takes no value` }; a[k.slice(2)] = true; continue; }
    if (!VALUE.has(k)) return { ok: false, error: `unknown argument ${k}` };
    if (v === undefined) { v = argv[i + 1]; i++; }
    if (v === undefined || v === '' || (v.startsWith('--') && VALUE.has(v))) return { ok: false, error: `${k} needs a value` };
    a[k.slice(2)] = v;
  }
  if (!!a.pause === !!a.resume) return { ok: false, error: 'exactly one of --pause / --resume' };
  if (a.resume && (a.for !== undefined || a.until !== undefined)) return { ok: false, error: '--for / --until only with --pause' };
  if (a.for !== undefined && a.until !== undefined) return { ok: false, error: 'give --for OR --until, not both' };
  if (!a.rid || !RID_RE.test(a.rid)) return { ok: false, error: '--rid <restaurant id> required' };
  if (!a.reason || !a.reason.trim()) return { ok: false, error: '--reason "…" required' };
  if (!a.actor || !a.actor.trim()) return { ok: false, error: '--actor "<name>" required' };
  let expectVersion = null;
  if (a['expect-version'] !== undefined) {
    if (!/^\d+$/.test(a['expect-version'])) return { ok: false, error: '--expect-version must be a non-negative integer' };
    expectVersion = Number(a['expect-version']);
  }
  let forMs = null;
  if (a.for !== undefined) {
    const m = /^(\d+)(m|h)$/.exec(a.for);
    if (!m) return { ok: false, error: '--for must be <N>m or <N>h (e.g. 30m, 2h)' };
    forMs = Number(m[1]) * (m[2] === 'h' ? 3600000 : 60000);
    if (!(forMs > 0)) return { ok: false, error: '--for must be more than zero' };
    if (forMs > MAX_FOR_MS) return { ok: false, error: '--for is capped at 7 days (use --pause with no end time for an indefinite pause)' };
  }
  let untilMs = null;
  if (a.until !== undefined) {
    if (!UNTIL_RE.test(a.until)) return { ok: false, error: '--until must be ISO-8601 WITH an explicit offset (e.g. 2026-10-08T18:30:00-06:00 or …Z)' };
    untilMs = Date.parse(a.until);
    if (!Number.isFinite(untilMs)) return { ok: false, error: '--until is not a valid date' };
  }
  return { ok: true, op: a.pause ? 'pause' : 'resume', rid: a.rid, forMs, untilMs, untilRaw: a.until || null,
    reason: a.reason.trim(), actor: a.actor.trim(), expectVersion, apply: !!a.apply };
}

// §0.3: server time from RTDB `.info/serverTimeOffset`; a large offset is reported, the corrected value is still used
function serverClock(offsetMs, clientNow) {
  const off = Number.isFinite(offsetMs) ? offsetMs : 0;
  return { serverNow: clientNow + off, offsetMs: off, skewWarning: Math.abs(off) > SKEW_WARN_MS };
}

// the stored state as a COMPLETE snapshot {paused, until?} (§0.10); an absent node = {paused:false}
function snapOf(current) {
  if (current === null || current === undefined) return { paused: false };
  const s = { paused: current.paused };
  if (current.until !== undefined) s.until = current.until;
  return s;
}
const sameSnap = (a, b) => a.paused === b.paused && a.until === b.until;

function versionOf(node) {
  const v = node && node.current && node.current.version;
  return v === undefined || v === null ? 0 : v;
}

// the change: { ok, error } | { ok, noop, expectedVersion, from, to }
function planChange({ node, args, serverNow }) {
  const v = versionOf(node);
  if (!Number.isInteger(v) || v < 0) return { ok: false, error: `the stored version is malformed (${JSON.stringify(v)}) — repair order_control/${args.rid} by hand` };
  if (args.expectVersion !== null && args.expectVersion !== v) return { ok: false, conflict: true, error: `version conflict: expected ${args.expectVersion}, stored ${v}` };
  let to;
  if (args.op === 'resume') to = { paused: false };
  else if (args.forMs !== null) to = { paused: true, until: serverNow + args.forMs };
  else if (args.untilMs !== null) {
    if (!(args.untilMs > serverNow + MIN_LEAD_MS)) return { ok: false, error: `--until must be more than 60 s in the future (server now ${new Date(serverNow).toISOString()})` };
    to = { paused: true, until: args.untilMs };
  } else to = { paused: true };
  const from = snapOf(node && node.current);
  return { ok: true, noop: sameSnap(from, to), expectedVersion: v, from, to };
}

// §1: ONE transaction on order_control/{rid}. Null-first-safe and side-effect free: everything it writes was decided
// before it runs (op_id, principal, the target); a version mismatch or the same state ABORTS (no write); RTDB's first
// optimistic call with `null` for an existing node returns null, which the server rejects and re-runs with the real value.
function txnCallback({ expectedVersion, to, opId, actor, principal, reason, timestamp }) {
  return (cur) => {
    const v = versionOf(cur);
    if (v !== expectedVersion) return cur === null ? null : undefined;
    const from = snapOf(cur && cur.current);
    if (sameSnap(from, to)) return cur === null ? null : undefined;
    const version = v + 1;
    const current = { ...to, since: timestamp, by: actor, principal, reason, version, op_id: opId };
    const events = { ...((cur && cur.events) || {}), [opId]: { from, to: { ...to }, at: timestamp, by: actor, principal, reason, version } };
    return { ...(cur || {}), current, events };
  };
}

// a readable end time: UTC and ISO with the operator machine's offset
function describeUntil(ms) {
  if (ms === undefined || ms === null) return 'sin hora de fin (indefinida)';
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const local = new Date(ms + off * 60000).toISOString().replace('Z', `${sign}${pad(off / 60)}:${pad(off % 60)}`);
  return `${d.toISOString()} (UTC) = ${local}`;
}

const describeState = (current, now) => {
  const e = S.effectiveState(current, now);
  return e.state === S.PAUSED ? `PAUSED (${e.until === null ? 'no end time' : `until ${describeUntil(e.until)}`})` : e.state.toUpperCase();
};

module.exports = { USAGE, MIN_LEAD_MS, SKEW_WARN_MS, MAX_FOR_MS, UNTIL_RE, parseArgs, serverClock, snapOf, versionOf, planChange, txnCallback, describeUntil, describeState };
