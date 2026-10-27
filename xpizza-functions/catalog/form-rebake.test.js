'use strict';
// PLAN 4 (bake from published) r3 §4 / §5 / §6 — the rebuild trigger and the deployed-vs-published reconciler, on a fake RTDB,
// an injected HTTP client and a fake clock. The deployed form is the REAL form with a bundle spliced by the real splice; the
// comparison is the live check's own compareBundle; the sites are the real platform manifest. Global fetch THROWS throughout:
// zero real hook calls.
// Run: node catalog/form-rebake.test.js
const assert = require('assert');
const fs = require('fs');
const FR = require('./form-rebake');
const { fakeRtdb } = require('../test/_fake-rtdb');
const { spliceBundle } = require('./splice-form-bundle');
const { generateFormBundle, catalogSnapshot } = require('./generate-form-bundle');
const { FORMS } = require('../tools/splice-form-bundle');
const SITES = require('../platform/sites.json');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('form-rebake: FAILED — exited without completing'); process.exitCode = 1; } });
const clone = (v) => JSON.parse(JSON.stringify(v));
global.fetch = () => { throw new Error('🔴 a REAL network call from a unit test'); };

const HOOK = { x_pizza: `https://api.netlify.com/build_hooks/${'a1'.repeat(12)}`, la_musa: `https://api.netlify.com/build_hooks/${'b2'.repeat(12)}` };
const HOOKS = JSON.stringify(HOOK);
const MIN = 60 * 1000;

// A real-RTDB-shaped transaction: the update function first sees the locally cached value (null), then the server's.
function rtdb() {
  const db = fakeRtdb();
  const realRef = db.ref;
  db.ref = (p) => { const r = realRef(p); const tx = r.transaction; r.transaction = async (fn) => { fn(null); return tx(fn); }; return r; };
  return db;
}
// The world: published menus, deployed forms (real HTML + a spliced bundle), a hook client, a clock, captured alarms + logs.
function world({ env = { FORM_BUILD_HOOKS: HOOKS }, hookStatus = 201 } = {}) {
  const published = { x_pizza: generateFormBundle('x_pizza', catalogSnapshot('x_pizza')), la_musa: generateFormBundle('la_musa', catalogSnapshot('la_musa')) };
  const html = { x_pizza: fs.readFileSync(FORMS.x_pizza, 'utf8'), la_musa: fs.readFileSync(FORMS.la_musa, 'utf8') };
  const deployed = { x_pizza: clone(published.x_pizza), la_musa: clone(published.la_musa) };
  const w = { published, deployed, posts: [], gets: [], alarms: [], logs: [], t: Date.UTC(2026, 9, 26, 12), hookStatus, readFails: new Set(), deployedFails: new Set() };
  const originOf = (rid) => SITES.deployments.find((d) => d.app === 'orders' && d.context === rid).origins[0];
  w.deps = {
    db: rtdb(), env, now: () => w.t, sites: SITES,
    registry: { ready: async () => {}, known: () => new Set(['la_musa', 'x_pizza', 'synthetic_3']) },
    alarm: async (kind, detail) => { w.alarms.push({ kind, detail }); },
    log: (line, detail) => { w.logs.push(`${line} ${detail}`); },
    readPublished: async (rid) => { if (w.readFails.has(rid)) throw new Error('down'); return clone(w.published[rid]); },
    http: {
      post: async (url) => { w.posts.push(url); if (w.hookStatus === 'throw') throw new Error('ECONNRESET'); return { status: w.hookStatus }; },
      getText: async (url, opts) => {
        w.gets.push({ url, cc: opts && opts.headers && opts.headers['cache-control'] });
        const rid = Object.keys(html).find((r) => url.startsWith(`${originOf(r)}/`));
        if (w.deployedFails.has(rid)) throw new Error('answered 503');
        return spliceBundle(html[rid], w.deployed[rid], rid);
      },
    },
  };
  return w;
}
const state = (w, rid) => clone(w.deps.db.data.form_rebake && w.deps.db.data.form_rebake[rid]);

