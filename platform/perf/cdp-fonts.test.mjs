// router()'s decide may be ASYNC (PLAN-portal-fonts-census-gaps-r0 §2, advisor 11-16): the portal font census answers its newer panes from the
// lanes' REAL cores, which answer with a promise. router() is driven here through the same two calls it makes on a live session — cdp.on
// (the Fetch.requestPaused handler it registers) and cdp.s (the Fetch.* commands it sends) — recorded, so the assertion is about the
// command that would reach Chrome. The SYNC cells pin the existing consumers (forms-fonts, portal-origins, capp-perf, forms-s3): a sync
// decide routes exactly as before. Run: node --test platform/perf/cdp-fonts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { router, census, attribute, session } from './cdp-fonts.mjs';

async function drive(decide, request = { url: 'https://us-central1-x.cloudfunctions.net/getThing', method: 'POST', headers: {} }) {
  const handlers = {}; const sent = [];
  const cdp = { on: (ev, fn) => { handlers[ev] = fn; }, s: async (method, params) => { sent.push({ method, params }); return {}; } };
  const rt = await router(cdp, decide);
  sent.length = 0;   // Fetch.enable
  await handlers['Fetch.requestPaused']({ requestId: 'R1', request });
  return { sent, rt };
}
const tick = () => new Promise((r) => setTimeout(r, 1));

test('ASYNC decide: a promise of \'continue\' (after a tick) continues the request — never a fulfil with an empty body', async () => {
  const { sent } = await drive(async () => { await tick(); return 'continue'; });
  assert.deepEqual(sent.map((x) => x.method), ['Fetch.continueRequest'], 'the awaited decision is the one applied');
  assert.equal(sent[0].params.requestId, 'R1');
});
test('ASYNC decide: a promise of a response fulfils it with that status and body', async () => {
  const { sent } = await drive(async () => { await tick(); return { status: 403, body: '{"error":"denied"}' }; });
  assert.deepEqual(sent.map((x) => x.method), ['Fetch.fulfillRequest']);
  assert.equal(sent[0].params.responseCode, 403);
  assert.equal(Buffer.from(sent[0].params.body, 'base64').toString(), '{"error":"denied"}');
});
test('ASYNC decide: \'fail\' / \'hold\' are applied and recorded as before', async () => {
  const f = await drive(async () => 'fail');
  assert.deepEqual(f.sent.map((x) => x.method), ['Fetch.failRequest']); assert.equal(f.rt.refused.size, 1);
  const h = await drive(async () => 'hold');
  assert.deepEqual(h.sent, []); assert.equal(h.rt.holds.size, 1);
});
test('SYNC decide (every existing consumer): continue / fail / hold / a response route exactly as before', async () => {
  assert.deepEqual((await drive(() => 'continue')).sent.map((x) => x.method), ['Fetch.continueRequest']);
  assert.deepEqual((await drive(() => 'fail')).sent.map((x) => x.method), ['Fetch.failRequest']);
  assert.deepEqual((await drive(() => 'hold')).sent, []);
  const r = await drive(() => ({ body: 'x' }));
  assert.deepEqual([r.sent[0].method, r.sent[0].params.responseCode, Buffer.from(r.sent[0].params.body, 'base64').toString()], ['Fetch.fulfillRequest', 200, 'x']);
});

// r3d (advisor 11-18, Codex #105 r3 follow-up): a node the census cannot read is RECORDED (path only, never its text), not dropped —
// the r3d M-st mutant (a span rewritten every 3 ms) was dropped by BOTH censuses, so the stability re-read saw two identical lists.
// The fake cdp answers exactly the commands census() sends on a live session; the span's text node is gone by the time it is asked.
const TEXT_GONE = 'CSS.getPlatformFontsForNode: No node with given id found';
function domCdp({ goneTextIds = [] } = {}) {
  const tree = { nodeId: 1, nodeType: 9, children: [{ nodeId: 2, nodeType: 1, localName: 'body', attributes: [], children: [
    { nodeId: 3, nodeType: 1, localName: 'p', attributes: ['class', 'k'], children: [{ nodeId: 4, nodeType: 3, nodeValue: 'Hola' }] },
    { nodeId: 5, nodeType: 1, localName: 'span', attributes: ['id', '__mst'], children: [{ nodeId: 6, nodeType: 3, nodeValue: 'm123' }] }] }] };
  const style = [{ name: 'font-family', value: 'Figtree' }, { name: 'font-weight', value: '750' }, { name: 'font-style', value: 'normal' }];
  return { s: async (m, p) => {
    if (m === 'DOM.getDocument') return { root: tree };
    if (m === 'CSS.getComputedStyleForNode') return { computedStyle: style };
    if (m === 'CSS.getPlatformFontsForNode') { if (goneTextIds.includes(p.nodeId)) throw new Error(TEXT_GONE); return { fonts: [{ familyName: 'Figtree', isCustomFont: true, glyphCount: 4 }] }; }
    throw new Error(`unexpected ${m}`);
  } };
}
test('census: a text node that vanished before it was read is recorded in .vanished by its PATH (never its text); the readable one is a node', async () => {
  const nodes = await census(domCdp({ goneTextIds: [6] }));
  assert.deepEqual(nodes.map((n) => n.path), ['>body>p'], 'the readable node is recorded as before');
  assert.deepEqual(nodes.vanished, ['>body>span#__mst'], 'the vanished one is named by its path');
  assert.ok(!JSON.stringify(nodes.vanished).includes('m123'), 'no text content in the record');
});
test('census: nothing vanished ⇒ .vanished is an EMPTY list (every existing consumer: the node list itself is unchanged)', async () => {
  const nodes = await census(domCdp());
  assert.deepEqual(nodes.map((n) => n.path), ['>body>p', '>body>span#__mst']);
  assert.deepEqual(nodes.vanished, []);
});

