'use strict';
// THE rule clauses for SDK card orders (BRIEF r5 §3, §4a) — one source for the rules file, its guard and the emulator suite.
// The server-only decision fields are written ONLY by the Admin SDK (which bypasses rules); a client can never create,
// change or remove them, and can never move a delivered/completed SDK order back. Legacy orders (no payment_flow) are untouched.
const SCALAR_FIELDS = Object.freeze(['payment_flow', 'payment_total_cents']);
const OBJECT_FIELDS = Object.freeze({ payment_placed: ['leg_id', 'at'], payment_commit: ['revision', 'pid'], payment_terminal: ['revision', 'at'], payment_cancel: ['kind', 'at'] });
const LEAF_IMMUTABLE = 'newData.val() === data.val()';
const leaves = [...SCALAR_FIELDS, ...Object.entries(OBJECT_FIELDS).flatMap(([f, ls]) => ls.map((l) => `${f}/${l}`))];
// at orders/$order_id, newData is the WHOLE resulting order for any write beneath it, so this covers a leaf write, a leaf
// delete, a whole-order replace and an order delete (validation alone does not run on deletes)
const PRESERVE = `(${leaves.map((p) => `newData.child('${p}').val() === data.child('${p}').val()`).join(' && ')})`;
const NO_REVERSAL_STATUS = "!data.parent().child('payment_flow').exists() || (data.val() !== 'delivered' && data.val() !== 'completed') || newData.val() === data.val()";
const NO_REVERSAL_ORDER = "(!data.child('payment_flow').exists() || (data.child('status').val() !== 'delivered' && data.child('status').val() !== 'completed') || newData.child('status').val() === data.child('status').val())";
module.exports = { SCALAR_FIELDS, OBJECT_FIELDS, LEAF_IMMUTABLE, PRESERVE, NO_REVERSAL_STATUS, NO_REVERSAL_ORDER };
