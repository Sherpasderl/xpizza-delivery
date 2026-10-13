// Unit test for the svc-handle safety net (codex r1 P1-7 follow-up). Run: node lib/svc-handle.test.js
const assert = require('node:assert/strict');
const H = require('./svc-handle');

// A fake db: counts flag reads, serves a programmable flag + mode, records pushed alerts; throws when told.
function fakeDb({ flag = false, mode = null, throwFlag = false } = {}) {
  const alerts = []; let flagReads = 0;
  return {
    alerts, get flagReads() { return flagReads; },
    ref(path) {
      return {
        once: async () => {
          if (path === H.FLAG_PATH) { flagReads++; if (throwFlag) throw new Error('read failed'); return { val: () => (flag ? true : false) }; }
          if (path === H.MODE_PATH) return { val: () => mode };
          return { val: () => null };
        },
        push: async (rec) => { assert.equal(path, 'dispatcher_alerts'); alerts.push(rec); },
      };
    },
  };
}
const DENY = () => { const e = new Error('PERMISSION_DENIED: Permission denied'); e.code = 'PERMISSION_DENIED'; throw e; };

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log(`  ok ${passed} ${name}`); };

(async () => {
  const T = H.FLAG_TTL_MS;
  await t('cache: a second read within the TTL does NOT re-read RTDB (single RTDB read)', async () => {
    H._resetCacheForTest(); const db = fakeDb({ flag: true });
    assert.equal(await H.svcHandleEnabled(db, T), true);          // forces a read (now ≥ TTL from at=0)
    assert.equal(await H.svcHandleEnabled(db, 2 * T - 1), true);  // within the TTL of the cached read → served from cache
    assert.equal(db.flagReads, 1, 'only one RTDB read within the TTL window');
  });
  await t('cache: a read AFTER the TTL re-reads RTDB (picks up a flip)', async () => {
    H._resetCacheForTest();
    assert.equal(await H.svcHandleEnabled(fakeDb({ flag: false }), T), false);
    assert.equal(await H.svcHandleEnabled(fakeDb({ flag: true }), 2 * T + 1), true, 're-read after TTL sees the flip');
  });
  await t('cache: single-flight — concurrent cold reads share ONE RTDB read', async () => {
    H._resetCacheForTest(); const db = fakeDb({ flag: true });
    const [a, b] = await Promise.all([H.svcHandleEnabled(db, T), H.svcHandleEnabled(db, T)]);
    assert.equal(a, true); assert.equal(b, true); assert.equal(db.flagReads, 1, 'both callers shared one read');
  });
  await t('cache: a FAILED read returns the last-known value (fail-safe), defaulting to false', async () => {
    H._resetCacheForTest();
    assert.equal(await H.svcHandleEnabled(fakeDb({ throwFlag: true }), T), false, 'no prior success → false');
    await H.svcHandleEnabled(fakeDb({ flag: true }), 2 * T);   // establish last-known true
    assert.equal(await H.svcHandleEnabled(fakeDb({ throwFlag: true }), 3 * T + 1), true, 'a later failed read keeps last-known true');
  });

  await t('svcWriteOrFallback: flag off (handle===db) → default handle, no fallback machinery', async () => {
    const db = fakeDb(); let h = null; await H.svcWriteOrFallback(db, db, async (x) => { h = x; }, { site: 's' });
    assert.equal(h, db);
  });
  await t('svcWriteOrFallback: flag on + success → the svc handle is used', async () => {
    const db = fakeDb(); const svc = {}; let used = null; await H.svcWriteOrFallback(db, svc, async (x) => { used = x; }, { site: 's' });
    assert.equal(used, svc);
  });
  await t('svcWriteOrFallback: DENIED in TOLERANT mode → ONE fallback to the default handle + a loud alert', async () => {
    const db = fakeDb({ mode: null }); const svc = {}; const calls = [];
    await H.svcWriteOrFallback(db, svc, async (x) => { calls.push(x); if (x === svc) DENY(); }, { site: 'autoAssign.claim' });
    assert.deepEqual(calls, [svc, db], 'tried svc, then fell back to db');
    assert.equal(db.alerts.length, 1); assert.equal(db.alerts[0].type, 'svc_handle_fallback'); assert.equal(db.alerts[0].site, 'autoAssign.claim');
  });
  await t('svcWriteOrFallback: DENIED in CLOSED mode → propagates (eligibility refusal, no fallback, no alert)', async () => {
    const db = fakeDb({ mode: 'closed' }); const svc = {};
    await assert.rejects(H.svcWriteOrFallback(db, svc, async (x) => { if (x === svc) DENY(); }, { site: 's' }), /PERMISSION_DENIED/);
    assert.equal(db.alerts.length, 0, 'no fallback alert in closed mode');
  });
  await t('svcWriteOrFallback: a NON-permission fault always propagates (never masked)', async () => {
    const db = fakeDb(); const svc = {};
    await assert.rejects(H.svcWriteOrFallback(db, svc, async () => { throw new Error('boom'); }, { site: 's' }), /boom/);
    assert.equal(db.alerts.length, 0);
  });

  console.log(`\nsvc-handle: ${passed} tests passed`);
})().catch((e) => { console.error('svc-handle FAILED:', e && e.stack || e); process.exit(1); });
