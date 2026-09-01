'use strict';
// Phase 1d Stage 1b — the RTDB mirror writer.
//
// The mirror is the Firestore-INDEPENDENT disaster fallback: if Firestore is unreachable, Stage 2 can
// still price from RTDB. It is therefore SELF-DESCRIBING — it carries its own `version` witness, so a
// reader never has to consult Firestore to know which version it is holding (which would defeat the
// whole point of a Firestore-independent fallback).
//
// Written at `/catalog_snapshot/{restaurantId}`. Server-only: no client rule grants access to that
// subtree, so it is default-denied exactly like /rate_limits.
function makeRtdbMirror(rtdb) {
  return async function mirrorToRtdb(restaurantId, payload) {
    await rtdb.ref(`catalog_snapshot/${restaurantId}`).set({
      version: payload.version,
      rid: payload.rid,
      menu: payload.menu,
      extras: payload.extras,
      at: Date.now(),        // wall-clock stamp for staleness triage; the VERSION is the authority
    });
  };
}
module.exports = { makeRtdbMirror };
