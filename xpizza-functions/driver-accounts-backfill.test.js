// Backfill list + record + Auth-lookup tests — run: `node driver-accounts-backfill.test.js` (no framework, repo idiom).
const assert = require('node:assert/strict');
const {
  DRIVER_BACKFILL, DISPATCHER_UID, accountRecord, authRtdbCoherent,
  EXPECTED_PROJECT, RTDB_URL, assertProject, lookupAuthExistence,
} = require('./driver-accounts-backfill.lib');

let passed = 0;
async function t(name, fn) { await fn(); passed++; }

// A fetch stub that records its calls and returns a canned Response-shaped object (or throws a transport error).
function fakeFetch(response, { throwNetwork = false } = {}) {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); if (throwNetwork) throw new Error('network down'); return response; };
  impl.calls = calls;
  return impl;
}
const res200 = (users) => ({ ok: true, status: 200, json: async () => ({ users }), text: async () => JSON.stringify({ users }) });
const res500 = () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'INTERNAL' });

(async () => {
  await t('exactly 6 driver accounts, all uids distinct and uid-shaped (28 chars)', () => {
    assert.equal(DRIVER_BACKFILL.length, 6);
    const uids = DRIVER_BACKFILL.map((d) => d.uid);
    assert.equal(new Set(uids).size, 6, 'uids must be distinct');
    for (const uid of uids) assert.ok(/^[A-Za-z0-9]{28}$/.test(uid), `uid not 28-char alnum: ${uid}`);
  });

  await t('the dispatcher uid is NEVER in the driver backfill list (dual-role safety)', () => {
    assert.ok(/^[A-Za-z0-9]{28}$/.test(DISPATCHER_UID));
    assert.ok(!DRIVER_BACKFILL.some((d) => d.uid === DISPATCHER_UID), 'dispatcher uid must not be a backfilled driver');
  });

  await t('accountRecord: grandfathered-active shape, no note for a normal driver', () => {
    const r = accountRecord({ uid: 'x', label: 'y' }, 1700000000000);
    assert.deepEqual(r, { enabled: true, onboarding_state: 'active', grandfathered: true, updated_at: 1700000000000 });
    assert.ok(!('note' in r));
  });

  await t('accountRecord: carries note when the driver has one (Play Reviewer)', () => {
    const r = accountRecord({ uid: 'x', label: 'y', note: 'play-review' }, 1700000000000);
    assert.equal(r.note, 'play-review');
    assert.equal(r.enabled, true);
  });

  await t('exactly one entry carries a note, and it is the Play Reviewer', () => {
    const noted = DRIVER_BACKFILL.filter((d) => d.note);
    assert.equal(noted.length, 1);
    assert.equal(noted[0].note, 'play-review');
    assert.match(noted[0].label, /Play Reviewer/);
  });

  await t('authRtdbCoherent (codex r1 P1-6): Auth and RTDB destinations must agree before any client', () => {
    assert.equal(authRtdbCoherent('emulator', '127.0.0.1:9099'), true);   // both emulator
    assert.equal(authRtdbCoherent('prod', undefined), true);              // both prod
    assert.equal(authRtdbCoherent('emulator', undefined), false);        // RTDB emulator, Auth prod
    assert.equal(authRtdbCoherent('prod', '127.0.0.1:9099'), false);     // Auth-only emulator (the reproduced hole)
  });

  await t('EXPECTED_PROJECT / RTDB_URL are pinned to prod (one source of truth)', () => {
    assert.equal(EXPECTED_PROJECT, 'xpizza-delivery');
    assert.equal(RTDB_URL, 'https://xpizza-delivery-default-rtdb.firebaseio.com');
  });

  await t('assertProject ([[cutover-pin-gcp-project]]): unset/matching ambient → expected; a DIFFERENT ambient throws', () => {
    assert.equal(assertProject({}), 'xpizza-delivery');                                   // unset ⇒ ADC resolves it
    assert.equal(assertProject({ GOOGLE_CLOUD_PROJECT: 'xpizza-delivery' }), 'xpizza-delivery');
    assert.throws(() => assertProject({ GOOGLE_CLOUD_PROJECT: 'lamusa-social' }), /REFUSING|!==/);  // the near-miss
    assert.throws(() => assertProject({ GCLOUD_PROJECT: 'other' }), /REFUSING/);
    assert.throws(() => assertProject({ GCP_PROJECT: 'other' }), /REFUSING/);
  });

  await t('lookupAuthExistence: a 200 returns the set of EXISTING localIds, and an omitted uid is genuinely missing', async () => {
    const f = fakeFetch(res200([{ localId: 'a' }, { localId: 'c' }]));
    const found = await lookupAuthExistence(['a', 'b', 'c'], { fetchImpl: f, accessToken: 'tok', project: 'xpizza-delivery' });
    assert.ok(found.has('a') && found.has('c'));
    assert.ok(!found.has('b'));  // a 200 that omits 'b' means 'b' is genuinely absent — NOT an undetermined error
    const { url, init } = f.calls[0];
    assert.match(url, /\/v1\/projects\/xpizza-delivery\/accounts:lookup$/);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['X-Goog-User-Project'], 'xpizza-delivery');  // the quota-project header ADC honors
    assert.equal(init.headers.Authorization, 'Bearer tok');
    assert.deepEqual(JSON.parse(init.body).localId, ['a', 'b', 'c']);       // batched by localId
  });

  // THE core regression this fix exists for: an internal error must NEVER be downgraded to "missing → skip silently".
  await t('lookupAuthExistence: a non-200 (HTTP 500 internal error) ABORTS by throwing — never "missing → skip"', async () => {
    const f = fakeFetch(res500());
    await assert.rejects(
      () => lookupAuthExistence(['a', 'b'], { fetchImpl: f, accessToken: 'tok' }),
      /HTTP 500|ABORTING|not skipping/,
      'a non-200 lookup must throw (so the run aborts), not resolve to a set that would mark uids missing',
    );
  });

  await t('lookupAuthExistence: a thrown transport/network error propagates (fail closed, not skip)', async () => {
    const f = fakeFetch(res200([]), { throwNetwork: true });
    await assert.rejects(() => lookupAuthExistence(['a'], { fetchImpl: f, accessToken: 'tok' }), /network down/);
  });

  console.log(`✓ driver-accounts-backfill: ${passed} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
