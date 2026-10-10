'use strict';
/* The run-endpoint validator (PLAN-emulator-isolation v5 §c.1, §b.6) — the ONE place that decides whether a process
 * holding emulator signals is pointed at THIS run's emulators, and nothing else.
 *
 * 🔴 WHY IT LIVES IN lib/ AND HAS NO DEPENDENCIES. lib/admin.js (deployed code) requires it, but ONLY inside its
 * emulator branch — production never loads this file (zero cold-start cost, codex r5 P2-4). Test helpers, the
 * launcher and the dev harnesses require the same file, so there is one definition of "valid", not one per caller.
 *
 * THE RULE (advisor-approved, 2026-10-10):
 *   · EMULATOR MODE = any emulator signal present: FUNCTIONS_EMULATOR (discovery + workers get it from
 *     getEmulatorEnvs) or any data-service host var / the hub (suites get THOSE, not FUNCTIONS_EMULATOR —
 *     commandUtils.js:232 → env.js:10, codex r5 P2-3).
 *   · In emulator mode EVERY data service must have a validated endpoint — Firestore AND RTDB. A half-configured
 *     process is REFUSED; the unset half NEVER falls back to production.
 *   · A valid endpoint is either loopback on that service's own band (exact slot when XPIZZA_EMU_OFFSET is known,
 *     any of the 40 slots otherwise — discovery has no offset), or the NULL endpoint, the exact string
 *     "127.0.0.1:1" (port 1 is privileged and never bound: unreachable by construction). NULL is invalid for a
 *     service the launcher STARTED (XPIZZA_EMU_SERVICES), unless the suite explicitly declared that service dead
 *     for a deliberate unreachable-backend test (XPIZZA_EMU_DEAD).
 *   · Accidental use of a NULL service must fail FAST: measured on firebase-admin here, a NULL Firestore read takes
 *     ~46 s to reject and a NULL RTDB read never settles. installNullGuard() makes the client constructor throw.
 */
const path = require('path');

const NULL_ENDPOINT = '127.0.0.1:1';
const SLOTS = 40;
const STEP = 10;
const BANDS = {
  ui: 4000, hub: 4400, logging: 4800, functions: 5200, eventarc: 5600, tasks: 6000,
  firestore: 8080, firestoreWebsocket: 8500, database: 9000,
};
const DATA_SERVICES = ['firestore', 'database'];
const HOST_VAR = { firestore: 'FIRESTORE_EMULATOR_HOST', database: 'FIREBASE_DATABASE_EMULATOR_HOST' };
const FIRESTORE_ALIAS = 'FIREBASE_FIRESTORE_EMULATOR_ADDRESS';
const HUB_VAR = 'FIREBASE_EMULATOR_HUB';
const OFFSET_VAR = 'XPIZZA_EMU_OFFSET';
const SERVICES_VAR = 'XPIZZA_EMU_SERVICES';
const DEAD_VAR = 'XPIZZA_EMU_DEAD';

function planPorts(offset) {
  const out = {};
  for (const [k, base] of Object.entries(BANDS)) out[k] = base + offset;
  return out;
}

class EmulatorEndpointError extends Error {
  constructor(msg) { super(`🔴 REFUSED — emulator endpoint: ${msg}`); this.name = 'EmulatorEndpointError'; }
}

const present = (v) => v !== undefined && v !== null && v !== '';

/* Emulator mode. Any non-empty FUNCTIONS_EMULATOR counts (a "1" or "false" is a signal too — it is refused below
   rather than silently treated as production). */
function hasEmulatorSignal(env) {
  return present(env.FUNCTIONS_EMULATOR) || present(env[HOST_VAR.firestore]) || present(env[FIRESTORE_ALIAS])
    || present(env[HOST_VAR.database]) || present(env[HUB_VAR]);
}

// Strict loopback host:port. Anchored; no 0.0.0.0, no suffix tricks (127.0.0.1.example.test), no leading zeros.
const HOSTPORT = /^(127\.0\.0\.1|localhost|\[::1\]):([1-9]\d{0,4})$/;

function readOffset(env) {
  if (!present(env[OFFSET_VAR])) return null;
  const raw = String(env[OFFSET_VAR]);
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new EmulatorEndpointError(`${OFFSET_VAR}=${JSON.stringify(raw)} is not a slot offset`);
  const n = Number(raw);
  if (n % STEP !== 0 || n > (SLOTS - 1) * STEP) throw new EmulatorEndpointError(`${OFFSET_VAR}=${raw} is outside 0..${(SLOTS - 1) * STEP} step ${STEP}`);
  return n;
}

