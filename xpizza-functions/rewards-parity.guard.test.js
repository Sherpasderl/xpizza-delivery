'use strict';

// REWARDS BYTE-IDENTICAL PARITY GUARD (B2 Task 6 — codex plan-gate #4, non-negotiable).
// Mechanically proves the two order forms' rewards code stays mirrored, so a drift in ONE form that
// isn't mirrored in the other FAILS the build (not a best-effort/weak check — exact string equality).
// Two enforced regions:
//   (1) account.js — EVERYTHING past the CONFIG block is byte-identical between the two forms. All the
//       rewards render/redeem/success logic (T3 display, T4 redeem, T5 success) lives here; the ONLY
//       legitimate brand difference is inside the CONFIG block. Strip each form's own CONFIG, then assert
//       exact string-equality of the entire remainder.
//   (2) index.html — the shared checkout-redeem helper block delimited by //__REWARDS_PARITY_BEGIN__ /
//       //__REWARDS_PARITY_END__ is byte-identical, and the three rewards mount lines (#acct-cart-earn,
//       #acct-redeem, #acct-success-rewards) are byte-identical. Brand-specific rewards code that is
//       EXPECTED to differ (redeemCartItems id-vs-name, the cash typed-409 setSending vs sending-msg)
//       lives OUTSIDE the marked block by construction — the guard neither requires nor tolerates it inside.
// Run: node rewards-parity.guard.test.js
const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');

const XP = (p) => readFileSync(join(__dirname, '..', 'xpizza-orders', p), 'utf8');
const LM = (p) => readFileSync(join(__dirname, '..', 'la-musa-orders', p), 'utf8');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// Report the first differing offset with a little context — a bare deepStrictEqual on 200k chars is unreadable.
function assertIdentical(a, b, label) {
  if (a === b) return;
  let i = 0; const len = Math.min(a.length, b.length);
  while (i < len && a[i] === b[i]) i++;
  const ctx = (s) => JSON.stringify(s.slice(Math.max(0, i - 50), i + 50));
  assert.fail(`${label}: DRIFT at offset ${i} (xp-len ${a.length}, lm-len ${b.length})\n  xpizza: ${ctx(a)}\n  lamusa: ${ctx(b)}`);
}

// ── (1) account.js: everything past CONFIG is byte-identical ──
const CONFIG_CLOSE = '\n  };\n';
function belowConfig(src, label) {
  const c = src.indexOf('const CONFIG');
  assert.notStrictEqual(c, -1, `${label}: 'const CONFIG' not found`);
  const close = src.indexOf(CONFIG_CLOSE, c);
  assert.notStrictEqual(close, -1, `${label}: CONFIG close ('\\n  };\\n') not found after 'const CONFIG'`);
  return src.slice(close + CONFIG_CLOSE.length);
}
const xpAcct = belowConfig(XP('account.js'), 'xpizza account.js');
const lmAcct = belowConfig(LM('account.js'), 'la-musa account.js');
// Sanity: the split must actually land past CONFIG on the real rewards code — guards against a mis-split
// that would make two tiny/empty strings compare equal and pass vacuously.
assert.ok(xpAcct.length > 50000, `account.js below-CONFIG unexpectedly small (${xpAcct.length}) — CONFIG split is wrong`);
for (const sig of ['renderCartEarn', 'renderRedeem', 'renderSuccessRewards', 'quoteRedemption', 'getRedeemPayload']) {
  assert.ok(xpAcct.includes(sig), `account.js below-CONFIG missing '${sig}' — CONFIG split is wrong`);
}
assertIdentical(xpAcct, lmAcct, 'account.js past CONFIG');
ok(`account.js byte-identical past CONFIG (${xpAcct.length} chars, both forms) — all rewards logic mirrored`);

// ── (2a) index.html: the marked shared redeem-helper block is byte-identical ──
const BEGIN = '//__REWARDS_PARITY_BEGIN__';
const END = '//__REWARDS_PARITY_END__';
function markedRegion(src, label) {
  const b = src.indexOf(BEGIN);
  assert.notStrictEqual(b, -1, `${label}: ${BEGIN} marker not found`);
  assert.strictEqual(src.indexOf(BEGIN, b + 1), -1, `${label}: ${BEGIN} marker appears more than once`);
  const afterBeginLine = src.indexOf('\n', b) + 1;        // first char of the line AFTER the begin marker
  const e = src.indexOf(END, afterBeginLine);
  assert.notStrictEqual(e, -1, `${label}: ${END} marker not found after ${BEGIN}`);
  return src.slice(afterBeginLine, e);                    // up to (excluding) the end-marker line
}
const xpBlock = markedRegion(XP('index.html'), 'xpizza index.html');
const lmBlock = markedRegion(LM('index.html'), 'la-musa index.html');
assert.ok(xpBlock.length > 400, `index.html marked block unexpectedly small (${xpBlock.length}) — markers likely misplaced`);
for (const sig of ['applyRedeemQuoteToTotals', 'redeemAdjustedTotal', 'renderRedeemUI']) {
  assert.ok(xpBlock.includes(sig), `index.html marked block missing '${sig}' — markers likely misplaced`);
}
assertIdentical(xpBlock, lmBlock, 'index.html marked redeem-helper block');
ok(`index.html marked redeem-helper block byte-identical (${xpBlock.length} chars, both forms)`);

// ── (2b) index.html: the three rewards mount lines are byte-identical ──
function mountLine(src, id, label) {
  const i = src.indexOf(`id="${id}"`);
  assert.notStrictEqual(i, -1, `${label}: mount id="${id}" not found`);
  const start = src.lastIndexOf('\n', i) + 1;
  const end = src.indexOf('\n', i);
  return src.slice(start, end === -1 ? src.length : end);
}
for (const id of ['acct-cart-earn', 'acct-redeem', 'acct-success-rewards']) {
  const xl = mountLine(XP('index.html'), id, 'xpizza index.html');
  const ll = mountLine(LM('index.html'), id, 'la-musa index.html');
  assert.strictEqual(ll, xl, `index.html mount line for #${id} differs between forms (byte-exact, incl. indentation)\n  xpizza: ${JSON.stringify(xl)}\n  lamusa: ${JSON.stringify(ll)}`);
}
ok('index.html rewards mount lines (#acct-cart-earn, #acct-redeem, #acct-success-rewards) byte-identical');

// ── (3) guest byte-identical at the money boundary: body.redeem is attached ONLY via the guarded one-liner ──
// A guest's getRedeemPayload() returns null → the `if(__rd)` guard is false → no `redeem` field on the order →
// the submit payload is byte-identical to today's. This asserts there is exactly ONE `.redeem =` assignment in
// each form and it is the guarded form — an unguarded `currentOrder.redeem = …` would fail the build.
const GUARDED = "if(__rd) currentOrder.redeem=__rd;";
for (const [src, label] of [[XP('index.html'), 'xpizza index.html'], [LM('index.html'), 'la-musa index.html']]) {
  const assigns = (src.match(/\.redeem\s*=/g) || []).length;
  assert.strictEqual(assigns, 1, `${label}: expected exactly 1 '.redeem =' assignment, found ${assigns} (an unguarded one would break guest byte-identical)`);
  assert.ok(src.includes(GUARDED), `${label}: the sole redeem assignment must be the guarded one-liner '${GUARDED}' (guest → null → no field)`);
}
ok('index.html attaches body.redeem ONLY via the guarded one-liner (guest path byte-identical — no redeem field)');

console.log(`rewards-parity: OK (${n} cases)`);
