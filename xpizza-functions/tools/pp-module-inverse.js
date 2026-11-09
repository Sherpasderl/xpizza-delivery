'use strict';
// F-1 platform-pending stamp (portal-ui 376eeb8f, parked line 06e236b0) — the MODULE inverse for catalog/reset-draft.js (train asm3/asm4,
// 2e). pp-inverse.js covers only the portal/functions.js fold; F-1's three reset-draft.js hunks (the platform-pending require, the
// `alertMalformed` dependency, the refusal block) had no inverse, so S1a's base pins (keymode / frozenkeys wiring guards, which pin
// catalog/reset-draft.js to their own bases) went RED once both landed. F-1 is the NEWER layer: those pins peel it FIRST (innermost).
// Each hunk must occur exactly once; any other file passes through untouched.
const HUNKS = Object.freeze([
 { "file": "catalog/reset-draft.js", "now": "const PS = require('../photos/photo-state');   // DISH PHOTOS A2: the three-state vocabulary (pure)\nconst { resolvePlatformPending } = require('./platform-pending');   // F-1 (2026-11-07): Sherpa-written draft fields are never reset away\n",
   "was": "const PS = require('../photos/photo-state');   // DISH PHOTOS A2: the three-state vocabulary (pure)\n" },
 { "file": "catalog/reset-draft.js", "now": "async function resetDraftToLiveCore({ db, authorize, readActiveVersionId, previewVersion, toPrecondition = (v) => v, readActivePhotos = null, attach = null, alertMalformed = null }, body, req) {\n",
   "was": "async function resetDraftToLiveCore({ db, authorize, readActiveVersionId, previewVersion, toPrecondition = (v) => v, readActivePhotos = null, attach = null }, body, req) {\n" },
 { "file": "catalog/reset-draft.js", "now": "    return reply(500, { error: 'projection_invalid', detail: String((e && e.message) || e).slice(0, 200) });\n  }\n\n  /* F-1 (BRIEF-portal-stale-draft-clobber, ruled 2026-11-07) — a draft carrying fields a SHERPA tool wrote (the platform-pending\n     stamp) that live does not carry yet is NOT the merchant's to throw away: going back to live would silently discard them (the\n     11-02 loss). Refused until live carries them; a draft that merely differs from live (a rollback) still resets — the stamp,\n     not the difference, decides. Live already carrying every stamped field clears the stamp here. Fails CLOSED. */\n  let pend;\n  try { pend = await resolvePlatformPending(db, rid, projected); } catch (e) { return reply(503, { error: 'store_unavailable', retryable: true }); }\n  if (pend.pending) {\n    // a malformed stamp: still refused (fail closed), and never silent — the one deduped owner alert (best effort)\n    if (pend.malformed && alertMalformed) { try { await alertMalformed(rid); } catch (e) { console.error('platform_pending_alert_failed', JSON.stringify({ rid })); } }\n    return reply(409, { error: 'platform_changes_pending', detail: 'Sherpa is updating this menu; the draft cannot be reset until that update is published', fields: pend.fields });\n",
   "was": "    return reply(500, { error: 'projection_invalid', detail: String((e && e.message) || e).slice(0, 200) });\n" }
]);
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);
function unapplyPpModule(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`pp-module-inverse: ${file}: an F-1 hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
module.exports = { HUNKS, FILES, unapplyPpModule };
