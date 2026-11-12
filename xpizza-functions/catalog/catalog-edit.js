'use strict';
// ---------------------------------------------------------------------------
// Portal Phase 2b-1 Task 1 — the DIFF a human reviews, and the TOKEN that makes the review binding.
//
// Through 2a, "is this catalog correct?" had a mechanical answer: it had to equal the code tables. From
// 2b on, divergence is the entire point, so that yardstick is gone. Two things replace it:
//
//   THE DIFF is the only thing between a merchant and a mistyped price. A change it fails to surface is
//   a change nobody reviewed, so it covers every price-bearing surface — items AND extras, on both
//   brands' keying schemes — plus the per-item gate flags that decide what is orderable and what can be
//   comped for free. Gates are reported PER ITEM rather than as "weekend_only_cats changed", because a
//   category list is not what a person checks; a dish name is.
//
//   THE TOKEN makes that review binding. It is an HMAC over the exact state the diff was computed from,
//   so publishEdited can only land the draft that was actually reviewed, against the live version it was
//   reviewed against, with the change that was actually shown. Anything else — a draft edited after the
//   diff, someone else publishing in between, a laundered sanity set, a forged token — fails to verify.
//
// Pure. No I/O, no Firestore. The caller supplies both built catalogs.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { canonicalize } = require('./source-store');
const PS = require('../photos/photo-state');   // DISH PHOTOS A2: the three-state photo vocabulary (pure)

const SWING_LIMIT = 0.50;          // |new-old|/old — a price moving by more than half is worth a human's attention
const MIN_SECRET_LEN = 32;

// Resolved LAZILY, not at module load. otp-lib.js throws at require-time, which is right for a module
// that is only ever required by the endpoints needing it — but catalogDiff is pure and is used by tests
// and tooling that have no business holding a signing key. A misconfigured secret must fail the TOKEN,
// not the diff.
function secret() {
  const s = process.env.EDIT_TOKEN_SECRET || '';
  if (s.length < MIN_SECRET_LEN) {
    // NEVER fall back to a default or an empty key: that would make every token forgeable by anyone.
    throw new Error(`EDIT_TOKEN_SECRET missing or too short (need >=${MIN_SECRET_LEN} chars) — refusing to sign (fail-closed)`);
  }
  return s;
}

const sha256 = (v) => crypto.createHash('sha256').update(JSON.stringify(canonicalize(v))).digest('hex');

// ── the per-item projections a merchant actually thinks in ─────────────────────────────────────
// Derived the same way the live gates derive them (menu-gates.js), so what the diff SHOWS is what the
// serving path will DO. A diff computed a second way would eventually disagree with production.
function gateFlagsOf(built) {
  const st = (built && built.structure) || {};
  const weekend = new Set(st.weekend_only_cats || []);
  const pickup = new Set(st.pickup_only_cats || []);
  const redeemCats = new Set(st.redeem_eligible_cats || []);
  const redeemItems = new Set(st.redeem_eligible_items || []);
  const out = new Map();
  for (const it of (built && built.items) || []) {
    const cat = it.display && it.display.cat;
    out.set(it.key, {
      weekend_only: weekend.has(cat),
      pickup_only: pickup.has(cat),
      redeem_eligible: redeemCats.has(cat) || redeemItems.has(it.key),
    });
  }
  return out;
}

// Display fields worth surfacing. `price` lives on the item record itself (display.price is a mirror the
// 2a validator already forces into agreement), and `id` is form-local plumbing a merchant never sees.
// `identity_id` (1D D4-P1) is the server-owned identity stamp: a merchant never sets it, never sees it,
// and the bootstrap pass adds it to every object at once — surfacing it would show a merchant a diff
// of their whole menu that they did not make and cannot act on.
const DISPLAY_SKIP = new Set(['price', 'id', 'identity_id']);

const itemsByKey = (built) => new Map(((built && built.items) || []).map((i) => [i.key, i]));
const extrasOf = (built) => ((built && built.extras) || {});

function priceSanity(key, surface, old, next, out) {
  if (!Number.isFinite(next) || next <= 0) { out.push({ key, surface, reason: 'nonpositive', old: old === undefined ? null : old, new: next }); return; }
  if (old === undefined || old === null) { out.push({ key, surface, reason: 'new_priced', old: null, new: next }); return; }
  if (old > 0 && Math.abs(next - old) / old > SWING_LIMIT) out.push({ key, surface, reason: 'swing_gt_50', old, new: next });
}

