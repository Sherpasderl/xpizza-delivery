'use strict';
// S1 (per-dish extras; owner decision 11-11 «the frozen forms keep offering every extra until they retire») — the extras-eligibility
// check is scoped to APP entries: an app request (entry_mode 'app', the ONE isApp rule of delivery-wire) is judged under the runtime
// mode; ANY other request (a form cart) is judged as mode 'off' — today's behaviour, whatever the mode, so a future «enforce» never
// refuses a form cart. Run: node catalog/extras-entry.test.js
const assert = require('assert');
const { modeForEntry } = require('./extras-entry');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
for (const mode of ['off', 'shadow', 'enforce', 'unknown']) {
  assert.strictEqual(modeForEntry(mode, { entry_mode: 'app' }), mode, `XE-APP ${mode}: an app entry is judged under the runtime mode`);
  for (const body of [{}, { entry_mode: 'direct' }, { entry_mode: 'APP' }, null, undefined]) {
    assert.strictEqual(modeForEntry(mode, body), 'off', `XE-FORM ${mode} ${JSON.stringify(body)}: a non-app entry is judged as off`);
  }
}
ok('an app entry keeps the runtime mode; every other entry is judged as off (forms untouched under shadow and enforce)');
console.log(`extras-entry: OK (${n})`);
