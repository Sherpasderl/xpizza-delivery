'use strict';
// N3 — surface the weekend_only rejection (client-only, both forms). The dispatch is inline in the form HTML,
// so lock the branch presence + copy + byte-parallelism + sibling-branch integrity in source. Run: node n3-weekend-message.test.js
const fs = require('fs');
const assert = require('assert');
const path = require('path');

const HINT = ' Quitá la pizza de 18" del carrito para continuar.';
const FALLBACK = 'Las pizzas de 18" solo están disponibles viernes, sábado y domingo.';
// Generic catch-all anchors — a weekend_only branch placed BELOW these is unreachable (shadowed), the exact bug
// N3 fixes. Use the FULL generic strings (unique to the branch): "No pudimos iniciar el pago" alone also appears
// in the N3 comment, so anchor on "…Revisá tus datos" to land on the real online fallback, not the comment.
const ONLINE_GENERIC = 'No pudimos iniciar el pago. Revisá tus datos';   // the !res.ok catch-all (shadows any 400 → would shadow a mis-placed weekend branch)
const CASH_GENERIC = 'No pudimos enviar el pedido';                       // the cash catch-all
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
  // Placement / REACHABILITY — weekend_only must sit AFTER item_unavailable AND BEFORE the generic catch-all in
  // BOTH paths. A branch below the generic is unreachable (the exact N3 bug). Anchors are present-checked (>-1)
  // so a missing one fails LOUD instead of comparing against -1.
  const at = (s) => { const i = src.indexOf(s); assert.ok(i !== -1, `[${brand}] placement anchor missing: ${s}`); return i; };
  assert.ok(at("cfg.error==='item_unavailable'") < at("cfg.error==='weekend_only'"), `[${brand}] online: weekend AFTER item_unavailable`);
  assert.ok(at("cfg.error==='weekend_only'") < at(ONLINE_GENERIC), `[${brand}] online: weekend BEFORE the generic fallback (reachable, not shadowed)`);
  assert.ok(at("err.error === 'item_unavailable'") < at("err.error === 'weekend_only'"), `[${brand}] cash: weekend AFTER item_unavailable`);
  assert.ok(at("err.error === 'weekend_only'") < at(CASH_GENERIC), `[${brand}] cash: weekend BEFORE the generic fallback (reachable, not shadowed)`);
  ok(`${brand}: online + cash weekend_only branches, correct copy, siblings intact, REACHABLE (after item / before generic)`);
}

// byte-parallel: identical N3 tokens in BOTH forms (online branch + copy are byte-identical across brands)
const tok = ["if(res.status===400 && cfg && cfg.error==='weekend_only'){", `return paymentFallback((cfg.message || '${FALLBACK}') + '${HINT}');`, "if(err && err.error === 'weekend_only'){", `(err.message || '${FALLBACK}') + '${HINT}'`];
const present = Object.fromEntries(Object.entries(FORMS).map(([b, { file }]) => [b, tok.map((t) => fs.readFileSync(file, 'utf8').includes(t))]));
assert.deepEqual(present['la-musa'], present['x-pizza'], 'both forms carry the identical N3 weekend_only dispatch + copy (byte-parallel)');
assert.ok(present['la-musa'].every(Boolean), 'all N3 tokens present in both forms');
ok('both forms byte-parallel on the N3 weekend_only handling');

console.log(`\nn3-weekend-message.test.js: ${pass} passed`);
