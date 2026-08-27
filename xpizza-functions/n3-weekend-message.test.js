'use strict';
// N3 — surface the weekend_only rejection. X. PIZZA ONLY: weekendOnlyViolation (menu-pricing.js:48) is a hard
// no-op for any restaurant !== 'x_pizza', so La Musa's server can NEVER return weekend_only — the 18" special
// is X. Pizza's; La Musa doesn't sell pizza. So the branch belongs ONLY in the X. Pizza form; La Musa must NOT
// carry pizza-copy dead code. This test locks that: X. Pizza has both branches (reachable), La Musa has none.
// Run: node n3-weekend-message.test.js
const fs = require('fs');
const assert = require('assert');
const path = require('path');

const HINT = ' Quitá la pizza de 18" del carrito para continuar.';
const FALLBACK = 'Las pizzas de 18" solo están disponibles viernes, sábado y domingo.';
// Generic catch-all anchors — a weekend_only branch below these is unreachable (shadowed), the exact N3 bug.
// "No pudimos iniciar el pago" alone also appears in the N3 comment, so anchor on the full generic string.
const ONLINE_GENERIC = 'No pudimos iniciar el pago. Revisá tus datos';
const CASH_GENERIC = 'No pudimos enviar el pedido';
const XPIZZA = path.join(__dirname, '..', 'xpizza-orders', 'index.html');
const LAMUSA = path.join(__dirname, '..', 'la-musa-orders', 'index.html');
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// ── X. Pizza — BOTH weekend_only branches present, correct copy, reachable ──
{
  const src = fs.readFileSync(XPIZZA, 'utf8');
  const has = (s, m) => assert.ok(src.includes(s), `[x-pizza] ${m}`);
  // ONLINE — paymentFallback(message-or-fallback + hint)
  has("if(res.status===400 && cfg && cfg.error==='weekend_only'){", 'online: weekend_only branch present');
  has(`return paymentFallback((cfg.message || '${FALLBACK}') + '${HINT}');`, 'online: message-or-fallback + hint');
  // CASH — sending-msg.innerHTML + ICON_X_CIRCLE
  has("if(err && err.error === 'weekend_only'){", 'cash: weekend_only branch present');
  has(`ICON_X_CIRCLE + (err.message || '${FALLBACK}') + '${HINT}'`, 'cash: message-or-fallback + hint');
  // REACHABILITY — after item_unavailable AND before the generic catch-all, both paths (present-checked anchors)
  const at = (s) => { const i = src.indexOf(s); assert.ok(i !== -1, `[x-pizza] placement anchor missing: ${s}`); return i; };
  assert.ok(at("cfg.error==='item_unavailable'") < at("cfg.error==='weekend_only'"), '[x-pizza] online: weekend AFTER item_unavailable');
  assert.ok(at("cfg.error==='weekend_only'") < at(ONLINE_GENERIC), '[x-pizza] online: weekend BEFORE the generic fallback (reachable)');
  assert.ok(at("err.error === 'item_unavailable'") < at("err.error === 'weekend_only'"), '[x-pizza] cash: weekend AFTER item_unavailable');
  assert.ok(at("err.error === 'weekend_only'") < at(CASH_GENERIC), '[x-pizza] cash: weekend BEFORE the generic fallback (reachable)');
  ok('x-pizza: online + cash weekend_only branches, correct copy, reachable (after item / before generic)');
}

// ── La Musa — MUST NOT carry the weekend_only branch (never fires; pizza-copy would be wrong for the brand) ──
{
  const src = fs.readFileSync(LAMUSA, 'utf8');
  assert.ok(!src.includes("cfg.error==='weekend_only'"), '[la-musa] online: NO weekend_only branch (X. Pizza only)');
  assert.ok(!src.includes("err.error === 'weekend_only'"), '[la-musa] cash: NO weekend_only branch (X. Pizza only)');
  assert.ok(!src.includes(FALLBACK) && !src.includes(HINT.trim()), '[la-musa] NO 18" pizza copy at all');
  // siblings still intact (removal was surgical — item_unavailable + generic untouched)
  assert.ok(src.includes("cfg.error==='item_unavailable'") && src.includes("err.error === 'item_unavailable'"), '[la-musa] item_unavailable siblings intact');
  assert.ok(src.includes(ONLINE_GENERIC) && src.includes(CASH_GENERIC), '[la-musa] generic fallbacks intact');
  ok('la-musa: NO weekend_only branch / NO 18" pizza copy; siblings intact');
}

console.log(`\nn3-weekend-message.test.js: ${pass} passed`);
