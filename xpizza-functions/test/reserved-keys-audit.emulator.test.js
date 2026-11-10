'use strict';
// S1c (PLAN-portal-item-edit r6 §2.2 "one-time audit tool"; design D4c-grill/item-s1/S1c-DESIGN.md D5) — THE RESERVATION AUDIT.
// Rebuilds the RECOVERABLE reservations of a restaurant whose history predates the reserved-key set: every identity id row's
// legacy_key (a moved-from key is gone from it — the limit the plan states), every key row, every retained version's item and
// extra keys, and every frozen_keys entry (source and version records). The dry run reads only; the apply is one transaction that
// reads the set and writes the union (it never removes a key), behind the limit check. Run: npm run test:reserved-keys-audit
require('./_emulator-required').harness(['firestore', 'database']);
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'reserved-keys-audit-'.padEnd(48, 'x');   // the portal save signs its edit token
const assert = require('assert');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const admin = require('firebase-admin');
require('../index.js');
const db = admin.firestore();
const rtdb = admin.database();
const { fixture } = require('./_c2b-fixture');
const { sourceRefOf } = require('../catalog/source-store');
const { readActiveVersion } = require('../catalog/identity-bootstrap');
const RK = require('../catalog/reserved-keys');
const AUDIT = require('../catalog/reserved-keys-audit');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('reserved-keys-audit(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const F = fixture({ db, rtdb, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
const RID = 'tb_rk_audit';
const reservedRef = RK.reservedRefOf(db, RID);
const snapshotAll = async () => { const out = {}; for (const c of await db.listCollections()) for (const d of (await c.get()).docs) out[`${c.id}/${d.id}`] = d.updateTime.toMillis(); return out; };

(async () => {
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing: not the local Firestore emulator');
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
  await rtdb.ref().remove();

  // history: a certified merchant, a dish added and published, then dropped and published (its key row survives — the
  // consumed-deletion divergence), and a frozen entry on the source. Then the set is wiped: a restaurant from before S1c.
  await F.merchant(RID, { dishes: 3, certify: true });
  await F.addDish(RID, 'Plato Viejo'); await F.publish(RID, 'a-v2');
  const src = (await sourceRefOf(db, RID).get()).data();
  // the drop is DECLARED (identity partition), through the real portal save + publish
  const oldId = (await readActiveVersion(db, RID)).dishes.find((d) => d.data.key === 'Plato Viejo').data.display.identity_id;
  await F.portalSaveAndPublish(RID, (s, base) => ({ ...s, items: s.items.filter((i) => i.key !== 'Plato Viejo'),
    structure: { ...s.structure, item_order: s.structure.item_order.filter((k) => k !== 'Plato Viejo') },
    deleted_ids: { ids: [oldId] }, deleted_ids_loaded_base: base }), 'a-v3');
  // frozen entries are server-owned (the portal save refuses them): written to the source as the server would, then published
  await sourceRefOf(db, RID).update({ frozen_keys: { 424242: 'Clave Congelada' } });
  await F.publish(RID, 'a-v4');
  await reservedRef.delete();

  // ── dry run: reads only ──
  const before = await snapshotAll();
  const found = await AUDIT.collectRecoverable(db, RID);
  assert.deepStrictEqual(await snapshotAll(), before, 'RKA-DRY the collection writes nothing');
  const keys = new Set(found.plan.flatMap((p) => p.dish));
  for (const k of [...src.items.map((i) => i.key), 'Plato Viejo', 'Clave Congelada']) assert.ok(keys.has(k), `RKA-SOURCES ${k} is recovered`);
  for (const f of ['id_rows', 'key_rows', 'versions', 'frozen', 'distinct_keys']) assert.ok(Number.isInteger(found.counts[f]) && found.counts[f] >= 0, `RKA-COUNTS ${f}`);
  const dry = AUDIT.wouldAdd(undefined, found.plan);
  assert.ok(dry > 0, 'RKA-DRY a wiped set would gain keys');
  ok('the dry run reads only and recovers keys from every source (id rows, key rows, versions, frozen entries)');

  // ── apply: one transaction, the union, never removes ──
  await reservedRef.set({ v: 1, keys: RK.unionReserved(RK.emptyReserved(), { dish: ['Clave Externa'], extra: [] }, 'pre').doc.keys });
  const r = await AUDIT.applyRecoverable(db, RID, found.plan);
  const set = RK.reservedKeySet((await reservedRef.get()).data());
  assert.ok(set.has('Clave Externa'), 'RKA-ADDONLY a key already in the set is kept');
  for (const k of keys) assert.ok(set.has(k), `RKA-APPLY ${k} is reserved`);
  assert.strictEqual(r.added, dry, 'RKA-APPLY the apply adds what the dry run counted (the pre-existing key was not in the plan)');
  const again = await AUDIT.applyRecoverable(db, RID, found.plan);
  assert.strictEqual(again.added, 0, 'RKA-IDEMPOTENT a second apply adds nothing');
  ok('the apply writes the union in one transaction, keeps what was there, and is idempotent');

  // ── fail closed: a malformed set refuses, nothing is written ──
  await reservedRef.set({ v: 1, keys: { '***': { dish: 'x' } } });
  let err = null; try { await AUDIT.applyRecoverable(db, RID, found.plan); } catch (e) { err = e; }
  assert.ok(err && /reserved_keys_malformed/.test(err.message), 'RKA-MALFORMED refused');
  assert.deepStrictEqual((await reservedRef.get()).data(), { v: 1, keys: { '***': { dish: 'x' } } }, 'RKA-MALFORMED nothing written');
  ok('a malformed stored set refuses the apply; nothing is written');

  FINISHED = true;
  console.log(`\nreserved-keys-audit(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
