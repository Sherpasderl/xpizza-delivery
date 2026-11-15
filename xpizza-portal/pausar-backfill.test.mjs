// «Pausar» / P-1 — the Codex backfill review (FULL HIGH, advisor 11-15) of 43ee1e54b..fd92b23b2: REVISE, one P1 + two P2s. Every cell runs
// the REAL branch page (app.js / ventas.js / shell.js through ventas-harness.mjs) against 5f's REAL getMyBranchesCore / setBranchPauseCore
// (portal/ops-core.js of THIS worktree) over the merchant fake RTDB — the owner and a manager by the REAL roster writer, every pause by
// the REAL writePause. A fault is injected only at the wire or as an outage of one read; no server body is hand-built.
// Run: node --test pausar-backfill.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installDom, installFetch, loadModules, okJson, errJson, settle, textOf } from './ventas-harness.mjs';
import { OFFLINE } from './ops-dom.js';

const req = createRequire(new URL('../xpizza-functions/package.json', import.meta.url));
const { createFakeDb } = req('./merchant/_fake-db');
const R = req('./access/roster');
const C = req('./portal/ops-core');
const OWNER = 'uOwnerPB', MGR = 'uMgrPB';
const ALL_DAY = { open: true, start: '00:00', end: '23:59' };
const days = () => Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((k) => [k, ALL_DAY]));
const ROWS = [['pv_centro', 'Centro'], ['pv_norte', 'Norte']];
const quiet = { warn() {}, log() {}, error() {} };
const all = (n) => (n && n.children ? n.children : []).flatMap((c) => (c && typeof c === 'object' ? [c, ...all(c)] : []));
const btn = (root, t) => all(root).find((n) => n.tag === 'button' && textOf(n) === t);
const UNCONF = ['No pudimos confirmar el resultado', 'Recargá para ver cómo quedó.'];   // advisor 11-15 (a): two approved strings

