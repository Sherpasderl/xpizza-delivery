"use strict";
// ── form-order-number — THE KITCHEN'S SHORT NUMBER ON THE CONFIRMATION, shared by every order form (owner, 2026-10-12) ──
//
// The confirmation shows the number the kitchen calls out (#47), never the long order id. That number is NOT in any
// create/payment response: allocateDisplayNumberOnSale stamps it AFTER the order goes live, onto the order AND its public
// tracking node (order_tracking/{tracking_token}/display_number, the node the tracker reads). It is written ONCE, so a
// number read from this order's own node is final — never wrong, only late. So:
//   token in hand → "pending" at once, then a short, CAPPED poll of that node → "number" when it lands;
//   no token (scheduled — numbered on release day; a re-tap that got no token), an unusable token, or no number within
//   DEADLINE_MS (the allocator is fail-open) → "hidden". The long id is never a fallback (owner ruling).
// Every poll belongs to ONE confirmation: start() and stop() bump a generation, and a result from an older generation
// paints nothing — "Hacer otro pedido" or a newer success can never show an older order's number.
//
// Same bytes load as a classic browser script AND a Node module (no ESM), like the other shared form modules.

const ORDER_NUMBER_DELAYS_MS = [700, 1500, 2500, 4000, 5000, 5000, 5000, 5000, 5000, 5000];   // ≤ 10 reads, ~39 s
const ORDER_NUMBER_DEADLINE_MS = 45000;
const ORDER_NUMBER_TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;

// A stamped number: a positive integer. Anything else is "not yet".
function orderNumberOf(v) { return (typeof v === "number" && Number.isInteger(v) && v > 0) ? v : null; }

// env: { base, read(url) → Promise<Response>, setTimeout, clearTimeout, paint(state, n) } — state ∈ "pending" | "number" | "hidden"
function createOrderNumber(env) {
  let gen = 0, timers = [];
  const clear = () => { timers.forEach((t) => { try { env.clearTimeout(t); } catch (_) {} }); timers = []; };
  function stop() { gen++; clear(); }
  function start(token) {
    stop();
    const mine = gen;
    const live = () => mine === gen;
    const paint = (state, n) => { if (live()) { try { env.paint(state, n); } catch (_) {} } };
    if (typeof token !== "string" || !ORDER_NUMBER_TOKEN_RE.test(token)) { paint("hidden"); return; }
    paint("pending");
    const url = env.base + "/order_tracking/" + encodeURIComponent(token) + "/display_number.json";
    timers.push(env.setTimeout(() => { paint("hidden"); if (live()) stop(); }, ORDER_NUMBER_DEADLINE_MS));
    let i = 0;
    const next = () => {
      if (!live()) return;
      if (i >= ORDER_NUMBER_DELAYS_MS.length) return;   // reads exhausted: the deadline hides the line
      timers.push(env.setTimeout(read, ORDER_NUMBER_DELAYS_MS[i++]));
    };
    function read() {
      if (!live()) return;
      let p;
      try { p = Promise.resolve(env.read(url)); } catch (_) { next(); return; }
      p.then((res) => (res && res.ok ? res.json() : null))
        .then((v) => { if (!live()) return; const n = orderNumberOf(v); if (n) { paint("number", n); stop(); } else next(); },
              () => next());
    }
    next();
  }
  return { start, stop };
}

const OrderNumber = { createOrderNumber, orderNumberOf, ORDER_NUMBER_DELAYS_MS, ORDER_NUMBER_DEADLINE_MS };
if (typeof module !== "undefined" && module.exports) module.exports = OrderNumber;
if (typeof window !== "undefined") { window.OrderNumber = OrderNumber; }
