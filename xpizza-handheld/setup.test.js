// H1b T6 — setup.js: pairing via merchantMyLocations (advisor 6, codex P1-6), the device-local session (incl. the prep base, advisor
// ruling: a null refresh keeps it), the manager PIN (PBKDF2, device-local; BC4: the lockout survives a restart on the wall clock),
// and the sign-out ORDER (gen bump before the Auth switch).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPairing, createSessionStore, hashPin, verifyPin, createPinGate, signOut, C1_NO_LOCATIONS } from './setup.js';
import { memoryStorage } from './offline-queue.js';

const row = (rid, base = 18) => ({ rid, brand_id: 'tb', location_name: rid.replace('tb_', ''), prep_default_min: base });
function fakes({ rows = [row('tb_norte')], pairFails = null, tokenFails = false } = {}) {
  const log = [];
  return {
    log,
    auth: {
      signInHuman: async (email) => { log.push(['signInHuman', email]); },
      signOut: async () => { log.push(['signOut']); },
      signInWithToken: async (t) => { log.push(['signInWithToken', t]); if (tokenFails) throw new Error('auth/invalid-custom-token'); return { uid: 'hh_tb_norte_r4nd' }; },
    },
    call: async (name, data) => {
      log.push([name, data]);
      if (name === 'merchantMyLocations') return rows;
      if (name === 'merchantPairDevice') { if (pairFails) throw Object.assign(new Error(pairFails), { code: `functions/${pairFails}` }); return { uid: 'hh_tb_norte_r4nd', custom_token: 'TOKEN' }; }
      throw new Error(`unexpected ${name}`);
    },
  };
}

test('pairing with ZERO locations → the approved C-1 copy, nothing paired', async () => {
  const f = fakes({ rows: [] });
  const p = await startPairing({ auth: f.auth, call: f.call, store: createSessionStore(memoryStorage()) }, { email: 'dueno@example.test', password: 'pw' });
  assert.deepEqual([p.screen, p.copy], ['none', C1_NO_LOCATIONS]);
  assert.equal(C1_NO_LOCATIONS, 'No tenés sucursales para vincular. Pedile acceso al dueño de la marca.');
  assert.ok(!f.log.some((l) => l[0] === 'merchantPairDevice'));
});

test('ONE location → the picker is skipped; SEVERAL → the picker; only the SELECTED rid is ever paired', async () => {
  const one = fakes();
  const p1 = await startPairing({ auth: one.auth, call: one.call, store: createSessionStore(memoryStorage()) }, { email: 'a@x.test', password: 'p' });
  assert.deepEqual([p1.screen, p1.selected.rid], ['checks', 'tb_norte']);
  const many = fakes({ rows: [row('tb_norte'), row('tb_centro'), row('tb_sur')] });
  const store = createSessionStore(memoryStorage());
  const p2 = await startPairing({ auth: many.auth, call: many.call, store }, { email: 'a@x.test', password: 'p' });
  assert.deepEqual([p2.screen, p2.rows.map((r) => r.rid)], ['branch', ['tb_norte', 'tb_centro', 'tb_sur']]);
  const done = await p2.pair(p2.rows[1], 'Mostrador');
  assert.equal(done.ok, true);
  const pairs = many.log.filter((l) => l[0] === 'merchantPairDevice');
  assert.deepEqual(pairs, [['merchantPairDevice', { rid: 'tb_centro', label: 'Mostrador' }]], 'never per location');
  const order = many.log.map((l) => l[0]).filter((n) => ['merchantPairDevice', 'signOut', 'signInWithToken'].includes(n));
  assert.deepEqual(order, ['merchantPairDevice', 'signOut', 'signInWithToken'], 'the human is signed out, then the device signs in');
  assert.deepEqual(store.load(), { uid: 'hh_tb_norte_r4nd', rid: 'tb_centro', brand_id: 'tb', location_name: 'centro', prep_default_min: 18 });
});

test('a failed token exchange → back to the picker with the error; nothing persisted (the device row stays for a manager to revoke)', async () => {
  const f = fakes({ tokenFails: true });
  const store = createSessionStore(memoryStorage());
  const p = await startPairing({ auth: f.auth, call: f.call, store }, { email: 'a@x.test', password: 'p' });
  const r = await p.pair(p.selected, 'Mostrador');
  assert.deepEqual([r.ok, r.screen, r.error], [false, 'branch', 'token_exchange']);
  assert.equal(store.load(), null);
});

test('a refused pairing (gate off, no prep base, not a manager) → an error, no sign-out of the human, nothing persisted', async () => {
  for (const code of ['failed-precondition', 'permission-denied']) {
    const f = fakes({ pairFails: code });
    const store = createSessionStore(memoryStorage());
    const p = await startPairing({ auth: f.auth, call: f.call, store }, { email: 'a@x.test', password: 'p' });
    const r = await p.pair(p.selected, 'Mostrador');
    assert.deepEqual([r.ok, r.error], [false, code]);
    assert.ok(!f.log.some((l) => l[0] === 'signInWithToken'));
    assert.equal(store.load(), null);
  }
});

test('the session store: prep base persisted at pairing; a VALID refresh updates it; a null / invalid refresh KEEPS it (advisor)', () => {
  const st = memoryStorage();
  const s = createSessionStore(st);
  s.save({ uid: 'u', rid: 'tb_norte', brand_id: 'tb', location_name: 'Norte', prep_default_min: 18 });
  assert.equal(s.refreshBase(22), 22);
  for (const bad of [null, undefined, 4, 121, 18.5, '20']) assert.equal(s.refreshBase(bad), 22, String(bad));
  assert.equal(createSessionStore(st).load().prep_default_min, 22, 'survives a restart');
  s.clear();
  assert.equal(s.load(), null);
  st.setRaw('hh_session', '{broken'); assert.equal(createSessionStore(st).load(), null, 'a corrupt session is no session');
});

