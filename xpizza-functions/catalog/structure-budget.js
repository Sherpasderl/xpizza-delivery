'use strict';
// S2-core (PLAN-structure-S2core-r3 §4; owner Q4 caps) — the Extras page's caps and byte budgets, judged on the save and on the publish
// BEFORE any write, and only behind the extrasCatalog switch (OFF: nothing is measured — today's save, byte for byte). First, the exact
// claim on the derived maps (structure_unexplained when the built extras_by_category / extras_by_item are not the projection).
//   structure_caps   ≤ 20 groups · ≤ 30 extras in a group · ≤ 600 extras · ≤ 60 ops in one draft against the live version
//   structure_bytes  source doc ≤ 512 KiB · eligibility doc ≤ 512 KiB · served public-menu body ≤ 768 KiB
// An OP is one authored Extras-page change: an extra added or removed, the group order / set changed (one), or one group entering or
// leaving a category's list (category_allow) or a dish's add / deny. An unticked extra (S1 deny_extras) and a price are today's edits,
// not ops. The documents are measured as they would be written: the source as stored, the eligibility doc the publisher writes
// (extras-eligibility-store), the body the public menu serves (public-menu composeServedMenu).
const { AddProductError } = require('./add-product');

const LIMITS = Object.freeze({ groups: 20, perGroup: 30, extras: 600, ops: 60, sourceBytes: 512 * 1024, eligibilityBytes: 512 * 1024, servedBytes: 768 * 1024 });
const refuse = (code, field, detail) => { throw new AddProductError(code, detail, { field }); };
const bytes = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');
const list = (v) => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)]);
const symDiff = (a, b) => { const A = new Set(a), B = new Set(b); return [...A].filter((x) => !B.has(x)).length + [...B].filter((x) => !A.has(x)).length; };

function opsOf(draft, active) {
  const dk = new Set((draft.extras || []).map((e) => e.key)); const ak = new Set((active.extras || []).map((e) => e.key));
  let ops = symDiff([...dk], [...ak]);
  const ds = draft.structure || {}, as = active.structure || {};
  if (JSON.stringify(list(ds.extra_categories)) !== JSON.stringify(list(as.extra_categories))) ops += 1;
  const dx = ds.exposure || {}, ax = as.exposure || {};
  const dca = dx.category_allow || {}, aca = ax.category_allow || {};
  for (const c of new Set([...Object.keys(dca), ...Object.keys(aca)])) ops += symDiff(list(dca[c]), list(aca[c]));
  const dov = dx.item_overrides || {}, aov = ax.item_overrides || {};
  for (const k of new Set([...Object.keys(dov), ...Object.keys(aov)])) {
    for (const f of ['add', 'deny']) ops += symDiff(list((dov[k] || {})[f]), list((aov[k] || {})[f]));
  }
  return ops;
}

// Codex build r1 P2-8 / r2 #8 — the COMPLETE served response, bounded from above before any write, every part MEASURED from the draft:
//   · the endpoint's composition (composeServedMenu) with what buildPublicMenu attaches after it — the version's public extras
//     eligibility and avail_identity — and the item_keys map (identity-overlay withServedItemKeys)
//   · the photos map: the legacy entries EXACTLY as served (public-photos buildPhotos over the restaurant's real asset base), plus every
//     published-photo entry of the draft photo map at the LONGEST public URL (a bucket name may be 222 characters)
//   · the identity decorations: each served dish's dish_id and each extra's extra_id, at the longer of its key and a minted id
//   · a fixed header allowance (versions and envelope fields). Over-counting is the safe side; nothing is a per-dish guess.
const HEADER_ALLOWANCE = 4096; const BUCKET_MAX = 222; const MINTED_ID_MAX = 32;
const publicUrlBound = (rid, pid, kind) => `https://storage.googleapis.com/${'b'.repeat(BUCKET_MAX)}/photos/${rid}/${pid}-${kind}.webp`;
function servedParts({ rid, draft, elig, keyMode, photos = null }) {
  const PM = require('./public-menu');
  const body = PM.composeServedMenu(rid, { items: draft.items, structure: draft.structure || {}, extras: draft.extras, keyMode });
  // what buildPublicMenu attaches after composing (catalog/public-menu.js:228): the version's public eligibility and avail_identity
  body.extras_eligibility = { version: elig.version, deny: elig.public_deny };
  body.avail_identity = { field: require('../menu-pricing').availIdentityField(rid, keyMode) };
  // the endpoint's OWN key map (public-menu.js: servedKeyMap(menu) → withServedItemKeys and the identity overlay) — display id → pricing
  // key, so a renamed dish's frozen (possibly long) key is what is served and measured (Codex build r3 #8)
  const IO = require('./identity-overlay'); const keyById = IO.servedKeyMap({ items: draft.items || [] });
  const withKeys = IO.withServedItemKeys(rid, body, keyById);
  const PP = require('./public-photos');
  const base = PP.assetBaseFor(rid, require('../platform-manifest').PLATFORM.sites);
  const legacy = base ? PP.buildPhotos({ items: draft.items || [] }, base) : {};
  const idOf = new Map((draft.items || []).filter((it) => it && it.display && it.display.id != null).map((it) => [it.key, String(it.display.id)]));
  let photoBytes = bytes(legacy) + 12;   // ,"photos":{}
  for (const [key, e] of Object.entries(photos && typeof photos === 'object' ? photos : {})) {
    if (!e || e.state !== 'pid' || typeof e.pid !== 'string') continue;
    photoBytes += bytes({ [idOf.get(key) || key]: { card: publicUrlBound(rid, e.pid, 'card'), hero: publicUrlBound(rid, e.pid, 'hero') } });
  }
  let identityBytes = 0;
  for (const r of Array.isArray(body.dishes) ? body.dishes : []) identityBytes += 13 + Math.max(MINTED_ID_MAX, bytes(String(IO.keyOfServed(rid, r, keyById) || (r && r.id))));   // a grandfathered id IS the served key
  for (const r of Array.isArray(body.extras) ? body.extras : []) identityBytes += 14 + Math.max(MINTED_ID_MAX, bytes(String(r && (r.key !== undefined ? r.key : r.id))));
  return { core: bytes(withKeys), photos: photoBytes, identity: identityBytes, header: HEADER_ALLOWANCE };
}
function servedUpperBound(args) { const p = servedParts(args); return p.core + p.photos + p.identity + p.header; }

