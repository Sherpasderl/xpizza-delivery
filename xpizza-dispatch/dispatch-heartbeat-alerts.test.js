// xpizza-dispatch/dispatch-heartbeat-alerts.test.js
//
// Slice D4 (LAST chunk) — board-liveness heartbeat pip + alerts affordance + Auto-asignar (unchanged) +
// the 2nd no-regression PORT (paid-after-close alert) + emoji→line-icon cleanup.
import assert from 'node:assert';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const fnSrc = (src, name) => { const s = src.indexOf(`function ${name}(`); const e = src.indexOf('\n}\n', s); return s < 0 || e < 0 ? null : src.slice(s, e + 2); };

// ─────────────────────────────────────────────────────────────────────────────
// 1. 2nd PORT — the paid-after-close alert case: byte-faithful to origin/main, EXECUTED (reads the nested
//    detail.orderId||detail.order_id), and NOT in COLA_OWNED_ALERT_TYPES (so it renders in the Torre/alerts).
// ─────────────────────────────────────────────────────────────────────────────
{
  let originHtml;
  try { originHtml = execSync('git show origin/main:xpizza-dispatch/index.html', { cwd: __dirname, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { console.error('  ! could not load origin/main blob:', e.message); process.exit(1); }
  // the case block byte-faithful (the return title + detail template) — grab the case slice from both
  const caseSlice = (src) => { const s = src.indexOf("case 'payment_paid_after_close_manual_refund_required':"); const e = src.indexOf('\n    }', s); return s < 0 ? null : src.slice(s, e); };
  assert.ok(caseSlice(html) && caseSlice(originHtml), 'paid-after-close case present in current + origin');
  assert.strictEqual(caseSlice(html), caseSlice(originHtml), 'paid-after-close alert case byte-faithful to origin/main');
  // NOT cola-owned → renders in the Torre
  const cola = (html.match(/COLA_OWNED_ALERT_TYPES = new Set\(\[([^\]]*)\]\)/) || [])[1] || '';
  assert.ok(!cola.includes('paid_after_close'), 'paid-after-close is NOT in COLA_OWNED_ALERT_TYPES (renders in Torre/alerts)');
  // EXECUTE alertContent on a real-shaped payload (emitter nests everything under `detail`)
  const src = fnSrc(html, 'alertContent');
  const alertContent = new Function('escapeHtml', 'displayOrderLabel', 'allDrivers', `${src}\nreturn alertContent;`)((s) => String(s), (x) => String(x), {});
  const r1 = alertContent({ type: 'payment_paid_after_close_manual_refund_required', detail: { orderId: '#118' } });
  assert.strictEqual(r1.title, 'Reembolso manual requerido', 'title');
  assert.match(r1.detail, /#118/, 'detail reads detail.orderId');
  assert.match(r1.detail, /<strong>Reembolsar<\/strong>/, 'detail instructs pressing Reembolsar');
  const r2 = alertContent({ type: 'payment_paid_after_close_manual_refund_required', detail: { order_id: '#119' } });
  assert.match(r2.detail, /#119/, 'detail falls back to detail.order_id (both id shapes handled)');
  ok('paid-after-close alert ported byte-faithful; executes on the nested-detail payload; not cola-owned');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Board-liveness heartbeat — READ-ONLY event-freshness; EXECUTED green→stale; pip present; hooked in the
//    3 core subscriptions.
// ─────────────────────────────────────────────────────────────────────────────
{
  const start = html.indexOf('const BOARD_STALE_MS');
  const block = html.slice(start, html.indexOf('setInterval(renderLivenessPip', start));   // exclude the live timer
  assert.ok(start > -1 && block.includes('function markBoardEvent()') && !block.includes('subscribeAll'), 'located heartbeat block (no timer/subs)');
  // no writes anywhere in the heartbeat machinery
  assert.doesNotMatch(block, /\.ref\(|\bfirebase\b|database\(|\bsubscribe|XPD\.(set|update|write|create|delete|save|resolve|cancel|refund|assign)\w*\(/i, 'heartbeat performs no write/subscription');
  // execute: mark → green; age it past threshold → amber
  const pip = { _c: new Set(), classList: { toggle: (c, on) => { on ? pip._c.add(c) : pip._c.delete(c); }, contains: (c) => pip._c.has(c) } };
  const age = { textContent: '' };
  const els = { 'board-liveness': pip, 'board-liveness-age': age };
  const api = new Function('$', `${block}\nreturn { renderLivenessPip, markBoardEvent, _setLast: (t) => { lastBoardEventAt = t; }, _stale: BOARD_STALE_MS };`)((id) => els[id] || null);
  api.markBoardEvent();
  assert.ok(!pip.classList.contains('stale'), 'a fresh board event → not stale');
  assert.strictEqual(age.textContent, 'en vivo', 'fresh → "en vivo"');
  api._setLast(Date.now() - api._stale - 5000); api.renderLivenessPip();
  assert.ok(pip.classList.contains('stale'), 'no event within threshold → stale');
  assert.match(age.textContent, /^sin datos · hace/, 'stale → "sin datos · hace Ns"');
  // a fresh event must RESET the clock even from a stale state (non-vacuous: catches a markBoardEvent that
  // renders but forgets to update lastBoardEventAt).
  api.markBoardEvent();
  assert.ok(!pip.classList.contains('stale'), 'markBoardEvent resets freshness → not stale');
  assert.strictEqual(age.textContent, 'en vivo', 'after a fresh event → "en vivo"');
  // pip in topbar + hooked in the 3 core subscriptions
  assert.match(html, /<div class="live-pip" id="board-liveness"[^>]*role="status"/, 'liveness pip in the topbar (read-only status)');
  const subs = html.slice(html.indexOf('function subscribeAll('), html.indexOf('function subscribeAll(') + 900);
  assert.strictEqual((subs.match(/markBoardEvent\(\);/g) || []).length, 3, 'markBoardEvent hooked in the 3 core streams (drivers/tasks/orders)');
  ok('heartbeat: read-only; executes green→stale on event freshness; pip present; hooked in 3 subscriptions');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Alerts bell — badge mirrors the Torre exceptions count (single source, before the empty early-return);
//    click opens the left rail + scrolls the Torre list; bell present.
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.match(html, /<button class="iconbtn alerts-bell" id="alerts-bell"[^>]*><svg class="ic"><use href="#i-alert"\/><\/svg><span class="alerts-bell-badge" id="alerts-bell-badge" hidden>/, 'alerts bell + badge present in the topbar');
  assert.match(html, /\.alerts-bell-badge\[hidden\] \{ display: none; \}/, 'bell badge hides at zero (hidden attr wins)');
  // badge mirror is computed from the SAME `entries` as the Torre count, before the empty-return
  const rda = html.slice(html.indexOf('function renderDispatcherAlerts('), html.indexOf('function renderDispatcherAlerts(') + 900);
  assert.match(rda, /bellBadge\.textContent = String\(entries\.length\); bellBadge\.hidden = !\(entries\.length > 0\);[\s\S]*?if \(entries\.length === 0\)/, 'bell badge mirrors entries.length before the empty early-return');
  // click → open left rail + scroll torre-list
  assert.match(html, /\$\('alerts-bell'\)\?\.addEventListener\('click', \(\) => \{[\s\S]*?togRail\('left-open'\)[\s\S]*?\$\('torre-list'\)[\s\S]*?scrollIntoView/, 'alerts bell opens the left rail + scrolls the Torre list');
  ok('alerts bell: badge mirrors the Torre count (single source); click opens rail + scrolls Torre');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Emoji cleanup — the ✓/✕ functional glyphs are replaced by line icons; none remain in rendered strings.
// ─────────────────────────────────────────────────────────────────────────────
{
  // strip comments, then assert no ✓/✕ remain in code/markup
  const noComments = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
  assert.ok(!/[✓✕]/.test(noComments), 'no ✓/✕ glyphs remain in rendered strings (comments excepted)');
  assert.match(html, /WhatsApp <svg class="ic"[^>]*><use href="#i-check"\/><\/svg>/, 'WhatsApp cue uses the i-check line icon');
  // scope to the closed-orders meta render SITE so reverting THAT swap goes red (not unrelated icons elsewhere)
  const metaRegion = html.slice(html.indexOf('const dCount = orders.filter'), html.indexOf('meta.innerHTML = cCount') + 130)
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');   // strip comments (which document "✓/✕")
  assert.ok(metaRegion.length > 40, 'located the closed-orders meta region');
  assert.match(metaRegion, /const chk = '[^']*#i-check[^']*';/, 'delivered icon (i-check) declared for the meta');
  assert.match(metaRegion, /const ex = '[^']*#i-close[^']*';/, 'cancelled icon (i-close) declared for the meta');
  // both icons must actually be RENDERED in the count (not just declared) — removing them from the template goes red
  assert.match(metaRegion, /meta\.innerHTML = cCount > 0 \? `\$\{dCount\} \$\{chk\}\s+\$\{cCount\} \$\{ex\}`/, 'the closed-orders count renders ${chk} and ${ex} (no ✓/✕)');
  assert.doesNotMatch(metaRegion, /[✓✕]/, 'closed-orders meta code has no ✓/✕ glyph');
  ok('emoji cleanup: ✓/✕ replaced with i-check / i-close line icons at their render sites; none left in rendered strings');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Auto-asignar toggle — UNCHANGED: still flips only the existing setting (XPD.setAutoAssignEnabled); no
//    assignment-logic change.
// ─────────────────────────────────────────────────────────────────────────────
{
  // slice the exact click-handler body (start → its closing `});`) so the negative guard can't reach other code
  const hs = html.indexOf("$('auto-assign-toggle').addEventListener('click'");
  assert.ok(hs > -1, 'located the auto-assign click handler');
  const toggleHandler = html.slice(hs, html.indexOf('  });', hs) + 5);
  assert.match(toggleHandler, /await XPD\.setAutoAssignEnabled\(!isOn\);/, 'toggle flips only the existing auto-assign setting');
  // NONE of the real assignment APIs — assignOrderToDriver is the one the old regex missed (it required `assignOrder(`)
  assert.doesNotMatch(toggleHandler, /assignOrderToDriver|reassignOrder|assignOrder\(|openPicker\(|buildActionQueue|assignOrderRemote/, 'toggle handler calls no real assignment API (only setAutoAssignEnabled)');
  ok('auto-asignar toggle unchanged — flips only the existing setting, no assignment API in the handler');
}

console.log(`\ndispatch-heartbeat-alerts: OK (${n} groups)`);
