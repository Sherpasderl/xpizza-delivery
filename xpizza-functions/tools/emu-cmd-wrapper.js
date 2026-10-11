'use strict';
/* The MARKED suite-command wrapper (codex R1-build P1-2). tools/emulator-run.js hands `firebase emulators:exec` exactly
 *     node <ROOT>/tools/emu-cmd-wrapper.js <payload>
 * and THIS process runs the suite chain — no shell in between.
 *
 * 🔴 WHY. macOS `ps -E` cannot read a platform binary's environment (measured: /bin/sh shows argv only), so a shell that
 * ran a chained command (`node a.js && node b.js`) carried the run marker INVISIBLY. If the supervisor died mid-chain,
 * that shell could launch the NEXT step after the slot looked empty and another run had taken it — with this run's
 * endpoints, against the other run's emulators. Here the only process that can launch a step is this one: node, marked
 * in its environment (inherited from the launcher) and therefore visible to every admission scan. While it is alive,
 * the slot reads as occupied (and, once the supervisor is dead, QUARANTINED) — it does not outlive a dead supervisor
 * silently. The CLI's own `sh -c "node …emu-cmd-wrapper.js <payload>"` runs a single command and cannot launch a step.
 *
 * Payload: base64url(JSON [[argv…], …]) — the `&&` chain, each step a `node …` argv. Steps run in order; the first
 * non-zero (or signalled) step stops the chain with its code, exactly as `&&`. Signals are FORWARDED to the running step
 * and no later step starts. XPIZZA_EMU_STARTED_FILE (set by the launcher) is touched first: "the suite began" — which
 * the launcher uses to tell a startup failure (re-slot) from a suite failure.
 */
const fs = require('fs');
const { spawn } = require('child_process');

function decode(payload) {
  const steps = JSON.parse(Buffer.from(String(payload || ''), 'base64url').toString('utf8'));
  if (!Array.isArray(steps) || !steps.length || !steps.every((s) => Array.isArray(s) && s.length > 1 && s[0] === 'node' && s.every((t) => typeof t === 'string'))) {
    throw new Error('emu-cmd-wrapper: payload must be a non-empty list of `node …` argv steps');
  }
  return steps;
}
const encode = (steps) => Buffer.from(JSON.stringify(steps), 'utf8').toString('base64url');

module.exports = { decode, encode };
if (require.main !== module) return;

let steps;
try { steps = decode(process.argv[2]); } catch (e) { console.error(`emulator-run: 🔴 ${e.message}`); process.exit(2); }
if (process.env.XPIZZA_EMU_STARTED_FILE) { try { fs.writeFileSync(process.env.XPIZZA_EMU_STARTED_FILE, String(process.pid)); } catch { /* best-effort signal */ } }

let current = null;
let stopping = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopping = stopping || sig;
    if (current && current.exitCode === null && current.signalCode === null) { try { current.kill(sig); } catch { /* gone */ } }
    else process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 })[sig]);
  });
}

(async () => {
  for (const argv of steps) {
    if (stopping) break;
    current = spawn(process.execPath, argv.slice(1), { stdio: 'inherit', env: process.env });
    const { code, signal } = await new Promise((res) => {
      current.once('error', (e) => { console.error(`emulator-run: 🔴 could not start a suite step — ${e && e.message}`); res({ code: 1, signal: null }); });
      current.once('exit', (c, s) => res({ code: c, signal: s }));
    });
    if (signal || code !== 0) process.exit(signal ? 128 + (({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 })[signal] || 1) : code);
  }
  process.exit(stopping ? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 })[stopping] : 0);
})();