// rid, source (the draft as it will be stored), draft / active: the built RECORDS { items, extras, structure }. Returns the measurements
// (null when the switch is off); throws AddProductError structure_caps / structure_bytes { field }.
function enforce({ rid, source, draft, active, extrasCatalog, limits = LIMITS, photos = undefined }) {
  if (!extrasCatalog) return null;
  const st = draft.structure || {};
  // T21 (§1.3 DERIVED-CLAIM-EXACT): under the switch compareToActive CLAIMS the two maps (they move with every attach / detach), so the
  // claim is exact here — the built maps ARE the projection of the draft's own records, nothing else (add-product.js requires nothing)
  const maps = require('./extras-projection').projectExtrasMaps({ items: draft.items, extras: draft.extras, structure: st });
  for (const [f, want] of [['extras_by_category', maps.byCategory], ['extras_by_item', maps.byItem]]) {
    if (JSON.stringify(st[f] || {}) !== JSON.stringify(want)) refuse('structure_unexplained', f, `the menu's ${f} is not the one its extras groups derive`);
  }
  const groups = list(st.extra_categories);
  if (groups.length > LIMITS.groups) refuse('structure_caps', 'extra_categories', `at most ${LIMITS.groups} extras groups (${groups.length})`);
  const per = new Map();
  for (const e of draft.extras || []) { const g = e && e.display && e.display.cat; per.set(g, (per.get(g) || 0) + 1); }
  for (const [g, c] of per) if (c > LIMITS.perGroup) refuse('structure_caps', 'extras', `at most ${LIMITS.perGroup} options in the group «${g}» (${c})`);
  if ((draft.extras || []).length > LIMITS.extras) refuse('structure_caps', 'extras', `at most ${LIMITS.extras} options (${draft.extras.length})`);
  const ops = opsOf(draft, active);
  if (ops > LIMITS.ops) refuse('structure_caps', 'ops', `at most ${LIMITS.ops} Extras changes in one publish (${ops}) — publish part of them first`);
  const sourceBytes = bytes(source);
  if (sourceBytes > limits.sourceBytes) refuse('structure_bytes', 'source', `the menu would be ${Math.ceil(sourceBytes / 1024)} KiB (at most ${limits.sourceBytes / 1024})`);
  const elig = require('./extras-eligibility-store').buildEligibilityDoc({ items: draft.items, extras: draft.extras, structure: st });
  const eligibilityBytes = bytes(elig);
  if (eligibilityBytes > limits.eligibilityBytes) refuse('structure_bytes', 'eligibility', `the extras rules would be ${Math.ceil(eligibilityBytes / 1024)} KiB (at most ${limits.eligibilityBytes / 1024})`);
  const servedBytes = servedUpperBound({ rid, draft, elig, keyMode: source && source.key_mode, photos: photos !== undefined ? photos : (source && source.photos) });
  if (servedBytes > limits.servedBytes) refuse('structure_bytes', 'served', `the served menu would be ${Math.ceil(servedBytes / 1024)} KiB (at most ${limits.servedBytes / 1024})`);
  return { ops, sourceBytes, eligibilityBytes, servedBytes };
}

module.exports = { enforce, opsOf, servedUpperBound, servedParts, publicUrlBound, LIMITS, HEADER_ALLOWANCE };