async function world() {
  const fake = createFakeDb({
    brands: { pv: { name: 'Pizzería Del Valle', active: true, locations: Object.fromEntries(ROWS.map(([rid]) => [rid, 'member'])), activation: { state: 'on', since: 1 } } },
    restaurants: Object.fromEntries(ROWS.map(([rid, name]) => [rid, { identity: { brand_id: 'pv', name, active: true, prep_default_min: 20, version: 1,
      hub_lat: 15.5, hub_lng: -88.03, delivery_radius_km: 4, phone: '+50497128830', hours: days() } }])),
  });
  const ok = (o, w) => assert.ok(o && o.ok !== false, `premise: ${w} (${JSON.stringify(o)})`);
  ok(await R.mutateRoster({ db: fake, now: () => 1 }, 'pv', { kind: 'cli', operator: 'test' }, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'Marcela Pineda', email: 'duena@pv.hn' } }), 'the owner');
  ok(await R.mutateRoster({ db: fake, now: () => 2 }, 'pv', { kind: 'cli', operator: 'test' }, { type: 'grant_manager', uid: MGR, rids: ['pv_norte'] }), 'a manager of Norte only');
  return fake;
}
// the page over the real cores. `fault`: a per-call hook (fn, body) → 'lost' | 'malformed' | 'unknown' | 'outage' | { hold: Promise } | undefined
async function open(fake, { uid = OWNER, rid = 'pv_centro', scope, fault = () => undefined } = {}) {
  const m = new Map();
  globalThis.sessionStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
  if (scope) m.set(`sherpa.portal.sel.${uid}`, JSON.stringify({ brand_id: 'pv', scope }));   // the owner's GLOBAL scope (the shell's own store)
  const byId = installDom();
  globalThis.window.location = { reload: () => {} };
  globalThis.window.scrollTo = () => {};
  globalThis.__branchesDirect = true;
  let txOut = null, readOut = null;   // an outage armed for ONE call: the writer's transaction (txOut) or one path's read (readOut)
  const db = { ref: (p = '') => { const r = fake.ref(p); const out = (x) => x && String(p).startsWith(x);
    return { ...r, get: () => (out(readOut) ? Promise.reject(new Error('injected outage')) : r.once()), once: (...a) => (out(readOut) ? Promise.reject(new Error('injected outage')) : r.once(...a)),
      transaction: (fn) => (out(txOut) ? Promise.reject(new Error('injected outage')) : r.transaction(fn)) }; } };
  const deps = () => ({ db, verifyIdToken: async () => ({ uid }), log: quiet, now: () => Date.now(), timestamp: () => Date.now(), newOpId: () => `oc_${Date.now().toString(36)}_t` });
  const http = (method, body) => ({ method, body, get: (h) => (String(h).toLowerCase() === 'authorization' ? 'Bearer t' : undefined) });
  const ans = (r) => (r.status === 200 ? okJson(r.body) : errJson(r.status, r.body));
  let calls = null;
  calls = installFetch(async (fn) => {
    const body = calls.length ? calls[calls.length - 1].body : null;
    let f = fault(fn, body);
    if (f && f.hold) { await f.hold; f = f.kind; }   // a held call, then (optionally) its own fault
    if (fn === 'getMyBranches') {
      if (f === 'lost') throw new TypeError('Failed to fetch');
      return ans(await C.getMyBranchesCore(deps(), http('GET')));
    }
    if (fn === 'setBranchPause') {
      if (f === 'outage') txOut = 'order_control/';                      // the writer's own transaction fails ⇒ the core's 503
      if (f === 'unknown') readOut = `order_control/${body.rid}/current`;  // only the post-write READ fails ⇒ the core's control: unknown
      let r;
      try { r = await C.setBranchPauseCore(deps(), http('POST', body)); } finally { txOut = null; readOut = null; }
      if (f === 'lost') throw new TypeError('Failed to fetch');                 // the real core ran; its reply never arrived
      if (f === 'malformed') return okJson({ ok: true, noop: false });          // the real 200, its control lost in delivery
      return ans(r);
    }
    if (fn === 'getEditableCatalog' || fn === 'getBranchAvailability') return errJson(404, { error: 'not_found' });
    return errJson(404, { error: 'not_found' });
  });
  const mods = await loadModules();
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle(30);
  if (rid) { mods.shell.goto('suc', { rid }); await settle(10); }
  const view = byId.get('viewsuc');
  return { byId, calls, mods, view, modal: byId.get('pausemodal'), pauses: () => calls.filter((c) => c.fn === 'setBranchPause').map((c) => c.body),
    toast: () => textOf(byId.get('opstoast')), text: () => textOf(view), state: async () => (await C.getMyBranchesCore(deps(), http('GET'))).body.branches.find((b) => b.rid === 'pv_centro').control.state };
}
async function pauseCentro(P) {
  btn(P.view, 'Pausar sucursal').click(); await settle(2);
  btn(P.modal, 'Pausar').click();
}
const enabled = (P, t) => { const b = btn(P.view, t); return !!b && !b.disabled; };

