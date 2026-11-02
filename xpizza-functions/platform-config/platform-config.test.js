'use strict';
// CONVERGENCE §1 (NOTE-convergence-server-lane-build + rulings 2026-11-02) — the CONFIG PLANE: the portal source store
// (Firestore restaurants/{rid}/meta/platform_source, via the ONE shared writer) → the generator (the projection's ONLY writer) →
// the server-only RTDB projection restaurants/{rid}/platform_config → the monotonic reader (LKG within a TTL, then closed) → the
// drift check. NO consumer is switched over here (rows 2.1+ after step 0).
//   1 the schema is strict; 2 the both-brands GOLDEN — the legacy seed equals TODAY's code constants field by field (and a 3rd restaurant
//   has none); 3 the source writer's CAS; 4 the generator (monotonic, conflict-refusing, never undefined); 5 the reader (monotonic,
//   LKG within TTL then closed, absent ≠ outage, malformed = outage, requireFresh for money / fiscal); 6 drift states; 7 a synthetic
//   3rd restaurant end to end through the real writer + generator + reader.
// Run: node platform-config/platform-config.test.js
const assert = require('assert');
const S = require('./schema');
const SRC = require('./source');
const G = require('./generate');
const R = require('./reader');
const D = require('./drift');
const L = require('./legacy-seed');
const { makeDb: makeFs } = require('../catalog/firestore-fake');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 platform-config: FAILED — exited without completing\n'); process.exitCode = 1; } });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function fakeRtdb() {
  const tree = {}; let failReads = false;
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  // AS STRICT AS RTDB (Codex run 5 P1 — the old fake kept them): a null leaf, an empty object and an EMPTY ARRAY are not stored —
  // the node simply has no such child; a value that prunes to nothing deletes the path
  const prune = (v) => { if (v === null || v === undefined) return undefined; if (typeof v !== 'object') return v;
    if (Array.isArray(v)) { const a = v.map(prune).filter((x) => x !== undefined); return a.length ? a : undefined; }
    const o = {}; for (const [k, x] of Object.entries(v)) { const q = prune(x); if (q !== undefined) o[k] = q; } return Object.keys(o).length ? o : undefined; };
  const set = (p, v) => { const ks = parts(p); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } const q = prune(clone(v)); if (q === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = q; };
  const snap = (v) => ({ exists: () => v != null, val: () => (v == null ? null : clone(v)) });
  const ref = (p) => ({
    once: async () => { if (failReads) throw new Error('rtdb down'); return snap(get(p)); },
    set: async (v) => set(p, v),
    // the Admin SDK: the updater runs FIRST on null; undefined there aborts with no round-trip; then on the actual value
    transaction: async (fn) => {
      const actual = clone(get(p)) ?? null;
      let next = fn(null);
      if (next === undefined) return { committed: false, snapshot: snap(get(p)) };
      if (actual !== null) { next = fn(actual); if (next === undefined) return { committed: false, snapshot: snap(get(p)) }; }
      set(p, next); return { committed: true, snapshot: snap(get(p)) };
    },
  });
  return { tree, get, set, ref, outage: (v) => { failReads = v; } };
}
const X = L.legacyFieldsFor('x_pizza'), M = L.legacyFieldsFor('la_musa');
const THIRD = { whatsapp_copy: { items_emoji: '🌮', ready_line: '¡Tu pedido está listo! 🌮', ack_emoji: '' }, rewards: null, ready_time: { cold_start_min: 25, has_items_schema: false } };

