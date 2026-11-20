// «Envío» map — the load deadline starts when the map COMES INTO VIEW (PLAN-portal-zones-z2-fixes-r0 (b), advisor 11-20). Proven in Chrome:
// at 390 the map sits below the fold, Chrome throttles the off-screen cross-origin frame, Maps never fires tilesloaded, and a deadline
// started at load said «No se pudo cargar el mapa» on every phone. The REAL envio.js; the browser's IntersectionObserver is a stub the cell
// drives (jsdom has none), so «seen» happens exactly when the cell says.
// Run: node --test --test-force-exit envio-map-deadline.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle } from './ventas-harness.mjs';
import { page } from './envio-harness.mjs';
import { childMessage } from './envio-map-protocol.js';

const FAIL = 'No se pudo cargar el mapa.';
function withIO(p) {
  const made = [];
  p.w.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; this.els = []; this.off = false; made.push(this); }
    observe(el) { this.els.push(el); }
    disconnect() { this.off = true; }
    see(on = true) { if (!this.off) this.cb(this.els.map((target) => ({ target, isIntersecting: on, intersectionRatio: on ? 1 : 0 })), this); }
  };
  return made;
}
async function open({ io = true, ms = 200 } = {}) {
  const p = await page();
  const made = io ? withIO(p) : null;
  p.mods.envio._envioTiming.deadlineMs = ms;
  await p.signIn(); await p.open(); await settle(10);
  return { p, made };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('(b) off-screen: NO deadline runs before the map box is seen — no failure line however long it waits', async () => {
  const { p, made } = await open();
  assert.equal(made.length, 1, 'premise: the map box is observed');
  p.fromMap(childMessage('listening', p.mount())); await settle();
  await wait(450);
  assert.ok(!p.text().includes(FAIL), '🔴 an off-screen map is not failed by a deadline it could never meet');
});

test('(b) seen ⇒ the 8 s (here 200 ms) runs from THEN, and a map that never gets ready still fails', async () => {
  const { p, made } = await open();
  await wait(300);
  made[0].see(); await settle();
  await wait(100);
  assert.ok(!p.text().includes(FAIL), 'not yet: the deadline started at the first sight');
  await wait(200);
  assert.ok(p.text().includes(FAIL), '🔴 the deadline still fails a map that never gets ready');
  assert.equal(made[0].off, true, 'the observer disconnected at its first hit');
});

test('(b) a non-intersecting callback is not a sight; ready after the sight clears the deadline', async () => {
  const { p, made } = await open();
  made[0].see(false); await wait(300);
  assert.ok(!p.text().includes(FAIL), 'an «out of view» report starts nothing');
  assert.equal(made[0].off, false, 'still watching');
  made[0].see(); await settle();
  p.fromMap(childMessage('listening', p.mount())); p.fromMap(childMessage('ready', p.mount())); await settle();
  await wait(300);
  assert.ok(!p.text().includes(FAIL), 'ready cleared it');
});

test('(b) a same-frame reload AFTER the sight restarts the deadline as today (r3)', async () => {
  const { p, made } = await open();
  made[0].see(); await settle();
  p.fromMap(childMessage('listening', p.mount())); p.fromMap(childMessage('ready', p.mount())); await settle();
  p.fromMap(childMessage('listening', p.mount())); await settle();   // a new document: not ready again
  await wait(300);
  assert.ok(p.text().includes(FAIL), '🔴 the reloaded document gets its own deadline (the box was already seen)');
});

test('(b) no IntersectionObserver in the browser ⇒ today\'s timing (from load)', async () => {
  const { p } = await open({ io: false });
  await wait(300);
  assert.ok(p.text().includes(FAIL), '🔴 the deadline ran from load');
});

test('(b) leaving the page disconnects an observer still waiting (no timer per mount left behind)', async () => {
  const { p, made } = await open();
  assert.equal(made[0].off, false, 'premise: still waiting for the first sight');
  p.d.getElementById('navprod').click(); await settle(20);
  assert.equal(made[0].off, true, '🔴 disconnected with its frame');
});
