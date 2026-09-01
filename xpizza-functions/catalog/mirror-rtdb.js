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
// The RTDB instance URL, pinned. An owner-run CLI that inits with ADC + GOOGLE_CLOUD_PROJECT alone
// CANNOT resolve RTDB — admin.database() throws "Can't determine Firebase Database URL" the moment it
// is called, so a tool would crash before writing anything. index.js pins the same value for the
// deployed functions; it is repeated (not imported) there because the additive guard for this phase
// keeps index.js byte-unchanged.
const RTDB_URL = 'https://xpizza-delivery-default-rtdb.firebaseio.com';

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
module.exports = { makeRtdbMirror, RTDB_URL };