const listVar = (env, name) => new Set(present(env[name]) ? String(env[name]).split(',').map((s) => s.trim()).filter(Boolean) : []);

/* Validate one band endpoint (no NULL handling here). Returns the port. */
function checkBand(service, varName, raw, offset) {
  const m = HOSTPORT.exec(String(raw));
  if (!m) throw new EmulatorEndpointError(`${varName}=${JSON.stringify(raw)} is not a strict loopback host:port`);
  const port = Number(m[2]);
  const base = BANDS[service];
  if (offset !== null) {
    if (port !== base + offset) throw new EmulatorEndpointError(`${varName}=${raw} is not this run's ${service} port (expected ${base + offset}, slot offset ${offset})`);
  } else if (port < base || port > base + (SLOTS - 1) * STEP || (port - base) % STEP !== 0) {
    throw new EmulatorEndpointError(`${varName}=${raw} is not on the ${service} band (${base}..${base + (SLOTS - 1) * STEP} step ${STEP})`);
  }
  return port;
}

/* The full §c.1 check over a process environment. Throws EmulatorEndpointError; returns a description of the run.
   Callers that are NOT in emulator mode must not call this (lib/admin.js only calls it inside its emulator branch;
   the dev harnesses call it unconditionally, so a missing signal refuses there). */
function validateEmulatorEnv(env, { ns } = {}) {
  if (!hasEmulatorSignal(env)) throw new EmulatorEndpointError('no emulator signal (no FUNCTIONS_EMULATOR, no host vars) — this process would run against PRODUCTION');
  if (present(env.FUNCTIONS_EMULATOR) && env.FUNCTIONS_EMULATOR !== 'true') {
    throw new EmulatorEndpointError(`FUNCTIONS_EMULATOR=${JSON.stringify(env.FUNCTIONS_EMULATOR)} — only "true" is a valid emulator signal`);
  }
  const offset = readOffset(env);
  const started = listVar(env, SERVICES_VAR);
  const dead = listVar(env, DEAD_VAR);
  for (const d of dead) if (!DATA_SERVICES.includes(d)) throw new EmulatorEndpointError(`${DEAD_VAR} names "${d}", which is not a data service`);

  const endpoints = {};
  const nulls = [];
  for (const svc of DATA_SERVICES) {
    const varName = HOST_VAR[svc];
    const raw = env[varName];
    if (!present(raw)) {
      throw new EmulatorEndpointError(`${varName} is not set while other emulator signals are — a half-configured process would send ${svc} to PRODUCTION`);
    }
    if (raw === NULL_ENDPOINT) {
      if (started.has(svc) && !dead.has(svc)) {
        throw new EmulatorEndpointError(`${varName}=${NULL_ENDPOINT} (NULL) but this run STARTED ${svc} — a service cannot be both real and null`);
      }
      nulls.push(svc);
      endpoints[svc] = NULL_ENDPOINT;
      continue;
    }
    if (dead.has(svc)) throw new EmulatorEndpointError(`${DEAD_VAR} declares ${svc} dead but ${varName}=${raw} is not the NULL endpoint`);
    checkBand(svc, varName, raw, offset);
    if (started.size && !started.has(svc)) {
      throw new EmulatorEndpointError(`${varName}=${raw} names a ${svc} emulator this run did NOT start (${SERVICES_VAR}=${[...started].join(',')}) — that is someone else's`);
    }
    endpoints[svc] = raw;
  }
  if (present(env[FIRESTORE_ALIAS]) && env[FIRESTORE_ALIAS] !== env[HOST_VAR.firestore]) {
    throw new EmulatorEndpointError(`${FIRESTORE_ALIAS}=${env[FIRESTORE_ALIAS]} disagrees with ${HOST_VAR.firestore}=${env[HOST_VAR.firestore]} — the SDK honours both`);
  }
  if (present(env[HUB_VAR])) checkBand('hub', HUB_VAR, env[HUB_VAR], offset);
  if (ns !== undefined && !/^[a-z0-9-]+$/.test(String(ns))) throw new EmulatorEndpointError(`RTDB namespace ${JSON.stringify(ns)} is malformed`);
  return { offset, endpoints, nulls, started: [...started], dead: [...dead] };
}

