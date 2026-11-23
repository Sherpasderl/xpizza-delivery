// xpizza-dispatch/dispatch-comms-consolidation.test.js
//
// Polish §1 (CTA audit #5/#9) — the #msg-modal is retired; the flyout Comms pane is the single surface, with a
// «Sin atender» / «Últimas 24h» segment and «Marcar atendido» on the thread sheet. The subscriptions must stay
// intact: a new inbound message updates the pane, the segment counts, the nav-rail badge and the rtab count;
// unread → attended through the thread. Drives the REAL renderCommsTab + updateMessagesBadge over stubs.
// Codex #242 B — enhance-don't-rework parity with the retired modal: «Sin atender» covers EVERY unhandled
// message (any age), and the thread keeps the modal's WhatsApp reply route + «Marcar pendiente» undo.
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const fnSrc = (name) => { const s = html.indexOf(`function ${name}(`); return html.slice(s, html.indexOf('\n}', s) + 2); };

function dom() {
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: '', textContent: '', hidden: true, _ls: {},
    querySelectorAll: () => [], addEventListener(ev, fn) { (el(id)._ls[ev] ||= []).push(fn); } });
  return { el, $: (id) => el(id) };
}
const DEPNAMES = ['$', 'commsSeg', 'allMessages', 'convoKey', 'escapeHtml', 'formatMsgPhone', 'formatMsgTime', 'setTabBadge', 'openCommsThread'];
// Run the REAL renderCommsTab against a DOM shim + a given message store / segment.
function runTab(allMessages, commsSeg) {
  const { el, $ } = dom();
  const badges = {};
  const deps = {
    $, commsSeg, allMessages,
    convoKey: (f) => (String(f || '').replace(/\D/g, '').slice(-8) || null),
    escapeHtml: (s) => String(s == null ? '' : s),
    formatMsgPhone: (f) => String(f || ''),
    formatMsgTime: () => '14:32',
    setTabBadge: (id, c) => { badges[id] = c; },
    openCommsThread: () => {},
  };
  new Function(...DEPNAMES, `${fnSrc('renderCommsTab')}\n; return renderCommsTab;`)(...DEPNAMES.map(k => deps[k]))();
  return { el, badges };
}
// The nav-rail badge formula (the subscription): count of EVERY unhandled message.
const navUnhandled = (allMessages) => Object.values(allMessages).filter(m => m && m.handled !== true).length;

// §1: a new inbound (unhandled) message → the pane renders it, and all three counters update.
{
  const msgs = { m1: { from: '50499112233', body: '¿Ya salió mi pedido?', received_at: Date.now(), handled: false } };
  const { el, badges } = runTab(msgs, 'unhandled');
  assert.match(el('comms-list').innerHTML, /comms-row/, 'the pane renders the conversation');
  assert.match(el('comms-list').innerHTML, /¿Ya salió mi pedido\?/, 'the message body shows');
  assert.equal(el('cseg-unhandled-n').textContent, '1', '«Sin atender» count = 1');
  assert.equal(el('cseg-recent-n').textContent, '1', '«Últimas 24h» count = 1');
  assert.equal(badges['tab-comms-n'], 1, 'the rtab badge = 1 (unhandled)');
  ok('a new unhandled message renders in the pane and sets both segment counts + the rtab badge');
}

// §1: the segment filters — «Sin atender» hides handled chats, «Últimas 24h» shows them.
{
  const msgs = {
    a: { from: '50499000001', body: 'nueva', received_at: Date.now(), handled: false },
    b: { from: '50499000002', body: 'vieja', received_at: Date.now() - 1000, handled: true },
  };
  for (const [seg, expectRows] of [['unhandled', 1], ['recent', 2]]) {
    const { el } = runTab(msgs, seg);
    const rows = (el('comms-list').innerHTML.match(/comms-row/g) || []).length;
    assert.equal(rows, expectRows, `segment '${seg}' shows ${expectRows} row(s)`);
  }
  ok('segment: «Sin atender» shows only unhandled; «Últimas 24h» shows handled too');
}

