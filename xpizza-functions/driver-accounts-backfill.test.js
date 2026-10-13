// Backfill list + record tests — run: `node driver-accounts-backfill.test.js` (no framework, repo idiom).
const assert = require('node:assert/strict');
const { DRIVER_BACKFILL, DISPATCHER_UID, accountRecord, authRtdbCoherent } = require('./driver-accounts-backfill.lib');

let passed = 0;
function t(name, fn) { fn(); passed++; }

t('exactly 6 driver accounts, all uids distinct and uid-shaped (28 chars)', () => {
  assert.equal(DRIVER_BACKFILL.length, 6);
  const uids = DRIVER_BACKFILL.map((d) => d.uid);
  assert.equal(new Set(uids).size, 6, 'uids must be distinct');
  for (const uid of uids) assert.ok(/^[A-Za-z0-9]{28}$/.test(uid), `uid not 28-char alnum: ${uid}`);
});

t('the dispatcher uid is NEVER in the driver backfill list (dual-role safety)', () => {
  assert.ok(/^[A-Za-z0-9]{28}$/.test(DISPATCHER_UID));
  assert.ok(!DRIVER_BACKFILL.some((d) => d.uid === DISPATCHER_UID), 'dispatcher uid must not be a backfilled driver');
});

t('accountRecord: grandfathered-active shape, no note for a normal driver', () => {
  const r = accountRecord({ uid: 'x', label: 'y' }, 1700000000000);
  assert.deepEqual(r, { enabled: true, onboarding_state: 'active', grandfathered: true, updated_at: 1700000000000 });
  assert.ok(!('note' in r));
});

t('accountRecord: carries note when the driver has one (Play Reviewer)', () => {
  const r = accountRecord({ uid: 'x', label: 'y', note: 'play-review' }, 1700000000000);
  assert.equal(r.note, 'play-review');
  assert.equal(r.enabled, true);
});

t('exactly one entry carries a note, and it is the Play Reviewer', () => {
  const noted = DRIVER_BACKFILL.filter((d) => d.note);
  assert.equal(noted.length, 1);
  assert.equal(noted[0].note, 'play-review');
  assert.match(noted[0].label, /Play Reviewer/);
});

t('authRtdbCoherent (codex r1 P1-6): Auth and RTDB destinations must agree before any client', () => {
  assert.equal(authRtdbCoherent('emulator', '127.0.0.1:9099'), true);   // both emulator
  assert.equal(authRtdbCoherent('prod', undefined), true);              // both prod
  assert.equal(authRtdbCoherent('emulator', undefined), false);        // RTDB emulator, Auth prod
  assert.equal(authRtdbCoherent('prod', '127.0.0.1:9099'), false);     // Auth-only emulator (the reproduced hole)
});

console.log(`✓ driver-accounts-backfill: ${passed} tests passed`);
