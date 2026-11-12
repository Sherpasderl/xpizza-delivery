'use strict';
// S3 (PLAN-structure-S3-r3 §1a, §1c, §2) — THE activation classifier for the required choice. ONE pure judgment of a RESULTING
// built snapshot (target) against the one it replaces (baseline), run by every path that moves the menu: save (target = the
// draft, baseline = the active version), publish and a manager's publish request (the same pair, re-judged), rollback (baseline =
// the version named by the flip's expected.activeVersionId — the pointer the CAS actually replaces — target = the rolled-to version).
// It never reads the op list: whatever wrote the target, the same rules hold. Gated on choiceEdit (OFF → null: today's rules only).
//   choice_index_invalid (409)       a group index that cannot be read as written, on EITHER side — never "no groups" (fail closed)
//   choice_on_reward_dish (409)      owner 11-12: an EXISTING dish (a pricing key in the baseline) that gains a group, when the
//                                    restaurant has a redemption model and the dish is redeemable in the target OR the baseline
//                                    (catalog-edit gateFlagsOf — the live gates' own derivation). A dish absent from the baseline
//                                    is NEW and allowed (Q3). Not gated on config/redemption_enabled (advisor 11-12).
//   choice_recommended_required / _many (409)   a TOUCHED group carries exactly one 'recommended' option after the change.
//                                    Touched = new, label changed, membership changed, an option's choice text or mark changed.
//                                    A price change alone touches nothing (P2-4); an untouched legacy group keeps zero.
//   choice_price_from_invalid (409)  a group removed from a dish that stays: its new price is one of that group's option prices.
// Keys and display ids: groups are keyed by display id; this module asks group-index.js (the one join) and works in PRICING KEYS.
const { groupIndexFrom } = require('./group-index');
const { gateFlagsOf } = require('./catalog-edit');
const { AddProductError } = require('./add-product');
const { REDEMPTION_CONFIG } = require('../rewards-redeem-config');

const TAG = 'recommended';
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const refuse = (code, detail, key = null) => { throw new AddProductError(code, detail, { status: 409, field: 'choices', key }); };

// THE touched-group rule (§2), the ONE definition the classifier and the review diff share: a group in the target that is new, or whose
// label, membership, an option's choice text or an option's mark changed. A price change alone touches nothing (P2-4).
function isTouched(ib, it, baseline, target, bItems, tItems, k) {
  if (!ib.launchers.has(k)) return true;
  const tm = membersOf(it, k); const bm = membersOf(ib, k);
  const bs = specOf(baseline, k) || {}; const ts = specOf(target, k) || {};
  return bs.label !== ts.label || bm.length !== tm.length || bm.some((v, i) => v !== tm[i])
    || tm.some((v) => { const a = bItems.get(v); const b = tItems.get(v); return !a || (a.display || {}).choice !== (b.display || {}).choice || marked(a) !== marked(b); });
}

// An S3 edit is present (the review diff's switch, §4; Codex build r1 P2-3) iff an EXISTING dish's group is touched by the rule above, or an
// existing dish lost its group (D3). A dish new to the menu is an addition (today's diff). false when either index cannot be read.
function s3EditPresent({ baseline, target }) {
  const ib = groupIndexFrom(baseline); const it = groupIndexFrom(target);
  if (!ib.ok || !it.ok) return false;
  const bItems = new Map(baseline.items.map((i) => [i.key, i])); const tItems = new Map(target.items.map((i) => [i.key, i]));
  for (const k of it.launchers) if (bItems.has(k) && isTouched(ib, it, baseline, target, bItems, tItems, k)) return true;
  for (const k of ib.launchers) if (!it.launchers.has(k) && tItems.has(k)) return true;
  return false;
}

function membersOf(index, launcherKey) {
  const out = [];
  for (const [v, l] of index.parentOf) if (l === launcherKey) out.push(v);
  return out.sort();
}
function specOf(built, launcherKey) {
  const it = built.items.find((i) => i.key === launcherKey);
  const vi = isObj(built.structure.variant_items) ? built.structure.variant_items : {};
  return it && isObj(it.display) ? vi[String(it.display.id)] : undefined;
}
const marked = (it) => !!(it && isObj(it.display) && Array.isArray(it.display.tags) && it.display.tags.includes(TAG));

