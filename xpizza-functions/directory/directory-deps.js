'use strict';
// S7a directory — the production readers, each the ONE shared reader of its value. pricingView is NOT built here: it comes
// from the Sherpa delivery readers (delivery/delivery-pricing.js minBandCents + readPricing promo_label + the coverageKm
// export), wired in ONE later commit on a base that contains both the train and the customer-app line.
const { activityWithSource } = require('../catalog/public-menu');
const { loadSchedule } = require('../schedule/load-schedule');
const { readCustomerAppPlatform } = require('./platform-config');

function makeDirectoryDeps({ rtdb, registry, pricingView, offers = {}, sponsoredDeps = {} }) {
  if (typeof pricingView !== 'function') throw new Error('makeDirectoryDeps: pricingView (the Sherpa delivery readers) is required');
  const activity = activityWithSource(rtdb);
  return {
    readRegistry: () => registry.readNow(),
    readPlatform: () => readCustomerAppPlatform(rtdb),
    activity,
    loadSchedule: (rid) => loadSchedule(rtdb, rid),
    readPresentation: async (rid) => (await rtdb.ref(`restaurants/${rid}/presentation`).once('value')).val(),
    pricingView,
    readStats: async (rid) => (await rtdb.ref(`public_stats/${rid}`).once('value')).val(),   // S-B step 4: the store's published counts
    // the store's live offers as a home-chip hint (advisor 11-14): 3a's ONE flag reader — synchronous, non-blocking (its memo), null when
    // offers are off or on any trouble. `offers` = test seams only (memo / inflight / now); production passes none.
    offerFlag: (rid) => require('../catalog/offers-serve').offerFlagOf(rid, { rtdb, ...offers }),
    // the platform's «Patrocinado» read (3a's Q6, marketing/sponsored-serve): never throws, never awaits (its own week-keyed memo);
    // `sponsoredDeps` = test seams only (memo / inflight / now / switchState)
    sponsored: () => require('../marketing/sponsored-serve').sponsoredOf({ rtdb, ...sponsoredDeps }),
  };
}

module.exports = { makeDirectoryDeps };
