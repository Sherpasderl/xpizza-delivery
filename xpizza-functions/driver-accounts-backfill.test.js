// Backfill list + record + Auth-lookup tests — run: `node driver-accounts-backfill.test.js` (no framework, repo idiom).
const assert = require('node:assert/strict');
const {
  DRIVER_BACKFILL, DISPATCHER_UID, accountRecord, authRtdbCoherent,
  EXPECTED_PROJECT, RTDB_URL, assertProject, lookupAuthExistence, getAdcAccessToken,
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
// status + raw body, for exact-200 and shape-validation cases.
const resRaw = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

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

  // codex backfill-fix P2-1: require EXACTLY 200 and validate the body shape.
  await t('lookupAuthExistence: a 200 with `users` ABSENT is the legitimate "none exist" empty set (not an error)', async () => {
    const found = await lookupAuthExistence(['a'], { fetchImpl: fakeFetch(resRaw(200, {})), accessToken: 'tok' });
    assert.equal(found.size, 0);
  });

  await t('lookupAuthExistence: a 2xx that is NOT 200 (e.g. 202) ABORTS — exact-200 required', async () => {
    await assert.rejects(() => lookupAuthExistence(['a'], { fetchImpl: fakeFetch(resRaw(202, {})), accessToken: 'tok' }), /HTTP 202|ABORTING/);
  });

  await t('lookupAuthExistence: a 200 with a malformed body shape ABORTS (users not an array / entry without string localId)', async () => {
    await assert.rejects(() => lookupAuthExistence(['a'], { fetchImpl: fakeFetch(resRaw(200, { users: {} })), accessToken: 'tok' }), /not an array|ABORTING/);
    await assert.rejects(() => lookupAuthExistence(['a'], { fetchImpl: fakeFetch(resRaw(200, { users: [{}] })), accessToken: 'tok' }), /without a string localId|ABORTING/);
    await assert.rejects(() => lookupAuthExistence(['a'], { fetchImpl: fakeFetch(resRaw(200, null)), accessToken: 'tok' }), /non-object|ABORTING/);
  });

  // codex backfill-fix P2-2: the gcloud token failure must never leak the child's stdout/stderr (a credential).
  await t('getAdcAccessToken: a failing token command NEVER leaks the child stdout/stderr into the thrown error', () => {
    const SECRET = 'ya29.SYNTHETIC_TOKEN_MUST_NOT_LEAK';
    const execImpl = () => { const e = new Error(`gcloud failed: ${SECRET}`); e.stdout = SECRET; e.stderr = SECRET; throw e; };
    let caught;
    try { getAdcAccessToken({ execImpl }); } catch (e) { caught = e; }
    assert.ok(caught, 'must throw');
    const serialized = `${caught.message}\n${caught.stack || ''}\n${JSON.stringify(Object.getOwnPropertyNames(caught).reduce((o, k) => (o[k] = caught[k], o), {}))}`;
    assert.ok(!serialized.includes(SECRET), 'the synthetic token must not appear anywhere in the thrown error');
    assert.match(caught.message, /child output suppressed|ADC access token/);
  });

  await t('getAdcAccessToken: an empty/whitespace token throws; a valid token is returned trimmed', () => {
    assert.throws(() => getAdcAccessToken({ execImpl: () => '   \n' }), /empty/);
    assert.equal(getAdcAccessToken({ execImpl: () => '  tok-123\n' }), 'tok-123');
  });

  console.log(`✓ driver-accounts-backfill: ${passed} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
