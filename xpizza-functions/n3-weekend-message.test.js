'use strict';
// N3 — surface the weekend_only rejection (client-only, both forms). The dispatch is inline in the form HTML,
// so lock the branch presence + copy + byte-parallelism + sibling-branch integrity in source. Run: node n3-weekend-message.test.js
const fs = require('fs');
const assert = require('assert');
const path = require('path');

const HINT = ' Quitá la pizza de 18" del carrito para continuar.';
const FALLBACK = 'Las pizzas de 18" solo están disponibles viernes, sábado y domingo.';
const FORMS = {
  'la-musa': { file: path.join(__dirname, '..', 'la-musa-orders', 'index.html'), cash: 'setSending(ICON_X_CIRCLE + (err.message' },
  'x-pizza': { file: path.join(__dirname, '..', 'xpizza-orders', 'index.html'), cash: "sending-msg').innerHTML =\n            ICON_X_CIRCLE + (err.message" },
};
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

for (const [brand, { file, cash }] of Object.entries(FORMS)) {
  const src = fs.readFileSync(file, 'utf8');
  const has = (s, msg) => assert.ok(src.includes(s), `[${brand}] ${msg}`);

  // ONLINE path — weekend_only via paymentFallback, message-or-fallback + hint
  has("if(res.status===400 && cfg && cfg.error==='weekend_only'){", 'online: weekend_only branch present');
  has(`return paymentFallback((cfg.message || '${FALLBACK}') + '${HINT}');`, 'online: message-or-fallback + removal hint via paymentFallback');
  // CASH path — weekend_only via the brand's display mechanism
  has("if(err && err.error === 'weekend_only'){", 'cash: weekend_only branch present');
  has(cash, 'cash: uses the brand display mechanism (innerHTML / setSending) with err.message');
  has(`(err.message || '${FALLBACK}') + '${HINT}'`, 'cash: message-or-fallback + removal hint');

  // sibling branches BYTE-UNCHANGED (present + not swallowed by the insertion)
  for (const sib of ["error==='item_unavailable'", "error === 'item_unavailable'", "error === 'order_conflict'", "error === 'free_order_stale'"]) {
    has(sib, `sibling branch intact: ${sib}`);
  }
  // the weekend branch sits AFTER item_unavailable, BEFORE the generic fallback (online) / redemption (cash)
  assert.ok(src.indexOf("cfg.error==='item_unavailable'") < src.indexOf("cfg.error==='weekend_only'"), `[${brand}] online: weekend after item_unavailable`);
  ok(`${brand}: online + cash weekend_only branches, correct copy, siblings intact`);
}

// byte-parallel: identical N3 tokens in BOTH forms (online branch + copy are byte-identical across brands)
const tok = ["if(res.status===400 && cfg && cfg.error==='weekend_only'){", `return paymentFallback((cfg.message || '${FALLBACK}') + '${HINT}');`, "if(err && err.error === 'weekend_only'){", `(err.message || '${FALLBACK}') + '${HINT}'`];
const present = Object.fromEntries(Object.entries(FORMS).map(([b, { file }]) => [b, tok.map((t) => fs.readFileSync(file, 'utf8').includes(t))]));
assert.deepEqual(present['la-musa'], present['x-pizza'], 'both forms carry the identical N3 weekend_only dispatch + copy (byte-parallel)');
assert.ok(present['la-musa'].every(Boolean), 'all N3 tokens present in both forms');
ok('both forms byte-parallel on the N3 weekend_only handling');

console.log(`\nn3-weekend-message.test.js: ${pass} passed`);