test('PIN: PBKDF2 hash/verify with a random salt; the PIN itself is never stored', async () => {
  const a = await hashPin('1234'); const b = await hashPin('1234');
  assert.equal(a.iter, 100000);
  assert.notEqual(a.salt, b.salt); assert.notEqual(a.hash, b.hash);
  assert.ok(!JSON.stringify(a).includes('1234'));
  assert.equal(await verifyPin('1234', a), true);
  assert.equal(await verifyPin('1235', a), false);
  assert.equal(await verifyPin('1234', { ...a, hash: 'x' }), false);
  assert.equal(await verifyPin('1234', null), false);
});

test('PIN gate: 5 failures → 1 min lockout on the local timer; BC4: the lockout survives a restart via the persisted wall deadline', async () => {
  const st = memoryStorage(); let wall = 5_000_000; let mono = 0;
  const rec = await hashPin('2468');
  const mk = () => createPinGate({ storage: st, wall: () => wall, mono: () => mono });
  const g = mk(); g.setRecord(rec);
  for (let i = 0; i < 4; i++) assert.deepEqual(await g.try('0000'), { ok: false, locked: false });
  assert.deepEqual(await g.try('0000'), { ok: false, locked: true, remainingMs: 60000 });
  assert.deepEqual(await g.try('2468'), { ok: false, locked: true, remainingMs: 60000 }, 'even the right PIN waits');
  wall += 20000; mono += 20000;
  const after = mk();                                  // app restart: a new gate, mono restarts at 0
  mono = 0;
  assert.deepEqual(await after.try('2468'), { ok: false, locked: true, remainingMs: 40000 }, 'the persisted lockout_until on the WALL clock');
  wall += 40000;
  assert.deepEqual(await after.try('2468'), { ok: true }, 'unlocked; a success resets the count');
  assert.deepEqual(await after.try('0000'), { ok: false, locked: false });
});

test('PIN gate: a wall clock set BACK during a lockout does not shorten it within the session (mono still counts)', async () => {
  const st = memoryStorage(); let wall = 9_000_000; let mono = 0;
  const g = createPinGate({ storage: st, wall: () => wall, mono: () => mono }); g.setRecord(await hashPin('1111'));
  for (let i = 0; i < 5; i++) await g.try('0000');
  wall -= 3600000; mono += 10000;
  assert.equal((await g.try('1111')).remainingMs, 50000);
});

test('"Olvidé el PIN" / sign-out ORDER: gen bump → feeds stop → queue partition discarded (with a note) → alarm stop → Auth sign-out', async () => {
  const log = [];
  const ctx = {
    session: { bump: () => log.push('gen++') },
    feeds: { stop: () => log.push('feeds.stop') },
    queue: { discard: (why) => { log.push(`queue.discard:${why}`); return { discarded: 2, reason: why }; } },
    undoStop: () => log.push('undo.drop'),
    eta: { stopAll: () => log.push('eta.stopAll') },
    bridge: { alarm: { stop: () => log.push('alarm.stop') } },
    auth: { signOut: async () => log.push('auth.signOut') },
    store: { clear: () => log.push('store.clear') },
  };
  const note = await signOut(ctx, 'cambiar_sucursal');
  assert.deepEqual(log, ['gen++', 'feeds.stop', 'undo.drop', 'eta.stopAll', 'queue.discard:cambiar_sucursal', 'alarm.stop', 'auth.signOut', 'store.clear']);
  assert.deepEqual(note, { discarded: 2, reason: 'cambiar_sucursal' });
});

test('codex H1b r1 P1-5: five CONCURRENT wrong attempts lock exactly once — never five unlocked answers', async () => {
  const st = memoryStorage(); let t = 1_000_000;
  const g = createPinGate({ storage: st, wall: () => t, mono: () => t }); g.setRecord(await hashPin('2468'));
  const rs = await Promise.all(['0000', '0000', '0000', '0000', '0000', '2468'].map((p) => g.try(p)));
  assert.deepEqual(rs.map((r) => r.locked), [false, false, false, false, true, true], 'the right PIN in the same burst is NOT let through');
  assert.equal(rs[5].ok, false);
  assert.equal((await g.try('2468')).locked, true, 'the right PIN waits too');
});

test('codex H1b r1 P1-5: a lockout state that cannot be persisted FAILS CLOSED (locked in-session for the full minute)', async () => {
  let t = 1_000_000; const rec = await hashPin('2468');
  const st = memoryStorage({ failWrites: true });
  st.setRaw('hh_pin', JSON.stringify(rec));
  const g = createPinGate({ storage: st, wall: () => t, mono: () => t });
  assert.deepEqual(await g.try('0000'), { ok: false, locked: true, remainingMs: 60000 }, 'the count cannot be persisted → locked at once');
  assert.equal((await g.try('2468')).locked, true);
  t += 60000;
  assert.equal((await g.try('2468')).locked, true, 'still cannot persist the count → still closed');
});

test('codex H1b r1 P1-5: the attempt is counted BEFORE the verify (a kill mid-verify still counts)', async () => {
  const st = memoryStorage(); const t = 1_000_000;
  const g = createPinGate({ storage: st, wall: () => t, mono: () => t }); g.setRecord(await hashPin('2468'));
  let settled = false;
  const p = g.try('0000').then((r) => { settled = true; return r; });
  await new Promise((r) => setImmediate(r));          // the chain has started; PBKDF2 (100k iterations) has not finished
  assert.equal(settled, false);
  assert.equal(JSON.parse(st.raw('hh_pin_lock')).fails, 1, 'persisted before PBKDF2 resolves');
  await p;
});
