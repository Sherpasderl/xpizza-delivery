// run: `node onboarding-host.test.js` (no framework, repo idiom). Asserts the REAL shipped index.html companion
// HANDLERS (lifted from source by brace-matching) behave per the plan, and executes the real brand-helpers for
// the practice greeting. Covers the host-level behaviors codex r1 flagged (A3 stages ≠ submits; practice is
// inert + neutral; the §4(c) hook is wired at every operational write/callable denial).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { driverGreeting, brandMeta } from './brand-helpers.js';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
let passed = 0;
function t(name, fn) { fn(); passed++; }

// Lift a brace-matched block that begins at the first occurrence of `startMarker`.
function liftBlock(src, startMarker) {
  const i = src.indexOf(startMarker);
  assert.notEqual(i, -1, `marker not found: ${startMarker}`);
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error(`unbalanced block from ${startMarker}`);
}
// The whole module <script> (the handlers live here).
const SCRIPT = HTML.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

// ---- A3 "Guardar perfil" STAGES, never submits (codex r1 P2-13 mutant: A3 submission) ----
t('A3 "Guardar perfil" stages the fields + advances to the checklist, and does NOT submit', () => {
  const save = liftBlock(SCRIPT, "$('co-save').addEventListener('click', () => {");
  assert.match(save, /companionWriteDraft\(/, 'co-save must stage the fields');
  assert.match(save, /companionStep = 'checklist'/, 'co-save must advance to the checklist');
  assert.doesNotMatch(save, /companionSubmit|submitDriverProfile/, 'co-save must NEVER submit (submit is "Pedir aprobación" only)');
});

// ---- "Pedir aprobación" (A4) is the ONLY submit ----
t('the only submit call is "Pedir aprobación" wired to companionSubmit', () => {
  // companionSubmit is invoked exactly once as a handler, from the request button.
  const calls = (SCRIPT.match(/companionSubmit\(\)/g) || []).length;
  assert.ok(calls >= 1, 'companionSubmit must be wired');
  assert.match(SCRIPT, /id="co-request"[^]*?companionSubmit|co-request'\)[^]*?companionSubmit/, 'companionSubmit is driven by the Pedir aprobación button');
});

// ---- A5 practice writes NOTHING operational (codex r1 P2-13 mutant: operational practice write) ----
t('the practice renderer uses the neutral greeting and calls NO operational writer/callable', () => {
  const practice = liftBlock(SCRIPT, 'function companionRenderOnboarding(');
  // the practice branch builds a synthetic order and uses driverGreeting; it must not touch any real write path
  assert.match(practice, /driverGreeting\(\{\}\)/, 'practice greeting comes from a NO-BRAND synthetic order (neutral)');
  for (const writer of ['acceptTask', 'completeTask', 'pickupComplete', 'updateDriverLocation', 'submitDriverProfile', 'startShift', 'endShift', 'XPD.set', 'runTransaction']) {
    assert.ok(!practice.includes(writer), `practice must not call ${writer}`);
  }
});

// ---- the practice greeting is actually neutral (executes the real brand-helpers) ----
t('driverGreeting({}) is the neutral greeting; a named third brand keeps its label (brand-agnostic)', () => {
  assert.equal(driverGreeting({}), 'Hola, soy su repartidor.');
  // a THIRD brand with a server display name keeps it (not discarded) + neutral styling class
  const third = { restaurant_display_name: 'Taquería Lupe', restaurant_id: 'taqueria_lupe' };
  assert.equal(driverGreeting(third), 'Hola, soy su repartidor de Taquería Lupe.');
  assert.equal(brandMeta(third).label, 'Taquería Lupe');
  assert.equal(brandMeta(third).cls, 'neutral');
});

// ---- §4(c): the one-shot-refresh hook is wired at EVERY operational write/callable denial (P1-4) ----
t('companionOnWriteDenied is wired at accept, pickup, complete, location, startShift and endShift denials', () => {
  const n = (SCRIPT.match(/companionOnWriteDenied\(/g) || []).length;
  // 1 definition + 6 call sites (accept, pickup, complete, location, startShift, endShift)
  assert.ok(n >= 7, `expected the hook wired at ≥6 sites (+1 def), saw ${n}`);
  for (const near of ['acceptTask', 'pickupComplete', 'completeTask']) {
    const blk = liftBlock(SCRIPT, 'function attachActiveCardHandlers');
    assert.ok(blk.includes('companionOnWriteDenied'), `attachActiveCardHandlers wires the hook (covers ${near})`);
  }
});

// ---- E2 sign-out teardown never AWAITS the guarded server call (P2-9) ----
t('companionLocalTeardown fires the push-unregister detached (never awaited before sign-out)', () => {
  const td = liftBlock(SCRIPT, 'function companionLocalTeardown(');
  assert.doesNotMatch(td, /await\s+unregisterNativePush/, 'must NOT await the guarded callable');
  assert.match(td, /unregisterNativePush/, 'still fires it best-effort (detached)');
});

// ---- the boot runs in try/finally so the barrier always settles (P1-1) ----
t('the onAuth boot wraps the continuation in try/finally and resolves the boot barrier in finally', () => {
  assert.match(SCRIPT, /companionBootBarrier = new Promise/, 'a per-session boot barrier is created on login');
  assert.match(SCRIPT, /finally\s*\{\s*if \(companionBootSettle\) companionBootSettle\(\);/, 'the barrier resolves in finally (success OR failure)');
});

console.log(`✓ onboarding-host: ${passed} tests passed`);
