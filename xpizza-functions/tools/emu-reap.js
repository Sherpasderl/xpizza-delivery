#!/usr/bin/env node
'use strict';
/* emu-reap — reclaim ONE quarantined emulator slot (PLAN-emulator-isolation v5 §b.4). The ONLY code that signals.
 *
 *   node tools/emu-reap.js <slot 0..39> [--dry-run]
 *
 * Admission never kills: a slot bearing a marked process whose supervisor is dead is QUARANTINED and skipped. This
 * CLI reclaims it, under rules that make signalling a LIVE run impossible by construction:
 *   1. It HOLDS THE SLOT'S SENTINEL first. If the sentinel is taken, a live run owns the slot: refuse (exit 3).
 *      Holding it also means no admission can race us onto this slot while we work.
 *   2. It signals INDIVIDUAL pids only — NEVER kill(-pgid). The supervisor and the suite share the launching shell's
 *      process group, which can also hold another worktree's LIVE run (codex r4 P1-2).
 *   3. Each pid is RE-READ FRESH immediately before it is signalled: same pid start time, same marker (slot + nonce),
 *      supervisor still dead (absent, or a different start = PID reuse). A pid that vanished or changed identity
 *      between enumeration and signal is skipped. A marked pid whose supervisor is ALIVE is never touched.
 *   4. EPERM ⇒ treated as alive, left, reported. Confirmed-death barrier: SIGTERM, wait, SIGKILL, wait, re-enumerate.
 * RESIDUALS (accepted, documented): whole-second `lstart` cannot tell a same-PID reuse within one second, and there is
 * a nonzero window between the fresh re-read and kill(). Both are the price of admission-never-kills.
 */
const ALLOC = require('./emu-alloc');

function freshRow(pid) {
  const t = ALLOC.readPsTables();
  const rows = ALLOC.joinScans(t.plain.filter((l) => ALLOC.parsePsLine(l)?.pid === pid), t.withEnv.filter((l) => ALLOC.parsePsLine(l)?.pid === pid));
  return rows[0] || null;
}

/* Pure decision for one target, given its fresh row and the fresh table — exported for the guard. */
function stillOrphan(target, fresh, table) {
  if (!fresh || !fresh.readable || ALLOC.isZombie(fresh.state)) return { ok: false, why: 'vanished or unreadable' };
  if (fresh.start !== target.start) return { ok: false, why: 'pid reused (start time changed)' };
  const mk = ALLOC.markerIn(fresh.env);
  if (!mk || mk.slot !== target.slot || mk.nonce !== target.nonce || mk.pid !== target.supervisorPid) return { ok: false, why: 'marker changed' };
  const sup = table.find((r) => r.pid === mk.pid);
  if (sup && !ALLOC.isZombie(sup.state) && sup.start === mk.start) return { ok: false, why: 'supervisor is ALIVE — a live run is never signalled' };
  return { ok: true };
}

async function reap(slot, { dryRun = false, log = (m) => console.error(`emu-reap: ${m}`), kill = process.kill.bind(process), sentinelBase } = {}) {
  const sentinel = await ALLOC.bindSentinel(ALLOC.sentinelPort(slot, sentinelBase));
  if (!sentinel) { log(`slot ${slot}: the sentinel is held — a LIVE run owns this slot. Refusing.`); return { code: 3, signalled: [], left: [] }; }
  try {
    const enumerate = () => {
      const t = ALLOC.readPsTables();
      const table = ALLOC.joinScans(t.plain, t.withEnv);
      const sc = ALLOC.classifyScan(table, slot, { isAlive: ALLOC.pidAlive });
      return { table, sc };
    };
    let { table, sc } = enumerate();
    if (sc.live.length) log(`slot ${slot}: ${sc.live.length} marked pid(s) of a LIVE supervisor (${sc.live.map((o) => o.pid).join(', ')}) — never signalled`);
    const targets = sc.orphans.map((o) => ({ ...o, slot, start: (table.find((r) => r.pid === o.pid) || {}).start }));
    if (!targets.length) { log(`slot ${slot}: no orphans${sc.incomplete ? ' (scan INCOMPLETE — unreadable live pids: ' + sc.unreadable.map((u) => u.pid).join(', ') + ')' : ''}`); return { code: sc.incomplete ? 1 : 0, signalled: [], left: [] }; }
    log(`slot ${slot}: ${targets.length} orphan(s): ${targets.map((o) => `${o.pid} (dead supervisor ${o.supervisorPid})`).join(', ')}`);
    if (dryRun) return { code: 0, signalled: [], left: targets.map((o) => o.pid) };
    const signalled = [];
    const signalPass = (sig) => {
      ({ table } = enumerate());
      for (const tgt of targets) {
        const v = stillOrphan(tgt, freshRow(tgt.pid), table);      // FRESH, immediately before the signal
        if (!v.ok) continue;
        try { kill(tgt.pid, sig); signalled.push(`${tgt.pid}:${sig}`); } catch (e) { if (e && e.code === 'EPERM') log(`pid ${tgt.pid}: EPERM — left alone, reported`); }
      }
    };
    const remaining = () => { ({ table } = enumerate()); return targets.filter((tgt) => stillOrphan(tgt, table.find((r) => r.pid === tgt.pid) || null, table).ok); };
    for (const [sig, waitMs] of [['SIGTERM', 8000], ['SIGKILL', 4000]]) {
      signalPass(sig);
      const until = Date.now() + waitMs;
      while (remaining().length && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
      if (!remaining().length) break;
    }
    const left = remaining().map((t) => t.pid);
    if (left.length) log(`🔴 ${left.length} orphan(s) survived SIGKILL: ${left.join(', ')}`);
    else log(`slot ${slot}: reclaimed — confirmed death of ${targets.length} orphan(s)`);
    return { code: left.length ? 1 : 0, signalled, left };
  } finally {
    await ALLOC.closeServer(sentinel);
  }
}

module.exports = { reap, stillOrphan };
if (require.main !== module) return;

const args = process.argv.slice(2);
const slot = Number(args.find((a) => /^\d+$/.test(a)));
if (!Number.isInteger(slot) || slot < 0 || slot >= ALLOC.SLOTS || args.some((a) => !/^\d+$/.test(a) && a !== '--dry-run')) {
  console.error(`usage: node tools/emu-reap.js <slot 0..${ALLOC.SLOTS - 1}> [--dry-run]`);
  process.exit(2);
}
reap(slot, { dryRun: args.includes('--dry-run') }).then((r) => process.exit(r.code), (e) => { console.error(`emu-reap: ${e && e.stack || e}`); process.exit(1); });
