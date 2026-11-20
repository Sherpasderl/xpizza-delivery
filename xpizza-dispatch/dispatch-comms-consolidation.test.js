// xpizza-dispatch/dispatch-comms-consolidation.test.js
//
// Polish §1 (CTA audit #5/#9) — the #msg-modal is retired; the flyout Comms pane is the single surface, with a
// «Sin atender» / «Últimas 24h» segment and «Marcar atendido» on the thread sheet. The subscriptions must stay
// intact: a new inbound message updates the pane, the segment counts, the nav-rail badge and the rtab count;
// unread → attended through the thread. This drives the REAL renderCommsTab + updateMessagesBadge over stubs.
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
const deps = (allMessages, commsSeg, extra = {}) => {
  const badges = {};
  const base = {
    allMessages, commsSeg,
    convoKey: (f) => (String(f || '').replace(/\D/g, '').slice(-8) || null),
    escapeHtml: (s) => String(s == null ? '' : s),
    formatMsgPhone: (f) => String(f || ''),
    formatMsgTime: () => '14:32',
    setTabBadge: (id, c) => { badges[id] = c; },
    openCommsThread: () => {},
    badges,
  };
  return { ...base, ...extra };
};

// §1: a new inbound (unhandled) message → the pane renders it, and all three counters update.
{
  const { el, $ } = dom();
  const d = deps({ m1: { from: '50499112233', body: '¿Ya salió mi pedido?', received_at: Date.now(), handled: false } }, 'unhandled');
  const names = ['$', 'commsSeg', 'allMessages', 'convoKey', 'escapeHtml', 'formatMsgPhone', 'formatMsgTime', 'setTabBadge', 'openCommsThread'];
  const run = new Function(...names, `${fnSrc('renderCommsTab')}\n; return renderCommsTab;`)($, d.commsSeg, d.allMessages, d.convoKey, d.escapeHtml, d.formatMsgPhone, d.formatMsgTime, d.setTabBadge, d.openCommsThread);
  run();
  assert.match(el('comms-list').innerHTML, /comms-row/, 'the pane renders the conversation');
  assert.match(el('comms-list').innerHTML, /¿Ya salió mi pedido\?/, 'the message body shows');
  assert.equal(el('cseg-unhandled-n').textContent, '1', '«Sin atender» count = 1');
  assert.equal(el('cseg-recent-n').textContent, '1', '«Últimas 24h» count = 1');
  assert.equal(d.badges['tab-comms-n'], 1, 'the rtab badge = 1 (unhandled)');
  ok('a new unhandled message renders in the pane and sets both segment counts + the rtab badge');
}

// §1: the segment filters — «Sin atender» hides handled chats, «Últimas 24h» shows them.
{
  const msgs = {
    a: { from: '50499000001', body: 'nueva', received_at: Date.now(), handled: false },
    b: { from: '50499000002', body: 'vieja', received_at: Date.now() - 1000, handled: true },
  };
  for (const [seg, expectRows] of [['unhandled', 1], ['recent', 2]]) {
    const { el, $ } = dom();
    const d = deps(msgs, seg);
    const names = ['$', 'commsSeg', 'allMessages', 'convoKey', 'escapeHtml', 'formatMsgPhone', 'formatMsgTime', 'setTabBadge', 'openCommsThread'];
    new Function(...names, `${fnSrc('renderCommsTab')}\n; return renderCommsTab;`)($, d.commsSeg, d.allMessages, d.convoKey, d.escapeHtml, d.formatMsgPhone, d.formatMsgTime, d.setTabBadge, d.openCommsThread)();
    const rows = (el('comms-list').innerHTML.match(/comms-row/g) || []).length;
    assert.equal(rows, expectRows, `segment '${seg}' shows ${expectRows} row(s)`);
  }
  ok('segment: «Sin atender» shows only unhandled; «Últimas 24h» shows handled too');
}

// §1: the nav-rail badge mirrors the unhandled count (the retired #msg-btn's job).
{
  const { el, $ } = dom();
  new Function('$', `${fnSrc('updateMessagesBadge')}\n; return updateMessagesBadge;`)($)(3);
  assert.equal(el('nav-comms-badge').textContent, '3', 'nav badge shows the unhandled count');
  assert.equal(el('nav-comms-badge').hidden, false, 'nav badge is shown when > 0');
  new Function('$', `${fnSrc('updateMessagesBadge')}\n; return updateMessagesBadge;`)($)(0);
  assert.equal(el('nav-comms-badge').hidden, true, 'nav badge hides at 0');
  ok('the nav-rail Comms badge mirrors the unhandled count (msg-btn retired)');
}

// §1: unread → attended lives on the thread sheet now (source: renderCommsThread computes the ids + wires markMessageHandled).
{
  const src = fnSrc('renderCommsThread');
  assert.match(src, /const unhandledIds = Object\.entries\(allMessages[\s\S]*?m\.handled !== true\)/, 'the thread computes its unhandled ids');
  assert.match(src, /comms-mark-attended[\s\S]*?Marcar atendido/, '«Marcar atendido» is on the thread header');
  assert.match(src, /XPD\.markMessageHandled\(id, currentUser\?\.uid\)/, '«Marcar atendido» marks each unhandled id handled');
  // the modal path is gone
  assert.ok(!html.includes('function renderMessagesLists(') && !html.includes('function openMessagesModal('), 'the modal render/open functions are removed');
  ok('«Marcar atendido» moved onto the thread sheet; the modal functions are gone');
}

console.log(`dispatch-comms-consolidation: OK (${n})`);
