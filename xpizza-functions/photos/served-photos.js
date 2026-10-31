'use strict';
// DISH PHOTOS A2 step 11 (PLAN-dish-photos r2 §2.1: "readers use the EXACT version id they serve") — the public menu's `photos`
// (keyed by String(dish.id); PLAN-public-menu-display T2) overlaid with the SERVED version's versions/{vid}/meta/photos:
//   pid entry   → that version's public card / hero (resolved at publish, immutable)
//   removed     → the dish is DROPPED from photos (an explicit removal: no legacy fallback)
//   no entry    → today's legacy photo, unchanged
// No doc (every pre-photos version) → the legacy map is returned AS IS (same object ⇒ the body and its ETag are byte-identical).
// An unreadable or malformed doc → null (the caller omits `photos`, exactly as photosFor's own trouble path): serving the legacy map
// instead could show a photo the merchant REMOVED. Never throws.
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function overlay(legacy, menu, entries) {
  const out = { ...(legacy || {}) };
  const idOf = new Map((menu && Array.isArray(menu.items) ? menu.items : [])
    .filter((it) => it && it.display && it.display.id !== undefined && it.display.id !== null).map((it) => [it.key, String(it.display.id)]));
  for (const [key, e] of Object.entries(entries || {})) {
    const id = idOf.get(key);
    if (id === undefined || !isObj(e)) continue;
    if (e.state === 'removed') delete out[id];
    else if (e.state === 'pid' && typeof e.card === 'string' && typeof e.hero === 'string') out[id] = { card: e.card, hero: e.hero };
  }
  return Object.keys(out).length ? out : null;
}

async function withVersionPhotos(db, rid, menu, legacy, read) {
  const vid = menu && menu.identity && menu.identity.version_id;
  if (!vid) return legacy;
  let doc;
  try {
    doc = await read(db, rid, vid);
    if (doc !== null && doc !== undefined && !(isObj(doc) && doc.schema === 1 && isObj(doc.entries))) throw new Error('malformed meta/photos');
  } catch (e) {
    console.warn('public_menu_version_photos_unreadable', JSON.stringify({ rid, vid, error: String((e && e.message) || e).slice(0, 120) }));
    return null;
  }
  return doc ? overlay(legacy, menu, doc.entries) : legacy;
}

const defaultReadVersionPhotos = async (db, rid, vid) => {
  const s = await db.collection('restaurants').doc(rid).collection('versions').doc(vid).collection('meta').doc('photos').get();
  return s.exists ? s.data() : null;
};

module.exports = { overlay, withVersionPhotos, defaultReadVersionPhotos };
