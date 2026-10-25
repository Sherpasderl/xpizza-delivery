// slice3-regions.js — the SLICE3 region CONTRACT, shared by two guards so there is ONE source of truth:
//   • slice3-freeze.guard.test.js  — the authority: strips SLICE3 regions (+ restores the replace spans) and
//     must recover index.html == the slice-3 baseline (07e5ab38) byte-for-byte, plus the marker/nesting proofs.
//   • slice2-freeze.guard.test.js  — coexistence: because its own region-strip is now blind to SLICE3 markers,
//     its check-2 splice must ALSO remove SLICE3 inserts and restore SLICE3 replace spans, so it still recovers
//     ITS baseline (e2266b24) with SLICE3 regions present.
//
// The two REPLACE spans below are BASE code that is byte-identical in BOTH baselines (e2266b24 and 07e5ab38) —
// slice3-freeze PROVES that (not just asserts it), so restoring them recovers EITHER baseline. That is the whole
// reason a single shared restore list is safe for both guards.
//
// Region set (exactly these names; anything else is RED):
//   PRESENTATION-3  insert   batch-3 CSS (inside <style>)
//   IMPORT-3        insert   batch-3 imports from stacked-view.js
//   LOGIC-3         insert   batch-3 module logic (help sheet, connectivity banner, gps-denied screen, cierre screen)
//   HELP-HANDLER    replace  the idle «¿Por qué no veo pedidos?» handler (alert → the diagnosis sheet)
//   CIERRE-REJECT   replace  the recordCuadre rejection branch (toast → the cierreRechazado screen)

export const SLICE3_REGIONS = [
  { name: 'PRESENTATION-3', kind: 'insert' },
  { name: 'IMPORT-3', kind: 'insert' },
  { name: 'LOGIC-3', kind: 'insert' },
  { name: 'HELP-HANDLER', kind: 'replace', restore: [
    "$('idle-help-link').addEventListener('click', () => {",
    "  alert(",
    "    'Posibles razones:\\n\\n' +",
    "    '• Aún no se ha asignado un pedido a ti\\n' +",
    "    '• Tu GPS está inactivo (revisa el indicador arriba)\\n' +",
    "    '• Las notificaciones están desactivadas\\n\\n' +",
    "    'Si crees que algo está mal, contacta al despachador.'",
    "  );",
    "});",
  ] },
  { name: 'CIERRE-REJECT', kind: 'replace', restore: [
    "  }).catch((err) => {",
    "    if (!isLatest()) return;",
    "    closeInFlight = false;",
    "    // Server REJECTED (permission/validation/other) — never clock out; the cuadre is the whole point. Stay on",
    "    // shift and surface it (this also surfaces a LATE rejection after the timeout message); the driver retries.",
    "    console.warn('recordCuadre rejected (staying on shift):', err);",
    "    toast(BLOCKED_CLOSE_TEXT, 'error');        // retry stays available (button re-enabled below); dispatch is the exit",
    "    refreshOpenCashSurfaces();                 // re-render from settled orders so a retry submits the current amount",
    "    reEnableConfirm();",
    "  });",
  ] },
];

export const SLICE3_NAMES = SLICE3_REGIONS.map((r) => r.name);
