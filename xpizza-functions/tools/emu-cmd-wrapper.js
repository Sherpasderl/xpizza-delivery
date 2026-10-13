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
const os = require('os');
const { spawn } = require('child_process');
// shell-equivalent status for a signal termination: 128 + the PLATFORM's signal number (codex r2 P2 — every signal, not four)
const sigCode = (sig) => 128 + ((os.constants.signals || {})[sig] || 1);

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

/* R3 P1-a (codex r1 P1-1): every step is preloaded with tools/egress-guard.js on its argv (emulator-run injects it); its
   DESCENDANTS — a node process a suite spawns itself — inherit the same guard through NODE_OPTIONS, so no process of a
   suite reaches beyond loopback. The guard prints nothing unless it refuses (children's stdout stays clean). */
const EGRESS = require('path').join(__dirname, 'egress-guard.js');
function stepEnv() {
  const env = { ...process.env };
  const req = `--require ${EGRESS}`;
  if (!String(env.NODE_OPTIONS || '').includes(EGRESS)) env.NODE_OPTIONS = `${env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : ''}${req}`;
  return env;
}

let steps;
try { steps = decode(process.argv[2]); } catch (e) { console.error(`emulator-run: 🔴 ${e.message}`); process.exit(2); }

/* RULES MUST COMPILE (codex R1-build P2-7). Measured: an INVALID, non-empty firestore.rules starts the Firestore emulator
   with NO error on the console, and the suite ran anyway. So before the first step, the run's own rules are (re)loaded
   through the emulator's rules API — the same PUT firebase-tools uses on a rules change — with ignore_errors:false, and
   any ERROR issue (or a failed load) REFUSES the run instead of leaving unknown rules in force. */
async function assertFirestoreRules() {
  const file = process.env.XPIZZA_EMU_FS_RULES;
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!file || !host || host === '127.0.0.1:1') return;
  const project = process.env.GCLOUD_PROJECT;
  const res = await fetch(`http://${host}/emulator/v1/projects/${project}:securityRules`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ignore_errors: false, rules: { files: [{ name: 'security.rules', content: fs.readFileSync(file, 'utf8') }] } }),
  });
  const body = await res.json().catch(() => ({}));
  const errors = (Array.isArray(body.issues) ? body.issues : []).filter((i) => String(i.severity).toUpperCase() === 'ERROR');
  if (!res.ok || errors.length) {
    console.error(`\nemulator-run: 🔴 REFUSED — the Firestore rules (${file}) did not load: HTTP ${res.status}${errors.length ? `, ${errors.length} compile error(s): ${errors.slice(0, 3).map((i) => `${(i.sourcePosition || {}).line}:${(i.sourcePosition || {}).column} ${i.description}`).join(' | ')}` : ''}.`);
    console.error('emulator-run:    Running the suite against unknown rules would make every rules assertion meaningless.\n');
    process.exit(2);
  }
}

let current = null;
let stopping = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopping = stopping || sig;
    if (current && current.exitCode === null && current.signalCode === null) { try { current.kill(sig); } catch { /* gone */ } }
    else process.exit(sigCode(sig));
  });
}

(async () => {
  await assertFirestoreRules();
  if (process.env.XPIZZA_EMU_STARTED_FILE) { try { fs.writeFileSync(process.env.XPIZZA_EMU_STARTED_FILE, String(process.pid)); } catch { /* best-effort signal */ } }
  for (const argv of steps) {
    if (stopping) break;
    current = spawn(process.execPath, argv.slice(1), { stdio: 'inherit', env: stepEnv() });
    const { code, signal } = await new Promise((res) => {
      current.once('error', (e) => { console.error(`emulator-run: 🔴 could not start a suite step — ${e && e.message}`); res({ code: 1, signal: null }); });
      current.once('exit', (c, s) => res({ code: c, signal: s }));
    });
    if (signal || code !== 0) process.exit(signal ? sigCode(signal) : code);
  }
  process.exit(stopping ? sigCode(stopping) : 0);
})();
