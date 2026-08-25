'use strict';
const crypto = require('crypto');
const { codeTablesToCatalogDocs } = require('./catalog-transform');
// Deterministic Firestore-safe doc id (item NAMEs contain spaces/&; hash avoids doc-id restrictions).
// The EXACT pricing key always travels in the `key` field — never derive the key from the doc id.
const docId = (key) => crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 20);
// Pure: code tables → the doc set (each doc carries its target id + the EXACT pricing key + price).
function catalogDocsForRestaurant(menuTable, extraTable) {
  const { itemDocs, extraDocs } = codeTablesToCatalogDocs(menuTable, extraTable || {});
  const withId = (docs) => docs.map((d) => ({ id: docId(d.key), key: d.key, price: d.price }));
  return { itemDocs: withId(itemDocs), extraDocs: withId(extraDocs) };
}
// Codex: the profile doc is PUBLIC-read + the Admin SDK BYPASSES Firestore rules → an allowlist here is
// the ONLY thing that keeps private/payout data off the public profile. Reject any non-allowlisted field.
const PROFILE_FIELDS = new Set(['name', 'tier', 'active', 'hours', 'branding', 'pricing_key_mode']);
// IMPORTABLE writer (DI'd Firestore db). RECONCILES stale docs (re-seed after a rename/removal deletes the
// old doc). Writes the PROFILE LAST — so on a FIRST seed, profile.exists ⇒ a COMPLETE seed (an interrupted
// seed leaves no profile → getRestaurantDocs throws restaurant_not_found, safe, never a plausible-empty).
// On a RE-seed the profile already exists, so completeness there rests on tools/verify-catalog.js, not on
// write order (see PLAN.md). Returns per-restaurant counts for the caller to log/audit.
async function seedCatalog(db, restaurants) {
  const report = {};
  for (const [rid, meta] of Object.entries(restaurants)) {
    const bad = Object.keys(meta.profile || {}).filter((k) => !PROFILE_FIELDS.has(k));
    if (bad.length) throw new Error(`profile field not allowlisted for ${rid}: ${bad.join(',')}`);   // no private data on the public doc
    const { itemDocs, extraDocs } = catalogDocsForRestaurant(meta.menu, meta.extras);
    const rref = db.collection('restaurants').doc(rid);
    let reconciled = 0;
    for (const [sub, docs] of [['menu_items', itemDocs], ['extras', extraDocs]]) {   // subcollections FIRST
      const col = rref.collection(sub);
      const wantIds = new Set(docs.map((d) => d.id));
      const existing = await col.get();
      // Chunked at 450 (Firestore caps a batch at 500 ops) so a large future menu + stale docs can't fail
      // the whole subcollection commit. Stale DELETES are queued before the sets deliberately: if a chunk
      // ever fails midway, the catalog is left MISSING items (1b fails closed on an unknown key) rather
      // than carrying a resurrected item at a stale price. verify-catalog.js catches either direction.
      const ops = [];
      existing.forEach((snap) => { if (!wantIds.has(snap.id)) { ops.push((b) => b.delete(snap.ref)); reconciled++; } });   // reconcile stale
      for (const d of docs) ops.push((b) => b.set(col.doc(d.id), { key: d.key, price: d.price }));
      for (let i = 0; i < ops.length; i += 450) {
        const b = db.batch();
        for (const op of ops.slice(i, i + 450)) op(b);
        await b.commit();
      }
    }
    // FULL overwrite, NO merge (advisor gate, security): the profile is public-read, and {merge:true} would
    // leave a PRE-EXISTING private field (payout/bank_account from a future phase or a manual write) alive on
    // it — the allowlist constrains only what WE write, not the doc's final contents. A full set makes the doc
    // contain EXACTLY the allowlisted fields, scrubbing anything stale. Private data lives on a server-only
    // path, never here. NOTE: because this REPLACES the doc, any future seed-managed public profile field must
    // be added to BOTH PROFILE_FIELDS and meta.profile, or it will be wiped on the next seed.
    await rref.set(meta.profile);   // profile LAST — completeness marker on a first seed
    report[rid] = { items: itemDocs.length, extras: extraDocs.length, reconciled };
  }
  return report;
}
module.exports = { seedCatalog, catalogDocsForRestaurant, docId, PROFILE_FIELDS };