(async () => {
  // ── 1. hooks are credentials: exact shape only; a bad config never echoes a url ──
  {
    const good = FR.parseHooks(HOOKS);
    assert.deepStrictEqual(good.hooks, HOOK); assert.deepStrictEqual(good.bad, []); assert.strictEqual(good.configured, true);
    for (const v of [undefined, '', '   ']) assert.deepStrictEqual(FR.parseHooks(v), { configured: false, hooks: {}, bad: [], fingerprint: null });
    const BAD = [`http://api.netlify.com/build_hooks/${'a'.repeat(24)}`, `https://api.netlify.com.evil.test/build_hooks/${'a'.repeat(24)}`,
      `https://api.netlify.com:444/build_hooks/${'a'.repeat(24)}`, `https://api.netlify.com/build_hooks/${'a'.repeat(24)}?trigger_branch=x`,
      `https://api.netlify.com/build_hooks/${'a'.repeat(23)}`, `https://api.netlify.com/build_hooks/${'A'.repeat(24)}`, `https://api.netlify.com/build_hooks/${'a'.repeat(24)}/`,
      `https://u:p@api.netlify.com/build_hooks/${'a'.repeat(24)}`, `https://api.netlify.com/build_hooks/${'a'.repeat(24)}#x`, 7, null];
    for (const url of BAD) {
      const p = FR.parseHooks(JSON.stringify({ x_pizza: url }));
      assert.deepStrictEqual([p.hooks, p.bad], [{}, ['x_pizza']], `refused: ${String(url)}`);
    }
    assert.deepStrictEqual(FR.parseHooks('{not json').bad, ['*']); assert.deepStrictEqual(FR.parseHooks('[1]').bad, ['*']);
    assert.deepStrictEqual(FR.parseHooks(JSON.stringify({ 'Bad Rid': HOOK.x_pizza })).bad, ['*']);
    assert.ok(!JSON.stringify(FR.parseHooks(JSON.stringify({ x_pizza: BAD[1] }))).includes('evil'), 'a refused url is not carried');
    ok(`hooks: only https://api.netlify.com/build_hooks/<24 lowercase hex> exactly; ${BAD.length} near-misses (scheme, host, port, query, length, case, slash, credentials, fragment, type) refused; bad JSON / non-object / bad rid → '*'; unset → dormant`);
  }

  // ── 2. the trigger: a mirror write POSTs the hook once per cooldown; duplicate events collapse ──
  {
    const w = world();
    const r1 = await FR.onMirrorWrite('la_musa', w.deps);
    assert.deepStrictEqual(r1, { posted: true, class: 'ok', attempts: 1 }); assert.deepStrictEqual(w.posts, [HOOK.la_musa]);
    for (let i = 0; i < 4; i += 1) assert.strictEqual((await FR.onMirrorWrite('la_musa', w.deps)).reason, 'cooldown');
    assert.strictEqual(w.posts.length, 1, 'duplicate mirror events: one POST per cooldown');
    w.t += FR.COOLDOWN_MS - 1; assert.strictEqual((await FR.onMirrorWrite('la_musa', w.deps)).reason, 'cooldown');
    w.t += 1; assert.strictEqual((await FR.onMirrorWrite('la_musa', w.deps)).posted, true);
    assert.deepStrictEqual(w.posts, [HOOK.la_musa, HOOK.la_musa]);
    assert.strictEqual((await FR.onMirrorWrite('x_pizza', w.deps)).posted, true, 'cooldowns are per rid');
    assert.strictEqual(state(w, 'la_musa').last_class, 'ok');
    ok('trigger: a mirror write POSTs that rid\'s hook (no body, its own branch); 5 events in the cooldown → 1 POST; the next after exactly 15 min; per rid');
  }

  // ── 3. DORMANT until configured: no reads, no requests, no alarms ──
  {
    const w = world({ env: {} });
    let reads = 0; w.deps.readPublished = async () => { reads += 1; return {}; };
    assert.deepStrictEqual(await FR.onMirrorWrite('x_pizza', w.deps), { posted: false, reason: 'dormant' });
    assert.deepStrictEqual(await FR.reconcile(w.deps), { dormant: true, results: [] });
    assert.deepStrictEqual([w.posts.length, w.gets.length, reads, w.alarms.length], [0, 0, 0, 0]);
    ok('unset FORM_BUILD_HOOKS (rollout steps 1–3): the trigger and the reconciler are dormant — no read, no request, no alarm');
  }

  // ── 4. a missing hook or a bad config alarms ONCE per configuration and makes no request ──
  {
    const w = world({ env: { FORM_BUILD_HOOKS: JSON.stringify({ x_pizza: HOOK.x_pizza }) } });
    for (let i = 0; i < 3; i += 1) assert.strictEqual((await FR.onMirrorWrite('la_musa', w.deps)).reason, 'no_hook');
    assert.deepStrictEqual(w.alarms, [{ kind: 'form_rebake_missing_hook', detail: { rid: 'la_musa' } }]);
    w.deps.env = { FORM_BUILD_HOOKS: JSON.stringify({ x_pizza: HOOK.x_pizza, la_musa: 'https://example.test/hook' }) };
    await FR.onMirrorWrite('la_musa', w.deps); await FR.onMirrorWrite('la_musa', w.deps);
    assert.deepStrictEqual(w.alarms[1], { kind: 'form_rebake_bad_hook', detail: { rid: 'la_musa' } }, 'a changed (bad) config alarms again, once');
    assert.strictEqual(w.alarms.length, 2);
    w.deps.env = { FORM_BUILD_HOOKS: '{oops' };
    await FR.onMirrorWrite('x_pizza', w.deps);
    assert.deepStrictEqual(w.alarms[2], { kind: 'form_rebake_bad_hook', detail: { rid: 'x_pizza' } });
    assert.strictEqual(w.posts.length, 0, 'no request on a missing or bad hook');
    ok('missing hook → form_rebake_missing_hook {rid}, bad url / unparseable config → form_rebake_bad_hook {rid}: once per configuration, no request');
  }

  // ── 5. the reconciler: converged = quiet; a publish whose mirror never fired is caught; failures retried after the cooldown ──
  {
    const w = world();
    let r = await FR.reconcile(w.deps);
    assert.deepStrictEqual(r.results.map((x) => [x.rid, x.decision]), [['la_musa', 'converged'], ['x_pizza', 'converged']], 'synthetic_3 (no orders site) skipped');
    assert.strictEqual(w.posts.length, 0); assert.strictEqual(w.alarms.length, 0);
    assert.ok(w.gets.every((g) => /\?_reconcile=\d+$/.test(g.url) && g.cc === 'no-cache'), 'the deployed read is fresh');
    // a publish lands and NO mirror event follows: the deployed form is now stale
    w.published.x_pizza.dishes[0].price += 10;
    w.hookStatus = 500;                                                 // and the hook fails
    r = await FR.reconcile(w.deps);
    const xr = r.results.find((x) => x.rid === 'x_pizza');
    assert.deepStrictEqual([xr.decision, xr.attempts, xr.class], ['post', 1, 'hook_rejected']);
    assert.deepStrictEqual(w.posts, [HOOK.x_pizza]);
    w.t += 10 * MIN; r = await FR.reconcile(w.deps);
    assert.strictEqual(r.results.find((x) => x.rid === 'x_pizza').decision, 'cooldown', 'not retried inside the cooldown');
    w.hookStatus = 'throw'; w.t += 5 * MIN; r = await FR.reconcile(w.deps);
    assert.deepStrictEqual(['post', 2, 'hook_unreachable'], ['decision', 'attempts', 'class'].map((k) => r.results.find((x) => x.rid === 'x_pizza')[k]));
    assert.strictEqual(state(w, 'x_pizza').last_class, 'hook_unreachable');
    // the build lands: deployed == published → converged, the retries re-armed
    w.deployed.x_pizza = clone(w.published.x_pizza); w.t += 15 * MIN; r = await FR.reconcile(w.deps);
    assert.strictEqual(r.results.find((x) => x.rid === 'x_pizza').decision, 'converged');
    assert.deepStrictEqual([state(w, 'x_pizza').attempts, state(w, 'x_pizza').stuck], [0, false]);
    ok('reconciler: converged → quiet (no POST, fresh deployed read); a publish with NO mirror event is caught and its hook POSTed; a rejected / unreachable hook is retried only after the cooldown; convergence resets the count');
  }

  // ── 6. accepted, but the deployed bundle stays stale: 3 attempts → form_rebake_stuck → silence → re-armed by a new publish ──
  {
    const w = world();
    w.published.la_musa.dishes[0].price += 5;
    const run = async () => (await FR.reconcile(w.deps)).results.find((x) => x.rid === 'la_musa');
    for (let i = 1; i <= 3; i += 1) { const r = await run(); assert.deepStrictEqual([r.decision, r.attempts], ['post', i]); w.t += FR.COOLDOWN_MS; }
    let r = await run();
    assert.deepStrictEqual([r.decision, r.attempts], ['stuck', 3]);
    assert.deepStrictEqual(w.alarms, [{ kind: 'form_rebake_stuck', detail: { rid: 'la_musa', attempts: 3 } }]);
    for (let i = 0; i < 4; i += 1) { w.t += FR.COOLDOWN_MS; r = await run(); assert.strictEqual(r.decision, 'stuck_silent'); }
    assert.strictEqual(w.posts.length, 3); assert.strictEqual(w.alarms.length, 1, 'silent until the published menu changes');
    w.published.la_musa.dishes[1].price += 5; w.t += FR.COOLDOWN_MS;
    r = await run(); assert.deepStrictEqual([r.decision, r.attempts], ['post', 1], 'a NEW published menu re-arms the retries');
    ok('a hook accepted while the deployed bundle stays stale: 3 POSTs (one per cooldown), then ONE form_rebake_stuck {rid, attempts: 3}, then silence; a new published menu re-arms');
  }

  // ── 7. unreadable published / deployed: nothing POSTed; 8. no url ever reaches a log or an alarm ──
  {
    const w = world();
    w.published.x_pizza.dishes[0].price += 1; w.published.la_musa.dishes[0].price += 1;
    w.readFails.add('x_pizza'); w.deployedFails.add('la_musa');
    const r = await FR.reconcile(w.deps);
    assert.deepStrictEqual(r.results.map((x) => x.decision), ['deployed_unreadable', 'published_unreadable']);
    assert.strictEqual(w.posts.length, 0);
    ok('an unreadable published menu or deployed form: logged, nothing POSTed');

    const all = world({ env: { FORM_BUILD_HOOKS: JSON.stringify({ x_pizza: HOOK.x_pizza, la_musa: 'https://api.netlify.com/build_hooks/zz' }) } });
    all.published.x_pizza.dishes[0].price += 1; all.hookStatus = 'throw';
    await FR.reconcile(all.deps); await FR.onMirrorWrite('la_musa', all.deps);
    const blob = JSON.stringify([all.logs, all.alarms, all.deps.db.data]);
    for (const secret of ['build_hooks', 'a1a1a1', 'api.netlify.com']) assert.ok(!blob.includes(secret), `🔴 "${secret}" leaked into a log, alarm or the bookkeeping`);
    assert.ok(all.logs.some((l) => /form_rebake_hook \{"rid":"x_pizza","class":"hook_unreachable"\}/.test(l)), 'errors carry the rid and the class only');
    ok('no hook url ever reaches a log line, an alarm or form_rebake/{rid} — only the rid and the class');
  }

  // ── 9. a PUBLISHED-ONLY addition (the live check's WARN, not a FAIL) is still a stale deploy: it is rebuilt ──
  {
    const w = world();
    const extra = { ...clone(w.published.x_pizza.dishes[0]), id: 999, name: 'Nueva' };
    w.published.x_pizza.dishes.push(extra);
    const r = (await FR.reconcile(w.deps)).results.find((x) => x.rid === 'x_pizza');
    assert.deepStrictEqual([r.decision, r.attempts], ['post', 1], 'a dish only the published menu has must reach the deployed form');
    ok('a published-only addition (a WARN for the build check) still counts as stale here: the hook is POSTed');
  }

  // ── 10. ONE BUDGET (Codex r1 #4): trigger + reconcile interleaved spend ≤ MAX_ATTEMPTS POSTs per published version, then
  //        ONE stuck alarm and silence from BOTH entry points; a NEW published version re-arms both ──
  {
    const w = world();
    w.published.x_pizza.dishes[0].price += 3;                                  // published; the deploy stays stale
    const T = () => FR.onMirrorWrite('x_pizza', w.deps);
    const R = async () => (await FR.reconcile(w.deps)).results.find((x) => x.rid === 'x_pizza');
    const seq = [];
    seq.push((await T()).posted);                       w.t += FR.COOLDOWN_MS;   // trigger: attempt 1
    seq.push((await R()).decision);                     w.t += FR.COOLDOWN_MS;   // reconcile: attempt 2
    seq.push((await T()).posted);                       w.t += FR.COOLDOWN_MS;   // trigger: attempt 3
    seq.push((await R()).decision);                     w.t += FR.COOLDOWN_MS;   // reconcile: budget spent → stuck
    seq.push((await T()).reason);                       w.t += FR.COOLDOWN_MS;   // an UNCHANGED mirror event → silent
    seq.push((await R()).decision);
    assert.deepStrictEqual(seq, [true, 'post', true, 'stuck', 'stuck_silent', 'stuck_silent']);
    assert.strictEqual(w.posts.length, FR.MAX_ATTEMPTS, `🔴 trigger + reconcile together POSTed ${w.posts.length} times for one version`);
    assert.deepStrictEqual(w.alarms, [{ kind: 'form_rebake_stuck', detail: { rid: 'x_pizza', attempts: FR.MAX_ATTEMPTS } }]);
    // inside the cooldown the trigger also waits for a reconciler POST (and vice versa)
    const w2 = world(); w2.published.x_pizza.dishes[0].price += 1;
    await FR.reconcile(w2.deps); assert.strictEqual((await FR.onMirrorWrite('x_pizza', w2.deps)).reason, 'cooldown', 'one cooldown across both entry points');
    // a NEW published version re-arms
    w.published.x_pizza.dishes[1].price += 3; w.t += FR.COOLDOWN_MS;
    const re = await T();
    assert.deepStrictEqual([re.posted, re.attempts], [true, 1], 'a new published version re-arms the trigger');
    // and an unreadable published menu never spends from the budget
    const w3 = world(); w3.readFails.add('x_pizza');
    assert.strictEqual((await FR.onMirrorWrite('x_pizza', w3.deps)).reason, 'published_unreadable'); assert.strictEqual(w3.posts.length, 0);
    ok(`one budget: trigger + reconcile interleaved → ${FR.MAX_ATTEMPTS} POSTs, ONE form_rebake_stuck, then no POST from either (incl. an unchanged mirror event); one cooldown across both; a new version re-arms; an unreadable published menu spends nothing`);
  }

  FINISHED = true;
  console.log(`\nform-rebake: OK (${n})`);
})().catch((e) => { console.error('form-rebake: FAILED', e); process.exit(1); });
