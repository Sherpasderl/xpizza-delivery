'use strict';
/**
 * Pure reconcile core for the driver-freshness dispatch alarm (Driver Tracking Program · Brief C1).
 *
 * THE SAFETY NET: today nothing alarms when a driver's phone actually goes dark (freeze, revoked
 * permission, dead battery) — dispatch only notices by staring at pins. This computes which on-shift
 * drivers have gone silent past a threshold and reconciles the keyed dispatch alerts.
 *
 * Freshness signal = `drivers/<uid>/last_ping` — the SERVER-received timestamp (ServerValue.TIMESTAMP,
 * set on each ingested batch), NOT `last_location_ts` (the device/plugin GPS-fix time). last_ping is what
 * dispatch already stales pins on (XPD.isStalePing) and is clock-consistent with the server's own `now`
 * (both Google server epoch-ms), so "we haven't HEARD from the driver" is measured without device-clock skew.
 * The 90s amber pin stays; this ALARM sits higher (default 180s) so it fires on genuine freezes, not GPS gaps.
 *
 * On-shift = a status that isn't 'off_shift' (canonical — matches countDriverSupply in order-lifecycle.js).
 *
 * Alerts are KEYED at dispatcher_alerts/driver_stale_<uid> (idempotent set/remove), so:
 *   - exactly ONE alert per silence episode — a NEW alert is raised only when a driver crosses the
 *     threshold with no existing alert; a driver already alerted is left untouched (no per-tick re-write/
 *     chime storm);
 *   - it AUTO-CLEARS (remove) when the driver's pings resume, they clock off, or they disappear;
 *   - off-shift drivers never alert.
 *
 * Pure: no I/O, no clock. `now` and `createdAt` are injected (ServerValue.TIMESTAMP in prod; numbers in tests).
 * Returns a keyed updates map RELATIVE to dispatcher_alerts: value = alert object to RAISE, or null to CLEAR.
 */

const ALERT_PREFIX = 'driver_stale_';
const ALERT_TYPE = 'driver_freshness_stale';

// on-shift = has a status and it isn't 'off_shift' (same predicate countDriverSupply uses for drivers_on_shift).
function isOnShift(d) {
  return !!(d && d.status && d.status !== 'off_shift');
}

function computeFreshnessAlerts({ drivers, existingAlerts, now, thresholdMs, createdAt }) {
  // Drivers that SHOULD currently be alarmed: on-shift, have pinged at least once this shift, silent > threshold.
  const stale = new Map();
  for (const [uid, d] of Object.entries(drivers || {})) {
    if (!isOnShift(d)) continue;
    const lastPing = Number(d.last_ping);
    // No usable last_ping ⇒ we've never heard from them this shift ⇒ can't measure a SILENCE (distinct from
    // "was pinging, then went dark"). Skip — the pin already shows absent/stale on the map. (Documented gap.)
    if (!Number.isFinite(lastPing) || lastPing <= 0) continue;
    if (now - lastPing > thresholdMs) stale.set(uid, d);
  }

  // Drivers that currently HAVE a freshness alert (ignore every other alert type in the node).
  const alerted = new Set(
    Object.keys(existingAlerts || {})
      .filter((k) => k.startsWith(ALERT_PREFIX))
      .map((k) => k.slice(ALERT_PREFIX.length))
  );

  const updates = {};
  // RAISE: newly-stale drivers with no existing alert (dedupe ⇒ one alert per episode).
  for (const [uid, d] of stale) {
    if (alerted.has(uid)) continue;
    updates[`${ALERT_PREFIX}${uid}`] = {
      type: ALERT_TYPE,
      driver_id: uid,
      driver_name: d.display_name || d.name || uid,
      last_ping: Number(d.last_ping),
      silent_sec: Math.round((now - Number(d.last_ping)) / 1000),
      created_at: createdAt,
    };
  }
  // CLEAR: existing alerts whose driver recovered / clocked off / disappeared.
  for (const uid of alerted) {
    if (!stale.has(uid)) updates[`${ALERT_PREFIX}${uid}`] = null;
  }
  return updates;
}

module.exports = { computeFreshnessAlerts, isOnShift, ALERT_PREFIX, ALERT_TYPE };