// «Quitar del menú» P-R1: the editor read's rows for the live dishes a SAVED draft removes (the comparator's honoured removals) —
// { key, identity_id, row: the live item, after: its live item_order predecessor or null, photo: its live photo entry or null }, sorted
// by key, plus its own refs (B-2). Here (not in portal-reads) because the stamp is identity: this module already owns reading it.
function pendingRemovalRows(liveBuilt, keys, photoMap = null) {
  const items = new Map(((liveBuilt && liveBuilt.items) || []).map((it) => [it && it.key, it]));
  const order = (liveBuilt && liveBuilt.structure && liveBuilt.structure.item_order) || [];
  const photos = new Map(photoMap && typeof photoMap === 'object' ? Object.entries(photoMap) : []);   // A-1: the ACTIVE entries in the draft map's shape (portal-reads)
  const st = (liveBuilt && liveBuilt.structure) || {};
  const ov = new Map(Object.entries(st.exposure && st.exposure.item_overrides && typeof st.exposure.item_overrides === 'object' ? st.exposure.item_overrides : {}));
  const ebi = new Map(Object.entries(st.extras_by_item && typeof st.extras_by_item === 'object' ? st.extras_by_item : {}));
  const rei = Array.isArray(st.redeem_eligible_items) ? st.redeem_eligible_items : [];
  return [...keys].sort().map((key) => { const row = items.get(key) || null; const i = order.indexOf(key);
    return { key, identity_id: row && row.display && row.display.identity_id !== undefined ? row.display.identity_id : null, row, after: i > 0 ? order.slice(i - 1, i).pop() : null, photo: photos.has(key) ? photos.get(key) : null,
      // B-2: the dish's OWN refs, so a reload «Deshacer» restores them exactly (the entries P-R4 lets a removal take)
      refs: { item_override: ov.has(key) ? ov.get(key) : null, extras_by_item: ebi.has(key) ? ebi.get(key) : null, redeem_index: rei.includes(key) ? rei.indexOf(key) : null } }; });
}
// «Quitar del menú» P-R3 (switch P-R5): the diff option for a draft whose deletion claim names live dishes — { declared: Set<live key> },
// the live dishes whose identity stamp is in `draft.deleted_ids.ids` and whose key the draft no longer has. Switch OFF, or no claim → null
// (today's diff). The save, the owner publish and the manager request pass it alike, so the token-bound diff re-matches.
function removalDiffOptions(liveBuilt, draft) {
  if (!require('./platform-removal').removalCapabilities().productRemoval) return null;
  const ids = draft && draft.deleted_ids && Array.isArray(draft.deleted_ids.ids) ? new Set(draft.deleted_ids.ids) : null;
  if (!ids || !ids.size) return null;
  const inDraft = new Set(((draft && draft.items) || []).map((it) => it && it.key));
  const declared = new Set(((liveBuilt && liveBuilt.items) || []).filter((it) => it && it.display && ids.has(it.display.identity_id) && !inDraft.has(it.key)).map((it) => it.key));
  return declared.size ? { declared } : null;
}
// B-1 (advisor RULED): the reviewed diff changes NOTHING but declared removals (their own cleanup is not a line) — no added, renamed or
// changed line, no sanity line, no consequence, and every removed line is a declared dish. Then no factura price moves.
function removalOnlyDiff(diff, opts) {
  const declared = opts && opts.declared instanceof Set ? opts.declared : null;
  if (!declared || !diff) return false;
  const none = (a) => !Array.isArray(a) || a.length === 0;
  return none(diff.added) && none(diff.renamed) && none(diff.changed) && none(diff.largeChangeSet) && none(diff.consequences)
    && Array.isArray(diff.removed) && diff.removed.length > 0 && diff.removed.every((r) => r && r.surface === 'item' && declared.has(r.key));
}
// Q-12 + A-3 (advisor RULED): THE one answer to «does this publish waive the fiscal acknowledgement?» — the switch ON (removalDiffOptions is
// null when OFF), a removal-only diff, AND the whole draft document equals the ACTIVE one minus ONLY the declared removals and their
// permitted cleanup (their item_overrides / extras_by_item / reward entries, item_order positions and photo) — compared canonically over
// the items, the extras (prices + records), the whole structure and the photo map. Anything else (a deny_extras, a badge order…) ⇒ not
// waived. The owner publish's gate and the save's `fiscalAckRequired: false` both read it.
function fiscalAckWaived({ live, draftBuilt, draft, diff, liveExtraRecords = null, draftExtraRecords = null, activePhotos = null, draftPhotos = null }) {
  const opts = removalDiffOptions(live, draft);
  if (!opts || !removalOnlyDiff(diff, opts) || !draftBuilt || !live) return false;
  const d = opts.declared;
  const st = JSON.parse(JSON.stringify(live.structure || {}));
  st.item_order = (st.item_order || []).filter((k) => !d.has(k));
  if (st.exposure && st.exposure.item_overrides && typeof st.exposure.item_overrides === 'object') for (const k of d) delete st.exposure.item_overrides[k];
  if (st.extras_by_item && typeof st.extras_by_item === 'object') for (const k of d) delete st.extras_by_item[k];   // emptied ⇒ {} (the sticky clear)
  if (Array.isArray(st.redeem_eligible_items)) st.redeem_eligible_items = st.redeem_eligible_items.filter((k) => !d.has(k));
  const photosOf = (m) => { const e = Object.entries(m || {}).filter(([k]) => !d.has(k)); return e.length ? Object.fromEntries(e) : null; };
  const both = liveExtraRecords != null && draftExtraRecords != null;
  const want = { items: (live.items || []).filter((it) => !d.has(it && it.key)), extras: live.extras || null, structure: st, ...(both ? { records: liveExtraRecords } : {}), photos: photosOf(PS.resetMapFromActive(activePhotos)) };
  const got = { items: draftBuilt.items || [], extras: draftBuilt.extras || null, structure: require('./add-product').clearedMapsFor(draftBuilt.structure || {}, live.structure, true), ...(both ? { records: draftExtraRecords } : {}), photos: photosOf(draftPhotos) };
  return JSON.stringify(canonicalize(want)) === JSON.stringify(canonicalize(got));
}
// B-5 / A-4 (advisor RULED): with photo uploads off, the draft map may differ from the stored one ONLY by (a) a declared removal's OWN entry
// leaving, or (b) a WITHDRAWN removal's dish (absent from the stored draft, present again) getting back exactly its ACTIVE entry. Switch ON only.
async function removalPhotoChangesOk({ map, stored, opts, storedItems, candidateItems, readActive }) {
  if (!require('./platform-removal').removalCapabilities().productRemoval) return false;
  const declared = opts && opts.declared instanceof Set ? opts.declared : new Set();
  const keysOf = (items) => new Set((Array.isArray(items) ? items : []).map((it) => it && it.key));
  const was = keysOf(storedItems), now = keysOf(candidateItems);
  const changed = PS.photoDiffLines(stored, map).map((l) => l.key);
  let active;
  for (const k of changed) {
    if (declared.has(k) && !(map && Object.prototype.hasOwnProperty.call(map, k))) continue;   // (a)
    if (was.has(k) || !now.has(k)) return false;
    if (active === undefined) { try { active = PS.resetMapFromActive(await readActive()) || {}; } catch (_) { return false; } }
    if (!PS.sameStates({ [k]: map && map[k] }, active[k] ? { [k]: active[k] } : null)) return false;   // (b) exactly the active entry
  }
  return true;
}
// Pair removals with additions ONLY when the pairing is unambiguous: exactly one of each at that price.
// Guessing is worse than not pairing. A deletion mislabelled as a "rename" is a deletion nobody reviewed,
// and this diff is the only review there is — so ambiguity stays visible as add + remove.
function pairRenames(removed, added, surface) {
  const renamed = [];
  const byPrice = new Map();
  for (const r of removed) { if (!byPrice.has(r.price)) byPrice.set(r.price, { rem: [], add: [] }); byPrice.get(r.price).rem.push(r); }
  for (const a of added) { if (!byPrice.has(a.price)) byPrice.set(a.price, { rem: [], add: [] }); byPrice.get(a.price).add.push(a); }
  const pairedKeys = new Set();
  for (const [price, g] of byPrice) {
    if (g.rem.length === 1 && g.add.length === 1) {
      renamed.push({ surface, from: g.rem[0].key, to: g.add[0].key, price });
      pairedKeys.add(`r:${g.rem[0].key}`); pairedKeys.add(`a:${g.add[0].key}`);
    }
  }
  return {
    renamed,
    removed: removed.filter((r) => !pairedKeys.has(`r:${r.key}`)),
    added: added.filter((a) => !pairedKeys.has(`a:${a.key}`)),
  };
}

