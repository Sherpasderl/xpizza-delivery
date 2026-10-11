'use strict';
/* R1 — the slot allocator, the process scan (P1-B), the sentinel contract and emu-reap.
 *
 * OFF THE REAL POOL (PLAN §c.2): every socket cell binds the FIXTURE sentinel range 6440-6479, never 6400-6439, so
 * this file can run while real emulator runs hold real slots — and two gates running it concurrently only contend
 * on fixture ports they each retry. The ps cells read the REAL process table (that IS the P1-B proof) but signal
 * nothing that is not a process this file spawned.
 */
const assert = require('assert');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const A = require('./emu-alloc');
const EE = require('../lib/emulator-endpoint');
const { reap, stillOrphan } = require('./emu-reap');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const L = (pid, state, lstart, args) => `${String(pid).padStart(6)} ${state.padEnd(4)} ${lstart} ${args}`;
const T0 = 'Sat Oct 10 22:00:00 2026';
const T0s = Math.floor(Date.parse(`${T0} UTC`) / 1000);
const T1 = 'Sat Oct 10 22:00:07 2026';
const mk = (slot, pid, start, nonce = 'a1b2c3d4e5f60718') => `${A.RUN_VAR}=${A.formatMarker({ slot, pid, nonce, start })}`;
// a child env with gate-all's count-marks preload stripped (a spawned child inheriting it prints ##CELLS)
const childEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  if (env.NODE_OPTIONS) env.NODE_OPTIONS = env.NODE_OPTIONS.replace(/--require[= ]\S*count-marks\.js/g, '').trim();
  if (!env.NODE_OPTIONS) delete env.NODE_OPTIONS;
  return env;
};

