'use strict';

/**
 * Ready-Time Phase 1 · Step 3 — deps-injected shadow-predictor core (PHASE1_STEP3_SHADOW_PREDICTOR.md rev-3).
 *
 * Orchestrates the PURE decisions (ready-time-predict.js / ready-time-features.js / ready-time-eligibility.js)
 * against an injected `db`, so the emulator F-matrix drives REAL transactions. index.js's two onValueCreated
 * triggers are thin adapters over runPrediction / runLabelAndUpdate.
 *
 * PURE SHADOW — the ONLY writes are order_predictions, prediction_logs, ready_time_model. It NEVER writes
 * /orders, /order_tracking, /tasks, /drivers, /dispatcher_alerts, any push/notification, or config/ready_time.
 * All other refs are `.once('value')` READs. Proven by the denylist API-spy in the F-matrix.
 *
 * deps = { db, now }   (now = a ms number — Date.now() in prod, fixed in tests)
 */
const F = require('./ready-time-features');
const P = require('./ready-time-predict');
const E = require('./ready-time-eligibility');

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const normRid = (rid) => rid || 'x_pizza';
const MS_PER_MIN = 60000;

function resolveCfg(cfg) {
  return { ringN: (cfg && isNum(cfg.ringN)) ? cfg.ringN : P.RING_N, minSamples: (cfg && isNum(cfg.minSamples)) ? cfg.minSamples : P.MIN_SAMPLES, coldStart: (cfg && cfg.coldStart) || {} };
}

// Trigger A — Prediction. Fires per order_events/{orderId}/{eventId}; predicts ONLY when THIS eventId is
// the pickNewEvent winner (the deterministic earliest to:'new'), so A and B anchor on the SAME immutable
// row even under a bounce / two-to:'new' race (a later event can never win the prediction). Writes ONE
// immutable prediction per ACTIVE_MODEL_VERSIONS (transactional create-if-absent → idempotent).
async function runPrediction(deps, { orderId, eventId, cfg }) {
  const { db, now } = deps;
  const c = resolveCfg(cfg);
  const events = (await db.ref(`order_events/${orderId}`).once('value')).val() || {};
  const winner = F.pickNewEventEntry(events);
  if (!winner || winner.id !== eventId) return { skipped: 'not_anchor_event' };  // only the winner predicts
  const event = winner.event;
  const source_event_id = winner.id;
  const restaurant = normRid(event.restaurant_id);
  const new_at = event.at;
  const kla = event.kitchen_load_ahead;

  // Stable composition READ from /orders (never a write); x_pizza only (la_musa external_pos has no items).
  const order = (await db.ref(`orders/${orderId}`).once('value')).val() || {};
  const item_count = Array.isArray(order.items) ? order.items.length : null;

  const features_snapshot = {
    new_at, kitchen_load_ahead: kla ?? null, drivers_available: event.drivers_available ?? null,
    drivers_on_shift: event.drivers_on_shift ?? null, hour_of_day: F.hourOf(new_at), daypart: F.daypartOf(new_at),
    item_count, load_bucket: F.loadBucketOf(kla), item_bucket: F.itemCountBucketOf(item_count),
  };
  const exactKey = F.bucketKeyExact(new_at, kla, item_count);
  const daypartKey = F.bucketKeyDaypart(new_at, kla);

  const written = [];
  for (const v of P.ACTIVE_MODEL_VERSIONS) {
    const modelNode = (await db.ref(`ready_time_model/${restaurant}/${v}`).once('value')).val();
    const pred = P.predictFromModel(modelNode, { restaurant, exactKey, daypartKey, minSamples: c.minSamples, coldStartMin: P.coldStartMin(restaurant, c) });
    const node = {
      predicted_ready_at: new_at + pred.prep_min * MS_PER_MIN, predicted_prep_min: pred.prep_min,
      bucket_key: pred.bucket_key, source: pred.source, sample_count: pred.sample_count,
      model_version: v, restaurant_id: restaurant, new_at, source_event_id, features_snapshot, created_at: now,
    };
    const res = await db.ref(`order_predictions/${orderId}/${v}`).transaction((curr) => (curr === null ? node : undefined));
    if (res.committed) written.push(v);
  }
  return { written, restaurant, source_preview: written.length ? 'created' : 'exists' };
}

