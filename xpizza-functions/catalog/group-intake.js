'use strict';
// ---------------------------------------------------------------------------
// 1D add-product PHASE B (rev 6, UNIFORM) — the required-choice group RULES at intake / quote / redemption, for EVERY
// brand, decided in one pure place so index.js carries only thin call sites.
//
//   ONLY when the platform RENDER capability is on (catalog/platform-groups.js) — off ⇒ null, no read, no change.
//   From the SAME gate snapshot as the Phase A known-key membership (menu-gates `groups`):
//     • a BARE launcher line is never orderable                                     → 409 choice_required
//     • a BARE launcher as a reward is never redeemable (the requested reward keys) → 409 choice_required
//     • a choice is available only if it AND its launcher are (§0d.4)               → item_unavailable (the existing 86)
//     • an unreadable variant map (groups:null) is UNCLASSIFIABLE, never "no launchers" → retryable 503 menu_updating
//   Cash (createOrder) refuses outright, after the dedupe and before any write or reserve. Card (chargeOnlineOrder) is
//   decided like the Phase A / D4-c4 guards: a FRESH issuance is refused here; anything else (a verified reuse, in
//   progress, terminal) keeps its BOUND snapshot and only ARMS the guard inside acquireHostedAttempt, so a reuse → fresh
//   rotation is still refused there (§0d.1). Parent-86'd choices join cartBlocked, which acquire already enforces the
//   same way.
//
// The parent-availability read happens ONLY when a line or reward is a variant, and keeps today's fail-open: a read
// failure blocks nothing (availability-gate.js semantics).
// ---------------------------------------------------------------------------
const { itemPricingKey } = require('../menu-pricing');
const { availKey } = require('../avail-key');
const availabilityReducer = require('../availability-reducer');

const CHOICE_REQUIRED = Object.freeze({ error: 'choice_required', detail: 'Elegí una opción antes de pedir este producto.' });
const MENU_UPDATING = Object.freeze({ error: 'menu_updating', detail: 'El menú se está actualizando — probá de nuevo en un momento', retryable: true });

// The reward keys a redemption request names (pricing keys on every brand: the request carries the item's key).
function rewardKeysOf(redeem) {
  const out = [];
  if (redeem && Array.isArray(redeem.items)) for (const e of redeem.items) if (e && typeof e.id === 'string' && e.id && !out.includes(e.id)) out.push(e.id);
  if (redeem && typeof redeem.item_id === 'string' && redeem.item_id && !out.includes(redeem.item_id)) out.push(redeem.item_id);
  return out;
}

/* groupIssues({ caps, gates, items, restaurantId, rewardKeys, readAvailability }) → null | { unclassifiable:true } |
   { bare:[keys], rewardBare:[keys], parentBlocked:[labels] }  (null also when there is nothing to object to) */
async function groupIssues({ caps, gates, items, restaurantId, rewardKeys = [], readAvailability = null }) {
  if (!caps || caps.render !== true) return null;
  if (!gates || gates.groups == null) return { unclassifiable: true };
  const { launchers, parentOf } = gates.groups;
  /* codex PB-1 r1 P1-1 — a REWARD key is classified by the SAME snapshot as the paid lines: it must be a key this snapshot
     KNOWS (a dish, or an extra — la_musa's acompañamientos are redeemable), or the whole request is unclassifiable
     (menu_updating). Without this a reward naming a product added after the snapshot — e.g. a new launcher while the gate
     pointer read fails and the code fallback is in force — escaped every group rule and redeemed at its stored price. */
  const knownDish = gates.known instanceof Set ? gates.known : null;
  const knownExtra = gates.knownExtras instanceof Set ? gates.knownExtras : null;
  if (rewardKeys.length && (!knownDish || !knownExtra || rewardKeys.some((k) => !knownDish.has(k) && !knownExtra.has(k)))) return { unclassifiable: true };
  const lines = (Array.isArray(items) ? items : []).map((it) => ({ it, key: itemPricingKey(it, restaurantId) })).filter((l) => typeof l.key === 'string' && l.key);
  const bare = [...new Set(lines.filter((l) => launchers.has(l.key)).map((l) => l.key))];
  const rewardBare = rewardKeys.filter((k) => launchers.has(k));
  // parent-or-variant: one availability read, only when some line or reward has a launcher
  const parentBlocked = [];
  const variantLines = lines.filter((l) => parentOf.has(l.key));
  const variantRewards = rewardKeys.filter((k) => parentOf.has(k));
  if ((variantLines.length || variantRewards.length) && typeof readAvailability === 'function') {
    let node = null;
    try { node = await readAvailability(); } catch (e) { node = null; }   // fail-open, exactly as today
    if (node && typeof node === 'object') {
      const down = (k) => availabilityReducer.decide([node[availKey(k)]], 'any_false');
      for (const l of variantLines) {
        if (down(parentOf.get(l.key))) {
          const label = (l.it && l.it.name != null && l.it.name !== '') ? String(l.it.name) : String(l.key);
          if (!parentBlocked.includes(label)) parentBlocked.push(label);
        }
      }
      for (const k of variantRewards) if (down(parentOf.get(k)) && !parentBlocked.includes(k)) parentBlocked.push(k);
    }
  }
  if (!bare.length && !rewardBare.length && !parentBlocked.length) return null;
  return { bare, rewardBare, parentBlocked };
}

