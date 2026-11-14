'use strict';
// PLAN-3a-capp-push-tokens r0 + the advisor's rulings 11-14 — marketing/push-policy: the owner-editable promo push limits, through the
// REAL writer (writePushPolicy) on the faithful RTDB double (test/_fake-rtdb-sdk, strict). Run: node marketing/push-policy.test.js
const assert = require('assert');
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');   // FAITHFUL to the Admin SDK's transactions (O1a)
const fakeDb = () => fakeRtdb({}, { strict: true });
const PP = require('./push-policy');

let n = 0; let FINISHED = false;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ push-policy: exited without completing (a hang)\n'); process.exitCode = 1; } });
const POL = (o = {}) => ({ promo_daily_max: 2, promo_weekly_max: 5, quiet_from: 1320, quiet_to: 480, ...o });

(async () => {
  try {
    // ── 1. never configured ⇒ the DEFAULTS; configured but malformed / unreadable ⇒ null (no send — Codex push r1 P2, fail closed) ──
    {
      assert.deepStrictEqual(PP.DEFAULTS, { promo_daily_max: 1, promo_weekly_max: 3, quiet_from: 1260, quiet_to: 540 }, 'the owner\'s defaults: 1/day, 3/week, quiet 21:00 → 09:00 HN');
      const db = fakeDb();
      assert.deepStrictEqual(await PP.readPushPolicy(db), PP.DEFAULTS, 'absent ⇒ DEFAULTS');
      await db.ref('platform_config/push').set('garbage');
      assert.strictEqual(await PP.readPushPolicy(db), null, 'a CONFIGURED but malformed node ⇒ null: no send (fail closed, Codex push r1)');
      const down = { ref: () => ({ once: async () => { throw new Error('rtdb unavailable'); } }) };
      assert.strictEqual(await PP.readPushPolicy(down), null, 'a read error ⇒ null: no send (fail closed)');
      ok('absent (never configured) ⇒ the DEFAULTS; malformed or unreadable ⇒ null — no send (fail closed)');
    }

    // ── 2. the REAL writer: valid policy written with a version CAS; read back exactly ──
    {
      const db = fakeDb();
      const w = await PP.writePushPolicy(db, { expected: 0, policy: POL(), actor: 'cli:op', now: 10 });
      assert.deepStrictEqual(w, { ok: true, version: 1 }, 'created at version 1');
      assert.deepStrictEqual(await PP.readPushPolicy(db), POL(), 'read back exactly');
      assert.deepStrictEqual((await PP.writePushPolicy(db, { expected: 0, policy: POL({ promo_daily_max: 3 }), actor: 'cli:op', now: 11 })).reason, 'conflict', 'a stale expected version ⇒ conflict (nothing written)');
      assert.deepStrictEqual(await PP.readPushPolicy(db), POL(), 'unchanged after the conflict');
      assert.deepStrictEqual(await PP.writePushPolicy(db, { expected: 1, policy: POL({ promo_daily_max: 3 }), actor: 'cli:op', now: 12 }), { ok: true, version: 2 });
      ok('the REAL writer: version CAS (a stale version ⇒ conflict, nothing written); a valid policy reads back exactly');
    }

    // ── 3. the bounds (APPROVED 11-14): frequency may rise within its bounds; the quiet window is MANDATORY, 6..14 h, wrap-aware ──
    {
      const db = fakeDb();
      const refused = async (p, field, label) => {
        const r = await PP.writePushPolicy(db, { expected: 0, policy: p, actor: 'cli:op', now: 1 });
        assert.deepStrictEqual([r.ok, r.field], [false, field], `${label} ⇒ refused on ${field} (${JSON.stringify(r)})`);
        assert.strictEqual(db.get('platform_config/push') ?? null, null, `${label}: nothing written`);
      };
      await refused(POL({ promo_daily_max: 4 }), 'promo_daily_max', 'daily 4 (> 3)');
      await refused(POL({ promo_daily_max: -1 }), 'promo_daily_max', 'daily -1');
      await refused(POL({ promo_daily_max: 1.5 }), 'promo_daily_max', 'a fractional daily');
      await refused(POL({ promo_weekly_max: 11 }), 'promo_weekly_max', 'weekly 11 (> 10)');
      await refused(POL({ promo_daily_max: 3, promo_weekly_max: 2 }), 'promo_weekly_max', 'weekly below daily');
      await refused(POL({ quiet_from: 600, quiet_to: 600 }), 'quiet_to', 'from === to (no quiet window)');
      await refused(POL({ quiet_from: 1260, quiet_to: 1559 }), 'quiet_to', 'a minute past 1439');
      await refused(POL({ quiet_from: 1260, quiet_to: 120 }), 'quiet_to', 'a window of 5 h (21:00 → 02:00)');
      await refused(POL({ quiet_from: 1200, quiet_to: 601 }), 'quiet_to', 'a window of 14 h 1 min (20:00 → 10:01)');
      await refused({ ...POL(), extra: 1 }, 'policy', 'an unknown field');
      await refused({ promo_daily_max: 1, promo_weekly_max: 3, quiet_from: 1260 }, 'policy', 'a missing field');
      for (const [p, label] of [[POL({ promo_daily_max: 0, promo_weekly_max: 0 }), 'promos off (0 / 0)'], [POL({ promo_daily_max: 3, promo_weekly_max: 10 }), 'the maxima (3 / 10)'],
        [POL({ quiet_from: 1260, quiet_to: 180 }), 'exactly 6 h, across midnight'], [POL({ quiet_from: 1200, quiet_to: 600 }), 'exactly 14 h (20:00 → 10:00)'], [POL({ quiet_from: 0, quiet_to: 480 }), 'a window starting at midnight']]) {
        const d2 = fakeDb();
        assert.deepStrictEqual((await PP.writePushPolicy(d2, { expected: 0, policy: p, actor: 'cli:op', now: 1 })).ok, true, `${label} ⇒ accepted`);
        assert.deepStrictEqual(await PP.readPushPolicy(d2), p, `${label}: read back`);
      }
      ok('bounds: daily 0..3, weekly 0..10 ≥ daily; the quiet window is mandatory, 6..14 h wrap-aware, integer minutes 0..1439; exact fields');
    }

    // ── 4. a stored node out of bounds (written past the setter) ⇒ null (no send), never a partial policy ──
    {
      const db = fakeDb();
      await PP.writePushPolicy(db, { expected: 0, policy: POL(), actor: 'cli:op', now: 1 });
      await db.ref('platform_config/push/quiet_to').set(1320);   // a corrupt node: from === to
      assert.strictEqual(await PP.readPushPolicy(db), null, 'a stored node failing the bounds ⇒ null: no send (fail closed), never a partial policy');
      ok('a stored node failing the bounds ⇒ null (no send), never a partial policy');
    }

    FINISHED = true;
    console.log(`push-policy: ${n}/${n} ok`);
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    process.exitCode = 1;
  }
})();
