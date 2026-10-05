'use strict';
// ── availabilityReducer — the ONE 86 decision rule (Portal 1D · D4-b, PLAN-D4b §C) ──────────────────
//
// Every reader of /restaurants/{rid}/item_availability decides through this module: the server intake
// gate (availability-gate.js), BOTH order forms (isSoldOut) and the KDS (isItemOff). Each reader keeps its
// OWN candidate key set — the server its current pricing key, a form its page-local key history, the KDS
// its manifest key — and hands this module the ENTRIES found under those keys. This module decides; it
// never chooses keys and never reads storage.
//
// TWO MODES, and only one is live:
//   • 'any_false'   — ACTIVE in D4-b. Exactly today's rule at every reader: an explicit
//                     `available === false` under ANY candidate key → sold out; absent / true / malformed
//                     → available. Byte-identical decisions are pinned by frozen goldens of the four
//                     pre-D4-b readers (catalog/d4b-availability-parity.golden.json), mixed historical
//                     keys included: {false@100, true@200} stays SOLD OUT here.
//   • 'newest_wins' — IMPLEMENTED + TESTED, INACTIVE (its activation is D4-c, behind PLAN-D4b §C.4).
//                     Over COMMITTED entries only. A valid timestamp is a finite non-negative integer
//                     (ms). Among valid-timestamp entries the maximum `updated_at` wins; ≥2 entries tied at
//                     that maximum with different values → sold out; a `false` with an invalid/missing
//                     timestamp → sold out; a `true` with an invalid timestamp → ignored; nothing → available.
//
// A whole-node READ FAILURE is not this module's concern: each reader keeps its own fail-open path,
// unchanged. NEVER THROWS — a reader that throws here would fail open at its own catch, silently.
//
// UMD-lite (the avail-key.js pattern): NO `export` keyword, so the same bytes are a CommonJS module for the
// server and a classic <script> for the KDS and forms (window.availabilityReducer). The surface copies
// (xpizza-orders/, la-musa-orders/, xpizza-kitchen/) must be byte-identical to THIS file; the drift test
// fails the build otherwise.
var AVAILABILITY_MODES = ['any_false', 'newest_wins'];

function availabilityEntryOff(e) { return !!e && typeof e === 'object' && e.available === false; }
function availabilityEntryOn(e) { return !!e && typeof e === 'object' && e.available === true; }
function availabilityValidTs(t) { return typeof t === 'number' && isFinite(t) && Math.floor(t) === t && t >= 0; }

// decide(entries, mode) → true when SOLD OUT. `entries` = the values found under the reader's candidate
// keys (undefined where a key has none). An unknown mode decides as 'any_false' (today's rule), never open.
function availabilityDecide(entries, mode) {
  try {
    var list = Array.isArray(entries) ? entries : [];
    if (mode !== 'newest_wins') {
      for (var i = 0; i < list.length; i += 1) if (availabilityEntryOff(list[i])) return true;
      return false;
    }
    var best = -1, bestOff = false, bestOn = false;
    for (var j = 0; j < list.length; j += 1) {
      var e = list[j];
      var off = availabilityEntryOff(e), on = availabilityEntryOn(e);
      if (!off && !on) continue;                                  // no information
      var ts = e.updated_at;
      if (!availabilityValidTs(ts)) { if (off) return true; continue; }   // invalid false → sold out; invalid true → ignored
      if (ts > best) { best = ts; bestOff = off; bestOn = on; }
      else if (ts === best) { bestOff = bestOff || off; bestOn = bestOn || on; }
    }
    if (best < 0) return false;                                   // no valid entries → available
    if (bestOff && bestOn) return true;                           // tie at the maximum with differing values
    return bestOff;
  } catch (_) {
    return true;   // unreachable over JSON values; were it reached, doubt is SOLD OUT, never a silent open
  }
}

// ── The PENDING overlay — newest_wins ONLY (dormant; PLAN-D4b §C.3) ────────────────────────────────
// In 'any_false' mode the KDS keeps its existing optimistic / subscription / revert machinery UNCHANGED and
// never calls this. In 'newest_wins' a toggle in flight is shown as pending over the committed entries
// until the write is acknowledged (a committed entry at or after the pending time carrying the pending
// value) or rejected (dropped; the committed state shows again).
function createAvailabilityOverlay() {
  var pending = {};
  return {
    set: function (key, available, at) { pending[key] = { available: available === true, at: at }; },
    reject: function (key) { delete pending[key]; },
    has: function (key) { return Object.prototype.hasOwnProperty.call(pending, key); },
    // view(key, committedEntries) → SOLD OUT?  Settles an acknowledged pending entry as a side effect.
    view: function (key, committed) {
      var p = pending[key];
      if (p) {
        var list = Array.isArray(committed) ? committed : [];
        for (var i = 0; i < list.length; i += 1) {
          var e = list[i];
          if (e && typeof e === 'object' && e.available === p.available && availabilityValidTs(e.updated_at) && e.updated_at >= p.at) {
            delete pending[key]; p = null; break;
          }
        }
      }
      if (p) return !p.available;
      return availabilityDecide(committed, 'newest_wins');
    },
  };
}

(function (root) {
  var api = { decide: availabilityDecide, createOverlay: createAvailabilityOverlay, MODES: AVAILABILITY_MODES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.availabilityReducer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
