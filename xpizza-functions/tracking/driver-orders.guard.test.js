'use strict';
// TRACKER FIXES (PLAN-tracker-fixes r2.5 §1 Step 3) — the server's copy of the driver app's getDriverOrders + enums must stay
// BYTE-IDENTICAL to the SDK: the recompute only ever claims "live" for the order the driver app shows as its active card, so a
// drifted copy would make the tracker and the driver app disagree. Extracts both from the SDK sources and compares.
// Run: node tracking/driver-orders.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
function balanced(src, start) {
  const open = src.indexOf('{', start); let depth = 0;
  for (let k = open; k < src.length; k += 1) {
    if (src[k] === '{') depth += 1;
    else if (src[k] === '}') { depth -= 1; if (depth === 0) return src.slice(start, k + 1); }
  }
  throw new Error('unbalanced');
}
const between = (src, a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, `markers ${a} … ${b}`); return src.slice(i + a.length, j).trim(); };

const sdk = read('xpizza-driver/xpizza-delivery.js');
const dc = read('xpizza-driver/driver-complete.js');
const copy = read('xpizza-functions/tracking/driver-orders.js');

const sdkFn = balanced(sdk, sdk.indexOf('export function getDriverOrders(')).replace('export function', 'function');
const copyFn = between(copy, '// ── BEGIN COPY: getDriverOrders (xpizza-delivery.js) ──', '// ── END COPY: getDriverOrders ──');
assert.strictEqual(copyFn, sdkFn, '🔴 tracking/driver-orders.js getDriverOrders differs from the driver SDK — re-copy it');

// the SDK imports its enums from driver-complete.js (xpizza-delivery.js:57): follow that import
assert.match(sdk, /import \{[^}]*TASK_STATUS[^}]*TASK_TYPE[^}]*\} from '\.\/driver-complete\.js';/, 'the SDK still takes TASK_STATUS/TASK_TYPE from driver-complete.js');
const enumOf = (src, name) => balanced(src, src.indexOf(`export const ${name} = {`)).replace('export const', 'const') + ';';
const copyEnums = between(copy, '// ── BEGIN COPY: enums (driver-complete.js) ──', '// ── END COPY: enums ──');
assert.strictEqual(copyEnums, `${enumOf(dc, 'TASK_STATUS')}\n\n${enumOf(dc, 'TASK_TYPE')}`, '🔴 the copied enums differ from driver-complete.js');

// non-vacuity: a one-character drift in the SDK text would be caught
assert.notStrictEqual(sdkFn.replace('phaseRank[a.phase]', 'phaseRank[b.phase]'), copyFn, 'mutation sensitivity');
console.log('driver-orders.guard: OK (getDriverOrders + TASK_STATUS/TASK_TYPE byte-identical to the driver SDK)');
