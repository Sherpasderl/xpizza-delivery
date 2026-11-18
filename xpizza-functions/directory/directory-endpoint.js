'use strict';
// PLAN-directory-endpoint-r0 (advisor GO 11-13) — getRestaurantDirectory's handler: the capp's public directory (GET only; the
// directory-2 allowlist; registered AND active restaurants only; a complete body ETag'd + public max-age=30, a partial one no-store —
// directory.handleDirectory). Its deps are the production readers (directory-deps) with the pricing view on the quote's own read
// (pricing-view), built ONCE per instance, lazily (index.js wires this file on one line; nothing is read at load).
const { handleDirectory } = require('./directory');
const { makeDirectoryDeps } = require('./directory-deps');
const { makePricingView } = require('./pricing-view');

function makeDirectoryEndpoint({ getDatabase, restaurantRegistry }) {
  let deps = null;
  const depsOf = () => deps || (deps = makeDirectoryDeps({ rtdb: getDatabase(), registry: restaurantRegistry(), pricingView: makePricingView({ rtdb: getDatabase() }) }));
  return async function getRestaurantDirectory(req, res) {
    res.set('Vary', 'Origin');   // a cache that varies by origin is told so on every answer (getPublicMenu's rule)
    return handleDirectory(req, res, depsOf());
  };
}

module.exports = { makeDirectoryEndpoint };
