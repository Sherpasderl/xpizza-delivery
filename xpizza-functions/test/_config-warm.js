'use strict';
/* CONFIG-READER WARMING for the trace / call-sequence suites: the request-path CONFIG caches are put in a KNOWN state —
 * freshly read, recorder OFF — right before every recorded request, never left to wall time.
 *
 * 🔴 WHY. index.js builds two more per-instance TTL readers on the default clock `Date.now`, beside the catalog caches that
 * test/_catalog-clock.js already controls (R1c): the client floor (client-floor.js createFloorReader, 30 s —
 * platform_config/client_floor/<app>) and the extras mode (catalog/extras-intake.js createExtrasModeReader, 30 s —
 * platform_config/extras_eligibility). A trace suite running past a TTL under load records the re-read in whichever late
 * case crosses it, and its frozen golden (read inside the warm window at capture) then differs: order-exists went RED
 * 3/6 under load with exactly one extra `get platform_config/client_floor/orders` or `once platform_config/extras_eligibility`
 * at the head / middle of a random case (oe-flake evidence, 2026-10-16; latency jitter reproduced it 2/2).
 *
 * HOW, with no production edit. Both factories take `now` as an option and index.js passes none; both build lazily through
 * their module object (CF.createFloorReader / EI.createExtrasModeReader inside clientFloorReader() / extrasModeReader()), so
 * install() wraps the module exports before the first request. The injected clock is the REAL clock plus a monotone BUMP:
 * both readers use `now` for cache AGE only (their read deadlines are setTimeout), so a bump only ages the cache. warm()
 * raises the bump past every TTL and calls each live reader once — a fresh read, OUTSIDE the recording — so the cache is
 * full-TTL fresh for the request that follows, and a floor / mode the test just wrote is the one the request sees.
 * Each wrapper REFUSES a caller that passes `now` itself (the hook would override production wiring) and keeps the
 * instance it built; warm() refuses to run if a reader was built more than once (an unhooked second instance).
 */
const path = require('path');

const FN = path.join(__dirname, '..');
const BUMP_MS = 24 * 3600 * 1000;   // larger than any of these TTLs (and the extras max-stale window)

function install() {
  let bump = 0;
  const now = () => Date.now() + bump;
  const live = { floor: [], extras: [] };
  const hook = (rel, name, slot) => {
    const mod = require(path.join(FN, rel));
    const real = mod[name];
    if (typeof real !== 'function') throw new Error(`config-warm: ${rel}.${name} is not a function — the hook list is stale`);
    mod[name] = function configWarmHooked(opts = {}) {
      if (opts && opts.now !== undefined) throw new Error(`config-warm: ${name} was passed 'now' by its caller — the hook would override production wiring`);
      const r = real({ ...opts, now });
      live[slot].push(r);
      return r;
    };
  };
  hook('client-floor', 'createFloorReader', 'floor');
  hook('catalog/extras-intake', 'createExtrasModeReader', 'extras');
  return {
    // put every live config reader in a KNOWN state: freshly read now, with the recorder OFF (the caller's job)
    async warm({ floorApps = ['orders'] } = {}) {
      for (const k of Object.keys(live)) if (live[k].length > 1) throw new Error(`config-warm: ${k} reader built ${live[k].length}× — one per process expected`);
      bump += BUMP_MS;
      for (const r of live.floor) for (const app of floorApps) await r.floorFor(app);
      for (const r of live.extras) await r.getMode();
    },
    built: () => ({ floor: live.floor.length, extras: live.extras.length }),
  };
}

module.exports = { install };
