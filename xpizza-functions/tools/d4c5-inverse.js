'use strict';
// D4-c5 phase 1 — the test-only INVERSE of the order_exists slice (the split-file fold pattern): every hunk this slice
// made to index.js, put back to its f17466e text. Guards that pin index.js to its integration parent apply it AFTER
// foldPortalSplit(), so the parent pin keeps proving "nothing else changed" — and it proves that for THIS slice too:
// index.js differs from f17466e ONLY in these eight hunks (the require + the seven refusal emitters).
// Each candidate hunk must occur EXACTLY once, else this throws (a moved, duplicated or edited emitter is never
// silently tolerated).

const HUNKS = [
  ["const OE = require('./order-exists');   // D4-c5 P1: every existing-order refusal → typed 409 order_exists (no form auto-mints on it)\n", ''],
  [`        // D4-c5 P1: today's self-heal literal ONLY for a \`closed\` order provably terminal and money-free (from \`ev\`, no read)
        const oe = OE.decideCashExistingRefusal(cls.reason, ev);
        if (oe.legacy) {
          console.warn(\`createOrder: \${orderId} exists — 409 order_conflict (\${cls.reason}, terminal-safe)\`);
          return res.status(409).json({ error: 'order_conflict', reason: cls.reason, order_id: orderId });
        }
        console.warn(\`createOrder: \${orderId} exists — 409 order_exists (\${cls.reason})\`);
        return res.status(409).json(OE.orderExistsBody(oe.reason, orderId));
`, `        console.warn(\`createOrder: \${orderId} exists — 409 order_conflict (\${cls.reason})\`);
        return res.status(409).json({ error: 'order_conflict', reason: cls.reason, order_id: orderId });
`],
  ["    return res.status(409).json(OE.orderExistsBody('client_update_race', orderId));\n",
    "    return res.status(409).json({ error: 'order_conflict', reason: 'client_update_race', order_id: orderId });\n"],
  ["      return res.status(409).json(OE.orderExistsBody('binding_format_invalid', orderId));\n",
    "      return res.status(409).json({ error: 'Order conflict', reason: 'binding_format_invalid', order_id: orderId });\n"],
  ["    return res.status(409).json(OE.orderExistsBody('conflict', orderId));   // D4-c5 P1: no disclosure of the other restaurant\n",
    "    return res.status(409).json({ error: 'Order conflict', detail: 'order_id already used for a different restaurant', order_id: orderId });\n"],
  ["    if (!f.ok) return res.status(409).json(OE.orderExistsBody('binding_format_invalid', orderId));\n",
    "    if (!f.ok) return res.status(409).json({ error: 'Order conflict', reason: 'binding_format_invalid', order_id: orderId });\n"],
  [`    // 1D D4-b: a TYPED conflict (binding_format_invalid / cart_unverifiable) keeps its reason; a legacy mismatch → the neutral 'conflict'
    console.warn(\`chargeOnlineOrder: \${orderId} — 409 order_exists (acquire conflict\${acq.reason ? \`: \${acq.reason}\` : ''})\`);
    return res.status(409).json(OE.orderExistsBody(acq.reason || 'conflict', orderId));
`, `    // 1D D4-b: a TYPED conflict (binding_format_invalid / cart_unverifiable) keeps its reason; a legacy mismatch has none → today's exact body
    return res.status(409).json({ error: 'Order conflict', detail: 'order_id already used for a different cart/total', order_id: orderId, ...(acq.reason ? { reason: acq.reason } : {}) });
`],
  [`    console.warn(\`chargeOnlineOrder: \${orderId} — 409 order_exists (acquire closed: \${acq.reason})\`);   // the order's state: log only, never the body
    return res.status(409).json(OE.orderExistsBody('closed', orderId));
`, "    return res.status(409).json({ error: 'Order closed', detail: `order is ${acq.reason}; please start a new order`, order_id: orderId });\n"],
];

function unapplyD4c5(src) {
  let out = src;
  for (const [now, was] of HUNKS) {
    const i = out.indexOf(now);
    if (i < 0 || out.indexOf(now, i + 1) !== -1) throw new Error(`d4c5-inverse: hunk not found exactly once: ${now.slice(0, 80)}`);
    out = out.slice(0, i) + was + out.slice(i + now.length);
  }
  return out;
}

module.exports = { unapplyD4c5, HUNKS };