// Codex #242 B-P1: a 25h-old unhandled message is shown in «Sin atender» and counted consistently everywhere
// (the nav badge counts it, so the pane must too — independent of the 24h history window).
{
  const t25 = Date.now() - 25 * 60 * 60 * 1000;
  const msgs = { old: { from: '50499112233', body: 'viejo sin atender', received_at: t25, handled: false } };
  const un = runTab(msgs, 'unhandled');
  assert.match(un.el('comms-list').innerHTML, /viejo sin atender/, '25h-old unhandled IS shown in «Sin atender»');
  assert.equal(un.el('cseg-unhandled-n').textContent, '1', '«Sin atender» counts it');
  assert.equal(un.badges['tab-comms-n'], 1, 'the rtab badge counts it');
  assert.equal(Number(un.el('cseg-unhandled-n').textContent), navUnhandled(msgs), '«Sin atender» count == the nav-badge count (consistent everywhere)');
  const rec = runTab(msgs, 'recent');
  assert.ok(!/viejo sin atender/.test(rec.el('comms-list').innerHTML), '«Últimas 24h» excludes it (correctly windowed)');
  assert.equal(rec.el('cseg-recent-n').textContent, '0', '«Últimas 24h» count excludes the 25h message');
  ok('25h-old unhandled: shown + counted in «Sin atender»/rtab (== nav badge), excluded from «Últimas 24h»');
}

// Codex #242 B-P1 (the "older one marked" case): a phone whose NEWEST message was marked handled but still has
// an older unhandled message stays in «Sin atender».
{
  const now = Date.now();
  const msgs = {
    old: { from: '50499112233', body: 'pendiente viejo', received_at: now - 26 * 3600e3, handled: false },
    neo: { from: '50499112233', body: 'ya atendido', received_at: now - 60e3, handled: true },
  };
  const un = runTab(msgs, 'unhandled');
  assert.match(un.el('comms-list').innerHTML, /pendiente viejo/, 'the conversation stays in «Sin atender» (older message still unhandled)');
  assert.equal(un.el('cseg-unhandled-n').textContent, '1', 'counted');
  assert.equal(Number(un.el('cseg-unhandled-n').textContent), navUnhandled(msgs), '== the nav-badge count');
  ok('a conversation with an older unhandled message stays in «Sin atender» even after the newest was marked');
}

// §1: the nav-rail badge mirrors the unhandled count (the retired #msg-btn's job).
{
  const { el } = dom();
  new Function('$', `${fnSrc('updateMessagesBadge')}\n; return updateMessagesBadge;`)(el)(3);
  assert.equal(el('nav-comms-badge').textContent, '3', 'nav badge shows the unhandled count');
  assert.equal(el('nav-comms-badge').hidden, false, 'nav badge is shown when > 0');
  new Function('$', `${fnSrc('updateMessagesBadge')}\n; return updateMessagesBadge;`)(el)(0);
  assert.equal(el('nav-comms-badge').hidden, true, 'nav badge hides at 0');
  ok('the nav-rail Comms badge mirrors the unhandled count (msg-btn retired)');
}

// §1 + Codex #242 B-P2: the thread sheet keeps the modal's actions — «Marcar atendido» (pending), the WhatsApp
// reply route, and the «Marcar pendiente» undo (attended).
{
  const src = fnSrc('renderCommsThread');
  assert.match(src, /const unhandledIds = Object\.entries\(allMessages[\s\S]*?m\.handled !== true\)/, 'the thread computes its unhandled ids');
  assert.match(src, /comms-mark-attended[\s\S]*?Marcar atendido/, '«Marcar atendido» is on the thread header');
  assert.match(src, /XPD\.markMessageHandled\(id, currentUser\?\.uid\)/, '«Marcar atendido» marks each unhandled id handled');
  // B-P2: the WhatsApp reply route (wa.me), «Responder» when pending / «Abrir en WhatsApp» otherwise
  assert.match(src, /https:\/\/wa\.me\/\$\{escapeHtml\(waDigits\)\}/, 'the thread has the wa.me reply link');
  assert.match(src, /unhandledIds\.length \? 'Responder' : 'Abrir en WhatsApp'/, 'WA label: «Responder» when pending, «Abrir en WhatsApp» otherwise (modal parity)');
  // B-P2: «Marcar pendiente» undo for an attended thread → markMessageUnhandled on the latest inbound
  assert.match(src, /comms-mark-pending[\s\S]*?Marcar pendiente/, '«Marcar pendiente» is restored for attended threads');
  assert.match(src, /XPD\.markMessageUnhandled\(latestInboundId\)/, '«Marcar pendiente» calls markMessageUnhandled on the latest inbound');
  assert.match(src, /unhandledIds\.length[\s\S]*?Marcar atendido[\s\S]*?Marcar pendiente/, 'pending → «Marcar atendido», attended → «Marcar pendiente» (mutually exclusive)');
  // the modal path is gone
  assert.ok(!html.includes('function renderMessagesLists(') && !html.includes('function openMessagesModal('), 'the modal render/open functions are removed');
  ok('thread parity: «Marcar atendido» + WhatsApp reply + «Marcar pendiente» undo; modal functions gone');
}

