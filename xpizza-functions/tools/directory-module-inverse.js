'use strict';
// S7a directory — the test-only MODULE inverse: the directory's changes to catalog/public-menu.js and
// catalog/restaurant-registry.js are purely ADDITIVE (activityWithSource + its export; readNow + its return key).
// unapplyDirectoryModule(name, src) removes exactly those hunks and must return BASE:<module> byte-for-byte
// (directory-wiring.guard), so getPublicMenu's code path and known/ready/refresh are provably untouched.
const BASE = '97a6e822';
const HUNKS = {
  'catalog/public-menu.js': [
    [`// S7a directory (PLAN-capp-S7a-r3 §4): ADDITIVE — the SAME getIdentity and the SAME activity predicate as defaultIsActive,
// plus the identity's source ('fresh' | 'cache') and the identity itself (so the directory reads it once). defaultIsActive
// above is untouched (a paired test asserts identical activity for fresh / cache / failure).
const activityWithSource = (rtdb) => async (rid) => {
  const { getIdentity } = require('../restaurant-config');
  const identity = await getIdentity(rtdb, rid);
  return { active: !!(identity && identity.active), source: (identity && identity._source) || null, identity };
};
`, ''],
    ['defaultIsActive, activityWithSource, assertWholeBody,', 'defaultIsActive, assertWholeBody,'],
  ],
  'catalog/restaurant-registry.js': [
    [`  // S7a directory (PLAN-capp-S7a-r2 §1.2 / r3 §3): ADDITIVE, NON-swallowing read. The same listIds under the same deadline;
  // on success it updates learned/at exactly as refresh() does, and returns the SAME union known() serves
  // (sanitized floor ∪ last-good ∪ fresh) plus freshness evidence. A failure is reported, never hidden.
  // known / ready / refresh are unchanged.
  async function readNow() {
    if (!listIds) return { ok: true, ids: [...new Set([...base, ...learned])], fresh_ids: [], at: now(), fresh: false };
    try {
      const p = Promise.resolve(listIds());
      if (p && typeof p.catch === 'function') p.catch(() => {});
      const fresh = sanitize(await withDeadline(p, deadlineMs, 'registry_read'));
      if (fresh.length) learned = fresh;
      at = now();
      return { ok: true, ids: [...new Set([...base, ...learned])], fresh_ids: fresh, at, fresh: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 160) };
    }
  }

`, ''],
    ['return { known, ready, refresh, readNow, _state:', 'return { known, ready, refresh, _state:'],
  ],
};

function unapplyDirectoryModule(name, src) {
  const hunks = HUNKS[name];
  if (!hunks) throw new Error(`no directory hunks for ${name}`);
  let out = src;
  for (const [now, was] of hunks) {
    const i = out.indexOf(now);
    if (i < 0 || out.indexOf(now, i + 1) >= 0) throw new Error(`directory hunk not found exactly once in ${name}: ${now.slice(0, 60)}`);
    out = out.slice(0, i) + was + out.slice(i + now.length);
  }
  return out;
}

const FILES = Object.freeze(Object.keys(HUNKS));

module.exports = { BASE, HUNKS, FILES, unapplyDirectoryModule };