// ═══ P1 · ambiguous outcomes never claim certainty (rule 17's spirit): no toast, the neutral box, the authoritative re-read first ═══
for (const [kind, label] of [['lost', 'a transport failure after the pause LANDED'], ['malformed', 'a malformed 200 (no control)'], ['unknown', 'the core\'s own control.state «unknown»']]) {
  test(`B-${kind} ${label} ⇒ NO success toast; «No pudimos confirmar el resultado» / «Recargá para ver cómo quedó.»; the actions disabled through the authoritative re-read; then the state AS READ`, async () => {
    const fake = await world();
    let release; const held = new Promise((r) => { release = r; });
    let n = 0;
    const P = await open(fake, { fault: (fn) => (fn === 'setBranchPause' ? kind : fn === 'getMyBranches' && ++n === 2 ? { hold: held } : undefined) });   // the 2nd branch read = the re-read
    await pauseCentro(P); await settle(20);
    assert.equal(await P.state(), 'paused', 'premise: the real writer paused Centro');
    assert.ok(!P.toast().includes('Centro pausada'), `B-${kind}: never the success toast`);
    assert.ok(UNCONF.every((s) => P.text().includes(s)), `B-${kind}: the neutral box`);
    assert.ok(!enabled(P, 'Pausar sucursal') && !enabled(P, 'Reanudar pedidos'), `B-${kind}: no action enabled during the re-read`);
    release(); await settle(30);
    assert.ok(enabled(P, 'Reanudar pedidos'), `B-${kind}: the state AS READ (paused) — then the action is enabled`);
    assert.ok(!UNCONF.some((s) => P.text().includes(s)), `B-${kind}: the box goes once the re-read answered`);
  });
}
test('B-reread-fails: the outcome is ambiguous AND the re-read fails ⇒ the box STAYS and the actions stay disabled', async () => {
  const fake = await world();
  let n = 0;
  const P = await open(fake, { fault: (fn) => (fn === 'setBranchPause' ? 'lost' : fn === 'getMyBranches' && ++n > 1 ? 'lost' : undefined) });
  await pauseCentro(P); await settle(40);
  assert.ok(UNCONF.every((s) => P.text().includes(s)), 'B-reread-fails: the box stays');
  assert.ok(!enabled(P, 'Pausar sucursal') && !enabled(P, 'Reanudar pedidos'), 'B-reread-fails: the actions stay disabled');
  assert.ok(!P.toast().includes('Centro pausada'), 'never the success toast');
});

// ═══ P2 · a failure is shown on the branch it was SUBMITTED for ═══════════════════════════════════════════════════════════════════
test('M1 a MANAGER on the default detail (V.det null): a failed pause shows its box there', async () => {
  const fake = await world();
  const P = await open(fake, { uid: MGR, rid: null, fault: (fn) => (fn === 'setBranchPause' ? 'outage' : undefined) });
  assert.ok(P.text().includes('Norte'), 'premise: the manager\'s own branch page');
  btn(P.view, 'Pausar sucursal').click(); await settle(2); btn(P.modal, 'Pausar').click(); await settle(30);
  assert.equal(P.pauses().length, 1, 'premise: the request went');
  assert.ok(P.text().includes(OFFLINE[0]), 'M1: the failure box on the manager\'s page');
});
test('M2 A\'s failure that settles after navigating to B: never on B; on A when back', async () => {
  const fake = await world();
  let release; const held = new Promise((r) => { release = r; });
  const P = await open(fake, { fault: (fn) => (fn === 'setBranchPause' ? { hold: held, kind: 'outage' } : undefined) });   // held, then the writer's outage ⇒ the real 503
  await pauseCentro(P); await settle(5);
  P.mods.shell.goto('suc', { rid: 'pv_norte' }); await settle(10);
  assert.ok(P.text().includes('Norte'), 'premise: on Norte');
  release(); await settle(30);
  assert.ok(!P.text().includes('Otra persona cambió el estado.') && !P.text().includes(OFFLINE[0]) && !P.text().includes('No se pudo cambiar el estado'), 'M2: no box on Norte');
  P.mods.shell.goto('suc', { rid: 'pv_centro' }); await settle(10);
  assert.ok(P.text().includes(OFFLINE[0]), 'M2: the box on Centro, where it was submitted');
});
test('P2b an owner whose GLOBAL scope is Centro opens Norte: «Pausar» on Norte sends Norte\'s request (resolved against the AUTHORIZED branches)', async () => {
  const fake = await world();
  const P = await open(fake, { scope: 'pv_centro', rid: 'pv_norte' });
  assert.ok(P.text().includes('Norte'), 'premise: Norte\'s page with the scope on Centro');
  btn(P.view, 'Pausar sucursal').click(); await settle(2);
  btn(P.modal, 'Pausar').click(); await settle(30);
  assert.deepEqual(P.pauses().map((b) => b.rid), ['pv_norte'], 'P2b: the request for the branch on screen');
  assert.ok(enabled(P, 'Reanudar pedidos'), 'and its answer repaints it');
});
