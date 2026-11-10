'use strict';
// ---------------------------------------------------------------------------
// S1c (PLAN-portal-item-edit r6 §2.2 "one-time audit tool"; design D4c-grill/item-s1/S1c-DESIGN.md D5) — THE RESERVATION AUDIT.
// For a restaurant whose history predates the reserved-key set: rebuild the RECOVERABLE reservations from what still exists —
//   • every identity id row's legacy_key (dish and extra; retired rows included),
//   • every identity key row (its doc id is the key, base64url),
//   • every retained version's item and extra keys,
//   • every frozen_keys value, on the source and on each version record.
// It does NOT prove complete history (plan §6): a key that lived only in a pruned version and whose id row was later moved
// away, and a never-registered key of an uncertified publish later removed and pruned, are gone. Reading is separate from
// writing; the write is one transaction that reads the set and writes the union, so it never removes a key.
// ---------------------------------------------------------------------------
const RK = require('./reserved-keys');
const { idsColOf, keysColOf } = require('./identity-registry');
const { sourceRefOf } = require('./source-store');

const KINDS = ['dish', 'extra'];
const AUDIT_VERSION = 'audit';
const versionsColOf = (db, rid) => db.collection('restaurants').doc(rid).collection('versions');

function decodeKeyRow(id) {
  const key = Buffer.from(id, 'base64url').toString('utf8');
  if (!key || Buffer.from(key, 'utf8').toString('base64url') !== id) throw new Error(`reserved_keys_audit_bad_key_row: ${id}`);
  return key;
}
const stringKey = (v, where) => { if (typeof v !== 'string' || !v) throw new Error(`reserved_keys_audit_bad_key: ${where}`); return v; };
const frozenValues = (fk, where) => (fk && typeof fk === 'object' ? Object.values(fk).map((v) => stringKey(v, where)) : []);

async function collectRecoverable(db, rid) {
  const counts = { id_rows: 0, key_rows: 0, versions: 0, frozen: 0, distinct_keys: 0 };
  const registry = { dish: [], extra: [] };
  for (const kind of KINDS) {
    const [ids, keys] = await Promise.all([idsColOf(db, rid, kind).get(), keysColOf(db, rid, kind).get()]);
    for (const d of ids.docs) { registry[kind].push(stringKey((d.data() || {}).legacy_key, `ids/${kind}/${d.id}`)); counts.id_rows += 1; }
    for (const d of keys.docs) { registry[kind].push(decodeKeyRow(d.id)); counts.key_rows += 1; }
  }
  const src = await sourceRefOf(db, rid).get();
  const frozen = frozenValues(src.exists ? (src.data() || {}).frozen_keys : null, 'source.frozen_keys');
  const plan = [];
  const versions = await versionsColOf(db, rid).get();
  for (const v of [...versions.docs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const [items, extras] = await Promise.all([v.ref.collection('menu_items').get(), v.ref.collection('extras').get()]);
    const fv = frozenValues((v.data() || {}).frozen_keys, `versions/${v.id}.frozen_keys`);
    frozen.push(...fv);
    plan.push({ versionId: v.id,
      dish: items.docs.map((d) => stringKey((d.data() || {}).key, `versions/${v.id}/menu_items/${d.id}`)),
      extra: extras.docs.map((d) => stringKey((d.data() || {}).key, `versions/${v.id}/extras/${d.id}`)) });
    counts.versions += 1;
  }
  counts.frozen = frozen.length;
  plan.push({ versionId: AUDIT_VERSION, dish: [...registry.dish, ...frozen], extra: registry.extra });
  counts.distinct_keys = RK.reservedKeySet(fold(undefined, plan).doc).size;
  return { plan, counts };
}

function fold(data, plan) {
  let doc = RK.readReserved(data); let added = 0;
  for (const p of plan) { const r = RK.unionReserved(doc, { dish: p.dish, extra: p.extra }, p.versionId); doc = r.doc; added += r.added; }
  return { doc, added };
}

const wouldAdd = (data, plan) => fold(data, plan).added;

async function applyRecoverable(db, rid, plan) {
  const ref = RK.reservedRefOf(db, rid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const r = fold(snap.exists ? snap.data() : undefined, plan);
    RK.assertWithinLimit(r.doc);
    if (r.added > 0) tx.set(ref, r.doc);
    return { added: r.added, total: Object.keys(r.doc.keys).length };
  });
}

module.exports = { collectRecoverable, wouldAdd, applyRecoverable, AUDIT_VERSION };
