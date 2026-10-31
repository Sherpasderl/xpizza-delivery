'use strict';
// PAY RATE (PROPOSAL-driver-pay-rate-reader r2) — the owner's set-driver-rate CLI: argument refusals, Honduras-time parsing,
// the append-only plan (duplicate / past refusals), the append + read-back over an in-memory fake, and the CLI's project guard.
// Run: node tools/set-driver-rate.test.js
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./set-driver-rate-core');
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  // ── args ──
  const good = C.parseArgs(['--project', 'x', '--cents', '7000', '--effective-from', '2026-11-03']);
  assert.deepStrictEqual(good, { cents: 7000, effectiveFrom: Date.parse('2026-11-03T06:00:00Z'), apply: false, allowPast: false }, 'a date alone = 00:00 Honduras time = 06:00Z; dry run by default');
  assert.strictEqual(C.parseArgs(['--cents=7000', '--effective-from=2026-11-03T06:00', '--apply']).effectiveFrom, Date.parse('2026-11-03T12:00:00Z'), 'a time without zone is Honduras time');
  assert.strictEqual(C.parseArgs(['--cents', '1', '--effective-from', '2026-11-03T12:00Z']).effectiveFrom, Date.parse('2026-11-03T12:00:00Z'), 'an explicit Z is honoured');
  assert.strictEqual(C.parseArgs(['--cents', '1', '--effective-from', '2026-11-03T00:00-06:00']).effectiveFrom, Date.parse('2026-11-03T06:00:00Z'), 'an explicit offset is honoured');
  for (const c of ['0', '-5', '70.5', '7e3', '07000', 'abc', '', '99999999999999999999']) {
    const r = C.parseArgs(['--cents', c, '--effective-from', '2026-11-03']);
    assert.ok(r.error && /positive integer/.test(r.error), `🔴 --cents ${JSON.stringify(c)} was accepted`);
  }
  for (const d of ['2026-02-31', '2026-13-01', 'tomorrow', '2026/11/03', '2026-11-03T25:00', '']) {
    const r = C.parseArgs(['--cents', '7000', '--effective-from', d]);
    assert.ok(r.error, `🔴 --effective-from ${JSON.stringify(d)} was accepted`);
  }
  assert.match(C.parseArgs(['--effective-from', '2026-11-03']).error, /--cents is required/);
  assert.match(C.parseArgs(['--cents', '7000']).error, /--effective-from is required/);
  assert.match(C.parseArgs(['--cents', '7000', '--effective-from', '2026-11-03', '--force']).error, /unknown argument/);
  ok('args: --cents a positive integer only (0, negative, fractional, exponent, leading zero, text, unsafe refused); --effective-from ISO (no zone = Honduras UTC-6; Z / offset honoured; overflow dates refused); unknown flags refused; dry run by default');

  // ── plan ──
  const NOW = Date.parse('2026-11-01T00:00:00Z');
  const EX = { '-Na': { cents: 7000, effective_from: Date.parse('2026-10-01T06:00:00Z') } };
  const fut = { cents: 8000, effectiveFrom: Date.parse('2026-11-10T06:00:00Z'), allowPast: false };
  let p = C.planRate(EX, fut, NOW);
  assert.deepStrictEqual(p.entry, { cents: 8000, effective_from: fut.effectiveFrom });
  assert.deepStrictEqual(p.refusals, []);
  assert.ok(p.notes.some((x) => /in effect now: 7000 cents/.test(x)), 'the plan reports the rate in effect now');
  p = C.planRate(EX, { ...fut, effectiveFrom: EX['-Na'].effective_from }, NOW);
  assert.ok(p.refusals.some((r) => /already takes effect at that instant/.test(r)), '🔴 a duplicate effective_from was accepted');
  p = C.planRate(EX, { ...fut, effectiveFrom: NOW - 1 }, NOW);
  assert.ok(p.refusals.some((r) => /PAST/.test(r)), '🔴 a past effective_from was accepted without --allow-past');
  assert.deepStrictEqual(C.planRate(EX, { ...fut, effectiveFrom: NOW - 1, allowPast: true }, NOW).refusals, [], '--allow-past permits a deliberate backdate');
  assert.deepStrictEqual(C.planRate(null, fut, NOW).refusals, [], 'the first entry on an empty node');
  assert.ok(C.planRate({ ...EX, bad: { cents: 'x' } }, fut, NOW).notes.some((x) => /malformed/.test(x)), 'an existing malformed entry is reported');
  ok('plan: one new entry; refuses a duplicate effective_from and a past one (unless --allow-past); reports the rate in effect now and any malformed existing entry');

  // ── append (in-memory fake) ──
  const db = fakeRtdb({ platform_rates: { driver_per_delivery: { ...EX } } });
  const key = await C.appendRate(db, { cents: 8000, effective_from: fut.effectiveFrom }, () => '-Nnew');
  assert.strictEqual(key, '-Nnew');
  assert.deepStrictEqual(db.get('platform_rates/driver_per_delivery'), { ...EX, '-Nnew': { cents: 8000, effective_from: fut.effectiveFrom } }, 'the old entry is untouched; the new one is added');
  assert.deepStrictEqual(db.writes.map((w) => [w[0], w[1]]), [['set', 'platform_rates/driver_per_delivery/-Nnew']], '🔴 APPEND-ONLY: exactly one set, at a NEW child (never the node, never an existing entry)');
  await assert.rejects(C.appendRate(db, { cents: 1, effective_from: 1 }, () => '-Na'), /already exists/, '🔴 an existing key is never overwritten');
  assert.deepStrictEqual(db.get('platform_rates/driver_per_delivery/-Na'), EX['-Na'], 'and stays as it was');
  ok('append: ONE set at a new push key (old entries untouched), read back; an existing key is refused, never overwritten');

  // ── the CLI's project guard (it can NEVER reach a real database: dead local RTDB port, credentials pointing nowhere) ──
  const env = { ...process.env, FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:1', GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/creds.json' };
  delete env.GOOGLE_CLOUD_PROJECT; delete env.GCLOUD_PROJECT; delete env.NODE_OPTIONS;
  const cli = path.join(__dirname, 'set-driver-rate.js');
  const args = ['--cents', '7000', '--effective-from', '2030-01-01'];
  const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 20000 });
  assert.notStrictEqual(r.status, 0, 'refuses without --project');
  assert.ok(!/DRY RUN|APPLY|appended/.test(r.stdout), 'and reads / writes nothing');
  const expected = require('./require-project').expectedProject();
  for (const v of ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT']) {
    const r2 = spawnSync(process.execPath, [cli, ...args, '--apply'], { env: { ...env, [v]: expected }, encoding: 'utf8', timeout: 20000 });
    assert.notStrictEqual(r2.status, 0, `${v}=${expected} without --project is refused`);
    assert.match(r2.stderr, /explicit flag/, 'with the explicit-flag refusal');
    assert.ok(!/DRY RUN|APPLY|appended/.test(r2.stdout), 'and nothing is planned, read or written');
  }
  // a stated --project with NO emulator signal passes the guard; the bad --cents must then refuse BEFORE initializeApp (credentials still point nowhere)
  const envProd = { ...env }; delete envProd.FIREBASE_DATABASE_EMULATOR_HOST;
  const r3 = spawnSync(process.execPath, [cli, '--project', expected, '--cents', '0', '--effective-from', '2030-01-01'], { env: envProd, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(r3.status, 2, 'a bad --cents refuses with exit 2'); assert.match(r3.stderr, /positive integer/); assert.ok(!/DRY RUN/.test(r3.stdout), 'before any read');
  ok('the CLI refuses without a stated --project (an inherited GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT is not enough), and a bad --cents refuses before any read');

  console.log(`\nset-driver-rate: OK (${n})`);
})().catch((e) => { console.error('set-driver-rate FAILED:', e); process.exit(1); });