function catalogDiff(liveBuilt, draftBuilt, opts = null) {
  const added = [], removed = [], changed = [], largeChangeSet = [];

  // ── items
  const liveItems = itemsByKey(liveBuilt), draftItems = itemsByKey(draftBuilt);
  const liveGates = gateFlagsOf(liveBuilt), draftGates = gateFlagsOf(draftBuilt);
  const rawAddedItems = [], rawRemovedItems = [];
  for (const [key, it] of draftItems) if (!liveItems.has(key)) rawAddedItems.push({ key, surface: 'item', price: it.price });
  for (const [key, it] of liveItems) if (!draftItems.has(key)) rawRemovedItems.push({ key, surface: 'item', price: it.price });

  for (const [key, dIt] of draftItems) {
    const lIt = liveItems.get(key);
    if (!lIt) { priceSanity(key, 'item', null, dIt.price, largeChangeSet); continue; }
    if (lIt.price !== dIt.price) {
      changed.push({ key, surface: 'item', field: 'price', old: lIt.price, new: dIt.price });
      priceSanity(key, 'item', lIt.price, dIt.price, largeChangeSet);
    }
    const ld = lIt.display || {}, dd = dIt.display || {};
    for (const f of new Set([...Object.keys(ld), ...Object.keys(dd)])) {
      if (DISPLAY_SKIP.has(f)) continue;
      if (JSON.stringify(canonicalize(ld[f])) !== JSON.stringify(canonicalize(dd[f]))) {
        changed.push({ key, surface: 'item', field: f, old: ld[f] === undefined ? null : ld[f], new: dd[f] === undefined ? null : dd[f] });
      }
    }
    if (Boolean(lIt.has_photo) !== Boolean(dIt.has_photo)) changed.push({ key, surface: 'item', field: 'has_photo', old: Boolean(lIt.has_photo), new: Boolean(dIt.has_photo) });
    const lg = liveGates.get(key) || {}, dg = draftGates.get(key) || {};
    for (const f of ['weekend_only', 'pickup_only', 'redeem_eligible']) {
      if (Boolean(lg[f]) !== Boolean(dg[f])) changed.push({ key, surface: 'item', field: f, old: Boolean(lg[f]), new: Boolean(dg[f]) });
    }
  }

  // ── extras (money too: an extra is a priced line on the same order)
  const liveEx = extrasOf(liveBuilt), draftEx = extrasOf(draftBuilt);
  const rawAddedEx = [], rawRemovedEx = [];
  for (const k of Object.keys(draftEx)) if (!Object.prototype.hasOwnProperty.call(liveEx, k)) rawAddedEx.push({ key: k, surface: 'extra', price: draftEx[k] });
  for (const k of Object.keys(liveEx)) if (!Object.prototype.hasOwnProperty.call(draftEx, k)) rawRemovedEx.push({ key: k, surface: 'extra', price: liveEx[k] });
  for (const k of Object.keys(draftEx)) {
    if (!Object.prototype.hasOwnProperty.call(liveEx, k)) { priceSanity(k, 'extra', null, draftEx[k], largeChangeSet); continue; }
    if (liveEx[k] !== draftEx[k]) {
      changed.push({ key: k, surface: 'extra', field: 'price', old: liveEx[k], new: draftEx[k] });
      priceSanity(k, 'extra', liveEx[k], draftEx[k], largeChangeSet);
    }
  }

  // ── category names (PLAN-public-menu-display r2 T1): the one category field the edit path may change, so the one
  // category change the review must show. Paired by id; anything else about a category is refused upstream.
  const liveCats = ((liveBuilt && liveBuilt.structure && liveBuilt.structure.categories) || []);
  const draftCats = new Map(((draftBuilt && draftBuilt.structure && draftBuilt.structure.categories) || []).map((c) => [c && c.id, c]));
  for (const lc of liveCats) {
    const dc = lc && draftCats.get(lc.id);
    if (!dc) continue;
    const o = lc.name === undefined ? null : lc.name, nx = dc.name === undefined ? null : dc.name;
    if (o !== nx) changed.push({ key: lc.id, surface: 'category', field: 'name', old: o, new: nx });
  }

  // DISH PHOTOS A2 step 9 (§2.1): the photo state per item — read from an OPTIONAL `photos` on each side (the active version's
  // meta/photos entries; the draft map). Absent on both ⇒ no lines ⇒ this diff (HASHED into the token) is byte-identical to before.
  // Same field order as every other `changed` line. Never in largeChangeSet.
  for (const l of PS.photoDiffLines(liveBuilt.photos, draftBuilt.photos)) changed.push({ key: l.key, surface: l.surface, field: l.field, old: l.old, new: l.new });

  // «Quitar del menú» P-R3: a DECLARED removal (removalDiffOptions) is never rename-paired — it stays «Quitado» beside the addition
  const declared = opts && opts.declared instanceof Set ? opts.declared : null;
  const itemPairs = pairRenames(declared ? rawRemovedItems.filter((r) => !declared.has(r.key)) : rawRemovedItems, rawAddedItems, 'item');
  if (declared) itemPairs.removed.push(...rawRemovedItems.filter((r) => declared.has(r.key)));
  if (declared) for (let i = changed.length - 1; i >= 0; i--) if (changed[i].field === 'photo' && declared.has(changed[i].key)) changed.splice(i, 1);   // B-5: the photo cleanup folds into the one «Quitado» row
  const extraPairs = pairRenames(rawRemovedEx, rawAddedEx, 'extra');
  added.push(...itemPairs.added, ...extraPairs.added);
  removed.push(...itemPairs.removed, ...extraPairs.removed);
  const renamed = [...itemPairs.renamed, ...extraPairs.renamed];

  // A rename is not an addition, so its "new item" sanity trip must go with it.
  const renamedTo = new Set(renamed.map((r) => `${r.surface}:${r.to}`));
  const sanity = largeChangeSet.filter((l) => !renamedTo.has(`${l.surface}:${l.key}`));

  // Deterministic ordering — the diff is HASHED into the token, so two runs over the same inputs must
  // produce byte-identical output or the binding would be unstable.
  const byKey = (a, b) => (a.surface + a.key + (a.field || a.reason || '')).localeCompare(b.surface + b.key + (b.field || b.reason || ''));
  return {
    added: added.sort(byKey),
    removed: removed.sort(byKey),
    renamed: renamed.sort((a, b) => (a.surface + a.from).localeCompare(b.surface + b.from)),
    changed: changed.sort(byKey),
    largeChangeSet: sanity.sort(byKey),
  };
}

