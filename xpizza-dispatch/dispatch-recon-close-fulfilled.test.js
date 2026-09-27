// dispatch-recon-close-fulfilled.test.js — SPLIT 1: the "Cerrar como entregado" recon panel affordance.
// Structural guards over the shipped index.html: the button renders + routes the new action, the outcome is a
// recognized success (so the alert clears), and the confirm dialog carries its own keep-payment copy. Red-when-
// reverted. The server keep-payment/no-refund/no-materialize behavior is guarded in xpizza-functions/*.
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// The button: rendered in the recon card, routing data-recon-action="close_fulfilled", labelled "Cerrar como entregado".
assert.match(html, /data-recon-action="close_fulfilled">Cerrar como entregado<\/button>/, 'recon card has the "Cerrar como entregado" button routing close_fulfilled');
// Distinct neutral styling (outlined, own row) — not the green materialize / amber refund fill.
assert.match(html, /\.recon-btn\.close-fulfilled \{[^}]*background: transparent;[^}]*border: 1px solid/, 'close-fulfilled button is outlined/neutral (distinct from the filled materialize/refund)');
ok('recon panel renders the neutral "Cerrar como entregado" button (routes close_fulfilled)');

// The success outcome clears the alert: closed_fulfilled_offline ∈ RECON_SUCCESS_OUTCOMES.
assert.match(html, /const RECON_SUCCESS_OUTCOMES = new Set\(\[[^\]]*'closed_fulfilled_offline'[^\]]*\]\)/, 'closed_fulfilled_offline is a recognized success → the reconciliation alert clears');
ok('closed_fulfilled_offline ∈ RECON_SUCCESS_OUTCOMES (panel clears on success)');

// The confirm dialog has keep-payment copy for this action (dispatcher must know it KEEPS the money).
assert.match(html, /const closeWarn = 'Solo si el pedido ya se entregó[^']*Conserva el pago[^']*'/, 'reconNotePrompt keep-payment copy ("ya se entregó" + "Conserva el pago")');
assert.match(html, /close_fulfilled: \['Cerrar como entregado', closeWarn\]/, 'close_fulfilled uses the computed (brand-aware) warn');
ok('confirm dialog copy: "solo si ya se entregó y el cobro es correcto — conserva el pago"');

// SPLIT 2 fiscal warning: a platform-factura (X. Pizza) close EMITS a real SAR factura → the dialog must SAY so,
// and it must be brand-conditional so a La Musa (external POS) dispatcher is NOT told a factura will be emitted.
assert.match(html, /const emitsFactura = \(\(\(reconOrder && reconOrder\.restaurant_id\) \|\| 'x_pizza'\) !== 'la_musa'\)/, 'emitsFactura mirrors the server split (missing/x_pizza → factura; la_musa → none)');
assert.match(html, /emitsFactura \? ' Se emitirá la factura SAR de este pedido\.' : ''/, 'the SAR-factura warning is appended ONLY for a platform-factura (non-la_musa) order');
ok('SPLIT 2: brand-aware SAR-factura warning (X. Pizza says "se emitirá la factura SAR"; La Musa does not)');

// The resolve dispatch is the SAME audited path the other actions use (no bespoke money call in the panel).
assert.match(html, /resolveReconciliationAction\(btn\.dataset\.reconOid, btn\.dataset\.reconAction\)/, 'close_fulfilled routes through the shared resolveReconciliationAction (XPD.resolveReconciliation)');
assert.doesNotMatch(html, /data-recon-action="close_fulfilled"[^>]*data-/, 'the button carries no extra bespoke handler — same path as materialize/refund/abandon');
ok('close_fulfilled uses the shared resolve path (server is the money authority)');

console.log(`\ndispatch-recon-close-fulfilled: OK (${n} groups)`);
