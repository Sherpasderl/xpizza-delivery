'use strict';
// PORTAL-UI 1a (PLAN-portal-ui-slice1 r5 §2 D9, §6) — the ONE pause-reason allowlist, shared with the handheld. A copy of
// merchant/merchant-location.js's PAUSE_REASONS (importing that module would load merchant-orders into the portal ops
// group). portal/ops-helpers.guard.test.js asserts Set-equality with the live merchant-location export on every run.
const PAUSE_REASONS = new Set(['Cocina llena', 'Falta personal', 'Problema técnico', 'Otro']);   // the prototype's chips

module.exports = { PAUSE_REASONS };
