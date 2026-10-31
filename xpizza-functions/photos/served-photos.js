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
// codex r1 P2-5: EVERY entry is validated before any is used — exactly {state:'removed'} or {state:'pid', pid: 32 hex, card + hero https URLs}.
// One malformed entry makes the whole doc malformed (→ photos omitted, deviation #3), never a silent per-dish legacy fallback.
const PID_RE = /^[0-9a-f]{32}$/;
const httpsUrl = (u) => typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u);
function entryOk(e) {
  if (!isObj(e)) return false;
  const ks = Object.keys(e).sort().join(',');
  if (e.state === 'removed') return ks === 'state';
  return e.state === 'pid' && ks === 'card,hero,pid,state' && typeof e.pid === 'string' && PID_RE.test(e.pid) && httpsUrl(e.card) && httpsUrl(e.hero);
}

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
    if (doc !== null && doc !== undefined && !(isObj(doc) && doc.schema === 1 && isObj(doc.entries) && Object.values(doc.entries).every(entryOk))) throw new Error('malformed meta/photos');
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
