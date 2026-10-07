// PORTAL SPEED P1 (PLAN-portal-speed rev 3 §1) — the LAZY stats keyer singleton + the ONE live cache, moved VERBATIM
// from index.js. Shared by getSalesStats (portal/functions.js) and rollupDailyStats (index.js): one instance per
// process. The secret is still read lazily, on first use — never at load or discovery. Sloppy mode on purpose.
const { makeLiveCache } = require('./stats-api');
const { loadStatsSecret, makeCustomerKeyer } = require('./stats-identity');
let _statsKeyer = null;
const statsKeyer = () => (_statsKeyer || (_statsKeyer = makeCustomerKeyer(loadStatsSecret())));
const _statsLiveCache = makeLiveCache();

module.exports = { statsKeyer, _statsLiveCache };