(async () => {
  // ── 1. the schema: strict ──
  {
    for (const f of [X, M, THIRD]) assert.deepStrictEqual(S.validateFields(f), f, "platform-config L55: S.validateFields(f)");
    const mut = (fn) => { const c = clone(X); fn(c); return c; };
    for (const [why, f] of [['an unknown section', mut((c) => { c.factura_mode = 'platform'; })], ['a missing section', mut((c) => { delete c.ready_time; })],
      ['an unknown field', mut((c) => { c.whatsapp_copy.token = 'x'; })], ['markup in copy', mut((c) => { c.whatsapp_copy.ready_line = '<b>x</b>'; })],
      ['a non-integer cold start', mut((c) => { c.ready_time.cold_start_min = 18.5; })], ['earn ≠ redemption kind', mut((c) => { c.rewards.redemption = clone(M.rewards.redemption); })],
      ['a float rate', (() => { const c = clone(M); c.rewards.redemption.rate = { points: 3.3333, per_lempiras: 1 }; return c; })()],
      ['a bad exclude glob', (() => { const c = clone(M); c.rewards.redemption.exclude = ['*']; return c; })()], ['a string boolean', mut((c) => { c.ready_time.has_items_schema = 'true'; })],
      ['not an object', 'x'], ['null', null]])
      assert.throws(() => S.validateFields(f), /platform_config_invalid/, `🔴 ${why} refused`);
  }
  ok('the schema: exactly the three v1 sections, every field typed and bounded; an unknown section / field, markup, a non-integer, a float rate, a bad glob, earn ≠ redemption kind ⇒ refused');

  // ── 2. the both-brands GOLDEN: the legacy seed IS today's code behaviour ──
  {
    const W = require('../whatsapp'), WI = require('../whatsapp_inbound'), RC = require('../rewards-core'), RD = require('../rewards-redeem-config'), RT = require('../ready-time-predict');
    for (const [rid, f] of [['x_pizza', X], ['la_musa', M]]) {
      assert.strictEqual(f.whatsapp_copy.items_emoji, W.itemsEmojiFor(rid), "platform-config L71: f.whatsapp_copy.items_emoji"); assert.strictEqual(f.whatsapp_copy.ready_line, W.readyLineFor(rid), "platform-config L71: f.whatsapp_copy.ready_line");
      assert.strictEqual(f.whatsapp_copy.ack_emoji, WI.configFor(rid).ackEmoji, "platform-config L72: f.whatsapp_copy.ack_emoji");
      const rc = RC.REWARDS_CONFIG[rid], rd = RD.REDEMPTION_CONFIG[rid];
      assert.strictEqual(f.rewards.welcome, rc.welcome, "platform-config L74: f.rewards.welcome"); assert.strictEqual(f.rewards.goal, rc.goal, "platform-config L74: f.rewards.goal"); assert.strictEqual(f.rewards.earn.kind, rc.kind, "platform-config L74: f.rewards.earn.kind");
      if (rc.kind === 'points') { assert.strictEqual(f.rewards.earn.points_per, rc.pointsPer, "platform-config L75: f.rewards.earn.points_per"); assert.strictEqual(f.rewards.earn.per_cents, rc.perCents, "platform-config L75: f.rewards.earn.per_cents"); }
      assert.strictEqual(f.rewards.redemption.kind, rd.kind, "platform-config L76: f.rewards.redemption.kind"); assert.strictEqual(f.rewards.redemption.reward, rd.reward, "platform-config L76: f.rewards.redemption.reward");
      if (rd.kind === 'punch') assert.strictEqual(f.rewards.redemption.cost, rd.cost, "platform-config L77: f.rewards.redemption.cost");
      else { assert.strictEqual(f.rewards.redemption.rate.points / f.rewards.redemption.rate.per_lempiras, rd.rate, '🔴 the exact ratio equals the code rate'); assert.deepStrictEqual(f.rewards.redemption.exclude, rd.exclude, "platform-config L78: f.rewards.redemption.exclude"); }
      assert.strictEqual(f.ready_time.cold_start_min, RT.coldStartMin(rid), "platform-config L79: f.ready_time.cold_start_min");
    }
    assert.strictEqual(X.ready_time.has_items_schema, true, "platform-config L81: X.ready_time.has_items_schema"); assert.strictEqual(M.ready_time.has_items_schema, false, 'only x_pizza walks the model rings today');
    for (const r of ['tb_tercera', 'unknown', '']) assert.strictEqual(L.legacyFieldsFor(r), null, '🔴 no legacy seed for any other restaurant — portal-authored only');
  }
  ok('the both-brands GOLDEN: every x_pizza / la_musa field equals the code constant its consumer reads today (WhatsApp copy, rewards earn + redemption incl. the exact 10/3 ratio, the cold start, the model gate); any other restaurant has NO legacy seed');

  // ── 3. the ONE source writer: validated, CAS on version ──
  {
    const fs = makeFs();
    assert.deepStrictEqual(await SRC.writePlatformSource(fs, 'x_pizza', X, { expectedVersion: null, by: 'owner', now: 1 }), { version: 1 }, "platform-config L89: await SRC.writePlatformSource(fs, x_pizza, X, { expectedVersion: null, by: owner");
    await assert.rejects(() => SRC.writePlatformSource(fs, 'x_pizza', X, { expectedVersion: null, by: 'owner' }), /platform_source_conflict/, '🔴 a create over an existing source ⇒ conflict');
    await assert.rejects(() => SRC.writePlatformSource(fs, 'x_pizza', X, { expectedVersion: 7, by: 'owner' }), /platform_source_conflict/, 'a stale expected version ⇒ conflict');
    await assert.rejects(() => SRC.writePlatformSource(fs, 'x_pizza', { ...X, extra: 1 }, { expectedVersion: 1, by: 'owner' }), /platform_config_invalid/, "platform-config L92: () => SRC.writePlatformSource(fs, x_pizza, { ...X, extra: 1 }, { expectedVersion");
    await assert.rejects(() => SRC.writePlatformSource(fs, 'x_pizza', X, { expectedVersion: 1 }), /author required/, "platform-config L93: () => SRC.writePlatformSource(fs, x_pizza, X, { expectedVersion: 1 })");
    await assert.rejects(() => SRC.writePlatformSource(fs, '../x', X, { expectedVersion: null, by: 'o' }), /bad restaurant id/, "platform-config L94: () => SRC.writePlatformSource(fs, ../x, X, { expectedVersion: null, by: o })");
    assert.strictEqual((await SRC.readPlatformSource(fs, 'x_pizza')).version, 1, 'nothing written by a refusal');
    assert.deepStrictEqual(await SRC.writePlatformSource(fs, 'x_pizza', { ...X, ready_time: { cold_start_min: 19, has_items_schema: true } }, { expectedVersion: 1, by: 'owner' }), { version: 2 }, "platform-config L96: await SRC.writePlatformSource(fs, x_pizza, { ...X, ready_time: { cold_start_min:");
    assert.strictEqual(await SRC.readPlatformSource(fs, 'nobody'), null, "platform-config L97: await SRC.readPlatformSource(fs, nobody)");
  }
  ok('the source writer: every field validated BEFORE the write; a compare-and-set on version (create ⇔ null; stale ⇒ conflict); an author required; version + 1 per accepted write');

  // ── 4. the generator: the ONLY writer, monotonic, conflict-refusing ──
  {
    const fs = makeFs(); const db = fakeRtdb();
    assert.deepStrictEqual(await G.generatePlatformConfig({ fs, db, now: 5 }, 'x_pizza'), { rid: 'x_pizza', outcome: 'no_source' }, "platform-config L104: await G.generatePlatformConfig({ fs, db, now: 5 }, x_pizza)");
    await SRC.writePlatformSource(fs, 'x_pizza', X, { expectedVersion: null, by: 'o' });
    assert.strictEqual((await G.generatePlatformConfig({ fs, db, now: 5 }, 'x_pizza')).outcome, 'written', "platform-config L106: (await G.generatePlatformConfig({ fs, db, now: 5 }, x_pizza)).outcome");
    assert.deepStrictEqual(db.get('restaurants/x_pizza/platform_config'), { schema_version: 1, source_version: 1, generated_at: 5, fields: require('./rtdb-encoding').encodeFields(X) }, 'stored in the RTDB wire form');
    assert.strictEqual((await G.generatePlatformConfig({ fs, db, now: 9 }, 'x_pizza')).outcome, 'unchanged', "platform-config L108: (await G.generatePlatformConfig({ fs, db, now: 9 }, x_pizza)).outcome");
    assert.strictEqual(db.get('restaurants/x_pizza/platform_config').generated_at, 5, 'an unchanged run rewrites nothing');
    await SRC.writePlatformSource(fs, 'x_pizza', { ...X, ready_time: { cold_start_min: 19, has_items_schema: true } }, { expectedVersion: 1, by: 'o' });
    assert.strictEqual((await G.generatePlatformConfig({ fs, db, now: 10 }, 'x_pizza')).outcome, 'written', "platform-config L111: (await G.generatePlatformConfig({ fs, db, now: 10 }, x_pizza)).outcome");
    assert.strictEqual(db.get('restaurants/x_pizza/platform_config').source_version, 2, "platform-config L112: db.get(restaurants/x_pizza/platform_config).source_version");
    // a projection AHEAD of its source (written outside the generator) is never moved backwards
    db.set('restaurants/x_pizza/platform_config/source_version', 9);
    assert.strictEqual((await G.generatePlatformConfig({ fs, db, now: 11 }, 'x_pizza')).outcome, 'stale_refused', '🔴 never a downgrade');
    // the same version with different fields ⇒ conflict, refused
    db.set('restaurants/x_pizza/platform_config/source_version', 2); db.set('restaurants/x_pizza/platform_config/fields/ready_time/cold_start_min', 99);
    assert.strictEqual((await G.generatePlatformConfig({ fs, db, now: 12 }, 'x_pizza')).outcome, 'conflict', "platform-config L118: (await G.generatePlatformConfig({ fs, db, now: 12 }, x_pizza)).outcome");
    assert.strictEqual(db.get('restaurants/x_pizza/platform_config/fields/ready_time/cold_start_min'), 99, 'a conflict is reported, never silently overwritten');
    // a malformed source throws — nothing projected
    await fs.collection('restaurants').doc('la_musa').collection('meta').doc('platform_source').set({ schema_version: 1, version: 1, fields: { ...M, junk: 1 } });
    await assert.rejects(() => G.generatePlatformConfig({ fs, db }, 'la_musa'), /platform_config_invalid/, "platform-config L122: () => G.generatePlatformConfig({ fs, db }, la_musa)");
    assert.strictEqual(db.get('restaurants/la_musa/platform_config'), undefined, '🔴 a malformed source is never projected');
    // the updater never returns undefined (the Admin first-run-on-null rule)
    for (const raw of [null, { source_version: 1, fields: X, schema_version: 1 }, { source_version: 5 }]) assert.notStrictEqual(G.projectionUpdater({ source_version: 2, fields: X, schema_version: 1 }, {})(raw), undefined, "platform-config L125: G.projectionUpdater({ source_version: 2, fields: X, schema_version: 1 }, {})(raw");
  }
  ok('the generator: no source ⇒ nothing; written / unchanged (no rewrite) / a newer source replaces; a projection ahead is never downgraded; same version + different fields ⇒ conflict (reported, not overwritten); a malformed source is never projected; never undefined');

  // ── 5. the reader: monotonic; LKG within the TTL, then closed; absent ≠ outage ──
  {
    const fs = makeFs(); const db = fakeRtdb(); let t = 1000;
    const rd = R.createPlatformConfigReader({ now: () => t, ttlMs: 600 });
    assert.deepStrictEqual(await rd.read(db, 'x_pizza'), { ok: false, reason: 'absent' }, 'absent is a confident answer');
    await SRC.writePlatformSource(fs, 'x_pizza', X, { expectedVersion: null, by: 'o' }); await G.generatePlatformConfig({ fs, db }, 'x_pizza');
    const a = await rd.read(db, 'x_pizza'); assert.ok(a.ok && a.fresh && a.source_version === 1, "platform-config L135: a.ok && a.fresh && a.source_version === 1"); assert.deepStrictEqual(a.fields, X, "platform-config L135: a.fields");
    db.outage(true); t = 1500;
    const b = await rd.read(db, 'x_pizza'); assert.ok(b.ok && !b.fresh && b.age_ms === 500, '🔴 an outage within the TTL ⇒ last-known-good');
    assert.deepStrictEqual(R.requireFresh(b), { ok: false, reason: 'not_fresh' }, '🔴 money / fiscal never accept LKG');
    t = 1601; assert.deepStrictEqual(await rd.read(db, 'x_pizza'), { ok: false, reason: 'unavailable' }, '🔴 past the TTL ⇒ CLOSED');
    db.outage(false); t = 2000;
    await SRC.writePlatformSource(fs, 'x_pizza', { ...X, ready_time: { cold_start_min: 21, has_items_schema: true } }, { expectedVersion: 1, by: 'o' }); await G.generatePlatformConfig({ fs, db }, 'x_pizza');
    assert.strictEqual((await rd.read(db, 'x_pizza')).source_version, 2, "platform-config L142: (await rd.read(db, x_pizza)).source_version");
    db.set('restaurants/x_pizza/platform_config/source_version', 1);                                   // an OLDER projection appears
    const c = await rd.read(db, 'x_pizza'); assert.ok(c.ok && !c.fresh && c.source_version === 2, '🔴 an older version is rejected — the accepted one is kept');
    db.set('restaurants/x_pizza/platform_config/source_version', 2); db.set('restaurants/x_pizza/platform_config/fields/ready_time/cold_start_min', 'x');
    const d = await rd.read(db, 'x_pizza'); assert.ok(d.ok && !d.fresh, 'a malformed projection is an outage (LKG), never trusted');
    const cold = R.createPlatformConfigReader({ now: () => t });
    assert.deepStrictEqual(await cold.read(db, 'x_pizza'), { ok: false, reason: 'unavailable' }, 'a cold instance with a malformed projection ⇒ closed');
  }
  ok('the reader: absent is confident; an outage or a malformed projection ⇒ LKG within the TTL, then CLOSED; an older source_version is rejected (no downgrade); requireFresh refuses LKG for money / fiscal');

  // ── 6. drift ──
  {
    const fs = makeFs(); const db = fakeRtdb(); const st = async (r) => (await D.checkDrift({ fs, db }, r)).state;
    assert.strictEqual(await st('x_pizza'), 'unconfigured', "platform-config L155: await st(x_pizza)");
    await SRC.writePlatformSource(fs, 'x_pizza', X, { expectedVersion: null, by: 'o' });
    assert.strictEqual(await st('x_pizza'), 'not_projected', "platform-config L157: await st(x_pizza)");
    await G.generatePlatformConfig({ fs, db }, 'x_pizza'); assert.strictEqual(await st('x_pizza'), 'in_sync', "platform-config L158: await st(x_pizza)");
    await SRC.writePlatformSource(fs, 'x_pizza', { ...X, rewards: null }, { expectedVersion: 1, by: 'o' }); assert.strictEqual(await st('x_pizza'), 'behind', "platform-config L159: await st(x_pizza)");
    await G.generatePlatformConfig({ fs, db }, 'x_pizza'); db.set('restaurants/x_pizza/platform_config/fields/rewards', { forged: 1 });
    assert.strictEqual(await st('x_pizza'), 'drift', '🔴 a hand-edited projection is DRIFT');
    db.set('restaurants/la_musa/platform_config', { source_version: 1 }); assert.strictEqual(await st('la_musa'), 'orphan_projection', "platform-config L162: await st(la_musa)");
    const out = JSON.stringify(await D.checkDrift({ fs, db }, 'x_pizza'));
    assert.ok(!/🍕|free_pizza|cold_start/.test(out), 'names and states only — no field value');
  }
  ok('drift: unconfigured / not_projected / in_sync / behind / drift (a hand edit) / orphan_projection — names and states only');

  // ── 7. a synthetic 3rd restaurant, end to end through the REAL writer + generator + reader ──
  {
    const fs = makeFs(); const db = fakeRtdb();
    for (const [rid, f] of [['x_pizza', X], ['la_musa', M], ['tb_tercera', THIRD]]) { await SRC.writePlatformSource(fs, rid, f, { expectedVersion: null, by: 'portal:ownerTB' }); await G.generatePlatformConfig({ fs, db }, rid); }
    const rd = R.createPlatformConfigReader();
    const r3 = await rd.read(db, 'tb_tercera');
    assert.ok(r3.ok && r3.fresh, "platform-config L174: r3.ok && r3.fresh"); assert.deepStrictEqual(r3.fields, THIRD, 'its own copy, no rewards, its own cold start');
    assert.deepStrictEqual((await rd.read(db, 'x_pizza')).fields, X, "platform-config L175: (await rd.read(db, x_pizza)).fields"); assert.deepStrictEqual((await rd.read(db, 'la_musa')).fields, M, 'the founding projections are untouched by the 3rd');
    for (const r of ['x_pizza', 'la_musa', 'tb_tercera']) assert.strictEqual((await D.checkDrift({ fs, db }, r)).state, 'in_sync', "platform-config L176: (await D.checkDrift({ fs, db }, r)).state");
  }
  ok('a synthetic 3rd restaurant: portal-authored through the ONE source writer → generated → read fresh with ITS OWN fields; both founding projections untouched; all three in sync');

  // ── 9. Codex run 5 P1: the RTDB-safe encoding — `rewards: null` and `exclude: []` survive a REAL-RTDB round trip (this fake drops them) ──
  {
    const E = require('./rtdb-encoding');
    const EMPTY_EXCL = clone(M); EMPTY_EXCL.rewards.redemption.exclude = [];
    for (const f of [X, M, THIRD, EMPTY_EXCL]) assert.deepStrictEqual(E.decodeFields(E.encodeFields(f)), f, 'decode(encode(f)) === f');
    const fs = makeFs(); const db = fakeRtdb();
    for (const [rid, f] of [['tb_tercera', THIRD], ['la_musa', EMPTY_EXCL]]) {
      await SRC.writePlatformSource(fs, rid, f, { expectedVersion: null, by: 'o' });
      assert.strictEqual((await G.generatePlatformConfig({ fs, db }, rid)).outcome, 'written', "platform-config L188: (await G.generatePlatformConfig({ fs, db }, rid)).outcome");
      const stored = db.get(`restaurants/${rid}/platform_config/fields`);
      assert.ok(rid === 'tb_tercera' ? !('rewards' in stored) : !('exclude' in stored.rewards.redemption), `premise: RTDB dropped the empty value (${rid})`);
      const r = await R.createPlatformConfigReader().read(db, rid);
      assert.ok(r.ok && r.fresh, `🔴 ${rid}: the reader restores the empty value (not 'unavailable')`); assert.deepStrictEqual(r.fields, f, "platform-config L192: r.fields");
      assert.strictEqual((await G.generatePlatformConfig({ fs, db }, rid)).outcome, 'unchanged', `🔴 ${rid}: a regen is 'unchanged', not 'conflict'`);
      assert.strictEqual((await D.checkDrift({ fs, db }, rid)).state, 'in_sync', `🔴 ${rid}: drift is 'in_sync', not 'drift'`);
    }
  }
  ok('Codex run 5 P1: ONE RTDB-safe encoding (rewards: null / exclude: [] omitted on the wire, restored on read) shared by generate / read / compare / drift — through an RTDB-faithful fake: the reader returns the fields, a regen is unchanged, drift is in_sync');

  // ── 8. the owner CLI core: strict arguments (no fan-out), break-glass seed never overwrites ──
  {
    const A = require('./admin-core');
    const P = (s) => A.parseArgs(s.split(' ').filter(Boolean));
    assert.deepStrictEqual(P('seed --project p --rid x_pizza'), { ok: true, sub: 'seed', rid: 'x_pizza', all: false, apply: false }, "platform-config L203: P(seed --project p --rid x_pizza)");
    assert.ok(P('drift --project p --all').ok && P('generate --project p --rid la_musa --apply').apply, "platform-config L204: P(drift --project p --all).ok && P(generate --project p --rid la_musa --apply).a");
    for (const bad of ['seed --project p --rid=x_pizza', 'seed --project p', 'generate --project p --all', 'drift --project p --all --rid x', 'drift --project p --rid x --apply',
      'seed --project p --rid', 'wipe --project p --rid x', '', 'seed --project p --rid x --force', 'seed --project=p --rid x', 'seed --project p --rid ../x'])
      assert.strictEqual(P(bad).ok, false, `🔴 refused: "${bad}"`);
    assert.match(P('seed --project p --rid=x_pizza').why, /space form/, '🔴 `--rid=` is refused BY NAME (the boundary-tool fan-out trap), not by accident');
    const fs = makeFs(); const db = fakeRtdb();
    assert.deepStrictEqual(await A.seed({ fs, apply: false }, 'x_pizza'), { rid: 'x_pizza', state: 'would_seed' }, "platform-config L210: await A.seed({ fs, apply: false }, x_pizza)");
    assert.strictEqual(await SRC.readPlatformSource(fs, 'x_pizza'), null, 'a dry run writes nothing');
    assert.deepStrictEqual(await A.seed({ fs, apply: true, now: 1 }, 'x_pizza'), { rid: 'x_pizza', state: 'seeded', version: 1 }, "platform-config L212: await A.seed({ fs, apply: true, now: 1 }, x_pizza)");
    assert.deepStrictEqual((await SRC.readPlatformSource(fs, 'x_pizza')).fields, X, 'the seed is exactly the golden');
    assert.deepStrictEqual(await A.seed({ fs, apply: true }, 'x_pizza').catch((e) => assert.fail(`🔴 the seed must REFUSE an existing source, not attempt the write: ${e.message}`)), { rid: 'x_pizza', state: 'refused_source_exists' }, '🔴 never an overwrite');
    assert.deepStrictEqual(await A.seed({ fs, apply: true }, 'tb_tercera'), { rid: 'tb_tercera', state: 'refused_no_legacy_seed' }, '🔴 no code-derived seed for a non-founding restaurant');
    assert.deepStrictEqual(await A.generate({ fs, db, apply: false }, 'x_pizza'), { rid: 'x_pizza', state: 'not_projected' }, 'a generate dry run reports, writes nothing');
    assert.strictEqual(db.get('restaurants/x_pizza/platform_config'), undefined, "platform-config L217: db.get(restaurants/x_pizza/platform_config)");
    assert.deepStrictEqual(await A.generate({ fs, db, apply: true, now: 3 }, 'x_pizza'), { rid: 'x_pizza', state: 'written', source_version: 1 }, "platform-config L218: await A.generate({ fs, db, apply: true, now: 3 }, x_pizza)");
  }
  ok('the owner CLI core: `--rid <id>` space form only (`--rid=`, a missing rid, --all outside drift, an unknown flag ⇒ refused — no fan-out); the break-glass seed is dry-run first, exactly the golden, and NEVER overwrites or seeds a non-founding restaurant');

  FINISHED = true;
  console.log(`platform-config: OK (${n})`);
})().catch((e) => { process.stderr.write(`platform-config: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