// Codex #242 B: the retired #msg-modal is dropped from the idle-adapter overlay list.
{
  const idle = html.slice(html.indexOf('idleAdapter({ overlays:'), html.indexOf('idleAdapter({ overlays:') + 400);
  assert.ok(!idle.includes('#msg-modal.open'), 'the idle-adapter overlay list no longer lists #msg-modal.open');
  assert.match(idle, /#comms-sheet\.open/, 'it still lists the live Comms surfaces');
  ok('the obsolete #msg-modal.open is dropped from the idle-adapter list');
}

// Owner Option B (SBS 11-23): the thread header is split into an identity row + an actions row, so the customer
// name never competes with the «Marcar atendido»+«Responder» pills (a single flex row with min-width:0 starved
// the name to «M…» at 430px, off-screen at 390px). jsdom has no layout, so the guard verifies — at the SOURCE
// level — the CSS that actually BUILDS the two rows (Codex #264: a class name alone is not enough) + row
// containment, and dies on realistic layout regressions mutated into the REAL source.
{
  // (a) fit predicate — fix-agnostic: a readable name budget comes from a two-row header OR a non-zero .sh-id min-width
  const headerFitsOK = (src) => {
    const i = src.indexOf('.sh-head'); const e = src.indexOf('.sh-recibido', i);
    const headCss = src.slice(i, e > i ? e : i + 2000);
    const shIdMinWidth = /\.sh-id\s*\{[^}]*min-width:\s*(?:[1-9]\d*px|[1-9]\d*%|[1-9]\d*rem|\d*\.\d+rem)/.test(headCss);
    const twoRow = /class="sh-head[^"]*\btwo-row\b/.test(src) || /\.sh-head\.two-row\b/.test(headCss);
    return shIdMinWidth || twoRow;
  };
  // (b) rows-CSS predicate — the FOUR layout declarations that actually create the two rows must be present + correct
  const rowsCssOK = (src) => {
    const i = src.indexOf('.sh-head.two-row'); if (i < 0) return false;
    const css = src.slice(i, i + 600);
    return /\.sh-head\.two-row\s*\{[^}]*display:\s*block/.test(css)
        && /\.sh-head\.two-row\s+\.sh-idrow\s*\{[^}]*display:\s*flex/.test(css)
        && /\.sh-head\.two-row\s+\.sh-actrow\s*\{[^}]*display:\s*flex/.test(css)
        && /\.sh-head\.two-row\s+\.sh-actspacer\s*\{[^}]*flex:\s*1/.test(css);
  };
  assert.ok(headerFitsOK(html), 'the thread header guarantees the name a readable budget (two-row header, or a non-zero .sh-id min-width)');
  assert.ok(rowsCssOK(html), 'the two-row layout CSS is present + correct: .sh-head.two-row display:block + .sh-idrow/.sh-actrow display:flex + .sh-actspacer flex:1');

  // (c) row containment — the name (.nm) + close live in the identity row; the pills + call live in the actions row
  const t = fnSrc('renderCommsThread');
  const pIdrow = t.indexOf('class="sh-idrow"'), pActrow = t.indexOf('class="sh-actrow"');
  const pNm = t.indexOf('class="nm"'), pClose = t.indexOf('comms-sheet-close');
  const pTriage = t.indexOf('${triageBtn}'), pWa = t.indexOf('${waBtn}'), pCall = t.indexOf('${callBtn}');
  assert.ok(pIdrow > -1 && pActrow > pIdrow, 'the identity row precedes the actions row');
  assert.ok(pIdrow < pNm && pNm < pActrow, 'the name (.nm) is contained in the identity row');
  assert.ok(pIdrow < pClose && pClose < pActrow, 'close is contained in the identity row');
  assert.ok(pActrow < pTriage && pActrow < pWa && pActrow < pCall, 'the pills + call are contained in the actions row');

  // (d) mutants on the REAL source (Codex #264) — both realistic layout regressions must die, plus the one-row header
  const mFlex = html.replace(/(\.sh-head\.two-row\s*\{[^}]*display:\s*)block/, '$1flex');            // display:block → flex
  assert.ok(mFlex !== html && !rowsCssOK(mFlex), 'mutant killed: .sh-head.two-row display:block→flex fails the rows-CSS guard');
  const mDel = html.replace(/\n\s*\.sh-head\.two-row\s*\{[^}]*\}\s*\.sh-head\.two-row\s+\.sh-idrow\s*\{[^}]*\}\s*\.sh-head\.two-row\s+\.sh-actrow\s*\{[^}]*\}\s*\.sh-head\.two-row\s+\.sh-actspacer\s*\{[^}]*\}/, '\n');   // delete all 4 layout rules
  assert.ok(mDel !== html && !rowsCssOK(mDel), 'mutant killed: deleting the four two-row layout rules fails the rows-CSS guard');
  const ONE_ROW = `<style>.sh-head{display:flex}.sh-id{flex:1;min-width:0}.sh-recibido{}</style>` +
    `<div class="sh-head"><div class="sh-av">MF</div><div class="sh-id"><div class="nm">María Fernanda Alvarenga</div></div>` +
    `<button class="sh-attend">Marcar atendido</button><a class="sh-attend wa">Responder</a></div>`;
  assert.ok(!headerFitsOK(ONE_ROW), 'mutant killed: the retired one-row header (both pills, min-width:0) fails the fit guard');
  ok('thread header fit (Option B): rows-CSS + containment verified; three mutants (display:block→flex, delete-4-rules, one-row) all die');
}

