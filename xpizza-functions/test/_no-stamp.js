'use strict';
// F-1 r2 (Codex r1 P2-1): getEditableCatalog reads the platform-pending stamp FAIL-CLOSED (unreadable ⇒ 503), so a bare `fsdb: {}`
// no longer stands for "no stamp". NO_STAMP answers exactly that one path — restaurants/<rid>/meta/platform_pending — as ABSENT,
// and throws on every other path: as strict as the bare object it replaces (the stamp's own cells live in
// catalog/platform-pending.test.js). One copy, shared by the getEditableCatalogCore suites.
const NO_STAMP = { collection: (c) => { if (c !== 'restaurants') throw new Error(`NO_STAMP: unexpected collection ${c}`);
  return { doc: (rid) => ({ collection: (m) => { if (m !== 'meta') throw new Error(`NO_STAMP: unexpected subcollection ${m}`);
    return { doc: (d) => { if (d !== 'platform_pending') throw new Error(`NO_STAMP: unexpected doc ${d}`);
      return { get: async () => ({ exists: false, data: () => undefined, updateTime: null }) }; } }; } }) }; } };
module.exports = { NO_STAMP };
