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

/* Pure decision for one target, given its fresh row and a table holding (or not) its supervisor — exported for the guard. */
function stillOrphan(target, fresh, table) {
  if (!fresh || !fresh.readable || ALLOC.isZombie(fresh.state)) return { ok: false, why: 'vanished or unreadable' };
  if (fresh.start !== target.start) return { ok: false, why: 'pid reused (start time changed)' };
  const mk = ALLOC.markerIn(fresh.env);
  if (!mk || mk.slot !== target.slot || mk.nonce !== target.nonce || mk.pid !== target.supervisorPid) return { ok: false, why: 'marker changed' };
  const sup = table.find((r) => r.pid === mk.pid);
  if (sup && !ALLOC.isZombie(sup.state) && sup.start === mk.start) return { ok: false, why: 'supervisor is ALIVE — a live run is never signalled' };
  return { ok: true };
}

/* Reclaim slot `slot`. Exit codes: 0 = every orphan CONFIRMED dead and the scan complete; 1 = UNCONFIRMED (an orphan
   survived, was unreadable, answered EPERM, or the scan could not attribute a live process); 3 = a live run holds it. */
async function reap(slot, { dryRun = false, log = (m) => console.error(`emu-reap: ${m}`), kill = process.kill.bind(process), sentinelBase,
  readTable, readRow = ALLOC.readPsRow, phases, isAlive } = {}) {
  const sentinel = await ALLOC.bindSentinel(ALLOC.sentinelPort(slot, sentinelBase));
  if (!sentinel) { log(`slot ${slot}: the sentinel is held — a LIVE run owns this slot. Refusing.`); return { code: 3, signalled: [], left: [] }; }
  try {
    const rt = readTable || ALLOC.readUnionTable;   // the UNION of both -E views (codex r2 P1-1)
    const first = ALLOC.classifyScan(rt(), slot, { isAlive: isAlive || ALLOC.pidAlive });
    if (first.live.length) log(`slot ${slot}: ${first.live.length} marked pid(s) of a LIVE supervisor (${first.live.map((o) => o.pid).join(', ')}) — never signalled`);
    log(`slot ${slot}: ${first.orphans.length} orphan(s)${first.orphans.length ? ': ' + first.orphans.map((o) => `${o.pid} (dead supervisor ${o.supervisorPid})`).join(', ') : ''}`);
    if (dryRun) return { code: 0, signalled: [], left: first.orphans.map((o) => o.pid) };
    // a marked process is OURS to end only while its marker names this slot AND its supervisor is (freshly) dead
    const supervisorDead = (mk) => { let sup; try { sup = readRow(mk.pid); } catch { return false; } return !sup || ALLOC.isZombie(sup.state) || sup.start !== mk.start; };
    const res = await ALLOC.terminateMarked({
      select: (table) => {
        const sc = ALLOC.classifyScan(table, slot, { isAlive: isAlive || ALLOC.pidAlive });
        return { targets: sc.orphans.map((o) => table.find((r) => r.pid === o.pid)).filter(Boolean), unattributable: sc.unreadable };
      },
      same: (row) => { const mk = ALLOC.markerIn(row.env); return !!mk && mk.slot === slot && supervisorDead(mk); },
      readTable: rt, readRow, kill, log, ...(phases ? { phases } : {}), ...(isAlive ? { isAlive } : {}),
    });
    if (res.confirmed) log(`slot ${slot}: reclaimed — CONFIRMED death of every orphan (${res.signalled.length} signal(s))`);
    else log(`🔴 slot ${slot}: UNCONFIRMED — ${res.unconfirmed.map((u) => `${u.pid} (${u.status})`).join(', ')}${res.eperm.length ? `; EPERM: ${res.eperm.join(', ')}` : ''}`);
    return { code: res.confirmed ? 0 : 1, signalled: res.signalled, left: res.unconfirmed.map((u) => u.pid), unconfirmed: res.unconfirmed };
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
