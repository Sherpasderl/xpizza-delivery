'use strict';
// DISH PHOTOS A2 (PLAN-dish-photos r2 §2.1 + amendment 2026-10-27) — the PURE three-state vocabulary, one place for every path.
// Per dish key the photo state is exactly one of: legacy (NO entry — today's rules), {state:'pid', pid}, {state:'removed'}.
//   validateDraftMap(v, {liveKeys, tmpRefs})  the editCatalog `source.photos` check → {ok, map|null} | {ok:false, code, detail}.
//                                             An absent or empty map → null (never stored: a photo-less save stays byte-identical).
//   rekeyTmp(map, refToKey)                    amendment: a `tmp:`-keyed entry moves to the key allocateAdditions gave its product.
//   kindOf(entry) / photoDiffLines(active, candidate)   the diff vocabulary {kind:'legacy'|'pid'|'removed'}; URLs never compared.
//   sameStates(a, b)                           state equality (changesNothingElse; the flag-off "unchanged map" rule).
//   resetMapFromActive(entries)                resetDraftToLive: the draft map rebuilt from the active version's meta/photos.
//   newlyReferencedPids(prev, next) / referencedPids(map)   the attach / publish / sweep reference sets.
//   versionPhotosDoc(map, urlFor)              versions/{vid}/meta/photos = {schema:1, entries} with resolved public URLs (publish).
const PID_RE = /^[0-9a-f]{32}$/;
const TMP_RE = /^tmp:[A-Za-z0-9-]{8,64}$/;   // = catalog/add-product.js TMP_RE
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const refuse = (code, detail) => ({ ok: false, code, detail });

function entryOk(e) {
  if (!isObj(e)) return false;
  const ks = Object.keys(e).sort().join(',');
  if (e.state === 'removed') return ks === 'state';
  if (e.state === 'pid') return ks === 'pid,state' && typeof e.pid === 'string' && PID_RE.test(e.pid);
  return false;
}

function validateDraftMap(v, { liveKeys, tmpRefs = new Set() } = {}) {
  if (v === undefined || v === null) return { ok: true, map: null };
  if (!isObj(v)) return refuse('photos_malformed', 'photos must be an object keyed by item key');
  const keys = Object.keys(v);
  if (!keys.length) return { ok: true, map: null };
  const out = {};
  for (const k of keys) {
    const known = (TMP_RE.test(k) && tmpRefs.has(k)) || (!k.startsWith('tmp:') && liveKeys.has(k));
    if (!known || k === '__proto__') return refuse('photo_unknown_item', `photos names ${JSON.stringify(k)}, which is not an item of this source`);
    if (!entryOk(v[k])) return refuse('photos_malformed', `photos[${JSON.stringify(k)}] must be {state:'pid', pid} or {state:'removed'}`);
    out[k] = v[k].state === 'pid' ? { state: 'pid', pid: v[k].pid } : { state: 'removed' };
  }
  return { ok: true, map: out };
}

function rekeyTmp(map, refToKey) {
  if (!map) return { ok: true, map: null };
  const out = {};
  for (const [k, e] of Object.entries(map)) {
    let key = k;
    if (k.startsWith('tmp:')) {
      if (!refToKey.has(k)) return refuse('photo_unknown_item', `photos names ${k}, which is not a new product of this edit`);
      key = refToKey.get(k);
    }
    if (own(out, key)) return refuse('photos_malformed', `two photo entries would name ${JSON.stringify(key)}`);
    out[key] = e;
  }
  return { ok: true, map: out };
}

function kindOf(e) {
  if (!e) return { kind: 'legacy' };
  if (e.state === 'pid') return { kind: 'pid', pid: e.pid };
  if (e.state === 'removed') return { kind: 'removed' };
  return { kind: 'legacy' };
}
const kindKey = (k) => (k.kind === 'pid' ? `pid:${k.pid}` : k.kind);

function photoDiffLines(activeEntries, candidateMap) {
  const a = activeEntries || {}, c = candidateMap || {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(c)])].sort();
  const lines = [];
  for (const key of keys) {
    const o = kindOf(a[key]), nw = kindOf(c[key]);
    if (kindKey(o) !== kindKey(nw)) lines.push({ surface: 'item', key, field: 'photo', old: o, new: nw });
  }
  return lines;
}

function sameStates(x, y) { return photoDiffLines(x, y).length === 0; }

function resetMapFromActive(entries) {
  if (!entries) return null;
  const out = {};
  for (const k of Object.keys(entries).sort()) {
    const kd = kindOf(entries[k]);
    if (kd.kind === 'pid') out[k] = { state: 'pid', pid: kd.pid };
    else if (kd.kind === 'removed') out[k] = { state: 'removed' };
  }
  return Object.keys(out).length ? out : null;
}

function referencedPids(map) {
  return [...new Set(Object.values(map || {}).filter((e) => e && e.state === 'pid').map((e) => e.pid))].sort();
}
function newlyReferencedPids(prev, next) {
  const before = new Set(referencedPids(prev));
  return referencedPids(next).filter((p) => !before.has(p));
}

function versionPhotosDoc(map, urlFor) {
  if (!map || !Object.keys(map).length) return null;
  const entries = {};
  for (const k of Object.keys(map).sort()) {
    const e = map[k];
    if (e.state === 'removed') { entries[k] = { state: 'removed' }; continue; }
    const card = urlFor(e.pid, 'card'), hero = urlFor(e.pid, 'hero');
    if (typeof card !== 'string' || typeof hero !== 'string' || !card || !hero) throw Object.assign(new Error('photo_publish_failed: no public URL for a pid'), { code: 'photo_publish_failed' });
    entries[k] = { state: 'pid', pid: e.pid, card, hero };
  }
  return { schema: 1, entries };
}

module.exports = { PID_RE, validateDraftMap, rekeyTmp, kindOf, photoDiffLines, sameStates, resetMapFromActive, referencedPids, newlyReferencedPids, versionPhotosDoc };