// ── the token ──────────────────────────────────────────────────────────────────────────────────
// Bound fields, and what each one stops:
//   rid                  — a token for one brand publishing another
//   baseActiveVersionId  — someone else publishing between the review and this publish
//   sourceUpdateTime     — the draft moving after the diff was shown
//   sourceHash           — the draft's CONTENT differing from the reviewed one
//   diffHash             — the change not being the one displayed
//   largeChangeSet       — belt-and-braces. diffHash already covers it (it is part of the diff), so this
//                          field is redundant for integrity TODAY; it is listed explicitly so that a
//                          future change to what diffHash serializes cannot silently unbind the one
//                          part of the diff that gates an acknowledgement.
const payloadOf = ({ rid, baseActiveVersionId, sourceUpdateTime, sourceHash, diff }) => canonicalize({
  v: 1,
  rid: rid == null ? null : String(rid),
  baseActiveVersionId: baseActiveVersionId == null ? null : String(baseActiveVersionId),
  sourceUpdateTime: sourceUpdateTime == null ? null : String(sourceUpdateTime),
  sourceHash: sourceHash == null ? null : String(sourceHash),
  diffHash: sha256(diff || {}),
  largeChangeSet: (diff && diff.largeChangeSet) || [],
});

function issueEditToken(state) {
  return crypto.createHmac('sha256', secret()).update(JSON.stringify(payloadOf(state))).digest('hex');
}

function verifyEditToken(token, state) {
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'token_missing' };
  let expected;
  try { expected = issueEditToken(state); } catch (e) { return { ok: false, reason: 'token_secret_unavailable' }; }
  const a = Buffer.from(token, 'utf8'), b = Buffer.from(expected, 'utf8');
  // Length-check first: timingSafeEqual throws on a length mismatch. Constant-time on the equal-length
  // path is what matters — an attacker must not be able to discover a valid token byte by byte.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'token_mismatch' };
  return { ok: true, reason: null };
}

module.exports = { catalogDiff, issueEditToken, verifyEditToken, gateFlagsOf, sha256, SWING_LIMIT, removalDiffOptions, pendingRemovalRows, removalOnlyDiff, removalPhotoChangesOk, fiscalAckWaived };
