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
const DISPLAY_SKIP = new Set(['price', 'id']);

const itemsByKey = (built) => new Map(((built && built.items) || []).map((i) => [i.key, i]));
const extrasOf = (built) => ((built && built.extras) || {});

function priceSanity(key, surface, old, next, out) {
  if (!Number.isFinite(next) || next <= 0) { out.push({ key, surface, reason: 'nonpositive', old: old === undefined ? null : old, new: next }); return; }
  if (old === undefined || old === null) { out.push({ key, surface, reason: 'new_priced', old: null, new: next }); return; }
  if (old > 0 && Math.abs(next - old) / old > SWING_LIMIT) out.push({ key, surface, reason: 'swing_gt_50', old, new: next });
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

function catalogDiff(liveBuilt, draftBuilt) {
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

  const itemPairs = pairRenames(rawRemovedItems, rawAddedItems, 'item');
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

module.exports = { catalogDiff, issueEditToken, verifyEditToken, gateFlagsOf, sha256, SWING_LIMIT };
