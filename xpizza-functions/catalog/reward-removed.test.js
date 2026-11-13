'use strict';
// S3 D3 (advisor 11-13, ruling (A)) — a reward key the intake gate snapshot cannot classify is decided by ONE fresh read of the
// live pointer, on that branch only: live == the snapshot's version ⇒ the gate is current, the key was really removed ⇒ 409
// menu_changed (the keyedRewardRefusal / resolutionRefusal shape), no order, no hold; live != snapshot ⇒ the gate cache is
// behind ⇒ 503 menu_updating (today); a failed / timed-out read, the static fallback, groups:null or no snapshot version ⇒ 503.
// Cash, card (fresh, reuse-armed → acquireHostedAttempt's guard), the prep-failure path and the quotes. Real gate reader + real
// built catalogs. Run: node catalog/reward-removed.test.js
const assert = require('assert');
const GI = require('./group-intake');
const { createGateReader } = require('./menu-gates');
const { buildCatalogV2 } = require('./form-menu-source');
const { resolutionRefusal } = require('./resolve-lines');
const { acquireHostedAttempt } = require('../pixelpay-hosted-charge');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ON = { render: true, authoring: false };
const BUILT = { x_pizza: buildCatalogV2('x_pizza'), la_musa: buildCatalogV2('la_musa') };
const tablesOf = (rid, b) => ({ restaurantId: rid, menu: Object.fromEntries(b.items.map((it) => [it.key, it.price])), extras: Object.fromEntries((b.extras || []).map((e) => [e.key, e.price])) });
const NS = { x_pizza: GI.rewardNamespaceIn('x_pizza', tablesOf('x_pizza', BUILT.x_pizza)), la_musa: GI.rewardNamespaceIn('la_musa', tablesOf('la_musa', BUILT.la_musa)) };
const LINE = { x_pizza: (k) => ({ name: k, qty: 1, price: 624 }), la_musa: (k) => ({ id: k, name: k, qty: 1, price: 342 }) };
const PLAIN = { x_pizza: 'Pepperoni', la_musa: 'dimsum_01' };
const GONE = { x_pizza: 'NY Garlic Slice', la_musa: 'noodle_02_tofu' };   // a key the current snapshot does not hold
const MENU_CHANGED = resolutionRefusal({ ok: false, code: 'menu_changed', at: 'redeem', index: 0 });   // the order endpoints' own refusal
const UPDATING = { status: 503, retryAfter: 2, body: { error: 'menu_updating', detail: 'El menú se está actualizando — probá de nuevo en un momento', retryable: true } };
const issuesOf = (rid, gates, keys = [GONE[rid]]) => GI.groupIssues({ caps: ON, gates, items: [LINE[rid](PLAIN[rid])], restaurantId: rid, rewardKeys: keys, rewardNamespace: NS[rid] });

// a reader whose pointer the test moves; counts every pointer read
function reader({ deadlineMs } = {}) {
  const st = { live: {}, reads: 0, hang: false, fail: false };
  const r = createGateReader({ getMenu: async (rid) => BUILT[rid], getVersionId: async (rid) => { st.reads += 1; if (st.fail) throw new Error('pointer read failed'); if (st.hang) return new Promise(() => {}); return st.live[rid] || `v1-${rid}`; }, ...(deadlineMs ? { deadlineMs } : {}) });
  return { r, st };
}