function choiceActivation({ rid, baseline, target, choiceEdit }) {
  if (!choiceEdit) return null;
  const ib = groupIndexFrom(baseline);
  const it = groupIndexFrom(target);
  if (!ib.ok) refuse('choice_index_invalid', 'the live menu\'s choice groups cannot be read');
  if (!it.ok) refuse('choice_index_invalid', 'the edited menu\'s choice groups cannot be read');
  const bItems = new Map(baseline.items.map((i) => [i.key, i]));
  const tItems = new Map(target.items.map((i) => [i.key, i]));

  // §1a — an EXISTING reward dish never gains a group
  if (REDEMPTION_CONFIG[rid]) {
    const fb = gateFlagsOf(baseline); const ft = gateFlagsOf(target);
    for (const k of it.launchers) {
      if (!bItems.has(k) || ib.launchers.has(k)) continue;   // new to the menu (Q3) or already a group
      if ((ft.get(k) || {}).redeem_eligible || (fb.get(k) || {}).redeem_eligible) {
        refuse('choice_on_reward_dish', `"${(tItems.get(k).display || {}).name}" is redeemable as a reward, so it cannot gain a required choice`, k);
      }
    }
  }

  // §2 — exactly one «Recomendada» per TOUCHED group
  for (const k of it.launchers) {
    const tm = membersOf(it, k);
    if (!isTouched(ib, it, baseline, target, bItems, tItems, k)) continue;
    const count = tm.filter((v) => marked(tItems.get(v))).length;
    if (count === 0) refuse('choice_recommended_required', `choose the «Recomendada» option of "${(tItems.get(k).display || {}).name}"`, k);
    if (count > 1) refuse('choice_recommended_many', `only one option of "${(tItems.get(k).display || {}).name}" can be «Recomendada»`, k);
  }

  // §2 — a removed group: the dish's price comes from one of its options (price_from)
  for (const k of ib.launchers) {
    if (it.launchers.has(k) || !tItems.has(k)) continue;
    const prices = new Set(membersOf(ib, k).map((v) => bItems.get(v).price));
    if (!prices.has(tItems.get(k).price)) refuse('choice_price_from_invalid', `"${(tItems.get(k).display || {}).name}" takes the price of one of its options`, k);
  }
  return null;
}

// The review rows (§4): one per EXISTING dish whose group changed — its label, its membership, its «Recomendada» option(s), or the
// dish gaining (became: 'launcher') / losing (became: 'plain') its group. A price-only change is no row. A dish new to the menu is
// an addition (today's diff). [] when either index cannot be read (the judgment refuses that draft before any token).
function choiceRows({ baseline, target }) {
  const ib = groupIndexFrom(baseline); const it = groupIndexFrom(target);
  if (!ib.ok || !it.ok) return [];
  const bItems = new Map(baseline.items.map((i) => [i.key, i]));
  const tItems = new Map(target.items.map((i) => [i.key, i]));
  const markedOf = (index, items, k) => membersOf(index, k).filter((v) => marked(items.get(v)));
  const rows = [];
  for (const k of [...new Set([...ib.launchers, ...it.launchers])].sort()) {
    if (!bItems.has(k) || !tItems.has(k)) continue;
    const inB = ib.launchers.has(k); const inT = it.launchers.has(k);
    const row = { launcher: k, name: (tItems.get(k).display || {}).name };
    if (!inB) row.became = 'launcher';
    if (!inT) row.became = 'plain';
    const bl = inB ? (specOf(baseline, k) || {}).label : null; const tl = inT ? (specOf(target, k) || {}).label : null;
    if (bl !== tl) row.label = { old: bl === undefined ? null : bl, new: tl === undefined ? null : tl };
    const bm = inB ? membersOf(ib, k) : []; const tm = inT ? membersOf(it, k) : [];
    const added = tm.filter((v) => !bm.includes(v)); const removed = bm.filter((v) => !tm.includes(v));
    if (added.length || removed.length) row.members = { added, removed };
    const br = inB ? markedOf(ib, bItems, k) : []; const tr = inT ? markedOf(it, tItems, k) : [];
    if (JSON.stringify(br) !== JSON.stringify(tr)) row.recommended = { old: br, new: tr };
    if (Object.keys(row).length > 2) rows.push(row);
  }
  return rows;
}

module.exports = { choiceActivation, choiceRows, s3EditPresent, TAG };
