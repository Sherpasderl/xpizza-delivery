// Unit test for the svc-handle safety net (codex r1 P1-7 + r2 P1-1/P1-2). Run: node lib/svc-handle.test.js
const assert = require('node:assert/strict');
const H = require('./svc-handle');

// A fake db: programmable flag (with optional delay / throw), mode, per-uid accounts; records pushed alerts.
function fakeDb({ flag = false, flagDelayMs = 0, throwFlag = false, mode = null, accounts = {}, throwMode = false, throwAccount = false } = {}) {
  const alerts = []; let flagReads = 0;
  return {
    alerts, get flagReads() { return flagReads; },
    ref(path) {
      return {
        once: async () => {
          if (path === H.FLAG_PATH) {
            flagReads++;
            if (flagDelayMs) await new Promise((r) => setTimeout(r, flagDelayMs));
            if (throwFlag) throw new Error('flag read failed');
            return { val: () => (flag ? true : false) };
          }
          if (path === H.MODE_PATH) { if (throwMode) throw new Error('mode read failed'); return { val: () => mode }; }
          const m = path.match(/^driver_accounts\/(.+)$/);
          if (m) { if (throwAccount) throw new Error('account read failed'); return { val: () => accounts[m[1]] || null }; }
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
const T = H.FLAG_TTL_MS;

(async () => {
  // ---- cache ----
  await t('cache: a second read within the TTL does NOT re-read RTDB', async () => {
    H._resetCacheForTest(); const db = fakeDb({ flag: true });
    assert.equal(await H.svcHandleEnabled(db, T), true);
    assert.equal(await H.svcHandleEnabled(db, 2 * T - 1), true);
    assert.equal(db.flagReads, 1);
  });
  await t('cache: single-flight — concurrent cold reads share ONE read', async () => {
    H._resetCacheForTest(); const db = fakeDb({ flag: true });
    const [a, b] = await Promise.all([H.svcHandleEnabled(db, T), H.svcHandleEnabled(db, T)]);
    assert.equal(a, true); assert.equal(b, true); assert.equal(db.flagReads, 1);
  });
  await t('cache: a FAILED refresh → DEFAULT (false), never retains a stale true, and BACKS OFF', async () => {
    H._resetCacheForTest();
    await H.svcHandleEnabled(fakeDb({ flag: true }), T);            // establish a fresh true
    const failing = fakeDb({ throwFlag: true });
    assert.equal(await H.svcHandleEnabled(failing, 2 * T + 1), false, 'stale + failed refresh → default false, NOT the stale true');
    assert.equal(failing.flagReads, 1, 'it did attempt the refresh');
    const during = fakeDb({ flag: true });
    assert.equal(await H.svcHandleEnabled(during, 2 * T + 2), false, 'within backoff → default, no re-read');
    assert.equal(during.flagReads, 0, 'backoff suppressed the re-read (no thundering)');
  });
  await t('cache: a refresh slower than the latency bound → DEFAULT + backoff', async () => {
    H._resetCacheForTest();
    const slow = fakeDb({ flag: true, flagDelayMs: H.FLAG_REFRESH_TIMEOUT_MS + 200 });
    assert.equal(await H.svcHandleEnabled(slow, T), false, 'read exceeded the bound → default handle');
  });

  // ---- pickHandle ----
  await t('pickHandle: flag off → the default db; flag on → NOT the default db (the svc handle)', async () => {
    H._resetCacheForTest(); const off = fakeDb({ flag: false });
    assert.equal(await H.pickHandle(off), off, 'off → default');
    H._resetCacheForTest(); const on = fakeDb({ flag: true });
    assert.notEqual(await H.pickHandle(on), on, 'on → the svc handle (a different db)');
  });

  // ---- isExpectedEligibilityDenial ----
  await t('isExpectedEligibilityDenial: true only for permission-denied on an explicitly ineligible target', async () => {
    const db = fakeDb({ accounts: { de: { deactivated: true }, su: { enabled: false }, en: { enabled: true }, de2: { deactivated: true } } });
    const E = () => { const e = new Error('PERMISSION_DENIED'); e.code = 'PERMISSION_DENIED'; return e; };
    assert.equal(await H.isExpectedEligibilityDenial(E(), db, 'de'), true);
    assert.equal(await H.isExpectedEligibilityDenial(E(), db, 'su'), true);
    assert.equal(await H.isExpectedEligibilityDenial(E(), db, 'en'), false, 'eligible target → unexpected');
    assert.equal(await H.isExpectedEligibilityDenial(E(), db, 'absent'), false, 'absent account → unexpected');
    assert.equal(await H.isExpectedEligibilityDenial(new Error('boom'), db, 'de'), false, 'non-permission → not eligibility');
  });

  // ---- svcWriteOrFallback ----
  await t('fallback: flag off (handle===db) → default handle, no fallback', async () => {
    const db = fakeDb(); let h = null; await H.svcWriteOrFallback(db, db, async (x) => { h = x; }, { site: 's' }); assert.equal(h, db);
  });
  await t('fallback: on + success → the svc handle is used', async () => {
    const db = fakeDb(); const svc = {}; let used = null; await H.svcWriteOrFallback(db, svc, async (x) => { used = x; }, { site: 's' }); assert.equal(used, svc);
  });
  await t('fallback: UNEXPECTED denial in tolerant (eligible target) → fallback to default + bounded alert', async () => {
    const db = fakeDb({ mode: null, accounts: { en: { enabled: true } } }); const svc = {}; const calls = [];
    await H.svcWriteOrFallback(db, svc, async (x) => { calls.push(x); if (x === svc) DENY(); }, { site: 'autoAssign.claim', target: 'en' });
    assert.deepEqual(calls, [svc, db], 'tried svc, then fell back to db');
    assert.equal(db.alerts.length, 1); assert.equal(db.alerts[0].type, 'svc_handle_fallback'); assert.equal(db.alerts[0].target, 'en');
  });
  await t('fallback: EXPECTED eligibility denial (deactivated target) in tolerant → STAYS DENIED (no fallback, no alert)', async () => {
    const db = fakeDb({ mode: null, accounts: { de: { deactivated: true } } }); const svc = {};
    await assert.rejects(H.svcWriteOrFallback(db, svc, async (x) => { if (x === svc) DENY(); }, { site: 's', target: 'de' }), /PERMISSION_DENIED/);
    assert.equal(db.alerts.length, 0, 'a suspended/deactivated target is never resurrected by the fallback');
  });
  await t('fallback: denial in CLOSED mode → propagates, no fallback', async () => {
    const db = fakeDb({ mode: 'closed', accounts: { en: { enabled: true } } }); const svc = {};
    await assert.rejects(H.svcWriteOrFallback(db, svc, async (x) => { if (x === svc) DENY(); }, { site: 's', target: 'en' }), /PERMISSION_DENIED/);
    assert.equal(db.alerts.length, 0);
  });
  await t('fallback: a FAILED mode read → propagates (never bypass enforcement)', async () => {
    const db = fakeDb({ throwMode: true, accounts: { en: { enabled: true } } }); const svc = {};
    await assert.rejects(H.svcWriteOrFallback(db, svc, async (x) => { if (x === svc) DENY(); }, { site: 's', target: 'en' }), /PERMISSION_DENIED/);
    assert.equal(db.alerts.length, 0);
  });
  await t('fallback: a FAILED account read → propagates (loud, never silently handled)', async () => {
    const db = fakeDb({ mode: null, throwAccount: true }); const svc = {};
    await assert.rejects(H.svcWriteOrFallback(db, svc, async (x) => { if (x === svc) DENY(); }, { site: 's', target: 'en' }), /PERMISSION_DENIED/);
    assert.equal(db.alerts.length, 0);
  });
  await t('fallback: a NON-permission fault always propagates', async () => {
    const db = fakeDb({ mode: null }); const svc = {};
    await assert.rejects(H.svcWriteOrFallback(db, svc, async () => { throw new Error('boom'); }, { site: 's', target: 'en' }), /boom/);
  });

  console.log(`\nsvc-handle: ${passed} tests passed`);
})().catch((e) => { console.error('svc-handle FAILED:', e && e.stack || e); process.exit(1); });