(async () => {
  assert.deepStrictEqual([MENU_CHANGED.status, MENU_CHANGED.body.error, MENU_CHANGED.body.retryable], [409, 'menu_changed', false], 'premise: the order endpoints\' menu_changed refusal');
  /* RR-SNAP: the real reader's intake snapshot names its version and carries a live re-read that bypasses the 45 s pointer TTL */
  {
    const { r, st } = reader();
    const g = await r.intakeGatesFor('la_musa');
    assert.strictEqual(g.version, 'v1-la_musa', '🔴 RR-SNAP the snapshot names the version it was read for');
    assert.strictEqual(typeof g.livePointer, 'function', '🔴 RR-SNAP the snapshot carries the live re-read');
    const before = st.reads; st.live.la_musa = 'v2-la_musa';
    assert.strictEqual(await g.livePointer(), 'v2-la_musa', '🔴 RR-SNAP the live re-read bypasses the pointer TTL');
    assert.strictEqual(st.reads, before + 1, 'RR-SNAP exactly one pointer read');
    assert.strictEqual(await r.intakeGatesFor('la_musa').then((x) => x.version), 'v1-la_musa', 'RR-SNAP the cached pointer is untouched (no behaviour change for the TTL path)');
    ok('RR-SNAP: the snapshot names its version; the live re-read is one fresh pointer read, the cached pointer untouched');
  }
  /* RR-REMOVED: the gate is current (live == snapshot) ⇒ the key was removed */
  for (const rid of ['x_pizza', 'la_musa']) {
    const { r } = reader();
    const g = await r.intakeGatesFor(rid);
    const is = await issuesOf(rid, g);
    assert.deepStrictEqual(is, { removed: [GONE[rid]] }, `🔴 RR-REMOVED ${rid}: live == snapshot ⇒ removed (${JSON.stringify(is)})`);
    assert.deepStrictEqual(GI.cashRefusal(is), MENU_CHANGED, `🔴 RR-REMOVED ${rid}: cash 409 menu_changed`);
    assert.deepStrictEqual(GI.chargeDecision(is, { willIssueFreshUrl: true }).respond, MENU_CHANGED, `🔴 RR-REMOVED ${rid}: a fresh card issuance 409 menu_changed`);
    assert.deepStrictEqual(GI.chargeDecision(is, { willIssueFreshUrl: false }), { respond: null, armChoice: false, armMenu: 'removed', block: [] }, `🔴 RR-REMOVED ${rid}: a reuse is honoured, the menu guard armed as removed`);
    assert.deepStrictEqual(GI.chargeDecision(is, null).respond, UPDATING, `RR-REMOVED ${rid}: the classifier failed ⇒ retryable 503 (a retry re-classifies)`);
    assert.deepStrictEqual(GI.prepFailureRefusal(is), MENU_CHANGED, `🔴 RR-REMOVED ${rid}: the card prep-failure path 409 menu_changed`);
    assert.deepStrictEqual(GI.quoteRefusal(is), { error: 'menu_changed' }, `🔴 RR-REMOVED ${rid}: the quotes menu_changed`);
  }
  ok('RR-REMOVED: gate current ⇒ cash / fresh card / prep failure 409 menu_changed; quotes menu_changed; reuse armed as removed; classifier failure 503');
  /* RR-BEHIND: the gate cache is behind the live pointer ⇒ today's 503 */
  for (const rid of ['x_pizza', 'la_musa']) {
    const { r, st } = reader();
    const g = await r.intakeGatesFor(rid); st.live[rid] = `v2-${rid}`;
    const is = await issuesOf(rid, g);
    assert.deepStrictEqual(is, { unclassifiable: true }, `🔴 RR-BEHIND ${rid}: live != snapshot ⇒ unclassifiable`);
    assert.deepStrictEqual(GI.cashRefusal(is), UPDATING, `RR-BEHIND ${rid}: 503 menu_updating`);
  }
  ok('RR-BEHIND: the gate cache behind the live pointer ⇒ unclassifiable (503 menu_updating), as today');
  /* RR-FAILSAFE: a failed or hung live read, the static fallback, groups:null, no version, no live reader ⇒ 503 */
  {
    const { r, st } = reader({ deadlineMs: 50 });
    const g = await r.intakeGatesFor('la_musa');
    st.fail = true;
    assert.deepStrictEqual(await issuesOf('la_musa', g), { unclassifiable: true }, '🔴 RR-FAILSAFE a failed live read ⇒ unclassifiable');
    st.fail = false; st.hang = true; const t0 = Date.now();
    const hung = await Promise.race([issuesOf('la_musa', g), new Promise((r) => { const t = setTimeout(() => r('UNBOUNDED'), 2000); })]);
    assert.deepStrictEqual(hung, { unclassifiable: true }, '🔴 RR-FAILSAFE a hung live read ⇒ unclassifiable, within the gate deadline');
    assert.ok(Date.now() - t0 < 1000, 'RR-FAILSAFE the live read is bounded by the gate deadline');
    st.hang = false;
    const reads = st.reads;
    const failing = createGateReader({ getMenu: async () => BUILT.la_musa, getVersionId: async () => { throw new Error('pointer read failed'); } });
    const fb = await failing.intakeGatesFor('la_musa');
    assert.strictEqual(fb.fallback, true, 'premise: the static fallback snapshot');
    assert.strictEqual(fb.version, undefined, '🔴 RR-FAILSAFE a pointer-failure fallback names no version');
    assert.deepStrictEqual(await issuesOf('la_musa', fb), { unclassifiable: true }, '🔴 RR-FAILSAFE the pointer-failure static fallback ⇒ unclassifiable');
    const menuFail = createGateReader({ getMenu: async () => { throw new Error('menu read failed'); }, getVersionId: async () => 'v1-la_musa' });
    const mf = await menuFail.intakeGatesFor('la_musa');
    assert.strictEqual(mf.version, undefined, '🔴 RR-FAILSAFE a menu-read-failure fallback (static known sets) names no version, though the pointer read');
    assert.deepStrictEqual(await issuesOf('la_musa', mf), { unclassifiable: true }, '🔴 RR-FAILSAFE the menu-read-failure static fallback ⇒ unclassifiable');
    assert.deepStrictEqual(await issuesOf('la_musa', { ...g, groups: null }), { unclassifiable: true }, 'RR-FAILSAFE groups:null ⇒ unclassifiable');
    assert.deepStrictEqual(await issuesOf('la_musa', { ...g, version: undefined }), { unclassifiable: true }, '🔴 RR-FAILSAFE no snapshot version ⇒ unclassifiable');
    assert.deepStrictEqual(await issuesOf('la_musa', { ...g, livePointer: undefined }), { unclassifiable: true }, 'RR-FAILSAFE no live reader ⇒ unclassifiable');
    assert.strictEqual(st.reads, reads, 'RR-FAILSAFE none of those read the pointer');
    assert.strictEqual(await issuesOf('la_musa', g, ['rice_white']), null, 'RR-FAILSAFE a KNOWN reward needs no live read');
    assert.strictEqual(st.reads, reads, 'RR-FAILSAFE zero cost on a classifiable reward');
  }
  ok('RR-FAILSAFE: failed / hung (bounded) live read, static fallback (pointer or menu read failure), groups:null, no version, no live reader ⇒ 503; a known reward reads nothing');
  /* RR-ACQUIRE: the armed menu guard inside acquireHostedAttempt answers by its arming — removed ⇒ menu_changed, true ⇒ menu_updating */
  {
    const root = {};
    const db = { ref: () => ({ async once() { return { val: () => null }; }, async transaction() { throw new Error('no CAS expected'); }, async update() { throw new Error('no write expected'); } }) };
    const PENDING = { order_id: 'O1', status: 'pending_payment', payment_status: 'pending', payment_method: 'online', total: 299, total_cents: 29900 };
    const acq = async (menu) => { try { return await acquireHostedAttempt(db, 'O1', PENDING, 'fp', 1e9, [], () => 'A', () => 'T', null, false, false, menu); } catch (e) { return { threw: String(e && e.message) }; } };
    assert.deepStrictEqual(await acq('removed'), { outcome: 'conflict', reason: 'menu_changed' }, '🔴 RR-ACQUIRE a fresh issuance armed as removed ⇒ menu_changed, before the CAS');
    assert.deepStrictEqual(await acq(true), { outcome: 'conflict', reason: 'menu_updating' }, 'RR-ACQUIRE armed true ⇒ menu_updating (today)');
    void root;
  }
  ok('RR-ACQUIRE: acquireHostedAttempt refuses a fresh issuance with menu_changed when armed as removed, menu_updating when armed true');
  /* RR-WIRE: the card handler (index.js, chargeOnlineOrder) arms the guard AS DECIDED — 'removed' unless a key is unclassifiable
     (true wins) — and answers acquire's menu_changed with the same 409, BEFORE its menu_updating branch */
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
    const ARM = "if (gd.armMenu) menuArmed = (menuArmed === true || gd.armMenu === true) ? true : gd.armMenu;";
    assert.strictEqual(src.split(ARM).length - 1, 1, '🔴 RR-WIRE the card handler arms the menu guard as decided (removed unless unclassifiable)');
    const ANS = "if (acq.reason === 'menu_changed') { console.warn(`chargeOnlineOrder: ${orderId} — 409 menu_changed (a removed reward; menu guard)`); const mc = require('./catalog/reward-removed').menuChangedRefusal(); return res.status(mc.status).json({ ...mc.body }); } if (acq.reason === 'menu_updating') {";
    assert.strictEqual(src.split(ANS).length - 1, 1, '🔴 RR-WIRE the card handler answers acquire\'s menu_changed with the 409, before menu_updating');
    const at = src.indexOf(ARM); const acqAt = src.indexOf('acq = await acquireHostedAttempt(', at);
    assert.ok(at > 0 && acqAt > at && /menuArmed, choic/.test(src.slice(acqAt, acqAt + 400)), '🔴 RR-WIRE the armed value reaches acquireHostedAttempt as menuRefuseFresh');
  }
  ok('RR-WIRE: the card handler arms the guard as decided and answers acquire\'s menu_changed with the 409');
  console.log(`\nreward-removed: OK (${n})`);
})().catch((e) => { console.error('reward-removed FAILED:', e); process.exit(1); });
