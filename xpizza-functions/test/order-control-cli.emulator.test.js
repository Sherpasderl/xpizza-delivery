'use strict';
// D4-c4 "Pausar pedidos" — the REAL owner CLI (tools/order-control.js) end to end on the emulators, spawned as the owner
// runs it (PLAN-D4c4 rev 13 §1/§0.1/§0.3/§0.10). Run: npm run test:order-control-cli
//   dry run writes nothing · an unknown rid is refused · --apply: ONE transaction — current + its audit event (full
//   {paused, until} snapshots, by, principal, reason, server timestamps), read back, then EFFECTIVE after the cache wait ·
//   a REAL round-trip of an indefinite pause, a timed pause and a resume read back through the SHARED module (and the
//   functions' own reader) · same-state no-op · --expect-version conflict · --until without an offset / too soon refused ·
//   SUPERSEDED when another apply lands during the wait · a registry-only THIRD synthetic restaurant.
// Spawned children get the environment WITHOUT the gate's count-marks preload (NODE_OPTIONS), whose ##CELLS trailer would
// otherwise land on the CLI's own stdout (memory: spawned-child-inherits-gate-preload).
require('./_emulator-required')('database', 'firestore');
const assert = require('assert');
const { execFileSync, spawn } = require('child_process');
const path = require('path');
const admin = require('firebase-admin');
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const S = require('../order-control-state');
const OC = require('../order-control');
const PROJECT = 'xpizza-delivery';
admin.initializeApp({ projectId: PROJECT, databaseURL: RTDB_URL });
const rtdb = admin.database();
const fs = admin.firestore();

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('order-control-cli(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const childEnv = () => { const e = { ...process.env }; delete e.NODE_OPTIONS; delete e.FORCE_COLOR; return e; };
const TOOL = path.join(__dirname, '..', 'tools', 'order-control.js');
const cli = (...args) => {
  try { return { code: 0, out: execFileSync('node', [TOOL, '--project', PROJECT, ...args], { encoding: 'utf8', env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 }) }; }
  catch (e) { return { code: e.status === null ? `TIMEOUT(${e.signal})` : e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
const cliAsync = (...args) => new Promise((resolve) => {
  const p = spawn('node', [TOOL, '--project', PROJECT, ...args], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out }));
});
const tree = async () => JSON.stringify((await rtdb.ref().get()).val());
const node = async (rid) => (await rtdb.ref(`order_control/${rid}`).get()).val();
const who = ['--reason', 'cocina llena', '--actor', 'Ana'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await rtdb.ref().set(null);
  await rtdb.ref('restaurants/x_pizza/identity').set({ name: 'X' });
  await rtdb.ref('restaurants/la_musa/identity').set({ name: 'L' });
  await fs.collection('restaurants').doc('synthetic_3').set({ name: 's3' });   // a registry-only THIRD merchant

  let before = await tree();
  let r = cli('--rid', 'x_pizza', '--pause', ...who);
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /DRY RUN/); assert.match(r.out, /\{"paused":false\} → \{"paused":true\}/);
  assert.match(r.out, /--expect-version 0/);
  assert.strictEqual(await tree(), before, '🔴 a dry run writes nothing');
  r = cli('--rid', 'nope_rid', '--pause', ...who, '--apply');
  assert.strictEqual(r.code, 1, r.out); assert.match(r.out, /unknown restaurant "nope_rid"/); assert.strictEqual(await tree(), before);
  r = cli('--rid', 'x_pizza', '--pause', '--until', '2030-01-01T00:00:00', ...who, '--apply');
  assert.strictEqual(r.code, 2, r.out); assert.match(r.out, /explicit offset/); assert.strictEqual(await tree(), before);
  r = cli('--rid', 'x_pizza', '--pause', '--until', new Date(Date.now() + 30000).toISOString(), ...who, '--apply');
  assert.strictEqual(r.code, 1, r.out); assert.match(r.out, /more than 60 s in the future/); assert.strictEqual(await tree(), before);
  r = cli('--rid', 'x_pizza', '--pause', ...who.slice(0, 2), '--apply');
  assert.strictEqual(r.code, 2, r.out); assert.match(r.out, /--actor/);
  try { execFileSync('node', [TOOL, '--rid', 'x_pizza', '--pause', ...who, '--apply'], { encoding: 'utf8', env: { ...childEnv(), GOOGLE_CLOUD_PROJECT: PROJECT }, stdio: ['ignore', 'pipe', 'pipe'] }); assert.fail('ran without --project'); }
  catch (e) { assert.strictEqual(e.status, 2, 'the project must be an explicit --project flag (an env var is not enough)'); assert.match(String(e.stderr), /explicit flag/); }
  assert.strictEqual(await tree(), before);
  ok('dry run (prints current → change + the version to bind) writes NOTHING; refused with nothing written: an unknown rid, --until without an explicit offset, --until within 60 s, a missing --actor, no explicit --project flag');

  // indefinite pause — the real transaction
  r = cli('--rid', 'x_pizza', '--pause', ...who, '--apply', '--expect-version', '0');
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /applied op oc_/); assert.match(r.out, /EFFECTIVE — x_pizza is PAUSED \(no end time\)/);
  let nd = await node('x_pizza');
  const op1 = nd.current.op_id;
  assert.deepStrictEqual(Object.keys(nd.current).sort(), ['by', 'op_id', 'paused', 'principal', 'reason', 'since', 'version']);
  assert.strictEqual(nd.current.paused, true); assert.ok(!('until' in nd.current), 'an indefinite pause stores NO until (RTDB drops nulls; the CLI never writes until:null)');
  assert.strictEqual(nd.current.version, 1); assert.strictEqual(nd.current.by, 'Ana'); assert.strictEqual(nd.current.principal, 'emulator (no credential)'); assert.strictEqual(nd.current.reason, 'cocina llena');
  assert.ok(Number.isFinite(nd.current.since) && Math.abs(nd.current.since - Date.now()) < 120000, 'since = the SERVER timestamp, resolved');
  assert.deepStrictEqual(Object.keys(nd.events), [op1]);
  assert.deepStrictEqual(nd.events[op1], { from: { paused: false }, to: { paused: true }, at: nd.current.since, by: 'Ana', principal: 'emulator (no credential)', reason: 'cocina llena', version: 1 });
  assert.strictEqual(S.effectiveState(nd.current, Date.now()).state, 'paused');
  OC._resetForTests(); assert.strictEqual(await OC.orderControlFor(rtdb, 'x_pizza'), 'paused', 'the functions\' own reader sees it');
  ok('--apply (indefinite): ONE transaction — current {paused:true, NO until, since: server time, by, principal, reason, version 1, op_id} + its audit event with full from/to snapshots; read back; EFFECTIVE after the cache wait; the shared module and the functions\' reader both read PAUSED');

  // same-state no-op
  before = await tree();
  r = cli('--rid', 'x_pizza', '--pause', ...who, '--apply');
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /already in that state — nothing to write/); assert.strictEqual(await tree(), before);
  // version conflict
  r = cli('--rid', 'x_pizza', '--resume', ...who, '--apply', '--expect-version', '0');
  assert.strictEqual(r.code, 1, r.out); assert.match(r.out, /version conflict: expected 0, stored 1/); assert.strictEqual(await tree(), before, '🔴 a conflict writes nothing');
  ok('same state → "nothing to write" (tree byte-identical); --expect-version ≠ stored → version CONFLICT, refused, nothing written');

  // timed pause (--for) → auto-resume read through the shared module at until
  r = cli('--rid', 'x_pizza', '--pause', '--for', '2h', ...who, '--apply');
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /EFFECTIVE — x_pizza is PAUSED \(until \d{4}-/);
  nd = await node('x_pizza');
  assert.strictEqual(nd.current.version, 2);
  const until = nd.current.until;
  assert.ok(Math.abs(until - (Date.now() + 7200000)) < 120000, `until ≈ server-now + 2 h (${until})`);
  const op2 = nd.current.op_id;
  assert.deepStrictEqual(nd.events[op2].from, { paused: true }); assert.deepStrictEqual(nd.events[op2].to, { paused: true, until });
  assert.strictEqual(S.effectiveState(nd.current, until - 1).state, 'paused');
  assert.strictEqual(S.effectiveState(nd.current, until).state, 'open', 'auto-resume at until');
  // --until with an explicit offset
  const wantUntil = Math.floor((Date.now() + 3 * 3600000) / 60000) * 60000;
  const iso = new Date(wantUntil - 6 * 3600000).toISOString().slice(0, 19) + '-06:00';   // the same instant, written with a -06:00 offset
  r = cli('--rid', 'x_pizza', '--pause', '--until', iso, ...who, '--apply');
  assert.strictEqual(r.code, 0, r.out);
  nd = await node('x_pizza');
  assert.strictEqual(nd.current.until, wantUntil, `--until ${iso} honoured to the ms (offset applied)`);
  assert.strictEqual(nd.current.version, 3);
  ok('timed pauses: --for 2h → until = server-now + 2 h; --until <ISO with -06:00> → exactly that instant; each a recorded change with full snapshots; the shared module reads PAUSED until − 1 ms and OPEN at until (the auto-resume)');

  // resume
  r = cli('--rid', 'x_pizza', '--resume', ...who, '--apply');
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /EFFECTIVE — x_pizza is OPEN/);
  nd = await node('x_pizza');
  assert.strictEqual(nd.current.paused, false); assert.ok(!('until' in nd.current)); assert.strictEqual(nd.current.version, 4);
  assert.strictEqual(Object.keys(nd.events).length, 4, 'four audit rows, one per change');
  OC._resetForTests(); assert.strictEqual(await OC.orderControlFor(rtdb, 'x_pizza'), null);
  ok('--resume: {paused:false}, version 4, the fourth audit row; the functions\' reader admits again');

  // superseded: another apply lands while the first waits for the caches
  const first = cliAsync('--rid', 'la_musa', '--pause', ...who, '--apply');
  for (let i = 0; i < 100 && !((await node('la_musa')) || {}).current; i++) await wait(100);
  r = cli('--rid', 'la_musa', '--resume', '--reason', 'falsa alarma', '--actor', 'Beto', '--apply');
  assert.strictEqual(r.code, 0, r.out);
  const f = await first;
  assert.strictEqual(f.code, 0, f.out); assert.match(f.out, /SUPERSEDED by oc_/, f.out);
  ok('a second apply landing during the first one\'s cache wait → the first reports "SUPERSEDED by <op_id>" (never "effective")');

  // a registry-only third merchant
  r = cli('--rid', 'synthetic_3', '--pause', '--for', '30m', ...who, '--apply');
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(S.effectiveState((await node('synthetic_3')).current, Date.now()).state, 'paused');
  ok('a THIRD (registry-only, synthetic) restaurant is paused with no code change');

  FINISHED = true;
  console.log(`\norder-control-cli(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('order-control-cli(emulator) FAILED:', e && e.stack || e); process.exit(1); });
