'use strict';
const crypto = require('crypto');
const { codeTablesToCatalogDocs } = require('./catalog-transform');
// Deterministic Firestore-safe doc id (item NAMEs contain spaces/&; hash avoids doc-id restrictions).
// The EXACT pricing key always travels in the `key` field — never derive the key from the doc id.
const docId = (key) => crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 20);
// Pure: code tables → the doc set (each doc carries its target id + the EXACT pricing key + price).
// 1c-a: `v2ByKey` optionally supplies each item's schema-v2 payload (the verbatim form display record
// + has_photo). `key` and `price` are produced EXACTLY as before — the 1b pricing reader reads only
// those two and is untouched by the new fields (PIN 1). Extras stay {key, price}.
function catalogDocsForRestaurant(menuTable, extraTable, v2ByKey = null) {
  const { itemDocs, extraDocs } = codeTablesToCatalogDocs(menuTable, extraTable || {});
  const withId = (docs) => docs.map((d) => ({ id: docId(d.key), key: d.key, price: d.price }));
  const items = withId(itemDocs).map((d) => {
    const v2 = v2ByKey && v2ByKey.get(d.key);
    if (!v2) return d;
    const out = { ...d, display: v2.display };
    if (v2.has_photo !== undefined) out.has_photo = v2.has_photo;
    return out;
  });
  return { itemDocs: items, extraDocs: withId(extraDocs) };
}
// Codex: the profile doc is PUBLIC-read + the Admin SDK BYPASSES Firestore rules → an allowlist here is
// the ONLY thing that keeps private/payout data off the public profile. Reject any non-allowlisted field.
const PROFILE_FIELDS = new Set(['name', 'tier', 'active', 'hours', 'branding', 'pricing_key_mode', 'schema_version']);   // 1c-a: schema_version (the allowlist WIPES anything unlisted)
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
    const v2ByKey = meta.v2Items ? new Map(meta.v2Items.map((i) => [i.key, i])) : null;   // 1c-a schema-v2 payload
    const { itemDocs, extraDocs } = catalogDocsForRestaurant(meta.menu, meta.extras, v2ByKey);
    const rref = db.collection('restaurants').doc(rid);
    let reconciled = 0;
    for (const [sub, docs] of [['menu_items', itemDocs], ['extras', extraDocs]]) {   // subcollections FIRST
      const col = rref.collection(sub);
      const wantIds = new Set(docs.map((d) => d.id));
      const existing = await col.get();
      // Chunked at 450 (Firestore caps a batch at 500 ops). NOTE: a sequence of batches is NOT atomic — a
      // partial failure (e.g. the 2nd delete chunk throws) can leave the catalog INCONSISTENT: stale docs
      // survive or current docs are missing. This is acceptable ONLY because (a) 1a's real seeds are single-
      // batch (x_pizza 24, la_musa 43 << 450 → atomic in practice), and (b) the REQUIRED post-seed
      // `verify-catalog.js` gate byte-compares prod vs code and blocks deploy on any mismatch. Atomic cutover
      // under a LIVE reader (a real large-menu re-seed) needs the 1b versioned-publish precondition — NOT this.
      // Delete-before-set is kept as the better-of-two partial states, NOT as a guarantee.
      const ops = [];
      existing.forEach((snap) => { if (!wantIds.has(snap.id)) { ops.push((b) => b.delete(snap.ref)); reconciled++; } });   // reconcile stale
      for (const d of docs) ops.push((b) => b.set(col.doc(d.id), {
        key: d.key, price: d.price,                                             // pricing identity + value — UNCHANGED (PIN 1)
        ...(d.display !== undefined ? { display: d.display } : {}),              // 1c-a: verbatim form record
        ...(d.has_photo !== undefined ? { has_photo: d.has_photo } : {}),
      }));
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
    // 1c-a: the menu_structure doc (category order/labels, la_musa subcats + variants, x_pizza gate
    // flags, and the ITEM ORDER — Firestore returns docs in hashed-id order, so the form's array order
    // must be carried explicitly or a regenerated bundle would be correct but reordered). Written just
    // before the profile so the profile remains the LAST write, i.e. still the completeness marker.
    if (meta.structure) await rref.collection('meta').doc('menu_structure').set(meta.structure);
    await rref.set(meta.profile);   // profile LAST — completeness marker on a first seed
    report[rid] = { items: itemDocs.length, extras: extraDocs.length, reconciled };
  }
  return report;
}
module.exports = { seedCatalog, catalogDocsForRestaurant, docId, PROFILE_FIELDS };