// Trigger B — Actual label + model update. Fires on the first-entry ready_at. Write-once log per active
// version (ALWAYS the actual; prediction_missing if A hasn't run; NO backfill). Model rings updated ONLY
// for eligible + timeline-sane x_pizza rows; all three fallback levels maintained (R2-#1).
async function runLabelAndUpdate(deps, { orderId, readyAt, cfg }) {
  const { db, now } = deps;
  if (!isNum(readyAt)) return { skipped: 'no_ready_at' };
  const c = resolveCfg(cfg);

  const events = (await db.ref(`order_events/${orderId}`).once('value')).val() || {};
  const timeline = (await db.ref(`order_timelines/${orderId}`).once('value')).val() || {};
  const order = (await db.ref(`orders/${orderId}`).once('value')).val() || {};
  const eligCfg = (await db.ref('ready_time_config').once('value')).val() || {};

  const newEntry = F.pickNewEventEntry(events);    // the SAME anchor event Trigger A predicted from
  const newEvent = newEntry ? newEntry.event : null;
  const sourceEventId = newEntry ? newEntry.id : null;
  const eventNewAt = newEvent ? newEvent.at : null;
  const kla = newEvent ? newEvent.kitchen_load_ahead : null;
  // Restaurant provenance = the IMMUTABLE event first, mutable /orders only as fallback (aligns B with A,
  // so a la_musa order can never be mislabeled/trained as x_pizza if /orders disagrees or is missing).
  const restaurant = normRid((newEvent && newEvent.restaurant_id) || order.restaurant_id);
  const item_count = Array.isArray(order.items) ? order.items.length : null;

  // Event-anchored order + timeline: new_at is the chosen event.at, restaurant is the event's — threaded
  // through eligibility so the gate judges the same identity the model trains under (R3 + Codex-on-diff #2).
  const anchoredOrder = { ...order, restaurant_id: restaurant };
  const anchored = { ...timeline, new_at: eventNewAt, ready_at: readyAt };
  const prep_new_min = isNum(eventNewAt) ? (readyAt - eventNewAt) / MS_PER_MIN : null;
  const prep_preparing_min = isNum(timeline.preparing_at) ? (readyAt - timeline.preparing_at) / MS_PER_MIN : null;

  // Recompute the MODEL-UPDATE gate here (never a stored flag): isTrainingEligible incl. timeline-sanity.
  const verdict = E.isTrainingEligible(anchoredOrder, anchored, events, eligCfg);
  const eligible = verdict.eligible;

  for (const v of P.ACTIVE_MODEL_VERSIONS) {
    const pred = (await db.ref(`order_predictions/${orderId}/${v}`).once('value')).val();
    const node = {
      actual_ready_at: readyAt, new_at: eventNewAt, source_event_id: sourceEventId, prep_new_min, prep_preparing_min,
      model_version: v, restaurant_id: restaurant, logged_at: now,
    };
    if (!eligible) { node.quarantined = true; node.quarantine_reason = verdict.reasons.join(','); }
    if (pred) {
      node.predicted_ready_at = pred.predicted_ready_at; node.predicted_prep_min = pred.predicted_prep_min;
      node.error_min = isNum(prep_new_min) ? (pred.predicted_prep_min - prep_new_min) : null;
    } else {
      node.prediction_missing = true;
    }
    await db.ref(`prediction_logs/${orderId}/${v}`).transaction((curr) => (curr === null ? node : undefined));
  }

  // Model update — eligible + timeline-sane x_pizza only; maintain ALL THREE fallback rings.
  if (eligible && restaurant === 'x_pizza' && isNum(prep_new_min)) {
    const exactKey = F.bucketKeyExact(eventNewAt, kla, item_count);
    const daypartKey = F.bucketKeyDaypart(eventNewAt, kla);
    const sample = { prep_min: prep_new_min, at: eventNewAt };
    for (const v of P.ACTIVE_MODEL_VERSIONS) {
      const base = `ready_time_model/${restaurant}/${v}`;
      for (const path of [`${base}/exact/${exactKey}`, `${base}/daypart/${daypartKey}`, `${base}/restaurant`]) {
        await db.ref(path).transaction((curr) => P.ringSetP50(curr, orderId, sample, { ringN: c.ringN, now }));
      }
    }
    return { eligible: true, quarantined: false, updated_rings: 3 };
  }
  return { eligible, quarantined: !eligible, updated_rings: 0 };
}

module.exports = { runPrediction, runLabelAndUpdate };
