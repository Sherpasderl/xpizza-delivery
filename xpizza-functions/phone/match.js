'use strict';
// INTL PHONE S-match (PLAN-intl-phone r2.3 §4 → r1 §5) — full-number phone comparison, replacing the last-8 suffix matches that
// cross countries (+502 9795-0000 and +504 9795-0000 share a suffix). Pure; never logs.
//   storedIdentity(raw)  the CC digits of a STORED / inbound value — byte-for-byte today's whatsapp.normalizePhone (unchanged by
//                        design: a stored '+'+8 stays HN), minus its console.warn (it would log the raw phone). Parity is tested over
//                        the 2,160-shape live corpus. null when it is not a phone.
//   samePhone(a, b)      both identities present AND equal. A null / invalid operand NEVER matches.
//   muteKeyFor(phone)    the auto-mute leaf key: the identity digits ('' when not a phone — the caller skips). Existing last-8 mute
//                        leaves are short-lived (a staff-reply window) and simply EXPIRE; there is NO suffix fallback (plan r1 §5).
const DEFAULT_COUNTRY_CODE = '504';
const { parseSubmitted } = require('./intl');   // whatsapp.js:33 — parity asserted by the corpus test

function storedIdentity(raw) {
  if (!raw) return null;
  let cleaned = String(raw).replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
  if (cleaned.length === 8) cleaned = DEFAULT_COUNTRY_CODE + cleaned;
  if (cleaned.length < 10 || cleaned.length > 15) return null;
  return cleaned;
}

function samePhone(a, b) {
  const x = storedIdentity(a), y = storedIdentity(b);
  return x !== null && x === y;
}

function muteKeyFor(phone) {
  return storedIdentity(phone) || '';
}

// codex r1 #4 — NO LOST MUTES AT DEPLOY. The pre-S-match writer keyed leaves by the last 8 characters (whatsapp_inbound.js @ 8a31e2a3);
// the reader checks that LEGACY leaf too, so a staff mute set just before the deploy still holds after it. The writer writes the
// identity leaf ONLY. A legacy leaf can only suppress inside its own mute window and is pruned by the writer at 6× it, so the
// transition is self-bounding. LATER CLEANUP: drop the legacy read once deploy + 6× the max configured mute window has passed.
function legacyMuteKeyFor(phone) {
  return String(phone == null ? '' : phone).replace(/@c\.us$/, '').slice(-8);
}
// → the mute record to decide on (the latest finite `at` of the identity + legacy leaves), or null. A non-phone never reads the parent
// node. A read error PROPAGATES (onIncomingWhatsApp's existing try is fail-open, unchanged).
// codex r2 #4: NO read is built without a VALID identity (storedIdentity non-null — the same rule the writer keys by), and the legacy
// last-8 leaf is consulted ONLY for a valid HN identity (504 + 8): '123' or a 16-digit string read nothing, and a +1 number never
// reads an HN customer's legacy leaf that happens to share its last 8.
async function readMute(db, restaurantId, phone) {
  const id = storedIdentity(phone);
  if (!id) return null;
  const p = parseSubmitted('+' + id);
  const keys = p && p.cc === '504' ? [id, p.national] : [id];
  const recs = (await Promise.all(keys.map((k) => db.ref(`whatsapp_mute/${restaurantId}/${k}`).once('value').then((s) => s.val())))).filter((r) => r != null);
  if (!recs.length) return null;
  const at = (r) => (r && Number.isFinite(r.at) ? r.at : -Infinity);
  return recs.reduce((best, r) => (at(r) > at(best) ? r : best));
}

module.exports = { storedIdentity, samePhone, muteKeyFor, legacyMuteKeyFor, readMute };
