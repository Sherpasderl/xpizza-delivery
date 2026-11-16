// router()'s decide may be ASYNC (PLAN-portal-fonts-census-gaps-r0 §2, advisor 11-16): the portal font census answers its newer panes from the
// lanes' REAL cores, which answer with a promise. router() is driven here through the same two calls it makes on a live session — cdp.on
// (the Fetch.requestPaused handler it registers) and cdp.s (the Fetch.* commands it sends) — recorded, so the assertion is about the
// command that would reach Chrome. The SYNC cells pin the existing consumers (forms-fonts, portal-origins, capp-perf, forms-s3): a sync
// decide routes exactly as before. Run: node --test platform/perf/cdp-fonts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { router } from './cdp-fonts.mjs';

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
