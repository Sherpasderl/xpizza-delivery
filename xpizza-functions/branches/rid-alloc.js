'use strict';
// ORCHESTRATION O1a (PLAN-multi-location-orchestration r3.1 §2.3) — branch rid allocation + branch-name reservation keys. Pure.
//   ridCandidates(brandId, locationName, count) → the DETERMINISTIC candidate sequence `base_slug`, `base_slug_2`, … `_999`;
//   the writer (branch-store) persists the candidate it is about to reserve and walks this sequence only forward (§2.2).
//   Every candidate is valid under BOTH id grammars: F1 `isBrandId` (/^[a-z0-9_]{1,40}$/, not all digits, not reserved) and the
//   registry / portal RID_RE (/^[a-z0-9][a-z0-9_-]{1,39}$/).
//   nameKey(locationName) → the RTDB key under brand_branch_names/{brand}/ that makes a branch name unique within its brand:
//   case-, accent- and spacing-insensitive; a symbol-only name is keyed by a hash (never collides with another symbol name).
const crypto = require('crypto');

const BASE_MAX = 20;
const SLUG_MAX = 15;
const SUFFIX_MAX = 999;

const fold = (s) => String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const runs = (s) => s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function ridBase(brandId) {
  const b = String(brandId || '').replace(/^_+/, '').slice(0, BASE_MAX).replace(/_+$/, '');
  return b || 'b';
}

function ridSlug(locationName) {
  const s = runs(fold(locationName)).slice(0, SLUG_MAX).replace(/_+$/, '');
  return s || 'sucursal';
}

function ridCandidates(brandId, locationName, count = SUFFIX_MAX) {
  const stem = `${ridBase(brandId)}_${ridSlug(locationName)}`;
  const out = [stem];
  for (let i = 2; out.length < Math.min(count, SUFFIX_MAX); i += 1) out.push(`${stem}_${i}`);
  return out;
}

function nameKey(locationName) {
  const norm = fold(locationName).trim().replace(/\s+/g, ' ');
  const k = runs(norm).slice(0, 48);
  if (k) return k;
  return `n_${crypto.createHash('sha256').update(String(locationName == null ? '' : locationName).normalize('NFC').trim().toLowerCase()).digest('hex').slice(0, 24)}`;
}

module.exports = { ridCandidates, ridBase, ridSlug, nameKey, BASE_MAX, SLUG_MAX, SUFFIX_MAX };
