'use strict';
// LEDGER S4 — the owner's set-commission-rate CLI: argument refusals, the append-only plan (a duplicate instant, a PAST effective_from —
// never retro, no override — out of bounds, more than 366 days ahead), the append + read-back over an in-memory fake, and the CLI's
// project guard (it can never reach a real database here). Run: node tools/set-commission-rate.test.js
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./set-commission-rate-core');
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
async function cell(label, fn) { try { await fn(); } catch (e) { console.error(`  ✗ ${label}`); throw e; } ok(label); }
const D = (s) => Date.parse(s);
const NOW = D('2026-11-16T18:00:00Z');

(async () => {
  await cell('SCR-ARGS: --scope (_default or one restaurant id), --bp (0–10000 integer), --effective-from (Honduras time when no zone); dry run by default', async () => {
    assert.deepStrictEqual(C.parseArgs(['--project', 'x', '--scope', '_default', '--bp', '1000', '--effective-from', '2026-11-20']),
      { scope: '_default', bp: 1000, effectiveFrom: D('2026-11-20T06:00:00Z'), apply: false });
    assert.strictEqual(C.parseArgs(['--scope=la_musa', '--bp=800', '--effective-from=2026-12-01T06:00', '--apply']).apply, true);
    for (const bp of ['-1', '10001', '9.5', '1e3', '01000', 'abc', '']) assert.ok(/--bp must be an integer from 0 to 10000/.test(C.parseArgs(['--scope', '_default', '--bp', bp, '--effective-from', '2026-11-20']).error || ''), `🔴 SCR-ARGS --bp ${JSON.stringify(bp)}`);
    for (const sc of ['', 'X/Y', 'La Musa', 'a'.repeat(65)]) assert.ok(/--scope/.test(C.parseArgs(['--scope', sc, '--bp', '1000', '--effective-from', '2026-11-20']).error || ''), `🔴 SCR-ARGS --scope ${JSON.stringify(sc)}`);
    for (const a of [['--bp', '1000', '--effective-from', '2026-11-20'], ['--scope', '_default', '--effective-from', '2026-11-20'], ['--scope', '_default', '--bp', '1000'], ['--scope', '_default', '--bp', '1000', '--effective-from', '2026-11-20', '--allow-past']]) {
      assert.ok(C.parseArgs(a).error, `🔴 SCR-ARGS ${a.join(' ')} accepted (a missing flag, or --allow-past: never retro)`);
    }
    assert.ok(/not a valid ISO/.test(C.parseArgs(['--scope', '_default', '--bp', '1000', '--effective-from', '2026-02-31']).error));
    assert.ok(/never retro/.test(C.parseArgs(['--scope', '_default', '--bp', '1000', '--effective-from', '2026-11-20', '--allow-past']).error || ''), '🔴 SCR-ARGS: --allow-past is refused AS never-retro (no override exists)');
  });

  const EX = { _default: { '-Na': { bp: 1000, effective_from: D('2026-11-01T06:00:00Z') }, '-Nb': { bp: 1100, effective_from: D('2026-12-01T06:00:00Z') } } };   // one in effect now, one ahead
  const req = (o) => ({ scope: '_default', bp: 1200, effectiveFrom: D('2027-01-01T06:00:00Z'), apply: false, ...o });
  await cell('SCR-PLAN: one new entry; refuses a PAST effective_from (never retro, no override), a duplicate instant in the scope, more than 366 days ahead, out of bounds; reports the rate in effect', async () => {
    const p = C.planRate(EX, req({}), NOW);
    assert.deepStrictEqual([p.entry, p.refusals], [{ bp: 1200, effective_from: D('2027-01-01T06:00:00Z') }, []]);
    assert.ok(p.notes.some((t) => /in effect now[^:]*: 1000 bp/.test(t)), p.notes.join(' | '));
    assert.ok(C.planRate(EX, req({ effectiveFrom: NOW - 1 }), NOW).refusals.some((r) => /PAST.*never retro/.test(r)), '🔴 SCR-PLAN: a past effective_from');
    assert.ok(C.planRate(EX, req({ effectiveFrom: D('2026-12-01T06:00:00Z') }), NOW).refusals.some((r) => /already takes effect/.test(r)), '🔴 SCR-PLAN: a duplicate instant');
    assert.deepStrictEqual(C.planRate(EX, req({ scope: 'la_musa', effectiveFrom: D('2026-12-01T06:00:00Z') }), NOW).refusals, [], 'the same instant in ANOTHER scope is fine');
    assert.ok(C.planRate(EX, req({ effectiveFrom: NOW + 367 * 86400000 }), NOW).refusals.some((r) => /366 days/.test(r)), '🔴 SCR-PLAN: too far ahead');
    assert.ok(C.planRate(EX, req({ bp: 10001 }), NOW).refusals.some((r) => /out of bounds/.test(r)), '🔴 SCR-PLAN: out of bounds');
  });

  await cell('SCR-APPEND: ONE set at a NEW push key under the scope (old entries untouched), read back; an existing key and an out-of-bounds / past entry are refused before any write', async () => {
    const db = fakeRtdb({ ledger_settings: { commission: JSON.parse(JSON.stringify(EX)) } });
    const e = { bp: 1200, effective_from: D('2027-01-01T06:00:00Z') };
    assert.strictEqual(await C.appendRate(db, '_default', e, () => '-Nnew', NOW), '-Nnew');
    assert.deepStrictEqual(db.get('ledger_settings/commission/_default'), { ...EX._default, '-Nnew': e }, 'old entry untouched');
    assert.deepStrictEqual(db.writes.map((w) => [w[0], w[1]]), [['set', 'ledger_settings/commission/_default/-Nnew']], '🔴 SCR-APPEND: exactly one set at a NEW child');
    await assert.rejects(C.appendRate(db, '_default', { ...e, effective_from: e.effective_from + 1 }, () => '-Na', NOW), /already exists/, '🔴 SCR-APPEND: an existing key');
    const before = db.writes.length;
    for (const [bad, sc] of [[{ bp: 10001, effective_from: e.effective_from }, '_default'], [{ bp: 1000, effective_from: NOW - 1 }, '_default'], [e, 'X/Y']]) {
      await assert.rejects(C.appendRate(db, sc, bad, () => '-Nbad', NOW), /refusing/, `🔴 SCR-APPEND wrote ${JSON.stringify([bad, sc])}`);
    }
    assert.strictEqual(db.writes.length, before, '🔴 SCR-APPEND: a refused append reached the database');
  });

  await cell('SCR-CLI: the CLI refuses without a stated --project (an inherited project variable is not enough), and a bad --bp refuses with exit 2 before any read', async () => {
    const env = { ...process.env, FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:1', GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/creds.json' };
    delete env.GOOGLE_CLOUD_PROJECT; delete env.GCLOUD_PROJECT; delete env.NODE_OPTIONS;
    const cli = path.join(__dirname, 'set-commission-rate.js');
    const args = ['--scope', '_default', '--bp', '1000', '--effective-from', '2030-01-01'];
    const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 20000 });
    assert.notStrictEqual(r.status, 0, '🔴 SCR-CLI: refuses without --project'); assert.ok(!/DRY RUN|APPLY|appended/.test(r.stdout));
    const expected = require('./require-project').expectedProject();
    for (const v of ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT']) {
      const r2 = spawnSync(process.execPath, [cli, ...args, '--apply'], { env: { ...env, [v]: expected }, encoding: 'utf8', timeout: 20000 });
      assert.ok(r2.status !== 0 && /explicit flag/.test(r2.stderr) && !/DRY RUN|APPLY|appended/.test(r2.stdout), `🔴 SCR-CLI: ${v} alone`);
    }
    const envProd = { ...env }; delete envProd.FIREBASE_DATABASE_EMULATOR_HOST;
    const r3 = spawnSync(process.execPath, [cli, '--project', expected, '--scope', '_default', '--bp', '-1', '--effective-from', '2030-01-01'], { env: envProd, encoding: 'utf8', timeout: 20000 });
    assert.ok(r3.status === 2 && /--bp must be an integer from 0 to 10000/.test(r3.stderr) && !/DRY RUN/.test(r3.stdout), `🔴 SCR-CLI: bad --bp (${r3.status} ${r3.stderr})`);
  });
  console.log(`\nset-commission-rate: OK (${n})`);
})().catch((e) => { console.error('set-commission-rate FAILED:', e && e.message); process.exit(1); });