// r3d: under paused virtual time document.fonts.load / .ready never settle, and the face wait hung the census 600 s (M-probe-*). The wait
// now races a NODE-side deadline; a key whose wait ran out is read as '(deadline)' — never the renderer's (unsettled) answer — so gate (d)
// and the per-node fidelity check FAIL naming it. The fake renderer here even answers 'Figtree' for it: a silent pass is what this pins.
function probeCdp({ settles }) {
  let host = 0;
  return { s: async (m, p) => {
    if (m === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (m === 'DOM.querySelector') return { nodeId: 100 + Number(p.selector.replace(/\D/g, '') || 0) };
    if (m === 'CSS.getPlatformFontsForNode') return { fonts: [{ familyName: 'Figtree' }] };
    throw new Error(`unexpected ${m}`);
  }, ev: async (x) => {
    if (x.includes('document.fonts.load')) return settles ? true : new Promise(() => {});
    if (x.includes("host.id = '__fprobe'")) host++;
    return true;
  } };
}
const NODE = { family: 'Figtree', weight: '750', style: 'normal', codepoints: [72, 111] };
test('attribute: a face wait that never settles stops at the deadline — every key of that batch reads \'(deadline)\', never the renderer\'s answer', { timeout: 5000 }, async () => {
  const t0 = Date.now();
  const map = await attribute(probeCdp({ settles: false }), [NODE], { settleMs: 60 });
  assert.ok(Date.now() - t0 < 2000, 'it did not wait for the face');
  assert.deepEqual([...map.values()], ['(deadline)', '(deadline)', '(deadline)'], 'H, o and the space: all named by the deadline');
  assert.deepEqual([...map.keys()].sort(), ['Figtree|750|normal|111', 'Figtree|750|normal|32', 'Figtree|750|normal|72']);
});
test('attribute: a face wait that settles reads the renderer as before (no deadline value)', { timeout: 5000 }, async () => {
  const map = await attribute(probeCdp({ settles: true }), [NODE], { settleMs: 60 });
  assert.deepEqual([...new Set(map.values())], ['Figtree']);
});

// r3d: the CDP session's backstop — a command Chrome never answers rejects, naming it, instead of hanging the run until its process kill.
// The fake socket is what launch() hands session(): addEventListener('message') + send(); it never answers.
function silentWs() { const sent = []; return { sent, addEventListener: () => {}, send: (d) => sent.push(JSON.parse(d)) }; }
test('session: a command with no answer rejects at the deadline, naming the method', { timeout: 5000 }, async () => {
  const ws = silentWs(); const { send } = session(ws, { deadlineMs: 50 });
  await assert.rejects(send('Runtime.evaluate', { expression: '1' }), /cdp: Runtime\.evaluate got no answer in 0\.05 s/);
  assert.equal(ws.sent[0].method, 'Runtime.evaluate');
});
test('session: an answered command resolves with its result (the deadline never fires on it)', { timeout: 5000 }, async () => {
  let onMsg = null; const ws = { addEventListener: (ev, fn) => { if (ev === 'message') onMsg = fn; }, send: (d) => { const { id } = JSON.parse(d); setTimeout(() => onMsg({ data: JSON.stringify({ id, result: { ok: 1 } }) }), 5); } };
  const { send } = session(ws, { deadlineMs: 200 });
  assert.deepEqual(await send('DOM.enable'), { ok: 1 });
});