// CASH: refuse outright (no reuse concept: an existing order already returned at the dedupe).
function cashRefusal(issues) {
  if (!issues) return null;
  if (issues.unclassifiable) return { status: 503, retryAfter: 2, body: { ...MENU_UPDATING } };
  if (issues.bare.length || issues.rewardBare.length) return { status: 409, body: { ...CHOICE_REQUIRED, keys: [...issues.bare, ...issues.rewardBare] } };
  if (issues.parentBlocked.length) return { status: 400, body: { error: 'item_unavailable', blocked: issues.parentBlocked } };
  return null;
}

/* CARD: chargePreGate semantics (order-control-state.js) over the preliminary classification `cls`:
   cls null (the classifier failed) ⇒ retryable 503 (a retry re-classifies); a FRESH issuance ⇒ refuse; anything else ⇒
   honour it, arming the matching guard. Returns { respond?, armChoice, armMenu, block:[labels] }. */
function chargeDecision(issues, cls) {
  const none = { respond: null, armChoice: false, armMenu: false, block: [] };
  if (!issues) return none;
  const fresh = cls && cls.willIssueFreshUrl === true;
  if (issues.unclassifiable) {
    if (!cls || fresh) return { ...none, respond: { status: 503, retryAfter: 2, body: { ...MENU_UPDATING } } };
    return { ...none, armMenu: true };
  }
  const choice = issues.bare.length || issues.rewardBare.length;
  if (choice) {
    if (!cls) return { ...none, respond: { status: 503, retryAfter: 2, body: { ...MENU_UPDATING } } };
    if (fresh) return { ...none, respond: { status: 409, body: { ...CHOICE_REQUIRED, keys: [...issues.bare, ...issues.rewardBare] } } };
    return { ...none, armChoice: true, block: issues.parentBlocked.slice() };
  }
  return { ...none, block: issues.parentBlocked.slice() };   // acquire refuses a fresh/rotated issuance on a blocked cart
}

// QUOTES (quoteOrder fails SOFT with 200 ok:false; quoteRedemption answers like the redemption intake).
function quoteRefusal(issues) {
  if (!issues) return null;
  if (issues.unclassifiable) return { error: 'menu_updating' };
  if (issues.bare.length || issues.rewardBare.length) return { error: 'choice_required' };
  if (issues.parentBlocked.length) return { error: 'item_unavailable', blocked: issues.parentBlocked };
  return null;
}

/* codex PB-1 r1 P1-3 (precedence): when the card path's redemption PREPARATION has already failed, a reward that is a bare
   launcher answers 409 choice_required (and an unclassifiable reward 503 menu_updating) instead of the preparation's own
   error (e.g. redemption_invalid). Consulted ONLY on that failure path, so nothing that succeeds today changes. */
function prepFailureRefusal(issues) {
  if (!issues) return null;
  if (issues.unclassifiable) return { status: 503, retryAfter: 2, body: { ...MENU_UPDATING } };
  if (issues.rewardBare.length) return { status: 409, body: { ...CHOICE_REQUIRED, keys: issues.rewardBare.slice() } };
  return null;
}
module.exports = { groupIssues, cashRefusal, chargeDecision, quoteRefusal, prepFailureRefusal, rewardKeysOf, CHOICE_REQUIRED };