// WCAG 2.4.3 (focus order) — the header's DOM/tab order is intentionally Close → triage → WhatsApp → call: it
// follows the VISUAL reading order of the two rows (close sits in the top identity row, the actions are below),
// which is what 2.4.3 wants (advisor ruling on Codex #264). Pin it so a reshuffle can't regress it — holds for
// BOTH pending and attended, since the triage/WA slots only swap labels+ids by state, not their position.
{
  const t = fnSrc('renderCommsThread');
  const pClose = t.indexOf('comms-sheet-close');
  const pTriage = t.indexOf('${triageBtn}'), pWa = t.indexOf('${waBtn}'), pCall = t.indexOf('${callBtn}');
  assert.ok(pClose > -1 && pTriage > pClose && pWa > pTriage && pCall > pWa,
    'header DOM/focus order = Close → triage → WhatsApp → call (matches the visual reading order; WCAG 2.4.3)');
  // the triage/WA slots carry the right controls per state, so the pinned order holds pending AND attended
  assert.match(t, /unhandledIds\.length[\s\S]*?comms-mark-attended[\s\S]*?comms-mark-pending/, 'triage slot: «Marcar atendido» (pending) / «Marcar pendiente» (attended)');
  assert.match(t, /unhandledIds\.length \? 'Responder' : 'Abrir en WhatsApp'/, 'WA slot: «Responder» (pending) / «Abrir en WhatsApp» (attended)');
  ok('focus order pinned: Close → triage → WhatsApp → call for both pending and attended (WCAG 2.4.3)');
}

console.log(`dispatch-comms-consolidation: OK (${n})`);