(async () => {
  // ── 1. MARKER + ps LINE FORMAT ────────────────────────────────────────────────────────────────────
  {
    const m = { slot: 7, pid: 4242, nonce: 'a1b2c3d4e5f60718', start: T0s };
    assert.deepStrictEqual(A.parseMarker(A.formatMarker(m)), m, 'marker round-trips');
    assert.ok(!/\s/.test(A.formatMarker(m)), '🔴 the marker contains whitespace — it would split inside `ps -E` output');
    for (const bad of ['', '7:4242:zz:1', '7:4242:a1b2c3d4e5f60718', '77:4242:a1b2c3d4e5f60718:1', '7:4242:a1b2c3d4e5f60718:Sat Oct']) {
      assert.strictEqual(A.parseMarker(bad), null, `malformed marker accepted: ${JSON.stringify(bad)}`);
    }
    const r = A.parsePsLine(L(4242, 'S', T0, '/usr/bin/node x.js'));
    assert.deepStrictEqual(r, { pid: 4242, state: 'S', lstart: T0, start: T0s, args: '/usr/bin/node x.js' });
    ok('the marker is one whitespace-free token that round-trips (malformed ones refused); LC_ALL=C/TZ=UTC ps lines parse to epoch starts');
  }

  // ── 2. P1-B: env SEPARATED from argv — x=y in argv is not env; empty env is not "unreadable" ─────────
  {
    const plain = [
      L(10, 'S', T0, 'node tool.js x=y FOO=bar'),          // argv carries x=y
      L(11, 'S', T0, '/usr/sbin/cfprefsd agent'),          // platform binary: env redacted ⇒ looks like empty env
      L(12, 'S', T0, 'node clean.js'),                     // genuinely empty env (env -i)
      L(13, 'S', T0, '(node)'),                            // Apple fallback: args unreadable
      L(14, 'S', T0, 'node odd.js'),
      L(16, 'S', T1, 'node reused.js'),                    // same pid, different process than in the -E scan
    ];
    const withEnv = [
      L(10, 'S', T0, `node tool.js x=y FOO=bar HOME=/h ${mk(3, 99, T0s)}`),
      L(11, 'S', T0, '/usr/sbin/cfprefsd agent'),
      L(12, 'S', T0, 'node clean.js'),
      L(13, 'S', T0, '(node)'),
      L(14, 'S', T0, 'something else entirely'),
      L(15, 'S', T0, 'node exited-between.js A=1'),        // absent from the LATER plain scan
      L(16, 'S', T0, 'node gone.js A=1'),
    ];
    const rows = A.joinScans(plain, withEnv);
    const by = Object.fromEntries(rows.map((r) => [r.pid, r]));
    assert.strictEqual(by[10].env, `HOME=/h ${mk(3, 99, T0s)}`, '🔴 argv x=y leaked into the env (or env lost)');
    assert.ok(by[11].readable && by[11].env === '', '🔴 a platform-redacted row was read as UNREADABLE — that quarantines every slot on a normal Mac');
    assert.ok(by[12].readable && by[12].env === '', '🔴 an empty-env process was read as UNREADABLE');
    assert.ok(!by[13].readable, '🔴 the (comm) fallback was read as readable');
    assert.ok(!by[14].readable, '🔴 -E text not prefixed by argv was trusted');
    assert.ok(!by[15].readable && !by[16].readable, 'rows absent from / changed in the second scan are not trusted as read');
    // and argv x=y NEVER yields a marker: a process whose ARGV merely mentions the marker is not a run's process
    const fake = A.joinScans([L(20, 'S', T0, `node -e 1 ${mk(3, 99, T0s)}`)], [L(20, 'S', T0, `node -e 1 ${mk(3, 99, T0s)}`)]);
    assert.strictEqual(A.markerIn(fake[0].env), null, '🔴 a marker in ARGV was read as a run marker (emu-reap could signal it)');
    ok('P1-B: env = (-E args) minus argv — an argv x=y (incl. a marker) is never env; an empty or platform-redacted env is NOT unreadable; the (comm) fallback, an un-prefixed -E row and a pid that changed between scans are');
  }

  // ── 3. CLASSIFICATION: free / live run / orphan / PID reuse / zombie / incomplete vs vanished ────────
  {
    const sup = (pid, start) => [L(pid, 'S', start, 'node tools/emulator-run.js'), L(pid, 'S', start, 'node tools/emulator-run.js PATH=/x')];
    const child = (pid, slot, supPid, supStart, state = 'S') => [L(pid, state, T0, 'java -jar db.jar'), L(pid, state, T0, `java -jar db.jar PATH=/x ${mk(slot, supPid, supStart)}`)];
    const table = (...pairs) => A.joinScans(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
    const alive = () => true;
    const free = A.classifyScan(table(sup(100, T0), child(101, 3, 100, T0s)), 5, { isAlive: alive });
    assert.deepStrictEqual([free.occupied, free.incomplete, free.orphans.length], [false, false, 0], 'another slot\'s run leaves slot 5 free');
    const liveRun = A.classifyScan(table(sup(100, T0), child(101, 3, 100, T0s)), 3, { isAlive: alive });
    assert.ok(liveRun.occupied && !liveRun.orphans.length && liveRun.live.length === 1, 'a live run occupies its slot and is NOT an orphan');
    const dead = A.classifyScan(table(child(101, 3, 100, T0s)), 3, { isAlive: alive });
    assert.ok(dead.occupied && dead.orphans.length === 1 && dead.orphans[0].supervisorPid === 100, '🔴 a dead supervisor\'s marked process was not an orphan');
    const reused = A.classifyScan(table(sup(100, T1), child(101, 3, 100, T0s)), 3, { isAlive: alive });
    assert.strictEqual(reused.orphans.length, 1, '🔴 PID reuse (supervisor pid alive with a different start) read as a live run');
    const zombie = A.classifyScan(table(child(101, 3, 100, T0s, 'Z')), 3, { isAlive: alive });
    assert.ok(!zombie.occupied, 'a zombie holds nothing and is skipped');
    const unreadable = A.joinScans([L(55, 'S', T0, '(node)')], [L(55, 'S', T0, '(node)')]);
    assert.ok(A.classifyScan(unreadable, 3, { isAlive: () => true }).incomplete, '🔴 a LIVE unreadable same-user row did not make the scan incomplete');
    assert.ok(!A.classifyScan(unreadable, 3, { isAlive: () => false }).incomplete, 'a VANISHED unreadable row is skipped, not doubted');
    ok('a free slot, a live run (occupied, not orphan), a dead supervisor (orphan), PID reuse (orphan), a zombie (skipped), a live unreadable row (INCOMPLETE) and a vanished one (skipped) are each classified correctly');
  }

  // ── 4. P1-B ON THIS MACHINE: a normal process table admits a free slot ─────────────────────────────
  {
    let incomplete = 0; const occupied = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const t = A.readPsTables();
      const rows = A.joinScans(t.plain, t.withEnv);
      incomplete = 0; occupied.length = 0;
      for (let s = 0; s < A.SLOTS; s++) {
        const c = A.classifyScan(rows, s, { isAlive: A.pidAlive });
        if (c.incomplete) incomplete += 1;
        if (c.occupied) occupied.push(s);
      }
      if (!incomplete) break;
      await sleep(200);                                  // a pid mid-exit between the two scans; re-read
    }
    assert.strictEqual(incomplete, 0, '🔴 the REAL same-UID process table makes slots INCOMPLETE — every admission would quarantine');
    assert.ok(occupied.length < A.SLOTS, 'premise — at least one slot is not occupied by a run');
    ok(`P1-B on this Mac: the real same-UID table (${A.readPsTables().withEnv.length} rows, most platform-redacted) leaves 0 of ${A.SLOTS} slots incomplete; ${occupied.length} occupied by live runs`);
  }

  // ── 5. MARKER VISIBILITY on REAL processes: node + java readable; /bin/sh redacted (the documented residual) ─
  {
    const nonce = A.newNonce();
    const marker = A.formatMarker({ slot: 39, pid: 1, nonce, start: 1 });
    const env = childEnv({ [A.RUN_VAR]: marker });
    const procs = [];
    const spawnHeld = (cmd, args) => { const p = spawn(cmd, args, { env, stdio: 'ignore' }); procs.push(p); return p; };
    const nodeP = spawnHeld(process.execPath, ['-e', 'setTimeout(()=>{},8000)']);
    const shP = spawnHeld('/bin/sh', ['-c', 'sleep 8; true']);
    let javaP = null;
    const java = ['/opt/homebrew/opt/openjdk/bin/java'].find((j) => fs.existsSync(j));
    const javaSrc = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'emu-alloc-java-')), 'S.java');
    if (java) { fs.writeFileSync(javaSrc, 'public class S { public static void main(String[] a) throws Exception { Thread.sleep(8000); } }\n'); javaP = spawnHeld(java, [javaSrc]); }
    try {
      let rows = [];
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        const t = A.readPsTables(); rows = A.joinScans(t.plain, t.withEnv);
        const seen = (p) => rows.find((r) => r.pid === p.pid);
        if (seen(nodeP) && seen(shP) && (!javaP || (seen(javaP) && /java/.test(seen(javaP).argv || '')))) break;
      }
      const row = (p) => rows.find((r) => r.pid === p.pid);
      assert.strictEqual((A.markerIn(row(nodeP).env) || {}).nonce, nonce, '🔴 a marked NODE process is not visible to the scan — suites, the CLI and workers would be invisible');
      if (javaP) assert.strictEqual((A.markerIn((row(javaP) || {}).env) || {}).nonce, nonce, '🔴 a marked JVM is not visible — the emulators themselves would be invisible');
      assert.ok(row(shP) && row(shP).readable && A.markerIn(row(shP).env) === null,
        'premise — /bin/sh (a platform binary) shows NO env: the documented residual. If this ever fails, Apple changed redaction; re-derive the residual');
    } finally {
      for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
      fs.rmSync(path.dirname(javaSrc), { recursive: true, force: true });
    }
    ok(`marker coverage on REAL processes: node${javaP ? ' + the Homebrew JVM' : ''} carry a readable marker; /bin/sh is redacted (the documented residual — it holds no band and no connection)`);
  }

  // ── 6. THE SENTINEL CONTRACT on real macOS sockets (fixture range only) ──────────────────────────────
  {
    // fixture disjointness: never a real sentinel, never any band port of any slot, never the 8000-8079 region
    const fixture = [...Array(A.SLOTS).keys()].map((s) => A.FIXTURE_SENTINEL_BASE + s);
    const real = new Set([...Array(A.SLOTS).keys()].map((s) => A.SENTINEL_BASE + s));
    const bands = new Set(); for (let s = 0; s < A.SLOTS; s++) for (const p of Object.values(EE.planPorts(s * 10))) bands.add(p);
    for (const p of fixture) assert.ok(!real.has(p) && !bands.has(p) && !(p >= 8000 && p <= 8079), `🔴 fixture port ${p} overlaps the real pool / a band`);
    for (const p of real) assert.ok(!bands.has(p) && p < 8000, `🔴 real sentinel ${p} overlaps a band or the discovery region`);

    // pick a fixture port nothing else holds right now
    let port = null; let a = null;
    for (const p of fixture) { a = await A.bindSentinel(p); if (a) { port = p; break; } }
    assert.ok(a, 'premise — some fixture port is free');
    assert.strictEqual(await A.bindSentinel(port), null, '🔴 a SECOND bind of a held sentinel succeeded — two runs would own one slot');
    // an incidental connection is destroyed at once (the sentinel never becomes a usable server)
    const closed = await new Promise((res) => {
      const c = net.connect(port, '127.0.0.1');
      const t0 = Date.now();
      c.on('close', () => res(Date.now() - t0)); c.on('error', () => {});
      setTimeout(() => res(-1), 3000);
    });
    assert.ok(closed >= 0 && closed < 2000, `🔴 an incidental connection to the sentinel was not destroyed (${closed})`);
    await A.closeServer(a);
    const again = await A.bindSentinel(port);
    assert.ok(again, '🔴 the sentinel could not be re-bound after an orderly close');
    await A.closeServer(again);
    // the kernel releases it on SIGKILL of the holder
    const holder = spawn(process.execPath, ['-e', `const n=require('net');const s=n.createServer();s.listen({port:${port},host:'127.0.0.1',exclusive:true},()=>process.stdout.write('L'));setTimeout(()=>{},30000)`], { env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((res) => holder.stdout.once('data', res));
    assert.strictEqual(await A.bindSentinel(port), null, 'premise — the child holds it');
    holder.kill('SIGKILL');
    await new Promise((res) => holder.once('exit', res));
    let rebound = null;
    for (let i = 0; i < 20 && !rebound; i++) { rebound = await A.bindSentinel(port); if (!rebound) await sleep(100); }
    assert.ok(rebound, '🔴 the sentinel stayed held after its owner was SIGKILLed — a crashed run would leak its slot forever');
    await A.closeServer(rebound);
    // 🔴 a WILDCARD listener (AirPlay's *:5000 shape) makes the band probe say IN-USE, although 127.0.0.1 alone is bindable
    const wild = net.createServer();
    await new Promise((res) => wild.listen({ port, host: '0.0.0.0' }, res));
    try {
      assert.notStrictEqual(await A.probePort(port), 'free', '🔴 a *:port wildcard listener was probed FREE — the CLI (lsof) would then refuse the port: the slot-20 / AirPlay failure');
      assert.strictEqual(await A.probePort(port, ['127.0.0.1']), 'free', 'premise — loopback ALONE is still bindable beside a wildcard listener on macOS (why the wildcards are probed)');
    } finally { await new Promise((res) => wild.close(res)); }
    assert.strictEqual(await A.probePort(port), 'free', 'and a genuinely free port probes free on all three addresses');
    // a non-contention error is SURFACED, never read as "unavailable"
    await assert.rejects(() => A.bindSentinel(port, '203.0.113.7'), (e) => e && e.code !== 'EADDRINUSE', '🔴 a non-EADDRINUSE bind error was swallowed');
    ok(`sentinel on real sockets (fixture ${A.FIXTURE_SENTINEL_BASE}-${A.FIXTURE_SENTINEL_BASE + A.SLOTS - 1}, disjoint from the real pool, every band and 8000-8079): exclusive, incidental connections destroyed, re-bindable after close AND after SIGKILL of its holder, non-contention errors surfaced; the band probe sees a WILDCARD listener (the AirPlay *:5000 shape) that loopback alone misses`);
  }

  // ── 7. ARBITRATION over the fixture range: skip-taken, concurrent-never-same, queue→deadline, pin ────
  {
    const SL = 6;
    const freeScan = () => ({ occupied: false, incomplete: false, orphans: [], unreadable: [] });
    /* PRIVATE REAL PORTS: SL ports the OS hands out as free (ephemeral range), mapped to slot indices 0..SL-1. Two gates
       run this file concurrently (the R1 two-gate proof); on a shared fixed sub-range one copy's allocator could take
       the slot the other copy's queued waiter was waiting for — a cross-copy deadlock (observed). Real sockets still,
       so exclusivity is the kernel's, not a stub's. */
    const PORTS = [];
    for (let i = 0; i < SL; i++) {
      const t = net.createServer();
      await new Promise((res) => t.listen({ port: 0, host: '127.0.0.1', exclusive: true }, res));
      PORTS.push(t.address().port);
      await new Promise((res) => t.close(res));
    }
    const base = 0;
    const bindMapped = (p) => A.bindSentinel(PORTS[p - base]);
    const deps = (o = {}) => ({ slots: SL, base, bind: bindMapped, scan: freeScan, probeBand: async () => true, sleep: (ms) => sleep(Math.min(ms, 20)), waitMs: 10, jitterMs: 5, ...o });
    // concurrent allocators never share a slot, and saturation is reached exactly at SL
    const got = await Promise.all([...Array(SL)].map(() => A.acquireSlot(deps())));
    assert.strictEqual(new Set(got.map((g) => g.slot)).size, SL, `🔴 ${SL} concurrent allocators did not get ${SL} distinct slots: ${got.map((g) => g.slot)}`);
    // the next one QUEUES, logs a heartbeat, and is admitted when a slot frees
    const logs = [];
    const waiter = A.acquireSlot(deps({ log: (m) => logs.push(m), heartbeatMs: 0 }));
    await sleep(150);
    await A.closeServer(got[2].server);
    const late = await waiter;
    assert.strictEqual(late.slot, got[2].slot, 'the queued allocator took the slot that freed');
    assert.ok(logs.some((l) => /QUEUED/.test(l)), '🔴 a queued allocator emitted no heartbeat — the gate would show a silent hang');
    // past the deadline it REFUSES (fake clock)
    let clock = 0;
    await assert.rejects(() => A.acquireSlot(deps({ now: () => clock, sleep: async () => { clock += 1000; }, deadlineMs: 5000 })), /no free slot after/, '🔴 saturation never refused');
    for (const g of [...got, late]) await A.closeServer(g.server);
    // pin: same arbitration, never queues
    const held = await bindMapped(base + 1);
    assert.deepStrictEqual((await A.acquireSlot(deps({ pin: 1 }))).slot, null, '🔴 a pin onto a held sentinel did not report unavailable');
    await A.closeServer(held);
    const pinned = await A.acquireSlot(deps({ pin: 1 }));
    assert.strictEqual(pinned.slot, 1, 'a pin onto a free slot acquires it');
    await A.closeServer(pinned.server);
    const q = await A.acquireSlot(deps({ pin: 1, scan: () => ({ occupied: true, incomplete: false, orphans: [{ pid: 9, supervisorPid: 8 }], unreadable: [] }) }));
    assert.strictEqual(q.slot, null, '🔴 a pin bypassed quarantine');
    const busy = await A.acquireSlot(deps({ pin: 1, probeBand: async () => false }));
    assert.strictEqual(busy.slot, null, '🔴 a pin bypassed the band probe');
    // quarantine and band-busy release the sentinel (no leak) — the slot is bindable straight after
    const after = await bindMapped(base + 1); assert.ok(after, '🔴 a quarantined / band-busy pin leaked its sentinel'); await A.closeServer(after);
    // EXCLUDE (re-slot): an excluded slot is never taken
    const exc = await A.acquireSlot(deps({ exclude: new Set([0, 1, 2, 3, 4]) }));
    assert.strictEqual(exc.slot, 5, '🔴 an EXCLUDED slot was taken (a re-slot would land back on the contended slot)');
    await A.closeServer(exc.server);
    // CANCELLATION: an abort while QUEUED stops promptly with ECANCELLED and holds nothing
    {
      const held2 = await Promise.all([...Array(SL)].map((_, i) => bindMapped(i)));
      const ac = new AbortController();
      const t0 = Date.now();
      const q2 = A.acquireSlot(deps({ signal: ac.signal, sleep: (ms) => sleep(ms), waitMs: 200, jitterMs: 1 }));
      setTimeout(() => ac.abort(), 150);
      await assert.rejects(q2, (e) => e && e.code === 'ECANCELLED', '🔴 an aborted queue did not cancel');
      assert.ok(Date.now() - t0 < 1500, `🔴 cancellation was not prompt (${Date.now() - t0} ms)`);
      for (const h of held2) await A.closeServer(h);
      const free0 = await bindMapped(0); assert.ok(free0, 'nothing leaked by the cancelled queue'); await A.closeServer(free0);
    }
    // DEADLINE PER SLOT: a slow scan cannot carry a sweep past the deadline (fake clock; each scan costs 1 s)
    {
      let clk = 0;
      await assert.rejects(() => A.acquireSlot(deps({ now: () => clk, scan: () => { clk += 1000; return { occupied: true, incomplete: false, orphans: [], unreadable: [] }; }, deadlineMs: 2500 })),
        (e) => /no free slot after [34]s/.test(e.message), '🔴 the deadline was not checked per slot (a slow sweep overran it)');
    }
    // a non-EADDRINUSE bind error propagates out of acquireSlot
    await assert.rejects(() => A.acquireSlot(deps({ bind: async () => { const e = new Error('boom'); e.code = 'EACCES'; throw e; } })), /boom/);
    ok(`arbitration (${SL} private real ports ${PORTS.join(',')}): ${SL} concurrent allocators get ${SL} distinct slots; the next QUEUES with a heartbeat and takes the slot that frees; saturation refuses at the deadline; a pin goes through sentinel + quarantine + band probe and never queues; refusals release the sentinel; bind errors surface`);
  }

  // ── 8. emu-reap: individual, fresh-validated signals; a live run (even co-grouped) is NEVER signalled ─
  {
    const r = (pid, start, env, state = 'S') => ({ pid, start, state, readable: true, env, argv: 'node x', lstart: T0 });
    const nonce = 'a1b2c3d4e5f60718';
    const tgt = { pid: 201, slot: 4, nonce, supervisorPid: 200, start: T0s };
    const own = `${mk(4, 200, T0s, nonce)}`;
    assert.ok(stillOrphan(tgt, r(201, T0s, own), []).ok, 'a dead-supervisor orphan is signalled');
    assert.ok(!stillOrphan(tgt, r(201, T0s, own), [r(200, T0s, '')]).ok, '🔴 a LIVE supervisor\'s process would be signalled');
    assert.ok(stillOrphan(tgt, r(201, T0s, own), [r(200, T0s + 5, '')]).ok, 'a REUSED supervisor pid (different start) does not protect an orphan');
    assert.ok(!stillOrphan(tgt, r(201, T0s + 3, own), []).ok, '🔴 a REUSED target pid would be signalled');
    assert.ok(!stillOrphan(tgt, r(201, T0s, mk(4, 200, T0s, 'ffffffffffffffff')), []).ok, '🔴 a target whose marker changed would be signalled');
    assert.ok(!stillOrphan(tgt, null, []).ok, 'a vanished target is skipped');

    // INTEGRATION on real processes, in ONE process group (the launching shell's): an orphan of a dead supervisor and
    // a child of a LIVE supervisor on the same slot. Uses slot 39 marks and the fixture sentinel for the reaper.
    /* CONCURRENCY-SAFE (two gates run this file at once): the chosen slot is LOCKED for the whole cell by holding its
       fixture sentinel, so no concurrent copy can pick it (a shared slot let one copy's reaper legitimately kill the
       other copy's orphan — observed). The reaper itself works through a PRIVATE ephemeral sentinel; the "held sentinel
       ⇒ refuse" case is then driven against the real lock. */
    let SLOT = null; let lock = null;
    for (const s2 of [...Array(A.SLOTS).keys()].sort(() => Math.random() - 0.5)) {
      lock = await A.bindSentinel(A.sentinelPort(s2, A.FIXTURE_SENTINEL_BASE));
      if (lock) { SLOT = s2; break; }
    }
    assert.ok(SLOT !== null, 'premise — a free fixture slot exists');
    const eph = net.createServer();
    await new Promise((res) => eph.listen({ port: 0, host: '127.0.0.1', exclusive: true }, res));
    const REAP_BASE = eph.address().port - SLOT;
    await new Promise((res) => eph.close(res));
    const dead = spawn(process.execPath, ['-e', '0'], { env: childEnv() });
    await new Promise((res) => dead.once('exit', res));                      // a supervisor pid that no longer exists
    const liveSup = spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { env: childEnv(), stdio: 'ignore' });
    await sleep(300);
    const supStart = A.parsePsLine(require('child_process').execFileSync('/bin/ps', ['-p', String(liveSup.pid), '-o', 'pid=,state=,lstart=,args='], { encoding: 'utf8', env: A.PS_ENV }).trim()).start;
    const orphan = spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { env: childEnv({ [A.RUN_VAR]: A.formatMarker({ slot: SLOT, pid: dead.pid, nonce: A.newNonce(), start: 1 }) }), stdio: 'ignore' });
    const liveChild = spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { env: childEnv({ [A.RUN_VAR]: A.formatMarker({ slot: SLOT, pid: liveSup.pid, nonce: A.newNonce(), start: supStart }) }), stdio: 'ignore' });
    try {
      await sleep(500);
      const lines = [];
      const kills = [];
      const res = await reap(SLOT, { phases: [['SIGTERM', 2000], ['SIGKILL', 2000]], sentinelBase: REAP_BASE, log: (m) => lines.push(m), kill: (pid, sig) => { kills.push([pid, sig]); process.kill(pid, sig); } });
      assert.ok(kills.every(([pid]) => pid === orphan.pid), `🔴 emu-reap signalled something other than the orphan: ${JSON.stringify(kills)} (orphan ${orphan.pid}, live child ${liveChild.pid})`);
      assert.ok(kills.some(([pid]) => pid === orphan.pid), `the orphan was signalled (${lines.join(' | ')})`);
      assert.strictEqual(res.left.length, 0, 'confirmed-death barrier reached');
      // our own child: dead means its exit is delivered here (until reaped it is a zombie, which the scan skips)
      const exited = orphan.exitCode !== null || orphan.signalCode !== null || await Promise.race([new Promise((r2) => orphan.once('exit', () => r2(true))), sleep(3000).then(() => false)]);
      assert.ok(exited, '🔴 the orphan is still alive after the reap');
      assert.ok(A.pidAlive(liveChild.pid) && liveChild.exitCode === null, '🔴 the co-grouped LIVE run\'s process was killed');
      assert.ok(lines.some((l) => /LIVE supervisor/.test(l)), 'and the reaper reported the live run it left alone');
      // a held sentinel = a live run owns the slot ⇒ refuse
      const refused = await reap(SLOT, { sentinelBase: A.FIXTURE_SENTINEL_BASE, log: () => {} });   // our LOCK holds it
      assert.strictEqual(refused.code, 3, '🔴 emu-reap worked a slot whose sentinel is held by a live run');
      // EPERM ⇒ left alone and reported
      const o2 = spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { env: childEnv({ [A.RUN_VAR]: A.formatMarker({ slot: SLOT, pid: dead.pid, nonce: A.newNonce(), start: 1 }) }), stdio: 'ignore' });
      await sleep(400);
      const elog = [];
      const er = await reap(SLOT, { phases: [['SIGTERM', 2000], ['SIGKILL', 2000]], sentinelBase: REAP_BASE, log: (m) => elog.push(m), kill: () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } });
      assert.ok(elog.some((l) => /EPERM/.test(l)) && A.pidAlive(o2.pid), '🔴 EPERM was not treated as alive-and-left');
      assert.strictEqual(er.code, 1, '🔴 an EPERM target was reported as CONFIRMED death (exit 0) — it is UNCONFIRMED');
      o2.kill('SIGKILL');
      await new Promise((r2) => o2.once('exit', r2));
      // a marked DESCENDANT spawned DURING the reap (the orphan answers SIGTERM by spawning a marked child, then exits) is
      // found by the re-enumeration and reaped too — the barrier is over the whole marked set, not the first snapshot
      const spawner = "process.on('SIGTERM',()=>{const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:process.env,stdio:'ignore',detached:true});c.unref();require('fs').writeFileSync(process.env.KID,String(c.pid));process.exit(0)});setInterval(()=>{},1000)";
      const kidFile = path.join(require('os').tmpdir(), `emu-alloc-kid-${process.pid}`);
      const o3 = spawn(process.execPath, ['-e', spawner], { env: childEnv({ KID: kidFile, [A.RUN_VAR]: A.formatMarker({ slot: SLOT, pid: dead.pid, nonce: A.newNonce(), start: 1 }) }), stdio: 'ignore' });
      await sleep(500);
      const dr = await reap(SLOT, { phases: [['SIGTERM', 2000], ['SIGKILL', 2000]], sentinelBase: REAP_BASE, log: () => {} });
      const kid = Number(fs.readFileSync(kidFile, 'utf8')); fs.rmSync(kidFile, { force: true });
      await sleep(300);
      assert.ok(!A.pidAlive(kid), `🔴 the marked descendant ${kid} spawned during the reap survived it`);
      assert.strictEqual(dr.code, 0, '🔴 the reap did not confirm the death of the orphan AND its new descendant');
      assert.ok(dr.signalled.some((x) => x.startsWith(`${kid}:`)), 'the descendant was signalled individually');
      void o3;

    } finally {
      for (const p of [liveSup, orphan, liveChild]) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
      // never leak a marked test process into the REAL pool (a leaked one quarantines a real slot): the descendant, if any
      const kf = path.join(require('os').tmpdir(), `emu-alloc-kid-${process.pid}`);
      try { process.kill(Number(fs.readFileSync(kf, 'utf8')), 'SIGKILL'); } catch { /* none / gone */ }
      fs.rmSync(kf, { force: true });
      await A.closeServer(lock);
    }
    ok('emu-reap: fresh per-pid validation (live supervisor / reused target / changed marker / vanished → skipped; reused SUPERVISOR pid → still an orphan); on real processes in ONE group it kills only the orphan, leaves the co-grouped live run, reaches the death barrier, refuses a held sentinel, reports an EPERM pid UNCONFIRMED (exit 1), and reaps a marked descendant spawned DURING the reap');
  }

  // ── 9. THE TERMINATION ROUTINE, injected: unreadable ≠ dead, EPERM ≠ dead, a REUSED pid is never signalled ────────
  {
    const mkRow = (pid, start, env, o = {}) => ({ pid, start, state: 'S', readable: true, env, argv: 'node x', lstart: T0, ...o });
    const NON = 'a1b2c3d4e5f60718';
    const ours = (row) => (A.markerIn(row.env) || {}).nonce === NON;
    const env1 = mk(2, 100, T0s, NON);
    const base = { same: ours, phases: [['SIGTERM', 300], ['SIGKILL', 300]], pollMs: 20, sleep: (ms) => sleep(Math.min(ms, 5)), isAlive: () => true };
    // (a) the target turns UNREADABLE after its signal → UNCONFIRMED, never "dead"
    {
      let signalledOnce = false;
      const res = await A.terminateMarked({ ...base,
        readTable: () => [signalledOnce ? mkRow(300, T0s, '', { readable: false, why: 'args unreadable (ps fallback)' }) : mkRow(300, T0s, env1)],
        readRow: (pid) => (signalledOnce ? mkRow(pid, T0s, '', { readable: false }) : mkRow(pid, T0s, env1)),
        kill: () => { signalledOnce = true; },
        select: (t) => ({ targets: t.filter((r) => r.readable && ours(r)), unattributable: [] }) });
      assert.strictEqual(res.confirmed, false, '🔴 a target that became UNREADABLE was counted as dead');
      assert.deepStrictEqual(res.unconfirmed.map((u) => u.pid), [300]);
    }
    // (b) EPERM → UNCONFIRMED
    {
      const res = await A.terminateMarked({ ...base, readTable: () => [mkRow(301, T0s, env1)], readRow: (pid) => mkRow(pid, T0s, env1),
        kill: () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }, select: (t) => ({ targets: t.filter(ours), unattributable: [] }) });
      assert.ok(!res.confirmed && res.eperm.includes(301), '🔴 an EPERM target was counted as dead');
    }
    // (c) TEARDOWN WITH PID REUSE: enumerated as ours (start T0), but at signal time the pid is a DIFFERENT process
    //     (start T0+7) — it must NOT be signalled, and the original counts as gone
    {
      const kills = [];
      let i = 0;
      const res = await A.terminateMarked({ ...base, readTable: () => (i++ === 0 ? [mkRow(302, T0s, env1)] : [mkRow(302, T0s + 7, 'OTHER=1')]),
        readRow: (pid) => mkRow(pid, T0s + 7, 'OTHER=1'), kill: (pid, sig) => kills.push([pid, sig]), select: (t) => ({ targets: t.filter(ours), unattributable: [] }) });
      assert.deepStrictEqual(kills, [], '🔴 a REUSED pid (a different process now) was signalled');
      assert.strictEqual(res.confirmed, true, 'the original process is gone (its pid names another process now)');
    }
    // (d) an unattributable live row (could be ours, cannot be read) keeps the result UNCONFIRMED
    {
      const res = await A.terminateMarked({ ...base, readTable: () => [], readRow: () => null, kill: () => {},
        select: () => ({ targets: [], unattributable: [{ pid: 9, why: 'args unreadable' }] }) });
      assert.strictEqual(res.confirmed, false, '🔴 an unattributable live row was ignored');
    }
    ok('termination routine: a target that turns unreadable and an EPERM target are UNCONFIRMED (never dead); a pid reused by another process between enumeration and signal is NOT signalled; an unattributable live row keeps the barrier unconfirmed');
  }

  // ── 10. THE MARKED WRAPPER (P1-2): a dead supervisor's chain keeps its slot QUARANTINED until the chain is gone ──────
  {
    const WRAP = path.join(__dirname, 'emu-cmd-wrapper.js');
    const { encode } = require('./emu-cmd-wrapper');
    let SLOT = null; let lock = null;
    for (const s2 of [...Array(A.SLOTS).keys()].sort(() => Math.random() - 0.5)) { lock = await A.bindSentinel(A.sentinelPort(s2, A.FIXTURE_SENTINEL_BASE)); if (lock) { SLOT = s2; break; } }
    const sup = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: childEnv(), stdio: 'ignore' });
    await sleep(300);
    const supStart = A.parsePsLine(require('child_process').execFileSync('/bin/ps', ['-p', String(sup.pid), '-o', 'pid=,state=,lstart=,args='], { encoding: 'utf8', env: A.PS_ENV }).trim()).start;
    const flag = path.join(require('os').tmpdir(), `emu-wrap-step2-${process.pid}`);
    fs.rmSync(flag, { force: true });
    // step 1 EXITS 0 on SIGTERM (a well-behaved suite), so only the wrapper's own stop rule can keep step 2 from starting
    const steps = [['node', '-e', "process.on('SIGTERM',()=>process.exit(0));setTimeout(()=>{},2500)"], ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(flag)}, String(process.env.${A.RUN_VAR}))`]];
    const marker = A.formatMarker({ slot: SLOT, pid: sup.pid, nonce: A.newNonce(), start: supStart });
    const w = spawn(process.execPath, [WRAP, encode(steps)], { env: childEnv({ [A.RUN_VAR]: marker }), stdio: 'ignore' });
    const wExit = new Promise((r2) => w.once('exit', (c) => r2(c)));
    try {
      await sleep(700);
      sup.kill('SIGKILL');                                      // the supervisor dies MID-CHAIN (step 1 running)
      await new Promise((r2) => sup.once('exit', r2));
      const samples = [];
      let exited = false; wExit.then(() => { exited = true; });
      while (!exited) {
        const sc = A.scanSlot(SLOT);
        if (!exited) samples.push({ occupied: sc.occupied, wrapperOrphan: sc.orphans.some((o) => o.pid === w.pid) });
        await sleep(150);
      }
      const code = await wExit;
      assert.ok(samples.length >= 3, `premise — the chain ran on after the supervisor died (${samples.length} samples)`);
      // the last sample may race the wrapper's own exit; every sample taken while it was alive must show quarantine
      assert.ok(samples.slice(0, -1).every((x) => x.occupied && x.wrapperOrphan), `🔴 while the dead supervisor's chain ran, the slot was NOT continuously quarantined with the wrapper visible: ${JSON.stringify(samples)}`);
      assert.strictEqual(code, 0, 'the chain completed');
      assert.strictEqual(fs.readFileSync(flag, 'utf8'), marker, 'step 2 ran under the wrapper with the run marker (visible, not a shell)');
      let after = A.scanSlot(SLOT);
      for (let i = 0; i < 50 && after.occupied; i++) { await sleep(100); after = A.scanSlot(SLOT); }   // exit delivery is async
      assert.ok(!after.occupied, `once the wrapper and its chain are gone, the slot is free (still marked: ${JSON.stringify([...after.orphans, ...after.live])})`);
      // SIGTERM is FORWARDED to the running step, and no later step starts
      fs.rmSync(flag, { force: true });
      const w2 = spawn(process.execPath, [WRAP, encode(steps)], { env: childEnv({ [A.RUN_VAR]: marker }), stdio: 'ignore' });
      await sleep(700);
      w2.kill('SIGTERM');
      const c2 = await new Promise((r2) => w2.once('exit', (c) => r2(c)));
      assert.strictEqual(c2, 143, `the wrapper exits 128+SIGTERM (got ${c2})`);
      assert.ok(!fs.existsSync(flag), '🔴 a later step started after the wrapper was signalled');
      // a non-node step is refused by the payload decoder itself
      const bad = require('child_process').spawnSync(process.execPath, [WRAP, encode([['sh', '-c', 'true']])], { encoding: 'utf8', env: childEnv() });
      assert.strictEqual(bad.status, 2, '🔴 the wrapper ran a non-node step');
    } finally {
      for (const p of [sup, w]) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
      fs.rmSync(flag, { force: true });
      await A.closeServer(lock);
    }
    ok('marked wrapper: with the supervisor SIGKILLed MID-CHAIN, every scan while the chain ran showed the slot occupied with the wrapper as a visible orphan (quarantined); after it, the slot is free; a later step runs under the marked wrapper (no shell); SIGTERM is forwarded and stops the chain; a non-node step is refused');
  }

  console.log(`\nemu-alloc: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('emu-alloc FAILED:', e && e.stack || e); process.exit(1); });
