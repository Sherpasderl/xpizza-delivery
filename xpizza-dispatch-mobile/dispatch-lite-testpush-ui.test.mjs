// dispatch-lite-testpush-ui.test.mjs — EXECUTABLE coverage of the «Probar notificación» button states (item 2),
// built EXACTLY to the owner-approved mockup. Extracts the shipped testpush helpers VERBATIM from index.html and
// runs them against a slot + XPD.sendTestPush + forceRepairStaffPush shim, so the HTTP→UI mapping is the real code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
const uiStart = html.indexOf('function testPushIdleHtml(){');
const uiEnd = html.indexOf('// ── settings ──');
assert.ok(uiStart > -1 && uiEnd > uiStart, 'located the testpush UI block');
const block = html.slice(uiStart, uiEnd);

function buildUI(opts = {}) {
  const slot = { innerHTML: '' };
  const $ = (id) => (id === 'testpush-slot' ? slot : null);
  const escapeHtml = (s) => (s == null ? '' : String(s)).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  let repairCalls = 0;
  const forceRepairStaffPush = async () => { repairCalls++; if (opts.repairThrow) throw new Error('repair fail'); };
  const XPD = { sendTestPush: opts.sendTestPush || (async () => ({ httpStatus: opts.status ?? 200, reason: opts.reason, retryAfterSec: opts.retryAfterSec })) };
  const body = `${block}\n;return { testPushIdleHtml, renderTestPush, runTestPush, reactivateTestPush };`;
  const api = new Function('$', 'escapeHtml', 'XPD', 'forceRepairStaffPush', body)($, escapeHtml, XPD, forceRepairStaffPush);
  return { api, slot, repairCalls: () => repairCalls };
}

test('idle: renders the secondary «Probar notificación» button routing data-testpush', () => {
  const { api } = buildUI();
  const h = api.testPushIdleHtml();
  assert.match(h, /class="btn btn-g"/);
  assert.match(h, /data-testpush="1"/);
  assert.match(h, /Probar notificación/);
});

test('200 → mint success panel «Enviada, revisá tu teléfono» + re-activate link + «Probar de nuevo»', async () => {
  const env = buildUI({ status: 200 });
  await env.api.runTestPush();
  assert.match(env.slot.innerHTML, /pn-ok/);
  assert.match(env.slot.innerHTML, /Enviada, revisá tu teléfono/);
  assert.match(env.slot.innerHTML, /Debería aparecer en unos segundos/);
  assert.match(env.slot.innerHTML, /data-reactivate="1"[^>]*>¿No apareció\? Volver a activar/);   // the principal failure path (owner)
  assert.match(env.slot.innerHTML, /data-testpush="1"[^>]*>Probar de nuevo/);
});

test('shows «Enviando…» (disabled) while the request is in flight', async () => {
  let release;
  const env = buildUI({ sendTestPush: () => new Promise((r) => { release = () => r({ httpStatus: 200 }); }) });
  const p = env.api.runTestPush();
  assert.match(env.slot.innerHTML, /disabled[^>]*>Enviando…|Enviando…<\/button>/);
  release(); await p;
  assert.match(env.slot.innerHTML, /Enviada, revisá tu teléfono/);
});

test('429 → error panel with a wait message + «Probar de nuevo» (no re-activate; it is a timing limit)', async () => {
  const env = buildUI({ status: 429, reason: 'rate_limited', retryAfterSec: 12 });
  await env.api.runTestPush();
  assert.match(env.slot.innerHTML, /pn-err/);
  assert.match(env.slot.innerHTML, /Esperá unos segundos/);
  assert.match(env.slot.innerHTML, /data-testpush="1"/);
  assert.doesNotMatch(env.slot.innerHTML, /data-reactivate/);
});

test('409 no_sub → error panel «ya no tiene una suscripción válida» + «Volver a activar notificaciones»', async () => {
  const env = buildUI({ status: 409, reason: 'no_sub' });
  await env.api.runTestPush();
  assert.match(env.slot.innerHTML, /pn-err/);
  assert.match(env.slot.innerHTML, /ya no tiene una suscripción válida/);
  assert.match(env.slot.innerHTML, /data-reactivate="1"[^>]*>Volver a activar notificaciones/);
});

test('502 / 503 / network (status 0) → generic error + re-activate', async () => {
  for (const status of [502, 503, 0]) {
    const env = buildUI({ status });
    await env.api.runTestPush();
    assert.match(env.slot.innerHTML, /pn-err/, `status ${status} → error panel`);
    assert.match(env.slot.innerHTML, /Revisá tu conexión/);
    assert.match(env.slot.innerHTML, /data-reactivate="1"/);
  }
});

test('re-activate → FORCES rotation via forceRepairStaffPush, then invites a retry', async () => {
  const env = buildUI();
  await env.api.reactivateTestPush();
  assert.equal(env.repairCalls(), 1, 'forced a fresh re-registration (not enableStaffPush reuse)');
  assert.match(env.slot.innerHTML, /pn-ok/);
  assert.match(env.slot.innerHTML, /Notificaciones reactivadas/);
  assert.match(env.slot.innerHTML, /data-testpush="1"/);
});

test('re-activate failure → error panel pointing at the phone permission settings', async () => {
  const env = buildUI({ repairThrow: true });
  await env.api.reactivateTestPush();
  assert.match(env.slot.innerHTML, /pn-err/);
  assert.match(env.slot.innerHTML, /Revisá los permisos en Ajustes del teléfono/);
});
