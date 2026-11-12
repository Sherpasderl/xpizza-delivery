'use strict';
// ENVÍO restaurant limit — CALLERS-PINNED (PLAN-envio-restaurant-limit-r5 §2.1): the ELEVEN runtime invocations of the delivery
// pricing / resume seams, exactly. Nine existing (quoteDelivery ×2, deliveryFor ×2, quoteDeliveryFor ×2, chargeContext ×1, the resume
// guard in chargeContext and at the reward-bound reuse) + two new (the hosted acquire's reuseGuard, chargeOnlineOrder's pre-bookkeeping
// check). Any added or removed call site — in any production file — is RED, so a new path cannot skip the limit silently.
// Run: node delivery/envlim-callers.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
const CALLS = { quoteDelivery: /(?<![A-Za-z_])(?:P\.)?quoteDelivery\(/g, deliveryFor: /(?<![A-Za-z_.])(?:DW\.)?deliveryFor\(/g, quoteDeliveryFor: /(?<![A-Za-z_])(?:DW\.)?quoteDeliveryFor\(/g,
  chargeContext: /(?<![A-Za-z_])(?:DW\.)?chargeContext\(/g, deliveryResumeRefusal: /(?<![A-Za-z_])(?:DW\.)?deliveryResumeRefusal\(/g,
  preBookkeepingRefusal: /(?<![A-Za-z_])(?:DW\.)?preBookkeepingRefusal\(/g, reuseGuard: /(?<![A-Za-z_])reuseGuard\(/g };
const DEF = /(?:async\s+)?function\s+(quoteDelivery|deliveryFor|quoteDeliveryFor|chargeContext|deliveryResumeRefusal|preBookkeepingRefusal)\(/g;
const EXPECTED = {
  'delivery/delivery-wire.js': { quoteDelivery: 2, deliveryResumeRefusal: 1 },
  'index.js': { deliveryFor: 2, quoteDeliveryFor: 2, chargeContext: 1, deliveryResumeRefusal: 4, preBookkeepingRefusal: 1 },   // +2 D4 asm7 gate: the SDK reuse's stored admission (P2, before the bookkeeping) and finishSdk's injected guard (P1, B4)
  'delivery/zone-resume.js': { deliveryResumeRefusal: 1 },   // inside preBookkeepingRefusal (the null-dq route's guard)
  'pixelpay-hosted-charge.js': { reuseGuard: 1 },
};
function prodFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'test' || e.name === 'tools' || e.name === 'contract') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) prodFiles(p, out); else if (/\.js$/.test(e.name) && !/\.test\.js$|\.guard\.test\.js$/.test(e.name)) out.push(p);
  }
  return out;
}
const got = {};
for (const f of prodFiles(ROOT)) {
  const rel = path.relative(ROOT, f); const src = strip(fs.readFileSync(f, 'utf8')).replace(DEF, 'function DEF(');
  for (const [name, re] of Object.entries(CALLS)) { const k = (src.match(re) || []).length; if (k) (got[rel] = got[rel] || {})[name] = k; }
}
assert.deepStrictEqual(got, EXPECTED, `🔴 the delivery seam's caller graph changed:\n${JSON.stringify(got, null, 1)}`);
const total = Object.values(got).reduce((a, m) => a + Object.values(m).reduce((x, y) => x + y, 0), 0);
// 13 call expressions = the plan's 11 invocations: the reuseGuard is ONE invocation written twice (index.js's injected lambda →
// pixelpay-hosted-charge.js's call), and so is the pre-bookkeeping check (index.js → its guard call in delivery/zone-resume.js)
// + D4 (asm7 gate P1/P2): two more invocations, each one call expression in index.js (the SDK path's stored admission, before the
// bookkeeping; B4's injected guard, run by payments/sdk/finish.js through payments/sdk/stored-admission.js)
assert.strictEqual(total, 15, 'fifteen call expressions = thirteen invocations');
console.log(`  ✓ 1 the thirteen-invocation caller graph (${total} call expressions), exactly (nine existing + reuseGuard + the pre-bookkeeping check + D4's SDK stored admission ×2)\nenvlim-callers.guard: OK (1)`);