/* A functions/HTTP base URL must be this run's loopback functions endpoint. */
function validateFunctionsUrl(url, env) {
  const offset = readOffset(env);
  let u;
  try { u = new URL(String(url)); } catch { throw new EmulatorEndpointError(`functions URL ${JSON.stringify(url)} does not parse`); }
  if (u.protocol !== 'http:') throw new EmulatorEndpointError(`functions URL ${url} is not plain-http loopback`);
  checkBand('functions', 'functions URL', `${u.hostname === '::1' ? '[::1]' : u.hostname}:${u.port}`, offset);
  return u;
}

/* RTDB URL (http://host:port/?ns=X or http://host:port?ns=X) must be this run's database AND the expected ns. */
function validateRtdbUrl(url, env, expectedNs) {
  let u;
  try { u = new URL(String(url)); } catch { throw new EmulatorEndpointError(`RTDB URL ${JSON.stringify(url)} does not parse`); }
  const v = validateEmulatorEnv(env);
  if (v.endpoints.database === NULL_ENDPOINT) throw new EmulatorEndpointError('RTDB URL requested but this run\'s database is NULL');
  if (`${u.hostname === '::1' ? '[::1]' : u.hostname}:${u.port}` !== v.endpoints.database) throw new EmulatorEndpointError(`RTDB URL ${url} is not this run's database (${v.endpoints.database})`);
  const ns = u.searchParams.get('ns');
  if (ns !== expectedNs) throw new EmulatorEndpointError(`RTDB URL ns=${ns} is not the expected namespace ${expectedNs}`);
  return u;
}

/* ── NULL guard: accidental use of a NULL service throws at client construction, not after ~46 s / never ── */
const GUARD = Symbol.for('xpizza.emu.nullGuard');
function installNullGuard(nullServices, { requireFrom } = {}) {
  const svc = new Set(nullServices || []);
  if (!svc.size) return false;
  // Resolve THE firebase-admin the caller uses (same file ⇒ same module instance ⇒ same prototype). The SDK's
  // exports map hides lib/app/firebase-app.js from bare specifiers; an absolute path is not subject to it.
  const req = requireFrom ? require('module').createRequire(requireFrom) : require;
  let FirebaseApp;
  try {
    FirebaseApp = req(path.join(path.dirname(req.resolve('firebase-admin/app')), 'firebase-app.js')).FirebaseApp;
  } catch (e) { throw new EmulatorEndpointError(`NULL guard could not load firebase-admin (${e && e.message}) — refusing rather than leaving a NULL service unguarded`); }
  const proto = FirebaseApp && FirebaseApp.prototype;
  if (!proto || typeof proto.getOrInitService !== 'function') throw new EmulatorEndpointError('NULL guard: firebase-admin FirebaseApp.getOrInitService not found — refusing rather than leaving a NULL service unguarded');
  const prior = proto[GUARD];
  const all = new Set([...(prior ? prior.services : []), ...svc]);
  const original = prior ? prior.original : proto.getOrInitService;
  proto.getOrInitService = function guardedGetOrInitService(name, init) {
    if (all.has(name)) {
      throw new EmulatorEndpointError(`${name} is the NULL endpoint in this run (${NULL_ENDPOINT}) — it was not started; using it would hang or retry. Start it with --only, or don't touch it.`);
    }
    return original.call(this, name, init);
  };
  proto[GUARD] = { services: all, original };
  return true;
}

/* Used by lib/admin.js inside its emulator branch, BEFORE its (unchanged) init: validate the run's endpoints (throws on
   a half-configured / foreign / malformed one), then arm the NULL guard for every NULL service the run did not declare
   deliberately dead (a declared-dead service keeps the real SDK behaviour on purpose — that is what a dead-backend test
   measures). The guard patches the SDK prototype, so it covers the app lib/admin creates next and any other app. */
function guardEmulatorProcess(env = process.env) {
  const v = validateEmulatorEnv(env);
  const accidental = v.nulls.filter((s) => !v.dead.includes(s));
  if (accidental.length) installNullGuard(accidental);
  return v;
}

module.exports = {
  NULL_ENDPOINT, SLOTS, STEP, BANDS, DATA_SERVICES, HOST_VAR, FIRESTORE_ALIAS, HUB_VAR,
  OFFSET_VAR, SERVICES_VAR, DEAD_VAR,
  planPorts, hasEmulatorSignal, validateEmulatorEnv, validateFunctionsUrl, validateRtdbUrl,
  installNullGuard, guardEmulatorProcess, EmulatorEndpointError,
};
